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

### 14.3 F3 物品线与在线服务（2026-09-22 追加，D-159…D-162）

> 用户 2026-09-22 就"玩家主界面 + 仓库 + 开箱 + 出战配置"给出的口径（逐条问答共 30+ 项，`docs/frontend/03-hub-warehouse-loadout.md` 为冻结稿）：**仓库改由服务端权威**；注册即发新手套装并建满三个配置槽；**非出战配置允许不完整**、出战才校验；新增 **AI 库**；**开箱随机性收归服务端**（接口不设 `seed`）。

| # | 决策 | 影响 |
|---|---|---|
| **D-159** | ⚠️ **仓库改为服务端权威（推翻 D-130 的"仓库/物品/装配由客户端 localStorage 持有"）**：<br>① 档案新增 `warehouse` 段（四桶 `role/skill/rolePlugin/skillPlugin`，**每桶上限 500**，值入 `service-config.json` 并由 schema 冻结）+ `ai` 段（AI 库，见 D-161）；`ARCHIVE_VERSION` 1 → **2**，`migrateV1toV2` 为存量档案补**空**仓库（**老账号保持空仓**，需删号重注册才能拿到 starter）。<br>② `GET /api/v1/me/warehouse` = **真源**：`{buckets, usage, caps, counts, starterIssued}`；`usage[uid].slotIds[]` 标记"该物品被哪些出战配置引用"（~~**同物品可被多配置引用**~~ —— **已被 D-163 推翻：一件物品同时只能被一份配置引用**，故该数组至多一项）。旧契约的"未提交镜像 → 404 `warehouse_missing`"作废。<br>③ 新增 `POST /api/v1/me/warehouse/assemble`（体 `{targetUid,pluginUid,slotIndex}`）与 `disassemble`（体 `{targetUid,slotIndex}`）——**服务端态**（不再在请求里传整仓）；校验仍由 `core/items` 纯函数单点完成，落 **journal 增量记录**（`warehouse.assemble`/`warehouse.disassemble`）以便恢复/重放。<br>④ `PUT /api/v1/me/warehouse` **退役**为"只校验形状"：形状非法仍 400，引用不覆盖出战配置时**不再 409**，改 200 + `verified:false`（旧客户端不至于卡死）；`GET` 不再读镜像。<br>⑤ **注册即发 starter**（`server/starter.js`，种子由身份派生、内容级确定性）：1 角色（**必带 ≥1 插槽**）+ 3 技能 + 1~2 角色插件 + 1 技能插件，**按实际槽类型筛选并已装配**；写入服务端仓库、装配进 `slot1`（默认配置、出战），**并建满 3 个槽**（`slot2`/`slot3` 为空槽，见 D-160）；同时登记库内默认 AI（`name='新手AI'`，`aiId` 写入 `slot1.loadout.aiId`）。<br>⑥ 出战配置的引用校验**优先用服务端仓库**；`loadWarehouse` 首选服务端仓库（不覆盖时才回落账号级镜像/进程内缓存/快照自带子集）；快照的 `warehouseExcerpt`（缺口 1 的时代产物）保留但不再是必需。<br>⑦ **作弊面关闭**：`systems/11-account-store.md` §15.1 登记的"改两行 JS 即可携带任意属性 loadout"随本决策失效，`security-backlog.md` 相应条目回填。 | `server/store/{archive,adapter-json,ledger,journal,errors,config,index}.js`、`server/starter.js`（**新**）、`server/account.js`、`server/index.js`、`server/data/{service-config.json,schema.js}`、`docs/interfaces.md` §1/§2/§2.1/§4/§5/§7、`tests/unit/starter.test.js`、`tests/api/api-me-warehouse.test.js`、`tests/api/api-me-box.test.js` |
| **D-160** | ⚠️ **配置完整性校验时机 + 三个槽的初始形态**：<br>① `PUT /api/v1/me/configs/:slotId`：**非出战槽允许不完整**（缺角色/技能/AI 均可）→ 200，**不冻结快照**、`loadout` 正文随 journal 记录落盘，响应 `snapshot:null` / `complete:false` / `missing:[…]`；**出战槽仍要求完整**（角色 + **恰 3 技能** + AI；**允许插槽为空**），不完整 → 409 `loadout_invalid` + 逐位置 details。<br>② `POST /api/v1/me/configs/:slotId/activate`：**此时**才校验完整性 → 不完整 **409 `cannot_activate_incomplete`**（新增错误码）；完整但缺快照者**自愈冻结**（不再返回 `no_active_config`）。<br>③ `POST /api/v1/me/configs`：改为**创建空槽**（**不再复制出战配置**），仍受 `maxSlots=3` / `slot_limit` 约束；注册时由 D-159⑤ 一次建满 3 槽。<br>④ 语义闭环（用户口径）：唯一出战 + 两个备用；**出战中的配置只能替换模板、不能拆卸**（由①的完整性约束天然保证）；非出战可直接拆空；拆模板后该模板与其插件回到"未出战"（仓库 `usage` 不再标记）。**口径澄清（独立审查后补）**：`usage` 覆盖**全部配置**的引用（不区分该配置是否出战），与 D-159② 的"该物品被哪些出战配置引用"是同一件事——"未出战"指**没有配置引用它**。 | `server/store/{archive,adapter-json,ledger,errors}.js`、`server/account.js`、`docs/interfaces.md` §2/§2.1/§4、`tests/api/api-configs-incomplete.test.js` |
| **D-161** | ⚠️ **AI 库（本批仅后端；前端只用列表）**：新增 `GET /api/v1/me/ai`（`{items:[{aiId,name,program,createdAt,updatedAt}], count, max:100, usage}`）、`POST /api/v1/me/ai`（`{name, program}`，名称 1~24 字符、`program.type==='program'`；成功回 `{aiId,ai,count,max}`）、`DELETE /api/v1/me/ai/:aiId`（回 `{deleted,referencedBy,count,max}`）。**上限 100 与物品分别计数**，满 → 409 `ai_limit`；**可删任意 AI，但被「出战配置」引用者 → 409 `ai_in_use`**（`loadout.aiId` 命中 `activeSlotId`；非出战配置的引用只在响应 `referencedBy` 里提示）。档案 `ai` 段入库；journal 记录 `ai.created`/`ai.deleted`。**本批不做完整 AST 校验**（由 F5 编辑器保存前调 `POST /ai/validate`），只做结构检查。 | `server/store/{archive,adapter-json,ledger}.js`、`server/account.js`、`server/index.js`、`docs/interfaces.md` §1/§2/§2.1、`tests/api/api-me-ai.test.js` |
| **D-162** | ⚠️ **开箱随机性收归服务端（修订 T-AP-5）**：HTTP 接口 **`POST /api/v1/box`（遗留）与 `POST /api/v1/me/box`（新增，服务端权威、物品入档）都没有 `seed` 入参**——客户端传了会被**忽略**（不再有 `bad_seed`），seed 一律由服务端生成（响应可回带，仅供审计/复现日志）。理由（实测）：seed 由客户端可控时"找到一个好 seed 就能无限复制同一批好货"（`docs/frontend/03-hub-warehouse-loadout.md` §0 探针 5：同 seed 内容逐字段相同、`seed=7` 一次开出 3 件 legendary 且可无限重复）。进程内确定性保留：`server/box.js` 的 `openBoxes({seed})` 仍接受显式 seed（离线 `npm run play`/`demo`/核心单测不受影响；**显式提供非法值（非整数/越界）仍如实 400 `bad_seed`**，`null`/`undefined` 才算"未提供"），HTTP 侧改由**实例级注入缝 `start({boxSeed})`** 提供确定性序列（第 n 次 = `boxSeed+n−1`；**序列按调用次数推进，含被 4xx 拒绝的调用**——独立审查口径澄清）；CLI `box` 移除 `--seed`（给了即参数错误 exit 2）。 | `server/box.js`、`server/index.js`、`cli/index.js`、`docs/interfaces.md` §2/§7、`tests/api/api-box.test.js`、`tests/api/api-me-box.test.js` |
| **D-163** | ⚠️ **出战配置的物品身份/数值一律来自服务端权威仓库 + 一件物品同时只能属于一份配置（2026-09-25 热修；由用户实测报告触发，用户裁定跨配置独占）**：<br>① **解析**：`PUT /me/configs/:slotId`、`POST /me/configs`、`POST …/activate` 一律按 uid 从**服务端仓库**取回物品（`server/loadout.js` 的 `resolveItems`），客户端正文里的 `stats`/`templateId`/`quality`/`params`/`slots` **全部丢弃**；uid 不在仓库 → 409 `loadout_invalid`（`物品不在仓库: <uid>`）。`loadout.buildPanel` 在拿到仓库时同样先解析（纵深防御：历史遗留的被篡改快照也不能把数值带进战斗）。<br>② **同一份配置内唯一**：角色 + 3 技能 + 全部插件引用的 uid 必须两两不同（`同一物品被多处引用` / 既有 `同一插件被双处引用`）；`skills.length > 3` 直接 409（不再静默截断）。修前只查"插件被双处引用"，故一件**无插件**的技能物品可以占满同一份配置的 3 个技能位（连出战槽都 200）。<br>③ **跨配置独占（用户 2026-09-25 裁定）**：一件物品同一时间只能被**一份配置**引用；保存/设为出战撞车 → **409 `item_in_use`**（`物品 <uid> 已被配置 <slotIds> 使用：一件物品同时只能装配到一份配置（请先在那边替换或拆卸）`，details 逐 uid）。`usage[uid].slotIds` 因此至多一项 —— **推翻 D-159② 的"同物品可被多配置引用"**。<br>④ **非出战槽仍允许不完整（D-160 不变）**，但只容忍"缺失类"错误；引用类错误（悬挂引用/未装配/类别不符/未知 uid/未知模板）任何情况下都拒绝（修前 `errors.length === 0` 前置条件让不完整配置**整段跳过**引用校验 → 可落盘悬挂/未装配的插件引用）。<br>⑤ **不再信任客户端仓库镜像**：HTTP 配置路由不再把 `body.warehouse` 传给保存/创建；解析与校验以服务端仓库为准（客户端镜像仅在服务端存储不可用时降级使用并记 `warn`）。<br>⑥ **开箱发放 uid 冲突**：物品 uid 由 core 的**进程级**递增计数器生成，进程重启后归零 → 同一玩家跨重启领到的物品会与旧物品撞 uid，而 apply 分支修前**静默丢弃**该件（实测：真重启后开箱 12 件，响应/journal 记 12 件、档案只落 2 件、**日志 0 条**；而前端提示"已入服务端仓库"）。现在由 `store.grantBox` 在**写 journal 之前**调用 `archive.allocateGrantUids` 把撞车 uid 重映射为仓库内空闲 uid（响应 = journal = 档案），并把闸门处丢弃改为 `error` 日志 + `dropped` 入 `grantIds` 审计。<br>**动机与证据**：独立复核实测 —— `PUT` 一件 `stats={hp:100000,atk:99999,def:99999}` 的"角色"（甚至 uid 完全不在仓库）→ **200**；`activate` → **200**；服务端留存与出战快照里就是这些数值；用服务端自己的 `battle.buildPlayer` 建玩家 → `maxHp=100000`；而 `quickmatch.js`/`ranked.js` 用的正是 `snapshot.loadout` → **真实对局可被打穿**。`security-backlog` 的 SEC-07 因此**复开 → 已修**。 | `server/loadout.js`、`server/account.js`、`server/store/{archive,adapter-json,errors}.js`、`server/index.js`、`server/ranked.js`、`scripts/play.js`、`public/format.js`、`docs/interfaces.md` §2/§2.1/§5、`docs/server.md`、`docs/security-backlog.md`、`docs/frontend/03-hub-warehouse-loadout.md` §3.7/§4/§6/§15.8、`tests/api/*`、`tests/unit/*`、`tests/frontend/config-editor-flow.test.js`、`tests/integration/e2e-play.test.js` |

---

### 14.4 战斗线后端修复（2026-09-25 追加，D-164…D-166）

> 用户 2026-09-25 就"快速对战与锦标赛"给出的口径（逐条问答见本轮会话）：**守方 AI 必须镜像**；回放只表现战斗、不含日志；注入的 bot 必须是**完整账号 + 完整战斗 AI**；24h 硬底线改为**4 小时线性软冷却**；胜负对外统一 `p1/p2/draw/invalid`；管理员可直接改任意账号段位/积分（留痕）。本节记录其中**已落地**的三条（其余见后续追加）。

| # | 决策 | 影响 |
|---|---|---|
| **D-164** | ⚠️ **守方 AI 完整镜像（"每个玩家都在自己的 p1 坐标系里思考"）**：玩家编写的出战配置 AI **一律按 p1（左、facing=+1）帧书写**；服务端在 **p2 侧**给 AI 一份**镜像快照**（`x' = fieldPx − x`、`facing' = −facing`、`effects[].displacement' = −displacement`），并把其产出的**方向动作反镜像**回真实世界（`move_left↔move_right`、`dodge_left↔dodge_right`；`turn` 自反、`wait`/`defend`/`skill:<槽位>` 不映射）。唯一实现处 = `server/runner.js` 的 `mirrorSnapshot`/`unmirrorAction`/`makeAiDriver`，由 `server/battle.js`（`/battle` 与回放重算）与 `server/ranked.js`（`battleOne`，排位/快速共用）调用——**禁止两处各写一份**。<br>**为什么不是"只翻动作名"（实测反例）**：出厂默认/新手 AI（`ranked.buildDefaultLoadout`，所有新号与 bot 都用它）用**有符号距离** `enemy.x − self.x` 选绝对方向，两侧本来就自洽；只翻输出动作会让它当守方时**掉头退回自己基地角、整场不开火**（实测 2 账号受控局：p2 由 800 退到 992，进攻方满血）。而**完整镜像**对这类方向无关程序是**恒等变换**（实测同 seed 逐 tick 帧完全一致 ⇒ 不改动任何既有对局/黄金/压测结论），却能让"按 p1 坐标写死方向"的玩家程序（永远 `move_right`、`self.x<500 → move_right`、看 `facing` 转身）在守方位**正确迎战**（实测：`永远 move_right` 当守方由"退到墙角被打死"变为"逼近至 480 并交战"）。<br>**范围**：仅玩家配置 AI；内置对手 `OPPONENTS`（写死 p2 语义、不经 `runtime.resume`）与 `/ai/battle` 的 p2 **一律不镜像**（实测 charger 仍直扑 p1）。<br>**帧与档案一律保留真实坐标**（镜像只作用于 AI 视角），侧位呈现由前端按 side 处理。 | `server/runner.js`（`mirrorSnapshot`/`unmirrorAction`/`makeAiDriver`/`MIRROR_ACTION`）、`server/battle.js`、`server/ranked.js`、`docs/interfaces.md` §1/§5、`docs/systems/08-ai.md`、`tests/unit/ai-mirror.test.js`（M-1…M-7）、`tests/cli/cli-replay.test.js`（夹具按新契约改写为 p1 帧） |
| **D-165** | ⚠️ **回放重算的仓库覆盖判据与 `resolveItems` 同谓词 + 注入 bot 携带真实仓库（修 P0：bot 对手回放 100% 410）**：<br>① 新增 `server/loadout.js` 的 `warehouseResolves(loadout, warehouse)`——要求**角色 + 3 技能 + 全部插件引用**都能在库中按 uid 命中（与 `resolveItems` 同一谓词）；`server/index.js` 的 `rt.loadWarehouse` 各来源改用该判据（修前用 `ranked.warehouseCovers`，**只看 `pluginUid`**）。<br>② `server/admin.js` 的 `injectDebugBots` 注入时把 `ranked.syntheticVerifiedWarehouse(loadout)` 作为 `warehouse` 写入档案（并随快照冻结）。<br>**根因（实测定位到行）**：bot 档案仓库为空且其 loadout 无插件引用 ⇒ 只查插件的覆盖判据**空转通过** ⇒ `loadWarehouse` 返回"真值但空"的仓库 ⇒ 回放重算时 `resolveItems` 报 `物品不在仓库: bot_role` ⇒ 410 `replay_expired：快照无法实例化（loadout_invalid）`。实测真人 vs bot 排位 **10/10 场回放全部 410**，而同一对局用 `p2Warehouse=null` 或合成仓库复算均 **200**。真人 vs 真人不受影响（服务端权威仓库完整）。**语义边界**：`syntheticVerifiedWarehouse` 只用于**服务端自签发的 bot 配置**；真人仍走服务端权威仓库，D-163 的"客户端数值不可信"不受影响。 | `server/loadout.js`（`warehouseResolves`）、`server/index.js`（`loadWarehouse`）、`server/admin.js`（bot 仓库）、`docs/interfaces.md` §1/§5、`tests/api/api-replay-bot.test.js`（RB-1/RB-2/RB-5） |
| **D-166** | ⚠️ **注入 bot 的多样化与预设参数（修"互打恒平局"）**：`POST /api/v1/admin/bots` 的 bot **逐个按自己的 `botKey` 派生**默认配置（`ranked.buildDefaultLoadout({botKey})`，3 族 × 3 子变体共 9 个程序），不再让整批共用同一个 `steady/0`；新增可选入参 **`preset`**（`steady`/`aggressive`/`kite`，非法 → 400 `bad_request`），用于按强弱造池；显式传入 `loadout` 时仍按调用方给定（逐条相同）。响应新增回带 `preset`。<br>**动机（实测）**：修前一批 bot 的 AI 程序逐字节相同 ⇒ bot 互打**恒平局**（实测 10 场 0 胜 10 平、每场 38 tick），使段位晋升（10 场胜 >6）与积分验收**无法进行**。 | `server/admin.js`、`server/ranked.js`（`buildDefaultLoadout(identity, options)` 支持 `preset`/`sub`）、`docs/interfaces.md` §2/§5、`docs/server.md` §3.2、`docs/systems/10-ranked.md`、`tests/api/api-replay-bot.test.js`（RB-3/RB-4） |

