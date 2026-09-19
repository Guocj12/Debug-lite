# Debug-Lite v3 接口冻结（ICD v1）

> 版本：v1　创建：2026-09-12（P0-7）　更新：2026-09-16（数据驱动改造 / `turn` 动作 / 枚举校验 / 计划项显式标注）　**本文件是接口唯一权威**（L1）；接口变更走 `docs/tasks.md` §10。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > 本文件 > `docs/tasks.md`。
> 落点约定：每条 D-编号在本文件**至少出现一次**（T-DC-8 机器核对，见 §5 与 `tests/integration/interfaces.test.js`）。

---

## §0 文档体系与同步约定

- `decisions.md`（D-01…D-136）为最高权威；本文件与 `systems/*`、`v3-design.md`、`tasks.md` 冲突时按权威链修正（D-126 同步重写）。
- **D-129 起服务端持久化玩家档案（⏳ 计划（P7/B27–B33），未实现）**：账号/配置槽/段位/积分/战绩/回放引用**设计为**服务端权威（`11-account-store.md`）；**仓库与物品仍由客户端 localStorage 持有**（D-130，混合权威，作弊面已在 `11-account-store §15.1` 登记）。**现状（2026-09-16 实测）**：`server/store/`、`server/auth.js`、`server/account.js`、`server/quickmatch.js`、`runtime/` 均不存在；现行 P5 段位/仓库口径仍是 D-123 的"请求传入并回带、不持久化"。
- `battle-walkthrough.md` 只讲系统间数值与状态传递（六条边界，D-125）；计算细节由 `examples/*` 负责。

---

## §1 模块 ICD（对准 `tasks.md` §2.2；括号内为落地批次）

