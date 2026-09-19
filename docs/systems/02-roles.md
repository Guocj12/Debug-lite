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

- 模板：`id`、`name`（专有名称）、`type`（balanced / specialized / expert）、`highStat`（特化/专家的最高属性，命名依据）、`baseStats{hp,atk,def,sp,mp}`、**`regen{mp,sp}`（必填，每 tick 自动回复量，D-110）**、`slotWeights`、`pluginPoints`（最大插件点数）、可选 `unlockTier`（D-112）。
- 角色实例：`charId`、`templateId`、`name`、`type`、`quality`、`stats{hp,atk,def,sp,mp}`、`regen{mp,sp}`、`slots[]`（含已装配插件）、`pluginPoints`（最大点数）、`special{}`（闪避/吸血/暴击汇总）。

## 4. 核心流程（代码逻辑）

### 4.1 实例化 `instantiateRole(template, quality, rng)`

1. 取模板 `baseStats` 为基础。
2. 按 `type` 套类型修饰（见 4.2）。
3. 每个属性乘以品质系数（品质 `statRange` 内均匀随机），取整。
4. 计算 `maxHp`（等于最终 hp 值）；**`regen{mp,sp}` 取模板的必填字段**（D-110）；插件词条对 regen 的加成**不在本步骤**，由面板聚合（4.4）叠加一次。

### 4.2 类型修饰 `applyTypeModifier(template, rng)`

1. `balanced`：五维不动（不消耗随机）。
2. `specialized`：最高属性由模板 `highStat` 固定（+15%）；其余 4 属性随机取 1 个「低」（-15%）、3 个标准。
3. `expert`：最高属性由模板 `highStat` 固定（+30%）；其余 4 属性随机分配「略高 +10%」「极低 -30%」「略低 -10%」「标准 0%」（Fisher–Yates 洗牌，3 次 int）。
4. 修饰作用于基础值，在品质系数之前；随机消耗顺序冻结为「修饰随机 → 品质系数 → 取整」。
5. **单一实现**：函数体在 `items.applyTypeModifier`（`roles.applyTypeModifier` 即同一引用）；**开箱生成**（`items.generateRoleItem`）与**实例化**（`instantiateRole`）共用它——2026-09-16 修正前开箱物品不套修饰，导致同品质的 11 个角色数值完全相同。

### 4.3 装配插件 `equipPlugins(role, plugins, options)`

1. 对每个待装配插件：
   - 校验 `kind === rolePlugin` 且插槽类型匹配（atk/def/hp/sp/mp/special，见主文档 §5.2）。
   - 校验点数：已装插件点数之和 + 该插件 `pointCost` ≤ `role.pluginPoints`（未声明 `pluginPoints` → 预算 0，正点数插件一律 `points_exceeded`）。
   - 段位门控（`items.validateUnlock`）与唯一性（同一插件不得双装）。
2. **只做「校验 + 登记」**：写入 `slots[].pluginUid` 与 `equipped[]`，**不改 `stats`、也不写 `regen`**（regen 由 4.4 的面板聚合叠加一次——旧实现写回 `regen` 会与 `loadout.buildPanel` 双计）。
3. 不匹配/超点数/超段位 → 拒绝装配，返回 `{ok:false, error}`（`kind_mismatch` / `already_equipped` / `tier_locked` / `slot_type_mismatch` / `points_exceeded` / `role_invalid`），状态原子不变。
4. **形状容错**：角色对象可以是**运行时角色**（`instantiateRole` 产物）或**角色物品**（`items.generateRoleItem` / 仓库产物）。缺 `slots` / `pluginPoints` / `equipped` 时按缺省处理并给明确错误码，**不抛 TypeError**。

### 4.4 最终面板 `getFinalStats(role, plugins?)`

1. 调用 **`items.buildRolePanel`（单一聚合实现）**：返回最终五维 + `regen` + `special` + `maxHp/maxMp/maxSp`（+ `pluginPoints` / `quality`）。
2. 已装插件来源（形状容错）：`role.equipped[]`（运行时角色）或 `slots[].pluginUid` + `role.plugins[]` 索引（角色物品形态）；也可由第二参显式传入插件列表（`loadout.buildPanel` 即按仓库槽位解析后传入）。
3. **与 `loadout.buildPanel` 同源同值**（不再有第二份算法）；多次调用幂等。
4. ⚠️ `loadout` 入口仍是严格契约：`POST /api/v1/panel` 的角色位置必须是 `kind === 'role'` 的角色物品，否则返回明确的 `loadout_invalid`（这是"明确错误"，不是 TypeError）。

### 4.5 运行时状态

- 战斗中的动态字段（x、facing、当前 hp/mp/sp、effects、cooldowns）由战斗引擎维护，不属于角色系统。

## 5. 边界与异常

- 修饰后的属性下限 1。
- 概率词条封顶 1。
- 插槽类型不匹配 → 装配失败，不影响已装配项。
- 角色对象缺字段（`slots` / `pluginPoints` / `equipped` / `stats` / `regen`）时不抛异常：`equipPlugins` 给明确错误码，`getFinalStats` 按缺省聚合（五维下限 1）。

## 6. 对外接口

- `instantiateRole`：引擎初始化双方角色。
- `applyTypeModifier`：类型修饰（= `items.applyTypeModifier`，**单一实现**；开箱 `items.generateRoleItem` 同用）。
- `equipPlugins`：装配校验 + 登记（不改 stats / 不写 regen）。
- `getFinalStats`：面板聚合（= `items.buildRolePanel`，**单一实现**，与 `loadout.buildPanel` 同源）。

## 7. 测试要点

- 特化型：恰 1 高 1 低，其余标准。
- 专家型：五个修饰各 1 个，覆盖全部属性。
- 品质系数与类型修饰叠加顺序正确；**开箱物品与实例化角色在相同 rng 序列下逐值一致**。
- 非法插槽类型装配被拒绝。
- 概率词条累加封顶。
- 插件点数超限被拒绝。
- regen 词条在面板聚合中**只叠一次**（`getFinalStats` 与 `items.buildRolePanel` / `loadout.buildPanel` 逐值对照）。
- 形状容错：角色物品（无 `equipped`）与运行时角色都能被两个入口接受；畸形输入给明确错误而非 TypeError。