---

### 14.5 战斗回放帧契约（2026-09-25 追加，D-167）

> 用户 2026-09-25 就"匹配后要拿到完整战斗过程供前端表现"给出的口径：**回放帧 = 画面数据 + 双方 AI 轨迹，不含日志**；**帧瘦身**（实测日志占 76–84%）；**匹配响应内联全量帧**；日志改由**管理员调试接口**提供；**aiTrace 永远双方都给**（前端只画自己一侧）。

| # | 决策 | 影响 |
|---|---|---|
| **D-167** | ⚠️ **回放帧契约重构：画面数据自足 + 双方 aiTrace + 日志出帧 + 匹配内联全量帧**：<br>① **引擎 `diff` 扩充（画面自足）**：`players.<side>` 补 `maxHp/maxMp/maxSp/atk/def`、`defending/dodging/fullDodge`、`action{kind,dir?,sid?,cells?}`（**本 tick 实际提交的行动**，`kind ∈ move/dodge/forced_move/cast/displacement/defend/turn/wait`）、`effects[]`（buff 摘要，与 AI 快照同形状）；`bases.<side>` 补 `maxHp`；**新增 `baseHits[]`**（玩家撞基地，**修掉"同 tick 双方各撞基地只结算一侧"的旧缺陷**）与 **`damages[]`**（`{target,amount,atX,kind,srcUid,attacker,crit,critM,backstab,backM,dodged}`，`kind ∈ bullet/collision/base/overtime`）；`bullets[]` 由"仅生成记录"升级为**完整生命周期**（`spawnX/endX/outcome:'hit'\|'collide'\|'expire'/hitTarget/collideWith/collideWinner/collided/expired`，含 `v/len`）。<br>② **对外帧剥掉 `events`**（引擎日志流仍在引擎/L4 内部保留，供 demo/CLI/审计）：实测日志占整场 **76–84%**（每 tick 14 条 `tick.step` 等），与"表现战斗过程"无关；帧体量由 92–219 KB/场降至 **10–21 KB/场**（10 场约 0.1–0.2 MB，而旧口径约 2 MB）。<br>③ **`aiTrace` 永远返回双方**（**推翻 §9.4 的"只给请求方一侧"**）：前端绘制只画自己一侧即可；`?trace=self\|all` **废弃**（参数被忽略）。**已接受风险**：玩家可见对手 AI 的逐步执行轨迹与条件值（程序源码仍不外泄）——登记为 SEC-33。<br>④ **新增 `GET /api/v1/replay/:id?frames=debug`**（`DL_ADMIN_TOKEN`/`DL_ADMIN_USERS`）：返回**含 `events`** 的原始帧，并可越过参与者鉴权排查他人对局（每次访问记 `store.abuse.suspect` 审计）；非法 `frames` 值 → 400 `bad_request`。<br>⑤ **匹配响应内联全量帧**：`POST /quick/run` → `data.frames`；`POST /ranked/run` → `results[].frames`（幂等重放 `duplicate` 场次不回带，客户端按 `battleId` 走 `GET /replay/:id`）。帧由 `ranked.battleOne` 直接产出并经 `battle.toFrames` 投影 ⇒ **不写 `battle.REPLAYS` 注册表**（无上限增长与本条无关）。**同时修掉 `battleOne` 不传 `aiTrace` 缓冲导致内联帧 trace 恒空**的缺陷。<br>⑥ 引擎 `diff` 仍逐帧携带 `events`（契约未变）；审计工具 `.audit/replay-audit.js` 改为：`events` **可选**（缺失则跳过 cid 检查），并把原"命中帧链基于日志"的检查改写为**基于帧内结构**（`bullets.outcome=hit → bulletHits → damages.srcUid` 三方一致 + **hp 下降必须被 damages 归因** + `hp ≤ maxHp`） | `server/core/engine.js`（diff/baseHits/damages/bullets 生命周期/action/effects）、`server/battle.js`（`toFrames`：默认剥 events，`keepEvents` 供调试）、`server/ranked.js`（`battleOne` 回带 frames + aiTrace 缓冲）、`server/quickmatch.js`（响应内联 frames）、`server/index.js`（`frames=debug` + 去 trace 裁剪）、`cli/index.js`（回放改读 `damages`）、`.audit/replay-audit.js`、`docs/interfaces.md` §2/§4.3/§5、`docs/systems/07-engine.md` §4.8、`docs/server.md` §11、`docs/security-backlog.md` SEC-33、`tests/api/api-match-frames.test.js`（MF-1…MF-3）、`tests/unit/replay.test.js`、`tests/api/api-battle.test.js`、`tests/api/api-battle-legacy-replay-trace.test.js`、`tests/api/api-replay-auth.test.js`（RP-7 重写）、`tests/cli/cli-replay.test.js`、`tests/cli/cli-battle.test.js` |

---

### 14.6 匹配冷却与胜负口径（2026-09-25 追加，D-168）

> 用户 2026-09-25 口径：**"不加硬底线。对手冷却只是减少匹配到的概率，逐时间恢复。4 小时从 0 到 100% 回满。不要 24 小时了"**；以及 **"winner 统一成 p1/p2/draw/invalid"**。

| # | 决策 | 影响 |
|---|---|---|
| **D-168** | ⚠️ **软冷却取代 D-136 的 24h 硬底线与 strict/relaxed 双池**：<br>① **语义**：任何在池候选**永不因"最近打过"被硬拒**；只有**权重**随"距上次交手的时间"**线性回满**：`weight = clamp(已过小时 / recoveryHours, 0, 1)`（从未交手 = 1，刚交手 = 0）。`recoveryHours` = 新配置键 **`opponentRecoveryHours`（默认 4）**，落 `rating-config.json`（+ `service-config.json` 的 `pool` 同键、`store/config.js` 默认值、`schema.js` 冻结值与形状校验）；**`opponentCooldownHours` 键删除**。<br>② **选择**：**加权轮盘抽签**（rng 由匹配 seed 派生 ⇒ 同 seed 同结果、可复现）；排位批次内**不重复**（逐个抽签后移除）；**全员权重为 0**（池子极小、都刚打过）→ 在"最久未打"一组内抽签，**永不 `no_opponent`**（`no_opponent` 只可能来自"池内无候选"）。实现**唯一处** = `server/ranked.js` 的 `cooldownWeightOf`/`pickByCooldownWeight`/`drawByCooldown`，`server/quickmatch.js` 直接复用（`splitByCooldown`/`COOLDOWN_RELAX_MULT`/`argminGroup` 一并删除）。<br>③ **响应**：`relaxed` **字段删除**（`/quick/run` 与 `/ranked/run`；journal 的 `ranked.batch` 也不再写该字段、旧记录里的被忽略）；`shortfall` **保留**（池不足如实回报，禁止 bot 充数 D-152）；新增回带 **`recoveryHours`**（ranked）与 **`opponentWeight`/`recoveryHours`**（quick），便于前端解释"为什么最近总碰到这批人"。<br>④ **已知代价（用户知情后接受）**：薄池下可反复匹配同一对手 ⇒ 排位晋升可被"刷"（登记 `security-backlog` **SEC-34**）。<br>**证据/实测**：`tests/unit/quickmatch-elo.test.js` T-QM-4/T-QM-4b（权重线性回满、权重 0 在有恢复候选时**确定性地**不被抽中、全员 0 时永不 no_opponent、同 seed 可复现）、`tests/unit/ranked.test.js` T-RK-4a/T-RK-4b（12 候选 10 场、权重 0 者不入选、批次内不重复、回满后权重 1）、`tests/unit/quickmatch.test.js` T-QM-R7、`tests/integration/e2e-play.test.js` E2E-5（第二轮不再 0 场、被抽场次按两轮累计）、`tests/integration/load-integrity.test.js`（不再有 ceil(N/2) 上限）。 | `server/ranked.js`、`server/quickmatch.js`、`server/store/{config,ledger}.js`、`server/data/{rating-config,service-config}.json`、`server/data/schema.js`、`docs/interfaces.md` §2/§4.11/§5、`docs/systems/10-ranked.md`、`docs/systems/11-account-store.md` §7.2/§8.2、`docs/server.md`、`docs/security-backlog.md` SEC-34、`tests/helpers/ranked.js`、`tests/unit/{ranked,quickmatch,quickmatch-elo,store-config}.test.js`、`tests/integration/{e2e-play,load-integrity}.test.js` |

---

### 14.7 胜负口径统一（2026-09-25 追加，D-169）

> 用户 2026-09-25 口径：**"写成统一逻辑。统一成 p1/p2/draw/invalid。每场战斗结束后给双方玩家发送同一个回放。（防守方会看到自己在 p2，进攻方看到自己在 p1）"**

| # | 决策 | 影响 |
|---|---|---|
| **D-169** | ⚠️ **对外"谁赢了"一律 `p1/p2/draw/invalid`（绝对口径）；档案内的"我赢了几场"保留 `win/loss/draw`（玩家视角）**：<br>① **统一处**：`POST /quick/run` 的 `data.winner` 由**请求者视角** `win/loss/draw` 改为**绝对口径** `p1/p2/draw`（与 `/ranked/run` 的 `results[].winner`、回放帧 `verdict.winner`、journal `battle.recorded.verdict.winner` 完全一致——后三者**本来就是**绝对口径）。<br>② **不动的部分（刻意保留）**：`journal`/档案里**每个玩家自己的** `result` 仍是 `win/loss/draw`（`stats.attack/defense` 直接累加它；`/me/records`、`/me/defense`、`recent[]`、Elo 结算输入都依赖"我这局赢了没"）——改成 `p1/p2` 会让"我赢了几场"无法直接累加，且需要迁移全部历史档案与 5 个测试套件的断言。**前端**把 `p1/p2` 翻成"你赢了/你输了"（自己那一侧由 `self`/`attacker` 字段可知）。<br>③ **不变量（可机器核对）**：`quick.response.winner === replay.frames[].verdict.winner === replay.data.winner === journal.verdict.winner`（同一场四处同值）。<br>**证据**：`tests/api/api-quick.test.js`（枚举改为 `p1/p2/draw`）、`tests/unit/quickmatch.test.js`、`tests/integration/quickmatch-invariants.test.js`、`tests/api/api-replay-auth.test.js`（重算判决与实战判决直接相等）、`tests/integration/e2e-play.test.js`、`scripts/e2e.js`（Elo 复算改为按 `p1/p2` 映射）。 | `server/quickmatch.js`、`docs/interfaces.md` §2/§5、`docs/systems/11-account-store.md` §8、`tests/api/api-quick.test.js`、`tests/api/api-replay-auth.test.js`、`tests/unit/quickmatch.test.js`、`tests/integration/{quickmatch-invariants,e2e-play}.test.js`、`scripts/e2e.js` |

---

### 14.8 管理端改账号（2026-09-25 追加，D-170）

> 用户 2026-09-25 口径：**"测试可以批量注册账号……也可以调用后端接口来修改任意账号的段位/积分"**——即验收（排位晋升、快速对战积分、段位榜分页）需要**直接造出目标档位**，不必靠反复对局刷。本节把它落成一个**只走管理员通道**、**写 journal 留痕**、**不伪造战绩与峰值**的 op。

| # | 决策 | 影响 |
|---|---|---|
| **D-170** | ⚠️ **新增 `POST /api/v1/admin/account-patch`（改任意账号的段位/积分/入池）**：<br>① **寻址**：`playerId` 或 `publicId` 至少给一项（都给时 `playerId` 优先，与 `/admin/delete-account` 同口径、复用 `resolveTarget`）。<br>② **部分更新**：`tier`（`common\|rare\|epic\|legendary\|mythic`，`server/admin.js` 的 `TIERS`）、`points`（`0..ratingConfig.cap`，冻结值 3000 的整数）、`inPool`（布尔）**至少给一项**；缺省字段**一律不改**（不是整档覆盖）。非法/缺失 → 400 `bad_request`；目标不存在/已删 → 404 `store_not_found`。<br>③ **落库方式 = journal（`account.patched`），不是直写档案文件**：`server/store/ledger.js:buildAccountPatchRecord` 只写显式给出的字段 → `server/store/archive.js` 的 `applyRecord` 落到 `progress.tier`+`tierUpdatedAt`、`rating.points`、`pool.inPool`。**理由**：档案必须可重放、可在重启后重建（§11 存储不变量）；绕过 journal 的直写会在 `rebuild-index`/重放后丢失。实测（`tests/api/api-admin-account-patch.test.js` AP-5）：改档 → 关服 → 同 dataDir 重启 → 值仍在；重复应用幂等。<br>④ **峰值只升不降**：`peakPoints = max(peakPoints, points)`，`peakTier` 按 `TIERS` 序同样取高。原因是档案不变量 `peakPoints >= points` 与"峰值 = 曾经达到过"；调高时峰值随之上移（新事实），调低时峰值原样保留 ⇒ **永远无法用改档压低/伪造历史峰值**。响应回带 `peakTier/peakPoints` 使这一点可被肉眼与机器同时核对。<br>⑤ **不改战绩**：`rating.games/wins/losses/draws/lastBattleAt/seasonId`、`progress.batchesPlayed/batchesPromoted`、仓库、装配一律不动（改档不伪造战绩）。<br>⑥ **前端同步（D-158⑥ 硬要求）**：管理面板新增三格输入（`adminPatchPublicId`/`adminPatchTier`/`adminPatchPoints`）+ 按钮 `admin-account-patch`；目标 publicId 经账号列表分页扫描（limit 200）解析为 playerId。四处登记必须同步，否则 `admin-op-parity`/`AU-1`/`UI-2`/`FC-1..3` 立刻 FAIL。<br>**边界（不是玩家可见能力）**：本 op 只在管理员通道（`DL_ADMIN_USERS` 白名单或 `DL_ADMIN_TOKEN`）可用，玩家侧无任何"给积分/买段位"端点；`docs/frontend/02-accounts.md` §1 的"非目标"据此改写。<br>**证据**：`tests/api/api-admin-account-patch.test.js`（AP-1…AP-8：契约逐字段 / 部分更新 / 峰值只升不降 / 不动战绩 / 重启重放 / 参数与错误码 / 权限两路径 / 改 `inPool=false` 后不再被抽为对手）、`tests/contract/store-contract.test.js` CN-12（适配器方法齐备）、`tests/frontend/{admin-op-parity,admin-ui-contract,auth-ui-contract,auth-field-contract}.test.js`。 | `server/admin.js`（`accountPatch`）、`server/index.js`（`adminOp` 分派）、`server/store/{ledger,archive,adapter-json}.js`、`public/{api,actions,store,format,contract}.js`、`docs/interfaces.md` §2/§2.1/§5、`docs/server.md` §3.2、`docs/frontend/02-accounts.md` §1/§2.5/§4/§5/§11/§13、`docs/tasks.md` §6、`tests/api/api-admin-account-patch.test.js` |

---

### 14.9 排行榜扩展（2026-09-25 追加，D-171）

> 用户 2026-09-25 口径：**"段位榜（按段位、同段位按到达时间）+ 积分榜，都要能分页，并显示自己的名次"**。
> 当时的 `GET /leaderboard` 只有 `scope`+`limit`（硬 top-N ≤100、无 offset/total、**不回本人名次**、只有积分序），无法满足 ⇒ 按总纲 §2.7 升级为决策记录（**本批唯一的后端契约改动**）。

