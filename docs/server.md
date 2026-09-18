# Debug-Lite v3 服务器文档

> 版本：v1　创建：2026-09-12　更新基线：**2026-09-16 复核（`main` HEAD `cee2ebf`；后端 P0–P5 共 34 批收口；`npm test` 459/0；`npm run gate` 9 PASS/0 FAIL/0 PEND）**
> 定位：**部署、配置、端点速查与使用说明**。接口契约的唯一权威是 `docs/interfaces.md`（ICD v1 §2/§3）；本文与之一致，冲突时以 interfaces.md 为准。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md`。
> **阅读约定（2026-09-16 起）**：正文中凡标 **✅ 现状** 的，是已实测可用能力；凡标 **⏳ 计划中（P7/B27–B33）** 的，是设计已定但**代码 0 行**，不得按可用能力使用。

---

## 1. 运行要求与启动

| 项 | 要求 |
|---|---|
| Node | `>= 24.18.0`（`package.json engines`） |
| 依赖 | **零运行时依赖**：HTTP 层用 `node:http`，`package.json` **无 `dependencies`**（2026-09-16 复核）。`express` 仅作为白名单存在，**从未引入** |
| 启动 | `npm start`（= `node server/index.js`） |
| 默认监听 | `http://127.0.0.1:3000` |
| 目录 | `server/`（HTTP 层 `index.js` + 编排层 `runner.js`/`box.js`/`loadout.js`/`battle.js`/`ranked.js` + `core/` 确定性内核 + `ai/` 解释器 + `data/` 数据表） |

**进程模型（✅ 现状）**：**单进程、无持久化**。所有玩家状态（仓库、loadout、段位、回放）都只存在于请求/响应中；回放存于 `server/battle.js` 的**进程内 Map**，重启即失（§6.1）。当前代码**不读** `DL_DATA_DIR`，**不写** `runtime/`。

**⏳ 计划中（P7/B27–B33）**：**单进程 + 服务端档案**（D-129；D-123 的"无状态"将被部分推翻）。段位/积分/配置槽/战绩落盘于 `runtime/`；仓库与物品仍由客户端持有（D-130 混合权威）。该能力**尚未实现**（`server/store/`、`server/auth.js`、`server/account.js`、`server/quickmatch.js` 均不存在，`runtime/` 目录不存在）。

## 2. 环境变量配置

> **接线状态（2026-09-16 复核 `server/index.js` + `shared/log.js`）**：代码实际只读 **`DL_PORT` / `DL_HOST` / `DL_LOG_LEVEL`** 三个变量；下表中标 ⏳ 的变量**全部未接线**（写了也没有任何效果）。

| 变量 | 默认 | 说明 | 是否已接线 |
|---|---|---|---|
| `DL_PORT` | `3000` | 监听端口（`0` = 临时端口，测试/冒烟用） | ✅ 已接线（`server/index.js`；`cli/index.js` 也读它作为默认 baseUrl 端口） |
| `DL_HOST` | `127.0.0.1` | 监听地址 | ✅ 已接线（`server/index.js`） |
| `DL_LOG_LEVEL` | `debug`（非 production）/ `warn` | 全局日志级别（`silent/fatal/error/warn/info/debug/trace`） | ✅ 已接线（`shared/log.js`） |
| `DL_LOG_CHANNELS` | 空 | 通道级覆盖，如 `bullets=trace,engine=debug` | ⏳ **未接线**：`shared/log.js` 无任何生产调用者读取该变量（仅 `tests/log/env-config.test.js` 覆盖语义）；通道级覆盖只经运行时 `POST /api/v1/log-level` 的 `channels` 生效 |
| `DL_DATA_DIR` | `<repo>/runtime` | 运行时档案根（档案/索引/journal/快照/会话）；必须可写且不入 git（D-129） | ⏳ **未接线（计划中 P7/B27–B33）**：代码中无引用，`runtime/` 目录不存在 |
| `DL_STORE` | `json` | 存储适配器：`json`（本轮唯一实现）\| `sqlite`（预留，`node:sqlite`） | ⏳ **未接线（计划中 P7/B27–B33）** |
| `DL_ADMIN_TOKEN` | 空 | 管理员端点（bot 注入/重建索引）所需的 token；为空时 admin 端点整体禁用 | ⏳ **未接线（计划中 P7/B33）**：admin 端点不存在 |
| `DL_LEGACY_STATELESS` | `1` | `1` = 保留旧无状态端点；`0` = 返回 `410 deprecated` | ⏳ **未接线（计划中 P7）**：无 `410` 路径，旧端点无开关 |
| `DL_CORS_ORIGIN` | 空 | 前端分离部署时的白名单源；空 = 不发送 CORS 头（同源部署） | ⏳ **未接线（计划中 P7）**：当前任何响应都不发送 CORS 头 |

