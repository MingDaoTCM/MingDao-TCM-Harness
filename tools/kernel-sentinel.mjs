#!/usr/bin/env node
// 内核版本哨兵 —— 回答一个**可观测**的问题：垂域 Pack 现在真的挂上了吗？
//
// 为什么不能只校验 `engines` 这一行声明：
// 内核加载 Pack 的口径是「坏 Pack 只 warn 并跳过，绝不阻塞启动」（src/packs.js 的 mountPacks）。
// engines 不匹配只是**跳过的原因之一**，此外还有：项目级信任门未通过、manifest 校验失败、
// 工具名非法、注册抛错 —— 每一条都是 `continue` + 一条 warning。
// 结果是那个著名的症状：**工具消失、问诊绕过 Dify 直接由 DeepSeek 生成**，
// 而控制台之外没有任何东西变红。所以哨兵必须断言**挂载结果**，不是断言声明。
//
// 哨兵做两件事：
//   ① 声明层：engines 窗口 vs 内核实际版本（用内核自己的 satisfiesRange，不复刻一份）；
//   ② 事实层：真的调内核的 mountPacks，断言 tcm 出现在 mounted 里、且 5 个工具都注册了。
// ② 的价值在于：无论将来跳过的原因变成什么（信任门、manifest、注册），它都会红。
//
// 用法：MINGDAO_KERNEL=/path/to/MingDao-Harness node tools/kernel-sentinel.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kernelRoot } from './gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(HERE, '..');
const PACK_DIR = path.join(REPO_DIR, 'layer', 'packs', 'tcm');
const KERNEL = kernelRoot();

let pass = 0;
let fail = 0;
const failures = [];
const ok = (n, extra = '') => { pass += 1; console.log(`  ✓ ${n}${extra ? '  ' + extra : ''}`); };
const bad = (n, why) => { fail += 1; failures.push(`${n}：${why}`); console.log(`  ✗ ${n}\n      ${why}`); };

console.log(`\n内核版本哨兵  仓库=${REPO_DIR}\n内核=${KERNEL}\n`);

// ── 0. 内核在位 ──
if (!fs.existsSync(path.join(KERNEL, 'package.json'))) {
  // 缺内核时**不判失败**，但也不许当成通过 —— 见 run-gates.mjs 的「一档都没执行」处理。
  console.log('  － 未找到内核（未验证 ≠ 通过）。设置 MINGDAO_KERNEL 或把内核检出到同级目录。');
  console.log('\n结果：通过 0，失败 0');
  process.exit(0);
}

const kernelVer = String(JSON.parse(fs.readFileSync(path.join(KERNEL, 'package.json'), 'utf8')).version || '');
const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
const range = String(manifest?.engines?.mingdao || '');

console.log(`内核版本 v${kernelVer}｜engines.mingdao「${range}」\n`);

// ── ① 声明层：engines 窗口是否还罩得住当前内核（用内核自己的比较器）──
try {
  const { satisfiesRange } = await import(path.join(KERNEL, 'src', 'packs.js'));
  if (!range) bad('engines.mingdao', 'pack.json 未声明兼容窗口 —— 内核将无法判定兼容性');
  else if (satisfiesRange(kernelVer, range)) ok('engines 窗口覆盖当前内核', `v${kernelVer} ∈ ${range}`);
  else {
    bad(
      'engines 窗口已过期',
      `内核 v${kernelVer} 不在「${range}」内 —— 内核会**跳过整个垂域层**：`
      + '工具全部消失、问诊绕过 Dify。请把 pack.json 的 engines 窗口扩到已验证的范围，'
      + '并跑一遍 `npm test` 确认全绿。'
    );
  }
} catch (e) {
  bad('engines 窗口', `无法用内核的 satisfiesRange 判定：${e?.message || e}`);
}

// ── ② 事实层：真的挂一次，看 mounted 里有没有 tcm ──
// 临时 home 必须在 import 内核模块**之前**设好（Pack 挂载时会读 mingdaoHome()）。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-sentinel-home-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-sentinel-work-'));
process.env.MINGDAO_HOME = HOME;

try {
  const { mountPacks } = await import(path.join(KERNEL, 'src', 'packs.js'));
  const res = await mountPacks({ packs: [PACK_DIR] }, { cwd: WORK });
  const mounted = (res.mounted || []).map((m) => String(m?.name));
  const warnings = (res.warnings || []).map(String);

  if (mounted.includes('tcm')) {
    const m = (res.mounted || []).find((x) => String(x?.name) === 'tcm');
    ok('tcm Pack 真的挂载成功', `v${m.version}｜apiVersion ${m.apiVersion}`);
  } else {
    bad(
      'tcm Pack **没有挂上**',
      '这是「工具消失、问诊不走 Dify」的直接原因。内核给出的 warning：\n      '
      + (warnings.length ? warnings.join('\n      ') : '（无 —— 静默跳过，更危险）')
      + '\n      排查顺序：engines 窗口 → 项目级信任门（mingdao pack trust）→ manifest 校验 → 工具名合法性。'
    );
  }

  // 工具数：以**挂载结果**为准。少一个工具就等于少一项能力，而且不会报错。
  const toolCount = Number(res.toolCount || 0);
  if (toolCount >= 5) ok('工具注册数', `${toolCount} 个（pack__tcm__*）`);
  else bad('工具注册数', `只有 ${toolCount} 个 —— 期望 ≥5。垂域能力不完整，但不会有任何报错。`);

  // 提示词段：缺了它，Dify 拿不到中医垂域规则，症状是"问诊变笨"而不是"报错"。
  const sections = (res.promptSections || []).filter((s) => String(s?.pack) === 'tcm');
  if (sections.length >= 1 && String(sections[0].content || '').trim()) ok('领域提示词段已注入', `${sections[0].id}`);
  else bad('领域提示词段', '没有注入 —— 问诊会退化成通用问答，且不报错。');

  // 约束（三条红线）：缺了它，"不输出诊疗结论"就只是提示词里的一句劝告。
  const cs = (res.constraints || []).filter((c) => String(c?.pack) === 'tcm');
  if (cs.length >= 4) ok('红线约束已挂载', `${cs.length} 条`);
  else bad('红线约束', `只有 ${cs.length} 条 —— 期望 ≥4。红线会退化成"劝告"。`);

  if (warnings.length) {
    console.log(`\n  内核 warning（不判失败，但值得看一眼）：\n      ${warnings.join('\n      ')}`);
  }
} catch (e) {
  bad('挂载验证', `无法完成：${e?.stack || e?.message || e}`);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log(`\n✗ 垂域层在当前内核下**不完整**。每一条都要修掉：\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}
console.log('\n✓ 垂域层在当前内核下完整挂载。\n');
