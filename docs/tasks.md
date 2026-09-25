# Debug-Lite v3 开发计划与任务清单

> 版本：v3-plan-6　更新：2026-09-16
> 定位：**本文件是唯一的开发计划来源**（阶段 / 批次 / 门禁 / 验收）。
> 依据：`docs/decisions.md`（**最高权威**）、`docs/v3-design.md`、`docs/items-data.md`、`docs/systems/01~10`。
> 状态图例：`[ ]` 未开始　`[~]` 进行中　`[x]` 已完成　`[!]` 阻塞

---

## 0. 铁律（本轮开发的硬约束）

> 上一轮失败复盘：**前端界面混乱、测试敷衍、代码未经审查、无法确定 bug、极难维护**。

| # | 铁律 | 对治的失败原因 |
|---|---|---|
| L1 | **先冻结接口，再写实现。** 每批接口先落到 `docs/interfaces.md`（唯一权威），再写骨架与契约测试，最后写实现 | 接口/结构混乱 |
| L2 | **每批一个 commit。** 禁止跨批次/跨模块混提；未过门禁不得进 `main` | 极难维护 |
| L3 | **每批全量测试。** 每批结束必须跑 `npm run gate` 并全绿 | 测试敷衍 |
| L4 | **测试可追溯到文档。** 每个用例归属 `§3.2` 的测试点编号 | 测试敷衍 |
| L5 | **禁止敷衍测试。** 见 `§3.3` 黑名单；审查逐条核对 | 测试敷衍、无法确定 bug |
| L6 | **每批独立审查。** 独立上下文审查者（干净 prompt + 本批 diff + 相关文档）产出 `docs/reviews/BXX.md` | 代码未经审查 |
| L7 | **先红后绿。** bug 修复必须先有可复现的失败用例 | 无法确定 bug |
| L8 | **接口改动 = 事件。** B8 前只允许新增接口；之后任何签名/结构变更走 `§10` + 全量回归 | 返工 |
| L9 | **机制在代码、数值在表。** 战斗数值全部来自 `battle-config.json` 等数据表 | 返工 |
| L10 | **三处一致。** `decisions.md` ↔ 设计文档 ↔ `server/data/*.json` ↔ 代码 由自动检查保证 | 数据与文档对不上 |
| L11 | **纯函数内核。** `server/core/**` 禁止 IO / `Math.random` / `eval` / `console.*`；随机与日志一律**注入** | 无法确定 bug |
| L12 | **全行为可观测。** 每次计算、模块间数据传递、每次 API/CLI 调用都有**分级结构化日志**；日志是合同（有矩阵、有断言）；**日志不得影响确定性** | 无法确定 bug、极难维护 |
| L13 | **日志与业务同批交付。** 新增计算路径/跨模块调用/接口必须同批补日志与断言 | 极难维护 |
| L14 | **接口自足（后端优先）。** 新增能力必须能通过 `/api/v1` 或 CLI 触达，否则视为未完成 | 前端界面混乱（先解耦） |
| L15 | **契约面向未来的 UI。** API 与回放帧按"将来要被界面消费"冻结（含 1px 位置、碰撞位置、cid）；本轮不实现 UI | 返工 |
| L16 | **战斗链路可追溯。** 同一次因果（释放→弹幕→碰撞→命中→伤害→效果）用统一 `cid` 串起来 | 无法确定 bug |
| L17 | **文档写入工具纪律。** 修改文档一律用文件工具或 Node（UTF-8 无 BOM）；**禁止用 Windows PowerShell 5.1 的 `Get-Content`/`Set-Content` 读写中文文档**（曾导致整文件双重编码损坏） | 极难维护 |

---

## 1. 技术基线与实测约束

### 1.1 环境（已实测）

- Node `v24.18.0`、npm `11.16.0`；工作区 `F:\Game\Debug-lite`。
- 依赖白名单：`express`（P0）。测试与日志**零依赖**（`node:test` + 自研 `shared/log.js`）。
- 前端依赖（`blockly`）P6 才安装。不使用 v2 美术/音乐资源；美术占位本轮仅作**数据表**。

### 1.2 沙箱约束（实测，决定测试基建形态）

1. **`node --test` 默认多进程 runner 失败**（子进程 + 管道 stdio → `EPERM: spawn`）→ 必须用 **`--test-isolation=none`（单进程）**，已实测通过。
2. 单进程 `require` 入口（`node tests/run-all.js`）可用，作备用。
3. 失败用例退出码为 `1`（带/不带覆盖率均是），门禁不会静默通过。
4. `npm run <script>` 可用，但**脚本内部禁止 spawn 子进程** → `scripts/gate.js` 单进程内联。
5. 命令 cwd 必须已存在且在会话工作区内。

### 1.3 命令（P0 落地）

```bash
npm start / npm test / npm run cov / npm run gate
npm run demo        # 跑一场并打印逐 tick 摘要（`scripts/demo.js` 已落地；默认 seed 20260912，与 gate 项 8 黄金战斗同源）
npm run demo:log    # trace 级
npm run cli -- ...  # 后端接口客户端（唯一"操作台"）
```
- 日志级别：PowerShell `$env:DL_LOG_LEVEL='trace'; npm run demo`。
- **P0-3 必须实测固化**：单进程、覆盖率阈值生效、失败退出码非零、无 spawn、日志开关生效。

---

## 2. 接口冻结（ICD）与架构约束

### 2.1 依赖分层（单向，禁止反向与循环）

```
L-1 shared/log.js     零依赖 UMD：唯一允许的跨层共享模块
L0  rng · field
L1  effects · items(数值层) · unlock
L2  roles · skills(实例化/插件) · bullets
L3  items(仓库/装配层) · skills(释放/canCast)
L4  engine            ← 唯一编排者
L5  ai/ast · ai/runtime      ← 只依赖 L0/L1，不依赖 engine
L6  server/index.js (/api/v1) · server/runner.js (AI 编排) · server/box.js (开箱编排) · server/loadout.js (出战/面板编排) · server/battle.js (对战/回放编排) · cli/
L7  public/**（P6）
```
- `scripts/check-arch.js`：反向依赖、循环依赖、core 引用 `express/fs/http`、`shared/log.js` 之外的跨层共享 → 失败。

### 2.2 模块接口清单（ICD 摘要；明细在 `docs/interfaces.md`）

| 模块 | 接口 |
|---|---|
| `shared/log.js` | `createLogger` / `nullLogger` / `LEVELS`；logger：`on` / `log` / `fatal..trace` / `setLevel` / `setChannelLevel` / `reset` / `dump` / `records` |
| `core/rng.js` | `createRng(seed,{logger})`；`float/int/pick/chance(...,purpose)`、`state/restore`；**`deriveStream(seed, tick, purpose)`**（D-91） |
| `core/field.js` | `FIELD_PX/CELL_PX/ACTOR_HALF/START_X/START_FACING/BASE_DEF`；`clampX` / `cellOf` / `cellRange` / `baseOf` / `touchesBase` |
| `core/effects.js` | `addEffect` / `resolveContinuous` / `resolveControl` |
| `core/items.js`（数值） | `getQuality` / `rollQuality` / `rollSlotCount` / `tierOf` / `generateRoleItem` / `generateSkillItem` / `generatePlugin` / `openBox` / `applyAffixes` / `validateUnlock` |
| `core/items.js`（仓库） | `createWarehouse` / `addItem` / `assemble` / `disassemble` / `buildLoadout` / 序列化往返 |
| `core/roles.js` | `instantiateRole` / `applyTypeModifier` / `equipPlugins` / `getFinalStats` |
| `core/skills.js` | `instantiateSkill` / `applySkillPlugins`（词条 `skillOp` 解释器 → `cost/参数/specials/castEffects/affixes`）/ `canCast` / `buildSkillAction`（发射 `pattern` 解释器）/ `coveredCellRanges` |
| `core/bullets.js` | `spawn` / `resolveAll(bullets, actors, config)`（**当 tick 全解算**）/ `collideAt`（连续方程）/ 等级比较 |
| `core/engine.js` | `createBattle(config)`（`config.logger` 注入）；battle：`step/runFull/judge/state`；`dealDamage`；`normalizeAction`（行动集含 **`turn`**）；`resolveActorCollision` |
| `core/unlock.js` | `tierIndex` / `isUnlocked` / `filterByTier` / `validateLoadout` / `availableNodes`（**只返回真实节点类型**；`validateAi` 于 B13 退役） |
| `ai/ast.js` | `validateProgram`（含**字段枚举校验**）/ `checkLegality`（**分支 action 规则 D-101 + call 行动产出定点分析**）/ `collectUsedNodeTypes` / `canonicalize` / `programHash` / `nodePathOf` / `limits` |
| `ai/runtime.js` | `createContext` / `resume(ctx,snapshot,rng)` / `serializeContext`（`frames[].path/fnScope` + 三个 limit + `traceTruncated`）/ `restoreContext` / `destroyContext` / `STEP_LIMIT` |
| 数据表（机制层，2026-09-16 新增） | `server/data/skill-mechanics.json`（技能类型机制：params/slots/emit pattern）/ `affix-registry.json`（词条语义：agg/skillOp/hitEffect/castEffect）/ `ai-nodes.json`（AI 真实节点 + `base` + `actions` 词汇表，单一数据源） |
| `server/index.js` | §2.3 |
| `cli/index.js` | §2.4 |

**日志注入**：参与战斗/生成/AI 执行的公开函数通过 options 接收 `logger`（缺省 `nullLogger`）；`engine` 向下透传。core 内不得 `require` sink、不得 IO。

### 2.3 HTTP API 契约 `/api/v1`（冻结；未来 UI 的唯一数据来源）

| 方法 | 路径 | 用途 | 主要错误码 |
|---|---|---|---|
| GET | `/api/v1/health` | 存活与版本 | — |
| GET | `/api/v1/data/:table` | 数据表（含 `battle-config`） | 404 `unknown_table` |
| GET | `/api/v1/unlock?tier=` | 该段位可用节点/模板/技能 | 400 `bad_tier` |
| POST | `/api/v1/box` | 开箱（seed/tier/次数）**D-162：无 `seed` 入参**（客户端传了被忽略），seed 服务端生成；**不入档** | 400 / 409 `tier_locked` |
| GET | `/api/v1/warehouse` | 仓库（分桶 + 装配状态） | — |
| POST | `/api/v1/warehouse/assemble` | 装配 | 409 `slot_type_mismatch` / `points_exceeded` / `slot_occupied` / `tier_locked` / `plugin_equipped` / `item_missing` |
| POST | `/api/v1/warehouse/disassemble` | 拆卸 | 404 `slot_empty` / `plugin_missing` |
| GET/POST | `/api/v1/loadout` | 读取/保存出战配置（**无持久化，P5/D-123**） | 409 `loadout_invalid` |
| POST | `/api/v1/panel` | 最终面板（五维/regen/special/技能参数） | 409 |
| POST | `/api/v1/ai/validate` | 静态校验 + 合法性 + 门控；错误带**节点路径** | 400 `ai_invalid` |
| POST | `/api/v1/ai/compile` | 规范化 + `programHash` + 统计（节点数/深度/用到的节点集） | 400 `ai_too_large` |
| POST | `/api/v1/ai/battle` | 用给定 AI 程序跑一场 | 400 / 409 |
| POST | `/api/v1/battle` | 双方 loadout + AI + seed → **完整回放帧（1px 位置 + 碰撞位置）** | 409 |
| GET | `/api/v1/replay/:id` | 取回放帧（`?from=&to=` 分片） | 404 |
| POST | `/api/v1/ranked/run` | 排位：服务端抽 10 场同段位快照 + **双向记账**（P7/B31，D-132）；池不足如实回报 `shortfall` 字段 | 400 `pool_forbidden` / 409 `no_active_config` / 401 |
| POST | `/api/v1/ranked/promote` | 晋升 + 段位奖励（读档案） | 409 `already_max` |
| POST | `/api/v1/auth/register` \| `login` \| `logout` \| `password` | 账号与会话（P7/B28，D-129） | 401 / 409 `username_taken` / 429 |
| GET | `/api/v1/me` | 档案摘要（段位/积分/未读/槽位） | 401 |
| GET/POST/PUT/DELETE | `/api/v1/me/configs[/:slotId]`（+`/activate`） | 配置槽 CRUD（≤3、唯一出战，P7/B29，D-131）；**D-160**：注册即建满 3 槽（`slot2`/`slot3` 空槽）、非出战槽允许不完整（不冻结快照）、`activate` 才校验完整性、新建槽 = 空槽 | 409 `slot_limit` / `slot_locked` / `config_conflict` / `cannot_activate_incomplete` |
| GET | `/api/v1/me/records` \| `/api/v1/me/defense` | 战绩与**防守战绩**（被抽场次/胜负，P7/B30） | 401 |
| POST | `/api/v1/quick/run` | 快速对战（积分相近 + 非对称 Elo 双向结算，P7/B32，D-133） | 409 `no_opponent` |
| GET | `/api/v1/leaderboard` | 排行榜 | 400 `bad_scope` |
| POST | `/api/v1/admin/bots` \| `/api/v1/admin/rebuild-index` | bot 注入 / 索引重建（需 `DL_ADMIN_TOKEN`） | 401 / 403 |
| GET | `/api/v1/log-level` | 日志总控（非 production） | 400 `bad_level` |

