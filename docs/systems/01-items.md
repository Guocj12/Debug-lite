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

- `qualities.json`：品质表（系数区间、插槽数区间）。
- `role-templates.json` / `skill-templates.json`：模板定义。
- `plugins.json`：插件与词条定义。
- `items-config.json`：开箱概率、类别权重。
- `rng.js`：种子随机。

## 3. 数据结构

- 品质：`id`、`name`、`color`、`statRange[lo,hi]`、`roleSlotRange`、`skillSlotRange`、`pluginPoints`、`tiers`。
- 物品实例：`uid`、`kind`（role / skill / rolePlugin / skillPlugin）、`templateId`、`quality`、`name`、`desc`、`category`（插件）、`slotCount`、`slots[]`（模板）、`stats{}`（模板）、`affixes[]`（插件）、`unlockTier`。
- 词条：`id`、`desc`、`params`（数值）。
- 插槽：`type`（角色：atk/def/hp/sp/mp/special；技能：basic/special）、`pluginUid`（装配的插件，可空）。
- 角色模板：`pluginPoints`（最大插件点数）。
- 插件：`id`（**一个变体一个 id**，如 `rp_atk_pct` / `rp_atk_flat`，D-114）、`tier`（档位 1/2/3）、`pointCost`（角色插件点数消耗 = 档位）、`costDeltaByTier`（技能插件**逐档数组**，如 `{mp:[2,4,6]}`；减耗类为 `null`，D-113）。
- 仓库：按 `kind` 分桶的映射，每桶存物品实例列表；物品带 `equipped` 标记（是否已装配）。
- 出战配置 `loadout`：`role`（角色模板及插槽）、`skills[3]`（三个技能模板及插槽）、`ai`（AI 程序）。

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

### 4.4 生成技能物品 `generateSkillItem(template, quality, rng)`

1. 对技能的可随机数值参数（倍率、范围/射程、弹幕数量、弹幕速度、位移距离、冷却等）逐一应用品质系数并取整。
2. 弹幕等级、技能类型、消耗结构等模板固有字段不随品质随机。
3. 生成插槽列表（数量由品质决定，类型按模板 `slotWeights` 分配）。

### 4.5 生成插件 `generatePlugin(kind, quality, rng)`

1. 从 `plugins.json` 中筛出 `kind` 匹配的插件定义池。
2. 随机抽取一个插件定义。
3. 掷档位：按品质 `statRange` 三等分（或品质 `tiers` 表）确定本插件落在一/二/三档中的哪一档。
4. 按档位在对应子区间内随机缩放词条数值，写入 `params`；记录 `tier`。
5. 角色插件：`pointCost = tier`；技能插件：`cost = cost + costDeltaByTier[tier]`（**逐档数组**，各品质基础值递增：绿 `[2,4,6]`，D-113）；减耗类 `costDeltaByTier = null`。
6. 写入 `category`、`name`、`desc`、`unlockTier`。

### 4.6 开箱 `openBox(rng)`

1. `rollQuality` 得到品质。
2. 按 `kindWeights` 加权随机选类别（role / skill / rolePlugin / skillPlugin）。
3. 依类别调用对应的生成函数，返回物品。

### 4.7 词条应用 `applyAffixes(base, affixes)`

1. 遍历词条，按词条 `id` 的结算语义应用到目标：
   - 百分比类（如 `atk_pct`）：累加百分比后与基础值相乘。
   - 数值类（如 `hp_flat`）：直接累加。
   - 概率类（暴击、闪避）：累加后封顶（≤1）。
   - 特殊类（吸血、真实伤害、击退等）：记录为标志/参数，供战斗结算读取。
2. 返回最终面板对象。

### 4.8 门控 `validateUnlock(item, tier)`

1. 读取 `item.unlockTier`；未定义则视为已解锁。
2. `item.unlockTier` 的段位序号 > `tier` 的段位序号 → 不可用（拒绝装配/不产出）。

### 4.9 仓库存储 `getWarehouse()` / `saveWarehouse()`

1. 仓库按 `kind` 分桶（角色模板/技能模板/角色插件/技能插件）。
2. 物品入桶时写入 `uid`、`equipped=false`。
3. 序列化为 JSON 存于本地；读入时反序列化并重建索引。

### 4.10 组装 `assemble(template, slotIndex, plugin)`

1. 校验插件 `kind` 与目标插槽 `type` 匹配（角色插件→角色模板五维/特殊槽，技能插件→技能模板基础/特殊槽）。
2. 校验段位门控（`validateUnlock`）。
3. 角色模板额外校验点数：已装插件点数之和 + 新插件 `pointCost` ≤ 模板 `pluginPoints`，否则拒绝。
4. 插槽为空 → 写入 `slot.pluginUid = plugin.uid`，插件 `equipped = true`。
5. 返回成功或失败原因。

### 4.11 拆卸 `disassemble(template, slotIndex)`

1. 读取该插槽的 `pluginUid`，非空则清除。
2. 对应插件 `equipped = false`，回到仓库未装配状态。

### 4.12 组装出战配置 `buildLoadout(roleItem, skillItems[3], ai)`

1. 校验角色模板 1 个、技能模板 3 个、AI 程序均合法。
2. 组装为 `loadout`，与仓库一起本地存储、可读可改。

## 5. 边界与异常

- 品质区间重叠时按均匀随机取值，不做排他处理。
- 所有随机值取整规则统一为四舍五入，属性下限 1。
- 插槽数下限 1（即使品质区间理论上可为 0 也不允许）。
- 词条叠加后的概率封顶 1；百分比可为负（减益插件）。

## 6. 对外接口

- `generateRoleItem` / `generateSkillItem` / `generatePlugin` / `openBox`：供开箱与初始配置生成。
- `applyAffixes`：供角色/技能系统计算最终面板。
- `validateUnlock`：供解锁系统与装配 UI 使用。
- `getWarehouse` / `saveWarehouse` / `assemble` / `disassemble` / `buildLoadout`：供仓库与装配 UI 使用。

## 7. 测试要点

- 品质分布接近 `dropRates`（大样本）。
- 插槽数落在对应 `roleSlotRange` / `skillSlotRange` 内。
- 属性值落在「基础值 × 系数区间」内。
- 百分比与数值词条叠加结果正确。
- 概率词条封顶。
- 门控：高段位物品在低段位被拒绝。
- 组装/拆卸：装配后插槽状态正确，拆卸后物品回到未装配。
- 出战配置：含 1 角色 + 3 技能 + AI，本地序列化/反序列化无损。
- 档位：同品质三档分布正确，档位与词条数值、点数/消耗成正比。
- 点数：超限装配被拒绝。
