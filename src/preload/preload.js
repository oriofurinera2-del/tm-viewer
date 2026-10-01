'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tmViewer', {
  site: {
    command: (command, value) => ipcRenderer.invoke('site:command', command, value),
    setBounds: bounds => ipcRenderer.send('site:bounds', bounds),
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('site:state', listener);
      return () => ipcRenderer.removeListener('site:state', listener);
    },
    // main からのショートカット通知（サイト表示に focus があるとき）: 'find' / 'focus-address'。
    onShortcut: callback => {
      const listener = (_event, name) => callback(name);
      ipcRenderer.on('site:shortcut', listener);
      return () => ipcRenderer.removeListener('site:shortcut', listener);
    }
  },
  // サイト表示のタブ（マルチタブ）。
  tabs: {
    new: url => ipcRenderer.invoke('tabs:new', url),
    close: id => ipcRenderer.invoke('tabs:close', id),
    select: id => ipcRenderer.invoke('tabs:select', id),
    list: () => ipcRenderer.invoke('tabs:list'),
    onChanged: callback => {
      const listener = (_event, tabs) => callback(tabs);
      ipcRenderer.on('tabs:changed', listener);
      return () => ipcRenderer.removeListener('tabs:changed', listener);
    }
  },
  // ページ内検索（Ctrl+F）。アクティブなタブに対して行う。
  find: {
    start: (text, options) => ipcRenderer.invoke('find:start', text, options),
    stop: () => ipcRenderer.invoke('find:stop'),
    onResult: callback => {
      const listener = (_event, result) => callback(result);
      ipcRenderer.on('find:result', listener);
      return () => ipcRenderer.removeListener('find:result', listener);
    }
  },
  google: {
    // 検索語を検索タブ内蔵の googleView に開く（DESIGN 4.10、案A）。累積はリセットされる。
    show: term => ipcRenderer.invoke('google:show', term),
    // 現在の googleView ページから自動ページ送りで取り込む（新規・CAPTCHA 後の再開に共用）。
    importAll: () => ipcRenderer.invoke('google:import'),
    // 累積（seen・裏取得）をクリアする。カードは renderer 側で消す。
    clear: () => ipcRenderer.invoke('google:clear'),
    // googleView の表示/非表示と、検索タブ「探す」領域への配置。
    command: command => ipcRenderer.invoke('google:command', command),
    setBounds: bounds => ipcRenderer.send('google:bounds', bounds),
    // 解決できた動画カードの追記（累積）。
    onCards: callback => {
      const listener = (_event, batch) => callback(batch);
      ipcRenderer.on('google:cards', listener);
      return () => ipcRenderer.removeListener('google:cards', listener);
    },
    // 取り込みの進捗・停止（CAPTCHA など）の状態。
    onStatus: callback => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('google:status', listener);
      return () => ipcRenderer.removeListener('google:status', listener);
    },
    // サムネ・投稿者・サイトタグの後入れ。
    onEnrich: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('google:enrich', listener);
      return () => ipcRenderer.removeListener('google:enrich', listener);
    }
  },
  feed: {
    refresh: options => ipcRenderer.invoke('feed:refresh', options),
    onProgress: callback => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('feed:progress', listener);
      return () => ipcRenderer.removeListener('feed:progress', listener);
    },
    open: options => ipcRenderer.invoke('feed:open', options),
    get: options => ipcRenderer.invoke('feed:get', options),
    people: options => ipcRenderer.invoke('feed:people', options),
    personPage: options => ipcRenderer.invoke('feed:person-page', options),
    onPersonProgress: callback => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('feed:person-progress', listener);
      return () => ipcRenderer.removeListener('feed:person-progress', listener);
    },
    tags: id => ipcRenderer.invoke('feed:tags', id),
    onSiteTags: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('feed:site-tags', listener);
      return () => ipcRenderer.removeListener('feed:site-tags', listener);
    },
    watch: (id, watched, meta) => ipcRenderer.invoke('feed:watch', id, watched, meta),
    mute: (user, muted) => ipcRenderer.invoke('feed:mute', user, muted)
  },
  // 見た動画の履歴（DESIGN 4.11）。端末内だけに保存する。
  history: {
    list: options => ipcRenderer.invoke('history:list', options),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  notes: {
    context: id => ipcRenderer.invoke('notes:context', id),
    set: (id, patch, meta) => ipcRenderer.invoke('notes:set', id, patch, meta),
    tags: () => ipcRenderer.invoke('notes:tags'),
    organized: options => ipcRenderer.invoke('notes:organized', options),
    exportData: () => ipcRenderer.invoke('notes:export'),
    importData: () => ipcRenderer.invoke('notes:import')
  },
  credentials: {
    // 値（ID・パスワード）を読み出す操作は無い。main で暗号化・復号し、渡すのは状態と成否だけ。
    status: () => ipcRenderer.invoke('credentials:status'),
    save: (id, password) => ipcRenderer.invoke('credentials:save', id, password),
    clear: () => ipcRenderer.invoke('credentials:clear'),
    onAutoLoginFailed: callback => {
      const listener = () => callback();
      ipcRenderer.on('credentials:auto-login-failed', listener);
      return () => ipcRenderer.removeListener('credentials:auto-login-failed', listener);
    }
  },
  update: {
    // 更新のダウンロード完了通知を購読する（バナー表示に使う）。
    onReady: callback => {
      const listener = (_event, info) => callback(info);
      ipcRenderer.on('update:ready', listener);
      return () => ipcRenderer.removeListener('update:ready', listener);
    },
    // 「再起動して更新」。quitAndInstall を呼ぶ。
    install: () => ipcRenderer.invoke('update:install')
  },
  download: {
    add: (id, meta) => ipcRenderer.invoke('download:add', id, meta),
    current: () => ipcRenderer.invoke('download:current'),
    cancel: id => ipcRenderer.invoke('download:cancel', id),
    retry: id => ipcRenderer.invoke('download:retry', id),
    list: () => ipcRenderer.invoke('download:list'),
    showInFolder: id => ipcRenderer.invoke('download:show', id),
    dir: () => ipcRenderer.invoke('download:dir'),
    chooseDir: () => ipcRenderer.invoke('download:choose-dir'),
    // 同時ダウンロード数（DESIGN 4.9・1〜5）。取得と、設定変更での即時反映。
    concurrency: () => ipcRenderer.invoke('download:concurrency'),
    setConcurrency: value => ipcRenderer.invoke('download:set-concurrency', value),
    onStatus: callback => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('download:status', listener);
      return () => ipcRenderer.removeListener('download:status', listener);
    }
  }
});
