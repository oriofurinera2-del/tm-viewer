'use strict';
const site = window.tmViewer.site;
const feed = window.tmViewer.feed;
const notes = window.tmViewer.notes;
const download = window.tmViewer.download;
const credentials = window.tmViewer.credentials;
const $ = id => document.getElementById(id);
const state = { selectedUser: null, page: 1, viewableOnly: true, includeSubscriptions: true, search: '', requestId: 0 };
const back = $('back');
const forward = $('forward');

function opts() { return { includeSubscriptions: state.includeSubscriptions, viewableOnly: state.viewableOnly, selectedUser: state.selectedUser, page: state.page }; }
function isCurrent(requestId) { return requestId === state.requestId; }
function setView(name) {
  const show = name === 'site';
  $('feed').hidden = name !== 'feed'; $('organized').hidden = name !== 'organized'; $('site').hidden = !show; $('downloads').hidden = name !== 'downloads'; $('settings').hidden = name !== 'settings';
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  site.command(show ? 'show' : 'hide');
  if (show) bounds();
  else if (name === 'feed') void draw(true);
  else if (name === 'organized') void drawOrganized();
  else if (name === 'downloads') renderDownloadsTab();
  else if (name === 'settings') void drawCredentials();
}
function bounds() { const r = $('site-area').getBoundingClientRect(); site.setBounds({ width: r.width, height: r.height }); }
function pager(id, current, pages, onGo) {
  const go = onGo || (page => { state.page = page; void draw(); });
  const box = $(id); box.textContent = ''; if (pages < 2) return;
  [['前へ', current - 1], ...Array.from({ length: pages }, (_, i) => [String(i + 1), i + 1]), ['次へ', current + 1]].forEach(([label, page]) => {
    const b = document.createElement('button'); b.textContent = label; b.disabled = page < 1 || page > pages || page === current;
    b.onclick = () => go(page); box.append(b);
  });
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

function videoCard(video) {
  const note = { name: video.note?.name || '', tags: Array.isArray(video.note?.tags) ? [...video.note.tags] : [], score: Number.isInteger(video.note?.score) ? video.note.score : 0 };
  const wrap = document.createElement('div'); wrap.className = 'card-wrap';
  const b = document.createElement('div'); b.className = `video-card${video.watched ? ' watched' : ''}`; b.tabIndex = 0; b.setAttribute('role', 'button');
  const image = document.createElement('img'); image.alt = ''; image.src = video.thumb || '';
  attachThumbRotation(b, image, video);

  const titleBox = document.createElement('div');
  const info = document.createElement('span'); info.className = 'card-user';
  const nameSpan = document.createElement('span'); nameSpan.className = 'card-user-name'; nameSpan.textContent = `${video.user} ・ ${video.duration || ''}`;
  const posted = document.createElement('span'); posted.className = 'card-posted'; posted.textContent = postedLabel(video); posted.title = video.ago || '';
  info.append(avatar(video.user, video.avatar), nameSpan, posted);
  const badges = document.createElement('small'); badges.textContent = [video.isNew && '新着', video.watched && '視聴済み', video.hd && '高画質', video.private && '非公開'].filter(Boolean).join(' '); badges.title = video.ago || '';
  const starsBox = document.createElement('div'); starsBox.className = 'stars';
  const customTagsBox = document.createElement('div'); customTagsBox.className = 'custom-tags';
  const siteTagsBox = document.createElement('small'); siteTagsBox.className = 'site-tags'; siteTagsBox.dataset.id = String(video.id); showTags(siteTagsBox, video.siteTags);
  // タグ未取得の動画は、カーソルを乗せたときにその 1 本だけ取る（DESIGN 4.2）。
  if (!Number.isFinite(video.siteTagsAt)) b.addEventListener('mouseenter', () => void loadTags(video.id), { once: true });

  // 名前があれば元のタイトルより大きく、元のタイトルは小さく併記する（4.8）。
  function renderTitle() {
    titleBox.textContent = '';
    if (note.name) {
      const big = document.createElement('strong'); big.className = 'custom-title'; big.textContent = note.name;
      const orig = document.createElement('span'); orig.className = 'orig-title'; orig.textContent = video.title || '無題の動画';
      titleBox.append(big, orig);
    } else {
      const strong = document.createElement('strong'); strong.textContent = video.title || '無題の動画';
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

  b.append(image, titleBox, info, badges, starsBox, customTagsBox, siteTagsBox);
  const openCard = async () => { await feed.watch(video.id, true); await site.command('navigate', `https://www.tokyomotion.net/video/${video.id}`); setView('site'); };
  b.onclick = () => void openCard();
  b.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openCard(); } };

  // ダウンロード（DESIGN 4.9）・編集（✎、4.8）。カードの中に入れず、上に重ねる。
  const saveBtn = document.createElement('button'); saveBtn.type = 'button'; saveBtn.className = 'card-download'; saveBtn.textContent = '保存'; saveBtn.title = 'この動画をダウンロード';
  saveBtn.onclick = event => { event.stopPropagation(); void addDownload(download.add(video.id)); };
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
  $('credentials-id').value = '';
  $('credentials-password').value = '';
  $('credentials-status').textContent = '';
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
// 起動時（DESIGN 4.4）: 保存済みのフィードがあれば先にフィード画面で表示し、裏で 1 回だけ自動更新する。
(async () => {
  const saved = await feed.get(opts()).catch(() => null);
  if (saved?.total > 0) setView('feed');
  await refresh(true);
})();
