// 启动：视图切换 + 各视图初始化 + 内核连接状态。
// 拆成多文件后这里是唯一入口（index.html 只 <script type="module" src="/js/app.js">）。
import { $ } from './util.js';
import { initConsult, prefillConsult } from './consult.js';
import { initPatients, enterPatients } from './patients.js';

const VIEWS = ['consult', 'patients'];

/** 切换视图（问诊 / 患者）。切到「患者」时按需刷新名册。 */
export function setView(name) {
  const v = VIEWS.includes(name) ? name : 'consult';
  for (const key of VIEWS) {
    const el = document.getElementById('view-' + key);
    if (el) el.hidden = key !== v;
  }
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  if (v === 'patients') enterPatients();
}

function init() {
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => setView(t.dataset.view); });

  initConsult();
  initPatients({
    // 「发起复诊」：切回问诊页，把**服务端生成的**复诊草稿填进输入框（医师可再编辑）
    onFollowup: (text) => { setView('consult'); prefillConsult(text); },
  });

  // 内核连接状态（这一条走内核，不是代理本地端点）
  fetch('/api/state')
    .then((r) => { $('#st').textContent = r.ok ? '内核已连接' : '内核异常 ' + r.status; })
    .catch(() => { $('#st').textContent = '内核不可达'; });

  setView('consult');
}

init();
