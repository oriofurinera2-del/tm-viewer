'use strict';

const site = window.tmViewer.site;
const siteSection = document.getElementById('site');
const siteArea = document.getElementById('site-area');
const address = document.getElementById('address');
const back = document.getElementById('back');
const forward = document.getElementById('forward');

function setView(name) {
  const showSite = name === 'site';
  document.getElementById('feed').hidden = showSite;
  siteSection.hidden = !showSite;
  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === name);
  }
  site.command(showSite ? 'show' : 'hide');
  if (showSite) updateBounds();
}

function updateBounds() {
  const rect = siteArea.getBoundingClientRect();
  site.setBounds({ width: rect.width, height: rect.height });
}

document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => setView(button.dataset.view));
});
document.getElementById('open-site').addEventListener('click', () => setView('site'));
document.getElementById('to-feed').addEventListener('click', () => setView('feed'));
back.addEventListener('click', () => site.command('back'));
forward.addEventListener('click', () => site.command('forward'));
document.getElementById('address-form').addEventListener('submit', event => {
  event.preventDefault();
  site.command('navigate', address.value.trim());
});
site.onState(state => {
  if (state.url) address.value = state.url;
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
});
new ResizeObserver(updateBounds).observe(siteArea);
updateBounds();
