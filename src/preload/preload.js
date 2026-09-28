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
    watch: (id, watched) => ipcRenderer.invoke('feed:watch', id, watched),
    mute: (user, muted) => ipcRenderer.invoke('feed:mute', user, muted)
  },
  notes: {
    context: id => ipcRenderer.invoke('notes:context', id),
    set: (id, patch, meta) => ipcRenderer.invoke('notes:set', id, patch, meta),
    tags: () => ipcRenderer.invoke('notes:tags'),
    organized: options => ipcRenderer.invoke('notes:organized', options),
    exportData: () => ipcRenderer.invoke('notes:export'),
    importData: () => ipcRenderer.invoke('notes:import')
  },
  download: {
    add: id => ipcRenderer.invoke('download:add', id),
    current: () => ipcRenderer.invoke('download:current'),
    cancel: id => ipcRenderer.invoke('download:cancel', id),
    retry: id => ipcRenderer.invoke('download:retry', id),
    list: () => ipcRenderer.invoke('download:list'),
    showInFolder: id => ipcRenderer.invoke('download:show', id),
    dir: () => ipcRenderer.invoke('download:dir'),
    chooseDir: () => ipcRenderer.invoke('download:choose-dir'),
    onStatus: callback => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('download:status', listener);
      return () => ipcRenderer.removeListener('download:status', listener);
    }
  }
});
