// 站点服务的端到端测试：真起进程、跑完整流程。
//   node site/test/site.test.mjs
//
// 为什么值得单独测：这个服务的**全部价值**就是「没密码进不来 + 改密码真的生效 + 下载要登录」。
// 这三条任何一条无声失效，表现都是"页面照常打开"，肉眼看不出来 —— 只能靠断言。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const PORT = 18448 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const INIT_PW = 'test-init-pw-1';

let passed = 0;
let failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}

// ── 临时站点根（public/ 拷一份 + 造两个假安装包）──
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-site-root-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-site-data-'));
fs.cpSync(path.join(SITE, 'public'), ROOT, { recursive: true });
const DL = path.join(ROOT, 'downloads');
fs.mkdirSync(DL, { recursive: true });
fs.writeFileSync(path.join(DL, 'mingdao-tcm-setup-0.9.9-x64.exe'), Buffer.alloc(2048, 7));
fs.writeFileSync(path.join(DL, 'mingdao-tcm-0.9.9-x86_64.AppImage'), Buffer.alloc(1024, 9));
fs.writeFileSync(path.join(DL, 'manifest.json'), JSON.stringify({
  version: '0.9.9',
  files: [
    { name: 'mingdao-tcm-setup-0.9.9-x64.exe', size: 2048, sha256: 'a'.repeat(64) },
    { name: 'mingdao-tcm-0.9.9-x86_64.AppImage', size: 1024, sha256: 'b'.repeat(64) },
  ],
}));

// ── 起服务 ──
const child = spawn(process.execPath, [path.join(SITE, 'server.mjs')], {
  env: { ...process.env, TCM_PORT: String(PORT), TCM_ROOT: ROOT, TCM_DATA: DATA, TCM_INIT_PASSWORD: INIT_PW, TCM_TRUST_PROXY: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/session'); if (r.ok) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const jar = {};
/** 改密前抓下来的那条 cookie —— 用来验证「改密即吊销旧会话」 */
let preChangeSession = '';
function setJar(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of sc) {
    const [kv] = String(c).split(';');
    const i = kv.indexOf('=');
    jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function req(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.auth !== false && cookieHeader()) headers.cookie = cookieHeader();
  const r = await fetch(BASE + p, { ...opts, headers, redirect: 'manual' });
  setJar(r);
  return r;
}
const login = (password) => req('/api/login', {
  method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
});
const clearJar = () => { for (const k of Object.keys(jar)) delete jar[k]; };

console.log('\n[0] 启动');
await testAsync('服务能起来', async () => {
  assert.ok(await waitUp(), '服务未在 9s 内就绪；日志：\n' + serverLog);
});

console.log('\n[1] 密码门（核心：没密码进不来）');
await testAsync('未登录访问 / → 看到登录页，不是首页', async () => {
  const r = await req('/', { auth: false });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /需要访问密码/, '应是登录页');
  assert.ok(!/下载桌面版/.test(html), '绝不能把首页内容发给未登录的人');
});
await testAsync('密码错误 → 401，且不下发会话', async () => {
  clearJar();
  const r = await login('wrong-password');
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.ok(!jar.tcm_session, '失败绝不能给 cookie');
});
await testAsync('密码正确 → 下发 HttpOnly + Secure + SameSite 的会话 cookie', async () => {
  clearJar();
  const r = await login(INIT_PW);
  assert.equal(r.status, 200);
  const sc = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).join(';');
  assert.match(sc, /HttpOnly/i, 'cookie 必须 HttpOnly（防 XSS 偷会话）');
  assert.match(sc, /SameSite=Lax/i);
  assert.ok(/Secure/i.test(sc), '必须 Secure（站点只走 https）');
  assert.ok(jar.tcm_session, '应拿到会话');
});
await testAsync('带会话再访问 / → 拿到真正的首页', async () => {
  const r = await req('/');
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /下载桌面版/, '应看到首页');
  assert.match(html, /明道中医/);
});

