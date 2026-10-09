#!/usr/bin/env node
// 文档不变量检查（doc-lint）—— **文档是会漂移的代码**。
//
// 为什么必须有它（不是"锦上添花"，是本项目最痛的那一类缺陷）：
// pack.mjs 的文件头注释曾长期写着「Provider 恒返回 toolCalls:null，工具不会被触发」，
// 而路线 A 早就接线了（dify.mjs 现在真的会返回 toolCalls）。
// 于是任何人打开这个**最核心的文件**，读第一段就会得到一套不存在的架构。
// 同一时期：pack.json 仍写「十问采集」（病历结构已重构）、README 仍写「4 个工具」（实为 5 个）、
// install.sh 仍指向一个已被删除的「待决策」小节、README 说对齐内核 v0.6.7（实际 0.6.10）。
// 全部无人发现 —— 因为**没有任何东西会因为它们变红**。
//
// 设计原则（决定了断言怎么写）：
//   1. **唯一定义处 = 代码**。工具数从 `createPack()` 数出来，不从文档里抄一个数字来比对。
//      抄一份就又变成两处定义，迟早再漂 —— 那正是 FIELD_CN 事故的根因。
//   2. **不制造假警报**。只断言 unambiguous 的事实（计数、标识符、锚点是否存在）。
//      含糊的措辞检查一律不做：假警报刷多了人就不看 lint 了，与"测试假绿"是同一类危害。
//   3. 文档里的计数必须用**阿拉伯数字**书写（如「5 个」而不是「五个」），
//      否则没有稳定模式可匹配 —— 这条本身也是为了让断言保持简单。
//
// 用法：node tools/doc-lint.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 字段表也必须**从 pack.mjs 导入**，不能在这里再抄一份 ——
// 抄一份就又变成两处定义，而"同一份契约定义在两处迟早漂移"正是本项目踩过的事故。
import { createPack, REQUIRED_FIELDS, OPTIONAL_FIELDS, ALL_FIELDS } from '../layer/packs/tcm/pack.mjs';
import { GATE_COUNT, REPO, kernelRoot } from './gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(HERE, '..');
const PACK_DIR = path.join(REPO_DIR, 'layer', 'packs', 'tcm');

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push(`${name}\n      ${e?.message || e}`);
    console.log(`  ✗ ${name}\n      ${e?.message || e}`);
  }
};

/** 读文件；不存在返回 ''（调用方自行断言存在性，避免在这里吞掉差异） */
const read = (rel) => {
  try { return fs.readFileSync(path.join(REPO_DIR, rel), 'utf8'); } catch { return ''; }
};
const readPack = (rel) => {
  try { return fs.readFileSync(path.join(PACK_DIR, rel), 'utf8'); } catch { return ''; }
};

// ───────────────────────── 事实来源：代码，不是文档 ─────────────────────────

const pack = createPack({ home: '', packDir: PACK_DIR, packName: 'tcm', log: () => {} });
const TOOLS = pack.tools.map((t) => String(t.name));
const CONSTRAINTS = (pack.constraints || []).map((c) => String(c.id));
const MANIFEST = JSON.parse(readPack('pack.json'));
const REQUIRED = REQUIRED_FIELDS;
const OPTIONAL = OPTIONAL_FIELDS;

const ROOT_README = read('README.md');
const ARCH = read('docs/ARCHITECTURE.md');
const PACK_README = readPack('README.md');
const INSTALL = read('install.sh');
const CI = read('.github/workflows/ci.yml');
const PREFLIGHT = read('tools/preflight.mjs');
const PACK_MJS = readPack('pack.mjs');

console.log(`\ndoc-lint（文档不变量）  仓库=${REPO_DIR}`);
console.log(`事实来源：代码 —— ${TOOLS.length} 个工具 / ${CONSTRAINTS.length} 条约束 / ${ALL_FIELDS.length} 个字段\n`);

// ── INV-1 工具数：文档里出现的每一个「N 个工具」都必须等于代码里的数量 ──
// 现状：pack README 写「4 个」，ARCHITECTURE 写「5 个」，根 README 枚举「工具一/二/三」——三个数字。
check('INV-1 文档里的工具计数 == createPack() 的 tools.length', () => {
  const pats = [
    ['layer/packs/tcm/README.md', PACK_README, /工具（(\d+) 个/g],
    ['docs/ARCHITECTURE.md', ARCH, /(\d+) 个 Pack 工具/g],
    ['docs/ARCHITECTURE.md', ARCH, /(\d+) 个域工具/g],
    ['README.md', ROOT_README, /(\d+) 个域工具/g],
  ];
  const wrong = [];
  for (const [file, text, re] of pats) {
    for (const m of text.matchAll(re)) {
      if (Number(m[1]) !== TOOLS.length) wrong.push(`${file}: 「${m[0]}」≠ ${TOOLS.length}`);
    }
  }
  if (wrong.length) throw new Error(wrong.join('；') + `。请改成 ${TOOLS.length}（唯一定义处：pack.mjs 的 tools[]）`);
});

