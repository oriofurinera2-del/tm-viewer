'use strict';
const site = window.tmViewer.site;
const google = window.tmViewer.google;
const feed = window.tmViewer.feed;
const notes = window.tmViewer.notes;
const download = window.tmViewer.download;
const credentials = window.tmViewer.credentials;
const update = window.tmViewer.update;
const $ = id => document.getElementById(id);
const state = { selectedUser: null, page: 1, viewableOnly: true, includeSubscriptions: true, search: '', requestId: 0 };
const back = $('back');
const forward = $('forward');

function opts() { return { includeSubscriptions: state.includeSubscriptions, viewableOnly: state.viewableOnly, selectedUser: state.selectedUser, page: state.page }; }
function isCurrent(requestId) { return requestId === state.requestId; }
function setView(name) {
  const show = name === 'site';
  $('feed').hidden = name !== 'feed'; $('search').hidden = name !== 'search'; $('organized').hidden = name !== 'organized'; $('site').hidden = !show; $('downloads').hidden = name !== 'downloads'; $('settings').hidden = name !== 'settings';
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  site.command(show ? 'show' : 'hide');
  if (show) bounds();
  else if (name === 'feed') void draw(true);
  else if (name === 'search') $('google-search-term').focus();
  else if (name === 'organized') void drawOrganized();
  else if (name === 'downloads') renderDownloadsTab();
  else if (name === 'settings') void drawCredentials();
  applyGoogleView();
}
function bounds() { const r = $('site-area').getBoundingClientRect(); site.setBounds({ width: r.width, height: r.height }); }
function pager(id, current, pages, onGo) {
  // 既定（フィード）: ページ移動したら内容の先頭までスクロールを戻す。
  const go = onGo || (page => { state.page = page; void draw(); const c = $('feed-content'); if (c) c.scrollTop = 0; });
  const box = $(id); box.textContent = ''; if (pages < 2) return;
  [['前へ', current - 1], ...Array.from({ length: pages }, (_, i) => [String(i + 1), i + 1]), ['次へ', current + 1]].forEach(([label, page]) => {
    const b = document.createElement('button'); b.textContent = label; b.disabled = page < 1 || page > pages || page === current;
    if (page === current) b.classList.add('current'); // 今開いているページを強調
    b.onclick = () => go(page); box.append(b);
  });
}

// 指定した投稿者だけの動画に切り替える（カードの投稿者クリック・左の友達名クリック共通の入口）。
function selectPerson(user) {
  if (!user) return;
  state.selectedUser = user; state.page = 1;
  setView('feed');
  syncSelectedPeople();
  const c = $('feed-content'); if (c) c.scrollTop = 0;
  void draw();
}

// ---- 検索タブの Google（DESIGN 4.10 案A）: 「探す」（googleView）と「取り込んだ動画」を切り替える ----
// 取り込んだ結果はセッション中メモリで保持する（アプリ再起動で消える。Google 結果自体は保存しない）。
const googleResults = new Map(); // id -> { id, url, title, thumb, user, siteTags }
const googleCardEls = new Map(); // id -> カードの wrap 要素
let googleMode = 'browse';
// 取り込み中の表示（DESIGN 4.10）: スピナーと「今◯ページ目・現在◯件取り込み中…」を更新し続ける。
let googleImporting = false;
let googleLastPages = 0;
function setGoogleImporting(on) {
  googleImporting = on;
  const spinner = $('google-spinner'); if (spinner) spinner.hidden = !on;
}
function googleImportingText(pages = googleLastPages) {
  const head = Number.isInteger(pages) && pages > 0 ? `今 ${pages} ページ目・` : '';
  return `${head}現在 ${googleResults.size} 件取り込み中…`;
}

async function googleResultCard(result) {
  // 検索結果そのものは保存しない。利用者が付けた note と、裏で後入れしたサムネ・投稿者・タグを重ねる。
  const context = await notes.context(result.id).catch(() => null);
  const siteTags = Array.isArray(result.siteTags) ? result.siteTags : [];
  const video = {
    id: result.id,
    title: result.title,
    user: result.user || context?.user || '',
    thumb: result.thumb || context?.thumb || null,
    duration: result.duration || '', hd: false, private: false, ago: '',
    siteTags, siteTagsAt: siteTags.length ? Date.now() : 0,
    note: { name: context?.name || '', tags: Array.isArray(context?.tags) ? context.tags : [], score: context?.score || 0 }
  };
  // タグは裏取得（google.onEnrich）で後入れするため、カーソル時のタグ取得はしない。
  const card = videoCard(video, { url: result.url, sourceLabel: 'Google 検索の結果', preventTagFetch: true, markWatched: false });
  applyGoogleCardLoading(card, result);
  return card;
}

// 裏取得（enrich）が終わるまでは、壊れた画像アイコンではなく「読み込み中」の見た目にする（DESIGN 4.10）。
// enrich が届いたら実際のサムネ・タグに差し替える。失敗（サムネ無し）は無地プレースホルダで止める。
function applyGoogleCardLoading(card, result) {
  const img = card.querySelector('.video-card > img');
  const tagsBox = card.querySelector('.site-tags');
  if (!result.enriched) {
    if (img) { img.removeAttribute('src'); img.classList.add('thumb-loading'); }
    if (tagsBox) { tagsBox.textContent = '取得中…'; tagsBox.classList.add('tags-loading'); }
  } else if (!result.thumb) {
    if (img) { img.removeAttribute('src'); img.classList.add('thumb-empty'); }
  }
}

