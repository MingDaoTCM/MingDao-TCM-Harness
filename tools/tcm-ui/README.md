# 得一中医 · 问诊台（独立前端 + 薄代理）

**样品**：证明"自建 UI + 内核零改动"这条路走得通。

## 它是什么

```
内核 MingDao-Harness（原样跑，git pull 跟上游）
   └─ http://127.0.0.1:3821   headless 后端：GET /api/* 、POST /api/chat（SSE）
        ▲ 薄代理（本目录 server.mjs，零依赖）
   └─ http://127.0.0.1:3830   本项目的问诊界面
```

**内核一行都没改。** 前端消费的是内核自己文档化的那套契约
（`src/web/server.js` 头部写着路由与 SSE 事件表）：

```
GET  /api/state  /api/sessions  /api/session?file=  /api/skills
POST /api/chat        {message, file?, preset?, attachments?} → SSE
POST /api/permission  {id, answer, taskId}
POST /api/abort
SSE：banner / text / reasoning / code / tool / toolDenied / todo / usage / ask / error / done
```

好处：内核升级只需要重新确认那套 SSE 契约，不必合并 100+ 提交。

## 怎么跑（一键脚本）

```bash
bash tools/tcm-ui/tcm-ui.sh start      # 启动内核 + 界面（已在跑就跳过）
bash tools/tcm-ui/tcm-ui.sh status     # 看状态与地址
bash tools/tcm-ui/tcm-ui.sh stop       # 停止两者
bash tools/tcm-ui/tcm-ui.sh restart    # 重启
bash tools/tcm-ui/tcm-ui.sh logs       # 跟踪日志（Ctrl+C 退出）
```

首次运行会生成配置 `~/.deyi-tcm-ui.conf`（内核目录 / MINGDAO_HOME / 端口），可手工改：

```bash
MINGDAO_KERNEL="/path/to/MingDao-Harness"   # 自动发现时会**按 package.json 版本挑最新的**
MINGDAO_HOME="/home/you/.deyi-tcm"
KERNEL_PORT=3821
UI_PORT=3830
NODE_BIN=""     # 留空=每次启动自动挑一个 fetch 真的能用的 node；选中后会写回本文件
```

> ### ⚠ 为什么要挑 node，而不是直接用 PATH 里的
>
> 实测本机 `/usr/bin/node`（v20.15.1，dpkg 包 `nodejs`）的安装是**坏的**：起得来、
> `node --version` 正常、跑内核也没事，**但内置 `fetch()` 一调就抛**
> `[CompileError: WebAssembly.compile(): section ... extends past end of the module]`
> 并伴随一个 unhandled rejection 直接崩进程。
>
> 薄代理**全靠 fetch 转发**，于是症状是：**界面能打开、一拉数据就 502 / 进程消失**。
> 更迷惑的是 systemd 用户会话的 PATH 只有 `/usr/bin`，而交互 shell 里先命中的是
> `~/.local` 的 v24 —— 所以「我在终端里跑是好的」和「开机自启后打不开」会同时成立。
>
> 脚本因此做一次**真实的 fetch 冒烟测试**（拿一个必然关闭的端口试，判据是**退出码**，
> 不是 stdout —— 坏 node 会先把 reject 抛出来、照常打印成功，然后才崩）。
> 挑中的路径写回 `NODE_BIN`，之后固定使用。

> **为什么发现要按版本挑**：机器上常同时存在旧克隆与新快照（实测：`MingDao-Harness`
> 是 v0.4.5，`MingDao-Harness-v0.6.3` 才是当前上游）。按目录名的字典序会挑错。
>
> 日志与 pid 落在 `~/.deyi-tcm-ui/`。

## 开机自启

```bash
bash tools/tcm-ui/install-autostart.sh            # 安装（优先 systemd --user）
bash tools/tcm-ui/install-autostart.sh --status   # 看当前用哪种方式
bash tools/tcm-ui/install-autostart.sh --uninstall
```

优先装成 **systemd 用户服务**（崩溃可查、`systemctl --user status` 可看）；
没有 systemd --user 的环境回落到 XDG autostart（登录时拉起一次，不自动重启）。

```bash
systemctl --user status  deyi-tcm-ui.service
systemctl --user restart deyi-tcm-ui.service
systemctl --user disable --now deyi-tcm-ui.service   # 关掉自启
```

