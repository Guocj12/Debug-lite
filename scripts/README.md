# scripts/

构建与门禁脚本（**单进程内联**，沙箱禁 `child_process`，见 `tasks.md` §1.2）。

| 文件 | 内容 | 批次 |
|---|---|---|
| `gate.js` | 9 项门禁（`tasks.md` §3.4），任一失败即非零退出 | P0-5 |
| `check-arch.js` | 架构依赖方向检查（反向/循环/core 越界） | P0-5 |
| `demo.js` | 跑一场战斗打印逐 tick 摘要；支持 `--log-level trace` | B11 |
| `play.js` | **离线可玩闭环**（`npm run play`）：开箱 → 合并仓库 → 自动装配 → 选 3 技能 → 内置预设 AI → 角色面板 → 打一场 → 逐 tick 战报（伤害/暴击/背击） | 可玩性（P6 前端之前） |
| `fe-spec-check.js` | 前端文档自检（`docs/frontend-spec.md` §14 的 C1–C9）：按钮↔动作表闭合、文档字段↔真实响应样本、取值↔后端实现、清单/通道规范 | P6 前端重设计 |
| `baseline.js` | 测试基线指纹（全量用例数 + 失败用例名 + `digest`）：`node scripts/baseline.js [--write\|--compare]`，并纳入 `gate` 项 7 明细 | P7-7 盲区 1（P0 ①） |

## `baseline.js` 契约（测试基线指纹，P7-7 审查 §⑤ 盲区 1）

- **定位**：把"任意一次全量测试结果"压缩成机器可读指纹，使**"红 1 条（自己改坏）"与"红 9 条（他人半写）"可区分**。此前只报"n 个用例失败（总 N）"，红成为常态后真正的回归会被淹没。
- **指纹结构**：`{ total, passed, failed, failedNames, suites, digest, generatedAt }`
  - `failedNames`：失败**叶用例**名的稳定全名 `<相对文件名> :: <用例名>`（去重 + 默认码元序排序，不依赖 locale）；
  - `digest`：`sha256(total + "\n" + failedNames.join("\n"))` 的十六进制前 12 位 —— **只吃 total + 失败名**，`generatedAt`/`suites`/`passed` 不进 digest，保证"同输入恒同指纹"。
- **采集方式**：`node:test` 的 `run()` API **本进程内**单进程执行 tests 目录下全部 `*.test.js`（`isolation:'none'`，与 `gate.js` 项 7 的 `runSuite` 同一做法）；**不 spawn 子进程、不解析 TAP/reporter 文本**。逐用例名直接取自 `test:pass`/`test:fail` 事件的 `data.name` + `data.file`。
- **套件口径（实测 Node v24.18.0）**：`describe`/`t.test` 的套件自己也会发一条 pass/fail 事件且 `details.type === 'suite'`；若不过滤，一个嵌套失败会被计成 2 条（叶 + 套件）。本文件**只计叶用例**，套件只累加 `suites`（用于解释与 gate 计数原口径的差值）。当前仓库 0 套件，两口径数值相同。
- **CLI**：
  | 命令 | 行为 | 退出码 |
  |---|---|---|
  | `node scripts/baseline.js` | 打印指纹 JSON + 一行摘要（`baseline: 545 tests / 6 failing [A、B…] digest=ab12cd34ef56`） | 0 |
  | `node scripts/baseline.js --write` | 采集并写入 `runtime/test-baseline.json`（`runtime/` 已 gitignore；目录不存在自动创建） | 0 |
  | `node scripts/baseline.js --compare` | 与 `runtime/test-baseline.json` 对比：**新增失败（回归）/ 已修复 / 总数变化 / digest 变化** | 无差异或仅"已修复"=0；**出现新增失败=1**；基线缺失/损坏=2 |
  | 用法错误（未知参数、`--write`+`--compare` 同时给、采集内部错误） | 打印用法/错误 | 3 |
