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
  test/pack.test.mjs        # 42 项：契约 / 红线阻断（真引擎）/ 工具功能 / 错误路径
  test/integration.test.mjs # 11 项：真实 agent 循环 + 提示词注入 + 入账 + 输出红线
  README.md                 # 本文件
```

安装位置：`$MINGDAO_HOME/packs/tcm/`（**用户级**）。
选用户级而不是项目级的理由：项目级 `<repo>/.mingdao/packs/` 在 v0.6.2 起**默认不挂载**，
需先 `mingdao pack trust <项目目录>` 记录内容指纹、且内容一变即失效；用户级不受信任门限制
（见 `PACK-API.md` §1.1）。

> ### ⚠ 装上这个 Pack **不是零影响** —— 装之前请先读这一段
>
> 约束一旦挂载就生效，而 `output-forbid` 作用在 **agent 的正文**上，**与 provider 无关**
> （`agent.js` 的 `applyOutputConstraints`）。所以：
>
> **只要你把本 Pack 装到 `$MINGDAO_HOME/packs/`，那条「不输出诊疗结论」的红线
> 立刻就作用在当前的 Dify 问诊输出上** —— 不需要等 §四 的架构决策。
> 表现为：Dify 产出的正文里出现 `有效` / `好转` / `治愈` 时，会被内核自动改写一次
> （改写请求计入本回合 usage），改写后仍命中则替换为合规文案并记审计。
>
> 这是**好事**（红线从"提示词里的一句劝告"变成内核强制、进审计），
> 但它确实会改变你现在看到的行为——所以先说清楚，别以为"装了没接线就等于没装"。
>
> 相比之下另外两条红线在接线前是**惰性**的：`tool-arg-require` 与 `completeness`
> 都只作用于 Pack 自己的工具，而工具在接线前不会被调用。

## 三、能力面

### 工具（4 个，内核注册名自动加前缀）

| 工具 | 注册名 | 读/写 | 职责 |
|---|---|---|---|
| `patient_lookup` | `pack__tcm__patient_lookup` | 只读 | 按病历号 / 姓名+出生年+性别 定位患者；**同名多命中返回候选列表，绝不静默挑一个** |
| `patient_register` | `pack__tcm__patient_register` | **写** | 登记新患者并分配病历号；**同名已存在时拒绝登记**，把候选交回医师 |
| `intake_collect` | `pack__tcm__intake_collect` | **写** | 十问结构化 + 病历落盘；**必填齐全才写**，缺项回报"请继续采集" |
| `visit_compare` | `pack__tcm__visit_compare` | 只读 | 复诊四态对比（消失/减轻/无变化/加重），只陈述事实 |
| `followup_board` | `pack__tcm__followup_board` | 只读 | 回访看板 / 单患者时间线趋势 + 异常预警 + 随访话术草稿 |

> 为什么比迁移指南多了两个工具（指南只列了三个）：
>
> **`patient_lookup`** —— 原 `chat()` 里"同名多命中"那条短路**必须保留候选列表这个交互**
> （验收标准要求"行为不回归"）。约束引擎只能拦"没带病历号的写入"，不能产出候选列表。
> 所以把"定位患者"单独做成只读工具，由约束引擎保证"没确认过病历号就写不进去"。
> **两层合起来比原来更强**：原来只在同名多命中时拒绝，现在是"任何没有确认病历号的写入都拒绝"。
>
> **`patient_register`** —— 原 `chat()` 在调用 Dify **之前**就 `allocId` 建好了患者记录，
> 所以采集落盘时永远有已存在的病历号可用。迁到 Pack 后如果只保留采集工具，
> **新患者永远建不出来（首诊直接卡死）**。这个缺口是写功能测试时暴露的，不是推理出来的。
> 登记单独成显式动作，既补上链路，又不必放松"`intake_collect` 必须带已确认病历号"这条约束。

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

### 4.0 已定：走路线 A（用户 2026-09-14 决定）

```js
// dify.mjs 的 chat()：两段
① 只把 pack__* 工具交给编排器，问它「这一轮要不要调工具」
   ├─ 要 → 返回 toolCalls，交回内核执行（患者定位/登记/落盘/对比/回访）
   └─ 不要 → 走 ②
② Dify 流式问诊 —— 这段正文成为 provider 的 res.text，
   因此**逐字呈现**且**受内核输出红线约束**（这正是选 A 而不是 B 的核心理由）
