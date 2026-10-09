// 中医垂域 Pack（Pack API v1）—— 把原先塞在 providers/dify.mjs 的 chat() 里的域逻辑搬出来，
// 变成内核一等公民：与内置工具走同一条「权限 → 审计 → schema 瘦身 → 费用归因 → 约束校验」链路。
//
// ⚠ 架构现状（重要，勿误读）：本 Pack 的 5 个工具**现在会被真实触发**。
//   路线 A（2026-09-14 定，已接线）：providers/dify.mjs 每轮先用小模型（编排器）判一次
//   「这一轮要不要调工具」，要调就返回 tool_calls 交回内核执行；判定不调才走 Dify 流式问诊。
//   编排器只看 `pack__*` 前缀的垂域工具，通用工具不交给它（否则它会去 ls/read 翻代码库）。
//   详见同目录 README.md §四。
//
//   ⚠ 给改架构的人：本段注释描述的是**骨架期**状态（工具已注册但不会触发），
//   路线 A 接线后早已不成立，但它在那之后还留了很久 ——
//   而这是一个人打开 pack.mjs 时读到的第一段话，等于给他一套不存在的架构。
//   现在 `tools/doc-lint.mjs` 的 INV-4 会守住这件事；改架构时请连这段注释一起改。
//   注意：INV-4 是字面匹配，所以这里**不要**再把旧说法原样抄一遍当反面例子 —— 抄了照样命中。
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

/**
 * 病历字段（2026-09-15 按医师要求重构为门诊病历的书写结构，取代原「十问」）。
 *
 * 原十问（寒热/汗/头身/二便/饮食/胸腹/口渴/旧病）是**问诊采集清单**；
 * 现在改成**病历结构**：主诉 + 现病史为必填，其余按实际接诊情况可选。
 * 四诊信息（舌象/脉象）单独留字段——此前无处可放，医师写下的舌脉会被直接丢掉。
 */
export const FIELDS = {
  zhushu: '主诉（主要症状 + 持续时间，一句话）',
  xianbingshi: '现病史（本次发病起因、经过、症状演变、诊治经过、现在症）',
  jiwangshi: '既往史（既往疾病、手术、外伤、输血等）',
  jiazushi: '家族史（家族中同类疾病或遗传病）',
  guominshi: '过敏史（药物/食物/接触物过敏）',
  liuxingbingshi: '流行病史（疫区接触、传染病接触、聚集发病等）',
  tigejiancha: '体格检查（T/P/R/BP、心肺腹、专科体征等）',
  shexiang: '舌象（望诊：舌质、舌体、舌苔）',
  maixiang: '脉象（切诊：脉位、脉数、脉形）',
  suifang: '随访（本次嘱托、复诊安排、需追踪的观察点）',
};

/**
 * 必填：**只有主诉与现病史**（医师明确要求）。
 * 其余七项按实际接诊情况可选 —— 首诊来不及查体、患者说不清家族史，
 * 都不该因此挡住病历落盘（宁可少记，不可挡住记录）。
 */
export const REQUIRED_FIELDS = ['zhushu', 'xianbingshi'];

/** 可选字段：记录但不强制（含四诊的舌象/脉象） */
export const OPTIONAL_FIELDS = ['jiwangshi', 'jiazushi', 'guominshi', 'liuxingbingshi', 'tigejiancha', 'shexiang', 'maixiang', 'suifang'];

/** 全部会落盘的字段（必填在前，可选在后） */
export const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

/**
 * 字段中文短名 —— **字段语义的唯一定义处**（问诊台时间线与「上次病历」注入块共用）。
 *
 * 为什么要抽出来、并把渲染权收在 Pack 里：
 * 复诊时注入给 Dify 的「上次病历」块，此前由 **provider**（`providers/dify.mjs`）
 * 按它自己那份**旧十问**字段表渲染。病历结构 2026-09-15 重构后 provider 那份没跟上，
 * 于是复诊时除主诉外全部字段渲染成「未提及」，现病史与四诊（舌象/脉象）整段丢失，
 * **而且不报错、不崩溃、测试还是绿的**（测试夹具同样用了旧字段）。
 * 根因不是"漏改一行"，是**同一份契约被定义在两处**。所以：
 *   · 渲染权归 Pack（本文件）→ `renderVisitBlock()`；
 *   · provider 只把成品转发出去，**零字段知识** → 结构上不再可能漂移。
 */
