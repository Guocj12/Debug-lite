# Debug-Lite v3 决策冻结记录

> 版本：v1　更新：2026-09-11
> 用途：**记录用户已拍板的全部设计决策**，作为重写设计文档 / 计划 / 走查的依据。
> 状态：本文件条目一经记录即为**冻结条款**；变更需走 `docs/tasks.md` §10 变更控制。
> 编号规则：`D-xx` 为决策条目；括号内标注来源提问编号（M/BU/S/C/R）与影响文件。

---

## 0. 使用说明

- 本记录与 `docs/tasks.md` §3.5（战斗规范）、§3.7（AI 规范）、`docs/v3-design.md`、`docs/systems/*` 必须一致。
- **冲突处理**：以本记录为准，同步修正其他文档（用户已批准同步重写）。
- ⚠️ 标记表示该条**推翻了原设计文档的既有条款**，必须连带修改设计文档。

---

## 1. 空间与坐标（来源：M10b / BU5 / SPEC_A）

| # | 决策 | 影响 |
|---|---|---|
| D-01 | 场地 16 格 × **64px** = **1024px** 宽；所有位置为**连续坐标** `x ∈ [0,1024]` | `06-field`、`04-bullets`、`07-engine`、`diff` 输出 |
| D-02 | 位置精度 **1px（= 1/64 格）** | 全部位置计算与输出 |
| D-03 | 格 `c` 占 `[64c, 64(c+1))`；角色位置取**格中心** → 初始 P1 `x=224`（格3）、P2 `x=800`（格12） | `06-field` |
| D-04 | 角色中心 clamp 到 `[32, 992]`（格 0 ~ 格 15 的中心范围） | `06-field` |
| D-05 | 基地：P1 占 `[-64, 0)`、P2 占 `(1024, 1088]`；**基地不反击** | `06-field`、`07-engine` |
| D-06 | 角色体积 = 1 格（64px，位置为中心）；两角色中心距**恒 ≥ 64px**（永不重叠） | `07-engine` |
| D-07 | 速度（每 tick 位移）：`move` = 64px；`dodge` = 128px；位移技能 = `distance×64px`；控制位移 = `N×64px`；**弹幕 = `range×64px`（一 tick 飞完全射程）** | `skills`、`bullets`、`battle-config` |
| D-08 | 碰撞严格按**连续方程求解**（同一时刻位置相等），**不用"轨迹重叠"近似**；结果精确到 1/64 格 | `bullets`、`engine` |

---

## 2. 移动、穿敌与角色碰撞（来源：M1 / M1b）

| # | 决策 | 影响 |
|---|---|---|
| D-10 | ⚠️ **角色碰撞伤害**：相向移动无法穿过且目标冲突时，双方**各受一次对方 `atk × 0.8`** 的碰撞伤害，走标准减伤，**允许全部机制**（闪避/暴击/背击/吸血） | `07-engine`（新增伤害来源） |
| D-11 | 相向移动但不重叠：**有"可穿过敌人"的一方穿过敌人到达目标位置**；否则双方停在相遇点两侧（中心距 64px）并结算碰撞伤害 | `07-engine` |
| D-12 | 相向移动且目标位置重叠：有可穿过的一方**更进一格停在敌方身后**；都不可穿过 → 碰撞伤害 + 双方停在相遇点左右 | `07-engine` |
| D-13 | 一方移动另一方静止：静止方不动；移动方按是否有穿敌能力判断穿过还是碰撞 | `07-engine` |
| D-14 | 同向移动且距离不同导致穿过/同格：由**后方角色**判断穿过还是碰撞 | `07-engine` |
| D-15 | **可穿过来源**：位移类技能 `passThroughEnemy=true`、`dodge`（默认可穿）；**普通 `move` 不可穿**；**控制类位移不可穿** | `07-engine`、`battle-config` |
| D-16 | `move` 默认移动 **1 格**；`dodge` 默认移动 **2 格** | `battle-config`、`10.2 行动集` |
| D-17 | 碰撞位置按**角色速度**求解并输出给前端（1px 精度） | `diff` 输出 |
| **D-18** | **位移技能的伤害模型（G2 + 2026-09-11 补充，已确认）**：<br>**① 统一用弹幕实现**：`dealDamage=true` 时，沿技能的**声明移动路径**（`caster.x → clampX(caster.x ± distance×cellPx)`）**每格放置一枚 0 速弹幕**（倍率 = 技能倍率）——与近战/垂直 AOE 完全同构，**不需要任何特判**；这些弹幕照常参与等级抵消与命中判定。<br>**② 路径独立于落位**：即使因碰撞被截停，路径弹幕仍按**声明的路径**放置（否则"弹幕+碰撞同时结算"不可能发生）。<br>**③ 弹幕伤害与碰撞伤害分别结算**：若同时发生碰撞，则**可能在同一 tick 受两次伤害**（路径弹幕的技能伤害 + M1 的碰撞伤害，双方各按 `atk×0.8`）。<br>**④ `dealDamage=false`**：不放置任何路径弹幕；**穿过无伤害**，只有**碰撞**才结算碰撞伤害。<br>**⑤ 副产品**：原 D-19「恰好停在相邻不算接触」**由本模型自然满足**（相邻格不在声明路径内），无需特判 | `03-skills`、`04-bullets`、`07-engine` |
| **D-19** | **"接触"不包括"恰好停在相邻"（U-1，已确认）**：移动/位移结束后中心距**正好 64px**（未穿过、未碰撞）→ **不算接触、不造成技能伤害**；只有**真正穿过**或**发生碰撞**才算接触（因此示例 M8 无伤害） | `07-engine`、`examples/07-movement-collision` M8 |

