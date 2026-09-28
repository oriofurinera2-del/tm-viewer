'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  DEFAULT_ALLOWLIST,
  buildGoogleSearchUrl,
  createRequestHandler,
  enableVideoTagDebug,
  isAllowedUrl,
  isGoogleHost,
  isGoogleSearchPageUrl,
  isSiteUrl,
  isVideoTagRequest,
  readAllowlist
} = require('../src/main/session');

test('Google 検索 URL は空語を作らず、検索語を安全に組み立てる', () => {
  assert.equal(buildGoogleSearchUrl(''), null);
  assert.equal(buildGoogleSearchUrl('  '), null);
  assert.equal(
    buildGoogleSearchUrl('a&b 日本語'),
    'https://www.google.com/search?q=site%3Atokyomotion.net%2Fvideo%2F+a%26b+%E6%97%A5%E6%9C%AC%E8%AA%9E&safe=off'
  );
  assert.equal(
    buildGoogleSearchUrl(' site:tokyomotion.net/video/ a&b 日本語 '),
    'https://www.google.com/search?q=site%3Atokyomotion.net%2Fvideo%2F+a%26b+%E6%97%A5%E6%9C%AC%E8%AA%9E&safe=off'
  );
  assert.equal(buildGoogleSearchUrl('site:tokyomotion.net/video/'), null);
});

test('Google のホストは検索表示中だけ通し、通常の許可リストには加えない', () => {
  let active = false;
  const decisions = [];
  const handler = createRequestHandler([], { isGoogleSearchRequestActive: () => active });
  // 検索表示中でないときは Google の描画・reCAPTCHA ホストも止める
  handler({ url: 'https://www.google.com/search?q=test' }, decision => decisions.push(decision));
  handler({ url: 'https://www.gstatic.com/recaptcha/releases/x.js' }, decision => decisions.push(decision));
  active = true;
  // 検索表示中は google.com / *.google.com / *.gstatic.com を通す
  handler({ url: 'https://www.google.com/search?q=test' }, decision => decisions.push(decision));
  handler({ url: 'https://google.com/' }, decision => decisions.push(decision));
  handler({ url: 'https://www.gstatic.com/recaptcha/releases/x.js' }, decision => decisions.push(decision));
  // 検索表示中でも Google 以外は通さない
  handler({ url: 'https://example.test/' }, decision => decisions.push(decision));
  assert.deepEqual(decisions, [
    { cancel: true }, { cancel: true },
    { cancel: false }, { cancel: false }, { cancel: false },
    { cancel: true }
  ]);
});

test('isGoogleHost は google.com とそのサブドメイン・*.gstatic.com だけを検索ホストとする', () => {
  for (const host of ['google.com', 'www.google.com', 'apis.google.com', 'www.gstatic.com']) {
    assert.equal(isGoogleHost(host), true, host);
  }
  for (const host of ['gstatic.com', 'notgoogle.com', 'google.com.evil.example', 'example.com', '', null]) {
    assert.equal(isGoogleHost(host), false, String(host));
  }
});

test('isGoogleSearchPageUrl は Google の /search だけを取り込み対象とし、CAPTCHA・非 Google は除く', () => {
  assert.equal(isGoogleSearchPageUrl('https://www.google.com/search?q=test'), true);
  assert.equal(isGoogleSearchPageUrl('https://google.com/search?q=test'), true);
  assert.equal(isGoogleSearchPageUrl('https://www.google.com/sorry/index?continue=x'), false);
  assert.equal(isGoogleSearchPageUrl('https://www.google.com/'), false);
  assert.equal(isGoogleSearchPageUrl('https://www.tokyomotion.net/video/1'), false);
  assert.equal(isGoogleSearchPageUrl('not a url'), false);
});

test('サイト本体と www だけをサイト遷移として許可する', () => {
  assert.equal(isSiteUrl('https://tokyomotion.net/login'), true);
  assert.equal(isSiteUrl('https://www.tokyomotion.net/ajax/video_tag'), true);
  assert.equal(isSiteUrl('https://tokyomotion.net/vsrc/example'), true);
  assert.equal(isSiteUrl('https://tokyomotion.net.evil.example/'), false);
  assert.equal(isSiteUrl('https://cdn.tokyomotion.net/'), false);
  assert.equal(isSiteUrl('https://example.com/'), false);
  assert.equal(isSiteUrl('file:///tmp/page.html'), false);
});

const ALLOWLIST_PATH = path.join(__dirname, '../data/allowlist.json');

