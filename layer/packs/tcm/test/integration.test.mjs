// 端到端集成测试：让 Pack 工具在**真实 agent 循环**里跑一遍（不是直接调 run()）。
//
// 为什么必须有这一层：单元测试证明的是「工具函数本身对」，它证明不了
//   ① 工具在真实 agent 里**真的会被 dispatch**；
//   ② 域内模型调用**真的会入账**（这是整个迁移最核心的收益：消灭 usage:{0,0} 的隐身花费）；
//   ③ 工具结果**真的会回填**消息历史。
// 这三条任何一条断了，迁移都等于没做——而它们在只调 run() 的测试里全都看不出来。
//
// 架构中立：provider 是**桩**，谁驱动问诊（Dify 还是 DeepSeek）都不影响本测试的结论。
//
// 运行：
//   MINGDAO_KERNEL=/path/to/MingDao-Harness node layer/packs/tcm/test/integration.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = path.resolve(HERE, '..');
const KERNEL = process.env.MINGDAO_KERNEL || '';

if (!KERNEL) {
  console.log('未设置 MINGDAO_KERNEL，跳过集成测试（见 README §六）。');
  process.exit(0);
}

// 临时 home 必须在 import 内核模块**之前**设好：Pack 挂载时会读 mingdaoHome()。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-e2e-home-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-e2e-work-'));
process.env.MINGDAO_HOME = HOME;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}
/**
 * 异步断言必须用这个。
 * 注意：把 async 函数传给上面的同步 check() 会**假绿** —— Promise 不被 await，
 * 断言失败也照样打印 ✓、也照样计入通过。这类「断言本身的缺陷」比被测代码的缺陷更隐蔽，
 * 所以两个入口分开命名，让「用错」在阅读时就能看出来。
 */
async function checkAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}

const { mountPacks } = await import(path.join(KERNEL, 'src/packs.js'));
const mounted = await mountPacks({ packs: [PACK_DIR] }, { cwd: WORK });
const tcmWarnings = (mounted.warnings || []).filter((w) => String(w).includes('tcm'));

const { createAgent } = await import(path.join(KERNEL, 'src/agent.js'));
const { createIO } = await import(path.join(KERNEL, 'src/ui.js'));
const { listCacheStats } = await import(path.join(KERNEL, 'src/cachestats.js'));
const { buildSystemPrompt, packPromptBlock } = await import(path.join(KERNEL, 'src/prompts.js'));

const F = {
  zhushu: '失眠多梦三个月', zhenduan: '宫颈癌（2024 年确诊，术后）', hanre: '手足心热',
  han: '夜间盗汗', toushen: '头晕', erbian: '小便偏黄', yinshi: '纳可',
  xiongfu: '胸闷', kouke: '口干', jiubing: '高血压十年',
};

console.log(`\n[集成] 真实 agent 循环（内核：${KERNEL}）`);

