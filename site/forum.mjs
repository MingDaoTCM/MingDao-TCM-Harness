// 社区论坛（站点服务内的一个模块）——零依赖、单文件 JSON 存储。
//
// 为什么不做成独立服务：上游的 BBS 是单独进程 + 单独端口 + 单独 systemd 单元；
// 那样多三处可坏的地方（端口占用、单元漏重启、vhost 漏配）。本项目的论坛只需要
// "发帖 / 回帖 / 管理员删帖"，挂在站点服务里最省事，也天然复用同一套公开访问与日志。
//
// 安全取舍（都写在这里，免得被当成疏漏）：
//   · **只存文本**，绝不接受 HTML；输出一律转义（页面侧也再转一次）——发帖是最典型的 XSS 入口。
//   · 长度硬上限（标题/正文/昵称），存储文件也有条数上限，防止有人把盘写满。
//   · 按 IP 限速（发帖/回帖），挡脚本刷屏。
//   · **删帖要管理员密码**：公开站点不能让人随手删别人的帖子。
//   · 原子写（临时文件 + rename）：半写的 JSON 会让整个论坛读不出来。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_POSTS = 500;
const MAX_REPLIES = 200;
const TITLE_MAX = 80;
const NAME_MAX = 20;
const BODY_MAX = 4000;

/** 网页渲染前先把控制字符去掉：它们能把日志与终端搅乱，且没有任何展示价值 */
const sanitize = (s, max) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/\r\n/g, '\n')
  .trim()
  .slice(0, max);

/** @param {string} dataDir */
function fileOf(dataDir) { return path.join(dataDir, 'forum.json'); }

function readAll(dataDir) {
  const p = fileOf(dataDir);
  // ⚠ "文件不存在"与"文件损坏"必须分开：前者是**首次使用的正常状态**。
  //   实测踩到：把两者混在一起，论坛的第一帖就会因为"读取失败"发不出去。
  if (!fs.existsSync(p)) return { posts: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j?.posts) ? j : { posts: [] };
  } catch {
    // 真损坏才大声说：论坛没了要比"显示空列表"清楚得多（后者会被当成"还没人发帖"）
    return { posts: [], error: '论坛数据读取失败（文件损坏）' };
  }
}

function writeAll(dataDir, db) {
  const p = fileOf(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/** 简单限速：同一 IP 在窗口内最多 N 次写操作 */
const hits = new Map();
function allow(ip, key, max, windowMs) {
  const k = `${ip}|${key}`;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(k, arr); return false; }
  arr.push(now);
  hits.set(k, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}

export const forumLimits = { TITLE_MAX, NAME_MAX, BODY_MAX, MAX_POSTS, MAX_REPLIES };

/** @param {any} post */
function publicPost(post) {
  return {
    id: post.id, title: post.title, name: post.name, body: post.body,
    at: post.at, replies: (post.replies || []).map((r) => ({ id: r.id, name: r.name, body: r.body, at: r.at })),
  };
}

/** 列帖（新在前） */
export function listPosts(dataDir) {
  const db = readAll(dataDir);
  return { ok: !db.error, error: db.error, posts: (db.posts || []).slice(0, 100).map(publicPost) };
}

/**
 * 发帖 / 回帖。`action` 为 'post' 或 'reply'。
 * @param {string} dataDir @param {string} ip @param {any} body
 */
export function submit(dataDir, ip, body) {
  const action = body?.action === 'reply' ? 'reply' : 'post';
  if (!allow(ip, action, action === 'post' ? 5 : 20, 10 * 60 * 1000)) {
    return { ok: false, error: '操作过于频繁，请稍后再试' };
  }
  const db = readAll(dataDir);
  if (db.error) return { ok: false, error: db.error };
  const name = sanitize(body?.name, NAME_MAX) || '匿名';
  const text = sanitize(body?.body, BODY_MAX);
  if (text.length < 2) return { ok: false, error: '内容太短' };

  if (action === 'post') {
    const title = sanitize(body?.title, TITLE_MAX);
    if (!title) return { ok: false, error: '标题不能为空' };
    const post = { id: crypto.randomBytes(6).toString('hex'), title, name, body: text, at: new Date().toISOString(), replies: [] };
    db.posts.unshift(post);
    if (db.posts.length > MAX_POSTS) db.posts.length = MAX_POSTS;
    writeAll(dataDir, db);
    return { ok: true, id: post.id };
  }

  const post = (db.posts || []).find((p) => p.id === String(body?.postId || ''));
  if (!post) return { ok: false, error: '帖子不存在' };
  post.replies = post.replies || [];
  post.replies.push({ id: crypto.randomBytes(6).toString('hex'), name, body: text, at: new Date().toISOString() });
  if (post.replies.length > MAX_REPLIES) post.replies = post.replies.slice(-MAX_REPLIES);
  writeAll(dataDir, db);
  return { ok: true, id: post.id };
}

/** 删帖（**仅管理员**；调用方负责校验管理员身份） */
export function deletePost(dataDir, id) {
  const db = readAll(dataDir);
  if (db.error) return { ok: false, error: db.error };
  const before = (db.posts || []).length;
  db.posts = (db.posts || []).filter((p) => p.id !== String(id || ''));
  if (db.posts.length === before) return { ok: false, error: '帖子不存在' };
  writeAll(dataDir, db);
  return { ok: true };
}
