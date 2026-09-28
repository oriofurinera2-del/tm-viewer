'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFeedService,
  estimatePostedAt,
  NEW_TAG_LIMIT,
  userListUrl,
  userVideosUrl,
  videoTagRequest
} = require('../src/main/feed');
const { createFetcher } = require('../src/main/fetcher');

function memoryStore({ feedCache = {}, state = {} } = {}) {
  let cache = feedCache;
  let savedState = state;
  return {
    loadFeedCache: () => cache,
    saveFeedCache: value => { cache = value; },
    loadState: () => savedState,
    saveState: value => { savedState = value; },
    cache: () => cache,
    state: () => savedState
  };
}

function harness({ replies = {}, store, now = 1_000_000, appPageSize, sitePageSize } = {}) {
  const calls = [];
  const request = async url => {
      calls.push(url);
      if (!(url in replies)) throw new Error(`unexpected URL: ${url}`);
      return { status: 200, body: JSON.stringify(replies[url]) };
  };
  const fetcher = {
    fetch: request,
    fetchUserVideos: async user => {
      const response = await request(userVideosUrl(user));
      return { user, videos: JSON.parse(response.body).videos, fetchedAt: now, fromCache: false };
    }
  };
  const parse = body => JSON.parse(body);
  const feedStore = store || memoryStore();
  return {
    calls,
    service: createFeedService({
      fetcher,
      store: feedStore,
      parseUserList: parse,
      parseVideoList: parse,
      now: () => now,
      appPageSize,
      sitePageSize
    }),
    store: feedStore
  };
}

test('更新はフレンド全ページと購読一覧を読み、1人につき動画1ページだけ取得する', async () => {
  const me = 'me user';
  const replies = {
    [userListUrl(me, 'friends')]: { users: ['friend-a'], lastPage: 2 },
    [userListUrl(me, 'friends', 2)]: { users: ['friend-b'], lastPage: 2 },
    [userListUrl(me, 'subscriptions')]: { users: ['friend-a', 'sub-a'], lastPage: 9 },
    [userVideosUrl('friend-a')]: { videos: [{ id: 30, title: 'a', ago: '2 時 前', private: true }] },
    [userVideosUrl('friend-b')]: { videos: [{ id: 20, title: 'b', ago: '1 日 前', private: false }] },
    [userVideosUrl('sub-a')]: { videos: [{ id: 10, title: 'c', ago: '3 日 前', private: true }] }
  };
  const h = harness({ replies, now: 2_000_000 });
  const progress = [];

  const result = await h.service.refresh({ me, onProgress: value => progress.push(value) });

  assert.deepEqual(result.friends, ['friend-a', 'friend-b']);
  assert.deepEqual(result.subscriptions, ['friend-a', 'sub-a']);
  assert.deepEqual(h.calls, [
    userListUrl(me, 'friends'), userListUrl(me, 'friends', 2), userListUrl(me, 'subscriptions'),
    userVideosUrl('friend-a'), userVideosUrl('friend-b'), userVideosUrl('sub-a')
  ]);
  assert.deepEqual(progress, [
    { done: 0, total: 3 },
    { done: 1, total: 3, user: 'friend-a' },
    { done: 2, total: 3, user: 'friend-b' },
    { done: 3, total: 3, user: 'sub-a' }
  ]);
  assert.equal(h.store.cache()['friend-a'].videos[0].kind, 'friend');
  assert.equal(h.store.cache()['sub-a'].videos[0].kind, 'subscription');
  assert.equal(h.store.state().me, me);
});

