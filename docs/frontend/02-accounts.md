# F2 设计与实现冻结：账号管理与管理员面板

> 版本：v1　创建：2026-09-22　状态：**设计已冻结（总纲 §2.5 四项全过）；后端契约与前端面板实现中**
> 依据：`docs/frontend/00-rules.md`（总纲：§1 绘制边界 / §2 协作协议 / §4 验收机制）；`docs/interfaces.md` §2（接口唯一权威）；`docs/systems/11-account-store.md`（档案与存储权威）；`docs/server.md` §2/§3.2。
> 本批结论（用户 2026-09-22 确认）：**Q-A = `DL_ADMIN_USERS` 环境变量白名单**；**Q-B = 只做后端已有能力**（+ 本批新增「分页账号列表」「删除账号」两项显式契约）；**Q3 = 管理员令牌仅内存**；**附加硬要求**：后端以后新增 admin 能力时，管理面板必须同步 → 见 §10.1 机器核对。

---

## 1. 范围与端点映射（规则 4.3）

| # | 能力 | 后端现状 | 本批 UI | 状态 |
|---|---|---|---|---|
| 1 | `POST /api/v1/auth/register\|login\|logout\|password`、`GET /api/v1/me` | 已有（F1） | 复用（F1 四屏） | ✅ 已有 |
| 2 | `POST /api/v1/admin/stats` | 已有（`server/admin.js:127`） | 面板按钮「服务统计」 | ✅ 本批接 UI |
| 3 | `POST /api/v1/admin/rebuild-index` | 已有（`:115`） | 按钮「重建索引」 | ✅ 本批接 UI |
| 4 | `POST /api/v1/admin/bots` | 已有（`:152`，需 `DL_DEBUG_BOTS=1`） | 按钮「注入调试 bot」 | ✅ 本批接 UI |
| 5 | `POST /api/v1/admin/clear-bots` | 已有（`:211`） | 按钮「清除调试 bot」 | ✅ 本批接 UI |
| 6 | `POST /api/v1/admin/ban` | 已有（`:228`） | 按钮「封禁/解封」 | ✅ 本批接 UI |
| 7 | `POST /api/v1/admin/unban` | 已有（`server/index.js` 映射到 `ban{banned:false}`） | 同 6 的第二个按钮 | ✅ 本批接 UI |
| 8 | **`POST /api/v1/admin/accounts`** | **本批新增**（分页、无总数上限） | 账号列表（分页） | 🆕 新增契约 |
| 9 | **`POST /api/v1/admin/delete-account`** | **本批新增**（写 `player.removed` 墓碑） | 每行「删除」 | 🆕 新增契约 |
| 10 | 其余 P0–P7 端点（开箱/仓库/装配/AI/对战/回放/排位/快速对战/排行榜/配置槽/战绩） | 已有 | ⛔ **本轮不做**（后续批次按 `00-rules.md` §2 逐批设计） | — |

**非目标**：不做新作弊能力（给物品/给积分/改段位——后端无这些端点，属 F3+）；不做管理员持久化角色（Q-A 选环境变量）；不做管理操作审计查询页（审计已由 journal + `store.*` 日志承担）。

---

## 2. 后端契约（新增部分；按总纲 §2.7 走决策记录 `D-158` + `docs/interfaces.md` 同步 + `docs/tasks.md` §10）

### 2.1 管理员身份：`DL_ADMIN_USERS`

| 项 | 规则 |
|---|---|
| 取值 | 逗号分隔的**用户名**或 **publicId**（`u_xxxx`）；大小写不敏感；空/未配置 = 无账号级管理员 |
| 判定处 | `server/admin.js` 的 `adminUsersOf(env)`（唯一真源）；`server/index.js` 注入 `auth.js`，使 `register/login/authenticate` 回带 `data.player.isAdmin`（布尔） |
| 回带位置 | `POST /auth/register`、`POST /auth/login` 的 `data.player.isAdmin`；`GET /me` 的 `data.flags.isAdmin`（后者由 `/me` 的信封直接给出，见 §5） |
| 不改动 | 档案结构（`flags` 不加字段）、存储层、schema；**零迁移** |

### 2.2 `POST /api/v1/admin/:op` 鉴权扩展

