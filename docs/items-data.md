# 物品数据清单（生成后内容）

> **定位**：本文是**内容清单**（实际存在于 `server/data/*.json` 的角色/技能/插件/品质条目与标准值），**不再承载设计推导**。
> **设计依据**：`docs/content-design.md`（内容数值唯一权威，D-173）；数值口径、配平模型、待填补项都在那里。
> **状态**：品质 / 角色模板 / 角色插件 / 技能插件 / 技能模板**均为正式内容**（表中无 `_sample`）。
> **口径提醒**：本表所有数值 = **绿品质标准值**；实例化时 `× U(stat_range_品质)`（`precision.stat = 3` 位小数），面板聚合时**只取整一次**。
> **复算**：`node .audit/content-design.js`（EP + 角色插件 + 技能 η 全量复算）。

---

## 1. 品质（`qualities.json`，正式内容）

| 品质 | 色 | 属性系数区间 | 角色插槽数 | 技能插槽数 | 角色插件点数 |
|---|---|---|---|---|---|
| 绿 common | `#2ecc71` | 0.80~1.05 | 0~2 | 0~1 | 2~3 |
| 蓝 rare | `#3498db` | 1.00~1.25 | 1~3 | 0~2 | 4~6 |
| 紫 epic | `#9b59b6` | 1.20~1.45 | 2~4 | 1~3 | 6~9 |
| 橙 legendary | `#e67e22` | 1.40~1.70 | 3~5 | 2~4 | 8~12 |
| 青 mythic | `#1abc9c` | 1.60~2.00 | 4~6 | 3~4 | 10~15 |

- **槽类型权重（全局单一来源）**：五维各 `0.15`（合计 75%）+ 万能槽 `any` `0.10` + 特殊槽 `special` `0.15`。
- **重复槽衰减**：同一模板内某类型第 k 次出现 → 权重 `× 0.35^(k-1)`。
- 插件品质档位 `tiers`（区间三等分）保留为**展示/分档**用途，**不决定点数消耗**。
- **技能插槽**：`skillExclusiveSlots = 1` 个专属槽（固定）+ `skillSlotRange` 个通用槽；专属槽只接受 `slot: "exclusive"` 的插件。
- `costDeltaBase` 随技能插件消耗补偿一并**退役**（D-173：通用插件零代价）。

## 2. 角色模板（`role-templates.json`，正式内容）

**绿品质标准均衡模板 B0**（= legacy v2 四职业逐维均值）：`hp 95 / atk 15 / def 8 / sp 73 / mp 62`，`regen {mp 2, sp 2}`。
**类型修饰（乘性守恒 `Π 因子 = 1`）**：特化 高 `×1.30`（略高）/ 低 `×0.769231`（略低）；专家 **README 五档（D-174）**：高 `×1.50`（极高）+ 其余四维按 `spread [1.20, 2/3, 5/6, 1]` 洗牌（略高/极低/略低/均衡）；**`excludeLow` 已退役 —— 无 def 特判**，五维等权。

| 模板 id | 名称 | 类型 | 最高属性 | 解锁段位 |
|---|---|---|---|---|
| `role_bal` | 均衡 | balanced | — | common |
| `role_spc_hp` / `role_spc_atk` / `role_spc_def` / `role_spc_sp` / `role_spc_mp` | 特化·HP/攻击/防御/SP/MP | specialized | 同名属性 | rare |
| `role_exp_hp` / `role_exp_atk` / `role_exp_def` / `role_exp_sp` / `role_exp_mp` | 专家·HP/攻击/防御/SP/MP | expert | 同名属性 | legendary |

- 全部模板的 `baseStats` 均为 B0；**差异全部来自类型修饰**（均衡不消耗修饰随机）。
- 位置属性（`regen`、插槽数、插槽类型、插件点数）**独立于模板**：`regen` 取自模板字段，其余按品质掷出。
- 角色无职业维度（v3 决策）。

## 3. 角色插件（`plugins.json`，正式内容；共 40 条）

**命名约定**：同一条插件按点数消耗分 id（D-114 一个变体一个 id）——无后缀 = `pointCost 2`，`_c1` = 1，`_c3` = 3。
**数值口径**：`v = 0.085 × pointCost × 基准`（pct 型基准 = 1；flat 型基准 = `Ref_绿(stat)`；**def 的基准 = `def + defK = 48`**）。

### 3.1 五维·百分比型（12 条）

