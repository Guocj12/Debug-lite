# Debug-Lite v3 安全与防作弊问题登记册（record-only）

> **本册只登记，不处理。**
>
> 本轮（v3 / P0–P5 后端收口）用户已明确：**不处理**安全与防作弊，只要求把所有已知问题记录下来，供以后处理。
> 因此：
> 1. 本册**不含任何修复**，不构成任务派发，也不改变当前实现与门禁（`npm run gate` 9 项）的通过状态。
> 2. 本册每一条都必须能被将来的自己**直接照着修**：现状证据（`文件:行` + 现象）→ 风险 → 建议处置方向 → 优先级 → 状态。
> 3. **禁止**以"顺手"为由在本册登记后立即改动 `server/`、`shared/`、`tests/`。任何处置都必须另开批次、另走 `npm run gate`。
> 4. 除本册外，本轮未修改、未删除任何文件。

| 项 | 值 |
|---|---|
| 文档性质 | 安全与防作弊问题登记册（record-only） |
| 更新日期 | **2026-09-19**（P7/B27–B33 收口后的处置回填：SEC-01/SEC-03/SEC-22；SEC-19 维持"已部分处置"） |
| 版本基线 | Debug-Lite v3.0.0，后端 P0–P5（34 批）+ **P7/B27–B33（7 批）均已收口**（2026-09-19；P6 前端未开始） |
| 适用范围 | `server/**`（HTTP 层 `server/index.js`、编排层 `battle.js`/`box.js`/`loadout.js`/`ranked.js`/`runner.js`、**身份与档案层 `auth.js`/`account.js`/`quickmatch.js`/`admin.js`**、**存储层 `server/store/*`**、AI 运行时 `server/ai/**`）、`shared/log.js`、仓库工程配置（`package.json`、`node_modules`、CI） |
| 不在范围 | 产品级数值平衡；前端 UI 缺陷（另见 `docs/frontend-spec.md`） |
| 关联设计文档 | `docs/interfaces.md` §2、`docs/server.md` §2/§4、`docs/systems/11-account-store.md`（D-129…D-136）、`docs/decisions.md`（D-122/D-123/D-135/D-152）、`docs/tasks.md`（B27–B33） |
| 状态取值 | `待处理` / `已部分处置` / `已处置`（**D-153 口径**：被顺手修掉的条目必须回填"现状证据 + 状态"） |
| 优先级 | 高 = 可直接造成不可用/数据不可信/信息泄漏；中 = 明显放大面或违反已冻结契约；低 = 卫生问题、可复现性问题 |

> **⚠ 复核提示（2026-09-19）**：本册多数条目的"现状证据"是在 **P7 代码 0 行**时登记的。P7 交付后，凡证据依赖"账号/鉴权/存储/回放改造不存在"的条目，其前提都已改变——本轮只回填了 **SEC-01/SEC-03/SEC-22**（以及既有的 SEC-17/SEC-19），**SEC-02、SEC-06、SEC-11、SEC-13、SEC-25、SEC-26、SEC-27、SEC-30 需要下一批逐条复核**（例如 SEC-26 的 `DL_ADMIN_TOKEN` 早已接线、SEC-27 的归档回放已参与者鉴权；它们的残余面与 SEC-01 的残余面相同：遗留无状态端点默认开放）。

## 处理前置条件（开工前必须先定，否则改一处破一处）

1. **必须先确定 P7 权威模型**：仓库/开箱/段位是继续"混合权威"（客户端 localStorage 为权威，服务端只存副本）还是切到"服务端权威账本"（`11-account-store.md` §15.1 "阶段 2"）。B 节（经济与防作弊）所有条目都取决于这个决定；在决定之前，B 节的任何补丁都只是**提高作弊成本**，不可能根治。
2. **必须先落地账号/会话（B28）**：A 节的限流、配额、C 节的 CORS 白名单都需要一个"主体"（`playerId`/`publicId`/token）才能实施"按来源"。P7 设计里 `11-account-store.md` §4.4 已给出 Bearer + `ctx.player` 方案，直接复用即可。
3. **必须先把 HTTP 状态语义扩展落到实处**：`docs/interfaces.md:92` 已冻结 `400/401/403/404/409/410/429/500`；`413/405/415/406` 尚未纳入契约，需先在 `interfaces.md` §2 补写再改代码，避免"代码先于契约"。
4. **必须先决定部署形态**：单机 127.0.0.1（当前默认）还是对公网/局域网暴露。暴露则 A 节全部条目优先级上浮一档，且必须同时解决 TLS 终止、反向代理、进程守护（本册不展开，属运维，仅提示）。
5. **必须先确定存储方案**：`11-account-store.md` §6（JSON + journal + 快照 + fsatomic）还是改用 `node:sqlite`（`DL_STORE=sqlite` 已预留）。E 节条目的加固方式取决于此。
6. **每条处置都必须带回归测试**：本仓库唯一回归防线是 `npm test`（2026-09-19 实测 915 通过）+ `npm run gate`（9 项，`scripts/gate.js`）。新增防护必须同时新增测试，否则下一批改动会静默回退。

> **前置条件现状（2026-09-19 复核）**：② **已满足**——账号/会话（B28）已落地，`ctx.player` 主体可用于按来源限流/配额/CORS；③ **部分满足**——`413 payload_too_large` 已实现并入契约，`405/415/406` 仍未纳入；⑤ **已定**——存储方案 = JSON + journal + 快照 + `fsatomic`（`DL_STORE=sqlite` 仍为抛错的预留适配器）；① 仍**未决**（混合权威 vs 服务端账本，见 §15.1 阶段 2）；④ 仍**未决**（部署形态，默认仍 `127.0.0.1`）。

---

## A. 网络与可用性（DoS / 限流 / 资源上限）

### SEC-01 所有 `/api/v1/*` 端点无鉴权，无会话概念

- **现状证据**
  - `server/index.js:414`：`const handler = (routes[req.method] || {})[urlPath];` —— 命中路由直接执行，**全链路不存在任何鉴权分支**；`server/index.js:7-10` 的全部依赖里没有 `auth`/`token`/`session` 模块。
  - `server/index.js:93-343`：`createHandler` 的路由表覆盖 `POST /api/v1/battle`（:297）、`/api/v1/box`（:219）、`/api/v1/warehouse/*`（:230/:244）、`/api/v1/loadout`（:257）、`/api/v1/panel`（:277）、`/api/v1/ranked/run`（:316）、`/api/v1/ranked/promote`（:333）、`/api/v1/ai/*`（:163/:184/:197），以及 `GET /api/v1/replay/:id`（:395）——**没有任何一处读取 `Authorization` 头**。
  - 实测（本地 `start()` + 原始 http 请求，不带任何头）：`POST /api/v1/battle` → 200；`POST /api/v1/box` → 200；`POST /api/v1/ranked/promote {tier:'common',wins:10}` → 200 `{"tier":"rare","promoted":true,...}`；`POST /api/v1/log-level {level:'trace'}` → 200（**任意人可把服务端日志级别改成 trace**）；`GET /api/v1/replay/r1` → 200。
  - 设计侧已冻结但未实现：`docs/interfaces.md:92`（`Authorization: Bearer <token>`，缺失 → 401，越权 → 403）、`docs/systems/11-account-store.md:218-225`（鉴权中间件 6 步）、`docs/server.md:89-92`。
- **风险**：任何人（只要网络可达）可调用全部业务端点；`POST /log-level` 可被用于日志放大（见 SEC-08）；`promote` 可被匿名调用伪造晋升结果；一旦 P7 端点上线，若沿用同一 handler 风格，账号/档案端点会直接裸奔。
- **建议处置方向**：接入统一鉴权中间件（`11-account-store.md` §4.4）；未实现账号前，先把 `POST /log-level` 等**运维端点**限制为仅本机/仅管理员 token 可达；`DL_LEGACY_STATELESS=0`（`docs/server.md:32` 已设计）用于生产关闭无状态旧端点 → `410 deprecated`。
- **优先级**：**高**
- **状态**：**已部分处置（2026-09-19，P7-4/B28/B33）**——① **鉴权中间件已落地**：`server/index.js` 读取 `Authorization: Bearer <token>`（`sha256` 查会话），`/auth/*`、`/me*`、`/quick/*`、`/leaderboard`、`/admin/*` 与归档回放均要求鉴权/参与关系（缺失/失效 → `401`，其中 `session_expired` 由 `store.sessions.peek()` 区分；越权 → `403`）；`POST /log-level` 之外**已不存在"全部端点裸奔"**。② **生产关闭开关已实现**：`DL_LEGACY_STATELESS=0` 使遗留无状态端点（`box`/`warehouse*`/`loadout`/`panel`/`ai/*`/`battle`）返回 `410 deprecated`（`server/index.js` 的 `isLegacyPath`/`legacyStatelessOf`）。
  **残余（仍未处置）**：① `DL_LEGACY_STATELESS` **默认 `1`**，即默认仍保留无鉴权的遗留端点（设计选择：开发/CLI/测试需要；生产须显式置 `0`）；② **`GET/POST /api/v1/log-level` 仍无鉴权、且无 production 守卫**（`server/index.js`，本条目原证据中"任意人可把日志级别改成 trace"**今天仍成立**）；③ 运维端点未做"仅本机"限制。

### SEC-02 无限流、无并发闸门，唯一"防护"是单端点参数上限

