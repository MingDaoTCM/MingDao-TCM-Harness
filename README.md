# 明道中医 Harness（MingDao TCM Harness）

> 中医垂域智能体外层。**下游（Line B）**，依赖上游通用内核 **[MingDao-Harness](../MingDao-Harness)**（Line A）。

## 定位

不做通用 Harness，只做 **中医垂域层**——把 Dify 的临床知识能力，装进一个能**动态追问、能落盘病历、能硬约束、能追责、能回访**的智能体外壳里。

- **上游 Line A（MingDao-Harness）**：通用内核（agent 循环、工具系统、Provider 扩展点、审计/成本），开源。
- **下游 Line B（本仓库）**：中医垂域层，私有。**只通过 A 的扩展点接入，绝不修改 A 的代码。**

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  明道中医层（本仓库 · 装进 MINGDAO_HOME）                        │
│  · Dify 主问诊 Provider（providers/dify.mjs）                  │
│  · 病历号患者系统（patients.json + intake/<病历号>/）            │
│  · 工具一 问诊采集（多轮追问 + 缺项不编造 + 落盘）               │
│  · 工具二 复诊四态对比（消失/减轻/无变化/加重）                  │
│  · 工具三 回访追踪（看板 + 时间线 + 预警 + 话术草稿）            │
└──────────────────────────────────────────────────────────────┘
                              │ 载体
┌──────────────────────────────────────────────────────────────┐
│  上游内核 MingDao-Harness（Line A）                            │
│  agent 循环 · 工具系统 · Provider 扩展点 · 审计/成本/脱敏        │
└──────────────────────────────────────────────────────────────┘
                              │ HTTP
┌──────────────────────────────────────────────────────────────┐
│  Dify + RAG（2 亿字中医语料，一行不改）—— 问诊/辨证/知识检索      │
│  DeepSeek（原生模型）—— 结构化提取 / 四态对比 / 随访话术          │
└──────────────────────────────────────────────────────────────┘
```

## 核心设计

### 分工原则：Dify 管知识，Harness 管流程

| 能力 | 归属 | 说明 |
|---|---|---|
| 问诊对话 / 追问 / 辨证 / 知识检索 | **Dify** | 1.5 年临床验证的成熟工作流，一行不改 |
| 患者识别 / 病历落盘 / 四态对比 / 回访 | **本层（DeepSeek 关思考调用）** | 结构化、确定性、可审计 |
| 就诊次数 | **本层注入 Dify** | Dify 自己用 `dialogue_count` 猜会错位 |

### 患者标识：病历号 + 同名提示（医疗级）

- **主键 = 病历号**（`P001`、`P002`…，注册表 `patients.json` 自增分配）；
- **匹配**：姓名 + 出生年 + 性别收窄；报到病历号则精确命中；
- **同名多命中不静默合并**：返回候选列表请医师确认，避免混病历；
- **快照按患者隔离**：`intake/<病历号>/case-<时间戳>.json`。

### 安全红线

- **缺项绝不编造**：未采集到的必填项必须继续追问；
- **不输出诊疗结论**：只做采集与病历起草，四态对比只陈述事实；
- **患者数据本地化**：`patients.json` / `intake/` 不入库，备份走加密通道。

## 用法

```bash
# 1. 准备上游内核
git clone <MingDao-Harness 地址> && cd MingDao-Harness

# 2. 安装中医层到指定 MINGDAO_HOME
MINGDAO_HOME=~/.mingdao-tcm bash ../MingDao-TCM-Harness/install.sh

# 3. 填入密钥（Dify App API Key + DeepSeek Key）
#    方式见 install.sh 输出，或手工编辑 $MINGDAO_HOME/credentials.json

