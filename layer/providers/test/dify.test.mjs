// 路线 A 的接线测试：Dify 仍是 Provider，工具编排由 Provider 内部先问一次小模型。
//
// 这一层必须测的是**决策**，不是网络：用桩 fetch 精确控制「判定模型怎么答」与「Dify 返什么」，
// 然后断言：
//   ① 判定要调工具 → 把 toolCalls 交回内核，且**不去调 Dify**（省一次问诊调用）
//   ② 判定说「继续」 → 走 Dify，且 query 里带上了「本次第几诊 + 上次病历」
//   ③ 判定失败 → **仍然走 Dify**（绝不因为编排层故障让医师问不了诊）
//   ④ 没配编排 key → 不请求判定，直接走 Dify
//
// 运行：node layer/providers/test/dify.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dify-orch-test-'));
process.env.MINGDAO_HOME = HOME;

const { createProvider } = await import(path.join(HERE, '..', 'dify.mjs'));
// 从 Pack 取**真实**的渲染函数：provider 现在只转发 Pack 渲染好的块（零字段知识），
// 所以「上次病历」这块的契约由 pack.mjs 定义，测试用同一个函数造夹具才不会自说自话。
const { renderVisitBlock } = await import(path.join(HERE, '..', '..', 'packs', 'tcm', 'pack.mjs'));

let passed = 0;
let failed = 0;
async function testAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
}

const writeCreds = (obj) => fs.writeFileSync(path.join(HOME, 'credentials.json'), JSON.stringify(obj));
const writeConfig = (obj) => fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(obj));
const clearConfig = () => { try { fs.rmSync(path.join(HOME, 'config.json')); } catch {} };

/** Dify 的 SSE 假响应 */
function sse(payloads) {
  const enc = new TextEncoder();
  const chunks = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }),
        cancel: async () => {},
      }),
    },
  };
}
const DIFY_OK = () => sse([
  { event: 'message', answer: '请问睡眠情况如何？', conversation_id: 'c1' },
  { event: 'message_end', metadata: { usage: { prompt_tokens: 10, completion_tokens: 5 } } },
]);

const TOOLS = [{
  type: 'function',
  function: { name: 'pack__tcm__patient_lookup', description: '定位患者', parameters: { type: 'object', properties: {} } },
}];

/** 装一个可编程的 fetch，并记录调用 */
function installFetch({ decider = 'continue', dify = DIFY_OK } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: u, body });
    if (u.includes('/chat/completions')) {
      if (decider === 'error') return { ok: false, status: 500, text: async () => 'boom' };
      if (decider === 'throw') throw new Error('network down');
      if (decider === 'tools') {
        return {
          ok: true, status: 200,
          json: async () => ({
            choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'pack__tcm__patient_lookup', arguments: '{}' } }] } }],
            usage: { prompt_tokens: 30, completion_tokens: 8 },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '继续' } }], usage: { prompt_tokens: 20, completion_tokens: 2 } }) };
    }
    if (u.includes('/chat-messages')) return dify();
    throw new Error(`未预期的请求：${u}`);
  };
  return calls;
}

/**
 * 造一条「Pack 的 patient_lookup 结果」消息，模拟内核把它序列化进上下文。
 * `lastVisitText` 用 Pack 的真实 `renderVisitBlock` 生成 —— 测的就是那条真实契约。
 */
const lookupMessage = (visitNo, lastSnapshot) => ({
  role: 'tool',
  tool_call_id: 'c0',
  content: JSON.stringify({
    ok: true, output: `已定位患者…本次为第 ${visitNo} 次就诊`,
    data: {
      status: 'found', patient: { id: 'P001', name: '张三' }, visits: visitNo - 1, visitNo,
      visitLabel: visitNo === 1 ? '初诊' : '二诊',
      lastSnapshot,
      lastVisitText: lastSnapshot ? renderVisitBlock(lastSnapshot) : null,
    },
  }),
});
const userMessages = (extra = []) => [
  { role: 'system', content: '系统' },
  { role: 'user', content: '张三，失眠多梦三个月' },
  ...extra,
];

