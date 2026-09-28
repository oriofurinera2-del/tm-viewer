'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, session, shell, safeStorage } = require('electron');
const { configureSession, enableVideoTagDebug, isSiteUrl } = require('./session');
const { createFetcher } = require('./fetcher');
const { createStore } = require('./store');
const { parseMe, parseUserList, parseVideoList, parseVideoTags } = require('./parser');
const { createFeedService } = require('./feed');
const notes = require('./notes');
const credentials = require('./credentials');
const {
  CanceledError,
  READ_PLAYER_SOURCES_SCRIPT,
  buildFileName,
  createDownloadQueue,
  extensionFor,
  httpErrorMessage,
  isVideoContentType,
  pickVideoUrl,
  uniqueFilePath,
  videoIdFromUrl,
  videoPageUrl
} = require('./download');

const START_URL = 'https://www.tokyomotion.net/';
const LOGIN_URL = 'https://www.tokyomotion.net/login';
const SITE_PARTITION = 'persist:tm';
const DEBUG_HOSTS = !app.isPackaged && process.argv.includes('--debug-hosts');
// renderer の上部タブ (40px) とサイト操作バー (48px) の下に配置する。
const SITE_VIEW_TOP = 88;

let mainWindow;
let siteView;
let downloadView;
let siteAttached = false;
let siteSession;
let feedService;
let appStore;
let downloadQueue;
// 起動時の自動更新は 1 回だけ（DESIGN 4.4）。renderer の読み直しでは繰り返さない。
let autoRefreshStarted = false;
// 自動ログイン（DESIGN 4.1）: 同時に 2 回動かさない・失敗したら次のログイン成功まで再試行しない。
let autoLoginBusy = false;
let autoLoginBlocked = false;

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
  siteView.webContents.on('did-navigate', () => {
    sendSiteState();
    // ログアウトされてログイン画面になったときの自動ログイン（DESIGN 4.1）。
    if (credentials.isLoginUrl(siteView.webContents.getURL())) void attemptAutoLogin();
  });
  siteView.webContents.on('did-navigate-in-page', sendSiteState);
  if (DEBUG_HOSTS) enableVideoTagDebug(siteView.webContents);
  siteView.webContents.loadURL(START_URL);
}