test('30分以内の更新はキャッシュの古いページを新着と誤認せず、動画を再取得しない', async () => {
  const me = 'me';
  const user = 'friend-a';
  const store = memoryStore({
    feedCache: {
      [user]: {
        fetchedAt: 999,
        fetchedSitePages: [1, 2],
        videos: [
          { id: 30, user, kind: 'friend', private: false, firstSeenAt: 1 },
          { id: 20, user, kind: 'friend', private: false, firstSeenAt: 1 },
          { id: 10, user, kind: 'friend', private: false, firstSeenAt: 1 }
        ]
      }
    }
  });
  const calls = [];
  const parse = body => JSON.parse(body);
  const fetcher = createFetcher({
    request: async url => {
      calls.push(url);
      if (url === userListUrl(me, 'friends')) return { status: 200, body: JSON.stringify({ users: [user], lastPage: 1 }) };
      throw new Error(`動画を再取得しました: ${url}`);
    },
    parseVideoList: parse,
    store,
    intervalMs: 0,
    now: () => 1_000
  });
  const service = createFeedService({ fetcher, store, parseUserList: parse, parseVideoList: parse, now: () => 1_000, sitePageSize: 2 });

  await service.refresh({ me, includeSubscriptions: false });

  assert.deepEqual(calls, [userListUrl(me, 'friends')]);
  assert.deepEqual(store.cache()[user].fetchedSitePages, [1, 2]);
});

test('全体フィードは ID の新しい順で、ミュートと見られる動画だけを反映する', () => {
  const store = memoryStore({
    state: { lastOpenedAt: 100, watched: [30], muted: ['friend-b'] },
    feedCache: {
      'friend-a': { videos: [{ id: 30, user: 'friend-a', kind: 'friend', private: true, firstSeenAt: 200 }] },
      'friend-b': { videos: [{ id: 40, user: 'friend-b', kind: 'friend', private: false, firstSeenAt: 200 }] },
      'friend-empty': { kind: 'friend', videos: [] },
      'sub-a': { videos: [{ id: 20, user: 'sub-a', kind: 'subscription', private: true, firstSeenAt: 200 }] }
    }
  });
  const h = harness({ store });

  assert.deepEqual(h.service.getFeed().videos.map(video => [video.id, video.isNew, video.watched]), [[30, false, true]]);
  assert.deepEqual(h.service.getFeed({ selectedUser: 'friend-b' }).videos.map(video => video.id), [40]);
  assert.deepEqual(h.service.getFeed({ viewableOnly: false }).videos.map(video => video.id), [30, 20]);
  assert.deepEqual(h.service.getPeople({ viewableOnly: false }).map(person => [person.user, person.unread, person.muted]), [
    ['friend-b', 1, true], ['sub-a', 1, false], ['friend-a', 0, false], ['friend-empty', 0, false]
  ]);
});

test('視聴済み・ミュート・フィードを開いた時刻を state に保存する', () => {
  const h = harness({ now: 999 });

  h.service.markWatched(12);
  h.service.setMuted('user-a', true);
  h.service.markFeedOpened();
  h.service.markWatched(12, false);
  h.service.setMuted('user-a', false);

  assert.deepEqual(h.store.state(), { watched: [], muted: [], lastOpenedAt: 999 });
});

test('個人の100件ページは必要な古いサイトページだけ取得し、取得済みを保存する', async () => {
  const user = 'friend-a';
  const store = memoryStore({
    feedCache: {
      [user]: {
        fetchedSitePages: [1],
        videos: [
          { id: 8, user, kind: 'friend', private: false, firstSeenAt: 1 },
          { id: 7, user, kind: 'friend', private: false, firstSeenAt: 1 }
        ]
      }
    }
  });
  const h = harness({
    store,
    appPageSize: 3,
    sitePageSize: 2,
    replies: {
      [userVideosUrl(user, 2)]: { videos: [{ id: 6, ago: '1 日 前' }, { id: 5, ago: '1 日 前' }], lastPage: 2 }
    }
  });

  const progress = [];
  const result = await h.service.getPersonPage({ user, page: 1, onProgress: value => progress.push(value) });

  assert.deepEqual(h.calls, [userVideosUrl(user, 2)]);
  assert.deepEqual(progress, [
    { loaded: 2, needed: 3 },
    { loaded: 4, needed: 3, sitePage: 2 }
  ]);
  assert.deepEqual(result.videos.map(video => video.id), [8, 7, 6]);
  assert.equal(h.store.cache()[user].videos.length, 4);
  assert.equal(h.store.cache()[user].allPagesFetchedAt, 1_000_000);
  assert.deepEqual(h.store.cache()[user].fetchedSitePages, [1, 2]);
});

