'use strict';

const path = require('node:path');
const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const { configureSession, enableVideoTagDebug, isSiteUrl } = require('./session');

const START_URL = 'https://www.tokyomotion.net/';
const SITE_PARTITION = 'persist:tm';
const DEBUG_HOSTS = !app.isPackaged && process.argv.includes('--debug-hosts');
// renderer の上部タブ (40px) とサイト操作バー (48px) の下に配置する。
const SITE_VIEW_TOP = 88;

let mainWindow;
let siteView;
let siteAttached = false;

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
  const siteSession = session.fromPartition(SITE_PARTITION);
  configureSession(siteSession, path.join(__dirname, '../../data/blocklist.json'), {
    debugHosts: DEBUG_HOSTS
  });

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

ipcMain.on('site:bounds', (_event, bounds) => resizeSiteView(bounds));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