console.log('\n[路线 A] dify.mjs 工具编排');

await testAsync('① 判定要调工具 → 交回 toolCalls，且**不调用 Dify**', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'tools' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  const r = await p.chat({ messages: userMessages(), tools: TOOLS });
  assert.equal(r.finish, 'tool_calls');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, 'pack__tcm__patient_lookup');
  assert.ok(r.usage && r.usage.prompt_tokens === 30, '判定调用的 usage 要带回来（内核据此计费）');
  assert.equal(calls.filter((c) => c.url.includes('/chat-messages')).length, 0, '判定要调工具时不该再问 Dify');
});

// ★ 记账不变量：**不调工具**那一轮，判定调用的花费也必须入账。
//   「判定为不需要工具」是常态（多数回合都是纯问诊），所以漏掉它 = 大部分花费隐身：
//   不进账本、不触发日费用护栏 —— 与迁移前硬编码 `usage:{0,0}` 是同一类问题，只是更隐蔽
//   （调用真实发生了、账上却看不出来）。这条断言守的就是"常态那一半"。
await testAsync('①b 判定**不**调工具 → 判定调用的 usage 也要并进账（不调工具才是常态）', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  installFetch({ decider: 'continue' }); // 判定返回 20/2，Dify 返回 10/5
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  const r = await p.chat({ messages: userMessages(), tools: TOOLS });
  assert.equal(r.finish, 'stop');
  assert.equal(r.toolCalls, null, '不调工具时不该带 toolCalls');
  assert.equal(r.usage.prompt_tokens, 30, '判定 20 + 问诊 10：两笔输入都要记（漏了就是花费隐身）');
  assert.equal(r.usage.completion_tokens, 7, '判定 2 + 问诊 5：两笔输出都要记');
});

// ★ 对应 2026-09-23 用户报的「无落盘、同一患者复诊仍按初诊」：
//   编排器查到「未找到既有患者」就停了，没接着 patient_register + intake_collect，
//   于是这次就诊丢失、下次复诊又被判首诊（病历断链）。
//   根因是 DECIDE_SYSTEM 把落盘写成了「典型情形」之一，与「该由问诊工作流回答」并列 ——
//   模型完全可以理解成"这轮交给工作流，不用落盘"。这条断言把发出去的提示钉住：
//   落盘必须是**硬性流程**，且明确禁止停在 patient_lookup。
await testAsync('★ 编排提示必须把「落盘」写成硬性流程，并明确禁止停在 patient_lookup', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'continue' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  await p.chat({ messages: userMessages(), tools: TOOLS });
  const dc = calls.find((c) => c.url.includes('/chat/completions') && Array.isArray(c.body?.tools));
  assert.ok(dc, '应发出一次带 tools 的判定请求');
  const sys = String(dc.body.messages?.[0]?.content || '');
  assert.match(sys, /硬性流程/, '落盘必须写明是硬性流程，不能只是「典型情形」之一');
  for (const t of ['patient_lookup', 'patient_register', 'intake_collect']) {
    assert.ok(sys.includes(t), `编排提示必须点出 ${t}（否则模型不知道有这一步）`);
  }
  assert.match(sys, /绝不要停在\s*patient_lookup/, '必须明确禁止停在 lookup');
  assert.match(sys, /病历断链|就诊丢失/, '必须说清停在 lookup 的后果');
});

