'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  configureSession,
  createRequestHandler,
  isBlockedUrl,
  isSiteUrl,
  isVideoTagRequest
} = require('../src/main/session');

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

test('タグ通信の記録対象はサイト本体の POST /ajax/video_tag に限る', () => {
  assert.equal(isVideoTagRequest({
    method: 'POST',
    url: 'https://www.tokyomotion.net/ajax/video_tag'
  }), true);
  assert.equal(isVideoTagRequest({
    method: 'GET',
    url: 'https://www.tokyomotion.net/ajax/video_tag'
  }), false);
  assert.equal(isVideoTagRequest({
    method: 'POST',
    url: 'https://www.tokyomotion.net/ajax/video_tags'
  }), false);
  assert.equal(isVideoTagRequest({
    method: 'POST',
    url: 'https://tokyomotion.net.evil.example/ajax/video_tag'
  }), false);
});

test('デバッグ時だけタグ通信本文と応答先頭500文字を記録する', () => {
  const logs = [];
  const filter = new EventEmitter();
  const forwarded = [];
  filter.write = chunk => forwarded.push(chunk);
  filter.end = () => { filter.ended = true; };
  let listener;
  const fakeSession = {
    webRequest: {
      onBeforeRequest: (_filter, handler) => { listener = handler; },
      filterResponseData: requestId => {
        assert.equal(requestId, 42);
        return filter;
      }
    }
  };

  configureSession(fakeSession, path.join(__dirname, '../data/blocklist.json'), {
    debugHosts: true,
    log: message => logs.push(message)
  });
  listener({
    id: 42,
    method: 'POST',
    url: 'https://www.tokyomotion.net/ajax/video_tag',
    uploadData: [{ bytes: Buffer.from('video_id=12') }]
  }, () => {});
  const response = 'x'.repeat(600);
  filter.emit('data', Buffer.from(response));
  filter.emit('end');

  assert.deepEqual(logs, [
    '[tm-viewer] video-tag request=video_id=12',
    `[tm-viewer] video-tag response=${response.slice(0, 500)}`
  ]);
  assert.deepEqual(forwarded, [Buffer.from(response)]);
  assert.equal(filter.ended, true);
});

test('非デバッグ時はタグ通信の本文と応答を取得しない', () => {
  let listener;
  const fakeSession = {
    webRequest: {
      onBeforeRequest: (_filter, handler) => { listener = handler; },
      filterResponseData: () => assert.fail('非デバッグ時に応答を取得してはいけない')
    }
  };

  configureSession(fakeSession, path.join(__dirname, '../data/blocklist.json'));
  listener({
    id: 42,
    method: 'POST',
    url: 'https://www.tokyomotion.net/ajax/video_tag',
    uploadData: [{ bytes: Buffer.from('video_id=12') }]
  }, () => {});
});
