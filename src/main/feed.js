'use strict';

// 新着フィードの取得・保存・表示用データをまとめる。
// サイト HTML の読み取りは行わず、parser.js から注入される関数だけを使う。

const SITE_ORIGIN = 'https://www.tokyomotion.net';
const APP_PAGE_SIZE = 100;
const SITE_PAGE_SIZE = 18;

function userListUrl(me, kind, page = 1) {
  const name = encodeURIComponent(me);
  const path = kind === 'friends' ? 'friends' : 'subscriptions';
  const query = kind === 'friends' || page > 1 ? `?page=${page}` : '';
  return `${SITE_ORIGIN}/user/${name}/${path}${query}`;
}

function userVideosUrl(user, page = 1) {
  const query = page > 1 ? `?page=${page}` : '';
  return `${SITE_ORIGIN}/user/${encodeURIComponent(user)}/videos${query}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueUsers(users) {
  return [...new Set(asArray(users).filter(user => typeof user === 'string' && user))];
}

function validId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function estimatePostedAt(ago, fetchedAt) {
  if (!Number.isFinite(fetchedAt) || typeof ago !== 'string') return null;
  const match = ago.replace(/\s+/g, '').match(/(\d+)(分|時|日|週|ヶ月|か月|年)前/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const milliseconds = {
    '分': 60 * 1000,
    '時': 60 * 60 * 1000,
    '日': 24 * 60 * 60 * 1000,
    '週': 7 * 24 * 60 * 60 * 1000,
    'ヶ月': 30 * 24 * 60 * 60 * 1000,
    'か月': 30 * 24 * 60 * 60 * 1000,
    '年': 365 * 24 * 60 * 60 * 1000
  }[unit];
  return milliseconds ? fetchedAt - amount * milliseconds : null;
}

function mergeVideos(previous, incoming, user, kind, fetchedAt) {
  const oldById = new Map(asArray(previous).filter(video => validId(video?.id)).map(video => [video.id, video]));
  const merged = [];
  for (const video of asArray(incoming)) {
    if (!validId(video?.id)) continue;
    const old = oldById.get(video.id);
    const firstSeenAt = Number.isFinite(old?.firstSeenAt) ? old.firstSeenAt : fetchedAt;
    merged.push({
      ...video,
      user,
      kind,
      firstSeenAt,
      postedAtEst: Number.isFinite(old?.postedAtEst)
        ? old.postedAtEst
        : estimatePostedAt(video.ago, fetchedAt),
      siteTags: asArray(old?.siteTags)
    });
  }
  return merged;
}

function mergeCachedPages(existing, pageVideos) {
  const byId = new Map(asArray(existing).filter(video => validId(video?.id)).map(video => [video.id, video]));
  for (const video of pageVideos) byId.set(video.id, video);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

function normalizeState(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...state,
    watched: [...new Set(asArray(state.watched).filter(validId))],
    muted: uniqueUsers(state.muted),
    lastOpenedAt: Number.isFinite(state.lastOpenedAt) ? state.lastOpenedAt : null
  };
}

function fetchedPages(value) {
  return [...new Set(asArray(value)
    .filter(page => Number.isSafeInteger(page) && page >= 1))].sort((a, b) => a - b);
}

function isViewable(video) {
  return !video.private || video.kind === 'friend';
}

function isNew(video, state) {
  return !state.watched.includes(video.id)
    && (!Number.isFinite(state.lastOpenedAt) || video.firstSeenAt > state.lastOpenedAt);
}

class FeedService {
  constructor({ fetcher, store, parseUserList, parseVideoList, now = Date.now, appPageSize = APP_PAGE_SIZE, sitePageSize = SITE_PAGE_SIZE }) {
    if (!fetcher || typeof fetcher.fetch !== 'function' || typeof fetcher.fetchUserVideos !== 'function') {
      throw new TypeError('fetcher.fetch と fetcher.fetchUserVideos が必要です');
    }
    if (!store || typeof store.loadFeedCache !== 'function' || typeof store.saveFeedCache !== 'function'
      || typeof store.loadState !== 'function' || typeof store.saveState !== 'function') {
      throw new TypeError('store は feed-cache と state の読み書きを提供する必要があります');
    }
    if (typeof parseUserList !== 'function' || typeof parseVideoList !== 'function') {
      throw new TypeError('一覧を読む parser 関数が必要です');
    }
    this.fetcher = fetcher;
    this.store = store;
    this.parseUserList = parseUserList;
    this.parseVideoList = parseVideoList;
    this.now = now;
    this.appPageSize = appPageSize;
    this.sitePageSize = sitePageSize;
  }

  state() {
    return normalizeState(this.store.loadState());
  }

  saveState(state) {
    this.store.saveState(normalizeState(state));
  }

  async fetchList(me, kind) {
    const first = this.parseUserList((await this.fetcher.fetch(userListUrl(me, kind))).body);
    const users = [...asArray(first?.users)];
    const lastPage = kind === 'friends' ? Math.max(1, Number(first?.lastPage) || 1) : 1;
    for (let page = 2; page <= lastPage; page += 1) {
      const parsed = this.parseUserList((await this.fetcher.fetch(userListUrl(me, kind, page))).body);
      users.push(...asArray(parsed?.users));
    }
    return uniqueUsers(users);
  }

  async refresh({ me, includeSubscriptions = true, onProgress } = {}) {
    if (typeof me !== 'string' || !me) throw new TypeError('ログイン中のユーザー名が必要です');
    const cache = this.store.loadFeedCache() || {};
    const results = [];
    try {
      const friends = await this.fetchList(me, 'friends');
      const subscriptions = includeSubscriptions ? await this.fetchList(me, 'subscriptions') : [];
      const friendSet = new Set(friends);
      const users = uniqueUsers([...friends, ...subscriptions]).map(user => ({
        user,
        kind: friendSet.has(user) ? 'friend' : 'subscription'
      }));
      if (typeof onProgress === 'function') onProgress({ done: 0, total: users.length });
      for (let index = 0; index < users.length; index += 1) {
        const { user, kind } = users[index];
        const fetched = await this.fetcher.fetchUserVideos(user);
        const fetchedAt = Number.isFinite(fetched?.fetchedAt) ? fetched.fetchedAt : this.now();
        const previous = asArray(cache[user]?.videos);
        const oldFirstPageIds = new Set(previous
          .slice()
          .sort((a, b) => b.id - a.id)
          .slice(0, this.sitePageSize)
          .map(video => video.id));
        // キャッシュには個人の古いページも含まれる。キャッシュ全体を最新の
        // 1 ページ目として比べると、古い ID を新着と誤認してページ境界を消してしまう。
        const hasNewFirstPageVideo = !fetched?.fromCache
          && asArray(fetched?.videos).some(video => !oldFirstPageIds.has(video?.id));
        const videos = mergeCachedPages(
          previous,
          mergeVideos(previous, fetched?.videos, user, kind, fetchedAt)
        );
        cache[user] = {
          ...cache[user],
          fetchedAt,
          kind,
          // 1ページ目に新しい ID が加わると、以後のページ境界がずれる。
          // 古い動画を飛ばさないよう、そのときは2ページ目以降を取り直す。
          fetchedSitePages: hasNewFirstPageVideo
            ? [1]
            : fetchedPages([1, ...fetchedPages(cache[user]?.fetchedSitePages)]),
          videos
        };
        this.store.saveFeedCache(cache);
        results.push({ user, kind, videos });
        if (typeof onProgress === 'function') onProgress({ done: index + 1, total: users.length, user });
      }
      const state = this.state();
      this.saveState({ ...state, me });
      return { friends, subscriptions, results, stopped: false, status: null };
    } catch (error) {
      if (error?.name !== 'FetchStoppedError') throw error;
      this.store.saveFeedCache(cache);
      return { results, stopped: true, status: error.status ?? null };
    }
  }

  videos({ includeSubscriptions = true } = {}) {
    const cache = this.store.loadFeedCache() || {};
    const videos = [];
    for (const entry of Object.values(cache)) {
      for (const video of asArray(entry?.videos)) {
        if (!includeSubscriptions && video.kind === 'subscription') continue;
        if (validId(video?.id)) videos.push(video);
      }
    }
    return [...new Map(videos.map(video => [video.id, video])).values()].sort((a, b) => b.id - a.id);
  }

  getFeed({ includeSubscriptions = true, viewableOnly = true, selectedUser = null, page = 1 } = {}) {
    const state = this.state();
    let videos = this.videos({ includeSubscriptions });
    if (selectedUser) videos = videos.filter(video => video.user === selectedUser);
    else videos = videos.filter(video => !state.muted.includes(video.user));
    if (viewableOnly) videos = videos.filter(isViewable);
    const pages = Math.max(1, Math.ceil(videos.length / this.appPageSize));
    const currentPage = Math.min(Math.max(1, Number(page) || 1), pages);
    const start = (currentPage - 1) * this.appPageSize;
    return {
      videos: videos.slice(start, start + this.appPageSize).map(video => ({ ...video, isNew: isNew(video, state), watched: state.watched.includes(video.id) })),
      total: videos.length,
      page: currentPage,
      pages
    };
  }

  getPeople({ includeSubscriptions = true, viewableOnly = true } = {}) {
    const state = this.state();
    const all = this.videos({ includeSubscriptions }).filter(video => !viewableOnly || isViewable(video));
    const byUser = new Map();
    const cache = this.store.loadFeedCache() || {};
    for (const [user, entry] of Object.entries(cache)) {
      const kind = entry?.kind || asArray(entry?.videos)[0]?.kind;
      if (typeof user !== 'string' || !user || (!includeSubscriptions && kind === 'subscription')) continue;
      byUser.set(user, { user, kind: kind || 'friend', unread: 0, muted: state.muted.includes(user) });
    }
    for (const video of all) {
      if (!byUser.has(video.user)) byUser.set(video.user, { user: video.user, kind: video.kind, unread: 0, muted: state.muted.includes(video.user) });
      if (isNew(video, state)) byUser.get(video.user).unread += 1;
    }
    return [...byUser.values()].sort((a, b) => b.unread - a.unread || a.user.localeCompare(b.user, 'ja'));
  }

  markFeedOpened() {
    const state = this.state();
    this.saveState({ ...state, lastOpenedAt: this.now() });
  }

  openFeed(options) {
    const result = this.getFeed(options);
    this.markFeedOpened();
    return result;
  }

  markWatched(id, watched = true) {
    if (!validId(id)) return;
    const state = this.state();
    const ids = new Set(state.watched);
    if (watched) ids.add(id); else ids.delete(id);
    this.saveState({ ...state, watched: [...ids] });
  }

  setMuted(user, muted) {
    if (typeof user !== 'string' || !user) return;
    const state = this.state();
    const users = new Set(state.muted);
    if (muted) users.add(user); else users.delete(user);
    this.saveState({ ...state, muted: [...users] });
  }

  async getPersonPage({ user, page = 1, viewableOnly = true } = {}) {
    if (typeof user !== 'string' || !user) throw new TypeError('ユーザー名が必要です');
    const cache = this.store.loadFeedCache() || {};
    const entry = cache[user];
    if (!entry) throw new Error('先にフィードを更新してください');
    const currentPage = Math.max(1, Number(page) || 1);
    const neededCount = currentPage * this.appPageSize;
    let videos = asArray(entry.videos);
    const loadedPages = new Set(fetchedPages(entry.fetchedSitePages));
    if (loadedPages.size === 0) loadedPages.add(1);
    let lastSitePage = Number.isSafeInteger(entry.lastSitePage) ? entry.lastSitePage : null;
    const visibleCount = () => videos.filter(video => !viewableOnly || isViewable(video)).length;
    while (visibleCount() < neededCount) {
      let sitePage = 2;
      while (loadedPages.has(sitePage)) sitePage += 1;
      if (lastSitePage !== null && sitePage > lastSitePage) break;
      const parsed = this.parseVideoList((await this.fetcher.fetch(userVideosUrl(user, sitePage))).body);
      const received = asArray(parsed?.videos);
      loadedPages.add(sitePage);
      const parsedLastPage = Number(parsed?.lastPage);
      if (Number.isSafeInteger(parsedLastPage) && parsedLastPage >= sitePage) lastSitePage = parsedLastPage;
      if (received.length === 0) break;
      const kind = videos[0]?.kind || 'friend';
      const enriched = mergeVideos(videos, received, user, kind, this.now());
      videos = mergeCachedPages(videos, enriched);
    }
    cache[user] = {
      ...entry,
      allPagesFetchedAt: this.now(),
      fetchedSitePages: [...loadedPages].sort((a, b) => a - b),
      ...(lastSitePage !== null ? { lastSitePage } : {}),
      videos
    };
    this.store.saveFeedCache(cache);
    return this.getFeed({ includeSubscriptions: true, viewableOnly, selectedUser: user, page: currentPage });
  }
}

function createFeedService(options) {
  return new FeedService(options);
}

module.exports = {
  APP_PAGE_SIZE,
  SITE_PAGE_SIZE,
  FeedService,
  createFeedService,
  estimatePostedAt,
  isViewable,
  mergeVideos,
  userListUrl,
  userVideosUrl
};
