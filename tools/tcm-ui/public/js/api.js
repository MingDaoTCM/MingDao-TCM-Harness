// 与内核 / 代理的 HTTP 交互（薄薄一层，便于测试与替换）。
// 内核契约见 MingDao-Harness 的 src/web/server.js 头部（路由 + SSE 事件表）。

/** GET 一个 JSON 端点；网络或解析失败也返回对象（{ok:false,error}），调用方不必 try/catch */
export async function getJSON(url, signal) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    const j = await r.json().catch(() => null);
    if (j && typeof j === 'object') return j;
    return { ok: false, error: `HTTP ${r.status}（响应不是 JSON）` };
  } catch (e) {
    return { ok: false, error: `请求失败：${e?.message || e}` };
  }
}

/** POST JSON；返回原始 Response（调用方可能要读 SSE 流） */
export function postJSON(url, body, signal) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
}

/**
 * 读 SSE：按空行分块，逐条 `data: <json>` 交给 onEvent（**不缓冲**，逐块到达）。
 * 抽出来是因为问诊链路对"逐字到达"敏感：任何缓冲都会把流式问诊变成"等全部再显示"。
 */
export async function streamSSE(resp, onEvent) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        await onEvent(ev);
      }
    }
  }
}