- **现状证据**
  - `server/index.js:363-434`：请求处理函数内没有任何计数器、队列、信号量、窗口或 `setTimeout`；同名端点可被无限高频调用。
  - 全仓库仅有的两个请求防护常量都是**单请求参数上限**，与速率无关：`server/box.js:14` `BOX_TIMES_MAX = 100`（单次开箱次数）、`server/ai/ast.js:84-92` `LIMITS`（程序节点/深度/步数）。
  - `POST /api/v1/battle` 每次跑**一整场**（`server/battle.js:48-99`，`engine.runFull` 固定上限 64 tick，`server/data/battle-config.json` `hardCapTick: 64`）并**注册回放**（`battle.js:97`）。
  - 实测：对本机服务并发发出 20 个 `POST /api/v1/battle`，**20/20 全部 200，总耗时 77 ms**（单机、测试夹具 loadout）。由于 `runBattle`/`box.openBoxes` 是**同步 CPU 计算**，这些请求在事件循环上串行执行——即 N 个并发请求等价于 N 倍 CPU 占用，且**阻塞所有其他请求的响应**。
  - 设计侧已冻结但未实现：`docs/systems/11-account-store.md:240`（登录/注册 10 次/分/IP；匹配与对战见 §8.5；全局 600 次/分/token）、`:810`（`rate_limited` 429）、`docs/server.md:130`。
- **风险**：单进程 HTTP 服务被少量请求即可打到 CPU 饱和（同步战斗 + 同步开箱 + 同步排位批次的叠加），表现为**服务不可用**（其他玩家请求排队）；配合 SEC-03 还会转为内存耗尽。这是一条**完整可用的 DoS 路径**，且不需要任何鉴权。
- **建议处置方向**：按主体（token/IP）令牌桶或滑窗限流（复用 `11-account-store.md` §4.6 的阈值口径）；对**昂贵端点**（`/battle`、`/ranked/run`、`/ai/battle`、`/box`）加**并发闸门**（同时最多 N 个在算，超出 → 429/排队）与**批次预算**；把 CPU 密集结算移出 HTTP 事件循环的临界区（或至少分片让出）；`dailyBattleLimit`（`11-account-store.md:638`，当前 `0 = 不限制`）在排行榜对外可见前至少设一个非零默认。
- **优先级**：**高**
- **状态**：待处理

### SEC-03 回放注册表 `REPLAYS` 无上限，持续请求可耗尽内存

- **现状证据**
  - `server/battle.js:18` `const REPLAYS = new Map();` + `battle.js:19` `let replaySeq = 0;`：**只增不减**，没有 `maxSize`、没有 evict、没有 TTL；`battle.js:97` `REPLAYS.set(id, { ...summary, frames });` 存**全量帧**。
  - 实测：连续 31 次 `POST /api/v1/battle` → `REPLAYS.size === 31`，id 依次 `r1 … r31`，**零淘汰**。
  - 实测体积（**修正 README 与任务口径**）：单场 `data` 序列化后 **156 686 B（极简 AI，57 tick，≈2.7 KB/帧）～200 967 B（测试夹具 loadout，57 tick，≈3.5 KB/帧）**；HTTP 响应体 201 030 B。`README.md:35` 与任务描述里的"每场 7–20 KB"**偏小约一个数量级**，登记时请以实测为准（体积随 `frames[].diff.events`/`aiTrace` 增长，帧数与帧内容都受 loadout/AI 复杂度影响）。
  - 设计侧已冻结但未实现：`docs/decisions.md:195` / `docs/systems/11-account-store.md:1062`（D-135：journal 只存引用、帧不落盘按需重算、**进程内帧缓存改为有上限 LRU（默认 64 场）**，明确写着"修掉 `battle.js` REPLAYS 无上限增长"）、`docs/server.md:212`。
- **风险**：**内存耗尽型 DoS**。按实测 200 KB/场估算，1 000 场 ≈ 200 MB，10 000 场 ≈ 2 GB（帧是 JS 对象，实际常驻内存高于 JSON 字节数），足以让单进程 OOM 崩溃；由于无鉴权（SEC-01）且无限流（SEC-02），攻击成本极低。附带效应：进程重启即全丢（`D-123` 不落盘），这不是安全项，但决定了"能不能靠重启回收"。
- **建议处置方向**：按 D-135 实现**有上限 LRU（默认 64 场）**；`REPLAYS` 改存引用（seed + 双方 `snapshotHash` + 版本戳）并按需重算，版本不匹配 → `410 replay_expired`；可选：给注册表加**总字节预算**（而非仅条数），并对超限返回 `429`/`410`。
- **优先级**：**高**
- **状态**：**已处置（2026-09-19，P7-4/B31，D-135）**——处置证据：`server/index.js:50` `DEFAULT_REPLAY_LRU = 64`（并被 `service-config.json` 的 `replayCacheSize: 64` 覆盖，`server/index.js:341-343`）；`pruneReplays()`（`server/index.js:664-671`）在本实例登记的帧数超过上限时 `battleApi.REPLAYS.delete(id)` 并记入 `evicted`（用于区分 410 与 404）；淘汰/版本不匹配/快照不可用 → `410 replay_expired`（`server/index.js:758-761`、`:793`/`:796`/`:803`/`:814`）。归档回放（`b_` 型）不再占用帧缓存额度（按 journal + 快照按需重算，D-135）。
  **残余（口径提示，非缺陷）**：`server/battle.js` 的模块级 `const REPLAYS = new Map()` 本身仍无内建上限——上限由 **HTTP 层**强制。**直接调用 `battle.runBattle`（不经 HTTP，如部分单测/嵌入式调用）不受 64 上限约束**；生产路径恒经 HTTP，故原"持续请求可耗尽内存"的 DoS 路径已关闭。

### SEC-04 AI 提交无信誉约束、无按账号配额（CPU 消耗攻击面）

- **现状证据**
  - `server/index.js:163-218`：`/api/v1/ai/validate`、`/ai/compile`、`/ai/battle` 接受**任意程序**，不要求账号、不记账、不计数。
  - 静态上限确实存在（`server/ai/ast.js:84-92`：`maxDepth:32 / maxNodes:2000 / maxBytes:256KB / stepLimit:10000 / traceLimit:2000 / recursionLimit:64`），运行时兜底也存在（`server/ai/runtime.js:22-24` 三个限制常量；超限 → `wait` + warn，见 `runtime.js:15-18` 注释）。
  - 但**这三点都不是配额**：`stepLimit` 是**每次 `resume` 重置**的（`createContext` 在 `runtime.js:46` 设 `stepCount: 0`，`battle.js:68-77` / `runner.js:117-123` 每 tick 调用一次 `resume`）→ 理论最坏 ≈ 64 tick × 10 000 步 = **每场每 AI 64 万步**（双 AI 约 128 万步），且 `maxBytes` 只限制程序**文本大小**，不限制**执行代价**。
  - 实测：一件 156 KB 的极小 AI 与 201 KB 的夹具 AI 差距不大，但**正常业务请求无任何计数**；同一程序可被无限次重放（`ai/battle` 还额外每次新建上下文并跑满整场）。
- **风险**：把服务端当作**免费 CPU 农场**（挖矿式占用 / 负载压制），并可与 SEC-02 叠加放大；`/ai/battle` 与 `/battle` 还能顺带写入回放注册表（SEC-03）。
- **建议处置方向**：按账号配额（每账号每分钟 `validate/compile/battle` 次数上限）；`/ai/compile` 这类纯计算端点做**结果缓存**（`programHash` 为键，`ast.js:457` 已导出 `programHash`）；对同一 `programHash` 的重复 `battle` 结果可缓存（同 seed 确定性，见 `battle.js:63` 注释）。
- **优先级**：**中**
- **状态**：待处理

### SEC-05 无请求/连接超时，慢速请求可长期占用 socket

- **现状证据**
  - `server/index.js:441` `http.createServer(...)` 未设置任何 `server.timeout` / `server.headersTimeout` / `server.requestTimeout` / `keepAliveTimeout`（Node 默认：`requestTimeout` 300 s、`headersTimeout` 60 s、`keepAliveTimeout` 5 s——均**按字节/时间**宽松，慢速发送 1 MB 以内 body 可长时间占住连接）。
  - `server/index.js:64-79` `readBody` 只累计 `data.length` 并对 `>1e6` 拒绝，**不看 `Content-Length`、不设读超时、不限制分片间隔**（Slowloris 式攻击）。
- **风险**：少量连接即可长期占用单进程的文件描述符与内存（每个未完成请求持有一个字符串缓冲）；与 SEC-02 叠加后更难恢复。
- **建议处置方向**：显式设置 `server.headersTimeout` / `requestTimeout` / `keepAliveTimeout`；`readBody` 预检 `Content-Length`（超限直接 413，见 SEC-07）并加空闲读超时（超时 → `408`/销毁 socket）。
- **优先级**：**中**
- **状态**：待处理

### SEC-06 `OPTIONS` / 预检完全未处理，跨源调用行为取决于浏览器而非服务端

- **现状证据**
  - `server/index.js:414`：`routes[req.method]` 只登记了 `GET`（:95）与 `POST`（:130）→ 任何 `OPTIONS` 落入"未命中"分支，返回 `404 unknown_endpoint`（实测 `OPTIONS /api/v1/battle` → 404 `unknown_endpoint`）。
  - 无 `Access-Control-Allow-Origin` / `Allow-Methods` / `Allow-Headers` / `Max-Age`，也无 `DL_CORS_ORIGIN` 读取（见 SEC-14 与 SEC-22）。
- **风险**：同源部署下无害；一旦前后端分离或服务被放到非预期 Origin 后面，行为**不可预测且不可配置**（浏览器直接拦截预检，前端表现为"接口挂了"）；同时服务端对"谁来调"没有任何声明，安全边界全凭部署巧合。
- **建议处置方向**：实现 `DL_CORS_ORIGIN` 白名单（`docs/server.md:33` / `11-account-store.md:241`），显式处理 `OPTIONS` 并返回 204 + 精确头；不配置时**明确不发 CORS 头**（同源口径，已有设计依据）。
- **优先级**：**中**
- **状态**：待处理

---

## B. 经济与防作弊（客户端权威）

> B 节整体受**前置条件 1**（P7 权威模型）约束。在权威模型定为"服务端账本"之前，下述条目的处置都只能降低作弊收益，不能根治。

### SEC-07 客户端权威的经济系统可被伪造（品质上限取请求体、仓库与出战配置整包提交）