- **统一信封**：成功 `{ok:true,data,log:{level,events}}`；失败 `{ok:false,error:{code,message,details}}`。
- 随机性由请求 `seed` 显式传入（缺省服务端生成并**回带**），保证可复现。**例外（D-162）**：两个开箱端点（遗留 `POST /api/v1/box` 与服务端权威 `POST /api/v1/me/box`）**都没有 `seed` 入参**——客户端传了被**静默忽略**（不再有 `bad_seed`），seed 一律服务端生成；HTTP 侧确定性由实例级注入缝 `start({boxSeed})` 提供（第 n 次 = `boxSeed + n − 1`），CLI `box` 移除 `--seed`。
- **D-159…D-162 的仓库/AI 端点（真源 = `docs/interfaces.md` §2 与其后的 D-159/D-160/D-162 契约注记；本表不复制细节，避免双源漂移）**：
  - **仓库（D-159，推翻 D-130 的客户端权威）**：`GET /api/v1/me/warehouse` = **真源**（`{buckets,usage,caps,counts,starterIssued}`）；`POST /api/v1/me/warehouse/assemble|disassemble` = **服务端态写**（体只有增量：`{targetUid,pluginUid,slotIndex}` / `{targetUid,slotIndex}`，**不再传整仓**）；`PUT /api/v1/me/warehouse` **退役**为只校验形状（引用不覆盖 → 200 + `verified:false`）。
  - **开箱（D-159/D-162）**：`POST /api/v1/me/box` = **服务端权威、物品入档**（任一桶超 500 → 409 `warehouse_full` 且不入档）。
  - **AI 库（D-161）**：`GET|POST /api/v1/me/ai`、`DELETE /api/v1/me/ai/:aiId`（上限 100、被出战配置引用 → 409 `ai_in_use`）。
  - **配置完整性（D-160）**：见上表 `me/configs` 行。
  - **前端分册**：`docs/frontend/03-hub-warehouse-loadout.md`（F3 主界面/仓库/开箱/出战配置）。

### 2.4 CLI 契约（本轮唯一"操作台"）

```
box --tier common --times 10        # D-162：**不接受 --seed**（给了即参数错误，退出码 2；seed 由服务端生成）
wh list|assemble|disassemble ...
panel --loadout <file>
ai validate|compile|battle --file ai.json [--tier rare] [--opponent kiter]
battle --p1 a.json --p2 b.json --seed 7 [--out replay.json]
replay --file replay.json [--tick N]        # 文本回放（含 px 位置）
ranked run --seed 11                  # 有 token → 档案驱动（服务端抽池）；无 token → 遗留口径
register --user dev --pass *** | login --user dev --pass *** | me | quick run | leaderboard
log --level trace --channel bullets=trace
health | data <table>
```
- 退出码：`0` 成功 / `1` 业务拒绝 / `2` 参数错误 / `3` 未鉴权（P7 新增）。
- CLI **只走 HTTP，不 require core** → 同时是接口完整性验收工具。
- **未实现（后续批次，实测退出码 2）**：`configs *`、`records`、`defense`、`admin *`、`replay --battle <battleId>`（本节原列出的这些子命令当前不可用；请走 HTTP 端点，见 §2.3）。

### 2.5 冻结的数据结构

1. **BattleState**：`tick/seed/rng/players{p1,p2}/bases/bullets/verdict/queuedActions`（引擎 `createBattle` 实际产出；`events` 不挂在 state 上——整场事件由调用方注入缓冲，按 tick 切进 `frame.diff.events`）。
2. **玩家运行时**：`x`（**px，1px 精度**）/`facing`/`hp,mp,sp`/`maxHp,maxMp,maxSp`/`atk,def`/`regen{hp,mp,sp}`（模板 regen + 角色插件 `*_regen` 词条叠加）/`special`/`cooldowns{}/effects[]/skills{}/aiContext`/每 tick 瞬时标记 `defending`/`dodging`/`fullDodgeDuring`。
3. **回放帧 `frame`**：`{tick, diff}`；`diff` = `{players, bullets, bases, events, aiTrace, collision, bulletHits, verdict}`，其中 **`diff.players` 是对象 `{p1,p2}`（不是数组）**，各含 `fromX/toX/facing/hp/mp/sp`；位置、**碰撞位置、命中位置均为 1px 精度**；事件带 `cid`。
4. **物品实例 / 技能实例 / loadout / AI AST**：以 `decisions.md` 与重写后的 `v3-design` §4.4/§6.3/§12.2/§11.5 为冻结版本。
5. **AiContext 序列化产物**（`runtime.serializeContext` 实际字段）：`programHash/entry/frames[{kind,path,childIndex,remaining,condValue,fnScope}]/vars/halted/stepCount/trace/stepLimit/traceLimit/recursionLimit/traceTruncated`（**必须可序列化**；帧存稳定 `path` 与 `fnScope`，不存 `nodeId/phase/scopeDepth`）。
6. **LogRecord**：`seq/ts/cid/tick/level/levelValue/channel/event/msg/data`。
7. **`battle-config.json`**（新增，D-117）：`cellPx=64`/`fieldPx=1024`/`actorHalfPx=32`/`movePx=64`/`dodgePx=128`/`collisionDmgMul=0.8`/`baseHitMul=0.8`/`baseDef=64`/`defendDefMul=1.6`/`dodgeChanceBonus=0.20`（**B21 定稿，D-127**）/`defK=40`（**B21 入表，D-128**）/`backstab=1.5`/`crit=1.5`/`overtimeStart=48`/`overtimeRatio=0.0625`/`hardCapTick=64`。
8. **本轮 schema 变更**（D-110~D-116）：`role-templates` 增**必填** `regen{mp,sp}`；`skill-templates` 增 `slotWeights`、`falloff`，**删 `bulletSpeed`**；三表增可选 `unlockTier`；技能插件消耗统一 `costDeltaByTier` 逐档数组；角色插件按 `rp_*_pct`/`rp_*_flat` **拆独立 id**。

---

## 3. 测试策略与门禁

### 3.1 测试分层

`tests/{contract,unit,integration,regression,api,cli,property,log,fixtures}`；属性测试用 `tests/helpers/gen.js`（种子化生成器）。

### 3.2 测试矩阵（**测试点编号即验收单位**）

> 类型：`[正常]` `[边界]` `[失败]` `[确定]` `[统计]` `[回归]`

**T-IT 物品（01-items）**：T-IT-1 品质分布（≥10000 样本，误差<2%）｜T-IT-2 插槽数区间｜T-IT-3 属性在系数区间｜T-IT-4 百分比+数值叠加｜T-IT-5 概率封顶/负百分比｜T-IT-6 段位门控拒绝｜T-IT-7 组装拆卸状态｜T-IT-8 loadout 往返无损｜T-IT-9 档位分布与单调性｜T-IT-10 点数超限拒绝

**T-RO 角色（02）**：T-RO-1 特化恰 1 高 1 低｜T-RO-2 专家五修饰覆盖｜T-RO-3 顺序（基础→修饰→品质→取整）｜T-RO-4 非法插槽拒绝｜T-RO-5 概率封顶｜T-RO-6 点数超限｜**T-RO-7 模板 `regen` 正确进入实例（D-110）**

**T-SK 技能（03）**：T-SK-1 四类型覆盖范围（px 区间）｜T-SK-2 插件叠加后参数（含下限 clamp）｜T-SK-3 越界 clamp｜T-SK-4 资源不足/冷却中不释放

**T-BU 弹幕（04）**：T-BU-1 等级碰撞矩阵｜T-BU-2 命中/尽头/越界三种结束｜T-BU-3 近战每格独立弹幕｜T-BU-4 同刻生成顺序确定｜T-BU-5 连续方程求交（相向必中 / 同向追及）｜**T-BU-6 AOE 按位移后位置判定**｜**T-BU-7 `falloff` 衰减数值正确**｜**T-BU-8 弹幕不跨 tick**

**T-EF 效果（05）**：T-EF-1 持续效果结算与到期｜T-EF-2 控制复写行动｜T-EF-3 多控制优先级｜T-EF-4 新效果下一 tick 起效｜T-EF-5 clamp｜T-EF-6 结算顺序回归

**T-FD 场地（06）**：T-FD-1 初始 px 位置与朝向（224/800）｜T-FD-2 `clampX` 到 `[32,992]`｜T-FD-3 基地区域与"移动撞基地"判定｜T-FD-4 击退/拉近不使中心距 <64px

**T-EN 引擎（07）**：T-EN-1 同种子一致｜T-EN-2 runFull=逐tick｜T-EN-3 结束三路径+平局｜T-EN-4 超时扣血与 64 tick 上界｜T-EN-5 无效行动/资源恢复/防御｜T-EN-6 伤害管线｜T-EN-7 **背击用位移后位置与朝向**｜T-EN-8 真实伤害与公式精确值｜T-EN-9 diff 字段齐备（1px 位置/碰撞位置）｜T-EN-10 同时行动统一落位

**T-AI AI（08）**：T-AI-1 合法性拒绝｜T-AI-2 结构校验拒绝｜T-AI-3 段位门控｜T-AI-4 续执行断点｜T-AI-5 循环计数/变量持久｜T-AI-6 步数兜底（返回 `wait`）｜T-AI-7 函数栈与递归上限｜T-AI-8 只读快照与安全默认值｜T-AI-9 随机消耗时机｜T-AI-10 执行轨迹｜**T-AI-11 隐式主循环（跑完回到第一行）**｜**T-AI-12 分支 action 合法性拒绝**

**T-UL 解锁（09）**：T-UL-1 各段位解锁项（紫=随机+扩展运算符）｜T-UL-2 继承｜T-UL-3 filterByTier｜T-UL-4 未知 key/tier → false

**T-RK 排位（10）**：T-RK-1 匹配恒 10｜T-RK-2 晋升阈值 x=6｜T-RK-3 平局不计胜｜T-RK-4 段位→品质上限｜T-RK-5 快照不可变｜T-RK-6 loadout 结构完整、往返无损

**T-BT 战斗逻辑**

