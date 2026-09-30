# dsh-srchunter — DSH 漏洞挖掘模式

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的漏洞挖掘模式：
在授权范围内记录目标、探索线索、验证结果、资产与漏洞，并在 Web 中以探索链路、漏洞和资产视图展示。

本目录是自包含 bundle 包（`@moliyu1101/dsh-srchunter`）：宿主插件、Web 界面和 sqlite 后端通过包内 `exports`
一同分发。Release 资产可直接由 `dsh plugin add` 安装。

## 安装

### 从 Release URL 安装

```powershell
dsh plugin --profile web add -w https://github.com/moliyu1101/dsh-srchunter/releases/download/v0.1.0-rc.28/dsh-srchunter.tar.gz
```

装带版本的地址而不是 `releases/latest/...`：profile 的依赖由 pnpm 按 URL 缓存，`latest` 这个地址
不变而内容会变，升级时可能仍然解出旧字节（实测把 `latest` 换成新发布后，装到的还是上一版）。
`-w` 是因为 profile 目录本身是一个 pnpm workspace 的根。

DSH Desktop 的 `desktop` profile 由 Electron 应用独占管理，`dsh plugin --profile desktop add` 会被
拒绝；要在桌面端用这个模式，请从应用内的插件入口安装，或者用 `dsh --profile web` 起 Web 界面。

### 或下载后从本地文件安装

```powershell
dsh plugin --profile web add -w file:C:\path\to\dsh-srchunter.tar.gz
```

重启 dsh 后，在新会话中选择自动注册的「漏洞挖掘模式」。

### 找不到「漏洞挖掘」标签页？

标签页按**当前会话是不是用「漏洞挖掘模式」预设创建的**来注入，不是全局开关。所以：

- 只有当前会话（或列表里它的祖先会话）的预设 id 是 `srchunter` 时才注入，普通会话没有这个入口；
  在旧会话里就地切换到「漏洞挖掘模式」即可让它出现。
- 投影只认 `srchunter_*` 工具调用。会话历史里还没有 `srchunter_add_goal` 时，标签页显示的是引导空态
  而不是报错——空面板说明这次作业还没记录，不代表装载失败。
- 存储域按 unit 名与版本各自登记，库不匹配直接拒开。本模式的库是
  `$DSH_HOME/storages/srchunter-sessions.db`；Web 面板读的是从会话日志折叠出来的投影，两者互不依赖，
  所以面板有内容也不等于 `srchunter_state` / `srchunter_graph` / `srchunter_report` 这些读库工具能看到同一批记录。
- 改了 `src/` 之后要重生成产物、重新出包并重装，界面上才会出现新构建的文案与视图：

  ```powershell
  node scripts/rebuild-artifacts.mjs
  npm pack --pack-destination .
  dsh plugin --profile web add -w file:C:\path\to\moliyu1101-dsh-srchunter-<version>.tgz
  ```

  重装后界面仍是旧文案时，先核对装进去的是不是新产物——对比
  `…/profiles/web/node_modules/@moliyu1101/dsh-srchunter/lib/srchunter.js` 与仓库里 `lib/srchunter.js`
  的大小和哈希；必要时把 `package.json` 的版本抬一级再打包安装。

## 架构速览

- **领域模型**（`src/dsh-srchunter/src/spec.ts`）：storage domain `srchunter`（version 2）——`goals` / `intents` /
  `facts` / `findings` / `assets` / `edges` 六张表。边即链路词汇：`spawns`(goal→intent)、`yields`(intent→fact)、
  `derived_from`(fact→intent)、`proves`(intent→finding)，资产关系用 `parent`(asset→asset)。goal 带
  `destructive`（子 agent 破坏性动作预算 readonly/limited/full）；intent 有裁决态 `status`
  （open/working/done/deepen/blocked/dead_end）与 `disposition`（打回深挖的定向指令、需人介入的内容、否证依据）；
  finding 必填 `reproducibleSteps`（至少一条）并通过**实锤证据门槛**（原始包或 PoC + `impact` 量化 + `owner` 归属，
  `publicInterface` 为真直接拒收），另带 `vulnType`/`killChain`/`score`/`strictListHit` 等提交要素；asset 带 `owner`。