await testAsync('★ 使用帮助页始终公开（桌面版菜单直指它，不该被密码门挡住）', async () => {
  const saved = jar.tcm_session;
  clearJar();                                   // 未登录状态
  const r = await req('/help.html', { auth: false });
  assert.equal(r.status, 200, '帮助页应免登录可看');
  const html = await r.text();
  assert.match(html, /使用帮助/);
  assert.match(html, /第一次启动：填密钥/, '帮助页要讲清"密钥自己填"这件事');
  jar.tcm_session = saved;
});

console.log('\n[2] 安装包下载（必须登录）');
await testAsync('/api/downloads 未登录 → 401', async () => {
  const saved = jar.tcm_session;
  clearJar();
  const r = await req('/api/downloads', { auth: false });
  assert.equal(r.status, 401);
  jar.tcm_session = saved;
});
await testAsync('/downloads/<文件> 未登录 → 302 回首页（不能直接拿走安装包）', async () => {
  const saved = jar.tcm_session;
  clearJar();
  const r = await req('/downloads/mingdao-tcm-setup-0.9.9-x64.exe', { auth: false });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  jar.tcm_session = saved;
});
await testAsync('★ /api/latest 免登录，但**只**回版本号（桌面版「检查更新」用它）', async () => {
  const saved = jar.tcm_session;
  clearJar();
  const r = await req('/api/latest', { auth: false });
  assert.equal(r.status, 200, '检查更新必须免登录可用，否则桌面版问不到最新版本');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.version, '0.9.9', '应回清单里的版本');
  // 这是整站唯一的公开面：泄露面必须小到只剩一个版本号
  const raw = JSON.stringify(j);
  for (const leak of ['.deb', '.exe', '.dmg', '.AppImage', 'mingdao-tcm', 'sha256']) {
    assert.ok(!raw.includes(leak), `公开的版本端点不得泄露「${leak}」：${raw}`);
  }
  jar.tcm_session = saved;
});
await testAsync('★ 清单缺失时**报空**，绝不把目录里的半截文件列出来', async () => {
  // 这条对应一个真实缺陷：早先"清单缺失 → 列目录兜底"，于是正在下载的半截安装包
  // 也会进下载卡（实测 97MB 的 dmg 只下了 10MB 就被列出）—— 医师下到的是坏包。
  const mf = path.join(DL, 'manifest.json');
  const bak = fs.readFileSync(mf, 'utf8');
  fs.rmSync(mf);
  try {
    const r = await req('/api/downloads');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.files, [], '清单不在就应报空，而不是列目录：' + JSON.stringify(j.files));
  } finally { fs.writeFileSync(mf, bak); }
});
await testAsync('登录后能拿到安装包本体，且字节数正确', async () => {
  const r = await req('/downloads/mingdao-tcm-setup-0.9.9-x64.exe');
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.length, 2048);
  assert.equal(buf[0], 7, '内容应是那个假包，不是 HTML');
  assert.match(String(r.headers.get('content-disposition')), /attachment/);
});
await testAsync('支持 Range（大文件断点续传）', async () => {
  const r = await req('/downloads/mingdao-tcm-setup-0.9.9-x64.exe', { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.match(String(r.headers.get('content-range')), /^bytes 0-99\/2048$/);
  assert.equal(Buffer.from(await r.arrayBuffer()).length, 100);
});
await testAsync('路径穿越拿不到 public/ 以外的东西', async () => {
  for (const bad of ['../server.mjs', '..%2Fserver.mjs', '%2e%2e%2fserver.mjs', '..././server.mjs']) {
    const r = await req('/downloads/' + bad);
    assert.ok([400, 404, 302].includes(r.status), `${bad} 应被拒，实际 ${r.status}`);
    const t = await r.text();
    assert.ok(!/createServer/.test(t), `${bad} 不该读到服务端源码`);
  }
});

console.log('\n[3] 后台（独立管理员密码）');
// 注意：初始密码**访问/管理相同**（首次部署就是这样，否则装完没人知道密码）。
// 所以想测准「改访问密码」必须先让两个密码分离，否则旧访问密码仍能当管理员登进来 —— 那是测试设计的坑，不是服务的。
await testAsync('初始密码登录即为管理员（所以部署后第一件事就是改掉它）', async () => {
  clearJar();
  assert.equal((await login(INIT_PW)).status, 200);
  const me = await (await req('/api/session')).json();
  assert.equal(me.authed, true);
  assert.equal(me.admin, true);
  assert.equal(me.role, undefined, 'session 接口只回布尔，不该泄露 role');
});
await testAsync('先把管理员密码改成独立的（改管理员密码会清掉当前会话）', async () => {
  const r = await req('/api/admin/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'admin', current: INIT_PW, next: 'admin-pw-A' }),
  });
  assert.equal(r.status, 200);
  assert.ok(!jar.tcm_session, '改管理员密码后应强制重登');
  clearJar();
  assert.equal((await login('admin-pw-A')).status, 200, '新管理员密码应可用');
  assert.equal((await req('/admin')).status, 200, '新管理员密码应能进后台');
});
await testAsync('★ 用「访问密码」拿到的会话进不了后台（后台靠独立的管理员密码）', async () => {
  clearJar();
  assert.equal((await login(INIT_PW)).status, 200, '访问密码此时仍是初始密码');
  const me = await (await req('/api/session')).json();
  assert.equal(me.authed, true);
  assert.equal(me.admin, false, '这应是普通访问会话，不是管理员');
  assert.equal((await req('/admin')).status, 302, '普通会话不能进后台');
  const bad = await req('/api/admin/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'site', current: INIT_PW, next: 'whatever-99' }),
  });
  assert.equal(bad.status, 403, '普通会话改密码必须 403');
});
await testAsync('管理员改访问密码：旧访问密码失效、新访问密码可用', async () => {
  clearJar();
  assert.equal((await login('admin-pw-A')).status, 200);
  preChangeSession = jar.tcm_session; // 抓改密前那条 cookie，下一条测试用它验吊销
  const r = await req('/api/admin/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'site', current: INIT_PW, next: 'new-site-pw-9' }),
  });
  assert.equal(r.status, 200, '改访问密码应成功：' + (await r.text()));
  clearJar();
  assert.equal((await login(INIT_PW)).status, 401, '旧访问密码必须失效');
  assert.equal((await login('new-site-pw-9')).status, 200, '新访问密码必须能用');
  assert.match(await (await req('/')).text(), /下载桌面版/);
});
await testAsync('★ 改密即吊销旧会话（拿改密前那条 cookie 直接打，必须 401）', async () => {
  assert.ok(preChangeSession, '前置测试应已抓到旧 cookie');
  const r = await fetch(BASE + '/api/downloads', { headers: { cookie: `tcm_session=${preChangeSession}` } });
  assert.equal(r.status, 401, '改密后旧会话必须失效（否则"改了密码别人还进得来"）');
});
await testAsync('改访问密码时**不该把正在操作的管理员踢出去**（服务给他续了新 cookie）', async () => {
  // 用新访问密码拿到的只是 viewer，这里重新用管理员登录来验证"管理员连续操作不被中断"
  clearJar();
  assert.equal((await login('admin-pw-A')).status, 200);
  const r = await req('/api/admin/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'site', current: 'new-site-pw-9', next: 'new-site-pw-10' }),
  });
  assert.equal(r.status, 200);
  assert.ok(jar.tcm_session, '改访问密码后管理员应仍持有有效会话');
  assert.equal((await req('/admin')).status, 200, '管理员应仍能进后台（未被踢出）');
});
await testAsync('当前密码不对 → 401；新密码太短 → 400', async () => {
  const bad = await req('/api/admin/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'site', current: 'definitely-wrong', next: 'whatever-1' }),
  });
  assert.equal(bad.status, 401);
  const short = await req('/api/admin/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'site', current: 'new-site-pw-10', next: '123' }),
  });
  assert.equal(short.status, 400, '太短的新密码应被拒');
});