function updateGoogleCardsLabel() {
  const btn = $('google-mode-cards'); if (!btn) return;
  btn.textContent = googleResults.size ? `取り込んだ動画 (${googleResults.size})` : '取り込んだ動画';
}
function clearGoogleResults() {
  googleResults.clear(); googleCardEls.clear();
  const grid = $('google-search-grid'); if (grid) grid.textContent = '';
  updateGoogleCardsLabel();
}
// 解決できたカードを累積で追記する（id 重複は除く）。
async function appendGoogleCards(batch) {
  const grid = $('google-search-grid'); if (!grid) return;
  for (const result of batch) {
    if (!result || !Number.isInteger(result.id) || googleResults.has(result.id)) continue;
    googleResults.set(result.id, result);
    const card = await googleResultCard(result);
    googleCardEls.set(result.id, card); grid.append(card);
  }
  updateGoogleCardsLabel();
  // 取り込み中は件数を更新し続けて、進んでいることが見えるようにする。
  if (googleImporting) $('google-search-status').textContent = googleImportingText();
}
// サムネ・投稿者・サイトタグの後入れ。該当カードだけ作り直して差し替える。
async function enrichGoogleCard({ id, thumb, user, siteTags, duration }) {
  const result = googleResults.get(id); const old = googleCardEls.get(id);
  if (!result || !old) return;
  if (thumb) result.thumb = thumb;
  if (user) result.user = user;
  if (duration) result.duration = duration;
  if (Array.isArray(siteTags) && siteTags.length) result.siteTags = siteTags;
  result.enriched = true; // 届いた時点で「読み込み中」を終える（サムネ無しでも回し続けない）
  const card = await googleResultCard(result);
  googleCardEls.set(id, card); old.replaceWith(card);
}

