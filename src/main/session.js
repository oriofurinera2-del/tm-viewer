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

function getUploadText(uploadData) {
  if (!Array.isArray(uploadData)) return '';
  const chunks = uploadData
    .filter(part => part && part.bytes)
    .map(part => Buffer.from(part.bytes));
  return Buffer.concat(chunks).toString('utf8');
}

function captureVideoTagResponse(siteSession, requestId, log) {
  const filter = siteSession.webRequest.filterResponseData(requestId);
  const chunks = [];
  let byteLength = 0;
  const previewLimit = 4096;

  filter.on('data', chunk => {
    if (byteLength < previewLimit) {
      const preview = Buffer.from(chunk).subarray(0, previewLimit - byteLength);
      chunks.push(preview);
      byteLength += preview.length;
    }
    filter.write(chunk);
  });
  filter.on('end', () => {
    log(`[tm-viewer] video-tag response=${Buffer.concat(chunks).toString('utf8').slice(0, 500)}`);
    filter.end();
  });
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

function configureSession(siteSession, blocklistPath, options = {}) {
  const blocklist = readBlocklist(blocklistPath);
  const requestHandler = createRequestHandler(blocklist, options);
  siteSession.webRequest.onBeforeRequest(
    { urls: ['*://*/*'] },
    (details, callback) => {
      if (options.debugHosts && isVideoTagRequest(details)) {
        const log = options.log || console.log;
        log(`[tm-viewer] video-tag request=${getUploadText(details.uploadData)}`);
        captureVideoTagResponse(siteSession, details.id, log);
      }
      requestHandler(details, callback);
    }
  );
  return blocklist;
}

module.exports = {
  SITE_HOSTS,
  configureSession,
  createRequestHandler,
  captureVideoTagResponse,
  getUploadText,
  isBlockedUrl,
  isSiteUrl,
  isVideoTagRequest,
  readBlocklist
};