示例：`$env:DL_PORT=3456; $env:DL_LOG_LEVEL='trace'; npm start`

## 3. 端点总表（实现状态已核对 `server/index.js`，2026-09-16 复核）

> 状态图例：**✅ 现状** = 已在 `server/index.js` 注册、有 `tests/api` 覆盖、gate 项 9 冒烟通过；**⏳ 计划中（P7/B27–B33）** = 仅设计，代码 0 行。

### 3.1 已启用端点（✅）

| 方法 | 路径 | 用途 | 主要错误码 | 批次 |
|---|---|---|---|---|
| GET | `/api/v1/health` | 存活与版本 `{status:'ok', version}` | — | P0-8 |
| GET | `/api/v1/data/:table` | 取数据表（含 `battle-config` 与 `assets/*`） | 404 `unknown_table` / 400 `bad_table` | P0-8 |
| GET | `/api/v1/unlock?tier=` | 该段位可用节点/模板/技能 id | 400 `bad_tier` | B4 |
| GET/POST | `/api/v1/log-level` | 日志总控（GET 查询 / POST 切换） | 400 `bad_level` / `bad_json` | P0-8 |
| POST | `/api/v1/ai/validate` | AI 结构 + 合法性 + 门控（错误带 `path`） | 400 `ai_invalid` | B16 |
| POST | `/api/v1/ai/compile` | 规范化 + `programHash` + 统计 | 400 `ai_too_large`（大小/节点上限，详见 §4） | B16 |
| POST | `/api/v1/ai/battle` | 给定 AI 跑一场（服务端重新执行） | 400 `bad_seed` / 409 `unknown_opponent` | B16 |
| POST | `/api/v1/box` | 开箱（seed/tier/times；品质上限 D-122 + 掉落池门控） | 400 `bad_seed`/`bad_times` / 409 `tier_locked` | B17 |
| GET | `/api/v1/warehouse` | 仓库规范骨架（`emptyWarehouse`） | — | B18 |
| POST | `/api/v1/warehouse/assemble` | 装配（原子性，失败状态不变） | 409 `slot_type_mismatch`/`points_exceeded`/`slot_occupied`/`tier_locked`/`plugin_equipped`/`item_missing` | B18 |
| POST | `/api/v1/warehouse/disassemble` | 拆卸 | 404 `slot_empty`/`plugin_missing` | B18 |
| GET/POST | `/api/v1/loadout` | 读取（返回 `EMPTY_LOADOUT` 骨架）/ 保存校验（无持久化回带） | 409 `loadout_invalid`（details 可含 `missing_warehouse`） | B19 |
| POST | `/api/v1/panel` | 最终面板（五维/regen/special/技能参数） | 409 `loadout_invalid` | B19 |
| POST | `/api/v1/battle` | 双方 loadout + AI + seed → 完整回放帧（**已实现**） | 400 `bad_seed` / 409 `loadout_invalid` | B22（P4） |
| GET | `/api/v1/replay/:id` | 回放帧分片 `?from=&to=`（**已实现**；动态路由） | 400 `bad_replay` / 404 `unknown_replay` | B22（P4） |
| POST | `/api/v1/ranked/run` | 抽 10 场离线结算（D-123 不持久化；**已实现**） | 409 `loadout_invalid`/`no_loadout` / 400 `bad_seed`/`bad_pool` | B24（P5） |
| POST | `/api/v1/ranked/promote` | 晋升判定 x=6 + 段位奖励（**已实现**） | 400 `bad_wins` / 409 `already_max` | B25（P5） |

