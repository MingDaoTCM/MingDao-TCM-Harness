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

/** 造一条「Pack 的 patient_lookup 结果」消息，模拟内核把它序列化进上下文 */
const lookupMessage = (visitNo, lastSnapshot) => ({
  role: 'tool',
  tool_call_id: 'c0',
  content: JSON.stringify({
    ok: true, output: `已定位患者…本次为第 ${visitNo} 次就诊`,
    data: { status: 'found', patient: { id: 'P001', name: '张三' }, visits: visitNo - 1, visitNo, visitLabel: visitNo === 1 ? '初诊' : '二诊', lastSnapshot },
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

await testAsync('② 判定说「继续」→ 走 Dify，且 query 带「本次第几次就诊 + 上次病历」', async () => {
  writeCreds({ dify: 'app-t', deepseek: 'sk-t' });
  clearConfig();
  const calls = installFetch({ decider: 'continue' });
  const p = createProvider({ name: 'dify', baseUrl: 'https://dify.example.com' });
  const snap = { zhushu: '失眠', zhenduan: '宫颈癌（2024 年确诊，术后）', hanre: '', han: '', toushen: '', erbian: '', yinshi: '', xiongfu: '', kouke: '', jiubing: '' };
  const r = await p.chat({ messages: userMessages([lookupMessage(2, snap)]), tools: TOOLS });
  const dc = calls.find((c) => c.url.includes('/chat-messages'));
  assert.ok(dc, '应当调用 Dify');
  assert.match(dc.body.query, /本次为该患者第 2 次就诊（二诊）/, '必须显式注入就诊次数');
  assert.match(dc.body.query, /上次为第 1 次就诊/, '必须回顾上次');
  assert.match(dc.body.query, /宫颈癌/, '重大疾病诊断必须原样带过去');
  assert.match(dc.body.query, /张三，失眠多梦三个月$/, '医师原文必须原样保留在末尾');
  assert.equal(r.text, '请问睡眠情况如何？');
  assert.equal(r.toolCalls, null);
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

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
