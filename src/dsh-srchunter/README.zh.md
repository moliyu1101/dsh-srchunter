# @deepseek-ai/dsh-srchunter

[English](README.md) | 中文

DeepSeek Harness 的漏洞挖掘模式：一条**探索链路**——goal → intent → fact → 派生 intent → finding——
决策 agent（根 agent）把探索/执行委派给子 agent、把每个节点与边写进持久记录，并记录**资产**
（根域名 / 子域名 / IP / 服务 / App / 端点）及其父子关系。每个漏洞 **finding 必须过实锤证据门槛**：原始请求/
响应包或可跑 PoC、量化影响面 `impact`、归属 `owner`，外加至少一条可复现步骤；打不穿的真线索记在 intent 的
`disposition` 上并置 `deepen`，不进漏洞清单。人类输入在决策门落地（`ask_user_question`，或直接提交的 intent）。
本包是唯一交付物：接线持久 `srchunter` storage domain、九个模型可见的 `srchunter_*` 工具，以及决策 agent 协议提示词段。

**记录所有权：** 决策 agent 负责建图、裁决（`srchunter_set_intent`）与出报告。探索/执行子 agent 用
`srchunter_submit` 把自己确认的事实/资产/漏洞直写被委派的父 intent —— 这是它们唯一可调的 `srchunter_*` 工具；
其余工具按调用 agent 自身会话 id 键控，子 agent 既碰不到父图，也没有自己的 goal。

## 配置

插件无配置。它依赖 `ctx.tools` 注册表与 `ctx.storageDomain` facility；组合了 `ctx.systemPrompt` 时还
贡献协议段。在同一个 profile overlay 中组合 storage hub（`@deepseek-ai/dsh-storage`）、存储后端
（`@deepseek-ai/dsh-storage-sqlite`）与 storage-domain facility：

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-sqlite
  name: '@deepseek-ai/dsh-storage-sqlite'
  config: { path: './.srchunter-sessions.db' }
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config: { backend: sqlite }
- id: srchunter
  name: '@deepseek-ai/dsh-srchunter'
