'use strict';

// お気に入りタグはサイトへ書き込まず、検索リンクだけを端末内に保存する。
const SITE_ORIGIN = 'https://www.tokyomotion.net';

function siteTagSearch(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['tokyomotion.net', 'www.tokyomotion.net'].includes(parsed.hostname)
      || parsed.port || parsed.username || parsed.password || parsed.pathname !== '/search') return null;
    const name = parsed.searchParams.get('search_query')?.trim();
    if (!name) return null;
    return { name, url: parsed.toString() };
  } catch {
    return null;
  }
}

function defaultTagSearchUrl(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) return null;
  const url = new URL('/search', SITE_ORIGIN);
  url.searchParams.set('search_query', text);
  url.searchParams.set('search_type', 'videos');
  return siteTagSearch(url.toString());
}

function normalizeFavorites(value) {
  const byName = new Map();
  for (const raw of Array.isArray(value) ? value : []) {
    const found = siteTagSearch(raw?.url);
    if (!found || byName.has(found.name)) continue;
    byName.set(found.name, found);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

module.exports = { defaultTagSearchUrl, normalizeFavorites, siteTagSearch };
