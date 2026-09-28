'use strict';
const site = window.tmViewer.site;
const feed = window.tmViewer.feed;
const notes = window.tmViewer.notes;
const download = window.tmViewer.download;
const $ = id => document.getElementById(id);
const state = { selectedUser: null, page: 1, viewableOnly: true, includeSubscriptions: true, search: '', requestId: 0 };
const back = $('back');
const forward = $('forward');

function opts() { return { includeSubscriptions: state.includeSubscriptions, viewableOnly: state.viewableOnly, selectedUser: state.selectedUser, page: state.page }; }
function isCurrent(requestId) { return requestId === state.requestId; }
function setView(name) {
  const show = name === 'site';
  $('feed').hidden = name !== 'feed'; $('organized').hidden = name !== 'organized'; $('site').hidden = !show; $('downloads').hidden = name !== 'downloads';
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  site.command(show ? 'show' : 'hide');
  if (show) bounds();
  else if (name === 'feed') void draw(true);
  else if (name === 'organized') void drawOrganized();
  else if (name === 'downloads') renderDownloadsTab();
}
function bounds() { const r = $('site-area').getBoundingClientRect(); site.setBounds({ width: r.width, height: r.height }); }
function pager(id, current, pages) {
  const box = $(id); box.textContent = ''; if (pages < 2) return;
  [['前へ', current - 1], ...Array.from({ length: pages }, (_, i) => [String(i + 1), i + 1]), ['次へ', current + 1]].forEach(([label, page]) => {
    const b = document.createElement('button'); b.textContent = label; b.disabled = page < 1 || page > pages || page === current;
    b.onclick = () => { state.page = page; void draw(); }; box.append(b);
  });
}
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
function videoCard(video) {
  const b = document.createElement('button'); b.className = `video-card${video.watched ? ' watched' : ''}`;
  const image = document.createElement('img'); image.alt = ''; image.src = video.thumb || '';
  attachThumbRotation(b, image, video);
  const title = document.createElement('strong'); title.textContent = video.title || '無題の動画';
  const info = document.createElement('span'); info.className = 'card-user';
  const name = document.createElement('span'); name.className = 'card-user-name'; name.textContent = `${video.user} ・ ${video.duration || ''}`;
  const posted = document.createElement('span'); posted.className = 'card-posted'; posted.textContent = postedLabel(video); posted.title = video.ago || '';
  info.append(avatar(video.user, video.avatar), name, posted);
  const badges = document.createElement('small'); badges.textContent = [video.isNew && '新着', video.watched && '視聴済み', video.hd && '高画質', video.private && '非公開'].filter(Boolean).join(' '); badges.title = video.ago || '';
  const tags = document.createElement('small'); tags.className = 'site-tags'; tags.dataset.id = String(video.id); showTags(tags, video.siteTags);
  // タグ未取得の動画は、カーソルを乗せたときにその 1 本だけ取る（DESIGN 4.2）。
  if (!Number.isFinite(video.siteTagsAt)) b.addEventListener('mouseenter', () => void loadTags(video.id), { once: true });
  b.append(image, title, info, badges, tags); b.onclick = async () => { await feed.watch(video.id, true); await site.command('navigate', `https://www.tokyomotion.net/video/${video.id}`); setView('site'); };
  // ダウンロード（DESIGN 4.9）。カードのボタンの中に入れず、上に重ねる。
  const wrap = document.createElement('div'); wrap.className = 'card-wrap';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'card-download'; save.textContent = '保存'; save.title = 'この動画をダウンロード';
  save.onclick = () => void addDownload(download.add(video.id));
  wrap.append(b, save);
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
  const active = [...downloads.values()].filter(x => x.state === 'downloading').length;
  button.textContent = active > 0 ? `ダウンロード (${active})` : 'ダウンロード';
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
