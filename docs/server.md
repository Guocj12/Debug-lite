# Debug-Lite v3 服务器文档

> 版本：v1　创建：2026-09-12　更新基线：**2026-09-22 复核（后端 P0–P5 共 34 批 + P7/B27–B33 共 7 批 + F3 后端契约 ①（`D-159`…`D-162`，非编号批次）已收口；`npm run check:docs` PASS。历史基线：2026-09-19 复核 `npm test` = 942 通过 / 0 失败；`npm run gate` = 9 PASS / 0 FAIL / 0 PEND）**
> 定位：**部署、配置、端点速查与使用说明**。接口契约的唯一权威是 `docs/interfaces.md`（ICD v1 §2/§3）；本文与之一致，冲突时以 interfaces.md 为准。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md`。
> **阅读约定（2026-09-19 起）**：正文中凡标 **✅ 现状** 的，是已实测可用能力；凡标 **⏳ 计划中** 的，是设计已定但**代码 0 行**，不得按可用能力使用。**P7（B27–B33：服务端档案 / 鉴权 / 排位改造 / 快速对战 / 回放鉴权）已于 2026-09-19 收口，本文中凡旧标注「计划中（P7/B27–B33）」的段落均已按实测改为「现状」**；唯一保留的 ⏳ 是**遗留无状态端点在生产关闭**（`DL_LEGACY_STATELESS=0`）与 SQLite 适配器（§11.4）。
> **F3 后端契约（2026-09-22，`D-159`…`D-162`）**：**仓库/物品/装配改为服务端权威**（推翻 `D-130` 的"仓库由客户端 localStorage 持有"）、配置完整性校验时机改为「保存宽松 / 出战严格」、新增 AI 库后端、开箱随机性收归服务端。**本次未新增批次号**（F3 不是编号批次，见 `docs/frontend/00-rules.md` FR-6）；正文改动处逐处标注 `D-159`…`D-162`。
> **D-163 热修（2026-09-25）**：出战配置的物品**按 uid 从服务端仓库解析**（客户端数值一律丢弃、未知 uid → 409 `物品不在仓库`）、同一份配置内全 uid 唯一、**一件物品同时只能属于一份配置**（409 `item_in_use`）、HTTP 配置路由不再采纳客户端 `warehouse` 镜像、开箱发放的撞车 uid 重映射（响应 = journal = 档案）+ 丢弃可审计。**收口实测**：`npm test` = **1058 通过 / 0 失败**（两轮）；`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**（digest `a1c5b11c0092`）；`npm run e2e` = **22/22（exit 0）**；`npm run play` = **exit 0**；`load-test --players 20 --deep` = **ok=true（7/7 完整性断言）**；`check-docs` = PASS（批次仍 41）/ `check-arch` = PASS（40 文件）。

---

## 1. 运行要求与启动

| 项 | 要求 |
|---|---|
| Node | `>= 24.18.0`（`package.json engines`） |
| 依赖 | **零运行时依赖**：HTTP 层用 `node:http`，`package.json` **无 `dependencies`**（2026-09-16 复核）。`express` 仅作为白名单存在，**从未引入** |
| 启动 | `npm start`（= `node server/index.js`） |
| 默认监听 | `http://127.0.0.1:3000` |
| 目录 | `server/`（HTTP 层 `index.js` + 编排层 `runner.js`/`box.js`/`loadout.js`/`battle.js`/`ranked.js` + **P7 身份与档案层 `auth.js`/`account.js`/`quickmatch.js`/`admin.js`** + **存储层 `store/`（唯一允许 `node:fs`）** + `core/` 确定性内核 + `ai/` 解释器 + `data/` 只读数据表）；运行时数据在 `DL_DATA_DIR`（默认 `<repo>/runtime`，非 `server/`） |

**进程模型（✅ 现状，2026-09-22 复核）**：**单进程 + 服务端权威档案与仓库**（D-129 + **D-159**）。段位/积分/配置槽/战绩/未读游标/会话落盘于运行时数据根 `DL_DATA_DIR`（默认 `<repo>/runtime`）；**仓库与物品也由服务端权威**（**D-159 推翻 D-130 的"仓库/物品/装配由客户端 localStorage 持有"**）——档案新增 `warehouse` 段（四桶 `role`/`skill`/`rolePlugin`/`skillPlugin`，**每桶上限 500**）与 `ai` 段（AI 库，上限 100），`GET /api/v1/me/warehouse` 是**唯一真源**，装配/拆卸走服务端端点（`/me/warehouse/assemble|disassemble`）并落 journal 增量记录；服务端另存**出战快照副本**（供他人匹配与回放重算），快照自带的"装配引用子集"（`warehouseExcerpt`，缺口 1 时代产物）**保留但不再是必需来源**，且 **D-163 起 HTTP 保存路径不再写入**（只有服务端内部传仓库的注册 starter 路径会带）。`server/store/*`（唯一允许 `node:fs` 的目录）、`server/auth.js`、`server/account.js`、`server/quickmatch.js`、`server/admin.js` 均已实现并接线；`runtime/` 目录已存在（运行时生成，已 `.gitignore`）。旧的"所有玩家状态只存在于请求/响应中、无持久化"**无状态语义只保留在遗留路径**（`DL_LEGACY_STATELESS=1`，见 §2/§3）；回放帧另有进程内 LRU（默认 64）+ 归档按需重算（§6.2）。

