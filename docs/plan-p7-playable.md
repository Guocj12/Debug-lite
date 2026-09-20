# P7 冲刺计划：让后端「完全可玩」+ 批量压力测试

> 创建：2026-09-16　角色：本文件是**本轮冲刺的唯一执行蓝图**（比 `tasks.md` 的批次表更具体：阶段顺序、文件所有权、验收标准）。
> 目标（用户原话）：**「这次会话结束后要有一个完全可玩的后端」**，并且「服务器链路完整跑通后开批量测试，注册大量玩家，模拟各个段位的玩家同时在线，匹配，战斗」。
> 权威链不变：`decisions.md` > `systems/*` > `v3-design.md` > `tasks.md`；本文件只做**执行编排**，不改变任何设计结论。

---

## 0. 全局约束（每个阶段都必须满足）

1. **机器门禁全绿**：`npm test`（全量用例）、`npm run gate`（9 项，禁止放宽覆盖率阈值）、`npm run check:docs` 三项必须 PASS 后才允许提交。
2. **提交前必须更新任务清单**：`.githooks/pre-commit` 会拦截"改了代码但没改 `docs/tasks.md`/`docs/progress.md`"的提交；提交信息必须写批次号 + 实跑结果。
3. **同一文件同一时刻只允许一个执行者**（本会话多次因并行改同一文件出现"半写状态导致测试瞬时红"）。
4. **零 npm 依赖**；禁 `child_process`（沙箱与项目铁律）、禁 `Math.random`（用种子化 RNG）；中文文档禁止用 PowerShell 写（会双重编码损坏）。
5. **`server/store/*` 是唯一允许 `node:fs` 的目录**；`server/core/**` 禁 IO/console。
6. 新功能一律**默认可关闭**（如 `DL_LEGACY_STATELESS`、门控开关），保证旧链路与既有测试不被破坏。
7. **每个阶段/新功能完成后，必须做一次「代码级审查」并修复**（用户 2026-09-16 要求）。审查必须**逐条**回答：
   - **功能完整度**：声称交付的每一项，是否真的端到端可用（不是只有单测/只有核心层可用、经 HTTP/CLI 路径失效）？
   - **空实现 / 占位**：是否有 stub、`TODO/FIXME`、只返回常量或恒真/恒假的分支、注册了却没人消费的字段（如"数据表有字段但代码从不读"）、有定义无调用的导出（dead code）？
   - **冲突 / 重合**：是否有两套实现做同一件事（面板聚合、校验、路径解析、去重）、镜像清单不同步（代码内注册表 vs 数据表枚举 vs 文档清单）、语义互相打架（同一字段两处不同解释）、新旧路径对同一输入给出不同结果？
   - **副作用与回归**：是否破坏了既有契约（帧契约、错误码、退出码、日志事件、覆盖率阈值）？
   - 发现的问题**必须在本阶段内修复**（无法修的要在 `progress.md` 登记为显式待办 + 原因），并重跑四项门禁。
   - 审查要**独立**：由未参与该阶段实现的执行者做（子代理或用户），并留下可核对的证据（文件:行 + 实测命令/输出）。

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
- **🚫 禁止注入占位 bot 充数（用户 2026-09-16 明确要求："不要用占位 bot 这种东西敷衍"）**：匹配池**只能**由**真实玩家档案**（真实注册、真实出战配置、真实 AI 的快照）构成；池内候选不足时，按设计**少打几场并回报 `shortfall`**（`10-ranked.md` §4.3 的"池不足不注入 bot"），**不得**用 `BOT_LD` 之类垫片把场次凑满。既有 `ranked.js` 的 bot 补齐逻辑必须在本阶段移除或改为"仅显式调试开关（默认关闭）＋日志标注"。验收时必须能证明：对局双方 `playerId` 都是真实注册玩家，且无 bot 参与。
- 验收：10 场排位结算 + 双向记账可复算；Elo 结算与均衡点公式有机器复算用例；离线防守方战绩可见。

### P7-4　HTTP/CLI 接线（B28~B33）
- 交付：`server/index.js` 中间件（`Authorization: Bearer` 鉴权、`401/403/404/409/410/429` 语义、`DL_*` 环境变量、`DL_LEGACY_STATELESS` 默认 1 保持旧端点）；回放 **LRU 64 + 参与者鉴权 + `410 replay_expired`**（D-135）；`cli/index.js` 新子命令（`auth`/`me`/`quick`/`leaderboard`/`ranked promote`）与**退出码 3 = 未鉴权**。
- 要求：既有无状态端点（`box`/`warehouse*`/`loadout`/`panel`/`ai/*`/`battle`）**全部保持可用**（gate 项 9 冒烟与 `tests/api`、`tests/cli` 依赖它们）。
- 验收：新端点逐个冒烟；旧端点零回归；CLI 闭环含鉴权。

