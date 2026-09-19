# server/data/

数据表（P0-6 落地 + T-DC-1/2 校验；机制在代码、数值在表，L9）。**本 README 即数据表契约**（P0-7 汇总进 docs/interfaces.md）。

## 0. 机制层 vs 内容层（先读这条）

| 层 | 表 | 性质 | 谁维护 |
|---|---|---|---|
| **机制层** | `skill-mechanics.json` | 技能**类型**机制：参数滚动模式（`pair`/`intMin`/`copy`）、语义槽位 `slots`、弹幕发射模式（`cellsFromRange`/`repeatCount`/`impactCells`/`pathCells`）与 `bullet` 描述、`costDims`、`precision`、`bounds` | 机制词汇——实现侧维护，**不是内容** |
| **机制层** | `affix-registry.json` | 词条注册表：`domain`/`roll`/`agg`/`special`/`regen`/`skillOp`/`hitEffect`/`castEffect`、`stats`、`caps`，以及 `_domainOfKind`（`kind` → 期望 `domain` 的映射） | 机制词汇——实现侧维护，**不是内容** |
| **机制层** | `ai-nodes.json` | AI 语言的**真实节点类型**单一数据源（`base` 恒可用 + `nodes` 全量白名单） | 机制词汇——**不是内容** |
| **参数表** | `service-config.json` / `rating-config.json` | 运行时参数（账号/会话/槽位/保留期/缓存上限/限速；积分与匹配参数 D-133）——**表为数值单一来源，代码默认值兜底**（`server/store/config.js` 的 `DEFAULT_SERVICE_CONFIG`/`DEFAULT_RATING_CONFIG`），schema 冻结值 + 跨字段不变量校验，**缺表必 FAIL** | `11-account-store.md` §10/§11、`interfaces.md` §4.11/§4.12 |
| **内容层** | `role-templates.json` / `skill-templates.json` / `plugins.json` / `qualities.json` / `items-config.json` / `unlock.json` | 角色/技能/插件/品质/掉落/解锁的**具体条目与数值** | ⚠️ **当前全部为示例数据** |
| **结构校验** | `schema.js` | T-DC-1（结构 + 冻结数值）+ T-DC-2（items-data 逐值一致） | 实现侧维护 |
| 冻结配置 | `battle-config.json` | 全部战斗数值（D-117 冻结，B21 校准入表） | 实现侧维护 |

> ⚠️ **内容层表当前为示例数据，正式内容由用户设计后冻结。**
> 表里的名称、数值、词条 v、解锁段位、`drop`/`dropWeight` 都只是"能跑通链路"的占位内容，**任何数值都不是最终设计**；替换内容时**只改内容层表**即可，不需要改代码。
> **门禁不锁内容数量**（2026-09-16 用户拍板 A）：增删角色/技能/插件/品质条目都不会让项 4/5 失败；T-DC-1 只校验**结构 + 机制自洽**（技能 `type`、词条 id、AI 权限名必须在机制层登记）。
> **逐值比对由 `_sample` 开关控制**：某张内容表带 `_sample: true` → T-DC-2 才按 `docs/items-data.md` 的示例期望表逐值核对；去掉该标记（可逐表去）→ 该表不再比对（文档与表可自由重设计）。
> 机制层表则相反：它声明的是**机制词汇**（某个词条怎么滚、打到哪个字段、命中做什么 / 某个类型怎么发弹幕），新增类型或词条 = 改这两张表（+ `ai-nodes.json` 管 AI 节点），代码不写分支（见 `docs/systems/03-skills.md` §2A、`docs/systems/01-items.md` §2A）。

## 数据表清单

| 文件 | 层 | 内容 | 权威来源 |
|---|---|---|---|
| `battle-config.json` | 冻结配置 | 全部战斗数值（D-117） | `tasks.md` §2.5.7 + `systems/06-field.md` §3 |
| `skill-mechanics.json` | **机制** | 4 种技能类型机制（参数滚动/槽位/发射模式/bounds/precision/costDims） | `systems/03-skills.md` §2A/§3 |
| `affix-registry.json` | **机制** | 词条注册表（27 条已登记词条：25 条单域 + 2 条 `both`；含 `caps.probability` 与 `_domainOfKind`） | `systems/01-items.md` §3A、`systems/03-skills.md` §4.2/§7 |
| `ai-nodes.json` | **机制** | AI 真实节点类型（`base` 恒可用 + `nodes` 全量白名单；**数量以此表为准，schema 不硬编码**） | `systems/08-ai.md` §3 + `examples/09-unlock.md` §1 |
| `service-config.json` | **参数** | 运行时参数：`auth`（scrypt 参数/用户名与密码长度/失败锁定/限速）、`session`、`config`（`maxSlots:3`）、`record`、`store`（缓存上限）、`journal`、`snapshot`、`replayCacheSize`、`pool`（`ttlDays` **无消费方**、`opponentCooldownHours`） | `systems/11-account-store.md` §10/§11 |
| `rating-config.json` | **参数** | 积分与匹配参数（D-133）：`base/cap/scale/kBase/kMin/kMax/drawFactor/matchWindow*/opponentCooldownHours/dailyBattleLimit/rounding/promoteWins/batchSize` | `systems/11-account-store.md` §8.3 |
| `role-templates.json` | 内容（示例） | 角色模板（D-110 必填 regen）+ `typeModifiers` + 每项 `drop`/`dropWeight` | `items-data.md` §3 |
| `skill-templates.json` | 内容（示例） | 技能模板（D-111 slotWeights / D-118 bulletLevel；**无 bulletSpeed**）+ 每项 `drop`/`dropWeight` | `items-data.md` §4 |
| `plugins.json` | 内容（示例） | 角色/技能插件（D-113 costDeltaByTier / D-114 独立 id）+ 每项 `drop`/`dropWeight` | `items-data.md` §5/§6 |
| `qualities.json` | 内容（示例） | 5 品质（D-116 pluginPoints）+ tiers 三等分 + costDeltaBase | `items-data.md` §2 + `v3-design` §13.4 |
| `items-config.json` | 内容（示例） | 开箱概率 dropRates / 类别权重 kindWeights | `v3-design` §13.5 |
| `unlock.json` | 内容（示例） | 段位解锁表（增量权限名 + 模板/技能清单 + `nodePermissions` 别名映射） | `examples/09-unlock.md` §1 |
| `schema.js` | 校验器 | 见下 | 本 README |