- **注册即发 starter（✅ 现状 2026-09-22，D-159）**：`POST /auth/register` 建号时由新文件 `server/starter.js` 生成新手套装——种子 = `sha256('starter|publicId|playerId')` 前 8 hex（**同身份内容级可复现**：模板/品质/数值/槽类型/插件/槽下标逐值相同；物品 `uid` 由 `core/items` 的进程内计数器分配，**不参与内容级比较**）；生成 1 角色（`role_bal`，`common`，**必带 ≥1 插槽**）+ 3 技能（`skill_melee_whirl`/`skill_straight_precise`，**重掷至至少 1 个技能有槽**，上限 20 次）+ 1~2 角色插件 + 1 技能插件，**全部按实际槽类型筛池并已装配**；写入**服务端仓库**，配置写进 `slot1`（默认配置、出战、并登记库内默认 AI `name='新手AI'`，其 `aiId` 写入 `slot1.loadout.aiId`）；**同时建满 3 个槽**（`slot2`/`slot3` 为空槽、无快照）。新号 `flags.unverifiedLoadout=false`。**老账号保持空仓**——`migrateV1toV2` 只补**空**仓库（不补发 starter），需删号重注册才拿到新手套装。
- **落盘开关口径（实测）**：`start()` **缺省不落盘**——只有传了 `dataDir`/`enableStore:true`/环境变量 `DL_DATA_DIR` 才打开 store；`npm start`（= `main()`）显式 `enableStore: true`，`dataDir` 缺省解析为 `<repo>/runtime`。测试经 `DL_DATA_DIR` 指向临时目录（`tests/helpers/store.js`）。
- **单进程锁 `runtime/lock`**：存在且 PID 存活 → 第二个进程拒绝启动（§9.1）。

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

> **不在环境变量里的配置（D-159/D-161）**：仓库与 AI 库的容量上限**不是 env**，而是数据表 `server/data/service-config.json` 的冻结值——`warehouse:{maxPerBucket:500}`（四桶各自上限，`GET /me/warehouse` 的 `caps` 即由它派生）与 `ai:{maxPerPlayer:100}`（AI 库条目上限，`GET /me/ai` 的 `max`）。二者由 `server/data/schema.js` 的 `SERVICE_CONFIG_FROZEN` 冻结值 + 跨字段校验把关，`server/store/config.js` 以同值默认并做超表兜底（缺表必 FAIL，见 §9）。
> **实例级注入缝（D-162，不是环境变量）**：`start({boxSeed})` 为**开箱 seed** 提供确定性序列（第 n 次开箱 = `boxSeed + n − 1`，回绕到合法区间），仅供测试/e2e/压测；生产不传该参数（seed 一律服务端生成）。同风格的注入缝还有 `start({replayLimit})`/`start({publicDir})`。CLI `box` 自 D-162 起**不接受 `--seed`**（给了即参数错误 exit 2，见 §7）。

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
| POST | `/api/v1/box` | **遗留无状态**开箱（tier/times；品质上限 D-122 + 掉落池门控；**D-162 起无 `seed` 入参**，客户端传了被静默忽略；**物品不入档**） | 400 `bad_times` / 409 `tier_locked` | B17 / **D-162** |
| GET | `/api/v1/warehouse` | 仓库规范骨架（`emptyWarehouse`）——**遗留无状态**（入参自带整仓，服务端不落账；真源见 §3.3） | — | B18 |
| POST | `/api/v1/warehouse/assemble` | 装配（原子性，失败状态不变）——**遗留无状态**（`D-159` 起服务端权威路径为 `/me/warehouse/assemble`） | 409 `slot_type_mismatch`/`points_exceeded`/`slot_occupied`/`tier_locked`/`plugin_equipped`/`item_missing` | B18 |
| POST | `/api/v1/warehouse/disassemble` | 拆卸——**遗留无状态**（`D-159` 起服务端权威路径为 `/me/warehouse/disassemble`） | 404 `slot_empty`/`plugin_missing` | B18 |
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
| POST | `/api/v1/auth/register` | 注册（建账号 + 下发默认配置 + token；**D-159 起并发 starter：仓库/3 槽/AI 库**） | 400 `weak_password`/`bad_request`；409 `username_taken` | B28 / **D-159** |
| POST | `/api/v1/auth/login` | 登录发 token | 401 `invalid_credentials`；429 `too_many_attempts` | B28 |
| POST | `/api/v1/auth/logout` | 撤销当前会话 | 401 `unauthorized` | B28 |
| POST | `/api/v1/auth/password` | 改密（撤销其他会话）；**别名** `/auth/change-password` ≡ 本行 | 401；400 `weak_password` | B28 |
| GET | `/api/v1/me` | 档案摘要（段位/积分/未读/槽位） | 401 | B29 |
| GET | `/api/v1/me/configs` | 3 套配置全文 | 401 | B29 |
| POST | `/api/v1/me/configs` | 新建槽（**D-160 起建空槽**，不再复制出战配置） | 401；409 `slot_limit` | B29 / **D-160** |
| PUT | `/api/v1/me/configs/:slotId` | 保存配置（**D-160**：非出战槽允许不完整 → 200 `snapshot:null`/`complete:false`/`missing:[…]`；出战槽要求完整 → 否则 409 `loadout_invalid` 逐位置 details。**D-163**：物品按 uid 从**服务端仓库**解析（客户端数值丢弃、未知 uid → `物品不在仓库`）、同配置内 uid 唯一、**一件物品只属于一份配置**；请求里的 `warehouse` 镜像不再被采纳） | 401；400；409 `loadout_invalid`/`config_conflict`/`item_in_use` | B29 / **D-160 + D-163** |
| POST | `/api/v1/me/configs/:slotId/activate` | 设为出战配置（**D-160**：此时才校验完整性 → 不完整 409 `cannot_activate_incomplete`；完整但缺快照会**自愈冻结**，不再 `no_active_config`。**D-163**：再判一次跨配置独占 → 409 `item_in_use`） | 401；404 `slot_not_found`；409 `cannot_activate_incomplete`/`loadout_invalid`/`item_in_use` | B29 / **D-160 + D-163** |
| DELETE | `/api/v1/me/configs/:slotId` | 删除槽（默认/出战槽禁止） | 401；409 `slot_locked` | B29 |
| PUT | `/api/v1/me/nickname` | 改昵称（`nicknameMax` 夹到 ≤16） | 400 `bad_request`；401 | B29 |
| PUT | `/api/v1/me/warehouse` | **D-159 退役**为"只校验形状"的遗留镜像：形状非法仍 400；引用不覆盖出战配置**不再 409**，改 200 + `verified:false`；正文只进进程内缓存、不落盘 | 400 `bad_request`；401 | B29 / **D-159** |
| GET | `/api/v1/me/warehouse` | **D-159 真源**：服务端仓库全文（`buckets`/`usage`/`caps`/`counts`/`starterIssued`）；旧契约的"未提交镜像 → 404 `warehouse_missing`"作废 | 401 | B29 / **D-159** |
| GET | `/api/v1/me/records` | 战绩（`?since=&limit=&role=`）→ `records/since/latestSeq/limit/role/unread/maxSeq` | 400 `bad_request`；401 | B30 |
| POST | `/api/v1/me/records/seen` | 推进未读游标（**唯一入口**）；**别名** `/me/seen` ≡ 本行 | 400；401 | B30 |
| GET | `/api/v1/me/defense` | **防守战绩**（被抽场次/胜负/最近列表） | 401 | B30 |
| POST | `/api/v1/quick/run` | 快速对战（积分相近 + 非对称 Elo 双向结算） | 400 `bad_seed`；401；403 `banned`；409 `no_opponent`/`no_active_config`/`store_not_found` | B32 |
| GET | `/api/v1/leaderboard` | 排行榜（`?scope=global\|tier:<t>&limit=`；不回 `playerId`） | 400 `bad_scope` | B30/B32 |
| POST | `/api/v1/admin/:op` | 运维（单动态路由）：`bots`/`rebuild-index`/`stats`/`clear-bots`/`ban`/`unban` + **F2 新增** `accounts`（分页全量账号列表 `{offset,limit}` → `{total,offset,limit,hasMore,rows[]}`；**total 无 100 条上限**）与 `delete-account`（按 `playerId`/`publicId` 删除，写 `player.removed` 墓碑，禁删自己）。**授权（D-158）**：管理员账号（`DL_ADMIN_USERS`，Bearer）**或** `X-Admin-Token`/Bearer == `DL_ADMIN_TOKEN`。**`bots` 的两处修复（D-165/D-166）**：注入时写入**真实（合成）仓库**（否则该 bot 参与的对局**回放 100% 410**），且每个 bot **按自身 `botKey` 派生不同预设**（修前整批共用同一程序 ⇒ 互打恒平局），可选 `preset`（`steady`/`aggressive`/`kite`，非法 → 400，响应回带 `preset`） | 400 `bad_request`；401/403 `forbidden`；403 `debug_bots_disabled`；404 `store_not_found`/`unknown_endpoint`；409 `cannot_delete_self`；503 `admin_token_missing` | B33 / **F2** / D-165 / D-166 |

