# 物品系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。

## 1. 职责

- 物品的随机生成（品质、插槽数、数值属性、词条）。
- 开箱：按品质概率 + 物品类别概率抽取物品。
- 词条应用：把插件的词条叠加到角色/技能上，得到最终面板。
- 段位门控：判断物品是否满足玩家的解锁段位。
- 仓库：按分类存储玩家物品，记录装配状态。
- 组装/拆卸：插件的装配与卸下，记录玩家对物品的行为。
- 出战配置：组装角色模板及插件 + 三个技能模板及插件 + AI，本地存储可读写。

## 2. 依赖

- **机制层（机制词汇，不是内容）**：
  - `affix-registry.json`：词条注册表——每个词条声明 `domain`（role / skill / both）、`roll`（int / stat）、`agg`（面板聚合）、`special`（概率）、`regen`（逐 tick 回复维度）、`skillOp`（技能实例改写算子）、`hitEffect`（命中结算）、`castEffect`（释放结算），以及 `stats`（五维口径）与 `caps.probability`。
  - `skill-mechanics.json`：技能类型机制（参数滚动模式 / 语义槽位 / 弹幕发射模式 / `costDims` / `precision` / `bounds`）——本模块的 `generateSkillItem` 与 `rollSlotCount` 读取它。
  - `ai-nodes.json`：AI 真实节点类型清单（不属物品链）。
- **内容层（示例数据，待用户设计）**：
  - `qualities.json`：品质表（系数区间、插槽数区间）。
  - `role-templates.json` / `skill-templates.json`：模板定义。
  - `plugins.json`：插件定义（每个词条只写 `id` 与**基础值 v**）。
  - `items-config.json`：开箱概率、类别权重。
  - `unlock.json`：段位解锁表。
- `rng.js`：种子随机。
- ⚠️ **内容层表当前均为示例数据**，正式数值由用户设计后冻结（见 `server/data/README.md`）。

> **实现位置**：`server/core/items.js`（数值层 L2）+ 仓库/装配（L3，同文件双分层）；角色/技能层分别见 `02-roles` / `03-skills`。

## 2A. 数据驱动的词条解释器（2026-09-16 改造）

- 代码内**不按词条 id 写分支**：`applyAffixes` / `applySkillPlugins` / `equipPlugins` / 引擎 `addAffixEffect` 都只读 `affix-registry.json` 的声明来决定"这个 v 值往哪去"。
- **一个词条的去向由注册表字段唯一决定**：

| 注册表字段 | 去向 | 消费方 |
|---|---|---|
| （无，仅内容） | 该词条只有名称/描述 | — |
| `agg{target,mode}` | 五维面板：`pct` → `base×(1+Σv)`；`flat` → 参与 `base×(1+Σpct)+Σv` | `items.applyAffixes` → `roles.getFinalStats` |
| `special` | 概率标志（`dodgeChance` / `critChance` / `lifesteal`），累加后按 `caps.probability=1` 封顶 | `items.applyAffixes`（角色）/ `skills.applySkillPlugins` + 引擎（技能） |
| `regen` | 逐 tick 回复维度（`sp` / `mp` / `hp`） | `roles.equipPlugins` 叠加 → 引擎步骤 10 |
| `skillOp{op,field,…}` | 技能实例字段改写（6 种算子） | `skills.applySkillPlugins` |
| `hitEffect{kind,…}` | 命中时入效果队列 / 附加伤害 | 引擎步骤 9 `addAffixEffect` |
| `castEffect{kind,…}` | 释放时入效果队列 | 引擎步骤 6 |
| `roll` | 词条数值滚动方式：`int` = ×档位系数后取整；`stat` = ×档位系数后保留 `precision.stat` 位 | `items.generatePlugin` |

- **新增一个词条 = 只改注册表**（`affixes` 加一条）；**新增一个数值变体 = 只改 `plugins.json`**（D-114 一个变体一个 id）。未登记的词条 id 在运行期记 `warn`（`items.affix.unknown` / `skill.plugin.unknown`）并跳过，不静默失效。

## 3. 数据结构

