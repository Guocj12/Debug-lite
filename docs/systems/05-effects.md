# 效果系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。

## 1. 职责

- 效果的添加、每 tick 结算、到期移除。
- 持续效果（增减 hp/mp/sp/atk/def）。
- 控制效果（AI 返回行动后复写该行动：位移/眩晕）。

## 2. 依赖

- 无（纯状态操作）。

## 3. 数据结构

- 持续效果：`uid`、`kind=continuous`、`target`、`stat`（hp/mp/sp/atk/def）、`delta`（每回合 ± 值）、`remaining`、`source`，以及运行期累计字段 **`applied`**（该效果**实际生效**的增量合计，clamp 修正后；仅 atk/def 用于到期回滚）。
- 控制效果：`uid`、`kind=control`、`target`、`displacement`（正负=方向，数值=距离，0=眩晕）、`remaining`、`source`。

## 4. 核心流程（代码逻辑）

### 4.1 添加 `addEffect(state, effect)`

1. 追加到目标角色的 `effects` 列表。
2. 新效果**从下一 tick 起**才开始结算（本 tick 不立即结算）。

### 4.2 结算控制效果 `resolveControlEffects(state, aiAction)`

1. 在 AI 返回行动**之后**调用，输入 AI 本 tick 的行动。
2. 遍历目标角色的 `control` 效果，生成「强制行动」：
   - `displacement > 0` → 向右移动 N 格（`N × 64px`）。
   - `displacement < 0` → 向左移动 |N| 格。
   - `displacement = 0` → 眩晕（本 tick 原地不动）。
   - **控制类位移一律不可穿过敌人**（D-71/D-15）：遇敌时走 `07-engine` 的"碰撞"分支（停在相遇点一侧并结算碰撞伤害），位移结果 clamp 到 `[32, 992]`，且不得使两角色中心距 < 64px。
   - **对 `fullDodgeDuring` 角色不施加控制**（D-72）：处于该状态的角色**免疫控制效果**（眩晕/击退/拉近均不生效），且**不参与弹幕判定**（视为无法命中）。
3. 多个控制效果并存时，取优先级最高者（眩晕 > 位移；位移取首个）。
4. **把 AI 返回的行动复写为该强制行动**，返回复写后的行动。
5. `remaining -= 1`，归零移除。

### 4.3 结算持续效果 `resolveContinuousEffects(state)`

1. 遍历 `continuous` 效果：先算 `after = 当前值 + delta`，再做钳制。
2. **钳制**：hp/mp/sp 结果 clamp 到 `[0, 上限]`（资源类）；atk/def 结果 clamp 到 `[0, 无上限]`（面板类，下限 0）。
3. **累计实际生效增量**：`applied += (after − before)`——即**钳制修正后真正生效的那部分**（不是名义 `delta`）。
4. `remaining -= 1`，归零移除。

**两种持续效果语义（2026-09-19 落地，务必区分）**

| 类别 | `stat` | 每 tick 结算 | 到期行为 |
|---|---|---|---|
| **面板修饰** | `atk` / `def` | 每 tick 把 `delta`（经下限钳制后的实际增量）加到面板上，并累计到 `applied` | **回滚累计增量**（`当前值 − applied`，再取 `max(0, …)`）→ 整段生效期**净 0**，严格回到施放前的值 |
| **资源池流量** | `hp` / `mp` / `sp` | 每 tick 结算即生效（clamp 到 `[0, 上限]`） | **不回滚**（回滚函数对资源类直接返回 0）——"已发生的血流/回蓝"是既成事实 |

- **为什么必须回滚面板类**：`cast_buff` 这类增益若永久留在面板上，一次释放就会**永久变强**（修前实测：`atk` 由"回到原值"退化为"永久 +4"）。回滚记录的是**实际生效**增量，因此钳制过的 tick 也精确（例：atk 12 叠加 `−4` 与 `−20` → 实际只生效 `−4`/`−8` 到 0，到期后回到 **12** 而不是负数或 0）。
- 引擎接入点：`engine.js` 步骤 2 调用 `resolveContinuous`（每 tick，先于 AI 决策）；`castEffects` 在步骤 6 `addEffect`（下一 tick 起效，D-70）。

### 4.4 结算顺序

- 引擎每 tick：先 `resolveContinuousEffects`（改属性）→ 交给 AI 决策 → AI 返回行动后 `resolveControlEffects`（复写行动）。
- 控制效果在 AI 返回行动后应用，AI 感知到的状态不包含控制效果的影响。

## 5. 边界与异常

- `remaining = 0` 时**在下一次结算入口立即移除、不再结算**（进入 resolve 时先清理 `remaining <= 0` 的项；面板类在此刻回滚 `applied`）。
- 「立即移除」不等于「延迟回滚」：面板类（atk/def）的回滚发生在**移除那一刻**，因此到期 tick 的净效果 = 其余仍存活效果的结算 + 本效果的 `−applied`。资源类（hp/mp/sp）**不回滚**。
- 同 `stat` 多个持续效果逐个独立结算、独立计时、**独立回滚**（`applied` 各记各的）。
- 新效果下一 tick 起效，避免同 tick 重复结算。
- 面板类下限 0：回滚取 `max(0, 当前值 − applied)`，不会出现负面板值。

## 6. 对外接口

- `addEffect`：技能命中/词条结算时调用。
- `resolveControlEffects` / `resolveContinuousEffects`：引擎每 tick 调用。

## 7. 测试要点

- 持续效果每 tick 增减与到期移除。
- **面板类（atk/def）到期回滚累计实际增量（含钳制修正）→ 净 0**；资源类（hp/mp/sp）到期**不回滚**（`effects.test.js` EF-17/EF-18/EF-19）。
- 控制效果强制替换行动（位移方向/距离、眩晕）。
- 多个控制效果优先级。
- 新效果下一 tick 起效。
- hp/mp/sp 不越界（clamp 到 0 与上限）。
