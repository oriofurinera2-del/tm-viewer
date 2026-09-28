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

// 1 本ずつ順に保存するキュー。resolveUrl と save は main（Electron）側から渡す。
// 状態の変化は onUpdate に { id, name, state, percent, message, fileName } で知らせる。
// state: queued / resolving / downloading / done / failed
function createDownloadQueue({ resolveUrl, save, onUpdate = () => {} }) {
  if (typeof resolveUrl !== 'function' || typeof save !== 'function') {
    throw new TypeError('resolveUrl と save が必要です');
  }
  const waiting = [];
  let active = null;
  let loop = null;

  const notify = (job, fields) => {
    Object.assign(job.status, fields);
    try { onUpdate({ ...job.status }); } catch { /* 表示の失敗で保存は止めない */ }
  };

  async function run() {
    while (waiting.length > 0) {
      active = waiting.shift();
      const job = active;
      try {
        notify(job, { state: 'resolving', percent: null, message: '動画の URL を確認中' });
        const found = await resolveUrl(job);
        if (!found?.url) throw new Error('動画の URL を取得できませんでした');
        notify(job, { state: 'downloading', percent: 0, message: found.hd ? '保存中（HD）' : '保存中' });
        const result = await save(job, found, percent => {
          notify(job, { percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.floor(percent))) : null });
        });
        notify(job, { state: 'done', percent: 100, message: '完了', fileName: result?.fileName || null });
      } catch (error) {
        notify(job, { state: 'failed', percent: null, message: error?.message || '保存できませんでした' });
      }
      active = null;
    }
  }

  // 保存の流れは常に 1 つだけ。終わった直後に足された分も取りこぼさない。
  function kick() {
    if (!loop) {
      loop = run().finally(() => {
        loop = null;
        if (waiting.length > 0) kick();
      });
    }
    return loop;
  }

  return {
    // 同じ動画が待ち・保存中なら足さない。
    add(job) {
      if (!validId(job?.id)) throw new TypeError('動画IDが必要です');
      if (active?.id === job.id || waiting.some(item => item.id === job.id)) return false;
      const entry = { ...job, status: { id: job.id, name: job.name || null, state: 'queued', percent: null, message: '待機中', fileName: null } };
      waiting.push(entry);
      notify(entry, {});
      kick();
      return true;
    },
    get pending() {
      return waiting.map(job => job.id);
    },
    get active() {
      return active ? active.id : null;
    },
    // 待ちがすべて終わるまで待つ（テスト用）。
    async idle() {
      while (loop) await loop;
    }
  };
}

module.exports = {
  READ_PLAYER_SOURCES_SCRIPT,
  buildFileName,
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