| 编号 | 测试点 | 批次 | 类型 |
|---|---|---|---|
| T-BT-1 | **帧可重建状态**：累积 frame.diff 后的状态 == `battle.state`（随机抽 20 tick 校验） | B22 | 确定 |
| T-BT-2 | 数值边界：`x ∈ [32,992]`、hp/mp/sp ∈ [0,max]、atk/def ≥ 0 | B10 | 边界 |
| T-BT-3 | 同 tick 双方求值顺序无关（交换 p1/p2） | B8 | 确定 |
| T-BT-4 | 战斗必在 ≤64 tick 内结束（含双方永不行动） | B10 | 边界 |
| T-BT-5 | 同 seed + 同 AI → 帧序列逐帧一致 | B11 | 确定 |
| T-BT-6 | 背击 × 暴击 = ×2.25（取整规则精确，逐位比对） | B9 | 正常 |
| T-BT-7 | 防御（def×1.6）后同一次攻击伤害 ≤ 未防御 | B9 | 正常 |
| T-BT-8 | 每 tick 生成弹幕数上界（≤ 技能数×bulletCount + AOE 覆盖格数） | B7 | 边界 |
| T-BT-9 | 事件顺序固定（弹幕按生成顺序、递归处理） | B8 | 确定 |
| T-BT-10 | 命中幂等：同一弹幕对同一目标只结算一次 | B11 | 正常 |
| T-BT-11 | 超时扣血精确：tick≥48 每 tick 扣 `ceil(maxHp×0.0625)`，基地与角色**同时**结算 | B10 | 边界 |
| T-BT-12 | 位移/击退/拉近不越界且不使中心距 <64px（含穿敌开关两种情形） | B9 | 边界 |
| T-BT-13 | **黄金战斗复现**：重写后的走查场次逐帧一致（含碰撞、抵消、背击、终结） | B11 | 回归 |
| T-BT-14 | 走查数值可复算：逐 tick 的 hp/mp/sp/**px 位置**与走查表格一致 | B11 | 回归 |
| T-BT-15 | **角色碰撞伤害**：相向冲突且不可穿 → 双方各受对方 `atk×0.8`（可闪避/暴击/背击/吸血） | B9 | 正常 |
| T-BT-16 | **基地规则**：弹幕对基地伤害恒为 0；仅"面向基地并移动"造成 `atk×0.8` 且角色停在原地 | B9 | 正常 |
| T-BT-17 | **连续碰撞解算精度**：命中/碰撞位置可按公式复算到 1/64 格（同 seed 逐位一致） | B8 | 确定 |
| T-BT-18 | **AOE 用位移后位置**：本 tick 走出 AOE 范围即不受伤害 | B9 | 正常 |
| T-BT-19 | **弹幕不跨 tick**：每 tick 结束后场上存活弹幕数为 0 | B7 | 边界 |
| T-BT-20 | **位移伤害统一模型**（D-18）：`dealDamage=true` → 沿**声明路径**每格一枚 0 速弹幕（等级取模板 `bulletLevel`，D-118）；与碰撞伤害**分别结算** | B9 | 边界 |
| T-BT-21 | **位移无伤语义**（D-18/G2）：`dealDamage=false` 时穿过无伤害；仅碰撞才双方各结算 `atk×0.8` | B9 | 边界 |
| T-BT-22 | **`t=0` 同格立即拦截**（D-32/G1）：敌方在本格开火且该格被 AOE 覆盖时，弹幕在生成点即被抵消 | B7 | 边界 |
| T-BT-23 | **"恰好停在相邻"不算接触**（D-19/U-1）：位移结束后中心距正好 64px → 不造成技能伤害 | B9 | 边界 |
| T-BT-24 | **被动位移也结算碰撞伤害**（D-35/U-4）：击退/拉近造成重叠时，双方各受对方 `atk×0.8` | B9 | 边界 |
| T-BT-25 | **互穿后各进一格**（D-33/U-2）：双方可穿且目标重叠 → 各 +64px，相遇格空着（中心距 128px） | B9 | 边界 |
| T-BT-26 | **闪避状态不参与弹幕判定**（D-72/V-1）：`fullDodgeDuring` 角色免疫伤害与控制，弹幕直接穿过（不命中、不被消耗） | B9 | 边界 |
| T-BT-27 | **控制复写不扣资源**（D-84/V-2）：被控制复写掉技能行动 → 不扣资源、不写冷却 | B9 | 边界 |
| T-BT-28 | **位移弹幕 + 碰撞双结算**（D-18）：路径弹幕命中（等级取模板 `bulletLevel`，D-118）+ 碰撞伤害可同 tick 各结算一次 | B9 | 边界 |
| T-BT-29 | **位移路径与落位解耦**（D-18②）：因碰撞被截停时，路径弹幕仍按声明的完整路径放置 | B9 | 边界 |

> **2026-09-16 新增用例登记**：`tests/unit/mechanics.test.js`（19 用例）覆盖 **T-BT-26（D-72 三态：伤害/控制/弹幕判定）**、`turn` 朝向写回、技能插件词条 `crit_chance`/`lifesteal`/`cast_buff` 消费、角色插件 `hp_regen` 逐 tick 回复（步骤 10）、`loadout.buildPanel` 投影（specials/castEffects/affixes + regen 叠加）、`ast` 字段枚举校验（logic.op/loop.kind/arith.op）与 call 行动产出定点分析，以及 items 侧"未登记词条"warn 分支。

**T-LG 日志**：T-LG-1 级别/通道过滤｜T-LG-2 记录结构（含 `cid`）｜T-LG-3 未知通道警告｜T-LG-4 覆盖矩阵事件｜T-LG-5 **日志不改结果**（silent vs trace 逐帧一致）｜T-LG-6 环形缓冲/`suppressed`/`dump`｜T-LG-7 禁用零成本｜T-LG-8 API/CLI 日志｜T-LG-9 总控开关｜T-LG-10 前端绘制日志（P6）｜T-LG-11 **因果链完整：一次命中可从 `skill.cast` 沿同一 `cid` 追到 `tick.end`**

**T-AP / T-CLI / T-PB / T-AF / T-DC**

| 编号 | 测试点 | 批次 | 类型 |
|---|---|---|---|
| T-AP-1 | 每端点正常返回符合信封 | 各 API 批次 | 正常 |
| T-AP-2 | 每端点参数错误 → 400 + `error.code` | 各 API 批次 | 失败 |
| T-AP-3 | 每端点业务拒绝 → 409 + `error.code` | 各 API 批次 | 失败 |
| T-AP-4 | 服务端重新执行 AI，不信任客户端结果 | B16 | 失败 |
| T-AP-5 | seed 显式化：带 seed 请求可复现、响应回带 seed。**D-162 修订**：**开箱两个端点（`/box`、`/me/box`）例外——无 `seed` 入参**（客户端传了被忽略，不再有 `bad_seed`），seed 服务端生成；HTTP 侧确定性改由 `start({boxSeed})` 注入缝提供（第 n 次 = `boxSeed+n−1`） | B16 | 确定 |
| T-CLI-1 | CLI 后端闭环：开箱→仓库→装配→loadout→校验 AI→对战→回放 | B16 | 正常 |
| T-CLI-2 | CLI 退出码 0/1/2 与输出结构 | P0-8 | 边界 |
| T-PB-1..10 | **插件连接 10 条不变量**（§3.6） | B18–B21 | 属性 |
| T-AF-1..11 | **自定义 AI 11 条不变量**（§3.7.11） | B12–B16 | 属性 |
| T-DC-1 | 数据表 schema 校验（含 `regen`/`slotWeights`/`unlockTier`/`costDeltaByTier`/`falloff`，且**不得出现 `bulletSpeed`**） | P0-6 | 失败 |
| T-DC-2 | `items-data.md` ↔ `data/*.json` 逐条对齐（11 角色/10 技能/5 品质/插件条目与 §5§6 表格一致） | P0-6 | 失败 |
| T-DC-3 | 静态检查：core/ai 无 `Math.random`/`eval`/`new Function` | P0-5 | 失败 |
| T-DC-4 | 架构依赖方向检查 | P0-5 | 失败 |
| T-DC-5 | 静态检查：`server/core/**` 无 `console.*` | P0-5 | 失败 |
| T-DC-6 | 日志事件命名：通道已注册、前缀一致 | P0-5 | 失败 |
| T-DC-7 | 机制数值不在代码里硬编码（战斗数值必须来自 `battle-config.json`） | P0-5 | 失败 |
| **T-DC-8** | **文档与现实一致**：`decisions.md` 的每条 D 编号都能在 `docs/interfaces.md` 或数据表中找到落点 | P0-7 | 失败 |

> P0 基建批自有的测试点：P0-3 的 `G-1..G-12`（`tests/helpers/gen.js` 契约）；P0-4 的 T-LG-1/2/3/6/7 与 `H-1..H-4`（`tests/helpers/log.js` 契约，见 `shared/README.md`）、T-LG-2g/2h（UMD 双入口，§4.10）；P0-5 的 T-DC-3..7；P0-6 的 T-DC-1/2；P0-8 的 T-CLI-2。见 `tests/README.md`。

### 3.3 敷衍测试黑名单（命中即打回）

1. 只断言 `truthy`／只断言"不抛错"／`assert.ok(true)`。
2. 断言实现细节的镜像。
3. 无边界值（0/1/上限/clamp±1/空数组）。
4. 无失败路径（拒绝/非法输入/资源不足）。
5. 随机不固定种子、无大样本统计。
6. `skip`/`todo`/注释掉断言（除 §9 登记项）。
7. 用 mock 替换被测模块本身（只允许注入 `rng`/`logger`/只读快照）。
8. 覆盖率靠凑数调用。
9. **日志缺失或未断言**（§4.6 事件未实现/未断言）。
10. **接口不可达**（模块层可用但 `/api/v1`/CLI 触达不到，违反 L14）。
11. **战斗逻辑用"最终血量对了"代替过程断言**（必须断言事件序列与中间值，含 px 位置）。

### 3.4 覆盖率与门禁

- **阈值（`core`+`ai`+`shared`+`cli`）**：行 ≥90%、分支 ≥85%、函数 ≥90%。
- **`npm run gate` 单进程内联 9 项**（任一失败即非零退出）：
  1. 静态：无 `Math.random`/`eval`/`new Function`；
  2. 静态：core 无 `console.*`（T-DC-5）；
  3. 架构依赖（T-DC-4）；
  4. 数据表 schema（T-DC-1）；
  5. 文档↔数据一致性（T-DC-2）+ D 编号落点（T-DC-8）；
  6. 日志规范（T-DC-6）+ 战斗数值未硬编码（T-DC-7）；
  7. 全量测试（单进程 + 覆盖率阈值 + §3.2 已归属用例）；
  8. 日志冒烟：`trace` 跑一场，断言关键事件齐备、`cid` 链路可追（T-LG-11），且结果与 `silent` 一致（T-LG-5）；
  9. 接口冒烟：同进程 `listen(0)` → `/api/v1` 关键端点 → **CLI 闭环**（T-CLI-1）。
- 禁止"重试绕过"；阈值调整属 §10。
- **文档↔实现一致性检查器**：`scripts/check-docs.js`（D1–D6，见 `§5.1`）由 `tests/integration/check-docs.test.js` 纳入项 7，也可用 `npm run check:docs` 单独运行；CI 单列一步（`.github/workflows/gate.yml`）。

---

### 3.5 战斗规范（依据 `docs/decisions.md` 冻结）

> **权威来源**：本节规则来自 `docs/decisions.md`（`D-01`…`D-126`），高于原设计文档；受影响章节将同步重写（D-126）。

#### 3.5.1 tick 管线（冻结，14 步）

| # | 步骤 | 内容 | 日志事件 |
|---|---|---|---|
| 1 | `tick.begin` | `tick+=1`；按 **D-91** 派生本 tick 各用途随机流；引擎冷却递减（D-82）；重置 `defending`/`dodging`/`fullDodgeDuring` 等**每 tick 瞬时**标记（D-72） | `tick.begin`(info) |
| 2 | `effects.resolveContinuous` | 持续效果 `stat += delta`；clamp；`remaining-=1` 归零移除 | `effect.continuous`(trace)/`effect.expire`(debug) |
| 3 | `ai.resume` | 按 **p1 → p2** 各调用一次，产出 action + trace | `ai.resume`(debug)/`ai.node`(trace)/`ai.action`(info) |
| 4 | `action.normalize` | 白名单校验；非法 → **`wait`**（D-80）。行动集 = `move_left/move_right/dodge_left/dodge_right/wait/defend/turn`（+ `skill:<sid>`） | `action.invalid`(**warn**) |
| 5 | `effects.resolveControl` | 控制效果复写行动（眩晕 > 位移；位移取首个）；控制位移不可穿敌（D-71） | `effect.control.override`(debug) |
| 6 | `action.commit` | 只算意图：`turn` 意图登记 / 防御标记（def×1.6，D-43）/ 目标位置 / 位移技 `fullDodgeDuring` 置位 / 技能 `canCast`→扣资源+写 CD+**生成弹幕（记录生成序号）**+释放类词条 `castEffects` 入效果队列（下一 tick 起效，D-70） | `skill.cast`(info)/`skill.reject`(**warn**) |
| 7 | `move.resolve` | **转向写回**（`turn` → `facing×−1`；`move`/`dodge`/位移**不改变朝向**）→ 统一落位 → 穿敌判定（D-11~15）→ **角色碰撞解算与碰撞伤害**（D-10，1px）→ clamp | `move.resolve`(debug)/`collision.resolve`(info) |
| 8 | `bullets.resolve` | 按**生成先后顺序**遍历（D-27）：每枚**当 tick 飞完全射程**（D-20），与角色轨迹**解方程**判命中（D-23），与敌方弹幕解方程判碰撞并**递归**（D-28）；AOE 用**位移后位置**（D-24） | `bullet.spawn`/`bullet.collide`/`bullet.hit`/`bullet.expire` |
| 9 | `damage` | 按 §3.5.4 结算（闪避→基础→背击→暴击→吸血→附加效果） | `damage.dodge`/`damage.calc`/`damage.lifesteal` |
| 10 | `regen` | `hp/mp/sp +=` regen（模板 regen + 角色插件 `*_regen` 词条，D-110）；**`hp` 在 hp≤0 时不回复**（死亡统一在步骤 12），全部封顶 | `resource.regen`(trace) |
| 11 | `overtime` | `tick ≥ 48` → 双方基地与角色**同时**扣 `ceil(maxHp×0.0625)` | `battle.overtime`(info) |
| 12 | `judge` | 基地≤0 → 角色≤0；优先级基地 > 角色；同级同时 → 平局 | `battle.judge`(info)/`battle.end`(info) |
| 13 | `diff.emit` | 产出 frame，位置/碰撞/命中均 1px 精度 | `tick.end`(info) |
| 14 | 传入下一 tick | — | — |

- **弹幕不跨 tick**：步骤 8 结束时场上无存活弹幕。
- **同时行动**：步骤 6 只算意图、步骤 7 统一落位。
- **朝向只能通过 `turn` 改变**（用户决定 2026-09-16）：`turn` 翻转朝向（`facing×−1`）、不移动不消耗；`move`/`dodge`/位移**都不写朝向**；引擎只在开战初始化与步骤 7 的 turn 写回时写 `facing`。
- **死亡时序**：统一在步骤 12；步骤 2 被扣到 `hp≤0` 的角色本 tick 仍会行动（测试锁定）。
- **超时扣血**：步骤 11（regen 之后、judge 之前）。

#### 3.5.2 空间与坐标（D-01 ~ D-08）

1. 场地 16 格 × **64px** = **1024px**；连续坐标 `x ∈ [0,1024]`，精度 **1px（1/64 格）**。
2. 格 `c` 占 `[64c, 64(c+1))`；角色取**格中心** → 初始 P1 `224`、P2 `800`。
3. 角色中心 clamp 到 `[32, 992]`。
4. 基地：P1 `[-64,0)`、P2 `(1024,1088]`；**不反击**。
5. 角色体积 1 格；两角色中心距**恒 ≥64px**。
6. 速度（每 tick）：`move` 64px；`dodge` 128px；位移技能 `distance×64px`；控制位移 `N×64px`；**弹幕 `range×64px`**。
7. **一切碰撞用连续方程求"同一时刻位置相等"**，精度 1/64 格，**不允许"轨迹重叠"近似**。
8. 全部数值来自 `battle-config.json`（D-117）。

#### 3.5.3 移动、穿敌与角色碰撞（D-10 ~ D-17）

| 情形 | 处理 |
|---|---|
| 一方移动、另一方静止 | 静止方不动；移动方按能否穿敌决定"穿过"或"碰撞" |
| 相向移动、目标不重叠 | 能穿敌者**穿过敌人到达目标位置**；否则双方停在相遇点两侧（中心距 64px）并**结算碰撞伤害** |
| 相向移动、目标位置重叠 | 能穿敌者**更进一格停在敌方身后**；都不可穿 → 碰撞伤害 + 双方停在相遇点左右 |
| 同向移动、距离不同导致穿越/同格 | 由**后方角色**决定"穿过"或"碰撞" |

- **可穿来源**：`passThroughEnemy=true` 的位移技能、`dodge`（2 格，可穿）；**普通 `move` 不可穿**；**控制类位移不可穿**。
- **碰撞伤害**：双方各受对方 `atk×collisionDmgMul`（`=0.8`），标准减伤，允许闪避/暴击/背击/吸血；碰撞位置按速度解方程，1px 输出。

#### 3.5.4 弹幕模型（D-20 ~ D-31）

1. **不跨 tick**：生成当 tick 飞完射程并结算完毕。
2. **无 `bulletSpeed`**：飞行距离只由 `range` 决定（字段已从模板与数据表删除）。
3. **生成位置**：平射 = 释放者所在格；垂直 = 落点格；近战 = **覆盖格每格一枚 0 速弹幕**。
4. **命中**：弹幕轨迹与角色轨迹解方程求交，命中位置 1px 精度；区间**含终点**。
5. **AOE 基准**：0 速弹幕用**角色位移后位置** —— 走出范围即可躲开。
6. **命中次数**：AOE 每目标最多一次；**平射可多次命中同一目标**。
7. **AOE 每格独立**参与等级计算与抵消。
8. **遍历**：按生成先后顺序，检测到碰撞后**递归**处理。
9. **等级碰撞**：高穿低并**继续命中**；同级双消；低者消失。
10. **衰减**：模板 `falloff`（每向外一格减伤%，默认 0）。
11. 弹幕不伤害自己（角色永不重叠）。

#### 3.5.5 伤害、防御与吸血（D-40 ~ D-46）

```
命中/碰撞 → 1 闪避判定（受方 dodgeChance）
          → 2 取本 tick 攻方 atk / 受方 def（受方 defend → def×1.6）
          → 3 普通 max(1, floor(atk×倍率×(1−def/(def+40)))) ；真实 max(1, floor(atk×倍率))
          → 4 背击 ×1.5
          → 5 暴击 ×1.5
          → 6 全部倍率相乘后**只取整一次**得 D，下限 1
          → 7 吸血 floor(D×lifesteal)，maxHp 封顶（不作用于基地）
          → 8 应用 D + 命中事件 + damage.calc（逐步中间值）
          → 9 附加效果（伤害生效后添加）
```
- `defend` **不是独立减伤步骤**，而是 def×1.6 代入公式；背击×暴击 = ×2.25。
- 词条聚合 `base×(1+Σ%)+Σ数值`，最后取整一次；概率类封顶 1。
- **技能插件词条**：`crit_chance`/`lifesteal` → `skill.specials`，随弹幕 payload 参与命中结算并**叠加在面板值上、按 1 封顶**；`cast_buff` → `skill.castEffects`，步骤 6 入效果队列、**下一 tick 起效**（D-70）、持续 `duration`（缺省 2）；命中类 `stun/knockback/pull/dot/true_dmg` 由引擎按 `affix-registry.json` 的 `hitEffect` 结算。

#### 3.5.6 背击与基地（D-50 ~ D-62）

- **背击**：用**本 tick 写回后**的位置与朝向（步骤 7；**只有 `turn` 会改变朝向**，`move`/`dodge`/位移都不改）；近战/位移看相对位置与朝向，平射看弹幕来向，**垂直永不触发**。
- **基地**：⚠️ **弹幕不造成任何基地伤害**；唯一途径是"面向基地并向基地方向移动" → **停在原地** + `atk×baseHitMul`（`=0.8`；与碰撞倍率 `collisionDmgMul` 是两个独立字段，真值当前相同）走基地 `def=64` 减伤；基地不反击。

#### 3.5.7 战斗链路（可追溯，L16）

```
skill.cast ─┐
            ├─ bullet.spawn ─ bullet.collide(递归) ─ bullet.hit
move.resolve┘                                            │
   └─ collision.resolve ──────────────────────────────┐  │
                                                      ▼  ▼
                       damage.dodge / damage.calc / damage.lifesteal
                                    │
                                    ├─ effect.add
                                    └─ tick.end(frame.events)
```
- 同一因果链共享 `cid`（`t{tick}:{owner}:{seq}`）；`frame` 保留 `cid`、1px 位置与碰撞/命中位置。

#### 3.5.8 战斗不变量

见 `§3.2` 的 **T-BT-1..29**。

#### 3.5.9 战斗走查（**已按真实引擎重算，2026-09-16**）

1. 走查 `battle-walkthrough.md` §3.1 的逐 tick 轨迹已用**真实引擎**重算：**seed 20260912 / 18 tick / p2 胜**，与 gate 项 8 依赖的 `.audit/golden-battle.json` 逐字段一致（复算命令 `node .audit/walkthrough.js`，输出 `.audit/walkthrough.json`）。
2. 作为 B11 黄金用例 `T-BT-13/14` 的基准；`tests/regression/golden-battle.test.js` **⏳ 计划（未实现）**——`tests/regression/` 目前只有 `.gitkeep`（当前由 gate 项 8 的日志冒烟 + `.audit/walkthrough.js` 复算承担回归）。
3. 保留同一 `cid` 的日志链样例（`T-LG-11` 参照）。

---

### 3.6 插件连接专项（P3，B17–B21）

| # | 不变量 |
|---|---|
| T-PB-1 | **槽位匹配**：`slot` ≠ 插槽 `type` → 拒绝且**状态完全不变** |
| T-PB-2 | **点数预算**：Σ `pointCost` ≤ 模板 `pluginPoints`；超限拒绝且状态不变 |
| T-PB-3 | **装配/拆卸往返**：往返后插槽、`equipped`、仓库归属与装配前**深度相等** |
| T-PB-4 | **档位单调**：档位↑ → 词条数值↑ 且点数/消耗↑ |
| T-PB-5 | **消耗补偿**：除减耗类外使技能 `cost` 单调不减；减耗类 `costDelta === null` |
| T-PB-6 | **词条聚合**：百分比先累加后乘基础，数值后加，最后取整一次；概率封顶 ≤1 |
| T-PB-7 | **门控**：`unlockTier` > 当前段位不可装配、不进掉落池 |
| T-PB-8 | **`equipped` 唯一性**：同一插件不可同时装两处 |
| T-PB-9 | **引用完整性**：loadout 中每个 `pluginUid` 存在且 `equipped=true`，无悬挂引用 |
| T-PB-10 | **序列化往返**：warehouse+loadout 往返后 10 条不变量仍成立 |

生成器：`tests/helpers/gen.js`（`createRng(seed)`，同 seed 可复现；随机 500 组装配序列）。

---

### 3.7 自定义 AI 详解（存储 / 解释 / 链路）

#### 3.7.1 存储与规范化

| 层面 | 形式 |
|---|---|
| 程序本体 | 纯 JSON AST：`{type:'program', version:1, body:{type:'seq',statements:[...]}}` |
| 存放 | `loadout.ai` → 请求体 → 回放/诊断记录 `programHash`（**本轮不持久化**，D-123） |
| 上限 | `256KB` / 深度 `≤32` / 节点数 `≤2000`；拒绝危险键（`__proto__` 等） |
| 规范化 | `canonicalize()`（键排序、去空白）→ `sha256` → **`programHash`**：缓存键、快照去重、回放校验 |
| 版本 | `version` + `migrations[n→n+1]`；高版本拒绝 `ai_version_unsupported` |

#### 3.7.2 节点与稳定路径 id

- 节点：`literal/get/var/set/getVar/arith/cmp/logic/random/if/loop/break/function/call/action` + `seq`（**共 16 类**，单一数据源 `server/data/ai-nodes.json`；**`bullets` 节点已于 2026-09-16 按用户决策删除**——AI 无法观测弹幕，弹幕当 tick 全解算，见 D-138 与 §3.7.6）。
- 路径 id 在执行期由位置生成（`body.s[3].then.s[0]`），**与编辑器无关**；API 校验错误返回 `path` 供未来 UI 高亮。

#### 3.7.3 隐式主循环（D-100）

⚠️ **AI 最外层是一个无法跳出的 `while(true)`**：程序运行到最后**自动回到第一行**；该结构由引擎隐式提供、在编辑器中**显式可见且无法删除**。因此 AI 无需（也不应在）自己写外层循环。

#### 3.7.4 解释器：显式状态机（可序列化）

```
AiContext = { programHash, entry, frames[{kind,path,childIndex,remaining,condValue,fnScope}], vars, halted, stepCount, trace, stepLimit, traceLimit, recursionLimit, traceTruncated }
（= runtime.serializeContext 实际产出；帧存稳定 path + fnScope 变量快照，不存 nodeId/phase/scopeDepth）
```
- `stepOnce()` 只推进一个微步骤；`resume()` 循环直到产出 `action` 或触及 `STEP_LIMIT`（限步/trace/挂起集中一处，杜绝"每 tick 重跑"）。
- **函数（D-102/D-103）**：= 打包代码块，**无参数无返回值**，但**拥有独立局部变量作用域与调用栈**（可读外层变量，内部 `var` 不泄漏）；进入顶层 `seq` 时先注册全部函数（hoisting）；递归深度上限 64。
- **循环**：`count` 用帧内 `remaining`；`while` 每次迭代先求值条件；`break` 用信号对象向上找最近 `loop` 帧。
- **随机（D-90/D-91）**：每局一个全局种子；**每 tick 每用途各派生一条流** `hash(seed, tick, purpose)`（`ai`/`crit`/`dodge`）；仅在实际求值 `random` 时消耗。
- **可序列化**：`serializeContext/restoreContext` 往返后继续执行结果一致（T-AF-7）。

#### 3.7.5 合法性检测（D-101）

1. 结构：白名单节点、字段类型、深度/节点数/字节上限、危险键；**字段枚举校验**（表外取值校验期拒绝，避免"校验通过但运行期静默失效"）——`logic.op ∈ {and, or}`、`loop.kind ∈ {count, while}`（`count` 必填 `times`、`while` 必填 `cond`）、`arith.op ∈ {+, -, *, /}`、`cmp.op ∈ {>, <, >=, <=, ==, !=}`；错误码 `bad_enum`。
2. **循环体必须能产出 `action`**：循环体内所有 `if` 的每个分支（含隐式空 `else`）都要能产出 `action`——直接含 `action`，或调用**行动产出函数**。行动产出函数用**调用链定点分析**判定：函数体直接含 `action`，或调用其它行动产出函数（可传递）才算；**纯检测函数不算**（因此"循环体只调用纯检测函数"会被拒，防空死循环），但纯检测函数本身**允许定义、也允许在顶层调用**。
3. **动作名不做校验期拒绝**（D-80）：`action.name` 是自由标签，未知名由引擎 `normalizeAction` 运行期归一化为 `wait` 并记 `action.invalid`(warn)；引擎动作词汇表登记在 `server/data/ai-nodes.json` 的 `actions`（前端下拉只给词汇表内的值）。
4. 段位门控：用到的节点必须已解锁（紫段位解锁 `random` + 扩展运算符**权限位**；`arith_ext` 尚未实现、不授予任何节点）。
5. 循环外 `break`、未知函数调用等结构错误 → 拒绝并给 `path`。

#### 3.7.6 只读快照与安全默认值

白名单投影（**字段总清单以 `server/runner.js` 的 `projectSnapshot` 投影注释为权威**，D-147）：
`tick` / `self{hp,maxHp,mp,maxMp,sp,maxSp,atk,def,x,facing,baseHp}` / `enemy{同}` / `self|enemy.cooldowns.<sid>` / `self|enemy.effects[i].{uid,kind,stat,delta,displacement,remaining}` / `bases.self|enemy.{hp,maxHp,def}` / `field{fieldPx,cellPx}`。
深冻结；AI 只能写 `vars`；越界读取 → 安全默认（0/false）并记 trace。**容器（`self`/`self.cooldowns`/`self.effects[i]`/`bases.self` …）不可当值读**；**不投影 `bullets`**（AI 无法观测弹幕＝设计，D-138）。
⚠️ **`baseHp` ＝ 该方基地当前血量（`bases.<owner>.hp`），`maxHp` ＝ 该方角色血量上限——两者是完全不同的东西**（B26 修正；旧实现曾误填角色 `maxHp`，D-147）。

#### 3.7.7 限步、兜底与错误策略

| 情形 | 行为 |
|---|---|
| 步数 > `STEP_LIMIT`(10000)/tick | 返回 **`wait`** + **重置到入口** + `ai.step.limit`(**warn**) |
| 递归超深 | 返回 `wait` + `ai.depth.limit`(warn) |
| 内部异常 | 返回 `wait` + `error` 日志 + trace，**绝不抛穿引擎** |
| 非法 action 名 | 归一化为 `wait` + `action.invalid`(warn) |

#### 3.7.8 执行轨迹 `trace`

`{seq, path, nodeType, phase, result, depth}`；上限 2000 条/tick，超出截断并记 `trace.truncated`(warn)；进 `frame.diff.aiTrace`，末条 action 与本轮返回值一致。

#### 3.7.9 与引擎 / API 的接口

引擎步骤 3 调 `resume(ctx, snapshot, rng)` → `{action, trace}`。API：`/ai/validate`（错误带 `path`）、`/ai/compile`（`programHash` + 统计）、`/ai/battle`（服务端**重新执行**，不信任客户端结果）。

#### 3.7.10 AI 不变量

| # | 不变量 |
|---|---|
| T-AF-1 | **只读**：执行前后战场快照深度相等（仅 `vars` 可变） |
| T-AF-2 | **确定性**：同 seed + 同程序 → 同行动序列、同 trace；挂起不消耗 RNG |
| T-AF-3 | **续执行等价性**：`n` 次 `resume` 的行动序列 == 顺序第 `n` 个 action 序列 |
| T-AF-4 | **步数上限**：≤ `STEP_LIMIT`，超限返回 `wait` + 重置 + warn |
| T-AF-5 | **门控**：未解锁节点被拒，错误带 `path` |
| T-AF-6 | **trace 一致**：末条 action == 返回值；顺序 == 求值顺序 |
| T-AF-7 | **上下文可序列化**：`serialize/restore` 往返后继续执行结果一致 |
| T-AF-8 | **程序上限**：深度/节点数/字节超限与危险键被拒 |
| T-AF-9 | **隐式主循环**：程序末尾自动回到第一行；连续多次 `resume` 可持续产出 action |
| T-AF-10 | **分支 action 合法性**：循环体内任一分支缺 `action` → 校验拒绝 |
| T-AF-11 | **函数语义**：独立作用域 + 调用栈；内部 `var` 不泄漏；不支持参数/返回值 |

**fixtures 套件**（`tests/fixtures/ai/*.json` + `expect/*.json`）：覆盖型（每节点 ≥1 例、if/else 双分支、count/while、break、函数、random、bullets 过滤、变量跨 tick、嵌套循环）＋ 病态型（无 action、**某分支无 action**、深嵌套、未知节点、非法字段、非法 action 名、超深递归、越界读取、未定义变量/函数、**危险键**）。

---

## 4. 日志与可观测性规范

> 前端绘制日志（`render.frame` 等）本轮**只登记不实现**（P6）。

### 4.1 三条底线

1. **可观测**：模块边界（传参/返回）、关键计算、接口进出都有事件，清单写入 `docs/interfaces.md`。
2. **零副作用**：默认 `nullLogger` 全 no-op；禁用时不构造载荷。
3. **不改结果**：不得消耗 RNG、不得改变顺序、不得进入 `diff`/`events`/`aiTrace`（T-LG-5 常驻回归）。

### 4.2 级别

`silent(-1)` / `fatal(0)` / `error(1)` / `warn(2)` / `info(3)` / `debug(4)` / `trace(5)` / `all(99)`。
默认：`NODE_ENV==='production'` → `warn`，否则 `debug`。

### 4.3 通道

`rng field effects items roles skills bullets engine damage ai.ast ai.runtime unlock api cli ranked store view render editor perf log`
（`store/view/render/editor` 为 P6 保留。）支持**按通道覆盖级别**；未注册通道 → `log.unknownChannels` 警告。

### 4.4 记录结构（冻结）

```jsonc
{ "seq":1234, "ts":1726000000000, "cid":"t17:p1:3", "tick":17,
  "level":"debug", "levelValue":4, "channel":"bullets", "event":"bullet.collide",
  "msg":"…", "data":{ } }
```

### 4.5 总控开关

后端 `DL_LOG_LEVEL` / `DL_LOG_CHANNELS` / CLI `--log=` / 运行时 `GET|POST /api/v1/log-level`；`reset()` 复位；`npm run demo:log` ≡ trace。（P6 前端 `?log=`、设置屏面板。）

### 4.6 覆盖矩阵（必须输出的事件；**测试逐条断言**）

| 层 | 通道 | 必须的事件（级别） |
|---|---|---|
| L0 | `rng` | `rng.create`(info) / `rng.draw`(trace，含 purpose 与值) / `rng.stream`(debug，含 tick+purpose) |
| L0 | `field` | `field.clamp`(trace) / `field.base`(debug，撞基地判定) |
| L1 | `effects` | `effect.add`(debug) / `effect.continuous`(trace) / `effect.expire`(debug) / `effect.control.override`(debug) |
| L1 | `items` | `items.roll.quality`(debug) / `items.generate`(debug) / `items.affix.apply`(trace) / `items.assemble`(info) / `items.reject`(**warn**) / `items.affix.unknown`(**warn**，词条注册表未登记 id) |
| L1 | `unlock` | `unlock.check`(debug) / `unlock.reject`(**warn**) |
| L2 | `roles` | `role.instantiate`(debug) / `role.panel`(debug) |
| L2 | `skills` | `skill.instantiate`(debug) / `skill.plugin.apply`(debug) / `skill.cast`(info) / `skill.reject`(**warn**) / `skill.area`(trace，px 区间) / `skill.plugin.unknown`(**warn**，词条或算子未登记) / `skill.emit.unknown`(**warn**，发射模式未登记) |
| L2 | `bullets` | `bullet.spawn`(debug，含起点/方向/射程 px) / `bullet.collide`(debug，含碰撞位置与等级比较) / `bullet.hit`(debug，含 1px 命中位置与 cid) / `bullet.expire`(trace) |
| L4 | `engine` | `battle.create`(info) / `tick.begin`(info) / `tick.step`(debug，14 步各一条) / `move.resolve`(debug) / `collision.resolve`(info，含双方速度与碰撞位置) / `resource.regen`(trace) / `battle.overtime`(info) / `tick.end`(info) / `battle.judge`(info) / `battle.end`(info) / `action.invalid`(**warn**) |
| L4 | `damage` | `damage.calc`(debug，含每步中间值) / `damage.dodge`(debug) / `damage.lifesteal`(trace) / `damage.affix.unknown`(**warn**，命中效果未登记) |
| L5 | `ai.ast` | `ai.validate`(debug) / `ai.validate.reject`(**warn**) / `ai.compile`(debug，含 hash) / `ai.migrate`(info) |
| L5 | `ai.runtime` | `ai.resume`(debug) / `ai.node`(trace) / `ai.action`(info) / `ai.step.limit`(**warn**) / `ai.depth.limit`(**warn**) / `trace.truncated`(**warn**) |
| L6 | `api` | `api.req`(info) / `api.res`(info，含耗时与字节) / `api.err`(**error**) |
| L6 | `cli` | `cli.invoke`(info) / `cli.result`(info，含退出码与耗时) |
| L6 | `ranked` | `ranked.snapshot`(debug) / `ranked.match`(info) / `ranked.promote`(info) |
| P6 | `store/view/render/editor` | `store.dispatch` / `view.render` / `render.frame` / `render.sprite` / `editor.ast.*` —— **仅登记** |

> 跨系统数据传递/接收统一用 `debug` 级边界事件：`{dir:'in'|'out', fn, args:摘要, result:摘要}`。

### 4.7 性能与体积

- 调用点先 `if (log.on('bullets','trace'))` 再构造载荷。
- 高频通道（`bullet.collide`、`collision.resolve`、`rng.draw`、`ai.node`、`api.res` 完整体）默认 trace + **环形缓冲**（N=2000，`dump()` 导出）；溢出计数并每 100 tick 输出 `log.suppressed`。
- 输出：≥`info` 写 stdout；`debug`/`trace` 默认只入缓冲，可选 `DL_LOG_FILE`（IO 只在 server/cli 层）。

### 4.8 与确定性/纯净性

core 与 `shared/log.js` 不得 IO；core 只接受注入 logger；core 禁止 `console.*` 与 `require('fs'|'http'|'express')`；常驻回归 **T-LG-5**。

### 4.9 日志即测试工具

`tests/helpers/log.js`：`createRecordingLogger()` / `assertEvent(...)` / `countEvents(...)` / `assertCidChain(log, cid, [...events])`。

### 4.10 共享实现（UMD）

`shared/log.js` 零依赖 UMD（Node `require` / 浏览器 `window.DLLog`）；架构检查只允许这一个跨层共享模块。

---

## 5. 批次节拍（每批接口的固定动作）

1. **规格**：摘出本批接口清单 + `§3.2` 测试点（含 `§4.6` 日志事件行）。
2. **冻结**：更新 `docs/interfaces.md`（签名、结构、API/CLI 契约、日志事件名、D 编号落点）；改已有签名 → §10。
3. **先红**：写契约测试并确认失败。
4. **实现**：只做本批范围；计算路径与跨模块调用**同批带日志**（L13）。
5. **接口自足**：接进 `/api/v1` 与 CLI（L14），补 T-AP-*/T-CLI-*。
6. **绿**：补单元/集成/日志覆盖测试，`npm test` 全绿（含覆盖率）。
7. **全量门禁**：`npm run gate` 全绿；`npm run demo` 正常。
8. **独立审查** → `docs/reviews/BXX.md`；P0/P1 级问题当批修复。
9. **提交**：`B07 bullets: 生成/连续碰撞/等级抵消 (+18 tests, core 93.2%/branch 87%, 日志 7/7, API 2)`
10. **记录**：更新批次状态与测试数字。

