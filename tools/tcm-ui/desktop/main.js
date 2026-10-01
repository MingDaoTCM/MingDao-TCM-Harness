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
import { APP_NAME, resolveAppRoot, resolveKernelRoot, startApp, checkForUpdate } from './orchestrator.mjs';

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

/**
 * 报错出口。`silent`（冒烟模式）时只打日志、不弹窗 ——
 * 无头 CI（xvfb）里弹一个模态对话框会把整条流水线挂住，而冒烟要的只是"非 0 退出"。
 */
function fail(msg, silent) {
  if (silent) { console.error(`[smoke] ${msg}`); return; }
  dialog.showErrorBox(APP_NAME, msg);
}

// ── 帮助菜单要用的三个外部入口（与上游桌面版同口径，可用环境变量覆盖）──────────
// 为什么把 URL 做成常量而不是散在菜单里：站点/反馈地址是会变的（内部域名、换论坛），
// 集中一处才好改，也便于在打包时用环境变量指向测试环境。
const SITE_URL = (process.env.MINGDAO_TCM_SITE || 'https://tcm.mingdao.ai').replace(/\/+$/, '');
// 问题反馈：默认用明道社区论坛（与上游桌面版指向同一个地方）。
const FEEDBACK_URL = process.env.MINGDAO_TCM_FEEDBACK_URL || `${SITE_URL}/forum/`;
const openExternal = (url) => shell.openExternal(url).catch((e) => {
  // 打不开要**说出来**：静默失败会让医师以为"点了没反应"
  dialog.showErrorBox(APP_NAME, `无法打开链接：${url}\n${e?.message || e}`);
});

/**
 * 自动更新（对齐上游桌面版：装完就不用再手动下载）。
 *
 * 为什么走站点而不是 GitHub：仓库是私有的，客户端读不到 Release。
 * electron-builder 会为每个平台生成 `latest*.yml`（记录版本与安装包地址），
 * 我们把它与安装包一起发到站点 `downloads/`，这里用 generic 源指过去。
 *
 * 三条与"手动检查"一致的纪律：**任何路径都要有痕迹**（成功/失败都打日志）、
 * 有超时兜底、开发态与显式禁用时直接跳过（`MINGDAO_TCM_NO_AUTOUPDATE=1`）。
 * 失败**不打扰医师**：自动更新是后台的事，坏了自己下次再试；只有"已下载完成"才弹窗。
 */
let updater = null;
async function initAutoUpdate() {
  if (!app.isPackaged) return null;                       // 开发态没有更新元数据
  if (process.env.MINGDAO_TCM_NO_AUTOUPDATE === '1') { console.log('[update] 已禁用（环境变量）'); return null; }
  try {
    const mod = await import('electron-updater');
    updater = mod.autoUpdater;
  } catch (/** @type {any} */ e) {
    console.warn('[update] electron-updater 不可用，退回"检查更新"：' + (e?.message || e));
    return null;
  }
  try {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('error', (/** @type {any} */ e) => console.warn('[update] 更新失败（不影响使用）：' + (e?.message || e)));
    updater.on('update-available', (/** @type {any} */ i) => console.log(`[update] 发现新版本 ${i?.version}，后台下载中…`));
    updater.on('update-not-available', () => console.log('[update] 已是最新版本'));
    updater.on('update-downloaded', (/** @type {any} */ i) => {
      dialog.showMessageBox(win ?? undefined, {
        type: 'info', title: '更新已就绪',
        message: `新版本 v${i?.version || '?'} 已下载完成`,
        detail: '重启应用即可生效。选择「稍后」则本次退出时自动安装。',
        buttons: ['立即重启并更新', '稍后'], defaultId: 0, cancelId: 1,
      }).then((r) => {
        if (r?.response === 0) { try { updater.quitAndInstall(); } catch (/** @type {any} */ e) { console.warn('[update] 安装失败：' + (e?.message || e)); } }
      }).catch(() => {});
    });
    await updater.checkForUpdates();
  } catch (/** @type {any} */ e) {
    console.warn('[update] 启动检查失败（不影响使用）：' + (e?.message || e));
  }
  return updater;
}

/**
 * 「检查更新」。逻辑在 orchestrator 的 `checkForUpdate`（纯 Node，有单测）；
 * 这里只负责弹窗 —— 三条硬要求照上游桌面版踩过的坑写：
 *   ① **任何路径都必须有反馈**（成功/失败/超时/被禁用一律弹窗，绝不静默）；
 *   ② 超时兜底在 orchestrator 里（站点在内网，可能不可达）；
 *   ③ 文案必带当前版本号，否则医师不知道自己在评估什么。
 */
