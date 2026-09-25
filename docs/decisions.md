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

## 15. 待补充的数值（B21 已统一校准，见 D-127/D-128）

- 已随 B21 校准定稿：`movePx=64`、`dodgePx=128`、`collisionDmgMul=0.8`、`baseHitMul=0.8`、`defendDefMul=1.6`、`dodgeChanceBonus=0.20`（**D-127**）、`defK=40`（入表，**D-128**）、`overtimeRatio=0.0625`、`overtimeStart=48`、`hardCapTick=64`、`baseDef=64`、`backstab=1.5`、`crit=1.5`——全部冻结于 `battle-config.json`，**不再开放**。
