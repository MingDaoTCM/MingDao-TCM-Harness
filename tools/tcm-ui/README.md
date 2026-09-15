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

## 怎么跑

```bash
# 1) 先按仓库根 install.sh 把 tcm 层装进一个 MINGDAO_HOME
MINGDAO_HOME=~/.deyi-tcm bash install.sh

# 2) 起内核（在 MingDao-Harness 检出目录下；端口随便挑一个空的）
MINGDAO_HOME=~/.deyi-tcm node src/cli.js web 3821

# 3) 起本代理（默认连 3821，界面在 3830）
node tools/tcm-ui/server.mjs
#   自定义： --target http://127.0.0.1:3820 --port 3831
#   内核若配了访问令牌： MINGDAO_UI_TOKEN=xxx node tools/tcm-ui/server.mjs
```

然后浏览器打开 **http://127.0.0.1:3830**。

> 代理只监听 `127.0.0.1`，`/api/*` **不缓冲地透传**（SSE 必须逐块到达，否则流式问诊会变成
> "等全部生成完再一次性显示"）。访问令牌只在代理内部加，浏览器永远拿不到它。

## 界面上有什么

- **患者**：姓名 / 出生年 / 性别 / 病历号
- **十问（必填）**：主诉、诊断、寒热、汗、头身、二便、饮食、胸腹、口渴、旧病
- **四诊补充（可选）**：舌象、**舌象照片（拍照或选图）**、脉象
- **「合成问诊消息」**：把表单拼成一段自然语言填进输入框，**医师可再编辑**再发送 ——
  刻意不替医师做任何判断，只做"结构化 → 人话"的搬运
- **右侧对话**：渲染 SSE 的正文、工具卡片（`pack__tcm__*` 的调用与结果）、权限询问、报错

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
| `server.mjs` | 薄代理 + 静态服务（零依赖，`node:http`）；含目录穿越防护、SSE 不缓冲透传 |
| `public/index.html` | 问诊界面（单文件，无构建步骤） |