// 検索タブがアクティブで「探す」モードのときだけ googleView を表示する（DESIGN 4.10）。
function sendGoogleBounds() {
  const el = $('google-area'); if (!el) return;
  const r = el.getBoundingClientRect();
  google.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
function applyGoogleView() {
  if (!$('search').hidden && googleMode === 'browse') { sendGoogleBounds(); void google.command('show'); }
  else void google.command('hide');
}
function setGoogleMode(mode) {
  googleMode = mode === 'cards' ? 'cards' : 'browse';
  $('google-browse').hidden = googleMode !== 'browse';
  $('google-cards').hidden = googleMode !== 'cards';
  document.querySelectorAll('[data-gmode]').forEach(b => b.classList.toggle('active', b.dataset.gmode === googleMode));
  applyGoogleView();
}

// 新しい検索: 累積をリセットし、googleView に開いて自動ページ送りで取り込む。
async function runGoogleSearch() {
  const term = $('google-search-term').value.trim();
  if (!term) return;
  const submit = $('google-search-submit'); const status = $('google-search-status');
  submit.disabled = true; $('google-import-more').hidden = true;
  clearGoogleResults(); setGoogleMode('browse');
  status.textContent = 'Google 検索を開いています…';
  try {
    const result = await google.show(term);
    if (result?.ok) {
      googleLastPages = 0; setGoogleImporting(true);
      status.textContent = googleImportingText(0);
      void google.importAll();
    } else {
      status.textContent = 'Google 検索を開けませんでした。';
    }
  } catch {
    status.textContent = 'Google 検索を開けませんでした。';
  } finally { submit.disabled = false; }
}
// 独自タグの候補（既存の独自タグ）。編集欄を開くたびに使うので取得結果を軽くキャッシュする。
let customTagCandidatesCache = null;
function customTagCandidates() {
  if (!customTagCandidatesCache) customTagCandidatesCache = notes.tags().catch(() => []);
  return customTagCandidatesCache;
}
function forgetCustomTagCandidates() { customTagCandidatesCache = null; }
// 投稿者のアイコン。画像が無い人は名前の頭文字の丸で代用する。
function avatar(user, url) {
  const box = document.createElement('span'); box.className = 'avatar'; box.setAttribute('aria-hidden', 'true');
  const initial = () => { box.textContent = Array.from(String(user || '?'))[0].toUpperCase(); };
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    const img = document.createElement('img'); img.alt = ''; img.src = url; img.onerror = () => { img.remove(); initial(); }; box.append(img);
  } else initial();
  return box;
}
// 推定投稿日（DESIGN 4.3）: 「2026/09/27 頃」。サイトの相対表示はカーソルで出す。
function postedLabel(video) {
  if (!Number.isFinite(video.postedAtEst)) return video.ago || '';
  const d = new Date(video.postedAtEst); const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} 頃`;
}
// サムネの切り替え（4.8・8 章）: 末尾 `/<番号>.jpg` の番号だけを差し替える。合わない形のサムネは何もしない。
const THUMB_URL_RE = /^(.*\/)(\d+)(\.jpg)$/i;
const THUMB_DEFAULT_COUNT = 20;
function attachThumbRotation(card, image, video) {
  const match = THUMB_URL_RE.exec(video.thumb || '');
  if (!match) return;
  const prefix = match[1]; const suffix = match[3];
  const count = Number.isInteger(video.frameCount) && video.frameCount > 1 ? video.frameCount : THUMB_DEFAULT_COUNT;
  let timer = null; let n = 1;
  const show = () => { image.src = `${prefix}${n}${suffix}`; };
  const step = () => { n = n >= count ? 1 : n + 1; show(); };
  image.addEventListener('error', () => { if (timer) step(); }); // 読み込めなかった画像は飛ばす
  card.addEventListener('mouseenter', () => { if (timer) return; step(); timer = setInterval(step, 500); });
  card.addEventListener('mouseleave', () => { clearInterval(timer); timer = null; n = 1; show(); });
}
// 名前・独自タグの小さな編集欄（✎で開く。カードの下・サイト表示の上部バーで共用）。
// 既存の独自タグを候補表示し、Enter で追加・×で削除する。
function buildTagEditor(currentTags, onChange) {
  const box = document.createElement('div'); box.className = 'chips';
  const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'タグを追加（Enter）';
  const listId = `tag-candidates-${Math.random().toString(36).slice(2)}`;
  input.setAttribute('list', listId);
  const datalist = document.createElement('datalist'); datalist.id = listId;
  void customTagCandidates().then(list => list.forEach(t => {
    const option = document.createElement('option'); option.value = t; datalist.append(option);
  }));
  let tags = [...currentTags];
  const drawChips = () => {
    box.textContent = '';
    tags.forEach(t => {
      const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = t;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'タグを外す';
      remove.onclick = event => { event.stopPropagation(); tags = tags.filter(v => v !== t); drawChips(); onChange(tags); };
      chip.append(remove); box.append(chip);
    });
  };
  drawChips();
  input.onclick = event => event.stopPropagation();
  input.onkeydown = event => {
    if (event.key !== 'Enter' || event.isComposing) return; // 日本語変換の確定 Enter では追加しない
    event.preventDefault();
    const t = input.value.trim(); input.value = '';
    if (!t || tags.includes(t)) return;
    tags = [...tags, t]; drawChips(); onChange(tags); forgetCustomTagCandidates();
  };
  const wrap = document.createElement('div'); wrap.append(box, input, datalist);
  return wrap;
}

function videoCard(video, { url = `https://www.tokyomotion.net/video/${video.id}`, sourceLabel = '', preventTagFetch = false, markWatched = true } = {}) {
  const note = { name: video.note?.name || '', tags: Array.isArray(video.note?.tags) ? [...video.note.tags] : [], score: Number.isInteger(video.note?.score) ? video.note.score : 0 };
  const wrap = document.createElement('div'); wrap.className = 'card-wrap';
  const b = document.createElement('div'); b.className = `video-card${video.watched ? ' watched' : ''}`; b.tabIndex = 0; b.setAttribute('role', 'button');
  const image = document.createElement('img'); image.alt = ''; image.src = video.thumb || '';
  attachThumbRotation(b, image, video);
  // 動画の長さはサムネ右下に重ねて表示（フィード・整理・Google 取り込みで共通）。未取得なら隠す。
  const dur = document.createElement('span'); dur.className = 'dur';
  if (video.duration) dur.textContent = video.duration; else dur.hidden = true;

  const titleBox = document.createElement('div');
  const info = document.createElement('span'); info.className = 'card-user';
  const nameSpan = document.createElement('span'); nameSpan.className = 'card-user-name'; nameSpan.textContent = video.user;
  const posted = document.createElement('span'); posted.className = 'card-posted'; posted.textContent = postedLabel(video); posted.title = video.ago || '';
  const av = avatar(video.user, video.avatar);
  // 投稿者（アイコン・名前）をクリックしたら、その投稿者だけの動画に切り替える（左の友達名クリックと同じ）。
  if (video.user) {
    for (const el of [av, nameSpan]) {
      el.classList.add('user-link');
      el.title = `${video.user} の動画だけ表示`;
      el.onclick = e => { e.stopPropagation(); selectPerson(video.user); };
    }
  }
  info.append(av, nameSpan, posted);
  const badges = document.createElement('small'); badges.textContent = [sourceLabel, video.isNew && '新着', video.watched && '視聴済み', video.hd && '高画質', video.private && '非公開'].filter(Boolean).join(' '); badges.title = video.ago || '';
  const starsBox = document.createElement('div'); starsBox.className = 'stars';
  const customTagsBox = document.createElement('div'); customTagsBox.className = 'custom-tags';
  const siteTagsBox = document.createElement('small'); siteTagsBox.className = 'site-tags'; siteTagsBox.dataset.id = String(video.id); showTags(siteTagsBox, video.siteTags);
  // タグ未取得の動画は、カーソルを乗せたときにその 1 本だけ取る（DESIGN 4.2）。
  if (!preventTagFetch && !Number.isFinite(video.siteTagsAt)) b.addEventListener('mouseenter', () => void loadTags(video.id), { once: true });

  // 名前があれば元のタイトルより大きく、元のタイトルは小さく併記する（4.8）。
  function renderTitle() {
    titleBox.textContent = '';
    const origTitle = video.title || '無題の動画';
    // タイトルは省略表示なので、ホバーで全文が見えるよう title 属性を付ける（独自名があれば併記）。
    titleBox.title = note.name ? `${note.name}｜${origTitle}` : origTitle;
    if (note.name) {
      const big = document.createElement('strong'); big.className = 'custom-title'; big.textContent = note.name;
      const orig = document.createElement('span'); orig.className = 'orig-title'; orig.textContent = origTitle;
      titleBox.append(big, orig);
    } else {
      const strong = document.createElement('strong'); strong.textContent = origTitle;
      titleBox.append(strong);
    }
  }
  // ★はカード上で直接押す。同じ★をもう一度押すと外す（4.8）。
  function renderStars() {
    starsBox.textContent = '';
    for (let i = 1; i <= 5; i += 1) {
      const s = document.createElement('button'); s.type = 'button'; s.className = `star${i <= note.score ? ' on' : ''}`; s.textContent = '★';
      s.title = i === note.score ? 'クリックで得点を外す' : `★${i}`;
      s.onclick = event => { event.stopPropagation(); void applyNote({ score: note.score === i ? 0 : i }); };
      starsBox.append(s);
    }
  }
  // 独自タグはサイトのタグより先に、色付きで表示する（4.8）。
  function renderCustomTags() {
    customTagsBox.textContent = '';
    note.tags.forEach(t => { const s = document.createElement('span'); s.className = 'utag'; s.textContent = t; customTagsBox.append(s); });
  }
  async function applyNote(patch) {
    Object.assign(note, patch);
    const saved = await notes.set(video.id, note, { title: video.title, user: video.user, thumb: video.thumb }).catch(() => undefined);
    if (saved !== undefined) {
      note.name = saved?.name || ''; note.tags = Array.isArray(saved?.tags) ? saved.tags : []; note.score = saved?.score || 0;
    }
    renderTitle(); renderStars(); renderCustomTags();
  }
  renderTitle(); renderStars(); renderCustomTags();

  if (video.user) b.append(image, dur, titleBox, info, badges, starsBox, customTagsBox, siteTagsBox);
  else b.append(image, dur, titleBox, badges, starsBox, customTagsBox, siteTagsBox);
  const openCard = async () => { if (markWatched) await feed.watch(video.id, true); await site.command('navigate', url); setView('site'); };
  b.onclick = () => void openCard();
  b.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openCard(); } };

  // ダウンロード（DESIGN 4.9）・編集（✎、4.8）。カードの中に入れず、上に重ねる。
  const saveBtn = document.createElement('button'); saveBtn.type = 'button'; saveBtn.className = 'card-download'; saveBtn.textContent = '保存'; saveBtn.title = 'この動画をダウンロード';
  saveBtn.onclick = event => { event.stopPropagation(); void addDownload(download.add(video.id, { title: video.title, user: video.user })); };
  const editToggle = document.createElement('button'); editToggle.type = 'button'; editToggle.className = 'edit-toggle'; editToggle.textContent = '✎'; editToggle.title = '名前・タグを編集';
  let editPanel = null;
  editToggle.onclick = event => {
    event.stopPropagation();
    if (editPanel) { editPanel.remove(); editPanel = null; return; }
    editPanel = document.createElement('div'); editPanel.className = 'card-edit'; editPanel.onclick = e => e.stopPropagation();
    const nameIn = document.createElement('input'); nameIn.type = 'text'; nameIn.placeholder = '独自の名前'; nameIn.value = note.name;
    nameIn.onchange = () => void applyNote({ name: nameIn.value.trim() });
    const tagEditor = buildTagEditor(note.tags, tags => void applyNote({ tags }));
    editPanel.append(nameIn, tagEditor);
    wrap.append(editPanel);
  };
  wrap.append(b, saveBtn, editToggle);
  return wrap;
}
// ダウンロードの進み具合。保存は 1 本ずつなので、最新の状態と待ちの本数を出す。
// ダウンロード タブ用に、動画ごとの最新状態を新しいものが上になる順で持つ（DESIGN 4.9）。
const downloads = new Map();
const downloadOrder = [];
function showDownloadText(text) { document.querySelectorAll('.download-status').forEach(x => { x.textContent = text; }); }
async function addDownload(request) {
  const result = await request.catch(() => null);
  if (!result?.ok) showDownloadText(result?.message || 'ダウンロードを始められませんでした');
}
function bumpDownloadOrder(id) {
  const index = downloadOrder.indexOf(id);
  if (index !== -1) downloadOrder.splice(index, 1);
  downloadOrder.unshift(id);
}
function updateDownloadsTabLabel() {
  const button = document.querySelector('[data-view="downloads"]');
  if (!button) return;
  const label = button.querySelector('.tab-label') || button;
  const active = [...downloads.values()].filter(x => x.state === 'downloading').length;
  label.textContent = active > 0 ? `ダウンロード (${active})` : 'ダウンロード';
}
function downloadRowLabel(status) {
  if (status.state === 'downloading' && Number.isInteger(status.percent)) return `${status.message || '保存中'} ${status.percent}%`;
  if (status.state === 'failed') return `失敗: ${status.message || '保存できませんでした'}`;
  return status.message || '';
}
function downloadRow(status) {
  const row = document.createElement('div'); row.className = 'download-row';
  const name = document.createElement('strong'); name.textContent = status.name || status.fileName || `動画 ${status.id}`;
  const info = document.createElement('span'); info.textContent = downloadRowLabel(status);
  row.append(name, info);
  if (status.state === 'queued' || status.state === 'resolving' || status.state === 'downloading') {
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '中止';
    cancel.onclick = () => void download.cancel(status.id);
    row.append(cancel);
  } else if (status.state === 'failed') {
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'やり直す';
    retry.onclick = () => void download.retry(status.id);
    row.append(retry);
  } else if (status.state === 'done') {
    const open = document.createElement('button'); open.type = 'button'; open.textContent = 'フォルダを開く';
    open.onclick = () => void download.showInFolder(status.id);
    row.append(open);
  }
  return row;
}
function renderDownloadsTab() {
  const box = $('downloads-list'); if (!box) return;
  box.textContent = '';
  const ids = downloadOrder.filter(id => downloads.has(id));
  if (ids.length === 0) { box.textContent = 'ダウンロードはまだありません。'; return; }
  ids.forEach(id => box.append(downloadRow(downloads.get(id))));
}
download.onStatus(status => {
  if (!status || !Number.isInteger(status.id)) return;
  const previous = downloads.get(status.id);
  if (status.state === 'canceled') { downloads.delete(status.id); const i = downloadOrder.indexOf(status.id); if (i !== -1) downloadOrder.splice(i, 1); }
  else {
    downloads.set(status.id, status);
    if (!previous || status.state === 'queued') bumpDownloadOrder(status.id);
  }
  const waiting = [...downloads.values()].filter(x => x.state === 'queued').length;
  const label = status.name || `動画 ${status.id}`;
  const percent = Number.isInteger(status.percent) && status.state === 'downloading' ? ` ${status.percent}%` : '';
  const text = status.state === 'done' ? `完了: ${status.fileName || label}`
    : status.state === 'failed' ? `失敗: ${label}（${status.message || '保存できませんでした'}）`
    : status.state === 'canceled' ? `中止: ${label}`
    : `${status.message || ''}${percent}: ${label}`;
  showDownloadText(waiting > 0 ? `${text}（あと ${waiting} 本）` : text);
  updateDownloadsTabLabel();
  if (!$('downloads').hidden) renderDownloadsTab();
});
(async () => {
  const list = await download.list().catch(() => []);
  list.forEach(status => { downloads.set(status.id, status); downloadOrder.push(status.id); });
  updateDownloadsTabLabel();
})();
function showTags(box, values) {
  const list = Array.isArray(values) ? values : []; box.textContent = list.join(' ・ '); box.title = list.join(' ・ ');
}
function updateTags(id, values) { document.querySelectorAll(`.site-tags[data-id="${Number(id)}"]`).forEach(box => showTags(box, values)); }
async function loadTags(id) {
  const result = await feed.tags(id).catch(() => null);
  if (result?.ok) updateTags(id, result.tags);
}
function syncSelectedPeople() {
  document.querySelectorAll('.person-pick').forEach(pick => {
    const selected = pick.dataset.user === (state.selectedUser || '');
    pick.classList.toggle('selected', selected); pick.setAttribute('aria-pressed', String(selected));
  });
}
async function people(requestId = state.requestId) {
  const values = await feed.people(opts()); if (!isCurrent(requestId)) return;
  const box = $('people'); box.textContent = '';
  const add = (label, user, unread, muted, url) => {
    const row = document.createElement('div'); const pick = document.createElement('button');
    pick.className = 'person-pick'; pick.dataset.user = user || '';
    const text = document.createElement('span'); text.className = 'person-label'; text.textContent = `${label} (${unread})`;
    if (user) pick.append(avatar(user, url)); pick.append(text);
    pick.onclick = () => { state.selectedUser = user; state.page = 1; syncSelectedPeople(); void draw(); };
    row.append(pick);
    if (user) { const mute = document.createElement('button'); mute.textContent = muted ? '表示する' : '非表示'; mute.onclick = async () => { await feed.mute(user, !muted); void draw(); }; row.append(mute); }
    box.append(row);
  };
  const list = values.filter(x => !state.search || x.user.toLowerCase().includes(state.search));
  add('すべて', null, list.filter(x => !x.muted).reduce((n, x) => n + x.unread, 0));
  list.forEach(x => add(x.user + (x.kind === 'subscription' ? '（購読）' : ''), x.user, x.unread, x.muted, x.avatar));
  syncSelectedPeople();
}
function renderResult(result, selectedUser) {
  state.page = result.page; $('feed-title').textContent = selectedUser || 'すべて';
  const grid = $('feed-grid'); grid.textContent = '';
  if (!result.videos.length) grid.textContent = selectedUser ? '保存済みの動画はありません。追加取得を待っています。' : '表示する動画がありません。サイトにログインしてから更新してください。';
  result.videos.forEach(x => grid.append(videoCard(x)));
  pager('feed-pager-top', result.page, result.pages); pager('feed-pager-bottom', result.page, result.pages);
}
async function draw(opened = false) {
  const requestId = ++state.requestId; const selectedUser = state.selectedUser; const options = opts();
  try {
    if (!selectedUser) {
      const result = opened ? await feed.open(options) : await feed.get(options);
      if (!isCurrent(requestId)) return;
      renderResult(result, null); await people(requestId); return;
    }
    // 保存済みの分は先に表示し、足りない古いページだけ後ろで取得する。
    const cached = await feed.get(options);
    if (!isCurrent(requestId)) return;
    renderResult(cached, selectedUser); void people(requestId);
    const needed = cached.page * 100;
    $('feed-progress').textContent = `追加取得中 ${Math.min(cached.total, needed)}/${needed}`;
    const completed = await feed.personPage({ user: selectedUser, page: cached.page, viewableOnly: options.viewableOnly, requestId });
    if (!isCurrent(requestId) || state.selectedUser !== selectedUser) return;
    renderResult(completed, selectedUser); $('feed-progress').textContent = `追加取得完了 (${completed.total}件)`;
    await people(requestId);
  } catch {
    if (!isCurrent(requestId)) return;
    $('feed-progress').textContent = selectedUser ? '追加取得できませんでした。保存済みの動画を表示しています。' : '表示できませんでした。';
  }
}
// ---- 整理した動画（4.8）: 名前・タグ・得点のどれかを付けた動画の一覧 ----
const orgState = { tag: null, siteTag: '', minScore: 0, sort: 'score', page: 1 };
async function drawOrganized() {
  const result = await notes.organized({ tag: orgState.tag, siteTag: orgState.siteTag || null, minScore: orgState.minScore, sort: orgState.sort, page: orgState.page }).catch(() => null);
  if (!result) return;
  orgState.page = result.page;

  const tagsBox = $('org-tags'); tagsBox.textContent = '';
  const chip = (label, value) => {
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = label; btn.className = orgState.tag === value ? 'on' : '';
    btn.onclick = () => { orgState.tag = orgState.tag === value ? null : value; orgState.page = 1; void drawOrganized(); };
    tagsBox.append(btn);
  };
  chip('すべて', null);
  result.customTags.forEach(t => chip(t, t));

  const siteSel = $('org-site-tag'); siteSel.textContent = '';
  const none = document.createElement('option'); none.value = ''; none.textContent = '指定なし'; siteSel.append(none);
  result.siteTags.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; siteSel.append(o); });
  siteSel.value = orgState.siteTag;
  $('org-min').value = String(orgState.minScore);
  $('org-sort').value = orgState.sort;
  $('org-count').textContent = result.total
    ? `全 ${result.total} 件中 ${(result.page - 1) * 100 + 1}〜${Math.min(result.total, result.page * 100)} 件目`
    : '0 件';

  const grid = $('org-grid'); grid.textContent = '';
  if (!result.items.length) grid.textContent = '条件に合う動画がありません。';
  result.items.forEach(x => grid.append(videoCard(x)));
  const goOrgPage = page => { orgState.page = page; void drawOrganized(); };
  pager('org-pager-top', result.page, result.pages, goOrgPage);
  pager('org-pager-bottom', result.page, result.pages, goOrgPage);
}
$('org-site-tag').onchange = e => { orgState.siteTag = e.target.value; orgState.page = 1; void drawOrganized(); };
$('org-min').onchange = e => { orgState.minScore = Number(e.target.value); orgState.page = 1; void drawOrganized(); };
$('org-sort').onchange = e => { orgState.sort = e.target.value; orgState.page = 1; void drawOrganized(); };

