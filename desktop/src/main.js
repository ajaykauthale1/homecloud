const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { HomeCloudServer } = require('./sync-server');

const workspaceRoot = 'D:\\workspaces\\homecloud';
const electronProfileDir = path.join(workspaceRoot, '.homecloud-data', 'electron-profile');
if (!fs.existsSync(electronProfileDir)) {
  fs.mkdirSync(electronProfileDir, { recursive: true });
}
app.setPath('userData', electronProfileDir);
app.setAppUserModelId('com.homecloud.desktop');

let mainWindow = null;
let tray = null;
let server = null;
let isQuitting = false;

function createTrayIcon() {
  const pngPath = path.join(__dirname, 'icon.png');
  let icon;
  if (fs.existsSync(pngPath)) {
    icon = nativeImage.createFromPath(pngPath);
  } else {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;
    icon = nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    );
  }
  tray = new Tray(icon);
  tray.setToolTip('HomeCloud Desktop — Wi-Fi Auto-Sync Active');

  const updateTrayMenu = () => {
    const ip = server ? server.getPrimaryIP() : '127.0.0.1';
    const port = server ? server.port : 4820;
    const contextMenu = Menu.buildFromTemplate([
      { label: `HomeCloud Running (${ip}:${port})`, enabled: false },
      { type: 'separator' },
      {
        label: 'Open HomeCloud Gallery',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: 'Open Photos Folder in Explorer',
        click: () => {
          if (server) shell.openPath(server.config.storageDir);
        }
      },
      { type: 'separator' },
      {
        label: 'Quit HomeCloud',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(contextMenu);
  };

  updateTrayMenu();
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  const startHidden = process.argv.includes('--hidden');
  const pngPath = path.join(__dirname, 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    show: !startHidden,
    icon: fs.existsSync(pngPath) ? pngPath : undefined,
    title: 'HomeCloud — Wi-Fi Photo & Video Sync',
    backgroundColor: '#0b0f19',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function sendEventToRenderer(type, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-event', { type, data });
  }
}

const http = require('http');

function checkExistingInstanceAndShow() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4820,
        path: '/api/show-window',
        method: 'POST',
        timeout: 800
      },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

app.whenReady().then(async () => {
  const alreadyRunning = await checkExistingInstanceAndShow();
  if (alreadyRunning) {
    isQuitting = true;
    app.quit();
    return;
  }
  server = new HomeCloudServer({ port: 4820, udpPort: 4821 });
  await server.start();

  server.on('show-window', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  server.on('media-uploaded', async (item) => {
    const info = await server.getConnectionInfo();
    sendEventToRenderer('media-uploaded', { item, info });
  });

  server.on('device-paired', async (device) => {
    const info = await server.getConnectionInfo();
    sendEventToRenderer('device-paired', { device, info });
  });

  server.on('device-heartbeat', async (device) => {
    const info = await server.getConnectionInfo();
    sendEventToRenderer('device-heartbeat', { device, info });
  });

  server.on('sync-progress', (progress) => {
    sendEventToRenderer('sync-progress', progress);
  });

  ipcMain.handle('get-server-info', async () => {
    return await server.getConnectionInfo();
  });

  ipcMain.handle('get-media', async (_event, params = {}) => {
    const { filter = 'all', search = '' } = params;
    let items = server.mediaIndex.items;
    if (filter === 'photos') items = items.filter((i) => i.mediaType === 'photo');
    else if (filter === 'videos') items = items.filter((i) => i.mediaType === 'video');
    else if (filter === 'favorites') items = items.filter((i) => i.favorite);

    if (search) {
      const q = String(search).toLowerCase();
      items = items.filter(
        (i) =>
          i.filename.toLowerCase().includes(q) ||
          (i.yearMonth && i.yearMonth.includes(q)) ||
          (i.deviceName && i.deviceName.toLowerCase().includes(q))
      );
    }

    return {
      items,
      stats: server.getStats(),
      serverUrl: `http://${server.getPrimaryIP()}:${server.port}`
    };
  });

  ipcMain.handle('choose-storage-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose HomeCloud Photo Backup Folder',
      defaultPath: server.config.storageDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      server.setStorageDirectory(result.filePaths[0]);
      return await server.getConnectionInfo();
    }
    return null;
  });

  ipcMain.handle('set-storage-folder-path', async (_event, customPath) => {
    if (customPath && String(customPath).trim()) {
      server.setStorageDirectory(String(customPath).trim());
      return await server.getConnectionInfo();
    }
    return null;
  });

  ipcMain.handle('set-protect-from-phone-delete', async (_event, enabled) => {
    server.config.protectFromPhoneDelete = Boolean(enabled);
    server.saveConfig();
    return await server.getConnectionInfo();
  });

  ipcMain.handle('open-storage-folder', async () => {
    await shell.openPath(server.config.storageDir);
    return true;
  });

  ipcMain.handle('reveal-media-in-folder', async (_event, relativePath) => {
    const fullPath = path.join(server.config.storageDir, relativePath);
    shell.showItemInFolder(fullPath);
    return true;
  });

  ipcMain.handle('toggle-favorite', async (_event, id) => {
    const item = server.mediaIndex.items.find((i) => i.id === id);
    if (item) {
      item.favorite = !item.favorite;
      server.saveMediaIndex();
      return item;
    }
    return null;
  });

  ipcMain.handle('set-organize-by-date', async (_event, enabled) => {
    server.config.organizeByDate = Boolean(enabled);
    server.saveConfig();
    return await server.getConnectionInfo();
  });

  ipcMain.handle('set-organize-by-device', async (_event, enabled) => {
    server.config.organizeByDevice = Boolean(enabled);
    server.saveConfig();
    return await server.getConnectionInfo();
  });

  ipcMain.handle('rescan-folder', async () => {
    server.scanStorageDirectory();
    return await server.getConnectionInfo();
  });

  createTrayIcon();
  createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (server) {
    server.stop();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
