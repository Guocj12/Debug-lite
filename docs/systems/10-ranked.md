# 排位系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。
>
> ## ⚠️ 现状 vs 计划（必读，2026-09-19 复核）
>
> - ✅ **现行（已实现，P7-3/D-132 档案驱动）**：`server/ranked.js` 为**服务端抽池 + 双向记账**实现——玩家档案（段位/积分/战绩/配置槽）由 `server/store/*` 持久化；`POST /ranked/run` 从 `byTier` 索引抽同段位对手快照，逐场离线对战，**每场写 journal（`battle.recorded`）后 apply 到双方档案**；发起者计 `stats.attack`，被抽取方计 `stats.defense` 且**段位与积分不变（离线只记战绩）**；晋升在批次内落地。
> - 🚫 **已删除**：`BOT_LD`（内置占位 bot 补齐）**不存在**（实测 `require('./server/ranked.js').BOT_LD === undefined`）；**池不足一律如实回报 `shortfall`，禁止 bot 充数**（D-152）。bot 只能由管理员注入**真实档案**（`server/admin.js`，双门控）。
> - ✅ **去重窗口裁定（用户 2026-09-16）**：`strict` = 间隔 ≥ 72h（优先）；`relaxed` = 24h ≤ 间隔 < 72h（仅当 strict 凑不满需要时启用，响应记 `relaxed:true`）；**间隔 < 24h 两池皆拒 —— 24h 是硬底线，永不"允许重复"**；仍不足 → `shortfall`。
> - ✅ **双轨（P7-4）**：PG 有 Bearer token → 档案驱动；无 token 且 `DL_LEGACY_STATELESS=1`（默认）→ 遗留无状态口径（`loadout/warehouse/pool/tier` 由请求传入并回带，D-123）；置 `0` → 401。
> - **D-122 规则继续有效**（未被推翻）：10 场批次、`wins > x`（`x = 6`，即胜 7 场）晋升、平局不计胜、段位序号即品质上限（门控默认关闭，见 `interfaces.md` §1 unlock 行）。
> - **tier 以档案为准**：`/ranked/promote` 读档案段位（入参 `tier` 不一致 → 403 `forbidden`），且**只判定不落盘**——落盘只发生在 `/ranked/run` 的批次结算里。

## 1. 职责

- 玩家出战配置的保存与快照。**现状（已实现）**：配置槽由 `server/account.js` + `server/store/*` 承载（`PUT /me/configs/:slotId` 校验 → 深拷贝冻结 → 算 hash → 写内容寻址快照库 → 更新档案）；`ranked.takeSnapshot` 仍提供"不可变深拷贝"原语供离线路径使用。
- 匹配 10 个同段位快照，依次离线对战。**现状（已实现）**：池来自服务端索引（真实档案），**池不足如实 `shortfall`，不补 bot**。
- **已实现**：服务端按段位索引抽池（D-132）、跨批去重窗口与 `relaxed` 标记（D-136）、双向战绩记账与 journal（D-134）。
- 晋升判定与段位 → 奖励品质映射。**已实现**（`promote` / `tierReward` / `promotedAt`）。

## 2. 依赖

- `engine.js`（离线结算一场）、`loadout.js`（出战配置校验）、`runner.js`（`projectSnapshot`）、`ai/runtime.js`（对手 AI 续执行）——**基础依赖**。
- `unlock.js`（段位品质门控；门控默认关闭）。
- **`server/store/*`（D-129 起为必需，已实现）**——档案读写、journal、索引抽池、快照库；`server/account.js`（配置槽与出战快照的来源）；`server/auth.js`（鉴权）；`server/admin.js`（bot 档案注入，运维通道）。

## 3. 数据结构

- **已实现**：玩家档案 `playerId`、`progress.tier`、`rating.points`、`configs.slots[≤3]`、`configs.activeSlotId`、`record.stats.{attack,defense}`、`record.unread`、`pool.*`（字段全表见 `11-account-store` §5.2）。
- **现行（保留）**：`loadout`（`role` 角色模板及插件、`skills[3]` 三个技能模板及各自插件、`ai` AI 程序）；**遗留路径**入参 = `{loadout, warehouse, pool, seed, tier}`；**档案路径**入参 = `{seed?, pool?}`（传 `pool` → 400 `pool_forbidden`）。返回值带 `tier/seed/matches/wins/draws/losses/invalids/promoted/shortfall/relaxed/results/batchId`。
- **持久化口径（D-129，已实现）**：段位/积分/战绩/配置槽**落盘于服务端**（`DL_DATA_DIR`，默认 `<repo>/runtime`）；仓库与物品仍由客户端 localStorage 持有（D-130），服务端只保存**出战快照副本**。
- **快照**：出战配置的不可变深拷贝（`takeSnapshot` 深冻结 + `JSON` 克隆）**+ 版本戳**（`hash`/`engineVersion`/`dataVersion`/`configHash`）并存入**内容寻址快照库**（`runtime/snapshots/<hex[0:2]>/<hex>.json`；磁盘文件名去掉 `sha256:` 前缀）。

