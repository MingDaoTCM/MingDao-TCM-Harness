// Dify 主问诊（流式）+ 病历号患者系统：
// 患者注册表 patients.json（病历号→姓名/出生年/性别/末次就诊）；首诊分配病历号，复诊按姓名+出生年匹配；
// 同名多命中时返回候选让医师确认（不静默合并）；问诊走 Dify，落盘/四态由 DeepSeek（关思考）做。
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = {
  zhushu: '主诉（含疾病诊断+主要症状）',
  zhenduan: '诊断/重大疾病（西医诊断：癌症、肿瘤、糖尿病、心脏病等，必须原样记录，绝不允许省略）',
  hanre: '寒热', han: '汗', toushen: '头身', erbian: '二便',
  yinshi: '饮食', xiongfu: '胸腹', kouke: '口渴', jiubing: '旧病',
};

export function createProvider(pc) {
  const home = process.env.MINGDAO_HOME || '';
  let creds = {};
  try { creds = JSON.parse(fs.readFileSync(path.join(home, 'credentials.json'), 'utf8')); } catch {}
  const difyKey = pc.apiKey || creds.dify || '';
  const deepseekKey = creds.deepseek || '';
  const difyBaseUrl = String(pc.baseUrl || 'https://dify.mingdaotcm.cn').replace(/\/+$/, '');
  const deepseekBaseUrl = 'https://api.deepseek.com/v1';
  let conversationId = '';
  let pendingPatient = null; // { name, ids } 同名待确认

  const intakeRoot = () => path.join(home, 'intake');
  const registryPath = () => path.join(home, 'patients.json');
  function loadRegistry() {
    try { const r = JSON.parse(fs.readFileSync(registryPath(), 'utf8')); if (r && r.patients) return r; } catch {}
    return { nextId: 1, patients: {} };
  }
  function saveRegistry(/** @type {any} */ r) { fs.writeFileSync(registryPath(), JSON.stringify(r, null, 2) + '\n'); }
  function allocId(/** @type {any} */ reg) { const id = 'P' + String(reg.nextId).padStart(3, '0'); reg.nextId += 1; return id; }
  function listPatientSnapshots(/** @type {string} */ pid) {
    const dir = path.join(intakeRoot(), pid);
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    } catch { return []; }
  }
  function writeIntake(/** @type {string} */ pid, /** @type {any} */ fields, /** @type {any} */ pinfo) {
    const dir = path.join(intakeRoot(), pid);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `case-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ patientId: pid, patientName: pinfo.name || '', birth: pinfo.birth || '', sex: pinfo.sex || '', ...fields, collectedAt: new Date().toISOString(), source: 'dify-consult' }, null, 2) + '\n');
    return file;
  }

  async function deepseekJson(/** @type {string} */ system, /** @type {string} */ user, /** @type {number} */ maxTokens = 2000) {
    const res = await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: maxTokens, thinking: { type: 'disabled' } }),
    });
    const d = await res.json();
    const content = String(d.choices?.[0]?.message?.content || '').trim();
    const s = content.indexOf('{'); const e = content.lastIndexOf('}');
    return (s >= 0 && e > s) ? JSON.parse(content.slice(s, e + 1)) : null;
  }

  // 患者匹配：病历号精确 > 姓名+出生年/性别收窄；多命中返回 ambiguous
  function matchPatient(/** @type {any} */ reg, /** @type {any} */ info) {
    if (info.id && reg.patients[info.id]) return { patient: reg.patients[info.id] };
    const name = info.name || pendingPatient?.name || '';
    if (!name) return { unknown: true };
    const cands = Object.values(reg.patients).filter((/** @type {any} */ p) => p.name === name);
    if (!cands.length) return { isNew: true };
    let narrowed = cands;
    if (info.birth) narrowed = narrowed.filter((/** @type {any} */ p) => p.birth === info.birth);
    if (info.sex) narrowed = narrowed.filter((/** @type {any} */ p) => p.sex === info.sex);
    if (narrowed.length === 1) return { patient: narrowed[0] };
    if (narrowed.length === 0) return { isNew: true };
    return { ambiguous: narrowed };
  }


  // —— 工具三：回访追踪辅助 ——
  function daysSince(/** @type {string} */ iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
  }
  function followupDashboard(/** @type {any} */ reg, /** @type {number} */ threshDays = 14) {
    const rows = Object.values(reg.patients).map((/** @type {any} */ p) => {
      const n = listPatientSnapshots(p.id).length;
      const d = daysSince(p.lastVisitAt);
      const overdue = d != null && d >= threshDays;
      const noScript = n === 0;
      return { p, n, d, overdue, noScript };
    }).sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || ((b.d ?? 0) - (a.d ?? 0)));
    const overdue = rows.filter((r) => r.overdue);
    const L = [];
    L.push(`## 回访看板（超期阈值 ${threshDays} 天）`);
    L.push(`共 **${rows.length}** 位患者，其中 **${overdue.length}** 位超期未复诊。`);
    if (overdue.length) {
      L.push('');
      L.push('### ⚠ 超期未复诊');
      for (const r of overdue) L.push(`- ${r.p.name}${r.p.birth ? '（' + r.p.birth + '年生）' : ''}｜病历号 ${r.p.id}｜末次就诊 ${String(r.p.lastVisitAt || '—').slice(0, 10)}｜已 ${r.d} 天未复诊`);
    }
    L.push('');
    L.push('### 全部患者');
    L.push('| 病历号 | 患者 | 就诊次数 | 末次就诊 | 距今天数 | 状态 |');
    L.push('|---|---|---|---|---|---|');
    for (const r of rows) L.push(`| ${r.p.id} | ${r.p.name}${r.p.birth ? '（' + r.p.birth + '）' : ''} | ${r.n} | ${String(r.p.lastVisitAt || '—').slice(0, 10)} | ${r.d ?? '—'} | ${r.overdue ? '⚠ 超期' : '正常'} |`);
    L.push('');
    L.push('> 用法：`回访 <病历号>` 查看某患者的时间线趋势、异常预警与随访话术草稿。');
    return L.join('\n');
  }
  async function patientFollowup(/** @type {any} */ reg, /** @type {string} */ target) {
    let pt = reg.patients[target];
    if (!pt) {
      const byName = Object.values(reg.patients).filter((/** @type {any} */ x) => x.name === target);
      if (byName.length === 1) pt = byName[0];
      else if (byName.length > 1) return `有 ${byName.length} 位患者叫「${target}」，请用病历号区分：${byName.map((/** @type {any} */ x) => x.id).join('、')}`;
      else return `未找到患者「${target}」。可用「回访」查看全部患者。`;
    }
    const files = listPatientSnapshots(pt.id).reverse(); // 最早 → 最新
    if (!files.length) return `患者 ${pt.name}（${pt.id}）暂无病历快照。`;
    const history = files.map((/** @type {string} */ f, /** @type {number} */ i) => {
      let d = {}; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      return { 第几次就诊: i + 1, 日期: String(d.collectedAt || '').slice(0, 10), 主诉: d.zhushu, 诊断: d.zhenduan, 寒热: d.hanre, 汗: d.han, 头身: d.toushen, 二便: d.erbian, 饮食: d.yinshi, 胸腹: d.xiongfu, 口渴: d.kouke, 旧病: d.jiubing };
    });
    const ds = daysSince(pt.lastVisitAt);
    let out = `## 患者随访｜${pt.name}${pt.birth ? '（' + pt.birth + '年生）' : ''}｜病历号 ${pt.id}\n共 ${history.length} 次就诊，末次就诊 ${String(pt.lastVisitAt || '—').slice(0, 10)}${ds != null ? `（已 ${ds} 天）` : ''}。\n`;
    if (ds != null && ds >= 14) out += `\n⚠ **超期未复诊预警**：距上次就诊已 ${ds} 天。\n`;
    const r = await deepseekJson('你是中医随访助手。只输出一个 JSON。只陈述事实，绝不出现"有效""好转""治愈"等疗效结论。',
      `根据该患者历史就诊快照，输出：① trend：时间线趋势（各主症逐次就诊的变化，纯事实陈述）；② alerts：异常预警数组（症状加重、新发症状、超期未复诊；没有就空数组）；③ script：一段可直接发微信/打电话的随访话术草稿（含称呼、问候、上次情况回顾、本次要问的几个问题、提醒复诊，语气温和专业）。\n患者：${pt.name}${pt.birth ? '（' + pt.birth + '年生）' : ''}，病历号 ${pt.id}\n历史快照（按时间正序）：${JSON.stringify(history)}\n输出：{"trend":"...","alerts":["..."],"script":"..."}`);
    if (r) {
      if (r.trend) out += `\n### 一、时间线趋势\n${r.trend}\n`;
      if (Array.isArray(r.alerts) && r.alerts.length) out += `\n### 二、⚠ 异常预警\n${r.alerts.map((/** @type {string} */ a) => '- ' + a).join('\n')}\n`;
      if (r.script) out += `\n### 三、随访话术草稿（草稿·需医师确认）\n${r.script}\n`;
    } else {
      out += `\n（趋势/话术生成失败，请稍后重试）\n`;
    }
    return out;
  }

  return {
    name: pc.name,
    async chat(opts) {
      const messages = Array.isArray(opts.messages) ? opts.messages : [];
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
      const query = String(lastUser?.content || '').trim();
      if (!query) throw new Error('[dify] 没有可发送的用户消息');

      // —— 工具三：回访追踪（命令式，不走问诊、不占 Dify）——
      const fu = /^(回访|随访)\s*(.*)$/.exec(query);
      if (fu) {
        const reg0 = loadRegistry();
        const target = fu[2].trim();
        const fuText = target ? await patientFollowup(reg0, target) : followupDashboard(reg0);
        opts.onDelta?.({ text: fuText }); // 前端只渲染流式 text 事件，命令式结果也要推一次
        return { text: fuText, reasoning: '', toolCalls: null, usage: { prompt_tokens: 0, completion_tokens: 0 }, finish: 'stop' };
      }

      // —— 0) 患者识别 ——
      let info = { id: '', name: '', birth: '', sex: '' };
      if (deepseekKey) {
        try {
          const r = await deepseekJson('你是患者身份提取器。只输出一个 JSON。', `从下面消息提取患者身份，只返回 {"id":"病历号如P001(未提及为空)","name":"姓名","birth":"出生年4位数字(未提及为空)","sex":"男/女(未提及为空)"}。\n\n消息：${query}`, 200);
          info = { id: String(r?.id || '').trim().toUpperCase(), name: String(r?.name || '').trim().replace(/\s+/g, ''), birth: String(r?.birth || '').replace(/[^0-9]/g, '').slice(0, 4), sex: String(r?.sex || '').trim() };
        } catch {}
      }
      const reg = loadRegistry();
      const match = matchPatient(reg, info);

      // 同名多命中：返回候选，请医师确认（不落盘、不问诊）
      if (match.ambiguous) {
        const cands = /** @type {any[]} */ (match.ambiguous);
        pendingPatient = { name: info.name || pendingPatient?.name || '', ids: cands.map((p) => p.id) };
        const list = cands.map((p) => `· ${p.name}（${p.birth || '出生年未录'}年生，性别${p.sex || '未录'}，病历号 ${p.id}，末次就诊 ${String(p.lastVisitAt || '—').slice(0, 10)}）`).join('\n');
        const warnText = `⚠ 系统中有 ${cands.length} 位患者叫「${pendingPatient.name}」，为避免混病历，请确认是哪位（回复病历号，或补充出生年）：\n${list}`;
        opts.onDelta?.({ text: warnText }); // 前端只渲染流式 text 事件
        return { text: warnText, reasoning: '', toolCalls: null, usage: { prompt_tokens: 0, completion_tokens: 0 }, finish: 'stop' };
      }

      let pid, isFollowUp = false;
      if (match.patient) {
        const p = /** @type {any} */ (match.patient);
        pid = p.id; isFollowUp = true; pendingPatient = null;
      } else {
        pid = allocId(reg);
        reg.patients[pid] = { id: pid, name: info.name || pendingPatient?.name || '未命名', birth: info.birth || '', sex: info.sex || '', createdAt: new Date().toISOString(), lastVisitAt: '', visits: 0 };
        pendingPatient = null;
      }
      const thisPatient = reg.patients[pid];
      // 补齐已知字段
      if (!thisPatient.birth && info.birth) thisPatient.birth = info.birth;
      if (!thisPatient.sex && info.sex) thisPatient.sex = info.sex;

      const prevSnaps = listPatientSnapshots(pid);
      const prevSnapshot = prevSnaps.length > 0 ? (() => { try { return JSON.parse(fs.readFileSync(prevSnaps[0], 'utf8')); } catch { return null; } })() : null;

      // 由 MDH 明确就诊次数（Dify 自己用 dialogue_count 猜会错）
      const visitNo = prevSnaps.length + 1;
      const CN = ['', '初', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
      const vLabel = visitNo === 1 ? '初诊' : (visitNo <= 10 ? CN[visitNo] + '诊' : `第${visitNo}诊`);
      const difyQuery = prevSnapshot
        ? `【就诊次数】本次为该患者第 ${visitNo} 次就诊（${vLabel}）；上次为第 ${visitNo - 1} 次就诊，病历如下，请回顾并对比辨证，不要当作新病案、不要自行重算次数。\n${Object.entries(FIELDS).map(([k, label]) => `${label}：${String(prevSnapshot[k] || '未提及')}`).join('\n')}\n\n【本次（${vLabel}）】\n${query}`
        : `【就诊次数】本次为该患者第 1 次就诊（初诊）。\n${query}`;

      // —— 1) Dify 问诊（流式）——
      const dbody = { inputs: {}, query: difyQuery, response_mode: 'streaming', user: 'mdh-dify-main' };
      if (conversationId) dbody.conversation_id = conversationId;
      const dres = await fetch(`${difyBaseUrl}/v1/chat-messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${difyKey}` },
        body: JSON.stringify(dbody), signal: opts.signal,
      });
      if (!dres.ok) { const raw = await dres.text().catch(() => ''); throw new Error(`[dify] HTTP ${dres.status}: ${raw.slice(0, 200)}`); }

      const reader = dres.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', answer = '', usage = {}, ended = false, streamError = '';
      const handle = (payload) => {
        let j; try { j = JSON.parse(payload); } catch { return; }
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
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
        if (ended) break;
      }
      if (ended) { try { reader.cancel().catch(() => {}); } catch {} }
      if (!answer && streamError) throw new Error(`[dify] 工作流错误：${streamError}`);
      if (!answer) throw new Error('[dify] 工作流未返回正文（可能被限流或参数异常），请稍后重试');

      let reasoning = '';
      let text = answer;
      const m = /<think>[\s\S]*?<\/think>/.exec(answer);
      if (m) { reasoning = m[0].slice(7, -8).trim(); text = answer.replace(m[0], '').trim(); }

      // —— 2) 提取十问 + 落盘（按病历号目录）——
      let note = '';
      let currentFields = null;
      if (deepseekKey && text) {
        try {
          const patientText = messages.filter((x) => x?.role === 'user').map((x) => `患者: ${x.content}`).join('\n');
          const fieldList = 'zhushu主诉、zhenduan诊断(重大疾病如癌症/肿瘤/糖尿病/心脏病，必须原样保留，绝不省略或概括)、hanre寒热、han汗、toushen头身、erbian二便、yinshi饮食、xiongfu胸腹、kouke口渴、jiubing旧病';
          let extractUser;
          if (prevSnapshot) {
            const prevClean = {}; for (const k of Object.keys(FIELDS)) prevClean[k] = String(prevSnapshot[k] || '未提及');
            extractUser = `已知该患者上次快照：${JSON.stringify(prevClean)}。结合患者的复诊消息，生成本次完整快照：本次未变的项沿用上次表述，本次明确变化的项用新表述（如"睡眠好多了"）。字段：${fieldList}。输出 {"complete":true,...}；若仍缺关键项返回 {"complete":false,"missing":[...]}。缺项绝不编造。\n\n患者复诊消息：\n${patientText}`;
          } else {
            extractUser = `从下面问诊对话提取中医问诊字段。字段：${fieldList}。规则：① 对话中提及的任何疾病诊断（如宫颈癌）必须原样填入 zhenduan，绝不允许过滤；② 任一必填项未明确出现就返回 {"complete":false,"missing":[...]}；齐全才返回 {"complete":true,...}；③ 缺项绝不编造。\n\n对话：\n${patientText}`;
          }
          const extracted = await deepseekJson('你是病历结构化提取器。只输出一个 JSON 对象。', extractUser);
          if (extracted?.complete) {
            currentFields = {};
            for (const k of Object.keys(FIELDS)) currentFields[k] = String(extracted[k] || '').trim();
            const file = writeIntake(pid, currentFields, thisPatient);
            note = `\n\n📋 病历快照已落盘｜患者 ${thisPatient.name}${thisPatient.birth ? '（' + thisPatient.birth + '年生）' : ''}｜病历号 ${pid}｜${vLabel}（第 ${visitNo} 次就诊）：${path.basename(file)}（草稿·需医师确认）`;
          }
        } catch {}
      }

      // —— 3) 复诊四态对比 ——
      if (currentFields && prevSnapshot) {
        try {
          const prevClean = {}; for (const k of Object.keys(FIELDS)) prevClean[k] = String(prevSnapshot[k] || '未提及');
          const cmp = await deepseekJson('你是复诊疗效对比助手。只输出 JSON。只陈述事实，绝不出现"有效""好转""治愈"等结论。',
            `对比该患者上次就诊与本次就诊的逐项症状，判定四态：消失（上次有、本次无）、减轻（本次程度下降）、无变化（基本一致）、加重（本次程度上升或新增）。\n上次快照：${JSON.stringify(prevClean)}\n本次快照：${JSON.stringify(currentFields)}\n输出：{"items":[{"label":"寒热","last":"...","now":"...","state":"减轻"},...]}`
          );
          if (cmp?.items?.length) {
            const rows = cmp.items.map((/** @type {any} */ it) => `| ${it.label} | ${it.last} | ${it.now} | ${it.state} |`).join('\n');
            note += `\n\n📊 复诊四态对比（仅陈述事实，不作疗效结论）：\n| 症状 | 上次 | 本次 | 变化 |\n|---|---|---|---|\n${rows}`;
          }
        } catch {}
      }

      // 更新注册表
      thisPatient.lastVisitAt = new Date().toISOString();
      thisPatient.visits = (thisPatient.visits || 0) + 1;
      saveRegistry(reg);

      return { text: text + note, reasoning, toolCalls: null, usage: { prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0 }, finish: 'stop' };
    },
  };
}