`schema.js`：校验器（T-DC-1 结构 + 机制自洽；T-DC-2 示例期望逐值比对**仅在对应内容表带 `_sample: true` 时执行**）。**不锁内容数量**（角色/技能/插件/品质均只要求 ≥1 项）、**不锁 sprites 形状枚举与条数**（允许多余条目，缺失不阻塞；动画只要求 `role` 组的基础六件套）。导出 `validateStructure` / `validateConsistency` / `validate`（合并）。

### 词条 `domain` / `_domainOfKind` 语义（**已被真实消费**）

- `affix-registry.json` 的每个词条带 `domain`（`role` / `skill` / `both`，当前 27 条 = 12 role + 13 skill + 2 `both`），表根另有 `_domainOfKind`（`{rolePlugin:'role', skillPlugin:'skill'}`）声明"某种 `kind` 的插件只该带哪个域的词条"。
- **消费方 = `server/core/items.js` 的 `generatePlugin`**：按 `kind` 取期望域，若词条 `domain` 与期望域不符（且不是 `both`）→ **记 `items.affix.domain`(warn) 并跳过该词条**（与"未登记词条 id"同一处理路径）；因此该字段**不是文档性声明**。
- **静态镜像**：`schema.js` 同时校验 `domain` 取值合法，并对**内容层插件**做同样的域匹配检查（不符 → T-DC-1 **FAIL**）。回归用例 `tests/unit/affix-domain.test.js`。
- **参数表口径**：`service-config.json` / `rating-config.json` 由 `server/store/config.js` 的 `loadConfigs` 读取（去掉 `_` 前缀元键后深合并到内置默认值之上）；**表为数值单一来源、代码默认值仅在缺表/缺键时兜底**；`schema.js` 的 `SERVICE_CONFIG_FROZEN`/`RATING_CONFIG_FROZEN` 做逐值冻结比对，并校验跨字段不变量（`session.maxTotalDays ≥ ttlDays`、`kMin ≤ kBase ≤ kMax`、`promoteWins < batchSize`、`matchWindowMax ≥ matchWindowStart`、`maxSlots ∈ 1..3`）；**缺表必 FAIL**，未知键亦 FAIL。

## 节点计数口径（`availableNodes`）

- `server/core/unlock.js` 的 `availableNodes(tier)` **只返回真实节点类型**：起点 = `ai-nodes.json` 的 `base`，再按 `unlock.json` 的增量权限名经 `nodePermissions` **展开**（`while` → 折叠为 `loop`、不新增节点；`arith_ext` → `implemented:false`、不授予任何节点）。
- **数量以 `ai-nodes.json` 为准**（schema 不再硬编码节点数量，也不再维护"增量表"副本）：当前 `base` 9 个、`nodes` 全量 16 个。
- 因此**累计真实节点数 = 10 / 12 / 14 / 14 / 16**（common / rare / epic / legendary / mythic；由 `availableNodes` 实测）。
- `unlock.json` 里权限名的累计个数是 10 / 13 / 16 / 16 / 18：多出的正是 `while` 与 `arith_ext` 这两个**非节点类型**。
- `isUnlocked(tier,'while')` = true（别名权限可用），`isUnlocked(tier,'arith_ext')` = **false**（未实现，恒拒绝）。

## 冻结的数值（T-DC-1 逐值校验；来源 `tasks.md` §2.5.7）

