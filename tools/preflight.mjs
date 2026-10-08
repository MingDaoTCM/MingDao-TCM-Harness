#!/usr/bin/env node
// 发版前审计（preflight）—— 在打 tag **之前**把这一版可能踩的坑先走一遍。
//
// 为什么要有它：这个项目最近连续几次"发布才发现"的失败，根因都属于同一类 ——
// **本机跑不出来、只有装机/打包才暴露**：
//   · extraResources 漏 `layer/providers/**`          → 产物没有 Dify Provider
//   · extraResources 漏 `tools/tcm-ui/settings.mjs`   → 产物起不来
//   · `desktop/**` 整目录排除，UI 服务端动态 import 它 → 检查更新 ERR_MODULE_NOT_FOUND
//   · 没排除 `desktop/dist/**`，打包把自己复制进自己  → ENAMETOOLONG，四条腿全红
//   · 前端 `.catch(() => {})` 吞掉 play() 错误          → 摄像头黑框、看不出原因
// 每一类都补了断言，但它们分散在各测试里，而**人是会忘记跑齐的**。
// 这个脚本把它们收成一条命令：**PASS 才允许打 tag**。
//
// 用法：node tools/preflight.mjs            （本地，打 tag 前）
//       node tools/preflight.mjs --quick    （跳过耗时项）
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const KERNEL = process.env.MINGDAO_KERNEL || path.resolve(REPO, '..', 'MingDao-Harness');
const QUICK = process.argv.includes('--quick');
const DESKTOP = path.join(REPO, 'tools', 'tcm-ui', 'desktop');

let pass = 0; let fail = 0; const failures = [];
const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); };
const bad = (name, why) => { fail++; failures.push(`${name}：${why}`); console.log(`  ✗ ${name}\n      ${why}`); };

/** 跑一个命令，返回 {code, out} */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || REPO, encoding: 'utf8', timeout: opts.timeout || 600000, env: { ...process.env, MINGDAO_KERNEL: KERNEL } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

console.log(`\n发版前审计（preflight）  仓库=${REPO}\n内核=${KERNEL}\n`);

// ── 0. 内核在位且版本合规（Pack 的 engines 校验靠它，缺了会静默跳过整个垂域层）
console.log('[0] 内核');
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(KERNEL, 'package.json'), 'utf8'));
  ok('内核 package.json 可读', `v${pkg.version}`);
} catch (e) {
  bad('内核 package.json', `读不到（${e?.message}）—— 产物里内核版本会变成 0.0.0，Pack 被静默跳过`);
}

// ── 1. 八档门禁
console.log('\n[1] 门禁');
const gates = [
  ['pack verify', ['src/cli.js', 'pack', 'verify', path.join(REPO, 'layer/packs/tcm')], KERNEL],
  ['pack.test', [path.join(REPO, 'layer/packs/tcm/test/pack.test.mjs')], REPO],
  ['integration', [path.join(REPO, 'layer/packs/tcm/test/integration.test.mjs')], REPO],
  ['dify.test', [path.join(REPO, 'layer/providers/test/dify.test.mjs')], REPO],
  ['tcm-data', [path.join(REPO, 'tools/tcm-ui/test/tcm-data.test.mjs')], REPO],
  ['settings', [path.join(REPO, 'tools/tcm-ui/test/settings.test.mjs')], REPO],
  ['ui-wiring', [path.join(REPO, 'tools/tcm-ui/test/ui-wiring.test.mjs')], REPO],
  ['desktop-orch', [path.join(REPO, 'tools/tcm-ui/test/desktop-orchestrator.test.mjs')], REPO],
  ['site', [path.join(REPO, 'site/test/site.test.mjs')], REPO],
];
for (const [name, args, cwd] of gates) {
  const r = run('node', args, { cwd });
  const line = (r.out.match(/结果：通过 \d+，失败 \d+/) || [])[0] || (r.code === 0 ? 'ok' : '');
  if (r.code === 0) ok(name, line); else bad(name, (r.out.trim().split('\n').slice(-3).join(' | ') || 'exit ' + r.code));
}

