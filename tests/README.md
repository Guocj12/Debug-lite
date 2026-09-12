# tests/

测试分层（`tasks.md` §3.1；每个用例归属 §3.2 测试点编号，L4）。

| 目录 | 内容 |
|---|---|
| `contract/` | 接口契约测试（先红后绿，L1/L7） |
| `unit/` | 模块单元测试 |
| `integration/` | 跨模块集成 |
| `regression/` | 硬回归：同种子一致 / runFull=逐tick / 64 tick 内结束 / 日志不改结果（B8 起常驻）+ 黄金战斗（B11，`golden-battle.test.js`） |
| `api/` | `/api/v1` 契约（T-AP-*，统一信封） |
| `cli/` | CLI 契约（T-CLI-*，退出码 0/1/2） |
| `property/` | 属性测试：插件 T-PB-1..10、AI T-AF-1..11（生成器 `helpers/gen.js`） |
| `log/` | 日志子系统（T-LG-*，录制器 `helpers/log.js`） |
| `fixtures/` | AI 程序夹具（`ai/*.json` + `expect/*.json`，覆盖型 + 病态型） |
| `helpers/` | 共享辅助：`gen.js`（种子化生成器）、`log.js`（录制 logger + 事件断言） |

- 命名 `*.test.js`；`npm test` 用 `tests/**/*.test.js` glob（node 自行展开，勿传目录）
- 全量必须单进程：`--test-isolation=none`（沙箱 EPERM 约束）