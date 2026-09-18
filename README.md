# Debug-Lite v3

「编程式自动对战」游戏后端。玩家为角色编写 AI 逻辑（JSON AST），服务器逐 tick 确定性模拟自动战斗；强度来自开箱得到的角色/技能模板与插件。本轮开发范围：**P0–P5 全部后端**（P6 前端延后）。

## 文档权威链

```
docs/decisions.md      决策记录（D-01…D-136）← 最高权威（D-129…D-136 为 P7 计划决策，代码未实现）
docs/systems/01~10.md  各系统实现细则（`11-account-store.md` 为**计划中 P7 设计**，未实现）
docs/v3-design.md      主设计文档（架构/数据模型/数值）
docs/items-data.md     物品数值、名称、贴图占位
docs/tasks.md          开发计划（铁律/接口/测试矩阵/批次/门禁）
docs/examples/         分支示例集（10 系统 + 索引），计算细节的唯一出处
docs/battle-walkthrough.md  端到端走查（系统间数值与状态传递）
docs/interfaces.md     接口冻结（P0-7 创建）
docs/progress.md       当前状态与下一步
docs/ai-handoff-prompt.md   实现期交接提示词
docs/frontend-spec.md   **前端设计 v3（可玩优先）**：按钮→动作→数据三重契约 + 七屏逐屏按钮表 + 真实响应样本附录
scripts/fe-spec-check.js    前端文档自检器（C1–C9；`npm test` 内断言，含投毒用例）
.audit/fe-samples.js    真实响应样本采集器（前端字段名的唯一依据；不进 gate）
```

冲突处理：`decisions.md` > `systems/*` > `v3-design.md` > `tasks.md`；发现矛盾先停下来问，不自行选一个继续。

## 现状与计划的显式分界（2026-09-16 复核）

以下条目是"已实测事实"，与"计划中"严格分开；凡标注「计划中」的内容**当前不可用**：

| 主题 | 现状（已实测） | 计划中（未实现） |
|---|---|---|
| 分支 | `main`（HEAD `cee2ebf`）为唯一主线，已完成合流；另有 `deepseek-v4.1f`、`glm-5.3f` 两个前端分支未合并。**`dev` 分支不存在** | — |
| 后端 | P0–P5 全部收口，34 批（9+11+5+5+2+2） | — |
| 前端 | **main 上没有任何前端代码**（无 `public/`，`server/index.js` 无静态托管路由） | P6（F1–F7，见 `docs/frontend-spec.md`） |
| 在线服务 | 无账号/登录/档案/配置槽/战绩/排行榜/快速对战/异步排位/非对称 Elo/回放鉴权 | P7（B27–B33，设计见 `docs/systems/11-account-store.md`） |
| 回放 | `server/battle.js` 的**进程内无上限 Map**（每场 7–20 KB，无淘汰、无鉴权，未知 id → 404）；重启即失 | D-135 的"只存引用 / 按需重算 / 64 场 LRU / 鉴权 / 410" |
| `server.md` 所列 P7 环境变量与端点 | 代码只读 `DL_PORT` / `DL_HOST` / `DL_LOG_LEVEL` | 其余变量与 `/auth/*`、`/me*`、`/quick/*`、`/leaderboard`、`/admin/*` 全部未接线 |

## 环境要求

- Node `>=24.18.0`（`package.json engines`）、npm `>=11.16.0`（已实测）
- **零运行时依赖**（2026-09-16 复核）：HTTP 层用 `node:http`，`package.json` 无 `dependencies`；`express` 历史上列在白名单但**从未引入**。测试与日志同样零依赖（`node:test` + 自研 `shared/log.js`）。前端依赖仅在 P6（未开始）才需要考虑

## 命令

