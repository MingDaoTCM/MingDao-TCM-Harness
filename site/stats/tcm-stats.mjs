// 站点访问量与安装包下载计数（宿主 cron 每 5 分钟运行）
//
// ⚠ 本文件**移植自上游官网的 /opt/mingdao/site-stats.mjs**（用户："直接抄上游作业就可以"）。
//   移植只改必要几处：日志路径 / 状态与输出路径 / 栏目划分 / 包名前缀与文件族归一化。
//   上游那套口径与防虚增判据**原样保留**（见下方"统一计数口径"）—— 都是他们踩出来的：
//     · 按「天」聚合后覆盖合并 → 重跑/日志轮转都不重复计数；
//     · 下载按「IP × 文件族 × 北京日」去重 → 一次下载几十个 Range 请求，按请求计虚增 7~15 倍；
//     · 排除 electron-updater 的 UA（自动更新与手动下载走**同一个 URL**，不排除会重复计数）；
//     · 排除爬虫/curl/wget；单 IP 单日 PV 超上限只扣超出（不整 IP 清零，免误伤高频真实用户）。
//   本层差异：桌面自动更新的**信标**尚未接入（字段保留恒为 0，不假装有数）。
// 数据源：openresty 容器内 /var/log/nginx/harness.access.log（main 格式，harness.mingdao.ai 专属）
// 输出：/opt/1panel/www/sites/mingdao-site/stats.json（原子写）
// 幂等设计：按「天」聚合后与状态文件做覆盖合并——重复解析/日志轮转/重跑都不会重复计数；
// 历史天数永久保留在状态文件，logrotate 删除旧日志不影响累计值。
//
// 统一计数口径（2026-09-06 统筹）：
//   1) 页面访问分四栏目：首页(/,/index.html) / 使用指南(/guide.html) / API 文档(/api.html) /
//      社区论坛(/forum/)；各栏目 total+today，另有全站 PV 与累计/今日 UV（独立 IP）。
//   2) 手动下载 = 官网三大平台按钮的 5 个文件族（setup-exe / arm64.dmg / x64.dmg / deb / AppImage）。
//      **只计「人」的下载**，判据与页面 PV 同源（2026-09-21 修正，此前有两个错误）：
//        · 排除 electron-updater（UA=electron-builder）。**只按文件名排除 mac zip 是不够的**：
//          Windows 的 exe 与 Linux 的 AppImage 自动更新走的是**与手动下载同一个 URL**，
//          于是同一次更新既进「手动下载」又进「桌面自动更新」信标 —— 重复计数。
//          macOS 因为更新器用的是独立的 -mac.zip 才侥幸没被重复计。
//        · 排除爬虫/监控/curl/wget（复用 PV 的 BOT_RE，同一份判据）。
//        · 保留 -mac.zip 的排除（历史规则：该文件只由更新器取）。
//        · 同一天同一 IP 同一文件族只计 1 次。一次下载会被浏览器/下载器拆成几十个 Range
//          请求（实测：arm64.dmg 一次下载 57 个请求；该族 356 个请求里 279 个是 206）。
//          按请求计会把「请求数」当「人数」，实测虚增 7~15 倍。这与 PV 的「单 IP 单日封顶」同源：
//          **宁可少算，不可虚增**。
//   3) 桌面自动更新 = stats-beacon.js 信标（一次更新计一次），按北京自然日聚合进 updates。
//   4) 累计下载 = 手动下载累计 + 桌面自动更新累计；今日下载同理。
//   5) 防轮询：单 IP 单日页面访问超过 PV_IP_CAP 的部分按「超出量」剔除（只扣超出，不整 IP 清零——
//      此前整 IP 剔除会误伤高频访问的真实用户）。每 IP 仍计 1 个 UV。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CONTAINER = '1Panel-openresty-baFL';
const LOG = '/var/log/nginx/tcm.access.log';
const STATE_FILE = '/opt/mingdao/tcm-stats-state.json';
const OUT_FILE = '/opt/1panel/www/sites/tcm-site/stats.json';
const BEACON_FILE = '/opt/mingdao/tcm-update-beacons.jsonl'; // 本站点自己的桌面更新信标（目前尚未接入 → 恒 0；**不要**指向上游那个文件，否则会把上游的更新算进来）
const PV_IP_CAP = Number(process.env.PV_IP_CAP || 50); // 单 IP 单日 PV 上限：超出部分视为轮询噪声（不再整 IP 清零）

const LINE_RE =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^"\s]+)[^"]*" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"(?: "([^"]*)")?/;
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const BOT_RE =
  /bot|crawler|spider|semrush|ahrefs|baiduspider|sogou|yandex|bingpreview|monitor|uptimerobot|pingdom|headless|python-requests|Go-http-client|curl\/|wget\/|libwww|facebookexternalhit|twitterbot|feedfetcher|bytespider|petalbot/i;
