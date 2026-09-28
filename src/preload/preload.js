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
  }
});
