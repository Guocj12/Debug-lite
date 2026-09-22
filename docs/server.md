# Debug-Lite v3 服务器文档

> 版本：v1　创建：2026-09-12　更新基线：**2026-09-19 复核（后端 P0–P5 共 34 批 + P7/B27–B33 共 7 批已收口；`npm test` = 942 通过 / 0 失败；`npm run gate` = 9 PASS / 0 FAIL / 0 PEND；`npm run check:docs` PASS）**
> 定位：**部署、配置、端点速查与使用说明**。接口契约的唯一权威是 `docs/interfaces.md`（ICD v1 §2/§3）；本文与之一致，冲突时以 interfaces.md 为准。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md`。
> **阅读约定（2026-09-19 起）**：正文中凡标 **✅ 现状** 的，是已实测可用能力；凡标 **⏳ 计划中** 的，是设计已定但**代码 0 行**，不得按可用能力使用。**P7（B27–B33：服务端档案 / 鉴权 / 排位改造 / 快速对战 / 回放鉴权）已于 2026-09-19 收口，本文中凡旧标注「计划中（P7/B27–B33）」的段落均已按实测改为「现状」**；唯一保留的 ⏳ 是**遗留无状态端点在生产关闭**（`DL_LEGACY_STATELESS=0`）与 SQLite 适配器（§11.4）。

---

## 1. 运行要求与启动

| 项 | 要求 |
|---|---|
| Node | `>= 24.18.0`（`package.json engines`） |
| 依赖 | **零运行时依赖**：HTTP 层用 `node:http`，`package.json` **无 `dependencies`**（2026-09-16 复核）。`express` 仅作为白名单存在，**从未引入** |
| 启动 | `npm start`（= `node server/index.js`） |
| 默认监听 | `http://127.0.0.1:3000` |
| 目录 | `server/`（HTTP 层 `index.js` + 编排层 `runner.js`/`box.js`/`loadout.js`/`battle.js`/`ranked.js` + **P7 身份与档案层 `auth.js`/`account.js`/`quickmatch.js`/`admin.js`** + **存储层 `store/`（唯一允许 `node:fs`）** + `core/` 确定性内核 + `ai/` 解释器 + `data/` 只读数据表）；运行时数据在 `DL_DATA_DIR`（默认 `<repo>/runtime`，非 `server/`） |

**进程模型（✅ 现状，2026-09-19 复核）**：**单进程 + 服务端档案**（D-129）。段位/积分/配置槽/战绩/未读游标/会话落盘于运行时数据根 `DL_DATA_DIR`（默认 `<repo>/runtime`）；仓库与物品仍由客户端 localStorage 持有（D-130 混合权威），服务端只保存**出战快照副本**（含该配置实际引用到的插件项，**有界、非整仓**）。`server/store/*`（唯一允许 `node:fs` 的目录）、`server/auth.js`、`server/account.js`、`server/quickmatch.js`、`server/admin.js` 均已实现并接线；`runtime/` 目录已存在（运行时生成，已 `.gitignore`）。旧的"所有玩家状态只存在于请求/响应中、无持久化"**无状态语义只保留在遗留路径**（`DL_LEGACY_STATELESS=1`，见 §2/§3）；回放帧另有进程内 LRU（默认 64）+ 归档按需重算（§6.2）。

- **落盘开关口径（实测）**：`start()` **缺省不落盘**——只有传了 `dataDir`/`enableStore:true`/环境变量 `DL_DATA_DIR` 才打开 store；`npm start`（= `main()`）显式 `enableStore: true`，`dataDir` 缺省解析为 `<repo>/runtime`。测试经 `DL_DATA_DIR` 指向临时目录（`tests/helpers/store.js`）。
- 单进程锁 `runtime/lock`：存在且 PID 存活 → 第二个进程拒绝启动（§9.1）。

## 2. 环境变量配置

> **接线状态（2026-09-19 复核 `server/index.js` / `server/store/index.js` / `server/admin.js` / `shared/log.js`）**：`DL_PORT`/`DL_HOST`/`DL_LOG_LEVEL` 之外，**P7 新增的五个变量（`DL_DATA_DIR`/`DL_STORE`/`DL_ADMIN_TOKEN`/`DL_LEGACY_STATELESS`/`DL_CORS_ORIGIN`）均已接线**，在 `server/index.js` / `server/store/index.js` / `server/admin.js` 有真实读取点（`docs/security-backlog.md` SEC-22 已回填处置）。下表中**仍标 ⏳ 的只有 `DL_LOG_CHANNELS`**。

