# 技能系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。

## 1. 职责

- 技能模板实例化（品质随机数值）。
- 四种类型（近战/平射/垂直/位移）的行为解析，生成释放指令。
- 装配技能插件，计算最终参数与消耗、冷却。
- 释放时的消耗/冷却判定。

## 2. 依赖

- `items.js`（词条应用）。
- `skill-templates.json`、`plugins.json`。
- `field.js`（坐标越界）。

## 3. 数据结构

- 技能实例：`sid`、`templateId`、`name`（专有名称）、`type`、`multiplier`、`cost{hp,mp,sp}`、`cooldown`、`bulletLevel`、类型参数（`range`/`area`/`bulletCount`/`bulletSpeed`/`distance`/`passThroughEnemy`/`dealDamage`/`fullDodgeDuring`）、`slots[]`（基础/特殊槽）、`affixes[]`。

## 4. 核心流程（代码逻辑）

### 4.1 实例化 `instantiateSkill(template, quality, rng)`

1. 拷贝模板基础字段。
2. 对可随机数值参数（倍率、范围/射程、弹幕数量、弹幕速度、位移距离、冷却）应用品质系数并取整。
3. 弹幕等级、类型、消耗结构、方向语义不变。

### 4.2 装配技能插件 `applySkillPlugins(skill, plugins)`

- 插槽分两类：基础槽（修改基本属性：倍率/消耗/冷却/射程/弹幕/位移距离）与特殊槽（特殊效果：眩晕/击退/拉近/持续伤害/真实伤害/吸血/暴击）。
- 按插件档位把 `costDelta` 叠加到消耗（除减耗类外）。

1. 倍率提升：倍率增加。
2. 消耗优化（减耗）：`cost` 各维按比例下调；此类插件 `costDelta` 为 null。
3. 冷却缩减：`cooldown` 减数值，下限 0。
4. 弹幕增强：范围/射程/弹幕数量/位移距离增加；「提高弹幕等级」令 `bulletLevel` 减 1（下限 1）。
5. 伤害类型/控制/命中回复/释放增益：记录到 `affixes`，供命中结算读取。
6. 除减耗类外，每个插件把其 `costDelta` 叠加到 `cost`。

### 4.3 释放判定 `canCast(skill, caster)`

1. 冷却检查：`caster.cooldowns[sid] > 0` → 不可释放。
2. 资源检查：`hp/mp/sp` 任一低于 `cost` 对应项 → 不可释放。
3. 通过则扣资源、写入冷却，返回成功。

### 4.4 生成释放指令 `buildSkillAction(skill, caster)`

按 `type` 分派：

1. **近战 melee**：
   - 依据 `range` 区间（相对角色）与朝向，计算覆盖格集合；每格越界（[0,15] 外）丢弃。
   - 生成近战弹幕（速度 0），`pathThisTick = 覆盖格`；对每格独立判定命中。

2. **平射 straight**：
   - 生成 `bulletCount` 个弹幕，沿朝向发射，参数为 `range`（射程）、`bulletSpeed`、`bulletLevel`。
   - 效果只作用于弹幕命中的一格。

3. **垂直 vertical**：
   - 计算落点格 = `clamp(caster.x + 朝向 × range)`。
   - 以落点为基准、按 `area` 区间计算作用格集合；每格独立判定。

4. **位移 displacement**：
   - 目标格 = `clamp(caster.x + 朝向 × distance)`。
   - 判定是否穿过敌人、是否造成伤害、位移过程中是否完全闪避。
   - 更新角色位置与朝向，必要时附带伤害。

### 4.5 命中结算

- 伤害管线由战斗引擎统一处理：倍率 → 防御/真实伤害 → 背击(×1.5) → 暴击(×1.5) → 吸血 → 附加效果（眩晕/击退/拉近/持续伤害）。
- 背击判定（详见 `07-engine.md`）：近战/位移用**释放技能前**的相对位置与朝向；平射弹幕用弹幕来向与朝向；垂直弹幕永不触发。

## 5. 边界与异常

- 所有坐标越界 clamp 到 [0,15]。
- `bulletLevel` 提升下限 1，冷却下限 0。
- 资源不足/冷却中：释放失败，不扣资源、不产生效果（引擎视为空行动）。

## 6. 对外接口

- `instantiateSkill`、`applySkillPlugins`：装配与初始化。
- `canCast`、`buildSkillAction`：引擎每 tick 调用。

## 7. 测试要点

- 四类型覆盖格计算正确（近战前后范围、平射单格、垂直落点范围、位移距离）。
- 插件叠加后的消耗/冷却/等级正确。
- 越界 clamp。
- 资源不足/冷却中不释放。
