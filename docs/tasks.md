# Debug-Lite v3 开发计划与任务清单

> 版本：v3-plan-6　更新：2026-09-11
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
npm run demo        # 跑一场并打印逐 tick 摘要
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
L6  server/index.js (/api/v1) · server/runner.js (AI 编排) · server/box.js (开箱编排) · server/loadout.js (出战/面板编排) · cli/
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
| `core/skills.js` | `instantiateSkill` / `applySkillPlugins` / `canCast` / `buildSkillAction` / `coveredCellRanges` |
| `core/bullets.js` | `spawn` / `resolveAll(bullets, actors, config)`（**当 tick 全解算**）/ `collideAt`（连续方程）/ 等级比较 |
| `core/engine.js` | `createBattle(config)`（`config.logger` 注入）；battle：`step/runFull/judge/state`；`dealDamage`；`normalizeAction`；`resolveActorCollision` |
| `core/unlock.js` | `tierIndex` / `isUnlocked` / `filterByTier` / `validateAi` / `validateLoadout` / `availableNodes` |
| `ai/ast.js` | `validateProgram` / `checkLegality`（**含分支 action 规则 D-101**）/ `collectUsedNodeTypes` / `canonicalize` / `programHash` / `nodePathOf` / `limits` |
| `ai/runtime.js` | `createContext` / `resume(ctx,snapshot,rng)` / `serializeContext` / `restoreContext` / `destroyContext` / `STEP_LIMIT` |
| `server/index.js` | §2.3 |
| `cli/index.js` | §2.4 |

**日志注入**：参与战斗/生成/AI 执行的公开函数通过 options 接收 `logger`（缺省 `nullLogger`）；`engine` 向下透传。core 内不得 `require` sink、不得 IO。

### 2.3 HTTP API 契约 `/api/v1`（冻结；未来 UI 的唯一数据来源）

| 方法 | 路径 | 用途 | 主要错误码 |
|---|---|---|---|
| GET | `/api/v1/health` | 存活与版本 | — |
| GET | `/api/v1/data/:table` | 数据表（含 `battle-config`） | 404 `unknown_table` |
| GET | `/api/v1/unlock?tier=` | 该段位可用节点/模板/技能 | 400 `bad_tier` |
| POST | `/api/v1/box` | 开箱（seed/tier/次数） | 400 / 409 `tier_locked` |
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
| POST | `/api/v1/ranked/run` | 排位：抽 10 场离线结算（段位由请求传入/回带） | 409 `no_loadout` |
| POST | `/api/v1/ranked/promote` | 晋升 + 段位奖励 | 409 |
| GET/POST | `/api/v1/log-level` | 日志总控（非 production） | 400 `bad_level` |

- **统一信封**：成功 `{ok:true,data,log:{level,events}}`；失败 `{ok:false,error:{code,message,details}}`。
- 随机性由请求 `seed` 显式传入（缺省服务端生成并**回带**），保证可复现。

### 2.4 CLI 契约（本轮唯一"操作台"）

```
box --seed 1 --tier common --times 10
wh list|assemble|disassemble ...
panel --loadout <file>
ai validate|compile|battle --file ai.json [--tier rare] [--opponent kiter]
battle --p1 a.json --p2 b.json --seed 7 [--out replay.json]
replay --file replay.json [--tick N]        # 文本回放（含 px 位置）
ranked run --seed 11
log --level trace --channel bullets=trace
health | data <table>
```
- 退出码：`0` 成功 / `1` 业务拒绝 / `2` 参数错误。
- CLI **只走 HTTP，不 require core** → 同时是接口完整性验收工具。

### 2.5 冻结的数据结构