| 变量 | 默认 | 说明 | 是否已接线 |
|---|---|---|---|
| `DL_PORT` | `3000` | 监听端口（`0` = 临时端口，测试/冒烟用） | ✅ 已接线（`server/index.js`；`cli/index.js` 也读它作为默认 baseUrl 端口） |
| `DL_HOST` | `127.0.0.1` | 监听地址 | ✅ 已接线（`server/index.js`）。**非回环时必须先完成鉴权与限流**（安全登记册 SEC-01/SEC-20） |
| `DL_LOG_LEVEL` | `debug`（非 production）/ `warn` | 全局日志级别（`silent/fatal/error/warn/info/debug/trace`） | ✅ 已接线（`shared/log.js`） |
| `DL_LOG_CHANNELS` | 空 | 通道级覆盖，如 `bullets=trace,engine=debug` | ⏳ **未接线**：`shared/log.js` 无任何生产调用者读取该变量（仅 `tests/log/env-config.test.js` 覆盖语义）；通道级覆盖只经运行时 `POST /api/v1/log-level` 的 `channels` 生效 |
| `DL_DATA_DIR` | `<repo>/runtime` | 运行时档案根（档案/索引/journal/快照/会话）；必须可写且不入 git（D-129） | ✅ **已接线（P7，2026-09-19）**：`server/index.js` 的 `storeWanted()` 与 `server/store/index.js` 的 `resolveDataDir()` 读取；未设时 `main()` 仍以 `<repo>/runtime` 为缺省（`start()` 缺省不落盘，见 §1） |
| `DL_STORE` | `json` | 存储适配器：`json`（本轮唯一实现）\| `sqlite`（预留，`node:sqlite`） | ✅ **已接线（P7）**：`server/store/index.js` 按该值选适配器；`sqlite` 适配器为契约骨架，`open()` **抛** `store_adapter_unavailable`（有意不静默退回 json，见 `11-account-store.md` §11.4） |
| `DL_ADMIN_TOKEN` | 空 | 管理员端点（bot 注入/重建索引/统计/封禁）所需的 token；为空时 admin 端点整体禁用 | ✅ **已接线（P7/B33）**：`server/admin.js` 读取；空 → `503 admin_token_missing`；比较用 `crypto.timingSafeEqual` |
| `DL_LEGACY_STATELESS` | `1` | `1` = 保留旧无状态端点；`0` = 遗留端点返回 `410 deprecated`（`ranked/run\|promote` 无 token 时改 `401`） | ✅ **已接线（P7-4）**：`server/index.js` 的 `legacyStatelessOf()`；默认 `1` |
| `DL_CORS_ORIGIN` | 空 | 前端分离部署时的白名单源；空 = 不发送 CORS 头（同源部署） | ✅ **已接线（P7-4）**：`server/index.js` 读入 CORS 白名单；未配置时**不发送** `Access-Control-Allow-Origin` |
| `DL_DEBUG_BOTS` | 空 | 调试 bot 注入的**第二道门控**（须 `=1`） | ✅ 已接线（`server/ranked.js`）；未设 → admin 注入返回 `403 debug_bots_disabled` |
| `DL_ADMIN_USERS` | 空 | **F2 新增**：管理员账号白名单（逗号分隔的**用户名**或 **publicId**/`playerId`，大小写不敏感；空 = 无账号级管理员）。命中者可**不带令牌**调用 `/admin/*` | ✅ **已接线（F2）**：`server/admin.js` 的 `adminUsersOf(env)`（唯一判定处）；`server/index.js` 注入 `auth` 的用户名索引做用户名→playerId 比对 |
| `DL_TOKEN` | 空 | CLI 的 token 来源（优先级最低，见 §7） | ✅ 已接线（`cli/index.js`：`--token` > `options.token` > `DL_TOKEN`） |

示例：`$env:DL_PORT=3456; $env:DL_LOG_LEVEL='trace'; npm start`

## 3. 端点总表（实现状态已核对 `server/index.js`，2026-09-19 复核）