---

## 3. 弹幕模型（来源：M2 / M2c / M2d / BU1–BU6 / M12 / SPEC_B）

| # | 决策 | 影响 |
|---|---|---|
| D-20 | ⚠️ **弹幕不跨 tick**：每枚弹幕在**生成当 tick 飞完自己的射程**并完成结算（命中 / 被抵消 / 到达射程尽头） | `04-bullets` 全面重写（取消逐 tick 推进） |
| D-21 | ⚠️ **删除 `bulletSpeed` 字段**：技能模板不再有该字段，数据表与 `items-data` 同步删除 | `v3-design §13.2`、`items-data §4`、数据表 |
| D-22 | 弹幕生成位置：**平射 = 释放者所在格**（起点即释放者位置）；**垂直 = 落点格**；**近战 = 覆盖格，每格一枚 0 速弹幕** | `04-bullets`、`skills` |
| D-23 | 命中判定：弹幕轨迹与目标角色轨迹**解连续方程求交**；命中位置以 1px 精度输出 | `04-bullets`、`diff` |
| D-24 | **AOE（0 速）命中基准 = 角色本 tick 位移后的位置**（走出范围即可躲开） | `04-bullets`、`07-engine` |
| D-25 | 一发 AOE 对**每个目标最多结算一次**；**平射可多次命中同一目标**（多发各算一次） | `04-bullets`、`07-engine` |
| D-26 | 近战/垂直弹幕**每格视作一枚独立弹幕**，各自参与等级计算与抵消判定 | `04-bullets` |
| D-27 | ⚠️ **遍历顺序**：不再按格遍历，改为**按弹幕生成先后顺序**逐条处理，检测到碰撞后**递归**处理（被消者退出后续判定） | `04-bullets`、`07-engine` |
| D-28 | 弹幕互撞：**按公式求同一时刻位置相等**（含同向追及），精确到 1/64 格；等级高者**穿过并继续判定命中**，同级**双消**，低者消失 | `04-bullets` |
| D-29 | AOE 伤害衰减：技能模板新增 **`falloff`** 参数（每向外一格减伤百分比，**默认 0 = 不衰减**） | `v3-design §13.2`、`items-data`、数据表 |
| D-30 | 轨迹判定区间**含终点**；弹幕不会伤害自己（生成格不含敌人，D-06 保证） | `04-bullets` |
| D-31 | 弹幕**没有"经过的格"列表**：全部判定基于连续轨迹（与 D-20/D-27 配套） | `04-bullets` |
| **D-32** | **`t = 0` 的同格碰撞计入碰撞（G1，已确认）**：解连续方程的时间区间取 **`t ∈ [0, 1]`**。当敌人在自己所在格开火、而某枚弹幕恰好覆盖该格时，二者在 `t=0` 位置相同 → **立即互相拦截**（等级高者存活并继续），**不允许"飞到下一格才拦下"** | `04-bullets §4.3`、`tasks.md §3.5.4` |
| **D-33** | **双方可穿且目标重叠时"各进一格"（U-2，已确认）**：两方各自**再沿原方向前进一格（+64px）**，即停在**相遇格的左右各一格**，**相遇格空着**（中心距 128px）。例：双方目标同为 528 → 左方 592、右方 464<br>（**仅一方可穿**且撞上静止方时仍按"停在敌方身后"，即中心距恰好 64px，见 D-11/D-12） | `07-engine §4.3`、`examples/07` N6 |
| **D-34** | **位移技撞基地＝`atk×0.8`（U-3，已确认）**：与 D-61 一致，**不使用技能倍率**（基地伤害只有一种公式） | `06-field §4.3` |
| **D-35** | **被动位移（击退/拉近）撞到敌人同样结算碰撞伤害（U-4，已确认）**：控制类位移造成重叠/碰撞时，**按 M1 规则结算碰撞伤害**（双方各受对方 `atk×0.8`），与主动移动一致 | `05-effects §4.2`、`06-field §5` |

---

## 4. 伤害、防御与吸血（来源：M6 / M13 / M14 / M18 / SPEC_C）

