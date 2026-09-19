# 技能系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。

## 1. 职责

- 技能模板实例化（品质随机数值）。
- 四种类型（近战 / 平射 / 垂直 / 位移）的行为解析与弹幕生成。
- 装配技能插件，计算最终参数、消耗与冷却。
- 释放判定（资源 / 冷却）。

> **实现位置**：`server/core/skills.js`（`instantiateSkill` / `applySkillPlugins` / `canCast` / `buildSkillAction` / `coveredCellRanges`）。
> 参数滚动、槽位、弹幕发射模式由 `items.generateSkillItem` 与 `skills.buildSkillAction` 按**机制表**解释，**代码内不按技能类型或词条 id 写分支**（2026-09-16 数据驱动改造）。

## 2. 依赖

- `items.js`（调 `generateSkillItem` 做参数随机；二者同构，避免双实现）。
- **机制层（机制词汇，不是内容）**：`skill-mechanics.json`（类型机制：参数滚动模式 / 语义槽位 / 弹幕发射模式与常量 / `costDims` / `precision` / `bounds`）、`affix-registry.json`（词条语义：`skillOp` / `hitEffect` / `castEffect`）。
- **内容层（示例数据，待用户设计）**：`skill-templates.json`（模板固有数值）、`plugins.json`（插件与其词条基础值）。
- `field.js`（px 坐标、格区间、clamp）。
- `battle-config.json`（速度/格宽）。

## 2A. 两层分工（机制层 / 内容层）

| 层 | 表 | 回答的问题 | 谁改 |
|---|---|---|---|
| **机制层** | `server/data/skill-mechanics.json` | "这个**类型**的参数怎么滚、词条打在哪个字段、弹幕怎么发、常量是什么" | 机制变更时由实现侧改表 |
| **机制层** | `server/data/affix-registry.json` | "这个**词条**是什么、怎么滚动、聚合到哪、在技能链上做什么" | 同上 |
| **内容层** | `server/data/skill-templates.json` / `plugins.json`（含 `role-templates.json` / `qualities.json` / `items-config.json` / `unlock.json`） | "具体有哪些技能/插件、标准数值与解锁段位" | **当前为示例数据，正式内容由用户设计后冻结** |
| （机制层） | `server/data/ai-nodes.json` | AI 语言的真实节点类型清单 | 机制词汇，不是内容 |

- **新增一个技能类型** = 在 `skill-mechanics.json` 的 `types` 里加一条（声明 `params` 滚动模式、`slots`、`emit.pattern` 与 `bullet` 描述）；**新增一个词条** = 在 `affix-registry.json` 的 `affixes` 里加一条（声明 `roll` 与去向）。两者都**不改本模块代码**。
- **唯一的代码登记点**：`emit.pattern` 的取值需在 `skills.js` 的发射器表（`EMITTERS`）里有同名函数；未登记的模式会在运行期记 `warn`（`skill.emit.unknown`）并退化为"无可发射弹幕"，不会静默错误。
- **未登记的词条 id / 算子名**：运行期记 `warn`（`skill.plugin.unknown`）并跳过，不静默失效。

## 3. 数据结构

- 技能实例（`instantiateSkill` 产物）：`sid` / `templateId` / `name` / `type` / `multiplier` / `cost{hp,mp,sp}` / `cooldown` / `bulletLevel` / 类型参数 / `falloff` / `affixes[]` / `specials{}` / `castEffects[]`。
  - `sid = templateId`（引擎冷却键用 `sid`；物品链 B20 可另分配实例 uid）。
  - `specials{}`：技能插件携带的概率类词条（`critChance` / `lifesteal`）；由 `applySkillPlugins` 写入，随弹幕 `payload.specials` 参与命中结算。
  - `castEffects[]`：技能插件携带的**释放类**词条（目前只有 `cast_buff`）；释放时入效果队列。
  - `affixes[]`：技能插件携带的**命中类**词条（`stun` / `knockback` / `pull` / `dot` / `true_dmg`），由引擎步骤 9 结算。

| 类型 | 类型参数 | 机制表 `params` 滚动模式 |
|---|---|---|
| `melee` | `range: [lo, hi]`（相对朝向的格区间） | `pair`（原样拷贝闭区间） |
| `straight` | `range`（最远格数）、`bulletCount`、**无 `bulletSpeed`**（D-21） | `range`/`bulletCount` = `intMin` |
| `vertical` | `range`（落点格数）、`area: [lo, hi]`（相对落点的格区间） | `range` = `intMin`、`area` = `pair` |
| `displacement` | `distance`、`passThroughEnemy`、`dealDamage`、`fullDodgeDuring` | `distance` = `intMin`；三个开关 = `copy` |

