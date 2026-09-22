# 明道中医 · 问诊台 桌面版

一次安装、双击可用、不需要终端 —— 把「内核 + 问诊台」打成一个桌面应用。

## 与内核桌面版的关系

内核自带一个桌面版（`MingDao-Harness/desktop/`），打开的是**内核 WebUI**。
本目录是**同一品牌、同一做法的另一个壳**，打开的是**本项目的问诊台**
（带患者名册 / 随访提醒的那个独立前端）。

```
Electron 主进程
 ├─ 内核 WebUI（同进程，随机端口 + 随机 token）   ← 问诊/工具/计费/审计
 └─ 问诊台薄代理（同进程，随机端口）              ← 前端 + /api/tcm/* 只读端点
        ▲
     BrowserWindow 指向代理地址
```

token 由主进程生成、**只在进程内**交给代理：浏览器永远拿不到它。

## 分层（为什么逻辑不写在 main.js 里）

| 文件 | 职责 | 能不能在这里自动测 |
|---|---|---|
| `orchestrator.mjs` | 纯 Node：解析路径、起内核、起代理、返回地址与 `close()` | ✅ 端到端测得到 |
| `main.js` | Electron 外壳：窗口 / 托盘 / 单实例 / 退出清理 | ❌ 需要图形环境 |

这样拆是因为 **Electron 必须在有 X server 的机器上才能启动**，而开发机与 CI 往往没有
（本仓库的开发机就没有：连内核自带的桌面冒烟都会 SIGSEGV）。把真正的逻辑放进纯 Node，
就能在没有图形环境的地方把它验完，`main.js` 只剩「照抄内核 `desktop/` 的成熟写法」。

## 怎么跑（需要图形环境）

```bash
cd tools/tcm-ui/desktop
npm install                                          # 装 electron（国内走镜像）
npm start                                            # 开发态：自动找工作区同级的 MingDao-Harness
MINGDAO_KERNEL=/path/to/MingDao-Harness npm start    # 指定内核
MINGDAO_HOME=~/.mingdao-dify-test npm start          # 指定患者数据目录
MINGDAO_TCM_DESKTOP_SMOKE=1 npm start                # 无窗口自检（起来就退）
```

## 怎么出安装包

```bash
cd tools/tcm-ui/desktop
npm install
npm run dist:linux     # AppImage + deb
npm run dist:win       # NSIS
npm run dist:mac       # dmg
```

打包会把两样东西带进安装包（见 [`electron-builder.yml`](electron-builder.yml)）：

- **内核** → `resources/kernel/src`（零运行时依赖，直接拷；默认取工作区同级的 `MingDao-Harness`）；
- **问诊台 + 垂域 Pack** → `resources/app/{tools/tcm-ui, layer/packs/tcm}`，
  **保持仓库内的相对布局** —— 因为 `tcm-data.mjs` 里有一句 `../../layer/packs/tcm/pack.mjs`。

> 校验这套布局的断言在 [`../test/desktop-orchestrator.test.mjs`](../test/desktop-orchestrator.test.mjs)
> 的 `[3]` 段：打包配置必须同时带 `to: app` 与 `to: kernel`。

## 诚实边界（重要）

本目录的 **Electron 层没有在本开发机验证过** —— 这台机器没有 X server，Electron 连平台初始化
都过不去。已经验证的是：

- **编排层端到端**（`test/desktop-orchestrator.test.mjs`）：真起内核 + 真起代理、
  `/api/tcm/*` 与经代理转发到内核的 `/api/state` 都通、`close()` 能干净关掉、不留进程；
- **壳的静态完整性**：文件齐全、`package.json` 合法（`main`/`type`/依赖）、
  `main.js` 引用的 orchestrator 导出都存在、`main.js` 不自己起服务、打包配置带上了内核与前端。

**没验证的**：窗口渲染、托盘、外链处理、以及三个平台的安装包本身。
请在有桌面的机器上跑一次 `npm start`（或 `MINGDAO_TCM_DESKTOP_SMOKE=1 npm start`）确认。