// ダウンロードの動画 URL 確認専用の裏ページ（DESIGN 4.9）。画面には一切出さない。
// サイト表示と同じセッション・同じ安全設定で、動画ページを開いてプレイヤーの URL を読むだけに使う。
function createDownloadView() {
  downloadView = new WebContentsView({
    webPreferences: {
      session: siteSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  downloadView.webContents.setAudioMuted(true);
  downloadView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  downloadView.webContents.on('will-navigate', (event, url) => {
    if (!isSiteUrl(url)) event.preventDefault();
  });
  downloadView.webContents.on('will-redirect', (event, url) => {
    if (!isSiteUrl(url)) event.preventDefault();
  });
  downloadView.webContents.loadURL('about:blank');
}

// ---- ログイン情報の保存・自動ログイン（DESIGN 4.1） ----

// 読み込み中なら終わるまで待つ（タイムアウトしても例外にはしない。自動ログインの失敗判定は呼び出し側で行う）。
function waitForSiteLoad(contents, timeoutMs = PAGE_LOAD_TIMEOUT_MS) {
  if (!contents.isLoading()) return Promise.resolve();
  return new Promise(resolve => {
    const cleanup = () => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', onDone);
      contents.removeListener('did-fail-load', onFail);
    };
    const onDone = () => { cleanup(); resolve(); };
    const onFail = (_event, code, _description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 は別の移動で置き換えられたとき
      cleanup(); resolve();
    };
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
    contents.on('did-finish-load', onDone);
    contents.on('did-fail-load', onFail);
  });
}

// ログアウトされていたとき、保存したログイン情報でサイトのログイン画面に入力して送信する（DESIGN 4.1）。
// 失敗（送信後もログイン画面のまま）は 1 回で止め、次にログインが成功するまで再試行しない
// （連続失敗でアカウントが制限されるのを防ぐ）。id・password はこの関数のスコープの外に出さない。
async function attemptAutoLogin() {
  if (!siteView || autoLoginBusy || autoLoginBlocked) return false;
  const saved = credentials.load(app.getPath('userData'), safeStorage);
  if (!saved) return false;
  autoLoginBusy = true;
  try {
    const contents = siteView.webContents;
    if (!credentials.isLoginUrl(contents.getURL())) {
      await contents.loadURL(LOGIN_URL).catch(() => {});
    }
    await waitForSiteLoad(contents);
    const submitted = await contents.executeJavaScript(credentials.buildLoginScript(saved.id, saved.password), false).catch(() => false);
    if (!submitted) {
      autoLoginBlocked = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('credentials:auto-login-failed');
      return false;
    }
    await waitForSiteLoad(contents);
    if (credentials.isLoginUrl(contents.getURL())) {
      autoLoginBlocked = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('credentials:auto-login-failed');
      return false;
    }
    autoLoginBlocked = false;
    return true;
  } finally {
    autoLoginBusy = false;
  }
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
  createDownloadView();
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

// 裏ページ（downloadView）で動画ページを開き、読み込みが終わるまで待つ。
function openVideoPage(id) {
  const contents = downloadView.webContents;
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

// プレイヤーの <video>／<source> が実際に使う URL を、画面に出さない裏ページで読む。推測の URL は作らない。
// 「動画ページから移動したため中止」の判定は、この裏ページについてのみ行う（サイト表示は動かさない）。
async function resolveVideoUrlOnHiddenPage(job) {
  if (!downloadView) throw new Error('裏ページがありません');
  await openVideoPage(job.id);
  const contents = downloadView.webContents;
  const until = Date.now() + PLAYER_WAIT_MS;
  while (Date.now() < until) {
    if (job.controller.signal.aborted) throw new CanceledError();
    if (videoIdFromUrl(contents.getURL()) !== job.id) throw new Error('動画ページから移動したため中止しました');
    const candidates = await contents.executeJavaScript(READ_PLAYER_SOURCES_SCRIPT, false).catch(() => []);
    const found = pickVideoUrl(candidates);
    if (found) return found;
    await delay(PLAYER_POLL_MS);
  }
  throw new Error('動画の URL を取得できませんでした（再生できない動画の可能性があります）');
}

// URL の確認が終わったら（成功でも失敗でも）裏ページを about:blank に戻す。
async function resolveVideoUrl(job) {
  try {
    return await resolveVideoUrlOnHiddenPage(job);
  } finally {
    if (downloadView) downloadView.webContents.loadURL('about:blank').catch(() => {});
  }
}

// ログイン済みのセッション（persist:tm）のまま保存する。
// ses.downloadURL は失敗の理由が分からないため、ses.fetch（同じ session の Cookie を使う）で取得し、
// 応答を確認してから自分でファイルに書き込む。
async function saveVideo(job, found, onProgress) {
  const ses = siteSession;
  const signal = job.controller.signal;
  let response;
  try {
    response = await ses.fetch(found.url, { headers: { Referer: videoPageUrl(job.id) }, signal });
  } catch {
    if (signal.aborted) throw new CanceledError();
    throw new Error('保存を始められませんでした');
  }

  const contentType = response.headers.get('content-type');
  if (DEBUG_HOSTS) {
    let host = '';
    try { host = new URL(response.url).hostname; } catch { /* 無視 */ }
    console.log('[download]', response.status, contentType, host);
  }
  if (!response.ok) throw new Error(httpErrorMessage(response.status));
  if (!isVideoContentType(contentType)) {
    const shown = typeof contentType === 'string' ? contentType.split(';')[0].trim() : '';
    throw new Error(`動画ではない応答でした（${shown || '不明'}）`);
  }

  const fileName = buildFileName({
    name: job.name,
    title: job.title,
    id: job.id,
    ext: extensionFor({ mimeType: contentType, url: response.url })
  });
  const savePath = uniqueFilePath(downloadDir(), fileName, fs.existsSync);
  const tmpPath = `${savePath}.part`;
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;

  const fileStream = fs.createWriteStream(tmpPath);
  try {
    const reader = response.body.getReader();
    for (;;) {
      if (signal.aborted) throw new CanceledError();
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      await new Promise((resolve, reject) => {
        fileStream.write(chunk, error => (error ? reject(error) : resolve()));
      });
      onProgress(total > 0 ? (received / total) * 100 : null);
    }
    await new Promise((resolve, reject) => fileStream.end(error => (error ? reject(error) : resolve())));
  } catch (error) {
    fileStream.destroy();
    // 中止のときも .part を消す（DESIGN 4.9）。
    try { fs.unlinkSync(tmpPath); } catch { /* 無視 */ }
    if (error instanceof CanceledError || signal.aborted) throw new CanceledError();
    throw new Error('保存に失敗しました');
  }

  fs.renameSync(tmpPath, savePath);
  return { fileName: path.basename(savePath), filePath: savePath };
}

// 動画ページのタイトル。サイト表示で今その動画を開いているときだけ webContents から読む。
function currentPageTitle(id) {
  return siteView && videoIdFromUrl(siteView.webContents.getURL()) === id ? siteView.webContents.getTitle() : '';
}

// 独自の名前・タグ・得点（DESIGN 4.8）と、無いときの元のタイトル・投稿者・サムネ。
// ダウンロードのファイル名にも、サイト表示の上部バーの入力初期値にも使う。
function noteContext(id, pageTitle = currentPageTitle(id)) {
  const raw = appStore?.loadNotes()?.[id];
  const note = notes.normalizeNoteRecord(raw || {});
  const saved = feedService?.findVideo(id);
  const title = saved?.title
    || note.title
    || String(pageTitle || '').replace(/\s*[-|]\s*TOKYO\s*Motion\s*$/i, '');
  return { name: note.name, tags: note.tags, score: note.score, title, user: saved?.user || note.user, thumb: saved?.thumb || note.thumb };
}

function addDownload(id) {
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, message: '動画IDが正しくありません' };
  const { name, title } = noteContext(id);
  const added = downloadQueue.add({ id, name, title });
  return { ok: added, message: added ? null : 'すでに保存待ちです' };
}

downloadQueue = createDownloadQueue({ resolveUrl: resolveVideoUrl, save: saveVideo, onUpdate: sendDownloadStatus });

ipcMain.handle('download:add', (_event, id) => addDownload(Number(id)));
ipcMain.handle('download:current', () => {
  const id = siteView ? videoIdFromUrl(siteView.webContents.getURL()) : null;
  return id ? addDownload(id) : { ok: false, message: '動画ページを開いてください' };
});
ipcMain.handle('download:cancel', (_event, id) => downloadQueue.cancel(Number(id)));
ipcMain.handle('download:retry', (_event, id) => downloadQueue.retry(Number(id)));
ipcMain.handle('download:list', () => downloadQueue.list());
ipcMain.handle('download:show', (_event, id) => {
  const entry = downloadQueue.list().find(x => x.id === Number(id));
  if (!entry?.filePath) return false;
  shell.showItemInFolder(entry.filePath);
  return true;
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

// ---- ログイン情報の保存（任意・DESIGN 4.1） ----

ipcMain.handle('credentials:status', () => ({
  available: credentials.isAvailable(safeStorage),
  hasSaved: credentials.hasSaved(app.getPath('userData'))
}));

ipcMain.handle('credentials:save', (_event, id, password) => {
  if (!credentials.isAvailable(safeStorage)) return { ok: false, message: 'この環境では使えません' };
  if (typeof id !== 'string' || !id.trim() || typeof password !== 'string' || !password) {
    return { ok: false, message: 'IDとパスワードを入力してください' };
  }
  try {
    credentials.save(app.getPath('userData'), safeStorage, id.trim(), password);
    autoLoginBlocked = false;
    return { ok: true, hasSaved: true };
  } catch {
    // 理由にパスワードは含めない。
    return { ok: false, message: '保存できませんでした' };
  }
});

ipcMain.handle('credentials:clear', () => {
  credentials.clear(app.getPath('userData'));
  autoLoginBlocked = false;
  return { ok: true, hasSaved: false };
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
  let response = await feedFetcher.fetch(START_URL);
  let me = parseMe(response.body);
  if (!me) {
    // 取得でログイン状態が無いとき、保存したログイン情報があれば自動ログインを試みる（DESIGN 4.1）。
    const loggedIn = await attemptAutoLogin();
    if (loggedIn) {
      response = await feedFetcher.fetch(START_URL);
      me = parseMe(response.body);
    }
  }
  if (!me) return { ok: false, loggedIn: false, message: 'サイトにログインしてから更新してください。' };
  autoLoginBlocked = false;
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

// フィードのカードに独自の名前・タグ・得点を付けて返す（DESIGN 4.8）。
function withNotes(result) {
  return { ...result, videos: notes.attachNotes(result.videos, appStore.loadNotes()) };
}
ipcMain.handle('feed:open', (_event, options) => withNotes(feedService.openFeed(options)));
ipcMain.handle('feed:get', (_event, options) => withNotes(feedService.getFeed(options)));
ipcMain.handle('feed:people', (_event, options) => feedService.getPeople(options));
ipcMain.handle('feed:person-page', async (event, options) => withNotes(await feedService.getPersonPage({
  ...options,
  onProgress: progress => event.sender.send('feed:person-progress', {
    ...progress,
    user: options?.user,
    page: options?.page,
    requestId: options?.requestId
  })
})));
ipcMain.handle('feed:watch', (_event, id, watched) => {
  feedService.markWatched(id, watched !== false);
  return true;
});
ipcMain.handle('feed:mute', (_event, user, muted) => {
  feedService.setMuted(user, muted);
  return true;
});

// ---- 独自の名前・タグ・得点（DESIGN 4.8） ----

ipcMain.handle('notes:context', (_event, id) => {
  id = Number(id);
  return Number.isSafeInteger(id) && id > 0 ? noteContext(id) : null;
});

ipcMain.handle('notes:set', (_event, id, patch, meta) => {
  id = Number(id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const all = appStore.loadNotes();
  const normalized = notes.normalizePatch(patch);
  if (notes.isEmptyNote(normalized)) {
    if (all[id]) { delete all[id]; appStore.saveNotes(all); }
    return null;
  }
  const saved = feedService.findVideo(id);
  const fallback = noteContext(id);
  all[id] = {
    ...normalized,
    user: (typeof meta?.user === 'string' && meta.user) || saved?.user || fallback.user,
    title: (typeof meta?.title === 'string' && meta.title) || saved?.title || fallback.title,
    thumb: (typeof meta?.thumb === 'string' && meta.thumb) || saved?.thumb || fallback.thumb,
    updatedAt: Date.now()
  };
  appStore.saveNotes(all);
  return all[id];
});

ipcMain.handle('notes:tags', () => notes.allCustomTags(appStore.loadNotes()));

ipcMain.handle('notes:organized', (_event, options) => notes.organizedList({
  ...options,
  notes: appStore.loadNotes(),
  findVideo: id => feedService.findVideo(id)
}));

ipcMain.handle('notes:export', async () => {
  if (!mainWindow) return { ok: false };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '整理データの書き出し',
    defaultPath: 'tm-viewer-notes.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false };
  try {
    fs.writeFileSync(result.filePath, `${JSON.stringify(appStore.loadNotes(), null, 2)}\n`, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch {
    return { ok: false, message: '書き出しに失敗しました' };
  }
});

ipcMain.handle('notes:import', async () => {
  if (!mainWindow) return { ok: false };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '整理データの読み込み',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false };
  try {
    const incoming = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    const merged = notes.mergeForImport(appStore.loadNotes(), incoming);
    appStore.saveNotes(merged);
    return { ok: true, count: Object.keys(merged).length };
  } catch {
    return { ok: false, message: '読み込みに失敗しました（JSON の形式を確認してください）' };
  }
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