async function checkUpdates() {
  const show = (opts) => dialog.showMessageBox(win ?? undefined, opts).catch(() => {});
  const cur = app.getVersion();
  // 装了自动更新器就交给它：它会下载并在下完后弹「立即重启并更新」
  if (updater) {
    try {
      await updater.checkForUpdates();
      return show({ type: 'info', title: '检查更新', message: `当前版本 v${cur}`, detail: '正在检查/下载，完成后会提示重启；若已是最新则无提示。' });
    } catch (/** @type {any} */ e) {
      console.warn('[update] 手动检查失败：' + (e?.message || e));
    }
  }
  const r = await checkForUpdate({ siteUrl: SITE_URL, current: cur });

  if (r.status === 'disabled') {
    return show({ type: 'info', title: '检查更新', message: '已通过环境变量关闭检查更新', detail: `当前版本 v${cur}` });
  }
  if (r.status === 'newer') {
    const pick = await show({
      type: 'info', title: '检查更新',
      message: `发现新版本 v${r.latest}（当前 v${cur}）`,
      detail: `是否现在打开下载页？下载页需要访问密码。\n${SITE_URL}/`,
      buttons: ['前往下载', '稍后'], defaultId: 0, cancelId: 1,
    });
    if (pick?.response === 0) openExternal(`${SITE_URL}/`);
    return;
  }
  if (r.status === 'current') {
    return show({
      type: 'info', title: '检查更新',
      message: `已是最新版本 v${cur}`,
      detail: `站点上的最新版本为 v${r.latest}。`,
    });
  }
  const pick = await show({
    type: 'warning', title: '检查更新',
    message: `暂时查不到最新版本（当前 v${cur}）`,
    detail: `原因：${r.reason || '未知'}\n确认能访问 ${SITE_URL} 后再试；也可以直接打开下载页手动查看。`,
    buttons: ['打开下载页', '知道了'], defaultId: 0, cancelId: 1,
  });
  if (pick?.response === 0) openExternal(`${SITE_URL}/`);
}

/** 应用菜单：与上游桌面版同结构（文件/编辑/视图/窗口/帮助），帮助里放官网、检查更新、反馈、关于 */
function buildAppMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: [{ role: 'quit', label: `退出 ${APP_NAME}` }] },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' }, { type: 'separator' },
        { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'resetZoom', label: '重置缩放' },
        { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' },
        ...(isDev ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
      ],
    },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' }] },
    {
      label: '帮助',
      submenu: [
        { label: '官网', click: () => openExternal(`${SITE_URL}/`) },
        { label: '检查更新', click: () => checkUpdates() },
        // 「检查更新」与「问题反馈」之间原来是分隔线留下的一段空白 —— 补上使用帮助（站点上的页）
        { label: '使用帮助', click: () => openExternal(`${SITE_URL}/help.html`) },
        { label: '问题反馈（社区论坛）', click: () => openExternal(FEEDBACK_URL) },
        {
          label: `关于 ${APP_NAME}`,
          click: () => dialog.showMessageBox(win ?? undefined, {
            type: 'info', title: '关于', message: `${APP_NAME} 桌面版`,
            detail: `版本 v${app.getVersion()}\n中医垂域问诊工作台（问诊正文与知识库走 Dify 工作流）\n${SITE_URL}`,
          }).catch(() => {}),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 起内核 + 问诊台（逻辑全在 orchestrator，这里只负责报错与退出） */
async function boot({ silent = false } = {}) {
  const appRoot = resolveAppRoot({ here: __dirname, resourcesPath: process.resourcesPath, packaged: app.isPackaged });
  const kernelRoot = resolveKernelRoot({ appRoot, resourcesPath: process.resourcesPath });
  if (!kernelRoot) {
    fail('找不到 MingDao-Harness 内核。\n可将内核检出目录设进环境变量 MINGDAO_KERNEL 后重试。', silent);
    return null;
  }
  try {
    return await startApp({ appRoot, kernelRoot, quiet: true });
  } catch (e) {
    fail(`启动失败：${e?.message || e}`, silent);
    return null;
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 900, minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0f1216',
    icon: loadIcon('icon.png') || undefined,
    // ⚠ 这里曾经是 `autoHideMenuBar: process.platform !== 'darwin'` ——
    //   Linux/Windows 上菜单栏默认**收起**，于是「帮助 → 检查更新/问题反馈/关于」这些
    //   功能"存在但看不见"（用户 v0.1.5 实测反馈：装了也没看到这些入口）。
    //   改成常显；页面底部也放了同样的链接，两条路都能到。
    autoHideMenuBar: false,
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
      { label: '检查更新', click: () => checkUpdates() },
      { label: '问题反馈', click: () => openExternal(FEEDBACK_URL) },
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
    running = await boot({ silent: smoke });
    if (!running) {
      // 冒烟必须**非 0 退出**：CI 只认退出码，弹窗在无头环境里等于挂住
      if (smoke) { console.error('MINGDAO_TCM_DESKTOP_SMOKE_FAILED'); app.exit(1); }
      else app.quit();
      return;
    }
    // 自动更新：装完就不用再手动下载（后台检查，失败不打扰）
    initAutoUpdate().catch(() => {});
    // 菜单**在冒烟分支之前**就建好：CI 那次 xvfb 冒烟于是也覆盖了菜单模板。
    // 否则这几十行菜单代码在本机与 CI 里都没跑过 —— 一次运行期错误要等医师打开才发现。
    // 托盘菜单早就在用同一个 Menu.buildFromTemplate，这条路在无头环境里是通的。
    buildAppMenu();
    if (smoke) {
      // 自检：证明「内核 + 问诊台都真起来了」再退出，不建窗口（CI 用 xvfb 跑它）
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