### 5.1 硬性规则：提交前必须更新任务清单

> 本节规则为**强制项**，与铁律 L2/L3/L10 同级。

1. **任何改动代码的提交**（`server/`、`cli/`、`shared/`、`scripts/`、`tests/`，含数据表），必须在**同一提交内**更新：
   - `docs/tasks.md` 的**批次勾选**（`[ ]`/`[~]`/`[x]`）；
   - `docs/progress.md` 的**当前状态**对应条目（唯一状态源）。
2. **提交信息必须写明批次号与"实跑结果"**：`npm test` 的用例数（通过/失败）与 `npm run gate` 的结果（几 PASS / 几 FAIL / 几 PEND）；只写"已测试"不算。
3. **机器强制（已实现，2026-09-16）**：本条规则由两个检查器拦截"改了代码但没改任务清单"的提交——
   - **`.githooks/pre-commit`**：staged 文件里含 `server/`、`cli/`、`shared/`、`scripts/`、`tests/` 改动，而 `docs/tasks.md`/`docs/progress.md` **都**没改 → 直接拒绝提交（并打印涉及文件；确属无需更新清单的改动可 `--no-verify` 并说明原因）；随后强制跑 `node scripts/check-docs.js`，不通过也拒绝。**`.githooks/pre-push`** 另在推送前跑全量 `node scripts/gate.js`。
     - **安装方式**：`npm run hooks:install`（= `git config core.hooksPath .githooks`）。**现状（2026-09-16 实测）**：本仓库已安装并生效（`git config core.hooksPath` 返回 `.githooks`；本轮提交由 pre-commit 实际执行 `check-docs` 校验）；新克隆仓库需先执行一次该命令。
   - **`scripts/check-docs.js`**（文档↔实现一致性，`npm run check:docs`）：D1 npm 脚本双向一致 / D2–D3 文档引用的脚本与数据表存在（标注「计划/未实现/⏳」的行豁免）/ **D4 批次计数一致（tasks.md 头部 ↔ progress.md）** / **D5 批次勾选数 = 批次数且无"已完成未勾选"** / **D6 每个已勾选批次有 `docs/reviews/<批次>.md`**。该检查由 `tests/integration/check-docs.test.js` 纳入 `npm test`（因此在 gate 项 7 内），CI 另单列一步（`.github/workflows/gate.yml`）。