> **2026-09-16 更正**：本表最后 4 行（`/battle`、`/replay/:id`、`/ranked/run`、`/ranked/promote`）在本文旧版中被误列为"契约已冻结、尚未启用（⏳）"，实际**均已实现**（`server/index.js` 已注册、`tests/api` 覆盖、gate 项 9 冒烟通过）。旧 §3.2 已随之删除。

### 3.2 ⏳ 计划中端点（P7/B27–B33，未实现）

> **本节全部端点代码 0 行**；`server/index.js` 中不存在任何 `/auth/*`、`/me*`、`/quick/*`、`/leaderboard`、`/admin/*` 路由，访问会得到 404 `unknown_endpoint`。逐条清单见 §3.3。

### 3.3 D-129 新增端点（账号 / 档案 / 快速对战）—— **⏳ 计划中（B27~B33），全部未实现（代码 0 行）**

> 以下端点为 D-129…D-136 设计的一部分，**当前不可用**（`server/auth.js`、`server/account.js`、`server/quickmatch.js`、`server/admin.js` 均不存在）。表格保留作为 P7 实现期的契约速查。

| 方法 | 路径 | 用途 | 主要错误码 | 计划批次（B27–B33） |
|---|---|---|---|---|
| POST | `/api/v1/auth/register` | 注册（建账号 + 下发默认配置 + token） | 409 `username_taken` / 400 `weak_password` | B28 |
| POST | `/api/v1/auth/login` | 登录发 token | 401 `invalid_credentials` / 429 `too_many_attempts` | B28 |
| POST | `/api/v1/auth/logout` | 撤销当前会话 | 401 `unauthorized` | B28 |
| POST | `/api/v1/auth/password` | 改密（撤销其他会话） | 401 / 400 `weak_password` | B28 |
| GET | `/api/v1/me` | 档案摘要（段位/积分/未读/槽位） | 401 | B29 |
| GET | `/api/v1/me/configs` | 3 套配置全文 | 401 | B29 |
| POST | `/api/v1/me/configs` | 新建配置槽 | 409 `slot_limit` | B29 |
| PUT | `/api/v1/me/configs/:slotId` | 保存配置（校验 + 冻结快照） | 409 `loadout_invalid` / `config_conflict` | B29 |
| POST | `/api/v1/me/configs/:slotId/activate` | 设为出战配置 | 404 `slot_not_found` | B29 |
| DELETE | `/api/v1/me/configs/:slotId` | 删除槽（默认/出战槽禁止） | 409 `slot_locked` | B29 |
| PUT | `/api/v1/me/nickname` | 改昵称 | 400 | B29 |
| PUT | `/api/v1/me/warehouse` | 提交仓库镜像（引用校验用，非权威） | 400 | B29 |
| GET | `/api/v1/me/records` | 战绩增量（`?since=&limit=&role=`） | 401 | B30 |
| POST | `/api/v1/me/records/seen` | 推进未读游标 | 400 | B30 |
| GET | `/api/v1/me/defense` | **防守战绩**（被抽场次/胜负/最近列表） | 401 | B30 |
| POST | `/api/v1/quick/run` | 快速对战（积分相近 + 非对称 Elo 双向结算） | 409 `no_opponent` | B32 |
| GET | `/api/v1/leaderboard` | 排行榜（`?scope=&limit=`） | 400 `bad_scope` | B30 |
| POST | `/api/v1/admin/bots` | 注入 bot 档案（需 `DL_ADMIN_TOKEN`） | 401 / 403 | B33 |
| POST | `/api/v1/admin/rebuild-index` | 重建索引 | 401 / 403 | B33 |