- **现状证据**
  - **开箱品质上限直接取请求体**：`server/index.js:224` `boxApi.openBoxes({ seed: body.seed, tier: body.tier, times: body.times, logger })` —— `body.tier` **不做任何白名单预检**就透传；`server/box.js:16-20` 只验证"是否为合法段位名"，然后以该段位作为**品质上限**（`box.js:6` 注释：*API 层 tier 缺省 common；core `items.openBox` 缺省 mythic（B3 兼容）*）。
    实测：`POST /api/v1/box {tier:'mythic', times:20, seed:12345}` → 200，品质分布 `{common:11, rare:7, epic:2}`；同样 seed 下 `{tier:'common'}` → `{common:20}`。即**客户端自报 `mythic` 即可拿到最高品质池**。
  - **段位缺省 mythic（多处）**：`server/index.js:210`（`/ai/battle`）、`:265`（`/loadout`）、`:285`（`/panel`）、`:302`（`/battle`）、`:321`（`/ranked/run`）一律 `body.tier === undefined ? 'mythic' : String(body.tier)`；`server/battle.js:49` `opts.tier || 'mythic'`、`server/ranked.js:79` 同样缺省 `mythic`。**注意与 `box` 相反**（`box.js:17` 缺省 `common`）——两套缺省口径并存，容易误读（`box.js:6` 已就此写了警告注释）。
  - **晋升只吃客户端入参**：`server/index.js:338` `rankedApi.promote(body.tier, body.wins)`。`server/ranked.js:166-172` **确实**校验了 `tier ∈ TIERS` 与 `wins ∈ [0,10]`，但 `win` 数是**客户端自报**、且**无任何持久化**（`ranked.js:3` "D-123 不持久化"）→ 实测 `{tier:'common', wins:10}` → 200 `{"tier":"rare","promoted":true}`，**服务端凭空返回一次晋升**。
  - **仓库/出战配置整包来自客户端**：`server/index.js:230/:244`（装配/拆卸吃 `body.warehouse`）、`:257/:277`（loadout/panel 吃 `body.loadout` + `body.warehouse`）、`:307`（`/battle` 吃 `body.p1`/`body.p2`/`body.warehouse`）、`:326`（`/ranked/run` 吃 `body.loadout`/`body.pool`）；`server/index.js:119-128` 的 `GET /warehouse`、`GET /loadout` 只是**返回空骨架**（`items.emptyWarehouse()` / `EMPTY_LOADOUT`，注释明写"客户端状态为权威"）。
  - **服务端只做自洽校验**：`server/loadout.js` 的 `validateLoadout` 校验的是"提交上来的 loadout"与"提交上来的 warehouse 镜像"之间的结构/引用/门控一致性（`server/index.js:270`）。实测：把 `loadout.role.stats` 改为 `{hp:999999, atk:999999, def:999999, sp:999999, mp:999999}`（warehouse 用合法夹具）→ `POST /api/v1/loadout` **200 `ok:true`**；`POST /api/v1/panel` → 200 `{"hp":1000049,"atk":1099999,"def":999999,"sp":999999,"mp":999999}`。**改两行前端 JS 即可提交任意属性并拿到服务端认可的面板。**
  - 设计侧**已自认**：`docs/systems/11-account-store.md:57-59`（§1.3 非目标 1："不做服务端物品账本……用户已确认的'混合权威'"）、`:1003-1021`（§15.1 "作弊面（必须让产品方知晓）"："**段位与积分不具备竞技可信度：改两行前端 JS 即可提交任意属性的 loadout**"；已实现缓解仅 4 条：`flags.unverifiedLoadout`、结构/门控/模板存在性校验、全量 journal 审计、保留"阶段 2"接口位）。
- **风险**：这是**经济系统与竞技可信度的根问题**，不是单个端点的输入校验缺失。攻击面：① 自报 `mythic` 直接开出最高品质；② 篡改 loadout 数值获得远超正常范围的战力（实测 atk 拉到 1 099 999）；③ 自报 `wins` 凭空晋升/拿奖励；④ `pool` 由客户端提供（`ranked.js:91-95`，可传空数组让 10 场全部对内置 bot，见 `ranked.js:100-103`）。后果：排行榜/段位无意义、正常玩家被碾压、将来一旦引入付费或交易则直接产生等价物。
- **建议处置方向**：**唯一根治路径是服务端权威账本**（`11-account-store.md` §15.1 "阶段 2" 已列 4 步：服务端权威 `POST /box` 落档、装配/拆卸/面板改为服务端函数、`service-config.json` 加**理论上限校验**（按段位允许品质上限 + 品质属性区间 + 插件点数反推五维上限，越界拒绝）、客户端首次登录导入并标 `importedAt` 视为不可信）。过渡期可先做：服务端按 `tier` **重新推导**品质/属性区间并与提交值比对（不落账也能拦住"atk=1099999"）；`pool` 改服务端抽取，不接受客户端提供；`wins` 从服务端结算结果读取而非入参。
- **优先级**：**高**
- **状态**：待处理

### SEC-08 `tier` 缺省值与校验口径在端点间不一致，易被误用为"提权开关"

- **现状证据**：`box` 缺省 `common`（`server/box.js:17`）；`ai/battle`、`loadout`、`panel`、`battle`、`ranked/run` 缺省 `mythic`（`server/index.js:210/:265/:285/:302/:321`，`battle.js:49`，`ranked.js:79`）；`ai/validate` 缺省 `common`（`server/index.js:172`）。全部只在枚举合法性上校验（`unlock.tierIndex(tier) === null → 400 bad_tier`），**没有任何"该玩家当前段位"的比对**。
- **风险**：缺省即最高段位意味着**任何忘记传 tier 的调用自动获得最高解锁面与最高品质上限**；不同端点口径不同会让前端/第三方集成按最宽松的口径实现，从而在服务端侧形成事实上的提权默认值。
- **建议处置方向**：统一为"缺省 = 最低（`common`）"或"缺省 = 该玩家服务端段位"，并在 `docs/interfaces.md` §2 逐行写明；把 `tier` 从入参改为服务端档案读取（随 SEC-07 一并处理）。
- **优先级**：**中**
- **状态**：待处理

### SEC-09 排位对手池由客户端提供，可自选对手/自造对手

- **现状证据**：`server/index.js:326` 透传 `body.pool` → `server/ranked.js:91-95`（`pool` 由请求提供，仅排除与自己深等的条目）→ `ranked.js:99-106` 抽取 10 场，**池空则全部用内置 bot**（`ranked.js:100-103`，`BOT_LD` 见 `ranked.js:35-58`）。设计侧本就规定"池 = 所有玩家的出战配置"（`11-account-store.md:81`），且反刷范围仅"同一对手 24h 去重"（`decisions.md` D-136 / `11-account-store.md:660-666`，`dailyBattleLimit: 0 = 不限制`，`:638`）。
- **风险**：玩家可提交**自己构造的弱对手池**（或空池）刷胜率与晋升条件；`pool` 里的 loadout 还绕过了正常匹配（且与 SEC-07 叠加可提交任意强度对手）。
- **建议处置方向**：池由服务端按段位/积分窗口抽取（`11-account-store.md:608` 已有窗口递进设计 `matchWindowStart/Step/Max`），完全不接受客户端 `pool`；保留 `dailyBattleLimit` 作为兜底（`:1033` 已提示"若排行榜要对外可见，建议至少补 `dailyBattleLimit`"）。
- **优先级**：**高**
- **状态**：待处理

### SEC-10 幂等/重放面：同 seed 同 loadout 可无限次重算，且结果可被用于"择优"

- **现状证据**：`/battle`、`/ai/battle`、`/ranked/run` 均接受客户端 `seed`（`server/index.js:206/:307/:326`；`server/battle.js:53-56`、`box.js:25-28`、`ranked.js:85-88` 只做区间校验），seed 缺省则由 `crypto.randomInt` 生成并回带（`battle.js:53` 等）。战斗是**确定性**的（`battle.js:63` 注释"同 seed 帧字节级可复现"）。
- **风险**：客户端可指定 seed 反复试算，**只在结果有利时采纳**（对排位尤其有意义：`ranked/run` 的 seed 可自选，等于可以重抽 10 场直到 7 胜）。另有服务端 CPU 放大效应（与 SEC-04 同源）。
- **建议处置方向**：对**影响账本的结算**（排位/快速对战）由服务端独占生成 seed，**禁止客户端指定**；无状态端点（`/battle`、`/ai/battle`）可保留 seed 入参（它是"可复现"契约的一部分，`docs/interfaces.md` T-AP-5），但必须计入配额（SEC-04）。
- **优先级**：**中**
- **状态**：待处理

---

## C. 传输与配置（CORS / 头 / 体积 / 日志）

### SEC-11 请求体超限处理不当：超 1 MB 最终返回 500，且未 drain/destroy 请求流

- **现状证据**
  - `server/index.js:64-79`：`readBody` 在 `data.length > 1e6` 时 `reject(new Error('请求体超过 1MB 上限'))`（`:71-74`），但 **① 不 `req.destroy()`、不 `req.pause()`、不消费剩余数据；② 抛出的错误没有状态码语义**。
  - 该 Promise 的 rejection 落到 `server/index.js:427-431` 的通用 `catch` → `status = 500; errEnvelope('internal_error', e.message)`。
  - 实测：`POST /api/v1/box` 带 3 MB body → **500 `internal_error`**（响应头含 `connection: keep-alive`）；随后 `GET /api/v1/health` → 200（进程未崩，但**语义错误已确认**）。
  - 设计侧：`11-account-store.md:239` "请求体上限：沿用 `readBody` 的 1MB"——**只延续了上限，没有定义超限状态码**；`docs/interfaces.md:92` 的状态码集合里**没有 413**。
