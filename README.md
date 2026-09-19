# Debug-Lite v3

「编程式自动对战」游戏后端。玩家为角色编写 AI 逻辑（JSON AST），服务器逐 tick 确定性模拟自动战斗；强度来自开箱得到的角色/技能模板与插件。当前开发范围：**P0–P5 全部后端 + P7 在线服务（B27–B33）均已交付**（P6 前端未开始）。

## 文档权威链

```
docs/decisions.md      决策记录（D-01…D-157）← 最高权威（D-129…D-157 均已落地）
docs/systems/01~10.md  各系统实现细则（`11-account-store.md` 为**已实现**的账号与存档权威设计，P7/B27–B33）
docs/v3-design.md      主设计文档（架构/数据模型/数值）
docs/items-data.md     物品数值、名称、贴图占位
docs/tasks.md          开发计划（铁律/接口/测试矩阵/批次/门禁）
docs/examples/         分支示例集（10 系统 + 索引），计算细节的唯一出处
docs/battle-walkthrough.md  端到端走查（系统间数值与状态传递）
docs/interfaces.md     接口冻结（P0-7 创建）
docs/plan-p7-playable.md    **P7 冲刺蓝图**（关段位门控 → 存储层 → 身份档案 → 排位/快速对战 → HTTP·CLI → e2e → 批量测试；含阶段级「代码级审查」硬性要求与"禁止占位 bot"约束）
docs/security-backlog.md    **安全与防作弊登记册**（record-only：SEC-01…SEC-30；只登记不修复，被顺手修掉的条目回填证据与状态）
docs/progress.md       当前状态与下一步
docs/ai-handoff-prompt.md   实现期交接提示词
docs/frontend-spec.md   **前端设计 v3（可玩优先）**：按钮→动作→数据三重契约 + 七屏逐屏按钮表 + 真实响应样本附录
scripts/fe-spec-check.js    前端文档自检器（C1–C9；`npm test` 内断言，含投毒用例）
.audit/fe-samples.js    真实响应样本采集器（前端字段名的唯一依据；不进 gate，**已入库**）
```

冲突处理：`decisions.md` > `systems/*` > `v3-design.md` > `tasks.md`；发现矛盾先停下来问，不自行选一个继续。

## 现状与计划的显式分界（2026-09-19 复核）

以下条目是"已实测事实"，与"计划中"严格分开；凡标注「计划中」的内容**当前不可用**：

| 主题 | 现状（已实测） | 计划中（未实现） |
|---|---|---|
| 分支 | `main` 为唯一主线，已完成合流；另有 `deepseek-v4.1f`、`glm-5.3f` 两个前端分支未合并。**`dev` 分支不存在** | — |
| 后端 | P0–P5 全部收口，34 批（9+11+5+5+2+2） | — |
| 在线服务（P7/B27–B33） | ✅ **已交付（2026-09-19）**：账号/登录/会话、服务端档案（配置槽 ≤3、唯一出战）、异步排位双向记账、快速对战非对称 Elo、战绩/防守/未读、排行榜、回放鉴权 + LRU 64 + 按需重算、`admin` 运维端点；`server/store/*`、`server/auth.js`、`server/account.js`、`server/quickmatch.js`、`server/admin.js` 在库，`runtime/`（`DL_DATA_DIR`）为运行时数据根 | P6 前端；`DL_STORE=sqlite` 适配器（`open()` 抛 `store_adapter_unavailable`，预留）；CLI 的 `configs`/`records`/`defense`/`admin *` 子命令；`scripts/bench-store.js`（**未实现**，T-ST-8 容量哨兵无承载） |
| 前端 | **main 上没有任何前端代码**（无 `public/`，`server/index.js` 无静态托管路由） | P6（F1–F7，见 `docs/frontend-spec.md`） |
| 回放 | `POST /battle` 帧由 **HTTP 层 LRU（默认 64，`replayCacheSize`）** 管理，淘汰 → `410 replay_expired`；归档回放（`b_`）按需重算 + **参与者鉴权**（非参与者 403）；`aiTrace` 按请求者 side 裁剪（`?trace=self` 默认、`?trace=all` 需管理员令牌）；遗留 `r<seq>` 回放默认仍对持有 id 者可见（`DL_LEGACY_STATELESS=1`） | 回放响应/帧**不含 `programHash`**（无法据回放核验 AI 程序；见 `11-account-store` §9.4 仍缺项）；`battle.js` 模块级 Map 无内建上限（限流只由 HTTP 层施加） |
| P7 环境变量与端点 | `DL_DATA_DIR`/`DL_STORE`/`DL_ADMIN_TOKEN`/`DL_LEGACY_STATELESS`/`DL_CORS_ORIGIN` 均**已接线**；`/auth/*`、`/me*`、`/quick/*`、`/leaderboard`、`/admin/*` 均已注册并鉴权 | `DL_LOG_CHANNELS` 仍未接线（通道级覆盖只经 `POST /api/v1/log-level`） |

