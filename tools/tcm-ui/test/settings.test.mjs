// 设置模块测试：密钥由医师自填，绝不内置、绝不明文回传。
//   node tools/tcm-ui/test/settings.test.mjs
//
// 为什么值得单独测：这一块一旦错了，表现要么是"填了密钥不起作用"（写的位置/格式与内核不一致），
// 要么是"密钥被明文回给浏览器"（截图即泄露）。两种都不会报错，只能靠断言。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..');
const { readSettings, writeSettings, maskKey } = await import(pathToFileURL(path.join(UI, 'settings.mjs')).href);
const { startUiServer } = await import(pathToFileURL(path.join(UI, 'server.mjs')).href);

let passed = 0, failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}
const freshHome = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-set-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' }, null, 2));
  return d;
};

console.log('\n[1] 脱敏');
await testAsync('短密钥不能"脱敏后等于明文"', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('abcd1234'), 'a****4');
  assert.ok(!maskKey('abcd1234').includes('bcd123'));
  assert.equal(maskKey('app-abcdefghijklmnop'), 'app-****mnop');
  assert.ok(!maskKey('app-abcdefghijklmnop').includes('efghij'));
});

console.log('\n[2] 读写语义');
await testAsync('空 home：读出来是"未配置"，且默认地址与 provider 默认一致', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-empty-'));
  try {
    const s = readSettings(h);
    assert.equal(s.difyKeySet, false);
    assert.equal(s.difyBaseUrl, 'https://dify.mingdaotcm.cn');
    assert.equal(s.routeA, false);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
await testAsync('★ 留空 = 不改：只填 Dify Key 时，已有的 DeepSeek Key 不能被抹掉', () => {
  const h = freshHome();
  try {
    assert.equal(writeSettings(h, { difyKey: 'app-dify-000111', orchKey: 'sk-deep-222333' }).ok, true);
    const r = writeSettings(h, { difyBaseUrl: 'https://dify.example.com' });   // 只改地址
    assert.equal(r.ok, true, r.error);
    const creds = JSON.parse(fs.readFileSync(path.join(h, 'credentials.json'), 'utf8'));
    assert.equal(creds.dify, 'app-dify-000111', '密钥不该被空值覆盖');
    assert.equal(creds.deepseek, 'sk-deep-222333', '另一个密钥更不该被连带抹掉');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
await testAsync('★ 配好 Dify Key 才切路线 A，并删掉会压过 Dify 端点的顶层 baseUrl', () => {
  const h = freshHome();
  try {
    writeSettings(h, { orchKey: 'sk-deep-222333' });   // 只有 DeepSeek key
    let cfg = JSON.parse(fs.readFileSync(path.join(h, 'config.json'), 'utf8'));
    assert.equal(cfg.provider, 'deepseek', '没有 Dify Key 时不该切过去（切了就用不了）');
    writeSettings(h, { difyKey: 'app-dify-000111' });
    cfg = JSON.parse(fs.readFileSync(path.join(h, 'config.json'), 'utf8'));
    assert.equal(cfg.provider, 'dify');
    assert.equal(cfg.model, 'dify-chatflow');
    assert.ok(!('baseUrl' in cfg), '顶层 baseUrl 会压过 Dify 端点（见 dify.mjs 的说明）');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
await testAsync('校验：带空白的密钥 / 非 http 地址 / 过短的密钥都要被挡住', () => {
  const h = freshHome();
  try {
    assert.equal(writeSettings(h, { difyKey: 'app-abc def ghi' }).ok, false, '含空格应被拒（多半是粘贴带上了空白）');
    assert.equal(writeSettings(h, { difyKey: 'short' }).ok, false, '过短应被拒');
    assert.equal(writeSettings(h, { difyBaseUrl: 'dify.example.com' }).ok, false, '缺协议应被拒');
    assert.equal(writeSettings(h, { orchBaseUrl: 'ftp://x/y' }).ok, false);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
await testAsync('写盘：credentials.json 必须是 0600，且密钥不被写进 config.json', () => {
  const h = freshHome();
  try {
    writeSettings(h, { difyKey: 'app-dify-000111', orchKey: 'sk-deep-222333' });
    const credPath = path.join(h, 'credentials.json');
    assert.equal(fs.statSync(credPath).mode & 0o777, 0o600, '凭据文件权限应为 600');
    const cfgRaw = fs.readFileSync(path.join(h, 'config.json'), 'utf8');
    assert.ok(!cfgRaw.includes('app-dify-000111') && !cfgRaw.includes('sk-deep-222333'),
      'config.json 不该出现任何密钥（它是可分享/可提交的那个文件）');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

console.log('\n[3] 端点：绝对不能把明文回给浏览器');
await testAsync('★ GET /api/tcm/settings 只回脱敏值；POST 能写入', async () => {
  const h = freshHome();
  let ui = null;
  try {
    ui = await startUiServer({ target: 'http://127.0.0.1:1', port: 0, home: h, quiet: true, currentVersion: '9.9.9' });
    let r = await fetch(ui.url + 'api/tcm/settings');
    let j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.currentVersion, '9.9.9', '页面「关于」要显示版本号');
    assert.equal(j.settings.difyKeySet, false);

    r = await fetch(ui.url + 'api/tcm/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difyKey: 'app-secret-abcdefg', orchKey: 'sk-secret-abcdefg' }),
    });
    j = await r.json();
    assert.equal(j.ok, true, j.error);

    r = await fetch(ui.url + 'api/tcm/settings');
    const raw = await r.text();
    assert.ok(!raw.includes('app-secret-abcdefg'), 'GET 绝不能回明文 Dify Key');
    assert.ok(!raw.includes('sk-secret-abcdefg'), 'GET 绝不能回明文 DeepSeek Key');
    assert.match(raw, /app-\*\*\*\*defg/, '应回脱敏值（前 4 + 后 4）：' + raw.slice(0, 200));
    const j2 = JSON.parse(raw);
    assert.equal(j2.settings.routeA, true, '配好 Dify Key 后应显示走路线 A');
  } finally {
    if (ui) await ui.close();
    fs.rmSync(h, { recursive: true, force: true });
  }
});

console.log('\n[4] 仓库卫生：密钥不许内置');
// 用户明确要求「密钥设置成一个模块，供用户自行填写、修改，**不内置在 MingDao-TCM-Harness**」。
// 这条守住这条线：仓库里出现 `sk-…` / `app-…` 这类真密钥就红。
await testAsync('★ 仓库里不得出现内置密钥（只有设置模块负责收用户输入）', () => {
  const REPO = path.resolve(HERE, '..', '..', '..');
  const exts = new Set(['.mjs', '.js', '.json', '.html', '.yml', '.yaml', '.md', '.css']);
  const skipDir = new Set(['node_modules', '.git', 'dist', 'out', 'site-downloads']);
  const hits = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    for (const name of fs.readdirSync(dir)) {
      if (skipDir.has(name)) continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!exts.has(path.extname(name))) continue;
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      // 真密钥形态：sk-/app- 后面跟一长串无空白字符（测试夹具里的假 key 都带连字符分段，不会命中）
      for (const re of [/\bsk-[A-Za-z0-9]{24,}/g, /\bapp-[A-Za-z0-9]{24,}/g]) {
        const m = txt.match(re);
        if (m) hits.push(`${path.relative(REPO, p)}: ${m[0].slice(0, 12)}…`);
      }
    }
  };
  walk(REPO);
  assert.deepEqual(hits, [], '仓库里不该有内置密钥：\n      ' + hits.join('\n      '));
});

console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
