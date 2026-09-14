# `pack-tcm` —— 中医垂域 Pack（Pack API v1）

把原先塞在 `layer/providers/dify.mjs` 的 `chat()` 里的整个中医域逻辑，搬到上游 v0.5.0 起冻结的
**垂域 Pack 扩展点**上。目标不是"换个地方放代码"，而是让域能力进入内核的**同一条链路**：

```
权限引擎 → 审计 → schema 瘦身 → 费用归因 → 约束校验 → UI 工具卡片
```

## 一、迁移前的六项损失（这是迁移的全部理由）

| 应有能力 | 迁移前 |
|---|---|
| 权限引擎门控 | 域内"工具"是 `chat()` 里的正则匹配（`/^(回访\|随访)\s*(.*)$/`），**绕过 `permissions.js`** |
| 审计追溯 | 不写 `audit.jsonl`，无法回答"谁在何时读了哪位患者的病历" |
| 费用与护栏 | 域内每次 DeepSeek 调用硬编码 `usage: { prompt_tokens: 0, completion_tokens: 0 }` → **完全不计费、不触发日费用护栏** |
| UI 工具卡片 / 流式 | 只能手工 `opts.onDelta` |
| 独立版本与 CI 校验 | 整文件覆盖，无 `apiVersion`，无法校验 |
| 记忆 / 技能 / 预设复用 | 全部用不上 |

## 二、目录结构

```
layer/packs/tcm/
  pack.json              # manifest：apiVersion / engines / permissions / contributes
  pack.mjs               # createPack(ctx) → tools / constraints / promptSections
  prompts/domain.md      # 中医领域提示词段（内核按 order + pack/id 确定性排序，字节稳定 → 不破坏前缀缓存）
  test/pack.test.mjs     # 红线与工具契约测试（21 项，含真实引擎阻断验证）
  README.md              # 本文件
```

安装位置：`$MINGDAO_HOME/packs/tcm/`（**用户级**）。
选用户级而不是项目级的理由：项目级 `<repo>/.mingdao/packs/` 在 v0.6.2 起**默认不挂载**，
需先 `mingdao pack trust <项目目录>` 记录内容指纹、且内容一变即失效；用户级不受信任门限制
（见 `PACK-API.md` §1.1）。

## 三、能力面

### 工具（4 个，内核注册名自动加前缀）

| 工具 | 注册名 | 读/写 | 职责 |
|---|---|---|---|
| `patient_lookup` | `pack__tcm__patient_lookup` | 只读 | 按病历号 / 姓名+出生年+性别 定位患者；**同名多命中返回候选列表，绝不静默挑一个** |
| `intake_collect` | `pack__tcm__intake_collect` | **写** | 十问结构化 + 病历落盘；**必填齐全才写**，缺项回报"请继续采集" |
| `visit_compare` | `pack__tcm__visit_compare` | 只读 | 复诊四态对比（消失/减轻/无变化/加重），只陈述事实 |
| `followup_board` | `pack__tcm__followup_board` | 只读 | 回访看板 / 单患者时间线趋势 + 异常预警 + 随访话术草稿 |

> 为什么多了 `patient_lookup`（迁移指南只列了三个工具）：
> 原 `chat()` 里"同名多命中"那条短路**必须保留候选列表这个交互**（验收标准要求"行为不回归"）。
> 约束引擎只能拦"没带病历号的写入"，不能产出候选列表。所以把"定位患者"单独做成一个只读工具，
> 由约束引擎保证"没确认过病历号就写不进去"。**两层合起来比原来更强**：原来只在同名多命中时拒绝，
> 现在是"任何没有确认病历号的写入都拒绝"。

### 约束（三条红线，内核强制，不依赖模型自觉）

