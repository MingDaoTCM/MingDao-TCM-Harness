// 问诊视图：左侧病历表单（合成问诊消息）+ 右侧对话（工具执行区 + 问诊正文 + 思考过程）。
// 从原单文件 index.html 拆出；逻辑未改，只把 DOM 选择/Markdown/SSE 抽到 util.js / api.js。
import { $, esc, renderMarkdown, visibleOf, inThink } from './util.js';
import { postJSON, streamSSE } from './api.js';

// ── 首字等待提示（思考中 / 工具执行中 + 自走计时器）──────────
function startThinking(body) {
  const el = body.querySelector('.thinking');
  if (!el) return null;
  const sec = el.querySelector('.sec');
  const ph = el.querySelector('.ph');
  const t0 = Date.now();
  let serverPhase = '';
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    sec.textContent = s >= 60 ? Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒' : s + 's';
    // 内核 progress 心跳 5s 一次、首个心跳前无阶段语义 —— 本地先给出确定性文案
    if (!serverPhase) ph.textContent = s >= 20 ? '· 工作流运行中（较慢）' : '';
  };
  tick();
  const h = setInterval(tick, 200);
  return {
    phase(p) { if (p) { serverPhase = p; ph.textContent = '· ' + p; } },
    stop() { clearInterval(h); },
  };
}

// ── 模型思考过程（reasoning 通道）────────────────────────────
// 医师定稿：思考过程保留可看（对辨证有参考），但视觉从属 —— 更小更淡、虚线框、可折叠。
// 内核把它作为独立的 reasoning 通道送来，与受红线约束的正文天然分流。
function reasoningSink(turn) {
  const box = turn.querySelector('.thinkbox');
  const rb = box.querySelector('.rbody');
  const name = box.querySelector('.tname');
  let buf = '', raf = 0;
  box.querySelector('.thead').onclick = () => box.classList.toggle('folded');
  // 实测一轮思考有 1800 个分片：按帧合并写入，避免 O(n²) 重排与刷屏式 scroll
  const flush = () => {
    raf = 0;
    rb.textContent = buf;                       // 纯文本：思考过程不该当 Markdown 解析
    name.textContent = '模型思考过程 · ' + buf.length + ' 字';
    scroll();
  };
  return {
    push(t) {
      buf += t;
      if (box.hidden) { box.hidden = false; box.classList.add('streaming'); }
      if (!raf) raf = requestAnimationFrame(flush);
    },
    /** 正文开始 → 收拢，避免一大段推理把正文挤到屏幕外（点标题可再展开） */
    fold() { if (buf && !box.hidden) box.classList.add('folded'); },
    stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; flush(); } box.classList.remove('streaming'); },
  };
}

// 流式重绘：每帧最多一次，避免长正文下 O(n²) 重排
function paint(body, raw, streaming) {
  body.classList.add('md');
  body.innerHTML = renderMarkdown(visibleOf(raw));
  if (!streaming) return;
  let host = body.lastElementChild || body;
  if (/^(UL|OL)$/.test(host.tagName) && host.lastElementChild) host = host.lastElementChild;
  const c = document.createElement('span'); c.className = 'caret'; host.appendChild(c);
}

/** 工具注册名 → 医师看得懂的名字（把内核加的 pack__<pack>__ 前缀翻成人话） */
const TOOL_LABEL = {
  patient_lookup: '患者定位',
  patient_register: '新患者登记',
  intake_collect: '病历落盘',
  visit_compare: '复诊四态对比',
  followup_board: '回访 / 随访',
};
const toolLabel = (raw) => {
  const s = String(raw || '');
  const bare = s.startsWith('pack__') ? s.split('__').slice(2).join('__') : s;
  return TOOL_LABEL[bare] || bare;
};

let session = null;
let generating = false;
let ctrl = null;
let pendingAttachments = [];

