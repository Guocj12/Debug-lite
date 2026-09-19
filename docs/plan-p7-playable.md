# P7 冲刺计划：让后端「完全可玩」+ 批量压力测试

> 创建：2026-09-16　角色：本文件是**本轮冲刺的唯一执行蓝图**（比 `tasks.md` 的批次表更具体：阶段顺序、文件所有权、验收标准）。
> 目标（用户原话）：**「这次会话结束后要有一个完全可玩的后端」**，并且「服务器链路完整跑通后开批量测试，注册大量玩家，模拟各个段位的玩家同时在线，匹配，战斗」。
> 权威链不变：`decisions.md` > `systems/*` > `v3-design.md` > `tasks.md`；本文件只做**执行编排**，不改变任何设计结论。

---

## 0. 全局约束（每个阶段都必须满足）

1. **机器门禁全绿**：`npm test`（全量用例）、`npm run gate`（9 项，禁止放宽覆盖率阈值）、`npm run check:docs`、`node scripts/fe-spec-check.js` 四项必须 PASS 后才允许提交。
2. **提交前必须更新任务清单**：`.githooks/pre-commit` 会拦截"改了代码但没改 `docs/tasks.md`/`docs/progress.md`"的提交；提交信息必须写批次号 + 实跑结果。
3. **同一文件同一时刻只允许一个执行者**（本会话多次因并行改同一文件出现"半写状态导致测试瞬时红"）。
4. **零 npm 依赖**；禁 `child_process`（沙箱与项目铁律）、禁 `Math.random`（用种子化 RNG）；中文文档禁止用 PowerShell 写（会双重编码损坏）。
5. **`server/store/*` 是唯一允许 `node:fs` 的目录**；`server/core/**` 禁 IO/console。
6. 新功能一律**默认可关闭**（如 `DL_LEGACY_STATELESS`、门控开关），保证旧链路与既有测试不被破坏。

---

## 阶段与验收

### P7-0　关闭段位门控（用户 2026-09-16 指示：「默认所有功能全部解锁，段位不参与判定」）
- 范围：`server/data/unlock.json` 增加总开关（`gating.enabled=false`）；`server/core/unlock.js`（`availableNodes/isUnlocked/filterByTier/validateLoadout`）、`server/core/items.js`（`validateUnlock`、`rollQuality` 的品质截断）、`server/box.js`、`server/loadout.js`、`server/ai/ast.js`（`node_locked`）读开关。
- 要求：**保留门控逻辑与数据字段**（`unlockTier`、段位树作元数据），只是默认不参与判定；提供 `withGating(true|false)` 工厂，使**开/关两种模式都有测试覆盖**（否则原有 `tier_locked`/`node_locked`/品质上限用例会全失效，将来无法安全重启门控）。
- 边界（已与用户确认的默认）：**排位晋升与段位奖励暂留**（属"进度"而非"门控"）；P7 快速对战按 **Elo 积分**匹配，不用段位。
- 验收：门控开/关两套用例全绿；`/api/v1/box` 不再受 `tier` 限制；`ast.validate` 不再报 `node_locked`。

### P7-1　存储层（B27）——**已在进行**
- 交付：`server/store/*`（适配器契约 + JSON 适配器：原子写 tmp→fsync→rename + Windows 重试、append-only journal + 幂等 apply、物化档案、内容寻址快照库、`byTier`/`leaderboard` 索引、单进程锁、崩溃恢复、`schemaVersion` 迁移、`seq` 重启来源定死）；`scripts/check-arch.js` 登记新层；`tests/contract/store-contract.test.js` + `tests/unit/store-*.test.js`。
- 数据根：`DL_DATA_DIR`（默认 `<repo>/runtime`，已 gitignore）；适配器选择：`DL_STORE`（默认 `json`；`node:sqlite` 为预留迁移路径，见 `systems/11-account-store.md` §11.4）。
- 验收：契约测试全绿；畸形/截断 journal 能恢复且**不产生半场战绩**；重复 apply 幂等；锁文件能拒绝二次启动。

### P7-2　身份与会话（B28）
- 交付：`server/auth.js`（`register/login/logout/changePassword/authenticate`、token 下发与撤销、登录失败限速与锁定）；`server/account.js`（`getSummary/listConfigs/saveConfig/activateConfig/createSlot/deleteSlot/saveWarehouseMirror/records/markSeen/defenseSummary`）。
- 规则（`decisions.md` D-129/D-131/D-134）：配置槽 **≤3、唯一出战、必有出战、注册即默认配置**；战绩带 `seq` 游标与未读游标。
- 验收：注册 → `GET /me` → 配置槽 CRUD（含 `409 slot_limit`/`slot_locked`）→ 战绩增量/未读 → 防守战绩汇总；`401` 语义正确。