## 环境要求

- Node `>=24.18.0`（`package.json engines`）、npm `>=11.16.0`（已实测）
- **零运行时依赖**（2026-09-16 复核）：HTTP 层用 `node:http`，`package.json` 无 `dependencies`；`express` 历史上列在白名单但**从未引入**。测试与日志同样零依赖（`node:test` + 自研 `shared/log.js`）。前端依赖仅在 P6（未开始）才需要考虑

## 命令

| 命令 | 用途 | 落地批次 | 复核状态（2026-09-16） |
|---|---|---|---|
| `npm start` | 启动 HTTP 服务（`/api/v1`；`main()` 显式启用档案存储，数据根默认 `<repo>/runtime`） | P0-8 / P7 | ✅ 已接线（启动冒烟见 gate 项 9 的同进程等价路径） |
| `npm test` | 单进程全量测试 | P0-3 固化 | ✅ **最后实测 942 通过 / 0 失败**（2026-09-19；用例数随并行改动会变，**以当次输出为准**）。状态源见 `docs/progress.md` |
| `npm run cov` | 全量测试 + 覆盖率阈值（行 ≥90 / 分支 ≥85 / 函数 ≥90） | P0-3 固化 | ✅ 实跑通过（阈值同时由 `gate` 项 7 逐文件判定） |
| `npm run gate` | 全量门禁（9 项，任一失败即非零退出） | P0-5 | ✅ **最后实测 9 PASS / 0 FAIL / 0 PEND**（含项 5 文档↔数据一致性 + D 编号落点 D-137…D-157） |
| `npm run check:docs` | 文档 ↔ 实现一致性检查（D1–D6；接入 CI 与 pre-commit） | 2026-09-16 | ✅ 实跑 PASS |
| `npm run hooks:install` | 安装 git 钩子（`core.hooksPath=.githooks`，一次性） | 2026-09-16 | ✅ 已安装 |
| `npm run demo` | 跑一场并打印逐 tick 摘要（数据表示例模板实例化） | B11 | ✅ 已补齐 `scripts/demo.js` 并实跑 |
| `npm run demo:log` | 同上，`trace` 级（等价 `DL_LOG_LEVEL=trace`） | B11 | ✅ 同上（`--log-level trace`） |
| `npm run play` | **离线可玩闭环**（开箱→自动装配→预设 AI→面板→打一场→逐 tick 战报；选项 `--seed/--boxes/--tier/--preset/--quality/--out`） | 2026-09-16（D-151） | ✅ 已实跑（`node scripts/play.js --help` 与默认局均可跑；**离线，不需要 `npm start`**） |
| `npm run e2e` | **联网全链路端到端**（真实玩家：注册→`GET /me`→开箱→仓库镜像→装配→配置槽/出战→AI validate/compile→对战→回放(403/410)→排位 run/promote→战绩/防守/未读→排行榜→快速对战 Elo；22 个检查点按 P7-7 §B1 顺序逐步打印真实响应；进程内起服务于随机端口，数据根用 `os.tmpdir()`，**不需要 `npm start`**） | 2026-09-16（P7-5） | ✅ 已实跑（`node scripts/e2e.js` = 22/22 检查点、退出码 0；测试版 `tests/integration/e2e-play.test.js` 纳入 `npm test`） |
| `npm run load-test -- --players 200` | **批量压测 / 完整性断言**（批量注册真实玩家 → 配齐出战配置与 AI → 先建池后匹配 → 并发排位与快速对战 → **7 条完整性断言**：journal 幂等 / 无半场战绩 / **积分守恒（逐场+全局恒等式且 `journal ΣΔ === 档案 ΣΔ`）** / 排行榜与档案一致 / 回放 LRU 不越界（淘汰→410、未知→404）/ **无 bot 参与（每场双方均可从注册表追溯）** / 无 5xx；报告写 `runtime/load-report.json`） | 2026-09-16（P7-6 / D-152） | ✅ 实测：50 人 550 场（46 场/秒）、200 人 2200 场（37 场/秒），0 5xx、7/7 断言通过 |
| `npm run cli -- ...` | 后端接口客户端（唯一"操作台"） | P0-8 | ⚠ 本轮未实跑（有 `tests/cli` 覆盖） |
| `node scripts/fe-spec-check.js` | 前端文档自检（C1–C9；`npm test` 已含同一函数） | P6 前端 | ⚠ 本轮未单独实跑（`npm test` 内含） |
| `node .audit/fe-samples.js` | 重采真实响应样本（`.audit/fe-samples.json`） | P6 前端 | ⚠ 本轮未实跑（**已入库**，见 `git ls-files`；快照字段扩充后**必须重采**，见 `docs/plan-p7-playable.md` §已知风险 4） |