- **三种参数滚动模式（`skill-mechanics.json._paramsModes`）**：
  1. `pair`：数值对原样拷贝（闭区间，不乘品质系数、不取整）；
  2. `intMin`：×品质系数后四舍五入取整，下限取 `bounds.min<字段名>`（如 `minRange` / `minBulletCount` / `minDistance`，缺省 1）；
  3. `copy`：布尔/标量原样拷贝（模板固有字段，不随品质随机）。
- **语义槽位 `slots`**：类型机制表把"词条作用的**语义槽位**"映射到"该类型下的**真实字段名**"（如 `addSlot(range)` 在 `melee` 上缺席 → 近战射程不可增强，D-128③）。槽位缺席或目标字段不存在 = 该词条对本类型**不生效**。
- **弹幕发射模式（`emit.pattern`，4 种）**：

| 模式 | 用于 | 覆盖格/发射锚点 | 弹幕常量（`emit.bullet` 描述） |
|---|---|---|---|
| `cellsFromRange` | melee | 以**施法者格心**为基准，`range` 为闭区间偏移 | `btype=aoe`、`v=0`、`len=0`、`origin=cellCenter`、`distCells=fromOriginCell` |
| `repeatCount` | straight | 按 `countFrom`（= `bulletCount`）枚数**重复同一枚**，起点 = `origin=caster`（不再取邻格，D-22） | `btype=straight`、`v=len=range×cellPx`、`dirFrom=facing`、`distCells=none` |
| `impactCells` | vertical | 先算落点 `impact=clampX(x+朝向×rangePx)`，覆盖格 = 以**落点格**为基准的 `cellsFrom`（= `area`）区间 | `btype=aoe`、`v=0`、`len=0`、`origin=cellCenter`、`distCells=fromImpactCell` |
| `pathCells` | displacement | 按 `move.cellsFrom`（= `distance`）声明路径**逐格发射**（D-18/D-118） | `btype=aoe`、`v=0`、`len=0`、`dirFrom=facing`、`origin=cellCenter` |

- `origin=caster` 用施法者当前 px 坐标；`origin=cellCenter` 用所在格中心 px（`field.xCenter`）。
- `distCells` 语义：`fromOriginCell` = |格 − 施法者格|、`fromImpactCell` = |格 − 落点格|、`none` = 不写该字段（= 0，falloff 不衰减）。
- **`falloff`（D-29）**：AOE 每向外一格减伤百分比，`0` = 不衰减；模板固有字段，**不随品质随机**。
- **`costDims = ["hp","mp","sp"]`**：消耗维度与"消耗补偿"的叠加维度皆由此表声明，代码无字面量。
- **`bounds`**：`minStat=1` / `minSlotCount=1` / `minRange=1` / `minBulletCount=1` / `minDistance=1` / `minBulletLevel=1` / `minCooldown=0`；**`precision.stat=2`**（面板与倍率保留 2 位小数）、`precision.multiplier=3`（`mult_up` 专用）。

## 4. 核心流程（代码逻辑）

### 4.1 实例化 `instantiateSkill(template, quality, rng)`

1. 拷贝模板固有字段（`type`、`bulletLevel`、`cost` 结构、`falloff`、`slotWeights`、`passThroughEnemy` / `dealDamage` / `fullDodgeDuring` 等）。
2. 可随机数值参数**不在此处滚动**：`instantiateSkill` 直接复用 `items.generateSkillItem` 的产物（`multiplier` / `cost` / `cooldown` / `bulletLevel` / `range` / `bulletCount` / `area` / `distance` / 三个开关），滚动规则逐字段取自 `skill-mechanics.json` 的类型机制表（见 §3 的 `pair` / `intMin` / `copy`）：`multiplier` 按 `precision.stat` 保留 2 位；`弹幕数量/射程/位移距离` 下限取 `bounds.min*`（缺省 1）；`冷却` 下限 `minCooldown=0`。
3. **`bulletLevel` 为模板固有字段**：`generateSkillItem` 原样拷贝，**不随品质系数缩放**（D-115/D-118；下限 1 由数据表校验保证）。
4. **不再有 `bulletSpeed`**（已从模板与数据表删除，D-21）。
5. 初始化 `affixes=[]`、`specials={}`、`castEffects=[]`（供 `applySkillPlugins` 写入）。
6. 未登记的类型直接抛 `RangeError`（不静默降级）。

