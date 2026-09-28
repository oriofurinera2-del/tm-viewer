'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, session } = require('electron');
const { configureSession, enableVideoTagDebug, isSiteUrl } = require('./session');
const { createFetcher } = require('./fetcher');
const { createStore } = require('./store');
const { parseMe, parseUserList, parseVideoList, parseVideoTags } = require('./parser');
const { createFeedService } = require('./feed');
const {
  READ_PLAYER_SOURCES_SCRIPT,
  buildFileName,
  createDownloadQueue,
  extensionFor,
  pickVideoUrl,
  uniqueFilePath,
  videoIdFromUrl,
  videoPageUrl
} = require('./download');

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
let appStore;
let downloadQueue;
// 起動時の自動更新は 1 回だけ（DESIGN 4.4）。renderer の読み直しでは繰り返さない。
let autoRefreshStarted = false;

function createFeedServices() {
  siteSession = session.fromPartition(SITE_PARTITION);
  configureSession(siteSession, path.join(__dirname, '../../data/allowlist.json'), {
    debugHosts: DEBUG_HOSTS
  });
  const store = createStore(app.getPath('userData'));
  appStore = store;
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

// ウィンドウ上部のメニューを日本語の最小メニューに置き換える（5 章、2026-09-29）。
function buildAppMenu() {
  const template = [
    { label: 'ファイル', submenu: [{ role: 'quit', label: '終了' }] },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' },
        { role: 'redo', label: 'やり直し' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' }
      ]
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { type: 'separator' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { role: 'resetZoom', label: '実寸' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全画面' },
        ...(!app.isPackaged ? [{ type: 'separator' }, { role: 'toggleDevTools', label: '開発者ツール' }] : [])
      ]
    },
    {
      label: 'ウィンドウ',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '閉じる' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

// ---- ダウンロード（DESIGN 4.9） ----

const PAGE_LOAD_TIMEOUT_MS = 30_000;
const PLAYER_WAIT_MS = 15_000;
const PLAYER_POLL_MS = 500;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function downloadDir() {
  const value = appStore?.loadSettings()?.downloadDir;
  return typeof value === 'string' && value && fs.existsSync(value) ? value : app.getPath('downloads');
}

function sendDownloadStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download:status', status);
}

// サイト表示で動画ページを開き、読み込みが終わるまで待つ。
function openVideoPage(id) {
  const contents = siteView.webContents;
  if (videoIdFromUrl(contents.getURL()) === id && !contents.isLoading()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', onLoad);
      contents.removeListener('did-fail-load', onFail);
    };
    const onLoad = () => { cleanup(); resolve(); };
    const onFail = (_event, code, _description, _url, isMainFrame) => {
      // -3 は別の移動で置き換えられたとき。最終的な読み込み完了を待つ。
      if (!isMainFrame || code === -3) return;
      cleanup();
      reject(new Error('動画ページを開けませんでした'));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('動画ページの読み込みが終わりませんでした')); }, PAGE_LOAD_TIMEOUT_MS);
    contents.on('did-finish-load', onLoad);
    contents.on('did-fail-load', onFail);
    contents.loadURL(videoPageUrl(id)).catch(() => {});
  });
}

// プレイヤーの <video>／<source> が実際に使う URL を読む。推測の URL は作らない。
async function resolveVideoUrl(job) {
  if (!siteView) throw new Error('サイト表示がありません');
  await openVideoPage(job.id);
  const contents = siteView.webContents;
  const until = Date.now() + PLAYER_WAIT_MS;
  while (Date.now() < until) {
    if (videoIdFromUrl(contents.getURL()) !== job.id) throw new Error('動画ページから移動したため中止しました');
    const candidates = await contents.executeJavaScript(READ_PLAYER_SOURCES_SCRIPT, false).catch(() => []);
    const found = pickVideoUrl(candidates);
    if (found) return found;
    await delay(PLAYER_POLL_MS);
  }
  throw new Error('動画の URL を取得できませんでした（再生できない動画の可能性があります）');
}

// ログイン済みのセッション（persist:tm）のまま保存する。
function saveVideo(job, found, onProgress) {
  const ses = siteView.webContents.session;
  const normalize = value => { try { return new URL(value).href; } catch { return String(value); } };
  return new Promise((resolve, reject) => {
    // 保存が始まらないまま待ち続けないようにする。
    const timer = setTimeout(() => {
      ses.removeListener('will-download', onWillDownload);
      reject(new Error('保存を始められませんでした'));
    }, PAGE_LOAD_TIMEOUT_MS);
    const onWillDownload = (_event, item) => {
      const chain = item.getURLChain();
      if (normalize(chain[0]) !== normalize(found.url)) return;
      clearTimeout(timer);
      ses.removeListener('will-download', onWillDownload);
      const fileName = buildFileName({
        name: job.name,
        title: job.title,
        id: job.id,
        ext: extensionFor({ filename: item.getFilename(), mimeType: item.getMimeType(), url: chain[chain.length - 1] })
      });
      const savePath = uniqueFilePath(downloadDir(), fileName, fs.existsSync);
      item.setSavePath(savePath);
      item.on('updated', () => {
        const total = item.getTotalBytes();
        onProgress(total > 0 ? (item.getReceivedBytes() / total) * 100 : null);
      });
      item.once('done', (_doneEvent, state) => {
        if (state === 'completed') resolve({ fileName: path.basename(savePath) });
        else reject(new Error(state === 'cancelled' ? '保存を取り消しました' : '保存に失敗しました'));
      });
    };
    ses.on('will-download', onWillDownload);
    try {
      ses.downloadURL(found.url, { headers: { Referer: videoPageUrl(job.id) } });
    } catch {
      clearTimeout(timer);
      ses.removeListener('will-download', onWillDownload);
      reject(new Error('保存を始められませんでした'));
    }
  });
}

// ファイル名に使う独自の名前（DESIGN 4.8）と元のタイトル。
function videoNames(id, pageTitle) {
  const note = appStore?.loadNotes()?.[id];
  const saved = feedService?.findVideo(id);
  const title = saved?.title
    || (typeof note?.title === 'string' ? note.title : '')
    || String(pageTitle || '').replace(/\s*[-|]\s*TOKYO\s*Motion\s*$/i, '');
  return { name: typeof note?.name === 'string' ? note.name : '', title };
}

function addDownload(id) {
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, message: '動画IDが正しくありません' };
  const pageTitle = siteView && videoIdFromUrl(siteView.webContents.getURL()) === id ? siteView.webContents.getTitle() : '';
  const { name, title } = videoNames(id, pageTitle);
  const added = downloadQueue.add({ id, name, title });
  return { ok: added, message: added ? null : 'すでに保存待ちです' };
}

downloadQueue = createDownloadQueue({ resolveUrl: resolveVideoUrl, save: saveVideo, onUpdate: sendDownloadStatus });

ipcMain.handle('download:add', (_event, id) => addDownload(Number(id)));
ipcMain.handle('download:current', () => {
  const id = siteView ? videoIdFromUrl(siteView.webContents.getURL()) : null;
  return id ? addDownload(id) : { ok: false, message: '動画ページを開いてください' };
});
ipcMain.handle('download:dir', () => downloadDir());
ipcMain.handle('download:choose-dir', async () => {
  if (!mainWindow) return downloadDir();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'ダウンロードの保存先',
    defaultPath: downloadDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (!result.canceled && result.filePaths[0]) {
    appStore.saveSettings({ ...appStore.loadSettings(), downloadDir: result.filePaths[0] });
  }
  return downloadDir();
});

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
  buildAppMenu();
  feedFetcher = createFeedServices();
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
