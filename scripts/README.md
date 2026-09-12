# scripts/

构建与门禁脚本（**单进程内联**，沙箱禁 `child_process`，见 `tasks.md` §1.2）。

| 文件 | 内容 | 批次 |
|---|---|---|
| `gate.js` | 9 项门禁（`tasks.md` §3.4），任一失败即非零退出 | P0-5 |
| `check-arch.js` | 架构依赖方向检查（反向/循环/core 越界） | P0-5 |
| `demo.js` | 跑一场战斗打印逐 tick 摘要；支持 `--log-level trace` | B11 |

---

# scripts/gate.js 契约（P0-5 冻结）

**单进程内联**：不 spawn 任何子进程。测试用 `node:test` 的 `run()` API 在**本进程内**执行（`isolation:'none'` + `coverage:true`）；覆盖率阈值由门禁**自行判定**（`run()` 不提供阈值选项，已实测）。输出 `[PASS]/[FAIL]/[PEND]` 表格；任一 `[FAIL]` → 退出码 1。

## 9 项检查

| # | 检查 | 规则 | 批次 |
|---|---|---|---|
| 1 | 静态：无 `Math.random`/`eval(`/`new Function`（T-DC-3） | 扫描 `server/core/**` + `server/ai/**`（先剥注释再匹配） | P0-5 ✅ 实时 |
| 2 | 静态：`server/core/**` 无 `console.*`（T-DC-5） | 同上剥注释 | P0-5 ✅ 实时 |
| 3 | 架构依赖（T-DC-4） | 调 `check-arch.js`（契约附后） | P0-5 ✅ 实时 |
| 4 | 数据表 schema（T-DC-1） | `server/data/schema.js` 存在则执行校验，否则 **PEND** | P0-6 激活 |
| 5 | 文档↔数据一致性（T-DC-2）+ D 编号落点（T-DC-8） | **本项只实现 T-DC-8**（D-xx 落点检查）；激活条件 = `docs/interfaces.md` 已建立（**P0-7 对齐**）。**T-DC-2（数据表 ↔ `items-data.md` 逐条对齐）未在本项实现，登记为 P0-6 必做**（P0-5 审查 P1-1） | P0-7 激活（T-DC-2 随 P0-6 接线） |
| 6 | 日志事件命名（T-DC-6）+ 战斗数值未硬编码（T-DC-7） | ① 扫描 core/ai 的 logger 调用：通道必须在 `shared/log.js` 注册表、事件名 `^[a-z]+\.[a-z.]+$` 且首段符合通道前缀映射（§4.6 导出）；② 若 `battle-config.json` 存在：core/ai 源码中的数字字面量（剥注释/字符串）与配置数值相等 → FAIL；配置缺失 → 该项 PEND | ① P0-5 ✅ 实时；② P0-6 激活 |
| 7 | 全量测试 + 覆盖率（n 个用例归属 §3.2） | 进程内 `run()` 跑 `tests/**/*.test.js`；**用例数 ≥ 1 否则 FAIL**（空匹配静默陷阱兜底）；覆盖率阈值按**每文件**判定，**仅限 `server/core` `server/ai` `shared` `cli` 四目录**：行 ≥90 / 分支 ≥85 / 函数 ≥90，任一低于 → FAIL | P0-5 ✅ 实时 |
| 8 | 日志冒烟（T-LG-11/T-LG-5） | `trace` 跑一场：关键事件齐备、cid 链路可追、与 `silent` 逐帧一致 | B11 激活（此前 PEND） |
| 9 | 接口冒烟（T-AP-*/T-CLI-1/T-CLI-2） | 同进程 `listen(0)` → `/api/v1` 关键端点 → CLI 闭环 | P0-8 激活（此前 PEND） |

> **PEND 语义**：前置产物（数据表/引擎/服务端）按批次表在后续批次落地，落地前该检查无物可查，报告为 PEND（不阻塞、不伪造通过——代码已接线，前置一出现即自动执行）。P0-5 完成时：1/2/3/6①/7 实时生效，4/5/6②/8/9 接线待激活。