| # | 决策 | 影响 |
|---|---|---|
| D-40 | 基础伤害 `max(1, floor(atk × 倍率 × (1 − def/(def+40))))`；真实伤害 `max(1, floor(atk × 倍率))` | `07-engine` |
| D-41 | 倍率（背击/暴击/其他）**全部相乘后只取整一次** | `07-engine` |
| D-42 | 背击 ×1.5、暴击 ×1.5，**可叠加 ×2.25** | `07-engine` |
| D-43 | ⚠️ **`defend` = 本 tick `def × 1.6`**（等效临时 +60% 防御插件），代入 D-40 公式；**不再是独立减伤步骤** | `07-engine`（伤害链路改写）、`battle-config` |
| D-44 | 吸血 `floor(伤害 × lifesteal)`，`maxHp` 封顶；仅对角色伤害生效，**不作用于基地** | `07-engine` |
| D-45 | 词条聚合：`base × (1 + Σ百分比) + Σ数值`，**最后一次取整** | `items`、`roles` |
| D-46 | 概率类词条累加封顶 1 | `items`、`roles` |

---

## 5. 背击（来源：M17 / SPEC_C）

| # | 决策 | 影响 |
|---|---|---|
| D-50 | ⚠️ **背击用本 tick 位移后的位置与朝向**判定（不再是"释放前快照"） | `07-engine`、`03-skills`（推翻原"释放前位置"条款） |
| D-51 | 近战/位移：看双方位移后的相对位置与朝向；平射：看弹幕飞行方向；**垂直永不触发** | `07-engine` |

---

## 6. 基地（来源：M4 / M4b / SPEC_C）

| # | 决策 | 影响 |
|---|---|---|
| D-60 | ⚠️ **弹幕不对基地造成任何伤害**（平射/垂直/近战弹幕一律无效） | `06-field`、`04-bullets`、`07-engine` |
| D-61 | ⚠️ **伤害基地的唯一方式**：面向基地且向基地方向移动 → **停在原地**（位置不变）+ 对基地造成 `atk × 0.8` 走基地 `def=64` 减伤 | `06-field`、`07-engine` |
| D-62 | 基地不反击（角色不受伤） | `06-field` |

---

## 7. 效果与控制（来源：M3）

| # | 决策 | 影响 |
|---|---|---|
| D-70 | `fullDodgeDuring`：整个位移 tick **免疫所有伤害来源** | `05-effects`、`03-skills` |
| D-71 | 控制类位移**不可穿过**敌人（D-15）；控制效果仍在 AI 返回行动之后复写 | `05-effects` |
| **D-72** | **`fullDodgeDuring` 的完整语义（V-1，已确认）**：位移期间该角色 **① 免疫所有伤害；② 免疫控制效果（眩晕/击退/拉近不生效）；③ 视为"无法命中"——完全**不参与弹幕判定**（弹幕既不因它而命中、也不因它而被消耗，直接穿过）** | `03-skills`、`04-bullets`、`07-engine` |

---

## 8. 运行期与兜底（来源：M7 / M8 / M8b / M11）

| # | 决策 | 影响 |
|---|---|---|
| D-80 | ⚠️ 行动集**新增 `wait`**（对 AI 可见）；非法 action 归一化为 `wait` | `v3-design §10.2`、`ast.js` |
| D-81 | ⚠️ **步数兜底返回 `wait`**（不是 `defend`）+ 重置到程序入口 + `ai.step.limit`(**warn**) 日志 | `08-ai`、`ast/runtime` |
| D-82 | 冷却递减：引擎**每 tick 步骤 1** `max(0, cd−1)`；AI 自记冷却变量在**本 tick 决策前**递减 | `07-engine`、`08-ai` |
| D-83 | 控制效果复写发生在 AI 返回行动**之后**（保持文档现有顺序） | `05-effects` |
| **D-84** | **被控制复写掉技能行动时**：**不扣资源、不写冷却**（V-2，已确认）。因为复写发生在 `action.commit`（步骤 6）**之前**，被复写的技能**从未真正释放**；日志记 `effect.control.override`，AI 的 trace 仍保留它原本想做的行动（便于排查） | `07-engine`、`05-effects` |

---

## 9. 随机（来源：M9 / M9b）

| # | 决策 | 影响 |
|---|---|---|
| D-90 | ⚠️ **每局一条全局种子**；所有随机由该种子派生 | `v3-design §11.6/§15.1`、`rng.js` |
| D-91 | **每 tick 每用途各派生一条流**：`hash(seed, tick, purpose)`，`purpose ∈ {ai, crit, dodge, …}`；各用途互不干扰、可复现 | `rng.js`、`08-ai`、`07-engine` |
| D-92 | 引擎内禁止 `Math.random`；随机全部走注入 RNG（保持原条款） | 全局 |

---

## 10. AI 语言与执行（来源：R2 / R2b / M8b）

| # | 决策 | 影响 |
|---|---|---|
| D-100 | ⚠️ **AI 最外层是一个无法跳出的 `while(true)`**：程序运行到最后**自动回到第一行**；该结构由引擎隐式提供、**在编辑器里显式可见且无法删除** | `v3-design §11.5/§11.9`、`ast.js`、Blockly 设计 |
| D-101 | **允许 `while(true)`**，但**循环体内所有分支都必须至少包含一个 `action`**（比原"循环体含 action"更严格） | `ast.js` 合法性检测、`08-ai` |
| D-102 | 函数 = **打包好的代码块**，**不支持传参与返回值**（AST 预留字段） | `v3-design §11.8`、`ast.js`、Blockly |
| D-103 | 函数**拥有独立局部变量作用域与调用栈**（可读取外层变量，内部 `var` 不泄漏） | `08-ai`、`runtime.js` |
| D-104 | 运行期仍保留步数上限兜底（D-81） | `08-ai` |