```
① 请求者已登录且 data.player.isAdmin === true（Bearer） → 放行
② 否则走既有令牌路径：X-Admin-Token 或 Bearer 值 == DL_ADMIN_TOKEN → 放行
③ 两者皆不满足：
   · DL_ADMIN_TOKEN 未配置/为空 → 503 admin_token_missing（既有语义不变）
   · 已配置但不匹配          → 403 forbidden（既有语义不变）
```
- `DL_DEBUG_BOTS=1` 仍只对 `bots`（注入调试 bot）构成第二道门控（既有语义不变）。
- 请求管线变化：admin 路由改为 `{admin:true, tolerant:true}`，让 Bearer 被解析为 `ctx.player`（无/坏 token 按匿名，不因此 401）。

### 2.3 `POST /api/v1/admin/accounts`（新增）

请求：`{ "offset": 0, "limit": 20, "token"?: "<DL_ADMIN_TOKEN>" }`

响应 `data`：
```jsonc
{ "total": 137, "offset": 0, "limit": 20, "hasMore": true,
  "rows": [ { "playerId": "pl_…", "publicId": "u_…", "nickname": "…", "tier": "common",
              "points": 0, "peakPoints": 0, "inPool": true, "isBot": false, "banned": false,
              "lastSeenAt": 1789911067638, "updatedAt": 1789911067638 } ] }
```
- **无总数上限**：`total` 是全部账号数；`offset`+`limit` 分页取完即"显示全部"。
- `limit` 缺省 20、**上限 200**（防单次响应过大）；非法值 → 400 `bad_request`。
- 数据源 = 索引条目（`server/store/index-file.js:18-35` 已有 `publicId/nickname/tier/points/peakPoints/inPool/isBot/banned/lastSeenAt/updatedAt`）+ 索引键 `playerId`；**不加载档案**（可支撑万级账号）。
- 排序：`updatedAt` 降序 → `publicId` 升序（**稳定**，保证分页无遗漏/无重复）。
- `playerId` 属于 admin 通道（既有口径：玩家侧响应才脱敏，`server/index.js` 的 `redact`）。

### 2.4 `POST /api/v1/admin/delete-account`（新增）

请求：`{ "playerId"?: "pl_…", "publicId"?: "u_…", "token"?: "…" }`（二者至少一项；都给时以 `playerId` 为准）
响应 `data`：`{ "removed": true, "playerId": "pl_…", "publicId": "u_…" }`
- 实现 = `store.removeArchive(playerId)`（既有墓碑语义 `player.removed`：防 journal 重放复活、`aggregateRecords` 从检查点剔除）。
- **禁止删自己**：请求者账号 == 目标 → 409 `cannot_delete_self`（防管理员误操作把自己锁在门外）。
- 目标不存在/已删 → 404 `store_not_found`；缺参数 → 400 `bad_request`。

### 2.5 新增/变更错误码

| code | HTTP | 触发 |
|---|---|---|
| `cannot_delete_self` | 409 | 管理员删除自己的账号 |
| （复用）`bad_request` / `store_not_found` / `forbidden` / `admin_token_missing` / `debug_bots_disabled` | 400/404/403/503/403 | 见 §2.2–§2.4 |

---

## 3. 屏幕清单（文本界面；总纲 §1.2/§1.4）

新增两屏（`state.view`），**仅当 `state.session.isAdmin === true` 时可达**：

### 3.1 屏 `admin`（管理员面板）

- 静态文字：屏标题 `管理员面板`；提示行 `你是管理员账号：<publicId>；下方为后端已实现的管理能力`。
- 文本区：**最近一次管理操作的结果**（信封投影：成功显示 `data` 的关键字段，失败显示错误文案）。
- 按钮：`刷新账号列表`（`admin-refresh-accounts`）／`服务统计`（`admin-stats`）／`重建索引`（`admin-rebuild-index`）／`注入调试 bot`（`admin-bots`）／`清除调试 bot`（`admin-clear-bots`）／`返回主页`（`goto-home`）。
- 输入框：`管理员令牌（可留空：用管理员账号身份免填）`（`adminToken`，**仅内存**）、`封禁目标 publicId`（`adminTarget`）、`注入数量`（`adminCount`，缺省 1）。

### 3.2 屏 `accounts`（账号列表，分页）