4. **禁止放宽覆盖率阈值来通过门禁**（行 ≥90 / 分支 ≥85 / 函数 ≥90）：阈值调整属 §10 的接口级变更，必须单独 commit 并说明理由（§3.4）。
5. **每个阶段/新功能完成后必须做一次「代码级审查」并修复**（用户 2026-09-16 要求）：逐条检查**功能完整度**（是否只有单测/核心层可用而经 HTTP·CLI 失效）、**空实现与占位**（stub/`TODO`/恒真恒假分支/注册了却无消费方的字段/有定义无调用的导出）、**冲突与重合**（同一件事两套实现、镜像清单不同步、同一字段两处不同解释、新旧路径结果不一致），并检查是否破坏既有契约（帧契约/错误码/退出码/日志事件/覆盖率）。问题必须当阶段修复；确实无法修复的要在 `docs/progress.md` 登记为显式待办并写明原因。审查由**未参与该阶段实现**的执行者独立完成，并留下 `文件:行` 与实测证据。详见 `docs/plan-p7-playable.md` §0 第 7 条。

---

## 6. 阶段与批次（后端优先，共 41 批 = P0–P5 的 9+11+5+5+2+2 + P7 在线服务的 7）

> **P0–P5 之外的新增工作以 `docs/progress.md` 的「本轮完成项」（§3.3/§3.4）为准**；P7（在线服务）的冲刺阶段、文件所有权与验收标准见 **`docs/plan-p7-playable.md`**（本轮"完全可玩后端"的执行蓝图）。