// ── 每轮回复：工具区（上） + 问诊正文（下） ─────────────────
function addTurn(userText, hasAttachment) {
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = '<div class="q"><div class="who">医师' + (hasAttachment ? ' · 附舌象照片' : '') + '</div>' + esc(userText) + '</div>'
    + '<div class="toolzone" style="display:none"><div class="zt">工具执行</div><div class="cards"></div></div>'
    + '<div class="answer"><div class="zt">问诊工作流正文</div>'
    + '<div class="thinkbox" hidden><div class="thead"><span class="arw">▾</span><span class="tname">模型思考过程</span></div><div class="rbody"></div></div>'
    + '<div class="body md">'
    + '<div class="thinking"><span class="orb"></span><span class="tt">正在思考中…</span><span class="ph"></span><span class="sec">0s</span></div>'
    + '</div></div>';
  $('#conv').appendChild(turn);
  scroll();
  return turn;
}

function toolCard(turn, rawName) {
  const zone = turn.querySelector('.toolzone');
  const cards = turn.querySelector('.cards');
  zone.style.display = '';
  const d = document.createElement('div');
  d.className = 'tool';
  d.innerHTML = '<div class="head"><span>🔧</span><span class="name">' + esc(toolLabel(rawName))
    + '</span><span class="raw">' + esc(rawName) + '</span>'
    + '<span class="st"><span class="spin">执行中…</span></span></div>';
  cards.appendChild(d);
  scroll();
  return d;
}

function scroll() { const c = $('#conv'); c.scrollTop = c.scrollHeight; }

async function send(text, attachments) {
  if (generating) return;
  text = String(text || '').trim();
  if (!text) return;
  generating = true; $('#send').disabled = true; $('#stop').style.display = '';
  const turn = addTurn(text, Boolean(attachments && attachments.length));
  const body = turn.querySelector('.answer .body');
  const cards = new Map();
  let raf = 0;
  const T = { think: startThinking(body), raw: '' };
  const R = reasoningSink(turn);
  ctrl = new AbortController();
  const pushText = (t) => {
    T.raw += t;
    if (T.think) {
      // <think> 段由 provider 分流到 reasoning 通道，正文分片天然干净；
      // 这里只在「正文仍无可见字」时保留等待提示，否则会出现「提示条没了、正文却是空的」。
      if (!visibleOf(T.raw).trim()) { T.think.phase(inThink(T.raw) ? '模型深度思考中' : ''); return; }
      T.think.stop(); T.think = null; body.innerHTML = ''; // 首个可见字到达 → 撤下等待提示
      R.fold(); R.stop();                                  // 正文开始了 → 思考过程收拢
    }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(body, T.raw, true); scroll(); });
  };

  const payload = { message: text };
  if (session) payload.file = session;
  if (attachments && attachments.length) payload.attachments = attachments;

  try {
    const resp = await postJSON('/api/chat', payload, ctrl.signal);
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      if (T.think) { T.think.stop(); T.think = null; }
      R.stop();
      body.classList.remove('md');
      body.innerHTML = '<div class="errline">' + esc(j.error || ('HTTP ' + resp.status)) + '</div>';
      return;
    }
    await streamSSE(resp, (ev) => handleEvent(ev, turn, body, cards, pushText, T, R));
  } catch (e) {
    if (T.think) { T.think.stop(); T.think = null; }
    R.stop();
    if (String(e?.name) !== 'AbortError') body.innerHTML += '<div class="errline">连接失败：' + esc(e?.message || e) + '</div>';
  } finally {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (T.think) { T.think.stop(); T.think = null; }
    R.stop();
    if (visibleOf(T.raw).trim()) paint(body, T.raw, false);
    else if (!body.querySelector('.errline')) body.innerHTML = '<div class="note">本轮没有正文输出 —— 可能被领域约束拦截，或工作流未返回内容。</div>';
    generating = false; $('#send').disabled = false; $('#stop').style.display = 'none'; ctrl = null;
  }
}