1. **BattleState**：`tick/seed/players{p1,p2}/bases/events[]/rngStreams`。
2. **玩家运行时**：`x`（**px，1px 精度**）/`facing`/`hp,mp,sp`/`maxHp,maxMp,maxSp`/`atk,def`/`regen{mp,sp}`/`special`/`cooldowns{}/effects[]/aiContext/defending`。
3. **回放帧 `frame`**：`tick` + `diff{players[],bullets[],bases[],events[],aiTrace[]}`；位置、**碰撞位置、命中位置均为 1px 精度**；事件带 `cid`。
4. **物品实例 / 技能实例 / loadout / AI AST**：以 `decisions.md` 与重写后的 `v3-design` §4.4/§6.3/§12.2/§11.5 为冻结版本。
5. **AiContext**：`programHash/frames[]/vars/halted/stepCount/trace/entry`（**必须可序列化**）。
6. **LogRecord**：`seq/ts/cid/tick/level/levelValue/channel/event/msg/data`。
7. **`battle-config.json`**（新增，D-117）：`cellPx=64`/`fieldPx=1024`/`actorHalfPx=32`/`movePx=64`/`dodgePx=128`/`collisionDmgMul=0.8`/`baseHitMul=0.8`/`baseDef=64`/`defendDefMul=1.6`/`dodgeChanceBonus=0.20`(占位)/`backstab=1.5`/`crit=1.5`/`overtimeStart=48`/`overtimeRatio=0.0625`/`hardCapTick=64`。
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

**T-LG 日志**：T-LG-1 级别/通道过滤｜T-LG-2 记录结构（含 `cid`）｜T-LG-3 未知通道警告｜T-LG-4 覆盖矩阵事件｜T-LG-5 **日志不改结果**（silent vs trace 逐帧一致）｜T-LG-6 环形缓冲/`suppressed`/`dump`｜T-LG-7 禁用零成本｜T-LG-8 API/CLI 日志｜T-LG-9 总控开关｜T-LG-10 前端绘制日志（P6）｜T-LG-11 **因果链完整：一次命中可从 `skill.cast` 沿同一 `cid` 追到 `tick.end`**

**T-AP / T-CLI / T-PB / T-AF / T-DC**

| 编号 | 测试点 | 批次 | 类型 |
|---|---|---|---|
| T-AP-1 | 每端点正常返回符合信封 | 各 API 批次 | 正常 |
| T-AP-2 | 每端点参数错误 → 400 + `error.code` | 各 API 批次 | 失败 |
| T-AP-3 | 每端点业务拒绝 → 409 + `error.code` | 各 API 批次 | 失败 |
| T-AP-4 | 服务端重新执行 AI，不信任客户端结果 | B16 | 失败 |
| T-AP-5 | seed 显式化：带 seed 请求可复现、响应回带 seed | B16 | 确定 |
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

---

### 3.5 战斗规范（依据 `docs/decisions.md` 冻结）

> **权威来源**：本节规则来自 `docs/decisions.md`（`D-01`…`D-126`），高于原设计文档；受影响章节将同步重写（D-126）。

#### 3.5.1 tick 管线（冻结，14 步）

| # | 步骤 | 内容 | 日志事件 |
|---|---|---|---|
| 1 | `tick.begin` | `tick+=1`；按 **D-91** 派生本 tick 各用途随机流；引擎冷却递减（D-82）；重置临时标记 | `tick.begin`(info) |
| 2 | `effects.resolveContinuous` | 持续效果 `stat += delta`；clamp；`remaining-=1` 归零移除 | `effect.continuous`(trace)/`effect.expire`(debug) |
| 3 | `ai.resume` | 按 **p1 → p2** 各调用一次，产出 action + trace | `ai.resume`(debug)/`ai.node`(trace)/`ai.action`(info) |
| 4 | `action.normalize` | 白名单校验；非法 → **`wait`**（D-80） | `action.invalid`(**warn**) |
| 5 | `effects.resolveControl` | 控制效果复写行动（眩晕 > 位移；位移取首个）；控制位移不可穿敌（D-71） | `effect.control.override`(debug) |
| 6 | `action.commit` | 只算意图：转向 / 防御标记（def×1.6，D-43）/ 目标位置 / 技能 `canCast`→扣资源+写 CD+**生成弹幕（记录生成序号）** | `skill.cast`(info)/`skill.reject`(**warn**) |
| 7 | `move.resolve` | 统一落位 → 穿敌判定（D-11~15）→ **角色碰撞解算与碰撞伤害**（D-10，1px）→ clamp | `move.resolve`(debug)/`collision.resolve`(info) |
| 8 | `bullets.resolve` | 按**生成先后顺序**遍历（D-27）：每枚**当 tick 飞完全射程**（D-20），与角色轨迹**解方程**判命中（D-23），与敌方弹幕解方程判碰撞并**递归**（D-28）；AOE 用**位移后位置**（D-24） | `bullet.spawn`/`bullet.collide`/`bullet.hit`/`bullet.expire` |
| 9 | `damage` | 按 §3.5.4 结算（闪避→基础→背击→暴击→吸血→附加效果） | `damage.dodge`/`damage.calc`/`damage.lifesteal` |
| 10 | `regen` | `mp/sp +=` 模板 regen（D-110），封顶 | `resource.regen`(trace) |
| 11 | `overtime` | `tick ≥ 48` → 双方基地与角色**同时**扣 `ceil(maxHp×0.0625)` | `battle.overtime`(info) |
| 12 | `judge` | 基地≤0 → 角色≤0；优先级基地 > 角色；同级同时 → 平局 | `battle.judge`(info)/`battle.end`(info) |
| 13 | `diff.emit` | 产出 frame，位置/碰撞/命中均 1px 精度 | `tick.end`(info) |
| 14 | 传入下一 tick | — | — |