> **P0–P5 全为后端**（共 **34 批**，已收口）；**P7 在线服务（B27–B33，7 批）已于 2026-09-19 交付**（共 **41 批** = 34 + 7）；**P6 前端**为「⏳ 计划（未实现）」，不计入 41 批。每批必须：① 满足 `§4.6` 事件；② 有日志断言；③ 经 `/api/v1` 或 CLI 可达。

### P0 后端基建与契约（9 批）

| 批次 | 交付物 |
|---|---|
| P0-1 `[x]` | `package.json`(start/test/cov/gate/demo/cli/demo:log) + `.gitignore` + `README.md`（2026-09-12 完成；审查 `docs/reviews/P0-1.md`） |
| P0-2 `[x]` | 目录骨架：`shared/ server/{core,ai,data} cli/ tests/{contract,unit,integration,regression,api,cli,property,log,fixtures} scripts/ assets/`（不建 `public/`；另含 `tests/helpers/`，解读见 `docs/reviews/P0-2.md`） |
| P0-3 `[x]` | 测试基建：单进程 runner 固化、`tests/helpers/`（`gen.js` 种子化生成器、`log.js` 录制器——后者随 P0-4）、覆盖率阈值 —— 实测 §1.3 部分命令（start/gate/demo/cli 随 P0-8/P0-5/B11 落地） |
| P0-4 `[x]` | **日志子系统**：`shared/log.js`（UMD 零依赖）+ 注入 + `DL_LOG_*` + `tests/helpers/log.js` + `tests/log/*`（T-LG-1/2/3/6/7；审查 `docs/reviews/P0-4.md`） |
| P0-5 `[x]` | `scripts/gate.js`（9 项）+ `scripts/check-arch.js` + 静态检查（T-DC-3/4/5/6/7；项 4/5/8/9 接线待激活，见 `docs/reviews/P0-5.md`） |
| P0-6 `[x]` | `server/data/schema.js` + **`battle-config.json`** + 按 D-110~D-116 重建数据表 + `T-DC-1/2`（T-DC-2 已接线进 gate 项 5；审查 `docs/reviews/P0-6.md`） |
| P0-7 `[x]` | `docs/interfaces.md`（模块 ICD + API/CLI 契约 v1 + **D 编号落点表** + 日志事件登记）+ 契约测试骨架（T-DC-8；审查 `docs/reviews/P0-7.md`；gate 项 5 激活→7 PASS） |
| P0-8 `[x]` | HTTP 骨架（`/api/v1` + 统一信封 + `api.*` 日志 + health/data）+ CLI 骨架（子命令、退出码、`cli.*`）+ `tests/api`、`tests/cli`（审查 `docs/reviews/P0-8.md`；gate 项 9 激活→8 PASS） |
| P0-9 `[x]` | `assets/sprites.json`/`animations.json`（占位规格，作为数据表经 API 提供；审查 `docs/reviews/P0-9.md`） |

- **出口**：`npm run gate` 全绿；`cli health`、`cli data battle-config` 可用；trace 可见模块边界与 `api.req/res`。

### P1 确定性内核 + 战斗逻辑（11 批）

| 批次 | 接口 | 必绿测试点 | 日志 |
|---|---|---|---|
| B1 `[x]` | `rng.js`（**每 tick 每用途派生流** `deriveStream(tick,purpose)`，seed 绑定于 createRng）+ `field.js`（px 坐标/clamp/基地区域） | T-FD-1/2/3 + rng 确定性 | `rng.*`/`field.*`（审查 `docs/reviews/B1.md`） |
| B2 `[x]` | `effects.js`（addEffect 下一 tick 起效 / resolveContinuous / resolveControl 复写意图 / resolveControlMove 单方落位） | T-EF-1..5 + T-FD-4（`effects.*`；审查 `docs/reviews/B2.md`，P1×3 已修） |
| B3 `[x]` | `items.js` 数值层（roll/generate/openBox/applyAffixes/validateUnlock）+ 数据表（含 schema 变更） | T-IT-1/2/3/4/5/9 + T-RO-7 + T-DC-1/2 | `items.roll/generate/affix`（审查 `docs/reviews/B3.md`，P1×1 已修） |
| B4 `[x]` | `validateUnlock` + `unlock.js`（紫段位）+ `GET /api/v1/unlock` 端点 | T-IT-6 + T-UL-1..4 | `unlock.*`（审查 `docs/reviews/B4.md`，P2×3 已修） |
| B5 `[x]` | `roles.js`（含模板 regen；typeModifiers L9 入表） | T-RO-1..7 | `roles.*`（审查 `docs/reviews/B5.md`，P1×1 已修） |
| B6 `[x]` | `skills.js`（`falloff`/无 `bulletSpeed`/px 范围/四类型释放指令/路径弹幕） | T-SK-1..4 | `skills.*`（审查 `docs/reviews/B6.md`，P1×1 已修） |
| B7 `[x]` | `bullets.js`（**当 tick 全解算 + 连续碰撞方程 + 等级抵消 + 递归**） | T-BU-1..8 + **T-BT-8/19** | `bullets.*`（审查 `docs/reviews/B7.md`，P1×2 已修） |
| B8 `[x]` | `engine.js` 骨架：**§3.5.1 的 14 步管线**、行动集（含 `wait`/`defend`/`turn`）、统一落位、**角色碰撞与碰撞伤害**（基础链路）、资源恢复 | T-EN-1/10 + **T-BT-3/9/15/17** + T-LG-5 起常驻 | `engine.tick.*`/`collision.resolve`（审查 `docs/reviews/B8.md`，P1×1 已修；`turn` 为 2026-09-16 新增动作） |
| B9 `[x]` | 伤害链路（§3.5.5 八步：闪避/背击/暴击/吸血/真实/附加效果）+ 基地（撞基地）+ AOE 基准 + 背击（追尾语义拍板 2026-09-12） | T-EN-5/6/7/8 + T-EF-6 + **T-BT-6/7/12/16/18** | `damage.*`（审查 `docs/reviews/B9.md`，P2×3 已修） |
| B10 `[x]` | 结束判定 + 超时扣血 + `runFull`（回放一致 diffs） | T-EN-2/3/4 + **T-BT-2/4/11** | `battle.overtime/judge/end`（审查 `docs/reviews/B10.md`，P1×1 已修） |
| B11 `[x]` | diff/events/`cid` + `.audit/golden-battle.js|json`（固定 loadout×AI×seed；**18 tick / p2 胜**）+ `.audit/walkthrough.js`（真实引擎复算走查 §3.1）+ **门禁项 8 激活**；`tests/regression/golden-battle.test.js` **⏳ 计划（未实现）** | **T-BT-5/10/13/14** + T-LG-11 | `engine.tick.step` 全 14 步（审查 `docs/reviews/B11.md`，P1×1 已修；2026-09-16 复核：`.audit/verify-rest.js` 仍在库、黄金回归测试尚未落地） |

- **门禁**：每批 gate；B8 起**常驻四条硬回归**（同种子一致 / runFull=逐tick / 64 tick 内结束 / 日志不改结果）。
- **出口（2026-09-16 复核）**：硬编码 AI 跑通整场（含 48→64 超时路径）；**`npm run demo` 已可跑**——`scripts/demo.js` 已落地（此前脚本缺失，见安全登记册 SEC-19），默认 **seed 20260912**（与 gate 项 8 黄金战斗同源），输出逐 tick 摘要（`tick | px/hp/mp/sp | 命中位置 | 事件`）与最终结果；`npm run demo:log` ≡ trace；trace 可见碰撞方程解算过程。

### P2 自定义 AI（5 批）

| 批次 | 交付物 | 必绿测试点 | 日志 |
|---|---|---|---|
| B12 `[x]` | `ai/ast.js` 白名单 + 结构/深度/大小校验 + 稳定路径 id + **隐式主循环语义**（body=seq 契约）+ 覆盖型 fixtures | T-AI-2/11 + **T-AF-8/9** | `ai.validate`（审查 `docs/reviews/B12.md`，P1×2 已修） |
| B13 `[x]` | 合法性检测（**分支 action 规则** D-101）+ 段位门控 + 错误带 `path`（unlock.validateAi 退役整合） | T-AI-1/3/12 + T-UL-1..4 + **T-AF-5/10** | `ai.validate.reject`（审查 `docs/reviews/B13.md`，P2×4 已修） |
| B14 `[x]` | `ai/runtime.js` 显式状态机：作用域/循环/函数（独立作用域+调用栈）/break/每 tick 每用途随机流/只读快照 | T-AI-4/5/7/9 + **T-AF-1/2/3/11** | `ai.runtime.*`（审查 `docs/reviews/B14.md`，P0×1 已修） |
| B15 `[x]` | 限步/递归上限/错误兜底（返回 **`wait`**）+ trace + 病态 fixtures | T-AI-6/8/10 + **T-AF-4/6** | `ai.step.limit`/`ai.node`（审查 `docs/reviews/B15.md`，PASS） |
| B16 `[x]` | `canonicalize`/`programHash`/版本迁移 + `/ai/compile`、`/ai/validate`、`/ai/battle` + CLI `ai` 子命令 + 上下文序列化 | T-AP-1..5 + T-CLI-1 + T-LG-8/9 + **T-AF-7** | `ai.compile`/`ai.migrate`/`api.*`/`cli.*`（审查 `docs/reviews/B16.md`，P1×1 已修——函数体内嵌套帧序列化；P2×9 全落实） |

- **出口**：JSON AST 经 `/api/v1/ai/validate` → `/ai/battle` 打完一场；病态程序（含**某分支无 action**）被拒或兜底；T-AF-3/7/9/10 全绿。

### P3 物品与插件连接（5 批）

| 批次 | 交付物 | 必绿测试点 |
|---|---|---|
| B17 `[x]` | 开箱 + 掉落池门控 + `POST /api/v1/box` | T-IT-1/2/3/9 | `items.*`/`api.*`（审查 `docs/reviews/B17.md`，P1×1 已修——品质池截断重归一；P2×8 落实） |
| B18 `[x]` | 仓库 + **装配/拆卸 API**（槽位/点数/档位/词条聚合） | T-IT-7/10 + T-PB-1/2/3/4 | `items.assemble/disassemble/reject`（审查 `docs/reviews/B18.md`，P1×2 已修——插件当目标/畸形桶 500；P2 落实） |
| B19 `[x]` | loadout API + 校验 + `POST /api/v1/panel` | T-IT-8 + T-RK-6 | `api.reject`（审查 `docs/reviews/B19.md`，P1×3 已修——skills 畸形 500/双引用面板双计/无 warehouse 空转；P2×7 落实） |
| B20 `[x]` | 技能插件消耗补偿（逐档数组）与聚合 + 面板一致性 | T-PB-5/6/7/8/9 | `skill.plugin.apply`/`items.*`（审查 `docs/reviews/B20.md`，P1×1 已修——聚合路径未知模板 500；U-5d 真分支兑现） |
| B21 `[x]` | 属性测试全套 + 数值校准（只改数据表 + schema 冻结清单） | T-PB-10 + T-PB-1..10 全量 | D-127/D-128（审查 `docs/reviews/B21.md`，P1×1 已修——defK 未入冻结清单；数值全部定稿关闭开放项） |

### P4 回放数据（2 批）

