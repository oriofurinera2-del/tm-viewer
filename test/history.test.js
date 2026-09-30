'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_HISTORY,
  normalizeRecord,
  normalizeList,
  addHistory,
  updateHistoryFields,
  historyPage
} = require('../src/main/history');

test('normalizeRecord: 未知のキー（パスワードなど）は落ち、既知の項目だけ残る', () => {
  const record = normalizeRecord({ id: 5, title: 't', user: 'u', thumb: 'https://x/1.jpg', duration: '10:00', at: 100, password: 'secret' });
  assert.deepEqual(record, { id: 5, title: 't', user: 'u', thumb: 'https://x/1.jpg', duration: '10:00', at: 100 });
});

test('normalizeList: 無効な ID・重複を落とす', () => {
  const list = normalizeList([{ id: 1 }, { id: 1 }, { id: 0 }, { id: -3 }, { id: 2 }, { foo: 'bar' }]);
  assert.deepEqual(list.map(r => r.id), [1, 2]);
});

test('addHistory: 先頭に足し、id で重複排除して新しい順になる', () => {
  let list = addHistory([], { id: 1, title: 'a' }, 100);
  list = addHistory(list, { id: 2, title: 'b' }, 200);
  assert.deepEqual(list.map(r => r.id), [2, 1]);
  assert.equal(list[0].title, 'b');
});

test('addHistory: 既にある動画は先頭へ移動し at を更新する（再視聴で最新）', () => {
  let list = addHistory([], { id: 1, title: 'a' }, 100);
  list = addHistory(list, { id: 2, title: 'b' }, 200);
  list = addHistory(list, { id: 1 }, 300);
  assert.deepEqual(list.map(r => r.id), [1, 2]);
  assert.equal(list[0].at, 300);
  // 空の meta では既存のタイトルを消さない。
  assert.equal(list[0].title, 'a');
});

test('addHistory: 分かる項目だけ上書きし、空文字では既存を消さない', () => {
  let list = addHistory([], { id: 1, title: 'a', user: 'u', thumb: 'https://x/1.jpg', duration: '5:00' }, 100);
  list = addHistory(list, { id: 1, title: '新タイトル', user: '', thumb: '', duration: '' }, 200);
  assert.equal(list[0].title, '新タイトル');
  assert.equal(list[0].user, 'u');
  assert.equal(list[0].thumb, 'https://x/1.jpg');
  assert.equal(list[0].duration, '5:00');
});

test('addHistory: 無効な id は無視して整形済みリストを返す', () => {
  const list = addHistory([{ id: 1, title: 'a' }], { id: 0 }, 100);
  assert.deepEqual(list.map(r => r.id), [1]);
});

test('addHistory: 上限 500 件で古いものを切り捨てる', () => {
  let list = [];
  for (let i = 1; i <= MAX_HISTORY + 10; i += 1) list = addHistory(list, { id: i }, i);
  assert.equal(list.length, MAX_HISTORY);
  assert.equal(list[0].id, MAX_HISTORY + 10); // 最新が先頭
  assert.equal(list[list.length - 1].id, 11); // 古い 10 件が消える
});

test('updateHistoryFields: 既存 1 件の空き項目を並び順を変えずに埋める', () => {
  let list = addHistory([], { id: 1, title: 'a' }, 100);
  list = addHistory(list, { id: 2, title: 'b' }, 200);
  const updated = updateHistoryFields(list, 1, { thumb: 'https://x/1.jpg', user: 'u' });
  assert.deepEqual(updated.map(r => r.id), [2, 1]); // 順番は変わらない
  assert.equal(updated[1].thumb, 'https://x/1.jpg');
  assert.equal(updated[1].user, 'u');
  assert.equal(updated[1].at, 100); // at も変わらない
});

test('updateHistoryFields: 見つからない・空の項目では変えない', () => {
  const list = addHistory([], { id: 1, title: 'a' }, 100);
  assert.deepEqual(updateHistoryFields(list, 9, { thumb: 'x' }), list);
  assert.deepEqual(updateHistoryFields(list, 1, { thumb: '' }), list);
});

test('historyPage: 新しい順で 100 件ずつページ送りする', () => {
  let list = [];
  for (let i = 1; i <= 150; i += 1) list = addHistory(list, { id: i }, i);
  const first = historyPage(list, { page: 1 });
  assert.equal(first.total, 150);
  assert.equal(first.pages, 2);
  assert.equal(first.page, 1);
  assert.equal(first.items.length, 100);
  assert.equal(first.items[0].id, 150); // 最新が先頭
  const second = historyPage(list, { page: 2 });
  assert.equal(second.items.length, 50);
  assert.equal(second.items[0].id, 50);
});

test('historyPage: 範囲外のページは端に丸める', () => {
  const list = addHistory([], { id: 1 }, 100);
  assert.equal(historyPage(list, { page: 99 }).page, 1);
  assert.equal(historyPage(list, { page: 0 }).page, 1);
  assert.deepEqual(historyPage([], {}), { items: [], total: 0, page: 1, pages: 1 });
});