// ---- 整理データの書き出し・読み込み（4.8） ----
$('notes-export').onclick = async () => {
  const result = await notes.exportData().catch(() => null);
  if (result?.ok) showDownloadText(`整理データを書き出しました: ${result.filePath}`);
  else if (result?.message) showDownloadText(result.message);
};
$('notes-import').onclick = async () => {
  const result = await notes.importData().catch(() => null);
  if (result?.ok) {
    showDownloadText(`整理データを読み込みました（${result.count} 件）`);
    if (!$('organized').hidden) void drawOrganized();
  } else if (result?.message) showDownloadText(result.message);
};

// ---- ログイン情報の保存（DESIGN 4.1）: 値は main に渡すだけで、渡された値をここで保持しない ----
async function drawCredentials() {
  const status = await credentials.status().catch(() => ({ available: false, hasSaved: false }));
  $('credentials-unavailable').hidden = status.available;
  $('credentials-form').hidden = !status.available;
  if (!status.available) return;
  $('credentials-enabled').checked = status.hasSaved;
  $('credentials-inputs').hidden = !status.hasSaved;
  $('credentials-clear').hidden = !status.hasSaved;
  // 保存済みなら ID を表示（秘密ではない）。パスワードは出さず、保存済みと分かる表示にする。
  $('credentials-id').value = status.savedId || '';
  $('credentials-password').value = '';
  $('credentials-password').placeholder = status.hasSaved ? '保存済み（変更するときだけ入力）' : '';
  $('credentials-status').textContent = status.hasSaved ? 'ログイン情報は保存されています' : '';
}
$('credentials-enabled').onchange = async e => {
  if (e.target.checked) { $('credentials-inputs').hidden = false; return; }
  $('credentials-inputs').hidden = true;
  const result = await credentials.clear().catch(() => null);
  $('credentials-clear').hidden = true;
  $('credentials-status').textContent = result?.ok ? '保存した情報を削除しました' : '';
};
$('credentials-save').onclick = async () => {
  const id = $('credentials-id').value.trim();
  const password = $('credentials-password').value;
  const result = await credentials.save(id, password).catch(() => null);
  $('credentials-password').value = '';
  if (result?.ok) {
    $('credentials-clear').hidden = false;
    $('credentials-status').textContent = '保存しました';
  } else {
    $('credentials-status').textContent = result?.message || '保存できませんでした';
  }
};
$('credentials-clear').onclick = async () => {
  const result = await credentials.clear().catch(() => null);
  $('credentials-enabled').checked = false;
  $('credentials-inputs').hidden = true;
  $('credentials-clear').hidden = true;
  $('credentials-id').value = ''; $('credentials-password').value = '';
  $('credentials-status').textContent = result?.ok ? '保存した情報を削除しました' : '';
};
credentials.onAutoLoginFailed(() => {
  const message = '自動ログインに失敗しました。手動でログインしてください。';
  $('feed-progress').textContent = message;
  $('credentials-status').textContent = message;
});