> `PUT /me/configs/:slotId`、`PUT /me/nickname`、`PUT /me/warehouse`、`DELETE /me/configs/:slotId`、`POST /me/configs/:slotId/activate` 注册在 `server/index.js` 的 PUT/DELETE 路由表中（其余为 GET/POST）。

### 3.3 仓库 / 开箱 / AI 库（`D-159`…`D-162`，**✅ 已实现（2026-09-22，F3 后端契约 ①）**）

> 本组端点在 `server/index.js` 注册并有 `tests/api` 覆盖（`api-me-warehouse.test.js` 6 / `api-me-box.test.js` 5 / `api-me-ai.test.js` 6 / `api-configs-incomplete.test.js` 6 用例）；字段级契约见 `docs/interfaces.md` §2 与 `docs/frontend/03-hub-warehouse-loadout.md` §5/§6。**本次未新增批次号**（F3 非编号批次）。

| 方法 | 路径 | 用途 | 主要错误码 | 依据 |
|---|---|---|---|---|
| GET | `/api/v1/me/warehouse` | **仓库真源**：`{buckets, usage, caps, counts, starterIssued}`（`usage[uid].slotIds[]` = 该物品被**哪一份**出战配置引用；**D-163 起至多一项**——一件物品同时只能属于一份配置） | 401 | `D-159`/`D-163` |
| POST | `/api/v1/me/warehouse/assemble` | 装配（**服务端态**：体 `{targetUid, pluginUid, slotIndex}`，**不再传整仓**）；校验由 `core/items` 纯函数**单点完成**，落 journal 增量记录 `warehouse.assemble` | 401；409 `slot_type_mismatch`/`slot_occupied`/`points_exceeded`/`plugin_equipped`/`item_missing`/`tier_locked` | `D-159` |
| POST | `/api/v1/me/warehouse/disassemble` | 拆卸（体 `{targetUid, slotIndex}`）；落 journal 增量记录 `warehouse.disassemble` | 401；404 `slot_empty`/`plugin_missing` | `D-159` |
| POST | `/api/v1/me/box` | **服务端权威开箱**：体 `{tier?, times?}` → 物品**直接入档**，回带 `{seed, tier, times, items, counts, caps, grantId}`；任一桶超限 → 409 `warehouse_full` 且**不入档**（上限前置校验，不写 journal）；**无 `seed` 入参**（客户端传了**静默忽略**，不再有 `bad_seed`）；**D-163**：发放 uid 若与该仓库已有物品撞车，写记录前重映射（响应 = journal = 档案） | 400 `bad_times`；401；409 `tier_locked`/`warehouse_full` | `D-159`/`D-162`/`D-163` |
| GET | `/api/v1/me/ai` | **AI 库列表**：`{items:[{aiId,name,program,createdAt,updatedAt}], count, max:100, usage}`（`usage: aiId → [slotId]`） | 401 | `D-161` |
| POST | `/api/v1/me/ai` | 命名保存 AI：体 `{name, program}`（名称 1~24 字符；`program.type='program'`）→ 200 `{aiId, ai, count, max}`；**上限 100 与物品分别计数** | 400 `bad_request`；401；409 `ai_limit` | `D-161` |
| DELETE | `/api/v1/me/ai/:aiId` | 删除库内 AI → 200 `{deleted, referencedBy, count, max}`；**被「出战配置」引用 → 409 `ai_in_use`**（非出战配置的引用只在 `referencedBy` 里提示，不阻止删除） | 401；409 `ai_in_use` | `D-161` |