---

## 11. 数据表与 schema（来源：C4b / C6 / C7 / C8 / C9 / BU2 / M15）

| # | 决策 | 影响 |
|---|---|---|
| D-110 | `role-templates.json` **新增必填 `regen` 字段**（每个模板各自的 `{mp, sp}` 基础回复值）+ 插件词条加成 | `v3-design §13.1`、`02-roles`、数据表 |
| D-111 | `skill-templates.json` **新增 `slotWeights`**（basic/special 权重） | `v3-design §13.2`、`01-items` |
| D-112 | 三张主表（角色/技能/插件）**新增可选 `unlockTier`**（缺省视为已解锁） | `v3-design §13.1~13.3`、`01-items`、`09-unlock` |
| D-113 | 技能插件消耗增量**统一为逐档数组** `costDeltaByTier`（如 `{mp:[2,4,6]}`）；各品质基础值递增（绿 2 起） | `v3-design §13.3`、`items-data §2.1/§6` |
| D-114 | 角色插件的百分比/数值变体**拆成独立插件 id**（如 `rp_atk_pct` / `rp_atk_flat`），掉落池与装备逻辑无特判 | `items-data §5`、数据表 |
| D-115 | 各技能参数取整与下限（沿用）：四舍五入；`弹幕数量/射程/位移距离` 下限 1；`冷却` 下限 0；`弹幕等级` 下限 1 | `03-skills`、`items` |
| D-116 | 最大插件点数按 `items-data` 建议值（绿 3 / 蓝 4 / 紫 5 / 橙 6 / 青 7） | `04 品质表`、数据表 |
| D-117 | 新增数据表 **`battle-config.json`**：承载空间/速度/碰撞/防御/超时等全部战斗数值（机制在代码、数值在表） | `P0-6` 新建 |
| **D-118** | **位移模板新增 `bulletLevel` 字段（V-3，已确认）**：位移技沿路径放置的 0 速弹幕需要一个等级来参与抵消判定，故 `skill-templates.json` 的 `displacement` 类型**同样携带 `bulletLevel`**（1~4）；`items-data` §4.4 表格补该列 | `v3-design §13.2`、`items-data §4.4`、`03-skills` |

---

## 12. 产品与流程（来源：R1 / R3 / R4 / R5 / R5b / R6 / WALK / DOC_SYNC）

| # | 决策 | 影响 |
|---|---|---|
| D-120 | 紫（epic）段位解锁：**概率随机 + 扩展运算符** | `unlock.json`、`09-unlock` |
| D-121 | 最大插件点数与 `costDelta` 基础值按 `items-data` 建议值 | 见 D-113/D-116 |
| D-122 | 排位晋升阈值 **x = 6**（胜 > 6，即 10 场胜 7 场）；段位序号即品质上限 | `10-ranked` |
| D-123 | ⚠️ **本轮不做存档**：延后到 P6（localStorage）；**P5 只做算法与接口，段位/仓库由请求传入并回带，不持久化**（**已由 D-129/D-130 部分推翻**：段位/积分/配置槽/战绩改为服务端持久化；仓库仍由客户端持有） | `10-ranked`、`P5 批次`、`R5`、`11-account-store` |
| D-124 | 前端（P6）选型：**无框架**——纯函数 `render(state) → HTML` + 自研 store + 事件委托 | `P6`、`§7 前端规范` |
| D-125 | **走查文档的定位**：只讲**系统间数值与状态传递**（六条边界：数据表→实例、物品→面板、AI→hash、请求→战斗、引擎→帧、引擎→响应）；计算细节由 `examples/*` 负责 | `battle-walkthrough.md` |
| D-126 | ⚠️ **同步重写受影响的设计文档章节**（保持"文档即唯一权威"） | `v3-design`、`systems/*`、`items-data` |
| **D-127** | **`dodge` 附带闪避加成定稿：`dodgeChanceBonus = 0.20`（B21 校准，保持占位值冻结）**——机制语义 = 本 tick 使用 dodge 行动的玩家，闪避判定额外 +20%（叠加在面板 dodgeChance 上，封顶 1）；不再开放 | `battle-config.json`、`07-engine §4.4`、`R17` |
| **D-128** | **数值校准收口（B21）**：① 减伤公式常数入表 `battle-config.defK = 40`（`1 − def/(def+40)`，代码零字面量兜底）；② 附加效果数值定稿——stun `remaining=1`、knockback/pull 位移 `±1 格`、dot `remaining=3`，数值 v 由词条档位给出；③ melee 射程不可增强（登记冻结）；④ regen 差异化维持数据表现值（D-110 必填口径） | `battle-config.json`、`07-engine §4.4`、`03-skills S-6`、`B9/B6/B8 审查遗留` |