```

**编排器只看到垂域工具**，不给 `read`/`write`/`ls`/`bash` 这些通用工具。
理由（实测踩到）：一开始把内核给的全部工具都转给编排器，医师只说了一句「回访」，
编排器却去 `read`/`ls` 翻代码库、白烧几步。断言 ⑨⑩ 已把这条锁死。

**编排模型可切本地小模型**（`config.tcm.orchestrator`），不配则默认 `deepseek-v4-flash`。
`thinking` 是 DeepSeek 专有参数，只在 DeepSeek 端点发送（本地 OpenAI 兼容服务收到会 400）。

### 4.1 两条路线的具体改动面（供评估代码，不是抽象选项）

**共同前提**：无论 A/B，`dify.mjs` 里那份患者注册表/快照读写都必须删掉
（否则两套实现各写一份 `patients.json`，见 §八）。

#### 路线 A —— Dify 继续主问诊：`chat()` 改成两段

```js
async chat(opts) {
  // ① 先让 DeepSeek 带 tools 判一次：这一轮该不该调工具？
  const decided = await decideWithTools(opts.messages, opts.tools, opts.signal); // 新增 ~40 行
  if (decided.toolCalls?.length) {
    return { text: '', toolCalls: decided.toolCalls, usage: decided.usage, finish: 'tool_calls' };
  }
  // ② 不调工具 → 走原来的 Dify 流式问诊（现有代码**原样不动**）
  //    ③ 域逻辑（患者注册表 / 十问提取 / 四态对比 / 回访）全部删除，已迁到 Pack
}
```

| | |
|---|---|
| 改动量 | `dify.mjs` 新增约 40 行（带 tools 的 DeepSeek 调用 + 判定）；删除约 200 行域逻辑 |
| 成本 | **每回合多一次 DeepSeek 调用**（tools 约 5 个 → 输入 1～2k token，输出几十 token） |
| 医师体验 | 不变（Dify 仍流式驱动问诊） |
| 归因 | 这次「判定」调用发生在 Provider 里、**不计入 pack** —— 它是编排成本、不是域成本，这是对的 |
| 风险 | 判定漏判（该调工具却没调）时要能看出来，需要给这次调用一个可观测的落点 |

#### 路线 B —— DeepSeek 主问诊：Dify 降为 Pack 内的一个工具

```js
// pack.mjs 新增第 6 个工具
{
  name: 'tcm_consult',
  description: '调用中医知识工作流（Dify）完成一次问诊应答；已带该患者的上一次病历上下文。',
  parameters: { type:'object', properties:{
    patientId: { type:'string' }, query: { type:'string' } }, required: ['query'] },
  readOnly: true,
  async run(args, toolCtx) {
    // 大部分代码是从现在 dify.mjs 的流式解析搬过来的；
    // 可用 toolCtx.io.writeText 边收边显示（工具 ctx 上确实有 io）
  },
}
```

| | |
|---|---|
| 改动量 | Pack 新增 1 个工具（约 60 行，主要是从 `dify.mjs` 搬来的 SSE 解析）；`dify.mjs` 从 Provider 降级为 Pack 内的一段代码 |
| 配置 | `config.json` 的 `provider` 改为 `deepseek`；`$MINGDAO_HOME/providers/dify.mjs` 不再作为 Provider 加载 |
| 成本 | **无额外调用**（DeepSeek 直接就是 agent 的模型） |
| 医师体验 | 问诊对话改由 DeepSeek 驱动；Dify 变成"调一次拿一段知识" |
| ⚠ 需要先解决 | 现在 `conversation_id` 是 **Provider 单例持有的一个变量**（`let conversationId = ''`），改成工具后必须**按患者隔离**，否则张三和李四的 Dify 会话会串。这是 B 路线必须先想清楚的一点 |
| 与既有原则 | 更贴合你 README 里写的「Dify 管知识，Harness 管流程」 |

> 一句话取舍：**要"问诊对话本身保持现在的水准"→ A**；
> **要"DeepSeek 编排、能做多步推理（先查病历 → 再决定问什么 → 再落盘）"→ B**，
> 但得先把上面那条 `conversation_id` 按患者隔离定下来。

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

### 5.1 WebUI 里的 Pack 工具卡片（DoD ④ 的核对结果）

结论：**Pack 工具会走与内置工具完全相同的卡片组件**，不需要任何下游改动。

核对依据（`src/web/app.js` 的 `renderToolStartEvent` / `renderToolEvent`）：

- 卡片按 `ev.name` / `ev.args` / `ev.result` **通用渲染**，全文件唯一的按名字分支是 `ev.name === 'task'`（子代理）；
- 结果渲染的兜底分支是 `else if (r.output)` —— 正是 Pack 工具返回的 `{ok, output}` 形状，
  所以医师能看到「📋 病历快照已落盘…」这样的正文，而不是一坨 JSON；
- 状态位按 `r.ok !== false` 判定，Pack 工具的错误返回（`{ok:false,error}`）会正确显示为 ✖。

**但有三处对医师不友好的细节**（都属于上游 WebUI 的缺口，下游无法修——DoD ⑥ 禁止改上游源码）：

| 现象 | 根因 | 建议的上游改法 |
|---|---|---|
| 卡片标题显示 `pack__tcm__intake_collect` | 渲染用的是**注册全名**，前缀由 `mountPacks` 自动加 | 用 `manifest.displayName` + 工具本地名渲染，或至少剥掉 `pack__<pack>__` 前缀 |
| 参数摘要为空 | 只取 `args.path \|\| args.pattern \|\| args.name` | 补 `args.patientId` 等常见键，或退化成显示前 1～2 个参数 |
| 图标是通用 🔌 | 图标表按内置工具名硬编码 | Pack 可在 manifest 里声明工具图标（或按 pack 给一个默认图标） |

这三条不影响功能，只影响观感；已作为上游反馈项记录，本 Pack 侧不做 hack 绕过。

> 上游在 `MIGRATION-DEYI-v0.5.md` 里写了「内核 bug 一律在上游修；扩展点不够用就直接反馈上游，
> 不要在下游 fork 内核」。上面这几条建议反馈回去——尤其 **Pack 工具无法被 Dify 类 Provider 触发**
> 这一条，它不在指南的覆盖范围内。

### 5.2 真实接线时又踩到的三个上游缺口（都在生产实例上复现过）

这三条不是读代码读出来的，是**把路线 A 接上去实跑**才暴露的，且都被下游绕开了：

| # | 现象 | 根因（已定位到行） | 下游如何绕开 |
|---|---|---|---|
| 1 | `ctx.llm({model:'deepseek-v4-flash'})` 报 **`[deepseek-v4-flash] 响应解析失败`** | `src/providers/index.js` 的 `resolveProviderConfig`：`baseUrl = cfg.baseUrl \|\| <目标模型服务商预设>.baseUrl` —— **顶层 `baseUrl` 会压过目标模型自己服务商的地址**。而顶层 `baseUrl` 是给「当前 provider」用的（Dify），于是带着 DeepSeek 的 key 打到了 Dify 域名 | **`config.json` 不写顶层 `baseUrl`**；Dify 地址由 `dify.mjs` 自己兜底（`pc.baseUrl → config.tcm.difyBaseUrl → 默认值`）。见 §5.3 |
| 2 | 医师只说「回访」时，Pack 工具**完全不在选项里** | `src/agent.js` 的 `toolsFor()`：只读阶段只放行 `READONLY_TIER_SET`（硬编码内置名）、已用过的工具、以及 MCP —— **`isRegisteredToolReadonly()` 明明存在却没被用**，于是 `readOnly:true` 的 Pack 工具被一并挡掉 | 无解（下游无法添加内核没给的工具）。**必须上游修**：只读阶段应改用 `isRegisteredToolReadonly(n)` |
| 3 | 编排器收到全部工具后 **去 `read`/`ls` 翻代码库** | 不是内核缺陷，是接线方的设计失误：`provider.chat()` 收到的 `tools` 含全部内置工具 | `dify.mjs` 只把 `pack__*` 前缀的工具交给编排器（见 §4.2）。已加断言 ⑨⑩ 锁死 |

> 第 2 条影响面最大：**任何"只读意图"的指令（回访、查病历、看趋势）都触发不了 Pack 工具**，
> 而这类指令恰恰是中医随访场景的高频入口。上游若不修，路线 A 就只能覆盖"带写意图"的指令。

### 5.3 一条必须遵守的配置约定

`config.json` **不要写顶层 `baseUrl`**。Dify 的地址写在 `tcm.difyBaseUrl`：

```jsonc
{
  "provider": "dify",
  "model": "dify-chatflow",
  // 不要在这里写 "baseUrl": "https://dify..."   ← 会让域内 ctx.llm 调用打错端点
  "tcm": { "difyBaseUrl": "https://dify.mingdaotcm.cn" }
}
```

另外 `PACK-API.md §3` 写「`data` 不进模型上下文，仅供 UI/约束」，实测**不符**：
`src/agent.js` 是 `JSON.stringify(result)` 整条写回消息，`data` 一样进上下文。
本 Pack 正好利用了这一点 —— `patient_lookup` 把「本次第几诊 + 上次病历」放进 `data`，
Provider 再从中取回、拼进 Dify 的 query（否则会重演「四诊标题矛盾」）。

## 六、怎么验证

```bash
# ① 静态校验（下游 CI 门禁，应退出 0）
mingdao pack verify layer/packs/tcm

