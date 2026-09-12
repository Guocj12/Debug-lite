# Debug-Lite v3

「编程式自动对战」游戏后端。玩家为角色编写 AI 逻辑（JSON AST），服务器逐 tick 确定性模拟自动战斗；强度来自开箱得到的角色/技能模板与插件。本轮开发范围：**P0–P5 全部后端**（P6 前端延后）。

## 文档权威链

```
docs/decisions.md      决策记录（D-01…D-126）← 最高权威
docs/systems/01~10.md  各系统实现细则
docs/v3-design.md      主设计文档（架构/数据模型/数值）
docs/items-data.md     物品数值、名称、贴图占位
docs/tasks.md          开发计划（铁律/接口/测试矩阵/批次/门禁）
docs/examples/         分支示例集（10 系统 + 索引），计算细节的唯一出处
docs/battle-walkthrough.md  端到端走查（系统间数值与状态传递）
docs/interfaces.md     接口冻结（P0-7 创建）
docs/progress.md       当前状态与下一步
docs/ai-handoff-prompt.md   实现期交接提示词
```

冲突处理：`decisions.md` > `systems/*` > `v3-design.md` > `tasks.md`；发现矛盾先停下来问，不自行选一个继续。

## 环境要求

- Node `>=24.18.0`、npm `>=11.16.0`（已实测）
- 依赖白名单：`express`（P0-8 起）。测试与日志零依赖（`node:test` + 自研 `shared/log.js`）

## 命令

| 命令 | 用途 | 落地批次 |
|---|---|---|
| `npm start` | 启动 HTTP 服务（`/api/v1`） | P0-8 |
| `npm test` | 单进程全量测试 | P0-3 固化 |
| `npm run cov` | 全量测试 + 覆盖率阈值（行 ≥90 / 分支 ≥85 / 函数 ≥90） | P0-3 固化 |
| `npm run gate` | 全量门禁（9 项，任一失败即非零退出） | P0-5 |
| `npm run demo` | 跑一场并打印逐 tick 摘要 | B11 |
| `npm run demo:log` | 同上，`trace` 级（等价 `DL_LOG_LEVEL=trace`） | B11 |
| `npm run cli -- ...` | 后端接口客户端（唯一"操作台"） | P0-8 |

## 开发流程

按 `docs/tasks.md` §5 的每批 10 步节拍执行；完整工作方式见 `docs/ai-handoff-prompt.md`。要点：

- 一次只做一批；每批一个 commit；每批独立审查（`docs/reviews/BXX.md`）
- 接口先冻结到 `docs/interfaces.md`（P0-7 创建）再写实现
- 数值必须机器复算（示例/走查/黄金战斗），不靠手算
- 战斗数值全部来自数据表（`server/data/*.json`），禁止硬编码

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
tests/             contract unit integration regression api cli property log fixtures helpers
```

## 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 后端基建与契约（9 批） | 进行中 |
| P1 | 确定性内核 + 战斗逻辑（11 批） | 未开始 |
| P2 | 自定义 AI（5 批） | 未开始 |
| P3 | 物品与插件连接（5 批） | 未开始 |
| P4 | 回放数据（2 批） | 未开始 |
| P5 | 排位（2 批；无存档，D-123） | 未开始 |
| P6 | 前端（延后） | 未开始 |

`legacy/` 是 v2 归档：只读参考，不修改、不复用其资源。