> 状态图例：**✅ 现状** = 已在 `server/index.js` 注册、有 `tests/api` 覆盖、gate 项 9 冒烟通过（**P0–P5 与 P7 端点均属此类**）；**⏳ 计划中** = 仅设计、代码 0 行（当前**只**剩 §2 的 `DL_LOG_CHANNELS` 与 `DL_STORE=sqlite` 两处）。

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
| GET | `/api/v1/replay/:id` | 回放帧分片 `?from=&to=`（**已实现**；动态路由）。**P7-4 起**：参与者鉴权 + 帧 LRU 64（淘汰/版本不匹配/快照失效 → 410）；`b_` 型归档回放按需重算 | 400 `bad_replay`；403 `replay_forbidden`；404 `unknown_replay`；410 `replay_expired` | B22（P4）/ P7-4 |
| POST | `/api/v1/ranked/run` | **双轨**：有 token → 档案驱动（服务端抽池 + 双向记账 + 晋升落盘；传 `pool` → 400 `pool_forbidden`）；无 token 且 `DL_LEGACY_STATELESS=1`（默认）→ 遗留无状态口径；`=0` → 401 | 400 `bad_seed`/`bad_pool`/`pool_forbidden`；401；409 `loadout_invalid`/`no_loadout`/`no_active_config`/`store_not_found`；503 `store_unavailable` | B24（P5）/ B31（P7） |
| POST | `/api/v1/ranked/promote` | 晋升判定 x=6 + 段位奖励。有 token → **段位以档案为准**（不一致 → 403）、**只判定不落盘**；无 token → 遗留口径 | 400 `bad_wins` / `bad_tier`；401；403 `forbidden`；409 `already_max` | B25（P5）/ B31（P7） |
| GET | `/` | **P6/F1 静态托管**：返回 `public/index.html`（前端入口；**非 `/api/v1` 契约**） | 404 `unknown_endpoint`（`public/` 缺失或未命中） | F1 |
| GET | `/<public 资源>` | **P6/F1 静态托管**：`public/` 下白名单资源（`.html/.js/.css/.json/.svg/.ico`），`cache-control: no-store` | 404 `unknown_endpoint`（含路径穿越/非白名单/文件不存在） | F1 |

> **2026-09-16 更正**：本表最后 4 行（`/battle`、`/replay/:id`、`/ranked/run`、`/ranked/promote`）在本文旧版中被误列为"契约已冻结、尚未启用（⏳）"，实际**均已实现**（`server/index.js` 已注册、`tests/api` 覆盖、gate 项 9 冒烟通过）。旧 §3.2 已随之删除。

### 3.2 P7 新增端点（账号 / 档案 / 快速对战）—— **✅ 已实现（B27–B33，2026-09-19 实测）**

> 以下端点均已在 `server/index.js` 注册并有 `tests/api` 覆盖（`server/auth.js`、`server/account.js`、`server/quickmatch.js`、`server/admin.js` 均已实现）。完整字段级契约见 `docs/systems/11-account-store.md` §10 与 `docs/interfaces.md` §2；鉴权一律 `Authorization: Bearer <token>`（缺失/失效 → 401，越权 → 403）。

