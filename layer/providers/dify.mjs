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
//   · **智能程度 = 明道中医层** → 患者定位/登记/病历落盘/四态对比/回访，全部由 Pack 工具承担。
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

/**
 * 声明本 Provider 支持视觉（上游 v0.6.3 的「路 B」，官方推荐）。
 * 内核的图片门控会咨询自定义 Provider 的这个导出（src/providers/index.js），
 * 于是医师上传的舌象照片不会再被 `buildUserContent` 拒收。
 *
 * 注意这背后要有真本事：本文件负责把图片**上传给 Dify** 并随 query 一起提交
 * （见 chat() 里的 files 处理），Dify 应用侧需开启视觉。
 */
export const supportsVision = true;

/**
 * 编排器系统提示。
 * 关键点：明确告诉它「不要产出临床内容」——临床正文由 Dify 负责。
 * 不需要调工具时让它回「继续」，这个文本会被丢弃（不进入正文、不进入历史）。
 */
const DECIDE_SYSTEM = `你是中医问诊系统的**编排器**，只做一件事：判断这一轮该调用哪些工具。

【硬性流程，不是可选项】只要医师这一轮给出了含「主诉 / 现病史」的病历正文，
就必须把这次就诊**落盘**，顺序固定：
  1) patient_lookup —— 确认这个人是老患者还是新患者
  2) lookup 说「未找到 / 首诊」→ patient_register 建号
  3) intake_collect —— 落盘本次病历
  4) 老患者复诊 → 落盘之后 visit_compare

**绝不要停在 patient_lookup。** 它只回答"这个人是谁"，不落盘就等于这次就诊丢失，
下次复诊会被判成首诊 —— 这是本系统最严重的一类错误（患者病历断链）。

其余需要调用工具的情形：
- 医师要看回访看板 / 随访提醒 → followup_board
- 上一次工具结果提示「必填项缺失」而医师已补充 → 重新 patient_lookup 后 intake_collect

**不需要**调用工具的情形（只有这些）：
- 医师只是在追问、要求解释某个概念、闲聊，**且这一轮没有给出新的病历正文**
- 这一轮纯粹复述上一轮内容

注意：「由问诊工作流回答」指的是**临床正文**由它写，**不是**说不用落盘。
落盘与问诊正文是两件事，同一轮里都要做。

不需要调工具时，只回复两个字：继续。
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
   *   ~/.mingdao-tcm/config.json
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
   * 把一条消息的 content 拆成「纯文本 + 图片 dataURL 列表」。
   * 内核在模型声明 supportVision 后会发多模态数组（`[{type:'text'},{type:'image_url'}]`），
   * 直接 `String(content)` 会得到 "[object Object]" —— 必须显式解析。
   */
  function splitParts(content) {
    if (typeof content === 'string') return { text: content, images: [] };
    if (!Array.isArray(content)) return { text: '', images: [] };
    const texts = [];
    const images = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') texts.push(String(part.text || ''));
      else if (part.type === 'image_url') {
        const url = String(part.image_url?.url || '');
        if (url) images.push(url);
      }
    }
    return { text: texts.join('\n'), images };
  }

  /** dataURL → Blob（Node 18+ 原生 Blob/FormData，零依赖） */
  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl));
    if (!m) return null;
    return new Blob([Buffer.from(m[2], 'base64')], { type: m[1] });
  }

  /** 把图片上传给 Dify，返回 upload_file_id（Dify 的 files 只认它或可抓取的 URL） */
  async function uploadToDify(dataUrl, signal) {
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) return null;
    const fd = new FormData();
    fd.append('file', blob, `tongue-${Date.now()}.jpg`);
    fd.append('user', 'mdh-dify-main');
    const r = await fetch(`${difyBaseUrl}/v1/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${difyKey}` },
      body: fd,
      signal,
    });
    if (!r.ok) {
      const raw = await r.text().catch(() => '');
      throw new Error(`舌象照片上传失败：HTTP ${r.status} ${raw.slice(0, 160)}`);
    }
    const j = await r.json().catch(() => null);
    return j?.id ? String(j.id) : null;
  }

  /**
   * 红线改写请求要交给 **DeepSeek**，不能交给 Dify。
   *
   * 为什么：内核在 output-forbid 命中 block-and-rewrite 时会调用 `provider.chat()`
   * 让我们「改写掉违规措辞」。但我们的 Provider 会把请求转给 Dify 中医工作流 ——
   * 那个工作流本身就是产出这类措辞的，让它改写等于让它再写一遍，改完仍然命中。
   * 纯文本改写是通用任务，用关思考的 DeepSeek 更合适也更便宜。
   *
   * 识别依据是内核生成的那句提示（`命中...领域红线`），tools 为空。
   */
  function isRewriteRequest(messages, tools) {
    if (Array.isArray(tools) && tools.length) return false;
    const last = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.role === 'user');
    return /命中了?领域红线|改写成/.test(splitParts(last?.content).text);
  }

  /** 用 DeepSeek 做一次纯文本改写（关思考、不流式、不归 Pack 账——它是内核触发的合规动作） */
  async function rewriteWithDeepseek(messages, signal) {
    const o = orchestrator();
    if (!o.apiKey) return null;
    const res = await fetch(`${o.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({
        model: o.model,
        messages: (Array.isArray(messages) ? messages : []).map((m) => ({ role: m.role, content: splitParts(m.content).text })),
        temperature: 0,
        max_tokens: 2048,
        ...(o.isDeepseek ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal,
    });
    if (!res.ok) return null;
    const d = await res.json();
    return { text: String(d?.choices?.[0]?.message?.content || '').trim(), usage: d?.usage || null };
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
   *
   * `lastVisitText` 是 Pack **渲染好的中文块**，本文件原样转发、**不认任何字段**。
   * 为什么不在 provider 里渲染：同一份字段契约定义两处必然漂移 ——
   * 2026-09-15 病历结构重构后就是如此，复诊注入的「上次病历」除主诉外全是「未提及」、
   * 现病史与四诊整段丢失，且不报错。字段语义只在 `packs/tcm/pack.mjs` 一处（FIELD_CN）。
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
          return {
            visitNo: Number(d.visitNo),
            visitLabel: String(d.visitLabel || ''),
            lastVisitText: typeof d.lastVisitText === 'string' ? d.lastVisitText : '',
          };
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

      // —— ⓪ 内核的红线改写请求：交给 DeepSeek，不要转给 Dify（见 isRewriteRequest 的说明）——
      if (isRewriteRequest(opts.messages, tools)) {
        try {
          const rw = await rewriteWithDeepseek(opts.messages, opts.signal);
          if (rw?.text) {
            return { text: rw.text, reasoning: '', toolCalls: null, usage: rw.usage, finish: 'stop' };
          }
        } catch (/** @type {any} */ e) {
          console.warn(`[dify] 红线改写调用失败，交由内核按原策略处理：${e?.message || e}`);
        }
        // 改写不成 → 让 Dify 兜底（内核仍会二次校验）
      }

      // 多模态：内核在 supportsVision 下会发数组，直接 String() 会得到 "[object Object]"
      const parts = splitParts(lastUser?.content);
      const query = String(parts.text || '').trim();
      if (!query && !parts.images.length) throw new Error('[dify] 没有可发送的用户消息');

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
        if (n > 1 && vc.lastVisitText) {
          // 「上次病历」块由 Pack 渲染好（renderVisitBlock），这里**原样转发**。
          difyQuery = `【就诊次数】本次为该患者第 ${n} 次就诊（${label}）；上次为第 ${n - 1} 次就诊，病历如下，请回顾并对比辨证，不要当作新病案、不要自行重算次数。\n${vc.lastVisitText}\n\n【本次（${label}）】\n${query}`;
        } else {
          difyQuery = `【就诊次数】本次为该患者第 ${n} 次就诊（${label}）。\n${query}`;
        }
      }

      // 舌象照片：先上传拿 upload_file_id，再随 query 一起提交给 Dify（Dify 应用侧需开启视觉）
      const files = [];
      for (const dataUrl of parts.images) {
        try {
          const id = await uploadToDify(dataUrl, opts.signal);
          if (id) files.push({ type: 'image', transfer_method: 'local_file', upload_file_id: id });
        } catch (/** @type {any} */ e) {
          // 照片传不上去**不能挡住问诊**：正文照常进行，只是这次没有图片
          console.warn(`[dify] ${e?.message || e}（本次问诊继续，仅缺图片）`);
        }
      }
      const dbody = { inputs: {}, query: difyQuery, response_mode: 'streaming', user: 'mdh-dify-main' };
      if (files.length) dbody.files = files;
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
      // Dify 工作流把模型的 <think>…</think> 推理**混在同一串 answer 分片里**（实测 1369 字 / 全文 2530 字）。
      // 处理原则（医师定稿）：思考过程**保留可看**，但必须与问诊正文分流，且不显示标签本身。
      //   · 正文  → `{ text }`      → 内核 writeText      → SSE text（受输出红线约束）
      //   · 思考  → `{ reasoning }` → 内核 writeReasoning → SSE reasoning（独立通道，不着红线）
      // 分流后标签天然不会出现在任何一条流里，前端只需给两条流不同的排版。
      let emitted = 0;
      let emittedThink = 0;
      // 全局处理**所有** <think>…</think> 段：Dify 可能把多个 LLM 节点的输出拼在一起，
      // 只剥第一段会让第二段连着标签一起留在正文里（实测确认，正好违反「隐藏标签」）。
      const THINK_RE = /<think>([\s\S]*?)<\/think>/g;
      const visibleOf = (/** @type {string} */ s) => {
        let out = '';
        let last = 0;
        THINK_RE.lastIndex = 0;
        let m;
        while ((m = THINK_RE.exec(s))) { out += s.slice(last, m.index); last = m.index + m[0].length; }
        out += s.slice(last);
        const i = out.indexOf('<think>'); // 未闭合的开标签：其后整体归思考通道
        return i >= 0 ? out.slice(0, i) : out;
      };
      const thinkingOf = (/** @type {string} */ s) => {
        const parts = [];
        let last = 0;
        THINK_RE.lastIndex = 0;
        let m;
        while ((m = THINK_RE.exec(s))) { parts.push(m[1]); last = m.index + m[0].length; }
        const i = s.slice(last).indexOf('<think>');
        if (i >= 0) parts.push(s.slice(last + i + 7));
        return parts.join('\n');
      };
      // 末尾可能是 "<thi" / "</thi" 这类半个标签：先扣住，避免发出后再回撤
      const holdBack = (/** @type {string} */ v, /** @type {string} */ tag) => {
        for (let k = Math.min(tag.length - 1, v.length); k > 0; k--) if (tag.startsWith(v.slice(-k))) return v.length - k;
        return v.length;
      };
      const emitStreams = (/** @type {boolean} */ final) => {
        const v = visibleOf(answer);
        const n = final ? v.length : holdBack(v, '<think>');
        if (n > emitted) { opts.onDelta?.({ text: v.slice(emitted, n) }); emitted = n; }
        const th = thinkingOf(answer);
        const tn = final ? th.length : holdBack(th, '</think>');
        if (tn > emittedThink) { opts.onDelta?.({ reasoning: th.slice(emittedThink, tn) }); emittedThink = tn; }
      };
      const handle = (/** @type {string} */ payload) => {
        let j;
        try { j = JSON.parse(payload); } catch { return; }
        if (j.conversation_id) conversationId = j.conversation_id;
        if (j.event === 'message') { answer += j.answer || ''; emitStreams(false); }
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
      emitStreams(true); // 补发被 holdBack 扣住的尾巴（与最终 text / reasoning 对齐）
      if (!answer && streamError) throw new Error(`[dify] 工作流错误：${streamError}`);
      if (!answer) throw new Error('[dify] 工作流未返回正文（可能被限流或参数异常），请稍后重试');

      // 思考过程：与上面流式分流的**同一套语义**（thinkingOf），保证「看到的」与「落库的」一致
      let reasoning = thinkingOf(answer).trim();
      let text = visibleOf(answer).trim();
      if (!text) {
        // 整段都被未闭合的 <think> 吞掉：正文位显式说明，推理照旧留在 reasoning 通道
        text = '（本次回复未产出可见正文：模型输出未正常闭合，请重试）';
      }

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