## 开发流程

按 `docs/tasks.md` §5 的每批 10 步节拍执行；完整工作方式见 `docs/ai-handoff-prompt.md`。要点：

- 一次只做一批；每批一个 commit；每批独立审查（`docs/reviews/BXX.md`）
- **提交前必须更新任务清单（硬性规则）**：任何改动代码（`server/`、`cli/`、`shared/`、`scripts/`、`tests/`）的提交，必须在**同一提交内**更新 `docs/tasks.md`（批次勾选）与/或 `docs/progress.md`（当前状态），并在提交信息中写明批次号与实跑结果（`npm test` 用例数、`npm run gate` 结果）
- 该规则由机器强制：`npm run hooks:install` 安装 `.githooks/pre-commit`（改代码未改任务清单 → 直接拒绝提交；同时跑 `npm run check:docs`）与 `.githooks/pre-push`（推送前跑全量门禁）；CI（`.github/workflows/gate.yml`）同样跑门禁与文档检查。**手动等价命令**：`npm run check:docs`（D1–D6 文档↔实现一致性；也可单独跑 `node scripts/check-docs.js`）
- **每个阶段/新功能完成后必须做一次独立「代码级审查」并修复**（功能完整度 / 空实现与占位 / 冲突与重合 / 副作用回归），检查表见 `docs/tasks.md` §5.1 第 5 条与 `docs/plan-p7-playable.md` §0 第 7 条；**测试体系需同步审查冗余与缺口**（`docs/plan-p7-playable.md` §P7-7）
- 禁止通过放宽覆盖率阈值来通过门禁
- 接口先冻结到 `docs/interfaces.md`（P0-7 创建）再写实现
- 数值必须机器复算（示例/走查/黄金战斗），不靠手算
- 机制在代码、内容在表：新增技能/词条/节点 = 改 `server/data/*.json` 机制表，**不改解释器分支**；内容层表（角色/技能/插件/品质/掉落）当前标 `_sample: true` 属示例数据，正式内容由用户设计后冻结（详见 `server/data/README.md`）
- 前端按 `docs/frontend-spec.md` v3 的 F1–F7 批次走（**未开工**）；每批必跑 `node scripts/fe-spec-check.js`

## 已实测的环境约束

1. `node --test` 默认多进程 runner 在沙箱失败（`EPERM: spawn`）→ **必须** `--test-isolation=none`；测试文件用 `tests/**/*.test.js` glob（Node ≥21 自行展开；传目录会报 `ERR_UNSUPPORTED_DIR_IMPORT`）。
2. 脚本内部禁止 `child_process` → `scripts/gate.js` 单进程内联全部检查。
3. 空测试目录会**静默通过**（0 个用例 exit 0）→ 门禁第 7 项必须断言测试数 ≥ 1。
4. 命令 cwd 必须已存在且在 `F:\Game\Debug-lite` 内。
5. 修改中文文档**禁止**用 PowerShell 5.1 的 `Get-Content`/`Set-Content`（双重编码损坏风险）→ 用文件工具或 Node（UTF-8 无 BOM）。

## 目录结构（对齐 `tasks.md` §2.1 分层）