async function handleEvent(ev, turn, body, cards, pushText, T, R) {
  switch (ev.type) {
    case 'text': pushText(String(ev.delta || '')); break;
    case 'reasoning': {
      // 内核的独立思考通道：与正文分流，样式更淡更小（标签由 provider 侧剥离，不会出现）
      R.push(String(ev.delta || ''));
      if (T?.think) T.think.phase('模型深度思考中');
      break;
    }
    case 'progress': if (T?.think) T.think.phase(String(ev.phase || '') + (Number(ev.steps) ? ' · 已执行 ' + ev.steps + ' 步' : '')); break;
    case 'toolStart': cards.set(ev.seq, toolCard(turn, ev.name)); break;
    case 'tool': {
      const card = cards.get(ev.seq) || toolCard(turn, ev.name);
      const r = ev.result || {};
      const ok = r.ok !== false;
      const st = card.querySelector('.st');
      st.className = 'st ' + (ok ? 'ok' : 'bad');
      st.textContent = (ok ? '✓' : '✖') + (ev.durationMs != null ? ' ' + ev.durationMs + 'ms' : '');
      if (r.output) { const pre = document.createElement('pre'); pre.textContent = String(r.output).slice(0, 2000); card.appendChild(pre); }
      if (r.error) { const pre = document.createElement('pre'); pre.style.color = 'var(--err)'; pre.textContent = String(r.error); card.appendChild(pre); }
      scroll();
      break;
    }
    case 'toolDenied': {
      const d = document.createElement('div'); d.className = 'errline';
      d.textContent = '✖ 工具未执行：' + (ev.reason || '未授权') + '（' + toolLabel(ev.name) + '）';
      const zone = turn.querySelector('.toolzone'); zone.style.display = '';
      turn.querySelector('.cards').appendChild(d); scroll();
      break;
    }
    case 'banner': {
      const d = document.createElement('div'); d.className = 'banner'; d.textContent = ev.text || '';
      turn.insertBefore(d, turn.firstChild); scroll();
      break;
    }
    case 'ask': {
      const yes = window.confirm(ev.question || '是否允许该操作？');
      await postJSON('/api/permission', { id: ev.id, answer: yes ? 'y' : 'n', taskId: ev.taskId }).catch(() => {});
      break;
    }
    case 'error': {
      const d = document.createElement('div'); d.className = 'errline'; d.textContent = ev.message || '出错了';
      turn.appendChild(d); scroll();
      break;
    }
    case 'done': {
      // done.text 才是内核的**权威正文**：领域红线的「改写 / 拦截」只体现在这里，
      // 流式分片可能早于改写（改写是一次非流式调用，没有分片）。
      // 因此收尾时必须以内核给的正文覆盖累积结果，否则医师看到的可能是改写前的版本。
      if (typeof ev.text === 'string' && ev.text.trim()) T.raw = ev.text;
      if (ev.session) { session = ev.session; $('#hint').textContent = '会话：' + session + '（后续消息沿用同一上下文）'; }
      if (ev.note) { const d = document.createElement('div'); d.className = 'errline'; d.style.color = 'var(--warn)'; d.textContent = ev.note; turn.appendChild(d); }
      const u = ev.usage || {};
      if (u.completion_tokens || u.prompt_tokens) {
        $('#st').textContent = '本轮 ' + (u.prompt_tokens || 0) + '+' + (u.completion_tokens || 0) + ' tokens'
          + (ev.durationMs ? ' · ' + (ev.durationMs / 1000).toFixed(1) + 's' : '');
      }
      scroll();
      break;
    }
    default: break;
  }
}

// ── 合成问诊消息 ──────────────────────────────────────────
// ⚠ 这里是**输入面**，天然要逐个列出字段（每个控件有自己的 placeholder / 类型），所以会出现
//   字段键 —— 这与「记录渲染路径不认识字段名」并不矛盾：
//     · 记录渲染（患者页）必须由服务端按 Pack 下发 label/value，前端零字段知识；
//     · 输入表单的字段键由 ui-wiring 测试与 index.html 的 #f_* 控件对齐，避免 HTML/JS 漂移。
const OPT_FIELDS = [
  ['jiwangshi', '既往史'], ['jiazushi', '家族史'], ['guominshi', '过敏史'], ['liuxingbingshi', '流行病史'],
  ['tigejiancha', '体格检查'], ['shexiang', '舌象'], ['maixiang', '脉象'], ['suifang', '随访'],
];

