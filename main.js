const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

let mainWindow;
let waSocket;
let waInitPromise = null;
let baileysModulePromise = null;
let reconnectTimer = null;
let disconnectRequested = false;
const WA_RECONNECT_DELAY_MS = 1500;
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

function logWAInfo(message) {
  console.log(`[WhatsApp] ${message}`);
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
    reconnectTimer = null;
    if (disconnectRequested) return;
    startWhatsApp().catch((err) => {
      logWAError('Reconnect failed', err);
      updateWAStatus({ connecting: false, error: 'Reconnect failed. Please try connecting again.' });
    });
  }, WA_RECONNECT_DELAY_MS);
}

function parseDisconnectCode(lastDisconnect) {
  if (!lastDisconnect || !lastDisconnect.error) return undefined;
  return lastDisconnect.error?.output?.statusCode || lastDisconnect.error?.statusCode;
}

function getSafeBillFileName(input = '') {
  const trimmed = String(input || '').trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe || `bill_${Date.now()}`}.pdf`;
}

function decodeBase64Pdf(pdfBase64) {
  const normalized = String(pdfBase64 || '').replace(/^data:application\/pdf;base64,/, '').trim();
  if (!normalized) return null;
  return Buffer.from(normalized, 'base64');
}

async function generateBillPdfBuffer(documentHTML) {
  if (!documentHTML || typeof documentHTML !== 'string') {
    throw new Error('Invalid bill document for PDF generation.');
  }

  const pdfWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      javascript: false
    }
  });

  try {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(documentHTML)}`;
    await pdfWindow.loadURL(dataUrl);
    return await pdfWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      marginsType: 1,
      preferCSSPageSize: true
    });
  } finally {
    if (!pdfWindow.isDestroyed()) {
      pdfWindow.destroy();
    }
  }
}

async function startWhatsApp() {
  if (waInitPromise) return waInitPromise;
  disconnectRequested = false;
  waInitPromise = (async () => {
    updateWAStatus({ connecting: true, error: '', qr: '', connected: false, phone: '' });
    try {
      const { makeWASocket, DisconnectReason, useMultiFileAuthState } = await loadBaileys();
      const { state, saveCreds } = await useMultiFileAuthState(authDir());
      if (disconnectRequested) {
        throw new Error('WhatsApp connection cancelled.');
      }
      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Chaturthi Surgicals', 'Desktop', '1.0.0']
      });
      waSocket = socket;

      socket.ev.on('creds.update', async () => {
        try {
          const saveResult = saveCreds();
          if (saveResult && typeof saveResult.then === 'function') {
            await saveResult;
          }
        } catch (err) {
          logWAError('Failed to persist WhatsApp session', err);
          updateWAStatus({ error: 'Session save failed. You may need to rescan QR after restart.' });
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
            if (loggedOut) {
              logWAInfo(`Connection closed (code: ${code ?? 'unknown'}) after logout`);
            } else {
              logWAError(`Connection closed (code: ${code ?? 'unknown'})`, lastDisconnect?.error);
            }
            updateWAStatus({
              connected: false,
              connecting: !loggedOut,
              qr: '',
              phone: '',
              error: loggedOut ? 'Logged out. Please reconnect by scanning QR again.' : ''
            });
            waSocket = undefined;
            waInitPromise = null;
            if (!loggedOut && !disconnectRequested) {
              scheduleReconnect();
            }
          }
        } catch (err) {
          logWAError('Error processing WhatsApp connection update', err);
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
    throw new Error(`Unable to connect WhatsApp right now. ${err.message || 'Please try again.'}`);
  }
});

ipcMain.handle('whatsapp:disconnect', async () => {
  disconnectRequested = true;
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
    throw new Error('Send payload must be an object with phone and pdfBase64 fields.');
  }
  const phone = String(payload.phone || '').replace(/\D/g, '');
  const pdfBuffer = decodeBase64Pdf(payload.pdfBase64);
  const fileName = getSafeBillFileName(payload.fileName);
  const caption = String(payload.caption || '').trim();
  if (!waStatus.connected || !waSocket) {
    throw new Error('WhatsApp is not connected. Please connect first.');
  }
  if (!phone || phone.length < 10) {
    throw new Error('Invalid customer phone number.');
  }
  if (!pdfBuffer || !pdfBuffer.length) {
    throw new Error('Bill PDF is empty.');
  }
  const jid = `${phone}@s.whatsapp.net`;
  try {
    await waSocket.sendMessage(jid, {
      document: pdfBuffer,
      mimetype: 'application/pdf',
      fileName,
      ...(caption ? { caption } : {})
    });
    return { ok: true };
  } catch (err) {
    logWAError('PDF send failed', err);
    throw new Error('Failed to send bill PDF on WhatsApp. Please retry.');
  }
});

ipcMain.handle('bill:generate-pdf', async (_event, payload = {}) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be an object.');
  }
  const documentHTML = String(payload.documentHTML || '');
  const fileName = getSafeBillFileName(payload.fileName || payload.billNo || 'bill');
  const pdfBuffer = await generateBillPdfBuffer(documentHTML);
  return {
    ok: true,
    pdfBase64: pdfBuffer.toString('base64'),
    fileName
  };
});

ipcMain.handle('gmail:send-bill', async (_event, payload = {}) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be an object.');
  }

  const senderEmail = String(payload.senderEmail || '').trim();
  const appPassword = String(payload.appPassword || '').trim();
  const recipientEmail = String(payload.recipientEmail || '').trim();
  const subject = String(payload.subject || 'Bill from Chaturthi Surgicals').trim();
  const text = String(payload.text || 'Please find your bill attached.').trim();
  const fileName = getSafeBillFileName(payload.fileName || 'bill');
  const pdfBuffer = decodeBase64Pdf(payload.pdfBase64);

  if (!senderEmail || !appPassword || !recipientEmail) {
    throw new Error('Gmail sender, app password, and customer email are required.');
  }
  if (!pdfBuffer || !pdfBuffer.length) {
    throw new Error('Bill PDF is empty.');
  }

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: senderEmail,
        pass: appPassword
      }
    });

    try {
      await transporter.verify();
    } catch (err) {
      throw new Error('Gmail authentication failed. Check sender email and app password.');
    }

    await transporter.sendMail({
      from: senderEmail,
      to: recipientEmail,
      subject,
      text,
      attachments: [
        {
          filename: fileName,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    });

    return { ok: true };
  } catch (err) {
    console.error('[Gmail] Failed to send bill', err);
    if (String(err.message || '').includes('authentication failed')) {
      throw err;
    }
    throw new Error('Failed to send bill via Gmail. Check sender credentials and internet.');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
