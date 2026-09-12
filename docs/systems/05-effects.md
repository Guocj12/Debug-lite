# 效果系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。

## 1. 职责

- 效果的添加、每 tick 结算、到期移除。
- 持续效果（增减 hp/mp/sp/atk/def）。
- 控制效果（AI 返回行动后复写该行动：位移/眩晕）。

## 2. 依赖

- 无（纯状态操作）。

## 3. 数据结构

- 持续效果：`uid`、`kind=continuous`、`target`、`stat`（hp/mp/sp/atk/def）、`delta`（每回合 ± 值）、`remaining`、`source`。
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

1. 遍历 `continuous` 效果：`stat += delta`。
2. hp/mp/sp 结果 clamp 到 [0, 上限]；atk/def 结果 clamp 到 [0, 无上限]。
3. `remaining -= 1`，归零移除。

### 4.4 结算顺序

- 引擎每 tick：先 `resolveContinuousEffects`（改属性）→ 交给 AI 决策 → AI 返回行动后 `resolveControlEffects`（复写行动）。
- 控制效果在 AI 返回行动后应用，AI 感知到的状态不包含控制效果的影响。

## 5. 边界与异常

- `remaining = 0` 时立即移除，不结算。
- 同 `stat` 多个持续效果逐个独立结算、独立计时。
- 新效果下一 tick 起效，避免同 tick 重复结算。

## 6. 对外接口

- `addEffect`：技能命中/词条结算时调用。
- `resolveControlEffects` / `resolveContinuousEffects`：引擎每 tick 调用。

## 7. 测试要点

- 持续效果每 tick 增减与到期移除。
- 控制效果强制替换行动（位移方向/距离、眩晕）。
- 多个控制效果优先级。
- 新效果下一 tick 起效。
- hp/mp/sp 不越界（clamp 到 0 与上限）。
