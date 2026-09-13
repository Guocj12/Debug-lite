# Debug-Lite v3 服务器文档

> 版本：v1　创建：2026-09-12　更新基线：B20 已提交（dev 分支，gate 9 PASS/0 FAIL/0 PEND）
> 定位：**部署、配置、端点速查与使用说明**。接口契约的唯一权威是 `docs/interfaces.md`（ICD v1 §2/§3）；本文与之一致，冲突时以 interfaces.md 为准。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md`。

---

## 1. 运行要求与启动

| 项 | 要求 |
|---|---|
| Node | `>= 24.18.0`（`package.json engines`） |
| 依赖 | 运行时仅零依赖 `node:http`（白名单 `express` 未引入：与"测试/门禁零依赖"哲学一致；后续如需路由中间件可换 express，**接口不变**） |
| 启动 | `npm start`（= `node server/index.js`） |
| 默认监听 | `http://127.0.0.1:3000` |
| 目录 | `server/`（HTTP 层 `index.js` + 编排层 `runner.js`/`box.js`/`loadout.js` + `core/` 确定性内核 + `ai/` 解释器 + `data/` 数据表） |

**进程模型**：无状态、无持久化（D-123）。服务重启不丢任何数据——因为数据本就只在请求里（见 §6）。

## 2. 环境变量配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DL_PORT` | `3000` | 监听端口（`0` = 临时端口，测试/冒烟用） |
| `DL_HOST` | `127.0.0.1` | 监听地址 |
| `DL_LOG_LEVEL` | `debug`（非 production）/ `warn` | 全局日志级别（`silent/fatal/error/warn/info/debug/trace`） |
| `DL_LOG_CHANNELS` | 空 | 通道级覆盖，如 `bullets=trace,engine=debug` |

示例：`$env:DL_PORT=3456; $env:DL_LOG_LEVEL='trace'; npm start`

## 3. 端点总表（实现状态已核对 `server/index.js`）

### 3.1 已启用端点（✅）

| 方法 | 路径 | 用途 | 主要错误码 | 批次 |
|---|---|---|---|---|
| GET | `/api/v1/health` | 存活与版本 `{status:'ok', version}` | — | P0-8 |
| GET | `/api/v1/data/:table` | 取数据表（含 `battle-config` 与 `assets/*`） | 404 `unknown_table` / 400 `bad_table` | P0-8 |
| GET | `/api/v1/unlock?tier=` | 该段位可用节点/模板/技能 id | 400 `bad_tier` | B4 |
| GET/POST | `/api/v1/log-level` | 日志总控（GET 查询 / POST 切换） | 400 `bad_level` / `bad_json` | P0-8 |
| POST | `/api/v1/ai/validate` | AI 结构 + 合法性 + 门控（错误带 `path`） | 400 `ai_invalid` | B16 |
| POST | `/api/v1/ai/compile` | 规范化 + `programHash` + 统计 | 400 `ai_too_large`（与 details） | B16 |
| POST | `/api/v1/ai/battle` | 给定 AI 跑一场（服务端重新执行） | 400 / 409 `unknown_opponent` | B16 |
| POST | `/api/v1/box` | 开箱（seed/tier/times；品质上限 D-122 + 掉落池门控） | 400 / 409 `tier_locked` | B17 |
| GET | `/api/v1/warehouse` | 仓库规范骨架（`emptyWarehouse`） | — | B18 |
| POST | `/api/v1/warehouse/assemble` | 装配（原子性，失败状态不变） | 409 `slot_type_mismatch`/`points_exceeded`/`slot_occupied`/`tier_locked`/`plugin_equipped`/`item_missing` | B18 |
| POST | `/api/v1/warehouse/disassemble` | 拆卸 | 404 `slot_empty`/`plugin_missing` | B18 |
| GET/POST | `/api/v1/loadout` | 读取（返回 `EMPTY_LOADOUT` 骨架）/ 保存校验（无持久化回带） | 409 `loadout_invalid` | B19 |
| POST | `/api/v1/panel` | 最终面板（五维/regen/special/技能参数） | 409 `loadout_invalid` | B19 |

### 3.2 契约已冻结、尚未启用（⏳）

| 方法 | 路径 | 批次 | 备注 |
|---|---|---|---|
| POST | `/api/v1/battle` | B22（P4） | 双方 loadout + AI + seed → 完整回放帧 |
| GET | `/api/v1/replay/:id` | B22（P4） | 回放帧分片 `?from=&to=` |
| POST | `/api/v1/ranked/run` | B24（P5） | 抽 10 场离线结算（D-123 不持久化） |
| POST | `/api/v1/ranked/promote` | B25（P5） | 晋升 x=6 + 段位奖励 |

> 本文档更新时，若端点状态变化请同步此表（并在 `interfaces.md` §2 的批次列打 ✅）。

## 4. 统一信封与错误码

**成功**：`{ok:true, data, log:{level, events:[]}}`（`events` 字段为日志摘要占位，当前恒为空数组）。

**失败**：`{ok:false, error:{code, message, details}}`（`details` 为数组，AI 校验时为逐条 `{path,code,message}`）。

HTTP 状态语义：`400` 参数/请求体错误 ｜ `404` 资源不存在（端点/表/槽位） ｜ `409` 业务拒绝（门控/点数/校验失败） ｜ `500` 内部异常（同时记 `api.err`）。

