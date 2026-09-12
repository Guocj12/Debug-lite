# Debug-Lite v3 接口冻结（ICD v1）

> 版本：v1　创建：2026-09-12（P0-7）　**本文件是接口唯一权威**（L1）；接口变更走 `docs/tasks.md` §10。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > 本文件 > `docs/tasks.md`。
> 落点约定：每条 D-编号在本文件**至少出现一次**（T-DC-8 机器核对，见 §5 与 `tests/integration/interfaces.test.js`）。

---

## §0 文档体系与同步约定

- `decisions.md`（D-01…D-126）为最高权威；本文件与 `systems/*`、`v3-design.md`、`tasks.md` 冲突时按权威链修正（D-126 同步重写）。
- `battle-walkthrough.md` 只讲系统间数值与状态传递（六条边界，D-125）；计算细节由 `examples/*` 负责。

---

## §1 模块 ICD（对准 `tasks.md` §2.2；括号内为落地批次）

| 模块 | 导出接口 | 依赖（层） | 批次 |
|---|---|---|---|
| `shared/log.js` | `createLogger` / `nullLogger` / `LEVELS`；logger：`on` / `log` / `fatal..trace` / `setLevel` / `setChannelLevel` / `reset` / `dump` / `records` / `stats`；`parseLevel` / `parseChannelOverrides` / `CHANNELS` | 零依赖 UMD（L-1） | P0-4 ✅ |
| `core/rng.js` | `createRng(seed,{logger})`；`float/int/pick/chance(...,purpose)`、`state/restore`；**`deriveStream(tick, purpose)`**（seed 于 createRng 绑定，D-90/D-91） | L0 | B1 ✅ |
| `core/field.js` | `FIELD_PX/CELL_PX/ACTOR_HALF/START_X/START_FACING/BASE_DEF`；`clampX` / `cellOf` / `xCenter` / `cellRange` / `baseOf` / `touchesBase` | L0 + battle-config（D-04/D-05） | B1 |
| `core/effects.js` | `addEffect(state, effect)`（补 uid + addedTick，下一 tick 起效）/ `resolveContinuous(state)`（clamp/递减/移除，入口先清 remaining≤0）/ `resolveControl(effects, aiAction)` → `{action}`（'wait' 眩晕；`{action:'forced_move',dir,cells}` 位移意图，B8 落位；无控制原样）/ `resolveControlMove(x, otherX, displacement)`（单方落位 gap≥64 + clamp，T-FD-4）/ `withLogger` | L1 | B2 ✅ |
| `core/items.js`（数值） | `getQuality` / `rollQuality` / `rollSlotCount` / `tierOf` / `generateRoleItem` / `generateSkillItem` / `generatePlugin` / `openBox` / `applyAffixes` / `validateUnlock` | L1 + 数据表 | B3 |
| `core/items.js`（仓库） | `createWarehouse` / `addItem` / `assemble` / `disassemble` / `buildLoadout` / 序列化往返 | L3（同文件双分层，见 check-arch 契约） | B18 |
| `core/unlock.js` | `tierIndex` / `isUnlocked` / `filterByTier` / `validateAi` / `validateLoadout` / `availableNodes` | L1 + unlock.json | B4 |
| `core/roles.js` | `instantiateRole` / `applyTypeModifier` / `equipPlugins` / `getFinalStats` | L2 | B5 |
| `core/skills.js` | `instantiateSkill` / `applySkillPlugins` / `canCast` / `buildSkillAction` / `coveredCellRanges` | L2 + field/battle-config | B6 |
| `core/bullets.js` | `spawnBullets(battle, act)` / `resolveBullets(battle, ctx)`（当 tick 全解算→{spawns,collides,hits,expires}）/ `solveIntersection(x1,v1,x2,v2,tMax,tMin)`（连续方程原语）/ `bulletBattle(a,b)`（等级矩阵：b1/b2/both/none）/ `bulletsOnField(battle)` | L2 | B7 ✅ |
| `core/engine.js` | `createBattle(config)`（`config.logger` 注入）；battle：`step/runFull/judge/state`；`dealDamage`；`normalizeAction`；`resolveActorCollision` | L4（编排 L0~L2，不依赖 L5；AI 由 server 层注入） | B8~B11 |
| `ai/ast.js` | `validateProgram` / `checkLegality`（含分支 action 规则 D-101）/ `collectUsedNodeTypes` / `canonicalize` / `programHash` / `nodePathOf` / `limits` | L5（只依赖 L0/L1） | B12~B13 |
| `ai/runtime.js` | `createContext` / `resume(ctx,snapshot,rng)` / `serializeContext` / `restoreContext` / `destroyContext` / `STEP_LIMIT` | L5 | B14~B15 |
| `server/index.js` | `/api/v1`（§2） | L6 | P0-8 |
| `server/ranked.js` | `submitLoadout` / `takeSnapshot` / `runRankedBattle` / `promote` / `tierReward`（D-123：不持久化） | L6 | P5 |
| `cli/index.js` | 子命令（§3）；**只走 HTTP 不 require core**（L14） | L6 | P0-8 |
| `server/data/schema.js` | `validateStructure(dataDir, assetsDir?)`（T-DC-1，assets 占位表经可选 assetsDir 校验，缺省推导 `<repo>/assets`）/ `validateConsistency(dataDir)`（T-DC-2）/ `validate` | 数据层 | P0-6 ✅（P0-9 扩展） |