---

## 13. 在线服务与存档（来源：ONLINE-1…ONLINE-8，2026-09-16）

> 详细设计见 `docs/systems/11-account-store.md`（本组决策的唯一落地文档）。
> 本组决策**推翻 D-123 的"不做存档"**；D-122（晋升 x=6）与 D-01…D-128 的引擎/数值条款**继续有效**。

| # | 决策 | 影响 |
|---|---|---|
| **D-129** | ⚠️ **服务端持久化玩家档案**（推翻 D-123 的"不做存档"）：段位、积分、配置槽、出战快照、战绩、未读游标落盘；运行时数据根为 `runtime/`（`DL_DATA_DIR`，须 `.gitignore`），`server/data/` 仍只放只读数据表 | `11-account-store`、`server.md`、`10-ranked`、`check-arch.js`、`.gitignore` |
| **D-130** | **混合权威**：仓库/物品/装配仍由客户端 localStorage 持有；服务端保存**出战快照副本**供匹配与回放。**明确登记：段位与积分不具备竞技可信度**（可被伪造 loadout 刷取）；服务端物品账本列为后续阶段 | `11-account-store §1.3/§15.1` |
| **D-131** | **配置槽规则**：每玩家最多 3 套完整配置、同时仅 1 套出战、必有出战配置；注册即下发默认配置（可修改、不可删除）；默认槽与当前出战槽禁止删除 | `11-account-store §5.3`、`interfaces §2` |
| **D-132** | **异步排位**：保留 D-122 的"10 场批次 + 胜 > 6 晋升"；由**发起者触发同步结算**并同时写入双方档案；**被抽取（防守）方只记战绩，段位与积分不变**；防守方在线与否均可被抽 | `10-ranked`、`11-account-store §7`、`interfaces §2` |
| **D-133** | **积分双轨 + 非对称 Elo**：积分从 0 起、上限 3000；加分系数随积分递减、扣分系数随积分递增（对同分对手的均衡点 `R = cap × (2×胜率 − 1)`）；积分只用于快速对战匹配与排行，**与段位互不推导**；结算非零和（存在分数汇，抑制通胀，属有意设计） | `rating-config.json`、`11-account-store §8`、`interfaces §2` |
| **D-134** | **append-only journal + 物化档案**：跨玩家结算必须先写 journal（一次落盘即视为对局成立）再更新双方档案；档案可重建、apply 幂等（`battleId` 内容寻址）、启动自动重放修复，崩溃不得产生"单边记账" | `11-account-store §6`、`server/store/*` |
| **D-135** | **回放只存引用**：journal 记录 `battleId/seed/双方 snapshotHash/configHash/版本戳`，帧不落盘、按需重算；引擎或数据版本不匹配 → `410 replay_expired`；进程内帧缓存改为**有上限 LRU（默认 64 场）**，修掉 `battle.js` REPLAYS 无上限增长 | `11-account-store §9`、`battle.js`、`interfaces §2` |
| **D-136** | **反刷范围**：仅"同一对手 24h 去重（候选不足时放宽至 72h）"；服务端抽池故不可自选对手；每日场次上限与同设备多号检测**预留参数但不启用** | `11-account-store §8.5`、`rating-config.json` |

---

## 14. P7 冲刺：门控关闭、AI 语言收口与可玩性（来源：P7-0 / AI 收口 / DOC_SYNC，2026-09-16）

> 本组决策是**用户 2026-09-16 连续拍板**的结果，落地编排见 `docs/plan-p7-playable.md`（阶段 P7-0…P7-7）。
> 其中 D-137（关段位门控）的**执行**属 P7-0（在途）；D-138…D-145 的**代码已落地**（第二波，已实测）；D-146…D-153 为流程与产品口径。