## 4. 核心流程（代码逻辑）

### 4.1 保存配置（`PUT /api/v1/me/configs/:slotId`；**无 `submitLoadout`**）

- **已实现**：**不存在** `submitLoadout` 这个导出/流程；配置保存由 `server/account.js` 的 `saveConfig` 承担，HTTP 入口是 `PUT /me/configs/:slotId`：
  1. 校验出战配置（角色模板及插件、三个技能模板及插件、AI 均合法）。
  2. **写入服务端档案的配置槽**：同一请求内完成"校验 → 深拷贝冻结快照 → 写快照库 → 更新档案"（D-131）；客户端 localStorage 保留权威副本（D-130）。
- 遗留路径（`DL_LEGACY_STATELESS=1` 且 `/ranked/run` 无 token）仍由请求传入 `loadout`，即用即弃（D-123）。

### 4.2 生成快照 `takeSnapshot(player)`

1. 深拷贝玩家当前出战配置，返回不可变快照（**已实现**：`JSON` 克隆 + 递归 `Object.freeze`）。
2. **已实现**：附带版本戳（`engineVersion`/`dataVersion`/`configHash`）并写入内容寻址快照库；同 hash 只存一份（幂等）。

### 4.3 排位对战 `runRankedBattle(input)`

> **现状（已实现，P7-3 档案驱动 + 遗留双轨）**：
> - **档案路径**（有 Bearer token）：入参 `{seed?, pool?}`；`pool` **任何非空传入 → 400 `pool_forbidden`**（服务端抽池，D-136）。抽池 = `byTier[tier] ∩ 可用快照 ∩ 未封禁 ∩ 在池 ∩ 排除自己`；逐场离线对战、平局不计胜；`batchId = f(playerId, seed)` **确定性派生** → 同一 seed 重发命中既有批次（**幂等，不重复结算、不重复触发晋升**）；`battleId` 亦为内容寻址幂等。
> - **遗留路径**（无 token 且 `DL_LEGACY_STATELESS=1`）：`{loadout, warehouse, pool, seed, tier}` 全部由请求传入并回带（D-123），**无任何落盘**。

1. 取**同段位玩家池**（服务端索引 `byTier[tier]`，池 = 所有玩家的出战快照，D-132），随机抽 10 个（排除自己）。— **已实现**
2. 跨批去重（D-136 裁定）：`strict` = 同一对手**间隔 ≥ 72h**（优先）；`relaxed` = **24h ≤ 间隔 < 72h**（仅当 strict 凑不满时启用并记 `relaxed:true`）；**间隔 < 24h 任何池都不收（24h 硬底线）**；仍不足 → `shortfall`。— **已实现**
3. 池不足 10 个 → **本轮不注入 bot**；只打实际可用的场次，响应 `matches` 与 `shortfall` 如实回带（bot 由管理员注入**真实档案**，见 `server/admin.js`）。— **已实现**
4. 依次与每个快照离线对战（调用引擎 `runFull`）。— **已实现**
5. **每场写一条 journal 记录**（`battle.recorded`，含双方战绩/版本戳），随后 apply 到**双方**档案：
   - 发起者：`record.stats.attack` + `recent`（`role:"attacker"`），`unread.attack++`；
   - 被抽取方：`record.stats.defense` + `recent`（`role:"defender"`），`unread.defense++`，**段位与积分不变**；
6. 统计胜场数（平局不计胜）。发起者批次结束后判定晋升（§4.4）**并在批次内落盘**；`shortfall > 0` 的批次**不判晋升**（未打满 10 场不结段位）；防守方段位不因被抽而改变。

### 4.4 晋升判定 `promote(tier, wins)`

1. `wins > x` → `tier + 1`（**`x = 6`，已确认**，D-122；即 10 场胜 7 场晋升）。— **已实现**（`x` 取自 `rating-config.promoteWins`）
2. 达到最高段位后不再晋升。— **已实现**（`mythic` + `wins>6` → 409 `already_max`）。
3. **已实现（P7-4）**：`/ranked/promote` 在有 token 时**段位以档案为准**（入参 `tier` 不一致 → 403 `forbidden`），且该端点**只判定、不落盘**；真正的段位回写发生在 `/ranked/run` 的批次结算（`ranked.promoted` journal 记录）。

### 4.5 段位奖励 `tierReward(tier)`

