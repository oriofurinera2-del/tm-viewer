'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePatch,
  normalizeNoteRecord,
  isEmptyNote,
  attachNotes,
  allCustomTags,
  organizedList,
  mergeForImport
} = require('../src/main/notes');

test('normalizePatch: 名前は前後の空白を除き、タグは重複と空文字を除き、得点は1〜5だけ受け付ける', () => {
  assert.deepEqual(normalizePatch({ name: '  お気に入り  ', tags: [' 旅行 ', '旅行', '', '料理'], score: 4 }),
    { name: 'お気に入り', tags: ['旅行', '料理'], score: 4 });
  assert.deepEqual(normalizePatch({ score: 0 }).score, 0);
  assert.deepEqual(normalizePatch({ score: 6 }).score, 0);
  assert.deepEqual(normalizePatch({ score: -1 }).score, 0);
  assert.deepEqual(normalizePatch({}), { name: '', tags: [], score: 0 });
});

test('isEmptyNote: 名前・タグ・得点のどれも無ければ空とみなす', () => {
  assert.equal(isEmptyNote({ name: '', tags: [], score: 0 }), true);
  assert.equal(isEmptyNote({ name: '名前', tags: [], score: 0 }), false);
  assert.equal(isEmptyNote({ name: '', tags: ['x'], score: 0 }), false);
  assert.equal(isEmptyNote({ name: '', tags: [], score: 3 }), false);
});

test('normalizeNoteRecord: 未知のキー（パスワードなど）は落ち、既知の項目だけ残る', () => {
  const record = normalizeNoteRecord({ name: 'n', tags: ['t'], score: 3, user: 'u', title: 'title', thumb: 'https://x/1.jpg', updatedAt: 100, password: 'secret', id: 'x' });
  assert.deepEqual(record, { name: 'n', tags: ['t'], score: 3, user: 'u', title: 'title', thumb: 'https://x/1.jpg', updatedAt: 100 });
});

test('attachNotes: 保存済みの動画にだけ note を付け、空の note は付けない', () => {
  const videos = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const notes = { 1: { name: '名前', tags: [], score: 0 }, 2: { name: '', tags: [], score: 0 } };
  const result = attachNotes(videos, notes);
  assert.deepEqual(result[0].note, { name: '名前', tags: [], score: 0 });
  assert.equal(result[1].note, undefined);
  assert.equal(result[2].note, undefined);
});

test('allCustomTags: 全 note の独自タグを重複なく返す', () => {
  const notes = { 1: { tags: ['旅行', 'あとで見る'] }, 2: { tags: ['旅行', '料理'] } };
  assert.deepEqual([...allCustomTags(notes)].sort(), ['あとで見る', '料理', '旅行'].sort());
});

function sampleNotes() {
  return {
    1: { name: 'A', tags: ['旅行'], score: 5, updatedAt: 300 },
    2: { name: '', tags: ['料理'], score: 3, updatedAt: 200 },
    3: { name: 'C', tags: [], score: 4, updatedAt: 100 },
    4: { name: '', tags: [], score: 0, updatedAt: 50 } // 空 note は一覧に出ない
  };
}
function sampleFindVideo(id) {
  const table = {
    1: { id: 1, title: '動画1', user: 'friend_a', siteTags: ['屋外'] },
    2: { id: 2, title: '動画2', user: 'friend_b', siteTags: ['料理', '屋外'] }
    // id 3 はフィードから消えた古い動画（見つからない）
  };
  return table[id] || null;
}

test('organizedList: 名前・タグ・得点のどれかを付けた動画だけを対象にする', () => {
  const result = organizedList({ notes: sampleNotes(), findVideo: sampleFindVideo });
  assert.deepEqual(result.items.map(x => x.id).sort(), [1, 2, 3]);
});

