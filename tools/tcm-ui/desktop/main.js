// 明道中医 · 问诊台 桌面版（Electron 外壳）
//
// ⚠ 这一层**没有在本开发机验证过**：Electron 起来需要图形环境，而这台机器没有 X server
//   （连内核自带的桌面冒烟都会 SIGSEGV）。所以真正的逻辑全部在 orchestrator.mjs（纯 Node，
//   由 test/desktop-orchestrator.test.mjs 端到端覆盖），这里只保留非 Electron 不可的部分：
//   开窗口 / 托盘 / 单实例 / 退出清理。
//
// 在带桌面的机器上：
//   cd tools/tcm-ui/desktop && npm install && npm start
// 无窗口自检：  MINGDAO_TCM_DESKTOP_SMOKE=1 npm start
// 出安装包：    npm run dist:linux   （Windows/macOS 见 package.json；需设 MINGDAO_KERNEL 之外的镜像已内置）
import { app, BrowserWindow, shell, dialog, Menu, Tray, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, resolveAppRoot, resolveKernelRoot, startApp } from './orchestrator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const smoke = process.env.MINGDAO_TCM_DESKTOP_SMOKE === '1';

// 与内核桌面版同口径的保守开关（需要时可被环境变量打开）
if (process.env.MINGDAO_WAYLAND !== '1') app.commandLine.appendSwitch('ozone-platform', 'x11');
if (process.env.MINGDAO_GPU !== '1') app.disableHardwareAcceleration();

/** @type {{uiUrl:string, close:()=>Promise<void>}|null} */
let running = null;
/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;

function loadIcon(file) {
  const p = path.join(__dirname, 'build', file);
  if (!fs.existsSync(p)) return null;
  try { const img = nativeImage.createFromPath(p); return img.isEmpty() ? null : img; } catch { return null; }
}

/** 起内核 + 问诊台（逻辑全在 orchestrator，这里只负责报错与退出） */
async function boot() {
  const appRoot = resolveAppRoot({ here: __dirname, resourcesPath: process.resourcesPath, packaged: app.isPackaged });
  const kernelRoot = resolveKernelRoot({ appRoot, resourcesPath: process.resourcesPath });
  if (!kernelRoot) {
    dialog.showErrorBox(APP_NAME, '找不到 MingDao-Harness 内核。\n可将内核检出目录设进环境变量 MINGDAO_KERNEL 后重试。');
    app.quit();
    return null;
  }
  try {
    return await startApp({ appRoot, kernelRoot, quiet: true });
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `启动失败：${e?.message || e}`);
    app.quit();
    return null;
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 900, minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0f1216',
    icon: loadIcon('icon.png') || undefined,
    autoHideMenuBar: process.platform !== 'darwin',
    // 与本项目其它前端同口径：不开 node 集成、开上下文隔离
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const origin = new URL(url).origin;
  // 站内留在窗口里；外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u).catch(() => {}); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith(origin)) { e.preventDefault(); shell.openExternal(u).catch(() => {}); }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(url);
  if (isDev && process.env.MINGDAO_TCM_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
}

function createTray(url) {
  const img = loadIcon('tray.png');
  if (!img) return; // 某些环境建不了托盘，不该挡住主窗口
  try {
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开问诊台', click: () => show(url) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
    tray.on('click', () => show(url));
  } catch { /* 忽略 */ }
}

function show(url) {
  if (!win) { createWindow(url); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ── 入口 ──────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (running) show(running.uiUrl); });

  app.whenReady().then(async () => {
    running = await boot();
    if (!running) return;
    if (smoke) {
      // 自检：证明「内核+问诊台都起来了」再退出，不建窗口
      console.log('MINGDAO_TCM_DESKTOP_SMOKE_OK');
      await running.close();
      app.exit(0);
      return;
    }
    createWindow(running.uiUrl);
    createTray(running.uiUrl);
    app.on('activate', () => { if (!win && running) createWindow(running.uiUrl); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => { running?.close?.().catch(() => {}); });
}
