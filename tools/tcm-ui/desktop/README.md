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

## 用 GitHub Actions 出包（推荐，与上游同一条路）

**打 tag 即出三平台安装包 + 自动建 GitHub Release**：

```bash
git tag -a v0.1.0 -m "明道中医 · 问诊台 桌面版 v0.1.0" && git push github v0.1.0
```

- `Desktop` 工作流（[`.github/workflows/desktop.yml`](../../../.github/workflows/desktop.yml)）跑 4 条腿：
  `linux-x64`（AppImage+deb）、`win-x64`（NSIS）、`mac-x64`、`mac-arm64`；
- **只上传工件、不发版**的干跑：Actions → Desktop → Run workflow（`workflow_dispatch`）；
- 发版只认 tag（`publish` 作业有 `if: startsWith(github.ref, 'refs/tags/')`），干跑绝不会误建 Release。

### macOS 签名 / 公证（需要你在仓库里配 Secrets）

上游用的是这 5 个（**本仓库目前一个都没配，所以现在的产物是未签名的**）：

| Secret | 用途 |
|---|---|
| `CSC_LINK` | Developer ID Application 证书（.p12 的 base64） |
| `CSC_KEY_PASSWORD` | 上面那张证书的密码 |
| `APPLE_ID` | Apple 开发者账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 该账号的 app-specific 密码 |
| `APPLE_TEAM_ID` | 团队 ID（已在 `electron-builder.yml` 的 `notarize.teamId` 里写死同一个） |

从上游 `MingDao-Harness` 的 Settings → Secrets and variables → Actions 里逐个复制到本仓库即可
（**GitHub 不导出密钥值，只能人工搬**）。配好后**重跑一次**（Actions 里 Re-run，或打个新 tag），
签名与公证会自动生效 —— 未配置时 `electron-builder` 自动回退未签名产物，不会失败。

> Windows 若要 Authenticode 签名，上游走 Azure Trusted Signing（`AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/
> `AZURE_CLIENT_SECRET`），`electron-builder.yml` 里那段已注释好，按注释取消注释即可。

## 诚实边界（重要）

**Electron 的窗口部分没有在开发机验证过** —— 这台机器没有 X server，Electron 连平台初始化都过不去。
但**打包产物本身已在 CI 里被真正启动过**（`ubuntu-latest` + `xvfb-run`，见工作流的「打包冒烟」一步）：
日志里能看到内核起服务、以及 `MINGDAO_TCM_DESKTOP_SMOKE_OK`。

已验证的：

- **编排层端到端**（[`../test/desktop-orchestrator.test.mjs`](../test/desktop-orchestrator.test.mjs)）：
  真起内核 + 真起代理、`/api/tcm/*` 与经代理转发的 `/api/state` 都通、`close()` 干净关掉不留进程；
- **壳的静态完整性**：文件齐全、`package.json` 合法、`main.js` 引用的 orchestrator 导出都存在、
  `main.js` 不自己起服务、打包配置确实带上了内核与前端；
- **打包产物能启动**（CI，xvfb）：Electron 主进程真的跑起来了，内置内核与问诊台都起来了；
- **打包布局正确**：CI 产出的 `.deb` 里能查到 `opt/<产品名>/resources/{kernel/src, app/tools/tcm-ui, app/layer/packs/tcm}`。

**仍未验证的**：窗口渲染、托盘、外链处理（冒烟在开窗口之前就退出了，CI 里也没有真显示器）。
请在有桌面的机器上 `npm start` 或装上安装包双击一次确认。