export const FIELD_CN = {
  zhushu: '主诉', xianbingshi: '现病史', jiwangshi: '既往史', jiazushi: '家族史',
  guominshi: '过敏史', liuxingbingshi: '流行病史', tigejiancha: '体格检查',
  shexiang: '舌象', maixiang: '脉象', suifang: '随访',
};

/**
 * 把一份病历快照渲染成可注入上下文的「上次病历」中文块。
 * 键集严格取自 `ALL_FIELDS`、标签取自 `FIELD_CN` —— 新增字段若忘了加标签，
 * `pack.test.mjs` 的字段契约断言会当场失败（而不是静默丢掉一个字段）。
 * @param {Record<string, any>|null|undefined} snapshot
 * @returns {string}
 */
export function renderVisitBlock(snapshot) {
  return ALL_FIELDS.map((k) => `${FIELD_CN[k]}：${String(snapshot?.[k] || '未提及')}`).join('\n');
}

/** 复诊四态（顺序固定，供提示词与渲染共用） */
export const FOUR_STATES = ['消失', '减轻', '无变化', '加重'];

/** 超期未复诊阈值（天）：达到它就进「超期」提醒 */
export const OVERDUE_DAYS = 14;

/**
 * 临期提前量（天）：距超期不足这么多天时进「临期」提醒。
 * 为什么除了「超期」还要「临期」：等到已经超期才提醒，医师就没有提前量了 ——
 * 主动提醒的价值恰恰在于**还没超期时就能把复诊排上**。
 */
export const DUE_SOON_DAYS = 3;

// ─────────────────────────── 纯函数（可单测，不碰 IO） ───────────────────────────

/** 计算距今天数；无效输入返回 null（不抛错，调用方按「未知」处理） */
export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
}

/**
 * 随访状态：`'overdue'`（已超期）/ `'due-soon'`（临期）/ `'ok'`（正常）/ `'none'`（从未就诊）。
 *
 * **这是「谁该随访」的唯一判定处**：回访看板（`followup_board`）与问诊台的提醒条都必须走它。
 * 为什么收在一处：两处各写一遍天数比较，改了阈值或差一天就会对不上 ——
 * 医师会在两个界面看到**不同的「超期人数」**，而且都不报错。
 * @param {{lastVisitAt?: string}|null|undefined} patient
 * @param {number} [now]
 * @returns {'overdue'|'due-soon'|'ok'|'none'}
 */
export function followupStatus(patient, now = Date.now()) {
  const d = daysSince(patient?.lastVisitAt, now);
  if (d == null) return 'none';
  if (d >= OVERDUE_DAYS) return 'overdue';
  if (d >= OVERDUE_DAYS - DUE_SOON_DAYS) return 'due-soon';
  return 'ok';
}

/** 状态严重度（排序用：超期 > 临期 > 正常 > 未就诊） */
export const STATUS_RANK = { overdue: 3, 'due-soon': 2, ok: 1, none: 0 };

/** 状态中文名（看板与界面共用，避免各写一份措辞） */
export const STATUS_CN = { overdue: '超期', 'due-soon': '临期', ok: '正常', none: '未就诊' };

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
  for (const k of ALL_FIELDS) out[k] = String(raw?.[k] ?? '').trim();
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

// ───────────────────── 数据访问（Pack 工具与问诊台共用）─────────────────────
// 为什么这几支要导出：问诊台（tools/tcm-ui）的「患者名册 / 历史」必须在服务端读同一批
// 文件。让它 import 这里的函数、而不是自己再写一份，是为了**读语义只有一个定义处**：
//   · 注册表损坏时**大声失败**（绝不降级成空注册表 —— 会发重病历号）；
//   · 快照按**文件名里的时间戳**排序、不用 mtime（同毫秒两次落盘 mtime 相同、顺序不定）；
//   · 只认 `case-<epoch>.json` 命名，其余回落 mtime。
// 这些语义被第二处抄错，就会出现「医师看到的就诊次数/顺序与落盘的不一致」——静默失真。
// 与 FIELD_CN 收敛到一处是同一个道理（见该常量上方的说明）。

