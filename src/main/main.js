'use strict';

const path = require('node:path');
const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const { configureSession, enableVideoTagDebug, isSiteUrl } = require('./session');
const { createFetcher } = require('./fetcher');
const { createStore } = require('./store');
const { parseMe, parseUserList, parseVideoList, parseVideoTags } = require('./parser');
const { createFeedService } = require('./feed');

const START_URL = 'https://www.tokyomotion.net/';
const SITE_PARTITION = 'persist:tm';
const DEBUG_HOSTS = !app.isPackaged && process.argv.includes('--debug-hosts');
// renderer の上部タブ (40px) とサイト操作バー (48px) の下に配置する。
const SITE_VIEW_TOP = 88;

let mainWindow;
let siteView;
let siteAttached = false;
let siteSession;
let feedService;
// 起動時の自動更新は 1 回だけ（DESIGN 4.4）。renderer の読み直しでは繰り返さない。
let autoRefreshStarted = false;

function createFeedServices() {
  siteSession = session.fromPartition(SITE_PARTITION);
  configureSession(siteSession, path.join(__dirname, '../../data/allowlist.json'), {
    debugHosts: DEBUG_HOSTS
  });
  const store = createStore(app.getPath('userData'));
  const fetcher = createFetcher({
    // persist:tm の Cookie を、サイト表示と同じ session から送る。
    // 呼び出し元の options に認証情報は受け取らず、必ずこの指定を使う。
    request: (url, options) => siteSession.fetch(url, {
      ...(options && typeof options === 'object' ? options : {}),
      credentials: 'include'
    }),
    parseVideoList,
    store
  });
  feedService = createFeedService({ fetcher, store, parseUserList, parseVideoList, parseVideoTags });
  return fetcher;
}

let feedFetcher;

function sendSiteState() {
  if (!mainWindow || mainWindow.isDestroyed() || !siteView) return;
  const contents = siteView.webContents;
  mainWindow.webContents.send('site:state', {
    url: contents.getURL(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward()
  });
}

function resizeSiteView(bounds) {
  if (!mainWindow || !siteView || !siteAttached) return;
  const width = Math.max(0, Math.floor(Number(bounds?.width) || 0));
  const height = Math.max(0, Math.floor(Number(bounds?.height) || 0));
  siteView.setBounds({ x: 0, y: SITE_VIEW_TOP, width, height });
}

function showSiteView() {
  if (!mainWindow || !siteView) return;
  if (!siteAttached) {
    mainWindow.contentView.addChildView(siteView);
    siteAttached = true;
  }
  const [width, height] = mainWindow.getContentSize();
  resizeSiteView({ width, height: height - SITE_VIEW_TOP });
  sendSiteState();
}

function hideSiteView() {
  if (!mainWindow || !siteView || !siteAttached) return;
  mainWindow.contentView.removeChildView(siteView);
  siteAttached = false;
}

function createSiteView() {
  siteView = new WebContentsView({
    webPreferences: {
      session: siteSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  siteView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  siteView.webContents.on('will-navigate', (event, url) => {
    if (!isSiteUrl(url)) event.preventDefault();
  });
  siteView.webContents.on('will-redirect', (event, url) => {
    if (!isSiteUrl(url)) event.preventDefault();
  });
  siteView.webContents.on('did-navigate', sendSiteState);
  siteView.webContents.on('did-navigate-in-page', sendSiteState);
  if (DEBUG_HOSTS) enableVideoTagDebug(siteView.webContents);
  siteView.webContents.loadURL(START_URL);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = undefined;
    siteAttached = false;
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  createSiteView();
  showSiteView();
}

ipcMain.handle('site:command', (_event, command, value) => {
  if (!siteView) return false;
  if (command === 'back' && siteView.webContents.navigationHistory.canGoBack()) {
    siteView.webContents.navigationHistory.goBack();
  }
  if (command === 'forward' && siteView.webContents.navigationHistory.canGoForward()) {
    siteView.webContents.navigationHistory.goForward();
  }
  if (command === 'navigate' && typeof value === 'string' && isSiteUrl(value)) {
    siteView.webContents.loadURL(value);
  }
  if (command === 'show') showSiteView();
  if (command === 'hide') hideSiteView();
  return true;
});

ipcMain.handle('feed:refresh', async (_event, options) => {
  if (options?.auto === true) {
    if (autoRefreshStarted) return { ok: false, skipped: true };
    autoRefreshStarted = true;
  }
  const response = await feedFetcher.fetch(START_URL);
  const me = parseMe(response.body);
  if (!me) return { ok: false, loggedIn: false, message: 'サイトにログインしてから更新してください。' };
  const result = await feedService.refresh({
    me,
    includeSubscriptions: options?.includeSubscriptions !== false,
    onProgress: ({ done, total }) => _event.sender.send('feed:progress', { done, total })
  });
  if (!result.stopped) {
    // NEW の動画のタグを裏で順に取る（DESIGN 4.2）。更新の応答は待たせない。
    const sender = _event.sender;
    feedService.fetchNewSiteTags({
      onTags: tags => { if (!sender.isDestroyed()) sender.send('feed:site-tags', tags); }
    }).catch(() => {});
  }
  return { ok: !result.stopped, ...result };
});

ipcMain.handle('feed:tags', async (_event, id) => {
  try {
    return { ok: true, tags: await feedService.fetchSiteTags(id) };
  } catch (error) {
    return { ok: false, stopped: error?.name === 'FetchStoppedError' };
  }
});

ipcMain.handle('feed:open', (_event, options) => feedService.openFeed(options));
ipcMain.handle('feed:get', (_event, options) => feedService.getFeed(options));
ipcMain.handle('feed:people', (_event, options) => feedService.getPeople(options));
ipcMain.handle('feed:person-page', (event, options) => feedService.getPersonPage({
  ...options,
  onProgress: progress => event.sender.send('feed:person-progress', {
    ...progress,
    user: options?.user,
    page: options?.page,
    requestId: options?.requestId
  })
}));
ipcMain.handle('feed:watch', (_event, id, watched) => {
  feedService.markWatched(id, watched !== false);
  return true;
});
ipcMain.handle('feed:mute', (_event, user, muted) => {
  feedService.setMuted(user, muted);
  return true;
});

ipcMain.on('site:bounds', (_event, bounds) => resizeSiteView(bounds));

app.whenReady().then(() => {
  feedFetcher = createFeedServices();
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
