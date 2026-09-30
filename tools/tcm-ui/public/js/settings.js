// 设置页 + 底部链接（官网 / 问题反馈 / 检查更新 / 关于）。
//
// 设计要点：
//   · **密钥不内置**：这里只负责把医师填的值 POST 给本机代理，由它写进
//     `$MINGDAO_HOME/credentials.json`（与内核 ⚙ 设置同一份文件）。
//   · GET 只拿得到**脱敏值**（`app-****abcd`）—— 页面负责显示"填过没有"，
//     而不是把明文再取回来（截图/演示都会泄露）。
//   · 「留空 = 不改」由服务端定义，前端不自行判断，避免"改一个字段把另一个抹了"。
import { $ } from './util.js';

const SITE_URL = 'https://tcm.mingdao.ai/';
const FEEDBACK_URL = 'https://harness.mingdao.ai/forum/';

/** 底部/设置页共用的提示位 */
function say(el, text, kind = '') {
  const node = typeof el === 'string' ? $(el) : el;
  if (!node) return;
  node.className = 'msg ' + kind;
  node.textContent = text;
}

async function loadSettings() {
  const r = await fetch('/api/tcm/settings', { cache: 'no-store' });
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  if (!j.ok) { say('#setMsg', '✗ ' + (j.error || '读取失败'), 'err'); return null; }
  const s = j.settings;
  $('#setHome').textContent = j.home || '—';
  $('#setDifyBase').value = s.difyBaseUrl || '';
  $('#setOrchBase').value = s.orchBaseUrl || '';
  $('#setOrchModel').value = s.orchModel || '';
  $('#setDifyKeyNow').textContent = s.difyKeySet ? `已配置：${s.difyKeyMasked}（重填即覆盖）` : '尚未填写 —— 问诊不会走 Dify 工作流';
  $('#setOrchKeyNow').textContent = s.orchKeySet ? `已配置：${s.orchKeyMasked}（来源：${s.orchKeyFrom === 'config' ? 'config.json 的 tcm.orchestrator' : 'credentials.json 的 deepseek'}）` : '尚未填写 —— 工具编排不可用（问诊仍可进行）';
  $('#setRouteBody').innerHTML = s.routeA
    ? '✅ <b>Dify 工作流（路线 A）</b>：问诊正文与知识库来自 Dify；工具编排由本机模型判定。'
    : `⚠️ 当前 provider 是 <code>${s.provider || '(未设置)'}</code>（model <code>${s.model || '-'}</code>）——
       问诊<b>不会</b>经过 Dify 工作流。填好上面的 Dify API Key 并保存即可切到路线 A。`;
  return s;
}

async function saveSettings() {
  const body = {
    difyKey: $('#setDifyKey').value,
    orchKey: $('#setOrchKey').value,
    difyBaseUrl: $('#setDifyBase').value,
    orchBaseUrl: $('#setOrchBase').value,
    orchModel: $('#setOrchModel').value,
  };
  say('#setMsg', '保存中…', 'dim');
  const r = await fetch('/api/tcm/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
  if (!j.ok) { say('#setMsg', '✗ ' + (j.error || '保存失败'), 'err'); return; }
  $('#setDifyKey').value = '';
  $('#setOrchKey').value = '';
  say('#setMsg', '✓ 已保存（重启问诊台后生效；密钥只写在本机）', 'ok');
  await loadSettings();
}

/** 检查更新：由本机代理去问站点（浏览器直连会撞 CORS） */
async function checkUpdate() {
  say('#setMsg', '正在检查更新…', 'dim');
  try {
    const r = await fetch('/api/tcm/update', { cache: 'no-store' });
    const j = await r.json();
    const cur = j.current ? `当前 v${j.current}` : '当前版本未知';
    if (j.status === 'newer') {
      say('#setMsg', `发现新版本 v${j.latest}（${cur}）—— 点底部「访问官网」去下载页`, 'ok');
    } else if (j.status === 'current') {
      say('#setMsg', `已是最新版本（v${j.latest}）`, 'ok');
    } else {
      say('#setMsg', `暂时查不到最新版本（${cur}）：${j.reason || '未知原因'}`, 'warn');
    }
  } catch (e) {
    say('#setMsg', '✗ 检查更新失败：' + (e?.message || e), 'err');
  }
}

export function initSettings() {
  $('#setSave').onclick = () => saveSettings().catch((e) => say('#setMsg', '✗ ' + (e?.message || e), 'err'));
  $('#setReload').onclick = () => loadSettings().catch(() => {});

  // 底部链接：用系统浏览器打开（Electron 的外链拦截会把它交给默认浏览器）
  $('#linkSite').onclick = (e) => { e.preventDefault(); window.open(SITE_URL, '_blank', 'noopener'); };
  $('#linkFeedback').onclick = (e) => { e.preventDefault(); window.open(FEEDBACK_URL, '_blank', 'noopener'); };
  $('#linkUpdate').onclick = (e) => { e.preventDefault(); checkUpdate(); };
  $('#linkAbout').onclick = (e) => {
    e.preventDefault();
    const cur = $('#aboutVer').dataset.version || '';
    window.alert(
      '明道中医 · 问诊台\n'
      + `版本 ${cur || '(未知)'}\n\n`
      + '中医垂域问诊工作台：问诊正文与辨证知识走 Dify 工作流，\n'
      + '患者识别、病历落盘、复诊对比与回访追踪由本地内核强制。\n\n'
      + `官网（内部）：${SITE_URL}\n`
      + '本产品为知识工作助手，不输出诊疗建议、不下诊断。',
    );
  };
}

/** 进入设置页时拉一次（顺带把版本号显示出来） */
export async function enterSettings() {
  try { await loadSettings(); } catch { /* 读不到就保持原样 */ }
}