test('organizedList: フィードから消えた動画は note に保存した user/title/thumb で表示する', () => {
  const notes = { 3: { name: 'C', tags: [], score: 4, user: 'friend_c', title: '昔の動画', thumb: 'https://x/1.jpg', updatedAt: 100 } };
  const result = organizedList({ notes, findVideo: () => null });
  const three = result.items.find(x => x.id === 3);
  assert.equal(three.title, '昔の動画');
  assert.equal(three.user, 'friend_c');
  assert.equal(three.thumb, 'https://x/1.jpg');
  assert.equal(three.note.name, 'C');
});

test('organizedList: 投稿者・サムネが無い Google 検索由来の note もタイトルと得点で表示する', () => {
  const notes = { 44: { name: '', tags: ['検索'], score: 4, user: '', title: '検索結果の動画', thumb: '', updatedAt: 100 } };
  const result = organizedList({ notes, findVideo: () => null });
  assert.deepEqual(result.items, [{
    id: 44, title: '検索結果の動画', user: '', thumb: '', duration: '', hd: false, private: false, ago: '', siteTags: [],
    note: { name: '', tags: ['検索'], score: 4 }
  }]);
});

test('organizedList: 独自タグで絞り込む', () => {
  const result = organizedList({ notes: sampleNotes(), findVideo: sampleFindVideo, tag: '旅行' });
  assert.deepEqual(result.items.map(x => x.id), [1]);
});

test('organizedList: サイトのタグで絞り込む', () => {
  const result = organizedList({ notes: sampleNotes(), findVideo: sampleFindVideo, siteTag: '料理' });
  assert.deepEqual(result.items.map(x => x.id), [2]);
});

test('organizedList: ★n 以上で絞り込む', () => {
  const result = organizedList({ notes: sampleNotes(), findVideo: sampleFindVideo, minScore: 4 });
  assert.deepEqual(result.items.map(x => x.id).sort(), [1, 3]);
});

test('organizedList: 得点順（同点は付けた順）で並べる', () => {
  const result = organizedList({ notes: sampleNotes(), findVideo: sampleFindVideo, sort: 'score' });
  assert.deepEqual(result.items.map(x => x.id), [1, 3, 2]);
});

test('organizedList: 付けた順（新しく付けたものが先）で並べる', () => {
  const result = organizedList({ notes: sampleNotes(), findVideo: sampleFindVideo, sort: 'added' });
  assert.deepEqual(result.items.map(x => x.id), [1, 2, 3]);
});

test('organizedList: 100 件ずつページ送りする', () => {
  const notes = {};
  for (let i = 1; i <= 205; i += 1) notes[i] = { name: `動画${i}`, tags: [], score: 0, updatedAt: i };
  const page1 = organizedList({ notes, findVideo: () => null, sort: 'added', page: 1 });
  const page3 = organizedList({ notes, findVideo: () => null, sort: 'added', page: 3 });
  assert.equal(page1.items.length, 100);
  assert.equal(page1.total, 205);
  assert.equal(page1.pages, 3);
  assert.equal(page3.items.length, 5);
  assert.equal(page1.items[0].id, 205); // 一番新しいものが先頭
});

test('mergeForImport: 同じ動画は新しいほう（updatedAt が大きいほう）を優先して統合する', () => {
  const existing = { 1: { name: '旧', tags: [], score: 2, updatedAt: 100 }, 2: { name: '既存のみ', tags: [], score: 1, updatedAt: 500 } };
  const incoming = { 1: { name: '新', tags: ['x'], score: 5, updatedAt: 200 }, 3: { name: '新規', tags: [], score: 3, updatedAt: 10 } };
  const merged = mergeForImport(existing, incoming);
  assert.equal(merged[1].name, '新');
  assert.equal(merged[2].name, '既存のみ');
  assert.equal(merged[3].name, '新規');
});

test('mergeForImport: 空の note や不正なキーは取り込まない', () => {
  const merged = mergeForImport({}, { 1: { name: '', tags: [], score: 0 }, abc: { name: '不正なID' }, 2: { name: '有効', tags: [], score: 0, updatedAt: 1 } });
  assert.deepEqual(Object.keys(merged), ['2']);
});