- **弹幕不跨 tick**：步骤 8 结束时场上无存活弹幕。
- **同时行动**：步骤 6 只算意图、步骤 7 统一落位。
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
- **碰撞伤害**：双方各受对方 `atk×0.8`，标准减伤，允许闪避/暴击/背击/吸血；碰撞位置按速度解方程，1px 输出。

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

#### 3.5.6 背击与基地（D-50 ~ D-62）

- **背击**：用**本 tick 位移后**的位置与朝向；近战/位移看相对位置与朝向，平射看弹幕来向，**垂直永不触发**。
- **基地**：⚠️ **弹幕不造成任何基地伤害**；唯一途径是"面向基地并向基地方向移动" → **停在原地** + `atk×0.8` 走基地 `def=64` 减伤；基地不反击。

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

见 `§3.2` 的 **T-BT-1..19**。

#### 3.5.9 战斗走查（**正在按新规范重写**）

1. 按 §3.5 新规范重写整场战斗，位置用**连续 px 坐标**；
2. 用**新的独立校验器**重新验算（含碰撞方程、命中位置、抵消链）后，方可作为 B11 黄金用例 `T-BT-13/14`；
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

- 节点：`literal/get/bullets/var/set/getVar/arith/cmp/logic/random/if/loop/break/function/call/action` + `seq`。
- 路径 id 在执行期由位置生成（`body.s[3].then.s[0]`），**与编辑器无关**；API 校验错误返回 `path` 供未来 UI 高亮。

#### 3.7.3 隐式主循环（D-100）

⚠️ **AI 最外层是一个无法跳出的 `while(true)`**：程序运行到最后**自动回到第一行**；该结构由引擎隐式提供、在编辑器中**显式可见且无法删除**。因此 AI 无需（也不应在）自己写外层循环。

#### 3.7.4 解释器：显式状态机（可序列化）

```
AiContext = { programHash, frames[{nodeId,kind,phase,childIndex,remaining,scopeDepth}], vars, halted, stepCount, trace, entry }
```
- `stepOnce()` 只推进一个微步骤；`resume()` 循环直到产出 `action` 或触及 `STEP_LIMIT`（限步/trace/挂起集中一处，杜绝"每 tick 重跑"）。
- **函数（D-102/D-103）**：= 打包代码块，**无参数无返回值**，但**拥有独立局部变量作用域与调用栈**（可读外层变量，内部 `var` 不泄漏）；进入顶层 `seq` 时先注册全部函数（hoisting）；递归深度上限 64。
- **循环**：`count` 用帧内 `remaining`；`while` 每次迭代先求值条件；`break` 用信号对象向上找最近 `loop` 帧。
- **随机（D-90/D-91）**：每局一个全局种子；**每 tick 每用途各派生一条流** `hash(seed, tick, purpose)`（`ai`/`crit`/`dodge`）；仅在实际求值 `random` 时消耗。
- **可序列化**：`serializeContext/restoreContext` 往返后继续执行结果一致（T-AF-7）。