| # | 决策 | 影响 |
|---|---|---|
| **D-137** | ⚠️ **默认关闭段位门控：所有功能默认全解锁、段位不参与判定**——六处判定（内容解锁 / 物品级 / 开箱品质上限 / 出战配置 / AI 节点 / 装配）一律不做段位判定；**门控逻辑与数据字段保留为可回退开关**（`unlock.json` 的 `gating.enabled`，关/开两模式都保留测试）；**排位晋升与段位奖励暂留**（属进度而非门控）；**快速对战按 Elo 积分匹配**（不用段位） | `unlock.json`（`gating`）、`core/unlock.js`、`core/items.js`、`server/box.js`、`server/loadout.js`、`ai/ast.js`、`09-unlock`、`10-ranked`、`plan-p7-playable §P7-0` |
| **D-138** | ⚠️ **取消"AI 观测弹幕"：从 AI 语言删除 `bullets` 节点与 `bullets[i].*` 路径，快照不再投影 `bullets`**；**"AI 无法观测弹幕"是设计**（弹幕当 tick 全解算完毕，D-20），**非缺陷**；节点数收敛为 **16 类 / `base` 9 / 段位累计 10/12/14/14/16** | `ai-nodes.json`、`ai/ast.js`、`ai/runtime.js`、`runner.js` 投影、`08-ai`、`tasks.md §3.7.2/§3.7.6`、`battle-walkthrough §3.2` |
| **D-139** | **`random` 双语义定稿**：**语句位** = 概率分支（真正进入 `then`/`else` 并执行，跨 tick 可恢复）；**表达式位** = 返回布尔（`true` 概率 = `prob`）；两种用法都只在真正求值时消费一次**每 tick 的 `ai` 流** | `ai/runtime.js`、`08-ai §4.3/§4.4`、`tasks.md §3.7.4` |
| **D-140** | ⚠️ **`aiTrace` 上限改口径：每 tick 上限 2000 条**（不再是"整场累计 2000"）；本 tick 的轨迹**全量**交给 trace 司机，每帧 `aiTrace` 只归属该 tick、不累积不重复 | `ai/runtime.js`（`traceLimit`）、`server/battle.js` trace 司机、`tasks.md §3.7.8`、`tests/api/api-battle.test.js` |
| **D-141** | ⚠️ **超时扣血口径定稿：基地按"自身 `maxHp`"扣，角色仍按"角色 `maxHp`"扣**——消除"角色变强反而更快输"的"变强即变弱"副作用 | `server/core/engine.js` 步骤 11、`battle-config.overtimeRatio`、`07-engine §4.7` |
| **D-142** | **`typeModifiers` 接入开箱生成路径**：角色模板的类型修饰（特化 ±15%、专家 `1.30`+`spread`）在**开箱实例化**时真正生效（此前只有面板层生效 → 11 角色数值同质） | `core/items.js`（生成路径）、`core/roles.js`、`role-templates.json`、`02-roles`、`01-items` |
| **D-143** | **掉落与解锁完全由 JSON 配置**：每项模板/插件自带 `drop` / `dropWeight` / `unlockTier`；**门禁不再锁"数量"**（不再有"某段位只能出 N 项"的隐含约束） | `role-templates.json`/`skill-templates.json`/`plugins.json`、`core/items.js`、`README.md`（server/data） |
| **D-144** | **`schema.js` 只校验结构与机制自洽**：不锁"11 角色 / 10 技能 / 29 插件"等内容条目数量；`_sample: true` 仅用作"示例期望表逐值比对"的开关（去掉标记即跳过逐值比对） | `server/data/schema.js`、`server/data/README.md`、gate 项 4/5 |
| **D-145** | ⚠️ **校验期硬化（四类一律校验期拒绝）**：① `get.path` 白名单（**容器不可当值读**）；② 变量必须先声明；③ 表达式位只允许表达式节点；④ 程序必须含 `action`。**同时保留运行层兜底**（路径缺失/越界 → 安全默认 `0`/`false`，**不抛**）——校验层不替代运行层 | `ai/ast.js`、`ai/runtime.js`、`08-ai §4.2/§4.5/§5`、`tasks.md §3.7.5`、`tests/unit/ai-validate.test.js` |
| **D-146** | **非法动作名走 `warnings`**（**不拒绝**，保持 D-80 的运行期归一化 `wait` + `action.invalid`）；`/api/v1/ai/validate` 与 `/api/v1/ai/compile` 的响应体带 `data.warnings` | `ai/ast.js`、`server/index.js`（ai 端点）、`interfaces §2`、`tasks.md §3.7.5` |
| **D-147** | **AI 快照字段补齐**：新增 `tick`、`self\|enemy.maxHp\|maxMp\|maxSp`、`cooldowns`、`effects[]`、`bases.*`（`bases.self\|enemy.{hp,maxHp,def}`）；**`baseHp` ＝ 该方基地当前血量**（`bases.<owner>.hp`，**≠ 角色最大血量**——两者是完全不同的东西） | `server/runner.js` `projectSnapshot`、`ai/ast.js` 路径白名单、`08-ai §4.5`、`battle-walkthrough §3.2`、`security-backlog SEC-17` |
| **D-148** | **`POST /api/v1/ai/battle` 明确回报未生效动作**：响应含 `actionsEffective` / `ineffectiveActions` 与 `frames[].actions\|events`（非法动作名→`wait` 的归一化不再静默） | `server/index.js`、`server/battle.js`（或 ai 驱动器）、`interfaces §2`、`tests/api/api-ai.test.js` |
| **D-149** | **合并面板实现（消除双写与 shape 分歧）**：`roles.equipPlugins`/`getFinalStats` 与 `loadout.buildPanel` **只保留一套聚合**（单一实现 `items.buildRolePanel`）——**regen 只叠一次**，角色面板 shape 唯一 | `core/items.js`、`core/roles.js`、`server/loadout.js`、`03-skills`（回归用例）、`04 品质表` |
| **D-150** | ⚠️ **测试与流程（三条硬性要求）**：① **只补"黄金战斗回归"**（`tests/regression/golden-battle.test.js`），**不补空的 `tests/contract`/`tests/property` 目录**（空目录会静默通过）；② **每个阶段/新功能完成后必须做一次独立"代码级审查"并修复**（检查**功能完整度 / 空实现 / 冲突重合**）；③ **测试体系需审查冗余与缺口**（冗余项合并、缺口补齐，不得只增不减堆用例） | `tests/regression/golden-battle.test.js`、`tasks.md §5.1 第 5 条`、`plan-p7-playable §0.7/§P7-7`、`progress.md` |
| **D-151** | **可玩性工具**：新增 `npm run play`（`node scripts/play.js`，**离线文本闭环**：开箱→装配→预设 AI→面板→战斗→逐 tick 战报）；`cli replay` 增加**伤害数字与暴击/背击标注** | `scripts/play.js`、`cli/index.js`（replay）、`README.md` 命令表、`plan-p7-playable §交付定义` |
| **D-152** | ⚠️ **真实玩家匹配，禁止占位 bot 敷衍**：匹配池**只能**由真实玩家档案（真实注册、真实出战配置、真实 AI 快照）构成；池内候选不足时**少打几场并回报 `shortfall`**，**不得**用 bot 补齐凑场次；既有 bot 补齐逻辑须移除或降级为"默认关闭的显式调试开关 + 日志标注" | `plan-p7-playable §P7-3/§P7-6`、`10-ranked §4.3`、`server/ranked.js`（P7-3 实施）、`11-account-store` |
| **D-153** | **安全与防作弊登记册口径**：`security-backlog.md` **只登记不修复**（不派发任务、不改门禁）；但**被顺手修掉的条目必须更新"现状证据 + 状态"**（标为**已处置 / 已部分处置**并留证据与日期） | `docs/security-backlog.md`（SEC-03/SEC-17/SEC-19 等）、`progress.md` |