| # | 决策 | 影响 |
|---|---|---|
| **D-171** | ⚠️ **`GET /api/v1/leaderboard` 扩展：两张榜 + 分页 + 本人名次**：<br>① **两张榜（`order`）**：`order=points`（缺省）= 既有**积分榜**（`points` 降序 → `peakPoints` 降序 → `updatedAt` 升序，**排序口径一字未改**）；`order=arrival` = **段位榜**（`tier` 按 `TIERS` 由高到低 → **同段位内 `tierUpdatedAt` 升序（先到者在前）** → `publicId` 升序兜底）。<br>② **分页**：新增 `offset`（≥0，缺省 0；非法 → 400 `bad_request`），`limit` 仍 1..100；响应新增 `order`/`offset`/`total`（**该榜该 scope 的全量**）/`hasMore`，行新增 `tierUpdatedAt`（`null` = 未知）。<br>③ **本人名次**：新增 `data.self` = 调用者在本榜本 scope 的**全榜**名次 `{rank, publicId, nickname, points, tier, tierUpdatedAt}`（**不含 `playerId`**，与行同口径）；`self=null` 表示未登录/未上榜。为拿到身份，路由改为 `{tolerant:true}`（**带 Bearer 才认身份，不带仍公开可读** —— 既有"无需鉴权"语义不变）。<br>④ **实现唯一处** = `server/store/index-file.js` 的 `board(query)`；`leaderboard(query)` 退化为 `board(query).rows` 薄封装（旧调用方/CLI/测试零改动）。段位榜排序独立懒缓存，并在 `tier`/`tierUpdatedAt`/`publicId` 变化时失效（否则榜单会停在上一次排序）。<br>⑤ **索引与迁移**：索引条目新增 `tierUpdatedAt`（取自 `progress.tierUpdatedAt`）；**老 `index.json`（D-171 之前落盘）没有该字段** → `store.open()` 检测到即**从档案重建索引**补齐（info 日志写明原因，**不谎称"索引损坏"**），重建结果立即落盘，此后正常路径不再触发。<br>⑥ **已知开销（登记而非本批缺陷）**：每页仍全量排序（`ensureSorted`/`ensureArrivalSorted`，O(n log n)），与既有实现同量级；超大账号量的分页索引化登记在 `docs/security-backlog.md`。<br>**证据**：`tests/api/api-leaderboard.test.js` **LB-3**（逐页拼起来 == 全量、无重复无遗漏、`total`/`hasMore`/越界 offset）/ **LB-4**（`self.rank` 与同一榜行位置一致；分页不影响；匿名与坏 token → `self=null`）/ **LB-5**（段位榜：高段位在前、同段位按 `tierUpdatedAt` 严格升序、单段位 scope）/ **LB-6**（`offset`/`order` 非法 → 400 `bad_request`；`scope` 非法仍 `bad_scope`）/ **LB-7**（老索引迁移：手工删掉 `tierUpdatedAt` → 重启后被补齐并落盘、排序不失真、留痕）；`tests/contract/store-contract.test.js` CN-12（`board`/`needsTierStamp`）；前端消费见 `docs/frontend/05-tournament.md` TB-7/TB-8。 | `server/store/index-file.js`（`entryOf.tierUpdatedAt`/`board`/`ensureArrivalSorted`/`needsTierStamp`）、`server/store/adapter-json.js`（`index.board`/`needsTierStamp`/open() 迁移/`readAllArchivesForIndex`）、`server/quickmatch.js`（`loadLeaderboard`）、`server/index.js`（`tolerant` + 参数透传）、`docs/interfaces.md` §2/§5、`docs/systems/11-account-store.md` §8.6、`docs/server.md` §3.2、`tests/api/api-leaderboard.test.js` LB-3…LB-7、`tests/contract/store-contract.test.js` CN-12 |

---

### 14.10 AI 库可编辑与草稿（2026-09-25 追加，D-172）

> 用户 2026-09-25 口径：**"实现完整的 AI 逻辑查看、保存、编辑、删除，编辑部分是核心"** + 逐条裁决（F5 分册 `docs/frontend/06-ai-editor.md` §0.1 的 11 条）。
> 当时的 AI 库只有 `GET|POST|DELETE /me/ai`（D-161），**无更新能力**（journal 只有 `ai.created`/`ai.deleted`），且 `POST /me/ai` 只做结构检查、完整校验依赖**遗留无状态端点** `/ai/validate`（`DL_LEGACY_STATELESS=0` 时 410）⇒ 按总纲 §2.7 升级为决策记录。

| # | 决策 | 影响 |
|---|---|---|
| **D-172** | ⚠️ **AI 库可编辑 + 草稿状态 + 双校验**：<br>① **新增 `PUT /api/v1/me/ai/:aiId`（编辑保存）**：路径参数 `aiId`；请求体 `{name?, program?, status?}` **至少给一项**，缺省字段一律不改（部分更新）；**`aiId` 不变**（这是本条的要点：编辑不得换 id，否则所有引用它的配置断裂）。落库 = journal **`ai.updated`**（`{aiId, at, name?, program?, status?}`）。**幂等键 = 内容比对**（`name`/`status`/`program` 逐字段与档案现值比较，**全部相同**且 `updatedAt === at` 才算"已应用"）——**刻意不用纯时间键**：若只比 `updatedAt === at`，同一毫秒内的两次**不同**编辑会被误判为"已应用"而**静默丢失第二次**（F5 独立审查 §5 指出本行原文与实现不符，已改正）。`aiId` 不存在 → 404 `store_not_found`。<br>② **AI 库条目新增 `status ∈ {ready, draft}`**（缺省 `ready` ⇒ **旧档案无需迁移**）。`GET /me/ai` 每条回 `status`；`POST /me/ai` 与 `PUT` 的 `status='ready'`（**缺省**）要求**服务端完整校验通过**（`ast.validate`）——**本条收紧 D-161 的「本批不做完整 AST 校验」：`POST /me/ai` 现在也校验**；`status='draft'` 只做结构检查（名称 1~24 + `program.type==='program'`），供"校验不过也要暂存"用。<br>③ **新增 `POST /api/v1/me/ai/validate`（登录版实时校验）**：鉴权；体 `{program}`；**`tier` 取调用者档案，不接受客户端传**（防伪造门控）；成功 → `{ok:true, warnings, programHash, stats:{nodes,depth,usedNodeTypes}}`（统计与哈希由此一并带回，**编辑器不再需要 `/ai/compile`**）；失败 → 400 `ai_invalid` + `details[{path,code,message}]`。**目的**：让编辑器的校验**不依赖任何遗留端点**（原 `/ai/validate`、`/ai/compile` 在 `DL_LEGACY_STATELESS=0` 时 410）。<br>④ **草稿护栏（窄规则）**：**三条写路径**——`POST /me/configs`（新建槽）、`PUT /me/configs/:slotId`（保存）、`POST /me/configs/:slotId/activate`（出战）——在 `loadout.aiId` 指向**库内存在的草稿**时一律拒绝（错误码 `ai_is_draft`；`activate` 一并对**历史数据**里已存在的那种槽生效）。**不新增**"`loadout.aiId` 必须存在于库中"的要求——服务端当前**根本不校验 `aiId` 成员资格**（`resolveLoadoutOf` 只解析物品），那是**既存缺口**，不在本条扩大，已登记进 `docs/security-backlog.md`（**SEC-36**）。<br>⑤ **被出战配置引用的 AI 禁止降级为草稿**（否则出战配置就引用了草稿）→ 与删除同码 409 `ai_in_use`；改程序/改名（保持 `ready`）不受限。<br>⑥ **计数与引用**：草稿**占库位**（≤100，超限仍 409 `ai_limit`）；`usage` 只由 `loadout.aiId` 派生（草稿恒为空，因其不可被引用）。<br>⑦ **已知行为（不是缺陷，界面必须提示）**：`loadout.ai` 是**程序正文副本**（`archive.loadoutMissingOf` 要求它是对象、`runtime.createContext(ld.ai)` 直接用、快照冻结的也是它），`loadout.aiId` 只是来源标记 ⇒ **改 AI 不会升级已保存的配置**（用户须在配置里重新选一次），也**不会改写历史回放**（回放按快照正文重算，内容寻址）。<br>⑧ **前端同步**：新增 `public/ai-editor.js`（`public/` 由**恰好 9 个文件**变 **10 个** ⇒ `UW-1`/`UI-1` 断言必须同步，属**放松一条既有验收线**，已由用户裁决）；`ai-editor` 从 `EMPTY_PAGES` 移除；设计见 `docs/frontend/06-ai-editor.md`。<br>**证据**：`tests/api/api-me-ai.test.js`（AI-1…：更新/部分更新/`aiId` 稳定/幂等重放/草稿可存/ready 校验拦截/草稿护栏/引用禁止降级/上限/权限）、`tests/frontend/ai-editor-flow.test.js`（AE-1…AE-12）、`tests/contract/store-contract.test.js`（`updateAi` 方法齐备）；独立审查 `docs/reviews/F5.md`；人工走查 `06-ai-editor.md` §9 的 13 步。 | `server/store/ledger.js`（`buildAiRecord` 增 `op:'update'`）、`server/store/archive.js`（`ai.items[].status` + `ai.updated` 幂等/apply/aggregate + `NON_COMPACTABLE`）、`server/store/adapter-json.js`（`updateAi`）、`server/account.js`（`updateAi`/`validateAi`/`createAi` 校验 + 草稿护栏）、`server/index.js`（`PUT /me/ai/:aiId`、`POST /me/ai/validate`、`ai_is_draft`）、`public/{ai-editor.js(新),store,format,actions,api,contract}.js`、`docs/interfaces.md` §2/§2.1/§4.8/§5、`docs/systems/11-account-store.md` §5.2/§10.1、`docs/security-backlog.md`、`docs/frontend/06-ai-editor.md` |

---

### 14.11 内容数值设计 v2 落地（2026-09-28 追加，D-173）

| D | 决策 | 落点 |
|---|---|---|
| **D-173** | ⚠️ **内容数值设计 v2 全量落地（设计依据见 `docs/content-design.md`）**：<br>① **等价点数（EP）模型**：战力 `P = A × H × (D + defK)` 由引擎伤害公式解析推导 ⇒ 每点边际战力 atk 6.667% / def 2.083% / hp 1.053% ⇒ **1 atk ≡ 6.33 hp ≡ 3.20 def**；同品质**标准值**（品质系数居中）下模板/插件等贡献；品质浮动是**刻意**的方差来源。<br>② **B0（绿品质标准均衡模板）= legacy v2 四职业逐维均值**：`{hp 95, atk 15, def 8, sp 73, mp 62}`、`regen {mp 2, sp 2}`（总量守恒 4）。**v3 无职业**：均衡即均值，特化/专家仅在 B0 上随机增减。<br>③ **类型修饰改为乘性守恒**（`Π 因子 = 1`，schema 强制）：特化 高 `×1.30` / 低 `×0.769231`；专家 高 `×1.50` / spread `[2/3,1,1,1]`；新增 **`excludeLow: ["def"]`**（def 边际价值 ∝ `1/(D+defK)`，`(D+defK)` 吃不下大额负补偿 ⇒ def 只能作高属性），专家若把 <1 因子洗到 def → **确定性换位**（不额外消耗随机、守恒不变）。旧口径 `Σ = 5`（加性守恒）作废。<br>④ **插槽系统重做**：类型权重移入 `qualities.slotTypeWeights`（**五维各 15% + 万能槽 `any` 10% + 特殊槽 15%**），同类型第 k 次出现权重 `× slotRepeatDecay^k`（0.35）；**插槽数下限 1 作废**（允许 0 槽：绿 0-2/蓝 1-3/紫 2-4/橙 3-5/青 4-6）；角色插件点数改为品质**区间** `pluginPointsRange`（2-3/4-6/6-9/8-12/10-15）内掷出；`role-templates.slotWeights` 与 `pluginPoints` 两字段**退役**。<br>⑤ **插件点数与数值解耦**：角色插件由"品质档位"（`pointCostByTier`）改为**插件定义里的固定 `pointCost`**；实例数值 = 标准值 × 品质系数（`precision.stat` 2→**3**）。<br>⑥ **五维插件标准值（每点收益恒定、零截距）**：pct = `0.085×cost`；flat = `0.085×cost×Ref_绿(stat)`，其中 **def 以 `(def+defK)` 为基准**（否则 def 类弱约 6 倍，且绿品质 cost1/2 取整后同值会撞 T-PB-4 单调性）。<br>⑦ **浮动字段收口**：技能 `range`/`bulletCount`/`distance` 由 `intMin`（随品质缩放）改 **`copy`**（不浮动）⇒"射程/弹幕/位移增强"三个技能插件成为唯一提升途径。<br>⑧ **新增 3 个角色特殊机制**（`affix-registry` + `core/engine.js`）：`thorns`（受击反弹 `v × 攻击者有效 atk`）、`critMul`（暴击倍率加成）、`lowHpAtk`（`hp/maxHp < battle-config.lowHpThreshold` 时 atk 加成）；注册表新增 **`cap` 字段**（只允许 `"probability"` = 按 `caps.probability` 封顶；缺省表示不封顶——荆棘/倍率/低血加攻不封顶）；回放帧 `damages[].kind` 新增 **`thorns`**。<br>⑨ **全局常数**：`crit: 1.5` 改名 **`critBonus: 1.0`**（暴击倍率 = `1 + critBonus + ΣcritMul` = 2.0；改名同时避开 gate 项 3 把裸字面量 `2` 误判为战斗数值硬编码）；新增 `lowHpThreshold: 0.5`；**`defK` 保持 40**（内容侧以 `(def+defK)` 基准精确补偿，不动既有基线）。<br>⑩ **示例开关退役**：`qualities.json`/`plugins.json`/`role-templates.json` 摘除 `_sample`；`schema.js` 删除 `QUALITY_PLUGIN_POINTS` 冻结表与 `QUALITY_/PLUGIN_EXPECTED` 逐值比对（`skill-templates.json` 仍为示例内容，保留 `_sample`）。<br>**证据**：`npm test` = 1136/1136、`npm run gate` = 9 PASS/0 FAIL/0 PEND（黄金战斗仍 18 tick / p2 胜 ⇒ crit 改动**零基线影响**）；`tests/unit/items.test.js`（0 槽 / 槽权重与 ×0.35 衰减 / 点数区间 / 标准值）、`tests/unit/roles.test.js`（乘性守恒 + def 换位）、`tests/unit/wh.test.js`+`b21.test.js`（点数区间单调）、`tests/integration/data-schema.test.js`（新结构破坏矩阵）、`tests/property/items-invariants.test.js`、`tests/unit/starter.test.js`（0 槽重掷）。<br>⑪ **技能系统落地（`content-design.md` §6，同一轮）**：4 条基础模板（近战/平射/定点/位移，每类 1 条）+ 16 条专属插件（`slot:"exclusive"`，声明式 `exclusive{}` 覆盖形态/名称/动画音效，按 `forTypes` 绑定技能类型，每技能至多 1 个）+ 7 条通用插件（`slot:"general"`，纯词条、**零代价**）；技能插槽 = 1 专属 + 品质区间通用槽；η 配平模型（`hit=10`、p_pos、覆盖价值、等效收益、替代行动常数、CD 档位、资源拆分、SP/MP ≤35 上限）由 **`.audit/content-design.js`** 逐条复算（4 模板 + 16 专属的 D/adv/η/sp/mp/CD 全一致，η ∈ 0.391~0.408）；代码新增 `skills.applyExclusive`、背向位移（`moveDir:"backward"`）、技能级真伤（`sk_true`）、技能级暴击倍率（`critMul`）、内联命中/释放效果、百分比减冷却算子（`scaleCooldownPct`）、帧 action 的 `skillName`/`animKey`/`sfxKey`/`exclusiveId`；前端物品契约同步（`animKey`/`sfxKey`/`forTypes`/`exclusive`，移除 `costDeltaByTier`）。**D-111/D-113/D-116 的字段与机制同时退役（见 §16）**。 | `server/data/{qualities,role-templates,plugins,battle-config,skill-mechanics,affix-registry,skill-templates,unlock}.json`、`server/data/schema.js`、`server/core/{items,roles,skills,engine,bullets}.js`、`server/{starter,ranked,loadout}.js`、`public/{contract,format}.js`、`tests/**`、`.audit/content-design.js`、`docs/content-design.md`、`docs/items-data.md`、`docs/interfaces.md` §1/§4/§5/§6、`docs/systems/03-skills.md`、`docs/examples/03-skills.md`、`docs/frontend/00-rules.md`、`docs/frontend/03-hub-warehouse-loadout.md`、`assets/sprites.json` |

---

### 14.12 内容/机制四项口径收口（2026-09-28 追加，D-174；依据 = 手写 `README.md` 与代码逐条核对）

