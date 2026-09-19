# 战斗全流程走查（系统间数值与状态传递）

> 所属：Debug-Lite v3　更新：2026-09-16
> **定位**：本文只讲**系统之间的数值与状态如何传递**（谁给谁什么值、以什么结构、什么时候）；**具体计算由各系统示例集负责**，本文只引用不重复推导（见 `examples/`）。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/tasks.md`。
> 全场基准数值见 `examples/README.md` §1。
> **§3.1 逐 tick 轨迹 = 真实引擎复算结果**（基准场景 = `.audit/golden-battle.js` 的黄金战斗：seed `20260912`、18 tick、winner `p2`；与 gate 项 8 同源），复算命令 **`node .audit/walkthrough.js`**（输出表格 + 机器可校验 `.audit/walkthrough.json`，脚本内含与 `.audit/golden-battle.json` 的逐字段比对）。
> **§2 的面板/物品数值**来自 `examples/` 的统一示例基准（**非**该黄金战斗场景）：那里只有"面板 → 引擎"的形状说明，引擎侧真正消费的是 §2.4 的初始状态；黄金战斗的固定 loadout 见 §3.1。

---

## 1. 数据流总览

```
[数据表] qualities / role-templates / skill-templates / plugins / battle-config
    │  ① 实例化（items / roles / skills）
    ▼
[物品实例] 角色物品 + 3 技能物品 + 插件 ──② 装配──▶ [最终面板] 五维 / regen / special / 技能参数
    │                                                        │
[AI 程序 AST] ──③ canonicalize + hash──▶ programHash         │
    │                                                        ▼
    └──────────────────────▶ ④ createBattle(seed, 双方 loadout + AI) ◀──┘
                                          │
                                          ▼ 每 tick 14 步（§3）
                    ┌───────────────────────────────────────────────┐
                    │ 引擎状态 ⇄ AI / 技能 / 弹幕 / 效果 / 伤害      │
                    └───────────────────────────────────────────────┘
                                          │
                                ⑤ frame（diff + events + aiTrace）
                                          ▼
                        ⑥ API/CLI 响应（result + frames + log）
```

| # | 边界 | 方向 | 结构 | 章节 |
|---|---|---|---|---|
| ① | 数据表 → 物品实例 | items/roles/skills ← JSON 表 | 物品实例、面板 | §2.1 |
| ② | 物品 → 面板 | engine ← roles/skills | `{五维, regen, special, 技能参数}` | §2.2 |
| ③ | AI 程序 → hash | engine ← ast | `programHash` + 统计 | §2.3 |
| ④ | 请求 → 战斗 | engine ← API/CLI | `{seed, p1, p2, logger}` | §2.4 |
| ⑤ | 引擎 → 帧 | 回放/前端 ← engine | `frame{diff, events, aiTrace}` | §4 |
| ⑥ | 引擎 → 响应 | 调用方 ← API/CLI | `{ok, data, log}` | §5 |

---

## 2. 阶段 0–1：初始化与状态交接

### 2.1 数据表 → 物品实例（①）

| 源（数据表） | 目标 | 传递字段 | 示例值 |
|---|---|---|---|
| `qualities.json` | items | `statRange` / `roleSlotRange` / `pluginPoints` / `tiers` | rare：`[1.00,1.25]` / `[2,4]` / `4` / 三档 |
| `role-templates.json` | roles | `baseStats` / `regen` / `slotWeights` / `pluginPoints` | 均衡 `100/10/8/60/40`、`{mp:1,sp:2}` |
| `skill-templates.json` | skills | `baseMultiplier` / `baseCost` / `cooldown` / `bulletLevel` / 类型参数 / `falloff` / `slotWeights` | 重击 `1.3`、`mp10+sp8`、`cd4`、`L2`、`[0,2]` |
| `plugins.json` | items | `slot` / `affixes` / `pointCost` / `costDeltaByTier` | `rp_atk_pct` tier1 → `+8.16%`、1 点 |
| `items-config.json` | items | `dropRates` / `kindWeights` | 绿 .55 / 类别权重 1:1:2:2 |

```jsonc
// 角色物品实例（跨 ① 边界的实际数据）
{ "uid":"item_r1", "kind":"role", "templateId":"role_bal", "quality":"rare",
  "stats":{ "hp":112, "atk":11, "def":8, "sp":72, "mp":41 },
  "slotCount":4,
  "slots":[ {"type":"atk","pluginUid":"item_p1"}, {"type":"hp","pluginUid":"item_p2"},
            {"type":"special","pluginUid":"item_p3"}, {"type":"special","pluginUid":"item_p4"} ],
  "unlockTier":"common" }