/** 把当前表单合成一段自然语言塞进输入框（医师可再编辑）。 */
function composeMessage() {
  const name = $('#pName').value.trim();
  const birth = $('#pBirth').value.trim();
  const sex = $('#pSex').value;
  const kind = $('#pKind').value;
  const head = [];
  if (name) head.push(name);
  if (birth) head.push(birth + '年生');
  if (sex) head.push(sex);
  const lines = [];
  const prefix = kind === 'follow' ? '复诊' : (kind === 'first' ? '首诊' : '');
  if (head.length || prefix) lines.push((prefix ? prefix + '：' : '') + head.join('，') + '。');
  const zhushu = $('#f_zhushu').value.trim();
  const xbs = $('#f_xianbingshi').value.trim();
  if (zhushu) lines.push('主诉：' + zhushu);
  if (xbs) lines.push('现病史：' + xbs);
  for (const [key, label] of OPT_FIELDS) {
    const v = ($('#f_' + key)?.value || '').trim();
    if (v) lines.push(label + '：' + v);
  }
  if (pendingAttachments.length) lines.push('（舌象照片见附件）');
  if (kind === 'follow') lines.push('（复诊：请回顾上次并逐项对比本次变化）');
  return lines.filter(Boolean).join('\n');
}

// ── 离线预览（?demo=1）──────────────────────────────────────
// 只做视觉验收：不调用 Dify、不发任何请求、不写任何数据。
// 复用真实的 startThinking / paint / toolCard 与真实渲染器，所以看到的排版就是线上排版。
const DEMO_ANSWER = [
  '参考知识库中胃脘胀满相关论述。李四目前仅有「反复胃脘胀满一个月」，四诊信息不足，**暂不能确定证型，也不宜直接开方**。',
  '',
  '## 一、问诊要点（建议一次性补充）',
  '',
  '### 1. 胀满细节',
  '- 部位：胃脘、上腹、胁下？是否连及胸胁？',
  '- 性质：胀、痞、闷、痛？喜温喜按还是拒按？',
  '- 与饮食：餐前 / 餐后加重？与情绪是否相关？',
  '',
  '### 2. 伴随症状',
  '1. 嗳气、反酸、口苦、口干？',
  '2. 纳食、二便、睡眠如何？',
  '3. 有无体重下降、黑便、吞咽困难（报警症状）？',
  '',
  '> 若出现消瘦、黑便、进行性吞咽困难，需先排除器质性疾病，不可仅从脾胃论治。',
  '',
  '## 二、四诊要点',
  '',
  '| 四诊 | 重点 |',
  '| --- | --- |',
  '| 望 | 面色、舌质舌苔、舌下络脉 |',
  '| 闻 | 嗳气声、口气 |',
  '| 问 | 如上（寒热、汗、二便、饮食、胸腹、口渴、旧病） |',
  '| 切 | 关脉沉 / 弦 / 滑，左右对比 |',
  '',
  '---',
  '',
  '**说明**：以上为问诊与辨证框架，待四诊信息补齐后再行四诊合参辨证论治。',
].join('\n');

const DEMO_THINK = [
  '先辨虚实：胀满一月，尚未问清部位、性质、与饮食情绪的关系，不能先定证型。',
  '知识库中胃脘胀满多从脾胃虚弱、肝郁脾虚、胆热乘胃、饮食停滞、脾胃虚寒、肝胃不和六路考虑。',
  '关脉是关键：关沉多脾胃虚弱，关弦多肝郁气滞；本案女性 41 岁，还需问月经与情绪。',
  '信息不足，不宜开方 —— 先给问诊要点，并列出报警症状，避免漏掉器质性疾病。',
].join('\n');

