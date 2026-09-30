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

  initConsult();
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