await testAsync('② 判定说「继续」→ 走 Dify，且 query 带「本次第几次就诊 + 上次病历」', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'continue' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  // ★ 夹具必须是**当前**病历结构的字段（重构后：主诉/现病史 + 可选八项）。
  // 此前这里用的是旧十问字段 —— 夹具与实现一起错，于是复诊失真测不出来（假绿）。
  const snap = {
    zhushu: '失眠多梦三个月',
    xianbingshi: '三月前无诱因入睡困难，伴多梦易醒；既往 2024 年确诊为宫颈癌，术后规律复查',
    jiwangshi: '宫颈癌术后；高血压十年',
    guominshi: '青霉素过敏',
    shexiang: '舌红苔黄',
    maixiang: '脉弦细',
    suifang: '两周后复诊',
  };
  const r = await p.chat({ messages: userMessages([lookupMessage(2, snap)]), tools: TOOLS });
  const dc = calls.find((c) => c.url.includes('/chat-messages'));
  assert.ok(dc, '应当调用 Dify');
  assert.match(dc.body.query, /本次为该患者第 2 次就诊（二诊）/, '必须显式注入就诊次数');
  assert.match(dc.body.query, /上次为第 1 次就诊/, '必须回顾上次');
  assert.match(dc.body.query, /宫颈癌/, '重大疾病诊断必须原样带过去');
  assert.match(dc.body.query, /张三，失眠多梦三个月$/, '医师原文必须原样保留在末尾');
  // ★ 复诊失真回归：上次病历必须带**现病史与四诊**，且不得残留旧十问字段名。
  // 这几条正是旧实现下会失败、而旧夹具下永远绿的部分。
  assert.match(dc.body.query, /现病史：/, '现病史必须注入（此前被静默丢掉）');
  assert.match(dc.body.query, /舌象：舌红苔黄/, '四诊·舌象必须注入');
  assert.match(dc.body.query, /脉象：脉弦细/, '四诊·脉象必须注入');
  assert.match(dc.body.query, /过敏史：青霉素过敏/, '过敏史必须注入');
  assert.ok(!/寒热|头身|口渴|旧病|诊断\/重大疾病/.test(dc.body.query), '不得再出现旧十问字段名：' + dc.body.query);
  assert.equal(r.text, '请问睡眠情况如何？');
  assert.equal(r.toolCalls, null);
});

await testAsync('②b ★ provider 零字段知识：只转发 Pack 渲染好的 lastVisitText', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'continue' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  // lastSnapshot 故意用 provider 不认识的键 + lastVisitText 用自定义文本：
  // 若 provider 还在自己遍历字段，自定义块就不会出现、未知键反而可能被渲染出来。
  const msg = {
    role: 'tool',
    tool_call_id: 'c0',
    content: JSON.stringify({
      ok: true, output: '已定位',
      data: { visitNo: 2, visitLabel: '二诊', lastSnapshot: { someUnknownField: '不应出现' }, lastVisitText: '现病史：自定义块内容\n舌象：自定义舌象' },
    }),
  };
  await p.chat({ messages: userMessages([msg]), tools: TOOLS });
  const dc = calls.find((c) => c.url.includes('/chat-messages'));
  assert.match(dc.body.query, /现病史：自定义块内容/, 'provider 必须原样转发 Pack 给的块');
  assert.ok(!/someUnknownField|不应出现/.test(dc.body.query), 'provider 不得自行遍历 lastSnapshot（零字段知识）');
});

await testAsync('③ 判定失败（HTTP 500）→ **仍然走 Dify**，不抛错', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'error' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  const r = await p.chat({ messages: userMessages(), tools: TOOLS });
  assert.equal(r.text, '请问睡眠情况如何？', '编排层故障绝不能阻断临床正文');
  assert.equal(calls.filter((c) => c.url.includes('/chat-messages')).length, 1);
});

await testAsync('③b 判定网络异常 → 同样回落', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'throw' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  const r = await p.chat({ messages: userMessages(), tools: TOOLS });
  assert.equal(r.text, '请问睡眠情况如何？');
  assert.equal(calls.filter((c) => c.url.includes('/chat-messages')).length, 1);
});