async function demo() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const turn = addTurn('（预览）李四，女，41岁，主诉：反复胃脘胀满一个月。请给出问诊与辨证。', false);
  const body = turn.querySelector('.answer .body');
  const th = startThinking(body);
  const R = reasoningSink(turn);
  const phases = ['模型推理中', '模型深度思考中', '模型深度思考中', '执行工具中'];
  let k = 0;
  const timer = setInterval(() => { if (k < phases.length) th.phase(phases[k++]); }, 1500);
  await wait(4500);
  clearInterval(timer);
  const card = toolCard(turn, 'pack__tcm__patient_lookup');
  const st = card.querySelector('.st');
  st.className = 'st ok'; st.textContent = '✓ 38ms';
  const pre = document.createElement('pre');
  pre.textContent = '已定位患者 P002（李四，1985）· 本次为第 3 次就诊（三诊）';
  card.appendChild(pre);
  await wait(600);
  // 思考过程（更小更淡、可折叠）先到，正文后到 —— 与真实链路顺序一致
  th.phase('模型深度思考中');
  for (let i = 0; i < DEMO_THINK.length; i += 6) { R.push(DEMO_THINK.slice(i, i + 6)); await wait(38); }
  R.stop();
  await wait(500);
  th.stop();
  body.innerHTML = '';
  R.fold(); // 正文开始 → 思考过程自动收拢
  for (let i = 0; i < DEMO_ANSWER.length; i += 18) { paint(body, DEMO_ANSWER.slice(0, i + 18), true); await wait(14); }
  paint(body, DEMO_ANSWER, false);
  scroll();
}

/** 绑定问诊视图的所有交互。由 app.js 在启动时调用一次。 */
export function initConsult() {
  // ── 舌象照片 ──
  $('#tongue').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    const tip = $('#tongueTip'); const thumb = $('#thumb');
    pendingAttachments = [];
    if (!f) { thumb.style.display = 'none'; tip.textContent = ''; return; }
    if (!/^image\//.test(f.type)) { tip.textContent = '只支持图片文件'; return; }
    const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); });
    if (dataUrl.length > 7 * 1024 * 1024) { tip.textContent = '图片过大（内核限制单张 ≤5MB）'; return; }
    pendingAttachments = [{ type: 'image', name: f.name || '舌象.jpg', dataUrl }];
    thumb.src = dataUrl; thumb.style.display = 'block';
    tip.textContent = '已附上 —— 发送时内核会把照片交给 Dify 工作流（Dify 侧需开启视觉）。';
  });

  $('#compose').onclick = () => { prefillConsult(composeMessage()); };

  $('#clearForm').onclick = () => {
    for (const id of ['f_zhushu', 'f_xianbingshi', ...OPT_FIELDS.map(([k]) => 'f_' + k)]) { const el = $('#' + id); if (el) el.value = ''; }
    for (const id of ['pName', 'pBirth']) $('#' + id).value = '';
    $('#pSex').value = ''; $('#pKind').value = 'auto';
    $('#tongue').value = ''; $('#thumb').style.display = 'none'; $('#tongueTip').textContent = '';
    pendingAttachments = [];
  };

  $('#send').onclick = () => {
    const t = $('#input').value;
    const att = pendingAttachments.slice();
    $('#input').value = '';
    if (att.length) { pendingAttachments = []; $('#tongue').value = ''; $('#thumb').style.display = 'none'; $('#tongueTip').textContent = ''; }
    send(t, att);
  };
  $('#stop').onclick = () => { try { ctrl?.abort(); } catch {} postJSON('/api/abort', {}).catch(() => {}); };
  $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#send').click(); } });

  if (new URLSearchParams(location.search).has('demo')) demo();
}

/** 把文本填进问诊输入框并聚焦（「患者」页的「发起复诊」也走这里）。 */
export function prefillConsult(text) {
  const el = $('#input');
  el.value = text;
  el.focus();
}