**依赖分层**（tasks §2.1）：`L-1 shared/log.js`｜`L0 rng·field`｜`L1 effects·items(数值)·unlock`｜`L2 roles·skills(实例化)·bullets`｜`L3 items(仓库)·skills(释放)`｜`L4 engine`｜`L5 ai/ast·ai/runtime`｜`L6 server·cli`｜`L7 public(P6)`。方向检查见 `scripts/check-arch.js` 契约。

## §2 HTTP API 契约 v1（`/api/v1`；唯一将来 UI 数据源，L15）

| 方法 | 路径 | 用途 | 主要错误码 | 批次 |
|---|---|---|---|---|
| GET | `/api/v1/health` | 存活与版本 | — | P0-8 |
| GET | `/api/v1/data/:table` | 数据表（含 battle-config） | 404 `unknown_table` | P0-8 |
| GET | `/api/v1/unlock?tier=` | 该段位可用节点/模板/技能 | 400 `bad_tier` | B4 接 |
| POST | `/api/v1/box` | 开箱（seed/tier/次数） | 400 / 409 `tier_locked` | B17 |
| GET | `/api/v1/warehouse` | 仓库（分桶 + 装配状态） | — | B18 |
| POST | `/api/v1/warehouse/assemble` | 装配 | 409 `slot_type_mismatch`/`points_exceeded`/`slot_occupied`/`tier_locked` | B18 |
| POST | `/api/v1/warehouse/disassemble` | 拆卸 | 404 `slot_empty`/`plugin_missing` | B18 |
| GET/POST | `/api/v1/loadout` | 读取/保存出战配置（**无持久化**，D-123） | 409 `loadout_invalid` | B19 |
| POST | `/api/v1/panel` | 最终面板（五维/regen/special/技能参数） | 409 | B19 |
| POST | `/api/v1/ai/validate` | 静态校验 + 合法性 + 门控；错误带路径 | 400 `ai_invalid` | B16 |
| POST | `/api/v1/ai/compile` | 规范化 + programHash + 统计 | 400 `ai_too_large` | B16 |
| POST | `/api/v1/ai/battle` | 给定 AI 跑一场（服务端重新执行，T-AP-4） | 400 / 409 | B16 |
| POST | `/api/v1/battle` | 双方 loadout + AI + seed → 完整回放帧 | 409 | B11/B22 |
| GET | `/api/v1/replay/:id` | 取回放帧（`?from=&to=` 分片） | 404 | B22 |
| POST | `/api/v1/ranked/run` | 排位：抽 10 场离线结算（段位由请求传入/回带，D-123） | 409 `no_loadout` | B24 |
| POST | `/api/v1/ranked/promote` | 晋升 + 段位奖励（x=6，D-122） | 409 | B25 |
| GET/POST | `/api/v1/log-level` | 日志总控（非 production） | 400 `bad_level` | P0-8 |

- 统一信封：成功 `{ok:true, data, log:{level,events}}`；失败 `{ok:false, error:{code,message,details}}`。
- 随机性由请求 `seed` 显式传入（缺省服务端生成并**回带**）（T-AP-5，D-90/D-91）。

## §3 CLI 契约 v1（本轮唯一"操作台"，L14）

```
box --seed 1 --tier common --times 10
wh list|assemble|disassemble ...
panel --loadout <file>
ai validate|compile|battle --file ai.json [--tier rare] [--opponent kiter]
battle --p1 a.json --p2 b.json --seed 7 [--out replay.json]
replay --file replay.json [--tick N]        # 文本回放（含 px 位置）
ranked run --seed 11                        # D-123：不持久化
log --level trace --channel bullets=trace
health | data <table>
```
- 退出码：`0` 成功 / `1` 业务拒绝 / `2` 参数错误（T-CLI-2）。
- **只走 HTTP，不 require core**；同时是接口完整性验收工具（T-CLI-1 闭环）。

