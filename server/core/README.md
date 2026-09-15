# server/core/

**确定性内核（L11 纯函数）**：禁 IO / `Math.random` / `eval` / `new Function` / `console.*`；随机与日志一律**注入**（缺省 `nullLogger`）；战斗数值来自 `server/data/*.json`（L9）。

模块（`tasks.md` §2.2，B1~B11 逐个落地）：

| 模块 | 职责 | 批次 |
|---|---|---|
| `rng.js` | 种子 RNG：每 tick 每用途派生流（D-91） | B1 |
| `field.js` | px 坐标 / clamp / 基地区域 | B1 |
| `effects.js` | 持续/控制效果结算 | B2 |
| `items.js` | 物品生成 / 词条 / 仓库装配（数值+仓库两层） | B3/B17~B20 |
| `unlock.js` | 段位解锁门控 | B4 |
| `roles.js` | 角色实例化 / 修饰 / 插件 | B5 |
| `skills.js` | 技能实例化 / 四类型行为 / canCast | B6 |
| `bullets.js` | 弹幕：当 tick 全解算 + 连续方程 + 等级抵消 | B7 |
| `engine.js` | 14 步 tick 管线 / 伤害 / 结束判定 | B8~B11 |