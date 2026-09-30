// 问诊台的**设置模块**：让医师自己填 / 改 DeepSeek 与 Dify 的密钥，不内置进仓库。
//
// 为什么单独成一个模块（而不是散在前端或 provider 里）：
//   · 密钥的落盘位置与格式由**内核**决定（`$MINGDAO_HOME/credentials.json`、
//     `config.json` 的 tcm 段）—— 这里必须与内核同一口径，写错了表现为"填了也没用"。
//   · 读取侧必须**只回脱敏值**：设置页要显示"已配置（app-****abcd）"而不是明文，
//     否则任何能打开本机页面的人（或一张截图）就把密钥带走了。
//   · 「留空 = 不改」这条语义必须写在**一处**：设置页有三四个输入框，
//     如果每个框都自己判断"空是不是要清空"，迟早出现"改一个字段把另一个密钥抹了"。
//
// 落盘（与内核/ provider 完全一致，见 layer/providers/dify.mjs 的读取）：
//   credentials.json  { "dify": "app-…", "deepseek": "sk-…", …其它键原样保留 }
//   config.json       { provider: "dify", model: "dify-chatflow",
//                       tcm: { difyBaseUrl, orchestrator: { baseUrl, model } } }
import fs from 'node:fs';
import path from 'node:path';

/** Dify 的默认工作流地址（与 provider 的 DEFAULT_DIFY_BASE 同一口径） */
export const DEFAULT_DIFY_BASE = 'https://dify.mingdaotcm.cn';
/** 编排判定模型（provider 里 decide() 用它；默认 DeepSeek） */
export const DEFAULT_ORCH_BASE = 'https://api.deepseek.com/v1';
export const DEFAULT_ORCH_MODEL = 'deepseek-chat';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function writeJson(p, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
  fs.renameSync(tmp, p);   // 原子写：半份凭据文件会让内核读不出来（等于全都丢了）
}

/**
 * 脱敏：只留前 4 / 后 4 位。密钥短于 12 位时只留后 2 位，避免"脱敏后等于明文"。
 * @param {string} v
 */
export function maskKey(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 12) return `${s.slice(0, 1)}****${s.slice(-1)}`;
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** @param {string} home */
export function readSettings(home) {
  const creds = readJson(path.join(home, 'credentials.json')) || {};
  const cfg = readJson(path.join(home, 'config.json')) || {};
  const tcm = cfg.tcm || {};
  const orch = tcm.orchestrator || {};
  const difyKey = String(creds.dify || '');
  const dsKey = String(creds.deepseek || '');
  return {
    provider: String(cfg.provider || ''),
    model: String(cfg.model || ''),
    difyBaseUrl: String(tcm.difyBaseUrl || DEFAULT_DIFY_BASE),
    difyKeyMasked: maskKey(difyKey),
    difyKeySet: !!difyKey,
    // 编排判定模型（provider 的 decide()）：默认 DeepSeek，可指向本地 OpenAI 兼容端点
    orchBaseUrl: String(orch.baseUrl || DEFAULT_ORCH_BASE),
    orchModel: String(orch.model || DEFAULT_ORCH_MODEL),
    orchKeyMasked: maskKey(orch.apiKey || dsKey),
    orchKeySet: !!(orch.apiKey || dsKey),
    orchKeyFrom: orch.apiKey ? 'config' : (dsKey ? 'credentials' : ''),
    // 问诊走没走 Dify 工作流，就看这个 —— 设置页把它显式告诉医师
    routeA: String(cfg.provider || '') === 'dify',
  };
}

/** 校验：只挡明显不可能的值（含空白的密钥、非 http 的地址），不猜测密钥格式 */
function validateKey(name, v) {
  const s = String(v).trim();
  if (!s) return `${name}不能为空`;
  if (/\s/.test(s)) return `${name}不能含空格或换行（粘贴时多半带上了）`;
  if (s.length < 8) return `${name}太短（${s.length} 位），像是没复制全`;
  return '';
}
function validateUrl(name, v) {
  const s = String(v).trim();
  if (!/^https?:\/\/[^\s]+$/i.test(s)) return `${name}必须是 http(s):// 开头的地址`;
  return '';
}

/**
 * 写设置。语义（**留空 = 不改**，`clear` 里点名才删）：
 *   { difyKey?, orchKey?, difyBaseUrl?, orchBaseUrl?, orchModel?, clear?: ('dify'|'deepseek')[] }
 * @returns {{ok:true, settings:any} | {ok:false, error:string}}
 */
export function writeSettings(home, input = {}) {
  const credPath = path.join(home, 'credentials.json');
  const cfgPath = path.join(home, 'config.json');
  const creds = readJson(credPath) || {};
  const cfg = readJson(cfgPath) || {};
  const clear = Array.isArray(input.clear) ? input.clear.map(String) : [];

  // ── 密钥 ──
  for (const [field, credKey, label] of [['difyKey', 'dify', 'Dify API Key'], ['orchKey', 'deepseek', 'DeepSeek API Key']]) {
    const raw = input[field];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;  // 留空 = 不改
    const err = validateKey(label, raw);
    if (err) return { ok: false, error: err };
    creds[credKey] = String(raw).trim();
  }
  for (const name of clear) {
    if (name === 'dify') delete creds.dify;
    else if (name === 'deepseek') delete creds.deepseek;
  }

  // ── 地址与模型 ──
  cfg.tcm = cfg.tcm || {};
  if (input.difyBaseUrl !== undefined && String(input.difyBaseUrl).trim() !== '') {
    const err = validateUrl('Dify 工作流地址', input.difyBaseUrl);
    if (err) return { ok: false, error: err };
    cfg.tcm.difyBaseUrl = String(input.difyBaseUrl).trim().replace(/\/+$/, '');
  }
  if (input.orchBaseUrl !== undefined && String(input.orchBaseUrl).trim() !== '') {
    const err = validateUrl('编排模型地址', input.orchBaseUrl);
    if (err) return { ok: false, error: err };
    cfg.tcm.orchestrator = { ...(cfg.tcm.orchestrator || {}), baseUrl: String(input.orchBaseUrl).trim().replace(/\/+$/, '') };
  }
  if (input.orchModel !== undefined && String(input.orchModel).trim() !== '') {
    cfg.tcm.orchestrator = { ...(cfg.tcm.orchestrator || {}), model: String(input.orchModel).trim() };
  }

  // ── 问诊路线：本产品的正文与知识库在 Dify 工作流里（路线 A）──
  // 只有"确实配了 Dify Key"才把 provider 切过去，避免医师还没填 key 就被切成一个用不了的 provider。
  if (creds.dify && (!cfg.provider || cfg.provider === 'deepseek' || input.forceRouteA)) {
    cfg.provider = 'dify';
    cfg.model = 'dify-chatflow';
    delete cfg.baseUrl;   // 顶层 baseUrl 会压过 Dify 端点（见 dify.mjs 的说明）
  }

  try {
    writeJson(credPath, creds, 0o600);
    writeJson(cfgPath, cfg, 0o600);
  } catch (e) {
    return { ok: false, error: `写入失败：${e?.message || e}` };
  }
  return { ok: true, settings: readSettings(home) };
}
