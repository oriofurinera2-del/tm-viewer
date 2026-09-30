'use strict';

// 見た動画の履歴（DESIGN 4.11）。端末内だけに保存し、外部には送らない。
// history.json の形: 新しい順のリスト [{ id, title, user, thumb, duration, at }]。
// ここでは重複排除・上限・ページ送りなどの純粋関数だけを扱う。
// ファイルの読み書きは main.js から store.js 経由で行い、この module は触らない。

const MAX_HISTORY = 500;
const PAGE_SIZE = 100;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeString(value) {
  return typeof value === 'string' ? value : '';
}

// 保存済み（または受け取った）1 件を、既知の項目だけの形に整える。
// 余計なキー（万一パスワードなどが紛れ込んでも）は落とす。
function normalizeRecord(raw) {
  return {
    id: raw?.id,
    title: normalizeString(raw?.title),
    user: normalizeString(raw?.user),
    thumb: normalizeString(raw?.thumb),
    duration: normalizeString(raw?.duration),
    at: Number.isFinite(raw?.at) ? raw.at : 0
  };
}

// 保存済みリストを、正しい形・有効な ID だけに整える。
function normalizeList(value) {
  const seen = new Set();
  const list = [];
  for (const raw of asArray(value)) {
    if (!validId(raw?.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    list.push(normalizeRecord(raw));
  }
  return list;
}

// meta で受け取った空でない項目だけを取り出す（空文字で既存を消さないため）。
function nonEmptyFields(meta) {
  const fields = {};
  for (const key of ['title', 'user', 'thumb', 'duration']) {
    const value = normalizeString(meta?.[key]);
    if (value) fields[key] = value;
  }
  return fields;
}

// 1 件を履歴の先頭に足す（DESIGN 4.11）。id で重複排除し、既にあれば先頭へ移動＋at 更新。
// 分かる項目（title/user/thumb/duration）だけ上書きし、空の meta では既存を消さない。上限 500 件。
function addHistory(list, meta, at, max = MAX_HISTORY) {
  const id = Number(meta?.id);
  if (!validId(id)) return normalizeList(list);
  const normalized = normalizeList(list);
  const existing = normalized.find(record => record.id === id);
  const rest = normalized.filter(record => record.id !== id);
  const record = {
    ...(existing || { id, title: '', user: '', thumb: '', duration: '', at: 0 }),
    ...nonEmptyFields(meta),
    id,
    at: Number.isFinite(at) ? at : Date.now()
  };
  return [record, ...rest].slice(0, Math.max(0, max));
}

// 既存 1 件の空いている項目を後から埋める（DESIGN 4.11 の裏取得）。
// 並び順（at）は変えない。見つからなければ何もしない。
function updateHistoryFields(list, id, fields) {
  id = Number(id);
  if (!validId(id)) return normalizeList(list);
  const add = nonEmptyFields(fields);
  if (Object.keys(add).length === 0) return normalizeList(list);
  return normalizeList(list).map(record => (record.id === id ? { ...record, ...add } : record));
}

// 新しい順で 1 ページ分を返す（整理タブと同じ 100 件粒度）。
function historyPage(list, { page = 1, pageSize = PAGE_SIZE } = {}) {
  const items = normalizeList(list);
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : PAGE_SIZE;
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (currentPage - 1) * size;
  return { items: items.slice(start, start + size), total, page: currentPage, pages };
}

module.exports = {
  MAX_HISTORY,
  PAGE_SIZE,
  normalizeRecord,
  normalizeList,
  addHistory,
  updateHistoryFields,
  historyPage
};
