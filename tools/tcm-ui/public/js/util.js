// 通用工具：DOM 选择、HTML 转义、Markdown 轻渲染、<think> 兜底过滤。
// 从原单文件 index.html 拆出（拆多文件是为了可维护；无构建步骤，浏览器原生 ES module）。

export const $ = (s) => document.querySelector(s);

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Markdown 轻渲染 ─────────────────────────────────────────
// 镜像内核 src/web/util.js 的 renderMarkdown（标题/段落/真列表/引用/分割线/代码块），
// 额外支持 GFM 表格 —— Dify 工作流的中医问诊正文大量使用分节标题与四诊表格。
export function renderInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\s][^*]*)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s'"<>)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let out = '', inCode = false, codeLang = '', code = [], para = [], list = null, tbl = [];
  const flushPara = () => { if (para.length) { out += '<p>' + para.join('<br>') + '</p>'; para = []; } };
  const flushList = () => {
    if (list) { out += '<' + list.type + '>' + list.items.map((i) => '<li>' + i + '</li>').join('') + '</' + list.type + '>'; list = null; }
  };
  const flushTable = () => {
    if (!tbl.length) return;
    const cells = (r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const head = cells(tbl[0]);
    out += '<table><thead><tr>' + head.map((c) => '<th>' + renderInline(c) + '</th>').join('') + '</tr></thead><tbody>'
      + tbl.slice(1).map((r) => '<tr>' + cells(r).map((c) => '<td>' + renderInline(c) + '</td>').join('') + '</tr>').join('')
      + '</tbody></table>';
    tbl = [];
  };
  const flushAll = () => { flushTable(); flushList(); flushPara(); };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('```')) {
      if (!inCode) { flushAll(); inCode = true; codeLang = t.slice(3).trim().split(/\s+/)[0] || ''; code = []; }
      else { out += '<pre><code class="lang-' + esc(codeLang) + '">' + esc(code.join('\n')) + '</code></pre>'; inCode = false; }
      continue;
    }
    if (inCode) { code.push(lines[i]); continue; }
    if (t === '') { flushAll(); continue; }
    const nxt = (lines[i + 1] || '').trim();
    if (t.startsWith('|') && t.endsWith('|') && /^\|[\s:|-]+\|$/.test(nxt)) { flushList(); flushPara(); tbl = [t]; i++; continue; }
    if (tbl.length && t.startsWith('|') && t.endsWith('|')) { tbl.push(t); continue; }
    if (tbl.length) flushTable();
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushList(); flushPara(); const lv = Math.min(h[1].length, 4); out += '<h' + lv + '>' + renderInline(h[2]) + '</h' + lv + '>'; continue; }
    const ul = t.match(/^([-*+])\s+(.*)$/);
    if (ul) { flushPara(); if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(renderInline(ul[2])); continue; }
    const ol = t.match(/^(\d+)[.)]\s+(.*)$/);
    if (ol) { flushPara(); if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(renderInline(ol[2])); continue; }
    if (/^>\s?/.test(t)) { flushList(); flushPara(); out += '<blockquote>' + renderInline(t.replace(/^>\s?/, '')) + '</blockquote>'; continue; }
    if (/^(-{3,}|\*{3,})$/.test(t)) { flushList(); flushPara(); out += '<hr>'; continue; }
    flushList();
    para.push(renderInline(t));
  }
  if (inCode && code.length) out += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
  flushAll();
  return out;
}

// <think> 段的可见部分 —— 与 provider 端 (dify.mjs) 同一套语义：
// 完整的 <think>…</think> 整段隐去；未闭合时其后全部隐去。
// 这是第二道防线：即使某个 provider 漏了过滤，医师也不会在正文里看到模型的内部推理。
export function visibleOf(s) {
  const t = String(s ?? '');
  const m = /<think>[\s\S]*?<\/think>/.exec(t);
  if (m) return t.replace(m[0], '');
  const i = t.indexOf('<think>');
  return i >= 0 ? t.slice(0, i) : t;
}

/** 是否正处在未闭合的推理段里（用于把等待提示换成「深度思考中」） */
export const inThink = (s) => {
  const t = String(s ?? '');
  return t.indexOf('<think>') >= 0 && !/<\/think>/.test(t);
};

/** 「N 天前」的口语化表述（名册/详情共用） */
export function relDays(d) {
  if (d == null) return '—';
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  return `${d} 天前`;
}