## §4 冻结数据结构（v1）

1. **BattleState**：`tick/seed/players{p1,p2}/bases/events[]/rngStreams`。
2. **玩家运行时**：`x`（px，1px 精度）/`facing`/`hp,mp,sp`/`maxHp,maxMp,maxSp`/`atk,def`/`regen{mp,sp}`/`special`/`cooldowns{}`/`effects[]`/`aiContext`/`defending`。
3. **回放帧 `frame`**：`tick` + `diff{players[],bullets[],bases[],events[],aiTrace[]}`；位置、碰撞位置、命中位置均 **1px**；事件带 `cid`（D-17/D-23）。
4. **物品/技能实例/loadout/AI AST**：`decisions.md` 与 `v3-design` §4.4/§6.3/§12.2/§11.5 冻结；`loadout = {role, skills[3], ai}`（T-RK-6）。
5. **AiContext**：`programHash/frames[]/vars/halted/stepCount/trace/entry`（**可序列化**）。
6. **LogRecord**：`seq/ts/cid/tick/level/levelValue/channel/event/msg/data`（§6 登记）。
7. **battle-config.json**（D-117）：§2.5.7 冻结值逐值校验（T-DC-1，schema.js）。

## §5 D 编号落点表（T-DC-8 机器核对：每条 D-xx 在本文件或数据表文本中出现）

