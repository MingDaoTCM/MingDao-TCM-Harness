#!/usr/bin/env node
// 统一门禁入口：`npm test` 跑的就是它。
//
// 为什么要有它：门禁此前只以「ci.yml 里的一段内联命令」的形式存在。
// 于是本机想跑全套，只能把那 9 行手抄一遍 —— 人不跑的理由只要一条就够了：
// 「我记得 CI 会跑」。而 CI 只在 push/PR 时跑，等你看到红的时候已经合进去了。
// 一条命令能跑全套，是「跑门禁」这件事发生的必要条件。
//
// 用法：
//   node tools/run-gates.mjs            # 全部
//   node tools/run-gates.mjs dify site  # 只跑指定几档（按 id）
//
// 退出码：任一档失败 → 1；**一档都没真正执行** → 1（"没验证过"不等于"没问题"）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GATES, REPO, kernelRoot } from './gates.mjs';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const KERNEL = kernelRoot();
const kernelOk = fs.existsSync(path.join(KERNEL, 'package.json'));

const list = only.length
  ? GATES.filter((g) => only.includes(g.id))
  : GATES;

if (only.length) {
  const known = new Set(GATES.map((g) => g.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length) {
    console.error(`未知门禁 id：${unknown.join(', ')}\n可用：${GATES.map((g) => g.id).join(', ')}`);
    process.exit(2);
  }
}

console.log(`\n门禁（共 ${GATES.length} 档，唯一定义处：tools/gates.mjs）`);
console.log(`仓库=${REPO}`);
console.log(`内核=${KERNEL}${kernelOk ? '' : '  （未找到 —— 依赖内核的档位将跳过）'}\n`);

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

for (const g of list) {
  if (g.needsKernel && !kernelOk) {
    skipped += 1;
    console.log(`  － ${g.name}  [${g.id}]  跳过：未找到内核`);
    continue;
  }
  const cwd = g.cwd === 'kernel' ? KERNEL : REPO;
  const r = spawnSync(process.execPath, g.args(), {
    cwd,
    encoding: 'utf8',
    timeout: 600000,
    env: { ...process.env, MINGDAO_KERNEL: KERNEL },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const line = (out.match(/结果：通过 \d+，失败 \d+/) || [])[0] || '';
  if (r.status === 0) {
    passed += 1;
    console.log(`  ✓ ${g.name}  [${g.id}]${line ? '  ' + line : ''}`);
  } else {
    failed += 1;
    const why = out.trim().split('\n').filter(Boolean).slice(-4).join('\n      ') || `exit ${r.status}`;
    failures.push(`${g.id}：${why}`);
    console.log(`  ✗ ${g.name}  [${g.id}]\n      ${why}`);
  }
}

console.log(`\n结果：通过 ${passed}，失败 ${failed}${skipped ? `，跳过 ${skipped}` : ''}`);

if (failed) {
  console.log(`\n✗ 门禁未通过：\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}
if (passed === 0) {
  // 一档都没跑成（典型原因：内核不在位）。
  // 这里**不当作通过** —— 「没验证过」和「验证通过」是两件事，混同就是假绿。
  console.log('\n✗ 没有任何一档被真正执行（未验证 ≠ 通过）。请设置 MINGDAO_KERNEL，或把内核检出到同级目录。\n');
  process.exit(1);
}
console.log('\n✓ 门禁全绿。\n');
