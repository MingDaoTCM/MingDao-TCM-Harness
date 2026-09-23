#!/usr/bin/env node
// 明道中医 · 问诊台 —— 站点服务
//
// 单文件、零依赖（只用 node: 内置模块），与官网的 `bbs-server.js` 同一路子。
//
// 为什么不是纯静态站：要求是「不公开 + 首页密码访问 + **密码可在后台管理** + 安装包供下载」。
// 静态站做不到「密码可改」——除非每次改密码都重新部署一次。所以这里放一个小服务：
//
//   GET  /                  有会话 → 首页；没有 → 登录页
//   POST /api/login         { password } → 校验 → 下发 HMAC 签名的会话 cookie
//   POST /api/logout
//   GET  /api/session       当前登录状态（前端用来决定显示什么）
//   GET  /api/downloads     安装包清单（由 deploy.sh 生成的 manifest.json）
//   GET  /downloads/<文件>  安装包本体（**必须已登录**，否则 302 回登录页）
//   GET  /admin             后台（**独立的管理员密码**）：改访问密码 / 改管理员密码
//   POST /api/admin/password   { current, next, target: 'site'|'admin' }
//
// 安全上的取舍（写出来，免得被当成疏漏）：
//   · 密码只存 **scrypt 哈希**（不存明文，也不可逆）；比对用 timingSafeEqual。
//   · 会话是 **HMAC 签名**的无状态 cookie（服务端不存 session，重启不掉线）；密钥随机生成存 0600 文件。
//   · 登录失败按 IP 做简单限速（防在线爆破）；不做账号体系——这是「一把门钥匙」，不是多用户系统。
//   · 下载路径做**白名单**（只能是 downloads/ 下的直系文件），挡 `../` 与软链逃逸。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.TCM_PORT || 8448);
const ROOT = process.env.TCM_ROOT || path.join(import.meta.dirname, 'public');
const DATA = process.env.TCM_DATA || '/var/lib/mingdao-tcm-site';
const SESSION_DAYS = Number(process.env.TCM_SESSION_DAYS || 7);
const TRUST_PROXY = process.env.TCM_TRUST_PROXY !== '0'; // nginx 在前面，取 X-Forwarded-For

const AUTH_FILE = path.join(DATA, 'auth.json');
const DL_DIR = path.join(ROOT, 'downloads');

const nowIso = () => new Date().toISOString();
const log = (...a) => console.log(nowIso(), ...a);