#### 3.7.5 合法性检测（D-101）

1. 结构：白名单节点、字段类型、深度/节点数/字节上限、危险键。
2. **循环体内所有分支都必须至少包含一个 `action`**（比"循环体含 action"更严格；允许 `while(true)`）。
3. 段位门控：用到的节点必须已解锁（紫段位解锁 `random` + 扩展运算符）。
4. 循环外 `break`、未知函数调用等结构错误 → 拒绝并给 `path`。

#### 3.7.6 只读快照与安全默认值

白名单投影 `self{hp,atk,def,sp,mp,x,baseHp,facing}` / `enemy{同}` / `bullets[{owner,level,dir,x,type}]`；深冻结；AI 只能写 `vars`；越界读取 → 安全默认（0/false）并记 trace。

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
| L1 | `items` | `items.roll.quality`(debug) / `items.generate`(debug) / `items.affix.apply`(trace) / `items.assemble`(info) / `items.reject`(**warn**) |
| L1 | `unlock` | `unlock.check`(debug) / `unlock.reject`(**warn**) |
| L2 | `roles` | `role.instantiate`(debug) / `role.panel`(debug) |
| L2 | `skills` | `skill.instantiate`(debug) / `skill.plugin.apply`(debug) / `skill.cast`(info) / `skill.reject`(**warn**) / `skill.area`(trace，px 区间) |
| L2 | `bullets` | `bullet.spawn`(debug，含起点/方向/射程 px) / `bullet.collide`(debug，含碰撞位置与等级比较) / `bullet.hit`(debug，含 1px 命中位置与 cid) / `bullet.expire`(trace) |
| L4 | `engine` | `battle.create`(info) / `tick.begin`(info) / `tick.step`(debug，14 步各一条) / `move.resolve`(debug) / `collision.resolve`(info，含双方速度与碰撞位置) / `resource.regen`(trace) / `battle.overtime`(info) / `tick.end`(info) / `battle.judge`(info) / `battle.end`(info) / `action.invalid`(**warn**) |
| L4 | `damage` | `damage.calc`(debug，含每步中间值) / `damage.dodge`(debug) / `damage.lifesteal`(trace) |
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

---

## 6. 阶段与批次（后端优先，共 35 批）

> **P0–P5 全为后端**；**P6 前端延后**。每批必须：① 满足 `§4.6` 事件；② 有日志断言；③ 经 `/api/v1` 或 CLI 可达。

### P0 后端基建与契约（9 批）

| 批次 | 交付物 |
|---|---|
| P0-1 `[x]` | `package.json`(start/test/cov/gate/demo/cli/demo:log) + `.gitignore` + `README.md`（2026-09-12 完成；审查 `docs/reviews/P0-1.md`） |
| P0-2 `[x]` | 目录骨架：`shared/ server/{core,ai,data} cli/ tests/{contract,unit,integration,regression,api,cli,property,log,fixtures} scripts/ assets/`（不建 `public/`；另含 `tests/helpers/`，解读见 `docs/reviews/P0-2.md`） |
| P0-3 `[x]` | 测试基建：单进程 runner 固化、`tests/helpers/`（`gen.js` 种子化生成器、`log.js` 录制器——后者随 P0-4）、覆盖率阈值 —— 实测 §1.3 部分命令（start/gate/demo/cli 随 P0-8/P0-5/B11 落地） |
| P0-4 | **日志子系统**：`shared/log.js` + 注入 + `DL_LOG_*` + `tests/log/*`（T-LG-1/2/3/6/7） |
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
| B8 `[x]` | `engine.js` 骨架：**§3.5.1 的 14 步管线**、行动集（含 `wait`）、统一落位、**角色碰撞与碰撞伤害**（基础链路）、资源恢复 | T-EN-1/10 + **T-BT-3/9/15/17** + T-LG-5 起常驻 | `engine.tick.*`/`collision.resolve`（审查 `docs/reviews/B8.md`，P1×1 已修） |
| B9 `[x]` | 伤害链路（§3.5.5 八步：闪避/背击/暴击/吸血/真实/附加效果）+ 基地（撞基地）+ AOE 基准 + 背击（追尾语义拍板 2026-09-12） | T-EN-5/6/7/8 + T-EF-6 + **T-BT-6/7/12/16/18** | `damage.*`（审查 `docs/reviews/B9.md`，P2×3 已修） |
| B10 `[x]` | 结束判定 + 超时扣血 + `runFull`（回放一致 diffs） | T-EN-2/3/4 + **T-BT-2/4/11** | `battle.overtime/judge/end`（审查 `docs/reviews/B10.md`，P1×1 已修） |
| B11 `[x]` | diff/events/`cid` + `.audit/golden-battle.js`（固定 loadout×AI×seed）+ `.audit/verify-rest.js` + **黄金战斗回归**（快照锚定）+ **门禁项 8 激活** | **T-BT-5/10/13/14** + T-LG-11 | `engine.tick.step` 全 14 步（审查 `docs/reviews/B11.md`，P1×1 已修） |