test('更新で新しい動画が加わったらページ境界から取り直し、古い動画を飛ばさない', async () => {
  const me = 'me';
  const user = 'friend-a';
  const store = memoryStore({
    feedCache: {
      [user]: {
        fetchedSitePages: [1, 2],
        videos: [
          { id: 10, user, kind: 'friend', private: false, firstSeenAt: 1 },
          { id: 8, user, kind: 'friend', private: false, firstSeenAt: 1 }
        ]
      }
    }
  });
  const h = harness({
    store,
    appPageSize: 3,
    sitePageSize: 2,
    replies: {
      [userListUrl(me, 'friends')]: { users: [user], lastPage: 1 },
      [userVideosUrl(user)]: { videos: [{ id: 12 }, { id: 10 }] },
      [userVideosUrl(user, 2)]: { videos: [{ id: 8 }, { id: 7 }], lastPage: 3 },
      [userVideosUrl(user, 3)]: { videos: [{ id: 6 }, { id: 5 }], lastPage: 3 }
    }
  });

  await h.service.refresh({ me, includeSubscriptions: false });
  const result = await h.service.getPersonPage({ user, page: 2 });

  assert.deepEqual(h.calls, [
    userListUrl(me, 'friends'), userVideosUrl(user), userVideosUrl(user, 2), userVideosUrl(user, 3)
  ]);
  assert.deepEqual(h.store.cache()[user].fetchedSitePages, [1, 2, 3]);
  assert.deepEqual(h.store.cache()[user].videos.map(video => video.id), [12, 10, 8, 7, 6, 5]);
  assert.deepEqual(result.videos.map(video => video.id), [7, 6, 5]);
});

test('相対日付を取得時刻から推定し、既に見た動画の初回取得時刻は更新で変えない', async () => {
  assert.equal(estimatePostedAt('2 時 前', 10_000_000), 2_800_000);
  assert.equal(estimatePostedAt('不明', 10_000_000), null);
  const me = 'me';
  const store = memoryStore({
    feedCache: {
      'friend-a': { videos: [{ id: 10, user: 'friend-a', kind: 'friend', firstSeenAt: 100, postedAtEst: 50, siteTags: ['saved'] }] }
    }
  });
  const h = harness({
    store,
    now: 10_000,
    replies: {
      [userListUrl(me, 'friends')]: { users: ['friend-a'], lastPage: 1 },
      [userVideosUrl('friend-a')]: { videos: [{ id: 10, ago: '2 時 前' }] }
    }
  });

  await h.service.refresh({ me, includeSubscriptions: false });

  assert.deepEqual(h.store.cache()['friend-a'].videos[0], {
    id: 10, ago: '2 時 前', user: 'friend-a', kind: 'friend', firstSeenAt: 100, postedAtEst: 50, siteTags: ['saved']
  });
});

// サイトのタグ（DESIGN 4.2）。応答は parser を差し替えて JSON 配列で返す。
function tagHarness({ store, replies = {}, status = 200 } = {}) {
  const calls = [];
  const fetcher = {
    fetch: async (url, options) => {
      calls.push({ url, options });
      const id = Number(/item_id=(\d+)/.exec(options?.body || '')?.[1]);
      if (status !== 200) {
        if (status === 429) {
          const error = new Error('stopped');
          error.name = 'FetchStoppedError';
          error.status = 429;
          throw error;
        }
        return { status, body: '' };
      }
      return { status: 200, body: JSON.stringify(replies[id] || []) };
    },
    fetchUserVideos: async () => { throw new Error('使わない'); }
  };
  const parse = body => JSON.parse(body);
  const service = createFeedService({
    fetcher, store, parseUserList: parse, parseVideoList: parse, parseVideoTags: parse, now: () => 5_000
  });
  return { calls, service };
}

test('タグ取得は POST /ajax/video_tag に act=list&item_id だけを送る', () => {
  const { url, options } = videoTagRequest(123);
  assert.equal(url, 'https://www.tokyomotion.net/ajax/video_tag');
  assert.equal(options.method, 'POST');
  assert.equal(options.body, 'act=list&item_id=123');
  assert.throws(() => videoTagRequest('1&act=vote'));
  assert.throws(() => videoTagRequest(0));
});

