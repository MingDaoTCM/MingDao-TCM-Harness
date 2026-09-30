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

/** 判断 src（文件或目录里的 pack.mjs/dify.mjs）是否比 dst 新，需要重装 */
function needsInstall(src, dst) {
  const key = (p) => {
    try { return fs.statSync(p).isDirectory() ? path.join(p, 'pack.mjs') : p; } catch { return null; }
  };
  const s = key(src);
  if (!s) return false;
  const d = key(dst);
  try {
    if (!d || !fs.existsSync(d)) return true;
    const a = fs.statSync(s);
    const b = fs.statSync(d);
    return a.size !== b.size || a.mtimeMs > b.mtimeMs + 1000;
  } catch { return true; }
}

/**
 * 把**打包进来的垂域层**（Pack + 自定义 Provider）装进 `$MINGDAO_HOME`。
 *
 * 为什么必须有这一步：内核只从 `$MINGDAO_HOME/packs`、`$MINGDAO_HOME/providers` 加载扩展，
 * 而打包产物把它们放在 `resources/app/layer/...`。此前没有任何一步做"安装"，
 * 于是在一台干净机器上打开桌面版得到的是**裸内核**：
 *   · 没有 `pack__tcm__*` 工具（患者识别/落盘/复诊对比全都没有）
 *   · 没有 dify provider，`config.provider` 还是内核默认的 `deepseek`
 *   → 问诊正文由 DeepSeek 直连生成，**根本不碰 Dify 工作流**，病历也不会落盘。
 * 探针实测（全新空 home）：`packs/` 不存在、`providers/` 为空、`provider=deepseek`。
 *
 * 幂等：内容一致就不动；源更新（重新打包）才覆盖。
 * @returns {{pack:string, provider:string, home:string}}
 */
export function installLayer({ home, appRoot }) {
  const out = { home, pack: 'unknown', provider: 'unknown' };
  const jobs = [
    { key: 'pack', src: path.join(appRoot, 'layer', 'packs', 'tcm'), dst: path.join(home, 'packs', 'tcm') },
    { key: 'provider', src: path.join(appRoot, 'layer', 'providers', 'dify.mjs'), dst: path.join(home, 'providers', 'dify.mjs') },
  ];
  for (const j of jobs) {
    try {
      if (!fs.existsSync(j.src)) { out[j.key] = '源缺失'; continue; }
      if (!needsInstall(j.src, j.dst)) { out[j.key] = '已就位'; continue; }
      fs.mkdirSync(path.dirname(j.dst), { recursive: true });
      fs.rmSync(j.dst, { recursive: true, force: true });
      fs.cpSync(j.src, j.dst, { recursive: true });
      out[j.key] = fs.existsSync(j.dst) ? '已安装' : '安装失败';
    } catch (e) {
      out[j.key] = `失败：${e?.message || e}`;
    }
  }
  return out;
}

/**
 * 只在**配置是本应用刚建出来**的时候，把 provider 指向 Dify（路线 A）。
 * 医师自己改过配置（hadConfig=true）就绝不动 —— 那是他的选择。
 * @returns {boolean} 是否写了
 */
export function pointConfigAtDify(home) {
  const p = path.join(home, 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 裸内核默认 deepseek 直连；本产品的问诊正文与知识库在 Dify 工作流里（路线 A），
    // 留在 deepseek 就等于"问诊不经过知识库、也不触发垂域工具链"。
    if (!cfg.provider || cfg.provider === 'deepseek') {
      cfg.provider = 'dify';
      cfg.model = 'dify-chatflow';
      // ⚠ 必须删掉顶层 baseUrl：内核的 resolveProviderConfig 是
      //   `baseUrl = cfg.baseUrl || <服务商预设>.baseUrl`，顶层值会**压过**目标模型自己的地址。
      //   内核建最小配置时会写上 `https://api.deepseek.com/v1`，若留着，它会被当成
      //   **Dify 的端点**（provider 的 pc.baseUrl）→ 请求发去 DeepSeek，仍然碰不到 Dify。
      //   dify.mjs 的注释里就写着「config.json 里不要写顶层 baseUrl」，这里照办。
      delete cfg.baseUrl;
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
      return true;
    }
    return false;
  } catch { return false; }
}

