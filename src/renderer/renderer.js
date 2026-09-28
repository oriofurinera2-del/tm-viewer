'use strict';
const site = window.tmViewer.site;
const feed = window.tmViewer.feed;
const $ = id => document.getElementById(id);
const state = { selectedUser: null, page: 1, viewableOnly: true, includeSubscriptions: true, search: '', requestId: 0 };
const back = $('back');
const forward = $('forward');

function opts() { return { includeSubscriptions: state.includeSubscriptions, viewableOnly: state.viewableOnly, selectedUser: state.selectedUser, page: state.page }; }
function isCurrent(requestId) { return requestId === state.requestId; }
function setView(name) {
  const show = name === 'site'; $('feed').hidden = show; $('site').hidden = !show;
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  site.command(show ? 'show' : 'hide'); if (show) bounds(); else void draw(true);
}
function bounds() { const r = $('site-area').getBoundingClientRect(); site.setBounds({ width: r.width, height: r.height }); }
function pager(id, current, pages) {
  const box = $(id); box.textContent = ''; if (pages < 2) return;
  [['前へ', current - 1], ...Array.from({ length: pages }, (_, i) => [String(i + 1), i + 1]), ['次へ', current + 1]].forEach(([label, page]) => {
    const b = document.createElement('button'); b.textContent = label; b.disabled = page < 1 || page > pages || page === current;
    b.onclick = () => { state.page = page; void draw(); }; box.append(b);
  });
}
function videoCard(video) {
  const b = document.createElement('button'); b.className = `video-card${video.watched ? ' watched' : ''}`;
  const image = document.createElement('img'); image.alt = ''; image.src = video.thumb || '';
  const title = document.createElement('strong'); title.textContent = video.title || '無題の動画';
  const info = document.createElement('span'); info.textContent = `${video.user} ・ ${video.duration || ''}`;
  const badges = document.createElement('small'); badges.textContent = [video.isNew && '新着', video.watched && '視聴済み', video.hd && '高画質', video.private && '非公開'].filter(Boolean).join(' '); badges.title = video.ago || '';
  const tags = document.createElement('small'); tags.textContent = Array.isArray(video.siteTags) ? video.siteTags.join(' ・ ') : '';
  b.append(image, title, info, badges, tags); b.onclick = async () => { await feed.watch(video.id, true); await site.command('navigate', `https://www.tokyomotion.net/video/${video.id}`); setView('site'); };
  return b;
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
  const add = (label, user, unread, muted) => {
    const row = document.createElement('div'); const pick = document.createElement('button');
    pick.className = 'person-pick'; pick.dataset.user = user || ''; pick.textContent = `${label} (${unread})`;
    pick.onclick = () => { state.selectedUser = user; state.page = 1; syncSelectedPeople(); void draw(); };
    row.append(pick);
    if (user) { const mute = document.createElement('button'); mute.textContent = muted ? '表示する' : '非表示'; mute.onclick = async () => { await feed.mute(user, !muted); void draw(); }; row.append(mute); }
    box.append(row);
  };
  const list = values.filter(x => !state.search || x.user.toLowerCase().includes(state.search));
  add('すべて', null, list.filter(x => !x.muted).reduce((n, x) => n + x.unread, 0));
  list.forEach(x => add(x.user + (x.kind === 'subscription' ? '（購読）' : ''), x.user, x.unread, x.muted));
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
$('refresh-feed').onclick = async () => { $('refresh-feed').disabled = true; $('feed-progress').textContent = '取得中…'; try { const r = await feed.refresh(opts()); $('feed-progress').textContent = r.message || (r.ok ? '更新完了' : '取得を停止しました'); await draw(); } catch { $('feed-progress').textContent = '取得できませんでした'; } finally { $('refresh-feed').disabled = false; } };
$('viewable-only').onchange = e => { state.viewableOnly = e.target.checked; state.page = 1; void draw(); };
$('include-subscriptions').onchange = e => { state.includeSubscriptions = e.target.checked; state.selectedUser = null; state.page = 1; void draw(); };
$('person-search').oninput = e => { state.search = e.target.value.trim().toLowerCase(); void people(); };
site.onState(x => { if (x.url) $('address').value = x.url; back.disabled = !x.canGoBack; forward.disabled = !x.canGoForward; });
feed.onProgress(progress => {
  const done = Number(progress?.done); const total = Number(progress?.total);
  if (Number.isInteger(done) && done >= 0 && Number.isInteger(total) && total >= 0) $('feed-progress').textContent = `取得中 ${done}/${total}`;
});
feed.onPersonProgress(progress => {
  if (progress?.requestId !== state.requestId || progress?.user !== state.selectedUser || Number(progress?.page) !== state.page) return;
  const loaded = Number(progress?.loaded); const needed = Number(progress?.needed);
  if (Number.isInteger(loaded) && loaded >= 0 && Number.isInteger(needed) && needed >= 0) $('feed-progress').textContent = `追加取得中 ${Math.min(loaded, needed)}/${needed}`;
});
new ResizeObserver(bounds).observe($('site-area')); bounds();
