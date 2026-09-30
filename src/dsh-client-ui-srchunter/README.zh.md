# @deepseek-ai/dsh-client-ui-srchunter

[English](README.md) | 中文

漏洞挖掘界面插件：**漏洞挖掘视图标签页**（`conversation.view`）。它是纯投影模式界面——实时 engagement 状态经
`useProjection('srchunter')` 到达（由历史尾部页播种、由 `session/projection` 帧更新），因此插件不拥有
store、刷新链或事件监听。

标签页按会话显示：仅当**当前**会话由 `srchunter` agent 预设组合时视图条目才注册（会话列表按行的
`agentPreset`）。投影键的存在性不能作为信号——会话投影注册表是 host 级单例，只要有一个漏洞挖掘预设挂载，
`srchunter` 键就会以 `null` 出现在**每个**会话的基线里。切换会话（或原位切换会话预设）会切换注册状态，
因此非漏洞挖掘会话永远不会出现该标签页。srchunter 会话中 `null`（尚无 `srchunter_add_goal`）时渲染引导空提示。

视图渲染一张 engagement 头部卡片（目标、目的、授权、**破坏性档位**、每类记录一枚计数块、已证实漏洞的
**严重度分布**、以及未收口意图提示），其下为吸顶的子标签栏，标签上带实时计数徽标：

- **探索链路**——探索链路（goal → intent → fact → 派生 intent → finding）以交互图呈现，由
  [@xyflow/react](https://reactflow.dev) 渲染。位置来自纯函数 `layoutExploration`（从目标 BFS 分层）；
  节点带类别徽章与连接手柄，意图节点显示**裁决徽章**（待委派/执行中/已结论/待深挖/需人介入/已否证），
  漏洞节点显示严重度，每条链边渲染可见的关系胶囊（意图链 / 产出 / 推导自 / 证实）；画布左上角是各类节点的
  当前数量图例，点节点开抽屉看完整字段（含 `disposition` 处置说明），点画布空白处收起抽屉。
- **漏洞**——每个漏洞一张卡片（左侧严重度色条），列表上方有工具条：按严重度筛选（头部卡片里的严重度分布块
  直接跳到本子页并只留该档），并在「按危害」（score → severity）与「按记录顺序」之间切换排序。卡片含严重度
  徽章 + 评分、类型、归属单位、危害量化、描述、**死规矩自检**（`strictListHit` / 是否公开接口）、**攻击链路**、
  **可复现步骤**、关联的影响资产，以及折叠的证据块——PoC / 原始请求 / 原始响应每条都能单独复制。
- **资产**——已记录的资产（根域名 / 子域名 / IP / 服务 / App / 端点）两种模式：按类型分组（每组标出数量）、
  行内显示父资产链接与**归属单位**、并带匹配值/元数据/归属/父资产的搜索框的列表；或由纯函数 `layoutAssets`
  布局、@xyflow/react 渲染的父子关系图。
- **报告**——与宿主 `srchunter_report` 同一 EduSRC 口径的 Markdown：头部（目标/目的/授权/破坏性档位/规模）、
  按危害排序的漏洞分节（归属·危害量化·死规矩自检·攻击链路·复现步骤·代码块包裹的 PoC 与原始包）、
  **交棒清单**（待深挖 / 需人介入 / 已否证）、资产与完整链路；可渲染、复制、保存 `.md`。

投影单元的 host 侧位于 [`@deepseek-ai/dsh-srchunter`](../dsh-srchunter/README.md)：它把已日志化的
`srchunter_*` 工具调用折叠为常驻图，因此标签页天然可重放。

## 配置

无配置。在 web bundle（`dsh.client` 行）中与 srchunter host 插件相邻组合即可；视图槽由
`@deepseek-ai/dsh-client-ui-conversation` 声明，本条目经 `ctx.slots.inject('conversation.view', …)` 以
`order: 20` 注册，并以 `ctx.sessions` 的当前会话及其 `agentPreset` 为门槛。文案位于插件自有的
`srchunter` locale 命名空间，注册进 locale 服务。`@xyflow/react` 内联进 client bundle；其样式表走本包
的 raw-CSS 内联插件（经 loader 拥有的 `<style data-plugin>` 通道注入）。

## 模型体验

纯呈现：这里没有任何内容进入模型、会话日志或工具目录。投影值由 host 侧 srchunter 包从已日志化的工具
调用计算。

## 已知限制与后续工作

- **只读标签页**——视图仅显示常驻状态；开始、暂停或重置 srchunter 会话仍须经决策 agent 的 `srchunter_*`
  工具或未来的命令界面。
- **跟随当前会话**——标签页跟随当前选中的会话（包括漏洞挖掘会话的子 agent 会话，经列表祖先链解析）；后台的
  srchunter 会话在被选中前不显示标签页。
- **静态图布局**——链路图与资产图使用固定分层布局；节点不可拖拽（React Flow 的平移/缩放仍可用）。