> 完整字段级契约见 `docs/systems/11-account-store.md` §10；鉴权一律 `Authorization: Bearer <token>`（**计划中**）。

## 4. 统一信封与错误码

**成功**：`{ok:true, data, log:{level, events:[]}}`（`events` 字段为日志摘要占位，当前恒为空数组）。

**失败**：`{ok:false, error:{code, message, details}}`（`details` 为数组，AI 校验时为逐条 `{path,code,message}`）。

HTTP 状态语义（**✅ 现状**）：`400` 参数/请求体错误 ｜ `404` 资源不存在（端点/表/槽位/回放） ｜ `409` 业务拒绝（门控/点数/校验/冲突） ｜ `500` 内部异常（同时记 `api.err`）。
**⏳ 计划中（P7/B27–B33）**：`401` 未鉴权 ｜ `403` 越权/封禁 ｜ `410` 已失效（回放过期/旧端点关闭） ｜ `429` 限速/登录锁定（D-129 扩展）。

> **✅ 现状错误码（已核对代码，2026-09-16）**：下表只列**当前代码真实会产生**的 code。P7 计划中的 code 另列于表后，标 ⏳。

| code | 触发 | 出处 |
|---|---|---|
| `bad_json` | POST 请求体不是合法 JSON | `server/index.js` |
| `bad_request` | 请求体结构不满足端点要求（缺失必填字段/类型错误；如 `/battle` 缺 p1/p2） | `server/index.js`、`server/battle.js` |
| `bad_ai` | `program`/`ai` 字段缺失或不是对象 | `server/index.js` |
| `bad_tier` | `tier` 不在 `common/rare/epic/legendary/mythic` | `server/index.js`、`server/runner.js` |
| `bad_level` | `level` 或通道级别非法；`channels` 不是对象 | `server/index.js` |
| `bad_table` | 表名非法（含 `/`、`..` 或畸形 URI 编码） | `server/index.js` |
| `unknown_table` | 表不存在（`details` 附可用表清单） | `server/index.js` |
| `unknown_endpoint` | 路径未匹配任何端点（404） | `server/index.js` |
| `ai_invalid` | AI 程序不合法（`details` 为逐条错误，含 `path`） | `server/index.js`、`server/runner.js` |
| `ai_too_large` | 程序超过**大小或节点数**上限（`/ai/compile` 与 `/ai/validate` 的 details） | `server/ai/ast.js`（`LIMITS`） |
| `ai_too_deep` | 程序嵌套**深度**超上限（**2026-09-16 补录**；旧表误并入 `ai_too_large` 的"深度"） | `server/ai/ast.js`（`LIMITS.maxDepth`；行号约 197，以 `ai_too_deep` 字面量为准） |
| `bad_seed` | `seed` 非合法正整数（`/ai/battle`、`/box`、`/battle`、`/ranked/run`） | `server/runner.js`、`box.js`、`battle.js`、`ranked.js` |
| `bad_times` | `/box` 的 `times` 不在 `1..BOX_TIMES_MAX` | `server/box.js`（`BOX_TIMES_MAX`） |
| `bad_pool` | `/ranked/run` 的 `pool` 不是 loadout 数组 | `server/ranked.js` |
| `bad_wins` | `/ranked/promote` 的 `wins` 非非负整数或 > 10 | `server/ranked.js` |
| `already_max` | `/ranked/promote` 时已是最高段位 | `server/ranked.js` |
| `no_loadout` | `/ranked/run` 缺少出战配置 | `server/ranked.js` |
| `bad_replay` | `/replay/:id` 的 id 为空、含 `/`、含 `..` 或畸形 URI 编码 | `server/index.js`（`/replay/` 动态路由分支） |
| `unknown_replay` | `/replay/:id` 的 id 不在进程内回放注册表（**404，不是 410**） | `server/battle.js`（`getReplay`） |
| `unknown_opponent` | `/ai/battle` 的 `opponent` 不在示例池（`kiter`/`charger`） | `server/runner.js` |
| `tier_locked` | 门控：玩家段位不足或掉落池为空（`/box`） | `server/box.js` |
| `slot_type_mismatch` / `points_exceeded` / `slot_occupied` / `plugin_equipped` / `item_missing` | 装配四道校验（含唯一性） | `server/core/items.js` |
| `slot_empty` / `plugin_missing` | 拆卸：空槽 / 悬挂引用 | `server/core/items.js` |
| `loadout_invalid` | loadout 校验失败（`details` 逐条，可含 `missing_warehouse`） | `server/loadout.js` |
| `missing_warehouse` | loadout 含装配引用但未提供 `warehouse` | `server/loadout.js`（`missing_warehouse`） |
| `internal_error` | 服务端异常（500，日志记 `api.err`） | `server/index.js` |