| D | 决策 | 落点 |
|---|---|---|
| **D-174** | ⚠️ **用户 2026-09-28 四项裁定（README 为准，AI 不得改 README，一律改代码/数据/文档）**：<br>① **专家类型 = README 五档**：`typeModifiers.expert = { high: 1.50, spread: [1.20, 2/3, 5/6, 1] }` ⇒ 1 项**极高 +50%**、1 项**略高 +20%**、1 项**极低 −33.33%**、1 项**略低 −16.67%**、1 项**均衡 0%**；乘性守恒 `high×Πspread = 1` 精确成立（`1.5×1.2×(2/3)×(5/6)=1`）。**`excludeLow` 退役 —— def 无特判**（五维等权，任何维度可作任意档位；旧"专家把 <1 因子洗到 def 则确定性换位"作废）。特化不变（`×1.30`/`×0.769231`，README"1 略高 1 略低其余均衡"）。<br>—— 与旧口径 D-173③ 的差异：旧 spread `[2/3,1,1,1]` 只动 2 项、与 README"五档"不符；且 def 被排除。**schema 新增五档结构校验**（高属性之外恰为 略高(>1)/均衡(=1)/极低(<1)/略低(<1) 且两个负因子不同值），`excludeLow` 出现即 fail。<br>② **定点技能索敌**：`skill-mechanics.json` 的 `vertical.emit.impactAim = "enemyCell"` ⇒ 落点 = **敌方所在格格心**（当该格落在"施法者格 → 最远格"的射程覆盖格内）；**射程内没有对方角色 → 落点 = `clampX(x+朝向×rangePx)`（最远位置），技能仍释放**。旧口径"以最远位置为落点、无敌人则释放失败"作废（`canCast` 从来只判冷却/资源，README 的"射程内无敌人则失败"从未实现）。落点含 `ctx.targetX`（引擎步骤 6 注入 `foe.x`，px；`coveredCellRanges`/`buildSkillAction` 第三参可选，缺省 = 旧行为）。<br>③ **AI 只见"格"**：`runner.projectSnapshot` 的 `self|enemy.x` = **格序号 `0..cells−1`**（`core/field.js` 的 `cellOf`；引擎/回放帧/档案一律仍是 px）；守方镜像相应改为 `x' = (cells−1) − x`；所有内置 AI 程序（`ranked.AI_VARIANT_PARAMS`、`scripts/play.js` 预设、`tests/helpers/load.js` 生成器）的距离阈值改为格（原 px 值 ÷ `battleConfig.cellPx`，半格阈值保留原口径）；前端 `public/ai-editor.js` 的中文标签同步为"位置（格序号，0 起）"。<br>④ **伤害衰减统一线性**：`系数 = max(0, 1 − falloff × \|格偏移\|)`（`core/bullets.js` 既有实现为准）⇒ `docs/content-design.md` §6.1 覆盖价值模型的 `Σ(1−衰减)^\|偏移\|`（指数）改为 `Σ max(0, 1−衰减×\|偏移\|)`，`.audit/content-design.js` 同步。当前 4 模板 + 16 专属中，`|偏移| ≥ 2` 的只有「箭雨」（`area [-2,2]` 且 `falloff = 0`）⇒ 两模型给出相同覆盖价值，**η 与表内 sp/mp/CD 零变化，审计仍全绿**。<br>⑤ **弹幕等级方向修正（同日追加，用户澄清）**：等级 **1 最高、4 最低**（`core/bullets.js` 的 `bulletBattle`：数字小者胜）；专属插件 `desc` 的「等级 +N」= **提升 N 级（数字 −N）**、「−N」= 降低 N 级（数字 +N）。此前 `plugins.json` 把四个平射专属的覆盖**写反**：`ex_pierce` 5（= 反而最弱）、`ex_snipe` 4、`ex_rapid` 2、`ex_scatter` 2 ⇒ 改为 **1 / 2 / 4 / 4**，并按 η 模型重导消耗与冷却（穿甲 sp2/mp6/cd1、狙击 sp4/mp9/cd2、连射 sp2/mp5/cd2、霰弹 sp7/mp17/cd4；η 0.387/0.410/0.392/0.400 全在 0.40±0.02）。**`schema.js` 硬化**：`exclusive.overrides.bulletLevel` 也必须 1..4（此前只校验 `skill-templates`，才让 5 漏过）。**遗留待裁决**：设计模型 §6.1 的 `lf(L) = 1 + 0.05×(L−2)` 把等级当**伤害**系数，但引擎只用等级做弹幕互撞（`core/bullets.js`），且该式符号与"1 最高"相反（等级 1 反而 −10% 伤害）⇒ 三种出路（引擎实现等级→伤害并改正符号 / 模型去掉 `lf` 并重导全部 20 行 / 维持现状），用户未定。 | `server/data/{role-templates,skill-mechanics}.json`、`server/data/schema.js`、`server/core/{items,skills,engine}.js`、`server/runner.js`、`server/ranked.js`、`scripts/play.js`、`server/ai/ast.js`、`public/ai-editor.js`、`tests/{unit/ai-mirror,unit/items,unit/roles,unit/skills,property/items-invariants,integration/data-schema}.test.js`、`tests/helpers/load.js`、`docs/content-design.md`、`docs/items-data.md`、`docs/systems/{03-skills,04-bullets,08-ai}.md`、`.audit/content-design.js` |

---

### 14.13 弹幕等级与伤害解耦 + 持续伤害倍率化（2026-09-28 追加，D-175）

| D | 决策 | 落点 |
|---|---|---|
| **D-175** | ⚠️ **用户 2026-09-28 两项裁定（代码/数据/文档一律照改）**：<br>① **弹幕等级与伤害系数完全独立**：等级（1 最高 / 4 最低）**只影响弹幕互撞**（`core/bullets.js` 的 `bulletBattle`），**不进伤害公式**；技能伤害只由 `multiplier` 一个字段承载（受通用/专属插件影响）。**配平模型删除 `lf(L) = 1 + 0.05×(L−2)`**（D-173 引入、符号还与"1 最高"相反），并按新模型**重导全部 20 条形态**的 SP/MP/CD：模板 4 条（平射 `mp3+sp2`、定点 `mp1`，近战/位移不变）；专属 8 条改动（穿甲 sp2/mp3/cd2、连射 sp2/mp6/cd1、霰弹 sp6/mp13/cd4、箭雨 mp24、藤蔓 mp30、诅咒 mp27、盾突 sp33、突刺 sp19/cd4），其余 8 条不变；`docs/content-design.md` §6.1/§6.3/§6.4 与 `docs/items-data.md` §5 同步。**资源拆分规则修正**：两维类型改为「一维取整、另一维吃余数」——修前两维各自独立取整会让 `Σ维度 > cost`（实测平射 adv3.6 时 2+4=6 > cost 5 ⇒ η 掉到 0.36），与"每点资源收益恒定"自相矛盾。<br>② **持续伤害自带倍率、按 atk 正常计算**：`affix-registry.json` 的 `dot.hitEffect` 由 `{deltaFrom:'v', sign:-1}` 改为 **`{multFrom:'v'}`**（`roll` 由 `int` 改 `stat`），`plugins.json` 火球的内联 `hitEffects` 带 `params.v = 0.2`（= 每 tick 20% 攻击力）；引擎步骤 2 通过**注入回调** `effects.resolveContinuous(state, { dotDamage })` 结算，`dotDamage` 调 `dealDamage(src, target, { mult, dot: true })` ⇒ 伤害 = **攻击力 × 倍率 × 防御减伤**（取整一次、下限 1；攻击力含低血加攻），伤害进帧 `damages[].kind='dot'`。<br>**收敛口径（同日用户追加裁定）**：持续伤害**不判闪避、不判暴击，也不触发其它特殊效果**（吸血 / 荆棘 / 命中类附加效果 / 背击），因此**不消耗任何随机流**；唯一例外是**位移全程免疫**（D-72「免疫所有伤害」，优先级高于一切）。`dealDamage` 新增 `dot: true` 模式实现之。**固定数值类效果不变**（诅咒 −4 def × 3 tick 仍是 `delta`）。新增 `_hitValueModes` 词表（`deltaFrom`/`multFrom`/`displacementFrom`/`amountFrom`）。 | `server/data/{affix-registry,plugins,skill-templates}.json`、`server/core/{effects,engine,bullets}.js`、`.audit/content-design.js`（`lf` 删除 + `derive` 余数拆分 + dot 价值 = 倍率 × hit × tick）、`.audit/golden-battle.json`（重算；差异仅 mp：平射消耗 4→3）、`docs/{content-design,items-data,battle-walkthrough,systems/{01-items,03-skills,07-engine},examples/{03-skills,05-effects}}.md`、`tests/{unit/engine(EN-21),unit/damage(DM-8),unit/skills,unit/items}.test.js` |

---

### 14.14 包（模块包）体系 + 战斗掉落与开包（2026-09-28 追加，D-176…D-177）

| D | 决策 | 落点 |
|---|---|---|
| **D-176** | ⚠️ **用户 2026-09-28 拍板：新增第五类仓库物品「包」（模块包）**：<br>① **五种包**：角色模块包 / 技能模块包 / 角色插件包 / 技能插件包 / **AI 节点包（保留包，见 D-177⑤）**；包的种类决定掉落的物品种类。<br>② **包品质 = 玩家当前段位（固定，不由随机决定）**；**包质量 = 该品质的 4 档百分比**（绿 5/10/15/20、蓝 25/30/35/40、紫 45…60、橙 65…80、青 85…100，共 20 档）。因此"只想掉当前段位的包"与"品质即变相段位门控"是同一件事。<br>③ **掉落物品品质规则（用户口径）**：一个品质的包可开出**本级及以下两级**的物品（最低绿；如紫包 → 紫/蓝/绿），**仅每级最高档**额外拥有一次"升一级"的极小概率（绿包 20% 档 3% 出蓝、紫包 60% 档 3% 出橙 …）；青包 100% 档 = **95% 青 + 5% 橙**。**不降级之外的分配权重按档位递增**（本级 50%→65%→80%→85%）。<br>④ **每包掉落 1~3 件**，件数分布随质量档递增（期望 1.30/1.50/1.67/1.85）。<br>⑤ **包体系自成门控**：**不读** `unlock.json` 的 `gating.enabled`（与 D-137 并存：D-137 继续只管模板/节点解锁，包的段位门控由"品质=段位"天然实现）；掉落池仍受内容表 `drop !== false` 与 `dropWeight` 影响。<br>⑥ **数值全在表**：`server/data/package-config.json`（20×5 品质曲线 + 件数曲线 + 战斗掉落个数/质量档曲线 + 包种类权重 + 包种类 × 质量档白名单），代码零概率字面量；schema 机器校验"档位并集 / 每行和为 1 / **候选品质越界**（本级±2 + 最高档上一级）/ 白名单模板 id 真实存在"。<br>⑦ 仓库新增第 5 桶 `package`（`warehouse.buckets.package`，上限沿用 `maxPerBucket=500`）；**不改 `ARCHIVE_VERSION`**（`normalizeWarehouse` 按 `WAREHOUSE_BUCKETS` 遍历，老档自动补空包桶、不补发历史包）；`kind → 桶` 的隐式三元映射收敛为 `archive.bucketOfKind`（此前散落三处且未知 kind 静默进 role 桶）。 | `server/data/package-config.json`（新）+ `server/data/schema.js`、`server/core/items.js`（`generatePackage`/`openPackage`/`rollBattlePackages`/`packageStepOf`/`packageDropPoolOf`）、`server/store/archive.js`（`WAREHOUSE_BUCKETS`/`bucketOfKind`/五桶空仓库）、`server/ranked.js`、`server/starter.js`、`docs/content-design.md` §10、`docs/items-data.md` §6、`server/data/README.md`、`tests/unit/package.test.js` |
| **D-177** | ⚠️ **战斗掉落与开包（用户 2026-09-28 拍板）**：<br>① **只有"主动匹配并战斗"才掉包**：`POST /api/v1/quick/run` 的**请求者**（进攻方）；**防守方不掉**；排位 `/ranked/run`、沙盒 `/battle`、`/ai/battle` 一律不掉。<br>② **个数：胜方 1~2 个、负/平 0~1 个**（`battleDropCountCurve`）；**质量档：胜方偏中高档（20/35/35/10），负/平偏低档（45/35/15/5）** ——"胜利更容易获得高质量的包"。<br>③ **掉落是服务端权威仓库的写入**（D-159 之后不再有客户端合并）：journal 新记录 **`package.granted`**，`grantId = pk_<sha256(playerId\|battleId\|source)>` **内容寻址** → 同一场重复调用/并发**不重复入仓**（与 `box.opened` 共用 `grantIds` 环形窗口），**不只依赖 quickmatch 的 `existing` 判据**；包 uid = `pkg_<sha256(playerId\|battleId\|序号)>`（跨重启稳定）。<br>④ **`data.drops` 字段恒在**（无掉落为 `[]`）：幂等重放照常回带同一批（由 `matchSeed` 确定性派生），但**不再次发放**；掉落发放失败**不回滚对局**（战绩已落盘），如实记 error 并置空 `drops`。<br>⑤ **AI 节点包 = 保留包（用户裁定：可掉落、开包零产出）**：`package-config.packages[].openable=false` → 开包返回 **200 + `items:[]` + `notice:'package_reserved'`**（**不报错**，包被消耗）；前端据此显示"暂未开放产出"。**（此条已被 D-178⑥ 取代：AI 节点包已开放产出。）**<br>⑥ **开包端点 `POST /api/v1/me/warehouse/open-package`**（体 `{packageUids:[1..100]}`）：**接口不设 `seed` 入参**（同 D-162 口径，随机性归服务端，响应回带 `seed` 供审计）；产出由 `core/items.openPackage` 纯函数算出、由 store 的 **`openPackages`**（消耗包 + 产出物品，**一条记录一次落盘**，journal `package.opened`）落档；上限**前置**校验（超限 → 409 `warehouse_full` 且零写入，包不被消耗）。<br>⑦ 开包在仓库屏内完成（前端开箱屏废弃，见 F8 批次）。 | `server/quickmatch.js`、`server/account.js`（`openPackages` 门面）、`server/index.js`（新路由）、`server/store/{ledger,archive,adapter-json}.js`、`docs/interfaces.md` §2/§2.1、`tests/api/api-me-open-package.test.js` |
| **D-178** | ⚠️ **AI 重构为「可收集积木节点」系统（用户 2026-09-28 拍板，分阶段落地）**：<br>① **只有原语、没有战术宏**：节点目录 = `server/data/ai-node-catalog.json`（单一数据源，**54 个原语节点**：绿 24 / 蓝 10 / 紫 8 / 橙 6 / 青 6），**每个节点只有一个固定品质**（品质 = 功能阶梯，不掷骰）：绿 = 动作 / 基础流程 / 基础感知与条件；蓝 = 且或非 / 距离区间 / 对手侦察 / 数值与比较；紫 = 循环与绝对方向；橙 = 记忆 / 计时 / 自身技能数据；青 = 子程序与状态读取。**高段位解锁的是"更高级的基本功能"，不提供打包好的招式**。<br>② **蓝图 → 编译 → 旧 AST**：玩家只与积木层打交道；`server/ai/blueprint.js` 把蓝图**确定性编译**成旧 AST，故 `runtime / engine / 回放 / 排名 / programHash` **零改动**；编译产物**必过 `ast.validate`**（编译器最后一道闸门）。<br>③ **记忆不写变量名**：编译器自动命名 `__m_<uid>`；因 AST 合法层要求 `var` 声明、而顶层 `var` 会随隐式主循环每轮重跑（= 每轮清空记忆），声明放进**执行 0 次**的循环体，真实写入靠 `set` 落 `ctx.vars`（跨帧持久）。<br>④ **限额按积木层重标定**（`ast.js` LIMITS）：depth 32→128、analyzeDepth 16→128（**必须同级**，否则深层分支被误判 `branch_without_action`）、maxNodes 2000→20000、maxBytes 256KB→512KB、traceLimit 2000→20000；蓝图自身上限 **128 节点 / 嵌套 24 层**。`random.then/else` 在结构层改为可选（表达式位 random 需要），语句位的"必须有 else"由合法层 `branch_without_action` 把关。<br>⑤ **AI 只读格坐标，且只投影自己的技能数据**：`self.skills[0..2].{type,range,cost,cooldown,ready,…}`；**不投影敌方技能数据**；弹幕维持不投影（同 tick 解算，时序上不可观测）。<br>⑥ **AI 节点包开放产出**：`packageKind='aiNode'`、`openable=true`、`dropsKind=null` → 每包 **1~3 个节点堆叠**；节点**品质**走 `package-config.nodeQualityCurve`（该包品质**及以下均匀**），**包质量百分比只决定产出个数**（复用 `itemCountCurve`）。<br>⑦ **节点可堆叠**：仓库新增**第 6 桶 `aiNode`**，条目 `{uid,kind:'aiNode',nodeId,name,category,quality,count}`；同 `nodeId` 自动累加 `count`（不占额外槽位、不触发桶上限）。<br>⑧ **新手自带全部绿档节点各 1 个**（`items.starterNodeStacks()`，uid 由 nodeId 派生 → 确定性/可重放），保证开箱前就能搭出完整 AI；段位门控由"包品质 = 段位"自然实现，**不再由 `unlock.json` 门控节点**。<br>⑨ **装配占用模型**：节点**跨 AI 独占 + 同蓝图独占**；空闲数 = 拥有数 − Σ(所有 `ready` 蓝图用量)（**派生**，不写仓库、不新增 journal 记录）；草稿不占用。**（API 待落，见下批）**<br>⑩ **高亮只显示积木层**（管理员/调试模式才看底层 AST 与完整 trace）；对局快照对外也只回蓝图（内部另存冻结 AST，保证行为不漂移）。**（待落）**<br>⑪ 编译期两个底层发现（一并登记）：**嵌套 `seq` 语句会被运行时静默忽略**（`st === 'seq'` 无分支）→ 编译器在组装语句列表时扁平化，并把 traceMap 改为**后置扫描**生成；**`literal` 不能承载 `null`**（FIELD_CHECKS 把 null 当缺字段）→ 存在性判定用 `remaining > 0`。<br>⑫ **默认 AI 与 bot 预设改写（已落）**：`server/ranked.js` 的 `blueprintOf(preset,sub)` 用**绿档节点**构造蓝图 → `buildDefaultLoadout` 编译成 AST（失败回退旧 `aiProgramOf`，保留为防御路径）；**starter 的默认 AI 仍等于身份派生默认 AI**（D-159 契约），同时带蓝图 → 新号开局即可编辑；行为基线冻结在 `tests/unit/ai-blueprint-bots.test.js`（9 个程序必须互不相同 + 固定探针动作序列）。为此新增 `s_my_hp`（绝对血量）节点、`v_number` 允许负数、**距离类阈值改小数**（半格阈值必须与整格区分，否则 9 变体塌成 7）。 | `server/data/ai-node-catalog.json`、`server/data/ai-blueprint-presets.json`、`server/ai/blueprint.js`、`server/data/package-config.json`、`server/core/items.js`、`server/starter.js`、`server/ranked.js`、`server/store/archive.js`、`server/data/schema.js`、`server/runner.js`、`scripts/check-arch.js`、`public/{format,store,contract}.js`、`tests/unit/{blueprint,ai-node-pack,ai-blueprint-presets,ai-blueprint-bots}.test.js` |