| 模块 | 导出接口 | 依赖（层） | 批次 |
|---|---|---|---|
| `shared/log.js` | `createLogger` / `nullLogger` / `LEVELS`；logger：`on` / `log` / `fatal..trace` / `setLevel` / `setChannelLevel` / `reset` / `dump` / `records` / `stats`；`parseLevel` / `parseChannelOverrides` / `CHANNELS` | 零依赖 UMD（L-1） | P0-4 ✅ |
| `core/rng.js` | `createRng(seed,{logger})`；`float/int/pick/chance(...,purpose)`、`state/restore`；**`deriveStream(tick, purpose)`**（seed 于 createRng 绑定，D-90/D-91） | L0 | B1 ✅ |
| `core/field.js` | `FIELD_PX/CELL_PX/ACTOR_HALF/START_X/START_FACING/BASE_DEF`；`clampX` / `cellOf` / `xCenter` / `cellRange` / `baseOf` / `touchesBase` | L0 + battle-config（D-04/D-05） | B1 |
| `core/effects.js` | `addEffect(state, effect)`（补 uid + addedTick，下一 tick 起效）/ `resolveContinuous(state)`（clamp/递减/移除，入口先清 remaining≤0）/ `resolveControl(effects, aiAction)` → `{action}`（'wait' 眩晕；`{action:'forced_move',dir,cells}` 位移意图，B8 落位；无控制原样）/ `resolveControlMove(x, otherX, displacement)`（单方落位 gap≥64 + clamp，T-FD-4）/ `withLogger` | L1 | B2 ✅ |
| `core/items.js`（数值） | `getQuality` / `rollQuality` / `rollSlotCount` / `tierOf` / `generateRoleItem` / `generateSkillItem` / `generatePlugin` / `openBox` / `applyAffixes` / `validateUnlock`。**段位门控默认关闭**（`unlock.json` → `gating.enabled=false`，用户决策 2026-09-16）：`validateUnlock` 恒 true、`rollQuality` 不做品质池截断、`dropPool` 不按 `unlockTier` 过滤、`assemble` 不产生 `tier_locked`；开关开启时行为不变。测试可注入 `withGating(true\|false)` | L1 + 数据表 | B3（2026-09-16 门控默认关闭） |
| `core/items.js`（仓库，L3） | `emptyWarehouse` / `assemble(wh,{targetUid,pluginUid,slotIndex,tier})` / `disassemble(wh,{targetUid,slotIndex})` / `buildLoadout`（B19） / 序列化往返 | L3（同文件双分层，见 check-arch 契约） | B18/B19 |
| `core/unlock.js` | `tierIndex` / `isUnlocked` / `filterByTier` / `validateLoadout` / `availableNodes`（**validateAi 于 B13 退役**，AI 程序校验由 ai/ast.validate 统一承担）。**`availableNodes(tier)` 只返回真实节点类型**（`ai-nodes.json` 的 `nodes`，16 类；`base` 9 类；`unlock.json` 的 `nodePermissions` 负责权限名→节点展开：`while` 折叠 `loop`、`implemented:false` 的 `arith_ext` 不授予）；段位累计数 10/12/14/14/16（**门控开启时**）。**段位门控默认关闭**（用户决策 2026-09-16）：开关 = `unlock.json` → `gating.enabled`（当前 `false`）；缺省实例下 `isUnlocked` 恒 true、`filterByTier` 原样返回、`validateLoadout` 恒 `{ok:true,errors:[]}`、`availableNodes` 恒全 16 类；测试可注入 `withGating(true\|false)`（同风格工厂见 items/ast/roles/loadout） | L1 + unlock.json/ai-nodes.json | B4 ✅（2026-09-16 口径收口 + 门控默认关闭） |
| `core/roles.js` | `instantiateRole` / `applyTypeModifier` / `equipPlugins` / `getFinalStats`（`regen{hp,mp,sp}`，含角色插件 `*_regen` 词条叠加） | L2 | B5 |
| `core/skills.js` | `instantiateSkill` / `applySkillPlugins` / `canCast` / `buildSkillAction` / `coveredCellRanges`。**数据驱动（2026-09-16）**：类型机制（params/slots/`emit.pattern`）读 `skill-mechanics.json`，词条算子（`skillOp`/`hitEffect`/`castEffect`）读 `affix-registry.json`，代码只解释表里声明的 `pattern`/`op`，不按类型或词条 id 写分支；输出 `skill.specials`（概率类）/`castEffects`（释放类）/`affixes`（命中类） | L2 + field/battle-config + 机制表 | B6 ✅（2026-09-16 数据驱动改造） |
| `core/bullets.js` | `spawnBullets(battle, act)` / `resolveBullets(battle, ctx)`（当 tick 全解算→{spawns,collides,hits,expires}）/ `solveIntersection(x1,v1,x2,v2,tMax,tMin)`（连续方程原语）/ `bulletBattle(a,b)`（等级矩阵：b1/b2/both/none）/ `bulletsOnField(battle)` | L2 | B7 ✅ |
| `core/engine.js` | `createBattle(config)`（`config.logger` 注入；数值读 battle-config，含 B21 校准 `dodgeChanceBonus`(D-127)/`defK`(D-128)/`baseHitMul`）；battle：`step/runFull/judge/state`；`dealDamage`；`normalizeAction`（**行动集 = `move_left/move_right/dodge_left/dodge_right/wait/defend/turn`**，非法 → `wait` D-80）；`resolveActorCollision`。**2026-09-16 接线**：`turn` 在步骤 7 写回朝向（move/dodge/位移不改朝向）、`fullDodgeDuring` 三态（步骤 6 置位/步骤 1 复位）、`castEffects` 步骤 6 入队（下一 tick 起效 D-70）、步骤 10 `regen.hp`、撞基地用 `baseHitMul` | L4（编排 L0~L2，不依赖 L5；AI 由 server 层注入） | B8~B11/B21 |
| `ai/ast.js` | `validateProgram`（结构 + **字段枚举校验**：`logic.op∈{and,or}`、`loop.kind∈{count,while}` 且 count 必填 `times`/while 必填 `cond`、`arith.op∈{+,-,*,/}`、`cmp.op∈{>,<,>=,<=,==,!=}` → `bad_enum`）/ `checkLegality`（分支 action 规则 D-101 + **call 行动产出定点分析**）/ `collectUsedNodeTypes` / **`validate(program, tier)`（结构+合法性+门控三段合一，B13）** / `canonicalize` / `programHash`（纯 JS sha256） / `statsOf` / `getNodeAtPath` / `migrateProgram` / `nodePathOf` / `limits` / `CURRENT_VERSION` / `MIGRATIONS`。**动作名不做校验期拒绝**（D-80：`action.name` 是自由标签，词汇表见 `ai-nodes.json` 的 `actions`） | L5（只依赖 L0/L1） | B12~B16 ✅ |
| `ai/runtime.js` | `createContext` / `resume(ctx,snapshot,rng)` / `getVar` / `serializeContext` / `restoreContext` / `destroyContext` / `STEP_LIMIT` / `TRACE_LIMIT` / `RECURSION_LIMIT`。**序列化产物**（§4.5）：`programHash/entry/frames[{kind,path,childIndex,remaining,condValue,fnScope}]/vars/halted/stepCount/trace/stepLimit/traceLimit/recursionLimit/traceTruncated` | L5 | B14~B16 ✅ |
| `server/index.js` | `/api/v1`（§2） | L6 | P0-8 |
| `server/runner.js` | `compileAi(program, logger)` / `runAiBattle({program,seed,tier,opponent,logger})` / `projectSnapshot(state,owner)` / `OPPONENTS` / `baselinePlayer` | L6 | B16 ✅ |
| `server/box.js` | `openBoxes({seed,tier,times,items?,logger})`（校验 + 每箱独立 rng 流 + 409 映射）/ `BOX_TIMES_MAX` | L6 | B17 ✅ |
| `server/loadout.js` | `EMPTY_LOADOUT` / `validateLoadout(loadout,{warehouse,tier})`（I-12 全案 + T-PB-9 引用完整 + T-PB-8 双引用 + 门控）/ `buildPanel`（五维/regen/special/技能参数聚合）。**2026-09-16 修复**：面板投影白名单补 `specials`/`castEffects`/`affixes`，并叠加角色插件 `hp_regen/sp_regen/mp_regen` 到 `regen`（此前 API 路径会静默丢失这些机制） | L6 | B19 |
| `server/ranked.js` | `submitLoadout` / `takeSnapshot` / `runRankedBattle` / `promote` / `tierReward`（现行 = 无状态：段位由入参传入/回带、`pool` 由请求提供；**⏳ 计划（B31，未实现）**：D-129 起改为档案驱动——服务端抽池 + 双向记账，见 `11-account-store §7`） | L6 | P5 ✅ / B31 ⏳ |
| `server/store/*`（L6 新增） | `store.open/close`；`store.loadArchive/saveArchive`（原子写）；`store.append(record)`（journal，group commit）；`store.applyRecord(record)`（幂等 apply）；`store.recover()`；`store.index.*`（load/rebuild/byTier/leaderboard）；`store.snapshot.*`（put/get/gc，内容寻址）；`store.sessions.*`。**唯一允许 `node:fs` 的目录** | L6 | ⏳ 计划（B27，未实现） |
| `server/auth.js`（L6 新增） | `register` / `login` / `logout` / `changePassword` / `authenticate(token)` / 限速与失败锁定（D-129§4） | L6 + store | ⏳ 计划（B28，未实现） |
| `server/account.js`（L6 新增） | `getSummary` / `listConfigs` / `saveConfig` / `activateConfig` / `createSlot` / `deleteSlot` / `saveWarehouseMirror` / `records(since)` / `markSeen` / `defenseSummary`（D-131/D-134） | L6 + store | ⏳ 计划（B29/B30，未实现） |
| `server/quickmatch.js`（L6 新增） | `runQuickMatch({playerId,seed})` / `match(points)`（窗口递进 + 对手去重）/ `settle(record)`（非对称 Elo，D-133） | L6 + engine + store | ⏳ 计划（B32，未实现） |
| `server/admin.js`（L6 新增） | `injectBots(opts)`（bot 档案，D-132§7.6）/ `rebuildIndex` / `stats` / `ban`；需 `DL_ADMIN_TOKEN` | L6 + store | ⏳ 计划（B33，未实现） |
| `cli/index.js` | 子命令（§3）；**只走 HTTP 不 require core**（L14） | L6 | P0-8 |
| `server/data/schema.js` | `validateStructure(dataDir, assetsDir?)`（T-DC-1，assets 占位表经可选 assetsDir 校验，缺省推导 `<repo>/assets`）/ `validateConsistency(dataDir)`（T-DC-2）/ `validate` | 数据层 | P0-6 ✅（P0-9 扩展） |
| `server/data/{skill-mechanics,affix-registry,ai-nodes}.json`（2026-09-16 新增机制表） | 技能类型机制（params/slots/`emit.pattern`/`_emitPatterns`）/ 词条语义（`agg`/`skillOp`/`hitEffect`/`castEffect`，未登记 id 由 gate 拦下）/ AI 真实节点 `nodes`(16)+`base`(9)+`actions` 词汇表（`bullets` 已于 2026-09-17 按用户决策移除——AI 无法观测弹幕，弹幕当 tick 全解算）。三表是 `core/skills.js`、`core/engine.js`、`core/unlock.js`、`ai/ast.js` 的**单一数据源**（代码不再按类型/词条 id 写分支） | 数据层 | 2026-09-16 数据驱动改造 |