- **门禁**：每批 gate；B8 起**常驻四条硬回归**（同种子一致 / runFull=逐tick / 64 tick 内结束 / 日志不改结果）。
- **出口**：硬编码 AI 跑通整场（含 48→64 超时路径）；`npm run demo` 输出逐 tick 摘要（含 px 位置与碰撞）；trace 可见碰撞方程解算过程。

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
| B20 | 技能插件消耗补偿（逐档数组）与聚合 + 面板一致性 | T-PB-5/6/7/8/9 |
| B21 | 属性测试全套 + 数值校准（只改数据表） | T-PB-10 + T-PB-1..10 全量 |

### P4 回放数据（2 批）

| 批次 | 交付物 | 必绿测试点 |
|---|---|---|
| B22 | 回放帧契约完备性（1px 位置、碰撞位置、cid、AI 轨迹）+ `POST /api/v1/battle` 完整帧 + `GET /api/v1/replay/:id` | T-EN-9 + **T-BT-1** |
| B23 | 文本回放器 CLI（`replay --file/--tick`，打印 px 位置与碰撞）+ 帧数据充分性审计 | T-CLI-1/2 |

### P5 排位（2 批；**按 D-123 不做存档**）

| 批次 | 交付物 | 必绿测试点 |
|---|---|---|
| B24 | 快照（不可变深拷贝）+ 匹配 10 场（bot 补齐）+ `POST /api/v1/ranked/run`（段位由请求传入/回带） | T-RK-1/5 |
| B25 | 晋升判定（x=6）+ 段位→奖励品质 + `POST /api/v1/ranked/promote` | T-RK-2/3/4 |

> ~~B26 服务端存档~~ **取消**（D-123）：存档延后到 P6（localStorage）。

### P6 前端（**延后，本轮不排批次**）

无框架：纯函数 `render(state) → HTML` + 自研 store（D-124）。含 Blockly 编辑器、仓库/装配、开箱、对战回放、HUD、AI 轨迹可视化 + 前端绘制日志（T-LG-10）。

---

## 7. 前端架构规范（**P6 参考，本轮不实现**）

- **屏幕**：`menu/editor/warehouse/gacha/battle/replay/settings`；切换只走 `store.dispatch({type:'goto'})`。
- **分层**：`api/`（唯一网络出口）→ `store/`（唯一状态源）→ `views/*.render(state) → HTML`（**纯函数**）→ `mount/`（唯一 DOM 写入点）；`render/` 只消费 diff，**禁止复制战斗算法**。
- **视觉令牌**：`public/css/tokens.css`；禁止行内样式与魔法数字。
- **每屏出口**：四态齐全、纯函数测试、无算法复制、每次绘制有 `render.frame` 日志、截图核对。
- Blockly 集成：由 `mount` 独占 DOM，纯函数视图不参与其内部重绘。

---

## 8. 里程碑