// ── 2. 打包布局：**在"已经打过包"的状态下**再验一次
//    全新检出没有 dist/，而 CI 是打完一次才有 —— 上一版就是在这里翻车的。
console.log('\n[2] 打包布局（含"已打过包"状态）');
const fakeDist = path.join(DESKTOP, 'dist', 'linux-unpacked', 'resources', 'app');
let created = false;
try {
  if (!fs.existsSync(fakeDist)) { fs.mkdirSync(fakeDist, { recursive: true }); created = true; }
  fs.writeFileSync(path.join(fakeDist, 'preflight-marker.txt'), 'x\n');
  const r = run('node', [path.join(REPO, 'tools/tcm-ui/test/desktop-orchestrator.test.mjs')], { cwd: REPO });
  if (r.code === 0) ok('有 dist/ 时打包模拟仍通过（排除生效，不会自我递归）');
  else bad('打包布局', (r.out.match(/✗[^\n]*/) || ['见 desktop-orch 输出'])[0]);
} finally {
  try { fs.rmSync(path.join(fakeDist, 'preflight-marker.txt'), { force: true }); } catch { /* 忽略 */ }
  if (created) { try { fs.rmSync(path.join(DESKTOP, 'dist'), { recursive: true, force: true }); } catch { /* 忽略 */ } }
}

// ── 3. 装机才会暴露的配置项（逐条点名，缺哪条说哪条）
console.log('\n[3] 装机配置');
try {
  const yml = fs.readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8');
  // [正则, 通过时显示的名字, 失败时说明为什么]
  const need = [
    [/NSCameraUsageDescription/, 'mac 段声明了 NSCameraUsageDescription', 'mac 段缺 NSCameraUsageDescription → macOS 摄像头必被系统拒'],
    [/^[ \t]*entitlements:[ \t]*build\/entitlements\.mac\.plist[ \t]*$/m, 'mac 段指定了 entitlements', 'mac 段没指定 entitlements → hardened runtime 下无 device.camera 授权，macOS 静默给黑帧且不弹授权框'],
    [/!tools\/tcm-ui\/desktop\/dist\/\*\*/, '排除了 desktop/dist/**', '缺 !desktop/dist/** → 打包自我递归（ENAMETOOLONG，四条腿全红）'],
    [/desktop\/node_modules/, '排除了 desktop/node_modules/**', '缺 !desktop/node_modules/** → 产物巨大且可能带进 Electron 本体'],
    [/dify\.mjs|layer\/providers/, '带上了 layer/providers（Dify Provider）', '缺 layer/providers → 产物没有 Dify Provider，问诊不走 Dify'],
    [/kernel\/package\.json/, '带上了 kernel/package.json', '缺 kernel/package.json → 内核版本读成 0.0.0，Pack 被静默跳过'],
  ];
  for (const [re, name, why] of need) { if (re.test(yml)) ok(`electron-builder.yml：${name}`); else bad('electron-builder.yml', why); }
  // entitlements 文件本身：device.camera 必须在，且 Electron 的四个必需授权不能少
  try {
    const pl = fs.readFileSync(path.join(DESKTOP, 'build', 'entitlements.mac.plist'), 'utf8');
    const keys = ['com.apple.security.device.camera', 'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.allow-dyld-environment-variables',
      'com.apple.security.cs.disable-library-validation'];
    const miss = keys.filter((k) => !pl.includes(k));
    if (!miss.length) ok('entitlements.mac.plist：摄像头授权 + Electron 四个必需授权齐全');
    else bad('entitlements.mac.plist', '缺：' + miss.join(', ') + (miss.includes('com.apple.security.device.camera') ? '（缺摄像头授权 → macOS 黑帧）' : '（缺 Electron 必需授权 → 可能起不来）'));
  } catch (e) { bad('entitlements.mac.plist', String(e?.message || e)); }
} catch (e) { bad('electron-builder.yml', String(e?.message || e)); }

// ── 3b. 自动更新链路：站点必须带 zip + 更新元数据
//        这两样缺任何一个，客户端就退化成"下载安装包再手动装"（用户反馈的"不够智能"）。
//        mac 的 electron-updater 用 **zip** 做增量更新，dmg 只供人工安装 —— 所以 zip 必须上站。
console.log('\n[3b] 自动更新链路');
try {
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'desktop.yml'), 'utf8');
  if (/case "\$f" in \._\*\) ;; \*\) SITE_FILES/.test(wf)) ok('站点推送包含 zip（mac 自动更新需要）');
  else bad('站点推送', 'SITE_FILES 把 zip 排除了 → electron-updater 在 macOS 上必然失败，只能手动装');
  const fa = fs.readFileSync(path.join(REPO, 'site', 'fetch-assets.py'), 'utf8');
  if (/\.zip/.test(fa) && /not x\['name'\]\.endswith\('\.zip'\)/.test(fa)) bad('对账口径', '把 zip 排除在对账之外 → 站点多出 zip 时会拒绝写清单');
  else ok('对账口径包含 zip');
  // 页面清单仍不该展示 zip（那是给医师点的安装包列表）
  if (/is_update_meta\(n\) or n\.endswith\('\.zip'\)/.test(fa)) ok('页面清单不展示 zip / 更新元数据');
  else bad('页面清单', 'zip 或 latest*.yml 会出现在下载列表里（医师不该看到它们）');
} catch (e) { bad('自动更新链路', String(e?.message || e)); }