**依赖分层**（tasks §2.1）：`L-1 shared/log.js`｜`L0 rng·field`｜`L1 effects·items(数值)·unlock`｜`L2 roles·skills(实例化)·bullets`｜`L3 items(仓库)·skills(释放)`｜`L4 engine`｜`L5 ai/ast·ai/runtime`｜`L6 server·cli`｜`L7 public(P6)`。方向检查见 `scripts/check-arch.js` 契约。

**§1 附注（P7-2 交付：`server/auth.js` + `server/account.js` 已实现，2026-09-16）**：两文件均为 L6 工厂 + 结果信封（`{ok, status, code, message, data, details}`，P7-4 直接映射 HTTP；`ok/fail/statusOf` 由 account.js 导出、auth.js 复用）。
- `server/auth.js`：`createAuth({store, account?, logger?, now?, config?})` → `register({username,password,nickname?,ip?,userAgent?,warehouse?})` / `login({username,password,ip?,userAgent?})` / `logout({token})` / `changePassword({token,playerId?,oldPassword,newPassword})` / `authenticate(token)`（返回 `ctx.player`，含 `playerId/publicId/tier/points/slots`）/ `listSessions(playerId)` / `revokeAllSessions(playerId)`；纯函数导出 `hashPassword` / `verifyPassword` / `validatePassword` / `validateUsername` / `randomToken` / `tokenHashOf` / `hash16` / `createFailureLimiter` / `normalizeScrypt`。错误码：`bad_request`(400) / `weak_password`(400) / `username_taken`(409) / `invalid_credentials`(401) / `unauthorized`(401) / `too_many_attempts`(429) / `banned`(403) / `forbidden`(403)。凭据为 `{algo:'scrypt',N,r,p,salt,hash,username,usernameLower}`（`username` 原大小写、索引键 lowercase；§5.2 无 username 字段，故随 `auth` 落档）。
- `server/account.js`：`createAccount({store, logger?, now?})` → `getSummary` / `listConfigs` / `createSlot` / `saveConfig` / `activateConfig` / `deleteSlot` / `saveWarehouseMirror({playerId,warehouse})` / `getWarehouseMirror(playerId)` / `records({playerId,since?,limit?,role?})` / `markSeen({playerId,uptoSeq})` / `defenseSummary({playerId,limit?})` / `setNickname({playerId,nickname})` / `createPlayerArchive({nickname,auth,loadout?,warehouse?,tier?})`（注册事务：冻结默认快照 → `store.createAccount`）；纯函数导出 `defaultLoadout` / `validateLoadoutOf` / `validateWarehouseMirror` / `ok` / `fail` / `statusOf`。错误码：`bad_request`(400) / `slot_not_found`(404) / `store_not_found`(404) / `slot_limit`(409) / `slot_locked`(409) / `loadout_invalid`(409) / `config_conflict`(409) / `no_active_config`(409) / `warehouse_missing`(404)。
- 持久化路径：两文件**无任何 `node:fs`**，状态变更一律经 `server/store`（A 类 `updateArchive/saveArchive` 原子写；B 类 `createAccount/setPasswordHash/setNickname/createConfigSlot/saveConfigSlot/activateConfigSlot/deleteConfigSlot/settleBattle/markRecordsSeen` = journal append → 幂等 apply，D-134）；会话经 `store.sessions.*`（只存 `sha256(token)`）。
- 本次交付**不含** HTTP 路由与鉴权中间件（属 P7-4），故 §2 中 `/auth/*`、`/me*` 各行的状态列与 §0 第 2 条"未实现"陈述仍待中央同步。