// 插件（一个变体一个 id）
{ "uid":"item_p1", "kind":"rolePlugin", "id":"rp_atk_pct", "tier":1,
  "affixes":[{"id":"atk_pct","params":{"v":0.0816}}], "pointCost":1, "equipped":true }
```

### 2.2 物品 → 最终面板（②）

| 传递 | 结构 | 示例（A） |
|---|---|---|
| 五维 | `{hp, atk, def, sp, mp}` | `132 / 12 / 8 / 72 / 41`（`hp 112+20`、`atk 11×1.0816→12`） |
| 回复 | `regen{mp,sp}` | `{mp:1, sp:2}`（模板 + 插件加成） |
| 特殊 | `special{critChance, lifesteal, dodgeChance}` | `{crit 8.16%, ls 10.2%}`（概率封顶 1） |
| 技能参数 | `{multiplier, cost, cooldown, bulletLevel, range/count/distance, falloff}` | 重击 `1.3 / mp10+sp8 / 4 / L2 / [0,2]`；精准 `1.1385 / mp2+sp6 / 2 / L3 / range8` |

**引擎只消费这个面板**，不再回看模板与插件（计算见 `examples/01`、`examples/02`）。

### 2.3 AI 程序 → programHash（③）

```jsonc
// 入参
{ "type":"program", "version":1, "body":{ "type":"seq", "statements":[ … ] } }
// 出参
{ "programHash":"3f9c…a71d",
  "stats":{ "nodes":12, "depth":3, "usedNodeTypes":["seq","loop","if","action", …] } }