test('許可リストにあるホストだけ通し、それ以外（ランダムな名前の配信元を含む）は止める', () => {
  const allowlist = readAllowlist(ALLOWLIST_PATH);
  const allowed = [
    'https://www.tokyomotion.net/ajax/video_tag',
    'https://tokyomotion.net/vsrc/segment',
    'https://www44.tokyomotion.net/video.mp4',
    'https://live.tokyomotion.net/',
    'https://cdn.tokyo-motion.net/thumb.jpg',
    'https://cdn.fluidplayer.com/v3/current/fluidplayer.min.js',
    'https://maxcdn.bootstrapcdn.com/bootstrap.min.css',
    'https://fonts.googleapis.com/css',
    'https://fonts.gstatic.com/font.woff2',
    'https://ajax.googleapis.com/ajax/libs/jquery.js'
  ];
  const blocked = [
    'https://syndication.realsrv.com/ad.js',
    'https://vast.random-name.example/vast.xml',
    'https://www.google-analytics.com/collect',
    'https://tokyomotion.net.evil.example/',
    'https://nottokyomotion.net/',
    'https://evil-tokyo-motion.net/',
    'https://bootstrapcdn.com/',
    'https://fluidplayer.com/',
    'https://other.fluidplayer.com/',
    'https://googleapis.com/',
    'https://www.googleapis.com/',
    'not a url'
  ];
  for (const url of allowed) assert.equal(isAllowedUrl(url, allowlist), true, url);
  for (const url of blocked) assert.equal(isAllowedUrl(url, allowlist), false, url);
});

test('許可リストが読めない・空のときは初期値を使う', () => {
  assert.deepEqual(readAllowlist(path.join(__dirname, 'no-such-allowlist.json')), [...DEFAULT_ALLOWLIST]);
  assert.deepEqual(readAllowlist(ALLOWLIST_PATH), [...DEFAULT_ALLOWLIST]);
});

test('開発時の通信ログは外部ホスト名と、通した/止めたの結果だけを記録する', () => {
  const logs = [];
  const decisions = [];
  const handler = createRequestHandler(['www.tokyomotion.net', 'cdn.fluidplayer.com'], {
    debugHosts: true,
    log: message => logs.push(message)
  });

  handler({ url: 'https://syndication.realsrv.com/path?secret=value' }, decision => decisions.push(decision));
  handler({ url: 'https://cdn.fluidplayer.com/player.js?secret=value' }, decision => decisions.push(decision));
  handler({ url: 'https://www.tokyomotion.net/ajax/video_tag' }, decision => decisions.push(decision));

  assert.deepEqual(decisions, [{ cancel: true }, { cancel: false }, { cancel: false }]);
  assert.deepEqual(logs, [
    '[tm-viewer] host=syndication.realsrv.com blocked',
    '[tm-viewer] host=cdn.fluidplayer.com allowed'
  ]);
  assert.equal(logs.join(' ').includes('/path'), false);
  assert.equal(logs.join(' ').includes('secret'), false);
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

test('デバッグ時だけタグ通信本文と応答先頭500文字を記録する', async () => {
  const logs = [];
  const debuggerApi = new EventEmitter();
  const commands = [];
  debuggerApi.attach = version => { debuggerApi.version = version; };
  debuggerApi.sendCommand = (method, params) => {
    commands.push({ method, params });
    if (method === 'Network.getResponseBody') {
      return Promise.resolve({ body: 'x'.repeat(600), base64Encoded: false });
    }
    return Promise.resolve({});
  };

  assert.equal(enableVideoTagDebug({ debugger: debuggerApi }, message => logs.push(message)), true);
  debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
    requestId: '42',
    request: {
      method: 'POST',
      url: 'https://www.tokyomotion.net/ajax/video_tag',
      postData: 'video_id=12'
    }
  });
  debuggerApi.emit('message', {}, 'Network.loadingFinished', { requestId: '42' });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(logs, [
    '[tm-viewer] video-tag request=video_id=12',
    `[tm-viewer] video-tag response=${'x'.repeat(500)}`
  ]);
  assert.equal(debuggerApi.version, '1.3');
  assert.deepEqual(commands, [
    { method: 'Network.enable', params: undefined },
    { method: 'Network.getResponseBody', params: { requestId: '42' } }
  ]);
});

test('通常のセッション処理はタグ通信の本文と応答を取得しない', () => {
  let listener;
  const fakeSession = {
    webRequest: {
      onBeforeRequest: (_filter, handler) => { listener = handler; }
    }
  };

  const handler = createRequestHandler([], {});
  fakeSession.webRequest.onBeforeRequest({}, handler);
  listener({
    method: 'POST',
    url: 'https://www.tokyomotion.net/ajax/video_tag',
    get uploadData() { assert.fail('本文を取得してはいけない'); }
  }, () => {});
});
