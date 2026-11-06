'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultTagSearchUrl, normalizeFavorites, siteTagSearch } = require('../src/main/favorites');

test('サイト内のタグ検索URLだけを、検索条件を保って受理する', () => {
  assert.deepEqual(siteTagSearch('https://tokyomotion.net/search?search_query=%E3%83%86%E3%82%B9%E3%83%88&type=private&t=w'), {
    name: 'テスト', url: 'https://tokyomotion.net/search?search_query=%E3%83%86%E3%82%B9%E3%83%88&type=private&t=w'
  });
  assert.equal(siteTagSearch('https://www.tokyomotion.net/search?search_query=x&search_type=videos').name, 'x');
  assert.equal(siteTagSearch('https://evil.example/search?search_query=x'), null);
  assert.equal(siteTagSearch('https://user:pass@www.tokyomotion.net/search?search_query=x'), null);
  assert.equal(siteTagSearch('https://www.tokyomotion.net/video/1'), null);
});

test('カード由来のタグは安全なサイト検索URLにし、重複を除く', () => {
  assert.deepEqual(defaultTagSearchUrl(' タグ A '), {
    name: 'タグ A', url: 'https://www.tokyomotion.net/search?search_query=%E3%82%BF%E3%82%B0+A&search_type=videos'
  });
  assert.equal(defaultTagSearchUrl(''), null);
  const list = normalizeFavorites([
    { url: 'https://www.tokyomotion.net/search?search_query=B&search_type=videos' },
    { url: 'https://www.tokyomotion.net/search?search_query=B&type=private' },
    { url: 'https://evil.example/search?search_query=A' }
  ]);
  assert.deepEqual(list, [{ name: 'B', url: 'https://www.tokyomotion.net/search?search_query=B&search_type=videos' }]);
});