- 静态文字：屏标题 `账号列表`；分页信息行 `共 <total> 个账号，第 <page>/<pages> 页（每页 <limit>）`。
- 文本区：每行一个账号：`<序号>. <publicId>  <nickname>  段位<层>  积分<n>  [在池|不在池] [bot] [已封禁]  playerId=<pl_…>`。
- 按钮：每行一个 `删除`（`admin-delete-account`，`data-player-id` 携带目标）；页脚 `上一页`（`accounts-prev`）／`下一页`（`accounts-next`）／`刷新`（`admin-refresh-accounts`）／`返回面板`（`goto-admin`）；`封禁此行`（`admin-ban-row`）／`解封此行`（`admin-unban-row`）。
- 每页条数：`20`（缺省）／`50`／`100` 三档切换按钮（`accounts-size-20|50|100`）。
- 二次确认：点「删除」后进入 `state.confirm = {kind:'delete', playerId, publicId}`，屏上显示 `确认删除 <publicId>？此操作不可撤销` + `确认删除`（`confirm-yes`）／`取消`（`confirm-no`）两个按钮。**后端不再二次确认，故前端必须确认**。

### 3.3 主页（F1 屏 `home`）变化

- `state.session.isAdmin === true` 时，额外显示按钮 `管理员面板`（`goto-admin`）；非管理员**完全不渲染**该按钮与任何管理入口（用户要求「普通账户只显示正常功能」）。

---

## 4. 按钮 ↔ 动作白名单增量（总纲 §4.1）

在 F1 的 9 个动作之外新增 16 个（合计 25；逐行枚举见下表，AU-1 以此断言）：

| 动作 | 触发控件 | 行为 | 成功可见文本 | 失败可见文本 |
|---|---|---|---|---|
| `goto-admin` | 主页·`管理员面板`（仅管理员） | 切 `admin` 屏 | 面板 | — |
| `goto-home`（F1 已有） | 面板·`返回主页` | 切 `home` | 主页 | — |
| `admin-refresh-accounts` | 面板/列表·`刷新账号列表` | `POST /admin/accounts {offset:0,limit}` | 切 `accounts` 屏并显示第 1 页 | 错误文案（403/503…） |
| `accounts-prev` / `accounts-next` | 列表·翻页 | 重新请求对应 offset | 更新列表与分页行 | 错误文案 |
| `accounts-size-20\|50\|100` | 列表·每页条数 | 改 `limit` 并回到第 1 页 | 更新列表 | — |
| `admin-delete-account` | 列表·每行`删除` | 进入二次确认 | `确认删除 <publicId>？` | — |
| `confirm-yes` | 确认态·`确认删除` | `POST /admin/delete-account {playerId}` → 重新拉当前页 | `已删除 <publicId>` | 错误文案 |
| `confirm-no` | 确认态·`取消` | 退出确认态 | 列表恢复 | — |
| `admin-stats` | 面板·`服务统计` | `POST /admin/stats` | 关键字段文本 | 错误文案 |
| `admin-rebuild-index` | 面板·`重建索引` | `POST /admin/rebuild-index` | `重建完成：<players> 玩家` | 错误文案 |
| `admin-bots` | 面板·`注入调试 bot` | `POST /admin/bots {tier, count}` | `已注入 <n> 个` | 403 `debug_bots_disabled` 文案 |
| `admin-clear-bots` | 面板·`清除调试 bot` | `POST /admin/clear-bots` | `已清除 <n> 个` | 错误文案 |
| `admin-ban-row` | 列表·`封禁此行` | `POST /admin/ban {playerId, banned:true}` | `已封禁 <publicId>` | 错误文案 |
| `admin-unban-row` | 列表·`解封此行` | `POST /admin/unban {playerId}` | `已解封 <publicId>` | 错误文案 |

- 管理动作在 `busy` 时全部禁用（防重复提交）；**非管理员**：这些动作的入口根本不渲染（`data-action` 不出现），但动作实现仍在白名单内（双向核对按「渲染集合 == 注册表」在**管理员态**下进行，见 §10.2）。

---

## 5. 字段来源契约增量（总纲 §4.2）

在 F1 的 38 条之外新增（`public/contract.js` 与 `public/format.js` 同步，仍由 FC-2/FC-3 机器强制）：

