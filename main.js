const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');

let mainWindow;
let waSocket;
let waInitPromise = null;
const waStatus = {
  connected: false,
  connecting: false,
  qr: '',
  phone: '',
  provider: 'baileys',
  enabled: true,
  error: ''
};

function authDir() {
  return path.join(app.getPath('userData'), 'wa-auth-state');
}

function emitWAStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('whatsapp:status', waStatus);
}

function updateWAStatus(nextState) {
  Object.assign(waStatus, nextState);
  emitWAStatus();
}

function parseDisconnectCode(lastDisconnect) {
  if (!lastDisconnect || !lastDisconnect.error) return undefined;
  return lastDisconnect.error?.output?.statusCode || lastDisconnect.error?.statusCode;
}

async function startWhatsApp() {
  if (waInitPromise) return waInitPromise;
  waInitPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(authDir());
    updateWAStatus({ connecting: true, error: '', qr: '', connected: false, phone: '' });
    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['Chaturthi Surgicals', 'Desktop', '1.0.0']
    });
    waSocket = socket;

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr);
          updateWAStatus({ qr: qrDataUrl, connecting: true, connected: false, error: '' });
        } catch (err) {
          updateWAStatus({ error: `QR generation failed: ${err.message || 'unknown error'}` });
        }
      }

      if (connection === 'open') {
        const rawId = socket.user?.id || '';
        const phone = rawId.split(':')[0].replace(/\D/g, '');
        updateWAStatus({ connected: true, connecting: false, qr: '', phone, error: '' });
      }

      if (connection === 'close') {
        const code = parseDisconnectCode(lastDisconnect);
        const loggedOut = code === DisconnectReason.loggedOut;
        updateWAStatus({
          connected: false,
          connecting: !loggedOut,
          qr: '',
          phone: '',
          error: loggedOut ? 'Logged out. Please reconnect by scanning QR again.' : ''
        });
        waSocket = undefined;
        waInitPromise = null;
        if (!loggedOut) {
          setTimeout(() => {
            startWhatsApp().catch((err) => {
              updateWAStatus({ connecting: false, error: `Reconnect failed: ${err.message || 'unknown error'}` });
            });
          }, 1500);
        }
      }
    });
  })();
  return waInitPromise;
}

async function clearAuthState() {
  try {
    fs.rmSync(authDir(), { recursive: true, force: true });
  } catch (err) {
    updateWAStatus({ error: `Auth cleanup warning: ${err.message || 'unknown error'}` });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 640,
    title: 'Chaturthi Surgicals — Business Management',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    frame: true,
    backgroundColor: '#0a0e1a',
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Custom menu
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Export Purchases (CSV)', click: () => mainWindow.webContents.executeJavaScript("exportTableCSV('purchases')") },
        { label: 'Export Sales (CSV)', click: () => mainWindow.webContents.executeJavaScript("exportTableCSV('sales')") },
        { label: 'Export Full Report', click: () => mainWindow.webContents.executeJavaScript("downloadExcel('all')") },
        { type: 'separator' },
        { label: 'Backup Data', click: () => mainWindow.webContents.executeJavaScript("backupData()") },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: 'Transaction',
      submenu: [
        { label: 'New Purchase', accelerator: 'CmdOrCtrl+B', click: () => mainWindow.webContents.executeJavaScript("openModal('buy')") },
        { label: 'New Sale', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.executeJavaScript("openModal('sell')") },
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Dashboard', click: () => mainWindow.webContents.executeJavaScript("navigate('dashboard')") },
        { label: 'Purchases', click: () => mainWindow.webContents.executeJavaScript("navigate('purchases')") },
        { label: 'Sales', click: () => mainWindow.webContents.executeJavaScript("navigate('sales')") },
        { label: 'Inventory', click: () => mainWindow.webContents.executeJavaScript("navigate('inventory')") },
        { label: 'Reports', click: () => mainWindow.webContents.executeJavaScript("navigate('reports')") },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Chaturthi Surgicals', click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About',
            message: 'Chaturthi Surgicals\nBusiness Management System',
            detail: 'Version 1.0.0\n\nA complete purchase & sale tracking solution\nfor surgical wholesale business.\n\nData is saved locally on your computer.'
          });
        }}
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(createWindow);

ipcMain.handle('whatsapp:get-status', async () => waStatus);

ipcMain.handle('whatsapp:connect', async () => {
  await startWhatsApp();
  return waStatus;
});

ipcMain.handle('whatsapp:disconnect', async () => {
  if (waSocket) {
    try {
      await waSocket.logout();
    } catch (err) {
      // Continue with local cleanup even if remote logout fails
    }
    try {
      waSocket.end(new Error('User initiated disconnect'));
    } catch (err) {
      // Ignore socket end errors
    }
  }
  waSocket = undefined;
  waInitPromise = null;
  await clearAuthState();
  updateWAStatus({ connected: false, connecting: false, qr: '', phone: '', error: '' });
  return waStatus;
});

ipcMain.handle('whatsapp:send-bill', async (_event, payload = {}) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Send payload must be an object with phone and message fields.');
  }
  const phone = String(payload.phone || '').replace(/\D/g, '');
  const message = String(payload.message || '');
  if (!waStatus.connected || !waSocket) {
    throw new Error('WhatsApp is not connected. Please connect first.');
  }
  if (!phone || phone.length < 10) {
    throw new Error('Invalid customer phone number.');
  }
  if (!message.trim()) {
    throw new Error('Bill message is empty.');
  }
  const jid = `${phone}@s.whatsapp.net`;
  await waSocket.sendMessage(jid, { text: message });
  return { ok: true };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