/** 版本比较：只认前 3 段数字，预发布后缀忽略（内部发布不玩 rc） */
export function versionGt(a, b) {
  const seg = (v) => String(v || '').replace(/^v/, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const pa = seg(a);
  const pb = seg(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/**
 * 「检查更新」的**逻辑**（纯 Node，可测；Electron 那边只负责弹窗）。
 *
 * 站点侧的 `/api/latest` 免登录、且只回版本号（不泄露下载区）。
 * **永不抛错**：查不到就返回 `unknown`，由调用方把原因说给用户听 ——
 * 「点了没反应」比「查不到」糟得多（上游桌面版为此外门修过一次）。
 *
 * @param {{siteUrl:string, current:string, timeoutMs?:number, fetchImpl?:typeof fetch}} o
 * @returns {Promise<{status:'newer'|'current'|'unknown'|'disabled', current:string, latest:string, reason?:string}>}
 */
export async function checkForUpdate(o) {
  const current = String(o?.current || '');
  if (process.env.MINGDAO_TCM_NO_AUTOUPDATE === '1') return { status: 'disabled', current, latest: '' };
  const site = String(o?.siteUrl || '').replace(/\/+$/, '');
  if (!site) return { status: 'unknown', current, latest: '', reason: '未配置站点地址' };
  const doFetch = o?.fetchImpl || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(o?.timeoutMs) || 8000);
  try {
    const r = await doFetch(`${site}/api/latest`, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) return { status: 'unknown', current, latest: '', reason: `HTTP ${r.status}` };
    const j = await r.json();
    const latest = String(j?.version || '').trim();
    if (!latest) return { status: 'unknown', current, latest: '', reason: '站点上还没有已发布的安装包' };
    return { status: versionGt(latest, current) ? 'newer' : 'current', current, latest };
  } catch (e) {
    return {
      status: 'unknown', current, latest: '',
      reason: e?.name === 'AbortError' ? '请求超时' : (e?.message || String(e)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 起整套应用：内核 WebUI（随机端口）+ 问诊台薄代理（同进程）。
 *
 * 为什么同进程起代理：桌面版不该再 spawn 一个 node 子进程去管生命周期（退出时容易留孤儿）。
 * token 由这里生成并**只在本进程内**交给代理 —— 浏览器永远拿不到它。
 *
 * @param {{appRoot?:string, kernelRoot?:string, home?:string, uiPort?:number, host?:string, quiet?:boolean}} [opts]
 * @returns {Promise<{appRoot:string, kernelRoot:string, home:string, layer:any, kernelPort:number, kernelUrl:string, uiUrl:string, uiPort:number, close:()=>Promise<void>}>}
 */
export async function startApp(opts = {}) {
  const appRoot = opts.appRoot || resolveAppRoot({});
  const kernelRoot = opts.kernelRoot || resolveKernelRoot({ appRoot });
  if (!kernelRoot) {
    throw new Error('找不到 MingDao-Harness 内核检出：设 MINGDAO_KERNEL，或把内核放进打包产物的 resources/kernel');
  }
  const host = String(opts.host || '127.0.0.1');

  // 先只加载 config 模块（它是纯模块，数据目录在**调用时**才解析），
  // 用它算出 home，再把 MINGDAO_HOME 定下来，最后才加载 WebUI。
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

  // ★ 把 home **回写进环境变量**，让内核也用同一个目录。
  //   否则一旦 home 来自 `~/.mingdao-tcm-desktop.json`（或 opts.home），就会分叉：
  //   我们把 Pack/Provider 装进 home，内核却去 `~/.mingdao` 找扩展 —— 装了等于没装，
  //   表现为"问诊不走 Dify、病历不落盘"，而且**没有任何报错**。
  //   必须在加载 WebUI 之前设好（内核在启动时读它）。
  process.env.MINGDAO_HOME = home;

  // ① 内核 WebUI：随机端口，被占用就换（与内核 desktop/ 同一套做法）
  const serverMod = await import(pathToFileURL(path.join(kernelRoot, 'src', 'web', 'server.js')).href);

  // 首启自检：没有 config.json 时让内核建一份最小可用的，
  // 否则桌面版第一次打开会直接报「配置缺失」——正是我们要消灭的「先跑终端」那一步。
  // 记下"本来有没有" —— 下面要据此决定是否把 provider 指向 Dify（**只对新建的**配置动手，
  // 不覆盖医师自己改过的选择）。
  const hadConfig = fs.existsSync(path.join(home, 'config.json'));
  try { cfgMod?.ensureMinimalConfig?.(); } catch { /* 建不出来也不该挡住窗口 */ }

  // ── 把**打包进来的垂域层**装进 home ─────────────────────────────────────
  // 这一段是 2026-09-24 用户报「似乎没有调用 Dify 工作流」的根因：
  // 内核从 `$MINGDAO_HOME/packs` 与 `$MINGDAO_HOME/providers` 加载扩展，而打包产物把
  // Pack / Provider 放在 `resources/app/layer/...`。此前**没有任何一步把它们装进 home** ——
  // 于是在一台干净机器上打开桌面版，得到的是一个**裸内核**：
  // 没有 tcm 工具、没有 dify provider，provider 还是内核默认的 deepseek，
  // 问诊正文直接由 DeepSeek 生成，**根本不碰 Dify 工作流**，患者数据也就永远不会落盘。
  // 探针实测（全新空 home）：packs/ 不存在、providers/ 为空、config.provider=deepseek。
  const layer = installLayer({ home, appRoot });
  if (!hadConfig) pointConfigAtDify(home);

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

  // 垂域层没装成功就**喊出来**：这种情况界面照样能打开、照样能聊天，
  // 但问诊不走 Dify、病历不落盘 —— 静默失败正是这一整类问题的共同点。
  if (opts.quiet === false || layer.pack.includes('失败') || layer.provider.includes('失败')) {
    console.warn(`[TCM] 垂域层：Pack ${layer.pack} · Provider ${layer.provider}（数据目录 ${home}）`);
  }

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
    layer,
    kernelPort,
    kernelUrl: `http://${host}:${kernelPort}`,
    uiUrl: ui.url,
    uiPort: ui.port,
    close: async () => { await ui.close(); },
  };
}