- **风险**：① 错误语义错误：客户端收到 `500 internal_error` 会当作服务端故障并**重试**，形成放大回路；② 未 drain 表示连接在 `keep-alive` 下继续接收/保留数据，是资源浪费与慢速攻击的温床（配合 SEC-05）；③ `e.message` 直接进响应（见 SEC-21）。
- **建议处置方向**：定义 `413 payload_too_large`（先补 `docs/interfaces.md` §2 与 `docs/server.md` §4），在 `readBody` 内以**带 `statusCode` 的错误**拒绝，并 `req.destroy()`（或 `req.resume()` 后按 413 收尾）；同时预检 `Content-Length`，超限时**在读之前**就拒绝。
- **优先级**：**高**
- **状态**：待处理

### SEC-12 无 `Content-Type` / `Accept` 校验，无 `415` / `406`

- **现状证据**：`server/index.js:82-89` `jsonBody` 只做 `JSON.parse`，**不检查 `content-type`**；`server/index.js:417-419` 对 POST 一律 `readBody` + 尝试解析；`server/index.js:59` 响应固定 `content-type: application/json; charset=utf-8`，**无 `Vary: Accept`、无 406 分支**。实测：`POST /api/v1/box` 带 `content-type: text/plain` + 合法 JSON → **200**（被当作 JSON 处理）。
- **风险**：跨站 `fetch` 的"simple request"（`text/plain`、`application/x-www-form-urlencoded`、`multipart/form-data`）**不触发预检**即可直接打到端点——在无 CSRF token 的情况下，这放宽了跨源触发面（JSON 请求本会因预检失败而被挡）。另：接受任意 Content-Type 也无助于 fuzz 防御。
- **建议处置方向**：对带 body 的端点**强制** `application/json`（否则 `415 unsupported_media_type`）；`Accept` 不含 `application/json` 时 `406`；状态码先入契约。
- **优先级**：**中**
- **状态**：待处理

### SEC-13 无 CORS 策略、无安全响应头

- **现状证据**
  - `server/index.js:57-62` `send()` 只写 `content-type` + `writeHead(status, ...)`，**没有任何安全头**：无 `X-Content-Type-Options: nosniff`、无 CSP、无 `X-Frame-Options`/`frame-ancestors`、无 `Referrer-Policy`、无 `Cache-Control: no-store`（响应含 seed/回放等状态性数据）、无 HSTS（无 TLS 时无意义）。
  - `DL_CORS_ORIGIN` 在设计中存在（`docs/server.md:33`、`11-account-store.md:241`），但**代码从未读取**（见 SEC-22）。
  - 实测：`OPTIONS /api/v1/box`（带 `Origin: https://evil.example`）→ 404，**无 `access-control-allow-origin`**。
- **风险**：当前恰好是"反向安全的默认"（不发 CORS 头 = 浏览器端不可用），但这是**未实现的副作用**而非策略：一旦有人为了联调随手加 `*`，就没有任何机制阻止；缺 `nosniff`/`no-store` 让响应在代理/浏览器缓存与 MIME 嗅探上存在被误用空间。
- **建议处置方向**：明确 CORS 策略（白名单，默认不发头）；统一加安全头（至少 `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`）；把这些写进 `docs/server.md` §4。
- **优先级**：**中**
- **状态**：待处理

### SEC-14 日志可被用作放大/污染面（每请求两条 info 全量落盘，无采样、无来源限流）

- **现状证据**
  - `server/index.js:366` 每个请求**先**记 `api.req`（含 `method/path/query` 原文）；`server/index.js:433` 响应后再记 `api.res`（含 `durationMs/bytes`）——**进出各一条，`info` 级，无条件**。
  - 只要请求打到服务就落日志，**包括未命中路由的请求**（`index.js:367-368` 先设 404 默认值，日志已在 `:366` 发出）。
  - 日志级别可被**匿名**改写（SEC-01 实测：`POST /api/v1/log-level {level:'trace'}` → 200），`trace` 级会额外打开 `ai.resume`/`ai.node` 等高频事件（`server/ai/runtime.js:5` 注释：`ai.node(trace)`）。
  - `main()` 的 sink 直接 `console.log` 到 stdout（`server/index.js:455-459`），无轮转、无大小上限、无采样；`shared/log.js:102` 的环形缓冲默认 `ringSize=2000` 只约束**内存环**，不约束落盘。
- **风险**：**日志放大 DoS**（磁盘填满 → 服务写失败/崩溃）；**日志污染/取证干扰**（攻击者用大量请求把关键事件冲掉，或把任意路径/query 原文注入日志行，见 SEC-19）；匿名切换 `log-level` 让噪声量级完全由攻击者控制。
- **建议处置方向**：`api.req/api.res` 降级到 `debug` 或加**采样 + 按来源限流**（如"同一来源 N req/s 内最多记 1 条"）；未命中路由/健康检查/静态表端点不记 `info`；`log-level` 端点加鉴权（SEC-01）并记审计；日志落盘加轮转与总量上限。
- **优先级**：**中**
- **状态**：待处理

### SEC-15 未知路径/方法语义不严（统一 404，无 405 / 415 / 406；方法覆盖不可控）

- **现状证据**：`server/index.js:367-368` 默认 `status = 404` + `unknown_endpoint`；`server/index.js:413-425` 只在 `routes[req.method]` 中查表。实测：`PUT /api/v1/health` → 404 `unknown_endpoint`；`DELETE /api/v1/data/battle-config` → 404 `unknown_endpoint`；`OPTIONS /api/v1/battle` → 404（**已存在路径 + 不支持方法，正确语义应为 405 + `Allow` 头**）。`GET /api/v1/box`（路径存在但只有 POST）也返回 404。
- **风险**：语义混淆会让客户端/网关/监控误判（把"方法用错"当成"端点不存在"，从而重试或走降级逻辑）；对将来加路由与前缀匹配（如 `/api/v1/admin/*`）不利，容易在重构时引入**路径前缀绕过**。
- **建议处置方向**：区分"路径不存在（404）"与"方法不允许（405 + `Allow`）"；对 `/api/v1/*` 未实现前缀考虑 501/404 的明确口径；把扩展后的状态码集合写回 `docs/interfaces.md` §2 与 `docs/server.md` §4。
- **优先级**：**低**
- **状态**：待处理

### SEC-16 响应无大小/压缩策略，大响应直接 chunked 抛出

- **现状证据**：`server/index.js:57-62` `send()` 永远 `JSON.stringify` 后一次性 `res.end`，无 `content-length`（实测响应头是 `transfer-encoding: chunked`）、无 gzip、无分页默认；`GET /api/v1/replay/:id` 缺省 `from=1,to=frames.length` 返回**全量帧**（`server/battle.js:105-107`，实测约 201 KB/场）。
- **风险**：放大 SEC-02/SEC-03 的带宽与内存效应；无 `content-length` 使客户端无法预判大小、也不利于反代限流策略。
- **建议处置方向**：大响应（回放）强制分片默认上限（如默认只返回前 N 帧，其余需显式 `from/to`）；补 `content-length`；按需启用压缩（注意引入依赖需先解决 SEC-17）。
- **优先级**：**低**
- **状态**：待处理

---

## D. 运行时与代码面（AI 沙箱 / 依赖 / CI）

### SEC-17 AI 运行时 `get` 路径解析使用放宽正则，仅靠上游投影兜底（存在原型链读取面）

- **现状证据**
  - `server/ai/runtime.js:62-75` `getPath(snap, path)`：**已加运行时白名单校验（2026-09-16 更新）**——路径正则收紧为 `SNAP_PATH_RE = /^\w+(?:\[\d+\])*(?:\.\w+(?:\[\d+\])*)*$/`（`runtime.js:60`，只允许标识符段与数组索引，**不再接受任意键名**），危险段由 `FORBIDDEN_SEG_RE = /^(?:__proto__|constructor|prototype)$/`（`:61`）在 `:72` 逐段拒绝，索引只允许落在数组上（`:75`）；取值对象来自 `deepFreeze` 后的只读快照副本（`:29-35`）。另有**校验期**白名单 `server/ai/ast.js:119-131` `isAllowedSnapshotPath` + `:356` `bad_path`（容器不可当值读；非法路径在 `/ai/validate|compile` 直接拒绝，见 D-145）。
  - 上游快照来源仍是白名单投影，且**字段已按 D-147 扩充**：`server/runner.js:59-98` `projectSnapshot` 每 tick 新建**只含固定字段**的对象——顶层 `:91-97` 为 `tick/self/enemy/bases/field`（**`bullets` 不再投影**，见 `:57-58`/`:90` 注释与 D-138）；`pick()` 在 `:82-88` 只取 `hp/maxHp/mp/maxMp/sp/maxSp/atk/def/x/facing/baseHp/cooldowns/effects`；`pickBase()` 在 `:89` 只取 `hp/maxHp/def`；`cooldowns` 逐键取数、`effects` 重建为最小摘要（`:64-81`），**不传引擎对象引用**；`deepFreeze` 由 `runtime.resume` 施加（`:172`）。调用点：`server/runner.js:174`、`server/battle.js:69`、`server/ranked.js:68`。
  - 也就是说：**运行侧与校验侧现在都有白名单**，不再依赖"调用方自觉"（`docs/systems/08-ai.md` §4.5 的"只读快照"语义已在运行侧强制）。
