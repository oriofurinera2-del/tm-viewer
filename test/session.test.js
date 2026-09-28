'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestHandler, isBlockedUrl, isSiteUrl } = require('../src/main/session');

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
  const blocklist = [
    'juicyads.com',
    'realsrv.com',
    'magsrv.com',
    'jads.co',
    'endowmentoverhangutmost.com',
    'addthis.com',
    'google-analytics.com',
    'googletagmanager.com'
  ];
  assert.equal(isBlockedUrl('https://juicyads.com/ad.js', blocklist), true);
  assert.equal(isBlockedUrl('https://a.realsrv.com/ad.js', blocklist), true);
  assert.equal(isBlockedUrl('https://jads.co/ad.js', blocklist), true);
  assert.equal(isBlockedUrl('https://endowmentoverhangutmost.com/ad.js', blocklist), true);
  assert.equal(isBlockedUrl('https://addthis.com/widget.js', blocklist), true);
  assert.equal(isBlockedUrl('https://www.google-analytics.com/collect', blocklist), true);
  assert.equal(isBlockedUrl('https://www.googletagmanager.com/gtm.js', blocklist), true);
  assert.equal(isBlockedUrl('https://notjuicyads.com/ad.js', blocklist), false);
  assert.equal(isBlockedUrl('https://www.tokyomotion.net/ajax/video_tag', blocklist), false);
  assert.equal(isBlockedUrl('https://tokyomotion.net/vsrc/segment', blocklist), false);
});

test('開発時の通信ログは外部ホスト名と遮断結果だけを記録する', () => {
  const logs = [];
  const decisions = [];
  const handler = createRequestHandler(['realsrv.com'], {
    debugHosts: true,
    log: message => logs.push(message)
  });

  handler({ url: 'https://syndication.realsrv.com/path?secret=value' }, decision => decisions.push(decision));
  handler({ url: 'https://www.tokyomotion.net/ajax/video_tag' }, decision => decisions.push(decision));

  assert.deepEqual(decisions, [{ cancel: true }, { cancel: false }]);
  assert.deepEqual(logs, ['[tm-viewer] host=syndication.realsrv.com blocked']);
  assert.equal(logs.join('\n').includes('/path'), false);
  assert.equal(logs.join('\n').includes('secret'), false);
});
