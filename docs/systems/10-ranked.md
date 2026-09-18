# 排位系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。
>
> ## ⚠️ 现状 vs 计划（必读）
>
> - ✅ **现行（已实现，D-123 无状态）**：`server/ranked.js` 仍是 **P5/B24/B25 的无状态实现**——段位、仓库、出战配置、对手池全部**由请求传入并原样回带**，服务端**不落盘**；快照 = 出战配置的不可变深拷贝；对手池由请求传入，**不足 10 场一律用内置 bot 补齐到恒定 10 场**；**没有** journal / 玩家档案 / 配置文件 / 积分 / 交互 falloff。
> - ⏳ **计划（未实现）**：本文档 §1/§2/§3/§4.1/§4.3/§4.4/§5/§6/§7 中所有"服务端档案、抽池、双向记账、journal、回放鉴权"的描述，均属 **P7 / D-129 + D-132 计划**，代码尚未实现（`server/store/*`、`auth.js`、`account.js`、`quickmatch.js` 为 P7 新增待办）。各节已就地标注。
> - **D-129/D-132 计划口径**：本系统的**持久化、账号、对手池、双向记账、回放**部分由 `11-account-store.md` 接管；本文档保留**批次规则**（10 场 / x=6 晋升 / 平局不计胜 / 段位奖励）作为**现行**权威。
> - **D-122 规则继续有效**（未被推翻）：10 场批次、`wins > x`（`x = 6`，即胜 7 场）晋升、平局不计胜、段位序号即品质上限。

## 1. 职责

- 玩家出战配置的保存与快照。**现状**：`takeSnapshot` 只做深拷贝，配置由请求传入回带（D-123）。⏳ **计划（未实现）**：改由 `11-account-store` §5 的服务端配置槽承担。
- 匹配 10 个同段位快照，依次离线对战。**现状**：池由请求传入，不足用 bot 补齐恒 10 场。
- ⏳ **计划（未实现）**：服务端按段位索引抽池（D-132）、跨批去重窗口与 `relaxed` 标记（D-136）、双向战绩记账与 journal（D-134）。
- 晋升判定与段位 → 奖励品质映射。**现状**：已实现（`promote` / `tierReward` / `promotedAt`）。

## 2. 依赖

- `engine.js`（离线结算一场）、`loadout.js`（出战配置校验）、`runner.js`（`projectSnapshot`）、`ai/runtime.js`（对手 AI 续执行）——**现行实际依赖**。
- `unlock.js`（段位品质门控）。
- ⏳ **计划（未实现）**：**`store.js` / `server/store/*`（D-129 起为必需）**——档案读写、journal、索引抽池、快照库；`server/account.js`（配置槽与出战快照的来源）；`server/auth.js`（鉴权）。

## 3. 数据结构

- ⏳ **计划（未实现）**：玩家档案 `playerId`、`progress.tier`、`rating.points`、`configs.slots[≤3]`、`configs.activeSlotId`、`record.stats.{attack,defense}`、`record.unread`（字段全表见 `11-account-store` §5.2）。
- **现行（已实现）**：`loadout`（`role` 角色模板及插件、`skills[3]` 三个技能模板及各自插件、`ai` AI 程序）；`runRankedBattle(opts)` 的入参 = `{loadout, warehouse, pool, seed, tier}`，返回值回带 `tier/seed/matches/wins/draws/losses/invalids/promoted/results`。
- ⏳ **计划（未实现）**：**持久化口径（D-129）**——段位/积分/战绩/配置槽**落盘于服务端**；仓库与物品仍由客户端 localStorage 持有（D-130），服务端只保存**出战快照副本**。
- **快照（现行已实现部分）**：出战配置的不可变深拷贝（`takeSnapshot` 深冻结 + `JSON` 克隆）。⏳ **计划（未实现）**：附加版本戳（`snapshotHash`/`engineVersion`/`dataVersion`/`configHash`）并存入**内容寻址快照库**。

## 4. 核心流程（代码逻辑）

### 4.1 保存配置 `submitLoadout(player, loadout)`

- **现行（已实现）**：**没有** `submitLoadout` 这个服务端流程；`server/ranked.js` 不做配置保存——每次 `POST /ranked/run` 由请求传入 `loadout`，服务端只做 `loadout.validateLoadout` 校验后即用即弃。
- ⏳ **计划（未实现）**：
  1. 校验出战配置（角色模板及插件、三个技能模板及插件、AI 均合法且与段位匹配）。
  2. **写入服务端档案的配置槽**（`PUT /me/configs/:slotId`）：在同一请求内完成"校验 → 深拷贝冻结快照 → 写快照库 → 更新档案"（D-131）；客户端 localStorage 保留权威副本（D-130）。

### 4.2 生成快照 `takeSnapshot(player)`

1. 深拷贝玩家当前出战配置，返回不可变快照（**已实现**：`JSON` 克隆 + 递归 `Object.freeze`）。
2. ⏳ **计划（未实现）**：附带版本戳（`engineVersion`/`dataVersion`/`configHash`）并写入内容寻址快照库；同 hash 只存一份。

### 4.3 排位对战 `runRankedBattle(player)`

> **现状（已实现，D-123 无状态）**：`runRankedBattle(opts)` 从 `opts` 取 `loadout`/`warehouse`/`pool`/`seed`/`tier`；池 = 请求传入的对手 loadout 数组（按 JSON 深等排除自己）；**不足 10 个一律用内置 bot（`BOT_LD`）补齐到恒定 10 场**；逐场离线对战、平局不计胜；**不写任何存储，也没有防守方记账**。