## §2 HTTP API 契约 v1（`/api/v1`；唯一将来 UI 数据源，L15）

| 方法 | 路径 | 用途 | 主要错误码 | 批次/状态 |
|---|---|---|---|---|
| GET | `/api/v1/health` | 存活与版本 | — | P0-8 ✅ 已实现 |
| GET | `/api/v1/data/:table` | 数据表（含 battle-config） | 404 `unknown_table` | P0-8 ✅ 已实现 |
| GET | `/api/v1/unlock?tier=` | 该段位可用节点/模板/技能（`nodes` 只含真实节点类型）。**段位门控默认关闭**（用户决策 2026-09-16，开关 `unlock.json` → `gating.enabled=false`）：任意段位都返回全部 16 类节点与全量模板/技能/插件，`tier` 仅回带；开关开启时按段位累计（10/12/14/14/16） | 400 `bad_tier`（参数校验，与门控无关，**始终保留**） | B4 ✅ 已实现（2026-09-16 门控默认关闭） |
| POST | `/api/v1/box` | 开箱（seed/tier/次数；tier **缺省 common**；**门控默认关闭** → tier 不再起门控作用、品质取自全池 `dropRates`；开关开启时按 D-122"段位序号即品质上限 + 截断后重归一"；409 `tier_locked` = 门控后掉落池为空——防御路径；seed 缺省生成并回带） | 400 / 409 `tier_locked` | B17 ✅ 已实现（2026-09-16 门控默认关闭） |
| GET | `/api/v1/warehouse` | 仓库（分桶 + 装配状态；服务端返回空骨架，客户端状态为权威） | — | B18 ✅ 已实现 |
| POST | `/api/v1/warehouse/assemble` | 装配 | 409 `slot_type_mismatch`/`points_exceeded`/`slot_occupied`/`tier_locked`/`plugin_equipped`/`item_missing` | B18 ✅ 已实现 |
| POST | `/api/v1/warehouse/disassemble` | 拆卸 | 404 `slot_empty`/`plugin_missing` | B18 ✅ 已实现 |
| GET/POST | `/api/v1/loadout` | 读取/保存出战配置（**无持久化**，D-123） | 409 `loadout_invalid` | B19 ✅ 已实现 |
| POST | `/api/v1/panel` | 最终面板（五维/regen/special/技能参数） | 409 | B19 ✅ 已实现 |
| POST | `/api/v1/ai/validate` | 静态校验 + 合法性 + 门控；错误带路径 | 400 `ai_invalid` | B16 ✅ 已实现 |
| POST | `/api/v1/ai/compile` | 规范化 + programHash + 统计 | 400 `ai_too_large` | B16 ✅ 已实现 |
| POST | `/api/v1/ai/battle` | 给定 AI 跑一场（服务端重新执行，T-AP-4） | 400 / 409 | B16 ✅ 已实现 |
| POST | `/api/v1/battle` | 双方 loadout + AI + seed → 完整回放帧（1px 位置 + 碰撞位置；服务端重执行） | 400 `bad_request`/`bad_seed`/`bad_tier`；409 `loadout_invalid` | B22 ✅ 已实现 |
| GET | `/api/v1/replay/:id` | 取回放帧（`?from=&to=` 1-based 含端分片；进程内注册表，D-123 不落盘） | 404 `unknown_replay` | B22 ✅ 已实现（**参与者鉴权 / 按需重算 / 410 `replay_expired` 为 ⏳ 计划（B31/B33，未实现）**，D-135） |
| POST | `/api/v1/ranked/run` | 排位：抽 10 场离线结算（段位由请求传入/回带，平局不计胜；`pool` 由请求提供，池空用内置 bot 补齐） | 400 `bad_seed`/`bad_pool`/`bad_tier`；409 `no_loadout`/`loadout_invalid` | B24 ✅ 已实现（**服务端抽池 + 同段位快照 + 双向记账 D-132 为 ⏳ 计划（B31，未实现）**） |
| POST | `/api/v1/ranked/promote` | 晋升（x=6，D-122）+ 段位奖励品质（`tier`/`wins` 由请求传入，不持久化） | 400 `bad_tier`/`bad_wins`；409 `already_max` | B25 ✅ 已实现（**读档案 / 落盘为 ⏳ 计划（B31，未实现）**） |
| POST | `/api/v1/auth/register` | 注册（下发默认配置 + token，D-131） | 409 `username_taken` / 400 `weak_password` | ⏳ 计划（B28，未实现） |
| POST | `/api/v1/auth/login` | 登录发 token | 401 `invalid_credentials` / 429 `too_many_attempts` | ⏳ 计划（B28，未实现） |
| POST | `/api/v1/auth/logout` | 撤销当前会话 | 401 `unauthorized` | ⏳ 计划（B28，未实现） |
| POST | `/api/v1/auth/password` | 改密（撤销其他会话） | 401 / 400 `weak_password` | ⏳ 计划（B28，未实现） |
| GET | `/api/v1/me` | 档案摘要（段位/积分/未读/槽位） | 401 | ⏳ 计划（B29，未实现） |
| GET | `/api/v1/me/configs` | 3 套配置全文 | 401 | ⏳ 计划（B29，未实现） |
| POST | `/api/v1/me/configs` | 新建配置槽 | 409 `slot_limit` | ⏳ 计划（B29，未实现） |
| PUT | `/api/v1/me/configs/:slotId` | 保存配置（校验 + 冻结快照，D-131） | 409 `loadout_invalid`/`config_conflict` | ⏳ 计划（B29，未实现） |
| POST | `/api/v1/me/configs/:slotId/activate` | 设为出战配置 | 404 `slot_not_found` | ⏳ 计划（B29，未实现） |
| DELETE | `/api/v1/me/configs/:slotId` | 删除槽（默认/出战槽禁止） | 409 `slot_locked` | ⏳ 计划（B29，未实现） |
| PUT | `/api/v1/me/nickname` | 改昵称 | 400 `bad_request` | ⏳ 计划（B29，未实现） |
| PUT | `/api/v1/me/warehouse` | 提交仓库镜像（引用校验用；非权威） | 400 | ⏳ 计划（B29，未实现） |
| GET | `/api/v1/me/records` | 战绩（`?since=&limit=&role=`） | 401 | ⏳ 计划（B30，未实现） |
| POST | `/api/v1/me/records/seen` | 推进未读游标 | 400 | ⏳ 计划（B30，未实现） |
| GET | `/api/v1/me/defense` | 防守战绩汇总（被抽场次/胜负/最近） | 401 | ⏳ 计划（B30，未实现） |
| POST | `/api/v1/quick/run` | 快速对战（积分相近 + 非对称 Elo 双向结算，D-133） | 409 `no_opponent`/`no_active_config` | ⏳ 计划（B32，未实现） |
| GET | `/api/v1/leaderboard` | 排行榜（`?scope=global\|tier:<t>&limit=`） | 400 `bad_scope` | ⏳ 计划（B32，未实现） |
| POST | `/api/v1/admin/bots` | 注入 bot 档案（`DL_ADMIN_TOKEN`） | 401/403 | ⏳ 计划（B33，未实现） |
| POST | `/api/v1/admin/rebuild-index` | 重建索引 | 401/403 | ⏳ 计划（B33，未实现） |
| GET/POST | `/api/v1/log-level` | 日志总控（非 production） | 400 `bad_level` | P0-8 ✅ 已实现 |