| 端点 | 字段路径 | 用途 |
|---|---|---|
| `register\|login` | `data.player.isAdmin` | 决定是否渲染管理员入口（Q-A） |
| `me` | `data.flags.isAdmin` | 同上（刷新后仍能判定） |
| `admin/accounts` | `data.total` | 分页信息行 |
| `admin/accounts` | `data.offset` | 当前页起点 |
| `admin/accounts` | `data.limit` | 每页条数 |
| `admin/accounts` | `data.hasMore` | 「下一页」是否可用 |
| `admin/accounts` | `data.rows` | 列表行（逐项取 `playerId/publicId/nickname/tier/points/inPool/isBot/banned/lastSeenAt`） |
| `admin/delete-account` | `data.removed` | 删除结果 |
| `admin/delete-account` | `data.publicId` | 成功文案 |
| `admin/stats` | `data.players` / `data.seq` / `data.snapshots` | 统计摘要行 |
| `admin/rebuild-index` | `data.players` | 重建结果文案 |
| `admin/bots` | `data.injected` / `data.skipped` | 注入结果文案 |
| `admin/clear-bots` | `data.removed` | 清除结果文案 |
| `admin/ban` | `data.banned` | 封禁/解封结果文案 |

---

## 6. 全部失败路径（增量）

| code | HTTP | 触发 | 界面文案 |
|---|---|---|---|
| `forbidden` | 403 | Bearer 非管理员且令牌不匹配 | `需要管理员权限（登录管理员账号，或填写管理员令牌）` |
| `admin_token_missing` | 503 | 未配置 `DL_ADMIN_TOKEN` 且请求者非管理员账号 | `服务端未配置管理员令牌（DL_ADMIN_TOKEN），且当前账号不是管理员` |
| `debug_bots_disabled` | 403 | `bots` op 但未设 `DL_DEBUG_BOTS=1` | `调试 bot 注入已关闭（需服务端设 DL_DEBUG_BOTS=1）` |
| `cannot_delete_self` | 409 | 删除自己 | `不能删除当前登录的管理员账号` |
| `store_not_found` | 404 | 目标不存在/已删 | `该账号不存在或已被删除` |
| `bad_request` | 400 | 分页/参数非法；bots count/tier 非法 | 服务端文案 |
| `unauthorized` / `session_expired` | 401 | 会话失效 | 按 F1 §6 统一登出 |
| `rate_limited` / `store_unavailable` / `internal_error` | 429/503/500 | 按 F1 §6 | 按 F1 §6 |

---

## 7. 状态增量（`public/store.js`）

```js
adminToken: '',                                   // 仅内存（Q3 A）；不写 localStorage
admin: { accounts: null, offset: 0, limit: 20, result: null, confirm: null, target: '', count: 1 },
```
reducer 动作增量：`admin.token.set` / `admin.accounts.set`(`{envelope, offset, limit}`) / `admin.page.set` / `admin.result.set` / `admin.confirm.set` / `admin.form.set`。会话增量：`session.isAdmin`（来自 `data.player.isAdmin` / `data.flags.isAdmin`）。

---

## 8. 边界条件

| # | 边界 | 行为 |
|---|---|---|
| A-1 | 非管理员登录 | 主页与管理动作入口**完全不渲染**；若手工构造请求 → 403 文案（服务端仍是权威） |
| A-2 | 账号总数 0 | 列表显示 `共 0 个账号`，无行；翻页按钮禁用 |
| A-3 | 最后一页不满 | `hasMore=false` → 「下一页」禁用 |
| A-4 | 删除当前页最后一行 | 删后重新拉**当前 offset**；若该页变空且 offset>0 → 自动回退一页 |
| A-5 | 删除自己 | 服务端 409；前端在确认文案里已提示（不影响操作） |
| A-6 | 管理员令牌留空且非管理员账号 | 403/503 文案（§6） |
| A-7 | 分页参数越界（offset 超总数） | 服务端返回空 rows + 正确 total；前端视为最后一页 |
| A-8 | `bots` 未开调试 | 403 `debug_bots_disabled` 文案，不静默 |
| A-9 | 令牌仅内存 | 刷新页面后需重填（Q3 A 的已知代价，写入提示行） |

---

## 9. 静态托管与接口可达性

复用 F1 的 `public/` 静态托管（`docs/frontend/01-auth.md` §9）；本批**不新增**静态资源类型、不改 `/api/v1` 既有端点语义。

---

## 10. 机器核对（本批新增；总纲 §4.1/§4.2/§4.3）

