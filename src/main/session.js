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
  isBlockedUrl,
  isSiteUrl,
  readBlocklist
};