- **风险**：① ~~若将来快照加入对象字段，`get` 路径 `x.y` 即可沿原型链读到非预期属性~~ → **该路径已封闭**（危险段拒绝 + 白名单 + 只读副本；对象字段 `self.effects[i].*` / `self.cooldowns.<sid>` 已在白名单内显式枚举）；② 剩余风险：白名单是**手工镜像**（`runner.js` 投影注释 ↔ `ast.js` 常量集 ↔ `08-ai §4.5` ↔ `interfaces`），三者不同步时会"文档说可读、代码判非法"（或反之）——需靠测试锁死；③ 一旦有第二处调用 `resume` 时用了**非投影**的状态对象（例如为了性能直接传 `state`），白名单仍会拒绝原型链段，但**未知自有字段**会被放过（正则允许任意标识符段），因此"必须经 `projectSnapshot`"这一纪律仍要保留。
- **建议处置方向**（**2026-09-16 更新**）：~~运行侧也加白名单~~ → **已实施**；剩余动作：① 加一条"投影清单 ↔ `ast.js` 白名单"的镜像一致性测试（防两边漂移）；② 在 `docs/systems/08-ai.md` §4.5 写明"投影白名单 + 运行时白名单"双保险（**已写**）；③ 补一条测试：路径含危险键名时**校验期拒绝**、绕过校验直调运行层时返回 `0`（`tests/unit/ai-validate.test.js:238-244` 与 `tests/unit/runtime-ctx.test.js:246-254` **已覆盖**）。
- **优先级**：**中**
- **状态**：**已处置（2026-09-16）**——处置证据：`runtime.js:60-75` 危险段/正则收紧（运行时白名单）、`ai/ast.js:119-131`+`:356` 校验期白名单与 `bad_path`、`runner.js:59-98` 投影字段显式枚举且**移除 `bullets`**；回归用例 `tests/unit/runtime-ctx.test.js:246-254`（`__proto__`/`self.__proto__` → `0`）与 `tests/unit/ai-validate.test.js:225-250`（容器/未知字段/危险段/已移除路径 → `bad_path`）。**残余**：投影清单的三处镜像一致性尚无专门测试（见建议 ①），登记为后续小项。

### SEC-18 依赖与供应链：无 `package-lock.json`，`node_modules` 含 extraneous 包，无审计流程

- **现状证据**
  - `F:\Game\Debug-lite\package.json`：`dependencies` 与 `devDependencies` **均不存在**（只有 `scripts`），即运行时零依赖（`server/index.js:7-10` 全部 `node:*` 与相对路径）——**这是当前最强的安全属性，处置时不要破坏它**。
  - **根目录无 `package-lock.json`**（实测 `Test-Path package-lock.json` → `False`；`.gitignore` 只忽略 `node_modules/`、`*.log`、`coverage/`、`*.tgz`、`runtime/`，没有锁文件例外）。
  - `node_modules/` 实际装着 30+ 个包：`blockly`、`jsdom`、`@socket.io`、`@csstools/*`、`undici`、`tough-cookie`、`parse5`、`lru-cache` 等（**与已废弃的前端分支相关**），并且存在 `node_modules/.package-lock.json`（npm 内部文件）却**没有**仓库级锁文件；`node_modules` 顶层**没有** `package.json`，说明这些是 **extraneous**（不属于任何声明的依赖）。
  - 无 `npm audit` / 依赖评审流程；无 SBOM。
- **风险**：① **环境不可复现**：换机/换人重装会得到完全不同的树，本仓库引以为傲的确定性（黄金战斗、覆盖率、门禁数值）依赖"恰好是这棵树"；② 供应链卫生差：`node_modules` 里躺着大量无声明、无锁定、无审计的第三方代码，一旦有人误 `require` 就形成**隐形依赖**（`blockly`/`jsdom` 体量都不小）；③ 将来引入依赖时没有审计闸门。
- **建议处置方向**：确认零依赖是**有意设计**并写进 `README.md`/`docs/v3-design.md`；清理 extraneous 包（新批次，需确认没有脚本/测试 require 它们）；若将来必须引依赖 → 提交 `package-lock.json`、锁定版本、加 `npm audit`/`licenses` 门禁项（`scripts/gate.js` 加第 10 项）；`.gitignore` 保持"忽略 `node_modules` 但**提交**锁文件"。
- **优先级**：**中**
- **状态**：待处理

### SEC-19 无 CI / 无自动化门禁执行，唯一防线是本机 `npm run gate`

- **现状证据**
  - **无 CI 自动执行门禁**（登记时实测 `Test-Path .github` → `False`，无任何 CI 配置）。**2026-09-16 更新**：同轮已新增 `.github/workflows/gate.yml`（push/PR 跑 `check-docs` + `npm run gate`）——本条**已部分处置**，但"门禁脚本自身可被改写/无 CODEOWNERS"的子项仍成立。
  - 唯一门禁是本地命令：`package.json` `"gate": "node scripts/gate.js"` → `scripts/gate.js:581-604` 的 9 项检查（静态无 `Math.random`/`eval`/`new Function`、`server/core` 无 `console.*`、数据 schema、文档↔数据一致性、日志命名/数值硬编码、全量测试 + 覆盖率、日志冒烟、接口冒烟）。
  - 覆盖率阈值靠门禁项 7 内的判定（`scripts/gate.js:602`，`npm run cov` 的行 ≥90/分支 ≥85/函数 ≥90），**没有 CI 会在 push 时自动跑**。
  - `package.json` 里还有一个**指向不存在文件**的脚本：`"demo": "node scripts/demo.js"`（登记时实测 `Test-Path scripts/demo.js` → `False`）。**2026-09-16 更新**：`scripts/demo.js` 已补齐并实跑通过——本条**已处置**（保留登记以说明"脚本接线失修"这一工程信号）。
- **风险**：回归与**恶意改动不会被自动拦截**（本册全部条目都可能被一次"热心重构"重新引入）；门禁可被跳过（改 `scripts/gate.js` 或直接不跑），且没有"谁在什么时候跑过"的记录；坏脚本说明工程面已有失修信号。
- **建议处置方向**：加最小 CI（push/PR 跑 `npm test` + `npm run gate`，失败即红）；门禁脚本本身纳入 CODEOWNERS/评审；修掉或删除失效脚本（新批次）；把"安全相关检查"（如本册 A/C 节的可自动化项：413 语义、404/405 区分、安全头存在性）逐步加为门禁第 10+ 项。
- **优先级**：**中**
- **状态**：**已部分处置（2026-09-16 更新）**——① CI：`.github/workflows/gate.yml` 已落地（push/PR 跑 `check-docs` + `npm run gate`），另加 `.githooks/pre-commit`（改代码未更新 `tasks.md`/`progress.md` → 拒绝提交，随后强制 `check-docs`）与 `.githooks/pre-push`（推送前跑全量 `gate`；安装：`npm run hooks:install`）——**"无自动化门禁执行"子项已处置**；② 失效脚本：`scripts/demo.js` 已补齐（`npm run demo` / `demo:log` 实跑通过，同轮另加 `npm run play` = `scripts/play.js`）——**"脚本指向不存在文件"子项已处置**；③ **残余未处置**：门禁脚本自身可被改写且**无 CODEOWNERS/评审强制**，CI 无法阻止"改 `scripts/gate.js` 后自证通过"；覆盖率阈值仍在门禁项 7 内（`scripts/gate.js` 项 7），CI 只是"会跑"，不是"不可绕过"。

### SEC-20 绑定地址与传输安全：默认 127.0.0.1，但可被环境变量改成任意地址，且无 TLS/无来源限制

- **现状证据**：`server/index.js:460-461` `DL_PORT`（缺省 `3000`）、`DL_HOST`（缺省 `127.0.0.1`）——**唯一的部署安全属性是"默认只监听回环"**；一旦 `DL_HOST=0.0.0.0`（或置于反向代理后），SEC-01（无鉴权）立即变成"公网可写"。无 TLS、无 mTLS、无 IP 允许列表、无 `X-Forwarded-For` 处理（也因此**无法按来源做限流**，见 SEC-02）。
- **风险**：部署时一行环境变量即可从"本机玩具"变成"公网无鉴权后端"；没有来源标识也意味着即使想加限流也没有主体可用。
- **建议处置方向**：在本册与 `docs/server.md` §2 明确标注"`DL_HOST` 非回环时**必须**先完成 SEC-01/SEC-02"；引入可信代理下的客户端 IP 解析（只在受信代理后信任 `X-Forwarded-For`）；TLS 由部署层终止（文档化）。
- **优先级**：**中**
- **状态**：待处理

### SEC-21 错误响应泄漏内部信息（`e.message` 回显 + 完整 stack 落日志）

- **现状证据**：`server/index.js:427-431` `catch` 里 `errEnvelope('internal_error', e.message || '服务端内部错误')` **把原始异常消息回显给客户端**，同时 `logger.error('api','api.err', ..., { message: e.message, stack: e.stack })` 记**完整堆栈**。实测：3 MB body → 响应体为 `{"ok":false,"error":{"code":"internal_error","message":"请求体超过 1MB 上限",...}}`（消息原文入响应）。
- **风险**：① 内部实现细节（文件路径、函数名、模块结构）经 `500` 响应与日志泄漏给任意调用者；② 日志里的 `stack` + `e.stack` 在匿名高频请求下成为放大面（SEC-14）；③ 未来若数据库/存储报错，连接串、路径等信息会经同一路径外泄（`11-account-store.md:243` 只对**登录失败**规定了统一错误码，未覆盖通用 500）。
- **建议处置方向**：对外统一 `internal_error` 文案（不带 `e.message`），细节只进**服务端**日志并做脱敏；`api.err` 的 `stack` 仅 `debug` 级记；为本册加"5xx 响应体不得包含内部字符串"的测试。注意 SEC-11 的 413 修复应**顺带消除**本条里最常见的那条泄漏路径。
- **优先级**：**中**
- **状态**：待处理

### SEC-22 文档已冻结的多个环境变量在代码中不存在（配置面与实现面脱节）