| 目标槽 | id | 点数 | 标准值 |
|---|---|---|---|
| atk | `rp_atk_pct_c1` / `rp_atk_pct` / `rp_atk_pct_c3` | 1 / 2 / 3 | +8.5% / +17% / +25.5% |
| hp | `rp_hp_pct_c1` / `rp_hp_pct` / `rp_hp_pct_c3` | 1 / 2 / 3 | +8.5% / +17% / +25.5% |
| sp | `rp_sp_opt_c1` / `rp_sp_opt` / `rp_sp_opt_c3` | 1 / 2 / 3 | SP 上限 +8.5% / +17% / +25.5%（`rp_sp_opt` 带 `unlockTier: legendary`） |
| mp | `rp_mp_opt_c1` / `rp_mp_opt` / `rp_mp_opt_c3` | 1 / 2 / 3 | MP 上限 +8.5% / +17% / +25.5% |

### 3.2 五维·数值型（15 条）

| 目标槽 | id（`_c1` / 无后缀 / `_c3`） | 点数 1 / 2 / 3 的标准值 |
|---|---|---|
| atk | `rp_atk_flat_*` | +1.275 / +2.55 / +3.825 |
| hp | `rp_hp_flat_*` | +8.075 / +16.15 / +24.225 |
| def | `rp_def_flat_*`（**def 只有数值型**，无百分比型） | +4.08 / +8.16 / +12.24 |
| sp | `rp_sp_flat_*` | +6.205 / +12.41 / +18.615 |
| mp | `rp_mp_flat_*` | +5.27 / +10.54 / +15.81 |

### 3.3 每 tick 回复型（3 条，均为 `pointCost 3`）

| id | 槽 | 效果 |
|---|---|---|
| `rp_regen` | special | 每 tick 生命 +1 |
| `rp_sp_regen` | sp | 每 tick SP +1 |
| `rp_mp_regen` | mp | 每 tick MP +1 |

### 3.4 特殊型（10 条，`special` 槽）

| id | 名称 | 点数 | 标准值 | 机制 |
|---|---|---|---|---|
| `rp_dodge` / `rp_dodge_c3` | 闪避 | 2 / 3 | 14.53% / 20.32% | `dodgeChance`（累加封顶 1） |
| `rp_crit` / `rp_crit_c3` | 暴击 | 2 / 3 | 17% / 25.5% | `critChance`（暴击倍率 2.0） |
| `rp_lifesteal` / `rp_lifesteal_c3` | 吸血 | 2 / 3 | 17% / 25.5% | `lifesteal` |
| `rp_thorns` / `rp_thorns_c3` | 荆棘 | 2 / 3 | 11.33% / 17% | `thorns`：受击反弹 `v × 攻击者有效 atk` |
| `rp_critdmg` | 致命 | 2 | 暴击倍率 +0.34 | `critMul`（需配合暴击率；**数值待 §7-T6 标定**） |
| `rp_lowhp` | 背水 | 2 | 生命 <50% 时 攻击 +51% | `lowHpAtk`（阈值 `battle-config.lowHpThreshold = 0.5`；**数值待 §7-T6 标定**） |

> **待校准标注**：`sp/mp` 相关条目（`rp_sp_*` / `rp_mp_*`）与 `rp_critdmg` / `rp_lowhp` 在 `plugins.json` 中带 `_pending` 字段，机制已完整实现，**数值待标定（§7-T6）后回填**（§7-T2 为掉落/开箱概率，与本条无关）。

## 4. 技能插件（`plugins.json`，正式内容；共 23 条 = 7 通用 + 16 专属）

**两类**（§6.2）：`slot: "general"` 通用（纯词条加成、**零代价**，7 条）与 `slot: "exclusive"` 专属（声明式形态覆盖、按 `forTypes` 绑定技能类型、每个技能至多 1 个，16 条）。
**专属插件的强度全在 `exclusive{}` 里**：`overrides`（形态/倍率/消耗/冷却）+ `specials`（技能级暴击类）+ `hitEffects`/`castEffects`（命中/释放效果）+ `qualityOverrides`（逐品质覆盖，如连射弹幕数）。

### 4.1 通用插件（7 条，零代价）

| id | 名称 | 词条（绿品质标准值） |
|---|---|---|
| `sk_mult` | 增伤 | 倍率 +8.5% |
| `sk_crit` | 暴击率 | 暴击率 +8.5% |
| `sk_critdmg` | 暴击伤害 | 暴击倍率 +0.17 |
| `sk_cd_down` | 冷却缩减 | 冷却 −25%（向下取整，下限 1） |
| `sk_sp_down` | 体力消耗 | SP 消耗 −20% |
| `sk_mp_down` | 法力消耗 | MP 消耗 −20% |
| `sk_true` | 真实伤害 | 倍率 −10% + 整次命中改真伤 |

### 4.2 专属插件（16 条，数值见 `content-design.md` §6.4）

