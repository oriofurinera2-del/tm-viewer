'use strict';

// 動画のダウンロード（DESIGN 4.9）。Electron に依存しない部分だけをここに置く。
// 動画の URL は推測で組み立てない。サイト表示の動画ページのプレイヤーが実際に使う URL だけを使う。

const path = require('node:path');

const SITE_ORIGIN = 'https://www.tokyomotion.net';
// 動画はサイト本体から配信用サブドメインへ転送される（DESIGN 4.9・8 章）。
const VIDEO_HOST_PATTERNS = ['tokyomotion.net', '*.tokyomotion.net', 'tokyo-motion.net', '*.tokyo-motion.net'];
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'mov', 'flv', 'mkv']);
const MIME_EXTENSIONS = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/x-matroska': 'mkv'
};
const DEFAULT_EXTENSION = 'mp4';
// 保存先のパスが Windows の長さの制限を超えないよう、名前の部分を切り詰める。
const MAX_NAME_LENGTH = 100;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function validId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// 「中止」によって止まったことを表す（失敗とは区別する）。
class CanceledError extends Error {
  constructor(message = '中止しました') {
    super(message);
    this.name = 'CanceledError';
  }
}

function videoPageUrl(id) {
  if (!validId(id)) throw new TypeError('動画IDが必要です');
  return `${SITE_ORIGIN}/video/${id}`;
}

// サイトの動画ページ（/video/<ID>…）なら動画 ID を返す。
function videoIdFromUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host !== 'tokyomotion.net' && host !== 'www.tokyomotion.net') return null;
    const match = url.pathname.match(/^\/video\/(\d+)(?:\/|$)/);
    const id = match ? Number(match[1]) : NaN;
    return validId(id) ? id : null;
  } catch {
    return null;
  }
}

function isVideoHostUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return VIDEO_HOST_PATTERNS.some(pattern => (pattern.startsWith('*.')
      ? host.endsWith(pattern.slice(1))
      : host === pattern));
  } catch {
    return false;
  }
}

function isHdSource(source) {
  if (source?.hd === true) return true;
  const text = [source?.label, source?.title, source?.res].filter(value => typeof value === 'string').join(' ');
  if (/\bHD\b|720|1080/i.test(text)) return true;
  try {
    return /\/hd\//i.test(new URL(source.src).pathname);
  } catch {
    return false;
  }
}

// プレイヤーの <source>／<video> から読んだ候補のうち、使える URL を選ぶ。HD があれば HD。
// blob: などサイトの配信元でない URL は使わない（取れなかったものとして扱う）。
function pickVideoUrl(candidates) {
  const usable = (Array.isArray(candidates) ? candidates : [])
    .filter(source => typeof source?.src === 'string' && isVideoHostUrl(source.src));
  if (usable.length === 0) return null;
  const hd = usable.find(isHdSource);
  return { url: (hd || usable[0]).src, hd: Boolean(hd) };
}

// サイト表示の動画ページで実行するスクリプト。<video> と <source> の URL と画質の表示だけを読み、
// それ以外の要素（ログインの入力欄など）には触れない。
const READ_PLAYER_SOURCES_SCRIPT = `(() => Array.from(document.querySelectorAll('video source, video')).map(el => ({
  src: el.tagName === 'VIDEO' ? (el.currentSrc || el.src || '') : (el.src || ''),
  label: el.getAttribute('label') || '',
  title: el.getAttribute('title') || '',
  res: el.getAttribute('res') || el.getAttribute('data-res') || '',
  hd: el.hasAttribute('data-fluid-hd')
})))()`;

function sanitizeFileName(value) {
  let name = String(value ?? '')
    .replace(/\s+/g, ' ')
    // Windows のファイル名に使えない文字と制御文字
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .trim();
  name = Array.from(name).slice(0, MAX_NAME_LENGTH).join('')
    // 末尾のピリオドと空白は Windows で消えるため置き換える。
    .replace(/[. ]+$/, '');
  if (RESERVED_NAMES.test(name)) name = `_${name}`;
  return name;
}

// HTTP の状態コードから日本語のエラーメッセージを作る（保存を拒否された理由を伝える）。
function httpErrorMessage(status) {
  return `サイトが保存を拒否しました（HTTP ${status}）`;
}

// Content-Type が動画（またはバイト列）と言えるかどうか。text/html などは動画ではない。
function isVideoContentType(value) {
  const type = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  return type.startsWith('video/') || type === 'application/octet-stream';
}