| 里程碑 | 内容 | 对应 | 出口证据 |
|---|---|---|---|
| MS0 后端可跑 | 服务 + `/api/v1` + CLI + 门禁 + 日志总控 | P0 | gate 全绿 + CLI 输出 |
| MS1 引擎可跑 | 硬编码 AI 打完一场 + 四条硬回归 + 战斗不变量 + 黄金复现 | P1 | `demo` 输出 + T-BT-* + trace/cid 样例 |
| MS2 自定义 AI 可用 | AST 校验/编译/执行/轨迹经 API 可达 | P2 | fixtures + T-AF-3/7/9/10 |
| MS3 有养成 | 开箱/仓库/插件连接/出战配置经 API 闭环 | P3 | T-PB-1..10 + CLI 闭环 |
| MS4 回放自足 | 完整帧 + 文本回放 | P4 | T-BT-1 + 帧字段审计 |
| MS5 有排位 | 快照/匹配/晋升 | P5 | `ranked run` 闭环 |
| MS6 有界面 | 前端全套 + 前端日志 | P6 | 待排期 |

---

## 9. 风险与开放问题

| # | 问题 | 状态/默认 | 期限 |
|---|---|---|---|
| R1 | 紫段位解锁内容 | ✅ **已决**：概率随机 + 扩展运算符（D-120） | 已决 |
| R2 | 函数参数/返回值 | ✅ **已决**：= 打包代码块，无参无返回，有独立作用域+调用栈（D-102/103） | 已决 |
| R3 | `costDelta` 基础值 / 最大插件点数 | ✅ **已决**：统一 `costDeltaByTier` 逐档数组 + `items-data` 建议点数（D-113/116） | 已决 |
| R4 | 晋升阈值 / 段位→品质 | ✅ **已决**：x = 6，段位序号即品质上限（D-122） | 已决 |
| R5 | 存档位置 | ✅ **已决**：本轮不做，延后 P6（D-123） | 已决 |
| R6 | 前端框架 | ✅ **已决**：无框架（D-124） | 已决 |
| R7 | 沙箱多进程 runner 不可用 | ✅ 已定：单进程 `--test-isolation=none` | 已决 |
| R8 | 美术占位规格细节 | 按 `items-data` §1（本轮只作数据表） | P6 前 |
| R9 | 数值平衡 | 机制先冻结、数值入表，B21 校准 | B21 |
| R10 | 日志体积/性能失控 | 环形缓冲 + 采样 + 禁用零成本 | 已定（P0-4） |
| R11 | 日志与确定性互相污染 | 注入 logger + 不耗 RNG + T-LG-5 | 已定（B8 起） |
| R12 | 日志携带巨大载荷 | 默认摘要，trace 才完整 | 已定 |
| R13 | API 契约变更成本高 | `/api/v1` 前缀 + 统一信封 + 契约测试 | 已定（P0-7/8） |
| R14 | 无 UI 时流程正确性难判断 | CLI 文本回放 + 逐 tick 摘要 + `cid` 因果链 + trace | 已定（B11/B23） |
| **R16** | **设计文档需同步重写受影响章节**（D-126） | 我按 `decisions.md` 逐章重写 `v3-design` / `systems/*` / `items-data` | **P0-7 前** |
| **R17** | **`dodge` 的闪避加成数值未定**（仅知"2 格可穿"） | `battle-config.dodgeChanceBonus` 占位 +20% | B21 校准 |
| **R18** | 文档编辑工具纪律 | ✅ 已加入铁律 L17（禁用 PS 5.1 读写中文文档） | 已定 |

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
- [ ] **战斗不变量 T-BT-1..19** 全绿（含连续碰撞精度与弹幕不跨 tick）
- [ ] **插件连接 T-PB-1..10**、**自定义 AI T-AF-1..11** 全绿
- [ ] `server/core/**` 无 `console.*`/IO/`Math.random`/`eval`；战斗数值均来自 `battle-config.json`
- [ ] AI 隐式主循环、分支 action 合法性、步数兜底（返回 `wait`）生效；未解锁内容不可用
- [ ] 控制效果在 AI 返回后复写；超时扣血精确
- [ ] 每批都有 `docs/reviews/BXX.md` 审查记录
- [ ] 未使用 v2 资源；未提前实现任何 UI
- [ ] 未用 PowerShell 5.1 读写中文文档（L17）