- **现状证据**
  - `docs/server.md:25-33` 声明 `DL_PORT`/`DL_HOST`/`DL_LOG_LEVEL`/`DL_LOG_CHANNELS`/`DL_DATA_DIR`/`DL_STORE`/`DL_ADMIN_TOKEN`/`DL_LEGACY_STATELESS`/`DL_CORS_ORIGIN` 九个环境变量。
  - 实测代码中 `process.env` 的读取点**只有两处**：`server/index.js:460`（`DL_PORT`）、`server/index.js:461`（`DL_HOST`）；日志级别经 `shared/log.js:61-63/:86` 读 `DL_LOG_LEVEL`（与 `NODE_ENV`，`log.js:88`）。因此 **`DL_DATA_DIR`、`DL_STORE`、`DL_ADMIN_TOKEN`、`DL_LEGACY_STATELESS`、`DL_CORS_ORIGIN` 全部未被读取**（属 P7 未实现，非缺陷）。
  - 影响面：`DL_CORS_ORIGIN` → SEC-13；`DL_LEGACY_STATELESS` → SEC-01（生产关闭旧端点）；`DL_DATA_DIR`/`DL_STORE` → E 节。
- **风险**：运维者按 `docs/server.md` 配置**不会有任何效果**（静默失效），从而误以为"已开启 CORS 白名单/已关旧端点/已设置管理员 token"；一旦 P7 部分实现（例如只接了鉴权中间件但没接 `DL_LEGACY_STATELESS`），就会出现"文档说关了、实际还开着"的高危错配。
- **建议处置方向**：P7 落地时**逐项实现 + 启动时打印生效配置**（`11-account-store.md:178` 已设计启动日志追加 `[store] archive=N seq=M`）；对"已文档化但未实现"的变量，在 `docs/server.md` §2 加"实现批次"列，避免读者误判；启动时对**未被读取**的已知变量发出 warn（低成本、收益高）。
- **优先级**：**低**
- **状态**：**已处置（2026-09-19，P7-4/B27/B33）**——处置证据（逐变量读取点）：`DL_DATA_DIR` → `server/index.js` `storeWanted()` + `server/store/index.js:52` `resolveDataDir()`；`DL_STORE` → `server/store/index.js:60`（`sqlite` → `open()` 抛 `store_adapter_unavailable`）；`DL_ADMIN_TOKEN` → `server/admin.js:20`/`:75`（空 → `503 admin_token_missing`，比较用 `crypto.timingSafeEqual`）；`DL_LEGACY_STATELESS` → `server/index.js:208`（默认 `1`）；`DL_CORS_ORIGIN` → `server/index.js:241`。`docs/server.md` §2 已按实测重写（五个变量标 ✅ 已接线）。
  **残余（仍未处置）**：`DL_LOG_CHANNELS` 仍未接线（`shared/log.js` 无生产调用者读取；`docs/server.md` §2 已标 ⏳）；"启动时打印生效配置 / 对未被读取的变量 warn"未实现。

### SEC-23 查询串解析静默吞错，可能掩盖设计外的输入

- **现状证据**：`server/index.js:39-51` `parseQuery` 对每个 `k=v` 对做 `decodeURIComponent`，**畸形百分号编码会抛异常**——该异常发生在 `server/index.js:421` `const ctx = { rawBody, logger, query: parseQuery(req.url) };`，落入通用 `catch` → **500 `internal_error`**（与 SEC-11 同一泄漏路径）。另外 `eq <= 0` 的分片被静默跳过（`:45`），重复键后者覆盖前者（`:48`）。
- **风险**：畸形的、来自 fuzz/扫描器的 query（如 `?a=%zz`）会造成 500 噪声并进日志（放大 SEC-14），也让"客户端错误"与"服务端错误"在监控上无法区分。**注意 `GET /api/v1/data/:table` 的路径解码有专门的 `badUri` 分支（`index.js:374-381`，畸形 → 400 `bad_table`）——query 侧没有同等处理，属口径不一致。**
- **建议处置方向**：`parseQuery` 内部 try/catch，畸形编码 → 忽略该对（或整体 400 `bad_query`）；与 `bad_table` 的口径统一；补测试。
- **优先级**：**低**
- **状态**：待处理

### SEC-24 未知/不支持路径的请求仍无条件落 `api.req` 日志（与 SEC-14 同源，可被扫描器放大）

- **现状证据**：`server/index.js:366` 的日志在**路由判定之前**执行；`server/index.js:367-368` 之后才把默认值设为 404。实测扫描式请求（`/api/v1/nope`、`OPTIONS`、`DELETE`、`PUT`）每条都会产生 `api.req`（info，含完整 `req.url`），并且日志中**只有 `api.req` 没有 `api.res`**（因为未命中路由时不进入 `:422-433` 的响应后路径？——注意 `:432-433` 在 try/catch 之外，实际仍会记 `api.res`），需要处置时以实测日志为准。
- **风险**：攻击者无需构造合法业务请求即可产生稳定日志量（放大 SEC-14）；日志与真实业务事件混在一起，稀释取证信号。
- **建议处置方向**：未命中路由/未支持方法只记 `debug` 或做来源级采样；考虑单独的 `api.scan`(debug) 事件便于聚合；与 SEC-14 一并处置。
- **优先级**：**低**
- **状态**：待处理

---

## E. 持久化与账号（P7 计划相关）

> E 节登记的是**已冻结设计**中的风险（代码 0 行）。它们不是当前缺陷，但**按原设计实现就会带着这些风险上线**，因此必须在本册留痕。

### SEC-25 P7 存储设计的持久化风险：崩溃一致性、并发写、journal `seq` 重启来源未定义

- **现状证据**（均为设计文本，需求方在实现前评审）
  - **崩溃一致性依赖"journal 先行 + 幂等重放"**：`docs/systems/11-account-store.md:415-417`（B 类跨玩家结算：先 append journal 再 apply 到双方档案）、`:456-463`（§6.3 apply/幂等/重放：`appliedSeq` 单调水位、`battleId` 去重）、`:465-478`（§6.4 崩溃恢复 5 步 + "任何崩溃点重启后不存在只有一方记了账的对局"）。该保证**全部依赖 journal 单写者与 fsync 语义**，设计侧已识别磁盘代价：`:870`（每条记录独立 fsync 1–10 ms → 100–1000 场/秒，对策 group commit `fsyncMode: "batch"`）、`:496`（目录 fsync 在 Windows 无效，只记 debug——**本仓库唯一目标平台是 Windows**）。
  - **并发模型边界**：`:480-486`（同一玩家每玩家写队列 `Map<playerId, Promise>`；journal 全局单写者）、`:553`（"并发安全：抽池只读索引快照；对手档案在结算时才落盘"）、`:890-891`（写 QPS > 500 时 JSON 文件 + fsync 撑不住 → 应换存储适配器）。
  - **`seq` 的重启来源未定义**：`:380`（物化档案含 `"seq": 41207 // = 最后应用的 journal 全局序号`）、`:469-471`（恢复用 `index.seq < journal.maxSeq` 补放）、`:475`（index 损坏时**全量重放 journal**）；但**没有任何一处写明重启后"下一个待分配 seq"从哪里取**（是 `journal.maxSeq + 1`？还是独立计数器？）。若在"journal 分段/压缩"（`:504`，按月分段 + checkpoint 后**删除该段**）之后仍以 `maxSeq + 1` 取号，则**已删除段的最大 seq 会丢失**，重启后可能**复用旧 seq**，直接破坏 P1（`appliedSeq >= record.seq → 跳过`，`:459`）的幂等判据 → 静默丢账。同理 `journal` 与 `index` 的**同时损坏**只有"拒绝启动并提示从备份恢复"（`:475`）这一条兜底。
  - **快照不可变性 + 版本硬门槛**：`:404`（快照不迁移）、`:701-703`（版本不匹配 → `410 replay_expired`，reason 含 `engine_mismatch`/`data_mismatch`/`snapshot_gc`）、`:1029`（任何影响战斗结果的改动都会让旧回放过期——这是**设计接受的代价**，但需要产品方知情）。
- **风险**：① 崩溃窗口内"一方记了账"（若 fsync/group commit 实现偏离设计）；② 并发写导致的丢失更新（若某处绕开每玩家队列）；③ **seq 复用 → 静默丢账/账目错乱**（最危险，因为不报错）；④ Windows 上目录 fsync 无效，rename 原子性依赖 NTFS 语义，设计未给出 Windows 专用验证；⑤ 分段压缩删除旧 journal 后，重建能力下降。
- **建议处置方向**：实现前先补齐三处规格：**(a) `seq` 分配器**（明确"持久化的 `nextSeq` 记在 index 或 checkpoint 中，且分段删除时必须保留最大值；或改用 `node:sqlite` 自增主键"）；**(b) 崩溃点矩阵测试**（T-ST-3 `:951` 已有设想，需扩到"journal 分段删除后重启""index+journal 双损"）；**(c) Windows 下的原子写与 fsync 实测**（`fsatomic.js` 的 tmp→fsync→rename→目录 fsync 在 Windows 上的语义）。**强烈建议评估直接用 `node:sqlite`**（`docs/server.md:30` 已预留 `DL_STORE=sqlite`，`:898` 已给出表结构 `players/journal/snapshots/sessions`）：单文件、事务、`WAL` 直接把"崩溃一致性 + seq 单调 + 并发写"交给数据库，可消掉本条目大部分风险，且 **Node 24 内置、仍是零依赖**（`package.json` `engines.node >= 24.18.0`）。
- **优先级**：**中**（当前 0 行代码；若直接按原设计实现而不加规格 → 升为**高**）
- **状态**：待处理

### SEC-26 管理员端点未实现，`DL_ADMIN_TOKEN` 未被读取（设计中的注入/重建入口同时缺位）