- 品质：`id`、`name`、`color`、`statRange[lo,hi]`、`roleSlotRange`、`skillSlotRange`、`pluginPoints`、`tiers`、`costDeltaBase`（各品质消耗补偿基准，`common=2…mythic=6`）。
- 物品实例：`uid`、`kind`（role / skill / rolePlugin / skillPlugin）、`templateId`、`quality`、`name`、`desc`、`category`（插件）、`slotCount`、`slots[]`（模板）、`stats{}`（模板）、`affixes[]`（插件）、`unlockTier`。
- 词条（**已生成实例**）：`id`、`desc`、`params`（含滚动后的 `v`）。
- 词条（**注册表定义**）：`domain`、`roll`、`agg`、`special`、`regen`、`skillOp`、`hitEffect`、`castEffect`（见 §2A 表）。
- 插槽：`type`（角色：atk/def/hp/sp/mp/special；技能：basic/special）、`pluginUid`（装配的插件，可空）。
- 角色模板：`pluginPoints`（最大插件点数）。
- 插件：`id`（**一个变体一个 id**，如 `rp_atk_pct` / `rp_atk_flat`，D-114）、`tier`（档位 1/2/3）、`pointCost`（角色插件点数消耗 = 档位）、`costDeltaByTier`（技能插件**逐档数组**，如 `{mp:[2,4,6]}`；减耗类为 `null`，D-113）。
- 仓库：按 `kind` 分桶的映射，每桶存物品实例列表；物品带 `equipped` 标记（是否已装配）。
- 出战配置 `loadout`：`role`（角色模板及插槽）、`skills[3]`（三个技能模板及插槽）、`ai`（AI 程序）。

### 3A. 词条注册表（`affix-registry.json`）字段与现役词条

注册表顶层：`stats`（五维口径，`["hp","atk","def","sp","mp"]`）、`caps{probability:1}`、`affixes{}`。每个词条的字段取值（词汇表）：

- `domain`：`role`（角色插件词条）/ `skill`（技能插件词条）/ `both`；
- `roll`：`int`（×档位系数后取整）| `stat`（×档位系数后保留 `precision.stat` 位）；
- `agg{target, mode}`：面板聚合（`mode` = `pct` | `flat`），`target` ∈ 五维；
- `special`：概率标志名（`dodgeChance` / `critChance` / `lifesteal`）；
- `regen`：逐 tick 回复维度（`sp` / `mp` / `hp`）；
- `skillOp{op, …}`：算子 ∈ `scalePct` / `sub` / `add` / `addSlot` / `scaleCostCeil` / `addSpecial`；
- `hitEffect{kind, …}`：命中效果，`kind` ∈ `control` / `continuous` / `flatTrueDamage`；
- `castEffect{kind, …}`：释放效果，`kind` ∈ `continuous`。

**现役词条一览（本仓库）**：

| 域 | 词条 id | 滚动 | 去向 |
|---|---|---|---|
| role | `atk_pct` / `def_pct` / `hp_pct` | stat | `agg.pct` → atk / def / hp |
| role | `atk_flat` / `def_flat` / `hp_flat` | int | `agg.flat` → atk / def / hp |
| role | `sp_cap` / `mp_cap` | stat | `agg.pct` → sp / mp（上限） |
| role | `sp_regen` / `mp_regen` / `hp_regen` | int | `regen` → sp / mp / hp |
| role | `dodge_chance` | stat | `special.dodgeChance` |
| both | `crit_chance` | stat | `special.critChance` + `skillOp.addSpecial` |
| both | `lifesteal` | stat | `special.lifesteal` + `skillOp.addSpecial` |
| skill | `mult_up` / `cooldown_down` / `range_plus` / `bullet_plus` / `level_up` / `distance_plus` / `cost_down` | stat / int | `skillOp`（见 `03-skills` §4.2） |
| skill | `stun` / `knockback` / `pull` / `dot` / `true_dmg` | int | `hitEffect`（引擎步骤 9） |
| skill | `cast_buff` | int | `castEffect`（引擎步骤 6 入队，下一 tick 起效） |

> `true_dmg` 的真实语义是**命中附加 `v` 点真实伤害（直扣 `hp`）**，不是"把本次伤害改为真实伤害"（见 `items-data.md` §6 备注）。

## 4. 核心流程（代码逻辑）

### 4.1 品质抽取 `rollQuality(rng)`

1. 读取 `dropRates`，按各品质概率做加权随机。
2. 返回命中的品质对象。

### 4.2 插槽数抽取 `rollSlotCount(kind, quality, rng)`

1. 角色模板取 `roleSlotRange`，技能模板取 `skillSlotRange`。
2. 在闭区间内均匀随机取整，返回。

### 4.3 生成角色物品 `generateRoleItem(template, quality, rng)`

1. 对模板的每个五维属性（hp/atk/def/sp/mp）：
   - 数值 = 基础值 ×（品质 `statRange` 内均匀随机系数）。
   - 四舍五入取整，下限 1。
2. 生成插槽列表：数量 = `rollSlotCount`；每个插槽类型按模板 `slotWeights` 加权随机分配；初始 `pluginUid` 为空。
3. 写入 `quality`、`unlockTier`、`pluginPoints`（取模板/品质定义），返回物品实例。
4. 角色物品携带 `regen{mp,sp}`（模板必填字段直入，D-110）；`hp` 维度由 `hp_regen` 词条在装配时叠加（§4.9）。

