#!/usr/bin/env node
// OSS 零依赖同步客户端 —— 抄自 DISTRIBUTION-PLAYBOOK.md §3.2（阿里云 OSS V1 签名，不需要 SDK）。
//
// 为什么零依赖：本项目的约束是"零运行时依赖 + 可审计"。OSS 的 V1 签名足够简单，
// 用 node:crypto 三十行就能实现，比引入 SDK 更可控（也避免供应链面）。
//
// 用法：
//   node scripts/oss-sync.mjs put <本地文件> <OSS 键>
//   node scripts/oss-sync.mjs get <OSS 键>  <本地文件>
//   node scripts/oss-sync.mjs ls  [前缀]
//   node scripts/oss-sync.mjs head <OSS 键>
//
// 凭据：~/.mingdao/oss.env（**0600，绝不入库**），格式：
//   OSS_AK=LTAI...
//   OSS_SK=...
//   OSS_BUCKET=mingdaotcm
//   OSS_ENDPOINT=oss-cn-hongkong.aliyuncs.com        # 公网
//   # OSS_ENDPOINT=oss-cn-hongkong-internal.aliyuncs.com  # 同地域 ECS 用**内网**端点（手册铁律 3）
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

function loadEnv() {
  const p = process.env.OSS_ENV_FILE || path.join(os.homedir(), '.mingdao', 'oss.env');
  if (!fs.existsSync(p)) die(`缺少凭据文件 ${p}（应是 0600，且**绝不入库**）`);
  const mode = fs.statSync(p).mode & 0o777;
  if (mode & 0o077) console.error(`⚠ ${p} 权限是 ${mode.toString(8)}，建议 chmod 600`);
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  for (const k of ['OSS_AK', 'OSS_SK', 'OSS_BUCKET', 'OSS_ENDPOINT']) if (!out[k]) die(`凭据文件缺少 ${k}`);
  out.OSS_ENDPOINT = out.OSS_ENDPOINT.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return out;
}

/** OSS V1 签名（虚拟主机风格：bucket 在域名里，resource 里仍要带 /<bucket>/<key>） */
function authHeaders(env, method, key, { contentType = '', contentMd5 = '', ossHeaders = {} } = {}) {
  const date = new Date().toUTCString();
  const canonicalHeaders = Object.keys(ossHeaders).sort()
    .map((k) => `${k.toLowerCase()}:${String(ossHeaders[k]).trim()}\n`).join('');
  // key 逐段 encodeURIComponent（手册原话：**逐段**，否则带空格/中文的键会签名不符）
  const resourceKey = key.split('/').map(encodeURIComponent).join('/');
  const resource = `/${env.OSS_BUCKET}/${resourceKey}`;
  const stringToSign = `${method}\n${contentMd5}\n${contentType}\n${date}\n${canonicalHeaders}${resource}`;
  const sig = crypto.createHmac('sha1', env.OSS_SK).update(stringToSign, 'utf8').digest('base64');
  const h = { Date: date, Authorization: `OSS ${env.OSS_AK}:${sig}`, ...ossHeaders };
  if (contentType) h['Content-Type'] = contentType;
  if (contentMd5) h['Content-MD5'] = contentMd5;
  return h;
}

function url(env, key, query = '') {
  const k = key.split('/').map(encodeURIComponent).join('/');
  return `https://${env.OSS_BUCKET}.${env.OSS_ENDPOINT}/${k}${query}`;
}

async function put(env, file, key) {
  const body = fs.readFileSync(file);
  const md5 = crypto.createHash('md5').update(body).digest('base64');
  const type = /\.yml$/.test(key) ? 'text/yaml' : /\.json$/.test(key) ? 'application/json' : 'application/octet-stream';
  const headers = authHeaders(env, 'PUT', key, { contentType: type, contentMd5: md5 });
  const r = await fetch(url(env, key), { method: 'PUT', headers, body });
  if (!r.ok) die(`PUT ${key} 失败：HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  console.log(`✓ put ${key}（${body.length} 字节）`);
}

async function get(env, key, file) {
  const headers = authHeaders(env, 'GET', key);
  const r = await fetch(url(env, key), { headers });
  if (!r.ok) die(`GET ${key} 失败：HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  console.log(`✓ get ${key} → ${file}（${buf.length} 字节）`);
}

async function head(env, key) {
  const headers = authHeaders(env, 'HEAD', key);
  const r = await fetch(url(env, key), { method: 'HEAD', headers });
  const size = r.headers.get('content-length');
  console.log(`${r.ok ? '✓' : '✗'} head ${key} → HTTP ${r.status}${size ? `，${size} 字节` : ''}`);
  return r.ok;
}

async function ls(env, prefix = '') {
  const headers = authHeaders(env, 'GET', '');
  const q = `?list-type=2${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}&max-keys=1000`;
  const r = await fetch(url(env, '', q), { headers });
  if (!r.ok) die(`LIST 失败：HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  const xml = await r.text();
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  console.log(`✓ ls ${prefix || '(全部)'} → ${keys.length} 个对象`);
  for (const k of keys.slice(0, 50)) console.log('  ' + k);
  if (keys.length > 50) console.log(`  …还有 ${keys.length - 50} 个`);
}

const [cmd, a1, a2] = process.argv.slice(2);
const env = loadEnv();
if (cmd === 'put' && a1 && a2) await put(env, a1, a2);
else if (cmd === 'get' && a1 && a2) await get(env, a1, a2);
else if (cmd === 'ls') await ls(env, a1 || '');
else if (cmd === 'head' && a1) await head(env, a1);
else die('用法：put <本地文件> <OSS 键> | get <OSS 键> <本地文件> | ls [前缀] | head <OSS 键>');
