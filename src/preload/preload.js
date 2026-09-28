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
    open: options => ipcRenderer.invoke('feed:open', options),
    get: options => ipcRenderer.invoke('feed:get', options),
    people: options => ipcRenderer.invoke('feed:people', options),
    personPage: options => ipcRenderer.invoke('feed:person-page', options),
    watch: (id, watched) => ipcRenderer.invoke('feed:watch', id, watched),
    mute: (user, muted) => ipcRenderer.invoke('feed:mute', user, muted)
  }
});