⏳ **计划（未实现，D-132 档案驱动）**：
1. 取**同段位玩家池**（服务端索引 `byTier[tier]`，池 = 所有玩家的出战快照，D-132），随机抽 10 个（排除自己）。
2. 跨批去重：同一对手 24h 内不重复，候选不足放宽到 72h 并在响应标 `relaxed`（D-136）。
3. 池不足 10 个 → **本轮不注入 bot**（bot 由管理员后续注入，见 `11-account-store` §7.6）；只打实际可用的场次，响应 `matches` 与 `shortfall` 如实回带。
4. 依次与每个快照离线对战（调用引擎 `runFull`）。— **此步已实现**
5. **每场写一条 journal 记录**（`battle.recorded`，含双方战绩/积分/版本戳），随后 apply 到**双方**档案：
   - 发起者：`record.stats.attack` + `recent`（`role:"attacker"`），`unread.attack++`；
   - 被抽取方：`record.stats.defense` + `recent`（`role:"defender"`），`unread.defense++`，**段位与积分不变**；
6. 统计胜场数（平局不计胜）。发起者 10 场结束后判定晋升（§4.4）并落盘；防守方段位不因被抽而改变。

> **现行口径与计划的差异（逐条）**：抽池（请求传入 vs 服务端索引）、补位（**bot 恒补齐 10 场** vs 不足不补 + `shortfall`）、去重（无 vs 24h/72h）、记账（无 vs 双向 journal）、落盘（无 vs 档案）。

### 4.4 晋升判定 `promote(player, wins)`

1. `wins > x` → `tier + 1`（**`x = 6`，已确认**，D-122；即 10 场胜 7 场晋升）。— **已实现**（现行签名 `promote(tier, wins)`；win 场数由调用方/请求传入，服务端不读档案）。
2. 达到最高段位后不再晋升。— **已实现**（`mythic` + `wins>6` → 409 `already_max`）。
3. ⏳ **计划（未实现）**：签名改 `promote(player, wins)`——段位从**服务端档案**读取与回写。

### 4.5 段位奖励 `tierReward(tier)`

1. 按段位返回可获得的品质上限（绿段位→绿，蓝→蓝，…，青→青）。— **已实现**
2. 用于开箱掉落池与奖励生成（配合解锁系统过滤）。

## 5. 边界与异常

> **现行（已实现）**：`status/code` 返回 `no_loadout` / `loadout_invalid` / `bad_seed` / `bad_pool` / `bad_tier` / `bad_wins` / `already_max`；单场实例化失败记 `invalid`（不计胜负，计入 `invalids`），批次不整体失败；快照深冻结不可变。

- ⏳ **计划（未实现）**：同段位候选不足 → 只打可用场次、响应带 `shortfall`（**不伪造对局、不自动 bot**；bot 由管理员注入真实档案）。— **现行相反**：不足即刻用内置 bot 补齐到 10 场。
- 平局不计胜、不占晋升数。— **已实现**
- 快照不可变：对战过程不修改原配置。— **已实现**
- **单场隔离**：某对手快照损坏/实例化失败 → 该场记 `invalid` 并换人，批次不整体失败。— **已实现**（`invalids` 计数）
- ⏳ **计划（未实现）**：**崩溃一致性**——对局以 journal 记录落盘为成立标志；"单边记账"不可能出现（D-134）。
- ⏳ **计划（未实现）**：**快照缺失**——回放返回 `410 replay_expired`。

## 6. 对外接口

- **现行（已实现，`server/ranked.js` 实际导出）**：`takeSnapshot`、`runRankedBattle`、`promote`、`tierReward`、`promotedAt`、`BOT_LD`、`buildBotLoadout`、`X_PROMOTE`、`TIERS`。（`submitLoadout` **未实现**。）
- **现行 HTTP**：`POST /api/v1/ranked/run`（body 含 `loadout/warehouse/pool/seed/tier`，**由客户端传池**）、`POST /api/v1/ranked/promote`（body `{tier, wins}`）。
- ⏳ **计划（未实现）**：
  - HTTP：`POST /api/v1/ranked/run`（鉴权；**不再由客户端传 loadout/pool**，D-132）、`POST /api/v1/ranked/promote`（读档案）。
  - 档案视图：`GET /api/v1/me`、`GET /api/v1/me/defense`、`GET /api/v1/me/records`（防守方离线可见，`11-account-store` §7.5）。

## 7. 测试要点

- 匹配数量恒为 ≤10。— **现行实测恒 =10**（bot 补齐）；⏳ **计划（未实现）**：池不足时如实回带 `shortfall`。
- 晋升阈值（胜 7 场晋升，默认 x=6；`mythic` 不再晋升）。— **已实现**
- 平局处理。— **已实现**
- 段位 → 品质上限映射。— **已实现**
- 快照不可变（含深冻结）。⏳ **计划（未实现）**：hash 稳定 + 内容寻址库。
- 出战配置结构完整（1 角色 + 3 技能 + AI），服务端存取无损。⏳ **计划（未实现）**：服务端配置槽存取（现行配置由请求传入，无"存取"）。
- ⏳ **计划（未实现）**：**被抽取方离线仍产生防守战绩**，且段位/积分不变（T-RK-3）。
- ⏳ **计划（未实现）**：跨批去重窗口 24h/72h 放宽（T-RK-4）。
- ⏳ **计划（未实现）**：崩溃恢复后双方战绩一致（T-ST-3）。
