const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

let mainWindow;
let waSocket;
let waInitPromise = null;
let baileysModulePromise = null;
let reconnectTimer = null;
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

function logWAError(context, error) {
  console.error(`[WhatsApp] ${context}`, error);
}

async function loadBaileys() {
  if (!baileysModulePromise) {
    baileysModulePromise = import('@whiskeysockets/baileys').then((module) => {
      const makeWASocket = module.default || module.makeWASocket;
      const { DisconnectReason, useMultiFileAuthState } = module;
      if (!makeWASocket || !DisconnectReason || !useMultiFileAuthState) {
        throw new Error('Baileys module did not provide required exports.');
      }
      return { makeWASocket, DisconnectReason, useMultiFileAuthState };
    }).catch((err) => {
      baileysModulePromise = null;
      throw err;
    });
  }
  return baileysModulePromise;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    startWhatsApp().catch((err) => {
      logWAError('Reconnect failed', err);
      updateWAStatus({ connecting: false, error: 'Reconnect failed. Please try connecting again.' });
    });
  }, 1500);
}

function parseDisconnectCode(lastDisconnect) {
  if (!lastDisconnect || !lastDisconnect.error) return undefined;
  return lastDisconnect.error?.output?.statusCode || lastDisconnect.error?.statusCode;
}

async function startWhatsApp() {
  if (waInitPromise) return waInitPromise;
  waInitPromise = (async () => {
    updateWAStatus({ connecting: true, error: '', qr: '', connected: false, phone: '' });
    try {
      const { makeWASocket, DisconnectReason, useMultiFileAuthState } = await loadBaileys();
      const { state, saveCreds } = await useMultiFileAuthState(authDir());
      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Chaturthi Surgicals', 'Desktop', '1.0.0']
      });
      waSocket = socket;

      socket.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (err) {
          logWAError('Failed to persist WhatsApp session. User may need to re-authenticate next startup.', err);
        }
      });
      socket.ev.on('connection.update', async (update) => {
        try {
          const { connection, qr, lastDisconnect } = update;
          if (qr) {
            try {
              const qrDataUrl = await QRCode.toDataURL(qr);
              updateWAStatus({ qr: qrDataUrl, connecting: true, connected: false, error: '' });
            } catch (err) {
              logWAError('QR generation failed', err);
              updateWAStatus({ error: 'QR generation failed. Please retry WhatsApp connect.' });
            }
          }

          if (connection === 'open') {
            clearReconnectTimer();
            const rawId = socket.user?.id || '';
            const phone = rawId.split(':')[0].replace(/\D/g, '');
            updateWAStatus({ connected: true, connecting: false, qr: '', phone, error: '' });
          }

          if (connection === 'close') {
            const code = parseDisconnectCode(lastDisconnect);
            const loggedOut = code === DisconnectReason.loggedOut;
            if (!loggedOut) {
              logWAError(`Connection closed (code: ${code ?? 'unknown'})`, lastDisconnect?.error);
            }
            updateWAStatus({
              connected: false,
              connecting: !loggedOut,
              qr: '',
              phone: '',
              error: loggedOut ? 'Logged out. Please reconnect by scanning QR again.' : 'Connection lost. Attempting to reconnect...'
            });
            waSocket = undefined;
            waInitPromise = null;
            if (!loggedOut) {
              scheduleReconnect();
            }
          }
        } catch (err) {
          logWAError('Unhandled connection update error', err);
          updateWAStatus({ error: 'WhatsApp connection update failed. Please reconnect.' });
        }
      });
    } catch (err) {
      waSocket = undefined;
      waInitPromise = null;
      logWAError('Initialization failed', err);
      updateWAStatus({
        connected: false,
        connecting: false,
        qr: '',
        phone: '',
        error: 'WhatsApp initialization failed. Please try connecting again.'
      });
      throw err;
    }
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
  try {
    await startWhatsApp();
    return waStatus;
  } catch (err) {
    logWAError('Connect request failed', err);
    throw new Error('Unable to connect WhatsApp right now. Please try again.');
  }
});

ipcMain.handle('whatsapp:disconnect', async () => {
  clearReconnectTimer();
  if (waSocket) {
    try {
      await waSocket.logout();
    } catch (err) {
      logWAError('Logout warning', err);
    }
    try {
      waSocket.end(new Error('User initiated disconnect'));
    } catch (err) {
      logWAError('Socket end warning', err);
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
  try {
    await waSocket.sendMessage(jid, { text: message });
    return { ok: true };
  } catch (err) {
    logWAError('Message send failed', err);
    throw new Error('Failed to send WhatsApp message. Please retry.');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
