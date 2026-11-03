// 问诊台「运行时冒烟」检查 —— 在真实 Electron 里加载页面、点按钮、抓 console 错误。
//
// 为什么不用静态分析：2026-11 试过（no-undefined-calls.test.mjs），正则做不了作用域分析，
// 假阳性反复收不干净 ✗。而**运行时**检查能直接看到真实后果：
//   实测三次事故（站点下载区崩 / 舌象四按钮失效 / 删块多删花括号）**全部**在运行时暴露 ✓。
//
// 这个文件由 runtime-smoke.mjs 用 Electron 启动，输出一行 SMOKE_OK / SMOKE_FAIL: …
// 由外层脚本决定退出码（Electron 自己退出码不可靠）。
const { app, BrowserWindow } = require('electron');

const URL = process.env.SMOKE_URL;
if (!URL) {
  console.log('SMOKE_FAIL: 缺少 SMOKE_URL');
  app.quit();
}

app.whenReady().then(async () => {
  const errors = [];
  const warns = [];
  const win = new BrowserWindow({ width: 1360, height: 950, show: false });
  win.webContents.on('console-message', (_e, lvl, msg) => {
    const s = String(msg);
    if (/Security Warning|user activation|DevTools|Autofill/.test(s)) return; // 与功能无关
    if (lvl >= 3) errors.push(s.slice(0, 200));       // error
    else if (lvl === 2) warns.push(s.slice(0, 200));  // warning
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('renderer 崩溃: ' + JSON.stringify(d)));

  const fail = (why) => { console.log('SMOKE_FAIL: ' + why); app.quit(); };
  const ok = (info) => { console.log('SMOKE_OK ' + JSON.stringify(info)); app.quit(); };

  try {
    await win.loadURL(URL);
  } catch (e) {
    return fail('页面加载失败：' + String(e && e.message || e));
  }
  await new Promise((r) => setTimeout(r, 3000));   // 等脚本初始化（含各 initXxx）

  if (errors.length) return fail('加载阶段有 console.error：' + errors.slice(0, 3).join(' | '));

  // 关键按钮必须都绑上了处理器（onclick 口径；实测舌象四按钮失效时这里全是 null ✗）
  const bound = await win.webContents.executeJavaScript(`(() => {
    const ids = ['tongueShot','tonguePick','tongueRetake','tongueRemove','directSend','compose','clearForm','patSwap','patNew','fsToggle'];
    const out = {};
    for (const id of ids) { const el = document.getElementById(id); out[id] = !!(el && el.onclick); }
    return JSON.stringify(out);
  })()`);
  const unbound = Object.entries(JSON.parse(bound)).filter(([, v]) => !v).map(([k]) => k);
  if (unbound.length) return fail('这些按钮没有绑定处理器（点了会没反应）：' + unbound.join(', '));

  // 依次点击关键交互，任何一步引发 console.error 都算失败
  const steps = [
    ['舌象-摄像头', "document.getElementById('tongueShot').click()"],
    ['舌象-选图', "document.getElementById('tonguePick').click()"],
    ['脉象 chip 弦', "document.querySelector('#pulseChips .chip[data-v=\"弦\"]').click()"],
    ['舌质下拉', "(() => { const s=document.getElementById('sheZhi'); s.value='淡红'; s.dispatchEvent(new Event('change',{bubbles:true})); })()"],
    ['舌象合成', "(() => { const v=document.getElementById('f_shexiang').value; if(!v.includes('舌质')) throw new Error('舌象未合成：'+v); })()"],
    ['字号切换', "document.getElementById('fsToggle').click()"],
    ['切到患者页', "document.querySelector('.tab[data-view=\"patients\"]').click()"],
    ['切回问诊页', "document.querySelector('.tab[data-view=\"consult\"]').click()"],
    ['合成到输入框', "document.getElementById('compose').click()"],
    ['清空表单', "document.getElementById('clearForm').click()"],
  ];
  for (const [name, js] of steps) {
    const before = errors.length;
    try {
      await win.webContents.executeJavaScript(js);
    } catch (e) {
      return fail(`点击「${name}」时抛错：` + String(e && e.message || e).slice(0, 200));
    }
    await new Promise((r) => setTimeout(r, 250));
    if (errors.length > before) return fail(`点击「${name}」后出现 console.error：` + errors.slice(before).join(' | '));
  }

  // 空态引导与吸底条是 UX 契约，也顺手校一下
  const ux = await win.webContents.executeJavaScript(`(() => {
    const sh = document.getElementById('startHere');
    const act = document.getElementById('actbar');
    return JSON.stringify({
      空态存在: !!sh,
      吸底条存在: !!act,
      吸底条高度: act ? Math.round(act.getBoundingClientRect().height) : 0,
    });
  })()`);
  const u = JSON.parse(ux);
  if (!u.空态存在) return fail('空态引导（#startHere）不存在');
  if (!u.吸底条存在) return fail('吸底操作条（#actbar）不存在');
  if (u.吸底条高度 > 120) return fail('吸底条过高（' + u.吸底条高度 + 'px，应 ≤120px，否则太占地方）');

  ok({ 点了: steps.length, 警告数: warns.length, 吸底条高度: u.吸底条高度 });
});
