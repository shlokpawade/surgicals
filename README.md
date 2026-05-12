# Chaturthi Surgicals — Business Management System
## Setup & Installation Guide

---

## 🚀 Quick Start (Open in Browser)

If you just want to run the software **right now** without installing anything:

1. Open the folder `chaturthi-surgicals`
2. Double-click `index.html`
3. Open it in **Chrome** or **Edge** browser
4. The software will run directly — all data is saved in your browser automatically

> ✅ Data is saved locally using browser storage. It will persist across sessions on the same computer.

---

## 💻 Build as Desktop App (.exe) using Electron

### Prerequisites
- Install **Node.js** from https://nodejs.org (version 18 or higher)
- Install **Git** (optional)

### Steps

```bash
# 1. Open this folder in Terminal / Command Prompt

# 2. Install dependencies
npm install

# 3. Run the app (development mode)
npm start

# 4. Build portable .exe (no installation needed)
npm run build

# 5. Build installer .exe (with Start Menu shortcut)
npm run build-installer
```

After building, find your `.exe` file in the `dist/` folder.

---

## 📁 Data Storage

- **Browser version**: Data saved in browser localStorage automatically
- **Electron app**: Data saved in localStorage (persists across restarts)
- **Backup**: Use the Export page → "Backup JSON" to save a backup file
- **Restore**: Use the Export page → "Restore from Backup" to load a backup

---

## 📊 Features

| Feature | Description |
|---------|-------------|
| **Purchases** | Record items bought — supplier, product, qty, rate, GST, invoice no. |
| **Sales** | Record items sold — customer, product, qty, rate, GST |
| **Inventory** | Auto-calculated stock levels based on purchases & sales |
| **Parties** | Manage suppliers, hospitals, medical stores |
| **Products** | Product catalogue with categories, HSN codes |
| **Reports** | Monthly summaries, top suppliers/customers/products |
| **Export** | Download Excel (.xls) or CSV files |
| **Backup** | JSON backup & restore for data safety |
| **Low Stock Alerts** | Automatic alerts when stock falls below minimum |
| **Profit Tracking** | Auto-calculates profit per sale based on avg buy price |
| **GST Support** | 0%, 5%, 12%, 18%, 28% GST calculation |

---

## 🔑 Keyboard Shortcuts (Electron App)

| Shortcut | Action |
|----------|--------|
| Ctrl+B | New Purchase |
| Ctrl+S | New Sale |
| F11 | Full Screen |
| F5 | Reload |

---

## 📞 Support
Chaturthi Surgicals Business Management System v1.0.0
