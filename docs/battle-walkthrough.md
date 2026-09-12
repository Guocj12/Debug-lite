# 战斗全流程走查（系统间数值与状态传递）

> 所属：Debug-Lite v3　更新：2026-09-11
> **定位**：本文只讲**系统之间的数值与状态如何传递**（谁给谁什么值、以什么结构、什么时候）；**具体计算由各系统示例集负责**，本文只引用不重复推导（见 `examples/`）。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/tasks.md`。
> 全场基准数值见 `examples/README.md` §1；本文逐 tick 轨迹由端到端校验器复算得出（同 seed 可复现）。

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

---

## 3. 阶段 2：每 tick 的跨系统数据流（14 步）

每步只写"**从哪读、往哪写**"；计算公式见 `examples/` 对应篇。

| 步 | 读取（来自） | 产出（交给） | 传递的关键值 |
|---|---|---|---|
| 1 | `seed`、`tick`、`cooldowns` | 引擎临时状态 | 本 tick 各用途随机流、冷却递减后的 CD |
| 2 | 玩家 `effects` | 玩家五维/资源 | `stat += delta`，到期移除 |
| 3 | **只读快照**（players/bullets/field） | **AI 运行时** → `{action, trace}` | 快照字段白名单；`vars` 跨 tick 持久 |
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

### 3.1 逐 tick 轨迹（17 tick，同 seed 可复现）

> `x/hp/mp/sp` 为该 tick **结束时**的值；`f` 为朝向。计算细节见 `examples/07`、`examples/04`。

| tick | P1 行动 | P1 x/hp/mp/sp/f | P2 行动 | P2 x/hp/mp/sp/f | 跨系统事件（值从谁到谁） |
|---|---|---|---|---|---|
| 1 | skill3（突击盾） | 480 / 132 / 41 / 64 / +1 | skill3（火球术） | 800 / 110 / 21 / 63 / −1 | **位移路径弹幕 ⇄ 敌方 AOE 三次抵消** @224/288/352；P1 未被火球命中 |
| 2 | move_right | 544 / 111 / 41 / 66 / +1 | skill2（冰锥） | 800 / 110 / 14 / 63 / −1 | 弹幕 → 角色命中 @533：21 |
| 3 | move_right | 608 / 93 / 41 / 68 / +1 | skill1（精准） | 800 / 110 / 13 / 59 / −1 | 弹幕 → 角色命中 @572：18 |
| 4 | move_right | 672 / 93 / 41 / 70 / +1 | defend | 800 / 110 / 14 / 61 / −1 | 写 `defending=true`（供步骤 9 使用） |
| 5 | skill2（重击） | 672 / 94 / 32 / 64 / +1 | skill2（冰锥） | 800 / 98 / 7 / 63 / −1 | **L2 抵消 L4** @672；重击 AOE 命中 @800：12 |
| 6 | move_right | 736 / 76 / 33 / 66 / +1 | skill1 | 800 / 99 / 6 / 59 / −1 | 相向落位**恰好相邻**（gap 64）→ 不算碰撞；弹幕命中 @686：18 |
| 7 | skill1（旋风斩） | 736 / 76 / 34 / 56 / +1 | defend | 800 / 91 / 7 / 61 / −1 | AOE 命中 @800：**8**（受方 def×1.6 生效） |
| 8 | defend | 736 / 60 / 35 / 58 / +1 | skill1 | 800 / 92 / 6 / 57 / −1 | 命中 @736：**16**（受方 def×1.6） |
| 9 | skill2 | 736 / 61 / 26 / 52 / +1 | defend | 800 / 81 / 7 / 59 / −1 | AOE 命中：**11**（def×1.6） |
| 10 | skill1 | 736 / 61 / 27 / 42 / +1 | skill1 | 800 / 72 / 6 / 55 / −1 | 抵消 @672（L2>L3）；AOE 命中：9 |
| 11 | defend | 736 / 61 / 28 / 44 / +1 | **turn** | 800 / 72 / 7 / 57 / **+1** | P2 转身 → **位移后朝向**写入状态（背击判定基准） |
| 12 | skill1 | 736 / 62 / 29 / 34 / +1 | skill1 | 800 / 58 / 6 / 53 / +1 | AOE 命中：**14（背击 ×1.5）** |
| 13 | skill2 | 736 / 63 / 20 / 28 / +1 | defend | 800 / 41 / 7 / 55 / +1 | AOE 命中：**17**（重击 ×1.3 × 背击，含 def×1.6） |
| 14 | skill1 | 736 / 65 / 21 / 18 / +1 | skill1 | 800 / 19 / 6 / 51 / +1 | **背击 + 暴击叠加**：**22** |
| 15 | defend | 736 / 65 / 22 / 20 / +1 | defend | 800 / 19 / 7 / 53 / +1 | 双方防御 |
| 16 | skill1 | 736 / 66 / 23 / 10 / +1 | skill1 | 800 / 5 / 6 / 49 / +1 | AOE 命中：**14** |
| 17 | skill2 | 736 / 67 / 14 / 4 / +1 | defend | 800 / **−12** / 7 / 51 / +1 | **终结**：AOE 命中 **17** → `hp ≤ 0` |

**跨系统传递的三个要点**：

1. **面板 → 伤害**：受方 `def` 只在**步骤 9** 被读取；若该 tick `defending=true` 则取 `def×1.6`（t7/t8/t9/t13 的伤害因此低于非防御时）。
2. **朝向 → 背击**：t11 的 `turn` 把**位移后**朝向写入状态，t12 起所有近战命中都成为背击（×1.5）——同一个 `facing` 字段在步骤 7 写、步骤 9 读。
3. **弹幕 → 弹幕**：t1 的位移路径弹幕与 t5/t10 的近战 AOE 都在**步骤 8** 按"生成顺序 + 等级"相互抵消，被消者不再进入命中结算。

### 3.2 单 tick 数据流详解：t1

```
① 步骤 3  引擎 → AI：只读快照 {self:{x:224, sp:72, …}, enemy:{x:800}, bullets:[], field:{…}}
          AI → 引擎：action = 'skill3'（突击盾）+ trace（命中"距离>256 且 cd3==0"分支）
