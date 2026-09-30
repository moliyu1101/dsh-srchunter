# 仓库贡献指南

## 项目结构与模块划分

本仓库把漏洞挖掘功能打包成一个 DSH bundle。`lib/` 就是对外发布的运行时产物：
`srchunter.js`、`storage-sqlite.js` 以及 Web 客户端文件都由 `npm pack` 打进包里。
`cordis.patch.yml` 必须与这些 exports 保持一致。`src/` 存放这些产物对应的源码快照，
`tests/bundle.spec.ts` 覆盖补丁层。`preset/srchunter/` 是由 bundle 注册的只读系统预设。
`README.md` 面向最终用户，贡献者的操作流程写在这里。

## 构建、测试与开发命令

- `npm pack`：生成 npm `.tgz`；release 工作流把它重命名为固定的 `dsh-srchunter.tar.gz` 资产。
- `dsh plugin --profile web add file:C:/path/to/<bundle>.tar.gz`：把构建好的 bundle
  装进本地 Web profile 做手工验证。
- `npm ci && npm test`：按 lockfile 安装独立的测试依赖，并跑 GitHub Actions 用的 bundle 校验。
- `node scripts/rebuild-artifacts.mjs`：从源码快照重生成 `lib/srchunter.js`、
  `lib/invariant.js` 和 `lib/ui-srchunter.client.js`。加 `--check` 会在产物与源码脱节时
  非零退出；改动任何 `src/` 之后、提交之前必须先跑它。

## 重生成流程与兼容性

签入的源码快照就是发布产物的装配依据。发布用的 bundle 自身是独立的：宿主改动做在
`src/dsh-srchunter`，客户端改动做在 `src/dsh-client-ui-srchunter`，然后跑
`node scripts/rebuild-artifacts.mjs`。它逐模块转译源码，再按 region 边界替换进对应产物：

- `src/dsh-srchunter/src/*` → `lib/srchunter.js`（产物原有的 zod 内联块与
  `@deepseek-ai/*` import 行会被保留）；
- `src/invariant.ts` → `lib/invariant.js`，其中 `PACKAGE_NAME = '@moliyu1101/dsh-srchunter'`、
  域名为 `dsh-srchunter-invariant`；
- `src/dsh-client-ui-srchunter/src/*` → `lib/ui-srchunter.client.js`，并把所有
  `@deepseek-ai/dsh-client-ui-srchunter` 引用替换成 `@moliyu1101/dsh-srchunter/ui-srchunter`。
  每个视图的 `.module.css` 同样会重编译进产物里对应的 `dsh-css` region：作用域前缀沿用产物
  已有那个（所以无改动时字节稳定），`:global(...)` 原样保留，class 映射表按选择器里出现的
  local 重新生成——也就是说改样式只需要动 `.module.css`，不要再去手改产物里的 CSS 串。
  各 region 共享一个顶层作用域，同名顶层声明会自动带 `$n` 后缀。
- 包身份不靠手改产物：脚本读 `package.json` 的 `name`，把产物里所有 bundle 自身身份串（客户端的 loader
  `id`、`dsh-css` region 的 tagId 与 `data-plugin*`、以及 `lib/types/` 下的声明壳）统一改写成当前包名。
  换包名只需要改 `package.json`/lock、`cordis.patch.yml`、`preset/srchunter/agent.cordis.yml` 的行名、
  `src/invariant.ts` 的 `PACKAGE_NAME` 和 `tests/bundle.spec.ts` 的断言，再跑一次重生成。

`lib/index.js` 和 `lib/ui-srchunter.js` 保持为空 `apply` 的中立入口。
`lib/storage-sqlite.js` 是从 DSH 仓库 vendored 过来的，本仓库没有它的源码快照，
要改就直接改产物，并保证它与领域表结构一致。脚本幂等且字节稳定，所以在无实质改动的情况下
重跑不应产生 diff，`--check` 就是用来断言这一点的。bundle 目标版本是 DSH `0.1.0-rc.6`；
DSH API 变化时要同步 peer 依赖，并从对应的上游版本重新构建。

## 代码风格与命名约定

TypeScript 用两空格缩进、单引号、不写分号，与源码快照保持一致。值和函数用 `camelCase`，
React 组件和类型用 `PascalCase`，Cordis 行 ID 与文件名用 kebab-case。

命名分三层，各层独立变动：

- 显示名：「漏洞挖掘模式」——预设显示名、Web 标签页标题、工具卡片标题和报告抬头。
- 模式标识符：`srchunter`——存储域及其路由、agent 预设 id（`preset/srchunter/`）、
  `srchunter_*` 工具、投影键、`srchunter:protocol` 段落、`srchunter-sessions.db`，
  以及 bundle 子路径 `./srchunter` / `./ui-srchunter`。再改这些就是破坏性变更：sqlite 后端
  按 unit 名+版本登记，库不匹配直接拒绝打开；每条会话记录里也存着当初把它认定为漏洞挖掘会话的
  预设 id。
- 包身份：`@moliyu1101/dsh-srchunter`，GitHub 仓库与 release 资产同名（`dsh-srchunter.tar.gz`），
  README 的安装 URL 就指向这个仓库。源码快照沿用 `@deepseek-ai/dsh-srchunter` /
  `@deepseek-ai/dsh-client-ui-srchunter` 这两个装配名：它们是快照转译时的 import 说明符（客户端侧会被
  换成 bundle 子路径，宿主侧只留 `@module` 注释与真正的宿主服务包），不要把它们当成待改的品牌。

文案语言：文档、提示词、工具与参数描述、报错文案、报告输出统一用中文；协议标识符
（工具名、字段名、枚举值、`data-testid`、包名、路径）保持英文，因为它们和已存库、投影、
前端选择器绑定。客户端 `locales.ts` 的 zh/en 双语是运行时功能，随宿主界面语言切换，不在此列。

不要手工编辑生成的 `lib/`：通过 `scripts/rebuild-artifacts.mjs` 让它与源码快照同步，
只有在装配结构变化时才改 bundle 补丁。

## 测试指南

用 Vitest 的 `describe`/`it`，测试名描述可观测行为。凡是改动导出的插件行、路由或它们的必需配置，
都要同步更新 `tests/bundle.spec.ts`。保留上游包的 100% 覆盖率门槛，并为领域模型、投影或客户端
改动补上针对性测试。

## 提交与 Pull Request 指南

提交标题用简洁的 Conventional Commit 风格，例如 `feat: add asset view` 或
`fix: configure sqlite path`。要说明重生成了哪些产物、tarball 版本号，链接相关 issue；
UI 改动把 Web 截图贴在评审线程里，不要把图片文件提交进仓库。绝不提交本地 DSH profile、
数据库或凭据。
