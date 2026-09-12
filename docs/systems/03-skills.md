# 技能系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。

## 1. 职责

- 技能模板实例化（品质随机数值）。
- 四种类型（近战 / 平射 / 垂直 / 位移）的行为解析与弹幕生成。
- 装配技能插件，计算最终参数、消耗与冷却。
- 释放判定（资源 / 冷却）。

## 2. 依赖

- `items.js`（词条应用）、`skill-templates.json`、`plugins.json`。
- `field.js`（px 坐标、格区间、clamp）。
- `battle-config.json`（速度/格宽）。

## 3. 数据结构

- 技能实例：`sid` / `templateId` / `name` / `type` / `multiplier` / `cost{hp,mp,sp}` / `cooldown` / `bulletLevel` / 类型参数 / `falloff` / `slots[]` / `affixes[]`。

| 类型 | 类型参数 |
|---|---|
| `melee` | `range: [lo, hi]`（相对朝向的格区间） |
| `straight` | `range`（最远格数）、`bulletCount`、**无 `bulletSpeed`**（D-21） |
| `vertical` | `range`（落点格数）、`area: [lo, hi]`（相对落点的格区间） |
| `displacement` | `distance`、`passThroughEnemy`、`dealDamage`、`fullDodgeDuring` |

- **`falloff`（新增，D-29）**：AOE 每向外一格减伤百分比，`0` = 不衰减；模板固有字段，**不随品质随机**。

## 4. 核心流程（代码逻辑）

### 4.1 实例化 `instantiateSkill(template, quality, rng)`

1. 拷贝模板固有字段（`type`、`bulletLevel`、`cost` 结构、`falloff`、`slotWeights`、`passThroughEnemy` 等）。
2. 对**可随机数值参数**（倍率、范围/射程、弹幕数量、位移距离、冷却）应用品质系数并取整（四舍五入；`弹幕数量/射程/位移距离` 下限 1；`冷却` 下限 0；`弹幕等级` 下限 1，D-115）。
3. **不再有 `bulletSpeed`**（已从模板与数据表删除，D-21）。

### 4.2 装配技能插件 `applySkillPlugins(skill, plugins)`

1. **倍率提升**：倍率按相对百分比增加。
2. **消耗优化（减耗）**：`cost` 各维按比例下调；此类插件 `costDeltaByTier === null`。
3. **冷却缩减**：`cooldown` 减数值，下限 0。
4. **射程/范围/弹幕数/位移距离增强**：对应参数增加；**提高弹幕等级** → `bulletLevel` 减 1（下限 1）。
5. **特殊效果**（眩晕/击退/拉近/持续伤害/真实伤害/暴击/吸血/释放增益）：记录到 `affixes`，供命中结算读取。
6. **消耗补偿**：除减耗类外，每个插件把 `costDeltaByTier[档位]` 叠加到 `cost`（D-113，逐档数组）。

### 4.3 释放判定 `canCast(skill, caster)`

1. 冷却：`caster.cooldowns[sid] > 0` → 不可释放（冷却在引擎每 tick 步骤 1 递减，D-82）。
2. 资源：`hp/mp/sp` 任一低于 `cost` → 不可释放。
3. 通过 → 扣资源、写入冷却、返回成功；失败 → 引擎视为**空行动**（`wait`），不扣资源、不产生效果。

### 4.4 生成释放指令 `buildSkillAction(skill, caster)`

1. **近战 `melee`**
   - 按 `range` 相对**朝向**算出覆盖格集合（`field.cellRange`），越界格丢弃；
   - **每格生成一枚 0 速弹幕**（D-22/D-26），各格独立参与等级判定与抵消；
   - 同一目标**最多结算一次**（D-25）；伤害按 `falloff`（以角色所在格为中心）衰减。

2. **平射 `straight`**
   - 生成 `bulletCount` 枚；**生成位置 = 释放者所在格的中心**（不再取邻格，D-22），方向 = 朝向；
   - 每枚当 tick 飞完 `range × cellPx`（D-07/D-20），与目标轨迹解连续方程判定命中；
   - **可多次命中同一目标**（多发各算一次，D-25）。