test('カーソルでのタグ取得は 1 本だけ取り、保存して取り直さない', async () => {
  const store = memoryStore({
    feedCache: { 'friend-a': { videos: [{ id: 10, user: 'friend-a', kind: 'friend', siteTags: [] }] } }
  });
  const h = tagHarness({ store, replies: { 10: ['タグA', 'タグB'] } });

  const [first, same] = await Promise.all([h.service.fetchSiteTags(10), h.service.fetchSiteTags(10)]);
  const again = await h.service.fetchSiteTags(10);

  assert.deepEqual(first, ['タグA', 'タグB']);
  assert.deepEqual(same, first);
  assert.deepEqual(again, first);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(store.cache()['friend-a'].videos[0].siteTags, ['タグA', 'タグB']);
  assert.equal(store.cache()['friend-a'].videos[0].siteTagsAt, 5_000);
  await assert.rejects(h.service.fetchSiteTags(99));
});

test('更新後の裏のタグ取得は NEW でタグ未取得の動画だけを新しい順に取る', async () => {
  const store = memoryStore({
    state: { lastOpenedAt: 100, watched: [] },
    feedCache: {
      'friend-a': { videos: [
        { id: 30, user: 'friend-a', kind: 'friend', firstSeenAt: 200, siteTags: [] },
        { id: 20, user: 'friend-a', kind: 'friend', firstSeenAt: 50, siteTags: [] }
      ] },
      'friend-b': { videos: [
        { id: 40, user: 'friend-b', kind: 'friend', firstSeenAt: 200, siteTags: ['既存'], siteTagsAt: 1 },
        { id: 35, user: 'friend-b', kind: 'friend', firstSeenAt: 200, siteTags: [] }
      ] }
    }
  });
  const h = tagHarness({ store, replies: { 35: ['タグA'], 30: [] } });
  const seen = [];

  const result = await h.service.fetchNewSiteTags({ onTags: value => seen.push(value) });

  assert.deepEqual(h.calls.map(call => call.options.body), ['act=list&item_id=35', 'act=list&item_id=30']);
  assert.deepEqual(seen, [{ id: 35, tags: ['タグA'] }, { id: 30, tags: [] }]);
  assert.deepEqual(result, { done: 2, total: 2, stopped: false, status: null });
  assert.equal(store.cache()['friend-a'].videos[0].siteTagsAt, 5_000);
  assert.equal(store.cache()['friend-a'].videos[1].siteTagsAt, undefined);
});

test('裏のタグ取得は 429 で止まり、タグを保存しない', async () => {
  const store = memoryStore({
    feedCache: { 'friend-a': { videos: [
      { id: 30, user: 'friend-a', kind: 'friend', firstSeenAt: 200, siteTags: [] },
      { id: 20, user: 'friend-a', kind: 'friend', firstSeenAt: 200, siteTags: [] }
    ] } }
  });
  const h = tagHarness({ store, status: 429 });

  const result = await h.service.fetchNewSiteTags();

  assert.deepEqual(result, { done: 0, total: 2, stopped: true, status: 429 });
  assert.equal(h.calls.length, 1);
  assert.equal(store.cache()['friend-a'].videos[0].siteTagsAt, undefined);
});

test('裏のタグ取得は 1 回につき NEW の新しい順に 100 本まで', async () => {
  const videos = Array.from({ length: 105 }, (_, index) => ({
    id: index + 1, user: 'friend-a', kind: 'friend', firstSeenAt: 200, siteTags: []
  }));
  const store = memoryStore({ state: { lastOpenedAt: 100, watched: [] }, feedCache: { 'friend-a': { videos } } });
  const h = tagHarness({ store });

  const result = await h.service.fetchNewSiteTags();

  assert.equal(NEW_TAG_LIMIT, 100);
  assert.deepEqual(result, { done: 100, total: 100, stopped: false, status: null });
  assert.equal(h.calls[0].options.body, 'act=list&item_id=105');
  assert.equal(h.calls.at(-1).options.body, 'act=list&item_id=6');
  // 残りの古い 5 本はカーソル時の取得に任せる。
  assert.equal(store.cache()['friend-a'].videos.find(video => video.id === 5).siteTagsAt, undefined);
});