> **术语澄清（`D-159` / `D-163`）**：`usage` 统计**全部配置**对物品的引用（`slotIds`；D-163 起**至多一项**——一件物品同时只能属于一份配置）；`counts` 是四桶件数（等价于 `buckets.*.length`）；`caps` 是四桶各自上限（均 `500`，来自 `service-config.json`）。
> **配置保存/激活的物品解析（`D-163`，2026-09-25 热修）**：`PUT/POST /me/configs*` 与 `activate` 一律按 `uid` 从**服务端仓库**取回物品（客户端正文里的 `stats`/`templateId`/`quality`/`params` **丢弃**；uid 不在仓库 → 409 `loadout_invalid` `物品不在仓库: <uid>`）；同一份配置内 角色/3 技能/全部插件引用的 uid 必须唯一；一件物品**只能属于一份配置**（撞车 → 409 **`item_in_use`**）。请求里携带的 `warehouse` 镜像**不再被采纳**（修前它是解析来源 ⇒ 客户端自带 buff 物品即可绕过"服务端权威"）。非出战槽仍可不完整，但只容忍"缺失类"错误，引用类错误一律拒绝。
> **开箱发放的 uid 分配（`D-163`）**：物品 uid 由 `core/items.js` 的**进程级**计数器生成，进程重启后归零 ⇒ 跨重启发放可能与该仓库已有物品撞 uid。`store.grantBox` 在**写 journal 之前**把撞车 uid 重映射为仓库内空闲 uid（`archive.allocateGrantUids`），因此响应 `items[].uid` = journal 记录 = 档案；闸门处若仍撞车，记 `error` 日志（`store.warehouse.uid_collision`）并把差额写进 `grantIds.dropped`（可审计），**不再静默丢弃**。
> **`grantId`（`D-162`）**：`POST /me/box` 回带的 `grantId = bx_<sha256[0..16]>`；幂等靠档案内 `warehouse.grantIds` 环形窗口 **256**——重复提交同一 `grantId` 不会重复入档。

## 4. 统一信封与错误码

**成功**：`{ok:true, data, log:{level, events:[]}}`（`events` 字段为日志摘要占位，当前恒为空数组）。

**失败**：`{ok:false, error:{code, message, details}}`（`details` 为数组，AI 校验时为逐条 `{path,code,message}`）。

