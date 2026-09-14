// 中医垂域 Pack（Pack API v1）—— 把原先塞在 providers/dify.mjs 的 chat() 里的域逻辑搬出来，
// 变成内核一等公民：与内置工具走同一条「权限 → 审计 → schema 瘦身 → 费用归因 → 约束校验」链路。
//
// ⚠ 架构现状（重要，勿误读）：
//   本 Pack 的工具**要被调用，前提是 agent 的模型能产出 tool_calls**。Dify Chatflow 不产出
//   tool_calls（providers/dify.mjs 恒返回 toolCalls:null），因此当前若 provider=dify，
//   这些工具是「已注册但不会被触发」的状态。这是骨架期的刻意状态：先把域能力搬进扩展点、
//   让 pack verify 与约束测试跑通，再由「谁驱动问诊」的架构决策决定如何接线。
//   详见同目录 README.md。
//
// 能力面说明（与 PACK-API.md 的出入，已按 v0.6.2 真实代码核对）：
//   - createPack(ctx) 只拿到 { home, packDir, packName, log }；ctx.llm 不在这里，
//     它在工具运行期的 toolCtx 上 → 所以所有模型调用都发生在 run() 内部；
//   - ctx.readJson / ctx.writeJsonAtomic / ctx.audit / ctx.storage **均未实现**，
//     文件 IO 一律用 node:fs（官方参考实现 packs/example-hello 亦如此）；
//   - permissions 目前只是**声明**，内核不据此强制 → 本文件的 fs 访问靠路径白名单自律。
import fs from 'node:fs';
import path from 'node:path';

export const apiVersion = 1;

/** 十问字段（zhenduan 单列，见下方提示词硬规则：重大疾病诊断必须原样保留） */
export const FIELDS = {
  zhushu: '主诉（含疾病诊断+主要症状）',
  zhenduan: '诊断/重大疾病（西医诊断：癌症、肿瘤、糖尿病、心脏病等，必须原样记录，绝不允许省略）',
  hanre: '寒热', han: '汗', toushen: '头身', erbian: '二便',
  yinshi: '饮食', xiongfu: '胸腹', kouke: '口渴', jiubing: '旧病',
};

/** completeness 约束校验的必填字段（顺序即提示词顺序） */
export const REQUIRED_FIELDS = Object.keys(FIELDS);

/** 复诊四态（顺序固定，供提示词与渲染共用） */
export const FOUR_STATES = ['消失', '减轻', '无变化', '加重'];

/** 超期未复诊阈值（天） */
export const OVERDUE_DAYS = 14;

// ─────────────────────────── 纯函数（可单测，不碰 IO） ───────────────────────────

/** 计算距今天数；无效输入返回 null（不抛错，调用方按「未知」处理） */
export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
}

/**
 * 患者匹配：病历号精确 > 姓名 + 出生年/性别收窄；多命中返回 ambiguous（**不静默合并**）。
 * 这是医疗安全属性：同名患者绝不能被自动挑一个。
 * @returns {{patient?:any}|{isNew:true}|{ambiguous:any[]}|{unknown:true}}
 */
export function matchPatient(registry, info = {}) {
  const patients = registry?.patients || {};
  const id = String(info.id || '').trim().toUpperCase();
  if (id && patients[id]) return { patient: patients[id] };
  const name = String(info.name || '').trim();
  if (!name) return { unknown: true };
  const cands = Object.values(patients).filter((p) => p?.name === name);
  if (!cands.length) return { isNew: true };
  let narrowed = cands;
  const birth = String(info.birth || '').replace(/[^0-9]/g, '').slice(0, 4);
  const sex = String(info.sex || '').trim();
  if (birth) narrowed = narrowed.filter((p) => String(p.birth || '') === birth);
  if (sex) narrowed = narrowed.filter((p) => String(p.sex || '') === sex);
  if (narrowed.length === 1) return { patient: narrowed[0] };
  if (narrowed.length === 0) return { isNew: true };
  return { ambiguous: narrowed };
}

