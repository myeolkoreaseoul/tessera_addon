const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const server = require('../server/index');

let mainWindow;
const PORT = 14000;

app.on('ready', async () => {
  await server.start(PORT);

  mainWindow = new BrowserWindow({
    width: 900,
    height: 750,
    title: 'Kiwi — 이지바로 집행내역 다운로드',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.setMenuBarVisibility(false);
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '저장 폴더 선택',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-folder', async (_, dir) => {
  if (dir) shell.openPath(dir);
});

app.on('window-all-closed', () => {
  app.quit();
});