// ── INV-2 工具名覆盖：每个已注册工具都必须在两份架构文档里出现 ──
// 只比对数量会漏掉"数量对了但换了一个工具"这种漂移。
check('INV-2 每个已注册工具名都出现在 ARCHITECTURE.md 与 pack README', () => {
  const missing = [];
  for (const t of TOOLS) {
    if (!ARCH.includes(t)) missing.push(`docs/ARCHITECTURE.md 缺 ${t}`);
    if (!PACK_README.includes(t)) missing.push(`layer/packs/tcm/README.md 缺 ${t}`);
  }
  if (missing.length) throw new Error(missing.join('；'));
});

// ── INV-3 字段：必填/可选计数 + 每个字段名都出现在架构文档 ──
// 2026-09-15 病历结构重构后，"十问"→ 门诊病历结构；字段表是医师直接看的东西，
// 文档与代码不一致 = 医师按错的字段表理解病历。
check('INV-3 必填/可选计数与字段名覆盖', () => {
  const wrong = [];
  for (const [file, text] of [['docs/ARCHITECTURE.md', ARCH], ['layer/packs/tcm/README.md', PACK_README]]) {
    for (const m of text.matchAll(/必填（(\d+)）/g)) if (Number(m[1]) !== REQUIRED.length) wrong.push(`${file}: ${m[0]} ≠ ${REQUIRED.length}`);
    for (const m of text.matchAll(/可选（(\d+)）/g)) if (Number(m[1]) !== OPTIONAL.length) wrong.push(`${file}: ${m[0]} ≠ ${OPTIONAL.length}`);
  }
  const missField = ALL_FIELDS.filter((k) => !ARCH.includes(k));
  if (missField.length) wrong.push(`docs/ARCHITECTURE.md 缺字段：${missField.join(', ')}`);
  if (wrong.length) throw new Error(wrong.join('；'));
});

// ── INV-4 pack.mjs 文件头注释必须与当前架构一致 ──
// 这是本 linter 存在的直接原因：那段「工具不会被触发」的注释在路线 A 接线后仍留了很久，
// 而它是新人读 pack.mjs 时看到的第一段话。
check('INV-4 pack.mjs 头部注释不得再断言「工具不会被触发」', () => {
  const head = PACK_MJS.split('\n').slice(0, 30).join('\n'); // 只看文件头
  const stale = [/恒返回\s*toolCalls\s*:\s*null/, /不会被触发/, /永远不会被触发/].filter((re) => re.test(head));
  if (stale.length) {
    throw new Error(
      `pack.mjs 头部仍在陈述「工具不会被触发」（命中：${stale.map(String).join(' ')}）。`
      + '路线 A 已接线：dify.mjs 会返回 toolCalls，工具会被真实触发。'
      + '这段注释会让人得到一套不存在的架构 —— 请改为描述路线 A 现状。'
    );
  }
  if (!/路线\s*A/.test(head)) {
    throw new Error('pack.mjs 头部应写明当前走的是路线 A（谁驱动问诊是这个文件的第一等事实）');
  }
});

// ── INV-5 install.sh 引用的文档小节必须真的存在 ──
// 现状：install.sh 写着「见 layer/packs/tcm/README.md 的『待决策』一节」，而那一节早已改名为「已定：路线 A」。
// 指向不存在的小节 = 装机时按一份不存在的说明操作。
check('INV-5 install.sh 引用的文档锚点存在', () => {
  const refs = [...INSTALL.matchAll(/见\s+([A-Za-z0-9_./-]+\.md)\s*的?[「"']([^」"']+)[」"']/g)];
  if (!refs.length) return; // 没有引用就不断言（不做无根据的强制）
  const bad = [];
  for (const [, file, anchor] of refs) {
    const text = read(file);
    if (!text) { bad.push(`引用的文件不存在：${file}`); continue; }
    const re = new RegExp(`^#{1,6}\\s*.*${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
    if (!re.test(text)) bad.push(`${file} 里没有「${anchor}」这一节（标题里找不到该字样）`);
  }
  if (bad.length) throw new Error(bad.join('；'));
});

// ── INV-6 README 声称对齐的内核版本：在 engines 窗口内，且不落后于实际内核 ──
// 后半条是"新鲜度"检查：内核已经 0.6.10 而 README 仍写 0.6.7，
// 意味着「本层已在 vX 下验证过」这句话自那以后没再被确认过。
check('INV-6 README 声称的内核版本在 engines 窗口内且不落后于实际内核', () => {
  const m = ROOT_README.match(/对齐\s*\*\*MingDao-Harness v(\d+\.\d+\.\d+)\*\*/);
  if (!m) throw new Error('README 里找不到「对齐 **MingDao-Harness vX.Y.Z**」这句 —— 无从判断兼容性陈述');
  const claimed = m[1];
  const range = String(MANIFEST?.engines?.mingdao || '');
  if (!range) throw new Error('pack.json 缺 engines.mingdao —— 无法判定兼容窗口');
  if (!satisfies(claimed, range)) {
    throw new Error(`README 声称对齐 v${claimed}，但它不在 engines 窗口「${range}」内 —— 这句话自相矛盾`);
  }
  const kp = path.join(kernelRoot(), 'package.json');
  if (!fs.existsSync(kp)) {
    console.log('      （内核不在位，跳过"新鲜度"半条：未验证，不代表没问题）');
    return;
  }
  const actual = String(JSON.parse(fs.readFileSync(kp, 'utf8')).version || '');
  if (!actual) return;
  if (cmp(actual, claimed) > 0) {
    throw new Error(
      `README 仍声称对齐 v${claimed}，实际内核已是 v${actual} —— 自 v${claimed} 之后本层没有重新验证过。`
      + `跑一遍 \`npm test\` 确认全绿后，把 README 里的版本号改成 v${actual}。（engines 窗口「${range}」仍然成立。）`
    );
  }
});