| **D-179** | ⚠️ **交付期缺陷修复 + 前端「入口装配 / 字段级契约」补测（用户 2026-10-02 实测反馈驱动）**：<br>用户实测三症状：①"快速对战/锦标赛后界面卡死、AI 逻辑查看器与读取回放点了没反应、返回主界面按钮全灰"；②"AI 编辑部分新手 AI 打不开"；③"保存 AI 报 `Cannot read properties of undefined (reading 'setCatalog')`"。**同一根因**：`public/index.html` **从未加载 `/ai-blueprint.js`**（文件在磁盘、被 `format.js`/`actions.js` 的 UMD 工厂当依赖引用）→ 浏览器里 `DL.aiBlueprint === undefined` → 所有触碰积木蓝图的分支抛 TypeError → 异常沿 `dispatch` → 动作 promise 链上抛 → **链尾 `busy(ctx,false)` 永不执行** → 全局 busy 卡真 → 全屏按钮变灰且点击被 `if (ctx.state.busy) return` 静默吞掉（刷新才恢复）。**当时 147 个测试文件全绿**：它们一律 `require('public/*.js')`（UMD 的 CommonJS 分支），**天然绕过 index.html 的脚本清单**。<br>① **入口装配闭环**：`ai-blueprint.js` 入清单；新增 `boot-wiring.test.js`（脚本清单 ↔ 模块依赖图 ↔ 磁盘文件三方一致 + 真实 UMD 装配 + 逐屏渲染不落兜底）与 **浏览器等价装置** `tests/helpers/browser.js`（按 index.html 顺序灌 `node:vm` + 手写假 DOM + 真实 HTTP）；`browser-flows.test.js` 逐条重放用户实测路径（对战 → 查看器 → 回放 → 返回主界面 / 打开新手 AI → 加节点 → 保存 → 套模板）。<br>② **界面绝不锁死**：`app.js mount()` 渲染失败 → `format.fatalViewModel` 兜底屏（可操作、不是白屏、**并复位 busy**）；`run()` 捕获**同步抛**（旧写法 `Promise.resolve(def.run(...))` 在 `def.run` 同步抛时连 catch 都进不去 → 点击完全无声）并复位 busy。<br>③ **按钮字段级契约**：`render.js targetAttrs` ↔ `app.js payloadOf` ↔ `format.js` 按钮字段三方相等（`button-payload-contract.test.js` + 字段级往返）。实测缺口：积木编辑器的 `node`/`preset` 两个载荷从未被搬运 → **「添加积木节点」「套用模板」点了毫无反应**（积木系统最核心的两个交互）。<br>④ **积木编辑屏补齐两块 UI**：导入区（此前点「导入 JSON」屏幕上什么都不出现）与「确认丢弃」弹层（此前脏草稿点「返回列表」无反应 → 有未保存改动就退不出编辑器）；导入解析按**草稿类型**分派（蓝图走 `aiBlueprint.importJson`，旧 AST 走 `aiEditor.importProgram`）。<br>⑤ **占用口径对齐**：新增 `aiBlueprint.excludeOwnUsage` —— 编辑**自己的** AI 时扣掉该条目自身占用（对齐服务端 `PUT /me/ai/:aiId` 的 `excludeAiId`）。修前"打开自己的 AI 就报 ⚠ 节点不足、节点库里自己用着的节点全是 0 空闲"，玩家会以为存不了（其实能存）。<br>⑥ **旧 AST 编辑器两处行为修正**：「插入」位置改为**当前选中节点**（此前缺 `addr` 一律回落 `'body'` → "插到语句后/放进语句块/填进表达式槽"三条分支是**死代码**，与界面文案承诺不符）；「上移/下移」后**光标跟随被移动的节点**（此前沿用旧地址 → 再点下移会操作到别的语句）。<br>⑦ **服务端两处硬化**：HTTP **解析层**错误（畸形请求行 / 坏 chunk 框架，如无 `content-length` 的 chunked `DELETE`）统一回 `bad_request` **JSON 信封**（此前 Node 直接回"空 400"，违反"每个响应都是信封"）；配置槽 id 与 `/me/ai/:aiId`、`/replay/:id`、`/data/:table` **同口径**拒绝 `%2F`/`..`/空段（此前会悄悄落进"未知槽位"404）。<br>⑧ **测试设施换代（用户要求：所有功能、每个接口、每条链路、每个分支）**：新增 `api-route-branches.test.js`（**58 条路由**的 401/403/503/`bad_json`/畸形 URI/动态路由穿透/解析层/ZH 410 分支，含此前从未在"无 token"下调用过的 7 条路由与 16 条从未测过的 `bad_json`）、`ai-editor-actions.test.js`（**24 个注册了却从未被执行过的动作**）、`boot-wiring`/`browser-flows`/`button-payload-contract`；`tests/helpers/http.js` 显式写 `content-length`（chunked DELETE 被解析层判成 `HPE_INVALID_METHOD` → 假状态码）；`store-warehouse-recovery` 的随机夹具抖动改为"按需多开几轮"（判定口径不变）。 | `public/index.html`、`public/app.js`、`public/format.js`、`public/render.js`、`public/actions.js`、`public/ai-blueprint.js`、`server/index.js`、`tests/helpers/{browser,http}.js`、`tests/frontend/{boot-wiring,browser-flows,button-payload-contract,ai-editor-actions}.test.js`、`tests/api/api-route-branches.test.js`、`docs/interfaces.md` §5 |

---

### 14.15 前端回退到「文字+按钮」并建立屏幕注册表地基（2026-10-04 追加，D-180）

> ⚠️ **本节的"回退范围"已由 §14.16 的 D-181 撤销**（用户澄清要的是**完整功能齐备、仅缺图形渲染**的那一版）；
> 本节的两条**保留项**（布局工具、主界面布局）与**屏幕注册表**继续有效。

> 触发：用户 2026-10-04 裁定——**「先回退到只有文字和按钮版本前端的干净状态，先给完整前端打基础，
> 都完成后我再依次手动实现每个屏幕的完整布局；但现有的布局工具和已经完成的主界面 UI 布局要保留」**。
> 设计权威 = `docs/frontend/08-foundation.md`（新增）；实现对账见 `docs/progress.md` §0.10。

| D | 决策 | 落点 |
|---|---|---|
| **D-180** | ⚠️ **前端回退批 + 屏幕注册表（用户 2026-10-04 拍板；六条口径）**：<br>① **回退范围**：除 F1 登录链（`login`/`register`/`password`）与用户详情（`profile`）外，**其余 9 屏全部退化为占位页**（`warehouse`/`settings`/`quick`/`tournament`/`leaderboard`/`records`/`ai-editor`/`admin`/`accounts`）；占位页规格 = 标题 + 「尚未实现」 + 「计划：…」 + 一颗「返回主界面」，**零请求**。被删的前端实现（管理面 / 旧出战配置编辑器 / 仓库与开包 / 设置 / 快速对战与查看器 / 锦标赛 / 排行榜 / AI 编辑器）归档进 `docs/archive/frontend-f2-f8/`，**后端端点一律不动**。<br>② **保留**：`tools/layout/**` 布局工具全套 + 四条 npm 脚本 + `public/layout-engine.js` + `public/layout-data.js`（hub 整屏与 8 个径向弹窗）+ `public/app.css` + 主界面的布局表/引擎/投影/7 个 `layout-*` 动作 + 154 张素材。**主界面仍由布局表渲染**。<br>③ **屏幕注册表（唯一真源）**：新增 `public/screens.js`，每屏声明 `{title,status,plan,layout,project,actions,data}`；`store.VIEWS` **由它派生**，`format.viewModel` 改为**查表分发**，屏清单与屏分发**不得再手写**。<br>④ **主界面底部入口清理**：`hubViewModel` 的 footer 整段删除（`refresh-hub`/`config-open`/`goto-admin` 三颗补充入口全清）；布局表里指向待重做屏的 6 个 `goto-*` 入口按钮与死按钮 `goto-records` 一并移除；**唯一例外** = 非布局兜底屏保留恰好一颗 `refresh-layout`（否则数据取不齐时用户无路可走，与总纲 §4.1「按钮永不无声」冲突；登记为偏差 K-1）。<br>⑤ **新增机器门禁 7 条**（`tests/frontend/foundation-contract.test.js` 的 FD-1..FD-7）：注册表 ≡ `store.VIEWS`；ready⇒project 真有实现 / todo⇒零请求；**布局整屏 ↔ 注册表双向一一对应**；**注册表动作并集 ≡ `ACTIONS` 键集**（双向）；源码级禁手写屏名与 `state.view === '…'` 链式分发；**布局台 core 与 `layout-engine.js` 的 digest 一致**（`make-engine.js` 一直声称有这条测试、实际不存在）；**`app.css` 覆盖 `render.js` 输出的每个 `dl-*` 类名**。<br>⑥ **连带修掉的既有真缺陷**（4 条，全部有实测证据）：**(a)** `tools/layout/import-layout.js` 的 `SKILLS[0].screen` 写成 `model_skill1_slots`（少一个 `a`），而结构性修正①先把它改名为 `modal_skill1_slots` ⇒ 第②/③条修正对**技能 1**整段静默失效：`slotsFrom` 丢 `pos`、`new_1` 仍是 `goto-hub`/`新元素` ⇒ 生产环境**点技能 1 的"再看一次"会按"换角色"投影**（无任何测试覆盖）；**(b)** `render.js` **从不消费** `vm.layout.background` ⇒ `assets/bg/hub_main.webp` 与 `.dl-screen-bg` 一直是死的，主界面背景图从未生效；**(c)** `app.css` 缺 `.dl-ph` 规则 ⇒ 缺素材时屏幕上"什么都没有"而不是占位框（与 `07-layout-tool.md` §3.2 的描述不符）；**(d)** 布局投影把 `'hub'` 与 `hub.background` 写死 ⇒ 泛化为 `layoutScreenVm(state, view)`；同时 `state.hub` 更名 `state.layout`（它承载的是所有布局屏的通用状态）。<br>⑦ **两处登录链真缺陷（实现期实测发现）**：**(a)** `submit-register` 把 `nickname` 直接透传，留空时下发 `""` → 服务端 schema 判「昵称需 1~16 字符」→ 400（**注册永远失败**）⇒ 留空时**不下发该字段**；**(b)** 登录/注册成功后调 `loadHub(ctx)` 依赖 `ctx.state.session.token`，而动作内的 `ctx.state` 是**执行开始时的快照**（`dispatch` 不回写它）⇒ 读到 null → `sessionLost` ⇒ **刚登录就被登出**；且 `loadHub` 的「档案已刷新」提示会盖掉"注册成功" ⇒ 两个取数函数改为**显式收 token**，成功文案移到取数**之后**。<br>⑧ **D-179 引用的编号本批才真正登记**（`public/format.js` 自 F9 起就写着「F9/D-180」，但 `decisions.md` 里从未有 D-180 —— 编号悬空，本批一并关闭）。 | 设计：`docs/frontend/08-foundation.md`（§2 注册表契约 I-1..I-8 / §3 保留删除清单 / §4 门禁 / §7 已知偏差 K-1..K-6）<br>代码：`public/screens.js`（新）、`store.js`、`format.js`、`actions.js`、`render.js`、`app.js`、`app.css`、`index.html`（删 `ai-editor.js`/`ai-blueprint.js`）<br>工具：`tools/layout/import-layout.js`（拼写修正 + 删死按钮 intent fix）<br>核对：`tests/frontend/foundation-contract.test.js`(7) + `boot-wiring.test.js`(7) + `auth-ui-contract.test.js`(13) + `auth-field-contract.test.js`(6) + `auth-flow.test.js`(14) + `button-payload-contract.test.js`(3) + `render-escaping` / `static-hosting` / `layout-tool-assets` / `layout-tool-server`<br>存档：`docs/archive/frontend-f2-f8/`（被删实现与测试） |

---


---

### 14.16 撤销 D-180 的回退范围，恢复完整「文字+按钮」前端（2026-10-04 追加，D-181）

> 触发：用户 2026-10-04 澄清 —— **「我是说回退到完整的只有按钮和文字的那一版前端页面，所有功能都完整可用只是没有图形渲染的那一版」**。
> 即 D-180 的回退范围**收得过狠**（只留登录链 + 9 个占位页）；用户要的是**功能齐备、仅缺图形渲染**的那一版。
> D-180 的两条保留要求（布局工具、主界面布局）继续有效。

| D | 决策 | 落点 |
|---|---|---|
| **D-181** | ⚠️ **恢复完整文字前端（撤销 D-180 的删除范围；保留 D-180 的两条保留项 + 屏幕注册表）**：<br>① **恢复**：前端全部屏与其完整功能回到 `HEAD` 状态 —— `format.js`（190 个导出）/ `store.js`（13 屏 + 11 个状态切片）/ `actions.js`（112 个动作）/ `render.js` / `app.js` / `contract.js` / `index.html` / `ai-editor.js` / `ai-blueprint.js`，以及配套的 21 个 `tests/frontend/*` 文件。**做法 = `git checkout HEAD -- <这些文件>`**（那版本身就是"完整文字+按钮"版），不是重写。<br>② **继续保留**（D-180 口径③不变）：`tools/layout/**` 布局工具、`public/layout-engine.js`、`public/layout-data.js`（hub 整屏 + 8 径向弹窗）、`public/app.css`、7 个 `layout-*` 动作 —— **主界面仍由布局表渲染**（`boot.js` 注入 `format.setLayout`；未注入或 `/me` 未到时回落**完整文字主界面**）。<br>③ **屏幕注册表继续存在**：`public/screens.js` 已更新为**完整 14 屏**（13 屏 + 新增 `records`），`store.VIEWS` 与它逐条相等；它是"加屏只改一处"的登记点。`index.html` 已加载它。<br>④ **`goto-records` 从死按钮接成真屏（新增 `records` 屏）**：修前它只发一句「尚未实现」、不切屏（违反总纲 §4.1）。本轮接上自 B30 就绪、前端从未接的两个端点：`GET /me/records`（`?limit=` / `?role=attacker\|defender`）与 `GET /me/defense` —— 新增 `store` 的 `records` 切片（含"只落地与请求一致的角色"的防旧响应覆盖守卫）+ `format.recordsViewModel`（逐行：时间/对手/攻防/模式/胜负/tick/积分变化/未读）+ 4 个动作（`goto-records` 改为切屏取数、`refresh-records`、`records-filter`、`records-seen`）+ `api.records/defense/recordsSeen` + 按钮载荷 `data-role`；字段登记进 `contract.js`（9 条）与 03 分册 **§5.4**（放在 §5.3 之前，避免 WH-11 的物品字段扫描把它当物品字段）。<br>⑤ **D-180 的连带修复继续有效**（与回退范围无关，属独立缺陷）：`import-layout.js` 的 `model_skill1_slots` 拼写（技能 1 弹窗一直按"换角色"投影）、`render.js` 消费 `vm.layout.background`（主界面背景图此前从未生效）、`app.css` 的 `.dl-ph` 占位样式、布局投影泛化、`07-layout-tool.md` 的素材计数与"真图保护"口径修正、`assets-inbox/README.md` 的 `tools/layout/` 路径。**D-180 记录的"登录链两处修复"（注册空昵称 400 / `loadHub` 读旧快照 token）不再适用** —— 那两处是本会话为"骨架版"新写的 `actions.js` 引入的，`HEAD` 版实现无此问题。<br>⑥ `docs/frontend/08-foundation.md` **保留为"屏幕注册表"的设计依据**，但其 §3.2 的删除清单与 §7 的偏差 K-1 **已作废** —— 以本条为准。 | 恢复：`git checkout HEAD -- public/{format,store,actions,render,app,contract,index.html,ai-editor,ai-blueprint}.* tests/frontend/*`<br>保留：`tools/layout/**`、`public/{layout-engine,layout-data,app.css}`、`boot.js` 的 `format.setLayout` 注入<br>新增：`records` 屏（`store`/`format`/`actions`/`api`/`render`/`contract` + 03 分册 §5.4）<br>注册表：`public/screens.js`（14 屏，与 `store.VIEWS` 逐条相等）<br>核对：`npm test` **1263/1263**、`gate` **9 PASS**、`check:docs` PASS、`check-arch` PASS（41 文件）、`npm run e2e` **22/22** |