```

- 程序随 loadout 流动；引擎侧只持有 `AiContext`（可序列化：`frames/vars/halted/stepCount/trace`）。
- `programHash` 进入快照与帧，用于回放校验。

### 2.4 请求 → 战斗（④）

| 入参 | 类型 | 说明 |
|---|---|---|
| `seed` | int | 缺省由服务端生成并**回带** |
| `p1` / `p2` | loadout | 面板 + 技能 + AI（排位场景来自不可变快照） |
| `logger` | 注入 | 缺省 `nullLogger`（core 不碰 IO） |

**`createBattle` 产出的初始状态**：

| 字段 | P1 | P2 | 来源 |
|---|---|---|---|
| `x`（px） | **224** | **800** | `battle-config` 格中心 |
| `facing` | +1 | −1 | 同上 |
| `hp / mp / sp` | 132 / 41 / 41 | 110 / 34 / 34 | 面板（**开局即满**） |
| `regen` | `{mp:1, sp:2}` | `{mp:1, sp:2}` | 模板 |
| `cooldowns` | `{}` | `{}` | 空 |
| `aiContext` | 入口 + 空 `vars` | 同 | ③ |
| 基地 | `hp 100 / def 64` | 同 | `battle-config` |

> 表中 `hp/mp/sp` 用的是 `examples/README.md` §1 的示例面板；位置、`facing`、`regen`、基地三项与面板无关，任何场景都一样。**黄金战斗（§3.1）的固定 loadout 是 `hp 100 / mp 40 / sp 60`（双方相同）**——见 §3.1 的 loadout 表。

---

## 3. 阶段 2：每 tick 的跨系统数据流（14 步）

每步只写"**从哪读、往哪写**"；计算公式见 `examples/` 对应篇。

| 步 | 读取（来自） | 产出（交给） | 传递的关键值 |
|---|---|---|---|
| 1 | `seed`、`tick`、`cooldowns` | 引擎临时状态 | 本 tick 各用途随机流、冷却递减后的 CD |
| 2 | 玩家 `effects` | 玩家五维/资源 | `stat += delta`，到期移除 |
| 3 | **只读快照**（`tick`/`self`/`enemy`/`bases.*`/`field`；**不含弹幕**） | **AI 运行时** → `{action, trace}` | 快照字段白名单（**不投影 `bullets`**——AI 无法观测弹幕＝设计，弹幕生成当 tick 全解算）；`vars` 跨 tick 持久 |
| 4 | AI 的 `action` | 引擎 action | 非法 → `wait` |
| 5 | 玩家 `effects`（control） | 覆写后的 action | 眩晕>位移，位移取首个；**复写不扣资源** |
| 6 | action + 技能面板 + 资源/CD | 意图 + **弹幕** + 资源/CD 写回 | `skill.cast`（扣资源、写 CD、生成弹幕并记录生成序号） |
| 7 | 双方意图 + 位置 | 新位置 + 碰撞事件 | 穿敌判定、碰撞位置（1px）、碰撞伤害 |
| 8 | 本 tick 全部弹幕 + 双方位置轨迹 | 命中/抵消事件 | 弹幕按**生成顺序**递归处理；AOE 用**位移后位置** |
| 9 | 命中/碰撞的攻防面板 | 玩家 `hp` + 新 `effects` | 闪避→基础（含 def×1.6）→背击→暴击→取整→吸血→附加 |
| 10 | 玩家 `regen` | 玩家 `mp/sp` | 封顶 |
| 11 | `tick`、`maxHp` | 玩家/基地 `hp` | `tick≥48` 同时扣 `ceil(maxHp×6.25%)` |
| 12 | 双方基地/角色 `hp` | `result` | 基地 > 角色优先级；同级同时 → 平局 |
| 13 | 本 tick 全部中间量 | **`frame`** | `diff`（1px 位置 + 碰撞位置）+ `events`（带 `cid`）+ `aiTrace` |
| 14 | — | 下一 tick | 弹幕**不跨 tick**（场上存活数归 0） |

### 3.1 逐 tick 轨迹（黄金战斗：seed 20260912，18 tick，winner = P2）

> **本节基准 = 黄金战斗场景（gate 项 8 同源）**：`.audit/golden-battle.js` / `.audit/golden-battle.json`。
> 之所以不用 §2 的示例面板：§2 只给到"面板结构与示例值"，缺**插件 uid / 品质档位 / 词条值 / 三个技能槽位顺序 / AI 程序**，无法无歧义重建一场战斗；黄金战斗是**固定 loadout × 固定行动计划 × 固定 seed**，可逐帧复现，因此以它为准。
> **复算命令**：`node .audit/walkthrough.js`（真实引擎 `createBattle` + `runFull`，打印逐 tick 表与事件链、写 `.audit/walkthrough.json`，并与 `.audit/golden-battle.json` 逐字段比对；退出码 0 = 一致）。
>
> **固定 loadout（不经过任何随机生成）**：
>
> | 项 | P1（id `A`） | P2（id `B`） |
> |---|---|---|
> | 起点 / 朝向 | `x 224` / `+1` | `x 800` / `−1` |
> | 面板 | `hp 100 / mp 40 / sp 60`（max 同值）、`atk 12`、`def 8` | `hp 100 / mp 40 / sp 60`（max 同值）、`atk 19`、`def 9` |
> | regen / special | `{mp:1, sp:2}` / `crit 0.5`（暴击流被真实消费） | `{mp:1, sp:2}` / 全 0 |
> | 技能 | `skill_straight_precise`（精准射击，straight：`mult 1.0`、cost `sp 6`、cd 2、L3、range 8） | `skill_dash_bash`（突击盾，displacement：`mult 1.3`、`distance 4`、`passThroughEnemy false`、cost `sp 10`、cd 3、L2） |
> | 行动来源 | 固定行动计划数组（脚本内 `plan.p1`） | 固定行动计划数组（脚本内 `plan.p2`） |
>
> 表内 `x/hp/mp/sp` 为该 tick **结束时**的值（`diff.players.*.toX` 与帧内 `hp/mp/sp`），`f` 为朝向；"行动"列写行动计划里的**原始行动名**（本场全部合法）。计算细节见 `examples/07`、`examples/04`。

| tick | P1 行动 | P1 x/hp/mp/sp/f | P2 行动 | P2 x/hp/mp/sp/f | 跨系统事件（值从谁到谁） |
|---|---|---|---|---|---|
| 1 | `dodge_right` | 352 / 100 / 40 / 60 / +1 | `move_left` | 736 / 100 / 40 / 60 / −1 | 双方位移（`dodge` 128px / `move` 64px）；无弹幕、无碰撞 |
| 2 | `move_left` | 288 / 100 / 40 / 60 / +1 | `wait` | 736 / 100 / 40 / 60 / −1 | P1 回撤 64px；**朝向不变**（移动类动作只写位置） |
| 3 | `wait` | 288 / 100 / 40 / 60 / +1 | `skill:bash` | 480 / 100 / 40 / 52 / −1 | 突击盾：`canCast` 扣 `sp 10`、写 `cd 3`；**沿声明路径生成 5 枚 0 速弹幕** L2 @480/544/608/672/736（`srcType=displacement`）；P2 位移 736→480；tick 末清场 |
| 4 | `skill:precise` | 288 / 100 / 40 / 56 / +1 | `dodge_left` | 352 / 100 / 40 / 54 / −1 | 精准射击：扣 `sp 6`、生成 1 枚平射弹幕 L3 @288；与 P2 轨迹（480→352）解方程 → **命中 @442**，但伤害步骤判**闪避成功**（本 tick `dodge` 行动给 `dodgeChanceBonus`）→ **0 伤害**（hp 不变） |
| 5 | `move_right` | 352 / 100 / 40 / 58 / +1 | `move_right` | 416 / 100 / 40 / 56 / −1 | 双方相向移动；结束时 gap 恰 64 → **不算接触**（D-19），无碰撞事件 |
| 6 | `skill:precise` | 352 / 100 / 40 / 54 / +1 | `wait` | 416 / 91 / 40 / 58 / −1 | 平射命中 @416：步骤 9 `A->B` **9**（`reduction = 1−9/(9+40)`） |
| 7 | `dodge_left` | 224 / 80 / 40 / 56 / +1 | `skill:bash` | 160 / 91 / 40 / 50 / −1 | 突击盾声明路径生成 L2 @160/224/288/352/416；**命中 @224：`B->A` 20**；P1 位移 352→224、P2 位移 416→160（互穿落位，D-33） |
| 8 | `wait` | 224 / 80 / 40 / 58 / +1 | `dodge_right` | 288 / 91 / 40 / 52 / −1 | 仅 P2 位移 +128；无事件 |
| 9 | `move_right` | 224 / 68 / 40 / 60 / +1 | `wait` | 288 / 84 / 40 / 54 / −1 | **角色碰撞 @contactX 256**：双方各受对方 `atk×0.8` → `A->B` **7**、`B->A` **12**（碰撞伤害走完整伤害链路，本例无防御/背击/暴击） |
| 10 | `move_left` | 160 / 68 / 40 / 60 / +1 | `move_left` | 224 / 84 / 40 / 56 / −1 | 同向移动；无事件 |
| 11 | `skill:precise` | 160 / 48 / 40 / 56 / +1 | `skill:bash` | 224 / 84 / 40 / 48 / −1 | **弹幕互撞 1 次**：P1 平射 L3 @160 vs P2 路径弹幕 L2 @160 → **L2 数值小=等级高 → 穿低**（D-28），P2 该枚消失、P1 弹幕留下 → **命中 @160：`B->A` 20**；P2 的突击盾意图 224−256=−32 越过 `BOUND_LOW 32` → **撞 P1 基地、停原地**（D-61），并记 `atk×0.8` 经基地 `def 64` 的伤害：**P1 基地 `hp 100→95`** |
| 12 | `dodge_right` | 288 / 48 / 40 / 58 / +1 | `wait` | 224 / 84 / 40 / 50 / −1 | P1 位移 +128；无事件 |
| 13 | `wait` | 288 / 48 / 40 / 60 / +1 | `dodge_right` | 352 / 84 / 40 / 52 / −1 | 仅 P2 位移；无事件 |
| 14 | `move_left` | 224 / 48 / 40 / 60 / +1 | `move_left` | 288 / 84 / 40 / 54 / −1 | 同向移动；无事件 |
| 15 | `skill:precise` | 224 / 16 / 40 / 56 / +1 | `skill:bash` | 288 / 77 / 40 / 46 / −1 | **同 tick 两条链路并存**：弹幕互撞 1 次（L2 穿 L3）+ **命中 @224：`B->A` 20**；**同时角色碰撞 @256**：`A->B` 7、`B->A` 12（弹幕与碰撞**分别结算**，D-18/D-35） |
| 16 | `dodge_left` | 96 / 16 / 40 / 58 / +1 | `wait` | 288 / 77 / 40 / 48 / −1 | P1 位移 −128；无事件 |
| 17 | `move_right` | 160 / 16 / 40 / 60 / +1 | `dodge_left` | 96 / 77 / 40 / 50 / −1 | 双方位移（P2 落位到 P1 左侧 96）；无事件 |
| 18 | `wait` | 160 / **0** / 40 / 60 / +1 | `move_right` | 96 / 66 / 40 / 52 / −1 | **角色碰撞 @128**：`A->B` **11 背击**、`B->A` **19 背击** → P1 `hp 16→0` → 步骤 12 `verdict = {winner:'p2', phase:'role'}`，战斗在第 18 tick 终止 |

**跨系统传递的三个要点**：

1. **面板 → 伤害**：受方 `def` 只在**步骤 9** 被读取，且仅当该 tick `defending=true` 时取 `def×1.6`（D-43）。黄金战斗中双方**都没有 `defend` 行动**，因此 t6 的 9、t7/t11/t15 的 20、t9 的 7/12 全按未防御的 `def` 计算。
2. **朝向 → 背击**：`facing` 只在 `createBattle` 初始化时写入；**引擎没有任何在 tick 内改写 `facing` 的代码路径**（`move_*` / `dodge_*` 只写位置；`ACTIONS` 白名单里也没有 `turn`——`turn` 会被 D-80 归一化成 `wait`，见 `node .audit/walkthrough.js` 第 [5] 段）。本场 t18 的两次背击来自**碰撞判定**按"位移后位置"读 `facing`（`isBackstab(..., 'melee')`：攻方位于受击方朝向的反方向），不是朝向变化造成的。
3. **弹幕 → 弹幕**：t11/t15 的互撞在**步骤 8** 按"生成顺序 + 等级"结算，**数值小的等级高**（D-28 高穿低），被消者不再进入命中结算；同一 tick 里"弹幕命中"与"角色碰撞"分别在步骤 8 / 步骤 9 结算，互不替代（t15 两者同时发生）。

### 3.2 单 tick 数据流详解：t1（黄金战斗的 t1）

```
① 步骤 3  引擎 → AI：只读快照 {tick:1,
            self:{hp:100, maxHp:100, mp:40, maxMp:40, sp:60, maxSp:60, atk:12, def:8, x:224, facing:+1,
                  baseHp:100, cooldowns:{}, effects:[]},
            enemy:{同结构，x:800},
            bases:{self:{hp:100, maxHp:100, def:64}, enemy:{同}},
            field:{fieldPx:1024, cellPx:64}}      ← 白名单投影 + 深冻结；**不含 bullets**（D-138）
          AI → 引擎：p1 action = 'dodge_right'；p2 action = 'move_left'
