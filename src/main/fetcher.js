'use strict';

const SITE_ORIGIN = 'https://www.tokyomotion.net';
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_CACHE_MINUTES = 30;

class FetchStoppedError extends Error {
  constructor(status) {
    super(`取得を停止しました (${status})`);
    this.name = 'FetchStoppedError';
    this.status = status;
  }
}

function isStopStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function buildUserVideosUrl(user) {
  return `${SITE_ORIGIN}/user/${encodeURIComponent(user)}/videos`;
}

async function responseBody(response) {
  if (response && typeof response.body === 'string') return response.body;
  if (response && typeof response.text === 'function') return response.text();
  throw new TypeError('request は status と本文を返す必要があります');
}

function isFresh(entry, now, cacheMs) {
  return entry
    && typeof entry === 'object'
    && Number.isFinite(entry.fetchedAt)
    && now - entry.fetchedAt >= 0
    && now - entry.fetchedAt < cacheMs;
}

class Fetcher {
  constructor({
    request,
    parseVideoList,
    store,
    intervalMs = DEFAULT_INTERVAL_MS,
    cacheMinutes = DEFAULT_CACHE_MINUTES,
    now = Date.now,
    sleep = delay => new Promise(resolve => setTimeout(resolve, delay))
  }) {
    if (typeof request !== 'function' || typeof parseVideoList !== 'function') {
      throw new TypeError('request と parseVideoList は関数で指定します');
    }
    if (!store || typeof store.loadFeedCache !== 'function' || typeof store.saveFeedCache !== 'function') {
      throw new TypeError('store は feed-cache の読み書きを提供する必要があります');
    }
    this.request = request;
    this.parseVideoList = parseVideoList;
    this.store = store;
    this.intervalMs = intervalMs;
    this.cacheMs = cacheMinutes * 60 * 1000;
    this.now = now;
    this.sleep = sleep;
    this.lastRequestAt = null;
    this.queue = Promise.resolve();
  }

  fetch(url, options) {
    return this.enqueue(() => this.fetchNow(url, options));
  }

  fetchUserVideos(user) {
    return this.enqueue(() => this.fetchUserVideosNow(user));
  }

  async fetchUsers(users, options) {
    const results = [];
    for (const user of users) {
      try {
        results.push(await this.fetchUserVideos(user, options));
      } catch (error) {
        if (error instanceof FetchStoppedError) {
          return { results, stopped: true, status: error.status };
        }
        throw error;
      }
    }
    return { results, stopped: false, status: null };
  }

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async fetchUserVideosNow(user) {
    const loadedCache = this.store.loadFeedCache();
    const cache = loadedCache && typeof loadedCache === 'object' && !Array.isArray(loadedCache)
      ? loadedCache
      : {};
    const cached = cache[user];
    const fetchedAt = this.now();
    if (isFresh(cached, fetchedAt, this.cacheMs)) {
      return { user, videos: cached.videos || [], fetchedAt: cached.fetchedAt, fromCache: true };
    }

    const response = await this.fetchNow(buildUserVideosUrl(user));
    const parsed = this.parseVideoList(response.body);
    const videos = Array.isArray(parsed?.videos) ? parsed.videos : [];
    const savedAt = this.now();
    cache[user] = { fetchedAt: savedAt, videos };
    this.store.saveFeedCache(cache);
    return { user, videos, fetchedAt: savedAt, fromCache: false };
  }

  async fetchNow(url, options) {
    await this.waitForSlot();
    const response = await this.request(url, options);
    if (!response || !Number.isInteger(response.status)) {
      throw new TypeError('request は整数の status を返す必要があります');
    }
    if (isStopStatus(response.status)) throw new FetchStoppedError(response.status);
    return { status: response.status, body: await responseBody(response) };
  }

  async waitForSlot() {
    if (this.lastRequestAt !== null) {
      const remaining = this.intervalMs - (this.now() - this.lastRequestAt);
      if (remaining > 0) await this.sleep(remaining);
    }
    this.lastRequestAt = this.now();
  }
}

function createFetcher(options) {
  return new Fetcher(options);
}

module.exports = {
  DEFAULT_CACHE_MINUTES,
  DEFAULT_INTERVAL_MS,
  Fetcher,
  FetchStoppedError,
  buildUserVideosUrl,
  createFetcher,
  isFresh,
  isStopStatus
};