---

### 14.17 前端整体回到「纯文字 + 按钮」：主界面也不再走布局表渲染（2026-10-04 追加，D-182）

> 触发：用户 2026-10-04 再次澄清 —— **「现在前端主界面屏仍然有图形渲染 完全回退到只有文字和按钮的界面」**。
> D-181 恢复了完整文字前端，但**保留了 F9 的布局表驱动主界面**（那是用户上一轮明确要求"保留"的）。
> 本轮用户进一步要求：**主界面也要回到文字+按钮** —— 即**整体关掉图形渲染**。

| D | 决策 | 落点 |
|---|---|---|
| **D-182** | ⚠️ **关闭布局表驱动渲染（前端 14 屏全部为文字 + 按钮）**：<br>① **做法 = 不再把布局表交给投影层**：`public/boot.js` **删掉** `DL.format.setLayout(DL.layoutEngine, DL.layoutData)` 的调用（原三行保留为注释，就在原位，作为"重新打开"的开关）。`format.js` 的 `layoutReady()` 因此恒为 `false` ⇒ `hubViewModel` 走**文字版**（摘要行 `昵称 · 段位 · 积分 · 未读 进攻a/防守d · 在池` + 12 颗按钮：用户/仓库/快速对战/锦标赛/排行榜/出战配置1-3/AI编辑/设置/对战历史/刷新）。<br>② **`format.js` / `store.js` / `actions.js` / `render.js` / `layout-engine.js` / `layout-data.js` / `app.css` 的布局代码全部原样保留**（只是没有调用方）—— 这样"重新打开图形主界面"只需把那三行注释解掉，**不需要重新实现**。<br>③ **布局工具 `tools/layout/**` 与四条 npm 脚本、154 张素材、`layout-data.js` 的 hub 整屏 + 8 径向弹窗 全部保留**（D-180 口径③的核心要求不变）。<br>④ **效果**：全部 14 屏的渲染路径现在**完全一致**（都是 `vm.lines` + `vm.buttons` + 屏内弹窗块），没有任何百分比定位 / 多边形 `clip-path` / 背景图层 / 径向弹窗流。`index.html` 仍加载 `layout-engine.js` 与 `layout-data.js`（保留以便一键重开），但它们不产生任何 DOM。<br>⑤ **机器核对现状（需知悉）**：`tests/frontend/` 里有一批**布局专项**用例（`layout-tool-assets` LT-*、`layout-tool-server` LS-*、`hub-warehouse-flow` WH-1、`admin-ui-contract` AU-1 的 `F9_ACTIONS` 并集）—— 它们为了核对布局**能力**仍在测试内**显式注入**布局表（`format.setLayout(...)`），因此**仍然全绿**；也就是说这些用例现在核对的是"**布局能力还在且没坏**"，而**不再是"浏览器里主界面走布局渲染"**。浏览器里实际走哪条路，由 `boot.js` 的开关决定（本轮已核验：真实 `index.html` 装配下 `layoutReady()===false`，主界面 HTML 内**不含** `dl-screen`/`dl-el`/`dl-screen-bg`）。 | 改动：`public/boot.js`（注释掉 `setLayout` 注入 + 写明重开开关）<br>保留：`tools/layout/**`、`public/{layout-engine,layout-data,app.css}`、`format.js` 的全部 `lay*` 投影与 `layout-*` 动作<br>核对：`npm test` **1263/1263**、`gate` **9 PASS**、`check:docs` PASS、`check-arch` PASS（41 文件）、`npm run e2e` **22/22**<br>浏览器路径核验（真 `index.html` 清单装配 + `node:vm` 假 DOM）：`layoutReady()===false`；14 屏 HTML 全不含 `dl-*` 布局类；主界面 = 文字摘要区 `#lines` + 10 类按钮（`goto-warehouse`/`goto-quick`/`goto-tournament`/`goto-leaderboard`/`goto-ai-editor`/`goto-settings`/`goto-records`/`goto-profile`/`config-open`/`refresh-hub`） |

---

### 14.18 清理占位素材（2026-10-04 追加，D-183）

> 触发：用户 2026-10-04 —— **「占位用的图片素材也清理掉」**。

| D | 决策 | 落点 |
|---|---|---|
| **D-183** | ⚠️ **删除 154 张程序生成的占位图**：<br>① **删除范围 = `tools/layout/placeholders.json` 的 `generated` 登记表所列的全部路径**（154 个：角色 11 / 技能 4 / 插件 41 / AI 节点 54 / 包 5 / 品质框 5 / 段位 5 / 背景 1 / 界面按钮 28），删完 **`public/assets/**` 为空**（空子目录一并移除，`public/assets/` 本身保留）。<br>② **`placeholders.json` 的 `generated` 清空**（结构保留），此后重跑生成器不会再看见"已登记"的路径；`make-placeholder-assets.py` 的 `can_write` 对未登记路径仍然放行 ⇒ **随时可重新生成**（`python tools/layout/make-placeholder-assets.py`）。<br>③ **清单重算**：`npm run assets:manifest` 后 `tools/layout/assets-manifest.json` 的 summary 变为 `total 158 / present 0 / placeholder 0 / real 0 / missing 154 / coreMissing 54`；`docs/frontend/assets-manifest.md` 同步（**清单仍完整列出该有的条目** —— 它是"要画哪些图"的依据，不因文件缺失而缩水）。<br>④ **布局表的 asset 引用原样保留**（`layout-data.js` 仍写着 `assets/role/role_bal.webp` 等）—— 因为 **D-182 已关闭布局渲染**，这些路径在浏览器里不产生任何 DOM；重开图形主界面前先补素材即可（`wire-assets-into-layout.js` + 生成器/真图）。<br>⑤ **LT-4 的口径随之修正**（原来断言"core 条目必须全部到位"，那是占位图还在时的正确状态；素材清空后它会误报）：改为断言**清单完整性 + present 标记与磁盘一致**（`present` 的条目文件必须真在；`summary.missing` 必须等于磁盘实际缺失数；数据表里每个可见对象必须仍在清单里**有条目**）。<br>⑥ `docs/frontend/07-layout-tool.md` §3.2 的"143/154 张占位图"改为**如实描述当前为 0**，并说明重新生成与归位真图的流程。 | 删除：`public/assets/**` 的 154 个文件（清单见 `tools/layout/placeholders.json`）<br>登记表：`tools/layout/placeholders.json`（`generated` 清空）<br>清单：`tools/layout/assets-manifest.json` + `docs/frontend/assets-manifest.md`<br>口径：`tests/frontend/layout-tool-assets.test.js` 的 **LT-4**<br>核对：`npm test` **1263/1263**、`gate` **9 PASS**、`check:docs` PASS、`check-arch` PASS（41 文件） |

---

### 14.19 布局工具：层级树 + 元素注释字段（2026-10-04 追加，D-184）

> 触发：用户 2026-10-04 —— **「给那个前端编辑界面添加功能：界面和弹窗的层级…显示为树状的层级包含关系」** +
> **「同时为每个元素添加一个注释字段。这个字段以自然语言描述其功能，具体实现时若该元素有不完整或未实现的功能则根据此字段补齐其功能」**。

| D | 决策 | 落点 |
|---|---|---|
| **D-184** | ⚠️ **布局台（`tools/layout/lab.html`）新增两项能力**：<br>① **层级树取代平铺清单成为左栏默认视图**：把"界面／弹窗的**包含关系**"画成树 —— 根是 `hub`，其下先列元素，再把每个元素 `target` 指向的画面**嵌在该元素底下**（表达"点这个能进那个"）。重复出现的画面（含 `A→B→A` 这类**合法循环**）只画一行 `↩ 已在上方` 的**引用行**，**绝不无限展开**；没有任何元素指向的画面单列一节"还有这些画面"。点画面行 = 切过去，点元素行 = 选中。左下角可在「层级 / 平铺」间切换（平铺保留原行为）。<br>② **每个元素新增 `desc` 字段（自然语言注释）**：右侧属性面板的输入框，边打边存（`input` 即时落进布局表，**每次输入一个撤销快照**）、清空即删字段（不留空串）。它是**设计期字段**：产品渲染（`render.js` / `layout-data.js`）**不消费**；用途是 ① 让每个元素有可读的职责说明，② **作为"功能补齐"的依据** —— 元素功能不完整/未实现时照这条注释补。状态行实时提示「还没写注释」/「按注释看还有未落地的部分：缺 action · target 没有对应动作 · 缺素材」/「注释已写」。树里用 💬 标记有注释、⚠ 标记待补齐。<br>③ **新增 `validateHierarchy(bundle)` 并接进 `validateBundle`**：`target` 指向不存在的画面 → **error**；声明了 `target` 但 `action` 是纯本地动作（空/`wait`/`none`/`noop`）→ **error**（点了进不去那个画面）；弹窗/整屏**没有任何元素指向它** → **warn**。**刻意不写成固定动作白名单** —— 布局表在导入期会被 `import-layout.js` 把 `config-open`/`plugin-pick`/`slot-set` 等重写成 `layout-open`，合法动作是一整个家族；**循环引用合法**，不报错。同时**去掉**旧的那条重复 `target` 存在性检查（原来散在 `validateBundle` 里）。<br>④ **`normalizeElement` 保留 `desc`**，故注释随布局表落盘（`layout-bundle.raw.json`）并穿过 normalize/快照往返；`make-engine.js` 已重跑，产品侧 `public/layout-engine.js` 同步拿到 `validateHierarchy`（digest `0e3f7269ab637f16`）。 | 改动：`tools/layout/lab.html`（core：`normalizeElement` + `validateHierarchy` + `validateBundle`；app：`renderTree`/`elNode`/`screenBranch`/`syncSideMode`/`renderDescHint`/`pDesc` 事件与 CSS）；`public/layout-engine.js`（再生成）<br>文档：`docs/frontend/07-layout-tool.md`（界面速览 + 新增「层级树」与「注释字段」两节 + 校验表）<br>核对：`node runtime/check-lab.js`（两个脚本语法 + 控件齐备）、`node runtime/test-layout-lab.js`（**13 组**核心断言，含"消息带 `[画面名]` 前缀"与"默认画面集合 0 error"）、`node runtime/test-layout-lab-browser.js`（**15 组** jsdom 真 DOM 断言：树可见/弹窗行缩进更深/引用行收敛/树有界/<每个画面都出现在树里>/点画面行切屏/点元素行选中/注释即时落盘/💬 标记/一次撤销回到本次编辑前/清空即删字段/两模式互斥）<br>回归：`npm test` **1263/1263**、`gate` **9 PASS**、`check:docs` PASS、`check-arch` PASS（41 文件） |

---

### 14.20 布局表支持容器/滚动/图标尺寸/网格/文字样式/九宫格，并补齐布局台常用设计能力（2026-10-04 追加，D-185）

> 触发：用户 2026-10-04 —— **「现在这个前端设计页面能设计滚动视图吗（比如固定大小的框，里面物品表格或列表排列，可以设置图标大小，
> 可丝滑自然上下滚动等）若不能，添加该功能」** + **「那就加这个后再看看这个布局台还缺什么常用的游戏ui设计功能，全部加上」**。

| D | 决策 | 落点 |
|---|---|---|
| **D-185** | ⚠️ **布局表新增 6 组字段，布局台补齐常用游戏 UI 设计能力**：<br>① **`parent`（装进谁）** —— 把平铺列表变成**层级**：子元素 `rect` 语义变为"相对父块内容原点"，父块裁剪子元素，移动父块子元素跟着走。<br>② **`scroll`（滚动容器）** —— `dir`:`v`/`h`/`both`/`none`（`none` = 只裁剪不滚）、`fade` 两端渐隐、`top`/`left` **设计期初始偏移**。渲染层用**原生 `overflow` 滚动**（`-webkit-overflow-scrolling:touch` + `overscroll-behavior:contain`）⇒ 手感是浏览器原生的"丝滑"；滚动条外观在 `app.css` 里收敛成游戏 UI 的细样式。<br>③ **`grid`（图标大小 + 网格）** —— `cellW`/`cellH`/`gapX`/`gapY`/`padX`/`padY`/`cols`。**图标大小 = 卡片尺寸**；布局台「排成网格」按它等距排子元素，列数由容器宽自动算。<br>④ **`font`（文字样式）** —— `size`/`align`/`color`/`bold`/`lineHeight`/`wrap`。**刻意不叫 `text`**：解析后的元素里 `text` 已是**渲染后的文字**，两个含义撞在一起会静默出错（本轮真踩过：`layoutAt` 应输出替换文字、结果输出了样式对象）。<br>⑤ **`nine`（九宫格拉伸）** —— `slice` 四边切片厚度，渲染成 `border-image … fill stretch`，面板/按钮底图圆角不糊。<br>⑥ **`opacity` / `clickThrough`** —— 不透明度与"不可点（透给下层）"。<br>⑦ **引擎 `layoutAt` 把祖先滚动容器的偏移从子元素位置上扣掉**（`applyScrollOffsets`）⇒ 设计器与产品**共用同一份坐标算法**，不各写一遍语义。<br>⑧ **非法值不再被静默修掉**：`normalizeElement` 原样保留非法 `scroll.dir` / `font.size` / `font.align`，交给新增校验报 error —— 静默改成 `v` 会让"看着像滚动容器但没生效"变成最难查的一类问题。<br>⑨ **新增校验**：`scroll.dir` 非法 / `font.size` 越界 / `font.align` 非法 → error；`parent` 不存在 / 自指 / **成环** → error；`grid` 缺参数或块里没子元素 / 装进 `hit:'path'` 的父块 / 九宫格没配底图 → warn。<br>⑩ **布局台 UI**：右侧新增「装进谁 / 滚动容器 / 初始滚动 / **图标大小**+**排成网格** / 网格间距 / 文字大小+按高度自算 / 文字样式 / 九宫格+不透明+不可点」面板；一键「**变成容器＋收进去**」把选中块盖住的元素收成子元素并开滚动；舞台里滚动容器**真的能滚**（与产品同语义），带虚线轮廓标识。<br>⑪ **仍登记为未做**（如实记录，非遗漏）：多选与对齐/分布工具、图层拖拽排序面板、标尺与安全区参考线、复制粘贴（现只有「复制」= 原地再放一份）、组件/实例复用。 | 改动：`tools/layout/lab.html`（core：`SCROLL_DIRS`/`TEXT_ALIGNS`/`normalizeElement`/`layoutAt`+`applyScrollOffsets`/`validateLayout`；app：容器面板 + `syncContainerProps`/`makeScrollContainer`/`applyGrid` + `buildEl` 容器渲染 + CSS）；`public/render.js`（`.dl-scroll`/`.dl-scroll-fade`/`.dl-clickthrough` + `--dl-fs/--dl-color/--dl-align/--dl-lh` + `border-image` 九宫格 + `opacity`）；`public/app.css`（滚动条细样式、遮罩渐隐、文字变量、不可点）；`public/layout-engine.js`（再生成，digest `761b6693c57b95af`）<br>文档：`docs/frontend/07-layout-tool.md` 新增「容器 / 滚动 / 图标大小 / 网格」整节（含字段示例、"常用游戏 UI 设计功能一览"表、容器校验表、`font` 命名注意）<br>核对：`node runtime/check-lab.js`、`node runtime/test-layout-lab.js`（13 组）、`node runtime/test-layout-lab-browser.js`（15 组）、D-185 专项端到端探针（**产品引擎字段往返 + `layoutAt` 扣滚动偏移 + 真 jsdom 里 `.dl-scroll` / `overflow-y:auto` / `--dl-fs` / `border-image` / `opacity` / `.dl-clickthrough` + CSS 覆盖**，全部通过）<br>回归：`npm test` **1263/1263**、`gate` **9 PASS**、`check:docs` PASS、`check-arch` PASS（41 文件） |


