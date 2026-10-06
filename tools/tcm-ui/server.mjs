#!/usr/bin/env node
// 明道中医 UI —— 薄代理 + 静态服务（零依赖，只用 node:内置模块）
//
// 为什么需要它：内核（MingDao-Harness）已经是一个契约清晰的 headless 后端
// （`src/web/server.js` 头部写明了路由与 SSE 事件表）。我们要自己的问诊界面，
// 但**不想改内核一行代码** —— 于是把内核原样跑在一个端口上，本代理：
//   · 把 / 及其它静态资源换成本项目自己的问诊 UI
//   · 把 /api/* 原样转发给内核，**SSE 不缓冲地透传**
//   · 另有代理自有的只读端点 /api/tcm/*（患者名册/历史/提醒；见 tcm-data.mjs）
// 这样内核照旧 `git pull` 跟上游，前端与内核版本**松耦合**：只依赖那套 SSE 契约。
//
// 用法（命令行）：
//   node tools/tcm-ui/server.mjs                          # 默认连 http://127.0.0.1:3821，本服务起 3830
//   node tools/tcm-ui/server.mjs --target http://127.0.0.1:3820 --port 3831
//   MINGDAO_UI_TOKEN=xxx node tools/tcm-ui/server.mjs     # 内核开了 token 时传给上游
//   node tools/tcm-ui/server.mjs --home ~/.mingdao-tcm    # 患者名册/历史要读的 MINGDAO_HOME
//
// 也可作为模块用：`startUiServer({ target, port, token, home })` —— 桌面版（desktop/main.js）
// 就靠它在**同一进程**里把界面拉起来，不必再 spawn 一个 node 子进程去管生命周期。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { roster, patientDetail, reminders, updatePatientRow, deletePatientRow } from './tcm-data.mjs';
import { readSettings, writeSettings } from './settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
/** 站点地址（下载页/使用帮助/论坛/检查更新都指向它）。**现在是公开站点**。可用环境变量覆盖，便于指向测试环境。 */
const SITE_URL = (process.env.MINGDAO_TCM_SITE || 'https://tcm.mingdao.ai').replace(/\/+$/, '');

/** 读请求体（设置页要 POST 密钥；限 64KB 足够） */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { resolve(''); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** 静态文件：限定在 public/ 内，防目录穿越 */
function serveStatic(/** @type {any} */ req, /** @type {any} */ res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUBLIC_DIR, rel);
  const rootWithSep = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (abs !== PUBLIC_DIR && !abs.startsWith(rootWithSep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found'); return; }
    // 样例 UI 处于快速迭代期：禁用缓存，避免浏览器拿旧页面（改动后仅需普通刷新）
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(buf);
  });
}

/**
 * 本地只读端点：`/api/tcm/*`
 *
 * 为什么代理要自己读数据：内核是**通用**的，不认识「患者」这种领域概念 ——
 * 患者名册与历史是 Line B 的领域数据（`patients.json` / `intake/**`），内核没有对应 API。
 * 代理与内核跑在同一台机器、同一个 MINGDAO_HOME 上，直接**只读**即可。
 *
 * ⚠ 这里**不重新定义**任何字段名、标签或读语义 —— 全部来自垂域 Pack（见 tcm-data.mjs）。
 *   理由与复诊修复同源：同一份契约定义两处必然漂移。
 */
function json(/** @type {any} */ res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, must-revalidate',
  });
  res.end(JSON.stringify(obj));
}

