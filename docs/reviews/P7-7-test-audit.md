# P7-7 测试矩阵审查报告

> **只读审查 · 2026-09-16 · 工作区 `F:\Game\Debug-lite`**
> 角色：P7-7（测试体系审查：冗余项与缺口）的交付物，供后续执行者按 `docs/plan-p7-playable.md` §P7-7「审查结论与 P0 清单」逐项闭环。
> 方法：全程只读（未修改/新建/删除任何仓库文件；临时探针写在 `%TEMP%\dsh-probe\`）。所有结论区分「**实测**」与「**推断**」，未标注者均为实测。
> 权威链不变：`decisions.md` > `systems/*` > `v3-design.md` > `tasks.md`；本文件只是审查记录，不改变任何设计结论。

---

## 0. 基线告警（先读：当前工作区不是绿的）

**用户所引「505 通过 / 0 失败」在当前工作区不可复现。同一套测试在约 6 分钟内给出三份不同结果：**

| 时刻 | 命令 | 结果 |
|---|---|---|
| t0 | `node --test --test-isolation=none tests/**/*.test.js` | tests **517** / pass **514** / **fail 3** |
| t0 | `node scripts/gate.js` | **7 PASS / 2 FAIL / 0 PEND**（项 3 架构、项 7 测试） |
| t0 | `npm run cov` | **exit 1** — 分支聚合 **84.93% < 85%** |
| t1（+4 min） | 全量 | tests **528** / pass 517 / **fail 11**（失败集完全不同） |
| t2 | cov 复跑 | tests **529** / pass 519 / **fail 10**；分支聚合 **84.98% < 85%** → cov 仍红 |

**t0 的 3 条失败**：
- `GX-8 check-arch main：真实仓库无违规 → 0 退出码`（`tests/integration/gate-extra.test.js:177`）
- `ast 枚举：arith.op 只接受 + - * /`（`tests/unit/mechanics.test.js:315`）
- `函数行动产出定点分析：只调用"能产出 action"的函数才算…`（`tests/unit/mechanics.test.js:213`）

**t1/t2 的失败集换成（P7-0「关闭段位门控」半落地：`server/data/unlock.json` 已加 `gating.enabled=false`，一批旧用例仍按门控开写死）**：
`tests/api/api-box.test.js:50「raree 上限」`、`AP-11 common 可用节点 10`（实得 16）、`PT-IT-3 late 只允许 mythic`、`IF-1 D 编号 105 !== 88`、`I-12e 段位门控`、`P2-3 tierReward 交叉一致` 等。

**隔离对照（关键）**：
```
node --test --test-isolation=none tests/unit/mechanics.test.js   →  tests 20 / pass 20 / fail 0
```
同一文件在全量运行中失败 2 条、单独运行 20/20 全过 → 这是**并行半写 + 单进程共享模块的顺序抖动**，不是该文件的独立缺陷。`plan-p7-playable.md` §0 第 3 条（"同会话多次因并行改同一文件出现半写状态导致测试瞬时红"）已预警此现象。

**审查窗口内的并发写入（实测）**：
- t0：`tests/contract/` 只有 `.gitkeep`；`server/store/` 无 `index.js`；`tests/` 下 60 个 `*.test.js`。
- t2：出现 `tests/contract/store-contract.test.js`（28 036 B）与 `server/store/{index,adapter-json,adapter-sqlite,recovery}.js`（store 目录共 14 文件）。
- → **持久化层（§B3）的覆盖状态以 t1 之后为准，本报告不对其给"已覆盖"结论。**

**check-arch 对真实仓库报错（gate 项 3 FAIL 的直接原因，实测）**：
```
node scripts/check-arch.js   →   exit 1
[FAIL] server/store/archive.js      [unknown-layer] 文件不在分层表中（scripts/README.md 需登记）
[FAIL] server/store/canonical.js    [unknown-layer]
[FAIL] server/store/config.js       [unknown-layer]
[FAIL] server/store/errors.js       [unknown-layer]
[FAIL] server/store/fsatomic.js     [unknown-layer]
[FAIL] server/store/index-file.js   [unknown-layer]
[FAIL] server/store/journal.js      [unknown-layer]
[FAIL] server/store/ledger.js       [unknown-layer]
[FAIL] server/store/lock.js         [unknown-layer]
[FAIL] server/store/session-table.js[unknown-layer]
[FAIL] server/store/snapshot-store.js [unknown-layer]
```

**由此得到第 0 号缺陷（P0）：没有任何"基线绿"的机器断言。** `npm test` 的绿/红只体现在人眼；一旦全量变红，2 条与 11 条一样都只是"红"，无法区分"我改坏了 1 条"与"别人半写了 9 条"。→ 见 §P0 清单第 ①条。

> **2026-09-19 状态更新（P7-7 执行轮实测）**：本节的"非绿基线"已不成立 —— 交付轮实测
> `npm test` = **839 通过 / 0 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、
> `node scripts/check-docs.js` PASS、`node scripts/fe-spec-check.js` = 9 PASS / 0 FAIL。
> §0 的 `fail 3 → 11 → 10` 三份结果保留为**历史证据**（它正是 §⑤ 盲区 1 的原始观测）。
> 本轮执行期间仍复现了同类抖动（两次 `tests/integration/e2e-play.test.js` 单条失败，隔离运行 6/6 全过，
> 且该文件在本轮被**另一条并行线实时改写**：12:05 34 506 B → 13:00 36 755 B）——即"并行半写 + 顺序抖动"
> 依旧存在，机器区分手段（§P0 第①条基线指纹）已就位。本节各 P0 条的闭环状态见 §④ 顶部表。

---

## ① 统计摘要（实测）

- `tests/` 下 **60 个 `*.test.js`**；测试代码 **9 822 行**；**断言 2 431 条**（密度 0.25 条/行、≈4.7 条/用例）。
- 静态 `test(` / `it(` 计数 **517**（运行时 517 → 528 → 529，期间被并行新增用例）。
- 另有游离文件 `/ .review-b17/probe.test.js`（44 行 / 4 用例）：**不被 `tests/**` 与 gate 的 `tests/` 扫描命中**（gate 用 `scopeFiles(root, ['tests'], '.test.js')`）→ 属"看得见跑不到"的假测试文件。
- `tests/contract/` t0 时为空（仅 `.gitkeep`）；`tests/property/` 仅 1 个测试文件。

### 1.1 各目录用例数 / 断言数 / 行数

| 目录 | 文件 | 用例 | 断言 | 行 |
|---|---|---|---|---|
| `tests/unit` | 27 | 308 | 1486 | 5748 |
| `tests/integration` | 6 | 69 | 197 | 1272 |
| `tests/api` | 7 | 38 | 344 | 1037 |
| `tests/cli` | 8 | 34 | 127 | 808 |
| `tests/log` | 7 | 35 | 159 | 447 |
| `tests/helpers` | 2 | 16 | 63 | 217 |
| `tests/frontend` | 1 | 9 | 26 | 111 |
| `tests/property` | 1 | 5 | 20 | 124 |
| `tests/regression` | 1 | 3 | 9 | 58 |
| **合计** | **60** | **517**（静态） | **2431** | **9822** |

### 1.2 空转 / 弱断言计数（实测全仓 `tests/`）

| 模式 | 计数 |
|---|---|
| `assert.doesNotThrow` | **26** |
| `assert.ok(Array.isArray(` | **20** |
| truthy 型 `assert.ok(单标识符)` | **2** |
| `try {` | **48** |
| `catch` | **7** |
| **空 catch `catch {}`** | **0** |
| `test.skip` / `todo` / `.only` | **0** |
| `assert.throws` | 41 |
| `assert.ok(...)` 总 | 423 |
| `assert.equal/deepEqual` 类 | 1920 |

### 1.3 重复辅助函数定义处（实测）

| 辅助 | 份数 | 定义处（`文件:行`） |
|---|---|---|
| `withServer` | **14** | `tests/api/api-ai.test.js:29`、`api-battle:27`、`api-box:26`、`api-loadout:27`、`api-ranked:27`、`api-wh:27`、`api.test:34`、`tests/cli/cli-ai:14`、`cli-battle:14`、`cli-box:9`、`cli-panel:13`、`cli-ranked:12`、`cli-wh:12`、`cli.test:28` |
| `request` | **7** | `api-ai:12`、`api-battle:10`、`api-box:9`、`api-loadout:10`、`api-ranked:10`、`api-wh:10`、`api.test:17` |
| `quiet` | **7** | `cli-ai:24`、`cli-battle:23`、`cli-box:18`、`cli-panel:22`、`cli-ranked:21`、`cli-replay:25`、`cli-wh:21` |
| `makeProject` | **3** | `check-arch.test:11`、`gate.test:11`、`gate-extra.test:11` |
| `runCheck` | **2** | `gate-extra.test:21`、`gate.test:21` |
| `mkBattle` | **4** | `battle-end.test:27`、`damage.test:37`、`engine.test:31`、`mechanics.test:26` |
| `mkPlayer` | **4** | `effects.test:11`、`engine-aitrace.test:8`、`engine.test:22`、`mechanics.test:18` |
| `mkSnapshot` | **3** | `runtime-ctx.test:8`、`runtime-limit.test:16`、`runtime.test:17` |
| `mkRng` | **3** | `runtime-ctx.test:16`、`runtime-limit.test:24`、`runtime.test:30` |
| `mkAtk` | **2** | `roles.test:84`、`wh.test:39` |
| `mkPlugin` | **2** | `b20.test:14`、`skills.test:92` |
| `mkActor` | **2** | `bullets.test:16`、`damage.test:21` |
| `mkdtempSync` 使用文件 | 4 | `check-arch.test`、`gate.test`、`gate-extra.test`、`data-schema.test` |
| `JSON.parse(JSON.stringify(` 使用文件 | 15 | 深拷散落各文件 |

---

## ② 冗余清单

### 2.1 纯冗余（R1–R8，建议合并/删除）

| # | 文件:行 | 为什么冗余 | 建议动作 |
|---|---|---|---|
| R1 | `tests/unit/golden.test.js:14-21` ↔ `tests/regression/golden-battle.test.js:47-52` | 「同 seed 两次 `runFull` 逐帧一致」被逐字重写两遍，同一实现同一分支 | 删 `unit/golden.test.js:14-21`，保留 regression 版 |
| R2 | `tests/unit/golden.test.js:23-25` ↔ `tests/regression/golden-battle.test.js:35-44` | 同一句 `deepEqual(summary, SNAP)` 两次；regression 版还多逐帧 diff | 删 `unit/golden.test.js:23-25` |
| R3 | `tests/regression/golden-battle.test.js:54-57` ↔ `tests/integration/gate-extra.test.js:258-263` ↔ `scripts/gate.js:603`（项 8） | `checkLogSmoke` 在 `npm test` 内被调 1 次、又被 gate 项 8 调 1 次，语义完全相同；且 GX-13 只断言 `status==='pass'` | 保留 gate-extra 版（带 pending 断言），删 regression 版第 54-57 条 |
| R4 | `tests/integration/interfaces.test.js:23-31` + `:82-87` ↔ `scripts/gate.js:591`（项 5）+ `gate-extra.test.js:57-74` | IF-1 与 IF-5 都在真仓库跑 `checkDNumberLocations` 并断言 pass；gate 项 5 已做同一件事，GX-3 已覆盖 fail 分支 | 删 IF-5；IF-1 只断言「D 编号集合无新增未落点」，并把 `assert.equal(decided.size, 88)`（`:30`）改为不锁数量 |
| R5 | `cli-ai.test.js:55,59,61`、`cli-replay.test.js:52,54`、`cli-wh.test.js:51,53`、`cli-panel.test.js:42,44`、`cli-ranked.test.js:41,45`、`cli-battle.test.js:66` | 「缺子命令 / 缺 `--file` / 未知旗标 / 未知子命令 / 文件不存在 → 退出码 2」在 7 个 CLI 文件里重复 12 处 | 抽 `tests/helpers/cli.js`，改一张 `[argv, 期望码]` 表驱动用例（各文件只留关键成功路径） |
| R6 | `api-ai.test.js:116-133`、`api-battle.test.js:88-93`、`api-box.test.js:76-86`、`api-ranked.test.js:63-70`、`api-loadout.test.js:77-79` | 同一组「`bad_json`→400 / `bad_tier`→400 / `bad_seed`→400」在 4–5 个端点文件里逐字重复 | 保留 1 处参数化「所有 POST 端点 × 3 类畸形输入」矩阵用例；各端点文件只留端点特有错误码 |
| R7 | `tests/integration/gate-extra.test.js:177-189`、`:258-269` | 对真仓库跑 `check-arch.main()` / `checkLogSmoke()` / `checkApiSmoke()` 并断言 pass —— 与 `npm run gate` 完全重复，且这三条的 **FAIL 分支全没测**（见 §B6） | 合并成 1 条「真实仓库三检查器 pass」；把省下的预算投给它们的投毒用例 |
| R8 | `.review-b16` ~ `.review-b25`（9 目录 53 文件，含 `.review-b17/probe.test.js`） | 历史审查残留物；`probe.test.js` 是 `*.test.js` 却不被任何 runner/gate 扫描 | 删除或移入 `.audit/`（P2） |

**分层说明（区分"必要契约分层"与"纯冗余"）**：跨层重复有时是必要的——`tests/unit` 断言语义、`tests/api` 断言 HTTP 信封与状态码（例：`assert.equal(r.status, 409)` 同时出现在 `api-loadout` 与 `unit/wh`，各有其价值），这类**不计入**冗余。上表 R1–R8 均经逐条比对，属**同层同分支的逐字重复**或**断言对象完全同一**。

### 2.2 重复 fixture / 辅助函数

`tests/helpers/` 目前只有 `gen.js` 与 `log.js`，HTTP/CLI 脚手架被复制粘贴（清单见 §1.3）。合计约 **250 行**纯脚手架重复，且未来加鉴权头（P7-4 `Authorization: Bearer`）需要改 7–14 处。

### 2.3 自证式 / 空转断言清单

**接近恒真的断言（服务端同一行就把值写成常量/兜底）：**

| 文件:行 | 断言 | 恒真原因（同源实现） |
|---|---|---|
| `tests/api/api.test.js:53` | `assert.ok(Array.isArray(r.body.log.events))` | `server/index.js:35` `okEnvelope` 硬写 `events: []` |
| `tests/api/api.test.js:81` | `assert.ok(Array.isArray(r.body.error.details))` | `server/index.js:54` 硬写 `details: details \|\| []` |
| `tests/api/api-ai.test.js:45`、`:56`、`:276` | `assert.ok(Array.isArray(...warnings))` | `server/index.js:184` 即 `Array.isArray(v.warnings) ? v.warnings : []` |
| `tests/unit/ai-validate.test.js:341` | `assert.ok(Array.isArray(cl.errors))` | `checkLegality` 结构固定 |
| `tests/unit/golden.test.js:28` | `assert.ok(winner==='p1'\|\|'p2'\|\|'draw')` | 引擎只可能产出这三值 |
| `tests/unit/golden.test.js:33-34` | `x ∈ [32,992]` | 场地边界恒定 |
| `tests/frontend/fe-spec.test.js:31`、`:90` | `assert.equal(res.items[0].id,'C1')` | 与 `fe-spec-check.js:499` 实现顺序同源 |
| `tests/cli/cli-replay.test.js:127` | `assert.ok(Array.isArray(a2.problems))` | `auditFrames` 返回结构固定 |

**只断言"不抛"：** `assert.doesNotThrow` 共 26 处。
- 纯空转：`tests/log/zero-cost.test.js:11-19` 一连 9 条「nullLogger 各方法不抛」→ 可折成 1 条表驱动。
- 弱但非空转（所在用例另有语义断言）：`bullets.test.js:236-242`、`effects.test.js:223`、`items.test.js:241`、`roles.test.js:180`、`skills.test.js:277`、`unlock.test.js:136,151`、`runtime.test.js:304,414,420,438`、`runtime-ctx.test.js:97,191`、`runtime-limit.test.js:161`、`ai-validate.test.js:194,238`、`ast.test.js:209`。
  建议：合并为 1 条「防御分支：坏输入不炸 **且** 返回安全默认值 **且** 引擎状态未变」的表驱动用例，把断言从"不抛"升级为"语义"。

**"自证式"门禁断言：** `tests/integration/check-docs.test.js:10-16` 只断言真实仓库 pass；其注释（`:4-5`）自认「检查器本身的失败路径在开发期已实测触发…故非空转」——**这是人工声明的证据，不是机器断言**（详见 §B6）。

---

## ③ 缺口清单（8 类）

### B1. 玩家真实路径端到端 —— **当前基本不存在**

实测 `server/index.js` 路由表只有 5 个 GET + 12 个 POST，**全部无状态**：
`health` / `log-level` / `unlock` / `warehouse` / `loadout` / `data/:table` / `replay/:id` / `box` / `warehouse.assemble` / `warehouse.disassemble` / `panel` / `ai.validate` / `ai.compile` / `ai.battle` / `battle` / `ranked.run` / `ranked.promote`。

**没有**：`auth`、`me`、`accounts`、`configs`、`records`、`defense`、`leaderboard`、`quick`。
**不存在**：`scripts/e2e.js`、`scripts/load-test.js`（`Test-Path` = False）；`package.json` 无 `e2e` / `load-test` 脚本。

- 已覆盖：开箱 → 仓库 → 装配 → loadout/panel → ai validate/compile → battle → replay → ranked run/promote，逐段都有（`tests/api/*` + `tests/cli/*`）。
- **未覆盖且未实现**：注册 → 登录 → `GET /me` → 仓库镜像 → 配置槽/出战 → 战绩/未读 → 排行榜 → 快速对战。

#### P7-5 应覆盖的检查点清单（22 条，逐条断言，含错误分支）

| 步 | 检查点 | 现状 |
|---|---|---|
| 1 | `POST /auth/register` → 200/201 + 返回 token；重名 → `409 user_exists` | 未实现 |
| 2 | `POST /auth/login` → token；错密码 → **401**；连错 N 次 → **429**/锁定；`logout` 后旧 token → **401** | 未实现 |
| 3 | `GET /me` 无 token → **401**；坏 token → 401；过期 → 401；正常 → `{playerId,tier,rating,configs,unread}` | 未实现 |
| 4 | `GET /me` 幂等：连续两次逐值一致（无副作用） | 未实现 |
| 5 | 开箱 → 仓库镜像 `PUT /me/warehouse` → `GET /me/warehouse` **往返一致**（round-trip） | 未实现 |
| 6 | 配置槽：建 ≤3，第 4 个 → `409 slot_limit`；删出战槽 → `409 slot_locked`；激活槽唯一；**注册即默认配置** | 未实现 |
| 7 | 装配后 `POST /panel` 与单测 `buildPanel` **逐值一致** → 端到端认面板 | 部分（仅单测同源，见 §B7） |
| 8 | `/ai/validate` 非法 → 400 + `details[].path`；合法 → `warnings:[]`；废弃动作 → warnings 非空 | 已覆盖（`api-ai`） |
| 9 | `/ai/compile` → `programHash` 稳定；同程序两次 hash 相同 | 已覆盖 |
| 10 | 首次 `POST /quick/run` → 池空 → **必须 `shortfall`，不得注入 bot**（用户明令） | 未实现 |
| 11 | `POST /quick/run` 有对手 → **双方 `playerId` 都是真实注册玩家**（断言对手 ID 在注册表内） | 未实现 |
| 12 | Elo：`R' = R + K(S − E)`，**双方变动绝对值可复算**；cap 3000 不越界 | 未实现 |
| 13 | **积分守恒**：`Σrating(前) + ΣΔ = Σrating(后)`（对局粒度 + 全局粒度） | 未实现 |
| 14 | 发起者同步结算、防守方离线只记战绩**不掉段不掉分** | 未实现 |
| 15 | `ranked/run` 抽池排除自己；24h 去重；候选不足 → `shortfall` 而非 bot | **现状相反**（bot 补齐） |
| 16 | `GET /me/records?since=seq` 增量游标；`unread` 计数；`markSeen` 后 unread=0 | 未实现 |
| 17 | `GET /me/defense` 汇总被抽场次 / 胜负 / 积分 | 未实现 |
| 18 | `GET /leaderboard` 与档案一致（索引重建后仍一致） | 未实现 |
| 19 | 回放：非参与者 → **403**；LRU 淘汰后 → **410 replay_expired** | 未实现 |
| 20 | CLI：`auth` / `me` / `quick` / `leaderboard` 子命令 + **退出码 3 = 未鉴权** | 未实现 |
| 21 | `DL_LEGACY_STATELESS=1` 时旧端点零回归（gate 项 9 + `tests/api` 全绿） | 已有旧端点矩阵 |
| 22 | e2e 一条命令退出码 0，且**每一步打印真实响应关键字段** | 未实现 |

### B2. 真实玩家匹配 —— **存在依赖 bot 的测试，且它们把缺陷"锁死"了**

| 文件:行 | 内容 | 问题 |
|---|---|---|
| `server/ranked.js:58` | `const BOT_LD = takeSnapshot(buildBotLoadout(), null)` | 占位 bot |
| `server/ranked.js:100-102` | `if (acc.length === 0) { matches.push(BOT_LD); continue; }` | **池不足用 bot 凑满 10 场** —— 用户明令禁止 |
| `tests/unit/ranked.test.js:20-42` | T-RK-1 主动断言「无池（bot 补齐）→ 恒 10 场」「池 3 → 补 7 bot」且"全部有效" | **测试在保护占位 bot** |
| `tests/unit/ranked.test.js:44-49` | 断言 `BOT_LD.skills.length===3`、`Object.isFrozen(BOT_LD)` | 同上 |
| `tests/unit/ranked.test.js:78-85` | 用 bot 池跑 losses 分支 | 同上 |

**后果（推断，基于上述实测）**：任何"池不足应 `shortfall`"的改造都会先撞红这 3 条用例 → **测试掩盖真实匹配缺陷**。P7-3 必须先删/改这几条，否则"不许用占位 bot"的验收无法落地。

**另一处实测缺口**：`server/ranked.js:91-95` 的 `pool` **由客户端传入** → 当前根本没有服务端抽池/匹配，`playerId` 概念不存在，无从断言"双方都是真实玩家"。

### B3. 持久化与并发 —— t0 时 **零覆盖**；t1 起在飞

- **t0 实测**：
  - `grep journal|snapshot-store|fsatomic|index-file|session-table|ledger|withLock|acquireLock` 于 `tests/` → **0 命中**。
  - `tests/contract/` 仅 `.gitkeep`。
  - `server/store/*`（11 文件、约 2 900 行）**从未被任何测试加载**（不在任何覆盖率报告里）。
- **t1 实测**：并发生成 `tests/contract/store-contract.test.js`（28 KB）+ `server/store/{index,adapter-json,adapter-sqlite,recovery}.js`（store 目录 14 文件）。→ **该层完备性不在本次实测窗口内。**
- 结论：journal 幂等 / 并发写 / 崩溃截断恢复 / 单进程锁 / `schemaVersion` 迁移 / `seq` 重启来源 —— **本报告不给"已覆盖"结论**；请在 store 层稳定后单独复审，直接对标 `plan-p7-playable.md` §P7-1 验收 4 条 + §P7-6 第 4 项完整性断言 5 条（journal 幂等 / 无半场战绩 / 积分守恒 / leaderboard 一致 / 回放 LRU 不越界）。

### B4. 错误码与边界

**实测错误码矩阵**（`grep` 于 `tests/`）：

| 错误码 | 出现次数 | 涉及文件数 |
|---|---|---|
| `bad_tier` | 14 | 9 |
| `tier_locked` | 11 | 8 |
| `bad_seed` | 10 | 6 |
| `loadout_invalid` | 9 | 5 |
| `bad_json` | 7 | 6 |
| `bad_level` | 6 | 3 |
| `slot_empty` | 6 | 3 |
| `plugin_missing` | 6 | 3 |
| `ai_invalid` | 6 | 4 |
| `bad_request` | 5 | 3 |
| `bad_times` | 5 | 2 |
| `points_exceeded` | 5 | 5 |
| `bad_wins` | 6 | 2 |
| `internal_error` | 4 | 2 |
| `item_missing` | 4 | 1 |
| `unknown_table` | 3 | 3 |
| `unknown_endpoint` | 3 | 1 |
| `ai_too_large` | 3 | 2 |
| `ai_version_unsupported` | 3 | 2 |
| `slot_occupied` | 3 | 3 |
| `plugin_equipped` | 3 | 2 |
| `no_loadout` | 3 | 3 |
| `bad_table` | 2 | 1 |
| `bad_pool` | 2 | 2 |
| `already_max` | 2 | 2 |
| `missing_warehouse` | 2 | 2 |
| `node_locked` | 2 | 1 |
| `bad_enum` | 3 | 1 |
| `unknown_opponent` | 1 | 1 |
| `unknown_replay` | 1 | 1 |
| `bad_ai` | 1 | 1 |
| `unknown_skill` | 1 | 1 |
| `invalid_action` | 0（经属性名断言 ✓：`api-ai.test.js:272`） | 1 |

**HTTP 状态码断言分布（实测）**：200（10 文件）、400（8 文件）、404（4 文件）、409（6 文件）、500（1 文件：`api.test.js`）。
**`401 / 403 / 410 / 429`：测试中 0 次、`server/` 实现中 0 次**（`server/index.js` 只有 400/404/409/500）。`server/store/errors.js:11-28` 已登记 `store_locked/slot_limit/slot_locked/config_conflict/no_active_config`，但**没有 HTTP 端点消费** → 属 P7-4 待落地项。

其余边界：

| 边界 | 现状 |
|---|---|
| 畸形 JSON | ✅ 6 个端点文件 + CLI 均覆盖（`bad_json`） |
| 畸形 URI（`%zz`） | ✅ `api.test.js:196` → 400 `bad_table` |
| 目录穿越（`..%2F`） | ✅ `api.test.js:132` → 400 `bad_table`；`replay/..%2Fetc` → 400 `bad_replay`（`api-battle.test.js:82`） |
| **超大 body（>1MB）** | ⚠️ **缺陷**：仅 `api.test.js:161-173` 测 `/log-level`，且断言 **500 `internal_error`**（`server/index.js:71-74` reject → catch → 500）。**应为 413 `payload_too_large`**；无任何测试断言分块写入的上限 |
| 越界索引 | ⚠️ `slotIndex` 负数/非整数 → 400 已测（`api-wh.test.js:117,120`）；**`slotIndex` ≥ `slots.length`** 越界分支无显式用例（推断：可能被 `item_missing`/`slot_empty` 间接覆盖，未定位专测） |
| 空输入 | ❌ `program:{}`、`loadout:{}`、`warehouse:{}`、`pool:[]` 显式用例缺失（`ranked` 的 `pool:[]` 反而走 bot 补齐，掩盖问题） |
| 超时 / 硬上限 | ✅ `hardCapTick` 由 `battle-end.test.js:36-67`（tick 47/48/62）+ golden（`ticks<=64`）覆盖 |

### B5. 属性 / 不变量

**已有**（`tests/property/items-invariants.test.js`，5 条，质量良好，含"否则本用例空转"式自检）：
1. 五维 ∈ [1, 最大修饰系数 × 品质区间上界]（机器推导上界）
2. 类型修饰单调性（特化 > 均衡、专家 > 特化，含机器复算 `[10,12,13]`）
3. `drop===false` 永不入池 + 段位门控恒成立
4. 加权抽取频率 = `dropWeight` 比例（±3%），返回值必在池内
5. 角色面板聚合幂等（多次调用逐值一致）

**缺失（用户点名 5 项中 4 项）**：
- **积分守恒** —— 积分不存在（P7-3）。
- **hp 守恒** —— 无「伤害前后 `hp_delta === -dmg`（无吸血/真伤时）」「超时扣血 `ceil(maxHp×0.0625)` 双侧闭合」「`Σhp_before − Σhp_after === Σdmg`」的守恒式断言（现只有定点用例 `engine.test.js:192-221`、`battle-end.test.js:36-67`）。
- **往返一致性** —— 无 `warehouse`/`loadout` JSON round-trip；无 `takeSnapshot` → JSON → 再投影 的往返断言。
- **同 seed 逐帧一致** —— 已有多处定点（`golden.test.js`、`api-battle.test.js:69-71`），但缺「随机 loadout × 随机 seed」的属性化版本。
- **回放可重建** —— `tests/cli/cli-replay.test.js` 有 `auditFrames` 自审（链/守恒维度，`:130-139`），但**没有**「`frames` → 重放 → 与再跑一次 `runBattle` 逐帧一致」的重建断言。

### B6. 门禁自身的投毒验证（逐项）

| 门禁 | 检查项 | 投毒用例 | 状态 |
|---|---|---|---|
| gate | 项 1 静态 `Math.random`/`eval`/`new Function` | `gate.test.js:30-37`（三种违规各 1） | ✅ 有；误报防护 `GATE-1b:39-48` / `GX-7:157-166` / `GX-7b:168-173` |
| gate | 项 2 `console.*` | `GATE-2a:52-57`（含别名）；不误报 `GATE-2b:59-64` | ✅ |
| gate | 项 3 架构依赖方向 | `GX-10:209-233`（runGate 级 fail）+ `check-arch.test.js` ARCH-1..12 | ✅ **最完整** |
| gate | 项 4 数据表 schema | `GX-1:32-36`、`GX-2:38-53`（ok / fail / throw 三态） | ✅ |
| gate | 项 5 D 编号落点 + 文档↔数据一致 | `GX-3:57-74`、`GX-4:78-87` | ✅ |
| gate | 项 6 日志命名 + 数值未硬编码 | `GATE-3a/3b`、`GATE-4a/4b`、`GX-5/5b/5c/5d`、`GX-6` | ✅ 含豁免标记与"不误报" |
| gate | 项 7 全量测试 + 覆盖率 | `GATE-5a..5d:131-192`（假 runner 覆盖判定 5 分支 + 盲区兜底） | ✅ 判定层有；**真实 `runSuite` 路径无投毒**（Node v24「第二次嵌套 run 流不结束」，`gate.js:362-364` 已登记，属客观约束） |
| gate | **项 8 日志冒烟** | **无** | ❌ **全缺**：`gate.js:476/479/483/490` 四个 FAIL 分支从未触发（覆盖率显示 `490-491` 未执行）；`GX-13:258-263` 只测 pass/pending |
| gate | **项 9 接口冒烟** | **无** | ❌ **全缺**：`gate.js:549/551/561/567` FAIL 分支无投毒；`GX-12:265-269` 只测 pass/pending |
| check-docs | **D1** npm 脚本双向一致 | **无** | ❌ |
| check-docs | **D2/D3** 脚本 / 数据表引用存在 | **无** | ❌ |
| check-docs | **D4** 批次计数一致 | **无** | ❌ |
| check-docs | **D5** 勾选数 = 批次数（含历史绕过修复 `check-docs.js:91-92`） | **无** | ❌ **最该补**（该绕过曾是真实逃逸） |
| check-docs | **D6** 已勾选批次有 review 记录 | **无** | ❌ |
| check-docs | —— | 全部只有 `check-docs.test.js:10-16` 一条"真仓库 pass" | ❌ **结构性阻塞**：`checkDocs()` 无 `projectRoot` 注入缝（`check-docs.js:26` 硬绑 `REPO`），无法在临时目录投毒 |
| check-arch | layer / forbidden / cli-core / cycle / unresolved / unknown-layer | `ARCH-1..12`（含"合法不误报" `ARCH-7/8/10/11`） | ✅ **最完整** |
| fe-spec | **C1** 注册表可解析 | `FE-SPEC-8:86-93` | ✅ |
| fe-spec | **C2** 按钮 action 命中动作表 | `FE-SPEC-4:55-61` | ✅ |
| fe-spec | **C3** 无僵尸动作 | 仅 pass（`FE-SPEC-3:51`） | ❌ 缺投毒 |
| fe-spec | **C4** 七屏齐全 / goto 可达 | 仅 pass（`FE-SPEC-3:52`） | ❌ 缺投毒（3 条子规则：缺屏 / 不可达 / goto 目标不存在） |
| fe-spec | **C5** 字段存在于真实样本 | `FE-SPEC-5:63-68` | ✅ |
| fe-spec | **C6** 取值与后端一致 | `FE-SPEC-6:70-75`（只投毒 ④对手） | ⚠️ 部分：①段位 ②AI 节点 ③动作名 ⑤品质色 ⑥几何 ⑦开箱上限 ⑧通道 共 7 组无投毒 |
| fe-spec | **C7** 文件清单一致 | **无任何断言** | ❌ 最严重：连正断言都没有，只靠 `FE-SPEC-1` 的 `failed.length===0` 间接覆盖 |
| fe-spec | **C8** 日志事件名 / 通道已注册 | `FE-SPEC-7:77-84`（2 种） | ✅ |
| fe-spec | **C9** 实现侧 `data-action`/`data-id` 命中注册表 | 仅 `FE-SPEC-1` 间接 | ❌ 且**当前恒 pass**：`fe-spec-check.js:448-450` 在 `public/js` 不存在时直接 `pass` → `FE-SPEC-1`「C1–C9 全绿」给出**虚假保证** |

**投毒覆盖小结**：
- `check-arch` ✅ 完整（12/12）。
- `gate` 9 项中 7 项有、**项 8 / 项 9 缺**（7/9）。
- `check-docs` **D1–D6 全缺（0/6）**。
- `fe-spec` **C1/C2/C5/C8 有、C3/C4/C6 部分/C7/C9 缺（≈4/9，其中 C7 连正断言都无）**。

### B7. 最近一轮新功能（逐项）

| 项 | 覆盖 | 证据 |
|---|---|---|
| `random` 两种位置 | ✅ | `runtime.test.js:465-500`（RT-18：语句位 `prob=1` 必 then / `prob=0` 必 else / 缺 else 同 if；表达式位返回布尔并消费 ai 流）；`ast.test.js:165-183`（AF-13 `random.then/else` 子树纳入校验/收集/路径 + 自引用环防御） |
| `bullets` 删除彻底性 | ✅ | `runtime.test.js:253,259`（`bullets[0].x` → 安全默认 0）；`runtime-ctx.test.js:245`（ZERO 路径表）；`runtime-ctx.test.js:163`（`bullets[0].owner`） |
| `aiTrace` 每 tick（长局 ≥60 tick 每帧非空） | ⚠️ 部分 | `api-battle.test.js:53-58`（每帧非空 + tick 归属 + 注释说明"第 2 tick 起恒空"的回归）；`engine-aitrace.test.js:19-32`；`api-ai.test.js:280-291`（不累积、不重复）。**但实测那场只有 ~18 tick；缺 ≥60 tick 长局的每帧非空用例** |
| 4 类校验硬化（含**误报**检查） | ✅ | `ai-validate.test.js:200-340`（`ALLOWED`/`BAD` 双向白名单、`bad_path`、`branch_without_action`、`bad_enum`、危险键 `__proto__`/`constructor`/`prototype`）；`ast.test.js` SAFE_KEYS；含"合法程序不被拒" |
| `warnings` 通道 | ✅ | `ai-validate.test.js:313-340`（含"拒绝态 `warnings` 恒为数组""`checkLegality` 无 `warnings` 字段"）；HTTP 侧 `api-ai.test.js:45,56,276` |
| 快照新字段 + 只读 | ✅ | `api-ai.test.js:178-223`（`baseHp`=基地当前血量 ≠ `maxHp`、`tick`、`max*`、`cooldowns`/`effects`/`bases.*` 副本解耦、`notEqual` 引用、改副本不影响引擎）；`runtime-ctx.test.js:199-245`（冻结副本 + 写入抛 `TypeError`） |
| `/ai/battle` 未生效动作计数（不重复计数） | ✅ | `api-ai.test.js:226-278`（`actionsEffective + ineffective == ticks`、`byReason.unknown_skill`/`invalid_action`、帧级 `actions{effective,ineffective}`、逐动作带 `tick`/`reasons`）+ `:280-291`（每 tick 重置、不累积） |
| `typeModifiers` 接入开箱 | ✅ | `items-invariants.test.js:23-59`（上界推导 + 特化/专家下界单调 + 机器复算 `[10,12,13]`）；`data-schema.test.js:292-315`（漂移必 FAIL + `applyTypeModifier` 读表值 10×1.15=11.5） |
| `drop` / `dropWeight` 消费 | ✅ | `data-schema.test.js:525-541`（全表显式携带 + 缺省兼容）、`items.test.js:318-366`、`items-invariants.test.js:61-105` |
| `schema.js` 机制自洽校验（造错必 FAIL + 无**误报**） | ✅ | `data-schema.test.js:376-414`（4 条投毒：未登记词条/技能类型/unlock 权限/算子）+ `:418-478`（DS-13 五条扩展性 + 第⑤条"未登记仍拦"）+ `:480-523`（`_sample` 逐表开关）+ `:317-370`（DS-11 含"多余条目 / 缺失不阻塞"的**无误报**） |
| 面板合并后两入口结果一致 | ⚠️ 部分 | 单测有：`loadout.test.js:148-175`（`buildPanel.panel.role ≡ items.buildRolePanel`，含 regen 单次叠加双计回归）+ `mechanics.test.js:157-190`（specials/castEffects/affixes/regen 不被投影丢失）；**HTTP `/panel` ↔ HTTP `/loadout` ↔ CLI `panel` 三者未互相比对**（CLI 只断言退出码 0，`cli-panel.test.js:35-45`） |
| `npm run play` 确定性与合法性 | ❌ **完全无测试** | `grep 'play.js\|scripts/play'` 于 `tests/` → **0 命中**；`scripts/play.js`（322 行）**从未被加载**（不在覆盖率报告里）；`scripts/demo.js` 同样 0%。`npm run play` 内含完整的 开箱→装配→`buildPanel`→battle 链路，是当前唯一"可玩"入口，却零回归保护 |
| `cli replay` 伤害/暴击/背击标注 | ✅ | `cli-replay.test.js:223-249`（真实局：`uid->target@x->` 伤害归属对照 + "无 `damage.calc` 不得伪造数字" + 条件断言）+ `:251-271`（合成帧钉死 4 渲染分支 + 缺 `data` 护栏）；含 `if (hits.length>0) … else 空转` 自检（`:229`） |
| 黄金回归（**故意破坏必须变红**） | ⚠️ 口径未验证 | `unit/golden.test.js:23-38` + `regression/golden-battle.test.js:35-45` 锁 `.audit/golden-battle.json`；gate 项 8 锁 trace↔silent。**但没有任何用例证明"故意改一个数值 → 黄金必红"**（缺元测试验证快照锚定真的有效）。`.audit/golden-battle.json` 仅 4 407 B，`--write` 重锚路径无测试 |

### B8. 覆盖率盲区（实测 `npm run cov` 逐文件）

#### 表 1：gate 项 7 阈值目录内（`server/core|server/ai|shared|cli`，阈值 行≥90 / 分支≥85 / 函数≥90）

**全部达标**，但多数"刚过线"：

| 文件 | 行% | 分支% | 函数% | 未覆盖行 |
|---|---|---|---|---|
| `server/ai/ast.js` | 96.70 | **87.86** | 97.92 | 208-209 213-214 292-294 311-313 330-332 501-503 572-573 597-601 614 |
| `server/ai/runtime.js` | 99.55 | **89.78** | 100.00 | 362 427 |
| `server/core/engine.js` | 99.27 | **89.83** | 91.30 | 120-122 141 |
| `server/core/items.js` | 100.00 | **91.24** | 100.00 | — |
| `server/core/rng.js` | 100.00 | **90.24** | 100.00 | — |
| `server/core/skills.js` | 100.00 | **86.05** | 100.00 | — |
| `server/core/unlock.js` | 100.00 | **92.00** | 100.00 | — |
| `server/core/bullets.js` | 100.00 | 93.02 | 100.00 | — |
| `server/core/effects.js` | 100.00 | 98.08 | 100.00 | — |
| `server/core/roles.js` | 100.00 | 96.67 | 100.00 | — |
| `server/core/field.js` | 100.00 | 100.00 | 100.00 | — |
| `shared/log.js` | 98.68 | 95.16 | 97.62 | 13-14 66 |
| `cli/index.js` | 96.12 | **89.16** | 100.00 | 184 272 275-276 326 391 506-507 **536-548** 592-593 |

- `cli/index.js:536-548` = **`ranked run --pool <file>` 分支**（CLI 的 `--pool` 参数从无测试）。
- `server/ai/ast.js:597-601`、`572-573` = 近期新增的校验硬化分支（推断：与 `__proto__`/维度上限相关，随 ast.js 未提交改动）。

#### 表 2：阈值目录之外（gate 项 7 不管，但 `npm run cov` 聚合阈值把它们算进去）

| 文件 | 行% | 分支% | 函数% | 未覆盖行 |
|---|---|---|---|---|
| `server/battle.js` | 100.00 | **84.00** | **83.33** | — |
| `server/runner.js` | 100.00 | **75.76** | 100.00 | — |
| `server/data/schema.js` | 98.90 | **67.22** | 100.00 | 206 296-298 478-479 |
| `scripts/check-docs.js` | 90.44 | **52.27** | 87.50 | 41 74-75 102 **126-134** |
| `scripts/fe-spec-check.js` | 81.87 | **64.73** | 90.77 | 74-76 82-84 108-112 188-189 209-210 238-239 244-245 267-268 274-275 277-278 306-307 322-323 340-341 358-359 362-363 369-370 **407-420** **451-482** 514-515 520-529 534-535 |
| `scripts/gate.js` | 96.28 | **83.97** | **89.83** | 337-338 344-345 367-378 490-491 625-628 645-646 |
| `server/index.js` | 95.13 | **85.84** | 95.56 | 103-104 193-194 206-207 265-266 360-361 456-466 471-472 |
| `server/loadout.js` | 98.76 | **86.60** | **86.67** | 44-45 |
| `server/box.js` | 100.00 | 100.00 | 100.00 | — |
| `server/ranked.js` | 100.00 | 96.15 | **94.44** | — |
| `tests/helpers/gating.js` | 100.00 | **85.71** | 100.00 | — |
| `.audit/golden-battle.js` | 78.70 | 81.48 | 75.00 | 82-102 107-108 |
| `.audit/replay-audit.js` | 76.30 | 69.23 | 87.50 | 60-61 66-67 104-131 |
| `.audit/walkthrough.js`、`.audit/fe-samples.js`、`scripts/play.js`、`scripts/demo.js`、`server/store/**` | — | — | — | **未出现在报告中 = 从未被加载 = 0%** |
| **all files** | 96.34 | **84.98** | 95.55 | → `npm run cov` **红** |

**核心矛盾（实测）**：gate 项 7 的逐文件阈值（更严，但只看 4 个目录）**通过**；`npm run cov` 的聚合阈值（更宽，但覆盖全部文件）**失败**。两套阈值**互相不覆盖**：
- gate 漏掉 `server/battle.js`（函数 83.33%）、`server/runner.js`（分支 75.76%）、`server/data/schema.js`（分支 67.22%）；
- cov 是聚合语义，一个文件 60% 可被另一个 100% 平均掉（`tests/README.md` §「覆盖率」已登记该差异，但**未解决冲突**）。

---

## ④ 合并 / 删除 / 新增建议

### P0（必须补 —— 不补则"完全可玩的后端"无法验证）

> **闭环状态（2026-09-19，P7-7 执行轮实测）**：本表各条已按下述状态处置；**实测证据**见每条末列。
> 基线同时更新（本报告 §0 的"7 PASS / 2 FAIL、fail 3→11→10"是 2026-09-16 审查窗口的历史状态）：
> `npm test` = **839 通过 / 0 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、`check-docs` PASS、`fe-spec-check` 9 PASS。

| 动作 | 文件 → 用例 → 操作 | 收益 | 闭环（2026-09-19） |
|---|---|---|---|
| 新增 | `scripts/baseline.js`（或用例总数 + 失败用例名指纹），纳入 gate 输出 | 让"红 1 条"与"红 11 条"可区分（第 0 号缺陷） | ✅ 已完成：`scripts/baseline.js` 存在，gate 项 7 明细含 `基线 总N/通过n/失败m；失败用例:…；digest=`；`tests/integration/baseline.test.js` |
| 新增 | `tests/helpers/http.js` ← `request()`/`withServer()`（7 + 14 份） | 一次删 ~250 行脚手架；P7-4 加 `Authorization` 头只改 1 处 | ✅ 已完成：`tests/helpers/http.js`（10 个 api/cli 文件改为 require） |
| 新增 | `tests/helpers/cli.js` ← `quiet()`/`capture()` + `[argv, 期望退出码]` 表 | 7 文件 12 处退出码契约合并；新增 `auth/me/quick` 子命令时零复制 | ❌ **未完成**：`tests/helpers/cli.js` 不存在，0 个文件 require；归属 §② R5 需改 `tests/cli/*`（P7-7 文件所有权外）→ 见 §⑦ 结论 |
| 新增 | `tests/integration/e2e-play.test.js`（§B1 的 22 个检查点） | 唯一能证明"完善可玩"的用例 | ✅ 已完成：E2E-1..E2E-6，含 401/403/409/410/429 分支 |
| 新增 | `tests/integration/quickmatch-invariants.test.js`：**积分守恒**（ΣΔ 闭合）+ Elo 可复算 + cap 3000 + **无 bot**（断言对手 ID ∈ 注册表） | 直接对应用户明令 + P7-3 验收 | ✅ 已完成：INV-1..INV-5（守恒/Elo/cap/真实玩家/排行榜一致/journal 幂等） |
| 修改 | `tests/unit/ranked.test.js:20-49,78-85` → 删"bot 补齐"断言，改为 `pool:[]` → **断言 `shortfall` 且 `matches<10`、`results.every(r => 对手是真实玩家)`** | 解除"测试保护占位 bot"（§B2） | ✅ 已完成：T-RK-1a `pool:[]` → matches=0/shortfall=requested；T-RK-1b 池 3 → 只打 3 场 |
| 修改 | `scripts/check-docs.js` 增 `checkDocs({projectRoot})` 注入缝；新增 `tests/integration/check-docs-poison.test.js`（**D1–D6 各 1 条投毒**，重点回归 D5 的"ID 后紧跟竖线但未勾选"历史绕过，见 `check-docs.js:91-92`） | 关闭最大空转风险（§B6） | ✅ 已完成：注入缝落地（无参仍走真实仓库）+ **16 条**用例（D1×2 / D2/D3×3 / D4×2 / D5×5 / D6×1 / 对照×3），D5 历史绕过 3 种形态全部 FAIL |
| 新增 | `tests/integration/gate-poison-extra.test.js`：gate **项 8** 3 条（缺事件 / cid 乱序 / silent≠trace）+ **项 9** 2 条（health 信封坏 / CLI 退出码非 0），用 `projectRoot` fixture（同 `GX-9` 手法） | 补齐 gate 9 项中最后 2 个无投毒项 | ✅ 已完成：**10 条**用例（项 8 ×5 含对照 / 项 9 ×4 含对照 / 项 7 口径 ×1）；实测发现项 8 的"cid 链顺序异常"分支为**不可达死代码**（见下） |
| 新增 | `tests/frontend/fe-spec-poison.test.js`：**C3**（僵尸动作）、**C4**（缺 goto / 不可达 / goto 目标不存在 共 3 条）、**C7**（清单漏条目 / 实现文件未登记）、**C9**（`data-action` 未命中）各 1 条；并给 `fe-spec-check.js` 增加 `publicDir`/`repoRoot` 注入缝（现 C6/C7/C9 硬读 `REPO`，无法投毒） | fe-spec 从 ≈4/9 → 9/9 | ✅ 已完成：注入缝 `{repoRoot, publicDir}` + **17 条**用例（C3/C4×4/C7×3/C9×4 + 解析器 3 + R-1 CRLF 回归）；C9 增加 `applicable:false` 标记关闭"恒 pass 虚假保证" |
| 新增 | `tests/unit/play.test.js`：`scripts/play.js` 同 seed 两次输出逐字节一致 + 每步合法性（开箱品质 ≤ 段位上限、装配后 panel 五维 ≥1、`winner ∈ {p1,p2,draw}`） | `npm run play` 是唯一可玩入口，当前 **0%** 覆盖 | ✅ 已完成：`play.js` 增 `runPlay(argv,{sink})` 可测入口（stdout 与重构前**逐字节一致**，SHA256 实测相同）+ PLAY-7..PLAY-14；`play.js` 覆盖率 0% → 行 92.94 / 分支 78.79 |

| 修改 | `scripts/gate.js:14` `THRESHOLD_DIRS` 增 `server`（或 `server/data`）与 `scripts`；给 `battle.js`/`runner.js`/`schema.js`/`check-docs.js`/`fe-spec-check.js` 补测或**显式登记豁免** | 消除"两套阈值互不覆盖"（§B8） | ✅ 已完成（**选 (b) 登记豁免 + 部分 (a) 补测**，未动阈值）：`scripts/README.md` 新增「覆盖率口径统一」小节（冻结"gate 项 7 = 每文件门禁 / `npm run cov` = 全仓聚合诊断"的单一裁定 + 逐文件豁免登记表与理由）；gate 项 7 明细同时打印两种口径（`全仓聚合…（诊断值非门禁）`）；补测后实测 `check-docs.js` 分支 52.27→**87.50**、`play.js` 0→**92.94 行/78.79 分支**、`fe-spec-check.js` 64.73→**72.46**、`schema.js` 67.22→**69.40**、`battle.js` 84→**86.00**、`runner.js` 75.76→**76.12**；全仓聚合 = 行 96.09 / 分支 **82.62** / 函数 95.00（**仍红，原因与归属见豁免表**） |

### P1（应该补）

| 动作 | 位置 | 收益 |
|---|---|---|
| 新增 | `tests/integration/long-battle-aitrace.test.js`：**≥60 tick 长局**，断言 `frames.every(f => f.diff.aiTrace.length > 0 && f.diff.aiTrace.every(e => e.tick === f.tick))` | 用户点名项，现只有 ~18 tick |
| 新增 | HP 守恒属性测试：`hp_delta === -dmg`（无吸血/真伤时）、超时扣血 `ceil(maxHp×0.0625)` 双侧闭合、`Σhp_before − Σhp_after === Σdmg` | 现有超时用例只定点，无守恒式 |
| 新增 | 往返一致性：`warehouse`/`loadout` JSON round-trip 逐值一致；`/battle` → `frames` → 重放 → 与再跑一次逐帧一致（回放可重建） | 回放/仓库是"客户端权威"的唯一凭据 |
| 新增 | HTTP ↔ CLI 面板一致性：同一 loadout 分别走 `POST /api/v1/panel` 与 `cli main(['panel',…])`，解析 CLI 输出并 `deepEqual` `role.stats` | "面板合并后两入口一致"目前只在单测层 |
| 新增 | 黄金元测试：临时改写 `.audit/golden-battle.json` 的一个 hp 值 → 断言校验逻辑必红（在 tempdir 中跑校验函数） | 防"快照被静默吸收" |
| 修改 | `server/index.js` `readBody` 超限改 **413 `payload_too_large`**；`tests/api/api.test.js:161-173` 同步改断言；再补 1 条分块写超限 | 边界语义正确性 |
| 修改 | `tests/unit/mechanics.test.js`：把 12 处 `assert.doesNotThrow` 聚合为 1 条表驱动「防御分支」用例，断言升级为"安全默认值 + 状态未变" | 减噪 + 提高失败信息量 |
| 修改 | `tests/integration/interfaces.test.js:30` 去掉 `decided.size===88` 硬编码（已因 D-137 变红）；`:59-72` IF-3 端点清单改为从 `server/index.js` 路由表**导出后比对** docs | 消除"文档自证" + 硬编码漂移 |
| 新增 | `tests/helpers/store.js` `withTempDataDir()` + `DL_DATA_DIR` 隔离 | store 层测试（已在飞）的前置 |
| 删除 | `tests/unit/golden.test.js:14-25`（R1/R2）、`tests/regression/golden-battle.test.js:54-57`（R3）、`tests/integration/interfaces.test.js:82-87`（R4） | 减噪；把 `runGolden()` 调用次数从 ~7 降到 ~3（整套实测 2.5 s，黄金战占大头） |

### P2（可选）

- 清理 `.review-b16` ~ `.review-b25/`（9 目录 53 文件，含一个不被扫描的 `probe.test.js`）。
- `tests/log/zero-cost.test.js:11-19` 的 9 条 → 1 条表驱动。
- `tests/api/api-ai.test.js:178-223`（纯 unit：直接 require `runner.js` + `engine.js`，不开 HTTP）**移到 `tests/unit/`**（分层错位：`tests/api` 应只测 HTTP 信封）。
- `mkBattle/mkPlayer/mkSnapshot/mkRng` 抽到 `tests/helpers/domain.js`（保持默认值可覆写）。
- 为 `scripts/fe-spec-check.js`、`scripts/check-docs.js` 增加 npm script（如 `check:fe-spec`），否则 `check-docs` D1 无法登记它们（实测 `package.json` 无此脚本）。

---

## ⑤ 当前测试体系最危险的三个盲区

### 盲区 1 —「门禁的红」不可区分，"半写状态"会被当成失败常态（第 0 号缺陷）

实测同一套测试在 6 分钟内给出 `fail 3 → fail 11 → fail 10` 三份不同结果，而 `npm run gate` 恒为 `7 PASS / 2 FAIL`。项目把"四项门禁全绿才允许提交"写进 `plan-p7-playable.md` §0 第 1 条，但**没有任何机器区分"我改坏了 1 条"与"别人半写了 9 条"**。当红是常态，第 11 条失败就会被忽略——这正是 P7 并行开发最容易吃掉正确性的地方（§0 第 3 条已两次记录"瞬时红"）。**危害等级高于任何单条测试缺口。**

### 盲区 2 —「检查器自己不会被检查」：check-docs D1–D6 全 0 投毒、fe-spec 缺 4/9、gate 项 8/项 9 无投毒

- `tests/integration/check-docs.test.js:4-5` 用**注释**声明"失败路径开发期已实测"来替代机器断言。
- `fe-spec-check.js:448-450` 的 **C9 在 `public/js` 不存在时恒 pass**，而 `FE-SPEC-1` 却断言"C1–C9 全绿"——**正在给出虚假保证**；C7（文件清单一致）连一条正断言都没有。
- 更关键：`check-docs.js` 的 D5 曾经被 `| B1 [ ] |` 形式**真实绕过**（`check-docs.js:91-92` 有修复注释），而这次修复**没有回归用例**——历史上已经发生过一次的空转，现在仍然可以再发生一次。

### 盲区 3 — 覆盖率门禁的"目录豁免"把最高风险文件放出去了，且与 `npm run cov` 语义冲突

豁免名单里躺着 `server/battle.js`（分支 84.00%、函数 83.33%）、`server/runner.js`（分支 75.76%）、`server/data/schema.js`（分支 67.22% —— 而它是 gate 项 4 的**检查器本体**）、`scripts/check-docs.js`（52.27%）、`scripts/fe-spec-check.js`（64.73%）、`scripts/play.js` 与 `scripts/demo.js`（**0%**）。

也就是说：**门禁最信任的几个检查器自己，恰恰是覆盖率最低的文件**；而唯一"可玩"的入口 `npm run play`（322 行）从未被任何测试加载。同时 `npm run cov`（聚合）与 gate 项 7（逐文件 + 目录白名单）**给出相反结论**（前者红、后者绿），团队会按"哪个绿看哪个"来选择——这是典型的门禁自我欺骗。

---

## ⑥ 一句话总评

当前 500+ 用例在"引擎 / 数据表 / AI 校验 / 黄金回归"这一层做得相当扎实（投毒矩阵、无误报防护、确定性锚定都属上乘），但它保护的是一条**"无状态 API + 离线 bot 排位"的旧链路**：真正定义"可玩"的玩家路径（注册 / 会话 / 档案 / 真实玩家匹配 / 持久化 / 并发）在当前测试里几乎全部为 0，而门禁自身有一套**会漏掉检查器的覆盖率目录豁免 + 6 项零投毒的文档/前端检查器 + 与 `npm run cov` 相反的阈值语义** —— 所以最该先修的不是"再加用例"，而是（P0）**让基线红可区分、给 check-docs/fe-spec/gate 项 8-9 补齐投毒、并把 `server/*.js`、`scripts/*.js`、`server/store/**` 纳入覆盖率与分层登记**。

---

## ⑦ 本次审查使用的主要命令（全部只读）

```bash
# 全量测试（三次，观测抖动）
node --test --test-isolation=none "tests/**/*.test.js"                      # t0 / t1

# 覆盖率（逐文件表语义）
node --test --experimental-test-coverage --test-coverage-lines=90 \
  --test-coverage-branches=85 --test-coverage-functions=90 \
  --test-isolation=none "tests/**/*.test.js"                                # t0 / t2

# 隔离对照（证明全量失败不是该文件的缺陷）
node --test --test-isolation=none tests/unit/mechanics.test.js              # 20/20 pass

# 门禁本体
node scripts/gate.js                                                        # 7 PASS / 2 FAIL / 0 PEND
node scripts/check-arch.js                                                  # 11× unknown-layer, exit 1

# 工作区状态
git status --porcelain
git diff --stat

# 临时探针（写在 %TEMP%\dsh-probe\，未落在仓库内）
#   stats.js  各目录 用例/断言/行数 + doesNotThrow/Array.isArray/try/catch 计数
#   dup.js    跨文件重复断言文本比对 + 重复消息串
#   helpers.js 重复 mk*/request/withServer/quiet/makeProject 定义处
#   codes.js   错误码矩阵 + HTTP 状态码断言分布
```

**只读声明**：本次审查未修改、新建或删除任何仓库文件；所有临时产物写在 `%TEMP%\dsh-probe\`。本文件（`docs/reviews/P7-7-test-audit.md`）是审查完成后的**落盘固化**，内容与审查结论一致。