- **现状证据**：设计冻结 `POST /api/v1/admin/bots`（注入 bot 档案）、`POST /api/v1/admin/rebuild-index`（重建索引）、`GET /api/v1/admin/stats`，由 `DL_ADMIN_TOKEN` 保护：`docs/interfaces.md:43/:86-87`、`docs/server.md:89-90/:31`、`docs/systems/11-account-store.md:573/:754-755/:906`。实现侧：`server/index.js:93-343` 无 `admin` 路由；实测 `POST /api/v1/admin/bots` → **404 `unknown_endpoint`**；`DL_ADMIN_TOKEN` **在代码中零读取点**（与 SEC-22 同一证据）。
- **风险**：① 现在无风险（端点不存在），但**将来实现时**若沿用当前 handler 风格（无鉴权中间件，SEC-01），`/api/v1/admin/*` 会以"路径不存在"的假象被误以为安全，一旦注册进 `routes` 就**立即裸奔**（bot 注入 = 直接改写竞技生态；`rebuild-index` = 数据面破坏）；② token 比较若实现为 `====` 明文比较，还存在时序侧信道。
- **建议处置方向**：实现时**先**接鉴权中间件（SEC-01），admin 路由只在其后注册；`DL_ADMIN_TOKEN` 为空 → **整体禁用**（返回 404/403，`docs/server.md:31` 已是此口径）；token 比较用 `crypto.timingSafeEqual`；所有 admin 操作写审计事件（`:452` 已设计 `admin.bot.injected` 进 journal）。
- **优先级**：**中**
- **状态**：待处理

---

## F. 其他

### SEC-27 回放可被任意读取且 id 可枚举（无参与者鉴权、无最小暴露）

- **现状证据**
  - `server/index.js:395-412`：`GET /api/v1/replay/:id` 分支**不检查调用者身份**，直接 `battleApi.getReplay(pt.arg, from, to)`；`server/battle.js:102-108` 命中即返回**全量帧**（含 `frames[].diff.aiTrace`）。
  - id 是**进程内自增**：`server/battle.js:19` `let replaySeq = 0;` + `battle.js:82` `const id = \`r${++replaySeq}\`;` → 实测连续请求得到 `r1, r2, … r31`，**可完全枚举**；`server/battle.js:104` 未知 id → 404（即"存不存在"也可探测）。
  - 泄漏内容：帧内含**双方 AI 的 `aiTrace`**（`battle.js:67-77` 采集、`:90` 入帧）——等于**对手 AI 程序的执行轨迹**；`docs/systems/11-account-store.md:724` 明确："即便…不存在针对性命中问题，**对手 AI 源码与帧内对手 aiTrace 仍属额外信息**，上表按最小暴露原则处理"。
  - 设计侧已冻结但未实现：`docs/interfaces.md:66`（`GET /api/v1/replay/:id`：**参与者鉴权 + 按需重算**，D-135）、`:92`、`docs/systems/11-account-store.md:224`（"任何路径参数…都必须校验归属；`GET /replay/:id` 校验请求者是该场参与者"）、`:753`（403 `replay_forbidden` / 410 `replay_expired`）。
- **风险**：**信息泄漏**。攻击者枚举 `r1…rN` 即可批量抓取所有回放的帧与 AI 轨迹：① 逆向对手 AI 策略（本游戏的核心竞技资产就是 AI 程序）；② 结合 `seed`（帧/响应里回带，`battle.js:96`）可**离线复现**任意一场并做针对性优化；③ 回放含双方 loadout 状态 → 变相获得对手配置；④ 与 SEC-03 叠加：枚举本身还会产生大量请求（放大 DoS）。
- **建议处置方向**：按 D-135 落地——**参与者鉴权**（仅对局双方可读 → 403 `replay_forbidden`）；id 改为**不可枚举**（随机 `battleId`，如 `b_` + 128-bit hex，`11-account-store.md:423` 已是此形态）；按最小暴露裁剪帧内容（是否需要给对手完整 `aiTrace`，`§15.5 Q5` 留了开放问题）；帧不落盘 + 版本不匹配 → `410 replay_expired`。
- **优先级**：**高**
- **状态**：待处理

### SEC-28 跨源简单请求 + 无 CSRF 判断依据落地（与 SEC-01/SEC-12/SEC-13 的组合面）

- **现状证据**：设计侧结论是"无 cookie、纯 Bearer + JSON → 天然免疫 CSRF"（`docs/systems/11-account-store.md:242`）。实现侧当前**既无 Bearer（SEC-01）也无 Content-Type 强制（SEC-12）**——即该"天然免疫"的两个前提**都还不成立**。实测：`POST /api/v1/box` 带 `content-type: text/plain` → 200，这类请求**不触发 CORS 预检**，浏览器可从任意站点发起。
- **风险**：当前服务默认只监听 `127.0.0.1`（SEC-20），浏览器跨源打本机服务是真实场景（用户本机开着服务，访问了恶意页面）；无状态端点虽不改服务端状态，但 `POST /log-level`（SEC-01）可被匿名改写，且 `/battle` 会消耗 CPU、写入回放注册表（SEC-02/SEC-03）→ **跨源 DoS + 状态污染**。
- **建议处置方向**：把"纯 Bearer + JSON"的两个前提**同时**实现（强制 `application/json` → 依赖预检；Bearer 鉴权 → 无凭据则 401），并在文档里保留该判断依据的**有效期与前提**，避免前提失效而结论仍被引用。
- **优先级**：**中**
- **状态**：待处理

### SEC-29 日志内容含原始 `req.url`/`query`，存在日志注入与取证污染

- **现状证据**：`server/index.js:366` 记录 `${req.method} ${req.url}`（**未转义**，`req.url` 由客户端完全控制）与 `query: req.url.split('?')[1]`；`server/index.js:433` 记录 `urlPath`。`shared/log.js` 的 `onRecord` 在 `main()` 里以 `console.log` 单行输出（`server/index.js:457`），事件名/通道走 `validateEvent` 校验（`scripts/gate.js:241-253`），但 **msg 与 data 无转义**。实测：请求 `/api/v1/%0a伪造行` 之类的 URL 会把换行写进日志行（`decodeURIComponent` 不参与 msg，但 `req.url` 原文即含百分号序列；一旦有任何下游把 `%0a` 解码或日志查看器做了 URL 解码，即可伪造日志行）。
- **风险**：**日志伪造/注入**（终端转义序列注入、伪造"登录成功"式行、破坏日志聚合解析）；配合 SEC-14 的放大效应，可用于**主动污染取证**。
- **建议处置方向**：日志输出对 msg/data 做换行与控制字符转义（`JSON.stringify` 已覆盖 data，msg 需显式处理）；只记录**规范化后的路径**（路由匹配后的模板，如 `/api/v1/replay/:id`），不记原始 URL；query 只记白名单键（如 `from/to`）。
- **优先级**：**低**
- **状态**：待处理

### SEC-30 回放注册表为进程内状态，随重启丢失（可用性/一致性，非传统安全项）

- **现状证据**：`server/battle.js:17-19`（注释 `D-123：不持久化`）、`battle.js:97`（仅进程内 `Map`）、`README.md:35`（"重启即失"）。这是**用户已确认的设计选择**（D-123），不是缺陷。
- **风险**：① 玩家在战斗后被引导去 `GET /replay/:id`，若期间发生部署/重启 → **404 `unknown_replay`**（`battle.js:104`），体验上等同"回放丢了"；② 多实例部署下回放**不可达**（单进程是当前唯一支持形态，`11-account-store.md:64`）；③ 与 SEC-03 结合：攻击者可用内存压力**主动制造重启**，从而批量销毁他人的回放。
- **建议处置方向**：D-135 的"journal 只存引用 + 按需重算"正是为此设计（回放不因重启消失），实现时一并解决；在此之前，前端应把"回放可能失效"作为正常分支而非异常（`404 unknown_replay` 的文案与重试策略）。**登记在此仅为提醒：处置 SEC-03 时不要退化成"落盘存帧"**（会与 D-135 冲突且放大磁盘面）。
- **优先级**：**低**
- **状态**：待处理

---

## 优先级汇总表

| 编号 | 标题 | 分节 | 优先级 | 状态 |
|---|---|---|---|---|
| SEC-01 | 所有 `/api/v1/*` 端点无鉴权，无会话概念 | A | 高 | **已部分处置（2026-09-19）**（残余：`/log-level` 无鉴权；遗留端点默认开放） |
| SEC-02 | 无限流、无并发闸门，唯一"防护"是单端点参数上限 | A | 高 | 待处理 |
| SEC-03 | 回放注册表 `REPLAYS` 无上限，持续请求可耗尽内存 | A | 高 | **已处置（2026-09-19）**（HTTP 层 LRU 64 + 淘汰 → 410 `replay_expired`） |
| SEC-04 | AI 提交无信誉约束、无按账号配额（CPU 消耗攻击面） | A | 中 | 待处理 |
| SEC-05 | 无请求/连接超时，慢速请求可长期占用 socket | A | 中 | 待处理 |
| SEC-06 | `OPTIONS` / 预检完全未处理，跨源调用行为取决于浏览器 | A | 中 | 待处理 |
| SEC-07 | 客户端权威的经济系统可被伪造（品质上限取请求体、仓库/出战整包提交） | B | 高 | 待处理 |
| SEC-08 | `tier` 缺省值与校验口径在端点间不一致 | B | 中 | 待处理 |
| SEC-09 | 排位对手池由客户端提供，可自选/自造对手 | B | 高 | 待处理 |
| SEC-10 | 幂等/重放面：seed 可自选，结算可择优 | B | 中 | 待处理 |
| SEC-11 | 请求体超限返回 500 而非 413，且未 drain/destroy | C | 高 | 待处理 |
| SEC-12 | 无 `Content-Type`/`Accept` 校验，无 415/406 | C | 中 | 待处理 |
| SEC-13 | 无 CORS 策略、无安全响应头 | C | 中 | 待处理 |
| SEC-14 | 日志可被用作放大/污染面（每请求两条 info，无采样/限流） | C | 中 | 待处理 |
| SEC-15 | 未知路径/方法语义不严（统一 404，无 405） | C | 低 | 待处理 |
| SEC-16 | 响应无大小/压缩策略，大响应直接 chunked 抛出 | C | 低 | 待处理 |
| SEC-17 | AI 运行时 `get` 路径解析放宽正则，仅靠投影兜底 | D | 中 | **已处置（2026-09-16）** |
| SEC-18 | 依赖与供应链：无锁文件，`node_modules` 含 extraneous 包 | D | 中 | 待处理 |
| SEC-19 | 无 CI / 无自动化门禁执行 | D | 中 | **已部分处置（2026-09-16）** |
| SEC-20 | 绑定地址可被改成任意地址，无 TLS/无来源限制 | D | 中 | 待处理 |
| SEC-21 | 错误响应泄漏内部信息（`e.message` 回显 + stack 落日志） | D | 中 | 待处理 |
| SEC-22 | 文档冻结的多个环境变量在代码中不存在（配置面与实现面脱节） | D | 低 | **已处置（2026-09-19）**（五个 `DL_*` 已接线；残余 `DL_LOG_CHANNELS`） |
| SEC-23 | 查询串解析静默吞错/畸形即 500 | D | 低 | 待处理 |
| SEC-24 | 未知路径请求仍无条件落 `api.req` 日志 | D | 低 | 待处理 |
| SEC-25 | P7 存储设计：崩溃一致性、并发写、journal `seq` 重启来源未定义 | E | 中（若照原设计直接实现 → 高） | 待处理 |
| SEC-26 | 管理员端点未实现，`DL_ADMIN_TOKEN` 未被读取 | E | 中 | 待处理 |
| SEC-27 | 回放可被任意读取且 id 可枚举（无参与者鉴权） | F | 高 | 待处理 |
| SEC-28 | 跨源简单请求 + 无 CSRF 判断依据落地（组合面） | F | 中 | 待处理 |
| SEC-29 | 日志含原始 `req.url`/`query`，日志注入与取证污染 | F | 低 | 待处理 |
| SEC-30 | 回放注册表进程内状态，随重启丢失（设计取舍，非缺陷） | F | 低 | 待处理 |
| | **合计** | | **高 7 / 中 16 / 低 7 = 30**（2026-09-16 复核更正：原写 6/16/8 与正文及分节统计不符） | **已处置 3（SEC-03 / SEC-17 / SEC-22）/ 已部分处置 2（SEC-01 / SEC-19）/ 待处理 25**（2026-09-19 更新） |