- **可复用导出**（供 `gate` 与测试调用，零依赖、CommonJS）：`collectBaseline({projectRoot, files, runner})` / `fingerprintFromEvents(events, root)` / `buildFingerprint(partial)` / `compareBaseline(base, current)`（**纯函数**）/ `readBaseline(p)` / `writeBaseline(fp, p)` / `formatDetail(fp)` / `formatSummary(fp)`。
- **注入缝**：`collectBaseline` 的 `runner(files, projectRoot) → 事件数组` 可注入 —— 因同一进程内**第二次嵌套 `run()` 的流永不结束**（见本文件「已实测的 Node 覆盖率机制」第 3 条），测试套件内一律注入假事件流，绝不真实 `run()`；`runner` 默认 `collectEventsInProcess`。
- **与 gate 的关系**：`gate.js` 项 7 在**不改判定与阈值**的前提下，把指纹追加进明细（`基线 总 N / 通过 n / 失败 m；失败用例: …（截断 10 + 剩余计数）；digest=…`），PASS/FAIL 都打印。基线文件与判定无关（仅 `--compare` 有判定语义），故 `gate` 不依赖 `runtime/` 是否已 `--write`。
- **空匹配防护**：`tests/**` 下 0 个 `*.test.js` 时**拒绝生成指纹**（同 gate 项 7 的"用例数 ≥ 1"断言，防"0 用例基线"被静默写入）。
- **禁**：`child_process`、`Math.random`（确定性全部来自用例集合本身）；产物只写 `runtime/`。


## `fe-spec-check.js` 契约（P6 前端，独立脚本）