| 技能类型 | id（名称） |
|---|---|
| 近战 melee | `ex_longsword`（长剑）/ `ex_dagger`（匕首）/ `ex_whirl`（旋风斩）/ `ex_hammer`（重锤） |
| 平射 straight | `ex_pierce`（穿甲）/ `ex_rapid`（连射）/ `ex_scatter`（霰弹）/ `ex_snipe`（狙击） |
| 定点 vertical | `ex_fireball`（火球）/ `ex_rain`（箭雨）/ `ex_vine`（藤蔓）/ `ex_curse`（诅咒） |
| 位移 displacement | `ex_bash`（盾突）/ `ex_blink`（瞬移）/ `ex_thrust`（突刺）/ `ex_retreat`（后撤） |

- 每条专属插件带 `animKey`/`sfxKey`（装上后覆盖技能展示键）与 `name`（装上后技能显示名）。
- 覆盖型字段**不随品质浮动**；`ex_rapid` 的弹幕数用 `qualityOverrides` 逐品质给值（3/3/4/4/5）。

## 5. 技能模板（`skill-templates.json`，正式内容）

4 条基础模板（每类 1 条，全 `common` 解锁），数值见 `content-design.md` §6.3：

| id | 名称 | 类型 | 弹幕等级 | 射程/范围 | 位移 | 倍率 | SP | MP | CD |
|---|---|---|---|---|---|---|---|---|---|
| `skill_melee` | 近战 | melee | 2 | 范围 `[0,2]` | — | 1.0 | 11 | 0 | 3 |
| `skill_straight` | 平射 | straight | 3 | 射程 5，弹幕 1 | — | 1.2 | 2 | 3 | 1 |
| `skill_vertical` | 定点 | vertical | 4 | 射程 5，范围 `[0,0]`，衰减 0.2 | — | 1.0 | 0 | 1 | 1 |
| `skill_displace` | 位移 | displacement | 1 | — | 距离 3（不穿敌/无伤/非全程闪避） | 0 | 7 | 0 | 2 |

**不浮动**：`range`/`area`/`bulletCount`/`distance`/`bulletLevel`/`cost`/`cooldown`/`falloff`/三个开关/`animKey`/`sfxKey`；**只有 `multiplier` 随品质浮动**。变体由专属插件产生（§4.2）。

## 6. 掉落配置（`items-config.json`）

- `dropRates`：`common 0.55 / rare 0.28 / epic 0.12 / legendary 0.04 / mythic 0.01`（**待用户设计**，`content-design.md` §7-T2）。
- `kindWeights`：`role 1 / skill 1 / rolePlugin 2 / skillPlugin 2`（**待用户设计**）。
- 逐条目的 `drop` / `dropWeight` / `unlockTier` 由各内容表自带（当前：全部 `drop: true` / `dropWeight: 1`；`unlockTier` 仅 `rp_sp_opt` 为 `legendary`，其余无 → 已解锁；技能模板全部 `common`）。

## 7. 贴图与动画占位（`assets/sprites.json` / `assets/animations.json`）

- **贴图**：角色 16×16、技能 8×8、插件 8×8 占位图形；`rolePlugins`（40 条）与 `skillPlugins`（23 条 = 7 通用 + 16 专属）覆盖上表 id（新增 id 缺占位**不阻塞门禁**，见 DS-11②）。
- **动画/音效**（T9 已补齐）：`animations.skill` 按技能 `animKey` 给帧数/时长/循环/偏移占位（4 模板 + 16 专属 = 20 条），`sounds.skill` 列出 20 个 `sfxKey`；`role` 组的基础六件套仍为必填。
- 齐备性由 `.audit/verify-skill-system.js` 核对（表现层缺失**不阻塞门禁**，只在该自检里报错）。

## 8. 备注

- **机制层 vs 内容层**：本文与 `server/data/*.json` 是**内容**；"词条怎么滚、打到哪个字段、命中做什么"是**机制**，在 `affix-registry.json` / `skill-mechanics.json`（说明见 `systems/01-items.md` §2A）。
- **口径变更史**：本文旧版（截至 2026-09-27）为占位示例（绿 100/10/8/60/40、点数 3/4/5/6/7、插槽 1-3…5-7、`pointCostByTier`、10 条示例技能、15 条技能插件）；2026-09-28 按 D-173 全量替换（技能系统同时落地），旧值不再有效。
- **待填补清单**：无 —— `docs/content-design.md` §7 的 T1~T9 与三项取舍已由用户 2026-09-28 全部拍板（T1~T8 维持现状、T9 已补占位素材、starter 恒发 1 专属 + 1 通用）。