### 4.2 装配技能插件 `applySkillPlugins(skill, plugins)`

> **实现方式**：循环体内**没有**技能类型判断与词条 id 判断——每个词条先查 `affix-registry.json`，再按它声明的 `skillOp` 算子、`hitEffect`、`castEffect` 三件事分派。纯函数：返回新实例，入参不变。

1. **算子解释器**（算子名取自注册表 `_opVocabulary`；未登记算子 → `warn` 并跳过）：

| 算子 | 语义 | 本仓库用到它的词条 |
|---|---|---|
| `scalePct` | `field ← round(field×(1+v), precision[op.round])` | `mult_up`（`multiplier`，3 位小数） |
| `sub` | `field ← max(bounds[op.min], field − v)` | `cooldown_down`（`cooldown`，`minCooldown=0`）、`level_up`（`bulletLevel`，`minBulletLevel=1`） |
| `add` | `field ← max(bounds[op.min], field + v)`；**该类型无此字段则整条不生效** | `bullet_plus`（`bulletCount`；近战无此字段 → 不生效） |
| `addSlot` | 语义槽位经类型机制表 `slots` 映射到真实字段后 `+ v`；**槽位缺席则不生效** | `range_plus` / `distance_plus`（同为槽位 `range`：平射/垂直→`range`，位移→`distance`，近战→缺席不生效） |
| `scaleCostCeil` | 仅对减耗类（`costDeltaByTier === null`）生效：`cost[dim] ← ceil(cost[dim]×(1−v))`，维度取自 `costDims` | `cost_down` |
| `addSpecial` | `skill.specials[field] ← min(caps.probability, 现值 + v)` | `crit_chance`（`critChance`）、`lifesteal` |

2. **命中类词条**（注册表 `hitEffect` 存在）：把 `{id, params}` **原样登记**进 `skill.affixes`，由引擎步骤 9 按注册表结算（本模块不做数值裁剪）。
3. **释放类词条**（注册表 `castEffect` 存在）：按注册表生成**释放效果**条目压入 `skill.castEffects`：
   - `kind` / `stat` 取自注册表；`delta` 取 `params[deltaFrom]`（`cast_buff` 即 `params.v`）；
   - `remaining` 取 `params[durationFrom]`（`cast_buff` 即 `params.duration`）；**缺省取注册表 `fallbackDuration=2`**；
   - 实际形态（注册表）为 `{kind:'continuous', stat:'atk', delta:v, remaining:duration}`。
4. **概率类词条**（`domain` 含 `skill` 且带 `skillOp.addSpecial`）：进 `skill.specials`，**叠加在角色面板值之上**，并按 `caps.probability = 1` 封顶（见 §4.5）。
5. **消耗补偿**（D-113）：除减耗类外，每个插件把消耗增量叠加到 `cost`：**每个维度 `delta = costDeltaBase[插件品质] × 插件档位 tier`**（如 rare tier1 = 3×1 = mp+3，I-6d）。**口径（B20 定稿，P2-1）**：数据表 `costDeltaByTier` 的数组值（如 `{mp:[2,4,6]}`，common 基准名义值）**仅作维度声明**、不参与计算——**声明了数组的维度**才加 `delta`（`sp_cooldown`/`sp_displacement` 声明的是 `sp`，多数插件声明 `mp`），逐档期望值由公式导出（rare=[3,6,9]、epic=[4,8,12]…）。
6. **纯函数边界**：`canCast` / `applySkillPlugins` 均返回新对象，入参技能实例不被修改。

### 4.3 释放判定 `canCast(skill, caster)`

1. 冷却：`caster.cooldowns[sid] > 0` → 不可释放（冷却在引擎每 tick 步骤 1 递减，D-82）。
2. 资源：`hp/mp/sp` 任一低于 `cost` → 不可释放。
3. 通过 → 扣资源、写入冷却、返回成功；失败 → 引擎视为**空行动**（`wait`），不扣资源、不产生效果。

### 4.4 生成释放指令 `buildSkillAction(skill, caster)`

返回 `{type:'cast', skill, bullets[], castEffects[], move?, impactX?}`，字段与覆盖格全部由类型机制表驱动（`coveredCellRanges` 由 `emit.cellsFrom` / `emit.impactFrom` 决定锚点；`mech.move` 存在时补 `move`）：

