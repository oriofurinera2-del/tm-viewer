'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUserVideosUrl, createFetcher } = require('../src/main/fetcher');

function memoryStore(initial = {}) {
  let cache = initial;
  return {
    loadFeedCache: () => cache,
    saveFeedCache: value => { cache = value; },
    value: () => cache
  };
}

function makeFetcher({ cache, responses, clock = 0, intervalMs = 2000, cacheMinutes = 30 } = {}) {
  const calls = [];
  const sleeps = [];
  const store = memoryStore(cache);
  let now = clock;
  const fetcher = createFetcher({
    request: async (url, options) => {
      calls.push({ url, options, at: now });
      return responses.shift();
    },
    parseVideoList: body => ({ videos: [{ id: Number(body) }] }),
    store,
    intervalMs,
    cacheMinutes,
    now: () => now,
    sleep: async delay => {
      sleeps.push(delay);
      now += delay;
    }
  });
  return { calls, fetcher, sleeps, store, setNow: value => { now = value; } };
}

test('ユーザー動画の取得は1件ずつ、既定で2秒間隔にする', async () => {
  const harness = makeFetcher({
    responses: [
      { status: 200, body: '101' },
      { status: 200, body: '102' }
    ]
  });

  const result = await harness.fetcher.fetchUsers(['user a', 'user-b']);

  assert.deepEqual(result, {
    results: [
      { user: 'user a', videos: [{ id: 101 }], fetchedAt: 0, fromCache: false },
      { user: 'user-b', videos: [{ id: 102 }], fetchedAt: 2000, fromCache: false }
    ],
    stopped: false,
    status: null
  });
  assert.deepEqual(harness.sleeps, [2000]);
  assert.deepEqual(harness.calls, [
    { url: buildUserVideosUrl('user a'), options: undefined, at: 0 },
    { url: buildUserVideosUrl('user-b'), options: undefined, at: 2000 }
  ]);
});

test('ユーザーごとの30分キャッシュを使い、期限後だけ再取得する', async () => {
  const harness = makeFetcher({
    cache: { user: { fetchedAt: 0, videos: [{ id: 1 }] } },
    responses: [{ status: 200, body: '2' }],
    clock: (30 * 60 * 1000) - 1
  });

  assert.deepEqual(await harness.fetcher.fetchUserVideos('user'), {
    user: 'user', videos: [{ id: 1 }], fetchedAt: 0, fromCache: true
  });
  assert.equal(harness.calls.length, 0);

  harness.setNow(30 * 60 * 1000);
  assert.deepEqual(await harness.fetcher.fetchUserVideos('user'), {
    user: 'user', videos: [{ id: 2 }], fetchedAt: 30 * 60 * 1000, fromCache: false
  });
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.store.value().user.videos, [{ id: 2 }]);
});

test('429 または 5xx を受けた回は残りのユーザー取得を止める', async () => {
  const harness = makeFetcher({
    responses: [
      { status: 200, body: '1' },
      { status: 429, body: '' },
      { status: 200, body: '3' }
    ]
  });

  const result = await harness.fetcher.fetchUsers(['first', 'limited', 'not-requested']);

  assert.deepEqual(result, {
    results: [{ user: 'first', videos: [{ id: 1 }], fetchedAt: 0, fromCache: false }],
    stopped: true,
    status: 429
  });
  assert.deepEqual(harness.calls.map(call => call.url), [
    buildUserVideosUrl('first'),
    buildUserVideosUrl('limited')
  ]);

  const serverError = makeFetcher({ responses: [{ status: 503, body: '' }] });
  assert.deepEqual(await serverError.fetcher.fetchUsers(['unavailable', 'not-requested']), {
    results: [],
    stopped: true,
    status: 503
  });
  assert.equal(serverError.calls.length, 1);
});

test('汎用 fetch もユーザー動画と同じキューと間隔を使う', async () => {
  const harness = makeFetcher({
    responses: [
      { status: 200, body: 'list' },
      { status: 200, body: '2' }
    ]
  });

  const list = harness.fetcher.fetch('https://www.tokyomotion.net/user/me/friends?page=1');
  const videos = harness.fetcher.fetchUserVideos('user');

  assert.deepEqual(await list, { status: 200, body: 'list' });
  assert.deepEqual(await videos, {
    user: 'user', videos: [{ id: 2 }], fetchedAt: 2000, fromCache: false
  });
  assert.deepEqual(harness.sleeps, [2000]);
});

test('URL はユーザー名をエンコードしてサイトの動画一覧だけを取得する', () => {
  assert.equal(
    buildUserVideosUrl('name/with space'),
    'https://www.tokyomotion.net/user/name%2Fwith%20space/videos'
  );
});