### 4.4 生成技能物品 `generateSkillItem(template, quality, rng)`

1. 先按 `skill-mechanics.json` 的 `bounds` / `costDims` / `precision` 生成公共数值：`multiplier`（×品质系数，保留 `precision.stat=2` 位）、`cost`（各维 = 模板 `baseCost`，**不随品质缩放**）、`cooldown`（×品质系数取整，下限 `minCooldown=0`）、`bulletLevel`（模板固有，原样拷贝）。
2. 再按**类型机制表 `types[type].params`** 逐字段滚动（`pair` 原样拷贝 / `intMin` ×系数取整且下限 `bounds.min<字段>` / `copy` 原样拷贝）——四种类型支持的参数不同，代码不写类型分支；未登记类型抛 `RangeError`。
3. 弹幕等级、技能类型、消耗结构等模板固有字段不随品质随机；`falloff` 亦为模板固有字段。
4. 生成插槽列表（数量由品质 `skillSlotRange` 决定、下限 1，D-111；类型按模板 `slotWeights` 加权分配）。

### 4.5 生成插件 `generatePlugin(kind, quality, rng, poolOverride)`

1. 从 `plugins.json` 中筛出 `kind` 匹配的插件定义池（`poolOverride` 用于 `openBox` 的段位门控池）。
2. 随机抽取一个插件定义，并掷一次品质区间系数 `coeff = U(statRange)`。
3. 掷档位：按品质 `tiers` 三段判断 `coeff` 落在 1/2/3 档（`tierOfValue`）。
4. **词条数值滚动方式取自注册表 `roll`**：`int` → `round(基础值 × coeff)`（I-6b）；`stat` → `round2(基础值 × coeff)`（保留 `precision.stat` 位，I-6a）；写入 `params.v` 并记录 `tier`。未登记词条 id → `warn`（`items.affix.unknown`）并跳过。
5. 角色插件：`pointCost = tier`；技能插件：`costDeltaByTier` 直通（`null` 表示减耗类）。**实际消耗增量在装配时结算**：`delta = costDeltaBase[插件品质] × tier`，只加在**声明了数组的维度**上（D-113；见 `03-skills` §4.2.5）。
6. 写入 `category`、`name`、`desc`、`unlockTier`。

### 4.6 开箱 `openBox(rng, options)`

1. `rollQuality` 得到品质（`options.tier` 存在时按段位序号截断品质池并按剩余池重归一，D-122/B17）。
2. 按 `kindWeights` 加权随机选类别（role / skill / rolePlugin / skillPlugin）。
3. 依类别先用 `validateUnlock` 过滤出该段位可用池（空池抛错），再调用对应的生成函数。

### 4.7 词条应用 `applyAffixes(baseStats, affixes)`

> **实现方式**：遍历词条时**不按 id 分支**——每条先查注册表，再按 `agg` / `special` / `regen` / 技能链字段分派。返回 `{stats, special}`。

1. 归类累加：
   - `agg.mode='pct'` → `pct[target] += v`；`agg.mode='flat'` → `flat[target] += v`；
   - 有 `special` 字段 → `special[名] = min(caps.probability, 现值 + v)`（**概率类累加后封顶 1**）；
   - 有 `regen` 字段 → **本函数不处理**，由 `roles.equipPlugins` 叠加（见 §4.13）；
   - 有 `skillOp` / `hitEffect` / `castEffect` → **本函数不处理**，由 `03-skills` / 引擎消费。
2. 对五维逐项一次性结算：`result = round(base × (1 + Σpct) + Σflat)`，**下限 1**（I-8f）。
3. 返回最终面板数值 + `special` 概率集合。

### 4.8 门控 `validateUnlock(item, tier)`

1. 读取 `item.unlockTier`；未定义/为 `null` 则视为已解锁。
2. `item.unlockTier` 的段位序号 > `tier` 的段位序号 → 不可用（拒绝装配/不产出）；未知段位名 → 拒绝（保守）。

### 4.9 角色 `regen` 的叠加（词条 `regen` 字段声明）

