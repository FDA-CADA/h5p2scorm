'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { convert, collectInputs } = require('../h5p2scorm');

function createWindow() {
  const win = new BrowserWindow({
    width: 640, height: 640, minWidth: 520, minHeight: 520,
    title: 'H5P → SCORM', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'], filters: [{ name: 'H5P', extensions: ['h5p'] }]
  });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('open-folder', (_e, dir) => shell.openPath(dir));

ipcMain.handle('convert', (e, { inputs, scorm, mastery }) => {
  const files = collectInputs(inputs);
  if (!files.length) return { error: 'Không tìm thấy file .h5p nào.' };
  const first = inputs[0];
  const baseDir = fs.statSync(first).isDirectory() ? first : path.dirname(first);
  const out = path.join(baseDir, 'scorm-out');
  fs.mkdirSync(out, { recursive: true });
  const opt = {
    out, scorm, mastery: mastery === null ? null : Number(mastery), completeOnOpen: false,
    scorePolicy: 'best', resume: true, maxWidth: '1100px', title: null, debug: false
  };
  const results = [];
  files.forEach((f, i) => {
    e.sender.send('progress', { index: i + 1, total: files.length, name: path.basename(f) });
    try {
      const r = convert(f, opt);
      results.push({ name: path.basename(f), ok: true, missing: r.missing });
    } catch (err) {
      results.push({ name: path.basename(f), ok: false, error: err.message });
    }
  });
  return { out, results };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