② 步骤 4  归一化（D-80）：'dodge_right' → {type:'dodge', dir:+1}；'move_left' → {type:'move', dir:−1}
③ 步骤 6  意图提交：dodge 取 cfg.dodgePx（128px）→ p1 意图 352；move 取 cfg.movePx（64px）→ p2 意图 736；
          两者都不生成弹幕（只有 skill 才生成），也不扣资源
④ 步骤 7  统一落位：意图不重叠、未越界 → p1 224→352、p2 800→736；无碰撞、无基地命中
⑤ 步骤 8  场上弹幕 0 枚 → 无命中、无抵消
⑥ 步骤 10/11/12  P1 sp 60→60（已封顶）、P2 sp 60→60；tick < overtimeStart 48；无 verdict
⑦ 步骤 13 引擎 → frame：diff.players 记两段 1px 位移，diff.bullets 为空（**回放帧仍带 `bullets` 供展示/诊断，
          与 AI 快照无关**）；
          events 两条 move.resolve（debug 级）
```

> **快照实际字段（权威清单见 `server/runner.js` 的 `projectSnapshot` 与 `docs/systems/08-ai.md` §4.5，D-147）**：`tick`；`self|enemy.{hp,maxHp,mp,maxMp,sp,maxSp,atk,def,x,facing,baseHp}`；`self|enemy.cooldowns.<sid>`；`self|enemy.effects[i].{uid,kind,stat,delta,displacement,remaining}`；`bases.self|enemy.{hp,maxHp,def}`；`field.{fieldPx,cellPx}`。**不含 `bullets`（设计）**；**`baseHp` ＝ 该方基地当前血量（≠ 角色 `maxHp`）**。

> **设计期示例（已按真实引擎复算，与黄金战斗的 t1 无关）**：原 §3.2 讲的是"位移伤害并入弹幕系统"——位移不再是特殊技能，它生成的路径弹幕与敌方 AOE 走**完全相同**的抵消流程，无需任何特判。这个**机制结论仍然成立**，数值改为以下实测值（`node .audit/walkthrough.js` 第 [5b] 段）：
>
> - P1 突击盾 224→480 生成 5 枚路径弹幕 **L2** @224/288/352/416/480；P2 火球术（vertical、range 8、起点 800、facing −1）落点 `clampX(800 − 8×64) = 288`、AOE 覆盖格心 352/288/224（**L3**）。
> - 真实解算 → **三次抵消** `@224 / @288 / @352`，每次都是 **P1 的 L2 穿掉 P2 的 L3**（等级数值小者胜，D-28）→ 三枚 AOE 全部被消，本 tick 无命中。
> - 旧文两处说法不成立、已修正：① "P1 未被火球命中"**只在位移弹幕把三枚 AOE 全部抵消的前提下成立**；若 P1 留在起点不动、或只放火球（无抵消），未被消掉的 AOE 弹幕**会命中生成格上的 P1**（实测命中 @224，伤害 `19×0.8×(1−8/48) = 12.667 → 12`）。② 位移路径弹幕命中 P2 的伤害是 `12×1.3×(1−9/49) = 12.735 → 12`（不是 10）。

---

## 4. 引擎 → 帧（⑤）

每 tick 的 `frame` 是**回放与前端唯一的输入**（数据自足，不做渲染）：

> 下面这段 JSON 是**设计期示例**（用 §3.2 那个"位移弹幕抵消"例子的数值），只用来展示**字段结构**；真实字段名与取值以 `server/battle.js` 的 `{tick, diff}` 与 `engine.step` 返回的 `diff` 为准（黄金战斗的实际帧可由 `node .audit/walkthrough.js` 复算）。

```jsonc
{ "tick": 1,
  "diff": {
    "players": [ { "actor":"p1", "fromX":224, "toX":480, "fromFacing":1, "toFacing":1,
                   "hpDelta":0, "mpDelta":0, "spDelta":-8, "defending":false, "buffs":[] } ],
    "bullets": [ { "uid":"b_1", "level":2, "type":"aoe", "x0":224, "clashAt":224, "vsUid":"b_9" } ],
    "collisions": [],
    "bases": [],
    "events": [ { "cid":"t1:p1:1", "type":"bullet.collide", "atX":224, "winner":"p1" } ],
    "aiTrace": [ { "path":"body.s[3].body.s[3].cond", "result":true, "nodeType":"if" } ]
  } }
