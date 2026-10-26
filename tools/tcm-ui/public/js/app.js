// 启动：视图切换 + 各视图初始化 + 内核连接状态。
// 拆成多文件后这里是唯一入口（index.html 只 <script type="module" src="/js/app.js">）。
import { $ } from './util.js';
import { initConsult, prefillConsult } from './consult.js';
import { initPatients, enterPatients, setStatusFilter } from './patients.js';
import { initReminders, refreshReminders } from './reminders.js';
import { initSettings, enterSettings } from './settings.js';

const VIEWS = ['consult', 'patients', 'settings'];

/** 切换视图（问诊 / 患者）。切到「患者」时按需刷新名册，同时刷新随访提醒。 */
export function setView(name) {
  const v = VIEWS.includes(name) ? name : 'consult';
  for (const key of VIEWS) {
    const el = document.getElementById('view-' + key);
    if (el) el.hidden = key !== v;
  }
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  if (v === 'patients') enterPatients();
  if (v === 'settings') enterSettings();
  refreshReminders(); // 切换视图时顺手刷新提醒（医师刚看完诊回来能立刻看到变化）
}

function init() {
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setView(t.dataset.view); });

  
// ── 3.5 字号档位：整站缩放（Electron/Chromium 支持 zoom，一处生效、完整覆盖）──
// 为什么不做逐条改 px：界面里有上百处字号，逐条改既容易漏、也难保一致性；
// 医师要的是"整体大一号"，不是"某几处变大"。用 zoom 一次覆盖，标准/大两档足够。
function applyFontSize() {
  const large = localStorage.getItem('tcmFs') === 'large';
  document.body.classList.toggle('fs-large', large);
  const b = document.getElementById('fsToggle');
  if (b) b.textContent = large ? '字号：大' : '字号：标准';
}
// ── 键盘优先（3.8）：医师熟手用键盘走完一次问诊 ──
// Ctrl/⌘+Enter 直接问诊 · Ctrl/⌘+K 换患者 · Ctrl/⌘+L 拍照
// 只在组合键时生效，不拦普通按键，避免和输入法/系统快捷键打架。
function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = String(e.key || '').toLowerCase();
    if (key === 'enter') {
      const b = document.getElementById('directSend');
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
      return;
    }
    if (key === 'k') { e.preventDefault(); document.querySelector('.tab[data-view="patients"]')?.click(); return; }
    if (key === 'l') { e.preventDefault(); document.getElementById('tongueShot')?.click(); return; }
  });
}

// 3.7 空态引导：发出第一条消息后隐藏（用观察器，和渲染逻辑解耦）
function initStartHere() {
  const box = document.getElementById('startHere');
  const conv = document.getElementById('conv');
  if (!box || !conv || typeof MutationObserver === 'undefined') return;
  const upd = () => { if (conv.children.length > 0) box.style.display = 'none'; };
  new MutationObserver(upd).observe(conv, { childList: true });
  upd();
}

applyFontSize();
initShortcuts();
initStartHere();
initConsult();
const fsBtn = document.getElementById('fsToggle');
if (fsBtn) fsBtn.onclick = () => {
  localStorage.setItem('tcmFs', localStorage.getItem('tcmFs') === 'large' ? 'standard' : 'large');
  applyFontSize();
};
  initSettings();
  initPatients({
    // 「发起复诊」：切回问诊页，把**服务端生成的**复诊草稿填进输入框（医师可再编辑）
    onFollowup: (text) => { setView('consult'); prefillConsult(text); },
  });
  // 提醒条的「查看 →」：切到患者页并按最严重的一类筛选
  initReminders({
    onGoto: (f) => { setView('patients'); setStatusFilter(f); },
  });

  // 内核连接状态（这一条走内核，不是代理本地端点）
  // 底部「关于」显示的版本号：问诊台代理会带上（桌面版从自己的 package.json 读）
  fetch('/api/tcm/settings', { cache: 'no-store' })
    .then((r) => r.json())
    .then((j) => {
      const v = j?.currentVersion || '';
      const el = document.getElementById('aboutVer');
      if (el) { el.textContent = `明道中医 · 问诊台${v ? ' v' + v : ''}`; el.dataset.version = v; }
    })
    .catch(() => {});

  fetch('/api/state')
    .then((r) => { $('#st').textContent = r.ok ? '内核已连接' : '内核异常 ' + r.status; })
    .catch(() => { $('#st').textContent = '内核不可达'; });

  setView('consult');
}

init();