3. **垂直 `vertical`**
   - 落点 = `clampX(caster.x + 朝向 × range × cellPx)`；
   - 以落点为基准按 `area` 算出覆盖格集合，**每格一枚 0 速弹幕**；
   - 判定用**角色本 tick 位移后的位置**（D-24）；每目标最多一次；按 `falloff` 向外衰减。

4. **位移 `displacement`**
   - 目标位置 = `clampX(caster.x + 朝向 × distance × cellPx)`，本 tick 位移量为 `distance × cellPx`（D-07）；
   - `passThroughEnemy=true` → 可穿过敌人（走 M1 的"穿过"分支）；`false` → 走"碰撞"分支（停在相遇点一侧，按 M1 结算碰撞伤害）；
   - **伤害模型（D-18 统一版 + D-118）**：
     - `dealDamage=true` → **沿技能的声明移动路径**（`caster.x → clampX(caster.x + 朝向 × distance × cellPx)`）**每格放置一枚 0 速弹幕**，等级取模板 **`bulletLevel`**（D-118）、倍率取技能倍率——**与近战/垂直 AOE 完全同构，无任何特判**；路径**与是否被碰撞截停无关**；
     - **弹幕伤害与碰撞伤害分别结算**：若同时发生碰撞，则**同一 tick 可能受两次伤害**（路径弹幕的技能伤害 **+** M1 的碰撞伤害，双方各 `atk×0.8`）；
     - `dealDamage=false` → **不放置路径弹幕**：穿过无伤害，只有**碰撞**才结算碰撞伤害；
     - **副产品**：原「恰好停在相邻不算接触」（D-19）**由本模型自然满足**（相邻格不在声明路径内）；
   - `fullDodgeDuring=true` → **位移期间的完整语义（D-72）**：① 免疫所有伤害；② **免疫控制效果**；③ **视为"无法命中"，完全不参与弹幕判定**（弹幕直接穿过，既不命中也不被消耗）；
   - **撞基地**：停在原地 + 按 `atk × 0.8` 对基地造成伤害（见 `06-field` §4.3）。

### 4.5 命中结算

- 伤害链路由引擎统一处理（见 `07-engine` §4.4）：闪避 → 基础（含 `def×1.6` 防御）→ 背击 ×1.5 → 暴击 ×1.5 → 一次取整 → 吸血 → 附加效果。
- **背击**（`07-engine` §4.5）：近战/位移用**本 tick 位移后**的相对位置与朝向；平射用弹幕飞行方向；垂直永不触发。

## 5. 边界与异常

- 所有坐标经 `clampX` 到 `[32, 992]`；格区间越界部分丢弃。
- `bulletLevel` 下限 1；`cooldown` 下限 0；`弹幕数量/射程/位移距离` 下限 1。
- 资源不足 / 冷却中 → 释放失败，不扣资源、不产生效果（引擎视为空行动）。
- **不可穿透来源**：普通 `move`、`dodge` 之外的控制类位移均不可穿过敌人（D-15）。

## 6. 对外接口

- `instantiateSkill` / `applySkillPlugins`：装配与初始化。
- `canCast` / `buildSkillAction` / `coveredCellRanges`：引擎每 tick 调用。

## 7. 测试要点（对应 `docs/tasks.md` §3.2）

| 编号 | 要点 |
|---|---|
| T-SK-1 | 四类型覆盖范围正确（近战格区间 / 平射单格起点 + 射程 px / 垂直落点区间 / 位移距离 px） |
| T-SK-2 | 插件叠加后倍率/消耗/冷却/弹幕等级/射程正确（含下限 clamp） |
| T-SK-3 | 越界 `clampX` 与格区间丢弃 |
| T-SK-4 | 资源不足 / 冷却中不释放、不扣资源、不产生效果 |