- **定位**：让前端文档**无法写完即过期**。前两轮前端失败的根因是文档与实现/真实响应脱节（字段名不存在、按钮无动作、动作无实现），本脚本把这三类变成机器可判定的 FAIL。
- **数据源**：`docs/frontend-spec.md` 的 ` ```json fe-spec-registry ` 注册表（唯一真相）+ `.audit/fe-samples.json`（活体响应样本，由 `node .audit/fe-samples.js` 生成）+ 后端源码（`core/unlock.js`、`ai/ast.js`、`core/engine.js`、`runner.js`、`box.js`、`shared/log.js`、数据表）。
- **C1–C9**：注册表可解析 / 按钮动作命中动作表 / 无僵尸动作 / 七屏 goto 可达 / 文档字段命中真实样本 / 取值与后端一致 / 文件清单一致 / 日志事件与通道规范 / 实现侧 data-action·data-id 命中注册表（`public/js` 落地后自动生效）。
- **与 gate 的关系**：**不进** `gate.js` 九项（gate 项 7 覆盖率目录为 `server/core|server/ai|shared|cli`，不含 `public/`）；由 `tests/frontend/fe-spec.test.js` 在 `npm test` 内断言（含 5 个投毒用例，防止检查空转）。
- **维护**：改前端文档/改后端取值 → 跑 `node scripts/fe-spec-check.js`；样本过期 → 重跑 `.audit/fe-samples.js`。

## `play.js` 契约（离线试玩闭环，`npm run play`）

- **定位**：在 P6 前端与 P7 服务端新系统（账号/存档/匹配）之前，让"零件齐备但不能玩"变成"一条命令能玩（文本版）"。**不新增任何服务端接口**，也不依赖服务端在跑。
- **流程**（每步打印在做什么）：开箱（`--boxes` 次，材料不足按同一 seed 流补齐）→ 合并进**内存**仓库（`items.emptyWarehouse` 语义，不依赖尚不存在的服务端仓库）→ 自动装配（`items.assemble`：槽位类型 + 段位门控 + 点数预算 + 插件唯一性；失败即跳过并说明原因）→ 选 3 个技能槽 → 内置预设 AI → 角色面板（五维/regen/special/技能参数）→ 打一场 → 逐 tick 战报 + 胜负。
- **动作名口径**：引擎只认 `skill:<sid>`；本脚本按出战槽位把技能命名为 `skill1/skill2/skill3`（与 `server/battle.js` 的 `buildPlayer` 同口径），预设 AI 因此发 `skill:skill1`。
- **内置预设 AI**（`--preset`，只使用 base 节点 + `if`，任意段位都能过 `ast.validate`；程序 `version: 2`＝当前版本）：
  | 预设 | 语义 |
  |---|---|
  | `steady`（稳健，默认） | 残血先防 → 拉近到中距 → 敌在背后则转身靠近 → 否则主技能开火 |
  | `aggressive`（激进） | 贴脸为主（gap>96 就靠近），近身交二技能 |
  | `kite`（风筝） | 太近拉开（槽位 3 是位移技就用位移，否则后撤）→ 太远靠近 → 射程内开火 |
- **参数**：`--seed`（默认 20260912，与 gate 项 8 黄金战斗同 seed）/ `--boxes`（默认 12，1..100）/ `--tier`（默认 mythic）/ `--preset` / `--quality`（装配选取的品质门槛，达标不足时回落并说明）/ `--out <file>` / `--help`。**只看不写**：除 `--out` 外不落盘（建议 `runtime/`，已 gitignore）。
- **对手**：`server/ranked.js` 的 `buildBotLoadout()`（均衡/common、无插件、直线逼近）——二选一中的 bot 方案，不改服务端接口。
- **战报**：逐 tick 行**复用 `cli/index.js` 导出的 `replayLine`**（与 `cli replay` 同一渲染，避免两套格式漂移），含碰撞、命中（`uid->目标@坐标->攻方->受方 伤害`）与无弹幕伤害（碰撞/附加真伤）；暴击/背击以 `(暴击×1.5 背击×1.5)` 标注（引擎 `critChance`/追尾背击触发时出现）。
- **铁律**：脚本内禁 `child_process` / `Math.random`（确定性全部来自 seed 派生的 rng 流）；零依赖。
- **与 CLI 的衔接**：`npm run play -- --out runtime/play-loadout.json` 的产物是 `{loadout, warehouse}`，可直接 `npm run cli -- battle --p1 runtime/play-loadout.json ...`（需先 `npm start`）。

---

# scripts/gate.js 契约（P0-5 冻结）

**单进程内联**：不 spawn 任何子进程。测试用 `node:test` 的 `run()` API 在**本进程内**执行（`isolation:'none'` + `coverage:true`）；覆盖率阈值由门禁**自行判定**（`run()` 不提供阈值选项，已实测）。输出 `[PASS]/[FAIL]/[PEND]` 表格；任一 `[FAIL]` → 退出码 1。

## 9 项检查

| # | 检查 | 规则 | 批次 |
|---|---|---|---|
| 1 | 静态：无 `Math.random`/`eval(`/`new Function`（T-DC-3） | 扫描 `server/core/**` + `server/ai/**`（先剥注释再匹配） | P0-5 ✅ 实时 |
| 2 | 静态：`server/core/**` 无 `console.*`（T-DC-5） | 同上剥注释 | P0-5 ✅ 实时 |
| 3 | 架构依赖（T-DC-4） | 调 `check-arch.js`（契约附后） | P0-5 ✅ 实时 |
| 4 | 数据表 schema（T-DC-1） | `server/data/schema.js` 存在则执行 `validateStructure`（结构 + 冻结数值 + 禁 `bulletSpeed`），否则 **PEND** | P0-6 ✅ 实时 |
| 5 | 文档↔数据一致性（T-DC-2）+ D 编号落点（T-DC-8） | 子 A（T-DC-8）：`docs/interfaces.md` 已建立时逐条 D-xx 落点；子 B（T-DC-2）：`server/data/schema.js` 存在时 `validateConsistency`（items-data 期望表逐条对齐）。状态 = fail > pend > pass | P0-6 激活子 B；P0-7 激活子 A |
| 6 | 日志事件命名（T-DC-6）+ 战斗数值未硬编码（T-DC-7） | ① 扫描 core/ai 的 logger 调用：通道必须在 `shared/log.js` 注册表、事件名 `^[a-z]+\.[a-z.]+$` 且首段符合通道前缀映射（§4.6 导出）；② 若 `battle-config.json` 存在：core/ai 源码中的数字字面量（剥注释/字符串）与配置数值相等 → FAIL（**行级豁免**：行尾 `// cl:<值>` 标注"通用精度常量、非战斗数值"，审查可见；token 边界 `(?<![\w.])(?![\w.])` 防标识符误报——B1/B3 实测调优）；配置缺失 → 该项 PEND | ① P0-5 ✅ 实时；② P0-6 激活 |
| 7 | 全量测试 + 覆盖率（n 个用例归属 §3.2） | 进程内 `run()` 跑 `tests/**/*.test.js`；**用例数 ≥ 1 否则 FAIL**（空匹配静默陷阱兜底）；覆盖率阈值按**每文件**判定，**仅限 `server/core` `server/ai` `shared` `cli` 四目录**：行 ≥90 / 分支 ≥85 / 函数 ≥90，任一低于 → FAIL | P0-5 ✅ 实时 |
| 8 | 日志冒烟（T-LG-11/T-LG-5） | `trace` 跑黄金战斗：关键事件齐备、cid 链路可追、与 `silent` 逐帧一致（lazy require 避开项 7 coverage 会话） | B11 ✅ 实时 |
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

**分层（按路径）**：`shared/*` L-1（唯一跨层共享）｜`server/data/*` 数据层（任何 server 模块可读）｜`server/core/{rng,field}` L0｜`server/core/{effects,items,unlock}` L1｜`server/core/{roles,skills,bullets}` L2｜`server/core/engine.js` L4｜`server/ai/*` L5｜`server/store/*` L6（存储层，D-129）｜`server/{index,ranked,runner,box,loadout,battle,auth,account,quickmatch,admin}.js` `cli/**` L6。

**规则**：
1. 依赖方向：模块只能依赖**同层或更低层** + `shared/log.js`（**唯一跨层共享单文件**，其它 shared/* 一律 unknown-layer）+ `server/data/*.json`（core/ai 不得依赖更高层：engine 不得 require `ai/*`（L5 由 server 层注入）、ai 不得 require `engine.js`/更高）。
2. core/ai（层 0~5）**禁止一切 bare require**（builtin 与三方，含 `fs http https express net child_process os path` 及任意 npm 包——黑名单仅影响报错措辞）；只允许相对路径（本层/低层/shared/log.js/data）。
3. 循环依赖：DFS 检测，每个环报一条后向边（含完整路径）。
4. `cli/**` 不得 require `server/core` / `server/ai`（L14：CLI 只走 HTTP）。
5. `tests/**` 不参与分层检查（可用一切）。
6. **L3 落地策略（登记）**：L3（items 仓库/装配层、skills 释放/canCast）与 L1/L2 共用同一文件，文件级分层取较低层；若未来 L3 专属逻辑需要跨层门控，再拆文件并登记新层号。
7. **`server/store/*` 存储层（L6，D-129 登记）**：与 `server/index.js` 同为 L6，可被 L6 依赖；**L0~L5 不得反向依赖它**（由规则 1 的 `依赖了更高层` 分支拦截，无需额外规则）。其专属约束（`store-forbidden` 违规）：
   - 外部模块**只允许** `node:fs` / `node:path` / `node:crypto`（本目录是唯一允许 `node:fs` 的目录，`11-account-store §3.1` 硬约束）；
   - **禁** `child_process` / `worker_threads` / `cluster` / `vm`（单进程为唯一支持形态，`11-account-store §1.3-6`）/ `http` / `https` / `net` / `express`；
   - **禁** `Math.random` / `eval(` / `new Function(`（D-92 铁律在 L6 同样成立；存储层的随机只用 `node:crypto`）。
   扫描根沿用 `SCAN_ROOTS = ['server','cli','shared']`（`server/store/**` 已被 `server` 根覆盖，无需单独登记）。

**实现要点**：require 用正则提取（`require('…')`），先剥注释；相对路径解析到真实文件后映射层号；外部模块（builtin/node_modules）不参加层比较与成环。core 里 `require('../data/x.json')` 与 `require('../../…/shared/log.js')` 放行。