| 批次 | 交付物 | 必绿测试点 |
|---|---|---|
| B22 `[x]` | 回放帧契约完备性（1px 位置、碰撞位置、cid、AI 轨迹）+ `POST /api/v1/battle` 完整帧 + `GET /api/v1/replay/:id` | T-EN-9 + **T-BT-1** | `events`/`battle.*`（审查 `docs/reviews/B22.md`，P1×2 已修——events 空心化/tick.end 入帧 + 同 seed 帧 ts 漂移） |
| B23 `[x]` | 文本回放器 CLI（`replay --file/--tick`，打印 px 位置与碰撞）+ 帧数据充分性审计 | T-CLI-1/2 | `cli.replay`（审查 `docs/reviews/B23.md`，P1×1 已修——畸形帧崩溃误报连接失败；第七维链/守恒审计落地） |

### P5 排位（2 批；**按 D-123 不做存档**）

| 批次 | 交付物 | 必绿测试点 |
|---|---|---|
| B24 `[x]` | 快照（不可变深拷贝）+ 匹配 10 场（bot 补齐）+ `POST /api/v1/ranked/run`（段位由请求传入/回带） | T-RK-1/5 | `ranked.snapshot/match`（审查 `docs/reviews/B24.md`，P1×1 已修——bot 技能不足 3 全 invalid；P2 落实） |
| B25 `[x]` | 晋升判定（x=6）+ 段位→奖励品质 + `POST /api/v1/ranked/promote` | T-RK-2/3/4 | `ranked.promote`（审查 `docs/reviews/B25.md`，PASS；P2-1/2/3 当批落实） |

> ~~B26 服务端存档~~ **取消**（D-123）：存档延后到 P6（localStorage）。
> **替代方案**：D-129 起服务端存档由 **P7（B27…B33）** 承担，见下。

### P7 在线服务与存档（**7 批；D-129…D-136**；设计权威：`docs/systems/11-account-store.md`）—— **✅ 已交付（2026-09-19）**

> **✅ 已交付（2026-09-19）**：B27–B33 共 7 批**全部落地**（`server/store/*`、`server/auth.js`、`server/account.js`、`server/quickmatch.js`、`server/admin.js`、`runtime/` 均已在库；`docs/reviews/B27.md`…`B33.md` 审查记录齐全）。交付实测：`npm test` 942 通过 / 0 失败、`npm run gate` 9 PASS/0 FAIL、`npm run check:docs` PASS、`npm run e2e` 22/22、`npm run load-test -- --players 50 --deep` 7/7 完整性断言。**已计入 §6 的 41 批。**

| 批次 | 交付物 | 必绿测试点 |
|---|---|---|
| B27 `[x]` | `server/store/*`：原子写（tmp→fsync→rename + Windows 重试）、append-only journal（group commit）、物化档案、索引、单进程锁、崩溃恢复、版本迁移、适配器契约（+ `service-config.json`/`rating-config.json` 两张参数表、`player.removed` 墓碑） | T-ST-1~8、T-CN-1 |
| B28 `[x]` | `server/auth.js`：注册/登录/登出/改密、scrypt、Bearer 会话、失败锁定与限速、鉴权中间件接入 `index.js` | T-AU-1~3 |
| B29 `[x]` | `server/account.js` + 配置槽（≤3、唯一出战、默认槽不可删）+ 快照冻结与内容寻址快照库 + GC（+ 快照自带装配引用子集） | T-AC-1~5、T-RP-3 |
| B30 `[x]` | 战绩视图：`me/records`、`me/defense`、`records/seen`、排行榜、索引增量维护 | T-ST-5 |
| B31 `[x]` | `ranked.js` 改造：服务端抽池（同段位 + 24h 硬底线/72h 优先去重）、双向记账（防守方只记战绩）、晋升落盘、回放引用；`battle.js` 帧 LRU 上限 | T-RK-1~5、T-RP-4 |
| B32 `[x]` | `server/quickmatch.js` + `rating-config.json`：积分窗口递进匹配、非对称 Elo 双向结算、leaderboard 联动 | T-QM-1~4 |
| B33 `[x]` | 回放按需重算与 `410 replay_expired`、`admin` 端点（bot 注入/重建索引/统计/封禁）、CLI 扩展、门禁与文档收尾（`scripts/bench-store.js` **未实现，后续批次**） | T-RP-1~2、`npm run gate` 9 PASS |

> **P7-5/P7-6/P7-7（同轮交付）**：P7-5 全链路 e2e（`npm run e2e`，22 检查点）、P7-6 批量测试（`npm run load-test`，真实玩家 + 7 条完整性断言）、P7-7 测试体系冗余与缺口审查（D-150③，见 `docs/reviews/P7-7-test-audit.md` 与 `docs/reviews/P7-7-wave2-code-review-residual.md`）。三者的阶段定义见 `docs/plan-p7-playable.md` §P7-5/§P7-6/§P7-7。

> **门禁同步（每批必查）**：`check-arch.js` 登记 `server/store/*` 与 `auth/account/quickmatch/admin`；`gate.js` 的 `PREFIX_MAP.ranked` 加 `'quick'`；项 9 接口冒烟加 `auth → me → configs → quick → replay → records` 闭环；`server/data/schema.js` 加 `service-config`/`rating-config`。**不得**修改 `server/core/*`、`server/ai/*`（战斗语义不变）。

### P6 前端（**设计待重做：旧 v3 设计已于 2026-09-20 全量作废并删除**）

仍在生效的产品约束：**无框架**、纯 DOM 视图（`state → 节点描述`）+ 自研 store（D-124）。**批次划分、屏幕清单与技术选型全部待重新设计**——旧 v3 稿（`docs/frontend-spec.md`）、旧布局快照（`docs/screens.md`）、文档自检器（`scripts/fe-spec-check.js`）、前端测试（`tests/frontend/*`）与真实响应样本（`.audit/fe-samples.*`）已于 2026-09-20 删除，**不得作为实现依据**。

**已落地分册（2026-09-20）**：`docs/frontend/00-rules.md`（总纲：协作协议 §2 / 绘制边界 §1 / 验收机制 §4；结论 FR-1…FR-8）+ `docs/frontend/01-auth.md`（**F1 登录与注册**：屏幕清单 / 按钮↔动作白名单 / 字段来源契约 / 全部失败路径 / 边界条件 / 静态托管契约 / 机器核对 / 人工走查剧本）。实现：`public/**`（零依赖双模模块）+ `server/index.js` 的同源静态托管；机器核对：`tests/frontend/*.test.js`（35 用例）；审查与走查记录：`docs/reviews/F1.md`。**F1 不新增批次号**（§6 仍为 41 批；P6 批次命名见 `00-rules.md` FR-6）。

**F2 账号管理与管理员面板（2026-09-22）**：设计冻结 `docs/frontend/02-accounts.md`（10 项端点映射 / 15 个新增动作 / 14 条新增字段契约 / 9 条边界 / 4 项机器核对 / 17 步走查剧本）。后端契约按 `decisions.md` **D-158** 落地（`DL_ADMIN_USERS` 管理员账号 + `checkAccess` 双路径授权 + 新增 `POST /admin/accounts`（分页、**total 无上限**）与 `POST /admin/delete-account`（`player.removed` 墓碑、禁删自己）+ admin 面豁免玩家级 `playerId` 一致性检查），机器核对 `tests/api/api-admin-accounts.test.js`（AA-1…AA-7）；前端管理面板与 F2 机器核对（含**后端 admin 能力 ↔ 前端面板双向相等**的 `admin-op-parity`）见 `docs/reviews/F2.md`。**F2 同样不新增批次号**（§6 仍为 41 批）。

**F3 物品线/主界面（2026-09-22 起）**：**后端契约已落地（D-159…D-162）**——仓库改为服务端权威（档案 `warehouse` 段 + `GET /me/warehouse` 真源 + `POST /me/warehouse/assemble|disassemble` + `PUT /me/warehouse` 退役为只校验形状）、注册即发 `starter` 并建满 3 槽（`server/starter.js`）、开箱收归服务端（`POST /me/box` 入档、无 `seed` 入参）、AI 库（`GET|POST /me/ai`、`DELETE /me/ai/:aiId`）、配置完整性校验时机（D-160）；端点真源见 `docs/interfaces.md` §2。**前端亦已全部落地**：提交② 主界面线（`hub`/`profile`/`warehouse`/`box`/`settings` + 4 空页；2026-09-24）、提交③ 出战配置编辑器（模板替换 / 插件装配的两步顺序 / AI 库选择 / 本地草稿；2026-09-25）；实现对账见 `docs/frontend/03-hub-warehouse-loadout.md` **§15.6/§15.7**。**唯一未完成项 = 浏览器人工走查**（分册 §11 的 25 步 + F2 的 17 步一次收口）→ **✅ 已完成并通过（2026-09-25，用户本人在真实浏览器执行；记录见 `docs/reviews/F3.md` §4）⇒ `F1`/`F2`/`F3` 均判定"能玩"**。**F3 同样不新增批次号**（§6 仍为 41 批；见 `docs/frontend/00-rules.md` FR-6）。

**F6 快速对战屏（2026-09-25 起）**：分册 `docs/frontend/04-quickmatch.md`。**零后端改动**（完全消费 D-167 的 `POST /quick/run` 内联帧 + `GET /replay/:id` + `GET /me/configs`）。前端新增：`quick` 真屏（结果行/抽池行/逐帧查看器）、共享战斗查看器状态 `state.viewer`（F7 复用）、AI 逻辑查看器弹窗（`ai-logic`：我方程序树 + 本帧执行标记 + 双方轨迹；对手只有轨迹 SEC-33）、9 个动作；机器核对 `tests/frontend/quick-battle-flow.test.js` QB-1…QB-10（真实 HTTP）。顺带修 `docs/interfaces.md` §4.3 的 `verdict`/`aiTrace` 两处文档漂移与 §2 `/quick/run` 错误码。**未完成项：浏览器人工走查**（分册 §11 的 12 步）→ 待用户执行，记录落 `docs/reviews/F6.md`。**F6 不新增批次号**（§6 仍为 41 批）。

**D-163 热修（2026-09-25，用户实测报告触发，非编号批次）**：用户走查后报告"同一个物品能被重复装配 / 被标记为已装配的物品无法被继续装配"。复现后**确认该报告**（同一件**无插件**的技能物品可占满同一份配置的 3 个技能位，连出战槽都 200；而插件在仓库层是独占的 ⇒ 两条规则不一致），并顺带查出两个更严重的真缺陷：① **P0 作弊面**——`PUT /me/configs/:slotId` 接受客户端提交的任意 `stats`（实测 `hp=100000/atk=99999`）甚至**仓库里不存在的 uid**，`activate` 后快照冻结该正文，而 `quick/ranked` 用的正是 `snapshot.loadout`（`battle.buildPlayer` 直接读 `role.stats`）⇒ 真实对局可被打穿（`security-backlog` 的 SEC-07"已处置"因此**复开并更正**）；② **开箱静默丢件**——物品 uid 由 `core/items.js` 的**进程级**计数器生成、重启后归零，撞车件被 apply 分支静默 `continue`（两进程实测：重启后开箱 12 件只落 2 件、日志 0 条，前端却提示"已入仓"）。**处置**（`decisions.md` **D-163**）：① 保存/创建/激活一律按 uid 从**服务端仓库**解析物品（客户端数值丢弃、未知 uid → 409 `物品不在仓库`），`loadout.buildPanel` 有仓库时同样先解析（纵深防御），HTTP 配置路由**不再采纳客户端 `warehouse` 镜像**；② 同一份配置内**全 uid 去重**（角色 + 3 技能 + 全部插件）、`skills.length > 3` 直接 409；③ **跨配置独占（用户裁定）**：一件物品同一时间只能被一份配置引用 → 409 **`item_in_use`**（推翻 D-159② "同物品可被多配置引用"）；④ 非出战槽仍可不完整，但只容忍"缺失类"错误（修前 `errors.length === 0` 前置让不完整配置整段跳过引用校验）；⑤ `store.grantBox` 在写 journal 前重映射撞车 uid（响应 = journal = 档案）+ 闸门丢弃改 `error` 日志与 `grantIds.dropped` 审计；⑥ 前端 `slot-pick`/`plugin-pick` 把"点了必然 409"的候选**预先标灰并写明原因**；⑦ 连带修正 `scripts/play.js` 的逐侧仓库（`npm run play` 曾被 D-163 的解析规则打坏）。**收口**：`npm test` / `npm run gate` / `npm run e2e` / `npm run play` 实测值见提交信息与 `docs/reviews/F3.md` §8。

