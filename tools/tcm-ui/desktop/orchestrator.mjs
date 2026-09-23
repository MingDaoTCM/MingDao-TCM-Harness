// 桌面版的「编排层」—— 纯 Node，**不依赖 Electron**。
//
// 为什么单独拆出这一层：Electron 启动需要图形环境，而开发/CI 机器常常没有 X server
// （本机就是：连内核自带的桌面冒烟都 SIGSEGV）。把「起内核 + 起问诊台代理」这段真正的逻辑
// 放在纯 Node 里，就能在没有图形环境的地方**端到端验证它**（见 test/desktop-orchestrator.test.mjs）；
// main.js 只保留「开窗口 / 托盘 / 菜单」这些非 Electron 不可的部分。
//
// 与内核自带 desktop/ 的关系：**同源不同壳**。内核桌面版打开的是内核 WebUI；
// 这里打开的是本项目的问诊台（带患者名册/随访提醒的那个独立前端）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP_NAME = '明道中医 · 问诊台';

/**
 * 桌面版的数据目录覆盖 —— 给 **GUI** 用的：给一个窗口应用设环境变量太别扭
 * （启动器、桌面项、双击图标各有各的传参方式，用户多半设不上）。
 *
 *   ~/.mingdao-tcm-desktop.json   →   { "home": "/home/you/.mingdao-tcm" }
 *
 * 读不到 / 不是合法 JSON / 字段不对 → 空串，交给后面的优先级继续兜。
 */
export function desktopConfigHome() {
  try {
    const p = path.join(os.homedir(), '.mingdao-tcm-desktop.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof j?.home === 'string' ? j.home.trim() : '';
  } catch { return ''; }
}

/**
 * 应用根目录（其下应有 `layer/` 与 `tools/tcm-ui/`）。
 * 打包后是 `resources/app`；开发态就是仓库根 —— 两者内部结构一致，
 * 所以 `tcm-data.mjs` 里那句 `../../layer/packs/tcm/pack.mjs` 在哪都成立。
 * @param {{here?:string, resourcesPath?:string, packaged?:boolean}} [opts]
 */
export function resolveAppRoot(opts = {}) {
  if (opts.packaged && opts.resourcesPath) return path.join(opts.resourcesPath, 'app');
  const here = opts.here || path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..'); // desktop → tcm-ui → tools → 仓库根
}

/**
 * 内核检出目录。优先级：显式传入 > `MINGDAO_KERNEL` > 打包内置 `resources/kernel` > 开发态工作区同级。
 * @param {{appRoot?:string, explicit?:string, resourcesPath?:string}} [opts]
 * @returns {string|null}
 */
export function resolveKernelRoot(opts = {}) {
  const cands = [];
  if (opts.explicit) cands.push(opts.explicit);
  if (process.env.MINGDAO_KERNEL) cands.push(process.env.MINGDAO_KERNEL);
  if (opts.resourcesPath) cands.push(path.join(opts.resourcesPath, 'kernel'));
  if (opts.appRoot) cands.push(path.resolve(opts.appRoot, '..', 'MingDao-Harness'));
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'src', 'web', 'server.js'))) return path.resolve(c);
  }
  return null;
}

/**
 * 起整套应用：内核 WebUI（随机端口）+ 问诊台薄代理（同进程）。
 *
 * 为什么同进程起代理：桌面版不该再 spawn 一个 node 子进程去管生命周期（退出时容易留孤儿）。
 * token 由这里生成并**只在本进程内**交给代理 —— 浏览器永远拿不到它。
 *
 * @param {{appRoot?:string, kernelRoot?:string, home?:string, uiPort?:number, host?:string, quiet?:boolean}} [opts]
 * @returns {Promise<{appRoot:string, kernelRoot:string, kernelPort:number, kernelUrl:string, uiUrl:string, uiPort:number, close:()=>Promise<void>}>}
 */