await testAsync('④ 没配编排 key → 不请求判定，直接走 Dify', async () => {
  writeCreds({ dify: 'app-t' }); // 没有 deepseek
  clearConfig();
  const calls = installFetch({ decider: 'tools' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  const r = await p.chat({ messages: userMessages(), tools: TOOLS });
  assert.equal(r.text, '请问睡眠情况如何？');
  assert.equal(calls.filter((c) => c.url.includes('/chat/completions')).length, 0, '没有 key 就不该发判定请求');
});

await testAsync('⑤ 首诊：只注入「第 1 次就诊（初诊）」，不带上次病历', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'continue' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  await p.chat({ messages: userMessages([lookupMessage(1, null)]), tools: TOOLS });
  const dc = calls.find((c) => c.url.includes('/chat-messages'));
  assert.match(dc.body.query, /本次为该患者第 1 次就诊（初诊）/);
  assert.ok(!/上次为第/.test(dc.body.query), '首诊不应出现「上次」');
});

await testAsync('⑥ 没有工具结果时 query 保持原文（不编造就诊次数）', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'continue' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  await p.chat({ messages: userMessages(), tools: TOOLS });
  const dc = calls.find((c) => c.url.includes('/chat-messages'));
  assert.equal(dc.body.query, '张三，失眠多梦三个月');
});

await testAsync('⑦ 编排模型可切本地小模型（config.tcm.orchestrator）', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  writeConfig({ tcm: { orchestrator: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: 'ollama' } } });
  const calls = installFetch({ decider: 'continue' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  await p.chat({ messages: userMessages(), tools: TOOLS });
  const dc = calls.find((c) => c.url.includes('/chat/completions'));
  assert.ok(dc, '本地编排模型也要被调用');
  assert.ok(dc.url.startsWith('http://127.0.0.1:11434/'), `应打到本地端点，实际 ${dc.url}`);
  assert.equal(dc.body.model, 'qwen2.5:7b');
  assert.equal(dc.body.thinking, undefined, 'thinking 是 DeepSeek 专有参数，本地端点不能带（会 400）');
});

await testAsync('⑧ 判定请求带上了内核给的 tools（否则模型无从选择）', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'continue' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  await p.chat({ messages: userMessages(), tools: TOOLS });
  const dc = calls.find((c) => c.url.includes('/chat/completions'));
  assert.equal(dc.body.tools.length, 1);
  assert.equal(dc.body.tools[0].function.name, 'pack__tcm__patient_lookup');
  assert.equal(dc.body.tool_choice, 'auto');
});

const BUILTIN_TOOLS = [
  { type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'ls', description: '列目录', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'bash', description: '执行命令', parameters: { type: 'object', properties: {} } } },
];

await testAsync('⑨ ★ 编排器**只**看到垂域 Pack 工具（通用工具不交给它）', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'continue' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  await p.chat({ messages: userMessages(), tools: [...TOOLS, ...BUILTIN_TOOLS] });
  const dc = calls.find((c) => c.url.includes('/chat/completions'));
  const names = dc.body.tools.map((t) => t.function.name);
  // 实测教训：一开始把全部工具都给它，医师说「回访」它却去 read/ls 翻代码库
  assert.deepEqual(names, ['pack__tcm__patient_lookup'], `编排器不应看到 read/ls/bash，实际 ${names.join(',')}`);
});

await testAsync('⑩ 全是通用工具时，**完全不发起**判定调用（不为注定空转的一轮多花钱）', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'tools' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  const r = await p.chat({ messages: userMessages(), tools: BUILTIN_TOOLS });
  assert.equal(calls.filter((c) => c.url.includes('/chat/completions')).length, 0, '没有垂域工具就不该发判定请求');
  assert.equal(calls.filter((c) => c.url.includes('/chat-messages')).length, 1, '直接走 Dify');
  assert.equal(r.text, '请问睡眠情况如何？');
});