## 已实测的 Node 覆盖率机制（务必遵守，勿重复踩）

1. **`--test-coverage-*` CLI 阈值是聚合语义**（全文件合计），不是每文件；门禁项 7 自己实现**每文件**判定（仅四目录）。
2. **V8 precise coverage 只统计会话开始之后加载的脚本**：门禁进程若在项 7 之前 require 过 `shared/log.js`，其覆盖率会永久残缺（实测 47.8~77.6%）→ gate.js 已做两点配合：①`shared/log.js` 改为**懒加载**（`channelRegistry()`）；②**项 7 最先执行**（执行顺序 7,1,2,3,4,5,6,8,9，输出顺序与执行顺序一致）。
3. **同一进程内第二次嵌套 `run()` 的流永不结束**（测试能跑，for-await 收不到结束事件，与 coverage 无关）→ 每进程最多一次真实 `run()`；测试套件一律注入假 runner。
4. **覆盖率会话活动中执行嵌套 run() 会破坏外层覆盖率数据** → 套件内禁止任何嵌套 run()；`runSuite` 真实路径由 `npm run gate` 本体自验证。
5. （P0-3 遗留项）`npm run cov` 空匹配时 0 用例 vacuous 通过 → 空目录陷阱由 gate 项 7 的"用例数 ≥ 1"断言兜底。

## 通道→事件前缀映射（项 6①，§4.6 导出）

| 通道 | 允许的事件首段 |
|---|---|
| rng / field / effects / items / roles / skills / bullets / unlock / api / cli / ranked / log | 同名单数（`bullet.*`、`skill.*`、`effect.*`、`item.*`…） |
| engine | `tick` `battle` `move` `collision` `resource` `action` |
| damage | `damage` |
| ai.ast / ai.runtime | `ai`、`trace`（§4.6 冻结了 ai.runtime 上的 `trace.truncated`） |
| store / view / render / editor / perf | 同名（P6 保留） |

事件名整体须匹配 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`（至少一段点）。

---

# scripts/check-arch.js 契约（P0-5 冻结，§2.1 分层）

`analyze({projectRoot})` → `{violations: [{file, rule, detail}], files: n}`；`main` 对仓库实跑，任一违例 → 退出码 1。

**分层（按路径）**：`shared/*` L-1（唯一跨层共享）｜`server/data/*` 数据层（任何 server 模块可读）｜`server/core/{rng,field}` L0｜`server/core/{effects,items,unlock}` L1｜`server/core/{roles,skills,bullets}` L2｜`server/core/engine.js` L4｜`server/ai/*` L5｜`server/{index,ranked}.js` `cli/**` L6。

**规则**：
1. 依赖方向：模块只能依赖**同层或更低层** + `shared/log.js`（**唯一跨层共享单文件**，其它 shared/* 一律 unknown-layer）+ `server/data/*.json`（core/ai 不得依赖更高层：engine 不得 require `ai/*`（L5 由 server 层注入）、ai 不得 require `engine.js`/更高）。
2. core/ai（层 0~5）**禁止一切 bare require**（builtin 与三方，含 `fs http https express net child_process os path` 及任意 npm 包——黑名单仅影响报错措辞）；只允许相对路径（本层/低层/shared/log.js/data）。
3. 循环依赖：DFS 检测，每个环报一条后向边（含完整路径）。
4. `cli/**` 不得 require `server/core` / `server/ai`（L14：CLI 只走 HTTP）。
5. `tests/**` 不参与分层检查（可用一切）。
6. **L3 落地策略（登记）**：L3（items 仓库/装配层、skills 释放/canCast）与 L1/L2 共用同一文件，文件级分层取较低层；若未来 L3 专属逻辑需要跨层门控，再拆文件并登记新层号。

**实现要点**：require 用正则提取（`require('…')`），先剥注释；相对路径解析到真实文件后映射层号；外部模块（builtin/node_modules）不参加层比较与成环。core 里 `require('../data/x.json')` 与 `require('../../…/shared/log.js')` 放行。