> 两点须知：
> 1. systemd --user 默认在**登录后**运行；想让它无人登录也常驻，需要一次性
>    `sudo loginctl enable-linger $USER`。
> 2. 服务启动的是**本机回环**地址（内核 127.0.0.1:3821、界面 127.0.0.1:3830），
>    不对外网开放。界面里的访问令牌只在代理内部加，浏览器拿不到。

<details>
<summary>手动跑（不用脚本时）</summary>

```bash
# 内核（MingDao-Harness 检出目录下）
MINGDAO_HOME=~/.deyi-tcm node src/cli.js web 3821
# 薄代理（本仓库目录下）—— --home 指同一个 MINGDAO_HOME，否则「患者」页读不到数据
node tools/tcm-ui/server.mjs --target http://127.0.0.1:3821 --port 3830 --home ~/.deyi-tcm
```

</details>

## 界面上有什么

- **患者资料**：姓名 / 出生年 / 性别 / **就诊类型（自动判断 / 首诊 / 复诊）**
  —— 病历号由 `patient_register` 自动分配，界面刻意不让医师填，避免与库里已有号冲突
- **必填**：主诉、现病史
- **可选**：既往史 · 家族史 · 过敏史 · 流行病史、体格检查、四诊（舌象 / **舌象照片** / 脉象）、随访
- **「合成问诊消息」**：把表单拼成一段自然语言填进输入框，**医师可再编辑**再发送 ——
  刻意不替医师做任何判断，只做"结构化 → 人话"的搬运
- **每轮回复分两区（固定上下，与事件到达顺序无关）**：
  - **上：工具执行区** —— `pack__tcm__*` 的调用卡片（中文名 + 原始名 + ✓/✖ + 耗时 + 结果）
  - **下：问诊工作流正文** —— Markdown 渲染：标题 / 加粗 / 真列表 / 引用 / 分隔线 / 代码 /
    **表格**（表格是内核渲染器没有的，本项目为中医四诊表格另加）
  - **思考过程**（在正文之上）—— Dify 工作流的 `<think>…</think>` 推理**保留可看**，
    但与正文分流：字体更小（12px vs 13px）更淡（`--faint` vs 正文 `--fg`）、虚线框、
    正文一开始就自动收拢成一行「模型思考过程 · N 字」（点标题可再展开）。
    **标签本身不显示**：分流在 provider 侧完成（`reasoning` 通道），不靠前端遮掩。
- **首字等待提示** —— 正文首字到达前，正文区显示「⟳ 正在思考中… · 阶段 · 计时」，
  首字一到即撤下。计时器由前端自走（Dify 工作流冷启动常见 10~60s 无任何事件）；
  阶段语义来自内核每 5s 的 `progress` 心跳（模型推理中 / 执行工具中 / 等待权限确认），
  20s 内没有心跳时本地兜底显示「工作流运行中（较慢）」。
  流式期间正文末尾有光标块，结束后消失。
- **离线预览排版**：打开 `http://127.0.0.1:3830/?demo=1` —— 不调用 Dify、不发请求、不写数据，
  用**真实的**等待提示条 / Markdown 渲染器 / 工具卡片跑一遍（含表格），用于快速验收排版。
- 页面禁用浏览器缓存（`Cache-Control: no-store`），改动后普通刷新即可看到最新版。

### 「患者」页：名册 + 历次病历（2026-09-16 新增）

顶部 tab 切到「患者」：

- **左 · 名册** —— 全部患者，**超期未复诊优先**，其次最近就诊在前；每行给出
  病历号 / 出生年 / 性别 / 就诊次数 / 末次距今，超期的带醒目标记；
- **右 · 历次病历** —— 时间线（**最早 → 最新**），每次就诊一张卡片，列出全部字段
  （未填显示「—」），并标出**与上次相比哪几项变了、从什么变成什么**；
- **「发起复诊 →」** —— 生成一段复诊草稿填进问诊输入框（**医师可再编辑**再发送）。

> 这里给的是**确定性的事实**（哪个字段从什么变成什么），**不含任何疗效判断** ——
> 「四态对比」（消失/减轻/无变化/加重）是模型判定的产物，仍走 `visit_compare` 工具。

### 数据从哪来（为什么代理要自己读）

