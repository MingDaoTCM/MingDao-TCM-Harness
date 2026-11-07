# 分发链路（抄自 DISTRIBUTION-PLAYBOOK.md）

架构（手册 §2）：**构建 → OSS（单一集散地）→ 各地 302/直供 → 用户**。
本目录只放**服务器端配置**（不含任何密钥 ✓），便于审计与重建。

| 文件 | 作用 |
| --- | --- |
| `hk-source-tcm.conf` | 香港源站 `tcm.mingdao.ai`：安装包（deb/dmg/exe/AppImage）**302 到 OSS**；`latest*.yml` 与 mac 更新用的 `.zip` **保持本地**（不拿自动更新链路冒险）|
| `shenzhen-mirror-mingdaotcm.conf` | 深圳镜像 `mingdaotcm.southdns.com`：`/downloads/` **本地优先**（18MB/s），没有就 **302 到 OSS**；页面与 API 直通代理 |
| `../scripts/oss-sync.mjs` | 零依赖 OSS 客户端（V1 签名，put/get/head/ls）|

## 实测状态（2026-11-07）

| 组件 | 状态 |
| --- | --- |
| OSS 客户端 | ✅ put/head/get/ls 往返通过 |
| OSS 内容 | ✅ v0.1.39 的 7 个安装包 + 3 个 yml（从香港机走**内网端点**上传）|
| 深圳镜像 | ✅ `https://mingdaotcm.southdns.com/` 200；`/downloads/*.deb` → **302 → OSS → 206 真实字节** |
| 香港源站 302 | ✅ `/downloads/*.deb` → 302；`latest.yml` / `*.zip` 仍 200 本地 |
| CI 直传 OSS | ⏳ **未做**（需把 AK/SK 加进 GitHub Secrets）|
| 页面就近选择 | ⏳ **未做**（手册 §3.5）|

## 待办

1. **CI 直传 OSS**：把 `oss.env` 的 4 个值加进 GitHub Secrets，workflow 里加一步
   `node scripts/oss-sync.mjs put`。当前是**手工**从香港机灌 OSS（内网端点 18MB/s）。
2. **页面就近选择**：页面加载时实测 `tcm.mingdao.ai` 与 `mingdaotcm.southdns.com`
   两条链路，谁快用谁（手册 §3.5，不显示任何提示文字）。
3. **轮换 OSS AK/SK**：这对凭据曾出现在对话记录里。
