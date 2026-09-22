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
# 薄代理（本仓库目录下）
node tools/tcm-ui/server.mjs --target http://127.0.0.1:3821 --port 3830
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

## 文件

| 文件 | 说明 |
|---|---|
| `tcm-ui.sh` | 一键启停（start/stop/restart/status/logs）；幂等，端口健康检查，按版本发现内核 |
| `install-autostart.sh` | 开机自启安装/卸载/查状态（systemd --user 优先，XDG autostart 兜底） |
| `server.mjs` | 薄代理 + 静态服务（零依赖，`node:http`）；含目录穿越防护、SSE 不缓冲透传 |
| `public/index.html` | 问诊界面（单文件，无构建步骤）；Markdown 渲染镜像内核 `src/web/util.js`（另支持表格） |