② 步骤 6  引擎 → 技能：canCast 读 sp 72 ≥ 10、CD 0 → 写回 sp 62、cooldowns.skill3 = 3
          技能 → 弹幕：沿声明路径 224→480 生成 0 速弹幕（格 3~7，等级取模板 bulletLevel = 2）
          P2 同理：火球术落点 288 → AOE 弹幕（格 3/4/5，L3），写回 mp 20、cd = 5
③ 步骤 8  弹幕 ⇄ 弹幕：按生成序号处理
             p1 的格 3 弹幕（L2）与 p2 的格 3 弹幕（L3）在 **224** 相遇 → 高穿低 → p2 侧消失
             格 4（288）、格 5（352）同理 → **P2 的火球被全部抵消**
          弹幕 → 角色：存活弹幕与 P1 轨迹（224→480）解方程 → 无命中
④ 步骤 13 引擎 → frame：diff.bullets 记三次碰撞位置（224/288/352）；
          events 三条 bullet.collide（同一 cid t1:p1:1）；aiTrace 两条
```

> 这一 tick 体现**"位移伤害并入弹幕系统"的价值**：位移不再是特殊技能，它生成的路径弹幕与敌方 AOE 走**完全相同**的抵消流程，无需任何特判。

---

## 4. 引擎 → 帧（⑤）

每 tick 的 `frame` 是**回放与前端唯一的输入**（数据自足，不做渲染）：

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
| `result` | `{winner, reason, tick, final{players,bases}}` | `reason ∈ {base_dead, hero_dead, draw}` |
| `frames` | `frame[]` | 逐 tick 差异（§4） |
| `programHash` | `{p1, p2}` | 回放校验 |
| `log` | `{level, events}` | 日志摘要（受总控开关约束） |

**本轮不持久化**：段位/仓库/loadout 由请求传入并回带，服务端不落盘。

---

## 6. 可观测性：同一条 `cid` 的完整链路

以 t1 的"位移弹幕抵消"为例：

```
[info ] engine     tick.begin    cid=null     tick 1；派生 ai/crit/dodge 三条流
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
