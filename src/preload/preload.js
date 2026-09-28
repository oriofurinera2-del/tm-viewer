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
  }
});
