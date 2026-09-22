// 患者视图：左侧**名册**（超期优先）+ 右侧**历次病历与逐次变化**。
//
// 数据来自代理自己的只读端点 `/api/tcm/*`（见 server.mjs / tcm-data.mjs）——
// 内核是通用的，不认识「患者」这种领域概念，这些是 Line B 的领域数据。
//
// ⚠ 本模块**不认识任何字段名/标签**：所有 label 与 value 都由服务端按 Pack 的 FIELD_CN
//   渲染好（含「复诊草稿」）。理由与复诊修复同源：同一份契约定义两处必然漂移。
import { $, esc, relDays } from './util.js';
import { getJSON } from './api.js';

/** app.js 注入：切到问诊页并预填一段文本 */
let onFollowup = () => {};
let selected = null;

function rosterItem(p) {
  return '<button class="pitem' + (p.id === selected ? ' active' : '') + '" data-id="' + esc(p.id) + '">'
    + '<span class="l1"><span class="nm">' + esc(p.name || '（未命名）') + '</span>'
    + '<span class="mt">' + esc(p.id) + (p.birth ? ' · ' + esc(p.birth) : '') + (p.sex ? ' · ' + esc(p.sex) : '') + '</span></span>'
    + '<span class="l2"><span>' + p.visits + ' 次就诊 · 末次 ' + esc(relDays(p.daysSince)) + '</span>'
    + (p.overdue ? '<span class="badge overdue ml-auto">超期 ' + p.daysSince + ' 天</span>' : '')
    + '</span></button>';
}

/** 拉名册并渲染。返回是否成功（供 initial/refresh 共用）。 */
export async function refreshRoster() {
  const list = $('#rosterList');
  const sum = $('#rosterSum');
  sum.textContent = '加载中…';
  const data = await getJSON('/api/tcm/patients');
  if (!data.ok) {
    // 注册表损坏时服务端会明确报错 —— 这里绝不显示成「0 位患者」（那会让人以为数据没了）
    sum.textContent = '读取失败';
    list.innerHTML = '<div class="perr" style="margin:12px">' + esc(data.error || '未知错误') + '</div>';
    return false;
  }
  sum.innerHTML = '共 <b>' + data.totals.patients + '</b> 位 · <b>' + data.totals.visits + '</b> 次就诊'
    + (data.totals.overdue ? ' · <span class="warn">' + data.totals.overdue + ' 位超期</span>' : '');
  if (!data.patients.length) {
    list.innerHTML = '<div class="pempty">还没有患者。<br>在「问诊」页完成首次接诊后，这里会出现名册。</div>';
    return true;
  }
  list.innerHTML = data.patients.map(rosterItem).join('');
  return true;
}

function visitCard(v) {
  const rows = v.items.map((it) =>
    '<tr><th>' + esc(it.label) + '</th><td' + (it.value ? '' : ' class="empty"') + '>'
    + (it.value ? esc(it.value) : '—') + '</td></tr>').join('');
  const changes = v.changes.length
    ? '<div class="changes">' + v.changes.map((c) =>
        '<div class="ch"><b>' + esc(c.label) + '</b>：<span class="from">' + esc(c.from || '（空）')
        + '</span> → <span class="to">' + esc(c.to || '（空）') + '</span></div>').join('') + '</div>'
    : '';
  return '<div class="vcard"><div class="vhead">'
    + '<span class="vn">' + esc(v.label) + '</span><span class="vd">' + esc(v.at || '') + '</span>'
    + '<span class="sp"></span>'
    + (v.changes.length ? '<span class="vc">' + v.changes.length + ' 项变化</span>' : '')
    + '</div>' + changes + '<table class="vfields">' + rows + '</table></div>';
}

function renderDetail(d) {
  const p = d.patient;
  const host = $('#patientDetail');
  host.innerHTML = '<div class="dhead">'
    + '<span class="nm">' + esc(p.name || '（未命名）') + '</span>'
    + '<span style="color:var(--faint);font-size:12.5px">' + esc(p.id)
    + (p.birth ? ' · ' + esc(p.birth) + '年生' : '') + (p.sex ? ' · ' + esc(p.sex) : '') + '</span>'
    + (p.overdue ? '<span class="badge overdue">超期 ' + p.daysSince + ' 天未复诊</span>' : '')
    + '<span class="sp"></span><button id="followup">发起复诊 →</button></div>'
    + '<div class="dhead" style="border:0;padding:0;margin:-6px 0 12px">'
    + '<span style="font-size:12px;color:var(--faint)">共 ' + d.visits.length + ' 次就诊'
    + (p.lastVisitAt ? ' · 末次 ' + esc(String(p.lastVisitAt).slice(0, 10)) : '') + '</span>'
    + '</div>'
    + (d.visits.length ? d.visits.map(visitCard).join('') : '<div class="pempty">该患者还没有病历快照。</div>');
}

async function selectPatient(id) {
  selected = id;
  document.querySelectorAll('.pitem').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  const host = $('#patientDetail');
  host.innerHTML = '<div class="pempty">加载中…</div>';
  const d = await getJSON('/api/tcm/patients/' + encodeURIComponent(id));
  if (!d.ok) {
    host.innerHTML = '<div class="perr">' + esc(d.error || '读取失败') + '</div>';
    return;
  }
  renderDetail(d);
}

/**
 * 绑定患者视图。
 * @param {{onFollowup?: (text: string) => void}} opts app.js 注入的回调：带着草稿切到问诊页
 */
export function initPatients(opts = {}) {
  onFollowup = typeof opts.onFollowup === 'function' ? opts.onFollowup : () => {};

  $('#rosterRefresh').onclick = () => { refreshRoster(); };

  $('#rosterList').addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement|null} */ (e.target.closest ? e.target.closest('.pitem') : null);
    if (btn && btn.dataset.id) selectPatient(btn.dataset.id);
  });

  // 「发起复诊」：草稿由服务端生成（前端不认识字段），医师在问诊页可再编辑再发送
  $('#patientDetail').addEventListener('click', async (e) => {
    if (!e.target || e.target.id !== 'followup') return;
    const d = await getJSON('/api/tcm/patients/' + encodeURIComponent(selected || ''));
    onFollowup(d.ok && d.followupDraft ? d.followupDraft : '复诊：');
  });
}

/** 切到患者页时调用：拉一次名册；若之前选过患者，刷新其详情 */
export async function enterPatients() {
  const ok = await refreshRoster();
  if (ok && selected) selectPatient(selected);
}
