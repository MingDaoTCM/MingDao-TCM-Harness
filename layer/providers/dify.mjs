// Dify 主问诊 Provider（路线 A）—— 只做两件事：
//
//   ① 工具编排判定：这一轮该不该调工具？（用一个小模型判断，**模型可配、可切本地**）
//   ② 不调工具时：走 Dify 工作流产出临床正文（逐字流式）
//
// ── 为什么是路线 A（而不是把 Dify 降成一个工具）────────────────────────────
// 只有 A 能让 Dify 的临床正文同时满足两件事：
//   · **逐字呈现**：它成为 provider 的 `res.text`，原生流式，不经任何模型转述；
//   · **受内核输出红线约束**：`agent.js` 的 `applyOutputConstraints(res.text)` 只作用于
//     provider 返回的正文；工具吐出来的文本（含工具里的 io.writeText）**不在覆盖范围内**。
// 若把 Dify 降为工具（路线 B），那段最该被管的临床正文恰好成为唯一不受红线管的部分。
//
// ── 职责边界（用户的硬要求）────────────────────────────────────────────
//   · **问诊精准度 = Dify + RAG 工作流** → 本文件不改写、不复述、不摘要 Dify 的正文；
//   · **智能程度 = 得一中医层** → 患者定位/登记/病历落盘/四态对比/回访，全部由 Pack 工具承担。
//
// ── 域逻辑已经全部移出本文件 ───────────────────────────────────────────
// 患者注册表、十问结构化提取、四态对比、回访，**已在 layer/packs/tcm**。
// 本文件不再写 patients.json / intake/** 的任何字节 ——
// 两套实现各写一份会互相覆盖，这是接线时必须消除的风险。
//
// ── 幂等与降级 ────────────────────────────────────────────────────
// 编排判定失败（没配 key / 网络不通 / 模型不支持 tool calling）**一律回落为纯问诊**，
// 绝不阻断临床正文。宁可少调一个工具，也不能让医师问不了诊。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIFY_BASE = 'https://dify.mingdaotcm.cn';
const DEFAULT_ORCH_BASE = 'https://api.deepseek.com/v1';
const DEFAULT_ORCH_MODEL = 'deepseek-v4-flash';
const DECIDE_TIMEOUT_MS = 20000;
/** 判定时最多回看多少条消息（长会话下控制这次额外调用的输入成本） */
const DECIDE_TAIL = 24;
/**
 * 交给编排器的工具**只保留垂域 Pack 的**（内核注册名形如 `pack__<pack>__<tool>`）。
 *
 * 为什么必须过滤（实测踩到）：一开始把内核给的全部工具都转给编排器，于是 read/write/ls/bash
 * 也在选项里 —— 医师只说了一句「回访」，编排器却去 `read`/`ls` 翻代码库，白烧几步。
 * 编排器的职责是判断**垂域工具**用不用；通用工具的取舍不属于它。
 *
 * 这也不损失既有能力：provider=dify 在过去从不产出 tool_calls（恒为 null），
 * 通用工具本来就用不上。
 */
const PACK_TOOL_PREFIX = 'pack__';

const FIELD_LABELS = {
  zhushu: '主诉（含疾病诊断+主要症状）',
  zhenduan: '诊断/重大疾病（必须原样记录，绝不省略）',
  hanre: '寒热', han: '汗', toushen: '头身', erbian: '二便',
  yinshi: '饮食', xiongfu: '胸腹', kouke: '口渴', jiubing: '旧病',
};

/**
 * 编排器系统提示。
 * 关键点：明确告诉它「不要产出临床内容」——临床正文由 Dify 负责。
 * 不需要调工具时让它回「继续」，这个文本会被丢弃（不进入正文、不进入历史）。
 */
const DECIDE_SYSTEM = `你是中医问诊系统的**编排器**，只做一件事：判断这一轮是否需要调用工具。

需要调用工具的典型情形：
- 要定位/确认患者身份（含同名多命中要交给医师确认）→ patient_lookup
- 医师确认确为初诊的新患者 → patient_register
- 要落盘本次病历 / 复诊对比 / 回访看板或随访 → intake_collect / visit_compare / followup_board
- 上一次工具结果提示「必填项缺失」但医师已补充了缺失信息 → 重新调用 intake_collect

**不需要**调用工具的情形：
- 这一轮该由「问诊工作流」回答：采集症状、继续追问、解释说明、总结本次问诊

不需要调工具时，**只回复两个字：继续**。

严禁输出任何临床内容（症状描述、辨证、建议、结论）——临床正文由问诊工作流产出，
你多说的每一句都不会被采纳，只会浪费一次调用。`;

/**
 * @param {{name?:string, baseUrl?:string, apiKey?:string}} pc
 */