> **⏳ 计划中（P7/B27–B33）才会出现的 code**（当前代码中**不存在**，勿据此排查）：
> `unauthorized` / `session_expired`（401）、`invalid_credentials`（401）、`too_many_attempts` / `rate_limited`（429）、`forbidden` / `banned`（403）、`weak_password`（400）、`username_taken`（409）、`slot_limit` / `slot_locked` / `slot_not_found`、`config_conflict`、`no_active_config`、`no_opponent`、`replay_forbidden` / `replay_expired`（410）、`store_write_failed`（500）、`bad_scope`（400）、`deprecated`（410）。

## 5. 端点示例（请求 → 响应要点）

### `GET /api/v1/health`

```jsonc
// 200
{ "ok": true, "data": { "status": "ok", "version": "3.0.0" }, "log": { "level": "debug", "events": [] } }
```

### `GET /api/v1/unlock?tier=rare`

```jsonc
// 200
{ "ok": true, "data": {
    "tier": "rare",
    "nodes": ["seq","action","literal","get","var","set","getVar","cmp","arith","if","else","loop","break"],  // availableNodes 累计
    "roleTemplates": ["role_bal","role_spc_atk", …],   // filterByTier 结果（仅 id）
    "skills": [ … ], "plugins": [ … ] }, … }
```

### `POST /api/v1/box`（请求 `{"seed":1,"tier":"rare","times":3}`）

```jsonc
// 200：data 含 items 数组与回带的 seed
{ "ok": true, "data": { "seed": 1, "tier": "rare", "items": [ { "uid": "…", "kind": "role", … } ] }, … }
// 409（门控后掉落池为空）
{ "ok": false, "error": { "code": "tier_locked", "message": "…" } }
```

### `POST /api/v1/warehouse/assemble`（`{warehouse, targetUid, pluginUid, slotIndex, tier?}`）

```jsonc
// 200：data.warehouse 为装配后的完整仓库
{ "ok": true, "data": { "warehouse": { "roles": […], "skills": […], "rolePlugins": […], "skillPlugins": […] } }, … }
// 409：{ "ok": false, "error": { "code": "points_exceeded", "message": "…" } }
```

### `POST /api/v1/loadout`（`{loadout, warehouse?, tier?}`）

```jsonc
// 200：校验通过，原样回带
{ "ok": true, "data": { "loadout": { "role": {…}, "skills": […], "ai": {…} } }, … }
// 409：{ "ok": false, "error": { "code": "loadout_invalid", "details": [{path,code,message}, …] } }
```

### `POST /api/v1/ai/validate`（`{program|ai, tier?}`）

```jsonc
// 200：{ "ok": true, "data": { "ok": true } }
// 400：{ "ok": false, "error": { "code": "ai_invalid",
//        "details": [{ "path": "body.s[1].then.body.s[0].else", "code": "branch_without_action", "message": "…" }] } }
```

### `POST /api/v1/ai/battle`（`{program|ai, seed?, tier?, opponent?}`）

