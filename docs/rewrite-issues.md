# 前端重写待决策问题登记（p6-rewrite 分支）

> 用途：R0..R7 批次推进中遇到的**无法自行解决或需要用户拍板**的问题登记于此，当批跳过；全部批次完成后统一解决。
> 约定：`RW-n` 编号；已拍板/已解决的条目移入文末「已处理」。

## 待处理（需要用户拍板）

| # | 批次 | 问题 | 选项/默认取向 | 状态 |
|---|---|---|---|---|
| RW-5 | R3 | 开箱结果的「逐张出现动画（120ms 间隔，§6.4）」本轮重写为**即时渲染 + toast「新物品 xN」**（用户指示样式从简、按钮/场景清晰即可）。如需逐张动画请拍板 | A. 保持即时渲染（本轮默认） / B. 恢复 120ms 逐张出现链 | 待拍板 |
| RW-6 | R5 | 回放播放采用**逐帧快照（每 1000/speed ms seek 下一帧）**，planFrame 已支持插值参数 t 但默认 t=1 不做帧间滑动（§7.1 插值）。如需帧间平滑请拍板 | 本轮默认快照播放；插值公式已实现并测试 | 待拍板 |
| RW-7 | R4 | 对手三模板（kiter/charger/cautious）为**前端内置模板**（与 B24 后端 bot 同构但独立登记），技能 id 已对齐数据表（skill_melee_whirl / skill_straight_precise）；是否需要后端提供对手清单端点请拍板 | 本轮维持前端模板（与旧 F4 同口径） | 待拍板 |

## 已处理（当批已定，留档）

| # | 批次 | 问题 | 处置 |
|---|---|---|---|
| RW-1 | R1 | frontend-spec §4.1 的 state.warehouse 写为扁平桶 `{roles,skills,rolePlugins,skillPlugins}`，与后端 B18 冻结的仓库形状 `{buckets:{role,skill,rolePlugin,skillPlugin}}` 不一致 | 按权威链以后端形状为准（buckets 形状），前端全程统一；后续批次如遇同类冲突同此处理 |
| RW-2 | R1 | spec §4.1 logPrefs 含 `panelOpen:false`，而 §8 只持久化 `{level,channels}` | panelOpen 属临时 UI 态，放 state.logPrefs 但不落盘；persist 白名单照 §8 |
| RW-3 | R1 | spec §4.2 `battle:{...speed}` 未含播放态字段，回放需要 playing 标志 | state.battle 增加 `playing`（播放状态机专用，不持久化）；属形状补充不冲突 |
| RW-4 | R2 | spec §3.5 zconflict 判「子 z ≤ 父 z」，但面板内嵌同层子盒（如 channels⊂logPanel）是正常 DOM 嵌套，screens.md 表中两者同为 z2 | 自检器放宽为「子 z < 父 z 才判颠倒」；screens.md 表坐标/z 仍逐行锁定 |
