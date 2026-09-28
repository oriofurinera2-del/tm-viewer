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

function isBlockedUrl(value, blocklist) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return blocklist.some(domain => hostnameMatches(hostname, domain));
  } catch {
    return false;
  }
}

function configureSession(siteSession, blocklistPath) {
  const blocklist = readBlocklist(blocklistPath);
  siteSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({ cancel: isBlockedUrl(details.url, blocklist) });
  });
  return blocklist;
}

module.exports = { SITE_HOSTS, configureSession, isBlockedUrl, isSiteUrl, readBlocklist };
