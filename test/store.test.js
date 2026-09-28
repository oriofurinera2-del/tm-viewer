'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/main/store');

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-viewer-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return createStore(directory);
}

test('設計書で決めた4種類の JSON を userData に保存して読み戻す', t => {
  const store = temporaryStore(t);
  const feedCache = { user_a: { fetchedAt: 10, videos: [{ id: 12 }] } };
  const state = { me: 'me', watched: [12], muted: [] };
  const notes = { 12: { name: 'memo', tags: ['tag'], score: 4 } };
  const settings = { intervalMs: 2000, cacheMinutes: 30 };

  store.saveFeedCache(feedCache);
  store.saveState(state);
  store.saveNotes(notes);
  store.saveSettings(settings);

  assert.deepEqual(store.loadFeedCache(), feedCache);
  assert.deepEqual(store.loadState(), state);
  assert.deepEqual(store.loadNotes(), notes);
  assert.deepEqual(store.loadSettings(), settings);
  assert.equal(path.basename(store.paths.feedCache), 'feed-cache.json');
  assert.equal(path.basename(store.paths.state), 'state.json');
  assert.equal(path.basename(store.paths.notes), 'notes.json');
  assert.equal(path.basename(store.paths.settings), 'settings.json');
});

test('未作成または壊れた JSON は呼び出し元の既定値で読む', t => {
  const store = temporaryStore(t);

  assert.deepEqual(store.loadFeedCache(), {});
  fs.writeFileSync(store.paths.state, '{not json', 'utf8');
  assert.deepEqual(store.loadState(), {});
});
