// 桌面版编排层测试（纯 Node —— 不需要图形环境）。
//
// 为什么这层要单独测：Electron 必须在有 X server 的机器上才能起来，CI/开发机常常没有。
// 把「起内核 + 起问诊台 + 两边都真能访问」这段逻辑放在 orchestrator.mjs 里，
// 就能在这里**端到端验证**；main.js 只剩开窗口/托盘，属于照抄内核 desktop/ 的成熟写法。
//
// main.js 自身没法在这里运行，但它的**静态完整性**（语法 / 引用的文件存在 / 关键导出名）
// 仍然可以断言 —— 少一个导出、路径写错，在桌面机上就是"双击没反应"。
//
// 运行：node tools/tcm-ui/test/desktop-orchestrator.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAppRoot, resolveKernelRoot, startApp, versionGt, checkForUpdate, installLayer } from '../desktop/orchestrator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(UI_DIR, '..', '..');
const KERNEL = process.env.MINGDAO_KERNEL || path.resolve(REPO, '..', 'MingDao-Harness');

let passed = 0;
let failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}

console.log('\n[1] 路径解析');
await testAsync('resolveAppRoot：开发态解析到仓库根（其下有 layer/ 与 tools/tcm-ui）', () => {
  const root = resolveAppRoot({ here: path.join(UI_DIR, 'desktop') });
  assert.equal(root, REPO);
  assert.ok(fs.existsSync(path.join(root, 'layer', 'packs', 'tcm', 'pack.mjs')));
  assert.ok(fs.existsSync(path.join(root, 'tools', 'tcm-ui', 'server.mjs')));
});
await testAsync('resolveAppRoot：打包态解析到 resources/app', () => {
  assert.equal(resolveAppRoot({ packaged: true, resourcesPath: '/x/resources' }), path.join('/x/resources', 'app'));
});
await testAsync('resolveKernelRoot：找到内核（有 src/web/server.js）', () => {
  const root = resolveKernelRoot({ appRoot: REPO, explicit: KERNEL });
  assert.ok(root, '应能解析出内核目录');
  assert.ok(fs.existsSync(path.join(root, 'src', 'web', 'server.js')));
});
await testAsync('resolveKernelRoot：找不到时返回 null（调用方据此给可操作报错）', () => {
  // ⚠ 必须先清掉 MINGDAO_KERNEL：CI 里门禁命令要用它，所以那个环境变量是**设着**的，
  // 而这条断言的语义恰恰是「哪儿都找不到」——不清就等于在测另一个场景。
  // （本机不设该变量，所以它一直在本地是绿的，是 GitHub CI 先把它照出来的。）
  const saved = process.env.MINGDAO_KERNEL;
  delete process.env.MINGDAO_KERNEL;
  try {
    assert.equal(resolveKernelRoot({ explicit: '/nonexistent-kernel-xyz', appRoot: '/nonexistent-app' }), null);
  } finally {
    if (saved !== undefined) process.env.MINGDAO_KERNEL = saved;
  }
});
await testAsync('resolveKernelRoot：显式传入优先于 MINGDAO_KERNEL 环境变量', () => {
  const saved = process.env.MINGDAO_KERNEL;
  process.env.MINGDAO_KERNEL = '/definitely-not-a-kernel';
  try {
    assert.equal(resolveKernelRoot({ explicit: KERNEL }), KERNEL, '显式给的内核必须赢过环境变量');
  } finally {
    if (saved === undefined) delete process.env.MINGDAO_KERNEL; else process.env.MINGDAO_KERNEL = saved;
  }
});

console.log('\n[2] 端到端（真起内核 + 真起问诊台）');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-desktop-test-'));
const d20 = new Date(Date.now() - 20 * 86400000).toISOString();
fs.mkdirSync(path.join(HOME, 'intake', 'P001'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'patients.json'), JSON.stringify({
  nextId: 2, patients: { P001: { id: 'P001', name: '张三', birth: '1990', sex: '男', lastVisitAt: d20, visits: 1 } },
}));
fs.writeFileSync(path.join(HOME, 'intake', 'P001', 'case-1000.json'), JSON.stringify({ patientId: 'P001', collectedAt: d20, zhushu: '失眠', xianbingshi: '三月前入睡困难' }));