1. **近战 `melee`**（`cellsFromRange`）
   - 按 `range` 相对**朝向**算出覆盖格集合（`field.cellRange`），越界格丢弃；
   - **每格生成一枚 0 速弹幕**（D-22/D-26），各格独立参与等级判定与抵消；
   - 同一目标**最多结算一次**（D-25）；伤害按 `falloff`（以角色所在格为中心）衰减。

2. **平射 `straight`**（`repeatCount`）
   - 生成 `bulletCount` 枚；**生成位置 = 释放者当前 px**（`origin=caster`，不再取邻格，D-22），方向 = 朝向；
   - 每枚当 tick 飞完 `range × cellPx`（`v = len = range×cellPx`；D-07/D-20），与目标轨迹解连续方程判定命中；
   - **可多次命中同一目标**（多发各算一次，D-25）。

3. **垂直 `vertical`**（`impactCells`）
   - 落点 = `clampX(caster.x + 朝向 × range × cellPx)`；
   - 以落点为基准按 `area` 算出覆盖格集合，**每格一枚 0 速弹幕**；
   - 判定用**角色本 tick 位移后的位置**（D-24）；每目标最多一次；按 `falloff` 以**落点格**为中心向外衰减。

4. **位移 `displacement`**（`pathCells`；`emit.when = dealDamage`）
   - `move` 块取自机制表 `move.cellsFrom`（= `distance`）：目标位置 = `clampX(caster.x + 朝向 × distance × cellPx)`，本 tick 位移量为 `distance × cellPx`（D-07）；
   - `passThroughEnemy=true` → 可穿过敌人（走 M1 的"穿过"分支）；`false` → 走"碰撞"分支（停在相遇点一侧，按 M1 结算碰撞伤害）；
   - **伤害模型（D-18 统一版 + D-118）**：
     - `dealDamage=true` → **沿技能的声明移动路径**（`caster.x → clampX(caster.x + 朝向 × distance × cellPx)`）**每格放置一枚 0 速弹幕**，等级取模板 **`bulletLevel`**（D-118）、倍率取技能倍率——**与近战/垂直 AOE 完全同构，无任何特判**；路径**与是否被碰撞截停无关**；
     - **弹幕伤害与碰撞伤害分别结算**：若同时发生碰撞，则**同一 tick 可能受两次伤害**（路径弹幕的技能伤害 **+** M1 的碰撞伤害，双方各 `atk×collisionDmgMul`）；
     - `dealDamage=false` → **不放置路径弹幕**（`emit.when` 未通过，直接返回空弹幕）：穿过无伤害，只有**碰撞**才结算碰撞伤害；
     - **副产品**：原「恰好停在相邻不算接触」（D-19）**由本模型自然满足**（相邻格不在声明路径内）；
   - **`fullDodgeDuring=true` → 位移期间完整语义（D-72，**已接线**，语义见 §4.6）**；
   - **撞基地**：停在原地 + 按 `atk × baseHitMul` 对基地造成伤害（见 `06-field` §4.3）。

### 4.5 命中结算

- 伤害链路由引擎统一处理（见 `07-engine` §4.4）：闪避 → 基础（含 `def×1.6` 防御）→ 背击 ×1.5 → 暴击 ×1.5 → 一次取整 → 吸血 → 附加效果。
- **背击**（`07-engine` §4.5）：近战/位移用**本 tick 位移后**的相对位置与朝向；平射用弹幕飞行方向；垂直永不触发。
- **技能插件的概率类词条（`crit_chance` / `lifesteal`）的设计语义**：随弹幕 `payload.specials` 进入命中结算（B9/B6 接线）：
  - 暴击率 = `min(caps.probability, 角色面板 critChance + payload.specials.critChance)`，命中时消费引擎每 tick 派生的 `crit` 随机流；倍率取 `battle-config.crit`；
  - 吸血率 = `min(caps.probability, 角色面板 lifesteal + payload.specials.lifesteal)`，回复 `floor(本次伤害 × 吸血率)`（`maxHp` 封顶）。
  - 即：**技能插件词条叠加在角色面板值之上，并按 `caps.probability=1` 封顶**。
  - ✅ **接线已确认（2026-09-16 复核）**：`specials` 由 `applySkillPlugins` 写入技能实例、`buildSkillAction` 原样放进 `payload`；经 `POST /api/v1/battle`（`server/battle.js buildPlayer`）的 `Object.assign(inst, agg)` 使用的是 `loadout.buildPanel` 的白名单聚合结果，而该白名单**已包含 `specials` / `castEffects` / `affixes`**（其余非标准字段按 P2-② 透传），故经 API 的战斗中 `crit_chance` / `lifesteal` / `cast_buff` **均生效**（`tests/unit/mechanics.test.js` 的投影用例断言这三个字段必须穿过面板；此前文档声称"被覆盖为空"是旧实现的失真陈述）。