/** 患者注册表路径 */
/**
 * 原子写：先写同目录临时文件再 rename，避免崩溃时留下半截 JSON。
 * 患者数据**不可半写** —— 半份注册表比没有更危险（会被当成"这个人不存在"而重新发号）。
 */
export function writeJsonAtomicAt(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 改患者基本信息（姓名/出生年/性别）。**只动这几项**，病历与就诊记录一律不碰 ——
 * 改名字不该影响任何一次就诊内容。
 * @returns {{ok:true, patient:any} | {ok:false, error:string}}
 */
export function updatePatient(home, id, patch = {}) {
  const pid = String(id || '').trim().toUpperCase();
  if (!/^P\d{3,}$/.test(pid)) return { ok: false, error: '非法的病历号' };
  let reg;
  try { reg = loadRegistryFrom(home); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  const p = reg.patients?.[pid];
  if (!p) return { ok: false, error: `病历号 ${pid} 不存在` };

  const next = { ...p };
  if (patch.name !== undefined) {
    const name = String(patch.name).trim().replace(/\s+/g, '');
    if (!name) return { ok: false, error: '姓名不能为空' };
    next.name = name;
  }
  if (patch.birth !== undefined) next.birth = String(patch.birth).replace(/[^0-9]/g, '').slice(0, 4);
  if (patch.sex !== undefined) {
    const sex = String(patch.sex).trim();
    if (sex && !['男', '女'].includes(sex)) return { ok: false, error: '性别只能是男/女（或留空）' };
    next.sex = sex;
  }
  next.updatedAt = new Date().toISOString();
  reg.patients[pid] = next;
  try { writeJsonAtomicAt(registryFile(home), reg); } catch (e) { return { ok: false, error: `写入失败：${e?.message || e}` }; }
  return { ok: true, patient: { id: pid, ...next } };
}

/**
 * 删除患者。**同时删掉其病历快照目录** —— 只从注册表摘掉会留下无主病历，
 * 下次同名患者登记时可能被误当作历史（混病历是不可逆的错误）。
 * 要求显式 `confirm: true`：调用方必须先让医师确认。
 * @returns {{ok:true, removed:number} | {ok:false, error:string}}
 */
export function deletePatient(home, id, { confirm = false } = {}) {
  const pid = String(id || '').trim().toUpperCase();
  if (!/^P\d{3,}$/.test(pid)) return { ok: false, error: '非法的病历号' };
  if (!confirm) return { ok: false, error: '删除患者需要显式确认（confirm:true）' };
  let reg;
  try { reg = loadRegistryFrom(home); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  if (!reg.patients?.[pid]) return { ok: false, error: `病历号 ${pid} 不存在` };

  const dir = path.join(intakeRootDir(home), pid);
  let removed = 0;
  try {
    if (fs.existsSync(dir)) {
      removed = fs.readdirSync(dir).length;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) { return { ok: false, error: `病历目录删除失败：${e?.message || e}` }; }

  delete reg.patients[pid];
  try { writeJsonAtomicAt(registryFile(home), reg); } catch (e) { return { ok: false, error: `注册表写入失败：${e?.message || e}` }; }
  return { ok: true, removed };
}

export function registryFile(home) {
  return path.join(String(home || ''), 'patients.json');
}

/** 病历快照根目录 */
export function intakeRootDir(home) {
  return path.join(String(home || ''), 'intake');
}

/**
 * 读患者注册表。
 *
 * ⚠ 刻意**不**把「文件存在但读不出来」降级成空注册表。
 * 空注册表会让 allocId 从 P001 重新发号，而 P001 的病历快照可能还躺在 intake/P001/ 里
 * —— 结果是**两个不同患者共用一个病历号**，正是三条红线要防的串病历，
 * 而且它静默发生（返回 ok:true，没有任何告警）。
 * 损坏（断电半写、手工编辑出错、磁盘故障）时必须**大声失败**：
 * 宁可拒绝服务，也不能发错号 —— 发错号是不可逆的，拒绝服务是可恢复的。
 * 只有「文件根本不存在」（全新 home）才允许从 P001 开始。
 */
export function loadRegistryFrom(home) {
  const p = registryFile(home);
  if (!fs.existsSync(p)) return { nextId: 1, patients: {} };
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`患者注册表无法读取（${p}）：${e?.message || e}。为避免病历号冲突/串病历，已停止操作——请先修复或从备份恢复该文件。`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`患者注册表 JSON 已损坏（${p}）：${e?.message || e}。为避免病历号冲突/串病历，已停止操作——请先修复或从备份恢复该文件。`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.patients || typeof parsed.patients !== 'object' || Array.isArray(parsed.patients)) {
    throw new Error(`患者注册表结构不符（${p}）：期望形如 {"nextId":1,"patients":{}}。为避免病历号冲突/串病历，已停止操作。`);
  }
  return parsed;
}

/**
 * 快照排序键：**文件名里的时间戳数值**。
 * 刻意不用 mtime：同一毫秒内写入两份时 mtime 完全相同，排序结果不确定，
 * 而 visit_compare 的「上次 vs 本次」直接依赖这个顺序（顺序错 = 对比表左右颠倒）。
 * 非 `case-<epoch>.json` 命名的文件回落到 mtime，保证老数据仍可读。
 */
export function snapshotOrder(file) {
  const m = /^case-(\d+)\.json$/.exec(path.basename(file));
  if (m) return Number(m[1]);
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 某患者全部快照文件，**最新在前** */
export function listSnapshotFiles(home, pid) {
  const dir = path.join(intakeRootDir(home), pid);
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => snapshotOrder(b) - snapshotOrder(a));
  } catch { return []; }
}

/** 读一份快照；读不出来返回 null（调用方按「无此快照」处理） */
export function readSnapshotFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ─────────────────────────── Pack 入口 ───────────────────────────

/**
 * @param {{home?:string, packDir:string, packName:string, log?:(m:string)=>void}} ctx
 */
export function createPack(ctx) {
  const home = String(ctx.home || process.env.MINGDAO_HOME || '');
  const packDir = String(ctx.packDir || '');
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};

  const registryPath = () => registryFile(home);
  const intakeRoot = () => intakeRootDir(home);

  /** 原子写：委托模块级实现（**一处实现**：工具与"患者编辑/删除"共用同一套写盘纪律） */
  function writeJsonAtomic(file, obj) {
    writeJsonAtomicAt(file, obj);
  }

  /** 读患者注册表（语义见模块级 loadRegistryFrom：损坏一律大声失败） */
  function loadRegistry() {
    return loadRegistryFrom(home);
  }

  /**
   * 把 loadRegistry 的异常收敛成工具统一的 `{ok:false, error}` 形状。
   * 底层仍**抛异常**（这样将来任何忘记处理的调用点都会 fail-closed，而不是拿着 undefined 继续跑），
   * 这里只负责在工具边界转成正常返回值——避免同一个 Pack 里「有的错返回、有的错抛异常」两种风格。
   */
  function tryRegistry() {
    try {
      return { reg: loadRegistry() };
    } catch (e) {
      return { error: { ok: false, error: String(e?.message || e) } };
    }
  }

  /**
   * 分配病历号。双保险：除了注册表自身的 nextId，还跳过**盘上已有 intake/<id>/ 目录**的号。
   * 注册表被回滚、被替换、或 nextId 被外部改小时，这一步能独立挡住
   * 「把已有病历的号再发给另一个患者」——不依赖注册表自身是否完好。
   */
  function allocId(reg) {
    let n = Number(reg.nextId) || 1;
    let id = `P${String(n).padStart(3, '0')}`;
    while (reg.patients[id] || fs.existsSync(path.join(intakeRoot(), id))) {
      n += 1;
      id = `P${String(n).padStart(3, '0')}`;
    }
    reg.nextId = n + 1;
    return id;
  }

  /** 某患者全部快照，**最新在前**（排序语义见模块级 listSnapshotFiles） */
  function listSnapshots(pid) {
    return listSnapshotFiles(home, pid);
  }

  /** 读一份快照（读不出来返回 null，调用方按「无此快照」处理） */
  function readSnapshot(file) {
    return readSnapshotFile(file);
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
    const { reg, error } = tryRegistry();
    if (error) return error;
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
      const snaps = listSnapshots(p.id);
      const visits = snaps.length;
      // lastSnapshot / lastVisitText：把「上一次病历」一并交出去。
      // 为什么放在工具结果里：路线 A 下 Dify 仍负责产出临床正文，而 Dify 看不到我们的会话，
      // 它必须收到「本次第几诊 + 上次病历摘要」才能正确回顾对比（否则会重演「四诊标题矛盾」）。
      // 内核把整个结果（含 data）序列化进消息上下文，provider 因此能取回它 —— 见 dify.mjs 的 visitContext()。
      //
      // lastVisitText 是**渲染好的中文块**：provider 直接转发、不认字段（见 FIELD_CN 的说明）。
      // lastSnapshot 一并保留，供调试与将来的消费方使用。
      const last = visits ? readSnapshot(snaps[0]) : null;
      const lastSnapshot = last ? Object.fromEntries(ALL_FIELDS.map((k) => [k, String(last[k] || '')])) : null;
      const lastVisitText = lastSnapshot ? renderVisitBlock(lastSnapshot) : null;
      return {
        ok: true,
        output: `已定位患者：${p.name}${p.birth ? `（${p.birth}年生）` : ''}｜病历号 ${p.id}｜性别 ${p.sex || '未录'}｜已有 ${visits} 次就诊记录｜末次就诊 ${String(p.lastVisitAt || '—').slice(0, 10)}。本次为第 ${visits + 1} 次就诊（${visitLabel(visits + 1)}）。`,
        data: {
          status: 'found',
          patient: { id: p.id, name: p.name, birth: p.birth, sex: p.sex, lastVisitAt: p.lastVisitAt },
          visits, visitNo: visits + 1, visitLabel: visitLabel(visits + 1),
          lastSnapshot, lastVisitText,
        },
      };
    }
    if (m.isNew) {
      return {
        ok: true,
        // 明确写出**下一步**：编排器看得到工具结果，但"未找到患者"这句话本身
        // 并不足以让它接着建号落盘 —— 2026-09-23 实测过，它查到"首诊"就停了，
        // 于是这次就诊没落盘、下次复诊又被判首诊。把动作写进结果里，别指望它自己推。
        output: `未找到既有患者「${info.name}」${info.birth ? `（${info.birth}年生）` : ''}，本次按**首诊**处理。`
          + `\n→ 下一步（必须做完）：调用 patient_register 建号，再调用 intake_collect 落盘本次病历。`
          + `只做 patient_lookup 等于这次就诊丢失，下次复诊会被当成首诊。`,
        data: { status: 'new', name: info.name, birth: info.birth, sex: info.sex },
      };
    }
    return {
      ok: true,
      output: '未提供足够信息定位患者。请让医师补充姓名 + 出生年，或直接给出病历号。',
      data: { status: 'none' },
    };
  }

  // ───────── 工具二：病历采集 + 落盘（写） ─────────
  async function intakeCollect(args, toolCtx) {
    const pidRaw = String(args?.patientId || '').trim().toUpperCase();
    // 兜底校验（约束引擎之外的第二层）：没有确认过的病历号一律不写
    if (!pidRaw) return { ok: false, error: '缺少 patientId——请先用 patient_lookup 确认患者，拿到病历号后再落盘（避免混病历）' };

    const { reg, error } = tryRegistry();
    if (error) return error;
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

    const fieldList = 'zhushu主诉(主要症状+持续时间，一句话)、xianbingshi现病史(本次发病的起因/经过/症状演变/诊治经过/现在症，逐项写全)'
      + '；**可选八项**（有就原样记、没有就留空，**不计入 missing、不影响 complete**）：jiwangshi既往史、jiazushi家族史、guominshi过敏史、liuxingbingshi流行病史、tigejiancha体格检查、shexiang舌象（如"舌红苔黄"；若医师上传了舌象照片，可写"[舌象照片见附件]"并保留文字描述）、maixiang脉象（如"脉弦细"）、suifang随访（嘱托/复诊安排/需追踪的观察点）';
    const extractUser = prevSnapshot
      ? `已知该患者上次快照：${JSON.stringify(Object.fromEntries(ALL_FIELDS.map((k) => [k, String(prevSnapshot[k] || '未提及')])))}。结合患者的复诊消息，生成本次完整快照：本次未变的项沿用上次表述，本次明确变化的项用新表述（如"睡眠好多了"）。字段：${fieldList}。输出 {"complete":true,...}；若仍缺**必填**项返回 {"complete":false,"missing":[...]}。缺项绝不编造。\n\n患者复诊消息：\n${consultText}`
      : `从下面问诊对话提取门诊病历字段。字段：${fieldList}。规则：① 对话中提及的任何疾病诊断（尤其癌症/肿瘤/糖尿病/心脏病等重大疾病，如宫颈癌）必须**原样**写进 xianbingshi（或 zhushu），绝不允许过滤、省略或概括成"慢性病"，既往确诊同样是事实要原样保留；② 两项**必填**（zhushu/xianbingshi）任一未明确出现就返回 {"complete":false,"missing":[...]}；两项齐全才返回 {"complete":true,...}；③ 缺项绝不编造，绝不用"未见异常""大致正常"填空；④ 其余八项可选，采集到就填、没采集到就留空。\n\n对话：\n${consultText}`;

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

    const { reg, error } = tryRegistry();
    if (error) return error;

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
    const { reg, error } = tryRegistry();
    if (error) return error;
    const patient = reg.patients[pid];
    if (!patient) return { ok: false, error: `病历号 ${pid} 不存在。` };

    const files = listSnapshots(pid); // 最新在前
    if (files.length < 2) {
      return { ok: true, output: `患者 ${patient.name}（${pid}）目前只有 ${files.length} 次就诊记录，无法做复诊对比。`, data: { items: [] } };
    }
    const now = readSnapshot(files[0]) || {};
    const last = readSnapshot(files[1]) || {};
    const pick = (s) => Object.fromEntries(ALL_FIELDS.map((k) => [k, String(s[k] || '未提及')]));

    const cmp = await llmJson(toolCtx, {
      system: '你是复诊疗效对比助手。只输出 JSON。只陈述事实，绝不出现"有效""好转""治愈"等结论。',
      user: `对比该患者上次就诊与本次就诊的逐项症状，判定四态：消失（上次有、本次无）、减轻（本次程度下降）、无变化（基本一致）、加重（本次程度上升或新增）。\n上次快照：${JSON.stringify(pick(last))}\n本次快照：${JSON.stringify(pick(now))}\n输出：{"items":[{"label":"寒热","last":"...","now":"...","state":"减轻"},...]}`,
      purpose: 'visit-compare',
    });

    if (!cmp?.items?.length) {
      return { ok: true, output: '（四态对比生成失败，请稍后重试）', data: { items: [] } };
    }
    // 固化进**本次**就诊快照：同一次就诊的四态对比是既定事实，历史里应当直接看得到，
    // 而不是每次翻病历都要再问一遍模型（既慢又可能给出不一致的结果）。
    try {
      const cur = readSnapshot(files[0]) || {};
      cur.compare = { at: new Date().toISOString(), items: cmp.items };
      writeJsonAtomic(files[0], cur);
    } catch { /* 固化失败不该让对比本身失败：结果照常返回给模型与医师 */ }

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
    const { reg, error } = tryRegistry();
    if (error) return error;

    if (!target) {
      // 状态判定统一走 followupStatus —— 与问诊台提醒条**同一处口径**（见该函数说明）
      const now = Date.now();
      const rows = Object.values(reg.patients).map((p) => {
        const n = listSnapshots(p.id).length;
        return { p, n, d: daysSince(p.lastVisitAt, now), status: followupStatus(p, now) };
      }).sort((a, b) => (STATUS_RANK[b.status] - STATUS_RANK[a.status]) || ((b.d ?? 0) - (a.d ?? 0)));
      const overdue = rows.filter((r) => r.status === 'overdue');
      const dueSoon = rows.filter((r) => r.status === 'due-soon');
      const cell = (s) => (s === 'overdue' ? '⚠ 超期' : s === 'due-soon' ? '⏳ 临期' : s === 'none' ? '—' : '正常');
      const L = [];
      L.push(`## 回访看板（超期阈值 ${OVERDUE_DAYS} 天，临期提前 ${DUE_SOON_DAYS} 天）`);
      L.push(`共 **${rows.length}** 位患者，其中 **${overdue.length}** 位超期未复诊${dueSoon.length ? `、**${dueSoon.length}** 位临期` : ''}。`);
      if (overdue.length) {
        L.push('');
        L.push('### ⚠ 超期未复诊');
        for (const r of overdue) L.push(`- ${r.p.name}${r.p.birth ? `（${r.p.birth}年生）` : ''}｜病历号 ${r.p.id}｜末次就诊 ${String(r.p.lastVisitAt || '—').slice(0, 10)}｜已 ${r.d} 天未复诊`);
      }
      if (dueSoon.length) {
        L.push('');
        L.push('### ⏳ 临近复诊期');
        for (const r of dueSoon) L.push(`- ${r.p.name}${r.p.birth ? `（${r.p.birth}年生）` : ''}｜病历号 ${r.p.id}｜末次就诊 ${String(r.p.lastVisitAt || '—').slice(0, 10)}｜已 ${r.d} 天（阈值 ${OVERDUE_DAYS} 天）`);
      }
      L.push('');
      L.push('### 全部患者');
      L.push('| 病历号 | 患者 | 就诊次数 | 末次就诊 | 距今天数 | 状态 |');
      L.push('|---|---|---|---|---|---|');
      for (const r of rows) L.push(`| ${r.p.id} | ${r.p.name}${r.p.birth ? `（${r.p.birth}）` : ''} | ${r.n} | ${String(r.p.lastVisitAt || '—').slice(0, 10)} | ${r.d ?? '—'} | ${cell(r.status)} |`);
      return { ok: true, output: L.join('\n'), data: { total: rows.length, overdue: overdue.length, dueSoon: dueSoon.length } };
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
    const st = followupStatus(pt);
    let out = `## 患者随访｜${pt.name}${pt.birth ? `（${pt.birth}年生）` : ''}｜病历号 ${pt.id}\n共 ${history.length} 次就诊，末次就诊 ${String(pt.lastVisitAt || '—').slice(0, 10)}${ds != null ? `（已 ${ds} 天）` : ''}。\n`;
    if (st === 'overdue') out += `\n⚠ **超期未复诊预警**：距上次就诊已 ${ds} 天（阈值 ${OVERDUE_DAYS} 天）。\n`;
    else if (st === 'due-soon') out += `\n⏳ **临近复诊期**：距上次就诊已 ${ds} 天（阈值 ${OVERDUE_DAYS} 天）——建议尽快联系安排复诊。\n`;

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

  /** 快照 → 中文字段（随访时间线用；标签统一取自 FIELD_CN，不在此另立一份） */
  function pickFieldsCn(d) {
    const out = /** @type {Record<string,any>} */ ({});
    for (const k of ALL_FIELDS) out[FIELD_CN[k]] = d[k];
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
          '病历采集与落盘：把本次接诊原文结构化成本次病历快照并写入 intake/<病历号>/。' +
          '**主诉与现病史两项必填、齐全才落盘**；其余（既往史/家族史/过敏史/流行病史/体格检查/舌象/脉象/随访）按实际接诊情况可选。' +
          '缺必填项会明确回报「请继续采集」而**绝不编造、不落盘半份病历**。' +
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
      // 红线二：缺项绝不编造 —— 主诉/现病史缺任一项即拒绝该结果，要求模型继续采集
      { id: 'ten-questions-complete', kind: 'completeness', tool: 'intake_collect', fields: REQUIRED_FIELDS, onMissing: 'reject' },
      // 红线三：不输出诊疗结论 —— 只判「疗效结论」，刻意不含「确诊为」：
      //   医师病历里会有既往确诊事实（如"2024 年确诊为宫颈癌"），拦它会把「重大疾病诊断必须原样保留」这条需求顶掉。
      // pattern 收窄到**结论性表述**，不再单拦「好转」这一个词。
      // 原因（医师实测反馈）：Dify 的问诊正文里"好转"是常见临床用词，且常是**事实转述**
      // （"患者自述服药后好转"）。原来的 `有效|好转|治愈` 会频繁命中 → 触发改写 →
      // 改写仍命中 → **正文被替换成合规文案，医师拿不到问诊结论**，这比措辞问题严重得多。
      // action 由 block-and-rewrite 改为 warn：**正文永不丢失**，但命中会提示 + 进审计，
      // 便于回头统计"哪些措辞值得收紧"。要恢复拦截只需把 warn 改回 block-and-rewrite。
      { id: 'no-efficacy-conclusion', kind: 'output-forbid', pattern: '疗效(显著|良好|不错|明显|确切)|治疗有效|已(经)?治愈|完全治愈|痊愈|病情(明显)?好转|症状(明显)?好转|建议继续服用', action: 'warn' },
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