const DL_RE = /^\/downloads\/([^\/?#]+\.(?:exe|dmg|deb|AppImage|zip))$/;
const AUTOUPDATE_RE = /-mac\.zip$/; // macOS 自动更新 zip（electron-updater，Range 分片虚增，不计手动下载）
const UPDATER_RE = /electron/i; // electron-updater 的 UA（实测为 electron-builder）——任何平台都不算手动下载
  const KNOWN_DL_RE = /^mingdao-tcm-(?:setup-)?\d/; // 只认自家安装包名：挡掉 SPA 兜底对不存在文件回的 200
// 文件名族归一化（历史版本累计）：mingdao-setup-0.1.62-x64.exe → mingdao-setup-x64.exe。
  // 文件族归一化（历史版本累计）：mingdao-tcm-setup-0.1.27-x64.exe → mingdao-tcm-setup-x64.exe
  // （上游是"前缀+后缀"两段拼；本项目版本号位置不固定，直接抹掉版本段更稳）
  function familyOf(name) {
    return String(name || '').replace(/-\d+\.\d+\.\d+/g, '');
  }

const SECTIONS = ['home', 'help', 'forum'];
// 页面归属：首页 / 使用指南 / API 文档 / 社区论坛（论坛 API 不算页面）。非页面返回 null。
function pageOf(method, reqPath) {
  if (method !== 'GET') return null;
  if (reqPath === '/' || reqPath === '/index.html') return 'home';
    if (reqPath === '/help.html') return 'help';

    if (reqPath === '/forum/' || reqPath === '/forum') return 'forum';
  return null;
}

function dayKey(timeLocal) {
  const m = /^(\d{1,2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})/.exec(timeLocal);
  if (!m) return null;
  const [, d, mon, y] = m;
  const mm = MONTHS[mon];
  if (!mm) return null;
  return `${y}-${mm}-${d.padStart(2, '0')}`;
}

function readLogs() {
  const chunks = [];
  const candidates = [
    { f: LOG, cmd: ['cat', LOG] },
    { f: LOG + '.1', cmd: ['cat', LOG + '.1'] },
    { f: LOG + '.1.gz', cmd: ['zcat', LOG + '.1.gz'] },
    { f: LOG + '.2', cmd: ['cat', LOG + '.2'] },
    { f: LOG + '.2.gz', cmd: ['zcat', LOG + '.2.gz'] },
  ];
  for (const c of candidates) {
    try {
      chunks.push(execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', c.cmd.join(' ') + ' 2>/dev/null'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8'));
    } catch {}
  }
  return chunks.join('\n');
}

function readBeaconDays() {
  const out = {};
  try {
    for (const l of fs.readFileSync(BEACON_FILE, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const b = JSON.parse(l);
        const dk = new Date(Number(b.at)).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        out[dk] = (out[dk] || 0) + 1;
      } catch {}
    }
  } catch {}
  return out;
}

function emptyPages() {
    return { home: 0, help: 0, forum: 0 };
}

// 旧状态迁移（2026-08-31 前）：{pv, ips:{ip:true}, dl} → {pages:{...}, ips:{ip:hits}, dl}
function normalizeDay(d) {
  if (d && d.pages) {
    const p = emptyPages();
    for (const k of SECTIONS) p[k] = d.pages[k] || 0;
    return { pages: p, ips: d.ips || {}, dl: d.dl || {}, updates: d.updates || 0 };
  }
  const ips = {};
  for (const [ip, v] of Object.entries((d && d.ips) || {})) ips[ip] = typeof v === 'number' ? v : 1;
  return { pages: { ...emptyPages(), home: (d && d.pv) || 0 }, ips, dl: (d && d.dl) || {}, updates: (d && d.updates) || 0 };
}

// 防轮询（只扣超出、不整 IP 清零）：单 IP 单日页面请求超 PV_IP_CAP 的部分按栏目从后往前扣减。
// day.ipsRaw = { ip: { home:n, guide:n, api:n, forum:n } } 按栏目分；day.ips[ip] = 该 IP 当日总页面请求。
function capPollers(day) {
  for (const [ip, by] of Object.entries(day.ipsRaw || {})) {
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    if (total <= PV_IP_CAP) continue;
    let left = total - PV_IP_CAP;
    for (const k of SECTIONS) {
      const cut = Math.min(by[k] || 0, left);
      by[k] -= cut;
      left -= cut;
      if (left <= 0) break;
    }
  }
  for (const [ip, by] of Object.entries(day.ipsRaw || {})) day.ips[ip] = Object.values(by).reduce((a, b) => a + b, 0);
  for (const k of SECTIONS) day.pages[k] = Object.values(day.ipsRaw || {}).reduce((sum, by) => sum + (by[k] || 0), 0);
}

function main() {
  let state = { days: {} };
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}

  const days = {};
  for (const [dk, d] of Object.entries(state.days || {})) days[dk] = normalizeDay(d);
  const uvAll = state.uvAll || {};

  const raw = readLogs();
  let parsed = 0;
  const parsedDays = {};
  for (const line of raw.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, ip, timeLocal, method, reqPath, status, , , ua] = m;
    const dk = dayKey(timeLocal);
    if (!dk) continue;
    const day = (parsedDays[dk] ||= { pages: emptyPages(), ipsRaw: {}, ips: {}, dl: {}, dlSeen: new Set() });
    const isBot = BOT_RE.test(ua || '');
    const page = !isBot && (status === '200' || status === '304') ? pageOf(method, reqPath) : null;
    if (page) {
      day.pages[page] += 1;
      day.ipsRaw[ip] ||= emptyPages();
      day.ipsRaw[ip][page] += 1;
    }
    const dl = DL_RE.exec(reqPath || '');
    // 手动下载（口径见文件头 2）：排除更新器与爬虫脚本、排除 mac 自动更新 zip，
    // 并按「IP × 文件族 × 北京日」去重 —— 一次下载会有多个 Range 请求，按请求计会虚增。
    if (
      dl &&
      method === 'GET' &&
      (status === '200' || status === '206') &&
      !AUTOUPDATE_RE.test(dl[1]) &&
      !UPDATER_RE.test(ua || '') &&
      !BOT_RE.test(ua || '') &&
      KNOWN_DL_RE.test(dl[1])
    ) {
      const dlFam = familyOf(dl[1]);
      const seenKey = ip + '|' + dlFam;
      if (!day.dlSeen.has(seenKey)) {
        day.dlSeen.add(seenKey);
        day.dl[dlFam] = (day.dl[dlFam] || 0) + 1;
      }
    }
    parsed += 1;
  }
  for (const [dk, d] of Object.entries(parsedDays)) {
    capPollers(d);
    delete d.ipsRaw;
    delete d.dlSeen; // 去重用的临时集合不进状态文件
    days[dk] = d;
  }

  const beaconDays = readBeaconDays();
  for (const [dk, n] of Object.entries(beaconDays)) {
    if (!days[dk]) days[dk] = { pages: emptyPages(), ips: {}, dl: {}, updates: 0 };
    days[dk].updates = n;
  }

  // 剪枝：IP 集合只保留近 7 天（今日 UV 用），pv/dl/updates 永久保留。
  const keys = Object.keys(days).sort();
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  for (const d of Object.values(days)) {
    for (const ip of Object.keys(d.ips || {})) uvAll[ip] = true;
  }
  for (const k of keys) if (k < cutoff) delete days[k].ips;

  fs.writeFileSync(STATE_FILE, JSON.stringify({ days, uvAll }, null, 2));

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const downloads = {};
  const pageTotals = emptyPages();
  const pageToday = emptyPages();
  let pvTotal = 0;
  let pvToday = 0;
  let updTotal = 0;
  let updToday = 0;
  for (const [k, d] of Object.entries(days)) {
    for (const sec of SECTIONS) {
      const n = d.pages?.[sec] || 0;
      pageTotals[sec] += n;
      pvTotal += n;
      if (k === today) {
        pageToday[sec] = n;
        pvToday += n;
      }
    }
    updTotal += d.updates || 0;
    if (k === today) updToday = d.updates || 0;
    for (const [f, n] of Object.entries(d.dl || {})) {
      const fam = familyOf(f);
      downloads[fam] ||= { total: 0, today: 0 };
      downloads[fam].total += n;
      if (k === today) downloads[fam].today = n;
    }
  }
  const out = {
    generatedAt: new Date().toISOString(),
    pvTotal,
    pvToday,
    uvToday: Object.keys(days[today]?.ips || {}).length,
    uv: { total: Object.keys(uvAll).length, today: Object.keys(days[today]?.ips || {}).length },
    pages: {
      home: { total: pageTotals.home, today: pageToday.home },
        help: { total: pageTotals.help, today: pageToday.help },

      forum: { total: pageTotals.forum, today: pageToday.forum },
    },
    downloads,
    updates: { total: updTotal, today: updToday },
  };
  const tmp = OUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, OUT_FILE);
  console.log(`[tcm-stats] 首页${pageToday.home}/${pageTotals.home} 帮助${pageToday.help}/${pageTotals.help} 论坛${pageToday.forum}/${pageTotals.forum}（今日${pvToday}/累计${pvTotal}，UV ${out.uvToday}/${out.uv.total}）· 更新 ${updToday}/${updTotal} · 下载 ${Object.keys(downloads).length} 族 · 解析 ${parsed} 行`);
}

main();