- 统一信封：成功 `{ok:true, data, log:{level,events}}`；失败 `{ok:false, error:{code,message,details}}`。
- 随机性由请求 `seed` 显式传入（缺省服务端生成并**回带**）（T-AP-5，D-90/D-91）。
- **鉴权（⏳ 计划，未实现）**：设计口径为 `Authorization: Bearer <token>`；需鉴权端点缺失/失效 → `401`，越权 → `403`（D-129§4）。HTTP 状态语义扩展为 `400/401/403/404/409/410/429/500`。**现状（2026-09-16 实测）**：全链路无鉴权分支（`server/index.js` 不读 `Authorization`；`server/auth.js` 不存在），已登记于 `docs/security-backlog.md` SEC-01。
- **兼容（⏳ 计划，未实现）**：设计口径为既有无状态端点（`box`/`warehouse*`/`loadout`/`panel`/`ai/*`/`battle`）保留不变，由 `DL_LEGACY_STATELESS`（默认 `1`）控制、置 `0` 返回 `410 deprecated`；**该环境变量当前未被代码读取**（SEC-22）。

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

1. **BattleState**：`tick/seed/rng/players{p1,p2}/bases/bullets/verdict/queuedActions`（`createBattle` 实际产出；**没有** `events[]`/`rngStreams`——整场事件由调用方注入缓冲，按 tick 切进 `frame.diff.events`）。
2. **玩家运行时**：`x`（px，1px 精度）/`facing`/`hp,mp,sp`/`maxHp,maxMp,maxSp`/`atk,def`/`regen{hp,mp,sp}`（模板 regen + 角色插件 `*_regen` 词条叠加）/`special`/`cooldowns{}`/`effects[]`/`skills{}`/`aiContext`/每 tick 瞬时标记 `defending`（D-43）/`dodging`/`fullDodgeDuring`（步骤 6 置位、步骤 1 复位，D-72）。
3. **回放帧 `frame`**：`{tick, diff}`；`diff = {players, bullets, bases, events, aiTrace, collision, bulletHits, verdict}`——**`diff.players` 是对象 `{p1,p2}`（不是数组）**，各含 `fromX/toX/facing/hp/mp/sp`；位置、碰撞位置、命中位置均 **1px**；事件带 `cid`（D-17/D-23）。
4. **物品/技能实例/loadout/AI AST**：`decisions.md` 与 `v3-design` §4.4/§6.3/§12.2/§11.5 冻结；`loadout = {role, skills[3], ai}`（T-RK-6）。**物品 `uid` 语义（B17 登记）**：进程内单调唯一（服务重启后重新计数），不参与内容级比较——「同 seed 复现」均为**内容级**（B18 仓库以 uid 区分同 seed 双开的同内容物品）。**`action.name` 是自由标签**（D-80）：引擎 `normalizeAction` 把未知名归一化为 `wait` 并记 `action.invalid`(warn)；`ai-nodes.json` 的 `actions` 只是**词汇表登记**（前端下拉取值来源），**校验期不拒绝**任何动作名。
5. **AiContext 序列化产物**（`runtime.serializeContext` 实际字段）：`programHash/entry/frames[{kind,path,childIndex,remaining,condValue,fnScope}]/vars/halted/stepCount/trace/stepLimit/traceLimit/recursionLimit/traceTruncated`（**可序列化**；帧存稳定 `path` + `fnScope` 快照，**不含** `nodeId/phase/scopeDepth`）。
6. **LogRecord**：`seq/ts/cid/tick/level/levelValue/channel/event/msg/data`（§6 登记）。
7. **battle-config.json**（D-117）：§2.5.7 冻结值逐值校验（T-DC-1，schema.js）。
8. **PlayerArchive（D-129/D-131）**：`archiveVersion/playerId/publicId/nickname/auth/progress{tier,peakTier}/rating{points,peakPoints,games,wins,losses,draws}/configs{slots[≤3],activeSlotId,activeSnapshotHash}/pool/record{appliedSeq,recent[],stats{attack,defense},unread}/flags`；字段详见 `11-account-store §5.2`。`playerId` **不对外返回**（只暴露 `publicId`）。
9. **Snapshot（D-135）**：`{hash, engineVersion, dataVersion, configHash, loadout, frozenAt}`；内容寻址存于 `runtime/snapshots/`，不可变，冻结后深拷贝 + canonical hash。
10. **BattleRecord（D-134/D-135）**：journal 行 `{seq,at,v,type:'battle.recorded',battleId,mode,batchId,matchIndex,seed,p1{},p2{},verdict{},versions{},replay{}}`；**不含帧**，回放按需重算。
11. **rating-config.json（D-133）**：`{base,cap,scale,kBase,kMin,kMax,drawFactor,matchWindowStart,matchWindowStep,matchWindowMax,opponentCooldownHours,dailyBattleLimit,rounding}`。
12. **service-config.json（D-129）**：`{auth{...},session{ttlDays,maxPerPlayer},config{maxSlots:3},record{recentLimit},store{archiveCacheSize,snapshotCacheSize},journal{fsyncMode,compactAfterDays},snapshot{retentionDays},replayCacheSize,pool{ttlDays,opponentCooldownHours}}`。

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
| D-127 | §1 engine（dodgeChanceBonus）+ §4.11 rating 无关（battle-config） | | D-128 | §1 engine（defK 入表）+ §4.7 battle-config | | D-129 | §1 store/* + §4.8 PlayerArchive（服务端存档） |
| D-130 | §1 store/*（混合权威：仓库仍客户端） + §4.8 flags.unverifiedLoadout | | D-131 | §2 auth/register + §4.8 configs.slots[≤3] | | D-132 | §2 ranked/run（双向记账） + §4.8 record.stats.defense |
| D-133 | §2 quick/run + §4.11 rating-config.json | | D-134 | §1 store.append/applyRecord + §4.10 BattleRecord | | D-135 | §2 replay/:id（410）+ §4.9 Snapshot/§4.10 |
| D-136 | §2 quick/run + §4.11 rating-config.json（opponentCooldownHours） | | D-137 | §1 core/unlock.js + unlock.json `gating.enabled`（默认关闭；六处判定不参与段位）+ §2 box/loadout + §1 ai/ast.js | | D-138 | §1 ai/ast.js/ai/runtime.js 删 `bullets` 节点与 `bullets[i].*` 路径 + §1 runner.js 快照不投影 bullets（设计） |
| D-139 | §1 ai/runtime.js（`random` 双语义：语句位分支/表达式位布尔，消费每 tick `ai` 流） | | D-140 | §1 ai/runtime.js `traceLimit`（**每 tick** 上限 2000）+ server/battle.js trace 司机 | | D-141 | §1 core/engine.js 步骤 11（基地按自身 `maxHp`、角色按角色 `maxHp`）+ §4.7 battle-config.json |
| D-142 | §1 core/items.js 生成路径 + core/roles.js（`typeModifiers` 接入开箱）+ role-templates.json | | D-143 | 各内容表 `drop`/`dropWeight`/`unlockTier`（掉落与解锁完全由 JSON 配置） | | D-144 | §1 server/data/schema.js（只校验结构与机制自洽，不锁条目数量；`_sample: true` 仅控示例期望表逐值比对） |
| D-145 | §1 ai/ast.js 校验期四类拒绝（`get.path` 白名单 / 变量先声明 / 表达式位 / 必含 action）+ §1 ai/runtime.js 运行层兜底（缺失→0，不抛） | | D-146 | §1 ai/ast.js warnings + §2 `/ai/validate`、`/ai/compile`（响应带 `data.warnings`；非法动作名不拒绝，D-80） | | D-147 | §1 runner.js `projectSnapshot` 字段补齐（`tick`/`max*`/`cooldowns`/`effects[]`/`bases.*`）+ `baseHp` ＝ 基地当前血量（≠ 角色 `maxHp`） |
| D-148 | §2 `/ai/battle`（`actionsEffective`/`ineffectiveActions`/`frames[].actions,events`） | | D-149 | §1 core/items.js `buildRolePanel` 单一聚合（roles/loadout 共用；regen 只叠一次） | | D-150 | §1 tests/regression/golden-battle.test.js + `docs/tasks.md §5.1` 第 5 条（阶段级代码级审查）+ `docs/plan-p7-playable.md` §0.7/§P7-7 |
| D-151 | §2 CLI `replay`（伤害数字 + 暴击/背击标注）+ `npm run play`（`scripts/play.js` 离线文本闭环） | | D-152 | §2 ranked/run·quick/run（匹配池＝真实玩家档案；池不足回报 `shortfall`，**禁止 bot 充数**） | | D-153 | `docs/security-backlog.md`（只登记不修复；被顺手修掉的条目更新证据 + 状态） |

## §6 日志事件登记（§4.6 覆盖矩阵；实现批次标注，T-LG-4 断言于此）

| 层 | 通道 | 必须事件（级别） | 批次 |
|---|---|---|---|
| L0 | rng | `rng.create`(info) / `rng.draw`(trace) / `rng.stream`(debug) | B1 |
| L0 | field | `field.clamp`(trace) / `field.base`(debug) | B1 |
| L1 | effects | `effect.add`(debug) / `effect.continuous`(trace) / `effect.expire`(debug) / `effect.control.override`(debug) | B2 |
| L1 | items | `items.roll.quality`(debug) / `items.generate`(debug) / `items.affix.apply`(trace) / `items.assemble`(info) / `items.disassemble`(info) / `items.reject`(warn) / `items.affix.unknown`(warn，2026-09-16) | B3/B18 |
| L1 | unlock | `unlock.check`(debug) / `unlock.reject`(warn) | B4 |
| L2 | roles | `role.instantiate`(debug) / `role.panel`(debug) | B5 |
| L2 | skills | `skill.instantiate`(debug) / `skill.plugin.apply`(debug) / `skill.cast`(info) / `skill.reject`(warn) / `skill.area`(trace) / `skill.plugin.unknown`(warn，词条或算子未登记，2026-09-16) / `skill.emit.unknown`(warn，发射模式未登记，2026-09-16) | B6 |
| L2 | bullets | `bullet.spawn`(debug) / `bullet.collide`(debug) / `bullet.hit`(debug) / `bullet.expire`(trace) | B7 |
| L4 | engine | `battle.create`(info) / `tick.begin`(info) / `tick.step`(debug，14 步各一条) / `move.resolve`(debug) / `collision.resolve`(info) / `resource.regen`(trace) / `battle.overtime`(info) / `tick.end`(info) / `battle.judge`(info) / `battle.end`(info) / `action.invalid`(warn) | B8~B11 |
| L4 | damage | `damage.calc`(debug) / `damage.dodge`(debug) / `damage.lifesteal`(trace) / `damage.affix.unknown`(warn，命中效果未登记，2026-09-16) | B9 |
| L5 | ai.ast | `ai.validate`(debug) / `ai.validate.reject`(warn) / `ai.compile`(debug) / `ai.migrate`(info) | B12~B16 |
| L5 | ai.runtime | `ai.resume`(debug) / `ai.node`(trace) / `ai.action`(info) / `ai.step.limit`(warn) / `ai.depth.limit`(warn) / `trace.truncated`(warn) / `ai.error`(err) | B14~B15 |
| L6 | api | `api.req`(info) / `api.res`(info) / `api.err`(error) / `api.reject`(warn，业务拒绝带 count/errors，B19) | P0-8/B19 |
| L6 | cli | `cli.invoke`(info) / `cli.result`(info) | P0-8 |
| L6 | ranked | `ranked.snapshot`(debug) / `ranked.match`(info) / `ranked.promote`(info) / `ranked.pool`(debug) / `quick.match`(info) / `quick.settle`(info) | B24~B25/B31/B32 |
| L6 | store | `store.open/close`(info) / `store.read`(trace) / `store.write`(debug) / `store.journal.append`(debug) / `store.journal.flush`(trace) / `store.journal.truncate`(warn) / `store.journal.compact`(info) / `store.recover`(info) / `store.index.rebuild`(info) / `store.migrate`(info) / `store.snapshot.write`(debug) / `store.snapshot.gc`(info) / `store.snapshot.missing`(warn) / `store.auth.register`(info) / `store.auth.login`(info) / `store.auth.reject`(warn) / `store.auth.lock`(warn) / `store.abuse.suspect`(warn) / `store.error`(error) | B27~B33 |
| P6 | store/view/render/editor | `store.dispatch` / `view.render` / `render.frame` / `render.sprite` / `editor.ast.*` —— 仅登记 | P6 |

- 跨系统边界事件统一 `debug` 级：`{dir:'in'|'out', fn, args:摘要, result:摘要}`（§4.6 注）。
- 命名规范由 `scripts/gate.js` 项 6① 强制（通道注册表 + 前缀映射，T-DC-6）。
- **D-129 新增事件的落点要求**：`store.*` 复用既有 `store` 通道（无需改注册表）；`quick.*` 必须把 `'quick'` 加入 `scripts/gate.js` 的 `PREFIX_MAP.ranked` 数组，否则门禁项 6 失败（`11-account-store §12.1`）。

## §7 环境与门禁契约（引用）

- 测试 runner / 覆盖率 / 嵌套 run() 限制：`tests/README.md` + `scripts/README.md`（**4 条实测机制**，勿违反）。
- 数据表契约与冻结数值：`server/data/README.md`（新增 `service-config.json`、`rating-config.json`，须同步 `schema.js` 与门禁项 4/5）。
- 目录分层与架构检查：`scripts/README.md`「check-arch.js 契约」。**D-129 新增文件必须登记**：`/^server\/store\//` → 6、`/^server\/(auth|account|quickmatch|admin)\.js$/` → 6（否则 `unknown-layer` 违规）。
- 新增环境变量（**⏳ 计划（B27–B33），未实现**）：`DL_DATA_DIR`（运行时数据根，默认 `<repo>/runtime`）、`DL_STORE`（`json`|`sqlite`，默认 `json`）、`DL_ADMIN_TOKEN`、`DL_LEGACY_STATELESS`（默认 `1`）、`DL_CORS_ORIGIN`（默认空）。**现状（2026-09-16 实测）**：代码只读 `DL_PORT`/`DL_HOST`（`server/index.js`）与 `DL_LOG_LEVEL`/`DL_LOG_CHANNELS`（`shared/log.js`），上述五个变量零读取点（`docs/security-backlog.md` SEC-22）。
- 运行时数据目录 `runtime/` **必须** `.gitignore`；测试用 `DL_DATA_DIR` 指向临时目录（`tests/helpers/store.js`）。**该目录与 helper 当前均不存在（同上：计划未实现）。**