export function createProvider(pc) {
  const home = process.env.MINGDAO_HOME || '';
  let creds = /** @type {any} */ ({});
  try { creds = JSON.parse(fs.readFileSync(path.join(home, 'credentials.json'), 'utf8')); } catch {}

  const difyKey = pc.apiKey || creds.dify || '';
  // 读一次配置：Dify 地址与编排模型都从这里取。
  // ⚠ 为什么不靠 config 的顶层 baseUrl：内核的 resolveProviderConfig 是
  //   `baseUrl = cfg.baseUrl || <目标模型服务商预设>.baseUrl` —— 顶层值会**压过**目标模型自己的地址。
  //   而顶层 baseUrl 是给「当前 provider」用的（就是我们）。一旦写上，Pack 里
  //   ctx.llm({model:'deepseek-v4-flash'}) 就会带着 DeepSeek 的 key 打到 Dify 域名上，
  //   报一句极难排查的「[deepseek-v4-flash] 响应解析失败」（实测踩到）。
  //   所以 Dify 地址由我们自己兜底（pc.baseUrl → config.tcm.difyBaseUrl → 默认值），
  //   config.json 里**不要**写顶层 baseUrl。
  let cfgFile = /** @type {any} */ ({});
  try { cfgFile = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch {}
  const difyBaseUrl = String(pc.baseUrl || cfgFile?.tcm?.difyBaseUrl || DEFAULT_DIFY_BASE).replace(/\/+$/, '');
  /** Dify 会话 id（单例）。注意：本 Provider 是「一问诊一实例」的使用方式，
   *  若将来改成工具/多患者并发，这里必须按患者隔离。 */
  let conversationId = '';
  let orchestratorWarned = false;

  /**
   * 编排判定模型的配置。可切本地小模型：
   *   ~/.deyi-tcm/config.json
   *   { "tcm": { "orchestrator": { "baseUrl": "http://127.0.0.1:11434/v1",
   *                                "model": "qwen2.5:7b", "apiKey": "ollama" } } }
   * 不配则回落到 DeepSeek（稳，但要花一次小调用）。
   */
  function orchestrator() {
    // 复用创建时读到的 cfgFile（配置在进程生命周期内视为不变；改配置请重启）
    const o = cfgFile?.tcm?.orchestrator || {};
    const baseUrl = String(o.baseUrl || DEFAULT_ORCH_BASE).replace(/\/+$/, '');
    return {
      model: String(o.model || DEFAULT_ORCH_MODEL),
      baseUrl,
      apiKey: String(o.apiKey || creds.deepseek || ''),
      isDeepseek: /(^|\.)api\.deepseek\.com$/.test(baseUrl.replace(/^https?:\/\//, '').split('/')[0]),
    };
  }

  /**
   * 这一轮要不要调工具？
   * @returns {Promise<{toolCalls:any[]|null, usage:any}|null>} 判定不可用时返回 null（调用方回落为纯问诊）
   */
  async function decide(/** @type {any} */ messages, /** @type {any} */ tools, /** @type {any} */ signal) {
    const o = orchestrator();
    if (!o.apiKey) {
      if (!orchestratorWarned) {
        orchestratorWarned = true;
        console.warn('[dify] 未找到编排判定模型的 API Key（config.tcm.orchestrator.apiKey 或 credentials.deepseek）。'
          + '工具编排不可用，**问诊链路不受影响**；需要工具时就近配置后重启。');
      }
      return null;
    }
    const tail = (Array.isArray(messages) ? messages : []).slice(-DECIDE_TAIL);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DECIDE_TIMEOUT_MS);
    const onAbort = () => ac.abort();
    try { if (signal) signal.addEventListener('abort', onAbort, { once: true }); } catch {}
    try {
      const res = await fetch(`${o.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify({
          model: o.model,
          messages: [{ role: 'system', content: DECIDE_SYSTEM }, ...tail],
          tools,
          tool_choice: 'auto',
          temperature: 0,
          max_tokens: 512,
          // thinking 是 DeepSeek 专有参数；本地 OpenAI 兼容服务收到会 400，故只在 DeepSeek 端点发
          ...(o.isDeepseek ? { thinking: { type: 'disabled' } } : {}),
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${raw.slice(0, 160)}`);
      }
      const d = await res.json();
      const msg = d?.choices?.[0]?.message || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
      return { toolCalls: calls && calls.length ? calls : null, usage: d?.usage || null };
    } finally {
      clearTimeout(timer);
      try { if (signal) signal.removeEventListener('abort', onAbort); } catch {}
    }
  }

  /**
   * 从上下文里的工具结果中取回「本次就诊上下文」。
   *
   * 为什么这么做：Dify 看不到我们的会话，必须在 query 里明确告诉它「本次第几诊 + 上次病历」，
   * 否则它会用 sys.dialogue_count 自己猜 —— 那正是「四诊标题矛盾」的根因。
   * 而这份上下文由 Pack 的 patient_lookup 权威产出（它读的是同一份注册表），
   * 这里只做**只读取回**，不重复实现患者匹配逻辑（避免两份实现给出不同的就诊次数）。
   */
  function visitContext(/** @type {any} */ messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== 'tool') continue;
      const s = String(m.content || '');
      if (!s.includes('"visitNo"')) continue;
      const a = s.indexOf('{');
      const b = s.lastIndexOf('}');
      if (a < 0 || b <= a) continue;
      try {
        const parsed = JSON.parse(s.slice(a, b + 1));
        const d = parsed?.data;
        if (d && Number.isFinite(Number(d.visitNo))) {
          return { visitNo: Number(d.visitNo), visitLabel: String(d.visitLabel || ''), lastSnapshot: d.lastSnapshot || null };
        }
      } catch { /* 该条不是我们要找的，继续往前找 */ }
    }
    return null;
  }

  return {
    name: pc.name,
    async chat(/** @type {any} */ opts) {
      const messages = Array.isArray(opts.messages) ? opts.messages : [];
      const tools = Array.isArray(opts.tools) ? opts.tools : [];
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
      const query = String(lastUser?.content || '').trim();
      if (!query) throw new Error('[dify] 没有可发送的用户消息');

      // —— ① 工具编排：判定要调工具就交回内核执行；判定失败一律回落 ——
      // 只把垂域工具交给编排器（见 PACK_TOOL_PREFIX 的说明）；没有垂域工具就整段跳过，
      // 不为「注定没有工具可调」的一轮多花一次模型调用。
      const packTools = tools.filter((t) => String(t?.function?.name || '').startsWith(PACK_TOOL_PREFIX));
      if (packTools.length) {
        try {
          const d = await decide(messages, packTools, opts.signal);
          if (d?.toolCalls?.length) {
            return { text: '', reasoning: '', toolCalls: d.toolCalls, usage: d.usage, finish: 'tool_calls' };
          }
        } catch (/** @type {any} */ e) {
          console.warn(`[dify] 工具编排判定失败，本轮回落为纯问诊（临床正文不受影响）：${e?.message || e}`);
        }
      }

      // —— ② Dify 流式问诊：这段正文会成为 provider 的 res.text → 受内核输出红线约束 ——
      const vc = visitContext(messages);
      let difyQuery = query;
      if (vc?.visitNo) {
        const n = vc.visitNo;
        const label = vc.visitLabel || (n === 1 ? '初诊' : `第${n}诊`);
        if (n > 1 && vc.lastSnapshot) {
          const block = Object.entries(FIELD_LABELS)
            .map(([k, name]) => `${name}：${String(vc.lastSnapshot[k] || '未提及')}`)
            .join('\n');
          difyQuery = `【就诊次数】本次为该患者第 ${n} 次就诊（${label}）；上次为第 ${n - 1} 次就诊，病历如下，请回顾并对比辨证，不要当作新病案、不要自行重算次数。\n${block}\n\n【本次（${label}）】\n${query}`;
        } else {
          difyQuery = `【就诊次数】本次为该患者第 ${n} 次就诊（${label}）。\n${query}`;
        }
      }

      const dbody = { inputs: {}, query: difyQuery, response_mode: 'streaming', user: 'mdh-dify-main' };
      if (conversationId) dbody.conversation_id = conversationId;
      const dres = await fetch(`${difyBaseUrl}/v1/chat-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${difyKey}` },
        body: JSON.stringify(dbody),
        signal: opts.signal,
      });
      if (!dres.ok) {
        const raw = await dres.text().catch(() => '');
        throw new Error(`[dify] HTTP ${dres.status}: ${raw.slice(0, 200)}`);
      }

      const reader = dres.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let answer = '';
      let usage = /** @type {any} */ ({});
      let ended = false;
      let streamError = '';
      const handle = (/** @type {string} */ payload) => {
        let j;
        try { j = JSON.parse(payload); } catch { return; }
        if (j.conversation_id) conversationId = j.conversation_id;
        if (j.event === 'message') { const c = j.answer || ''; answer += c; opts.onDelta?.({ text: c }); }
        else if (j.event === 'message_end') { if (j.metadata?.usage) usage = j.metadata.usage; ended = true; }
        else if (j.event === 'error') { streamError = String(j.message || j.error || j.code || 'Dify 工作流错误'); }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
        if (ended) break;
      }
      if (ended) { try { reader.cancel().catch(() => {}); } catch {} }
      if (!answer && streamError) throw new Error(`[dify] 工作流错误：${streamError}`);
      if (!answer) throw new Error('[dify] 工作流未返回正文（可能被限流或参数异常），请稍后重试');

      // <think> 段拆出来单独展示（与内核的 reasoning 通道对齐）
      let reasoning = '';
      let text = answer;
      const m = /<think>[\s\S]*?<\/think>/.exec(answer);
      if (m) { reasoning = m[0].slice(7, -8).trim(); text = answer.replace(m[0], '').trim(); }

      return {
        text,
        reasoning,
        toolCalls: null,
        usage: { prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0 },
        finish: 'stop',
      };
    },
  };
}