### P7-5　全链路端到端（`npm` 脚本 `e2e`）
- 交付：`scripts/e2e.js`（或等价）+ `tests/integration/e2e-play.test.js`，**模拟真实玩家**按顺序跑通并打印每一步真实响应：
  注册 → `GET /me` → 开箱 → 提交仓库镜像 → 装配 → 配置槽保存/出战 → 写 AI（`/ai/validate` + `/ai/compile`）→ 对战（`/battle`）→ 回放（`/replay/:id`，含 `403`/`410` 分支）→ 排位（`/ranked/run` + `/ranked/promote`）→ 战绩/防守战绩/未读（`/me/records`、`/me/defense`）→ 排行榜（`/leaderboard`）→ 快速对战（`/quick/run`，验证 Elo 变化）。
- 验收：一条命令跑通、退出码 0、输出含每步关键字段；纳入 `npm test`。
- **注记（2026-09-19 小修）**：`scripts/e2e.js` 原末尾的「已知后端缺陷 D1：第 6 步出战配置剥离装配引用 →
  `/ranked/run`、`/quick/run` 会以 `missing_warehouse` 失败」**已失效并删除**。缺陷 B（进程内仓库镜像 +
  已校验快照退化口径，`server/ranked.js` / `server/quickmatch.js`）与缺口 1（冻结快照随正文持久化
  `archive.warehouseExcerpt` 镜像片段）均已修复，故 e2e 第 6 步**回收**了"剥离 `pluginUid`"的适配：
  出战配置原样保留真实装配引用，第 7 步用真镜像 `POST /panel ≡ buildPanel`（并以"去掉 warehouse 必
  `missing_warehouse`"作反证）。
- **抽池可控性（同日复审修正）**：`/quick/run`、`/ranked/run` 的**对手**由服务端抽池决定（池内任意真实
  玩家，默认配置者 0 处装配引用），因此"含装配插件的配置能出战"的判定**一律锚在发起者侧**（第 11 步 = B、
  第 14/21/22 步 = A，都是 `authed(<玩家>.token)` 的确定侧），**不得**假设"抽中的一定是 A"（该假设会间歇假红）。
  对手抽中 A 时额外做同款全链核验；抽中默认配置玩家时**如实打印**该事实。第 21 步另用 legacy `/battle`
  （p1 = p2 = 含装配引用的同一配置 + 真镜像）做**双方**确定性的出战证明（`ticks>0`、帧数 == ticks）。
  统一判定实现在 `scripts/e2e.js` 的 `verifyPluginSide()`（引用为真 + 缺口 1 持久化 + 面板 ≡ 真镜像 +
  去 warehouse 反证）。仍然 `PASS 检查点=22/22`。

### P7-6　批量测试（用户要求：注册大量玩家、多段位并发在线、匹配、战斗）
- 交付：`scripts/load-test.js`（`npm run load-test`），要求：
  1. **批量注册** N 个玩家（默认 N=200，可 `--players`），并发（批次化 `Promise.all`，避免单点串行）；
  2. 每个玩家：开箱 → 建仓库 → 装配 → 存配置槽 → 出战（覆盖多个"段位/积分档"，因为门控已关闭，用积分分布模拟不同水平玩家）；
  3. **并发在线 + 匹配 + 战斗**：同时发起排位与快速对战（`/ranked/run`、`/quick/run`），统计**吞吐（场/秒）、P50/P95 延迟、错误率**；
  4. **数据完整性断言（关键）**：journal 幂等（重复 apply 不重复记账）、**无半场战绩**、积分守恒（双轨记账前后总和符合公式）、`leaderboard` 索引与档案一致、回放 LRU 不越界；
  5. 产出报告：`runtime/load-report.json` + 终端摘要（不要写进仓库根目录）。
- 验收：N=200 稳定跑完、无 5xx、完整性断言全过；报告里给出实际数字。
- **🚫 必须用真实玩家，不用占位 bot（用户 2026-09-16 明确要求）**：流程固定为
  1. **并发批量注册** N 个真实玩家（`/auth/register`）；
  2. **为每个玩家配齐完整出战配置**：开箱 → 仓库镜像 → 装配（角色插件 + 技能插件）→ 配置槽保存并出战 → **为每个玩家生成/提交一份 AI 程序**（用 `play.js` 的预设变体 + 随机种子生成**行为各不相同**的程序，并通过 `/ai/validate`+`/ai/compile`）；
  3. **先建池、后匹配**：等服务器内档案/快照数量达到阈值（例如 ≥ 与目标场次同量级）再发起排位与快速对战——**不得**用 bot 补位；
  4. 统计吞吐/延迟/错误率 + **数据完整性断言**（journal 幂等、**无半场战绩**、积分守恒、`leaderboard` 与档案一致、回放 LRU 不越界、**每场对局双方都是真实 playerId**）；
  5. 覆盖"**不同水平玩家**"：通过对战结果自然产生积分/段位分布（不要手工写死），并报告分布曲线。