### 10.1 `admin-op-parity.test.js`（用户硬要求：后端加能力 → 面板必须同步）
从**后端源码**解析管理能力集合（`server/index.js` 的 `adminOp` 分支 `op === '…'` + `server/admin.js` 的 `return { … }` 导出方法名），与**前端** `public/api.js` 的 `ADMIN_OPS` 键集合断言**双向相等**。后端新增 op 而前端未登记 → FAIL（含缺失清单）。

### 10.2 `admin-ui-contract.test.js`
管理员态下渲染 `home`/`admin`/`accounts` 三屏，`data-action` 集合 == 注册表键集合（双向）；非管理员态下这些入口**不出现**（A-1）；`public/render.js` 仍零逻辑（F1 UI-7 复用）。

### 10.3 `admin-flow.test.js`（真实 HTTP + DOM 级）
起真实服务（`DL_ADMIN_USERS` 指向测试账号、`DL_ADMIN_TOKEN` 亦配置）：
管理员账号 → 面板各按钮 → 断言真实响应文案；非管理员账号 → 403；令牌路径（无管理员身份，带 `X-Admin-Token`）→ 200；**分页**：造 25 个账号 → 逐页取完 → 断言 `total=25`、无重复无遗漏（**且不受 100 上限约束**）；**删除**：删 1 个 → 列表少 1、该账号登录失效、删自己 → 409。

### 10.4 回归
F1 的四个测试文件全部继续通过（`data.player.isAdmin` 加入契约后 FC-1/FC-2/FC-3 同步）。

---

## 11. 人工走查剧本（管理员 + 普通账号两条线）

前置：`npm start`（`DL_ADMIN_USERS=<你的用户名>`；如需令牌路径再设 `DL_ADMIN_TOKEN`；如需 bot 注入再设 `DL_DEBUG_BOTS=1`）。

| 步 | 点哪里 | 看什么 | 期望文本 |
|---|---|---|---|
| 1 | 用**普通账号**登录 | 主页 | **看不到**「管理员面板」按钮 |
| 2 | 用 `DL_ADMIN_USERS` 里的账号登录 | 主页 | 出现「管理员面板」按钮 |
| 3 | 点「管理员面板」 | 面板屏 | 提示行含 `你是管理员账号：u_…` |
| 4 | 点「服务统计」 | 结果区 | `players=<n> seq=<n> snapshots=已装配`（无快照存储时 `snapshots=不可用`；见 §13-4） |
| 5 | 点「刷新账号列表」 | 列表屏 | `共 <total> 个账号，第 1/<pages> 页`；每行含 publicId 与 playerId |
| 6 | 点「下一页」/「上一页」/「每页 50」 | 列表 | 页码与行数随之变化，总数不变 |
| 7 | 对某个非自己账号点「删除」 | 确认态 | `确认删除 u_…？此操作不可撤销` |
| 8 | 点「取消」 | 列表 | 该账号仍在 |
| 9 | 再次「删除」→「确认删除」 | 结果区 | `已删除 u_…`；列表少一行 |
| 10 | 用被删账号登录 | 登录屏 | `用户名或密码错误`（账号已不存在） |
| 11 | 对自己点「删除」 | 结果区 | `不能删除当前登录的管理员账号` |
| 12 | 点「封禁此行」→ 刷新列表 | 该行 | 出现 `已封禁` 标记 |
| 13 | 点「解封此行」 | 该行 | 标记消失 |
| 14 | 点「注入调试 bot」（未设 `DL_DEBUG_BOTS`） | 结果区 | `调试 bot 注入已关闭（需服务端设 DL_DEBUG_BOTS=1）` |
| 15 | 设 `DL_DEBUG_BOTS=1` 重启后点「注入调试 bot」 | 结果区 | `已注入 <n> 个`；列表出现 bot 行 |
| 16 | 点「清除调试 bot」 | 结果区 | `已清除 <n> 个` |
| 17 | 刷新浏览器（F5）后用普通账号登录 | 主页 | 管理入口消失（普通账号只显示正常功能） |

---

## 12. 定稿判定（总纲 §2.5 四项）