// ── 3c. 自动更新的客户端纪律（借鉴上游 DESKTOP-AUTO-UPDATE.md §6.1）
//        这几条都是上游**真机踩过**的：模块导出缺失、监听器抛错中断事件派发、
//        deb 形态自更新必抛、本地化错误文案导致重试永不触发。写成断言，免得再退化。
console.log('\n[3c] 自动更新客户端纪律');
try {
  const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  const checks = [
    [/mod\?\.autoUpdater \?\? mod\?\.default\?\.autoUpdater/, '模块解析多级兜底（打包后 ESM→CJS 命名导出可能缺失）'],
    [/typeof updater\.on !== 'function'/, '解析不到可用对象时及早退出，而不是走到 .on() 才炸'],
    [/process\.platform === 'linux' && !process\.env\.APPIMAGE/, 'deb 形态只检查不下载（否则抛 ERR_UPDATER_OLD_FILE_NOT_FOUND）'],
    [/ERR_\(NETWORK\|CONNECTION/, '重试判据看 err.code（message 是本地化的）'],
    [/const safe = /, '监听器统一包一层：抛错只隔离该事件，不中断事件派发'],
    [/Promise\.race/, '检查阶段有超时兜底'],
  ];
  for (const [re, why] of checks) { if (re.test(main)) ok('客户端：' + why); else bad('main.js', '缺：' + why); }
} catch (e) { bad('main.js', String(e?.message || e)); }

// ── 3c2. shell 陷阱：`set -o pipefail` 下的 `… | grep -q`
//        为什么单列一条：grep -q 一匹配就退出 → 上游命令收到 SIGPIPE（141）→
//        pipefail 把整条管道判为失败。表现是「资产明明齐了却报缺」，而且**间歇性**发作
//        （v0.1.21 挂、22 过、23 过、24 挂），排查成本极高。
console.log('\n[3c2] shell 陷阱');
try {
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'desktop.yml'), 'utf8');
  // 只看**真正执行的行**：注释里提到这个陷阱是正常的（那条注释就是在解释它）
  // ⚠ 必须先剥掉 `||`：它里面的竖线不是管道（`grep -q X file || { ... }` 是安全的，
  //   上一版规则把这种当成了违规，属于假警报 —— 而假警报刷多了人就不看审计了）
  const risky = wf.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\|\|/g, ''))
    .filter((l) => l.includes('|') && /\bgrep\s+-q/.test(l));
  if (!risky.length) ok('workflow 无「管道 + grep -q」（pipefail 下会因 SIGPIPE 误判）');
  else bad('workflow', '仍有 pipefail+grep -q 管道（间歇性误判）：' + risky.map((l) => l.trim().slice(0, 60)).join(' / '));
} catch (e) { bad('workflow', String(e?.message || e)); }

// ── 3d. 已知差距（明示，不判失败）：差量更新
//        上游 DESKTOP-AUTO-UPDATE.md §7 第 7 条：没有 .blockmap 时三平台**每次都整包重下**
//        （exe 76MB / mac zip 93-101MB / AppImage 104MB）。本项目在 CI 里**显式丢弃 blockmap**，
//        原因是我们这条服务器上行只有 ~50-100KB/s，推送量已经在 300 分钟上限附近；
//        再带上 blockmap 会让发版本身更容易失败。
//        这是**知情取舍**，不是遗漏 —— 写在这里，免得后人以为是忘了。
console.log('\n[3d] 已知差距（明示）');
{
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'desktop.yml'), 'utf8');
  if (/rm -f "\$DL"\/\*\.blockmap/.test(wf)) {
    console.log('  ⚠ 差量更新未启用：CI 丢弃了 *.blockmap → 用户每次更新整包重下（76-104MB）。');
    console.log('     取舍理由：本站上行 ~50-100KB/s，推送量已近 300 分钟上限。');
    console.log('     要启用：去掉那行 rm，并把 blockmap 纳入站点与对账口径（上游做法见文档 §4.3）。');
  } else ok('未丢弃 blockmap（差量更新可用）');
}

