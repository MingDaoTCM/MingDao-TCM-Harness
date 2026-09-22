// 随访主动提醒：轮询 `/api/tcm/reminders`，在顶部提醒条上给出「超期 / 临期」，
// 并在**新出现超期患者**时发桌面通知（需医师显式开启）。
//
// 为什么用轮询而不是 SSE：提醒的变化频率是**「天」级**（某位患者跨过 14 天阈值），
// 不是秒级。为一天变一次的数据维持一条长连接，换来的是复杂度而不是新鲜度。
//
// 为什么只在「新增」时通知：否则每次轮询都会重复轰炸同一位患者。
// 首次拉取只建立**基线**（不通知），避免一打开页面就弹一堆。
import { $, esc } from './util.js';
import { getJSON } from './api.js';

const POLL_MS = 60_000;
const NOTIF_KEY = 'tcm-notify-on';

let onGoto = () => {};
let baselineDone = false;
let lastOverdue = new Set();
let lastCounts = { overdue: 0, dueSoon: 0 };
let notifyOn = (() => { try { return localStorage.getItem(NOTIF_KEY) === '1'; } catch { return false; } })();

const canNotify = () => notifyOn && typeof Notification !== 'undefined' && Notification.permission === 'granted';

function paintNotifyBtn() {
  const b = $('#remindNotify');
  if (!b) return;
  if (typeof Notification === 'undefined') { b.hidden = true; return; }
  b.textContent = canNotify() ? '关闭桌面提醒' : '开启桌面提醒';
}

function renderBar(r) {
  const bar = $('#remindBar');
  const n = r?.counts?.overdue || 0;
  const m = r?.counts?.dueSoon || 0;
  if (!n && !m) { bar.hidden = true; return; }
  bar.hidden = false;
  const parts = [];
  if (n) parts.push(`<b>${n}</b> 位患者已超期未复诊`);
  if (m) parts.push(`<b>${m}</b> 位临近复诊期`);
  $('#remindText').innerHTML = parts.join(' · ')
    + `<span class="rb-sub">（阈值 ${r.overdueDays} 天，提前 ${r.dueSoonDays} 天）</span>`;
}

function notifyNewlyOverdue(list) {
  if (!canNotify() || !list.length) return;
  const names = list.slice(0, 3).map((p) => p.name || p.id).join('、');
  try {
    new Notification('得一中医 · 随访提醒', {
      body: `${list.length} 位患者超期未复诊：${names}${list.length > 3 ? ' 等' : ''}`,
      tag: 'tcm-followup', // 同 tag 会替换而不是堆叠
    });
  } catch { /* 非安全上下文等环境会抛；通知失败不该影响界面 */ }
}

/** 拉一次提醒并更新界面。基线之后**新增**的超期患者才发通知。 */
export async function refreshReminders() {
  const r = await getJSON('/api/tcm/reminders');
  if (!r.ok) {
    // 读不出来（例如注册表损坏）→ 明确显示，绝不假装「没有提醒」
    const bar = $('#remindBar');
    bar.hidden = false;
    $('#remindText').innerHTML = '<b>随访提醒读取失败</b>：' + esc(r.error || '未知错误');
    return r;
  }
  lastCounts = r.counts || lastCounts;
  renderBar(r);
  if (baselineDone) notifyNewlyOverdue(r.overdue.filter((p) => !lastOverdue.has(p.id)));
  lastOverdue = new Set(r.overdue.map((p) => p.id));
  baselineDone = true;
  return r;
}

/** 清除基线：刚给一位超期患者看完诊后，希望它不再被算成「新增」。 */
export function resetReminderBaseline() { baselineDone = false; lastOverdue = new Set(); }

function toggleNotify() {
  if (typeof Notification === 'undefined') return;
  if (canNotify()) { // 关掉
    notifyOn = false;
    try { localStorage.setItem(NOTIF_KEY, '0'); } catch {}
    paintNotifyBtn();
    return;
  }
  // 开启：浏览器只允许在用户手势里请求权限
  Notification.requestPermission().then((perm) => {
    notifyOn = perm === 'granted';
    try { localStorage.setItem(NOTIF_KEY, notifyOn ? '1' : '0'); } catch {}
    paintNotifyBtn();
  }).catch(() => {});
}

/** 绑定提醒：立即拉一次 + 之后每分钟拉一次。由 app.js 调用。 */
export function initReminders(opts = {}) {
  onGoto = typeof opts.onGoto === 'function' ? opts.onGoto : () => {};
  // 「查看 →」按当前最严重的一类过滤（有超期就看过期，否则看临期）
  $('#remindGo').onclick = () => onGoto(lastCounts.overdue ? 'overdue' : 'due-soon');
  $('#remindNotify').onclick = toggleNotify;
  paintNotifyBtn();
  refreshReminders();
  setInterval(refreshReminders, POLL_MS);
}