- **确定性 id**（`store.ts`）：节点/边 id 为 `<kind>-<n>`（按会话计数，goal 重置后归零）——工具返回 id 供模型
  跨调用引用，会话投影从日志纯重放同一张图。
- **工具**（`tools.ts`）：`srchunter_submit`（子 agent 直写指定父 intent）/ `srchunter_add_goal`（重置整图，带 destructive 档位）/
  `srchunter_add_intent`（恰好一个锚点）/ `srchunter_set_intent`（意图裁决：done/deepen/blocked/dead_end + disposition）/
  `srchunter_add_fact` / `srchunter_add_finding`（实锤证据门槛，步骤必填，可关联影响资产）/ `srchunter_add_asset`（可选 parentId，
  空字符串视为根资产）/ `srchunter_state` / `srchunter_graph` / `srchunter_report`。
- **会话投影**（`projection.ts`）：折叠已日志化的 `srchunter_*` 调用为 `{ goal, nodes, assets, edges, counts }`，
  镜像 store 的引用拒绝；上限各 200。单元 `stateVersion` 为 4，宿主据此判定缓存是否过期并重折。
- **Web 标签页**（`src/dsh-client-ui-srchunter`）：按会话注册（当前会话或列表祖先链的预设是 `srchunter`
  即显示，其他会话隐藏）；抬头卡片给出目标·目的·授权·破坏性档位、四类计数块、按严重度
  分组的统计块（点某一档直接跳到漏洞子页并只留该档）与「待收口意图」提示，子标签带实时计数并吸顶。
  四个子标签——探索链路（@xyflow/react 图，节点带类别徽章与**意图裁决徽章**，边带关系胶囊：
  意图链/产出/推导自/证实，左上角图例，点画布空白收起抽屉）、漏洞（按危害或记录顺序排序的卡片，可按严重度
  筛选：严重度+score、类型、归属、危害量化、死规矩自检、攻击链路、可复现步骤、折叠的证据块内每条 PoC/原始包
  都能单独复制、影响资产）、资产（列表/图两种模式，列表带搜索与分组计数，含归属与父资产）、
  报告（客户端按同一 EduSRC 结构拼装 Markdown：漏洞·交棒清单·资产·链路，渲染/复制/保存）。
- **协议**（`instructions.ts`）：系统提示词段 `srchunter:protocol`（order 50）。除链路记录纪律外，它还承载 EduSRC
  的作战与裁决口径：分层推进（侦察建模→入口突破→深入验证→关联扩大）、实锤证据门槛与常见误收/漏报清单、
  半成品走 `deepen` 而非 finding、疑似后门/被黑必须收、按 `goal.destructive` 的破坏性红线、泛扫与轮次纪律、
  以及 EduSRC 死规矩四类敏感数据与未授权收取门槛；与用户交互一律中文。
- **报告**（`srchunter_report`）：按危害（score→severity）排序的漏洞清单，每条含类型/归属/危害量化/描述/死规矩自检/
  攻击链路/可复现步骤/PoC/原始请求包与响应包；随后是「交棒清单」（待深挖、需人介入、已否证三类意图及其
  disposition）、资产（含归属）与完整探索链路。

## 已知边界

- **数据库**：漏洞挖掘记录写入 `$DSH_HOME/storages/srchunter-sessions.db`（sqlite，经 bundle 补丁路由）。
  宿主其它域的存储不受影响（仍为宿主默认 json 后端）。
- **换标识就是换库**：存储域按 unit 名与版本各自登记，不一致直接拒开。改动域标识（库文件名、`srchunter_*`
  工具名前缀、预设 id 中任一项）后读的是新库，旧库既不会被读取也不会自动搬迁；要留存就把旧库当档案，
  或自行按 `sessionId:id` 把行复制进新库。同理，Web 标签页按预设 id 判定，预设 id 变了而会话头部仍记着
  旧 id 时，那个标签页不会为历史会话出现。