```jsonc
// 200：真实形状（2026-09-16 复核 server/runner.js runAiBattle 的 data）
// data = { seed, programHash <string>, winner, phase, ticks, frames[] }
{ "ok": true, "data": { "seed": 7, "programHash": "…64位小写十六进制…",
                        "winner": "p1", "phase": "hero_dead", "ticks": 17,
                        "frames": [ { "tick": 1, "players": [ … ], "collision": null,
                                      "bulletHits": [ … ], "verdict": null, "aiTrace": [ … ] } ] } }
```

> **2026-09-16 更正**：旧示例写作 `data.result.{winner,reason,tick,final}` + `programHash:{p1,p2}` + 无 `phase/ticks`，与实现不符。真实形状以 `server/runner.js` 为准：`programHash` 是**单个字符串**，胜负字段直接挂在 `data` 上，且含 `phase`（`b.state.verdict.phase`，无判决时为 `null`）与 `ticks`。

### `GET/POST /api/v1/log-level`

```jsonc
GET  → 200 { "ok": true, "data": { "level": "debug" } }
POST { "level": "trace", "channels": { "bullets": "trace" } } → 200（先全量校验后应用，任何失败都不产生部分生效）
```

## 6. 状态契约：**现状 = 进程内无状态；服务端档案 = 计划中**

> 旧版本节标题为「档案契约（D-129 起；原无状态契约（D-123）已部分推翻）」，把**计划**写成了**现行**。2026-09-16 复核后重写如下。

### 6.1 ✅ 现状（已实测）：进程内、无持久化

- **无账号、无档案、无会话、无鉴权**：`server/index.js` 不读 `Authorization`，不存在任何 `/auth/*`、`/me*` 路由。
- **无运行时目录**：代码不引用 `DL_DATA_DIR`，不创建 `runtime/`，无 journal、无快照库、无归档锁。
- **回放 = 进程内回放注册表**：`server/battle.js` 用模块级 `const REPLAYS = new Map()` 保存整场帧，**无上限、无淘汰、无鉴权**；每场约 **7–20 KB**；进程重启即全部丢失（不落盘）。
  - 未知 id → **404 `unknown_replay`**（不是 410）；`?from=&to=` 为 1-based 含端切分。
- **玩家状态不落盘**：段位（`/ranked/run`、`/ranked/promote`）与 loadout 均由请求方传入并回带，服务端不留痕（D-123 语义仍然成立）。
- **容量口径**：单场战斗 0.175~0.280 ms、回放帧 7.0~20.5 KB（`docs/systems/11-account-store.md` §11 的实测基线，**为设计 P7 所做**，不代表已有存储实现）。

### 6.2 ⏳ 计划中（P7/B27–B33，未实现）：服务端档案契约

以下条目**全部未实现**，仅作为 D-129/D-130 的设计速查；不得据此判断服务已具备档案能力。

- **服务端权威**：账号、配置槽（≤3，唯一出战）、段位、积分、战绩、未读游标、回放引用 → 计划落盘于 `DL_DATA_DIR`（默认 `runtime/`，**必须 .gitignore**）。
- **客户端权威**：仓库、物品、装配、开箱（`box`/`warehouse*` 端点保持无状态校验 + 回带）。服务端只计划保存**出战快照副本**（供他人匹配与回放重算）。
- **跨玩家一致性（计划）**：一场对局涉及双方档案；先 append `journal`（一次落盘即视为对局成立）再 apply 到双方档案，崩溃可重放修复（D-134）。
- **段位/积分双轨（计划）**：段位来自排位批次（D-122，x=6）；积分来自快速对战（D-133 非对称 Elo，从 0 起、上限 3000）。二者互不推导。
- **防守方语义（计划）**：被抽为对手的玩家**不需要在线**；只记战绩（`stats.defense`）与未读红点，段位与积分不变（D-132）。
- **回放（计划，D-135）**：只存 `battleId/seed/双方快照 hash/版本戳`，帧不落盘、按需重算；版本不匹配 → `410 replay_expired`；进程内帧缓存上限 **64 场**；非参与者 → `403 replay_forbidden`。