| 命令 | 用途 | 落地批次 | 复核状态（2026-09-16） |
|---|---|---|---|
| `npm start` | 启动 HTTP 服务（`/api/v1`） | P0-8 | ⚠ 本轮未实跑（9 号门禁项有同进程等价冒烟） |
| `npm test` | 单进程全量测试 | P0-3 固化 | ✅ 实跑 **484 通过 / 0 失败** |
| `npm run cov` | 全量测试 + 覆盖率阈值（行 ≥90 / 分支 ≥85 / 函数 ≥90） | P0-3 固化 | ✅ 实跑通过（阈值同时由 `gate` 项 7 逐文件判定） |
| `npm run gate` | 全量门禁（9 项，任一失败即非零退出） | P0-5 | ✅ 实跑 **9 PASS / 0 FAIL / 0 PEND** |
| `npm run check:docs` | 文档 ↔ 实现一致性检查（D1–D6；接入 CI 与 pre-commit） | 2026-09-16 | ✅ 实跑 PASS |
| `npm run hooks:install` | 安装 git 钩子（`core.hooksPath=.githooks`，一次性） | 2026-09-16 | ✅ 已安装 |
| `npm run demo` | 跑一场并打印逐 tick 摘要（数据表示例模板实例化） | B11 | ✅ 已补齐 `scripts/demo.js` 并实跑 |
| `npm run demo:log` | 同上，`trace` 级（等价 `DL_LOG_LEVEL=trace`） | B11 | ✅ 同上（`--log-level trace`） |
| `npm run cli -- ...` | 后端接口客户端（唯一"操作台"） | P0-8 | ⚠ 本轮未实跑（有 `tests/cli` 覆盖） |
| `node scripts/fe-spec-check.js` | 前端文档自检（C1–C9；`npm test` 已含同一函数） | P6 前端 | ⚠ 本轮未单独实跑（`npm test` 内含） |
| `node .audit/fe-samples.js` | 重采真实响应样本（`.audit/fe-samples.json`） | P6 前端 | ⚠ 本轮未实跑（脚本未入库，见 `git status`） |

## 开发流程

按 `docs/tasks.md` §5 的每批 10 步节拍执行；完整工作方式见 `docs/ai-handoff-prompt.md`。要点：

- 一次只做一批；每批一个 commit；每批独立审查（`docs/reviews/BXX.md`）
- **提交前必须更新任务清单（硬性规则）**：任何改动代码（`server/`、`cli/`、`shared/`、`scripts/`、`tests/`）的提交，必须在**同一提交内**更新 `docs/tasks.md`（批次勾选）与/或 `docs/progress.md`（当前状态），并在提交信息中写明批次号与实跑结果（`npm test` 用例数、`npm run gate` 结果）
- 该规则由机器强制：`npm run hooks:install` 安装 `.githooks/pre-commit`（改代码未改任务清单 → 直接拒绝提交；同时跑 `npm run check:docs`）与 `.githooks/pre-push`（推送前跑全量门禁）；CI（`.github/workflows/gate.yml`）同样跑门禁与文档检查
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
server/data/       数据表（role-templates / skill-templates / plugins / qualities / items-config / unlock / battle-config）+ schema.js
server/index.js    /api/v1 HTTP 层 → P0-8
cli/index.js       命令行"操作台"（只走 HTTP）→ P0-8
scripts/           gate.js / check-arch.js / demo.js
assets/            占位美术数据表 → P0-9
tests/             unit integration api cli log fixtures helpers（**contract / property / regression 三层目前只有 `.gitkeep`，无测试文件**——2026-09-16 复核）
```

## 阶段（2026-09-16 复核）

**当前状态**：后端 P0–P5 全部收口，批次真值 = **34** 批（9+11+5+5+2+2）；`npm test` = 484 通过 / 0 失败；`npm run gate` = 9 PASS / 0 FAIL / 0 PEND。P6 前端与 P7 在线服务均未开始。

| 阶段 | 内容 | 批次真值 | 状态 |
|---|---|---|---|
| P0 | 后端基建与契约 | 9 | ✅ 已完成 |
| P1 | 确定性内核 + 战斗逻辑 | 11 | ✅ 已完成 |
| P2 | 自定义 AI | 5 | ✅ 已完成 |
| P3 | 物品与插件连接 | 5 | ✅ 已完成 |
| P4 | 回放数据（`POST /battle` + `GET /replay/:id`，进程内注册表） | 2 | ✅ 已完成 |
| P5 | 排位（2 批；无存档，D-123） | 2 | ✅ 已完成 |
| — | 后端合计 | **34** | ✅ |
| P6 | 前端 | F1–F7 | ⏳ 未开始（仅 `docs/frontend-spec.md` v3 设计就绪；main 上**无任何前端代码**） |
| P7 | 在线服务（账号/登录/配置槽/战绩/排行榜/快速对战/异步排位/回放鉴权） | B27–B33 | ⏳ **仅设计（`docs/systems/11-account-store.md`），代码 0 行** |

> 权威链现状：`docs/progress.md` 是唯一状态源；`docs/tasks.md` §6 的批次勾选与计数值（其头部写"共 35 批"）与上表口径不一致，以本表与 `progress.md` 为准，`tasks.md` 的修正不在本轮范围内。

`legacy/` 是 v2 归档：只读参考，不修改、不复用其资源。