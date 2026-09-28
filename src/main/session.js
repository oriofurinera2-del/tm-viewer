'use strict';

const fs = require('node:fs');

const SITE_HOSTS = new Set(['tokyomotion.net', 'www.tokyomotion.net']);

function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
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

function readBlocklist(blocklistPath) {
  try {
    const values = JSON.parse(fs.readFileSync(blocklistPath, 'utf8'));
    if (!Array.isArray(values)) return [];
    return values
      .filter(value => typeof value === 'string')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isBlockedUrl(value, blocklist) {
  const hostname = getHostname(value);
  return hostname !== null && blocklist.some(domain => hostnameMatches(hostname, domain));
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

function createRequestHandler(blocklist, { debugHosts = false, log = console.log } = {}) {
  return (details, callback) => {
    const hostname = getHostname(details.url);
    const blocked = hostname !== null && blocklist.some(domain => hostnameMatches(hostname, domain));

    if (debugHosts && hostname !== null && !SITE_HOSTS.has(hostname)) {
      log(`[tm-viewer] host=${hostname} ${blocked ? 'blocked' : 'allowed'}`);
    }
    callback({ cancel: blocked });
  };
}

function configureSession(siteSession, blocklistPath, options) {
  const blocklist = readBlocklist(blocklistPath);
  siteSession.webRequest.onBeforeRequest(
    { urls: ['*://*/*'] },
    createRequestHandler(blocklist, options)
  );
  return blocklist;
}

module.exports = {
  SITE_HOSTS,
  configureSession,
  createRequestHandler,
  enableVideoTagDebug,
  getResponsePreview,
  isBlockedUrl,
  isSiteUrl,
  isVideoTagRequest,
  readBlocklist
};