```
shared/log.js      零依赖 UMD（唯一跨层共享模块）→ P0-4
server/core/       rng field effects items roles skills bullets unlock engine（纯函数内核，禁 IO/console/Math.random）
server/ai/         ast.js runtime.js（AI 解释器，只依赖 L0/L1）
server/data/       数据表（role-templates / skill-templates / plugins / qualities / items-config / unlock / battle-config / skill-mechanics / affix-registry / ai-nodes / **service-config / rating-config**）+ schema.js
server/store/      【P7】存储层（唯一允许 `node:fs`）：原子写 / journal / 物化档案 / 索引 / 快照库 / 会话 / 适配器
server/{auth,account,quickmatch,admin}.js  【P7】账号会话 / 档案门面 / 快速对战 / 运维端点
server/index.js    /api/v1 HTTP 层（含 Bearer 鉴权中间件、回放 LRU、全局限速）→ P0-8 / P7-4
cli/index.js       命令行"操作台"（只走 HTTP）→ P0-8 / P7-4
scripts/           gate.js / check-arch.js / check-docs.js / demo.js / play.js / e2e.js / load-test.js / fe-spec-check.js / baseline.js
assets/            占位美术数据表 → P0-9
tests/             unit integration api cli log frontend regression（**`contract` 目前只有 `.gitkeep`——按用户决策不补空目录**；`property/` 含 `items-invariants.test.js`；2026-09-19 复核）
runtime/           【P7】运行时数据根（`DL_DATA_DIR` 默认此处；已 `.gitignore`，不入库）
```

## 阶段（2026-09-19 复核）

**当前状态**：后端 **P0–P5（34 批）+ P7 在线服务（B27–B33，7 批）= 41 批全部收口**。最后实测：`npm test` = **942 通过 / 0 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、`npm run check:docs` = PASS、`node scripts/fe-spec-check.js` = 9 PASS、`npm run e2e` = **22/22**、`npm run load-test -- --players 50 --deep` = **7/7 完整性断言**——**用例数与数字随并行改动会变，以当次输出为准**（`docs/progress.md` 是唯一状态源）。**P6 前端未开始**（main 上 0 行前端代码）。

| 阶段 | 内容 | 批次真值 | 状态 |
|---|---|---|---|
| P0 | 后端基建与契约 | 9 | ✅ 已完成 |
| P1 | 确定性内核 + 战斗逻辑 | 11 | ✅ 已完成 |
| P2 | 自定义 AI | 5 | ✅ 已完成 |
| P3 | 物品与插件连接 | 5 | ✅ 已完成 |
| P4 | 回放数据（`POST /battle` + `GET /replay/:id`） | 2 | ✅ 已完成 |
| P5 | 排位（B25 时为无存档口径，D-123） | 2 | ✅ 已完成 |
| — | 后端合计（P0–P5） | **34** | ✅ |
| P7 | 在线服务（账号/登录/档案/配置槽/战绩/排行榜/快速对战/异步排位/回放鉴权） | B27–B33（7） | ✅ **已完成（2026-09-19）**；D-129 部分推翻 D-123，见 `docs/reviews/B27.md`…`B33.md` |
| — | **后端合计（P0–P5 + P7）** | **41** | ✅ |
| P6 | 前端 | F1–F7 | ⏳ 未开始（仅 `docs/frontend-spec.md` v3 设计就绪） |

> 权威链现状：`docs/progress.md` 是唯一状态源；`docs/tasks.md` §6 的批次勾选与计数（**共 41 批**）与本表一致，由 `node scripts/check-docs.js`（D1–D6）机器核对。
> **验收/可玩入口**：`npm run play`（离线文本闭环，无需 `npm start`）、`npm run e2e`（联网全链路 22 检查点，随机端口 + 临时数据根）、`npm run load-test -- --players 50 --deep`（批量真实玩家 + 7 条完整性断言）、`npm run demo`。
> **P7 期间的已知残项**：`DL_STORE=sqlite` 适配器（预留，`open()` 抛 `store_adapter_unavailable`）、CLI `configs`/`records`/`defense`/`admin *` 子命令、`scripts/bench-store.js`（**未实现**，T-ST-8 容量哨兵无承载）、回放响应不含 `programHash`——逐条见 `docs/progress.md` 与 `docs/security-backlog.md`。（`POST /quick/run` 的"抽池 vs 实例化可用性判定不一致"已按 D-157 修复：`ranked.sideInstantiable` 统一判据。）

`legacy/` 是 v2 归档：只读参考，不修改、不复用其资源。