test('更新は、途中でカーソル取得したタグを古い cache で消さない', async () => {
  const me = 'me';
  const store = memoryStore({
    feedCache: { 'friend-a': { videos: [{ id: 10, user: 'friend-a', kind: 'friend', firstSeenAt: 1, siteTags: [] }] } }
  });
  const h = harness({
    store,
    replies: {
      [userListUrl(me, 'friends')]: { users: ['friend-a', 'friend-b'], lastPage: 1 },
      [userVideosUrl('friend-a')]: { videos: [{ id: 10 }] },
      [userVideosUrl('friend-b')]: { videos: [{ id: 5 }] }
    }
  });
  const original = h.service.fetcher.fetchUserVideos;
  h.service.fetcher.fetchUserVideos = async user => {
    if (user === 'friend-b') {
      // 別の処理がタグを保存した状況（保存先は別オブジェクトとして置き換える）
      const latest = JSON.parse(JSON.stringify(store.cache()));
      latest['friend-a'].videos[0].siteTags = ['タグA'];
      latest['friend-a'].videos[0].siteTagsAt = 7;
      store.saveFeedCache(latest);
    }
    return original(user);
  };

  await h.service.refresh({ me, includeSubscriptions: false });

  assert.deepEqual(store.cache()['friend-a'].videos[0].siteTags, ['タグA']);
  assert.equal(store.cache()['friend-a'].videos[0].siteTagsAt, 7);
});

test('一覧のアイコンを保存し、フィードと人の一覧に付ける', async () => {
  const me = 'me';
  const h = harness({
    now: 10_000,
    replies: {
      [userListUrl(me, 'friends')]: { users: ['friend-a', 'friend-b'], avatars: { 'friend-a': 'https://cdn.example.test/a.jpg' }, lastPage: 1 },
      [userVideosUrl('friend-a')]: { videos: [{ id: 20 }] },
      [userVideosUrl('friend-b')]: { videos: [{ id: 10 }] }
    }
  });

  await h.service.refresh({ me, includeSubscriptions: false });

  assert.equal(h.store.cache()['friend-a'].avatar, 'https://cdn.example.test/a.jpg');
  assert.equal(h.store.cache()['friend-b'].avatar, null);
  assert.deepEqual(h.service.getFeed().videos.map(video => [video.id, video.avatar ?? null]), [
    [20, 'https://cdn.example.test/a.jpg'], [10, null]
  ]);
  assert.deepEqual(h.service.getPeople().map(person => [person.user, person.avatar]), [
    ['friend-a', 'https://cdn.example.test/a.jpg'], ['friend-b', null]
  ]);
});

test('前回より新しい ID の動画は、推定投稿日に初めて取得した時刻を使う', async () => {
  const me = 'me';
  const store = memoryStore({
    feedCache: { 'friend-a': { fetchedAt: 1, videos: [{ id: 10, user: 'friend-a', kind: 'friend', firstSeenAt: 1, postedAtEst: 1 }] } }
  });
  const now = 100 * 24 * 60 * 60 * 1000;
  const h = harness({
    store,
    now,
    replies: {
      [userListUrl(me, 'friends')]: { users: ['friend-a', 'friend-b'], lastPage: 1 },
      [userVideosUrl('friend-a')]: { videos: [{ id: 12, ago: '3 日 前' }, { id: 10, ago: '9 日 前' }, { id: 8, ago: '9 日 前' }] },
      [userVideosUrl('friend-b')]: { videos: [{ id: 5, ago: '2 日 前' }] }
    }
  });

  await h.service.refresh({ me, includeSubscriptions: false });

  const posted = Object.fromEntries(Object.values(h.store.cache())
    .flatMap(entry => entry.videos).map(video => [video.id, video.postedAtEst]));
  assert.equal(posted[12], now);
  assert.equal(posted[10], 1);
  assert.equal(posted[8], now - 9 * 24 * 60 * 60 * 1000);
  // 初めて取得した人の動画は、相対表示から推定する
  assert.equal(posted[5], now - 2 * 24 * 60 * 60 * 1000);
});
