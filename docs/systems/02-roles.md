# 角色系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。

## 1. 职责

- 从角色模板 + 品质实例化出战角色。
- 计算类型修饰（均衡/特化/专家）与品质系数后的最终五维。
- 装配角色插件，计算五维加成与特殊词条（闪避/吸血/暴击）。

## 2. 依赖

- `items.js`（词条应用）。
- `role-templates.json`。

## 3. 数据结构

- 模板：`id`、`name`（专有名称）、`type`（balanced / specialized / expert）、`highStat`（特化/专家的最高属性，命名依据）、`baseStats{hp,atk,def,sp,mp}`、`slotWeights`。
- 角色实例：`charId`、`templateId`、`name`、`type`、`quality`、`stats{hp,atk,def,sp,mp}`、`regen{mp,sp}`、`slots[]`（含已装配插件）、`pluginPoints`（最大点数）、`special{}`（闪避/吸血/暴击汇总）。

## 4. 核心流程（代码逻辑）

### 4.1 实例化 `instantiateRole(template, quality, rng)`

1. 取模板 `baseStats` 为基础。
2. 按 `type` 套类型修饰（见 4.2）。
3. 每个属性乘以品质系数（品质 `statRange` 内均匀随机），取整。
4. 计算 `maxHp`（等于最终 hp 值），`regen` 取模板默认。

### 4.2 类型修饰 `applyTypeModifier(stats, highStat, type, rng)`

1. `balanced`：五维不动。
2. `specialized`：最高属性由模板 `highStat` 固定（+15%）；其余 4 属性随机取 1 个「低」（-15%）、3 个标准。
3. `expert`：最高属性由模板 `highStat` 固定（+30%）；其余 4 属性随机分配「略高 +10%」「极低 -30%」「略低 -10%」「标准 0%」。

- 修饰作用于基础值，在品质系数之前。

### 4.3 装配插件 `equipPlugins(role, plugins)`

1. 对每个待装配插件：
   - 校验 `kind === rolePlugin` 且插槽类型匹配（atk/def/hp/sp/mp/special，见主文档 §5.2）。
   - 校验点数：已装插件点数之和 + 该插件 `pointCost` ≤ `role.pluginPoints`。
   - 五维插件：调用 `applyAffixes` 叠加到对应属性。
   - 特殊插件：把词条汇总到 `role.special`（概率累加封顶）。
2. 不匹配/超点数 → 拒绝装配，返回失败原因。

### 4.4 最终面板 `getFinalStats(role)`

1. 返回最终五维 + `regen` + `special` 汇总。

### 4.5 运行时状态

- 战斗中的动态字段（x、facing、当前 hp/mp/sp、effects、cooldowns）由战斗引擎维护，不属于角色系统。

## 5. 边界与异常

- 修饰后的属性下限 1。
- 概率词条封顶 1。
- 插槽类型不匹配 → 装配失败，不影响已装配项。

## 6. 对外接口

- `instantiateRole`：引擎初始化双方角色。
- `equipPlugins` / `getFinalStats`：装配 UI 与战斗面板。

## 7. 测试要点

- 特化型：恰 1 高 1 低，其余标准。
- 专家型：五个修饰各 1 个，覆盖全部属性。
- 品质系数与类型修饰叠加顺序正确。
- 非法插槽类型装配被拒绝。
- 概率词条累加封顶。
- 插件点数超限被拒绝。
