'use strict';

if (process.versions.electron) {
  const assert = require('node:assert/strict');
  const { app, WebContentsView } = require('electron');

  app.whenReady().then(async () => {
    const view = new WebContentsView();
    const debuggerApi = view.webContents.debugger;

    assert.equal(typeof debuggerApi.attach, 'function');
    assert.equal(typeof debuggerApi.sendCommand, 'function');
    debuggerApi.attach('1.3');
    assert.equal(debuggerApi.isAttached(), true);
    const enabled = debuggerApi.sendCommand('Network.enable');
    const loaded = view.webContents.loadURL('data:text/html,debugger-api-check');
    await Promise.all([enabled, loaded]);
    debuggerApi.detach();
    console.log('Electron debugger API check passed');
    app.quit();
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
    app.quit();
  });
}