export async function startApp(opts = {}) {
  const appRoot = opts.appRoot || resolveAppRoot({});
  const kernelRoot = opts.kernelRoot || resolveKernelRoot({ appRoot });
  if (!kernelRoot) {
    throw new Error('找不到 MingDao-Harness 内核检出：设 MINGDAO_KERNEL，或把内核放进打包产物的 resources/kernel');
  }
  const host = String(opts.host || '127.0.0.1');

  // ① 内核 WebUI：随机端口，被占用就换（与内核 desktop/ 同一套做法）
  const serverMod = await import(pathToFileURL(path.join(kernelRoot, 'src', 'web', 'server.js')).href);
  let cfgMod = null;
  try { cfgMod = await import(pathToFileURL(path.join(kernelRoot, 'src', 'config.js')).href); } catch { /* 老内核没这个模块也不该挡住启动 */ }

  // ── 数据目录：**以内核自己的解析为准**，界面复用同一个值 ──────────────────
  // 为什么不能各算一次：内核用的是 `process.env.MINGDAO_HOME || ~/.mingdao`
  // （src/config.js 的 mingdaoHome）。而桌面版里 MINGDAO_HOME **通常是空的** ——
  // 于是内核用 ~/.mingdao，界面却拿到空串 → 名册/提醒直接报「未配置数据目录」。
  // 这个组合在命令行下恰好不出现（启动脚本会设 MINGDAO_HOME），所以本机与单测都没暴露，
  // 是 2026-09-23 用户装上桌面版才照出来的。收口办法：向内核要它解析的结果。
  //
  // 优先级：显式传入 > MINGDAO_HOME 环境变量 > 桌面版配置文件 > 内核默认。
  const home = String(
    opts.home
    || process.env.MINGDAO_HOME
    || desktopConfigHome()
    || (typeof cfgMod?.mingdaoHome === 'function' ? cfgMod.mingdaoHome() : '')
    || '',
  ).trim();
  if (!home) throw new Error('解析不出数据目录（MINGDAO_HOME / 桌面版配置 / 内核 mingdaoHome()）——界面将读不到患者数据');

  // 首启自检：没有 config.json 时让内核建一份最小可用的，
  // 否则桌面版第一次打开会直接报「配置缺失」——正是我们要消灭的「先跑终端」那一步。
  try { cfgMod?.ensureMinimalConfig?.(); } catch { /* 建不出来也不该挡住窗口 */ }

  const authToken = crypto.randomBytes(16).toString('hex');
  let kernelPort = 0;
  for (let attempt = 0; attempt < 6 && !kernelPort; attempt++) {
    const p = 40000 + Math.floor(Math.random() * 20000);
    try {
      await serverMod.runWebServer({ host, port: p, authToken });
      kernelPort = p;
    } catch (e) {
      if (e?.code === 'EADDRINUSE') continue;
      throw e;
    }
  }
  if (!kernelPort) throw new Error('内核 WebUI 启动失败：随机端口连续 6 次都被占用');

  // ② 问诊台代理（从 appRoot 动态加载 —— 打包前后布局一致，见 resolveAppRoot 的说明）
  const uiEntry = path.join(appRoot, 'tools', 'tcm-ui', 'server.mjs');
  if (!fs.existsSync(uiEntry)) throw new Error(`找不到问诊台入口：${uiEntry}`);
  const { startUiServer } = await import(pathToFileURL(uiEntry).href);
  const ui = await startUiServer({
    target: `http://${host}:${kernelPort}`,
    port: Number.isFinite(Number(opts.uiPort)) ? Number(opts.uiPort) : 0,
    token: authToken,
    home,
    host,
    quiet: opts.quiet !== false,
  });

  return {
    appRoot,
    kernelRoot,
    home,
    kernelPort,
    kernelUrl: `http://${host}:${kernelPort}`,
    uiUrl: ui.url,
    uiPort: ui.port,
    close: async () => { await ui.close(); },
  };
}