// 自動更新: ダウンロード完了の通知が来たらバナーを出す。押されたら再起動して更新する。
update.onReady(info => {
  const version = info?.version ? `（${info.version}）` : '';
  $('update-banner-text').textContent = `新しいバージョン${version}を準備しました`;
  $('update-banner').hidden = false;
});
$('update-install').onclick = () => void update.install();
$('update-dismiss').onclick = () => { $('update-banner').hidden = true; };

// ---- サイト表示: 動画ページを開いているときだけ、上部バーの下に名前・タグ・得点の入力欄を出す（4.8） ----
function extractVideoId(url) {
  const m = /^https?:\/\/(www\.)?tokyomotion\.net\/video\/(\d+)/i.exec(url || '');
  return m ? Number(m[2]) : null;
}
let metaCurrentId = null;
async function renderSiteMetabar(id) {
  const bar = $('site-metabar');
  if (!Number.isInteger(id)) { bar.hidden = true; bar.textContent = ''; return; }
  const context = await notes.context(id).catch(() => null);
  if (metaCurrentId !== id) return; // その間に別のページへ移動していたら描かない
  bar.hidden = false; bar.textContent = '';
  const note = { name: context?.name || '', tags: Array.isArray(context?.tags) ? [...context.tags] : [], score: context?.score || 0 };
  async function save(patch) {
    Object.assign(note, patch);
    await notes.set(id, note, { title: context?.title }).catch(() => {});
  }

  const nameField = document.createElement('label'); nameField.className = 'field';
  const nameIn = document.createElement('input'); nameIn.type = 'text'; nameIn.className = 'name-in'; nameIn.value = note.name; nameIn.placeholder = context?.title || '独自の名前';
  nameIn.onchange = () => void save({ name: nameIn.value.trim() });
  nameField.append(Object.assign(document.createElement('span'), { className: 'lbl', textContent: '名前' }), nameIn);

  const tagField = document.createElement('div'); tagField.className = 'field';
  const tagEditor = buildTagEditor(note.tags, tags => void save({ tags }));
  tagField.append(Object.assign(document.createElement('span'), { className: 'lbl', textContent: 'タグ' }), tagEditor);

  const scoreField = document.createElement('div'); scoreField.className = 'field';
  const starsBox = document.createElement('div'); starsBox.className = 'stars';
  function drawStars() {
    starsBox.textContent = '';
    for (let i = 1; i <= 5; i += 1) {
      const s = document.createElement('button'); s.type = 'button'; s.className = `star${i <= note.score ? ' on' : ''}`; s.textContent = '★';
      s.title = i === note.score ? 'クリックで得点を外す' : `★${i}`;
      s.onclick = () => { note.score = note.score === i ? 0 : i; drawStars(); void save({ score: note.score }); };
      starsBox.append(s);
    }
  }
  drawStars();
  scoreField.append(Object.assign(document.createElement('span'), { className: 'lbl', textContent: '得点' }), starsBox);

  bar.append(nameField, tagField, scoreField);
}