| 方法 | 路径 | 用途 | 主要错误码 | 批次 |
|---|---|---|---|---|
| POST | `/api/v1/auth/register` | 注册（建账号 + 下发默认配置 + token） | 400 `weak_password`/`bad_request`；409 `username_taken` | B28 |
| POST | `/api/v1/auth/login` | 登录发 token | 401 `invalid_credentials`；429 `too_many_attempts` | B28 |
| POST | `/api/v1/auth/logout` | 撤销当前会话 | 401 `unauthorized` | B28 |
| POST | `/api/v1/auth/password` | 改密（撤销其他会话）；**别名** `/auth/change-password` ≡ 本行 | 401；400 `weak_password` | B28 |
| GET | `/api/v1/me` | 档案摘要（段位/积分/未读/槽位） | 401 | B29 |
| GET | `/api/v1/me/configs` | 3 套配置全文 | 401 | B29 |
| POST | `/api/v1/me/configs` | 新建配置槽 | 401；409 `slot_limit` | B29 |
| PUT | `/api/v1/me/configs/:slotId` | 保存配置（校验 + 冻结快照，含装配引用子集） | 401；400；409 `loadout_invalid`/`config_conflict` | B29 |
| POST | `/api/v1/me/configs/:slotId/activate` | 设为出战配置 | 401；404 `slot_not_found` | B29 |
| DELETE | `/api/v1/me/configs/:slotId` | 删除槽（默认/出战槽禁止） | 401；409 `slot_locked` | B29 |
| PUT | `/api/v1/me/nickname` | 改昵称（`nicknameMax` 夹到 ≤16） | 400 `bad_request`；401 | B29 |
| PUT | `/api/v1/me/warehouse` | 提交仓库镜像（引用校验用，非权威）；响应可含 `snapshotWarehouseRefreshed` | 400；401 | B29 |
| GET | `/api/v1/me/warehouse` | 回读本进程镜像 | 404 `warehouse_missing`；401 | B29 |
| GET | `/api/v1/me/records` | 战绩（`?since=&limit=&role=`）→ `records/since/latestSeq/limit/role/unread/maxSeq` | 400 `bad_request`；401 | B30 |
| POST | `/api/v1/me/records/seen` | 推进未读游标（**唯一入口**）；**别名** `/me/seen` ≡ 本行 | 400；401 | B30 |
| GET | `/api/v1/me/defense` | **防守战绩**（被抽场次/胜负/最近列表） | 401 | B30 |
| POST | `/api/v1/quick/run` | 快速对战（积分相近 + 非对称 Elo 双向结算） | 400 `bad_seed`；401；403 `banned`；409 `no_opponent`/`no_active_config`/`store_not_found` | B32 |
| GET | `/api/v1/leaderboard` | 排行榜（`?scope=global\|tier:<t>&limit=`；不回 `playerId`） | 400 `bad_scope` | B30/B32 |
| POST | `/api/v1/admin/:op` | 运维（单动态路由）：`bots`/`rebuild-index`/`stats`/`clear-bots`/`ban`/`unban` + **F2 新增** `accounts`（分页全量账号列表 `{offset,limit}` → `{total,offset,limit,hasMore,rows[]}`；**total 无 100 条上限**）与 `delete-account`（按 `playerId`/`publicId` 删除，写 `player.removed` 墓碑，禁删自己）。**授权（D-158）**：管理员账号（`DL_ADMIN_USERS`，Bearer）**或** `X-Admin-Token`/Bearer == `DL_ADMIN_TOKEN` | 400 `bad_request`；401/403 `forbidden`；403 `debug_bots_disabled`；404 `store_not_found`/`unknown_endpoint`；409 `cannot_delete_self`；503 `admin_token_missing` | B33 / **F2** |

> `PUT /me/configs/:slotId`、`PUT /me/nickname`、`PUT /me/warehouse`、`DELETE /me/configs/:slotId`、`POST /me/configs/:slotId/activate` 注册在 `server/index.js` 的 PUT/DELETE 路由表中（其余为 GET/POST）。

## 4. 统一信封与错误码

**成功**：`{ok:true, data, log:{level, events:[]}}`（`events` 字段为日志摘要占位，当前恒为空数组）。

**失败**：`{ok:false, error:{code, message, details}}`（`details` 为数组，AI 校验时为逐条 `{path,code,message}`）。

HTTP 状态语义（**✅ 现状，P7-4 已扩展并实测**）：`400` 参数/请求体错误 ｜ `401` 未鉴权（缺/失效会话） ｜ `403` 越权/封禁/非参与者 ｜ `404` 资源不存在（端点/表/槽位/回放/仓库镜像） ｜ `409` 业务拒绝（门控/点数/校验/冲突/槽位/匹配） ｜ `410` 已失效（回放过期 / 遗留端点被 `DL_LEGACY_STATELESS=0` 关闭） ｜ `413` 请求体过大 ｜ `429` 全局限速 / 登录锁定 ｜ `500` 内部异常（同时记 `api.err`） ｜ `503` 存储未装配 / 管理端未配置。

> **✅ 错误码总表（已核对代码，2026-09-19）**：下表列出**当前代码真实会产生**的 code，含 P7 新增。

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

**P7（B27–B33）新增且已实测的 code**：

