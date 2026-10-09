#!/usr/bin/env node
// 生成站点用的 versions.json —— **每一版增加了什么、变了什么**。
//
// 为什么要有这个脚本（而不是写在 workflow 的一行 python 里）：
//   它是"版本动态"的唯一数据来源，逻辑要能被读到、能被改对；塞在 YAML 里只会越来越没人敢动。
//
// 口径：说明取自 GitHub 的 **compare API**（上一版…本版 之间的提交标题），
//   不是手写的静态文案 —— 手写的必然过期（本项目已因此吃过亏）。
//   过滤掉纯发布提交（`chore: release`）与 Merge 提交，它们对读者没有信息量。
//
// 用法：MINGDAO_GITHUB_TOKEN=… node site/gen-versions.mjs > versions.json

const REPO = process.env.TCM_REPO || 'MingDaoTCM/MingDao-TCM-Harness';
const LIMIT = Number(process.env.TCM_VERSIONS_LIMIT || 30);

// 用 **token + fetch**，不用 gh CLI：CI 里两者都有，但本机往往只配了 token
// （`gh` 需要 GH_TOKEN，缺了就静默失败 —— 这个脚本第一版就因此在本机跑不出来）。
const TOKEN = process.env.MINGDAO_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!TOKEN) {
  console.error('缺少 MINGDAO_GITHUB_TOKEN / GH_TOKEN —— 读私有 Release 需要它');
  process.exit(2);
}
async function ghApi(path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mingdao-tcm-site' },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} ${path}`);
  return r.json();
}

const releases = (await ghApi(`/repos/${REPO}/releases?per_page=${LIMIT}`))
  .filter((r) => !r.draft)
  .map((r) => ({ tagName: r.tag_name, publishedAt: r.published_at, name: r.name || r.tag_name }));
const versions = [];
for (let i = 0; i < releases.length; i++) {
  const tag = releases[i].tagName;
  const prev = releases[i + 1]?.tagName;
  const notes = [];
  if (prev) {
    try {
      const cmp = await ghApi(`/repos/${REPO}/compare/${prev}...${tag}`);
      for (const c of (cmp.commits || []).slice(0, 25)) {
        const msg = String(c?.commit?.message || '').split('\n')[0].trim();
        if (msg && !/^(chore: release|Merge )/.test(msg)) notes.push(msg);
      }
    } catch (e) {
      notes.push(`（未能取到本版说明：${e?.message || e}）`);
    }
  }
  versions.push({ version: tag.replace(/^v/, ''), at: releases[i].publishedAt, name: releases[i].name || tag, notes });
}
process.stdout.write(JSON.stringify({ versions }, null, 2) + '\n');
