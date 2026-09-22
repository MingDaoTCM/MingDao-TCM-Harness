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
import { fileURLToPath } from 'node:url';
import { resolveAppRoot, resolveKernelRoot, startApp } from '../desktop/orchestrator.mjs';

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

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