1. 角色模板必填 `regen{mp,sp}`（D-110）；角色物品实例携带该值（`items.generateRoleItem`）。
2. `roles.equipPlugins(role, plugins)` 在装配登记阶段按注册表 `def.regen` 把词条的 `v` **叠加到对应维度**（`sp_regen`→`regen.sp`、`mp_regen`→`regen.mp`、`hp_regen`→`regen.hp`）——**目标维度由注册表声明，代码不按 id 分支**。
3. 引擎步骤 10 逐 tick 结算：`hp/mp/sp` 各自 `min(max, 当前 + regen[维度])`；**`regen.hp` 仅在 `hp > 0` 时回复**（不在阵亡后复活，死亡时序统一在步骤 12）。
4. ⚠️ **接线范围**：`regen.hp` 的逐 tick 回复在引擎中已生效（`tests/unit/mechanics.test.js` 覆盖）；但 `roles.equipPlugins` 目前**只被 `core/roles.js` 自身与单测调用**，现行 `/api/v1/panel` 与 `/api/v1/battle` 走 `loadout.buildPanel`（直接读角色物品的 `regen{mp,sp}` 并做 `Object.assign({mp:0,sp:0}, role.regen)`），**不经过 `equipPlugins` 的 regen 叠加**——即经 API 的战斗中 `hp_regen` 词条不会进入 `regen.hp`。属**实现待接线项**（见本轮汇报），本文档不为其定义新语义。

### 4.10 仓库与出战配置（L3；D-123 不持久化）

- 服务端**不持有仓库状态**：客户端 `loadout` / `warehouse` 为权威，每个请求由客户端带上，服务端**校验后回带**（D-123；`server/index.js` 无仓库持久化端点）。
- 仓库为 `{buckets:{role[],skill[],rolePlugin[],skillPlugin[]}}` 骨架；`items.js` 导出 `emptyWarehouse` / `assemble` / `disassemble`（`getWarehouse` / `saveWarehouse` **不存在**——存取由客户端本地负责，服务端只做装配/拆卸的纯函数计算）。
- 装配 `assemble(warehouse, {targetUid, pluginUid, slotIndex, tier})`：纯函数，成功返回 `{ok:true, warehouse}`（新仓库，入参不变）；失败返回 `{ok:false, code, message}` 且状态完全不变。校验顺序见 `docs/interfaces.md`（目标/插件存在 → 目标必须是角色或技能 → 类别匹配 → 插槽存在且类型匹配 → 段位门控 → 角色点数预算 → 空槽 → 插件唯一性）。
- 拆卸 `disassemble(warehouse, {targetUid, slotIndex})`：清空槽位引用并把插件 `equipped` 置回 `false`；空槽/悬挂引用分别拒绝。
- 出战配置 `loadout`：`{role, skills[3], ai}`；服务端接口为 `POST /api/v1/loadout`（校验）、`POST /api/v1/panel`（面板聚合）、`POST /api/v1/battle`（对战）。`loadout.buildPanel` 为"物品实例 → 面板"的现行聚合入口。

## 5. 边界与异常

- 品质区间重叠时按均匀随机取值，不做排他处理。
- 所有随机值取整规则统一为四舍五入（`int` 词条取整、`stat` 词条保留 `precision.stat` 位），属性下限 1。
- 插槽数下限 1（即使品质区间理论上可为 0 也不允许）。
- 词条叠加后的概率封顶 `caps.probability = 1`；百分比可为负（减益插件）。
- 未登记的词条 id / 算子名 / 发射模式：运行期 `warn` + 跳过（不静默失效）。

## 6. 对外接口

- `getQuality` / `rollQuality` / `rollSlotCount` / `tierOf`：品质与档位原语。
- `generateRoleItem` / `generateSkillItem` / `generatePlugin` / `openBox`：供开箱与初始配置生成。
- `applyAffixes`：面板词条聚合（返回 `{stats, special}`）；`validateUnlock`：段位门控。
- `emptyWarehouse` / `assemble` / `disassemble`：仓库装配（纯函数）。
- **聚合入口**：现行服务端面板为 `loadout.buildPanel`（调 `items.applyAffixes` + `skills.applySkillPlugins`）；`roles.getFinalStats` 为角色层等价聚合（含 `regen` 叠加），目前仅单测调用。

## 7. 测试要点

- 品质分布接近 `dropRates`（大样本）。
- 插槽数落在对应 `roleSlotRange` / `skillSlotRange` 内。
- 属性值落在「基础值 × 系数区间」内。
- 百分比与数值词条叠加结果正确（`base×(1+Σpct)+Σflat`，一次取整、下限 1）。
- 概率词条封顶 `caps.probability`。
- 门控：高段位物品在低段位被拒绝。
- 组装/拆卸：装配后插槽状态正确，拆卸后物品回到未装配。
- 出战配置：含 1 角色 + 3 技能 + AI；服务端校验后回带（D-123 不持久化）。
- 档位：同品质三档分布正确，档位与词条数值、点数/消耗成正比。
- 点数：超限装配被拒绝。
- regen：`sp_regen` / `mp_regen` / `hp_regen` 按注册表维度叠加。