| code | HTTP | 触发 | 出处 |
|---|---|---|---|
| `unauthorized` | 401 | 缺 token / token 无效 | `server/index.js` |
| `session_expired` | 401 | 会话过期（`store.sessions.peek()` 区分"不存在"与"刚过期"） | `server/index.js`、`server/store/session-table.js` |
| `invalid_credentials` | 401 | 用户名或密码错误（不区分） | `server/auth.js` |
| `forbidden` | 403 | 越权（他人资源 / 非管理员 / 段位与档案不一致） | `server/index.js` |
| `banned` | 403 | `flags.banned` | `server/auth.js`、`server/index.js` |
| `replay_forbidden` | 403 | 非该场参与者 | `server/index.js` |
| `debug_bots_disabled` | 403 | 未设 `DL_DEBUG_BOTS=1` | `server/admin.js` |
| `weak_password` | 400 | 密码长度/字符不满足 | `server/auth.js` |
| `pool_forbidden` | 400 | `/ranked/run` 传入 `pool`（服务端抽池，D-136） | `server/ranked.js` |
| `bad_scope` | 400 | 排行榜 `scope` 非法 | `server/account.js` |
| `slot_limit` / `slot_locked` / `slot_not_found` | 409 / 409 / 404 | 槽位上限 / 默认或出战槽禁删 / 槽不存在 | `server/account.js` |
| `config_conflict` | 409 | 乐观锁冲突（`baseUpdatedAt` 不匹配） | `server/account.js` |
| `no_active_config` | 409 | 出战配置或快照缺失（不变量破损） | `server/account.js` |
| `no_opponent` | 409 | **快速对战**匹配不到对手（候选不足/窗口用尽；排位池不足用 `shortfall` 字段） | `server/quickmatch.js` |
| `username_taken` | 409 | 用户名已存在（大小写不敏感） | `server/auth.js` |
| `already_max` | 409 | 已在最高段位 | `server/ranked.js` |
| `too_many_attempts` | 429 | 登录失败锁定（5 次/5 分钟） | `server/auth.js` |
| `rate_limited` | 429 | 全局限速命中（600 次/分/principal，进程内滑动窗口） | `server/index.js` |
| `payload_too_large` | 413 | 请求体超 1MB（**原为 500 `internal_error`**） | `server/index.js`（`readBody`） |
| `deprecated` | 410 | 遗留无状态端点被 `DL_LEGACY_STATELESS=0` 关闭 | `server/index.js` |
| `replay_expired` | 410 | 帧 LRU 淘汰 / 引擎或数据版本不匹配 / 快照不可用 | `server/index.js` |
| `warehouse_missing` | 404 | `GET /me/warehouse`：本进程无该玩家的仓库镜像 | `server/account.js` |
| `store_unavailable` | 503 | 未装配档案存储（`DL_DATA_DIR` 未启用） | `server/index.js` |
| `admin_token_missing` | 503 | `DL_ADMIN_TOKEN` 未配置（管理端整体不可用） | `server/admin.js`、`server/index.js` |
| `store_write_failed` | 500 | journal / 档案写失败（磁盘满等） | `server/store/*` |
| `store_adapter_unavailable` | — | `DL_STORE=sqlite`（`open()` 抛错，不静默退回 json） | `server/store/adapter-sqlite.js` |

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

## 6. 状态契约：**现状 = 服务端档案（D-129）+ 遗留无状态双轨**

> 2026-09-19 复核：P7（B27–B33）已收口，本节由"计划 vs 现状"改写为**现行契约**。历史版本曾把**计划**写成**现行**（2026-09-16 前），也曾把**现行**写成**计划**（2026-09-16 后），两次漂移均在此修正。

### 6.1 ✅ 现状（已实测）：服务端档案 + journal + 快照库