/** 从模型返回的 JSON 里挑出十个字段（缺失一律空串，绝不编造） */
export function normalizeFields(raw) {
  const out = /** @type {Record<string,string>} */ ({});
  for (const k of REQUIRED_FIELDS) out[k] = String(raw?.[k] ?? '').trim();
  return out;
}

/** 缺项列表：空串 / 未提及 均视为缺（与内核 completeness 的口径保持一致） */
export function missingFields(fields) {
  return REQUIRED_FIELDS.filter((f) => {
    const v = fields?.[f];
    return v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '未提及';
  });
}

/** 就诊次序中文标签（内核明确注入，不让 Dify 用 dialogue_count 猜） */
export function visitLabel(n) {
  const CN = ['', '初', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (n <= 1) return '初诊';
  return n <= 10 ? `${CN[n]}诊` : `第${n}诊`;
}

// ─────────────────────────── Pack 入口 ───────────────────────────

/**
 * @param {{home?:string, packDir:string, packName:string, log?:(m:string)=>void}} ctx
 */
export function createPack(ctx) {
  const home = String(ctx.home || process.env.MINGDAO_HOME || '');
  const packDir = String(ctx.packDir || '');
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};

  const registryPath = () => path.join(home, 'patients.json');
  const intakeRoot = () => path.join(home, 'intake');

  /** 原子写：先写同目录临时文件再 rename，避免崩溃时留下半截 JSON（患者数据不可半写） */
  function writeJsonAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function loadRegistry() {
    try {
      const r = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
      if (r && typeof r === 'object' && r.patients) return r;
    } catch {}
    return { nextId: 1, patients: {} };
  }

  function allocId(reg) {
    // 防御：nextId 被外部改坏时不会分配出重复病历号
    let n = Number(reg.nextId) || 1;
    let id = `P${String(n).padStart(3, '0')}`;
    while (reg.patients[id]) { n += 1; id = `P${String(n).padStart(3, '0')}`; }
    reg.nextId = n + 1;
    return id;
  }

  /**
   * 某患者全部快照，**最新在前**。
   * 排序刻意按文件名里的时间戳数值，而不是 mtime：
   * 同一毫秒内写入两份时 mtime 完全相同，排序结果不确定，而 visit_compare 的
   * 「上次 vs 本次」直接依赖这个顺序 —— 顺序错 = 对比表左右颠倒 = 事实陈述出错。
   * 非 `case-<epoch>.json` 命名的文件回落到 mtime，保证老数据仍可读。
   */
  function snapshotOrder(file) {
    const m = /^case-(\d+)\.json$/.exec(path.basename(file));
    if (m) return Number(m[1]);
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
  }
  function listSnapshots(pid) {
    const dir = path.join(intakeRoot(), pid);
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => snapshotOrder(b) - snapshotOrder(a));
    } catch { return []; }
  }

  function readSnapshot(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  /** 落盘一份病历快照，返回文件路径 */
  function writeIntake(pid, fields, patient) {
    const dir = path.join(intakeRoot(), pid);
    // 文件名必须唯一：`case-${Date.now()}.json` 在同一毫秒内两次落盘会**互相覆盖**，
    // 结果是复诊把首诊病历顶掉、就诊次数与事实不符。撞名时把时间戳 +1ms 直到空位。
    let ts = Date.now();
    let file = path.join(dir, `case-${ts}.json`);
    while (fs.existsSync(file)) { ts += 1; file = path.join(dir, `case-${ts}.json`); }
    writeJsonAtomic(file, {
      patientId: pid,
      patientName: patient?.name || '',
      birth: patient?.birth || '',
      sex: patient?.sex || '',
      ...fields,
      collectedAt: new Date().toISOString(),
      source: 'tcm-pack',
    });
    return file;
  }

  /**
   * 领域模型出口。**必须**经 toolCtx.llm —— 否则费用隐身、护栏失效、无法归因。
   * 参数与原 providers/dify.mjs 的 deepseekJson 逐项等价（已按 PACK-API §3.3.1 核对）：
   *   thinking:{type:'disabled'} ↔ reasoningEffort:'off'；自切花括号 ↔ json:true。
   * @returns {Promise<any|null>} 解析失败返回 null（不抛错，与原有语义一致）
   */
  async function llmJson(toolCtx, { system, user, purpose, maxTokens = 2000 }) {
    if (typeof toolCtx?.llm !== 'function') {
      log(`toolCtx.llm 不可用（purpose=${purpose}）——域内模型调用将无法计入费用与护栏`);
      return null;
    }
    const r = await toolCtx.llm({
      model: 'deepseek-v4-flash',
      system,
      user,
      maxTokens,
      temperature: 0,
      reasoningEffort: 'off',
      json: true,
      purpose,
    });
    return r?.data ?? null;
  }

  /** 模型给出的纯文本出口（随访话术等非 JSON 场景，未使用） */

  // ───────── 工具一：患者定位（读） ─────────
  async function patientLookup(args, toolCtx) {
    const reg = loadRegistry();
    const info = { id: args?.id, name: args?.name, birth: args?.birth, sex: args?.sex };

    // 未给任何线索时，可直接用 DeepSeek 从「本次问诊原文」里抽身份（与原 chat() 行为一致）
    if (!info.id && !info.name && args?.text && typeof toolCtx?.llm === 'function') {
      const r = await llmJson(toolCtx, {
        system: '你是患者身份提取器。只输出一个 JSON。',
        user: `从下面消息提取患者身份，只返回 {"id":"病历号如P001(未提及为空)","name":"姓名","birth":"出生年4位数字(未提及为空)","sex":"男/女(未提及为空)"}。\n\n消息：${String(args.text).slice(0, 2000)}`,
        maxTokens: 200,
        purpose: 'patient-extract',
      });
      info.id = String(r?.id || '').trim().toUpperCase();
      info.name = String(r?.name || '').trim().replace(/\s+/g, '');
      info.birth = String(r?.birth || '').replace(/[^0-9]/g, '').slice(0, 4);
      info.sex = String(r?.sex || '').trim();
    }

    const m = matchPatient(reg, info);

    if (m.ambiguous) {
      const list = m.ambiguous
        .map((p) => `· ${p.name}（${p.birth || '出生年未录'}年生，性别${p.sex || '未录'}，病历号 ${p.id}，末次就诊 ${String(p.lastVisitAt || '—').slice(0, 10)}）`)
        .join('\n');
      return {
        ok: true,
        output: `⚠ 系统中有 ${m.ambiguous.length} 位患者叫「${info.name}」，为避免混病历，请确认是哪位（回复病历号，或补充出生年）：\n${list}`,
        data: { status: 'ambiguous', candidates: m.ambiguous.map((p) => ({ id: p.id, name: p.name, birth: p.birth, sex: p.sex, lastVisitAt: p.lastVisitAt })) },
      };
    }
    if (m.patient) {
      const p = m.patient;
      const visits = listSnapshots(p.id).length;
      return {
        ok: true,
        output: `已定位患者：${p.name}${p.birth ? `（${p.birth}年生）` : ''}｜病历号 ${p.id}｜性别 ${p.sex || '未录'}｜已有 ${visits} 次就诊记录｜末次就诊 ${String(p.lastVisitAt || '—').slice(0, 10)}。本次为第 ${visits + 1} 次就诊（${visitLabel(visits + 1)}）。`,
        data: { status: 'found', patient: { id: p.id, name: p.name, birth: p.birth, sex: p.sex, lastVisitAt: p.lastVisitAt }, visits, visitNo: visits + 1, visitLabel: visitLabel(visits + 1) },
      };
    }
    if (m.isNew) {
      return {
        ok: true,
        output: `未找到既有患者「${info.name}」${info.birth ? `（${info.birth}年生）` : ''}，按**首诊**处理（病历号将在采集落盘时分配）。`,
        data: { status: 'new', name: info.name, birth: info.birth, sex: info.sex },
      };
    }
    return {
      ok: true,
      output: '未提供足够信息定位患者。请让医师补充姓名 + 出生年，或直接给出病历号。',
      data: { status: 'none' },
    };
  }

  // ───────── 工具二：十问采集 + 病理落盘（写） ─────────
  async function intakeCollect(args, toolCtx) {
    const pidRaw = String(args?.patientId || '').trim().toUpperCase();
    // 兜底校验（约束引擎之外的第二层）：没有确认过的病历号一律不写
    if (!pidRaw) return { ok: false, error: '缺少 patientId——请先用 patient_lookup 确认患者，拿到病历号后再落盘（避免混病历）' };

    const reg = loadRegistry();
    const patient = reg.patients[pidRaw];
    if (!patient) {
      return {
        ok: false,
        error: `病历号 ${pidRaw} 不存在。若确为新患者，请先用 patient_lookup 确认身份，由系统分配病历号。现有病历号：${Object.keys(reg.patients).join('、') || '（暂无）'}`,
      };
    }

    const consultText = String(args?.consultText || '').slice(0, 20000);
    if (!consultText.trim()) return { ok: false, error: '缺少 consultText（本次问诊的医患对话原文）' };

    const prevFiles = listSnapshots(pidRaw);
    const prevSnapshot = prevFiles.length ? readSnapshot(prevFiles[0]) : null;
    const visitNo = prevFiles.length + 1;

    const fieldList = 'zhushu主诉、zhenduan诊断(重大疾病如癌症/肿瘤/糖尿病/心脏病，必须原样保留，绝不省略或概括)、hanre寒热、han汗、toushen头身、erbian二便、yinshi饮食、xiongfu胸腹、kouke口渴、jiubing旧病';
    const extractUser = prevSnapshot
      ? `已知该患者上次快照：${JSON.stringify(Object.fromEntries(REQUIRED_FIELDS.map((k) => [k, String(prevSnapshot[k] || '未提及')])))}。结合患者的复诊消息，生成本次完整快照：本次未变的项沿用上次表述，本次明确变化的项用新表述（如"睡眠好多了"）。字段：${fieldList}。输出 {"complete":true,...}；若仍缺关键项返回 {"complete":false,"missing":[...]}。缺项绝不编造。\n\n患者复诊消息：\n${consultText}`
      : `从下面问诊对话提取中医问诊字段。字段：${fieldList}。规则：① 对话中提及的任何疾病诊断（如宫颈癌）必须原样填入 zhenduan，绝不允许过滤；② 任一必填项未明确出现就返回 {"complete":false,"missing":[...]}；齐全才返回 {"complete":true,...}；③ 缺项绝不编造。\n\n对话：\n${consultText}`;

    const extracted = await llmJson(toolCtx, {
      system: '你是病历结构化提取器。只输出一个 JSON 对象。',
      user: extractUser,
      purpose: 'intake-extract',
    });

    if (!extracted) {
      return { ok: false, error: '结构化提取失败（模型未返回可解析的 JSON）。未落盘，请重试。' };
    }

    const fields = normalizeFields(extracted);
    const missing = missingFields(fields);

    if (extracted.complete !== true || missing.length) {
      // 刻意**不落盘**：半份病历比没有更危险（会被后续复诊当成上次基线）。
      // 同时把 data 交出去，让内核的 completeness 约束再独立拦一次（双保险）。
      return {
        ok: true,
        output: `⚠ 必填项缺失：${missing.map((f) => FIELDS[f]).join('、')}。缺项绝不编造，请继续向患者采集后再落盘。`,
        data: fields,
      };
    }

    const file = writeIntake(pidRaw, fields, patient);
    patient.lastVisitAt = new Date().toISOString();
    patient.visits = (patient.visits || 0) + 1;
    if (!patient.birth && args?.birth) patient.birth = String(args.birth);
    saveRegistry(reg);

    return {
      ok: true,
      output: `📋 病历快照已落盘｜患者 ${patient.name}${patient.birth ? `（${patient.birth}年生）` : ''}｜病历号 ${pidRaw}｜${visitLabel(visitNo)}（第 ${visitNo} 次就诊）：${path.basename(file)}（草稿·需医师确认）`,
      data: { ...fields, __file: path.basename(file), __visitNo: visitNo },
    };
  }

  function saveRegistry(reg) {
    writeJsonAtomic(registryPath(), reg);
  }

  // ───────── 工具二：新患者登记（写） ─────────
  // 为什么必须有这个工具：原 chat() 在调用 Dify **之前**就 allocId 建好了患者记录，
  // 所以「采集落盘」永远有一个已存在的病历号可用。迁到 Pack 后如果只保留采集工具，
  // 新患者就永远建不出来（首诊直接卡死）。登记单独成一个显式动作，
  // 既补上这条链路，又保持「intake_collect 必须带已确认病历号」这条约束不被放松。
  async function patientRegister(args) {
    const name = String(args?.name || '').trim().replace(/\s+/g, '');
    if (!name) return { ok: false, error: '缺少 name——登记新患者必须有姓名' };
    const birth = String(args?.birth || '').replace(/[^0-9]/g, '').slice(0, 4);
    const sex = String(args?.sex || '').trim();

    const reg = loadRegistry();

    // 安全闸门：同名已有患者时**拒绝登记**，把选择权交回医师。
    // 若这里放行，就会出现「两个张三」——正是「避免混病历」要防的事。
    const m = matchPatient(reg, { name, birth, sex });
    if (m.ambiguous) {
      const list = m.ambiguous
        .map((p) => `· ${p.name}（${p.birth || '出生年未录'}年生，性别${p.sex || '未录'}，病历号 ${p.id}，末次就诊 ${String(p.lastVisitAt || '—').slice(0, 10)}）`)
        .join('\n');
      return {
        ok: false,
        error: `系统中已有 ${m.ambiguous.length} 位患者叫「${name}」，不得重复登记。请让医师确认是哪位（或补齐出生年以区分）：\n${list}`,
      };
    }
    if (m.patient) {
      return {
        ok: false,
        error: `患者「${name}」已存在（病历号 ${m.patient.id}），请直接使用该病历号，不要重复登记。`,
      };
    }

    const pid = allocId(reg);
    reg.patients[pid] = {
      id: pid, name, birth, sex,
      createdAt: new Date().toISOString(),
      lastVisitAt: '',
      visits: 0,
    };
    saveRegistry(reg);
    return {
      ok: true,
      output: `已登记新患者：${name}${birth ? `（${birth}年生）` : ''}｜病历号 ${pid}。请用该病历号调用 intake_collect 落盘首诊病历。`,
      data: { patientId: pid, name, birth, sex },
    };
  }

  // ───────── 工具三：复诊四态对比（读） ─────────
  async function visitCompare(args, toolCtx) {
    const pid = String(args?.patientId || '').trim().toUpperCase();
    const reg = loadRegistry();
    const patient = reg.patients[pid];
    if (!patient) return { ok: false, error: `病历号 ${pid} 不存在。` };

    const files = listSnapshots(pid); // 最新在前
    if (files.length < 2) {
      return { ok: true, output: `患者 ${patient.name}（${pid}）目前只有 ${files.length} 次就诊记录，无法做复诊对比。`, data: { items: [] } };
    }
    const now = readSnapshot(files[0]) || {};
    const last = readSnapshot(files[1]) || {};
    const pick = (s) => Object.fromEntries(REQUIRED_FIELDS.map((k) => [k, String(s[k] || '未提及')]));

    const cmp = await llmJson(toolCtx, {
      system: '你是复诊疗效对比助手。只输出 JSON。只陈述事实，绝不出现"有效""好转""治愈"等结论。',
      user: `对比该患者上次就诊与本次就诊的逐项症状，判定四态：消失（上次有、本次无）、减轻（本次程度下降）、无变化（基本一致）、加重（本次程度上升或新增）。\n上次快照：${JSON.stringify(pick(last))}\n本次快照：${JSON.stringify(pick(now))}\n输出：{"items":[{"label":"寒热","last":"...","now":"...","state":"减轻"},...]}`,
      purpose: 'visit-compare',
    });

    if (!cmp?.items?.length) {
      return { ok: true, output: '（四态对比生成失败，请稍后重试）', data: { items: [] } };
    }
    const rows = cmp.items.map((it) => `| ${it.label} | ${it.last} | ${it.now} | ${it.state} |`).join('\n');
    return {
      ok: true,
      output: `📊 复诊四态对比（仅陈述事实，不作疗效结论）：\n| 症状 | 上次 | 本次 | 变化 |\n|---|---|---|---|\n${rows}`,
      data: { items: cmp.items },
    };
  }

  // ───────── 工具四：回访看板 / 单患者随访（读） ─────────
  async function followupBoard(args, toolCtx) {
    const target = String(args?.patientId || args?.target || '').trim();
    const reg = loadRegistry();

    if (!target) {
      const rows = Object.values(reg.patients).map((p) => {
        const n = listSnapshots(p.id).length;
        const d = daysSince(p.lastVisitAt);
        return { p, n, d, overdue: d != null && d >= OVERDUE_DAYS };
      }).sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || ((b.d ?? 0) - (a.d ?? 0)));
      const overdue = rows.filter((r) => r.overdue);
      const L = [];
      L.push(`## 回访看板（超期阈值 ${OVERDUE_DAYS} 天）`);
      L.push(`共 **${rows.length}** 位患者，其中 **${overdue.length}** 位超期未复诊。`);
      if (overdue.length) {
        L.push('');
        L.push('### ⚠ 超期未复诊');
        for (const r of overdue) L.push(`- ${r.p.name}${r.p.birth ? `（${r.p.birth}年生）` : ''}｜病历号 ${r.p.id}｜末次就诊 ${String(r.p.lastVisitAt || '—').slice(0, 10)}｜已 ${r.d} 天未复诊`);
      }
      L.push('');
      L.push('### 全部患者');
      L.push('| 病历号 | 患者 | 就诊次数 | 末次就诊 | 距今天数 | 状态 |');
      L.push('|---|---|---|---|---|---|');
      for (const r of rows) L.push(`| ${r.p.id} | ${r.p.name}${r.p.birth ? `（${r.p.birth}）` : ''} | ${r.n} | ${String(r.p.lastVisitAt || '—').slice(0, 10)} | ${r.d ?? '—'} | ${r.overdue ? '⚠ 超期' : '正常'} |`);
      return { ok: true, output: L.join('\n'), data: { total: rows.length, overdue: overdue.length } };
    }

    let pt = reg.patients[target];
    if (!pt) {
      const byName = Object.values(reg.patients).filter((x) => x.name === target);
      if (byName.length === 1) pt = byName[0];
      else if (byName.length > 1) {
        return { ok: true, output: `有 ${byName.length} 位患者叫「${target}」，请用病历号区分：${byName.map((x) => x.id).join('、')}`, data: { status: 'ambiguous' } };
      } else {
        return { ok: true, output: `未找到患者「${target}」。可用 followup_board 不带参数查看全部患者。`, data: { status: 'none' } };
      }
    }

    const files = listSnapshots(pt.id).reverse(); // 最早 → 最新
    if (!files.length) return { ok: true, output: `患者 ${pt.name}（${pt.id}）暂无病历快照。`, data: { visits: 0 } };

    const history = files.map((f, i) => {
      const d = readSnapshot(f) || {};
      return { 第几次就诊: i + 1, 日期: String(d.collectedAt || '').slice(0, 10), ...pickFieldsCn(d) };
    });
    const ds = daysSince(pt.lastVisitAt);
    let out = `## 患者随访｜${pt.name}${pt.birth ? `（${pt.birth}年生）` : ''}｜病历号 ${pt.id}\n共 ${history.length} 次就诊，末次就诊 ${String(pt.lastVisitAt || '—').slice(0, 10)}${ds != null ? `（已 ${ds} 天）` : ''}。\n`;
    if (ds != null && ds >= OVERDUE_DAYS) out += `\n⚠ **超期未复诊预警**：距上次就诊已 ${ds} 天。\n`;

    const r = await llmJson(toolCtx, {
      system: '你是中医随访助手。只输出一个 JSON。只陈述事实，绝不出现"有效""好转""治愈"等疗效结论。',
      user: `根据该患者历史就诊快照，输出：① trend：时间线趋势（各主症逐次就诊的变化，纯事实陈述）；② alerts：异常预警数组（症状加重、新发症状、超期未复诊；没有就空数组）；③ script：一段可直接发微信/打电话的随访话术草稿（含称呼、问候、上次情况回顾、本次要问的几个问题、提醒复诊，语气温和专业）。\n患者：${pt.name}${pt.birth ? `（${pt.birth}年生）` : ''}，病历号 ${pt.id}\n历史快照（按时间正序）：${JSON.stringify(history)}\n输出：{"trend":"...","alerts":["..."],"script":"..."}`,
      purpose: 'followup-script',
    });

    if (r) {
      if (r.trend) out += `\n### 一、时间线趋势\n${r.trend}\n`;
      if (Array.isArray(r.alerts) && r.alerts.length) out += `\n### 二、⚠ 异常预警\n${r.alerts.map((a) => `- ${a}`).join('\n')}\n`;
      if (r.script) out += `\n### 三、随访话术草稿（草稿·需医师确认）\n${r.script}\n`;
    } else {
      out += '\n（趋势/话术生成失败，请稍后重试）\n';
    }
    return { ok: true, output: out, data: { visits: history.length, overdueDays: ds } };
  }

  /** 快照 → 中文字段（随访时间线用） */
  function pickFieldsCn(d) {
    const CN = { zhushu: '主诉', zhenduan: '诊断', hanre: '寒热', han: '汗', toushen: '头身', erbian: '二便', yinshi: '饮食', xiongfu: '胸腹', kouke: '口渴', jiubing: '旧病' };
    const out = /** @type {Record<string,any>} */ ({});
    for (const k of REQUIRED_FIELDS) out[CN[k]] = d[k];
    return out;
  }

  return {
    tools: [
      {
        name: 'patient_lookup',
        description:
          '定位患者：按病历号精确匹配，或按姓名 + 出生年/性别收窄。返回病历号、就诊次数与本次应为第几次就诊。' +
          '**同名多命中时返回候选列表而不会替你挑一个**（避免混病历）——此时必须请医师确认后再继续。' +
          '任何针对具体患者的操作（采集落盘、复诊对比、随访）都应先调用本工具拿到病历号。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '病历号，如 P001（医师明确给出时用）' },
            name: { type: 'string', description: '患者姓名' },
            birth: { type: 'string', description: '出生年 4 位数字' },
            sex: { type: 'string', description: '男 / 女' },
            text: { type: 'string', description: '本次问诊原文（未提供 id/name 时，由系统从中提取身份）' },
          },
          required: [],
        },
        readOnly: true,
        run: patientLookup,
      },
      {
        name: 'patient_register',
        description:
          '登记新患者并分配病历号（写操作）。**仅在 patient_lookup 返回「new」且医师确认确为初诊时调用**。' +
          '若系统中已有同名患者，本工具会拒绝登记并把候选交回医师确认——绝不重复建人、绝不静默合并。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '患者姓名' },
            birth: { type: 'string', description: '出生年 4 位数字（强烈建议提供，用于区分同名）' },
            sex: { type: 'string', description: '男 / 女' },
          },
          required: ['name'],
        },
        readOnly: false,
        run: patientRegister,
      },
      {
        name: 'intake_collect',
        description:
          '十问采集与病历落盘：把本次问诊原文结构化成本次完整病历快照并写入 intake/<病历号>/。' +
          '**必填十项齐全才落盘**；缺项会明确回报「请继续采集」而**绝不编造、不落盘半份病历**。' +
          '必须提供已由 patient_lookup 确认过的 patientId。',
        parameters: {
          type: 'object',
          properties: {
            patientId: { type: 'string', description: '已确认的病历号，如 P001' },
            consultText: { type: 'string', description: '本次问诊的医患对话原文（越完整越准）' },
          },
          required: ['patientId', 'consultText'],
        },
        readOnly: false,
        run: intakeCollect,
      },
      {
        name: 'visit_compare',
        description:
          '复诊四态对比：读取该患者最近两次病历快照，逐项判定 消失 / 减轻 / 无变化 / 加重。' +
          '**只陈述事实，不作任何疗效结论**。应在 intake_collect 落盘本次快照之后调用。',
        parameters: {
          type: 'object',
          properties: { patientId: { type: 'string', description: '病历号，如 P001' } },
          required: ['patientId'],
        },
        readOnly: true,
        run: (args, toolCtx) => visitCompare(args, toolCtx),
      },
      {
        name: 'followup_board',
        description:
          '回访追踪：不带参数时给出全部患者的回访看板与超期未复诊预警；带 patientId 或姓名时给出该患者的' +
          '时间线趋势、异常预警与随访话术草稿（话术标注「草稿·需医师确认」）。',
        parameters: {
          type: 'object',
          properties: { patientId: { type: 'string', description: '病历号或姓名；不填则输出全部患者看板' } },
          required: [],
        },
        readOnly: true,
        run: followupBoard,
      },
    ],

    // ─── 三条领域红线：由内核强制，不依赖模型自觉 ───
    constraints: [
      // 红线一：不得跨患者串病历 —— 没有确认病历号的写入一律拒绝（比原来「仅同名多命中时拒绝」更强）
      { id: 'no-cross-patient-intake', kind: 'tool-arg-require', tool: 'intake_collect', requireArg: 'patientId', action: 'block' },
      { id: 'no-cross-patient-compare', kind: 'tool-arg-require', tool: 'visit_compare', requireArg: 'patientId', action: 'block' },
      // 红线二：缺项绝不编造 —— 十问缺任一项即拒绝该结果，要求模型继续采集
      { id: 'ten-questions-complete', kind: 'completeness', tool: 'intake_collect', fields: REQUIRED_FIELDS, onMissing: 'reject' },
      // 红线三：不输出诊疗结论 —— 只判「疗效结论」，刻意不含「确诊为」：
      //   医师病历里会有既往确诊事实（如"2024 年确诊为宫颈癌"），拦它会把「重大疾病诊断必须原样保留」这条需求顶掉。
      { id: 'no-efficacy-conclusion', kind: 'output-forbid', pattern: '有效|好转|治愈', action: 'block-and-rewrite' },
    ],

    promptSections: [
      {
        id: 'tcm-domain',
        order: 100,
        content: readPrompt(packDir, 'prompts/domain.md'),
      },
    ],
  };
}

/** 读提示词段；缺失时返回空串（loadPack 会因为 contributes 声明缺文件而告警，这里不抛错） */
function readPrompt(packDir, rel) {
  try { return fs.readFileSync(path.join(packDir, rel), 'utf8'); } catch { return ''; }
}
