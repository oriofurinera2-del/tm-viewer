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

// サイトのタグ取得（DESIGN 4.2・8 章）。送るのは act=list だけ。
// 同じ応答にある投票（tagvp）などの書き込み操作は送らない。
function videoTagRequest(id) {
  if (!validId(id)) throw new TypeError('動画IDが必要です');
  return {
    url: `${SITE_ORIGIN}/ajax/video_tag`,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: `act=list&item_id=${id}`
    }
  };
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

// newerThanId: 前回までに取得済みの最大の動画ID。これより新しい動画はアプリが新着として
// 見つけたものなので、推定投稿日に「初めて取得した時刻」を使う（DESIGN 4.3）。
function mergeVideos(previous, incoming, user, kind, fetchedAt, { newerThanId = null } = {}) {
  const oldById = new Map(asArray(previous).filter(video => validId(video?.id)).map(video => [video.id, video]));
  const merged = [];
  for (const video of asArray(incoming)) {
    if (!validId(video?.id)) continue;
    const old = oldById.get(video.id);
    const firstSeenAt = Number.isFinite(old?.firstSeenAt) ? old.firstSeenAt : fetchedAt;
    const foundAsNew = !old && Number.isFinite(newerThanId) && video.id > newerThanId;
    merged.push({
      ...video,
      user,
      kind,
      firstSeenAt,
      postedAtEst: Number.isFinite(old?.postedAtEst)
        ? old.postedAtEst
        : foundAsNew ? firstSeenAt : estimatePostedAt(video.ago, fetchedAt),
      siteTags: asArray(old?.siteTags),
      ...(Number.isFinite(old?.siteTagsAt) ? { siteTagsAt: old.siteTagsAt } : {})
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

function hasSiteTags(video) {
  return Number.isFinite(video?.siteTagsAt);
}

// 別の処理（カーソルでのタグ取得）が先に保存したタグを、手元の古い cache で消さない。
function keepSavedTags(cache, latest) {
  const saved = new Map();
  for (const entry of Object.values(latest || {})) {
    for (const video of asArray(entry?.videos)) {
      if (validId(video?.id) && hasSiteTags(video)) saved.set(video.id, video);
    }
  }
  if (saved.size === 0) return cache;
  for (const entry of Object.values(cache)) {
    for (const video of asArray(entry?.videos)) {
      const found = saved.get(video?.id);
      if (found && !hasSiteTags(video)) {
        video.siteTags = asArray(found.siteTags);
        video.siteTagsAt = found.siteTagsAt;
      }
    }
  }
  return cache;
}

function isNew(video, state) {
  return !state.watched.includes(video.id)
    && (!Number.isFinite(state.lastOpenedAt) || video.firstSeenAt > state.lastOpenedAt);
}

class FeedService {
  constructor({ fetcher, store, parseUserList, parseVideoList, parseVideoTags = null, now = Date.now, appPageSize = APP_PAGE_SIZE, sitePageSize = SITE_PAGE_SIZE }) {
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
    this.parseVideoTags = typeof parseVideoTags === 'function' ? parseVideoTags : null;
    this.now = now;
    this.tagRequests = new Map();
    this.tagRun = 0;
    this.appPageSize = appPageSize;
    this.sitePageSize = sitePageSize;
  }

  state() {
    return normalizeState(this.store.loadState());
  }

  saveCache(cache) {
    this.store.saveFeedCache(keepSavedTags(cache, this.store.loadFeedCache()));
  }

  saveState(state) {
    this.store.saveState(normalizeState(state));
  }

  // avatars を渡すと、一覧で見つけたアイコンの URL を { 名前: URL } で足す。
  async fetchList(me, kind, avatars = {}) {
    const addAvatars = parsed => {
      const found = parsed?.avatars;
      if (!found || typeof found !== 'object') return;
      for (const [user, url] of Object.entries(found)) {
        if (typeof url === 'string' && url && !avatars[user]) avatars[user] = url;
      }
    };
    const first = this.parseUserList((await this.fetcher.fetch(userListUrl(me, kind))).body);
    addAvatars(first);
    const users = [...asArray(first?.users)];
    const lastPage = kind === 'friends' ? Math.max(1, Number(first?.lastPage) || 1) : 1;
    for (let page = 2; page <= lastPage; page += 1) {
      const parsed = this.parseUserList((await this.fetcher.fetch(userListUrl(me, kind, page))).body);
      addAvatars(parsed);
      users.push(...asArray(parsed?.users));
    }
    return uniqueUsers(users);
  }

  async refresh({ me, includeSubscriptions = true, onProgress } = {}) {
    if (typeof me !== 'string' || !me) throw new TypeError('ログイン中のユーザー名が必要です');
    // 前回の更新の NEW タグ取得が残っていれば、次の動画から止める。
    this.tagRun += 1;
    const cache = this.store.loadFeedCache() || {};
    const results = [];
    try {
      const avatars = {};
      const friends = await this.fetchList(me, 'friends', avatars);
      const subscriptions = includeSubscriptions ? await this.fetchList(me, 'subscriptions', avatars) : [];
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
        const newerThanId = Number.isFinite(cache[user]?.fetchedAt)
          ? previous.reduce((max, video) => (validId(video?.id) && video.id > max ? video.id : max), 0)
          : null;
        const videos = mergeCachedPages(
          previous,
          mergeVideos(previous, fetched?.videos, user, kind, fetchedAt, { newerThanId })
        );
        cache[user] = {
          ...cache[user],
          fetchedAt,
          kind,
          avatar: avatars[user] || (typeof cache[user]?.avatar === 'string' ? cache[user].avatar : null),
          // 1ページ目に新しい ID が加わると、以後のページ境界がずれる。
          // 古い動画を飛ばさないよう、そのときは2ページ目以降を取り直す。
          fetchedSitePages: hasNewFirstPageVideo
            ? [1]
            : fetchedPages([1, ...fetchedPages(cache[user]?.fetchedSitePages)]),
          videos
        };
        this.saveCache(cache);
        results.push({ user, kind, videos });
        if (typeof onProgress === 'function') onProgress({ done: index + 1, total: users.length, user });
      }
      const state = this.state();
      this.saveState({ ...state, me });
      return { friends, subscriptions, results, stopped: false, status: null };
    } catch (error) {
      if (error?.name !== 'FetchStoppedError') throw error;
      this.saveCache(cache);
      return { results, stopped: true, status: error.status ?? null };
    }
  }

  videos({ includeSubscriptions = true } = {}) {
    const cache = this.store.loadFeedCache() || {};
    const videos = [];
    for (const entry of Object.values(cache)) {
      const avatar = typeof entry?.avatar === 'string' && entry.avatar ? entry.avatar : null;
      for (const video of asArray(entry?.videos)) {
        if (!includeSubscriptions && video.kind === 'subscription') continue;
        if (validId(video?.id)) videos.push(avatar ? { ...video, avatar } : video);
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
      const avatar = typeof entry?.avatar === 'string' && entry.avatar ? entry.avatar : null;
      byUser.set(user, { user, kind: kind || 'friend', unread: 0, muted: state.muted.includes(user), avatar });
    }
    for (const video of all) {
      if (!byUser.has(video.user)) byUser.set(video.user, { user: video.user, kind: video.kind, unread: 0, muted: state.muted.includes(video.user), avatar: video.avatar || null });
      if (isNew(video, state)) byUser.get(video.user).unread += 1;
    }
    return [...byUser.values()].sort((a, b) => b.unread - a.unread || a.user.localeCompare(b.user, 'ja'));
  }

  findVideo(id) {
    const cache = this.store.loadFeedCache() || {};
    for (const entry of Object.values(cache)) {
      const video = asArray(entry?.videos).find(item => item?.id === id);
      if (video) return video;
    }
    return null;
  }

  saveSiteTags(id, tags) {
    const cache = this.store.loadFeedCache() || {};
    const siteTagsAt = this.now();
    for (const entry of Object.values(cache)) {
      for (const video of asArray(entry?.videos)) {
        if (video?.id === id) {
          video.siteTags = tags;
          video.siteTagsAt = siteTagsAt;
        }
      }
    }
    this.store.saveFeedCache(cache);
  }

  // 1 本分のサイトのタグ。保存済みなら取り直さない。取得は fetcher のキュー（間隔を守る）を通す。
  fetchSiteTags(id) {
    if (!validId(id)) return Promise.reject(new TypeError('動画IDが必要です'));
    if (!this.parseVideoTags) return Promise.reject(new Error('parseVideoTags が必要です'));
    const saved = this.findVideo(id);
    if (!saved) return Promise.reject(new Error('保存済みの動画ではありません'));
    if (hasSiteTags(saved)) return Promise.resolve(asArray(saved.siteTags));
    if (this.tagRequests.has(id)) return this.tagRequests.get(id);
    const { url, options } = videoTagRequest(id);
    const pending = this.fetcher.fetch(url, options)
      .then(response => {
        if (response.status !== 200) throw new Error(`タグを取得できませんでした (${response.status})`);
        const tags = this.parseVideoTags(response.body);
        this.saveSiteTags(id, tags);
        return tags;
      })
      .finally(() => this.tagRequests.delete(id));
    this.tagRequests.set(id, pending);
    return pending;
  }

  // 更新後に、NEW の動画のタグを新しい順に 1 本ずつ裏で取る。次の更新が始まったら止める。
  async fetchNewSiteTags({ onTags } = {}) {
    const run = ++this.tagRun;
    const state = this.state();
    const targets = this.videos()
      .filter(video => isNew(video, state) && !hasSiteTags(video))
      .map(video => video.id);
    let done = 0;
    for (const id of targets) {
      if (run !== this.tagRun) return { done, total: targets.length, stopped: true, status: null };
      try {
        const tags = await this.fetchSiteTags(id);
        done += 1;
        if (typeof onTags === 'function') onTags({ id, tags });
      } catch (error) {
        if (error?.name === 'FetchStoppedError') {
          return { done, total: targets.length, stopped: true, status: error.status ?? null };
        }
        // 1 本の失敗（削除された動画など）では止めず、次へ進む。
      }
    }
    return { done, total: targets.length, stopped: false, status: null };
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

  async getPersonPage({ user, page = 1, viewableOnly = true, onProgress } = {}) {
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
      if (typeof onProgress === 'function') {
        onProgress({ loaded: visibleCount(), needed: neededCount });
      }
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
      if (typeof onProgress === 'function') {
        onProgress({ loaded: visibleCount(), needed: neededCount, sitePage });
      }
    }
    cache[user] = {
      ...entry,
      allPagesFetchedAt: this.now(),
      fetchedSitePages: [...loadedPages].sort((a, b) => a - b),
      ...(lastSitePage !== null ? { lastSitePage } : {}),
      videos
    };
    this.saveCache(cache);
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
  userVideosUrl,
  videoTagRequest
};
