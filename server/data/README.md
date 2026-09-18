# server/data/

数据表（P0-6 落地 + T-DC-1/2 校验；机制在代码、数值在表，L9）。**本 README 即数据表契约**（P0-7 汇总进 docs/interfaces.md）。

## 0. 机制层 vs 内容层（先读这条）

| 层 | 表 | 性质 | 谁维护 |
|---|---|---|---|
| **机制层** | `skill-mechanics.json` | 技能**类型**机制：参数滚动模式（`pair`/`intMin`/`copy`）、语义槽位 `slots`、弹幕发射模式（`cellsFromRange`/`repeatCount`/`impactCells`/`pathCells`）与 `bullet` 描述、`costDims`、`precision`、`bounds` | 机制词汇——实现侧维护，**不是内容** |
| **机制层** | `affix-registry.json` | 词条注册表：`domain`/`roll`/`agg`/`special`/`regen`/`skillOp`/`hitEffect`/`castEffect`、`stats`、`caps` | 机制词汇——实现侧维护，**不是内容** |
| **机制层** | `ai-nodes.json` | AI 语言的**真实节点类型**单一数据源（`base` 恒可用 + `nodes` 全量白名单） | 机制词汇——**不是内容** |
| **内容层** | `role-templates.json` / `skill-templates.json` / `plugins.json` / `qualities.json` / `items-config.json` / `unlock.json` | 角色/技能/插件/品质/掉落/解锁的**具体条目与数值** | ⚠️ **当前全部为示例数据** |
| **结构校验** | `schema.js` | T-DC-1（结构 + 冻结数值）+ T-DC-2（items-data 逐值一致） | 实现侧维护 |
| 冻结配置 | `battle-config.json` | 全部战斗数值（D-117 冻结，B21 校准入表） | 实现侧维护 |

> ⚠️ **内容层表当前为示例数据，正式内容由用户设计后冻结。**
> 表里的名称、数值、词条 v、解锁段位都只是"能跑通链路"的占位内容，**任何数值都不是最终设计**；替换内容时**只改内容层表（并同步 `docs/items-data.md`）**，不需要改代码。
> 机制层表则相反：它声明的是**机制词汇**（某个词条怎么滚、打到哪个字段、命中做什么 / 某个类型怎么发弹幕），新增类型或词条 = 改这两张表，代码不写分支（见 `docs/systems/03-skills.md` §2A、`docs/systems/01-items.md` §2A）。

## 数据表清单

| 文件 | 层 | 内容 | 权威来源 |
|---|---|---|---|
| `battle-config.json` | 冻结配置 | 全部战斗数值（D-117） | `tasks.md` §2.5.7 + `systems/06-field.md` §3 |
| `skill-mechanics.json` | **机制** | 4 种技能类型机制（参数滚动/槽位/发射模式/bounds/precision/costDims） | `systems/03-skills.md` §2A/§3 |
| `affix-registry.json` | **机制** | 词条注册表（27 条已登记词条：25 条单域 + 2 条 `both`；含 `caps.probability`） | `systems/01-items.md` §3A、`systems/03-skills.md` §4.2/§7 |
| `ai-nodes.json` | **机制** | AI 真实节点类型（base 10 + 全量 17） | `systems/08-ai.md` §3 + `examples/09-unlock.md` §1 |
| `role-templates.json` | 内容（示例） | 11 个角色模板（D-110 必填 regen）+ `typeModifiers` | `items-data.md` §3 |
| `skill-templates.json` | 内容（示例） | 10 个技能模板（D-111 slotWeights / D-118 bulletLevel；**无 bulletSpeed**） | `items-data.md` §4 |
| `plugins.json` | 内容（示例） | 14 角色插件 + 15 技能插件（D-113 costDeltaByTier / D-114 独立 id） | `items-data.md` §5/§6 |
| `qualities.json` | 内容（示例） | 5 品质（D-116 pluginPoints）+ tiers 三等分 + costDeltaBase | `items-data.md` §2 + `v3-design` §13.4 |
| `items-config.json` | 内容（示例） | 开箱概率 dropRates / 类别权重 kindWeights | `v3-design` §13.5 |
| `unlock.json` | 内容（示例） | 段位解锁表（增量权限名 + 模板/技能清单 + `nodePermissions` 别名映射） | `examples/09-unlock.md` §1 |
| `schema.js` | 校验器 | 见下 | 本 README |

`schema.js`：校验器（T-DC-1 结构 + T-DC-2 items-data 一致性，期望值硬编码并注释出处行号；禁 `bulletSpeed`）。导出 `validateStructure` / `validateConsistency` / `validate`（合并）。

## 节点计数口径（`availableNodes`）

