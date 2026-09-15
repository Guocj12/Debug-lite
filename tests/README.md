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
- **runner 注入特例（登记，P0-5）**：§3.3 只允许注入 rng/logger/只读快照，但门禁测试（`tests/integration/gate*.test.js`）注入**假 runner** 以规避"进程内第二次嵌套 run() 流永不结束"的 Node 缺陷（机制见 `scripts/README.md`）——注入的是 node:test 基建而不是被测模块，真实 `runSuite` 路径由 `npm run gate` 本体自验证

## 测试 runner 契约（P0-3 固化，已实测）

| 项 | 契约 | 实测 |
|---|---|---|
| 入口 | `npm test` ≡ `node --test --test-isolation=none tests/**/*.test.js` | ✅ v24.18.0 |
| 目录参数 | `node --test <目录>` 报 `ERR_UNSUPPORTED_DIR_IMPORT`，**禁用** | ✅ 已实测 |
| 失败退出码 | 任一用例失败 → 进程退出码 **1**（不静默通过） | ✅ 已实测 |
| 空匹配 | 无匹配文件 → 0 用例、退出码 0（**静默通过陷阱**；由 `scripts/gate.js` 第 7 项断言测试数 ≥ 1 兜底，P0-5） | ✅ 已实测 |
| 覆盖率 | `npm run cov` ≡ 上行 + `--experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=85 --test-coverage-functions=90`；CLI 阈值为**聚合**语义（全文件合计低于阈值 → 非零退出，P0-5 实测修正早前"每文件"表述）；**gate 项 7 为每文件语义**（仅 core/ai/shared/cli 四目录，任一文件低于阈值 → FAIL，更严格） | ✅ 已实测 |
| 无 spawn | runner 全程单进程，不 spawn 子进程 | ✅ 已实测 |
| 备用入口 | `node tests/run-all.js`（单进程 require 串联）——暂不实现，`node --test` 可用则不作冗余 | — |

## tests/helpers/gen.js 契约（P0-3 冻结）

种子化生成器，属性/统计测试共用；**零依赖、自包含**（与 `server/core/rng.js`（B1）相互独立，避免测试与被测实现共享随机实现；语义对齐 D-90/D-91 的概念）。

```js
const g = require('../helpers/gen.js');   // 或 require('./helpers/gen.js')
g.mulberry32(seed)        // → () => [0,1) 浮点流（标准 mulberry32 算法）
g.createGen(seed)         // → { float(lo=0,hi=1)[lo,hi) / int(lo,hi)闭区间均匀整数
                          //     / pick(arr)非空均匀取一（空数组抛错）
                          //     / chance(p)[0,1] 概率布尔
                          //     / shuffle(arr)Fisher–Yates 返回新数组
                          //     / deriveStream(tick,purpose) → 该派生流的新 createGen（对齐 D-91 每 tick 每用途派生） }
g.hash32(str)             // → uint32（deriveStream 的派生散列，fnv1a 变体）
```

- 确定性：同 seed 同调用序列 → 完全相同的序列（测试断言锁定）。
- `seed` 归一化为 uint32（`>>> 0`）；非法/缺失 seed 视为 0。
- 测试归属：`tests/helpers/gen.test.js`（在仓库内自证契约）。