// ── 4. 静默失败扫描（只提示，不判失败：有些是合理的，需要人看一眼）
console.log('\n[4] 静默失败扫描（提示）');
const risky = [];
for (const f of ['tools/tcm-ui/public/js/consult.js', 'tools/tcm-ui/public/js/patients.js', 'tools/tcm-ui/public/js/settings.js', 'tools/tcm-ui/public/js/app.js']) {
  const p = path.join(REPO, f);
  if (!fs.existsSync(p)) continue;
  fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
    // 只报**真·空 catch**（`.catch(() => {})`）—— 它会把"该让人看见的错误"吞掉，
// 摄像头黑框就是这么来的。带注释说明的忽略（catch { /* 忽略 */ }）是经过判断的，不算。
    if (/catch\s*\(\s*\)\s*=>\s*\{\s*\}/.test(l)) risky.push(`${f}:${i + 1}  ${l.trim().slice(0, 60)}`);
  });
}
if (risky.length) console.log(`  ⚠ 有空 catch（确认每一处都不会吞掉"该让人看见"的错误）：\n      ${risky.join('\n      ')}`);
else ok('前端无空 catch');

// ── 5. 上一版是否真的发出去了（避免在上一次失败的基础上又叠一版）
console.log('\n[5] 上一版发布状态');
const prevTag = (() => { const r = run('git', ['tag', '-l', 'v0.1.*']); return (r.out.split('\n').filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() || '').trim(); })();
if (!prevTag) ok('尚无历史 tag');
else {
  // token 从工作区的 .env 取（有就给 gh，没有就明说"查不了"）——
  // ⚠ 查询失败 ≠ 资产为 0。把"查不了"报成"资产不足"就是**假警报**，
  //   而假警报刷多了人就不看审计了，与审计骗人是同一类危害。
  let token = process.env.GH_TOKEN || process.env.MINGDAO_GITHUB_TOKEN || '';
  if (!token) {
    try {
      const env = fs.readFileSync(path.resolve(REPO, '..', 'MingDao-Harness', '.env'), 'utf8');
      token = (env.match(/^MINGDAO_GITHUB_TOKEN=(.*)$/m) || [])[1]?.trim() || '';
    } catch { /* 没有就算了 */ }
  }
  const r = run('gh', ['release', 'view', prevTag, '--json', 'assets', '-q', '.assets[].name'],
    { cwd: REPO, env: token ? { ...process.env, GH_TOKEN: token } : process.env });
  const names = r.out.split('\n').filter(Boolean);
  const queryFailed = r.code !== 0 && /auth|token|not found|error/i.test(r.out);
  // 刚打的 tag 天然还没有 Release（正在构建）—— 那不是"发了一半"，
  // 报成警告同样是假警报。只有**创建超过 60 分钟**且资产不足才值得提醒。
  const ageMin = (() => {
    const t = run('git', ['log', '-1', '--format=%ct', prevTag]);
    const ct = Number((t.out || '').trim());
    return ct ? (Date.now() / 1000 - ct) / 60 : 0;
  })();
  if (!queryFailed && names.length >= 5) ok(`上一版 ${prevTag} 已发布`, `${names.length} 个资产`);
  else if (!queryFailed && ageMin < 60) console.log(`  － ${prevTag} 刚打 tag（${Math.round(ageMin)} 分钟前），Release 仍在构建/推送中 —— 不作为问题`);
  else if (queryFailed) console.log(`  － 上一版 ${prevTag} 的发布状态**未能查询**（gh 未认证 / 无网络）—— 未验证，不代表有问题`);
  else console.log(`  ⚠ 上一版 ${prevTag} 的 Release 资产确实不足（${names.length} 个）—— 确认不是"发了一半"`);
}

// ── 6. 摄像头端到端（可选：需要 Electron + 图形环境，跑不了就明确跳过）
console.log('\n[6] 摄像头端到端（可选）');
if (QUICK) console.log('  － --quick 跳过');
else {
  const electron = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron');
  const e2e = path.join(REPO, '..', 'gui-verify', 'camera-e2e.js');
  if (!fs.existsSync(electron) || !fs.existsSync(e2e) || !process.env.DISPLAY) {
    console.log('  － 环境不具备（无 Electron / 无 DISPLAY / 缺脚本）—— 未验证真实出图，装机后仍需人工看一眼');
  } else {
    console.log('  － 需先起 UI 服务，见 gui-verify/camera-e2e.js 顶部说明（本项在装机前无法完全替代人工）');
  }
}

console.log(`\n审计结果：通过 ${pass}，失败 ${fail}`);
if (fail) { console.log('\n✗ 不允许发版。先修掉上面每一条：\n  ' + failures.join('\n  ') + '\n'); process.exit(1); }
console.log('\n✓ 可以打 tag。\n');