### P7-7　测试体系审查：冗余项与缺口（用户 2026-09-16 要求）
- 目标：现有 500+ 用例是否存在**冗余**（同一分支被多个用例重复覆盖、自证式断言、只断言"不抛"而不断言语义）与**缺口**（未覆盖的玩家路径、错误分支、边界、并发、状态迁移）。
- 交付：一份**测试矩阵审查报告**（按目录 × 行为维度：冗余项清单 + 缺口清单 + 建议的新增/合并/删除），并据此**合并冗余、补齐缺口**；补齐重点：
  - 端到端玩家路径（不含 bot 的真实对局）；
  - 持久化与并发（journal 幂等/并发写/崩溃恢复/锁）；
  - 错误与边界（401/403/404/409/410/429、畸形输入、越界、超时）；
  - 属性测试（往返/守恒/不变量：积分守恒、hp 守恒、回放可重建）；
  - 门禁自身的"投毒"验证（每个检查器都必须有一条"故意造错 → 必须 FAIL"的用例，防空转）。
- 验收：报告 + 改动后四项门禁全绿，且用例总数与覆盖分布有明确变化说明（不得只增不减地堆用例）。

#### 审查结论与 P0 清单（2026-09-16）

> **本节由独立只读审查得出；执行时按 `docs/plan-p7-playable.md` §0 第 7 条（每次新功能后必须做代码级审查并修复）逐项闭环。**
> 完整报告（含全部 `文件:行` 证据、冗余清单 R1–R8、缺口清单 B1–B8、投毒矩阵、覆盖率两张表）：**`docs/reviews/P7-7-test-audit.md`**。
> 审查时刻的基线告警（务必先读）：同一套测试 6 分钟内三次结果 `fail 3 → fail 11 → fail 10`；`npm run gate` = 7 PASS / 2 FAIL（项 3 架构、项 7 测试）；`npm run cov` 因分支聚合 84.98% < 85% 而红；`tests/unit/mechanics.test.js` 单独运行 20/20 全过 —— 当前无任何机器手段区分"红 1 条"与"红 11 条"。

| # | 动作 | 文件 | 验收 |
|---|---|---|---|
| ① | **新增** 基线指纹工具 | `scripts/baseline.js`（新建）；在 `scripts/gate.js` 输出中打印 | 记录用例总数 + 失败用例名指纹；`node scripts/baseline.js` 打印 `tests/pass/fail` 与失败清单；gate 报告尾部含该行。目的：区分"红 1 条"与"红 11 条"（并行半写场景）。 |
| ② | **新增** HTTP/CLI 公共 helper | `tests/helpers/http.js`、`tests/helpers/cli.js`（新建） | 7 份 `request()`、14 份 `withServer()`、7 份 `quiet()` 全部改为 require；`tests/api/*`、`tests/cli/*` 用例数与断言数**不减少**；后续加 `Authorization: Bearer` 头只改 1 处。 |
| ③ | **新增** 端到端玩家路径 | `tests/integration/e2e-play.test.js`（新建） | 覆盖 `docs/reviews/P7-7-test-audit.md` §B1 的 **22 个检查点**（注册→登录→`GET /me`→开箱→仓库镜像→装配→配置槽/出战→AI validate/compile→对战→回放→排位 run/promote→战绩/防守/未读→排行榜→快速对战），含 `401/403/409/410/429` 分支；纳入 `npm test`，一条命令可单跑。 |
| ④ | **新增** 快速对战不变量 | `tests/integration/quickmatch-invariants.test.js`（新建） | 断言：**积分守恒**（`Σrating(前) + ΣΔ = Σrating(后)`，对局粒度 + 全局粒度闭合）、**Elo 可复算**（`R' = R + K(S−E)` 双方 Δ 机器复算相等）、**cap 3000 不越界**、**每场对手 ID ∈ 注册表（= 无 bot 参与）**。 |
| ⑤ | **修改** 删除 bot 占位断言 | `tests/unit/ranked.test.js:20-49`、`:78-85` | 删掉「无池（bot 补齐）→ 恒 10 场」「池 3 → 补 7 bot」「`BOT_LD.skills.length===3`」等断言；改为 `pool: []` → **断言 `shortfall` 且 `matches < 10`**、`results.every(r => 对手是真实注册玩家)`。**用户明令：不许用占位 bot 敷衍**（`systems/10-ranked.md` §4.3「池不足不注入 bot」）。 |
| ⑥ | **修改 + 新增** check-docs 投毒 | `scripts/check-docs.js` 增 `checkDocs({ projectRoot })` 注入缝；`tests/integration/check-docs-poison.test.js`（新建） | D1–D6 **各至少 1 条**「故意造错 → 必须 FAIL」（临时目录 fixture）；**重点回归 D5 的历史绕过**：`\| B1 [ ] \|` 形式（ID 后紧跟竖线但未勾选）必须被抓（修复见 `check-docs.js:91-92`，当前零回归用例）。 |
| ⑦ | ~~**新增** gate 项 8/9 + fe-spec 投毒~~ | `tests/integration/gate-poison-extra.test.js`（保留）；`tests/frontend/fe-spec-poison.test.js` 与 `scripts/fe-spec-check.js`（**已于 2026-09-20 随前端设计删除**） | gate **项 8** 3 条（关键事件缺失 / cid 链乱序 / trace≠silent）+ **项 9** 2 条（health 信封异常 / CLI 退出码非 0）必 FAIL（**仍有效**）。 |
| ⑧ | **新增** 试玩入口回归 | `tests/unit/play.test.js`（新建） | `scripts/play.js`（322 行）当前 **0% 覆盖**（从未被任何测试加载）：断言同 seed 两次输出**逐字节一致** + 每步合法性（开箱品质 ≤ 段位上限、装配后 panel 五维 ≥ 1、`winner ∈ {p1,p2,draw}`）。 |
| ⑨ | ~~**修改** 覆盖率阈值口径~~ | 该行提到的 `scripts/fe-spec-check.js`（分支 64.73%）**已于 2026-09-20 删除**，其豁免随之失效；其余（`battle.js`/`runner.js`/`schema.js`/`check-docs.js`）仍按 `scripts/README.md` 的豁免表执行。 |
| ⑩ | **修改** 超大 body 错误码 | `server/index.js:64-79` `readBody`；同步 `tests/api/api.test.js:161-173` | 超过 1 MB 上限返回 **413 `payload_too_large`**（现为 500 `internal_error`）；测试同步断言 413 + 错误码，并补 1 条分块写入超限用例。 |