**战斗线后端修复批（2026-09-25 起，D-164…，非编号批次）**：用户就"快速对战 / 锦标赛"逐条问答后冻结规格。**已交付**：`D-164` 守方 AI 完整镜像（`server/runner.js` 的 `mirrorSnapshot`/`unmirrorAction`/`makeAiDriver`；玩家 AI 一律按 p1 帧书写，p2 侧镜像快照 + 反镜像动作；内置对手排除；`tests/unit/ai-mirror.test.js` M-1…M-7）、`D-165` 回放 410 修复（`loadout.warehouseResolves` 与 `resolveItems` 同谓词 + 注入 bot 携带真实仓库；修前 bot 对手回放 10/10 场 410；`tests/api/api-replay-bot.test.js` RB-1/RB-2/RB-5）、`D-166` 注入 bot 多样化 + `preset` 参数（修前整批同程序 ⇒ 互打恒平局；RB-3/RB-4）、`D-167` 回放帧契约重构（引擎补画面字段 + `baseHits[]`/`damages[]`/弹幕完整生命周期；**对外帧去 `events`**；**`aiTrace` 双方都给**（SEC-33 已接受风险）；`GET /replay/:id?frames=debug` 管理员调试帧；`quick/run`·`ranked/run` 响应**内联全量帧**；`tests/api/api-match-frames.test.js` MF-1…MF-3）、`D-168` **软冷却取代 D-136 硬底线 + strict/relaxed 双池**（`opponentRecoveryHours=4` 线性回满；加权轮盘抽签；**永不因冷却 `no_opponent`**；删 `relaxed`、改回带 `recoveryHours`/`opponentWeight`；SEC-34 已接受风险）。**收口**：`npm test` = 1073 通过 / 0 失败、`npm run gate` = 9 PASS / 0 FAIL / 0 PEND、`check-docs` PASS（批次仍 41）、`check-arch` PASS（40 文件）。`D-169` **胜负口径统一**（`quick/run` 的 `winner` 改绝对口径 `p1/p2/draw`，与 ranked/帧/journal 同值；档案内每人 `result` 仍 `win/loss/draw`）、`D-170` **管理端改账号** `POST /admin/account-patch`（改任意账号段位/积分/入池，供验收造数据：部分更新、写 journal `account.patched` 可重放、**峰值只升不降**、不动战绩与仓库；前端管理面板同步「改账号（段位/积分）」按钮 + 三格输入，满足 D-158⑥ 双向相等；证据 `tests/api/api-admin-account-patch.test.js` AP-1…AP-8 + `tests/contract/store-contract.test.js` CN-12 + 前端四个契约测试）。**剩余（未做）**：无（本批后端任务已全部落地）。**本批不新增批次号**（§6 仍为 41 批）。

---

## 7. 前端（P6）—— **设计待重做**

> ⚠️ **本章原为"前端实现的唯一依据"（`docs/frontend-spec.md` v3），该设计已于 2026-09-20 按用户决策全量作废并删除**（连旧布局快照 `docs/screens.md`、文档自检器 `scripts/fe-spec-check.js`、测试 `tests/frontend/*`、真实响应样本 `.audit/fe-samples.*` 一并清理，以防旧稿影响新设计）。
>
> **重新设计前，本章不含任何实现依据。** 下列几条是**仍然生效的产品/工程约束**（与旧稿无关，来自 `docs/decisions.md`）：

- **无框架**（D-124）：纯 DOM 视图（`state → 节点描述`）+ 自研状态容器；不引入 Blockly 或任何需要 DOM 布局的第三方编辑器。
- **单一网络出口 / 单一 DOM 写入点**：网络调用与 DOM 写入各自收敛到一处，视图层只产出描述，保证可无头测试。
- **按钮永不无声**：每个可点元素必须命中一个已实现的动作分支，失败必须落到可见提示（旧轮"死按钮"是失败根因之一）。
- **字段名不得来自散文**：字段名只能取自**真实 HTTP 响应**；新设计需自带"文档 ↔ 真实响应"的机器核对手段（旧稿的做法是探针采样 + 自检器，已删除，可重新设计）。
- **禁止前端复制战斗公式**：伤害/命中/移动一律由服务端算，前端只消费帧。
- **验收**：机器测试不能证明"能玩"。每批必须在真实浏览器按端到端剧本人工走查（旧两轮 F0–F8 / R0–R7 均在测试全绿时不可玩）。
- **后端配合**：静态托管（`public/`、`/shared`、`/assets`）；服务端端点见 `docs/server.md` 与 `docs/systems/11-account-store.md`。
- **F3（物品线/主界面）已全部落地**——后端契约（D-159…D-162）：仓库服务端权威（真源 `GET /me/warehouse`，装配/拆卸走 `POST /me/warehouse/assemble|disassemble`）、注册即发 starter 并建满 3 槽、`POST /me/box` 服务端权威开箱（无 `seed` 入参）、AI 库 `me/ai*`、配置完整性校验时机（D-160）；前端：提交② 主界面线 + 提交③ 出战配置编辑器。实现对账见 `docs/frontend/03-hub-warehouse-loadout.md` §15.6/§15.7（端点真源 `docs/interfaces.md` §2）。~~未完成项：浏览器人工走查~~ → **✅ 人工走查已通过（2026-09-25，用户本人；`docs/reviews/F3.md` §4）**；`D-163` 热修亦已交付（同上 §8）。**F3 不新增批次号**（§6 仍为 41 批）。

- **F6（快速对战屏 + 战斗查看器 + AI 逻辑查看器）前端已落地（2026-09-25）**：分册 `docs/frontend/04-quickmatch.md`；实现与机器核对见 §6「F6 快速对战屏」一段。**未完成项：浏览器人工走查**（§11 的 12 步）→ 待用户执行，记录落 `docs/reviews/F6.md`。

---


| 里程碑 | 内容 | 对应 | 出口证据 |
|---|---|---|---|
| MS0 后端可跑 | 服务 + `/api/v1` + CLI + 门禁 + 日志总控 | P0 | gate 全绿 + CLI 输出 |
| MS1 引擎可跑 | 硬编码 AI 打完一场 + 四条硬回归 + 战斗不变量 + 黄金复现 | P1 | `demo` 输出 + T-BT-* + trace/cid 样例 |
| MS2 自定义 AI 可用 | AST 校验/编译/执行/轨迹经 API 可达 | P2 | fixtures + T-AF-3/7/9/10 |
| MS3 有养成 | 开箱/仓库/插件连接/出战配置经 API 闭环 | P3 | T-PB-1..10 + CLI 闭环 |
| MS4 回放自足 | 完整帧 + 文本回放 | P4 | T-BT-1 + 帧字段审计 |
| MS5 有排位 | 快照/匹配/晋升 | P5 | `ranked run` 闭环 |
| MS6 有界面 | 前端全套 + 前端日志 | P6 | 待排期 |
| MS7 有档案与在线对战 | 账号/服务端档案/异步排位双向记账/快速对战积分/回放鉴权 | P7 **✅ 已达成（2026-09-19）** | `cli` 注册→保存配置→快速对战→查防守战绩闭环 + `npm run gate` 9 PASS（**实测**：`npm run e2e` 22/22、`npm run load-test -- --players 50 --deep` 7/7） |

---

## 9. 风险与开放问题

| # | 问题 | 状态/默认 | 期限 |
|---|---|---|---|
| R1 | 紫段位解锁内容 | ✅ **已决**：概率随机 + 扩展运算符（D-120） | 已决 |
| R2 | 函数参数/返回值 | ✅ **已决**：= 打包代码块，无参无返回，有独立作用域+调用栈（D-102/103） | 已决 |
| R3 | `costDelta` 基础值 / 最大插件点数 | ✅ **已决**：统一 `costDeltaByTier` 逐档数组 + `items-data` 建议点数（D-113/116） | 已决 |
| R4 | 晋升阈值 / 段位→品质 | ✅ **已决**：x = 6，段位序号即品质上限（D-122） | 已决 |
| R5 | 存档位置 | ✅ **已决**：**D-129 服务端存档**（`runtime/`，段位/积分/配置槽/战绩落盘）→ **D-159 起仓库/物品/装配/AI 库也改服务端权威**（推翻 D-130 的"仓库仍客户端"）；D-123 的"不做存档"已推翻 | 已决 |
| R6 | 前端框架 | ✅ **已决**：无框架（D-124） | 已决 |
| R7 | 沙箱多进程 runner 不可用 | ✅ 已定：单进程 `--test-isolation=none` | 已决 |
| R8 | 美术占位规格细节 | 按 `items-data` §1（本轮只作数据表） | P6 前 |
| R9 | 数值平衡 | ✅ **已决（B21 校准收口，D-128）**：机制冻结、数值全部入表（battle-config 无占位项） | 已决 |
| R10 | 日志体积/性能失控 | 环形缓冲 + 采样 + 禁用零成本 | 已定（P0-4） |
| R11 | 日志与确定性互相污染 | 注入 logger + 不耗 RNG + T-LG-5 | 已定（B8 起） |
| R12 | 日志携带巨大载荷 | 默认摘要，trace 才完整 | 已定 |
| R13 | API 契约变更成本高 | `/api/v1` 前缀 + 统一信封 + 契约测试 | 已定（P0-7/8） |
| R14 | 无 UI 时流程正确性难判断 | CLI 文本回放 + 逐 tick 摘要 + `cid` 因果链 + trace | 已定（B11/B23） |
| **R16** | **设计文档需同步重写受影响章节**（D-126） | 我按 `decisions.md` 逐章重写 `v3-design` / `systems/*` / `items-data` | **P0-7 前** |
| **R17** | **`dodge` 的闪避加成数值** | ✅ **已决（B21 校准，D-127）**：`dodgeChanceBonus = +20%`（叠加面板 dodgeChance，封顶 1） | 已决 |
| **R18** | 文档编辑工具纪律 | ✅ 已加入铁律 L17（禁用 PS 5.1 读写中文文档） | 已定 |
| **R19** | **混合权威导致段位/积分不可信**（D-130） | **D-159（2026-09-22）已关闭其中"客户端权威仓库 ⇒ 可携带任意属性 loadout"这条路径**（仓库/物品/装配/开箱改服务端权威，`11-account-store.md` §15.1.1 已标**已处置**并附证据；`docs/security-backlog.md` 的 SEC-07 同步回填）；**但"段位/积分仍不具竞技可信度"的结论保留**（残余：`wins`/`pool` 等入参、"理论上限校验"未做），风险登记见 `11-account-store.md` §15.1.3 | 已知风险（范围已收窄） |
| **R20** | **回放与引擎/数据版本强耦合**（D-135） | 版本不匹配返回 `410 replay_expired`；是否改存帧见 `11-account-store.md` §15.5 Q3 | 已定（可再议） |
| **R21** | **单进程 JSON 存储的容量上限** | 实测 0.175~0.280 ms/场、索引 ~200 B/玩家；>5 万玩家或写 QPS >500 时切 `node:sqlite` 适配器（`11-account-store.md` §11.4） | 已定（有判据） |

---

## 10. 变更控制

1. **权威顺序**：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > 本文件；冲突时先改文档再改代码。
2. **接口变更**：模块签名/结构/`/api/v1` 契约变更先在 `docs/interfaces.md` 记录（原因、影响、迁移）再全量回归；B8 后强制。
3. **战斗机制变更**：§3.5 任何条款变更视为接口变更，需同步 `decisions.md`、`battle-config.json`、测试与本文档。
4. **日志事件变更**：新增/改名/改级别需同步 `§4.6`、通道注册表与断言（T-DC-6 拦截）。
5. **阈值变更**：覆盖率/门禁调整需单独 commit 并说明理由。
6. **数据表变更**：改 `server/data/*.json` 必须同步 `items-data.md` 且 T-DC-1/2 保持绿。
7. **每批完成后**更新本文件批次状态与测试数字。

---

## 11. 全局自检（每阶段结束）

- [ ] `npm run gate` 全绿（测试 + 覆盖率 + 静态 + 数据 + 文档一致性 + D 编号落点 + 日志规范 + 接口冒烟 + CLI 闭环）
- [ ] 四条硬回归常驻全绿：同种子一致 / runFull=逐tick / 64 tick 内结束 / **日志不改结果**
- [ ] 本阶段测试点（§3.2）全绿，无 `skip`/`todo`
- [ ] `§4.6` 覆盖矩阵事件全部实现且有断言；`cid` 因果链可追（T-LG-11）
- [ ] **接口自足**：能力全部经 `/api/v1` 或 CLI 可达（L14）
- [ ] **战斗不变量 T-BT-1..29** 全绿（含连续碰撞精度、弹幕不跨 tick、D-72 位移三态免疫、`turn` 朝向）
- [ ] **插件连接 T-PB-1..10**、**自定义 AI T-AF-1..11** 全绿
- [ ] `server/core/**` 无 `console.*`/IO/`Math.random`/`eval`；战斗数值均来自 `battle-config.json`
- [ ] AI 隐式主循环、分支 action 合法性（含"call 行动产出定点分析"）、字段枚举校验、步数兜底（返回 `wait`）生效；未解锁内容不可用
- [ ] 控制效果在 AI 返回后复写；超时扣血精确
- [ ] 每批都有 `docs/reviews/BXX.md` 审查记录
- [ ] 未使用 v2 资源；未提前实现任何 UI
- [ ] 未用 PowerShell 5.1 读写中文文档（L17）
