'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedUrl, isSiteUrl } = require('../src/main/session');

test('サイト本体と www だけをサイト遷移として許可する', () => {
  assert.equal(isSiteUrl('https://tokyomotion.net/login'), true);
  assert.equal(isSiteUrl('https://www.tokyomotion.net/ajax/video_tag'), true);
  assert.equal(isSiteUrl('https://tokyomotion.net/vsrc/example'), true);
  assert.equal(isSiteUrl('https://tokyomotion.net.evil.example/'), false);
  assert.equal(isSiteUrl('https://cdn.tokyomotion.net/'), false);
  assert.equal(isSiteUrl('https://example.com/'), false);
  assert.equal(isSiteUrl('file:///tmp/page.html'), false);
});

test('広告ドメインとそのサブドメインだけを遮断する', () => {
  const blocklist = ['juicyads.com', 'realsrv.com', 'magsrv.com'];
  assert.equal(isBlockedUrl('https://juicyads.com/ad.js', blocklist), true);
  assert.equal(isBlockedUrl('https://a.realsrv.com/ad.js', blocklist), true);
  assert.equal(isBlockedUrl('https://notjuicyads.com/ad.js', blocklist), false);
  assert.equal(isBlockedUrl('https://www.tokyomotion.net/ajax/video_tag', blocklist), false);
  assert.equal(isBlockedUrl('https://tokyomotion.net/vsrc/segment', blocklist), false);
});