- `server/core/unlock.js` 的 `availableNodes(tier)` **只返回真实节点类型**：起点 = `ai-nodes.json` 的 `base`（10 个），再按 `unlock.json` 的增量权限名经 `nodePermissions` **展开**（`while` → 折叠为 `loop`、不新增节点；`arith_ext` → `implemented:false`、不授予任何节点）。
- 因此**累计真实节点数 = 11 / 13 / 15 / 15 / 17**（common / rare / epic / legendary / mythic）。
- `unlock.json` 里权限名的累计个数是 11 / 14 / 17 / 17 / 19（旧口径）：多出的正是 `while` 与 `arith_ext` 这两个**非节点类型**。`schema.js` 的 T-DC-1 仍按**权限名增量表**核对（对 `unlock.json` 原文做数组比对），文档与文档口径以本节为准。
- `isUnlocked(tier,'while')` = true（别名权限可用），`isUnlocked(tier,'arith_ext')` = **false**（未实现，恒拒绝）。

## 冻结的数值（T-DC-1 逐值校验；来源 `tasks.md` §2.5.7）

`cellPx=64` `fieldPx=1024` `actorHalfPx=32` `movePx=64` `dodgePx=128` `collisionDmgMul=0.8` `baseHitMul=0.8`（**撞基地伤害倍率用 `baseHitMul`**；此前引擎误用 `collisionDmgMul`——真值表两者同为 0.8，故线上无差异，B8/后续修正）`baseDef=64` `defendDefMul=1.6` `dodgeChanceBonus=0.20`（占位，B21 校准）`backstab=1.5` `crit=1.5` `defK=40` `overtimeStart=48` `overtimeRatio=0.0625` `hardCapTick=64`；`minGapPx=64`、`startX{p1:224,p2:800}`、`startFacing{p1:1,p2:-1}`、基地 `hp100/def64`（`06-field` §3）；`bases.*.def === baseDef` 交叉一致。

## 冻结的语义要点（P0-6，实现依据）

1. **品质 tiers 三等分**（4 位小数、段间接续、首尾 = statRange 边界）：common 显式 `[0.80,0.88]/[0.88,0.97]/[0.97,1.05]`（items-data §2.1 用户指定）；其余品质同法三等分（rare `[1.0000,1.0833]/[1.0833,1.1667]/[1.1667,1.2500]` 等）。
2. **插件词条存"基础值"**：实例化时按注册表 `roll` 滚动——`int` → `round(基础值 × 档位系数)`、`stat` → 保留 `precision.stat=2` 位（01-items I-5/I-6 + `affix-registry.json`）；`pointCostByTier=[1,2,3]`（角色）、`costDeltaByTier` 逐档数组（技能，减耗类 `null`；**数组只声明"哪个维度加消耗"**，逐档增量 = `costDeltaBase[quality] × tier`：S-2b rare tier1 = mp+3）。
3. **`unlockTier` 可选**（缺省=已解锁）；分配（**示例数据，占位，待用户设计**）：技能 绿=旋风斩/精准射击、蓝=重击/连续射击/冰锥、紫=毒瓶/箭雨、橙=火球术、青=突击盾/暗影步；角色 绿=均衡、蓝=特化×5、橙=专家×5；AI 权限名 绿=`if`、蓝=`loop`/`while`/`break`、紫=`random`/`logic`/`arith_ext`、青=`function`/`call`（legendary 无语法新增）。**权限名 ≠ 节点类型**（真实节点数 11/13/15/15/17，见上节）。
4. **`unlock.json` 与 角色/技能两表 `unlockTier` 交叉一致**（schema 校验二者集合相等，防双源漂移；插件表当前大部分无 `unlockTier`——即全体已解锁；已登记的两条示例为 `rp_sp_opt`/`sp_displacement` = legendary，不参与交叉）。
5. 角色模板 `pluginPoints=3`（字面保留，v3-design §13.1）；**装配点数上限按物品品质的 `pluginPoints`**（01-items I-10d：rare=4 为唯一带数值证据；B18 复核模板字段去留）。
6. 特化/专家模板 `regen` 占位 `{mp:1,sp:2}`（B21 按流派校准）；`slotWeights` 占位：高属性 2、其余 1、special 1（均衡全 1，I-4）；技能统一 `{basic:2, special:1}`。
7. **词条口径（机制层）**：概率类（`dodge_chance` / `crit_chance` / `lifesteal`）累加后按 `caps.probability=1` 封顶；`true_dmg` = **命中附加 v 点真实伤害（直扣）**，不是"改为真实伤害"（B21/D-128）；`cast_buff` = **释放时入效果队列、下一 tick 起效**（D-70）；`hp_regen` 由引擎步骤 10 逐 tick 回复（`hp≤0` 不复活）。
8. **改内容层表时必须同步改 `docs/items-data.md`**：`schema.js` 的 T-DC-2 期望表逐值硬编码（角色/技能/品质/插件的 `name`/`type`/数值/`unlockTier`），且 gate 项 5 会执行它——只改表不改文档（或反之）会**门禁失败**。内容重构时除了表与文档，还需同步 `schema.js` 里那张期望表（`ROLE_EXPECTED` / `SKILL_EXPECTED` / `QUALITY_EXPECTED` / `PLUGIN_EXPECTED`）。