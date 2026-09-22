// 问诊台前端「接线」测试。
//
// 为什么单独测接线：拆成多文件后最容易坏的不是逻辑，而是**接线** ——
// 少一个 id、import 了一个不存在的导出、public 下漏了一个文件。
// 这些在浏览器里表现为「整页白屏」或「点按钮没反应」，而服务端门禁看不见。
// 没有无头浏览器可用时，就把静态接线变成断言（真正跑页面仍是人工验收）。
//
// 运行：node tools/tcm-ui/test/ui-wiring.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '..', 'public');
const JS_DIR = path.join(PUBLIC, 'js');
const read = (p) => fs.readFileSync(p, 'utf8');
const html = () => read(path.join(PUBLIC, 'index.html'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}

console.log('\n[1] 静态资源');
test('index.html 引用的每个静态资源都真实存在', () => {
  const refs = [...html().matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.includes('/app.css'), '应引用 /app.css');
  assert.ok(refs.includes('/js/app.js'), '应引用 /js/app.js');
  for (const r of refs) assert.ok(fs.existsSync(path.join(PUBLIC, r)), `index.html 引用了 ${r}，但文件不存在`);
});
test('入口是 module 脚本（拆多文件后不能再是普通 script）', () => {
  assert.ok(/<script[^>]+type="module"[^>]+src="\/js\/app\.js"/.test(html()), 'index.html 应以 ES module 加载 /js/app.js');
});

console.log('\n[2] DOM 接线');
test('JS 里 $(\'#id\') 引用的 id 都在 index.html 定义（动态生成的除外）', () => {
  const ids = new Set([...html().matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const f of fs.readdirSync(JS_DIR)) {
    for (const m of read(path.join(JS_DIR, f)).matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) {
      if (!ids.has(m[1])) missing.push(`${f}: #${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], '这些 id 在 index.html 里找不到：' + missing.join('、'));
});
test('每个 tab 的 data-view 都有对应的 #view-<name> 容器', () => {
  const h = html();
  const views = [...h.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(views.length >= 2, '至少应有「问诊 / 患者」两个视图');
  for (const v of views) assert.ok(new RegExp('id="view-' + v + '"').test(h), `tab ${v} 没有对应的 #view-${v}`);
});

console.log('\n[3] 模块依赖');
test('跨模块 import 的符号都真的被导出', () => {
  const problems = [];
  for (const f of fs.readdirSync(JS_DIR)) {
    const src = read(path.join(JS_DIR, f));
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([A-Za-z0-9_-]+)\.js'/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      const depPath = path.join(JS_DIR, m[2] + '.js');
      if (!fs.existsSync(depPath)) { problems.push(`${f} → ${m[2]}.js（文件不存在）`); continue; }
      const dep = read(depPath);
      for (const n of names) {
        const id = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const ok = new RegExp('export\\s+(?:const|let|var|function|async\\s+function|class)\\s+' + id + '(?=[^\\w$])').test(dep)
          || new RegExp('export\\s*\\{[^}]*\\b' + id + '\\b').test(dep);
        if (!ok) problems.push(`${f} 从 ${m[2]}.js 引入 ${n}，但后者未导出`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('；'));
});
test('★ 记录渲染路径（patients.js）不认识任何字段名 —— 字段语义只在 Pack / 服务端', () => {
  // 这是 P0 复诊修复的同类防线：把病历**渲染回给医师**的路径必须由服务端下发 label/value，
  // 前端一旦自己认字段名，重构后就会静默错位（Provider 就是这样丢字段的）。
  const fieldKeys = ['zhushu', 'xianbingshi', 'jiwangshi', 'jiazushi', 'guominshi', 'liuxingbingshi', 'tigejiancha', 'shexiang', 'maixiang', 'suifang'];
  const offenders = fieldKeys.filter((k) => new RegExp('(?<![\\w_])' + k + '(?![\\w_])').test(read(path.join(JS_DIR, 'patients.js'))));
  assert.deepEqual(offenders, [], 'patients.js 出现了字段键（应由服务端按 Pack 渲染后下发）：' + offenders.join('、'));
});
test('问诊表单：OPT_FIELDS 的每个键都在 index.html 有对应控件（表单自身不漂移）', () => {
  // 表单是**输入面**，天然要逐个列出字段（每个控件有自己的 placeholder / 类型），
  // 所以这里**允许**出现字段键；但 HTML 与 consult.js 之间不能互相漂移 —— 那会变成
  // 「填了没进消息」或「消息里有、控件不存在」。
  const h = html();
  const htmlKeys = new Set([...h.matchAll(/id="f_([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  const block = /const OPT_FIELDS = \[([\s\S]*?)\];/.exec(read(path.join(JS_DIR, 'consult.js')));
  assert.ok(block, 'consult.js 应有 OPT_FIELDS');
  const optKeys = [...block[1].matchAll(/\['([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(optKeys.length >= 8, 'OPT_FIELDS 应覆盖可选字段');
  for (const k of optKeys) assert.ok(htmlKeys.has(k), `OPT_FIELDS 里的 ${k} 在 index.html 没有 #f_${k} 控件`);
  for (const k of ['zhushu', 'xianbingshi']) assert.ok(htmlKeys.has(k), `必填字段 ${k} 缺少控件`);
});

console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