/** @type {any} */
let app = null;
await testAsync('startApp：内核与问诊台都起来了，且拿到两个地址', async () => {
  process.env.MINGDAO_HOME = HOME; // 内核从环境变量读 MINGDAO_HOME
  app = await startApp({ appRoot: REPO, kernelRoot: KERNEL, home: HOME, uiPort: 0, quiet: true });
  assert.ok(app.kernelPort > 0, '内核应拿到端口');
  assert.ok(app.uiPort > 0, '问诊台应拿到端口（0 = 让系统分配）');
  assert.match(app.uiUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});
await testAsync('问诊台自带端点可用：/api/tcm/patients + /api/tcm/reminders', async () => {
  const r1 = await fetch(app.uiUrl + 'api/tcm/patients');
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.patients[0].id, 'P001');
  assert.equal(j1.patients[0].status, 'overdue', '20 天未复诊应判超期');
  const r2 = await fetch(app.uiUrl + 'api/tcm/reminders');
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).counts.overdue, 1);
});
await testAsync('★ 转发链路可用：/api/state 经代理打到内核（token 在进程内带上）', async () => {
  const r = await fetch(app.uiUrl + 'api/state');
  assert.equal(r.status, 200, '代理应把 /api/* 转发给内核');
  const j = await r.json();
  assert.equal(j.ok, true, '内核返回的 state 应是 ok:true');
});
// ★ 2026-09-24 用户报「似乎没有调用 Dify 工作流」。根因：内核只从 $MINGDAO_HOME/{packs,providers}
//   加载扩展，而打包产物把它们放在 resources/app/layer/... —— 此前**没有任何一步做安装**，
//   干净机器上打开桌面版得到的是裸内核：没有 tcm 工具、没有 dify provider、provider 还是 deepseek。
//   这条断言把「首启必须把垂域层装进 home，并把 provider 指向 Dify」钉住。
await testAsync('★ 全新 home：必须装上 Pack/Provider，并让内核真的挂载 tcm、问诊走 Dify', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-fresh-home-'));
  /** @type {any} */
  let app2 = null;
  const captured = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  // 内核把"已加载垂域 Pack"打在 **console.error** 上（src/web/server.js），横幅打在 stdout —— 三个都截
  console.log = (...a) => { captured.push(a.map(String).join(' ')); };
  console.warn = (...a) => { captured.push(a.map(String).join(' ')); };
  console.error = (...a) => { captured.push(a.map(String).join(' ')); };
  try {
    app2 = await startApp({ appRoot: REPO, kernelRoot: KERNEL, home: fresh, uiPort: 0, quiet: true });
  } finally { console.log = origLog; console.warn = origWarn; console.error = origErr; }
  try {
    assert.ok(fs.existsSync(path.join(fresh, 'packs', 'tcm', 'pack.mjs')), '必须把打包的 tcm Pack 装进 home');
    assert.ok(fs.existsSync(path.join(fresh, 'providers', 'dify.mjs')), '必须把 dify provider 装进 home');
    assert.equal(app2.layer.pack, '已安装');
    assert.equal(app2.layer.provider, '已安装');
    const cfg = JSON.parse(fs.readFileSync(path.join(fresh, 'config.json'), 'utf8'));
    assert.equal(cfg.provider, 'dify', '问诊必须走 Dify 工作流（路线 A），不能停在 deepseek 直连');
    assert.equal(cfg.model, 'dify-chatflow');
    assert.ok(!('baseUrl' in cfg), '顶层 baseUrl 会压过 Dify 端点（provider 源码明说不要写）——必须删掉');
    // 只验"文件在盘上"不够：要内核**真的挂载**了它
    assert.ok(captured.some((l) => /已加载垂域 Pack.*\btcm\b/.test(l)),
      '内核应挂载 tcm Pack；实际日志：' + captured.join(' | ').slice(0, 300));
  } finally {
    if (app2) await app2.close();
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

// ★ 这条对应**用户实测报回来的缺陷**（2026-09-23 装上桌面版就看到「未配置数据目录」）：
//   桌面版里 MINGDAO_HOME **是空的**（命令行下启动脚本会设它，所以本机与原来的单测都没暴露），
//   于是「内核用 ~/.mingdao、界面拿到空串」。修法是向内核要它解析的结果；这条把那个组合钉住。
await testAsync('★ MINGDAO_HOME 为空时，也必须把内核解析出的数据目录交给界面', async () => {
  const savedHome = process.env.HOME;
  const savedMh = process.env.MINGDAO_HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-fake-home-'));
  process.env.HOME = fakeHome;      // mingdaoHome() 走 os.homedir()，POSIX 上就是 $HOME
  delete process.env.MINGDAO_HOME;  // ← 桌面版的真实情况：这个变量根本没设
  /** @type {any} */
  let app2 = null;
  try {
    app2 = await startApp({ appRoot: REPO, kernelRoot: KERNEL, uiPort: 0, quiet: true });
    assert.equal(app2.home, path.join(fakeHome, '.mingdao'), '界面拿到的主目录必须与内核解析的一致');
    const r = await fetch(app2.uiUrl + 'api/tcm/reminders');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true, '不能是「未配置数据目录」：' + JSON.stringify(j));
    assert.ok(j.counts, '应返回提醒计数（哪怕是 0）');
  } finally {
    if (app2) await app2.close();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedMh !== undefined) process.env.MINGDAO_HOME = savedMh;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
await testAsync('界面静态资源可用（打开的就是这个前端）', async () => {
  const r = await fetch(app.uiUrl);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /明道中医/);
  assert.match(html, /\/js\/app\.js/);
});
await testAsync('close()：能干净关掉（不留住进程）', async () => {
  await app.close();
  await assert.rejects(fetch(app.uiUrl + 'api/tcm/reminders'), '关闭后不应再能访问');
});

console.log('\n[3] Electron 壳的静态完整性（这里跑不了 Electron，但能挡住"双击没反应"类错误）');
const DESKTOP = path.join(UI_DIR, 'desktop');
await testAsync('main.js / orchestrator.mjs / package.json / electron-builder.yml 都在', () => {
  for (const f of ['main.js', 'orchestrator.mjs', 'package.json', 'electron-builder.yml']) {
    assert.ok(fs.existsSync(path.join(DESKTOP, f)), `缺文件：desktop/${f}`);
  }
});
await testAsync('package.json：main 指向 main.js，且声明了 electron 依赖与 type=module', () => {
  const p = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
  assert.equal(p.main, 'main.js');
  assert.equal(p.type, 'module', 'Electron 28+ 的主进程 ESM 需要 type=module');
  assert.ok(p.devDependencies?.electron, '应声明 electron 依赖');
  assert.ok(p.scripts?.start, '应能用 npm start 起');
});
await testAsync('main.js：只从 orchestrator 取逻辑，且引用的导出都真的存在', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const orch = fs.readFileSync(path.join(DESKTOP, 'orchestrator.mjs'), 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/orchestrator\.mjs'/g)) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      assert.ok(new RegExp('export\\s+(?:async\\s+)?(?:function|const)\\s+' + name + '(?=[^\\w$])').test(orch),
        `main.js 引入了 orchestrator 的 ${name}，但后者未导出`);
    }
  }
});
await testAsync('★ main.js 不做「起服务」的活（那是 orchestrator 的职责，也才测得到）', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  assert.ok(!/runWebServer\s*\(/.test(src), 'main.js 不该自己起内核 —— 那样就没法在无图形环境验证了');
  assert.ok(!/startUiServer\s*\(/.test(src), 'main.js 不该自己起代理');
  assert.ok(!/http\.createServer/.test(src), 'main.js 不该自己建 http 服务');
});
await testAsync('electron-builder.yml：内核与问诊台都被 extraResources 带上', () => {
  const y = fs.readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8');
  assert.ok(/extraResources:/.test(y), '需要 extraResources 才能把内核/前端带进安装包');
  assert.ok(/to:\s*app\b/.test(y), '问诊台与 layer 要落到 resources/app（保持相对布局）');
  assert.ok(/to:\s*kernel\b/.test(y), '内核要落到 resources/kernel');
  assert.ok(/npmmirror|mirror/.test(y), '国内下载 electron 需要镜像（照抄内核 desktop 的做法）');
});

// ── 桌面版「帮助 → 检查更新」的逻辑（放在纯 Node 层就是为了能在这里测）──
await testAsync('★ 版本比较：必须按数字比，不能按字符串比', () => {
  assert.equal(versionGt('0.1.5', '0.1.4'), true);
  assert.equal(versionGt('0.2.0', '0.1.9'), true);
  assert.equal(versionGt('1.0.0', '0.9.9'), true);
  assert.equal(versionGt('0.1.4', '0.1.4'), false);
  assert.equal(versionGt('0.1.3', '0.1.4'), false);
  assert.equal(versionGt('v0.1.5', '0.1.4'), true, '带 v 前缀也要认');
  // 字符串比较会得出 "0.1.10" < "0.1.9" —— 这正是要数字比的原因
  assert.equal(versionGt('0.1.10', '0.1.9'), true);
  assert.equal(versionGt('', '0.1.4'), false);
});
await testAsync('★ 检查更新：四种结果都有明确答案，且**永不抛错**（点了没反应比查不到更糟）', async () => {
  const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  assert.equal((await checkForUpdate({ siteUrl: 'https://s', current: '0.1.4', fetchImpl: ok({ version: '0.1.5' }) })).status, 'newer');
  assert.equal((await checkForUpdate({ siteUrl: 'https://s', current: '0.1.4', fetchImpl: ok({ version: '0.1.4' }) })).status, 'current');
  assert.equal((await checkForUpdate({ siteUrl: 'https://s', current: '0.1.4', fetchImpl: ok({ version: '0.1.3' }) })).status, 'current', '站点比本机旧也算已最新');
  const http = await checkForUpdate({ siteUrl: 'https://s', current: '0.1.4', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(http.status, 'unknown');
  assert.match(http.reason, /500/, 'HTTP 失败也要有可读原因');
  const to = await checkForUpdate({ siteUrl: 'https://s', current: '0.1.4', fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
  assert.equal(to.status, 'unknown');
  assert.equal(to.reason, '请求超时');
  const empty = await checkForUpdate({ siteUrl: 'https://s', current: '0.1.4', fetchImpl: ok({}) });
  assert.equal(empty.status, 'unknown');
  assert.match(empty.reason, /还没有已发布/);
  assert.equal((await checkForUpdate({ siteUrl: '', current: '0.1.4' })).status, 'unknown');
});

// ★ 2026-09-24：打包 filter 里漏了 `layer/providers/**`，产物只有 Pack 没有 Dify Provider
//   → 桌面版起不来（或补个 baseUrl 就变成"问诊绕过 Dify"）。本机是开发态、直接读仓库，
//   所以这个缺陷**本机跑不出来**。这条测试按 electron-builder 的 filter 组装一个模拟的
//   resources/app，再让 installLayer 去装 —— filter 少一行就会红。
await testAsync('★ 打包布局：按 electron-builder 的 filter 组装产物，垂域层必须装得进去', async () => {
  const yml = fs.readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8');
  // 解析要**容忍注释与否定模式**（filter 块里现在有说明注释，还会用 '!xxx' 排除子目录）
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /to:\s*app\s*$/.test(l));
  assert.ok(start >= 0, '应能从 electron-builder.yml 找到 `to: app`');
  const pats = [];
  for (let k = start + 1; k < lines.length; k++) {
    if (/^\s*-\s*from:/.test(lines[k])) break;                 // 下一条 extraResources
    const m = /^\s*-\s*'?([^'\s#]+)'?\s*(?:#.*)?$/.exec(lines[k]);
    if (m && m[1] !== 'filter:') pats.push(m[1]);
  }
  assert.ok(pats.length > 0, '应能解析出 filter 列表，实际：' + JSON.stringify(pats));
  assert.ok(pats.some((p) => p.startsWith('layer/providers/')), 'filter 必须带上 layer/providers/**');
  assert.ok(pats.some((p) => p.startsWith('layer/packs/')), 'filter 必须带上 layer/packs/tcm/**');

  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-pkg-'));
  const appDir = path.join(pkg, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const raw of pats) {
    if (raw.startsWith('!')) continue;          // 否定模式不参与"要带哪些"
    const rel = raw.replace(/\/\*\*$/, '');
    const src = path.join(REPO, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(appDir, rel);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  }
  const pkgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-pkg-home-'));
  try {
    const layer = installLayer({ home: pkgHome, appRoot: appDir });
    assert.equal(layer.provider, '已安装', '按打包 filter 组装的产物里必须有 dify provider：' + JSON.stringify(layer));
    assert.equal(layer.pack, '已安装', 'Pack 也要能装进去：' + JSON.stringify(layer));
    assert.ok(fs.existsSync(path.join(pkgHome, 'providers', 'dify.mjs')));

    // ★ 通用守卫：server.mjs 里 import 的**每一个**本地模块都必须落在产物里。
    //   逐个文件列举的 filter 漏一个就是"装完起不来"（2026-09-24 连着栽两次：
    //   先漏 layer/providers/**，后漏 tools/tcm-ui/settings.mjs —— 后者是 CI 冒烟
    //   报 Cannot find module 才发现的）。这条断言把整类问题一次挡住。
    const srv = fs.readFileSync(path.join(appDir, 'tools', 'tcm-ui', 'server.mjs'), 'utf8');
    const rels = [...srv.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
    assert.ok(rels.length > 0, '应能从 server.mjs 解析出本地 import');
    const missing = rels
      .map((r) => path.resolve(path.join(appDir, 'tools', 'tcm-ui'), r))
      .filter((abs) => !fs.existsSync(abs))
      .map((abs) => path.relative(appDir, abs));
    assert.deepEqual(missing, [], '产物里缺少被 import 的模块（打包 filter 漏了？）：' + missing.join(', '));
    assert.ok(fs.existsSync(path.join(pkgHome, 'packs', 'tcm', 'pack.mjs')));
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
    fs.rmSync(pkgHome, { recursive: true, force: true });
  }
});

// ★ 2026-09-24 CI 冒烟实测：产物里内核版本是 **0.0.0**（只带了 src/、没带 package.json）
//   → 垂域 Pack 的 engines 窗口校验失败 → **Pack 被静默跳过** → 没有 tcm 工具、问诊不走 Dify。
//   这条按 electron-builder 的条目**真的拼一个 kernel/ 出来**，再问内核自己"你是几版" ——
//   比断言 yml 里有某个字符串强得多。
await testAsync('★ 打包后的内核必须报得出真实版本（否则 Pack 被 engines 校验跳过）', async () => {
  const yml = fs.readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /to:\s*kernel\/package\.json/, 'extraResources 必须把内核 package.json 带进 kernel/');
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-kernel-pkg-'));
  const kdir = path.join(pkgRoot, 'kernel');
  fs.cpSync(path.join(KERNEL, 'src'), path.join(kdir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(KERNEL, 'package.json'), path.join(kdir, 'package.json'));
  try {
    const mod = await import(pathToFileURL(path.join(kdir, 'src', 'packs.js')).href);
    const v = mod.coreVersionOf();
    assert.notEqual(v, '0.0.0', '打包后的内核必须读到真实版本；0.0.0 会让垂域 Pack 被跳过');
    assert.match(v, /^\d+\.\d+\.\d+/, '版本号应形如 x.y.z：' + v);
  } finally { fs.rmSync(pkgRoot, { recursive: true, force: true }); }
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