### 6.3 ✅ 现状中仍然有效的无状态语义（D-130 范围内）

- 开箱随机性：请求带 `seed` 缺省由服务端生成并**回带**，同 seed 重复请求结果一致（T-AP-5）。
- 物品 `uid` 语义（B17 登记）：进程内单调唯一（服务重启后重新计数），**不参与内容级比较**。
- **作弊面登记**：由于仓库/配置由客户端提交，**段位与积分不具备竞技可信度**；缓解与后续"服务端物品账本"路线见 `docs/systems/11-account-store.md` §15.1。

## 7. CLI（唯一"操作台"，只走 HTTP）

```bash
npm run cli -- health | data <table> | box --seed 1 --tier common --times 10
npm run cli -- wh list|assemble|disassemble ...
npm run cli -- panel --loadout <file>
npm run cli -- ai validate|compile|battle --file ai.json [--tier rare] [--opponent kiter] [--seed N]
npm run cli -- battle --p1 a.json --p2 b.json [--seed N] [--out replay.json]   # P4 B22（经 HTTP）
npm run cli -- replay --file replay.json [--tick N]                           # P4 B23（本地文件）
npm run cli -- ranked run --seed N --loadout <file> [--tier <t>] [--pool <file>]  # P5 B24（`--loadout` 必填；无 promote 子命令）
npm run cli -- log --level trace --channel bullets=trace
```
- 退出码：`0` 成功 / `1` 业务拒绝 / `2` 参数错误（T-CLI-2）。
- CLI **不 require core**，全部经 HTTP——它本身就是接口完整性验收工具。
- **2026-09-16 更正**：`wh list` 需带 `--file wh.json`；`ranked` 只有 `run` 子命令且 `--loadout` 必填（原文档的裸 `wh list`、`ranked run --seed N`、隐式的 promote 子命令均会以退出码 2 失败）。`npm run demo` / `demo:log` 当前**不可执行**（`scripts/demo.js` 不存在，见 §10）。

## 8. 日志

| 主题 | 说明 |
|---|---|
| 级别 | `silent/fatal/error/warn/info/debug/trace`（`DL_LOG_LEVEL` 或运行时 `POST /api/v1/log-level`） |
| 通道 | `rng field effects items roles skills bullets engine damage ai.ast ai.runtime unlock api cli ranked store view render editor perf log`（`store` 属 P7 计划；`view`/`render`/`editor`/`perf` 属 P6 计划，均当前无生产调用者） |
| HTTP 层事件 | 每个请求：`api.req`(info) → 处理 → `api.res`(info，含耗时与字节) / `api.err`(error) |
| 输出 | ≥`info` 写 stdout（`main()` 的 sink）；`debug/trace` 默认只入环形缓冲（N=2000，`dump()` 可导出） |
| 请求体上限 | POST 1MB（超限 500 拒绝，见 `readBody`） |

> **2026-09-16 复核**：`DL_LOG_CHANNELS` **未接线**（`shared/log.js` 无生产调用者读取该变量）；通道级覆盖当前只能经 `POST /api/v1/log-level` 的 `channels` 参数生效（见 §2）。

## 9. 数据表与资源

`GET /api/v1/data/:table` 覆盖 `server/data/*.json` + `assets/*.json`：

```
✅ 现状（2026-09-16 复核 server/data 目录）：
battle-config  items-config  plugins  qualities  role-templates  skill-templates  unlock   （+ assets: sprites/animations）

⏳ 计划中（P7）且当前不存在：service-config（槽位/会话/保留期/缓存上限）  rating-config（D-133 积分与匹配参数）
```

- 全部表由 `server/data/schema.js` 校验（T-DC-1/2，`npm run gate` 第 4/5 项）。计划新增的 `service-config.json` 与 `rating-config.json` 须同步 schema 与 `server/data/README.md`（**尚未创建**）。
- 战斗数值**全部**在 `battle-config.json`（L9，禁止硬编码；`checkNumericHardcode` 门禁检查）。
- **`server/data/` 只放只读数据表**：门禁项 4/5 会遍历该目录，运行时档案**必须**写在数据目录之外（计划：`DL_DATA_DIR`，默认 `runtime/`），否则门禁失败。

