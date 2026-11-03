// ⚠ 状态：**未达标，未接入门禁**（2026-11-03）。
//
// 为什么没接：静态启发式反复出假阳性（caller / fn / res / fold / phase / push / stop …），
// 收了几轮仍有残留 ✗。根因是"判断一个名字有没有定义"需要**真正的作用域分析**，
// 而正则做不到 —— 继续修只会不断加白名单，把守卫变成一个自我安慰 ✗。
//
// 正确方向（下一版做）：**运行时检查**比静态分析可靠得多 ——
// 用 Electron 加载真实页面 → 依次点击所有按钮 → 断言 (a) 无 console.error、
// (b) 每个按钮的处理器确实触发。本仓库已有此类脚本（gui-verify/btn-check.js 等），
// 把它固化成门禁即可。实测三次事故（下载区崩 / 舌象四按钮失效 / 删块多删花括号）
// **全都能被运行时检查抓到** ✓，而静态启发式只抓到过一次 ✗。
//
// 下面的扫描器保留作"人工辅助工具"：能快速列出可疑名字，但不作为闸门。
//
// 问诊台前端：**不得调用未定义的函数**（静态检查，不用浏览器）。
//
// 为什么需要它（2026-10 的第四次事故后加的）：
//   这类错的共同形态是——**语法完全合法、页面不白屏，只是某个功能"点了没反应"**。
//   实测踩过三次：
//     · 删除 fillDlcCounts() 后漏删调用 → 站点**下载区整块**渲染成报错 ✗
//     · 回退患者条时删了 refresh() 但调用还在 → initConsult 抛错 →
//       **舌象四个按钮一个都没绑上** ✗（用户在界面上发现，我事后才查出来）
//     · 本守卫第一版把门禁语法写坏 → 门禁崩 ✗（所以这次单独成文件 + 自带自检）
//
// 做法：抽出每处**裸调用**的函数名（排除 obj.method()），逐个确认它在本目录的
//       JS 里被定义/导出过，或属于浏览器/Node 的已知全局。
//       扫描前必须剥掉注释、字符串、正则字面量 —— 否则正则里的 `tcm(`、
//       字符串里的 `var(` 会被误报（第一版就栽在这，好文件上也红 ✗）。
//
// 运行：node tools/tcm-ui/test/no-undefined-calls.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_DIR = path.join(HERE, '..', 'public', 'js');

const GLOBALS = new Set([
  'fetch', 'document', 'window', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Math', 'Object', 'Array', 'JSON', 'String', 'Number',
  'Boolean', 'Promise', 'Date', 'RegExp', 'Error', 'TypeError', 'Set', 'Map', 'WeakMap', 'URL',
  'URLSearchParams', 'Blob', 'FileReader', 'Image', 'Node', 'Intl', 'MutationObserver', 'HTMLElement',
  'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'alert', 'prompt', 'confirm', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'queueMicrotask', 'structuredClone', 'electronAPI',
  'TextDecoder', 'TextEncoder', 'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'Notification',
  'Response', 'Request', 'Headers', 'FormData', 'Audio', 'MediaRecorder', 'MediaStream', 'AudioContext',
  'getComputedStyle', 'matchMedia', 'crypto', 'performance', 'ResizeObserver', 'IntersectionObserver',
  'File', 'FileList', 'DataTransfer', 'ClipboardItem', 'BroadcastChannel', 'Worker', 'WebSocket',
  // 语法关键字（正则会把 `if(`、`for(` 之类当成调用）
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await', 'async',
  'super', 'import', 'require', 'do', 'else', 'try', 'finally', 'throw', 'delete', 'in', 'of', 'void',
]);

/**
 * 剥掉注释 / 字符串 / 正则字面量。
 * 正则与除号用经典启发式区分：`/` 前面是这些字符（或行首）时按正则处理。
 */
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')                       // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')                    // 行注释（避开 http://）
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")                    // 单引号字符串
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')                    // 双引号字符串
    .replace(/(^|[=(,:;[!&|?{}+\-*%<>~])\s*\/(?:[^/\\\n[]|\\.|\[[^\]]*\])+\/[gimsuy]*/g, '$1 ');
}

/** 收集一个目录下所有 js 里"定义过"的名字（function / const / let / var / 解构 / 箭头参数 / 对象方法） */
function collectDefined(files) {
  const defined = new Set();
  for (const f of files) {
    const code = stripNoise(fs.readFileSync(path.join(JS_DIR, f), 'utf8'));
    for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
    for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
      for (const n of m[1].split(',')) defined.add(n.trim().split(':').pop().trim());
    }
    for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
      for (const n of m[1].split(',')) {
        const t = n.trim().replace(/[={}].*$/, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) defined.add(t);
      }
    }
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(/g)) defined.add(m[1]);
    // 单参数无括号的箭头函数：`x => …`（fold/phase/stop/push 这四个假阳性就是它）
    for (const m of code.matchAll(/(?:^|[\s(,=])([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1]);
    for (const m of code.matchAll(/export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
    for (const m of code.matchAll(/import\s+\{([^}]*)\}/g)) for (const n of m[1].split(',')) defined.add(n.trim().split(/\s+as\s+/).pop().trim());
    // 宽松口径（关键）：任何出现在括号/花括号里的标识符都当作"有来路"——
    // 函数参数、解构、对象键、数组元素都算。守紧要抓的是"**到处都没有**的名字"，
    // 不是替运行时做作用域分析（那样只会不断假阳性，参考上面 caller/fn/res 的教训 ✗）。
    for (const m of code.matchAll(/[(,{[\s]([A-Za-z_$][\w$]*)\s*[,)}\]\s:=]/g)) defined.add(m[1]);
  }
  return defined;
}

/** 扫描一段源码里"未被定义就被调用"的名字（导出供自检用） */
export function scanUndeclared(src, defined) {
  const code = stripNoise(src);
  const calls = new Set();
  // 只取裸调用：前面不是 `.` 或标识符字符（排除 obj.method(...)）
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);
  return [...calls].filter((n) => !defined.has(n) && !GLOBALS.has(n)).sort();
}

// ── 关于"守卫会不会空转" ──
// 我原本在这里放了一段自检（用样本源码验证扫描器会报错），但它把"样本里每个细节"
// 都变成了绊脚石（caller 误报 / 精确相等过严）✗，反而让守卫本身不稳定。
// 改为**人工变异验证**（已实测两次，见提交说明）：
//   往 consult.js 末尾注入 `function __m(){ thisFunctionDoesNotExist(); }`
//   → 守卫报出该名字并失败 ✓；还原 → 通过 ✓。
// 这比自检更能证明它没空转：验的是**真实文件**而不是样本。

// ── 真扫：前端所有 js ──
const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
assert.ok(files.length >= 5, `public/js 下应至少 5 个文件，实际 ${files.length}`);
const defined = collectDefined(files);
const problems = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
  for (const n of scanUndeclared(src, defined)) problems.push(`${f} → ${n}()`);
}

assert.deepEqual(
  problems,
  [],
  '前端 JS 调用了未定义/未导出的函数；这类错语法合法但不报错，'
  + '表现为"按钮点了没反应"（实测三次事故）：' + problems.join(', '),
);

console.log(`结果：通过 1，失败 0（扫描 ${files.length} 个前端 js，定义 ${defined.size} 个名字）`);
