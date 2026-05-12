const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile: (data, filename) => ipcRenderer.invoke('save-file', data, filename),
  openFile: () => ipcRenderer.invoke('open-file'),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  whatsappGetStatus: () => ipcRenderer.invoke('whatsapp:get-status'),
  whatsappConnect: () => ipcRenderer.invoke('whatsapp:connect'),
  whatsappDisconnect: () => ipcRenderer.invoke('whatsapp:disconnect'),
  whatsappSendBill: (payload) => ipcRenderer.invoke('whatsapp:send-bill', payload),
  billGeneratePdf: (payload) => ipcRenderer.invoke('bill:generate-pdf', payload),
  gmailSendBill: (payload) => ipcRenderer.invoke('gmail:send-bill', payload),
  onWhatsAppStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('whatsapp:status', handler);
    return () => ipcRenderer.removeListener('whatsapp:status', handler);
  }
});