1. 按段位返回可获得的品质上限（绿段位→绿，蓝→蓝，…，青→青）。— **已实现**
2. 用于开箱掉落池与奖励生成（配合解锁系统过滤）。

## 5. 边界与异常

> **现行（已实现）**：`status/code` 返回 `no_loadout` / `loadout_invalid` / `bad_seed` / `bad_pool`（遗留路径）/ `pool_forbidden`（档案路径传 `pool`）/ `bad_tier` / `bad_wins` / `already_max` / `no_active_config` / `store_not_found` / `unauthorized` / `forbidden` / `store_unavailable`；单场实例化失败记 `invalid`（不计胜负，计入 `invalids`），批次不整体失败；快照深冻结不可变。

- **已实现**：同段位候选不足 → 只打可用场次、响应带 `shortfall`（**不伪造对局、不自动 bot**；bot 由管理员注入真实档案，且需 `DL_ADMIN_TOKEN` + `DL_DEBUG_BOTS=1` 双门控）。
- 平局不计胜、不占晋升数。— **已实现**
- 快照不可变：对战过程不修改原配置。— **已实现**
- **单场隔离**：某对手快照损坏/实例化失败 → 该场记 `invalid` 并换人，批次不整体失败。— **已实现**（`invalids` 计数）
- **已实现**：**崩溃一致性**——对局以 journal 记录落盘为成立标志；"单边记账"不可能出现（D-134，启动恢复五步会补放）。
- **已实现**：**快照缺失/版本不匹配**——回放返回 `410 replay_expired`（含 LRU 淘汰、引擎/数据版本不匹配、快照不可用）。

## 6. 对外接口

- **现行（已实现，`server/ranked.js` 实际导出，2026-09-19 实测）**：`takeSnapshot`、`runRankedBattle`、`promote`、`tierReward`、`promotedAt`、`buildDefaultLoadout`（兼容名 `buildBotLoadout` = 新玩家默认出战配置，**非"占位 bot 补齐"**）、`X_PROMOTE`、`TIERS`、`DEFAULT_BATCH_SIZE`、`COOLDOWN_RELAX_MULT`、`battleOne`、`batchIdOf`、`candidatesOf`、`isUsableSnapshot`、`loadSnapshotOf`、`cooldownHoursOf`、`batchSizeOf`、`loadoutKey`、`inspectDebugBots`、`withLogger`。**`BOT_LD` 已删除**（`ranked.BOT_LD === undefined`）；**没有** `submitLoadout`。
- **现行 HTTP（双轨）**：
  - `POST /api/v1/ranked/run`：有 token → 档案驱动（body `{seed?}`，传 `pool` → 400 `pool_forbidden`）；无 token 且 `DL_LEGACY_STATELESS=1` → body `{loadout, warehouse, pool, seed, tier}`（客户端传池，D-123 遗留）；`=0` → 401。
  - `POST /api/v1/ranked/promote`：有 token → body `{wins, tier?}`（段位以档案为准，不一致 → 403；只判定不落盘）；无 token → body `{tier, wins}`（遗留）。
- **现行档案视图（已实现）**：`GET /api/v1/me`、`GET /api/v1/me/defense`、`GET /api/v1/me/records`（防守方离线可见，`11-account-store` §7.5）。

## 7. 测试要点

- 匹配数量 `≤10` 且**等于实际可用场次**。— **已实现**（池不足时 `matches = 可用数`、`shortfall = 10 − matches` 如实回带；**不再恒 =10**）。
- 晋升阈值（胜 7 场晋升，默认 x=6；`mythic` 不再晋升）。— **已实现**
- 平局处理。— **已实现**
- 段位 → 品质上限映射。— **已实现**
- 快照不可变（含深冻结）+ hash 稳定 + 内容寻址库（同配置同 hash 只存一份）。— **已实现**
- 出战配置结构完整（1 角色 + 3 技能 + AI），服务端存取无损。— **已实现**（服务端配置槽 `PUT /me/configs/:slotId`）
- **被抽取方离线仍产生防守战绩**，且段位/积分不变（T-RK-3）。— **已实现**
- 跨批去重窗口（`strict` ≥72h / `relaxed` 24–72h / **<24h 硬拒**）与 `relaxed` 标记（T-RK-4）。— **已实现**
- 崩溃恢复后双方战绩一致（T-ST-3）。— **已实现**
- 批次幂等：同 `(playerId, seed)` 重发 → 命中既有批次，不重复结算/不重复晋升（P1-4）。— **已实现**
- 双轨零回归：`DL_LEGACY_STATELESS=1` 时旧无状态调用方不变；`=0` 时遗留端点 410、`ranked/*` 无 token 401。— **已实现**