function extensionFor({ filename, mimeType, url } = {}) {
  const fromName = value => {
    const ext = path.extname(String(value || '')).slice(1).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext) ? ext : null;
  };
  let urlPath = '';
  try { urlPath = new URL(url).pathname; } catch { /* 無視 */ }
  const mime = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
  return fromName(filename) || MIME_EXTENSIONS[mime] || fromName(urlPath) || DEFAULT_EXTENSION;
}

// 「独自の名前（無ければタイトル）_動画ID.拡張子」
function buildFileName({ name, title, id, ext = DEFAULT_EXTENSION }) {
  if (!validId(id)) throw new TypeError('動画IDが必要です');
  const base = sanitizeFileName(typeof name === 'string' && name.trim() ? name : title);
  const extension = VIDEO_EXTENSIONS.has(String(ext).toLowerCase()) ? String(ext).toLowerCase() : DEFAULT_EXTENSION;
  return `${base ? `${base}_` : ''}${id}.${extension}`;
}

// 同名のファイルがあれば「名前 (2).mp4」のように番号を付ける。
function uniqueFilePath(dir, fileName, exists) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  for (let number = 2; exists(candidate); number += 1) {
    candidate = path.join(dir, `${stem} (${number})${ext}`);
  }
  return candidate;
}

// 同時ダウンロード数の上限と既定（DESIGN 4.9）。設定は 1〜5、既定 5。
const MAX_DOWNLOAD_CONCURRENCY = 5;
const DEFAULT_DOWNLOAD_CONCURRENCY = 5;

function clampConcurrency(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_DOWNLOAD_CONCURRENCY;
  return Math.max(1, Math.min(MAX_DOWNLOAD_CONCURRENCY, n));
}