### P7-3　排位改造与快速对战（B31/B32）
- 交付：`server/ranked.js` 改为**档案驱动**（服务端抽池、双向记账、发起者同步结算 + 防守方离线只记战绩不掉段不掉分，D-132）；`server/quickmatch.js`（非对称 Elo：0 起、上限 3000、均衡点 `R = cap×(2×胜率−1)`，D-133）；`leaderboard` 索引；`server/admin.js`（注入 bot、重建索引，需 `DL_ADMIN_TOKEN`）。
- 对手去重：同一对手 24h（候选不足放宽 72h），服务端抽池不许自选对手（D-136）。
- 验收：10 场排位结算 + 双向记账可复算；Elo 结算与均衡点公式有机器复算用例；离线防守方战绩可见。

### P7-4　HTTP/CLI 接线（B28~B33）
- 交付：`server/index.js` 中间件（`Authorization: Bearer` 鉴权、`401/403/404/409/410/429` 语义、`DL_*` 环境变量、`DL_LEGACY_STATELESS` 默认 1 保持旧端点）；回放 **LRU 64 + 参与者鉴权 + `410 replay_expired`**（D-135）；`cli/index.js` 新子命令（`auth`/`me`/`quick`/`leaderboard`/`ranked promote`）与**退出码 3 = 未鉴权**。
- 要求：既有无状态端点（`box`/`warehouse*`/`loadout`/`panel`/`ai/*`/`battle`）**全部保持可用**（gate 项 9 冒烟与 `tests/api`、`tests/cli` 依赖它们）。
- 验收：新端点逐个冒烟；旧端点零回归；CLI 闭环含鉴权。

### P7-5　全链路端到端（`npm run e2e`）
- 交付：`scripts/e2e.js`（或等价）+ `tests/integration/e2e-play.test.js`，**模拟真实玩家**按顺序跑通并打印每一步真实响应：
  注册 → `GET /me` → 开箱 → 提交仓库镜像 → 装配 → 配置槽保存/出战 → 写 AI（`/ai/validate` + `/ai/compile`）→ 对战（`/battle`）→ 回放（`/replay/:id`，含 `403`/`410` 分支）→ 排位（`/ranked/run` + `/ranked/promote`）→ 战绩/防守战绩/未读（`/me/records`、`/me/defense`）→ 排行榜（`/leaderboard`）→ 快速对战（`/quick/run`，验证 Elo 变化）。
- 验收：一条命令跑通、退出码 0、输出含每步关键字段；纳入 `npm test`。

### P7-6　批量测试（用户要求：注册大量玩家、多段位并发在线、匹配、战斗）
- 交付：`scripts/load-test.js`（`npm run load-test`），要求：
  1. **批量注册** N 个玩家（默认 N=200，可 `--players`），并发（批次化 `Promise.all`，避免单点串行）；
  2. 每个玩家：开箱 → 建仓库 → 装配 → 存配置槽 → 出战（覆盖多个"段位/积分档"，因为门控已关闭，用积分分布模拟不同水平玩家）；
  3. **并发在线 + 匹配 + 战斗**：同时发起排位与快速对战（`/ranked/run`、`/quick/run`），统计**吞吐（场/秒）、P50/P95 延迟、错误率**；
  4. **数据完整性断言（关键）**：journal 幂等（重复 apply 不重复记账）、**无半场战绩**、积分守恒（双轨记账前后总和符合公式）、`leaderboard` 索引与档案一致、回放 LRU 不越界；
  5. 产出报告：`runtime/load-report.json` + 终端摘要（不要写进仓库根目录）。
- 验收：N=200 稳定跑完、无 5xx、完整性断言全过；报告里给出实际数字。

---

## 交付定义（"完全可玩的后端"）

一条命令能让人从零走到"打完一场并看到成长"：
`npm run play`（离线文本试玩，已交付）→ `npm start` + `npm run e2e`（联网全链路）→ `npm run load-test`（批量并发）。
判定标准：**e2e 与 load-test 都绿 + 四项门禁全绿 + 上述各阶段验收项逐条通过**。

## 已知风险

1. **并行冲突**：每次只允许一条线改同一文件；本会话已两次因并行半写导致瞬时红。
2. **崩溃测试**：沙箱禁 `child_process`，`T-ST-1`（子进程 kill）用"构造畸形/截断 journal 再加载"等价替代。
3. **回放体积**：实测 61–268 KB/场（旧文档 7–20 KB 偏小一个数量级），LRU 64 时上限约 4–17 MB（可接受，但需在报告中记录）。
4. **`.audit/fe-samples.json` 必须重采**：快照字段扩充（`tick`/`cooldowns`/`effects`/`max*`/`bases.*`/`baseHp` 语义修正）后需重采，且必须在数据表改动收敛之后做。
5. **文档同步债务**：每阶段完成后同步 `interfaces.md`/`server.md`/`tasks.md`/`progress.md`/`frontend-spec.md`/`systems/09-unlock.md` 等，并登记用户决策到 `decisions.md`。