### 14.21 后端新增「选定显示配置」与「分解」两条端点（2026-10-05 追加，D-186/D-187）

> 触发：用户 2026-10-05 —— 本轮开始做**布局表驱动的界面**（见 §14.23 D-188），
> 期间确认两个后端缺口：**①** 主界面「显示哪份配置」需要一个服务端持久化状态；
> **②** 桶满 500 后没有任何"腾空间"的手段（N-10 一直待决）。
> 设计冻结：`docs/frontend/09-layout-driven-ui.md` §8。

| D | 决策 | 落点 |
|---|---|---|
| **D-186** | ⚠️ **新增 `POST /api/v1/me/configs/:slotId/select`：把「主界面当前显示哪份配置」存到服务端档案**。<br>① **与 `activate` 完全分开**：`select` **不校验完整性**（可以选一份空槽）、**不动快照**、**不改出战槽**——"在看 slot2、出战是 slot1"是合法且被产品使用的状态（主界面 1/2/3 号按钮只切换"在看哪份"）。<br>② 档案新增 `configs.viewedSlotId`；**`ARCHIVE_VERSION` 2 → 3** + `migrateV2toV3`（兜底链：`activeSlotId` → 首个槽 → `null`；**不伪造"玩家看过哪一份"**，它只是"到 v3 之前没有这个量"的代理）。<br>③ `GET /me` 回带 `viewedSlotId` 与 **`battleSlot`**（= `activeSlotId` 的**布局投影别名**，供主界面「出战」徽章 / 按钮按下态做 `press:'state'` 判据）。<br>④ journal 新增 `config.viewed`（**幂等**：值相同 → `changed:false`）；`syncViewedSlot(archive)` 做存在性自愈（槽被删 → 回落），调用点 = 建槽后/删槽后/建槽记录/读档护栏。<br>⑤ 错误：400 `bad_request`（非法槽名，含 D-179 的 `%2F` 口径）；401；404 `slot_not_found`。<br>⑥ **校验器新增**：`viewedSlotId` 必须指向真实存在的槽（`null` 合法 = 无槽异常态）；**刻意不要求它等于 `activeSlotId`**。 | 代码：`server/store/archive.js`（`ARCHIVE_VERSION`=3、`migrateV2toV3`、`viewedSlotId` 字段、`syncViewedSlot`、`config.viewed` case、`summaryOf` 加两字段、`validateArchive` 判据、`RECORD_TYPES`）、`server/store/ledger.js`（`buildConfigViewedRecord`）、`server/store/adapter-json.js`（`setViewedSlot`）、`server/account.js`（`selectViewedSlot` + `item_not_found: 404`）、`server/index.js`（`POST /me/configs/:slotId/select`）<br>核对：`tests/api/api-d18x-select-dismantle.test.js` **SL-1…SL-4** |
| **D-187** | ⚠️ **新增 `POST /api/v1/me/warehouse/dismantle`：分解（删除）仓库物品**。<br>① **无产出**（用户 2026-10-05 裁定：「先只删除，产出待定」）—— 响应只回带删除后的仓库视图，**不生成任何物品**。本决策**只关闭 N-10 的"腾空间"半边**，回报机制仍未定。<br>② **可分解范围 = `role`/`skill`/`rolePlugin`/`skillPlugin`**；**`aiNode` 与 `package` 不可分解** → 409 `item_not_dismantlable`（用户裁定：「ai 节点和包不可分解，其他都可」）。理由：`aiNode` 是**堆叠**条目（一 uid = 一堆，删它需单独的减堆叠语义），`package` 是**消耗品**（正解是"开包"）。<br>③ **三类拒绝（全部在落盘之前判完 → "拒绝 = 零写入"）**：被任何配置引用 → 409 `item_in_use`（沿用 D-163 语义）；仍装配在插槽里（`equipped===true`）→ 409 `plugin_equipped`；uid 不存在 → **404 `item_not_found`**。<br>④ **`item_not_found` 是专属新码**，**刻意不复用** `item_missing`：后者在 `interfaces.md` §2 固定为 409（装配/拆卸路径的既有契约），删除语义下"没找到"必须是 404。改它会同时改掉两个已文档化端点。<br>⑤ **collect-then-apply**：批量分解时逐条判完，**任一条不合法 → 整批拒绝、合法那件也不能被删**（避免"删了一半才发现不合法"）。<br>⑥ journal 新增 `warehouse.dismantled`（**无物品正文**，只有排序后的 uid 列表 ⇒ 记录体积恒定）；幂等键 = `dismantleId`（= 排序后 uid 集合的内容哈希 `dm_<digest>`），落 `grantIds` 同一环形窗口；**排序是承重的**（`['b','a']` 与 `['a','b']` 必须同 id）。<br>⑦ **`DISMANTLABLE_KINDS` 是单一判据**：HTTP 层、`applyRecordToArchive`、`applyRecordToMaterializedWarehouse`（检查点物化）**三处都必须调它**，否则检查点重建后会与真源漂移。档案侧对畸形/重放记录另加护栏（不可分解/仍装配 → **不删**，只记 warn），宁可少删也不造成"档案里少了一件不该少的"。<br>⑧ **无二次确认**（用户裁定：「直接分解，不确认」）—— 确认是**前端口径**，后端不做。 | 代码：`server/store/errors.js`（`item_not_dismantlable: 409`）、`server/store/archive.js`（`DISMANTLABLE_KINDS`/`isDismantlableKind`、`warehouse.dismantled` case + 物化分支、`NON_COMPACTABLE`、`RECORD_TYPES`）、`server/store/ledger.js`（`dismantleGrantIdOf`/`buildDismantleRecord`）、`server/store/adapter-json.js`（`dismantleItems`）、`server/store/adapter-sqlite.js`（未实现清单加 3 项）、`server/account.js`（`dismantleItems`）、`server/index.js`（`POST /me/warehouse/dismantle`）<br>核对：同文件 **DM-1…DM-5** |

**收口实跑（2026-10-05）**：`npm test` = **1272 通过 / 0 失败**（新增 9 条）；
本批专项探针（真起服务 + 真注册，用完即删）**18/18 PASS**，含跨重启持久化（`viewedSlotId` 与分解结果都不复活）。
---

---

### 14.22 布局表驱动界面重启：网格自动流式排布 + 按钮按下四模式 + 双素材（2026-10-05 追加，D-188）

> 触发：用户 2026-10-05 —— **「现在开始做布局表驱动的界面 删掉所有纯文字和按钮的约束」** + 仓库弹窗/物品详情的一组口径。
> 完整设计与逐条问答见 `docs/frontend/09-layout-driven-ui.md`（本批唯一实现依据）。

| D | 决策 | 落点 |
|---|---|---|
| **D-188** | ⚠️ **前端重新走布局表驱动，并补齐布局台/引擎缺的三项能力**：<br>① **重开布局渲染**：「界面只能由文字与按钮构成」这条约束**作废**。`public/boot.js` 放回 `format.setLayout(...)` 注入 ⇒ `layoutReady()` 为真、主界面走布局版。**主界面既有元素的 `rect` 一律不动**（用户口径：位置与大小由用户自己微调），本轮只做加法（补 `action`、加 `press`/`assetPressed`、加新元素）。<br>② **`grid.flow` 网格自动流式排布（本轮核心新增）**：用户口径原文「应能设定格子大小，**不硬性规定几乘几**，视仓库内物品数量**从左到右从上到下自行排布**，横着显示不下就换行，竖着显示不下的变成滚动视图」。实现 = 引擎 `gridFlowRects(containerRect, grid, n)`：`cols = max(1, floor((w−2·padX+gapX)/(cellW+gapX)))`（显式 `cols` 优先）；第 i 个 → `row=⌊i/cols⌉`、`col=i%cols` → `rect=[padX+col·(cellW+gapX), padY+row·(cellH+gapY), cellW, cellH]`（**相对父容器内容原点**，与 D-185 的 `parent` 语义一致）；返回 `{rects,cols,rows,contentW,contentH}`，`contentH` 供 `grid.autoHeight` **撑开内容高度** ⇒ 外层 `scroll` 才能真正滚动。**算在引擎而非前端投影层**：设计器与产品必须共用同一份坐标算法（D-185 已确立的原则），否则"布局台里看着对、实现出来不对"。<br>③ **`grid.autoHeight`**：行数超出容器高时把内容高撑开（配 `scroll` 才有意义）；另加**显式 `cols`**（可强制列数）。<br>④ **`press` 按钮按下四模式**（用户口径：所有按钮类都该有按下反馈，且行为可分四种）：`tap`（点击期间按下、松开恢复 → CSS `:active`）／`hover`（移上去即按下 → `:hover`）／`sticky`（点击后保持，直到其他条件解除）／`state`（**由状态决定**：`pressKey` 的值命中 `pressWhen` → 按下）。`state` 的两个实际用法（用户原话）：**当前显示的配置槽一直保持按下、切换后旧按钮恢复新按钮按下**（`pressKey:'activeSlot'`）；**「设为出战」当前配置是出战则显示已按下、未出战则常态可点击**（`pressKey:'battleSlot'`）。引擎新增 `pressActive(el, sstate)`（与 `whenMatches` 同形：单值/数组、字符串化比较），`layoutAt` 产出 `pressed` 布尔。<br>⑤ **`assetPressed` 双素材**：所有按钮类都应有「常态/按下」两张图；常态仍用 `asset`，新增 `assetPressed`（同样过 `{键}` 模板替换）。渲染层在两者都在时输出两张 `<img>`（`.dl-img-pressed`），由 CSS 按 `.dl-pressed`/`:hover`/`:active` 切换显隐；**只有一张时不产生视觉变化（不凭空造图）**。<br>⑥ **非法值不静默修掉**（与 D-185 的 `scroll.dir`/`font` 同口径）：非法 `press`、`press=state` 缺 `pressKey`/`pressWhen`、`pressKey` 不在 `WHEN_KEYS`、`grid.flow` 缺格尺寸 → **error**；只给 `assetPressed` 没给 `asset`、`grid.flow` 容器没有 `scroll`、`autoHeight` 没有 `scroll` → **warn**。<br>⑦ **布局台同步补齐**：右侧新增「按下素材 / 按下行为（+状态键/等于什么）/ 自动排布 / 撑高内容 / 强制列数 / **预览条数**」面板；舞台**就地显示 `grid.flow` 的排布结果**（子元素位置按引擎算，不是手摆的），并按「预览条数」造只用于展示的空壳；按下态在设计器里可见（`.pressed` 描边 + 「按下」角标）；设计期状态选择器**同时驱动 `activeSlot` 与 `battleSlot`**（一个开关就能验两种 `state` 用法）。<br>⑧ **配套前端批次（同轮，见 `09-layout-driven-ui.md` §4–§7）**：仓库从**独立屏改为弹窗**（6 个选项卡一行、下方网格、超出滚动、**取消右上角 X**）；点物品 → **中间弹详情弹窗**（属性**按类别分组**、字段全部来自 `/me/warehouse` 真实响应 ⇒ **零新接口**）；详情内可**开包**（包）/ **分解**（其他，D-187）；配置装配的候选列表弹窗**也要可滚动**；主界面 `slot_1/2/3` 接 `config-select`（D-186）+ `press:'state'`，「设为出战」接 `press:'state'`，新增「战绩」入口（**本轮只做空占位弹窗**）。<br>⑨ **不做任何空实现/偷换概念**（用户口径原文）：引擎不支持就先改引擎与布局台，再落产品。 | 代码：`public/layout-engine.js`（`PRESS_MODES`/`pressActive`/`gridFlowRects`；`normalizeElement` 保留 `assetPressed`/`press`/`pressKey`/`pressWhen`、`grid.flow`/`autoHeight`；`layoutAt` 产出 `pressed`/`assetPressed`；`validateLayout` 新增 7 条判据）、`public/render.js`（`.dl-press-*`/`.dl-pressed` 类 + 第二张 `<img class="dl-img-pressed">`）、`public/app.css`（四模式显隐规则 + 按下强调）、`tools/layout/lab.html`（core 同步 + 新面板 + 舞台就地排布 + 预览空壳 + 设计态选择器驱动 `battleSlot`）<br>核对：`tests/frontend/layout-engine-d188.test.js`（**GF-1…GF-5 / PB-1…PB-9**，含 **digest 一致性**与**产品↔布局台双侧可达**）<br>引擎：`node tools/layout/make-engine.js` 再生成（**digest `3fb8c8b7d0354390`**） |

---

### 14.23 布局台预览改为「真实产品渲染」（2026-10-05 追加，D-189）

> 触发：用户 2026-10-05 —— **「完善预览弹窗流程部分，改为预览。可以在里面点击所有可交互的控件，
> 预览完整前端效果。必要的话可以加点 mock 数据（比如预览仓库和插件列表时需要看滚动视图是否正确）」**。

| D | 决策 | 落点 |
|---|---|---|
| **D-189** | ⚠️ **布局台的「预览弹窗流程」重做为「预览」，跑真实产品渲染管线**：<br>① **旧版是粗代模型**：自己画一批绝对定位 `div`（`.pvel`/`.pvmask`）、只认 `setState`/`target`/`modal-close` 三种行为、**不显示图片**、没有真实布局语义（滚动 / 网格 / 按下态 / 九宫格一律看不出来）。<br>② **新版直接跑产品管线**：`format.setLayout(engine, 当前编辑中的布局表)` → `format.viewModel(mock 状态)` → `render.render(vm)` → 把**真实 HTML** 塞进预览舞台；样式与产品同源。**所见即产品实际输出**。<br>③ **点所有可交互控件都执行真实动作**：事件委托按 `data-action` + `data-*` 载荷调用 `public/actions.js` 的注册表；弹窗栈由**产品状态机**（`state.hub.modals`）维护 ⇒ "点仓库 → 弹窗 → 切分类 → 点物品 → 详情 → 分解"整条链路在预览里跑真的。<br>④ **产品模块从同源 `/public/*.js` 加载**（`lab-server.js` 已有该路由；`ensureProduct` 逐个注入 `<script>`）。**已存在 `window.DL` 时直接用**（真页面上是 `index.html` 的脚本）—— 这条判据**先于**加载分支，否则无 HTTP 的环境（jsdom）会白走一遍注定失败的 fetch。直接双击 `file://` 打开时**明确提示原因**，不假装能用。<br>⑤ **预览不发真实请求**：`api` 出口换成桩。**读接口必须回带 mock 数据**（动作常常"点一下顺手重取一次"，如 `warehouse-open` 会调 `loadWarehouse`；桩一律回 `data:{}` 会把预览里的仓库**清空** —— 表现是"弹窗开了、选项卡也在、网格一个格子都没有"）；写接口回 `{}` 并在状态行提示"已模拟调用 xxx"。<br>⑥ **mock 数据照真响应写**（不是编的）：`mockMe` / `mockConfigs` / `mockWarehouse` / `mockAiLibrary`，形状与 `/me`、`/me/configs`、`/me/warehouse`、`/me/ai` 逐字段一致；六桶各 24 件、三份配置（含一个空槽）、AI 库 6 条。**改了后端字段这里要跟着改**。<br>⑦ **新增「仓库件数」开关**（4 / 24 / 60 / 200）：用户点名要验"滚动视图是否正确"—— 件数少时一屏放下、多时必须换行 + 出现滚动条。<br>⑧ **内置示例布局表补齐 `modal_warehouse` + `modal_item_detail`**（与工作区真实布局表同构）：否则预览里点仓库按钮会指向不存在的画面（校验直接报 error）。<br>⑨ **连带修掉三个真缺陷**（都留了回归断言）：**(a)** `layScreen` 的"布局表→产品动作"重写**无条件执行**，把布局表里显式接好的 `warehouse-open` 改成了 `layout-open`（界面没坏、点了走错路）；**(b)** 上一条修完后走向另一极端 —— 布局表里 `crest_role` 的**遗留 `config-open`** 盖住了它自己的 `target`，导致"指定了 target 却打不开弹窗" ⇒ 判据定稿为**"能打开画面的动作族（`OPENS_SCREEN`）优先保留，其余情况 `target` 优先"**；**(c)** `render.js` 的 `layAttrs` 是**显式白名单**，`bucket` 不在其中 ⇒ 仓库格子的 `data-bucket` 根本到不了 DOM（详情弹窗拿不到桶）—— 已补并纳入 BP-1 双向核对。 | 代码：`tools/layout/lab.html`（`MOCK_*` mock 数据 / `ensureProduct` / `pvBuildStore` / `pvRun` / `renderPreview` / `pvWire` / 预览工具条的「仓库件数」与「重来」/ `.pvel`-`.pvmask` 旧样式删除、`#pvstage` 作用域内的产品样式）；`public/format.js`（`layScreen` 的动作判据 `OPENS_SCREEN`）；`public/render.js`（`layAttrs` 输出 `data-bucket`）；`public/layout-engine.js`（再生成）<br>文档：`docs/frontend/07-layout-tool.md` 新增「预览：真实产品渲染」整节<br>核对：`runtime/test-layout-lab-browser.js` **16 组**（新增 ⑯ 预览：产品 DOM 渲染 / 点控件弹窗 / 点遮罩关闭 / 退出）；`runtime/test-layout-lab.js` 13 组；**真 HTTP 端到端 28/28**（起真 lab-server + jsdom `resources:'usable'`，走真的 `/public/*.js` 加载路径）<br>引擎：`node tools/layout/make-engine.js` 再生成（digest `a35bb7e9e6a88bba`） |