> **流程补充（D-150 的落地细则）**：独立"代码级审查"的**逐条检查表**（功能完整度 / 空实现与占位 / 冲突与重合 / 副作用与回归 / 独立执行者 + 文件:行证据）见 `docs/plan-p7-playable.md` §0 第 7 条与 `docs/tasks.md` §5.1 第 5 条——**每个阶段/新功能完成后执行，问题当阶段修复**。

### 14.1 P7 收口补充（2026-09-19 追加，D-154…D-157）

> 用户 2026-09-19 拍板/确认的 4 条收口口径，**只追加、不改 D-137…D-153 既有条目**。其中 D-155/D-156 是 D-101/D-139 的**补充**（原条目文字保持不变）；D-154 是本次唯一的**战斗数值口径变更**。

| # | 决策 | 影响 |
|---|---|---|
| **D-154** | ⚠️ **持续效果双语义定稿（面板修饰 vs 资源池流量）**：`atk`/`def` 属**面板修饰**——每 tick 累加**实际生效**增量（含 clamp 修正），到期**回滚累计增量**（下限 0，整段生效期**净 0**，严格回到施放前）；`hp`/`mp`/`sp` 属**资源池流量**——结算即生效、**到期不回滚**。`cast_buff` 因此为 **`atk` 每 tick +2、`duration=2`（生效窗口 t+1/t+2）**，到期回滚净 0，**不再是永久增益**。复算：E-2d 轨迹 8 → 12 → **20**（第二个效果到期回滚 −4）→ **8**（第一个到期回滚 +18）（`tests/unit/effects.test.js` EF-3/EF-14/EF-17/EF-18/EF-19） | `systems/05-effects.md` §3/§4.3/§5/§7、`examples/05-effects.md` E-2d、`items-data.md` §特殊词条、`systems/03-skills.md` §4.7、`server/data/plugins.json`（`cast_buff` desc）、`server/core/effects.js` |
| **D-155** | **D-101 补充（可达性收紧）**：条件为**字面量为假**（`false`/`0`/`''`/`null`）的 `if`，其 `then` 分支**静态不可达**——其中的 `action` **不计入**可达 action，也不使所在函数成为"行动产出函数"（`function g(){ if(false){ action wait } }` + `while(true){ call g }` → 校验期 `branch_without_action`，`path` 指向循环体）；truthy 字面量与非字面量条件保持原保守口径。**D-101 的"不会出现空死循环"应理解为「循环体内不会出现无 action 的空死循环」**；**残余（不变）**：`no_action_program` 仍只数"是否存在 action"，**顶层** `if(false){action}` 空转仍通过校验，运行期由**步数上限兜底**（D-81：同 tick 返回 `wait` + `stepLimited`、trace 截断 2000） | `server/ai/ast.js`、`systems/08-ai.md` §4.2、`tests/unit/ai-validate.test.js` |
| **D-156** | **D-139 补充（`random` 位置语义与 `else` 必填）**：**仅语句位** `random` 适用 D-101 分支行动规则（`then`/`else` 各需可达 action）；**表达式位**（`set`/`var` 的值、`if.cond`、`loop.cond`、运算子节点）只取 `prob` 求布尔，`then`/`else` **不参与求值**、**不适用**该规则（校验期仍扫描其结构错误）。`random.else` 为**校验期必填**（缺失或 `null` → `bad_field`，`path` 指向该 `random` 节点），**运行期仍容忍缺省**（按空分支跳过，与 `if` 缺 `else` 一致）——分层原则：校验层拒绝 + 运行层兜底 | `server/ai/ast.js`、`server/ai/runtime.js`、`systems/08-ai.md` §4.2/§4.3、`tests/unit/ai-validate.test.js`、`tests/unit/runtime.test.js` |
| **D-157** | ⚠️ **匹配池与实例化必须共用同一"可用性"判定**：`/ranked/run` 与 `/quick/run` 的**抽池筛选**与**最终实例化**必须使用同一判据（快照可实例化 + 装配引用有可用仓库镜像）——实现为 `ranked.sideInstantiable(loadout, warehouse, tier)`（与 `battleOne` 同一 `battle.buildPlayer` 实现），两处共用。两处口径不一致会产生"抽得到、打不了"的含混失败（`/quick/run` 曾在"发起者带装配引用 + 抽到默认配置对手 + 进程内镜像缓存缺失"下返回 `409 no_opponent`，**同日已修复**，回归用例 `tests/unit/quickmatch-availability.test.js`）。**任何情况下不得用 bot 凑数**（D-152）；池不足只如实回报 `shortfall`（排位）或 `no_opponent`（快速） | `server/quickmatch.js`（`candidatePool` / `run`）、`server/ranked.js`（`sideInstantiable`）、`systems/10-ranked.md` §4.3、`progress.md` |

