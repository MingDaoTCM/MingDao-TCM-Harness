// 运行时冒烟门禁的**运行器**：起一个临时 MINGDAO_HOME 的本地服务 → 用 Electron 加载 → 汇总结果。
//
// 为什么要这么绕（而不是纯 node 测试）：这个门禁要验的恰恰是**浏览器里会发生什么** ——
// 按钮有没有绑上、初始化有没有抛错。纯 node 测不出来（实测三次事故全是这类）。
//
// 跳过条件（都会明确打印原因，不静默通过）：
//   · 没有 Electron 可执行文件
//   · 没有图形显示（DISPLAY 为空 / 无 X）—— CI 里默认跳过，本机发版前会跑
//
// 用法：node tools/tcm-ui/test/runtime-smoke.mjs
// 退出码：0 通过 / 1 失败 / 2 跳过
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'tools', 'tcm-ui', 'desktop', 'node_modules', 'electron', 'dist', 'electron');
const ELECTRON_JS = path.join(HERE, 'runtime-smoke-electron.cjs');
const SERVER = path.join(ROOT, 'tools', 'tcm-ui', 'server.mjs');
const PORT = 18499;

function skip(why) {
  console.log(`跳过：${why}`);
  process.exit(2);
}

if (!fs.existsSync(ELECTRON)) skip('没有 Electron 可执行文件（' + ELECTRON + '）—— 在装过桌面版依赖的环境里跑');
if (process.platform === 'linux' && !process.env.DISPLAY) skip('无 DISPLAY（CI 环境默认跳过；本机发版前会跑）');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-smoke-'));
const env = { ...process.env, MINGDAO_HOME: home, MINGDAO_UI_PORT: String(PORT) };

const srv = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });

const cleanup = () => { try { srv.kill('SIGKILL'); } catch { /* 忽略 */ } try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ } };

// 等服务起来（最多 8 秒）
let up = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 200));
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    if (res.ok) { up = true; break; }
  } catch { /* 还没起来 */ }
}
if (!up) { cleanup(); console.log('失败：本地服务没起来\n' + srvErr.slice(0, 400)); process.exit(1); }

const child = spawn(ELECTRON, [ELECTRON_JS, '--no-sandbox'], {
  env: { ...env, SMOKE_URL: `http://127.0.0.1:${PORT}/?t=${Date.now()}`, DISPLAY: process.env.DISPLAY },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += String(d); });
child.stderr.on('data', (d) => { out += String(d); });

const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } }, 90_000);
await new Promise((r) => child.on('exit', r));
clearTimeout(timer);
cleanup();

const line = out.split('\n').find((l) => l.startsWith('SMOKE_OK') || l.startsWith('SMOKE_FAIL'));
if (!line) {
  console.log('失败：Electron 没有给出结论（可能崩溃）\n' + out.slice(-600));
  process.exit(1);
}
if (line.startsWith('SMOKE_FAIL')) {
  console.log('失败：' + line.slice('SMOKE_FAIL:'.length).trim());
  process.exit(1);
}
console.log('结果：通过 1，失败 0（运行时冒烟 ' + line.slice('SMOKE_OK'.length).trim() + '）');
process.exit(0);