// 動画を並列に保存するキュー。resolveUrl と save は main（Electron）側から渡す。
// 「解決は順番・転送は並列（最大 N）」: 取得元 URL の解決（resolveUrl）は共有の裏ページ
// （downloadView）が 1 つしかないため single-flight で直列化し、解決済みの保存（save＝CDN への
// 転送）だけを最大 N 本まで並列で走らせる（DESIGN 4.9）。
// 状態の変化は onUpdate に { id, name, state, percent, message, fileName, filePath } で知らせる。
// state: queued / resolving / downloading / done / failed
// resolveUrl(job) / save(job, found, onProgress) の job には controller（AbortController）が入る。
// 中止（cancel）はこの controller を abort するだけで、判定・後始末（fetch の中断・.part の削除）は
// 呼び出し側（main.js）と、ここでの CanceledError の扱いで行う。
function createDownloadQueue({ resolveUrl, save, onUpdate = () => {}, concurrency = DEFAULT_DOWNLOAD_CONCURRENCY }) {
  if (typeof resolveUrl !== 'function' || typeof save !== 'function') {
    throw new TypeError('resolveUrl と save が必要です');
  }
  const waiting = [];
  // 完了・失敗した分も、一覧に出すためにアプリを閉じるまで保持する（中止した分は消す）。
  const jobs = new Map();
  // 今 saveVideo/resolveUrl を処理中の entry（最大 limit 本）。
  const running = new Set();
  // 取得元 URL の解決を 1 本に直列化するための鎖（single-flight ミューテックス）。
  let resolveChain = Promise.resolve();
  let limit = clampConcurrency(concurrency);
  let seq = 0;
  // idle() 用: 走行中・待機中がすべて無くなったら解決する待ち受け。
  let drainWaiters = [];

  const notify = (entry, fields) => {
    Object.assign(entry.status, fields);
    try { onUpdate({ ...entry.status }); } catch { /* 表示の失敗で保存は止めない */ }
  };

  function checkDrain() {
    if (running.size === 0 && waiting.length === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      waiters.forEach(resolve => resolve());
    }
  }

  // 解決（resolveUrl）を直列で行う。前の解決が終わってから自分の番になる。
  function resolveInOrder(entry) {
    const result = resolveChain.then(() => {
      if (entry.controller.signal.aborted) throw new CanceledError();
      return resolveUrl(entry);
    });
    // 鎖は成否にかかわらず次へつなぐ（1 本の失敗で解決が止まらないように）。
    resolveChain = result.then(() => {}, () => {});
    return result;
  }

  async function runJob(entry) {
    try {
      notify(entry, { state: 'resolving', percent: null, message: '動画の URL を確認中' });
      const found = await resolveInOrder(entry);
      if (entry.controller.signal.aborted) throw new CanceledError();
      if (!found?.url) throw new Error('動画の URL を取得できませんでした');
      notify(entry, { state: 'downloading', percent: 0, message: found.hd ? '保存中（HD）' : '保存中' });
      const result = await save(entry, found, percent => {
        notify(entry, { percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.floor(percent))) : null });
      });
      notify(entry, { state: 'done', percent: 100, message: '完了', fileName: result?.fileName || null, filePath: result?.filePath || null });
    } catch (error) {
      if (error instanceof CanceledError || entry.controller.signal.aborted) {
        jobs.delete(entry.id);
        notify(entry, { state: 'canceled', percent: null, message: '中止しました' });
      } else {
        notify(entry, { state: 'failed', percent: null, message: error?.message || '保存できませんでした' });
      }
    } finally {
      running.delete(entry);
      pump();
    }
  }

  // 空きスロット（最大 limit 本）があるだけ、待機中の先頭から走らせる。
  function pump() {
    while (running.size < limit && waiting.length > 0) {
      const entry = waiting.shift();
      running.add(entry);
      void runJob(entry);
    }
    checkDrain();
  }

  return {
    // 同じ動画が待ち・保存中なら足さない。
    add(job) {
      if (!validId(job?.id)) throw new TypeError('動画IDが必要です');
      if (jobs.has(job.id) && (running.has(jobs.get(job.id)) || waiting.includes(jobs.get(job.id)))) return false;
      seq += 1;
      const entry = {
        id: job.id,
        name: job.name || null,
        title: job.title || null,
        order: seq,
        controller: new AbortController(),
        status: { id: job.id, name: job.name || null, state: 'queued', percent: null, message: '待機中', fileName: null, filePath: null }
      };
      jobs.set(job.id, entry);
      waiting.push(entry);
      notify(entry, {});
      pump();
      return true;
    },
    // 待機中の動画は一覧から外す。保存中（確認中を含む）の動画は abort し、
    // runJob() 側で CanceledError として拾って中止として知らせる。
    cancel(id) {
      const entry = jobs.get(id);
      if (!entry) return false;
      const index = waiting.indexOf(entry);
      if (index !== -1) {
        waiting.splice(index, 1);
        jobs.delete(id);
        notify(entry, { state: 'canceled', percent: null, message: '中止しました' });
        checkDrain();
        return true;
      }
      if (running.has(entry)) {
        entry.controller.abort();
        return true;
      }
      return false;
    },
    // 失敗した動画を、同じ内容でもう一度キューに入れる。
    retry(id) {
      const entry = jobs.get(id);
      if (!entry || entry.status.state !== 'failed') return false;
      seq += 1;
      entry.order = seq;
      entry.controller = new AbortController();
      waiting.push(entry);
      notify(entry, { state: 'queued', percent: null, message: '待機中', fileName: null, filePath: null });
      pump();
      return true;
    },
    // 同時ダウンロード数を変える（設定変更で増減。増やしたら待機中が追加で走る）。
    setConcurrency(value) {
      limit = clampConcurrency(value);
      pump();
      return limit;
    },
    get concurrency() {
      return limit;
    },
    // ダウンロード タブに出す一覧。新しいものが上。
    list() {
      return [...jobs.values()].sort((a, b) => b.order - a.order).map(entry => ({ ...entry.status }));
    },
    get pending() {
      return waiting.map(job => job.id);
    },
    // 今走っている（解決中・保存中）動画の id（新しく走り出した順）。
    get active() {
      return [...running].map(entry => entry.id);
    },
    // 待ち・走行中がすべて終わるまで待つ（テスト用）。
    async idle() {
      while (running.size > 0 || waiting.length > 0) {
        await new Promise(resolve => drainWaiters.push(resolve));
      }
    }
  };
}

module.exports = {
  CanceledError,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  MAX_DOWNLOAD_CONCURRENCY,
  READ_PLAYER_SOURCES_SCRIPT,
  buildFileName,
  clampConcurrency,
  createDownloadQueue,
  extensionFor,
  httpErrorMessage,
  isVideoContentType,
  isVideoHostUrl,
  pickVideoUrl,
  sanitizeFileName,
  uniqueFilePath,
  videoIdFromUrl,
  videoPageUrl
};