| code | 触发 |
|---|---|
| `bad_json` | POST 请求体不是合法 JSON |
| `bad_request` | 请求体结构不满足端点要求（缺失必填字段/类型错误） |
| `bad_ai` | `program`/`ai` 字段缺失或不是对象 |
| `bad_tier` | `tier` 不在 `common/rare/epic/legendary/mythic` |
| `bad_level` | `level` 或通道级别非法；`channels` 不是对象 |
| `bad_table` | 表名非法（含 `/`、`..` 或畸形 URI 编码） |
| `unknown_table` | 表不存在（`details` 附可用表清单） |
| `unknown_endpoint` | 路径未匹配任何端点（404） |
| `ai_invalid` | AI 程序不合法（`details` 为逐条错误，含 `path`） |
| `ai_too_large` | 程序超过大小/深度/节点上限（`/ai/compile`） |
| `unknown_opponent` | `/ai/battle` 的 `opponent` 不在示例池 |
| `tier_locked` | 门控：玩家段位不足或掉落池为空（`/box`） |
| `slot_type_mismatch` / `points_exceeded` / `slot_occupied` / `plugin_equipped` / `item_missing` | 装配四道校验（含唯一性） |
| `slot_empty` / `plugin_missing` | 拆卸：空槽 / 悬挂引用 |
| `loadout_invalid` | loadout 校验失败（`details` 逐条） |
| `internal_error` | 服务端异常（500，日志记 `api.err`） |

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
// 200：data 含 result（winner/reason/tick/final）、frames 与回带的 seed、programHash
{ "ok": true, "data": { "seed": 7, "result": { "winner": "p1", "reason": "hero_dead", "tick": 17, "final": {…} },
                       "frames": [ … ], "programHash": { "p1": "…", "p2": "…" } } }
```

### `GET/POST /api/v1/log-level`

```jsonc
GET  → 200 { "ok": true, "data": { "level": "debug" } }
POST { "level": "trace", "channels": { "bullets": "trace" } } → 200（先全量校验后应用，任何失败都不产生部分生效）
```

## 6. 无状态契约（D-123，前端先行者必读）

- **服务器不保存任何玩家状态**：`warehouse`、`loadout`、段位都由**调用方持有**，POST 时随请求传入，服务器只做校验并**原样回带**。
- 因此：服务重启无数据丢失；同玩家并发请求天然安全；同一内容可重复校验（结果确定）。
- 开箱的随机性：请求带 `seed` 缺省由服务端生成并**回带**——同一 `seed` 重复请求结果一致（T-AP-5）。
- 物品 `uid` 语义（B17 登记）：进程内单调唯一（服务重启后重新计数），**不参与内容级比较**；「同 seed 复现」均为内容级。

## 7. CLI（唯一"操作台"，只走 HTTP）

```bash
npm run cli -- health | data <table> | box --seed 1 --tier common --times 10
npm run cli -- wh list|assemble|disassemble ...
npm run cli -- panel --loadout <file>
npm run cli -- ai validate|compile|battle --file ai.json [--tier rare] [--opponent kiter]
npm run cli -- log --level trace --channel bullets=trace
```
- 退出码：`0` 成功 / `1` 业务拒绝 / `2` 参数错误（T-CLI-2）。
- CLI **不 require core**，全部经 HTTP——它本身就是接口完整性验收工具。

## 8. 日志

| 主题 | 说明 |
|---|---|
| 级别 | `silent/fatal/error/warn/info/debug/trace`（`DL_LOG_LEVEL` 或运行时 `POST /api/v1/log-level`） |
| 通道 | `rng field effects items roles skills bullets engine damage ai.ast ai.runtime unlock api cli ranked store view render editor perf log`（后 4 个为 P6 保留） |
| HTTP 层事件 | 每个请求：`api.req`(info) → 处理 → `api.res`(info，含耗时与字节) / `api.err`(error) |
| 输出 | ≥`info` 写 stdout（`main()` 的 sink）；`debug/trace` 默认只入环形缓冲（N=2000，`dump()` 可导出） |
| 请求体上限 | POST 1MB（超限 500 拒绝，见 `readBody`） |

## 9. 数据表与资源

`GET /api/v1/data/:table` 覆盖 `server/data/*.json` + `assets/*.json`：

```
battle-config  items-config  plugins  qualities  role-templates  skill-templates  unlock   （+ assets: sprites/animations）
```

- 全部表由 `server/data/schema.js` 校验（T-DC-1/2，`npm run gate` 第 4/5 项）。
- 战斗数值**全部**在 `battle-config.json`（L9，禁止硬编码；`checkNumericHardcode` 门禁检查）。

## 10. 测试与门禁

```bash
npm test        # node --test --test-isolation=none tests/**/*.test.js（沙箱下必须单进程）
npm run cov     # 同左 + 覆盖率阈值（core/ai/shared/cli：行≥90% 分支≥85% 函数≥90%）
npm run gate    # 单进程内联 9 项：静态/架构/schema/一致性/D 落点/日志规范/全量测试/日志冒烟/接口冒烟
npm run demo    # 跑一场并打印逐 tick 摘要（--log-level trace 可开 trace）
```
- 门禁失败只能修代码/修测试；禁止放宽阈值绕过（阈值调整属 `tasks.md` §10 变更控制）。

## 11. 与前端 / 排位的关系

- **前端（P6）**：唯一数据来源是本文 §3.1 的全部端点与 `interfaces.md` §2；`warehouse`/`loadout` 由前端持有（localStorage，P6 落地），服务器只校验回带 —— 前端设计见 `docs/frontend-spec.md`。
- **排位（P5）**：`ranked/run`/`promote` 就绪后，前端只负责提交 loadout 快照与展示结果；段位由前端保管。
- **回放（P4）**：`/api/v1/battle` 就绪后返回**自足帧**（累积 diff 可重建任意 tick，T-BT-1）；前端渲染层只消费帧，不重算。