| D | 落点 | | D | 落点 | | D | 落点 |
|---|---|---|---|---|---|---|---|
| D-01 | §4.7 battle-config（fieldPx/cellPx） | | D-02 | §1 field.js（1px 精度） | | D-03 | §4.7 startX |
| D-04 | §1 field.js clampX | | D-05 | §4.7 bases | | D-06 | §4.7 minGapPx/actorHalfPx |
| D-07 | §4.7 movePx/dodgePx + §1 skills | | D-08 | §1 bullets.collideAt | | D-10 | §1 engine.resolveActorCollision + §4.7 collisionDmgMul |
| D-11 | §1 engine 移动解算 | | D-12 | §1 engine 移动解算 | | D-13 | §1 engine 移动解算 |
| D-14 | §1 engine 移动解算 | | D-15 | §1 skills/effects | | D-16 | §4.7 movePx/dodgePx + §1 skills（行动集 move/dodge） |
| D-17 | §4.3 frame diff（1px 碰撞位置） | | D-18 | §1 skills/bullets（位移伤害统一模型） | | D-19 | §1 skills（恰好相邻不算接触） |
| D-20 | §1 bullets（当 tick 全解算） | | D-21 | §1 schema.js（无 bulletSpeed） | | D-22 | §1 bullets.spawn |
| D-23 | §1 bullets.collideAt | | D-24 | §1 bullets（AOE 位移后基准） | | D-25 | §1 bullets（命中次数） |
| D-26 | §1 bullets（每格独立） | | D-27 | §1 bullets.resolveAll（生成顺序） | | D-28 | §1 bullets（弹幕互撞） |
| D-29 | §1 skills falloff + skill-templates.json | | D-30 | §1 bullets（区间含终点） | | D-31 | §1 bullets（无经过格列表） |
| D-32 | §1 bullets（t=0 同格拦截） | | D-33 | §1 engine（互穿各进一格） | | D-34 | §1 engine/field（位移技撞基地） |
| D-35 | §1 effects/engine（被动位移碰撞） | | D-40 | §1 engine.dealDamage + §4.7 baseHitMul/baseDef | | D-41 | §1 engine.dealDamage（一次取整） |
| D-42 | §4.7 backstab/crit | | D-43 | §4.7 defendDefMul | | D-44 | §1 engine.dealDamage（吸血） |
| D-45 | §1 items/roles（词条聚合） | | D-46 | §1 items（概率封顶） | | D-50 | §1 engine（背击用位移后） |
| D-51 | §1 engine（背击判定表） | | D-60 | §1 bullets/field（弹幕不伤基地） | | D-61 | §1 field + §4.7 bases |
| D-62 | §1 field（基地不反击） | | D-70 | §1 skills（fullDodgeDuring） | | D-71 | §1 effects（控制位移不可穿） |
| D-72 | §1 effects/bullets/**engine**（fullDodge 完整语义） | | D-80 | §1 engine.normalizeAction（wait 归一化） | | D-81 | §1 ast/runtime（步数兜底） |
| D-82 | §1 engine（冷却递减） | | D-83 | §1 engine（控制复写时机） | | D-84 | §1 engine/effects（复写不扣资源） |
| D-90 | §1 rng（全局种子） | | D-91 | §1 rng.deriveStream | | D-92 | §1 rng（禁 Math.random，L11） |
| D-100 | §1 ast（隐式主循环） | | D-101 | §1 ast.checkLegality（分支 action） | | D-102 | §1 ast（函数无参无返回） |
| D-103 | §1 runtime（独立作用域） | | D-104 | §1 runtime STEP_LIMIT | | D-110 | role-templates.json regen + schema.js |
| D-111 | skill-templates.json slotWeights + schema.js | | D-112 | 三表 unlockTier + unlock.json | | D-113 | plugins.json costDeltaByTier + schema.js |
| D-114 | plugins.json（变体独立 id） | | D-115 | §1 skills（参数取整下限） | | D-116 | qualities.json pluginPoints + schema.js |
| D-117 | battle-config.json + schema.js | | D-118 | skill-templates.json bulletLevel | | D-120 | unlock.json（紫段位 random+扩展） |
| D-121 | qualities.json costDeltaBase | | D-122 | §2 ranked/promote（x=6） | | D-123 | §2/§3（无持久化，P5） |
| D-124 | §2/§3（P6 无框架存根） | | D-125 | §0（走查定位） | | D-126 | §0（同步重写约定） |

## §6 日志事件登记（§4.6 覆盖矩阵；实现批次标注，T-LG-4 断言于此）

| 层 | 通道 | 必须事件（级别） | 批次 |
|---|---|---|---|
| L0 | rng | `rng.create`(info) / `rng.draw`(trace) / `rng.stream`(debug) | B1 |
| L0 | field | `field.clamp`(trace) / `field.base`(debug) | B1 |
| L1 | effects | `effect.add`(debug) / `effect.continuous`(trace) / `effect.expire`(debug) / `effect.control.override`(debug) | B2 |
| L1 | items | `items.roll.quality`(debug) / `items.generate`(debug) / `items.affix.apply`(trace) / `items.assemble`(info) / `items.reject`(warn) | B3/B18 |
| L1 | unlock | `unlock.check`(debug) / `unlock.reject`(warn) | B4 |
| L2 | roles | `role.instantiate`(debug) / `role.panel`(debug) | B5 |
| L2 | skills | `skill.instantiate`(debug) / `skill.plugin.apply`(debug) / `skill.cast`(info) / `skill.reject`(warn) / `skill.area`(trace) | B6 |
| L2 | bullets | `bullet.spawn`(debug) / `bullet.collide`(debug) / `bullet.hit`(debug) / `bullet.expire`(trace) | B7 |
| L4 | engine | `battle.create`(info) / `tick.begin`(info) / `tick.step`(debug，14 步各一条) / `move.resolve`(debug) / `collision.resolve`(info) / `resource.regen`(trace) / `battle.overtime`(info) / `tick.end`(info) / `battle.judge`(info) / `battle.end`(info) / `action.invalid`(warn) | B8~B11 |
| L4 | damage | `damage.calc`(debug) / `damage.dodge`(debug) / `damage.lifesteal`(trace) | B9 |
| L5 | ai.ast | `ai.validate`(debug) / `ai.validate.reject`(warn) / `ai.compile`(debug) / `ai.migrate`(info) | B12~B16 |
| L5 | ai.runtime | `ai.resume`(debug) / `ai.node`(trace) / `ai.action`(info) / `ai.step.limit`(warn) / `ai.depth.limit`(warn) / `trace.truncated`(warn) | B14~B15 |
| L6 | api | `api.req`(info) / `api.res`(info) / `api.err`(error) | P0-8 |
| L6 | cli | `cli.invoke`(info) / `cli.result`(info) | P0-8 |
| L6 | ranked | `ranked.snapshot`(debug) / `ranked.match`(info) / `ranked.promote`(info) | B24~B25 |
| P6 | store/view/render/editor | `store.dispatch` / `view.render` / `render.frame` / `render.sprite` / `editor.ast.*` —— 仅登记 | P6 |

- 跨系统边界事件统一 `debug` 级：`{dir:'in'|'out', fn, args:摘要, result:摘要}`（§4.6 注）。
- 命名规范由 `scripts/gate.js` 项 6① 强制（通道注册表 + 前缀映射，T-DC-6）。

## §7 环境与门禁契约（引用）

- 测试 runner / 覆盖率 / 嵌套 run() 限制：`tests/README.md` + `scripts/README.md`（**4 条实测机制**，勿违反）。
- 数据表契约与冻结数值：`server/data/README.md`。
- 目录分层与架构检查：`scripts/README.md`「check-arch.js 契约」。