function handleTcm(/** @type {any} */ req, /** @type {any} */ res, /** @type {string} */ home, /** @type {any} */ ctx = {}) {
  const u = new URL(req.url || '/', 'http://localhost');
  if (!home) {
    json(res, 500, { ok: false, error: '未配置数据目录：用 --home 或环境变量 MINGDAO_HOME / MINGDAO_UI_HOME 指定' });
    return;
  }
  try {
    // ── 设置：密钥由医师自己填 / 改（**不内置在仓库里**）────────────────────
    // 只监听回环地址（本页只有本机能开）＋ GET 只回脱敏值：
    // 设置页要能让医师确认"填过没有"，但不能把明文回给浏览器（截图/演示即泄露）。
    if (u.pathname === '/api/tcm/settings') {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, settings: readSettings(home), home, currentVersion: String(ctx.currentVersion || ''), siteUrl: SITE_URL });
        return;
      }
      if (req.method === 'POST') {
        readBody(req).then((raw) => {
          let body = null;
          try { body = JSON.parse(raw || '{}'); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
          const r = writeSettings(home, body || {});
          json(res, r.ok ? 200 : 400, r.ok ? { ...r, home } : r);
        }).catch((e) => json(res, 400, { ok: false, error: String(e?.message || e) }));
        return;
      }
      json(res, 405, { ok: false, error: '只支持 GET / POST' });
      return;
    }
    // ── 检查更新：由**服务端**去问站点（浏览器直连会撞 CORS，且站点只对登录用户开主页）
    //    站点那侧 /api/latest 免登录、且只回版本号。
    if (u.pathname === '/api/tcm/update') {
      const cur = String(ctx.currentVersion || '');
      // 动态 import：命令行单跑问诊台时不一定有 desktop/ 那一层，缺了也只是"查不到版本"
      (async () => {
        const base = { siteUrl: SITE_URL, nextUrl: `${SITE_URL}/` };
        try {
          const { checkForUpdate } = await import('./desktop/orchestrator.mjs');
          json(res, 200, { ok: true, ...(await checkForUpdate({ siteUrl: SITE_URL, current: cur })), ...base });
        } catch (e) {
          json(res, 200, { ok: false, status: 'unknown', current: cur, latest: '', reason: String(e?.message || e), ...base });
        }
      })();
      return;
    }
    if (u.pathname === '/api/tcm/patients') {
      const r = roster(home);
      json(res, r.ok ? 200 : 500, { ...r, home });
      return;
    }
    // 随访提醒：问诊台轮询它（提醒口径与名册/看板同源，见 tcm-data.mjs）
    if (u.pathname === '/api/tcm/reminders') {
      const r = reminders(home);
      json(res, r.ok ? 200 : 500, r);
      return;
    }
    const m = /^\/api\/tcm\/patients\/(.+)$/.exec(u.pathname);
    if (m) {
      const pid = decodeURIComponent(m[1]);
      // 改患者：只动姓名/出生年/性别（病历内容一律不碰）
      if (req.method === 'POST' || req.method === 'PATCH') {
        readBody(req).then((raw) => {
          let body = null;
          try { body = JSON.parse(raw || '{}'); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
          const r = updatePatientRow(home, pid, body || {});
          json(res, r.ok ? 200 : 400, r);
        }).catch((e) => json(res, 400, { ok: false, error: String(e?.message || e) }));
        return;
      }
      // 删患者：必须带 confirm:true（并连带删病历目录）
      if (req.method === 'DELETE') {
        readBody(req).then((raw) => {
          let body = null;
          try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
          const r = deletePatientRow(home, pid, body?.confirm === true);
          json(res, r.ok ? 200 : 400, r);
        }).catch((e) => json(res, 400, { ok: false, error: String(e?.message || e) }));
        return;
      }
      const r = patientDetail(home, pid);
      json(res, r.ok ? 200 : 404, r);
      return;
    }
    json(res, 404, { ok: false, error: '未知的 /api/tcm 路由' });
  } catch (/** @type {any} */ e) {
    json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

/**
 * 起一个问诊台服务（薄代理 + 静态资源 + 只读端点）。
 *
 * 导出给桌面版复用：`port: 0` 表示让系统分配随机端口（桌面版不想和别的实例抢 3830）。
 * @param {{target?:string, port?:number, token?:string, home?:string, host?:string, quiet?:boolean}} [opts]
 * @returns {Promise<{port:number, url:string, server:import('node:http').Server, close:()=>Promise<void>}>}
 */
export function startUiServer(opts = {}) {
  const target = String(opts.target || '').replace(/\/+$/, '');
  const port = Number.isFinite(Number(opts.port)) ? Number(opts.port) : 3830;
  const token = String(opts.token || '').trim();
  const home = String(opts.home || '').trim();
  const host = String(opts.host || '127.0.0.1');
  const quiet = opts.quiet === true;

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    // 代理自有的只读端点先处理，不转发给内核
    if (url.startsWith('/api/tcm/')) { handleTcm(req, res, home, { currentVersion: opts.currentVersion }); return; }
    if (!url.startsWith('/api/')) { serveStatic(req, res); return; }

    // —— 转发 /api/* 给内核，SSE 原样透传（绝不缓冲：缓冲会把流式问诊变成"等全部再显示"）——
    try {
      const headers = /** @type {Record<string,string>} */ ({});
      if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
      if (req.headers.accept) headers.accept = String(req.headers.accept);
      // token 只在本代理内部加，不进浏览器（浏览器永远拿不到它）
      if (token) headers['x-mingdao-token'] = token;

      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = Buffer.concat(chunks);
      }

      const upstream = await fetch(`${target}${url}`, {
        method: req.method,
        headers,
        body,
        // @ts-ignore Node 18+ 的 fetch 支持 duplex
        duplex: body ? 'half' : undefined,
      });

      const outHeaders = /** @type {Record<string,string>} */ ({});
      for (const [k, v] of upstream.headers) {
        // 逐跳头不转发；content-length 在流式下也不可信
        if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue;
        outHeaders[k] = v;
      }
      // 关掉缓冲：SSE 必须逐块到达浏览器
      outHeaders['cache-control'] = 'no-cache, no-transform';
      outHeaders['x-accel-buffering'] = 'no';
      res.writeHead(upstream.status, outHeaders);
      if (upstream.body) {
        await pipeline(Readable.fromWeb(/** @type {any} */ (upstream.body)), res);
      } else {
        res.end();
      }
    } catch (/** @type {any} */ e) {
      const msg = `内核不可达或转发失败：${e?.message || e}\n目标：${target}\n请确认内核已启动（例如 MINGDAO_HOME=... node src/cli.js web 3821）。`;
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(msg);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      if (!quiet) {
        console.log('明道中医 UI（独立前端 + 薄代理）');
        console.log(`  界面      http://${host}:${actual}`);
        console.log(`  内核      ${target}${token ? '（已配置访问令牌）' : ''}`);
        console.log(`  患者数据  ${home || '（未配置 —— 名册/历史不可用；用 --home 或 MINGDAO_HOME 指定）'}`);
        console.log('  说明：本服务只监听回环地址；内核不需要任何改动。');
      }
      resolve({
        server,
        port: actual,
        url: `http://${host}:${actual}/`,
        close: () => new Promise((/** @type {any} */ r) => server.close(() => r())),
      });
    });
  });
}

/** @param {string[]} argv */
function argOf(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

// ── 命令行入口（被 import 时不执行）──
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  startUiServer({
    target: argOf(argv, 'target', process.env.MINGDAO_UI_TARGET || 'http://127.0.0.1:3821'),
    port: Number(argOf(argv, 'port', process.env.MINGDAO_UI_PORT || '3830')),
    token: process.env.MINGDAO_UI_TOKEN || '',
    home: argOf(argv, 'home', process.env.MINGDAO_UI_HOME || process.env.MINGDAO_HOME || ''),
  }).catch((/** @type {any} */ e) => {
    console.error(`启动失败：${e?.message || e}`);
    process.exit(1);
  });
}