- **账号/会话/鉴权**：`server/index.js` 有 Bearer 鉴权中间件；`/auth/*`、`/me*`、`/quick/*`、`/leaderboard`、`/admin/*` 路由均已注册（§3.2）。未鉴权/越权 → 401/403。
- **运行时目录**：`DL_DATA_DIR`（默认 `<repo>/runtime`）存放 `index.json`/`sessions.json`/`players/`/`snapshots/`/`journal/`/`lock`（§9.1）。
- **服务端权威**：账号、配置槽（≤3，唯一出战）、段位、积分、战绩、未读游标、回放引用落盘于 `DL_DATA_DIR`。
- **客户端权威**：仓库、物品、装配、开箱（`box`/`warehouse*` 端点保持无状态校验 + 回带，D-130）。服务端只保存**出战快照副本**（供他人匹配与回放重算），快照正文**额外携带该配置实际引用到的插件项**（装配引用子集，**有界、非整仓**；`server/store/archive.js` 的 `warehouseExcerpt`）——D-130 的"仓库不落服务端账本"**其余不变**。
- **跨玩家一致性**：一场对局涉及双方档案；先 append `journal`（一次落盘即视为对局成立）再 apply 到双方档案，崩溃可重放修复（D-134）。**每档案 `appliedSeq` ≠ 全局 `index.seq`**（只有走 journal 的写推进前者；`touchLastSeen`/未读游标等纯 A 类写不动水位）。
- **段位/积分双轨**：段位来自排位批次（D-122，x=6）；积分来自快速对战（D-133 非对称 Elo，从 0 起、上限 3000）。二者互不推导。
- **防守方语义**：被抽为对手的玩家**不需要在线**；只记战绩（`stats.defense`）与未读红点，段位与积分不变（D-132）。
- **回放（D-135）**：`battle.recorded` 只存 `battleId/seed/双方快照 hash/版本戳`，帧不落盘、按需重算；版本不匹配/快照不可用/帧 LRU 淘汰 → `410 replay_expired`；进程内帧缓存上限 **64 场**；非参与者 → `403 replay_forbidden`；`?trace=self` 按请求者 side 裁剪 `aiTrace`。
- **容量口径**：单场战斗 0.175~0.280 ms/场、索引 ~200 B/玩家；回放帧**实测 61–268 KB/场**（17–63 tick，≈2.7–3.5 KB/帧；旧口径"7–20.5 KB"偏小约一个数量级，2026-09-16 已修正，见 `docs/progress.md` §0）。

### 6.2 ✅ 仍然有效的无状态语义（D-130 范围内）

- 开箱随机性：请求带 `seed` 缺省由服务端生成并**回带**，同 seed 重复请求结果一致（T-AP-5）。
- 物品 `uid` 语义（B17 登记）：进程内单调唯一（服务重启后重新计数），**不参与内容级比较**。
- **作弊面登记**：由于仓库/配置由客户端提交，**段位与积分不具备竞技可信度**；缓解与后续"服务端物品账本"路线见 `docs/systems/11-account-store.md` §15.1。
- **遗留无状态端点**：`box`/`warehouse*`/`loadout`/`panel`/`ai/*`/`battle` 默认保留（`DL_LEGACY_STATELESS=1`）；置 `0` 时这些端点返回 `410 deprecated`（`ranked/run|promote` 无 token 时改为 `401`）。

## 7. CLI（唯一"操作台"，只走 HTTP）

```bash
npm run cli -- health | data <table> | box --seed 1 --tier common --times 10
npm run cli -- wh list|assemble|disassemble ...
npm run cli -- panel --loadout <file>
npm run cli -- ai validate|compile|battle --file ai.json [--tier rare] [--opponent kiter] [--seed N]
npm run cli -- battle --p1 a.json --p2 b.json [--seed N] [--out replay.json]   # P4 B22（经 HTTP）
npm run cli -- replay --file replay.json [--tick N]                           # P4 B23（本地文件）
npm run cli -- ranked run --seed N [--loadout <file>] [--tier <t>] [--pool <file>] [--token <t>]
                                  # P5 B24 / P7-3 双轨：有 token → 档案驱动（服务端抽池）；无 token → 遗留口径
npm run cli -- ranked promote [--wins N] [--tier <t>] [--token <t>]           # P5 B25 / P7-4（有 token 时读档案）
npm run cli -- auth register|login|logout|change-password --user <u> --pass <p> [--nick <n>] [--save-token <f>]
npm run cli -- me [--token <t>]                                   # P7-4：档案摘要（段位/积分/未读/槽位）
npm run cli -- quick run [--seed N] [--token <t>]                 # P7-4：快速对战（非对称 Elo 双向结算）
npm run cli -- leaderboard [--limit N] [--scope global|tier:<t>]  # P7-4：排行榜
npm run cli -- log --level trace --channel bullets=trace
```
- 退出码：`0` 成功 / `1` 业务拒绝 / `2` 参数错误（T-CLI-2）；**P7-4 新增 `3` = 未鉴权**（HTTP 401 → 3，便于脚本区分）。
- **token 来源优先级（P7-4）**：`--token <t>` > `options.token`（进程内调用）> 环境变量 `DL_TOKEN`；`--save-token` 写文件时权限 0600。
- CLI **不 require core**，全部经 HTTP——它本身就是接口完整性验收工具。
- **2026-09-16 更正**：`wh list` 需带 `--file wh.json`。`npm run demo` / `demo:log` / `play` 均已可执行（`scripts/demo.js`、`scripts/play.js` 已落地，见 §10）。
- **未实现（后续批次，实测退出码 2）**：`configs *`、`records`、`defense`、`admin *`、`replay --battle <battleId>`（请直接 `POST /api/v1/admin/:op` 或走 HTTP）。