// ── 正文 / 思考过程 双通道分流（实测回归：Dify 把 <think> 混在 answer 分片里）──
// 现场数据：正文分片累积 2530 字，其中 <think>…</think> 占 1369 字，而收尾 res.text 只有 1163 字。
// 医师定稿的处理原则：思考过程**保留可看**（对中医辨证有用），但必须
//   ① 走 reasoning 通道，不混进问诊正文（正文要受输出红线约束）；
//   ② 标签本身不出现在任何一条流里；
//   ③ 流式所见 == 收尾所得（否则「看到的」和「落库的」不一致）。
async function streamOf(payloads) {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  installFetch({ decider: 'continue', dify: () => sse(payloads) });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  let text = '', reasoning = '';
  const r = await p.chat({
    messages: userMessages(), tools: TOOLS,
    onDelta: (d) => { text += d.text || ''; reasoning += d.reasoning || ''; },
  });
  return { text, reasoning, r };
}

await testAsync('⑪ ★ 思考过程走 reasoning 通道，正文通道保持干净（标签两边都不出现）', async () => {
  const { text, reasoning, r } = await streamOf([
    { event: 'message', answer: '<think>先问失眠', conversation_id: 'c1' },
    { event: 'message', answer: '多久了，是否多梦</think>请问睡眠情况如何？' },
    { event: 'message_end', metadata: { usage: { prompt_tokens: 10, completion_tokens: 5 } } },
  ]);
  assert.equal(text.trim(), '请问睡眠情况如何？', '正文通道只能有正文');
  assert.ok(!text.includes('先问失眠'), '推理绝不能混进正文通道：' + JSON.stringify(text));
  assert.equal(reasoning.trim(), '先问失眠多久了，是否多梦', '思考内容必须完整走 reasoning 通道（医师要看）');
  assert.ok(!/<\/?think>/.test(text) && !/<\/?think>/.test(reasoning), '标签本身不能被送出：' + JSON.stringify({ text, reasoning }));
  assert.equal(text.trim(), r.text.trim(), '流式正文必须与收尾 res.text 同源');
  assert.equal(reasoning.trim(), r.reasoning.trim(), '流式思考必须与收尾 res.reasoning 同源');
});

await testAsync('⑫ 标签被切在分片中间（"<thi" / "</thi"）也不早发半个标签', async () => {
  const { text, reasoning, r } = await streamOf([
    { event: 'message', answer: '<thi' },
    { event: 'message', answer: 'nk>推理' },
    { event: 'message', answer: '内容</thi' },
    { event: 'message', answer: 'nk>正文开始' },
    { event: 'message_end', metadata: { usage: { prompt_tokens: 1, completion_tokens: 1 } } },
  ]);
  assert.ok(!text.includes('<') && !reasoning.includes('<'), '半截标签不能被发出去：' + JSON.stringify({ text, reasoning }));
  assert.equal(text.trim(), '正文开始');
  assert.equal(reasoning.trim(), '推理内容');
  assert.equal(text.trim(), r.text.trim());
  assert.equal(reasoning.trim(), r.reasoning.trim());
});

await testAsync('⑬ 未闭合的 <think> → 正文不留推理，但推理内容仍完整可看', async () => {
  const { text, reasoning, r } = await streamOf([
    { event: 'message', answer: '<think>模型只顾自己推理，忘了闭合' },
    { event: 'message_end', metadata: { usage: { prompt_tokens: 1, completion_tokens: 1 } } },
  ]);
  assert.equal(text, '', '未闭合时段内流式正文必须为空 —— 前端据此继续显示「思考中」');
  assert.ok(!text.includes('忘了闭合'), '正文通道不能漏推理：' + JSON.stringify(text));
  assert.match(r.text, /未产出可见正文/, '收尾正文要显式说明，而不是静默为空');
  assert.match(reasoning, /忘了闭合/, '推理内容不能丢，留在 reasoning 通道');
  assert.equal(reasoning.trim(), r.reasoning.trim());
  assert.ok(!/<\/?think>/.test(r.text) && !/<\/?think>/.test(r.reasoning), '标签不得出现在任何通道');
});

