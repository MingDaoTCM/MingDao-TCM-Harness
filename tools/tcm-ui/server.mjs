#!/usr/bin/env node
// 得一中医 UI —— 薄代理 + 静态服务（零依赖，只用 node:内置模块）
//
// 为什么需要它：内核（MingDao-Harness）已经是一个契约清晰的 headless 后端
// （`src/web/server.js` 头部写明了路由与 SSE 事件表）。我们要自己的问诊界面，
// 但**不想改内核一行代码** —— 于是把内核原样跑在一个端口上，本代理：
//   · 把 / 及其它静态资源换成本项目自己的问诊 UI
//   · 把 /api/* 原样转发给内核，**SSE 不缓冲地透传**
// 这样内核照旧 `git pull` 跟上游，前端与内核版本**松耦合**：只依赖那套 SSE 契约。
//
// 用法：
//   node tools/tcm-ui/server.mjs                       # 默认连 http://127.0.0.1:3821，本服务起 3830
//   node tools/tcm-ui/server.mjs --target http://127.0.0.1:3820 --port 3831
//   MINGDAO_UI_TOKEN=xxx node tools/tcm-ui/server.mjs  # 内核开了 token 时传给上游
//   node tools/tcm-ui/server.mjs --home ~/.deyi-tcm    # 患者名册/历史要读的 MINGDAO_HOME
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { roster, patientDetail } from './tcm-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

/** @param {string[]} argv */
function argOf(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const argv = process.argv.slice(2);
const TARGET = String(argOf(argv, 'target', process.env.MINGDAO_UI_TARGET || 'http://127.0.0.1:3821')).replace(/\/+$/, '');
const PORT = Number(argOf(argv, 'port', process.env.MINGDAO_UI_PORT || '3830'));
const TOKEN = String(process.env.MINGDAO_UI_TOKEN || '').trim();
// 患者数据目录（读名册/历史用）。与内核同一个 MINGDAO_HOME —— 界面与内核读的必须是同一批文件。
const HOME = String(argOf(argv, 'home', process.env.MINGDAO_UI_HOME || process.env.MINGDAO_HOME || '')).trim();

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

function handleTcm(/** @type {any} */ req, /** @type {any} */ res) {
  const u = new URL(req.url || '/', 'http://localhost');
  if (!HOME) {
    json(res, 500, { ok: false, error: '未配置数据目录：用 --home 或环境变量 MINGDAO_HOME / MINGDAO_UI_HOME 指定' });
    return;
  }
  try {
    if (u.pathname === '/api/tcm/patients') {
      const r = roster(HOME);
      json(res, r.ok ? 200 : 500, { ...r, home: HOME });
      return;
    }
    const m = /^\/api\/tcm\/patients\/(.+)$/.exec(u.pathname);
    if (m) {
      const r = patientDetail(HOME, decodeURIComponent(m[1]));
      json(res, r.ok ? 200 : 404, r);
      return;
    }
    json(res, 404, { ok: false, error: '未知的 /api/tcm 路由' });
  } catch (/** @type {any} */ e) {
    json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  // 代理自有的只读端点先处理，不转发给内核
  if (url.startsWith('/api/tcm/')) { handleTcm(req, res); return; }
  if (!url.startsWith('/api/')) { serveStatic(req, res); return; }

  // —— 转发 /api/* 给内核，SSE 原样透传（绝不缓冲：缓冲会把流式问诊变成"等全部再显示"）——
  try {
    const headers = /** @type {Record<string,string>} */ ({});
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
    if (req.headers.accept) headers.accept = String(req.headers.accept);
    // token 只在本代理内部加，不进浏览器（浏览器永远拿不到它）
    if (TOKEN) headers['x-mingdao-token'] = TOKEN;

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }

    const upstream = await fetch(`${TARGET}${url}`, {
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
    const msg = `内核不可达或转发失败：${e?.message || e}\n目标：${TARGET}\n请确认内核已启动（例如 MINGDAO_HOME=... node src/cli.js web 3821）。`;
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(msg);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('得一中医 UI（独立前端 + 薄代理）');
  console.log(`  界面      http://127.0.0.1:${PORT}`);
  console.log(`  内核      ${TARGET}${TOKEN ? '（已配置访问令牌）' : ''}`);
  console.log(`  患者数据  ${HOME || '（未配置 —— 名册/历史不可用；用 --home 或 MINGDAO_HOME 指定）'}`);
  console.log('  说明：本服务只监听回环地址；内核不需要任何改动。');
});