# 4. 启动
MINGDAO_HOME=~/.mingdao-tcm node src/cli.js web 3821
```

## 命令（WebUI / CLI 对话中输入）

| 命令 | 作用 |
|---|---|
| 直接描述患者病情（带姓名） | 首诊：十问追问 → 落盘病历（分配病历号） |
| `复诊：<病历号或姓名+出生年>，…` | 复诊：回顾上诊 → 四态对比 → 落盘 |
| `回访` | 回访看板：全部患者 + 超期未复诊预警 |
| `回访 P003` / `随访 曾慧慧` | 单患者：时间线趋势 + 异常预警 + 随访话术草稿 |

## 与上游的版本关系

- 本层当前对齐 **MingDao-Harness v0.6.7**（`engines.mingdao: ">=0.5 <0.7"`，兼容窗口已覆盖）；
- 已在 v0.6.7 内核下验证全部 8 档门禁：`pack verify`（静态）、`pack.test.mjs`（53 项）、
  `integration.test.mjs`（11 项）、`dify.test.mjs`（18 项）、`tcm-data`（14 项）、`ui-wiring`（7 项）、
  `desktop-orchestrator`（19 项）、`site`（22 项）**全部通过，无代码改动**；
  v0.6.7 中与扩展点相关的只有一处、且是**改进**：自定义 Provider 模块的 ESM 缓存键从
  `?v=Date.now()` 改为按 **mtime**（此前每次建 provider 都重新 import，长驻 WebUI 里模块实例无限累积）；
  另有权限面的 deny 绕过收口（`$(…)`/子 shell/`\r`/续行 当分隔符）——本层 Pack 不执行 shell，不受影响；
- 接入的扩展点：垂域 **Pack（Pack API v1：tools / constraints / promptSections）** + 自定义 **Provider（dify.mjs，含 `supportsVision`）**；
- 内核升级后如扩展点有变，本层适配后再跟版本；
- **内核 bug 在上游修，本层不重复造**。

> 桌面版（`tools/tcm-ui/desktop/`）只从 `$MINGDAO_HOME/{packs,providers}` 加载扩展，
> 所以它**必须**在首启时把打包进来的垂域层装进数据目录 —— 见 `orchestrator.installLayer`。
> 少了这一步，装出来的就是一个"裸内核"：没有 tcm 工具、没有 dify provider，
> 问诊正文由 DeepSeek 直连生成、**完全不碰 Dify 工作流**（2026-09-24 用户实测报回）。

## 远端仓库（三平台私有镜像）

| 远端 | 仓库 | 可见性 |
| --- | --- | --- |
| `github` | `github.com/MingDaoTCM/MingDao-TCM-Harness` | 私有 |
| `gitee` | `gitee.com/MingDaoTCM/MingDao-TCM-Harness` | 私有 |
| `gitcode` | `gitcode.com/MingDaoTCM/MingDao-TCM-Harness` | 私有 |

```bash
git push github main && git push gitee main && git push gitcode main
```

**两个已知坑（都已在配置里绕开）**

1. **GitHub 用独立 deploy key** —— 本账号的 `~/.ssh/mingdao_git` 是 `MingDao-Harness` 的单仓库
   deploy key，GitHub 不允许同一公钥复用到第二个仓库（`key is already in use`）。故为 Line B
   单配了 `~/.ssh/mingdao_tcm`，并经 `.ssh/config` 的 `Host github-tcm` 别名接入，
   远端写作 `git@github-tcm:MingDaoTCM/MingDao-TCM-Harness.git`。
2. **GitCode 建私有仓库必须用 JSON body** —— `POST /api/v5/user/repos` 若以
   `application/x-www-form-urlencoded` 提交，`private=true` 会被**静默忽略**，仓库变成公开；
   改传 JSON body `{"name":"…","private":true,"description":"…"}` 才生效。
   PATCH 接口（`/repos/:owner/:repo`）目前**不支持**改可见性，所以必须建仓库时就设对。

## 授权与合规

- 本项目为私有项目，未开源；临床使用须遵守《个人信息保护法》及互联网诊疗相关规定。
- 定位为**知识工作助手**，不输出诊疗建议，判断权始终归属执业医师。
