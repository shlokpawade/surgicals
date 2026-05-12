const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