内核是**通用**的，不认识「患者」这种领域概念 —— 患者名册与历史是 Line B 的领域数据
（`MINGDAO_HOME/patients.json` 与 `intake/**`），内核没有对应 API。
代理与内核跑在同一台机器、同一个 `MINGDAO_HOME` 上，于是由代理提供**只读**端点
（`GET /api/tcm/patients`、`GET /api/tcm/patients/<病历号>`）。

⚠ 但代理**不重新定义**任何字段名、标签或读语义 —— 全部 `import` 自垂域 Pack
（`FIELD_CN` / `ALL_FIELDS` / `listSnapshotFiles` / `loadRegistryFrom` …）。
理由与 2026-09-16 的复诊修复同源：**同一份契约定义在两处必然漂移**。
连「复诊草稿」都是服务端生成好、前端只负责填进输入框（前端**零字段知识**，有测试守着）。

## 已知限制（诚实记录）

1. ~~只读意图的指令触发不了 Pack 工具~~ —— **上游 v0.6.3 已修**（只读档判定方向反过来，
   且「域内 Pack 在场时不进只读档」）。实测：只说「回访」现在就会调用 `followup_board` ✓
2. **舌象照片** —— 上游 v0.6.3 修好了门控：自定义 Provider 现在可以
   `export const supportsVision = true` 声明视觉（本项目的 `dify.mjs` 已声明）。
   链路是：内核把图片发成多模态消息 → `dify.mjs` 上传到 Dify（`/v1/files/upload`）
   → 随 query 一起提交。**前提是 Dify 应用侧也开了视觉**。
   照片传不上去不会挡住问诊（正文照常，只是这次没有图片）。
3. **不是桌面版** —— 这里只交"独立前端 + 薄代理"这一层。打包成 Electron 桌面应用
   （自带内核、一次安装、摄像头权限、自动更新）是下一层，照抄内核 `desktop/` 的
   `main.js` + `electron-builder.yml` 即可。

## 测试

```bash
node tools/tcm-ui/test/tcm-data.test.mjs    # 数据层：名册排序 / 时间线方向 / 逐项变化 / fail-loud（11 项）
node tools/tcm-ui/test/ui-wiring.test.mjs   # 接线：静态资源 / DOM id / 模块导出 / 前端零字段知识（7 项）
```

**没有无头浏览器可用**，所以「页面真的能跑」仍需人工验收（打开 `?demo=1` 看排版）。
能自动化的那部分已经变成断言：少一个 id、import 了不存在的导出、`public/` 漏文件、
前端写死字段名 —— 这些在浏览器里表现为「白屏 / 点了没反应」，在这里会当场变红。

## 文件

| 文件 | 说明 |
|---|---|
| `tcm-ui.sh` | 一键启停（start/stop/restart/status/logs）；幂等，端口健康检查，按版本发现内核 |
| `install-autostart.sh` | 开机自启安装/卸载/查状态（systemd --user 优先，XDG autostart 兜底） |
| `server.mjs` | 薄代理 + 静态服务（零依赖，`node:http`）：转发 `/api/*` 给内核（SSE 不缓冲）+ 自有只读端点 `/api/tcm/*` |
| `tcm-data.mjs` | 名册/历史的数据层；**不自己定义字段**，全部 import 自垂域 Pack |
| `public/index.html` | 外壳：视图容器 + 问诊表单 HTML（无构建步骤） |
| `public/app.css` | 全部样式（含问诊 / 患者两套） |
| `public/js/util.js` | `$` / HTML 转义 / Markdown 轻渲染（镜像内核 `src/web/util.js`，另支持表格）/ `<think>` 兜底过滤 |
| `public/js/api.js` | HTTP 薄封装：`getJSON` / `postJSON` / `streamSSE` |
| `public/js/consult.js` | 问诊视图：表单合成 + 对话（工具卡片 / 正文 / 思考过程）+ `?demo=1` 离线预览 |
| `public/js/patients.js` | 患者视图：名册 + 时间线 + 逐项变化（**零字段知识**） |
| `public/js/app.js` | 启动、视图切换、内核连接状态 |
| `test/tcm-data.test.mjs` | 数据层单测 |
| `test/ui-wiring.test.mjs` | 前端接线测试 |

> 「问诊台」原先是一个 640 行的单文件 `index.html`（HTML + CSS + JS 全在一起）。
> 2026-09-16 拆成上表的多文件（浏览器原生 ES module，**仍然没有构建步骤**）——
> 目的是加「患者」页时不至于把单文件撑成难以维护的一坨。