## 8. 日志

| 主题 | 说明 |
|---|---|
| 级别 | `silent/fatal/error/warn/info/debug/trace`（`DL_LOG_LEVEL` 或运行时 `POST /api/v1/log-level`） |
| 通道 | `rng field effects items roles skills bullets engine damage ai.ast ai.runtime unlock api cli ranked store view render editor perf log`（**`store` 已生效**（P7/B27–B33：`store.*` 事件由 `server/store/*` 产生）；`view`/`render`/`editor`/`perf` 属 P6 计划，当前无生产调用者） |
| HTTP 层事件 | 每个请求：`api.req`(info) → 处理 → `api.res`(info，含耗时与字节) / `api.err`(error) / `api.reject`(warn，业务拒绝带原因码) |
| 输出 | ≥`info` 写 stdout（`main()` 的 sink）；`debug/trace` 默认只入环形缓冲（N=2000，`dump()` 可导出） |
| 请求体上限 | POST 1MB（**超限 → `413 payload_too_large`**，见 `readBody`） |
| 全局限速 | **600 次/分/principal**（`service-config.auth.rateLimitPerMinute` 之外的全局限速；进程内滑动窗口，按 `playerId`，未登录按 IP；命中 → `429 rate_limited`，P7-4 中间件真实产生） |

> **2026-09-16 复核**：`DL_LOG_CHANNELS` **未接线**（`shared/log.js` 无生产调用者读取该变量）；通道级覆盖当前只能经 `POST /api/v1/log-level` 的 `channels` 参数生效（见 §2）。

## 9. 数据表与资源

`GET /api/v1/data/:table` 覆盖 `server/data/*.json` + `assets/*.json`：

```
✅ 现状（2026-09-19 复核 server/data 目录）：
battle-config  items-config  plugins  qualities  role-templates  skill-templates  unlock
skill-mechanics  affix-registry  ai-nodes
service-config（槽位/会话/保留期/限速/缓存上限）  rating-config（D-133 积分与匹配参数）   （+ assets: sprites/animations）
```

- 全部表由 `server/data/schema.js` 校验（T-DC-1/2，`npm run gate` 第 4/5 项）。**`service-config.json` / `rating-config.json` 已落地**：表为数值单一来源、代码默认值兜底（`server/store/config.js`）、schema 冻结值 + 跨字段不变量校验、**缺表必 FAIL**；契约见 `server/data/README.md`。
- 战斗数值**全部**在 `battle-config.json`（L9，禁止硬编码；`checkNumericHardcode` 门禁检查）。
- **`server/data/` 只放只读数据表**：门禁项 4/5 会遍历该目录，运行时档案**必须**写在数据目录之外（`DL_DATA_DIR`，默认 `runtime/`），否则门禁失败。

### 9.1 运行时数据目录（✅ 现状，2026-09-19）

> `runtime/` 由运行时生成、**已 `.gitignore`**；`DL_DATA_DIR` 可改。测试经 `DL_DATA_DIR` 指向 `os.tmpdir()` 临时目录（`tests/helpers/store.js`）。

```
runtime/
├── lock                          # 单进程锁（存在且 PID 存活 → 第二个进程拒绝启动）
├── index.json                    # 匹配/排行榜索引（~200 B/玩家，可重建；运行期"标脏 + 微任务合并落盘"）
├── sessions.json                 # 会话表（可丢弃；丢失=全员登出）
├── players/<shard>/<playerId>.json   # 物化档案（可重建；<shard> = pl_ 之后 2 hex）
├── snapshots/<aa>/<hash>.json    # 内容寻址快照库（不可变，回放重算依赖；磁盘名去掉 sha256: 前缀）
└── journal/
    ├── <yyyymm>.jsonl            # append-only 真源（跨玩家结算）
    └── <yyyymm>.checkpoint.json  # 聚合检查点（compact 后生成，替代被删段；精度降级）
```