### 14.2 F2 管理面补充（2026-09-22 追加，D-158）

> 用户 2026-09-22 就"登录界面显示全部账号 + 删除任意账号"给出的口径：**只做后端已有能力**；引入**管理员账号**（普通账号只显示正常功能）；账号列表**不要上限、要分页**；管理员令牌**仅内存**；并附一条硬要求：**后端以后新增 admin 能力时，管理面板必须同步**。

| # | 决策 | 影响 |
|---|---|---|
| **D-158** | ⚠️ **管理面访问模型与两项新契约**：<br>① **管理员身份** = `DL_ADMIN_USERS`（逗号分隔的**用户名**或 **publicId**/`playerId`，大小写不敏感；空 = 无账号级管理员）；判定唯一处 = `server/admin.js` 的 `adminUsersOf(env)` + `isAdminPlayer`，经 `server/index.js` 注入 `auth` 的用户名索引比对；`register`/`login` 响应回带 `data.player.isAdmin`，`GET /me` 回带 `data.flags.isAdmin`。<br>② **`POST /api/v1/admin/:op` 访问判定**（`checkAccess`）：**管理员账号（Bearer）优先放行**，否则回落既有令牌路径（`X-Admin-Token`/Bearer == `DL_ADMIN_TOKEN`；未配置 → 503 `admin_token_missing`，不匹配 → 403 `forbidden`）——两者语义均不改变，`DL_DEBUG_BOTS` 仍只对 `bots` 构成第二道门控。<br>③ **新增 `POST /api/v1/admin/accounts`**：`{offset,limit}` → `{total,offset,limit,hasMore,rows[]}`；**`total` 为全量、无 100 条上限**（分页取完即"显示全部"）；单页 `limit` 缺省 20、上限 200；数据源 = 索引条目（不加载档案）；排序 `updatedAt` desc → `publicId` asc（稳定分页，无遗漏无重复）；`playerId` 属 admin 通道（玩家侧响应才脱敏）。<br>④ **新增 `POST /api/v1/admin/delete-account`**：`{playerId|publicId}` → `store.removeArchive`（写 `player.removed` 墓碑，防 journal 重放复活）；**禁止删除自己**（409 `cannot_delete_self`）；未知 → 404 `store_not_found`。<br>⑤ **越权检查例外**：`runEntry` 的"请求体 `playerId` 必须与令牌一致"检查**不施加于 admin 面**（管理面以他人为操作对象是设计意图，其授权由 `checkAccess` 承担）。<br>⑥ **前端硬要求（可机器判定）**：后端 admin 能力集合与前端管理面板注册表必须**双向相等**（`tests/frontend/admin-op-parity.test.js`）——后端新增 op 而面板未同步即 FAIL | `server/admin.js`（`adminUsersOf`/`isAdminPlayer`/`checkAccess`/`accounts`/`deleteAccount`）、`server/index.js`（`withIsAdmin`/`adminOp`/越权例外）、`docs/interfaces.md` §2/§2.1/§7、`docs/server.md` §2/§3.2、`docs/frontend/02-accounts.md`、`tests/api/api-admin-accounts.test.js`（AA-1…AA-7） |

---

## 15. 待补充的数值（B21 已统一校准，见 D-127/D-128）

- 已随 B21 校准定稿：`movePx=64`、`dodgePx=128`、`collisionDmgMul=0.8`、`baseHitMul=0.8`、`defendDefMul=1.6`、`dodgeChanceBonus=0.20`（**D-127**）、`defK=40`（入表，**D-128**）、`overtimeRatio=0.0625`、`overtimeStart=48`、`hardCapTick=64`、`baseDef=64`、`backstab=1.5`、`crit=1.5`——全部冻结于 `battle-config.json`，**不再开放**。