// ── INV-7 门禁档数：不得再出现第二份门禁清单 ──
// 现状：ci.yml 注释写「7 档」、preflight 写「八档」、实际跑 9 档 —— 三个数字。
check('INV-7 CI 与 preflight 都从 gates.mjs 取门禁，且写出的档数一致', () => {
  const bad = [];
  for (const [file, text] of [['.github/workflows/ci.yml', CI], ['tools/preflight.mjs', PREFLIGHT]]) {
    if (!/gates\.mjs/.test(text)) bad.push(`${file} 没有引用 tools/gates.mjs —— 门禁清单出现了第二份定义`);
    for (const m of text.matchAll(/(\d+)\s*档门禁/g)) {
      if (Number(m[1]) !== GATE_COUNT) bad.push(`${file}: 「${m[0]}」≠ ${GATE_COUNT} 档`);
    }
  }
  if (bad.length) throw new Error(bad.join('；'));
});

// ── INV-8 「十问」不得再用于描述当前能力 ──
// 病历结构 2026-09-15 已重构为「主诉 + 现病史 + 可选八项」。
// 「十问」只允许出现在历史沿革的叙述里；用它描述**现在**，医师就会按错的字段表理解病历。
check('INV-8 「十问」不得用于描述当前能力', () => {
  const bad = [];
  if (/十问/.test(String(MANIFEST.description || ''))) bad.push(`pack.json 的 description 仍写「十问采集」（实际是门诊病历结构）`);
  if (/十问追问/.test(ROOT_README)) bad.push('README 命令表仍写「首诊：十问追问」');
  const row = (PACK_README.split('\n').find((l) => l.includes('`intake_collect`')) || '');
  if (/十问/.test(row)) bad.push('pack README 的 intake_collect 行仍写「十问结构化」');
  if (bad.length) throw new Error(bad.join('；'));
});

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log(`\n✗ 文档不变量被破坏：\n  ${failures.join('\n  ')}`);
  console.log('\n  修的时候请记住：改文档只是让 lint 变绿；真正的修复是让「定义处」只剩一个。\n');
  process.exit(1);
}
console.log('\n✓ 文档与代码一致。\n');

// ───────────────────────── 下面是纯粹的工具函数 ─────────────────────────

/**
 * 版本补零到三段：`0.5` → `0.5.0`。engines 窗口就是这么写的（`>=0.5 <0.7`），必须认。
 * 用 function 而不是 const：本文件顶层的断言会先于 const 初始化执行（TDZ）。
 */
function pad(v) {
  const p = String(v).split('.').map((x) => Number(x) || 0);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

/** 极简 semver 比较：x[.y[.z]]，返回 -1/0/1 */
function cmp(a, b) {
  const pa = pad(a);
  const pb = pad(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * 判断 version 是否满足 range。只支持 `>=x.y.z` / `>x.y.z` / `<=x.y.z` / `<x.y.z` / `=x.y.z`，
 * 多个子句以空格或 `,` 分隔取 AND —— 够用即可，刻意不实现 ^/~/||：
 * engines 窗口写成 `^0.5` 会让「0.7 算不算兼容」变得靠猜，本项目也不需要那种写法。
 */
function satisfies(version, range) {
  for (const clause of String(range).split(/[\s,]+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})$/.exec(clause.trim());
    if (!m) throw new Error(`engines 子句无法解析：${clause}（只支持 >=,>,<=,<,= 加 x.y.z）`);
    const op = m[1] || '=';
    const d = cmp(version, m[2]);
    const okMap = { '>=': d >= 0, '<=': d <= 0, '>': d > 0, '<': d < 0, '=': d === 0 };
    if (!okMap[op]) return false;
  }
  return true;
}