```

## 工具

在 `ctx.tools` 注册：`srchunter_submit`、`srchunter_add_goal`、`srchunter_add_intent`、`srchunter_set_intent`、
`srchunter_add_fact`、`srchunter_add_finding`、`srchunter_add_asset`、`srchunter_state`、`srchunter_graph`、`srchunter_report`。

| 工具 | 用途 |
|---|---|
| `srchunter_add_goal` | 设置目标 + 目的 + 可选授权声明 + `destructive` 档位（readonly/limited/full）；**重置**本会话的探索图（全新链路，`goal-1`）。 |
| `srchunter_add_intent` | 记录意图节点（创建时恒为 `open`），锚定且仅锚定 `goalId`（spawns）或 `derivedFromFactId`（derived_from）之一。 |
| `srchunter_set_intent` | 裁决意图：`working` / `done` / `deepen` / `blocked` / `dead_end`，`disposition` 写定向指令、需人补的内容或否证依据（后三者必填）。仅决策 agent 可调。 |
| `srchunter_add_fact` | 记录由某意图产出的事实（port/service/vuln/finding/http/info，yields 边）。 |
| `srchunter_add_finding` | 记录由某意图证实的漏洞（proves 边）；**reproducibleSteps（至少一条）** 之外还要过实锤门槛（`rawRequest`/`rawResponse`/`poc` 至少其一 + `impact` + `owner`，且 `publicInterface` 不为真），另收 `vulnType`/`killChain`/`score`/`strictListHit`，可关联影响资产。 |
| `srchunter_add_asset` | 记录资产（root-domain/subdomain/ip/service/app/endpoint），可带 `owner` 归属、可选挂接父资产（parent 边）。 |
| `srchunter_state` | 读取目标、节点/资产清单与计数。 |
| `srchunter_graph` | 以 JSON 导出完整探索图（节点 + 边）。 |
| `srchunter_report` | 纯最终 Markdown 报告：按危害（score→severity）排序的漏洞清单（每条含类型、归属、量化影响、死规矩自检、攻击链路、复现步骤，PoC 与原始包用代码块包裹），随后是「交棒清单」（待深挖 / 需人介入 / 已否证三类意图及其 disposition）、资产图与完整链路。 |

节点与边 id 是确定性的（`<kind>-<n>`，按会话计数），因此会话投影能纯从日志重放整张图，决策 agent 也
能在跨调用引用 id。只读三件套带 `presentResult` 完成态卡片视图：`srchunter_state`/`srchunter_graph`/
`srchunter_report` 渲染为通用卡片，标题分别为 漏洞挖掘状态 / 漏洞挖掘探索图 / 漏洞挖掘报告（错误结果保持默认
回退）。

## 会话投影与 Web 界面

本包注册常驻 `srchunter` 会话投影单元（`./types` 声明 `SessionProjectionMap` 键；`./client` 为客户端消费方
纯再导出类型）。该单元把**已日志化的 `srchunter_*` 工具调用**折叠为常驻图——目标、意图/事实/漏洞节点、
资产、边与计数——因此其值可重放、且从不读取 storage domain。首次 `srchunter_add_goal` 之前为 `null`。

Web 界面位于 `@deepseek-ai/dsh-client-ui-srchunter`：按会话显示的 漏洞挖掘 会话视图标签页，读取
`useProjection('srchunter')`。标签页仅在当前会话由 `srchunter` agent 预设组合时注册（投影键本身不能作为
会话信号：host 级注册表会对每个会话输出 `null`），渲染 engagement 头部卡片与子标签 探索链路（交互图）、
漏洞（含可复现步骤）、资产（列表或图），srchunter 会话中 `null`（尚无 `srchunter_add_goal`）时显示引导空提示。

## 持久 domain

以 `defineDomain` 声明 `srchunter`（版本 2）：`goals`、`intents`、`facts`、`findings`、`assets`、`edges`
六张表。一切按单会话作用域（每条记录携带其 `sessionId`）。写入按域排队，先持久化到路由后端、再改内存、
再发 `domain/changed`；读取是权威内存态的同步读。

store 拥有探索纪律：每会话一个 goal（新 goal 清空整图）；每条边按种类引用同会话的精确节点种类
（spawns: goal → intent；yields: intent → fact；derived_from: fact → intent；proves: intent → finding；
parent: asset → asset）；finding 至少一条可复现步骤。`./invariant` 伴生在每次 `domain/changed` 上复查
该引用纪律。

## 模型体验

### 请求上下文与条件

#### 模型可见内容

本包贡献 `srchunter:protocol` 系统提示词段（order 50），内含逐字协议文本（见 `src/instructions.ts`）：EduSRC
作战与裁决口径——分层推进（侦察建模→入口突破→深入验证→关联扩大）、实锤证据门槛与常见误收/漏报清单、
半成品走 `deepen` 不落 finding、疑似后门/被黑必须收、按 `goal.destructive` 的破坏性红线、泛扫与轮次纪律、
死规矩四类敏感数据与未授权收取门槛；同时指示决策 agent 沿探索链路建图、把执行委派给子 agent、
子 agent 用 `srchunter_submit` 直写父 intent，并始终用中文与人交互。`srchunter_*` 工具 schema 贡献进模型工具目录，与 `src/tools.ts` 声明完全一致；
当部署属于 DeepSeek Harness 构建时，它们锚定在生成的工具目录中。

#### Token 效应

固定、与部署无关：一个常驻协议段加九个工具 schema。token 不随会话长度增长；完整记录留在 storage
domain，只有 `srchunter_state` 摘要进入模型上下文。

#### KV Cache 效应

前缀稳定：协议段文本与工具 schema 跨请求不变，构成稳定可复用前缀，不使缓存复用失效。只有工具参数与
结果在轮次间变化。

## 已知限制与后续工作

- **仅限单会话**——记录按会话键控，无跨会话/项目续跑（已确认的部署选择）。重新开始一次 engagement
  需新的 `srchunter_add_goal`。
- **不强制范围**——协议要求决策 agent 拒绝越界意图，`srchunter_add_goal` 记录声明式 `authorization`
  备注，但本包自身不拦截工具；沙箱/审批配置仍是部署的责任。
- **子 agent 转录负担**——子 agent 返回须由决策 agent 转录进 `srchunter_*` 记录；无人校验转录是否完整、
  忠实。
- **SQLite/会话并发**——写入按域串行（storage-domain 保证）；同一会话的并发多 agent 写入不再额外串行。