- **授权**：只测试有授权的目标。`srchunter_add_goal` 的 `authorization` 参数可填写授权说明（授权对象 /
  书面许可引用），会写入状态与最终报告留痕；它只是审计事实，不是门禁——扫描/利用动作仍受部署沙箱与
  审批约束。
- **记录按单会话作用域**，无跨会话/项目续跑；重新开始一次 engagement 需新的 `srchunter_add_goal`。
- **Web 图为窗口视图**：会话投影各保留最新 200 个节点/资产/边（超出后最旧被逐出，悬挂边同步清理）。
  UI 计数与图反映的是该窗口；完整记录以 `srchunter_state` / `srchunter_report`（读存储层）为准。
- **图布局为静态分层**（可平移缩放，节点不可拖拽）。
- **实锤门槛在写入边界**：`srchunter_add_finding` 与 `srchunter_submit` 的每条 finding 都要过门槛（原始包或 PoC +
  `impact` + `owner`，且 `publicInterface` 不为真），不达标直接拒并回指 `deepen` 路径；被拒的提交不留半批数据。
  投影折叠同一门槛，所以 UI 图与报告口径一致。
- **证据包在 Web 侧截断**：会话投影把 `rawRequest`/`rawResponse`/`poc` 截到 20000 字符并标注已截断，
  持久层与 `srchunter_report` 保留完整包。
- **域版本仍为 2**：新增字段全部是带默认值的可选字段，旧记录可直接读出；sqlite 后端按 unit 版本拒绝不一致库，
  因此不能靠升版本号迁移，也不应删除既有 `srchunter-sessions.db`。
- **运行时要求**：sqlite 后端使用 Node.js `node:sqlite`，宿主运行时需 Node.js >= 22.5。

## 目录结构

```
dsh-srchunter/                   # 项目根 = bundle 包 @moliyu1101/dsh-srchunter（自带 zod/schemastery 运行时依赖，其余宿主提供）
├── package.json               # bundle manifest：dsh.bundle.patch + dsh.client + exports 子路径
├── cordis.patch.yml           # 补丁层：UI、sqlite 后端与 storage-domain 路由
├── lib/                       # 构建产物（npm pack 的内容）
│   ├── index.js               #   包入口：空 apply
│   ├── srchunter.js             #   宿主漏洞挖掘插件：9 个 srchunter_* 工具 + 协议注入 + 会话投影
│   ├── preset-root.js          #   注册包内只读「漏洞挖掘模式」预设目录（兼容 DSH rc.6）
│   ├── storage-sqlite.js      #   漏洞挖掘记录专用的 sqlite 后端（node:sqlite）
│   ├── ui-srchunter.js          #   Web 插件宿主半：空 apply
│   ├── ui-srchunter.client.js   #   Web 插件浏览器半：漏洞挖掘视图标签页（3 个子标签，@xyflow/react 内联）
│   └── invariant.js           #   探索图不变量伴生（与官方各包同构，生产环境不加载）
├── src/                       # 源码快照（继续开发/重新构建用）
│   ├── index.ts / invariant.ts
│   ├── dsh-srchunter/               # host 包源码：src/ + tests/ + tsconfig + tsdown + README
│   └── dsh-client-ui-srchunter/     # client 包源码：src/client/（视图/图布局/注册）+ tests/
├── tests/bundle.spec.ts       # bundle 补丁层测试
├── scripts/rebuild-artifacts.mjs # 从 src/ 快照重生成 lib/ 产物（--check 校验是否脱节）
├── docs/                      # quick-start / storage / goal-reset 说明
├── preset/srchunter/            # 「漏洞挖掘模式」agent 预设（由 bundle 自动注册）
└── README.md
```

## 参考项目

- [ARTEX](https://github.com/Autumn-27/ARTEX)