document.querySelectorAll('[data-view]').forEach(x => { x.onclick = () => setView(x.dataset.view); });
$('to-feed').onclick = () => setView('feed'); back.onclick = () => site.command('back'); forward.onclick = () => site.command('forward');
$('address-form').onsubmit = event => { event.preventDefault(); site.command('navigate', $('address').value.trim()); };
$('google-search-form').onsubmit = event => { event.preventDefault(); void runGoogleSearch(); };
$('google-mode-browse').onclick = () => setGoogleMode('browse');
$('google-mode-cards').onclick = () => setGoogleMode('cards');
// CAPTCHA を解いた後などに、現在のページから続きを取り込む（累積は保つ）。
$('google-import-more').onclick = () => {
  $('google-import-more').hidden = true;
  setGoogleImporting(true);
  $('google-search-status').textContent = googleImportingText();
  void google.importAll();
};
$('google-clear').onclick = async () => {
  await google.clear().catch(() => {});
  clearGoogleResults();
  setGoogleImporting(false);
  $('google-import-more').hidden = true;
  $('google-search-status').textContent = 'クリアしました。';
};
google.onCards(batch => { if (Array.isArray(batch)) void appendGoogleCards(batch); });
google.onEnrich(value => { if (value && Number.isInteger(value.id)) void enrichGoogleCard(value); });
google.onStatus(status => {
  const state = status?.state; const total = Number(status?.total) || 0; const pages = Number(status?.pages) || 0;
  const el = $('google-search-status');
  if (state === 'importing') {
    googleLastPages = pages; setGoogleImporting(true);
    el.textContent = googleImportingText(pages);
    return;
  }
  setGoogleImporting(false); // done・limit・captcha・notready・error はここで止める
  if (state === 'done') el.textContent = total ? `${total} 件を取り込みました。` : '該当する動画はありません。';
  else if (state === 'limit') el.textContent = `上限（${pages} ページ）まで取り込みました（${total} 件）。`;
  else if (state === 'captcha') {
    el.textContent = '確認画面が出たので止めました。「探す」画面で解いてから「続きを取り込む」を押してください。';
    $('google-import-more').hidden = false; setGoogleMode('browse');
  } else if (state === 'notready') {
    el.textContent = '検索結果ページが表示されていません。もう一度「Googleで探す」をお試しください。';
  } else if (state === 'error') {
    el.textContent = 'Google の結果を読み取れませんでした。';
  }
});
async function refresh(auto = false) {
  $('refresh-feed').disabled = true; $('feed-progress').textContent = '取得中…';
  try {
    const r = await feed.refresh({ ...opts(), auto });
    // 自動更新で未ログイン・実行済みのときは何も出さない（ログインしていなければ自動更新しない）。
    if (auto && (r.skipped || r.loggedIn === false)) { $('feed-progress').textContent = ''; return; }
    $('feed-progress').textContent = r.message || (r.ok ? '更新完了' : '取得を停止しました'); await draw();
  } catch { $('feed-progress').textContent = '取得できませんでした'; } finally { $('refresh-feed').disabled = false; }
}
$('refresh-feed').onclick = () => void refresh();
$('viewable-only').onchange = e => { state.viewableOnly = e.target.checked; state.page = 1; void draw(); };
$('include-subscriptions').onchange = e => { state.includeSubscriptions = e.target.checked; state.selectedUser = null; state.page = 1; void draw(); };
$('person-search').oninput = e => { state.search = e.target.value.trim().toLowerCase(); void people(); };
site.onState(x => {
  if (x.url) $('address').value = x.url; back.disabled = !x.canGoBack; forward.disabled = !x.canGoForward;
  $('download-current').disabled = !/^https?:\/\/(www\.)?tokyomotion\.net\/video\/\d+(\/|$|\?|#)/i.test(x.url || '');
  const id = extractVideoId(x.url);
  if (id !== metaCurrentId) { metaCurrentId = id; void renderSiteMetabar(id); }
});
$('download-current').onclick = () => void addDownload(download.current());
$('download-dir').onclick = async () => { const dir = await download.chooseDir().catch(() => null); if (dir) $('download-dir').title = `保存先: ${dir}`; };
download.dir().then(dir => { $('download-dir').title = `保存先: ${dir}`; }).catch(() => {});
feed.onProgress(progress => {
  const done = Number(progress?.done); const total = Number(progress?.total);
  if (Number.isInteger(done) && done >= 0 && Number.isInteger(total) && total >= 0) $('feed-progress').textContent = `取得中 ${done}/${total}`;
});
feed.onSiteTags(value => { if (value && Number.isInteger(value.id)) updateTags(value.id, value.tags); });
feed.onPersonProgress(progress => {
  if (progress?.requestId !== state.requestId || progress?.user !== state.selectedUser || Number(progress?.page) !== state.page) return;
  const loaded = Number(progress?.loaded); const needed = Number(progress?.needed);
  if (Number.isInteger(loaded) && loaded >= 0 && Number.isInteger(needed) && needed >= 0) $('feed-progress').textContent = `追加取得中 ${Math.min(loaded, needed)}/${needed}`;
});
new ResizeObserver(bounds).observe($('site-area')); bounds();
new ResizeObserver(() => { if (!$('search').hidden && googleMode === 'browse') sendGoogleBounds(); }).observe($('google-area'));
// 起動時（DESIGN 4.4）: 保存済みのフィードがあれば先にフィード画面で表示し、裏で 1 回だけ自動更新する。
(async () => {
  const saved = await feed.get(opts()).catch(() => null);
  if (saved?.total > 0) setView('feed');
  await refresh(true);
})();