```

**帧必须自足**（`T-BT-1`）：累积 `diff` 可重建任意 tick 的完整状态。

---

## 5. 引擎 → 调用方（⑥）

| 出参 | 结构 | 说明 |
|---|---|---|
| `seed` | int | **回带**（可复现） |
| `winner` / `phase` | string | 引擎判定：`winner ∈ {p1, p2, draw}`；`phase ∈ {base, role}` 表示结束发生在基地层还是角色层（`draw` 由双方同级同时归零产生） |
| `ticks` | int | 实际 tick 数（黄金战斗 = 18） |
| `frames` | `frame[]` | 逐 tick 差异（§4），每项 `{tick, diff}` |
| `id` / `tier` | string | 回放 id（进程内注册表）/ 本场所用段位（`server/battle.js`） |
| `programHash` | `{p1, p2}` | 回放校验（随 loadout 流动，§2.3） |
| `log` | `{level, events}` | 日志摘要（受总控开关约束） |

**本轮不持久化**：段位/仓库/loadout 由请求传入并回带，服务端不落盘。

---

## 6. 可观测性：同一条 `cid` 的完整链路

以 **§3.2 的设计期示例**（位移弹幕抵消）为例展示 `cid` 如何串联同一条链路；黄金战斗的实际链路见 `node .audit/walkthrough.js` 第 [6] 段（事件带 `cid` 与 tick 归属）：

```
[info ] engine     tick.begin    cid=null     tick 1；引擎在步骤 9 按需派生 crit/dodge 流（`rng.deriveStream(tick,'crit')`；AI 自己的流由调用方在步骤 3 派生）
[debug] ai.runtime ai.resume     cid=null     p1 action=skill3（trace 路径 body.s[3]…）
[info ] skills     skill.cast    cid=t1:p1:1  突击盾 → sp 72→62、cd=3、路径格 3~7
[debug] bullets    bullet.spawn  cid=t1:p1:1  aoe L2 @224/288/352/416/480
[info ] skills     skill.cast    cid=t1:p2:1  火球术 → mp 34→20、cd=5、落点 288
[debug] bullets    bullet.collide cid=t1:p1:1 @224 p1(L2) vs p2(L3) → winner p1
[info ] engine     tick.end      cid=null     p1.sp 72→62；存活弹幕 0
```

---

## 7. 测试要点映射

| 走查环节 | 测试点 |
|---|---|
| §2.1 数据表 → 实例 | T-IT-* / T-RO-* / T-SK-* / T-DC-1/2 |
| §2.2 面板 | T-RO-3 / T-IT-4 / T-PB-6 |
| §2.3 programHash | T-AF-7 / T-AI-2 |
| §3 每 tick 数据流 | T-EN-1..10 / T-BT-1..29 |
| §4 帧自足 | **T-BT-1** / T-EN-9 |
| §5 响应 | T-AP-1/2/3/5 |
| §6 `cid` 链路 | **T-LG-11** |
| 全场复现 | **T-BT-13/14**（黄金战斗，B11 落地） |
