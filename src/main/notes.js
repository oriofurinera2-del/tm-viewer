'use strict';

// 独自の名前・タグ・得点（DESIGN 4.8）。サイトには送らず、自分の PC 内だけに保存する。
// notes.json の形（DESIGN 6 章）: { "<動画ID>": { name, tags, score, user, title, thumb, updatedAt } }
// ここでは保存データの正規化・絞り込み・並べ替え・書き出し/読み込みの統合だけを扱う。
// ファイルの読み書きは main.js から store.js 経由で行い、この module は触らない。

const MAX_SCORE = 5;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTags(value) {
  const seen = new Set();
  const tags = [];
  for (const raw of asArray(value)) {
    const tag = typeof raw === 'string' ? raw.trim() : '';
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function normalizeScore(value) {
  const n = Math.trunc(Number(value));
  return Number.isInteger(n) && n >= 1 && n <= MAX_SCORE ? n : 0;
}

// 利用者の入力（名前・タグ・得点）だけを正規化する。保存前の patch 用。
function normalizePatch(patch) {
  return {
    name: normalizeName(patch?.name),
    tags: normalizeTags(patch?.tags),
    score: normalizeScore(patch?.score)
  };
}

function isEmptyNote(note) {
  return !note?.name && asArray(note?.tags).length === 0 && !note?.score;
}

// 保存済み（または読み込んだ）1 件を、既知の項目だけの形に整える。
// 余計なキー（万一パスワードなどが紛れ込んでも）は落とす。
function normalizeNoteRecord(raw) {
  return {
    ...normalizePatch(raw),
    user: typeof raw?.user === 'string' ? raw.user : '',
    title: typeof raw?.title === 'string' ? raw.title : '',
    thumb: typeof raw?.thumb === 'string' ? raw.thumb : '',
    updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : 0
  };
}

// フィード・整理した動画のカードに付ける note フィールド。空なら付けない。
function attachNotes(videos, notes) {
  return asArray(videos).map(video => {
    if (!validId(video?.id)) return video;
    const raw = notes ? notes[video.id] : null;
    if (!raw) return video;
    const note = normalizeNoteRecord(raw);
    if (isEmptyNote(note)) return video;
    return { ...video, note: { name: note.name, tags: note.tags, score: note.score } };
  });
}

// 独自タグの候補（既存の独自タグをすべて集めて重複を除く）。
function allCustomTags(notes) {
  const set = new Set();
  for (const raw of Object.values(notes || {})) {
    for (const tag of normalizeTags(raw?.tags)) set.add(tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

// 整理した動画の一覧: 絞り込み（独自タグ・サイトのタグ・★n 以上）・並べ替え（得点順／付けた順）・100 件ずつのページ送り。
// findVideo(id) は feedService から渡す。見つからない（フィードから消えた）動画は note に保存した user/title/thumb で表示する。
function organizedList({ notes, findVideo, tag = null, siteTag = null, minScore = 0, sort = 'score', page = 1, pageSize = 100 } = {}) {
  const entries = [];
  for (const [key, raw] of Object.entries(notes || {})) {
    const id = Number(key);
    if (!validId(id)) continue;
    const note = normalizeNoteRecord(raw);
    if (isEmptyNote(note)) continue;
    const cached = typeof findVideo === 'function' ? findVideo(id) : null;
    const video = cached
      ? { ...cached, id }
      : { id, title: note.title, user: note.user, thumb: note.thumb, duration: '', hd: false, private: false, ago: '', siteTags: [] };
    entries.push({ id, video, note });
  }

  const customTags = [...new Set(entries.flatMap(e => e.note.tags))].sort((a, b) => a.localeCompare(b, 'ja'));
  const siteTags = [...new Set(entries.flatMap(e => asArray(e.video.siteTags)))].sort((a, b) => a.localeCompare(b, 'ja'));

  let list = entries;
  if (typeof tag === 'string' && tag) list = list.filter(e => e.note.tags.includes(tag));
  if (typeof siteTag === 'string' && siteTag) list = list.filter(e => asArray(e.video.siteTags).includes(siteTag));
  const min = normalizeScore(minScore) || (Number(minScore) > 0 ? Math.trunc(Number(minScore)) : 0);
  if (min > 0) list = list.filter(e => e.note.score >= min);

  list = list.slice().sort((a, b) => (sort === 'added'
    ? (b.note.updatedAt || 0) - (a.note.updatedAt || 0)
    : (b.note.score - a.note.score) || ((b.note.updatedAt || 0) - (a.note.updatedAt || 0))));

  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (currentPage - 1) * pageSize;
  const items = list.slice(start, start + pageSize)
    .map(e => ({ ...e.video, note: { name: e.note.name, tags: e.note.tags, score: e.note.score } }));

  return { items, total, page: currentPage, pages, customTags, siteTags };
}

// 書き出し・読み込み（JSON、DESIGN 4.8）。読み込みは既存と統合し、同じ動画IDは新しいほう（updatedAt が大きいほう）を優先する。
// 未知のキー（ログイン情報など）は normalizeNoteRecord で落ちるため、ここに混入しない。
function mergeForImport(existing, incoming) {
  const merged = { ...(existing || {}) };
  for (const [key, raw] of Object.entries(incoming || {})) {
    const id = Number(key);
    if (!validId(id)) continue;
    const record = normalizeNoteRecord(raw);
    if (isEmptyNote(record)) continue;
    const current = merged[id] ? normalizeNoteRecord(merged[id]) : null;
    if (!current || record.updatedAt >= current.updatedAt) merged[id] = record;
  }
  return merged;
}

module.exports = {
  MAX_SCORE,
  normalizePatch,
  normalizeNoteRecord,
  isEmptyNote,
  attachNotes,
  allCustomTags,
  organizedList,
  mergeForImport
};