- 备份点：直接快照整个 `runtime/`（建议停机或先 flush）；单进程锁 `runtime/lock` 防止两个进程写同一目录。
- 容量估算与"何时引入数据库"的判据见 `docs/systems/11-account-store.md` §11（实测：0.175~0.280 ms/场，索引 ~200 B/玩家；回放帧实测 61–268 KB/场）。

## 10. 测试与门禁

```bash
npm test        # node --test --test-isolation=none tests/**/*.test.js（沙箱下必须单进程）→ 2026-09-19 实测 942 通过 / 0 失败
npm run cov     # 同左 + 覆盖率阈值（core/ai/shared/cli：行≥90% 分支≥85% 函数≥90%）
npm run gate    # 单进程内联 9 项：静态/架构/schema/一致性/D 落点/日志规范/全量测试/日志冒烟/接口冒烟 → 2026-09-19 实测 9 PASS/0 FAIL/0 PEND
npm run check:docs       # 文档↔实现一致性 D1–D6（批次计数/勾选/审查记录）→ PASS
npm run e2e              # 联网全链路（22 检查点，进程内起服务 + 临时 DL_DATA_DIR）→ 22/22，exit 0
npm run load-test -- --players 50 --deep   # 批量真实玩家压测 + 7 条完整性断言 → 7/7
npm run demo | npm run play                # 离线可执行（demo=逐 tick 摘要；play=可玩闭环，见 README 命令表）
```
- 门禁失败只能修代码/修测试；禁止放宽阈值绕过（阈值调整属 `tasks.md` §10 变更控制）。
- **实跑数字以当次输出为准**（仓库处于多线并行时数字会变）；上列 2026-09-19 基线见 `docs/progress.md` §3.4 与各 `docs/reviews/BXX.md`。

## 11. 与前端 / 排位 / 快速对战 / 回放的关系

- **前端（P6，进行中：`F1` 已落地）**：`public/` 下为**零依赖双模模块**的文本界面（无框架，D-124），由 `server/index.js` 的**同源静态托管**提供（§3.1 末两行；仅 `GET`、扩展名白名单、穿越防护；`start({publicDir})` 为测试缝）。前端唯一数据来源 = 本文 §3 的端点与 `interfaces.md` §2（账号/配置槽/段位/积分/战绩/回放引用走 `GET /me` + `Authorization: Bearer` 鉴权）；仓库/开箱仍由前端持有（localStorage，D-130）。`F1` 覆盖 `/auth/register|login|logout|password` 与 `GET /me`，会话 token 存 `localStorage['dl.token']`；设计依据 `docs/frontend/01-auth.md`（规则总纲 `docs/frontend/00-rules.md`），审查与走查记录 `docs/reviews/F1.md`。**旧前端设计已于 2026-09-20 全量作废并删除**（含 `frontend-spec.md`/`screens.md`/自检器/样本），其余屏幕需按新规则重新设计。
- **排位（✅ 服务端权威，P5 → P7/B31 已改造）**：`POST /ranked/run` 有 token → 服务端抽池 + 双向记账（D-132）、晋升在批次内落盘；无 token → 遗留无状态口径（`DL_LEGACY_STATELESS=1` 默认）；`=0` → 401。`POST /ranked/promote` 读档案、只判定不落盘。池不足如实回报 `shortfall`（**禁止 bot 充数**，D-152）。
- **快速对战（✅ 已实现，P7/B32）**：`POST /quick/run` 按积分窗口递进匹配 + 非对称 Elo 双向结算（D-133），响应含双方 `pointsBefore/After/delta`；无候选 → `409 no_opponent`。
- **回放（✅ P4 已实现 + P7/B33 增强）**：`POST /battle` 生成的帧由 HTTP 层按 `replayCacheSize`（默认 64）LRU 管理，归档回放（`b_` 型）按需重算（D-135）；参与者鉴权（403 `replay_forbidden`）、版本/快照/LRU 失效（410 `replay_expired`）、`?trace=self` 裁剪 `aiTrace`；前端渲染层只消费帧，不重算。