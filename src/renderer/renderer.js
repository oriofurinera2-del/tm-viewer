'use strict';
const site = window.tmViewer.site;
const feed = window.tmViewer.feed;
const $ = id => document.getElementById(id);
const state = { selectedUser: null, page: 1, viewableOnly: true, includeSubscriptions: true, search: '' };
const back = $('back');
const forward = $('forward');
function opts() { return { ...state }; }
function setView(name) {
  const show = name === 'site'; $('feed').hidden = show; $('site').hidden = !show;
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  site.command(show ? 'show' : 'hide'); if (show) bounds(); else draw(true);
}
function bounds() { const r = $('site-area').getBoundingClientRect(); site.setBounds({ width: r.width, height: r.height }); }
function pager(id, current, pages) {
  const box = $(id); box.textContent = ''; if (pages < 2) return;
  [['前へ', current - 1], ...Array.from({ length: pages }, (_, i) => [String(i + 1), i + 1]), ['次へ', current + 1]].forEach(([label, page]) => {
    const b = document.createElement('button'); b.textContent = label; b.disabled = page < 1 || page > pages || page === current;
    b.onclick = () => { state.page = page; draw(); }; box.append(b);
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
async function people() {
  const values = await feed.people(opts()); const box = $('people'); box.textContent = '';
  const add = (label, user, unread, muted) => { const row = document.createElement('div'); const pick = document.createElement('button'); pick.textContent = `${label} (${unread})`; pick.onclick = () => { state.selectedUser = user; state.page = 1; draw(); }; row.append(pick); if (user) { const mute = document.createElement('button'); mute.textContent = muted ? '表示する' : '非表示'; mute.onclick = async () => { await feed.mute(user, !muted); draw(); }; row.append(mute); } box.append(row); };
  const list = values.filter(x => !state.search || x.user.toLowerCase().includes(state.search));
  add('すべて', null, list.filter(x => !x.muted).reduce((n, x) => n + x.unread, 0));
  list.forEach(x => add(x.user + (x.kind === 'subscription' ? '（購読）' : ''), x.user, x.unread, x.muted));
}
async function draw(opened = false) {
  const result = state.selectedUser
    ? await feed.personPage({ user: state.selectedUser, page: state.page, viewableOnly: state.viewableOnly })
    : (opened ? await feed.open(opts()) : await feed.get(opts())); state.page = result.page; $('feed-title').textContent = state.selectedUser || 'すべて';
  const grid = $('feed-grid'); grid.textContent = ''; if (!result.videos.length) grid.textContent = '表示する動画がありません。サイトにログインしてから更新してください。'; result.videos.forEach(x => grid.append(videoCard(x)));
  pager('feed-pager-top', result.page, result.pages); pager('feed-pager-bottom', result.page, result.pages); await people();
}
document.querySelectorAll('[data-view]').forEach(x => x.onclick = () => setView(x.dataset.view));
$('to-feed').onclick = () => setView('feed'); back.onclick = () => site.command('back'); forward.onclick = () => site.command('forward');
$('address-form').onsubmit = event => { event.preventDefault(); site.command('navigate', $('address').value.trim()); };
$('refresh-feed').onclick = async () => { $('refresh-feed').disabled = true; $('feed-progress').textContent = '取得中…'; try { const r = await feed.refresh(opts()); $('feed-progress').textContent = r.message || (r.ok ? '更新完了' : '取得を停止しました'); await draw(); } catch { $('feed-progress').textContent = '取得できませんでした'; } finally { $('refresh-feed').disabled = false; } };
$('viewable-only').onchange = e => { state.viewableOnly = e.target.checked; state.page = 1; draw(); };
$('include-subscriptions').onchange = e => { state.includeSubscriptions = e.target.checked; state.selectedUser = null; state.page = 1; draw(); };
$('person-search').oninput = e => { state.search = e.target.value.trim().toLowerCase(); people(); };
site.onState(x => { if (x.url) $('address').value = x.url; back.disabled = !x.canGoBack; forward.disabled = !x.canGoForward; });
new ResizeObserver(bounds).observe($('site-area')); bounds();
