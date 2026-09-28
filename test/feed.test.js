'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFeedService,
  estimatePostedAt,
  userListUrl,
  userVideosUrl
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
