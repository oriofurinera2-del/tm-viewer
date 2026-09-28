'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILES = {
  feedCache: 'feed-cache.json',
  state: 'state.json',
  notes: 'notes.json',
  settings: 'settings.json'
};

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createStore(userDataPath) {
  const filePath = name => path.join(userDataPath, FILES[name]);
  const read = (name, fallback) => readJson(filePath(name), fallback);
  const write = (name, value) => writeJson(filePath(name), value);

  return {
    get paths() {
      return Object.fromEntries(Object.entries(FILES).map(([name, file]) => [
        name,
        path.join(userDataPath, file)
      ]));
    },
    loadFeedCache: () => read('feedCache', {}),
    saveFeedCache: value => write('feedCache', value),
    loadState: () => read('state', {}),
    saveState: value => write('state', value),
    loadNotes: () => read('notes', {}),
    saveNotes: value => write('notes', value),
    loadSettings: () => read('settings', {}),
    saveSettings: value => write('settings', value)
  };
}

module.exports = { FILES, createStore, readJson, writeJson };