---

### 14.24 弹窗关闭方式统一为「点遮罩」，取消弹窗内的关闭键（2026-10-05 追加，D-190）

> 触发：用户 2026-10-05 —— **「弹窗外的遮罩部分点击后关闭弹窗，无需再为弹窗添加关闭键。
> 不论预览还是实际逻辑都是这样」**。

| D | 决策 | 落点 |
|---|---|---|
| **D-190** | ⚠️ **弹窗的唯一关闭方式 = 点弹窗外的遮罩；弹窗内不再画关闭键**：<br>① **删掉关闭键**：`modal_warehouse` 的 `wh_close`、`modal_item_detail` 的 `det_close` 从布局表移除（工作区真源 `layout-bundle.raw.json` 与布局台内置示例 `DEFAULT_BUNDLE` **同步删除**）。删除的是**关闭键**，不是操作键 —— `det_open`（开包）/ `det_dismantle`（分解）/ 6 个分类选项卡 / 网格原型**全部保留**。<br>② **遮罩是唯一出口，所以它必须可用**：`role='modal'` 的画面 `mask.closeOnMaskClick` **不得**为 `false` ⇒ 引擎 `validateLayout` 判 **error**（`弹窗禁用了「点遮罩关闭」，而弹窗已取消关闭键 → 玩家将无法关闭它`）。**这条是 D-190 的必要配套**：取消关闭键后，一旦遮罩也关不掉，玩家点哪儿都出不去 —— 这类"死胡同"必须在布局表校验阶段拦下，而不是等走查时才发现。<br>③ **连带把"遮罩不拦背景"降级为 warn 但仍报告**：`blocksBackground:false` 时底下按钮仍能被点到（弹窗形同穿透），给出可见提示。<br>④ **预览与产品同一套行为**：预览本就跑产品渲染 + 产品动作（D-189），所以删掉关闭键后，预览里也只能点遮罩关闭 —— **不需要为预览单独写关闭逻辑**（这正是 D-189 选"跑真管线"的回报）。<br>⑤ **修订 FR-10**：原文「弹窗内另有显式「取消」按钮」作废（见 `docs/frontend/00-rules.md` **FR-16**）。<br>⑥ **不在本轮范围**：**旧文字版弹窗**（`state.modal` 的出战配置编辑器 / AI 逻辑查看器等，`format.js` 的 `closeButton()` 8 处）仍带「关闭」按钮。它们属于被逐步替代的旧 UI 世代，且其「关闭」是文本按钮行的一员（不是叠加在界面上的关闭键）；其背景同样已支持点外关闭。**如用户要求统一，再单独一批处理**。 | 代码：`tools/layout/layout-bundle.raw.json`（删 `wh_close`/`det_close`）、`tools/layout/lab.html`（内置示例同步删 + 校验新增死胡同 error）、`public/layout-engine.js`（再生成）、`public/layout-data.js`（`import-layout` 再生成）<br>文档：`docs/frontend/00-rules.md` **FR-16**（并修订 FR-10）、`docs/frontend/07-layout-tool.md`<br>核对：**新增** `tests/frontend/modal-close-contract.test.js` **MC-1…MC-5**（布局表无关闭键 / 遮罩必须可关 / 渲染出的遮罩能逐层关闭 / 死胡同进校验器 / 操作键未被误删）；真 HTTP 预览核验 **10/10**（预览里无关闭键、点遮罩逐层关闭、操作键仍在）<br>引擎 digest `60997413dfbcbddc` |

---

### 14.25 修掉「预览里点弹窗外面关不掉」（2026-10-17 追加，D-191）

> 触发：用户 2026-10-17 —— **「为什么我预览的时候点击弹窗外的界面仍然无法关闭弹窗」**。
> D-190 的口径是对的，**实现坏了**：产品侧能用，只有预览不能用。

| D | 决策 | 落点 |
|---|---|---|
| **D-191** | ⚠️ **`dl-layer` 不得拦截点击；预览改为加载产品真样式表（单一真源），并加 DOM 级兜底**：<br>① **根因**：D-189 的预览**手抄了一份**产品 `.dl-*` 样式（`#pvstage .dl-*`），抄的时候把 `.dl-layer` 写成 `position:absolute;inset:0`。它铺满全屏、在 DOM 里排在 `.dl-mask` **之后** ⇒ 把整张遮罩盖住。点"弹窗外面"命中的是 `.dl-layer`（无 `data-action`）⇒ 什么都不发生。产品侧 `app.css` **从来没有 `.dl-layer` 的布局规则**（静态、零高），所以产品一直是对的 —— **只有预览坏**。<br>② **为什么之前的测试没抓到**：jsdom 没有命中测试，`modal-close-contract` / `probe` 都是**直接往遮罩节点派发 click**，绕过了"点击落在哪个元素上"。这类"只测事件不测命中"的断言对遮挡类缺陷是瞎的。<br>③ **修法一：预览不再手抄样式** —— `ensureProduct` 里注入 `<link href="/public/app.css">`，删掉布局台里全部 `#pvstage .dl-*` 副本（本轮还发现那份副本被**重复粘贴了一次**）。预览与产品从此共用同一份 CSS，不存在漂移。<br>④ **修法二：产品 CSS 把不变量写死** —— `.dl-layer{pointer-events:none}`（**只**这一条，注释里明写"不要给它 position/inset/height:100%"），元素用 `.dl-modal .dl-el{pointer-events:auto}` 重新接回点击；另修 `.dl-modal .dl-el.dl-clickthrough{pointer-events:none}`（原先 `.dl-clickthrough` 单类选择器被 `.dl-modal .dl-el` 压过，装进弹窗后失效）。<br>⑤ **修法三：DOM 级兜底（不依赖 CSS）** —— 产品 `app.js` 的 `onClick` 与预览的 `pvWire` 都加一条：**没命中任何 `[data-action]` 且点在 `.dl-layer`/`.dl-modal` 上 ⇒ 等同点遮罩**。这样即使将来有人又给 `.dl-layer` 加了尺寸，功能也不会再静默失效。<br>⑥ **门禁从"事件级"升级为"结构级"**：新增 `MC-6`（`.dl-layer` 规则体里不得出现 absolute/fixed/inset/height:100%，且必须 `pointer-events:none`）、`MC-7`（布局台不得再有 `#pvstage .dl-*` 副本、必须加载 `/public/app.css`）、`MC-8`（遮罩必须是 `.dl-modal` 的第一个直接子元素；`.dl-layer` 不得带内联 style；两处兜底必须存在）。 | 代码：`tools/layout/lab.html`（删手抄 CSS ×2、新增 `ensureProductCss`、`pvWire` 加包装层兜底）、`public/app.css`（`.dl-layer` 不变量 + clickthrough 优先级）、`public/app.js`（`isModalChrome` 兜底）<br>核对：`tests/frontend/modal-close-contract.test.js` **MC-6/MC-7/MC-8**；真 HTTP 预览核验 **12/12**（含**派发给 `.dl-layer`** 而非遮罩：计算样式 `position:static`/`pointer-events:none`/无内联 style，点包装层→关闭，点面板→**不关**）<br>文档：`docs/frontend/07-layout-tool.md` 预览节补"加载真样式表"与"`.dl-layer` 不变量" |

---

### 14.26 屏即界面：去掉页面级标题与屏外白框（2026-10-17 追加，D-192）

> 触发：用户 2026-10-17 —— **「预览和实际前端效果都应该直接只有这个屏，
> 不应再有上面的 debuglitev3 和外面一圈白框」**。

| D | 决策 | 落点 |
|---|---|---|
| **D-192** | ⚠️ **布局屏 = 整个界面；页面级 chrome 一律去掉**：<br>① **删页面级标题**：`public/index.html` 的 `<h1>Debug-Lite v3 · 账号</h1>` 移除；`index.html` 只剩 `#view` 一个可见容器。<br>② **布局屏不再输出 `<h2>`**：`render.js` 的布局分支原先固定 `['<h2>'+title+'</h2>']`，现在不画标题（`vm.title` 仍保留，供 `<title>`/文档用）。**文字屏（旧世代）仍保留 `<h2>`** —— 它们靠标题标识自己，这条口径只针对布局屏。<br>③ **白框根因**：`app.css` **从来没有 `body` 规则** ⇒ 深色 `.dl-screen` 落在浏览器默认**白色**页面里，且 `<body>` 有 8px 默认边距。修法：`html,body{margin:0;padding:0;height:100%;background:var(--dl-bg);overflow:hidden}`。<br>④ **屏铺满**：`#view>.dl-screen{position:absolute;inset:0}` —— 绝对占满 `#view`，不再靠 `aspect-ratio` 留出上下白边。<br>⑤ **屏外的三块改为"叠在屏上"**（否则它们会把屏挤小、甚至挤出滚动条）：`#notice` → 顶部居中 toast；`.buttons`（布局表没画但必须有入口的那几颗：刷新/阵容编辑/对战历史/管理面板）→ 底部居中悬浮条；旧文字版弹窗 `#modal` → 全屏浮层。为此 `render.js` 的布局分支把输出顺序改为 **屏 → 提示 → 兜底按钮 → 旧弹窗**（`#notice` 必须排在屏**之后**，CSS 才能用 `.dl-screen ~ #notice` 选中它）。<br>⑥ **预览侧**：`#pvbox` 去掉 `0 0 0 1px` 描边阴影、`.pvwrap` 内边距改 0、`#pv` 背景改深色；`pvScale` 不再从可用空间里扣 20px。预览里同样没有标题（它跑的就是 `render.js`）。<br>⑦ **注意 `index.html` 的注释**：删 `<h1>` 时留了说明性注释，里面**提到了**被删的标签文本 —— 断言前必须剥 HTML 注释，否则会被自己的注释骗成"没删"（本轮真踩到）。 | 代码：`public/index.html`（删 `<h1>`）、`public/render.js`（布局屏不输出 `<h2>`；输出顺序改为 屏→提示→按钮→旧弹窗）、`public/app.css`（`html,body` 深色铺满 + `#view>.dl-screen` 绝对铺满 + `~#notice`/`~.buttons`/`~#modal` 叠加层）、`tools/layout/lab.html`（`#pvbox`/`.pvwrap`/`#pv` 去框、`pvScale` 不扣 20px）<br>核对：**新增** `tests/frontend/screen-chrome.test.js` **SC-1/SC-2/SC-2b/SC-3/SC-4**（index.html 无 h1 且只有 #view / 布局屏无 `<h2>` 无「Debug-Lite」且首块是 `.dl-screen` / **文字屏仍保留 h2** / app.css body 深色铺满 + 屏绝对占满 / 预览无外框且不抄产品样式）；真 HTTP 预览核验 **16/16**（`#pvbox` box-shadow 计算值 `none`、`#pvwrap` padding `0px`、舞台无 h2、无「Debug-Lite」）<br>文档：`docs/frontend/07-layout-tool.md` 预览节 |

---

### 14.27 布局台界面整理：删静态讲解、右栏折叠、顶栏分组（2026-10-17 追加，D-193）

> 触发：用户 2026-10-17 —— **「现在这个布局工具太乱了，帮我整理下，把没用的提示信息都删掉，使用体验丝滑整洁一点」**。

| D | 决策 | 落点 |
|---|---|---|
| **D-193** | ⚠️ **布局台只留"活的状态行"，静态讲解一律清掉；结构改为折叠＋分组**：<br>① **顶栏 24 个控件散排 → 5+ 组**：画面 / 断点 / 吸附 / 元素 / 撤销·缩放 / 预览·校验·导入导出 / 存盘，组间竖线分隔；删掉冗长副标题「dev 原型 · 单文件 · 无依赖 · 编辑的是数据（JSON）」；「素材清单 / 归位素材」收进「更多」下拉（并实现**点别处自动收起** —— `<details>` 默认要再点一次才关，用起来别扭）。<br>② **右栏 8 个平铺分区 → 13 个可折叠 `<details>`**（元素·基本 / 位置形状 / 素材按下态 / 条件显示断点 / 容器滚动网格 / 文字视觉 / 画面属性 / 径向 / 设计期状态 / 断点预览 / 校验 / JSON / 存盘）。默认**只展开 2 块**（基本 + 位置形状），其余点开再看。<br>③ **校验块**收起时在标题上直接标数量（「校验 · 无问题」/「校验 · 2 错误 / 15 警告」），**有 error 才自动摊开**、标题转红。<br>④ **删掉的纯静态讲解**（用户点名的"没用的提示信息"）：层级区那段「点画面名=切过去…」、设计期状态那段 `when` 讲解、存盘区「素材出图规范…」长文、右栏最底部「这份布局表怎么被真代码消费？」整块 4 条要点、底栏铺开的 6 条快捷键（收进一个悬停提示 `快捷键 ⌨`）。<br>⑤ **保留**：所有**有 id 的 `.hint`** —— 它们是 JS 实时写的状态行（`pParentInfo`/`pGridInfo`/`pPressInfo`/`sInfo`…），删了会 null 崩。新增 `.hint:empty{display:none}`，空状态行不占位。<br>⑥ **左栏**：层级/平铺切换与统计压成一行，素材目录收进折叠（它只用于本地预览）。<br>⑦ **顺手修掉一个死类**：`class="primary"` 之前**从未定义**，主操作按钮（预览/存盘/一键应用）其实没有任何强调；现在补上定义。 | 代码：`tools/layout/lab.html`（CSS：顶栏分组/`details.sect` 折叠/`.hint:empty`/`button.primary`/`.hdr-more` 下拉；HTML：顶栏与左右两栏重排；app：`renderIssues` 写标题数量并按 error 自动展开、`hdr-more` 点别处收起）<br>核对：**新增** `tests/frontend/layout-tool-ui.test.js` **LT-1…LT-5** —— 其中 **LT-1 是自维护护栏**：把 app 脚本里 155 个 `$('id')` 引用逐个与 HTML 对账（整理最易犯的错就是删掉"看着只是提示"其实脚本在写的 DOM）；LT-2 默认展开 ≤3 块；LT-3 不得有无 id 的静态 hint；LT-1b core 不碰 DOM<br>实测：`node runtime/check-lab.js` 3/3；`test-layout-lab.js` 13 组；`test-layout-lab-browser.js` **16 组**；整洁度专项探针 **11/11**（13 个分区只开 2 块、无静态 hint、选中后 10 个状态行全部有内容、关键控件 30 项齐备、「更多」点画布自动收起、零 jsdom 错误） |

## 15. 待补充的数值（B21 已统一校准，见 D-127/D-128）
- **2026-09-28（D-173）变更**：`crit: 1.5` → **`critBonus: 1.0`**（暴击倍率 = `1 + critBonus + ΣcritMul` = 2.0）；新增 `lowHpThreshold: 0.5`（`rp_lowhp` 低血加攻阈值）。`defK` **保持 40 不变**。

## 16. 被 D-173 取代的旧决策（字段/机制退役登记，2026-09-28）

> 保留编号以便追溯（`interfaces.md` §5 仍按编号登记落点），但**其内容不再有效**；实现处一律改为"出现即被 schema 拦下"。

| D | 原决策 | 现状 |
|---|---|---|
| D-111 | `skill-templates.json` 新增 `slotWeights`（basic/special 权重） | **字段退役**：技能插槽 = 1 专属槽 + 品质区间的通用槽（`qualities.skillExclusiveSlots` / `skillSlotRange`） |
| D-113 | 技能插件消耗增量统一为逐档数组 `costDeltaByTier`；各品质基础值递增（绿 2 起） | **机制退役**：通用技能插件**零代价**（不加消耗/冷却）；专属插件用自身 `cost`/`cooldown` 覆盖配平；`qualities.costDeltaBase` 一并删除 |
| D-116 | 最大插件点数按建议值（绿 3 / 蓝 4 / …） | **改为品质区间** `qualities.pluginPointsRange`（2-3/4-6/6-9/8-12/10-15），点数由区间掷出 |