- **命中类词条的附加效果由引擎步骤 9 逐条按 `affix-registry.json` 的 `hitEffect` 结算**：

| 词条 | `hitEffect.kind` | 结算语义 |
|---|---|---|
| `stun` | `control` | 入控制队列，`displacement=0`（= 眩晕），`remaining=1` |
| `knockback` | `control` | `displacement = +v` 格（沿攻击来源方向），`remaining=1` |
| `pull` | `control` | `displacement = −v` 格，`remaining=1` |
| `dot` | `continuous` | `stat=hp`、`delta = −v`、`remaining=3` |
| `true_dmg` | `flatTrueDamage` | **命中后额外直扣 `v` 点真实伤害**（`hp ← max(0, hp − v)`，B21/D-128 冻结）。**不是**"把本次伤害改为真实伤害"；若要改成 D-40 的 `trueDamage = max(1, floor(atk×倍率))` 公式语义，属**设计变更** |

- **位移全程免疫（D-72）优先于上述一切**：受击方本 tick 处于 `fullDodgeDuring` 时，命中类词条与附加真实伤害**一律不结算**（见 §4.6）。

### 4.6 `fullDodgeDuring` 的真实语义（D-72，已接线）

- **触发**：释放**位移技**且模板 `fullDodgeDuring=true` 时，引擎步骤 6 在提交意图时给施法者置位 `fullDodgeDuring`；**该标志是"每 tick 瞬时状态"**——步骤 6 置位、引擎步骤 1 每 tick 开头重置为 `false`，因此只覆盖**本 tick**。
- 本 tick 内三件事同时成立：
  1. **免疫所有伤害**：弹幕伤害、角色碰撞伤害、附加真实伤害（`dealDamage` 步骤 0 直接返回 `{dmg:0, dodged:true, fullDodgeDuring:true}`）。
  2. **免疫控制**：`stun` / `knockback` / `pull` / `dot` 等**不入效果队列**（`addAffixEffect` 直接返回）。
  3. **不参与弹幕命中判定**：步骤 8 的命中扫描直接跳过该角色——弹幕**径直穿过**，既不命中、也不因它被消耗（D-72③）。
- 与 dodge **运动学**的差别：`dodge` 行动仍可能被平射弹幕的连续方程命中（只叠加闪避率 `dodgeChanceBonus`）；`fullDodgeDuring` 则完全退出判定。
- **注意**：该标志在**步骤 6 置位、步骤 8 命中判定读同一 tick 的值**，所以"位移当 tick"就已生效；下一个 tick 步骤 1 重置，不再免疫。（14 步冻结顺序见 `07-engine` §4.2；伤害链路见 §4.4。）

### 4.7 释放类词条（`cast_buff`）的效果队列语义

1. 释放时（引擎步骤 6）把 `skill.castEffects` 每条 `addEffect` 入效果队列，`addedTick = 当前 tick`。
2. 效果系统的"新效果下一 tick 起效"规则（D-70）→ **释放当 tick 的持续结算（步骤 2）已经过去**，所以 **下一 tick 才起效**。
3. 持续 `params.duration` tick（缺省取注册表 `fallbackDuration = 2`）；形态为 `continuous / stat=atk / delta=v`，逐 tick 结算并递减，归零移除。
4. 该效果与命中无关——**没打中也会生效**（"释放"即触发）。
5. ✅ **API 链路已接线**（2026-09-16 复核）：`loadout.buildPanel` 的技能投影白名单含 `castEffects`，故经 `/api/v1/battle` 时 `cast_buff` 正常入队（见 §4.5 注）。

## 5. 边界与异常