await testAsync('⑭ 无 <think> 时正文逐字透传、reasoning 通道为空（过滤不能吃掉正文）', async () => {
  const { text, reasoning, r } = await streamOf([
    { event: 'message', answer: '## 一、问诊要点\n' },
    { event: 'message', answer: '- 睡眠时长\n- 是否多梦\n' },
    { event: 'message_end', metadata: { usage: { prompt_tokens: 1, completion_tokens: 1 } } },
  ]);
  assert.equal(reasoning, '', '没有思考段就不该凭空造 reasoning');
  assert.equal(r.reasoning, '');
  // 注意：收尾的 res.text 会 .trim()，而流式分片保留尾部换行 —— 这正是前端必须在 done 时
  // 改用内核权威正文的原因（样例 UI 已如此处理）。
  assert.equal(text.trim(), r.text, '无 <think> 时正文应逐字透传（仅收尾 trim 差异）');
  assert.match(text, /问诊要点/);
});

await testAsync('⑮ ★ 多段 <think>：全部剥掉（只剥第一段会让第二段连着标签留在正文里）', async () => {
  const { text, reasoning, r } = await streamOf([
    { event: 'message', answer: '<think>第一段</think>正文中间<think>第二段</think>正文结尾' },
    { event: 'message_end', metadata: { usage: { prompt_tokens: 1, completion_tokens: 1 } } },
  ]);
  assert.ok(!/<\/?think>/.test(text), '正文里不能残留任何标签：' + JSON.stringify(text));
  assert.ok(text.includes('正文中间') && text.includes('正文结尾'), '两段正文都要在：' + JSON.stringify(text));
  assert.match(reasoning, /第一段/);
  assert.match(reasoning, /第二段/, '第二段思考也要收进 reasoning，不能连标签丢在正文里');
  assert.equal(text.trim(), r.text.trim());
  assert.equal(reasoning.trim(), r.reasoning.trim());
});

// ★ 用户报的严重问题：v0.1.8 **无法问诊** —— 医师发了完整病历，最终正文只有一个"继续"
//   （那是编排器的内部口令；Dify 后台查不到问诊记录）。用户同时要求：
//   **Dify 工作流出问题时自动切换到 DeepSeek 直连**。下面两条钉住这个兜底。
await testAsync('★ Dify 返回内部口令「继续」→ 自动兜底 DeepSeek 出正文，绝不给空白', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (u.includes('/chat/completions')) {
      const isFallback = String(body?.messages?.[0]?.content || '').includes('兜底直连');
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: isFallback ? '兜底产出的问诊正文' : '继续' } }], usage: {} }) };
    }
    if (u.includes('/chat-messages')) {
      // Dify 把编排口令当正文吐了回来（实测现象）
      return sse([{ event: 'message', answer: '继续' }, { event: 'message_end', metadata: { usage: {} } }]);
    }
    throw new Error('未预期请求：' + u);
  };
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  const r = await p.chat({ messages: userMessages(), tools: TOOLS });
  assert.equal(r.fellBack, true, '应标记本次是兜底（便于审计"这次没有知识库"）');
  assert.match(r.text, /兜底产出的问诊正文/, '必须给医师正文，而不是那个口令');
  assert.ok(!/^继续$/.test(r.text.trim()), '正文绝不能是「继续」');
});
await testAsync('★ Dify 报错（HTTP 5xx）→ 同样自动兜底，不把错误甩给医师', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (u.includes('/chat/completions')) {
      const isFallback = String(body?.messages?.[0]?.content || '').includes('兜底直连');
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: isFallback ? '兜底正文' : '继续' } }], usage: {} }) };
    }
    if (u.includes('/chat-messages')) return { ok: false, status: 503, text: async () => 'upstream down' };
    throw new Error('未预期请求：' + u);
  };
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  const r = await p.chat({ messages: userMessages(), tools: TOOLS });
  assert.equal(r.fellBack, true);
  assert.equal(r.text, '兜底正文');
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