// ─────────────────────────── 认证存储 ───────────────────────────
function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
/** 原子写 + 0600：auth.json 里有口令哈希与会话密钥，半写会锁死整个站 */
function writeAuth(o) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const tmp = `${AUTH_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
function makeCred(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPw(pw, salt), updatedAt: nowIso() };
}
function verifyPw(pw, cred) {
  if (!cred?.salt || !cred?.hash) return false;
  const got = Buffer.from(hashPw(pw, cred.salt), 'hex');
  const want = Buffer.from(cred.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * 首次运行生成凭据。初始密码取 `TCM_INIT_PASSWORD`（部署脚本会传），否则随机生成。
 * 同时写一份 0600 的 `INITIAL-PASSWORD.txt`，并在日志里打一次 —— 否则装完没人知道密码。
 */
function ensureAuth() {
  const existing = readAuth();
  if (existing?.sessionSecret && existing?.site && existing?.admin) return existing;
  const init = String(process.env.TCM_INIT_PASSWORD || '').trim() || crypto.randomBytes(9).toString('base64url');
  const auth = {
    site: makeCred(init),
    admin: makeCred(init),
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    createdAt: nowIso(),
    note: 'site=访问密码；admin=后台管理员密码。改密码走 /admin，不要手工编辑本文件。',
  };
  writeAuth(auth);
  try {
    fs.writeFileSync(path.join(DATA, 'INITIAL-PASSWORD.txt'),
      `初始密码（访问密码与管理员密码相同）：${init}\n请到 /admin 改成你自己的密码，然后删掉本文件。\n`, { mode: 0o600 });
  } catch { /* 写不了也只是少个提示 */ }
  log(`[init] 已生成初始密码：${init}（同时写入 ${path.join(DATA, 'INITIAL-PASSWORD.txt')}）`);
  return auth;
}

// ─────────────────────────── 会话（HMAC 签名，无状态） ───────────────────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function issueSession(role, secret) {
  const body = b64({ role, exp: Date.now() + SESSION_DAYS * 86400000 });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function parseSession(raw, secret) {
  const [body, sig] = String(raw || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!o?.exp || o.exp < Date.now()) return null;
    return o.role === 'admin' || o.role === 'viewer' ? o : null;
  } catch { return null; }
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const SESSION_COOKIE = 'tcm_session';
function sessionOf(req, auth) {
  return parseSession(cookies(req)[SESSION_COOKIE], auth.sessionSecret);
}
function setCookie(res, value, maxAgeSec) {
  const bits = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'];
  bits.push(maxAgeSec > 0 ? `Max-Age=${maxAgeSec}` : 'Max-Age=0');
  res.setHeader('Set-Cookie', bits.join('; '));
}

// ─────────────────────────── 登录限速（按 IP） ───────────────────────────
const attempts = new Map(); // ip → { n, until }
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRIES = 8;
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}
function tooMany(ip) {
  const a = attempts.get(ip);
  return !!(a && a.n >= MAX_TRIES && Date.now() < a.until);
}
function noteFail(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n += 1; a.until = Date.now() + WINDOW_MS;
  attempts.set(ip, a);
  if (attempts.size > 5000) attempts.clear(); // 别让这张表长成内存泄漏
}
function noteOk(ip) { attempts.delete(ip); }

// ─────────────────────────── HTTP 小工具 ───────────────────────────
function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  res.writeHead(code, { 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(buf);
}
const sendHtml = (res, code, html) => send(res, code, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { resolve(null); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}
function readJson(req) { return readBody(req).then((s) => { try { return JSON.parse(s || '{}'); } catch { return null; } }); }

// ─────────────────────────── 静态文件（白名单） ───────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp',
};
/** 只允许 public/ 下的直系资源（不含 downloads/，那条走鉴权路由） */
function serveAsset(res, rel) {
  const clean = String(rel).replace(/^\/+/, '');
  if (clean.includes('..') || clean.startsWith('downloads/')) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
  const abs = path.join(ROOT, clean);
  if (!abs.startsWith(ROOT + path.sep)) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
  fs.readFile(abs, (err, buf) => {
    if (err) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
    send(res, 200, buf, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': path.extname(abs) === '.html' ? 'no-store' : 'public, max-age=3600',
    });
  });
}

// ─────────────────────────── 安装包下载（已登录才给） ───────────────────────────
function downloadManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DL_DIR, 'manifest.json'), 'utf8'));
    return { ok: true, version: m.version || '', files: Array.isArray(m.files) ? m.files : [] };
  } catch {
    // 清单还没生成（deploy.sh 会生成）——列目录兜底，至少别让页面空着
    try {
      const files = fs.readdirSync(DL_DIR)
        .filter((f) => /\.(exe|dmg|zip|AppImage|deb)$/i.test(f))
        .map((f) => ({ name: f, size: fs.statSync(path.join(DL_DIR, f)).size }));
      return { ok: true, version: '', files };
    } catch { return { ok: true, version: '', files: [] }; }
  }
}
function serveDownload(req, res, name) {
  const base = path.basename(decodeURIComponent(name));
  if (!base || base.includes('..')) return send(res, 400, 'bad name', { 'Content-Type': 'text/plain' });
  const abs = path.join(DL_DIR, base);
  let st;
  try { st = fs.statSync(abs); if (!st.isFile()) throw new Error('not a file'); } catch { return send(res, 404, 'not found', { 'Content-Type': 'text/plain' }); }
  const type = base.endsWith('.dmg') ? 'application/x-apple-diskimage'
    : base.endsWith('.exe') ? 'application/vnd.microsoft.portable-executable'
      : base.endsWith('.deb') ? 'application/vnd.debian.binary-package'
        : 'application/octet-stream';
  // 大文件（100MB+）支持 Range，断点续传/下载器友好
  const range = String(req.headers.range || '');
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
    }
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${base}"`,
    });
    return fs.createReadStream(abs, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': st.size,
    'Accept-Ranges': 'bytes', 'Content-Disposition': `attachment; filename="${base}"`,
  });
  fs.createReadStream(abs).pipe(res);
}

