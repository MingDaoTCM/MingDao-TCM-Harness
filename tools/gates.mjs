// 门禁清单 —— 全项目**唯一**的一份定义处。
//
// 为什么必须有这个文件：此前「要跑哪几档」被抄在三处 ——
//   · .github/workflows/ci.yml     内联 9 行 node 命令，且注释至今写着「7 档」
//   · tools/preflight.mjs          内联一个数组，标题写着「八档门禁」
//   · README.md                    又描述了一遍
// 三份必然漂移（现在已经漂了：7 / 八 / 9 三个数字同时存在）。
// 门禁清单漂移的后果不是「文档不好看」，而是**某一档其实没人跑过、却以为跑过** ——
// 这正是本项目反复出现的失败模式。所以清单只此一处，CI / preflight / `npm test` 都 import 它；
// 想漏掉一档就必须显式改这里，而改动会出现在 PR diff 里被人看见。
//
// 用法：
//   import { GATES, REPO, kernelRoot } from './gates.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 内核根目录：显式 MINGDAO_KERNEL 优先，否则取同级的 MingDao-Harness。
 * CI 里两个仓库同级检出（见 .github/workflows/ci.yml），所以这个默认值是对的。
 */
export function kernelRoot() {
  return process.env.MINGDAO_KERNEL || path.resolve(REPO, '..', 'MingDao-Harness');
}

const PACK_DIR = path.join(REPO, 'layer', 'packs', 'tcm');
const T = (...p) => path.join(REPO, ...p);

/**
 * @typedef {{ id:string, name:string, cwd:'repo'|'kernel', needsKernel?:boolean, args:()=>string[] }} Gate
 */

/** @type {Gate[]} */
export const GATES = [
  {
    id: 'pack-verify',
    name: 'pack verify（manifest 静态校验，含 engines 窗口）',
    cwd: 'kernel',
    needsKernel: true,
    args: () => ['src/cli.js', 'pack', 'verify', PACK_DIR],
  },
  {
    id: 'doc-lint',
    name: 'doc-lint（文档不变量：工具数/字段数/架构注释/文档锚点/内核版本陈述）',
    cwd: 'repo',
    args: () => [T('tools', 'doc-lint.mjs')],
  },
  {
    id: 'kernel-sentinel',
    name: '内核版本哨兵（Pack 真的挂上了吗？不是"声明挂了"）',
    cwd: 'repo',
    needsKernel: true,
    args: () => [T('tools', 'kernel-sentinel.mjs')],
  },
  {
    id: 'pack',
    name: 'pack.test（契约 / 字段 / 红线 / 工具 / 错误路径）',
    cwd: 'repo',
    needsKernel: true,
    args: () => [T('layer', 'packs', 'tcm', 'test', 'pack.test.mjs')],
  },
  {
    id: 'integration',
    name: 'integration（真实 agent 循环 + 域内调用入账 + 输出红线）',
    cwd: 'repo',
    needsKernel: true,
    args: () => [T('layer', 'packs', 'tcm', 'test', 'integration.test.mjs')],
  },
  {
    id: 'dify',
    name: 'dify.test（Provider 协议适配与 usage 记账）',
    cwd: 'repo',
    args: () => [T('layer', 'providers', 'test', 'dify.test.mjs')],
  },
  {
    id: 'tcm-data',
    name: 'tcm-data（患者 / 病历读语义）',
    cwd: 'repo',
    args: () => [T('tools', 'tcm-ui', 'test', 'tcm-data.test.mjs')],
  },
  {
    id: 'settings',
    name: 'settings（配置读写）',
    cwd: 'repo',
    args: () => [T('tools', 'tcm-ui', 'test', 'settings.test.mjs')],
  },
  {
    id: 'ui-wiring',
    name: 'ui-wiring（前端接线）',
    cwd: 'repo',
    args: () => [T('tools', 'tcm-ui', 'test', 'ui-wiring.test.mjs')],
  },
  {
    id: 'desktop-orchestrator',
    name: 'desktop-orchestrator（桌面编排层与打包布局）',
    cwd: 'repo',
    args: () => [T('tools', 'tcm-ui', 'test', 'desktop-orchestrator.test.mjs')],
  },
  {
    id: 'site',
    name: 'site（站点与发布清单）',
    cwd: 'repo',
    args: () => [T('site', 'test', 'site.test.mjs')],
  },
];

/** 门禁档数（文档里写的数字必须与它一致 —— 由 doc-lint 的 INV-7 断言） */
export const GATE_COUNT = GATES.length;