### 9.1 运行时数据目录 —— **⏳ 计划中（P7/B27–B33），当前不存在**

> 2026-09-16 复核：仓库根**没有** `runtime/` 目录，代码也不引用 `DL_DATA_DIR`。以下为 D-129 的设计布局，仅作 P7 实现参考。

```
runtime/
├── index.json                    # 匹配/排行榜索引（~200 B/玩家，可重建）
├── sessions.json                 # 会话表（可丢弃）
├── players/<shard>/<playerId>.json   # 物化档案（可重建）
├── snapshots/<aa>/<hash>.json    # 内容寻址快照库（不可变，回放重算依赖）
└── journal/<yyyymm>.jsonl        # append-only 真源（跨玩家结算）
```

- 备份点：直接快照整个 `runtime/`（建议停机或先 flush）；单进程锁 `runtime/lock` 防止两个进程写同一目录。
- 容量估算与"何时引入数据库"的判据见 `docs/systems/11-account-store.md` §11（实测：0.175~0.280 ms/场，帧 7.0~20.5 KB，索引 ~200 B/玩家；该实测是为 P7 设计做的基线，不代表已有存储实现）。

## 10. 测试与门禁

```bash
npm test        # node --test --test-isolation=none tests/**/*.test.js（沙箱下必须单进程）→ 2026-09-16 实测 459 通过 / 0 失败
npm run cov     # 同左 + 覆盖率阈值（core/ai/shared/cli：行≥90% 分支≥85% 函数≥90%）
npm run gate    # 单进程内联 9 项：静态/架构/schema/一致性/D 落点/日志规范/全量测试/日志冒烟/接口冒烟 → 2026-09-16 实测 9 PASS/0 FAIL/0 PEND
npm run demo    # ⚠ 当前不可执行：scripts/demo.js 不存在（全 git 历史无此文件）
```
- 门禁失败只能修代码/修测试；禁止放宽阈值绕过（阈值调整属 `tasks.md` §10 变更控制）。
- `npm run demo` / `npm run demo:log` 的引用**保留**（计划补齐 `scripts/demo.js`），但在补齐前**不得**陈述为"已实测通过"。

## 11. 与前端 / 排位 / 快速对战 / 回放的关系

- **前端（P6，未开始）**：main 上**无任何前端代码**（无 `public/`，`server/index.js` 无静态托管路由）。计划中的唯一数据来源是本文 §3.1 的现状端点与 `interfaces.md` §2。**⏳ 计划中（P7/B27–B33）**：仓库/开箱仍由前端持有（localStorage），但账号、配置槽、段位、积分、战绩、回放引用改为服务端拉取（`GET /me`）+ `Authorization: Bearer` 鉴权 —— 前端设计见 `docs/frontend-spec.md`（**待同步**：登录屏、我的战绩、防守战绩、排行榜、token 存储）。
- **排位（P5 已实现 / 计划迁移）**：**现状** `POST /ranked/run`、`POST /ranked/promote` 已实现，但仍是**无状态**（段位由请求传入并回带，D-123 不持久化）。**⏳ 计划中（P7/B31）**：改为服务端抽池 + 双向记账（D-132）；段位服务端权威，前端只展示。
- **快速对战（⏳ 计划中 P7/B32）**：`quick/run` 按积分窗口匹配 + 非对称 Elo 双向结算（D-133）。**当前端点不存在**。
- **回放（P4 已实现 / 计划增强）**：**现状** `POST /battle` + `GET /replay/:id` 已实现，帧存于**进程内无上限 Map**、无鉴权、未知 id → 404。**⏳ 计划中（P7/B33）**：需参与者鉴权（403 `replay_forbidden`），帧由服务端按需重算（D-135），上限 64 场、过期 410 `replay_expired`；前端渲染层只消费帧，不重算。