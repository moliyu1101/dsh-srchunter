## 漏洞挖掘模式快速上手

1. 在新会话选择器里选 **漏洞挖掘模式**。
2. 说明目标与目的（并附上授权说明与破坏性预算）：
   `srchunter_add_goal { target: "example.edu.cn", objective: "梳理 Web 面", authorization: "CTO 书面审批 #123", destructive: "limited" }`
3. 以 goal 为锚点建意图：`srchunter_add_intent { goalId: "goal-1", title: "枚举接口" }`
4. 子 agent 返回后就记录 fact/asset/finding；或者让指挥官用 `subagent` / `subagent_fork` 派发，
   由子 agent 自己调 `srchunter_submit` 回写。
5. 出报告前必须逐个裁决意图：
   `srchunter_set_intent { intentId: "intent-1", status: "deepen", disposition: "用 appSecret 伪造签名遍历 userId，贴出他人记录响应" }`
   （裁决态取值：`working` / `done` / `deepen` / `blocked` / `dead_end`；
   `deepen`/`blocked`/`dead_end` 必须给出那段 `disposition` 文字）。
6. finding 只有在过了实锤危害门槛后才会落库：`rawRequest`/`rawResponse`/`poc` 至少一项、
   量化后的 `impact`、归属 `owner`、`publicInterface` 不为 true，再加上 `reproducibleSteps`。
   过程中随时看 `srchunter_state` / `srchunter_graph`；收尾用 `srchunter_report` 生成按危害排序的
   Markdown 报告，每条漏洞带自己的证据块，末尾是 deepen/blocked/dead_end 意图的交棒清单。

Web 里的 **漏洞挖掘** 标签页（按会话隔离）实时展示同一张链路图：链路 / 漏洞 / 资产 / 报告。
抬头卡片把目标、目的、授权与破坏性档位放在上面，下面是意图/事实/漏洞/资产计数块，以及按严重度
分组的统计块——点某个严重度的块会直接跳到 **漏洞** 子页并只留这一档；还有未收口意图时，抬头会挂
出「待收口意图：N」，点了回到链路图。子页标签带实时计数。
**探索链路** 用图形渲染，左上角是各类节点的图例，点节点开右侧抽屉（能看到 `disposition` 定向指令），
点画布空白处收起。**漏洞** 子页可按严重度筛选、在「按危害」与「按记录顺序」之间切换，卡片带分值、
漏洞类型、归属单位、量化危害、死规矩自查、杀伤链、可复现步骤，PoC 与原始报文折叠在证据块里且每条
都能单独复制。**资产** 子页支持搜索（值、元数据、归属、父资产都参与匹配），列表按类型分组计数，
也能切成资产图。**报告** 子页渲染的结构与宿主 `srchunter_report` 输出的交棒结构一致，可复制或保存 .md。