// ─────────────────────────── 页面 ───────────────────────────
const page = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return null; } };
function adminHtml(masked) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>后台 · 明道中医问诊台</title>
<style>
:root{--bg:#0b0e14;--bg2:#10141d;--border:#242b3a;--text:#e8ecf4;--dim:#98a2b8;--faint:#5c6679;--jade:#14b8a6;--red:#ff6b6b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:48px 20px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:32px 0 10px;color:var(--jade)}
p.sub{color:var(--dim);margin:0 0 24px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;margin:0 0 18px}
label{display:block;font-size:13px;color:var(--dim);margin:10px 0 4px}
input{width:100%;background:#0d1017;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:10px 12px;font:14px inherit}
button{margin-top:14px;background:var(--jade);border:0;color:#04120f;font-weight:600;border-radius:8px;padding:10px 18px;font:14px inherit;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--border);color:var(--text);font-weight:400}
.msg{margin-top:12px;font-size:13.5px;min-height:20px}
.ok{color:#3ddc97}.err{color:var(--red)}
.meta{font-size:12.5px;color:var(--faint)}
a{color:var(--jade)}
</style></head><body><div class="wrap">
<h1>明道中医 · 问诊台 — 后台</h1>
<p class="sub">改访问密码 / 改管理员密码。改完立即生效，无需重启。</p>
<div class="card">
  <h2 style="margin-top:0">访问密码（首页门钥匙）</h2>
  <p class="meta">当前更新时间：${masked.siteUpdated || '—'}</p>
  <label>当前访问密码</label><input id="c1" type="password" autocomplete="current-password"/>
  <label>新访问密码（至少 6 位）</label><input id="n1" type="password" autocomplete="new-password"/>
  <button onclick="save('site','c1','n1','m1')">保存访问密码</button>
  <div class="msg" id="m1"></div>
</div>
<div class="card">
  <h2 style="margin-top:0">管理员密码（进这个后台用）</h2>
  <p class="meta">当前更新时间：${masked.adminUpdated || '—'}</p>
  <label>当前管理员密码</label><input id="c2" type="password" autocomplete="current-password"/>
  <label>新管理员密码（至少 6 位）</label><input id="n2" type="password" autocomplete="new-password"/>
  <button onclick="save('admin','c2','n2','m2')">保存管理员密码</button>
  <div class="msg" id="m2"></div>
</div>
<div class="card">
  <h2 style="margin-top:0">安装包</h2>
  <p class="meta">安装包由发布流程上传到 <code>downloads/</code>；清单见 <a href="/api/downloads" target="_blank">/api/downloads</a>。</p>
</div>
<button class="ghost" onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.href='/')">退出登录</button>
<script>
async function save(target, cur, next, msg){
  const el=document.getElementById(msg); el.className='msg'; el.textContent='保存中…';
  const r=await fetch('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({target,current:document.getElementById(cur).value,next:document.getElementById(next).value})});
  const j=await r.json().catch(()=>({ok:false,error:'HTTP '+r.status}));
  if(j.ok){
    el.className='msg ok'; el.textContent='✓ 已保存（'+(j.updatedAt||'')+'）';
    document.getElementById(cur).value=''; document.getElementById(next).value='';
    if(target==='admin') setTimeout(()=>{ el.textContent+=' 管理员密码已变，请重新登录…'; setTimeout(()=>location.href='/',1200); },600);
  } else { el.className='msg err'; el.textContent='✗ '+(j.error||'保存失败'); }
}
</script></div></body></html>`;
}

// ─────────────────────────── 路由 ───────────────────────────
const auth = ensureAuth();
log(`[boot] 站点根=${ROOT} 数据=${DATA} 端口=${PORT}`);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  const p = u.pathname;
  const sess = sessionOf(req, auth);
  const isAdmin = sess?.role === 'admin';
  const isAuthed = !!sess;

  // ── 公开资源（登录页也要用图标/样式）
  if (p === '/favicon.ico' || p === '/apple-touch-icon.png' || p.startsWith('/assets/')) return serveAsset(res, p);

  // ── 登录 / 登出 / 状态
  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (tooMany(ip)) return sendJson(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
    const body = await readJson(req);
    const pw = String(body?.password || '');
    const role = verifyPw(pw, auth.admin) ? 'admin' : verifyPw(pw, auth.site) ? 'viewer' : null;
    if (!role) { noteFail(ip); log(`[login] 失败 ip=${ip}`); return sendJson(res, 401, { ok: false, error: '密码不正确' }); }
    noteOk(ip);
    setCookie(res, issueSession(role, auth.sessionSecret), SESSION_DAYS * 86400);
    log(`[login] 成功 ip=${ip} role=${role}`);
    return sendJson(res, 200, { ok: true, role });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    setCookie(res, '', 0);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/session') return sendJson(res, 200, { ok: true, authed: isAuthed, admin: isAdmin });

  // ── 安装包清单（登录后可见）
  if (p === '/api/downloads') {
    if (!isAuthed) return sendJson(res, 401, { ok: false, error: '未登录' });
    return sendJson(res, 200, downloadManifest());
  }
  if (p.startsWith('/downloads/')) {
    if (!isAuthed) return redirect(res, '/');       // 未登录：回首页（会看到登录页）
    return serveDownload(req, res, p.slice('/downloads/'.length));
  }

  // ── 后台
  if (p === '/admin' || p === '/admin/') {
    if (!isAdmin) return redirect(res, '/');
    return sendHtml(res, 200, adminHtml({ siteUpdated: auth.site?.updatedAt, adminUpdated: auth.admin?.updatedAt }));
  }
  if (p === '/api/admin/password' && req.method === 'POST') {
    if (!isAdmin) return sendJson(res, 403, { ok: false, error: '需要管理员登录' });
    const body = await readJson(req);
    const target = body?.target === 'admin' ? 'admin' : 'site';
    if (!verifyPw(String(body?.current || ''), auth[target])) return sendJson(res, 401, { ok: false, error: '当前密码不正确' });
    const next = String(body?.next || '');
    if (next.length < 6) return sendJson(res, 400, { ok: false, error: '新密码至少 6 位' });
    auth[target] = makeCred(next);
    // 改密即**吊销所有旧会话**：会话是无状态 HMAC，不换密钥的话旧 cookie 会一直有效到过期 ——
    // 「改了密码但别人还进得来」是这把门钥匙最不该有的行为。
    auth.sessionSecret = crypto.randomBytes(32).toString('hex');
    writeAuth(auth);
    if (target === 'admin') {
      setCookie(res, '', 0);                                        // 管理员自己重登
    } else {
      setCookie(res, issueSession('admin', auth.sessionSecret), SESSION_DAYS * 86400); // 改访问密码别把管理员踢出去
    }
    log(`[admin] ${target} 密码已更新（旧会话已全部吊销）`);
    return sendJson(res, 200, { ok: true, updatedAt: auth[target].updatedAt });
  }

  // ── 首页
  if (p === '/' || p === '/index.html') {
    if (!isAuthed) {
      const login = page('login.html');
      return login ? sendHtml(res, 200, login) : sendHtml(res, 500, '缺少 login.html');
    }
    const idx = page('index.html');
    return idx ? sendHtml(res, 200, idx) : sendHtml(res, 500, '缺少 index.html');
  }

  return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`明道中医 · 问诊台 站点服务已启动 http://127.0.0.1:${PORT}`);
  log(`  首页    http://127.0.0.1:${PORT}/   （未登录会看到登录页）`);
  log(`  后台    http://127.0.0.1:${PORT}/admin  （用管理员密码）`);
});