# ② 单元 + 红线 + 功能 + 错误路径测试（42 项；需要一份上游内核检出，红线部分用它的真实约束引擎）
MINGDAO_KERNEL=/path/to/MingDao-Harness node layer/packs/tcm/test/pack.test.mjs

# ③ 端到端集成测试（11 项；真实 agent 循环 + 提示词注入 + 输出红线）
MINGDAO_KERNEL=/path/to/MingDao-Harness node layer/packs/tcm/test/integration.test.mjs

# ④ 装进一个 MINGDAO_HOME 后确认挂载
mingdao pack list
mingdao pack info tcm
```

测试分四层，**每层都要求断言能失败**：

| 层 | 覆盖 |
|---|---|
| 纯函数 | `matchPatient`（含同名多命中不静默挑一个）、`missingFields`、`visitLabel`、`daysSince` |
| 红线阻断 | 用**内核真实引擎**断言三条红线确实拦得住；并断言"该放行的放行"（带了病历号不拦、十项齐全不拦、纯事实输出不拦、既往确诊不被误伤） |
| 工具功能 | 临时 home + 桩 llm 跑完整业务流：登记 → 首诊落盘 → 复诊落盘 → 四态对比 → 回访看板/随访；并断言**缺项时确实没有写盘**、只读工具确实没写注册表 |
| 错误路径 | 注册表损坏/结构不符/`nextId` 被改小/`ctx.llm` 不可用/模型返回非 JSON/缺项后补齐 —— 断言**该失败的一定失败、且一定没有副作用** |
| 端到端 | 真实 `createAgent` + 桩 provider：①两轮 `tool_calls` → 工具真的被 dispatch、副作用真的落盘、结果真的回填，**并断言域内模型调用真的入账**（`cache-stats.jsonl` 里 `pack=tcm`、`purpose=intake-extract`、`packCost>0`、`cost=null`）；②提示词段真的进了系统提示且两次构建字节一致；③**含「好转」的正文被红线改写**、命中进审计、纯事实正文不被改写 |

测试**刻意不复刻一份约束引擎**——复刻出来的断言在真引擎坏掉时照样通过，是假绿。
`pack.test.mjs` 直接 `import` 内核的 `compileConstraints` / `checkPreTool` / `checkPostTool` / `checkOutput`。

**两条关于「断言本身」的纪律**（写这套测试时各踩过一次）：

1. **异步断言必须用 `testAsync` / `checkAsync`。** 把 `async` 函数传给同步的 `test()` / `check()`
   会**假绿**——Promise 不被 await，里面断言失败也照样打印 ✓、照样计入通过。
   两个入口分开命名，就是为了让"用错"在阅读时看得出来。（本仓库曾有 2 处踩中，已修；
   复查命令：`awk '/^[[:space:]]*test\(/{if($0~/async/)print NR": "$0}' layer/packs/tcm/test/pack.test.mjs`）
2. **断言要能失败。** 定期做变异验证：例如把 `no-efficacy-conclusion` 的 `action`
   从 `block-and-rewrite` 改成 `warn`，红线测试**必须**变红。
   实测过：42 → 41 通过 / 1 失败。改不红，就说明这条断言是摆设。

> 端到端测试用的是**桩 provider**，所以它证明的是「**工具→入账**这条链在内核里是通的」，
> **不**证明生产环境的 provider 会产出 `tool_calls`——那正是 §四 待决策的事。
> 它的价值在于：无论最后选 A 还是 B，这条链都已经验过，不需要边接线边怀疑内核。

### 测试抓出的三个真 bug（已修）

这三条都不是推理出来的，是写测试时跑出来的——**只验证"能挂载、红线能拦"是发现不了它们的**：

1. **新患者永远建不出来**：`intake_collect` 要求病历号已存在，但没有任何工具会创建患者
   （原 `chat()` 是在调用 Dify 前就 `allocId` 建好了）。首诊会直接卡死。→ 补 `patient_register`。
2. **同一毫秒内两次落盘互相覆盖**：快照文件名是 `case-${Date.now()}.json`，
   复诊紧跟首诊时会同名 → **复诊把首诊病历顶掉**，就诊次数与事实不符。
   （原 `dify.mjs` 就有这个隐患，只是从没被测试碰到过。）
   并且 `visit_compare` 按 mtime 排序，同时刻写入时**左右会颠倒**。
   → 文件名撞名时递增时间戳；排序改按文件名里的时间戳数值。
3. **注册表损坏会静默把病历号发重**（性质最严重的一条）：
   `patients.json` 读不出来时原本回退成空注册表 → 从 `P001` 重新发号，
   而 `intake/P001/` 的病历快照还在盘上 → **两个不同患者共用一个病历号**，
   而且它返回 `ok:true`、没有任何告警。这正是三条红线要防的串病历。
   → 只有「文件根本不存在」才允许从 P001 开始；损坏/结构不符一律**大声失败**并给出修复建议。
   另加一层独立兜底：`allocId` 会跳过**盘上已有 `intake/<id>/` 目录**的号，
   即使注册表被回滚或替换，也不会复用已有病历的号。
   > 原则：**发错号不可逆，拒绝服务可恢复** —— 医疗数据上这两者的代价不对称。

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
| 8. 域内模型调用改走 `ctx.llm()`（消灭 `usage:{0,0}`） | ✅ **机制已在真实 agent 链路里验证**（集成测试断言 `cache-stats.jsonl` 出现 `pack=tcm` / `purpose=intake-extract` / `packCost>0`） |

**DoD 对照**（①`pack verify` 退出 0 ②域内调用进 `cost --by pack` ③三条红线可被测试阻断
④工具在 WebUI 显示为卡片 ⑤同名多命中不回归 ⑥不改内核源码）：

| | 状态 |
|---|---|
| ① | ✅ 退出 0（5 工具 / 4 约束 / 1 提示词段） |
| ② | ✅ **已在生产实例验证**：`mingdao cost --by pack` 显示 `tcm 1 次调用 261+269 tokens ≈¥0.00160`（用真实患者数据跑出来的） |
| ③ | ✅ 三层验证：单测用内核真实引擎逐条断言（含"该放行的放行"）；端到端在**真实 agent** 里验证输出红线会改写违规正文并写审计。注：`output-forbid` 与 provider 无关，**装上 Pack 即已生效**（见 §二 的警告） |
| ④ | ✅ **已在生产实例验证**：SSE 里出现 `toolStart pack__tcm__followup_board` + `tool`（成功、带 output），走的正是 §5.1 核对的通用卡片路径 |
| ⑤ | ✅ 单测 + 功能测试双层覆盖（`patient_lookup` 返回候选、`patient_register` 拒绝重复登记） |
| ⑥ | ✅ 全程只动 `layer/`，上游源码零改动 |

## 八、数据与合规

- `patients.json`、`intake/**` 是**真实患者数据**，已在 `.gitignore` 中排除，永不入库；
- 快照写入用**原子写**（临时文件 + `rename`），避免崩溃时留下半份病历；
- 半份病历**刻意不落盘**：它会被下一次复诊当成基线，比没有更危险；
- 注册表损坏时**大声失败**，绝不降级成"空注册表"——发错病历号不可逆，拒绝服务可恢复；
- `allocId` 有一层独立兜底：跳过盘上已有 `intake/<id>/` 的号，不依赖注册表自身完好；
- `zhenduan` 字段对重大疾病诊断有硬规则（原样保留、绝不概括）；
- 本 Pack 不做任何诊疗判断，**判断权始终归属执业医师**。

### 一个仍存在的结构性风险（接线时必须一并处理）

`layer/providers/dify.mjs` 里**仍有一份**患者注册表/快照的读写逻辑。
当前两套并存是安全的——因为 Pack 工具还没被触发（见 §四）——但**一旦接线，两条写入路径会同时存在**：
两个实现各写一份 `patients.json`，互相覆盖。
所以接线时必须二选一：把 `dify.mjs` 的域逻辑删掉（推荐，本来就该删），或让它只读不写。