| id | kind | 作用 |
|---|---|---|
| `no-cross-patient-intake` | `tool-arg-require` | `intake_collect` 缺 `patientId` → PreToolUse 阻断 |
| `no-cross-patient-compare` | `tool-arg-require` | `visit_compare` 缺 `patientId` → 阻断 |
| `ten-questions-complete` | `completeness` | 十问缺任一项 → PostToolUse 拒绝该结果 |
| `no-efficacy-conclusion` | `output-forbid` | 输出含 `有效`/`好转`/`治愈` → `block-and-rewrite` |

**关于 pattern 的一个刻意偏离**：`MIGRATION-DEYI-v0.5.md` 给的 pattern 是
`有效|好转|治愈|确诊为`。本 Pack **不含 `确诊为`**，理由：

- 你的文档里这条红线是「**不输出诊疗结论**：四态对比只陈述事实」——管的是**疗效判断**，
  不是"不许出现诊断字样"；
- 而「重大疾病诊断必须原样保留」是你专门修过的一条需求（`zhenduan` 字段的设立原因之一，
  就是为了不再把"宫颈癌"过滤掉）。医师病历里必然出现"2024 年确诊为宫颈癌"这类**既往确诊事实**，
  拦它等于把那条需求顶掉。

测试里有一条专门守这个边界：`红线三 · 既往确诊事实不被误伤`。**若你希望连"确诊为"一起拦，改
`pack.mjs` 的 pattern 即可**，但要接受上面的代价。

## 四、⚠ 待决策：谁驱动问诊（这是骨架期最关键的未决项）

### 事实

Pack 工具要被调用，**前提是 agent 的模型能产出 `tool_calls`**。
`src/agent.js` 拿到 `res.toolCalls` 才会进入工具执行分支。

而 `layer/providers/dify.mjs` 的 `chat()` **恒返回 `toolCalls: null`** ——
Dify Chatflow 的 `chat-messages` 接口只返回文本，不支持 OpenAI 风格的工具调用。

**结论：只要 `provider` 还是 `dify`，本 Pack 的 4 个工具就是「已注册但永远不会被触发」的状态。**
（`pack verify` 通过、WebUI 里工具列表可见，但没有任何一次真实调用。）

**这是骨架期的刻意状态**：先把域能力搬进扩展点、把红线做成可测试的内核约束，
再由架构决策决定怎么接线。当前 `dify.mjs` **一行未动**，3821 实例行为不变。

### 两条能真正跑通的路线

| | A. Dify 继续主问诊 | B. DeepSeek 主问诊，Dify 降为一个知识工具 |
|---|---|---|
| 做法 | `dify.mjs` 内部先用 DeepSeek 带 tools 判一次"要不要调工具"，不调就走 Dify 流式问诊 | agent 的 provider 改为 DeepSeek；新增 `tcm_consult` 工具去调 Dify 工作流 |
| 医师体验 | 最接近现状，Dify 流式问诊不变 | 问诊对话改由 DeepSeek 驱动 |
| 代价 | **每回合多一次小模型调用**（约 +1～2 秒） | 无额外调用；但 Dify 从"主问诊引擎"变成"调一次拿一段知识" |
| 与既有原则 | Dify 既管知识又管对话流程 | 更贴合你 README 里写的「**Dify 管知识，Harness 管流程**」 |

> 两条路线下 **Pack 本身完全一样**（本目录不用改），差别只在 `dify.mjs` 怎么接线。

## 五、与上游契约文档的出入（已按 v0.6.2 真实代码核对）

迁移指南与 `PACK-API.md` 有几处与实现不一致。**以下是核对结果，不是推测**：