- 所有坐标经 `clampX` 到 `[32, 992]`；格区间越界部分丢弃。
- `bulletLevel` 下限 1；`cooldown` 下限 0；`弹幕数量/射程/位移距离` 下限 1。
- **生成位置按机制表 `emit.bullet.origin`**：`straight` = 施法者当前 px（`caster`），其余三类型 = 所在格中心 px（`cellCenter`）。
- 资源不足 / 冷却中 → 释放失败，不扣资源、不产生效果（引擎视为空行动）。
- **不可穿透来源**：普通 `move`、`dodge` 之外的控制类位移均不可穿过敌人（D-15）。
- **表外取值**（运行期 `warn` + 退化，不静默错误）：
  - 未登记技能类型 → `instantiateSkill` 抛 `RangeError`；
  - 未登记 `emit.pattern` → `skill.emit.unknown`，该次释放无弹幕；
  - 未登记 `skillOp.op` / 词条 id → `skill.plugin.unknown`，该词条跳过；
  - 未登记 `hitEffect.kind` → 引擎 `damage.affix.unknown`，该效果跳过。

## 6. 对外接口

- `instantiateSkill` / `applySkillPlugins`：装配与初始化（纯函数，入参不变）。
- `canCast` / `buildSkillAction` / `coveredCellRanges`：引擎每 tick 调用。
- 模块内不导出"类型分支函数"——类型行为完全由 `skill-mechanics.json` + `EMITTERS` 发射器表解释。

## 7. 本模块消费的词条（技能链总览）

| 词条 id | 注册表声明 | 消费点 | 落点字段 |
|---|---|---|---|
| `mult_up` | `skillOp.scalePct(multiplier)` | `applySkillPlugins` | `skill.multiplier` |
| `cost_down` | `skillOp.scaleCostCeil(complement)` | 同上（仅减耗类） | `skill.cost[各维]` = `ceil(cost×(1−v))`；**`v` 随档位滚动，故不是恒定的 −20%** |
| `cooldown_down` | `skillOp.sub(cooldown)` | 同上 | `skill.cooldown` |
| `range_plus` / `distance_plus` | `skillOp.addSlot(range)` | 同上（按类型槽位映射） | `range` / `distance` |
| `bullet_plus` | `skillOp.add(bulletCount)` | 同上（无字段则不生效） | `skill.bulletCount` |
| `level_up` | `skillOp.sub(bulletLevel)` | 同上 | `skill.bulletLevel` |
| `crit_chance` | `skillOp.addSpecial(critChance)` | `applySkillPlugins` → 弹幕 payload → `dealDamage` | `skill.specials.critChance` |
| `lifesteal` | `skillOp.addSpecial(lifesteal)` | 同上 | `skill.specials.lifesteal` |
| `stun` / `knockback` / `pull` / `dot` / `true_dmg` | `hitEffect.*` | 引擎步骤 9 `addAffixEffect` | `skill.affixes[]` |
| `cast_buff` | `castEffect.continuous(atk)` | 引擎步骤 6 入队 → 下一 tick 起效 | `skill.castEffects[]` |

## 8. 测试要点（对应 `docs/tasks.md` §3.2）

| 编号 | 要点 |
|---|---|
| T-SK-1 | 四类型覆盖范围正确（近战格区间 / 平射单格起点 + 射程 px / 垂直落点区间 / 位移距离 px） |
| T-SK-2 | 插件叠加后倍率/消耗/冷却/弹幕等级/射程正确（含下限 clamp） |
| T-SK-3 | 越界 `clampX` 与格区间丢弃 |
| T-SK-4 | 资源不足 / 冷却中不释放、不扣资源、不产生效果 |

> **机制接线回归用例**（`tests/unit/mechanics.test.js`，2026-09-16 补齐 11 用例，全绿）：D-72 三态（免疫伤害 / 不参与判定 / 免疫控制 / 免疫附加真实伤害）、`crit_chance`·`lifesteal` 进 `specials` 并在"实例直通引擎"链路上真触发、`cast_buff` 下一 tick 起效、`hp_regen` 逐 tick 回复且不复活。
> ⚠️ **上述接线目前只在"技能实例直通引擎"的链路上成立**（`skills.applySkillPlugins` → `buildSkillAction` → 弹幕 payload）。经 `POST /api/v1/battle`（`server/battle.js buildPlayer` → `loadout.buildPanel` 白名单聚合）进入战斗时，`specials` / `castEffects` 未被投影到技能实例（聚合白名单只含 `multiplier/cost/cooldown/bulletLevel/bulletCount/range/area/distance/passThroughEnemy/dealDamage/fullDodgeDuring/falloff`）——**这属于实现待接线项**，详见本轮汇报（不在本文档定义新语义）。