**P0 完成清单（供后续打勾）**
- [x] ① `scripts/baseline.js`：用例总数 + 失败用例名指纹，纳入 gate 输出
- [ ] ② `tests/helpers/http.js` + `tests/helpers/cli.js`：抽 `request/withServer/quiet` 与 CLI 退出码表
- [x] ③ `tests/integration/e2e-play.test.js`：22 检查点端到端玩家路径
- [x] ④ `tests/integration/quickmatch-invariants.test.js`：积分守恒 + Elo 可复算 + cap 3000 + 无 bot
- [x] ⑤ 改 `tests/unit/ranked.test.js`：删 bot 补齐断言，改断言 `shortfall` + 真实玩家对手
- [x] ⑥ `scripts/check-docs.js` 加 `checkDocs({projectRoot})` + D1–D6 各一条投毒（重点 D5 历史绕过）
- [x] ⑦ 补 gate 项 8 / 项 9 + fe-spec C3/C4/C7/C9 投毒（**fe-spec 部分已于 2026-09-20 删除**，gate 项 8/9 投毒保留）
- [x] ⑧ `tests/unit/play.test.js`：`npm run play` 确定性 + 合法性（原 0% 覆盖）
- [x] ⑨ 覆盖率：`server/*.js`、`server/data/schema.js`、`scripts/*.js` 纳入阈值或显式登记豁免；解决 gate 项 7 与 `npm run cov` 的冲突
- [x] ⑩ `readBody` 超限改 413 `payload_too_large` 并同步 `api.test.js`

---

## 交付定义（"完全可玩的后端"）

一条命令能让人从零走到"打完一场并看到成长"：
`npm run play`（离线文本试玩，已交付）→ `npm start` + `npm` 脚本 `e2e`（联网全链路）→ `npm` 脚本 `load-test`（批量并发）。
判定标准：**e2e 与 load-test 都绿 + 四项门禁全绿 + 上述各阶段验收项逐条通过**。

## 已知风险

1. **并行冲突**：每次只允许一条线改同一文件；本会话已两次因并行半写导致瞬时红。
2. **崩溃测试**：沙箱禁 `child_process`，`T-ST-1`（子进程 kill）用"构造畸形/截断 journal 再加载"等价替代。
3. **回放体积**：实测 61–268 KB/场（旧文档 7–20 KB 偏小一个数量级），LRU 64 时上限约 4–17 MB（可接受，但需在报告中记录）。
4. ~~**`.audit/fe-samples.json` 必须重采**~~：**已于 2026-09-20 连同前端设计一并删除**（该条仅存历史意义；新前端设计若需要真实响应样本，需重新设计采样方案）。
5. **文档同步债务**：每阶段完成后同步 `interfaces.md`/`server.md`/`tasks.md`/`progress.md`/`systems/09-unlock.md` 等（`frontend-spec.md` 已于 2026-09-20 删除），并登记用户决策到 `decisions.md`。