| 文档写 | 代码实际 | 影响 |
|---|---|---|
| `ctx.llm()` 在 `createPack(ctx)` 上 | ❌ 那里的 ctx 只有 `{home, packDir, packName, log}`；**`llm` 只在工具的 `run(args, toolCtx)` 上**（`agent.js:326`） | 所有模型调用必须写在 `run()` 内部——本 Pack 就是这么做的 |
| `ctx.readJson` / `ctx.writeJsonAtomic` | ❌ 未实现 | 文件 IO 一律 `node:fs`（官方参考实现 `packs/example-hello` 亦如此） |
| `ctx.audit(entry)` | ❌ 未实现 | 审计由内核在工具执行链路里自动写（`agent.js` 的 `writeAudit`），域代码不必自己写 |
| `ctx.storage` | ❌ 未实现（`PACK-API.md` §6 自己也标了"仍缺"） | 用 `permissions.fs` 声明的显式路径 |
| `permissions` 强制"越出即拒绝" | ❌ **只是声明，内核不强制**（`PACK-API.md` §2 已加 ⚠ 更正） | 本 Pack 靠自身路径白名单自律；**安装第三方 Pack 前必须人工审阅 `pack.mjs`** |
| `contributes.commands` / `presets` / `skills` / `provider` | ⚠️ 只做**文件存在性校验**，无执行点消费 | 声明了也不生效——所以域能力**只能**经 `tools` + `constraints` + `promptSections` 暴露 |

最后一条是本 Pack 只用这三种 contributions 的原因。

> 上游在 `MIGRATION-DEYI-v0.5.md` 里写了「内核 bug 一律在上游修；扩展点不够用就直接反馈上游，
> 不要在下游 fork 内核」。上面这几条建议反馈回去——尤其 **Pack 工具无法被 Dify 类 Provider 触发**
> 这一条，它不在指南的覆盖范围内。

## 六、怎么验证

```bash
# ① 静态校验（下游 CI 门禁，应退出 0）
mingdao pack verify layer/packs/tcm

# ② 红线与工具契约测试（21 项；需要一份上游内核检出，测试用它的真实约束引擎）
MINGDAO_KERNEL=/path/to/MingDao-Harness node layer/packs/tcm/test/pack.test.mjs

# ③ 装进一个 MINGDAO_HOME 后确认挂载
mingdao pack list
mingdao pack info tcm
```

测试**刻意不复刻一份约束引擎**——复刻出来的断言在真引擎坏掉时照样通过，是假绿。
`pack.test.mjs` 直接 `import` 内核的 `compileConstraints` / `checkPreTool` / `checkPostTool` / `checkOutput`。

## 七、迁移进度

| 步骤（对应 `MIGRATION-DEYI-v0.5.md` §四） | 状态 |
|---|---|
| 1. `mingdao pack new tcm` 脚手架 | ✅ |
| 2. 域逻辑搬到 `pack.mjs` 的工具里 | ✅（患者注册表 / 十问采集 / 四态对比 / 回访看板） |
| 3. 患者 JSON 读写挂到显式路径（原子写） | ✅（`writeJsonAtomic`：临时文件 + rename） |
| 4. 三条红线写成 `constraints` | ✅（4 条，可被测试阻断） |
| 5. 领域提示词抽成 `prompts/domain.md` | ✅ |
| 6. `dify.mjs` 只保留协议适配 | ⏸ **刻意未做**——等架构决策（见 §四） |
| 7. `mingdao pack verify` 退出 0 | ✅ |
| 8. 域内模型调用改走 `ctx.llm()`（消灭 `usage:{0,0}`） | ✅（代码就绪，**要等工具真被调用才看得到账**） |

**DoD 对照**：①③⑤⑦ 已满足；②④ 依赖架构接线；⑥（不改内核源码）全程遵守。

## 八、数据与合规

- `patients.json`、`intake/**` 是**真实患者数据**，已在 `.gitignore` 中排除，永不入库；
- 快照写入用**原子写**（临时文件 + `rename`），避免崩溃时留下半份病历；
- 半份病历**刻意不落盘**：它会被下一次复诊当成基线，比没有更危险；
- `zhenduan` 字段对重大疾病诊断有硬规则（原样保留、绝不概括）；
- 本 Pack 不做任何诊疗判断，**判断权始终归属执业医师**。