> **状态口径（**D-153**）**：本册**只登记不修复**——不派发任务、不改门禁；但**被顺手修掉的条目必须回填"现状证据 + 状态"**（标为**已处置**/**已部分处置**，附日期与 `文件:行`/测试证据）。
> 截至 2026-09-19：**SEC-03 已处置**（HTTP 层 LRU 64 + 淘汰 → `410 replay_expired`；证据见该条）、**SEC-22 已处置**（五个 `DL_*` 变量均已在 `server/index.js`/`server/store/index.js`/`server/admin.js` 有读取点；残余 `DL_LOG_CHANNELS`）、**SEC-01 已部分处置**（鉴权中间件 + `DL_LEGACY_STATELESS=0` 开关已实现；残余 `/log-level` 无鉴权与遗留端点默认开放）、**SEC-17 已处置**（运行时 + 校验期双白名单）、**SEC-19 已部分处置**（CI + git 钩子 + `demo.js` 补齐；残余"门禁自身可被改写/无 CODEOWNERS"未处置）。

**按分节统计**：A 网络与可用性 6 条（高 3 / 中 3 / 低 0）；B 经济与防作弊 4 条（高 2 / 中 2 / 低 0）；C 传输与配置 6 条（高 1 / 中 3 / 低 2）；D 运行时与代码面 8 条（高 0 / 中 5 / 低 3）；E 持久化与账号 2 条（高 0 / 中 2 / 低 0）；F 其他 4 条（高 1 / 中 1 / 低 2）。

---

## 建议处理顺序（**只是建议，本轮不实现**）

> 排序原则：**先挡住"可被匿名打崩"与"可被匿名读走"的**（A/F），再定权威模型（B），再补传输与工程面（C/D），最后才是 P7 存储（E）。

1. **第 0 步（决定一切）**：定 P7 权威模型与存储方案（前置条件 1 + 5）。若选"服务端账本 + 保留混合权威过渡"，SEC-07/SEC-08/SEC-09/SEC-10 才有明确目标态；若选 `node:sqlite`，SEC-25 风险大幅下降。
2. **第 1 步（可用性止血，可与第 2 步并行）**：SEC-02（限流 + 昂贵端点并发闸门）、SEC-03（回放 LRU 上限，按 D-135）、SEC-11（413 + drain/destroy，顺带消掉 SEC-21 的主路径）、SEC-05（超时）。这一组不依赖账号，**可以在 P7 之前独立落地**，收益最大。
3. **第 2 步（身份）**：SEC-01（鉴权中间件 + `POST /log-level` 收权）→ 解锁 SEC-04（配额）、SEC-14（按来源采样）、SEC-06/SEC-13（CORS 白名单）、SEC-20（来源限制）、SEC-26（admin 端点安全实现）。
4. **第 3 步（信息最小暴露）**：SEC-27（回放参与者鉴权 + 不可枚举 id + 帧裁剪）——与第 2 步同批最省事（都要 `playerId`/`battleId`）。
5. **第 4 步（经济与防作弊）**：SEC-07 的**过渡期拦截**（服务端按 `tier` 重推属性/品质区间并比对、`pool` 服务端抽取、`wins` 服务端结算）→ 之后才谈服务端账本（`11-account-store.md` §15.1 阶段 2 四步）。此步必须与产品方确认"客户端权威是设计选择"这一前提是否需要改变（见下节）。
6. **第 5 步（传输/工程卫生）**：SEC-12、SEC-21、SEC-15、SEC-22、SEC-23、SEC-24、SEC-29、SEC-16（可合并为"HTTP 语义与日志一批"）；SEC-17（运行时白名单，可与 AI 相关批次合并）；SEC-18（依赖与锁文件）、SEC-19（CI 门禁）。
7. **第 6 步（P7 存储落地时）**：SEC-25 的三处规格（`seq` 分配器、崩溃点矩阵、Windows 原子写实测）+ SEC-30（回放不再依赖进程内 Map）。
8. **贯穿全程**：每条处置都补对应测试并扩充 `scripts/gate.js`（把可自动化的安全项——413 语义、404/405 区分、安全头存在性、"5xx 不含内部字符串"、危险 `get` 路径返回 0——做成门禁第 10+ 项）。**没有测试的安全修复等于没修**，因为本仓库唯一的回归防线就是本地门禁。

---

## 特别提醒：以下条目属于**产品级取舍**，不只是"漏洞"

> 本册登记为问题，但**是否算缺陷取决于产品意图**。处置前必须由产品方确认，不能由工程单方面"修掉"。

1. **SEC-07 / SEC-08 / SEC-09（客户端权威的经济系统）——这是「已确认的设计选择」，不只是漏洞。**
   `docs/systems/11-account-store.md:57-59`（§1.3 非目标 1）明写"**不做服务端物品账本**：开箱/仓库/装配仍在客户端（**用户已确认的"混合权威"**）"；§15.1（`:1003-1007`）自认"**段位与积分不具备竞技可信度**"。也就是说：**改两行前端 JS 就能拿到任意属性的 loadout，是当前产品有意接受的状态**，代价换取的是"零持久化 + 后端收口快 + 单进程零依赖"。
   因此处置它不是"修 bug"，而是**改产品模型**：一旦切到服务端账本，就要接受 `11-account-store.md` §6 的全部复杂度（journal/fsync/崩溃恢复/并发队列，见 SEC-25）、`DL_DATA_DIR` 落盘、以及"回放/段位"全部依赖服务端状态。**必须由产品方拍板"是否要竞技可信度"**（§15.5 的开放问题清单里已经挂了这类决策）。
   在拍板之前，工程可做的**只有**：① 文档层面的显式免责（已在 §15.1，建议在 `README.md`/`docs/v3-design.md` 也点一句，避免外部读者误以为段位有意义）；② 廉价拦截（SEC-07 的过渡期方案：越界属性直接拒），它**降低作弊收益但不根治**，且会带来"自洽但更严"的新契约变更，需要同步 `docs/interfaces.md`。
2. **SEC-30（回放重启即失）**：`D-123 不持久化` 是用户已确认的选择（`README.md:35` 明示"重启即失"），登记只为提醒**不要**在修 SEC-03 时退化成"把帧落盘"（与 D-135"只存引用"直接冲突）。
3. **SEC-09 的「仅对手去重」反刷口径**：`decisions.md` D-136 / `11-account-store.md:660-666` 明写**用户选择**"仅同一对手 24h 去重"，`dailyBattleLimit` 默认 `0 = 不限制`（`:638`）。因此"可刷分"在**无排行榜对外**的前提下是**有意接受的**；文档也给了触发条件（`:1033`："**若排行榜要对外可见**，建议至少补 `dailyBattleLimit`"）。→ **建议把"排行榜是否对外可见"设为 SEC-09 的处置开关**，而不是无条件限流。
4. **SEC-18 的「零依赖」**：不是疏漏而是**核心设计哲学**（`server/index.js:3-4` 明写"零依赖 `node:http`……与门禁/测试零依赖哲学一致"）。因此正确处置是**清理 extraneous 包 + 明确零依赖为契约 + 提交锁文件备将来用**，而**不是**顺手引入 express/CORS 中间件等依赖来解决 SEC-06/SEC-13。
5. **SEC-25 的「回放随版本过期」（`410 replay_expired`）**：`11-account-store.md:1029` 明写这是"省空间的**必然代价**"，属设计取舍。登记它只是要求：实现时把"玩家会看到自己的老回放失效"作为**已知产品后果**接受，而不是当成 bug 去绕。
6. **反向提醒（不是取舍，是真问题）**：**SEC-01 / SEC-02 / SEC-03 / SEC-11 / SEC-27 是纯工程缺陷**——在当前"仅本机 127.0.0.1"的部署下影响有限，但**只要 `DL_HOST` 被改成对外（SEC-20），它们立刻变成公网可利用的 DoS 与信息泄漏**。建议把这几条与"是否对外部署"绑定为发布门禁。
