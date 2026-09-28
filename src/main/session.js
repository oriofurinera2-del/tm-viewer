'use strict';

const fs = require('node:fs');

const SITE_HOSTS = new Set(['tokyomotion.net', 'www.tokyomotion.net']);
const GOOGLE_SEARCH_HOST = 'www.google.com';
const GOOGLE_SITE_QUERY_PREFIX = 'site:tokyomotion.net/video/';
// 検索表示中の Google ビューにだけ通すホスト（DESIGN 4.10）。描画と reCAPTCHA に要る。
// 通常のサイト許可リストには入れない（検索表示中以外は通さない）。
const GOOGLE_SEARCH_HOST_PATTERNS = Object.freeze(['google.com', '*.google.com', '*.gstatic.com']);

// サイト表示の通信は許可リストのホストだけ通す（DESIGN 4.5）。
// 書き方: "example.com" はそのホストだけ、"*.example.com" はそのサブドメインだけ（example.com 自身は含まない）。
// data/allowlist.json が読めないときは、この初期値を使う。
const DEFAULT_ALLOWLIST = Object.freeze([
  'tokyomotion.net',
  '*.tokyomotion.net',
  'tokyo-motion.net',
  '*.tokyo-motion.net',
  'cdn.fluidplayer.com',
  '*.bootstrapcdn.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ajax.googleapis.com'
]);

function hostnameMatches(hostname, pattern) {
  if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1));
  return hostname === pattern;
}

function isSiteUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && SITE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Google 検索の描画・reCAPTCHA に使うホストか（検索表示中だけ通す判定に使う）。
function isGoogleHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  const host = hostname.toLowerCase();
  return GOOGLE_SEARCH_HOST_PATTERNS.some(pattern => hostnameMatches(host, pattern));
}

// siteView が今 Google の検索結果ページ（/search）を開いているか。/sorry/（CAPTCHA）や
// 非 Google ページは false。取り込み前の確認に使う（DESIGN 4.10）。
function isGoogleSearchPageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && (host === 'google.com' || host === 'www.google.com')
      && url.pathname === '/search';
  } catch {
    return false;
  }
}

function buildGoogleSearchUrl(term) {
  if (typeof term !== 'string' || !term.trim()) return null;
  // 利用者が検索演算子ごと貼り付けても、先頭の指定は1回だけ外して付け直す。
  const keyword = term.trim().replace(/^site:tokyomotion\.net\/video\/\s*/i, '').trim();
  if (!keyword) return null;
  // セーフサーチはオフで送る（DESIGN 4.10、2026-09-29 ユーザー決定）。結果件数には影響しないが、
  // Google のプレビュー画像のぼかしを外すためユーザー指定で off にする。
  const query = new URLSearchParams({ q: `${GOOGLE_SITE_QUERY_PREFIX} ${keyword}`, safe: 'off' });
  return `https://${GOOGLE_SEARCH_HOST}/search?${query}`;
}

function readAllowlist(allowlistPath) {
  try {
    const values = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    if (!Array.isArray(values)) return [...DEFAULT_ALLOWLIST];
    const list = values
      .filter(value => typeof value === 'string')
      .map(value => value.trim().toLowerCase())
      .filter(value => value && value !== '*.');
    return list.length > 0 ? list : [...DEFAULT_ALLOWLIST];
  } catch {
    return [...DEFAULT_ALLOWLIST];
  }
}

function getHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedUrl(value, allowlist) {
  const hostname = getHostname(value);
  return hostname !== null && allowlist.some(pattern => hostnameMatches(hostname, pattern));
}

function isVideoTagRequest(details) {
  if (details.method !== 'POST') return false;
  try {
    const url = new URL(details.url);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && SITE_HOSTS.has(url.hostname.toLowerCase())
      && url.pathname === '/ajax/video_tag';
  } catch {
    return false;
  }
}

function getResponsePreview(result) {
  if (!result || typeof result.body !== 'string') return '';
  const body = result.base64Encoded
    ? Buffer.from(result.body, 'base64').toString('utf8')
    : result.body;
  return body.slice(0, 500);
}

function enableVideoTagDebug(webContents, log = console.log) {
  const debuggerApi = webContents.debugger;
  const requestIds = new Set();

  try {
    debuggerApi.attach('1.3');
  } catch {
    log('[tm-viewer] video-tag debug unavailable');
    return false;
  }

  debuggerApi.on('message', (_event, method, params) => {
    const requestId = params?.requestId;
    if (method === 'Network.requestWillBeSent' && isVideoTagRequest(params?.request)) {
      requestIds.add(requestId);
      log(`[tm-viewer] video-tag request=${params.request.postData || ''}`);
      return;
    }
    if (method === 'Network.loadingFailed') {
      requestIds.delete(requestId);
      return;
    }
    if (method === 'Network.loadingFinished' && requestIds.delete(requestId)) {
      debuggerApi.sendCommand('Network.getResponseBody', { requestId })
        .then(result => log(`[tm-viewer] video-tag response=${getResponsePreview(result)}`))
        .catch(() => log('[tm-viewer] video-tag response unavailable'));
    }
  });
  debuggerApi.sendCommand('Network.enable')
    .catch(() => log('[tm-viewer] video-tag debug unavailable'));
  return true;
}

function createRequestHandler(allowlist, { debugHosts = false, isGoogleSearchRequestActive = () => false, log = console.log } = {}) {
  return (details, callback) => {
    const hostname = getHostname(details.url);
    // Google は検索表示中の Google ビューに限り、描画・reCAPTCHA に要るホストだけ通す。
    // 通常のサイト許可リストには入れない（DESIGN 4.10）。
    const isSearchRequest = isGoogleSearchRequestActive() && isGoogleHost(hostname);
    const blocked = !isAllowedUrl(details.url, allowlist) && !isSearchRequest;

    // 開発時だけ、サイト本体以外のホスト名（URL 全体ではない）と通した/止めたを記録する。
    // 止めたホストでサイトの機能が壊れたら、ここを見て許可リストに足す。
    if (debugHosts && hostname !== null && !SITE_HOSTS.has(hostname)) {
      log(`[tm-viewer] host=${hostname} ${blocked ? 'blocked' : 'allowed'}`);
    }
    callback({ cancel: blocked });
  };
}

function configureSession(siteSession, allowlistPath, options) {
  const allowlist = readAllowlist(allowlistPath);
  siteSession.webRequest.onBeforeRequest(
    { urls: ['*://*/*'] },
    createRequestHandler(allowlist, options)
  );
  return allowlist;
}

module.exports = {
  DEFAULT_ALLOWLIST,
  SITE_HOSTS,
  buildGoogleSearchUrl,
  configureSession,
  createRequestHandler,
  enableVideoTagDebug,
  getHostname,
  getResponsePreview,
  isAllowedUrl,
  isGoogleHost,
  isGoogleSearchPageUrl,
  isSiteUrl,
  isVideoTagRequest,
  readAllowlist
};