| 项 | 判定 | 证据 |
|---|---|---|
| ① 行业主流做法（点名模式 + 被否决替代） | ✅ | 沿用 F1 的单向数据流 + 纯 `render(vm)` + 事件委托；**被否决**：(a) 把管理能力做成独立后端管理站点（多一套部署，违反"单一网络出口/同源"）；(b) 管理员令牌写 localStorage（Q3 选仅内存）；(c) 持久化 `flags.isAdmin` + WebUI 授权（Q-A 选环境变量白名单，零迁移）；(d) 一次性返回全部账号（无分页 → 响应体随账号数线性膨胀，故分页 + `total`） |
| ② 既有约束下合理 | ✅ | 零依赖；`public/**` 不在门禁扫描范围；后端改动仅在 L6（`admin.js`/`auth.js`/`index.js`）+ 新增 admin op，**不改 store 结构、不改 schema**；新增契约按 §2.7 走 D-158 + interfaces 同步 |
| ③ 功能完整（全部用户动作 + 全部失败路径） | ✅ | §1 端点映射（10 行，含 8 项接 UI）；§4 新增 16 个动作（合计 25）；§6 全部失败路径；§8 九条边界 |
| ④ 已明确到可逐行实现 | ✅ | §2 请求/响应字段逐条、§5 字段路径逐条、§7 状态与 reducer 逐项、§10 机器核对逐条 |

---

## 13. 实现对账（2026-09-22；实现与 §3/§4/§6/§10/§11 的差异逐条，**以本节为准**）

| # | 差异 | 处置 |
|---|---|---|
| 13-1 | §4 正文原写「新增 15（合计 24）」，与同表逐行枚举的 16 个不符 | ✅ 已改正文为 **16（合计 25）**；AU-1 以 25 双向断言 |
| 13-2 | §10.1/§10.2 原写 `public/admin.js`，但 F1 的 UI-1 冻结 `public/` 为 9 文件 | ✅ 管理能力登记表 `ADMIN_OPS` 落在 **`public/api.js`**（真正发 `/api/v1/admin/<op>` 的文件）；`admin-op-parity.test.js` 从该文件读取；本节与 §10.1 已同步 |
| 13-3 | F1 的 `auth-ui-contract.test.js` UI-2 原含「注册表 ⊆ 渲染集合」（不可达检查）。25 个动作下**非管理员态**四屏永远只渲染 9 个，该断言不可能成立 | ✅ UI-2 保留「死按钮」检查与 `rendered.size === 9`（非管理员态）；**全量双向核对移到 AU-1**（管理员态三屏渲染集合 == 25） |
| 13-4 | §5 只登记 `data.snapshots`，其真实值是对象 `{files,refs,cached}`（`server/store/snapshot-store.js`）；出数字需读 `data.snapshots.files`，而该路径未登记、FC-3 又强制「契约 == 两份分册 §5 并集」 | ✅ 不扩路径：投影为 `snapshots=已装配`（无快照存储时 `snapshots=不可用`）；§11 步 4 期望已同步 |
| 13-5 | §3.1 的输入框 `封禁目标 publicId`（`adminTarget`）在 §4 无独立动作，且 `POST /admin/ban` 只收 `playerId` | ✅ 接到**既有** `admin-ban-row`（面板多一个「封禁目标」按钮，**不新增动作名**）；无行 payload 时先分页扫 `admin/accounts`（limit 200、≤25 页）把 publicId 解析成 playerId |
| 13-6 | §6 未登记的 4 条**客户端预校验**文案 | ✅ 沿用 F1 预校验先例，实现在 `public/format.js` 的 `ADMIN_HINTS` + `actions.js`：`注入数量需为 1~200 的整数`、`请填写封禁目标 publicId`、`账号列表中没有 publicId=… 的账号`、`未登记的管理端点：…`（api.js 本地拒绝，不发请求） |
| 13-7 | §3.2 行模板未含 `lastSeenAt`，但 §5 行字段清单含它（读了却不用 = 违反"投影单一真源"精神） | ✅ 行文本在 `playerId=<pl_…>` 后追加 `最后活跃<YYYY-MM-DD HH:mm>`；其余逐字按 §3.2 |
| 13-8 | §3 规定两屏「仅 `isAdmin` 可达」→ `X-Admin-Token` 路径**无法经 UI 驱动** | ✅ UI 侧令牌输入框保留（仅管理员账号进入面板后可选填，用于**降级**为纯令牌调用）；令牌路径本身由 §10.3 在 **api 层**覆盖（正确 200 / 错误 403 / 未配置 503） |
| 13-9 | 文档未规定的小实现选择 | ✅ 备案：登出/会话失效一并清 `adminToken` 与列表/确认/结果态；管理结果默认只进结果区，仅当"从非管理屏被强制调用"（A-1）时同文案也写 `#notice`（保证按钮永不无声） |