HTTP 状态语义（**✅ 现状，P7-4 已扩展并实测**）：`400` 参数/请求体错误 ｜ `401` 未鉴权（缺/失效会话） ｜ `403` 越权/封禁/非参与者 ｜ `404` 资源不存在（端点/表/槽位/回放/**拆卸空槽或悬挂引用**） ｜ `409` 业务拒绝（门控/点数/校验/冲突/槽位/匹配/**仓库满/AI 库满/出战不完整**） ｜ `410` 已失效（回放过期 / 遗留端点被 `DL_LEGACY_STATELESS=0` 关闭） ｜ `413` 请求体过大 ｜ `429` 全局限速 / 登录锁定 ｜ `500` 内部异常（同时记 `api.err`） ｜ `503` 存储未装配 / 管理端未配置。

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
| `bad_seed` | `seed` 非合法正整数（`/ai/battle`、`/battle`、`/ranked/run`；**D-162 起 `/box` 与 `/me/box` 已无 `seed` 入参，不再产生该码**） | `server/runner.js`、`battle.js`、`ranked.js` |
| `bad_times` | `/box` 与 `/me/box` 的 `times` 不在 `1..BOX_TIMES_MAX`（`BOX_TIMES_MAX = 100`） | `server/box.js` |
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
| `no_active_config` | 409 | 出战配置或快照缺失（不变量破损）。**D-160 起 `POST /me/configs/:slotId/activate` 不再产生该码**（完整但缺快照会**自愈冻结**） | `server/account.js` |
| `warehouse_full` | 409 | **D-159/D-162**：开箱会使某桶超过上限（默认 500）→ 拒绝且**不入档**（上限前置校验，不写 journal） | `server/store/adapter-json.js` |
| `cannot_activate_incomplete` | 409 | **D-160**：设为出战时配置不完整（角色 + 恰 3 技能 + AI；`details` 逐位置） | `server/store/adapter-json.js` |
| `ai_limit` | 409 | **D-161**：AI 库已满（默认 100，**与物品分别计数**） | `server/store/adapter-json.js` |
| `ai_in_use` | 409 | **D-161**：删除被**出战配置**引用的 AI（非出战配置的引用只在 `referencedBy` 提示） | `server/store/adapter-json.js` |
| `item_missing` / `slot_type_mismatch` / `slot_occupied` / `points_exceeded` / `plugin_equipped` | 409 | **D-159**：服务端权威装配的五类拒绝（不存在 / 类型不符或槽位不可用 / 槽已占用 / 角色插件点数不足 / 插件已装配别处），由 `core/items` 纯函数单点判定 | `server/core/items.js`（→ `server/account.js`） |
| `item_in_use` | 409 | **D-163**：该物品已被**另一份配置**引用（一件物品同时只能装配到一份配置）；`details[].path` = 物品 uid，`message` 写明占用它的 slotId | `server/account.js`（`exclusivityDetails`，判据 = `archive.warehouseUsage`） |
| `slot_empty` / `plugin_missing` | 404 | **D-159**：拆卸时空槽 / 悬挂引用 | `server/core/items.js`（→ `server/account.js`） |
| `no_opponent` | 409 | **快速对战**匹配不到对手（候选不足/窗口用尽；排位池不足用 `shortfall` 字段） | `server/quickmatch.js` |
| `username_taken` | 409 | 用户名已存在（大小写不敏感） | `server/auth.js` |
| `already_max` | 409 | 已在最高段位 | `server/ranked.js` |
| `too_many_attempts` | 429 | 登录失败锁定（5 次/5 分钟） | `server/auth.js` |
| `rate_limited` | 429 | 全局限速命中（600 次/分/principal，进程内滑动窗口） | `server/index.js` |
| `payload_too_large` | 413 | 请求体超 1MB（**原为 500 `internal_error`**） | `server/index.js`（`readBody`） |
| `deprecated` | 410 | 遗留无状态端点被 `DL_LEGACY_STATELESS=0` 关闭 | `server/index.js` |
| `replay_expired` | 410 | 帧 LRU 淘汰 / 引擎或数据版本不匹配 / 快照不可用 | `server/index.js` |
| `warehouse_missing` | 404 | ~~`GET /me/warehouse`：本进程无该玩家的仓库镜像~~ **D-159 起作废**（`GET /me/warehouse` 改为读服务端真源，不再有"未提交镜像 → 404"这一路径） | `server/account.js` |
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

### `POST /api/v1/box`（请求 `{"tier":"rare","times":3}`；D-162：**无 `seed` 入参**）

```jsonc
// 200：data 含 items 数组与**服务端生成**并回带的 seed（遗留路径：物品不入档）
{ "ok": true, "data": { "seed": 1, "tier": "rare", "items": [ { "uid": "…", "kind": "role", … } ] }, … }
// 409（门控后掉落池为空）
{ "ok": false, "error": { "code": "tier_locked", "message": "…" } }
// 客户端传了 seed → **被静默忽略**（不再有 400 bad_seed）
```

### `POST /api/v1/me/box`（请求 `{"tier":"rare","times":3}`；D-159/D-162 服务端权威）

```jsonc
// 200：物品直接入档，回带 counts/caps/grantId（grantId 幂等靠 warehouse.grantIds 环形窗口 256）
{ "ok": true, "data": { "seed": 12345, "tier": "rare", "times": 3, "items": [ … ],
                        "counts": { "role": 4, "skill": 5, "rolePlugin": 2, "skillPlugin": 2 },
                        "caps": { "role": 500, "skill": 500, "rolePlugin": 500, "skillPlugin": 500 },
                        "grantId": "bx_0123456789abcdef" }, … }
// 409：{ "ok": false, "error": { "code": "warehouse_full", "message": "仓库已满，无法开箱（请先清理）" } } —— 不入档
```

### `GET /api/v1/me/warehouse`（D-159 真源）与 `POST /api/v1/me/warehouse/assemble|disassemble`

```jsonc
// GET 200：buckets 为四桶全文；usage[uid].slotIds 列出该物品被哪些出战配置引用（可多处）
{ "ok": true, "data": { "buckets": { "role": [ … ], "skill": [ … ], "rolePlugin": [ … ], "skillPlugin": [ … ] },
                        "usage": { "<uid>": { "slotIds": ["slot1"] } },
                        "caps": { "role": 500, "skill": 500, "rolePlugin": 500, "skillPlugin": 500 },
                        "counts": { "role": 1, "skill": 3, "rolePlugin": 2, "skillPlugin": 1 },
                        "starterIssued": true }, … }
// POST /me/warehouse/assemble（体 {targetUid, pluginUid, slotIndex}；**不再传整仓**）
{ "ok": true, "data": { "warehouse": { "buckets": { … } }, "usage": { … }, "counts": { … }, "caps": { … } }, … }
// 409：{ "ok": false, "error": { "code": "points_exceeded", "message": "角色插件点数不足" } }
// POST /me/warehouse/disassemble（体 {targetUid, slotIndex}）→ 同上形状；空槽/悬挂引用 → 404 slot_empty / plugin_missing
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
- **服务端权威（D-159 起新增）**：**仓库、物品、装配、开箱**也落盘于 `DL_DATA_DIR`——档案含 `warehouse` 段（四桶 `role`/`skill`/`rolePlugin`/`skillPlugin`，**每桶上限 500**，上限值来自 `service-config.json` 的 `warehouse.maxPerBucket`）与 `ai` 段（AI 库，上限 `ai.maxPerPlayer=100`）；`GET /api/v1/me/warehouse` 是**唯一真源**，装配/拆卸走 `/me/warehouse/assemble|disassemble`（**服务端态**：只传 `targetUid`/`pluginUid`/`slotIndex`），开箱走 `POST /me/box`（物品直接入档）。**D-159 推翻 D-130 的"仓库/物品/装配由客户端 localStorage 持有"**。服务端另存**出战快照副本**（供他人匹配与回放重算）；快照正文里那个"该配置实际引用到的插件项"的可选字段（装配引用子集，有界、非整仓；`server/store/archive.js` 的 `warehouseExcerpt`）**D-163 起在 HTTP 保存路径上不再写入**（配置路由不再把客户端 `warehouse` 传下去，只传解析自服务端仓库的正文）——只有**服务端内部传仓库**的路径（如注册 starter）才会带上；该字段在任何路径上都**不再是必需来源**（`loadWarehouse` 首选服务端仓库，不覆盖才回落账号级镜像/进程内缓存/它）。
- **档案版本与迁移（D-159）**：`ARCHIVE_VERSION` **1 → 2**；`migrateV1toV2` 为存量档案补**空**仓库（**老账号保持空仓**，需删号重注册才拿到新手套装）。
- **跨玩家一致性**：一场对局涉及双方档案；先 append `journal`（一次落盘即视为对局成立）再 apply 到双方档案，崩溃可重放修复（D-134）。**每档案 `appliedSeq` ≠ 全局 `index.seq`**（只有走 journal 的写推进前者；`touchLastSeen`/未读游标等纯 A 类写不动水位）。
- **段位/积分双轨**：段位来自排位批次（D-122，x=6）；积分来自快速对战（D-133 非对称 Elo，从 0 起、上限 3000）。二者互不推导。
- **防守方语义**：被抽为对手的玩家**不需要在线**；只记战绩（`stats.defense`）与未读红点，段位与积分不变（D-132）。
- **回放（D-135）**：`battle.recorded` 只存 `battleId/seed/双方快照 hash/版本戳`，帧不落盘、按需重算；版本不匹配/快照不可用/帧 LRU 淘汰 → `410 replay_expired`；进程内帧缓存上限 **64 场**；非参与者 → `403 replay_forbidden`；`?trace=self` 按请求者 side 裁剪 `aiTrace`。
- **journal（D-134 + D-159/D-162 扩充）**：记录类型含 `battle.recorded`/`ranked.*`/`account.*` 与**新一轮的状态量记录**——`box.opened`（含 `grantId = bx_<sha256[0..16]>`，幂等靠档案内 `warehouse.grantIds` 环形窗口 **256**）、`warehouse.assemble`/`warehouse.disassemble`（增量：目标 uid + 槽位下标 + 插件 uid）、`ai.created`/`ai.deleted`；`account.created` 现可携带 `warehouse` / `slots`（多槽）/ `aiLibrary`。
  - **压缩策略（D-159/D-162）**：含上述"状态量"记录的 journal 段**不参与 compact**（`server/store/archive.js` 的 `NON_COMPACTABLE`），跳过时记日志 `store.journal.compact.skip`——**真源始终留在 journal**；检查点里额外物化 `warehouse`/`ai` **只作降级兜底**。
- **容量口径**：单场战斗 0.175~0.280 ms/场、索引 ~200 B/玩家；回放帧**实测 61–268 KB/场**（17–63 tick，≈2.7–3.5 KB/帧；旧口径"7–20.5 KB"偏小约一个数量级，2026-09-16 已修正，见 `docs/progress.md` §0）。

### 6.2 ✅ 仍然有效的语义（D-130 遗留范围，**已按 D-159/D-162 修订**）

- **开箱随机性（D-162 修订 T-AP-5）**：**客户端不能指定 seed**——`POST /box` 与 `POST /me/box` 都**没有 `seed` 入参**，传了**静默忽略**（不再有 `bad_seed`）；seed 一律服务端生成并回带。HTTP 侧的确定性由**实例级注入缝 `start({boxSeed})`** 提供（第 n 次 = `boxSeed + n − 1`）；进程内 `server/box.js` 的 `openBoxes({seed})` **保留**（离线 `npm run play`/`demo`/核心单测不受影响）。CLI `box` **移除 `--seed`**（给了即参数错误 exit 2）。
- 物品 `uid` 语义（B17 登记）：进程内单调唯一（服务重启后重新计数），**不参与内容级比较**。
- **遗留无状态端点**：`box`/`warehouse*`/`loadout`/`panel`/`ai/*`/`battle` 默认保留（`DL_LEGACY_STATELESS=1`）；置 `0` 时这些端点返回 `410 deprecated`（`ranked/run|promote` 无 token 时改为 `401`）。**注（D-159/D-162）**：`POST /box` 与 `POST /warehouse/assemble|disassemble` 属遗留口径（**不入档**），前端只用服务端权威路径 `/me/box` 与 `/me/warehouse/*`。
- **作弊面结论（`D-163` 后更正）**：**段位与积分仍不具备竞技可信度**（`wins`/`pool` 等入参路径与遗留无状态端点仍在）；`11-account-store §15.1` 的"客户端权威仓库 → 改两行 JS 即可携带任意属性出战配置"这一具体作弊面，**`2026-09-22` 的"已随 `D-159` 关闭"其实不成立** —— 2026-09-25 实测：`PUT /me/configs/:slotId` 仍接受客户端提交的 `stats`（`hp=100000/atk=99999`）甚至**仓库里不存在的 uid**，`activate` 后快照冻结该正文，而 `quick/ranked` 用的正是 `snapshot.loadout`（`battle.buildPlayer` 直接读 `role.stats`）⇒ **真实对局可被打穿**。**`D-163` 已关闭该路径**（保存/激活按 uid 从服务端仓库解析、不采纳客户端镜像、`buildPanel` 有仓库时同样先解析）；登记册 `SEC-07` 已同步更正，另新增 `SEC-32`（开箱 uid 冲突静默丢件，已修）。**残余**：`POST /loadout` 与 `POST /panel` 是**无状态展示**端点，仍按客户端提交的 loadout + 镜像返回面板（不落账、不影响对局）。

## 7. CLI（唯一"操作台"，只走 HTTP）

```bash
npm run cli -- health | data <table> | box --tier common --times 10
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
- **D-162 更正**：CLI `box` **不接受 `--seed`**（给了即**参数错误 exit 2**，与 `bad_seed` 语义无关）；`seed` 由服务端生成并回带。离线可复现仍走 `npm run play`/`demo` 与核心单测（`server/box.js` 的 `openBoxes({seed})` 保留）。
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
✅ 现状（2026-09-22 复核 server/data 目录；**D-159/D-161 新增两组冻结值**）：
battle-config  items-config  plugins  qualities  role-templates  skill-templates  unlock
skill-mechanics  affix-registry  ai-nodes
service-config（槽位/会话/保留期/限速/缓存上限 + **`warehouse.maxPerBucket=500`** + **`ai.maxPerPlayer=100`**）  rating-config（D-133 积分与匹配参数）   （+ assets: sprites/animations）
```

- 全部表由 `server/data/schema.js` 校验（T-DC-1/2，`npm run gate` 第 4/5 项）。**`service-config.json` / `rating-config.json` 已落地**：表为数值单一来源、代码默认值兜底（`server/store/config.js`）、schema 冻结值 + 跨字段不变量校验、**缺表必 FAIL**；`D-159/D-161` 的 `warehouse:{maxPerBucket}` 与 `ai:{maxPerPlayer}` 已进 `SERVICE_CONFIG_FROZEN`（同值默认 + 超表兜底）；契约见 `server/data/README.md`。
- 战斗数值**全部**在 `battle-config.json`（L9，禁止硬编码；`checkNumericHardcode` 门禁检查）。
- **`server/data/` 只放只读数据表**：门禁项 4/5 会遍历该目录，运行时档案**必须**写在数据目录之外（`DL_DATA_DIR`，默认 `runtime/`），否则门禁失败。

### 9.1 运行时数据目录（✅ 现状，2026-09-22）

> `runtime/` 由运行时生成、**已 `.gitignore`**；`DL_DATA_DIR` 可改。测试经 `DL_DATA_DIR` 指向 `os.tmpdir()` 临时目录（`tests/helpers/store.js`）。

```
runtime/
├── lock                          # 单进程锁（存在且 PID 存活 → 第二个进程拒绝启动）
├── index.json                    # 匹配/排行榜索引（~200 B/玩家，可重建；运行期"标脏 + 微任务合并落盘"）
├── sessions.json                 # 会话表（可丢弃；丢失=全员登出）
├── players/<shard>/<playerId>.json   # 物化档案（可重建；<shard> = pl_ 之后 2 hex）
│                                 #   D-159 起含 warehouse（四桶 ≤500/桶 + grantIds 环形窗口 256）与 ai（AI 库 ≤100）
├── snapshots/<aa>/<hash>.json    # 内容寻址快照库（不可变，回放重算依赖；磁盘名去掉 sha256: 前缀）
└── journal/
    ├── <yyyymm>.jsonl            # append-only 真源（跨玩家结算 + D-159/D-162 状态量记录）
    └── <yyyymm>.checkpoint.json  # 聚合检查点（compact 后生成，替代被删段；精度降级；额外物化 warehouse/ai 只作兜底）
```

- **真源优先级（D-159）**：含状态量记录（`box.opened`/`warehouse.assemble`/`warehouse.disassemble`/`ai.created`/`ai.deleted`）的 journal 段**不参与 compact**（`NON_COMPACTABLE`，跳过时记 `store.journal.compact.skip`）——**真源始终在 journal**，检查点里的 `warehouse`/`ai` 只是降级兜底。
- 备份点：直接快照整个 `runtime/`（建议停机或先 flush）；单进程锁 `runtime/lock` 防止两个进程写同一目录。
- 容量估算与"何时引入数据库"的判据见 `docs/systems/11-account-store.md` §11（实测：0.175~0.280 ms/场，索引 ~200 B/玩家；回放帧实测 61–268 KB/场）。

## 10. 测试与门禁

```bash
npm test        # node --test --test-isolation=none tests/**/*.test.js（沙箱下必须单进程）→ 2026-09-19 实测 942 通过 / 0 失败
npm run cov     # 同左 + 覆盖率阈值（core/ai/shared/cli：行≥90% 分支≥85% 函数≥90%）
npm run gate    # 单进程内联 9 项：静态/架构/schema/一致性/D 落点/日志规范/全量测试/日志冒烟/接口冒烟 → 2026-09-19 实测 9 PASS/0 FAIL/0 PEND
npm run check:docs       # 文档↔实现一致性 D1–D6（批次计数/勾选/审查记录）→ 2026-09-22 实测 PASS（批次计数仍 41）
npm run e2e              # 联网全链路（22 检查点，进程内起服务 + 临时 DL_DATA_DIR）→ 22/22，exit 0
npm run load-test -- --players 50 --deep   # 批量真实玩家压测 + 7 条完整性断言 → 7/7
npm run demo | npm run play                # 离线可执行（demo=逐 tick 摘要；play=可玩闭环，见 README 命令表）
```
- **D-159…D-162 新增用例（2026-09-22）**：`tests/unit/starter.test.js`(7) + `tests/api/api-me-warehouse.test.js`(6) + `tests/api/api-me-box.test.js`(5) + `tests/api/api-me-ai.test.js`(6) + `tests/api/api-configs-incomplete.test.js`(6) = **30 条**；`tests/contract/store-contract.test.js` 的适配器方法清单新增 **6 个方法**（`getWarehouse`/`grantBox`/`applyWarehouseChange`/`listAi`/`createAi`/`deleteAi`）。`scripts/check-arch.js` 的 `LAYER_RULES` 新增 `starter` 到 **L6** 正则。
- 门禁失败只能修代码/修测试；禁止放宽阈值绕过（阈值调整属 `tasks.md` §10 变更控制）。
- **实跑数字以当次输出为准**（仓库处于多线并行时数字会变）；上列 2026-09-19 基线见 `docs/progress.md` §3.4 与各 `docs/reviews/BXX.md`。

## 11. 与前端 / 排位 / 快速对战 / 回放的关系

- **前端（P6，进行中：`F1`/`F2` 已落地，`F3` 后端契约 ① 已落地）**：`public/` 下为**零依赖双模模块**的文本界面（无框架，D-124），由 `server/index.js` 的**同源静态托管**提供（§3.1 末两行；仅 `GET`、扩展名白名单、穿越防护；`start({publicDir})` 为测试缝）。前端唯一数据来源 = 本文 §3 的端点与 `interfaces.md` §2（账号/配置槽/段位/积分/战绩/回放引用走 `GET /me` + `Authorization: Bearer` 鉴权）。**D-159 更正**：**仓库/物品/装配/开箱不再由前端 localStorage 持有**——改为 `GET /me/warehouse`（真源）+ `POST /me/warehouse/assemble|disassemble` + `POST /me/box`；`public/**` 的 F3 三屏与出战配置编辑器**本批只做后端**（前端三提交见 `docs/frontend/03-hub-warehouse-loadout.md` §14），**尚未实现**。`F1` 覆盖 `/auth/register|login|logout|password` 与 `GET /me`，会话 token 存 `localStorage['dl.token']`；设计依据 `docs/frontend/01-auth.md`（规则总纲 `docs/frontend/00-rules.md`），审查与走查记录 `docs/reviews/F1.md`。**旧前端设计已于 2026-09-20 全量作废并删除**（含 `frontend-spec.md`/`screens.md`/自检器/样本），其余屏幕需按新规则重新设计。
- **排位（✅ 服务端权威，P5 → P7/B31 已改造；D-159 起仓库亦服务端优先）**：`POST /ranked/run` 有 token → 服务端抽池 + 双向记账（D-132）、晋升在批次内落盘；无 token → 遗留无状态口径（`DL_LEGACY_STATELESS=1` 默认）；`=0` → 401。`POST /ranked/promote` 读档案、只判定不落盘。池不足如实回报 `shortfall`（**禁止 bot 充数**，D-152）。**取仓库口径（D-159）**：出战配置的引用校验与实例化**优先用服务端仓库**；`loadWarehouse` 首选服务端仓库，**不覆盖才回落**账号级镜像 / 进程内缓存 / 快照自带的装配引用子集。
- **快速对战（✅ 已实现，P7/B32；D-159 起仓库亦服务端优先）**：`POST /quick/run` 按积分窗口递进匹配 + 非对称 Elo 双向结算（D-133），响应含双方 `pointsBefore/After/delta`；无候选 → `409 no_opponent`；候选与发起者的可实例化判定同源（`ranked.sideInstantiable`），仓库来源同上条（**服务端仓库优先**）。
- **守方 AI 镜像（D-164，2026-09-25）**：**玩家编写的 AI 一律按 p1（左）帧书写**；p2 侧由服务端给镜像快照（`x→fieldPx−x`、`facing→−facing`、`displacement→−displacement`）并反镜像其方向动作（`move_left↔move_right`、`dodge_left↔dodge_right`；`turn`/`wait`/`defend`/`skill:*` 不映射）。唯一实现处 `server/runner.js`（`mirrorSnapshot`/`unmirrorAction`/`makeAiDriver`），`battle.js` 与 `ranked.js` 只调用；内置对手 `OPPONENTS` 与 `/ai/battle` 的 p2 不镜像。**帧与档案保留真实坐标**（`self.x` 仍是 0..1024 的真实值），`POST /battle` 的调用方若把 p2 程序按"右方视角"书写需改为 p1 帧（否则守方会朝自己基地走）。
- **回放（✅ P4 已实现 + P7/B33 增强；D-165 修 bot 对手 410；D-167 帧契约重构）**：`POST /battle` 生成的帧由 HTTP 层按 `replayCacheSize`（默认 64）LRU 管理，归档回放（`b_` 型）按需重算（D-135）；参与者鉴权（403 `replay_forbidden`）、版本/快照/LRU 失效（410 `replay_expired`）；前端渲染层只消费帧，不重算。**D-167**：帧=**画面数据 + 双方 `aiTrace`**（`?trace=*` 已废弃，永远双方都给——SEC-33 已接受风险），**不含引擎日志 `events`**（实测日志占 76–84% ⇒ 帧体量 92–219 KB → 10–21 KB/场）；需要日志用 **`GET /api/v1/replay/:id?frames=debug`**（管理员令牌；含 `events`、可越过参与者鉴权、每次记 `store.abuse.suspect` 审计）；**`POST /quick/run` 与 `POST /ranked/run` 的响应内联全量帧**（`data.frames` / `results[].frames`）。**仓库来源（D-165）**：重算时逐侧用 `loadWarehouse`（服务端权威仓库 → 账号镜像 → 进程内缓存 → 快照子集），其覆盖判据 = `loadout.warehouseResolves`（**与 `resolveItems` 同谓词**）；修前该判据只看插件引用，导致管理端注入的 bot（空仓库 + 无插件引用）**对局成立但回放 100% 410**（实测 10/10 场）。