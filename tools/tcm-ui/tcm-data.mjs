// 问诊台的「患者名册 / 历史」数据层。
//
// ⚠ 本文件**不自己定义任何字段名、标签或读语义** —— 全部 import 自垂域 Pack
// （`layer/packs/tcm/pack.mjs`）。理由与 2026-09-16 的复诊修复同源：
// **同一份契约定义在两处必然漂移**。当时 provider 自己抄了一份字段表，重构后没跟上，
// 结果复诊注入的「上次病历」静默丢字段。这里若再抄一份，同样的事会在界面上重演
// （医师看到的历史与落盘的不一致，而且不报错）。
//
// 所以：字段集/标签 → FIELD_CN / ALL_FIELDS；就诊序 → visitLabel；
//       超期阈值 → OVERDUE_DAYS / daysSince；**读文件的语义**（损坏大声失败、
//       按文件名时间戳排序、只认 case-<epoch>.json）→ loadRegistryFrom / listSnapshotFiles。
import path from 'node:path';
import {
  ALL_FIELDS, FIELD_CN, OVERDUE_DAYS, daysSince, visitLabel, REQUIRED_FIELDS,
  loadRegistryFrom, listSnapshotFiles, readSnapshotFile,
} from '../../layer/packs/tcm/pack.mjs';

/**
 * 病历号白名单。除了挡住明显非法的输入，它天然让 `../` 这类路径穿越进不来
 * （`:id` 会被拼进 `intake/<id>/`）。真正的存在性校验仍以注册表为准。
 */
const PID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** 造一行患者摘要（名册与详情共用） */
function patientRow(id, p, visits) {
  const d = daysSince(p.lastVisitAt);
  return {
    id,
    name: String(p.name || ''),
    birth: String(p.birth || ''),
    sex: String(p.sex || ''),
    visits,
    lastVisitAt: String(p.lastVisitAt || ''),
    daysSince: d,
    overdue: d != null && d >= OVERDUE_DAYS,
  };
}

/**
 * 复诊消息草稿 —— **服务端生成**，前端只负责填进输入框。
 * 这样前端连"主诉是哪个字段"都不必知道（字段语义只此一处，见文件头说明）。
 */
function followupDraft(p, visits) {
  const head = [p.name, p.birth ? `${p.birth}年生` : '', p.sex].filter(Boolean).join('，');
  const last = visits[visits.length - 1];
  const chief = last ? (last.items.find((x) => x.key === REQUIRED_FIELDS[0])?.value || '') : '';
  const lines = [`复诊：${head}。`];
  if (chief) lines.push(`（上次主诉：${chief}）`);
  lines.push('（复诊：请回顾上次并逐项对比本次变化）');
  return lines.join('\n');
}

/**
 * 患者名册。排序：**超期优先**，其次最近就诊在前，最后按病历号稳定排序。
 * @param {string} home MINGDAO_HOME
 */
export function roster(home) {
  let reg;
  try {
    reg = loadRegistryFrom(home);
  } catch (e) {
    // 与 Pack 同口径：注册表损坏**不降级成空名册** —— 显示「0 位患者」会让人以为数据没了
    return { ok: false, error: String(e?.message || e) };
  }
  const patients = Object.entries(reg.patients)
    .map(([id, p]) => patientRow(id, p, listSnapshotFiles(home, id).length));
  patients.sort((a, b) =>
    (Number(b.overdue) - Number(a.overdue))
    || ((b.daysSince ?? -1) - (a.daysSince ?? -1))
    || a.id.localeCompare(b.id));
  return {
    ok: true,
    patients,
    totals: {
      patients: patients.length,
      overdue: patients.filter((x) => x.overdue).length,
      visits: patients.reduce((s, x) => s + x.visits, 0),
    },
    overdueDays: OVERDUE_DAYS,
  };
}

/**
 * 单患者详情：时间线（**最早 → 最新**）+ 逐次与上次的逐项变化。
 *
 * 这里给的是**确定性的事实**（哪个字段从什么变成什么），不含任何疗效判断 ——
 * 「四态对比」（消失/减轻/无变化/加重）是模型判定的产物，走 `visit_compare` 工具，不进这里。
 * @param {string} home MINGDAO_HOME
 * @param {string} id 病历号
 */
export function patientDetail(home, id) {
  const pid = String(id || '');
  if (!PID_RE.test(pid)) return { ok: false, error: '非法的病历号' };

  let reg;
  try {
    reg = loadRegistryFrom(home);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  const p = reg.patients[pid];
  if (!p) return { ok: false, error: `病历号 ${pid} 不存在` };

  const files = listSnapshotFiles(home, pid).reverse(); // 列表是最新在前 → 翻成最早在前
  /** @type {any[]} */
  const visits = [];
  /** @type {Record<string, any>|null} */
  let prev = null;
  files.forEach((file, i) => {
    const snap = readSnapshotFile(file) || {};
    const items = ALL_FIELDS.map((k) => ({ key: k, label: FIELD_CN[k], value: String(snap[k] || '') }));
    const changes = [];
    if (prev) {
      for (const k of ALL_FIELDS) {
        const from = String(prev[k] || '');
        const to = String(snap[k] || '');
        if (from !== to) changes.push({ key: k, label: FIELD_CN[k], from, to });
      }
    }
    visits.push({
      n: i + 1,
      label: visitLabel(i + 1),
      at: String(snap.collectedAt || '').slice(0, 10),
      file: path.basename(file),
      items,
      changes,
    });
    prev = snap;
  });

  return {
    ok: true,
    patient: patientRow(pid, p, visits.length),
    visits,
    overdueDays: OVERDUE_DAYS,
    followupDraft: followupDraft(p, visits),
  };
}