console.log('\n[3b] 社区论坛');
await testAsync('★ 发帖/回帖公开可用；删帖必须管理员密码', async () => {
  clearJar();
  let j = await (await req('/api/forum/posts', { auth: false })).json();
  assert.equal(j.ok, true);
  assert.equal(j.posts.length, 0, '开始应该是空论坛');

  const post = async (b) => (await req('/api/forum/posts', {
    method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  })).json();

  let r = await post({ action: 'post', name: '李医师', title: '复诊对比怎么看', body: '在患者页点开历次病历即可。' });
  assert.equal(r.ok, true, r.error);
  r = await post({ action: 'post', title: '', body: 'x' });
  assert.equal(r.ok, false, '空标题应被拒');

  j = await (await req('/api/forum/posts', { auth: false })).json();
  assert.equal(j.posts.length, 1);
  assert.equal(j.posts[0].name, '李医师');
  const id = j.posts[0].id;

  r = await post({ action: 'reply', postId: id, name: '王医师', body: '谢谢，找到了。' });
  assert.equal(r.ok, true, r.error);
  j = await (await req('/api/forum/posts', { auth: false })).json();
  assert.equal(j.posts[0].replies.length, 1, '回帖应挂在该帖下');

  // 删帖：没有管理员密码必须被挡（公开站点不能让人随手删别人的帖子）
  let d = await (await req('/api/forum/delete', {
    method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, current: 'wrong' }),
  })).json();
  assert.equal(d.ok, false, '错密码不能删帖');
  // 注意：前面的 [3] 已经把管理员密码改成 admin-pw-A（初始密码只用于首登）
  d = await (await req('/api/forum/delete', {
    method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, current: 'admin-pw-A' }),
  })).json();
  assert.equal(d.ok, true, '管理员密码应能删帖：' + JSON.stringify(d));
  j = await (await req('/api/forum/posts', { auth: false })).json();
  assert.equal(j.posts.length, 0);
});
await testAsync('★ 发帖内容按**纯文本**处理：页面必须转义（XSS 入口）', async () => {
  // 服务端存原文（不擅自改写用户内容），所以**页面侧必须转义** —— 这条守住它。
  const html = fs.readFileSync(path.join(SITE, 'public', 'forum.html'), 'utf8');
  for (const t of ['esc(p.title)', 'esc(p.body)', 'esc(r.name)', 'esc(r.body)']) {
    assert.ok(html.includes(t), `forum.html 必须对 ${t} 做转义`);
  }
  assert.match(html, /replace\(\/\[&<>"'\]\/g/, '应有 HTML 转义函数');
  // 发帖是公开的 → 页面里不能把用户内容塞进 innerHTML 而不转义
  assert.ok(!/innerHTML\s*=\s*[^`'"]*\$\{(?!esc\()/.test(html), '不得有未转义的插值写入 innerHTML');
});
await testAsync('★ 发帖限速：短时间内连发会被挡', async () => {
  clearJar();
  let blocked = false;
  for (let i = 0; i < 8; i++) {
    const j = await (await req('/api/forum/posts', {
      method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'post', title: '压力测试 ' + i, body: '内容内容' }),
    })).json();
    if (!j.ok && /频繁/.test(j.error || '')) { blocked = true; break; }
  }
  assert.ok(blocked, '连发应触发限速');
});

console.log('\n[4] 页面观感（能失败的那部分）');
// ★ 用户实测反馈：「网站下载桌面版 linux 的 AppImage 那个**没有背景颜色**」，
//   随后明确要求：**跟其他安装包统一、别搞特殊**。
//   根因是每张卡第 2 个文件走 .dbtn.sec（当时是 background:transparent）——
//   同一片下载区出现两种按钮，Linux 卡的 AppImage 因此看着像禁用。
//   修法是**删掉整套次级样式**，所有安装包按钮一种样式。下面把这点钉住。
await testAsync('★ 下载按钮统一样式：不许有次级/特殊样式，也不许按序号切换', () => {
  const html = fs.readFileSync(path.join(SITE, 'public', 'index.html'), 'utf8');
  assert.ok(!/\.dbtn\.sec/.test(html), '不应存在 .dbtn.sec 之类的次级样式');
  assert.ok(!/class="dbtn\$\{/.test(html), '按钮模板不得按序号/条件切换 class');
  assert.match(html, /class="dbtn" href="\/downloads\//, '按钮模板应固定为同一种 class');
  // 主按钮样式必须是可见底色（防止有人把它也改成透明）
  const m = /\.dbtn\s*\{([^}]*)\}/.exec(html);
  assert.ok(m, '应有 .dbtn 样式');
  assert.match(m[1], /background\s*:\s*(linear-gradient|rgba?)\(/i, '.dbtn 必须有可见底色');
  assert.ok(!/background\s*:\s*transparent/i.test(m[1]), '.dbtn 不能是透明底');
});

console.log('\n[4b] 公开访问模式（TCM_PUBLIC=1）');
// 同一份代码两种模式：上锁（默认，上面全测过了）与公开（分发页）。
// 关键：公开的是**产品页与安装包**，不是后台 —— /admin 仍然要管理员密码。
await testAsync('★ 公开模式：首页直接是首页、清单与下载都免登录，但后台仍要密码', async () => {
  const PORT2 = PORT + 1;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  const child2 = spawn(process.execPath, [path.join(SITE, 'server.mjs')], {
    env: { ...process.env, TCM_PORT: String(PORT2), TCM_ROOT: ROOT, TCM_DATA: DATA, TCM_INIT_PASSWORD: 'pub-init-pw', TCM_TRUST_PROXY: '0', TCM_PUBLIC: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const up = async () => { for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE2 + '/api/session'); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 150)); } return false; };
  try {
    assert.ok(await up(), '公开模式实例未起来');
    const sess = await (await fetch(BASE2 + '/api/session')).json();
    assert.equal(sess.public, true, '/api/session 应报告当前是公开模式');

    const home = await fetch(BASE2 + '/');
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /下载桌面版/, '公开模式首页应直接是产品页，不是登录页');
    assert.ok(!/需要访问密码/.test(html), '公开模式不该再出现登录页');

    const dl = await fetch(BASE2 + '/api/downloads');
    assert.equal(dl.status, 200, '安装包清单应免登录');
    const j = await dl.json();
    assert.ok(j.files.length > 0, '清单应有内容');

    const one = await fetch(BASE2 + '/downloads/' + j.files[0].name);
    assert.equal(one.status, 200, '安装包本体应免登录可下');
    assert.match(String(one.headers.get('content-disposition')), /attachment/);

    // 后台仍然要密码：未登录访问 /admin 应被挡（302 回首页）
    const adm = await fetch(BASE2 + '/admin', { redirect: 'manual' });
    assert.equal(adm.status, 302, '公开模式下后台也必须挡住');
  } finally {
    child2.kill('SIGTERM');
  }
});

console.log('\n[5] 在线爆破限速');
await testAsync('同一 IP 连续试错 → 第 9 次起 429', async () => {
  clearJar();
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await login('brute-force-' + i);
    if (r.status === 429) { got429 = true; break; }
  }
  assert.ok(got429, '连续失败应触发限速');
});

console.log('\n[5] 凭据存储');
await testAsync('auth.json 是 0600 且**不含明文密码**', () => {
  const p = path.join(DATA, 'auth.json');
  const txt = fs.readFileSync(p, 'utf8');
  const mode = fs.statSync(p).mode & 0o777;
  assert.equal(mode, 0o600, `auth.json 权限应为 600，实际 ${mode.toString(8)}`);
  for (const pw of [INIT_PW, 'admin-pw-A', 'new-site-pw-9', 'new-site-pw-10']) {
    assert.ok(!txt.includes(pw), `auth.json 里不该出现明文密码 ${pw}`);
  }
  const j = JSON.parse(txt);
  assert.ok(j.sessionSecret && j.site?.salt && j.site?.hash && j.admin?.hash, '结构应完整');
});

child.kill('SIGTERM');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