// 桩 provider：同时承担「agent 回合」与「ctx.llm 提取」两种角色。
// 区分依据：agent 调用 provider 时一定带 tools；ctx.llm 传的是 tools: []。
let round = 0;
const llmCalls = [];
const fakeProvider = {
  async chat(opts) {
    if (!opts.tools || opts.tools.length === 0) {
      llmCalls.push({ model: opts.model, tools: 0 });
      return {
        text: JSON.stringify({ complete: true, ...F }),
        toolCalls: null,
        usage: { prompt_tokens: 300, completion_tokens: 120 },
        finish: 'stop',
      };
    }
    round += 1;
    if (round === 1) {
      return {
        text: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'pack__tcm__patient_register', arguments: JSON.stringify({ name: '张三', birth: '1985', sex: '女' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        finish: 'tool_calls',
      };
    }
    if (round === 2) {
      return {
        text: '',
        toolCalls: [{ id: 'c2', type: 'function', function: { name: 'pack__tcm__intake_collect', arguments: JSON.stringify({ patientId: 'P001', consultText: '首诊：失眠多梦三个月，1985 年生，女' }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
        finish: 'tool_calls',
      };
    }
    return { text: '首诊病历已起草，请医师核对。', toolCalls: null, usage: { prompt_tokens: 20, completion_tokens: 8 }, finish: 'stop' };
  },
};

const agent = createAgent({
  provider: fakeProvider,
  permission: { async check() { return true; } },
  io: createIO({ quiet: true }),
  modelName: 'deepseek-v4-flash',
  workingDir: WORK,
  cfg: { permission: 'auto', model: 'deepseek-v4-flash' },
});

// 「建」命中 WRITE_INTENT_RE → 首轮就给全量工具（否则只读档只发只读工具）
const messages = [
  { role: 'system', content: '系统' },
  { role: 'user', content: '首诊：请为患者张三建立病历' },
];
const res = await agent.runTurn(messages);

const toolMsgs = messages.filter((m) => m.role === 'tool');
const stats = listCacheStats(1000);
const packRecords = stats.filter((e) => e.pack === 'tcm');

check('Pack 装载零告警（permissions 声明与源码实际用量一致）', () => {
  assert.equal(tcmWarnings.length, 0, tcmWarnings.join('；'));
});

check('agent 真的 dispatch 了 Pack 工具（两轮 tool_calls → 两次工具结果回填）', () => {
  assert.equal(toolMsgs.length, 2, `应回填 2 条工具结果，实际 ${toolMsgs.length}`);
  assert.ok(toolMsgs.some((m) => m.tool_call_id === 'c1'));
  assert.ok(toolMsgs.some((m) => m.tool_call_id === 'c2'));
});

check('工具副作用真的落了盘：注册表 + 病历快照', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(HOME, 'patients.json'), 'utf8'));
  assert.equal(reg.patients.P001.name, '张三');
  assert.equal(reg.patients.P001.visits, 1);
  const files = fs.readdirSync(path.join(HOME, 'intake', 'P001')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, '应恰好落盘一份病历快照');
  const snap = JSON.parse(fs.readFileSync(path.join(HOME, 'intake', 'P001', files[0]), 'utf8'));
  assert.equal(snap.zhenduan, F.zhenduan, '重大疾病诊断必须原样落盘');
});

check('最终正文正常返回（工具调用后模型仍能产出总结）', () => {
  assert.equal(res.text, '首诊病历已起草，请医师核对。');
  assert.equal(res.truncated, false);
});

// ★ 这一条是本次迁移的核心收益，也是 DoD ②
check('★ 域内模型调用真的入账：cache-stats 里有 pack=tcm 的归因记录且 packCost>0', () => {
  assert.ok(llmCalls.length >= 1, `应至少发生 1 次域内模型调用，实际 ${llmCalls.length}`);
  assert.ok(packRecords.length >= 1, `应有 pack=tcm 的归因记录，实际 ${packRecords.length} 条`);
  const rec = packRecords[packRecords.length - 1];
  assert.equal(rec.purpose, 'intake-extract', '应带上 purpose 归因标签');
  assert.ok(Number(rec.packCost) > 0, `packCost 应 > 0，实际 ${rec.packCost}`);
  assert.equal(rec.cost, null, '归因标记记录的 cost 必须是 null，否则会与回合级记录重复计费');
});

check('域内调用用的模型是 deepseek-v4-flash（关思考的提取模型，不是会话主模型）', () => {
  assert.ok(llmCalls.every((c) => c.model === 'deepseek-v4-flash'), JSON.stringify(llmCalls));
});

// 提示词段：这是 Pack 的第三个贡献面，也是「三条红线」在提示词层的落点。
// 它接得对不对，只看 mountPacks 的返回值是看不出来的 —— 必须真的构建一次系统提示。
const sysPrompt = buildSystemPrompt({ workingDir: WORK });
const sysPrompt2 = buildSystemPrompt({ workingDir: WORK });
const packBlock = packPromptBlock();

check('域提示词段真的被注入系统提示（不是只挂在 mountPacks 的返回值里）', () => {
  assert.ok(packBlock.includes('<pack_rules>'), 'packPromptBlock 应产出 <pack_rules> 包裹');
  assert.ok(packBlock.includes('pack="tcm" id="tcm-domain"'), '应带 tcm 段标签');
  for (const kw of ['缺项绝不编造', '不输出诊疗结论', '不得跨患者串病历', '判断权始终归属执业医师']) {
    assert.ok(sysPrompt.includes(kw), `系统提示应含「${kw}」`);
  }
  assert.ok(sysPrompt.includes('zhenduan'), '十问字段说明应进系统提示');
  assert.ok(sysPrompt.includes('patient_lookup'), '工作流程应告诉模型先调 patient_lookup');
});

check('★ 提示词段两次构建字节完全一致（否则每轮都打掉 DeepSeek 前缀缓存）', () => {
  assert.equal(sysPrompt, sysPrompt2);
});

// ─────────────────────────────────────────────────────────────
// 场景 2：输出红线 —— **与 provider 无关**。
// 这是「装上 Pack 就立刻生效」的原因：约束作用在 agent 的正文上，
// 不管这段正文是 Dify 产的还是 DeepSeek 产的。
// 也就是说，**还没做架构接线，第三条红线就已经在当前 Dify 路径上生效了**。
// ─────────────────────────────────────────────────────────────
console.log('\n[集成] 输出红线（provider 无关：装上 Pack 即生效）');

const rewriteCalls = [];
const dirtyProvider = {
  async chat(opts) {
    if (!opts.tools || opts.tools.length === 0) {
      rewriteCalls.push(String(opts.messages?.[opts.messages.length - 1]?.content || '').slice(0, 30));
      return { text: '本次主诉失眠，入睡时间较上次提前，二便正常。', toolCalls: null, usage: { prompt_tokens: 30, completion_tokens: 20 }, finish: 'stop' };
    }
    return { text: '本次服药后患者病情好转，继续原方。', toolCalls: null, usage: { prompt_tokens: 10, completion_tokens: 8 }, finish: 'stop' };
  },
};
const agent2 = createAgent({
  provider: dirtyProvider,
  permission: { async check() { return true; } },
  io: createIO({ quiet: true }),
  modelName: 'deepseek-v4-flash',
  workingDir: WORK,
  cfg: { permission: 'auto', model: 'deepseek-v4-flash' },
});
const res2 = await agent2.runTurn([{ role: 'user', content: '复诊看看' }]);

check('★ 含「好转」的正文被内核红线改写（Dify 类 provider 同样受管）', () => {
  assert.ok(rewriteCalls.length >= 1, '应触发一次改写请求');
  assert.ok(!/好转/.test(String(res2.text || '')), `最终正文不应含「好转」，实际：${res2.text}`);
});

check('红线命中写进了审计（受监管场景要能回答「红线何时被触发」）', () => {
  let audit = '';
  try { audit = fs.readFileSync(path.join(HOME, 'audit.jsonl'), 'utf8'); } catch {}
  assert.ok(audit.includes('no-efficacy-conclusion'), `审计里应出现红线 id，实际审计长度 ${audit.length}`);
});

await checkAsync('放行路径不受影响（纯事实陈述原样通过，不产生改写请求）', async () => {
  // 上面那次已消耗改写；这里换一个只产纯事实的 provider，断言不触发改写
  const clean = { chat: async () => ({ text: '本次主诉失眠，二便正常。', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 5 }, finish: 'stop' }) };
  const before = rewriteCalls.length;
  const a3 = createAgent({
    provider: clean, permission: { async check() { return true; } }, io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash', workingDir: WORK, cfg: { permission: 'auto', model: 'deepseek-v4-flash' },
  });
  const r3 = await a3.runTurn([{ role: 'user', content: '复诊看看' }]);
  assert.equal(rewriteCalls.length, before, '纯事实正文不应触发改写');
  assert.equal(r3.text, '本次主诉失眠，二便正常。');
});

// 收尾
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });

console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
