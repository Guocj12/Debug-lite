# server/data/

数据表（P0-6 落地 + T-DC-1/2 校验；机制在代码、数值在表，L9）。**本 README 即数据表契约**（P0-7 汇总进 docs/interfaces.md）。

## 数据表清单

| 文件 | 内容 | 权威来源 |
|---|---|---|
| `battle-config.json` | 全部战斗数值（D-117） | `tasks.md` §2.5.7 + `systems/06-field.md` §3 |
| `role-templates.json` | 11 个角色模板（D-110 必填 regen） | `items-data.md` §3 |
| `skill-templates.json` | 10 个技能模板（D-111 slotWeights / D-118 bulletLevel；**无 bulletSpeed**） | `items-data.md` §4 |
| `plugins.json` | 14 角色插件 + 15 技能插件（D-113 costDeltaByTier / D-114 独立 id） | `items-data.md` §5/§6 |
| `qualities.json` | 5 品质（D-116 pluginPoints）+ tiers 三等分 + costDeltaBase | `items-data.md` §2 + `v3-design` §13.4 |
| `items-config.json` | 开箱概率 dropRates / 类别权重 kindWeights | `v3-design` §13.5 |
| `unlock.json` | 段位解锁表（增量；aiNodes 累积 = 11/14/17/17/19） | `examples/09-unlock.md` §1 |

`schema.js`：校验器（T-DC-1 结构 + T-DC-2 items-data 一致性，期望值硬编码并注释出处行号；禁 `bulletSpeed`）。导出 `validateStructure` / `validateConsistency` / `validate`（合并）。

## 冻结的数值（T-DC-1 逐值校验；来源 `tasks.md` §2.5.7）

`cellPx=64` `fieldPx=1024` `actorHalfPx=32` `movePx=64` `dodgePx=128` `collisionDmgMul=0.8` `baseHitMul=0.8` `baseDef=64` `defendDefMul=1.6` `dodgeChanceBonus=0.20`（占位，B21 校准）`backstab=1.5` `crit=1.5` `overtimeStart=48` `overtimeRatio=0.0625` `hardCapTick=64`；`minGapPx=64`、`startX{p1:224,p2:800}`、`startFacing{p1:1,p2:-1}`、基地 `hp100/def64`（`06-field` §3）；`bases.*.def === baseDef` 交叉一致。

## 冻结的语义要点（P0-6，实现依据）

1. **品质 tiers 三等分**（4 位小数、段间接续、首尾 = statRange 边界）：common 显式 `[0.80,0.88]/[0.88,0.97]/[0.97,1.05]`（items-data §2.1 用户指定）；其余品质同法三等分（rare `[1.0000,1.0833]/[1.0833,1.1667]/[1.1667,1.2500]` 等）。
2. **插件词条存"基础值"**：实例化时 `词条 = 基础值 × U(档位区间系数)`（01-items I-5/I-6）；`pointCostByTier=[1,2,3]`（角色）、`costDeltaByTier` 逐档数组（技能，减耗类 `null`；**基准 = 绿品质 [2,4,6]**，实例化按 `costDeltaBase[quality]` 折算：S-2b rare tier1 = mp+3）。
3. **`unlockTier` 可选**（缺省=已解锁）；分配（占位，B13/B21 可调）：技能 绿=旋风斩/精准射击、蓝=重击/连续射击/冰锥、紫=毒瓶/箭雨、橙=火球术、青=突击盾/暗影步；角色 绿=均衡、蓝=特化×5、橙=专家×5；AI 节点 绿=if、蓝=loop/while/break、紫=random/logic/arith_ext、青=function/call（L4 无语法新增）。
4. **`unlock.json` 与 角色/技能两表 `unlockTier` 交叉一致**（schema 校验二者集合相等，防双源漂移；插件表当前无 `unlockTier`，不参与交叉——即全体已解锁）。
5. 角色模板 `pluginPoints=3`（字面保留，v3-design §13.1）；**装配点数上限按物品品质的 `pluginPoints`**（01-items I-10d：rare=4 为唯一带数值证据；B18 复核模板字段去留）。
6. 特化/专家模板 `regen` 占位 `{mp:1,sp:2}`（B21 按流派校准）；`slotWeights` 占位：高属性 2、其余 1、special 1（均衡全 1，I-4）；技能统一 `{basic:2, special:1}`。