# 前端重写待决策问题登记（p6-rewrite 分支）

> 用途：R0..R7 批次推进中遇到的**无法自行解决或需要用户拍板**的问题登记于此，当批跳过；全部批次完成后统一解决。
> 约定：`RW-n` 编号；已拍板/已解决的条目移入文末「已处理」。

## 待处理（需要用户拍板）

| # | 批次 | 问题 | 选项/默认取向 | 状态 |
|---|---|---|---|---|
| — | — | （暂无） | — | — |

## 已处理（当批已定，留档）

| # | 批次 | 问题 | 处置 |
|---|---|---|---|
| RW-1 | R1 | frontend-spec §4.1 的 state.warehouse 写为扁平桶 `{roles,skills,rolePlugins,skillPlugins}`，与后端 B18 冻结的仓库形状 `{buckets:{role,skill,rolePlugin,skillPlugin}}` 不一致 | 按权威链以后端形状为准（buckets 形状），前端全程统一；后续批次如遇同类冲突同此处理 |
| RW-2 | R1 | spec §4.1 logPrefs 含 `panelOpen:false`，而 §8 只持久化 `{level,channels}` | panelOpen 属临时 UI 态，放 state.logPrefs 但不落盘；persist 白名单照 §8 |
| RW-3 | R1 | spec §4.2 `battle:{...speed}` 未含播放态字段，回放需要 playing 标志 | state.battle 增加 `playing`（播放状态机专用，不持久化）；属形状补充不冲突 |