`cellPx=64` `fieldPx=1024` `actorHalfPx=32` `movePx=64` `dodgePx=128` `collisionDmgMul=0.8` `baseHitMul=0.8`（**撞基地伤害倍率用 `baseHitMul`**；此前引擎误用 `collisionDmgMul`——真值表两者同为 0.8，故线上无差异，B8/后续修正）`baseDef=64` `defendDefMul=1.6` `dodgeChanceBonus=0.20`（占位，B21 校准）`backstab=1.5` `crit=1.5` `defK=40` `overtimeStart=48` `overtimeRatio=0.0625` `hardCapTick=64`；`minGapPx=64`、`startX{p1:224,p2:800}`、`startFacing{p1:1,p2:-1}`、基地 `hp100/def64`（`06-field` §3）；`bases.*.def === baseDef` 交叉一致。

## 冻结的语义要点（P0-6，实现依据）

1. **品质 tiers 三等分**（4 位小数、段间接续、首尾 = statRange 边界）：common 显式 `[0.80,0.88]/[0.88,0.97]/[0.97,1.05]`（items-data §2.1 用户指定）；其余品质同法三等分（rare `[1.0000,1.0833]/[1.0833,1.1667]/[1.1667,1.2500]` 等）。
2. **插件词条存"基础值"**：实例化时按注册表 `roll` 滚动——`int` → `round(基础值 × 档位系数)`、`stat` → 保留 `precision.stat=2` 位（01-items I-5/I-6 + `affix-registry.json`）；`pointCostByTier=[1,2,3]`（角色）、`costDeltaByTier` 逐档数组（技能，减耗类 `null`；**数组只声明"哪个维度加消耗"**，逐档增量 = `costDeltaBase[quality] × tier`：S-2b rare tier1 = mp+3）。
3. **`unlockTier` 可选**（缺省=已解锁）；分配（**示例数据，占位，待用户设计**）：技能 绿=旋风斩/精准射击、蓝=重击/连续射击/冰锥、紫=毒瓶/箭雨、橙=火球术、青=突击盾/暗影步；角色 绿=均衡、蓝=特化×5、橙=专家×5；AI 权限名 绿=`if`、蓝=`loop`/`while`/`break`、紫=`random`/`logic`/`arith_ext`、青=`function`/`call`（legendary 无语法新增）。**权限名 ≠ 节点类型**（真实节点数 10/12/14/14/16，见上节）。
4. **`unlock.json` 与 角色/技能两表 `unlockTier` 交叉一致**（schema 校验二者集合相等，防双源漂移；插件表当前大部分无 `unlockTier`——即全体已解锁；已登记的两条示例为 `rp_sp_opt`/`sp_displacement` = legendary，不参与交叉）。
5. **掉落也完全是数据字段**（2026-09-16 拍板 A）：`role-templates.json` / `skill-templates.json` / `plugins.json` 的**每一条**都带 `drop`（`false` = 不进掉落池；缺省 `true`）与 `dropWeight`（同类池内相对权重；缺省 `1`）。开箱 = 品质（`dropRates`）× 类别（`kindWeights`）× 段位门控（`unlockTier`）× 池内权重（`dropWeight`）。示例内容全为 `true`/`1`（与旧行为一致）。
6. 角色模板 `pluginPoints=3`（字面保留，v3-design §13.1）；**装配点数上限按物品品质的 `pluginPoints`**（01-items I-10d：rare=4 为唯一带数值证据；B18 复核模板字段去留）。
7. 特化/专家模板 `regen` 占位 `{mp:1,sp:2}`（B21 按流派校准）；`slotWeights` 占位：高属性 2、其余 1、special 1（均衡全 1，I-4）；技能统一 `{basic:2, special:1}`；**类型修饰在开箱生成时即生效**（`items.applyTypeModifier` 同时服务 `items.generateRoleItem` 与 `roles.instantiateRole`）。
8. **词条口径（机制层）**：概率类（`dodge_chance` / `crit_chance` / `lifesteal`）累加后按 `caps.probability=1` 封顶；`true_dmg` = **命中附加 v 点真实伤害（直扣）**，不是"改为真实伤害"（B21/D-128）；`cast_buff` = **释放时入效果队列、下一 tick 起效**（D-70）；`hp_regen` 由引擎步骤 10 逐 tick 回复（`hp≤0` 不复活）；regen 词条在**单一聚合实现** `items.buildRolePanel`（`roles.getFinalStats` 与 `loadout.buildPanel` 共用）里**只叠一次**。
9. **内容正式化时"只改表"**（2026-09-16 拍板 A）：`schema.js` 只做结构与机制自洽校验，**不再比对数量**；T-DC-2 的示例期望表（`ROLE_EXPECTED` / `SKILL_EXPECTED` / `QUALITY_EXPECTED` / `PLUGIN_EXPECTED`）**仅当对应内容表保留 `_sample: true` 时**逐值比对——正式设计内容时逐表去掉 `_sample`（或整体去掉）即不再与示例文档耦合；保留 `_sample` 则需保持表与 `docs/items-data.md` 的示例期望一致。机制层仍强制：技能 `type` 必须在 `skill-mechanics.json` 登记、插件词条 id 必须在 `affix-registry.json` 登记、`unlock.json` 权限名必须在 `ai-nodes.json` 的 `nodes` 或 `nodePermissions` 中；sprites 允许多余条目、动画只强制 `role` 组基础六件套。