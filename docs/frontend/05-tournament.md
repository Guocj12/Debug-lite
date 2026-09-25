# F7 设计与实现冻结：锦标赛屏 + 排行榜屏（段位榜/积分榜）

> 版本：v1　创建：2026-09-25　状态：**设计已冻结（总纲 §2 协作协议）；实现与机器核对中；人工走查待用户执行**
> 依据：`docs/frontend/00-rules.md`（总纲：§1 绘制边界 / §2 协作协议 / §3 文档体系 / §4 验收机制）；`docs/interfaces.md` §2（接口唯一权威）；`docs/decisions.md` §14.9（**D-171**）与 §14.4–§14.8。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md` > `docs/frontend/*`。
> 本文件是 P6 批次 **F7** 的唯一实现依据。**本批含一处后端契约扩展（D-171）**，按总纲 §2.7 走决策记录 + `interfaces.md` 同步。

---

## 0. 本轮的取证方式（总纲 §2.3：运行时事实必须实测）

| 探针 | 覆盖 | 结论落点 |
|---|---|---|
| `%TEMP%\probe-f6\probe-f67-shapes.js`（真实 HTTP） | `POST /ranked/run` 的 `data` 键集、`results[i]` 键集（**`frames` 在幂等/重放批次上缺失**）、`POST /ranked/promote` 的 `wins` 必填、`GET /leaderboard` 的 `scope`/`limit` 与**无分页、无本人名次**、`GET /me/records` 行字段 | §1/§3/§5 |
| 独立上下文子代理（后端契约清点，只读） | 上述各项的 `file:line` + `ranked.js:749`（`shortfall>0` 强制不判晋升）+ `results[]` 在重放路径**没有 `frames` 键**（不是 `null`） | §2 反驳 2/3、§8 |
| 本批新增 `tests/api/api-leaderboard.test.js` LB-3…LB-7 | D-171 的分页一致性、本人名次、段位榜排序、参数负例、老索引迁移 | §9/§10 |

---

## 1. 范围与端点 UI 映射（规则 4.3）

| # | 端点 | 本批 UI 路径 | 状态 |
|---|---|---|---|
| 1 | `POST /api/v1/ranked/run` | 锦标赛屏·「开始锦标赛」→ 批次汇总 + 10 场分页列表 + 每场帧查看 | ✅ 本批接 UI |
| 2 | `GET /api/v1/leaderboard`（**D-171 扩展**） | 排行榜屏·积分榜/段位榜 + 分页 + 本人名次 | ✅ 本批接 UI（契约扩展见 §9） |
| 3 | `GET /api/v1/replay/:id` | 锦标赛屏·某场无内联帧时读该场回放 | ✅ 复用 F6 出口 |
| 4 | `POST /api/v1/ranked/promote` | — | ⛔ **本轮不做**：它是"只判定不落盘"的纯函数式端点，而晋升已在 `/ranked/run` 内落地（实测响应含 `promoted`/`tierAfter`/`reward`）⇒ 前端再调一次只会得到同一答案，且要额外解释"调了也不落盘"。登记为**非目标**，理由见 §2 反驳 4 |
| 5 | `GET /api/v1/me/records`、`/me/defense` | — | ⛔ 非目标（战绩列表属后续批次；本批只做"刚打完的这一批"） |
| 6 | `POST /api/v1/quick/run` 等 | F6 已接 | 复用（`state.viewer` 共用） |

---

## 2. 采用的模式与被否决的替代（总纲 §2.5 ①）

**采用**：沿用 F1–F3/F6 的既有模式（零依赖双模模块、纯 `render(vm)`、单 store、唯一网络出口、唯一 DOM 写入点、动作注册表、投影单一真源）。**不新增 `public/` 文件**（UI-1 锁死 9 文件）。

**反驳清单（对"最自然的实现方式"的自我攻击；每条都给反例与代价）**

| # | 被反驳的提案 | 反例 / 后果 | 本批处置 |
|---|---|---|---|
| 1 | 「锦标赛结果一次把 10 场全渲染出来（不做分页）」 | 10 场 ×（每场 1 行文本 + 1 个按钮）本身不大，但**用户明确要求分页**，且每场还会展开帧文本（数十行）⇒ 不分页时单屏上千行、`data-action` 集合膨胀。**备选**：全量渲染 + 折叠；**代价**：需要折叠状态机（多一个 state 字段与两类动作），收益不如固定分页 | ✅ 每页 **5 场**（10 场 = 2 页），页脚 `上一页/下一页` + `第 x/y 页（共 n 场）` |
| 2 | 「`shortfall>0` 时也照样显示"未晋升"就完事」 | 实测 `server/ranked.js:749`：**缺场批次强制不判晋升**（`promoted = promotion.promoted && shortfall === 0`）。若前端只显示"未晋升"，用户会以为"打够了但没赢够"，而真相是"池里没人、这轮不算数"⇒ 误导。**必须**把 `shortfall` 与"缺场不判晋升"这条规则直接写在屏上 | ✅ 缺口诚实行（§3.1）：`池内候选不足：本批少打 <shortfall> 场（D-152 禁止 bot 充数；缺场批次不判晋升）` |
| 3 | 「每场的 `frames` 一定在（像 quick 那样直接看）」 | 实测：**重放批次**（同 `playerId`+`seed` 再请求）的 `results[i]` **根本没有 `frames` 键**；`invalid` 场次也没有。若直接读 `frames[i]` 会渲染 `undefined`/空查看器 ⇒ 用户点了「看这一场」却什么也看不到 | ✅ `tournament-open-battle` 对"无内联帧"必须**自动改走 `GET /replay/:battleId`**（失败可见、不空转）；无 `battleId`（invalid 场）时按钮禁用并写明原因 |
| 4 | 「把 `/ranked/promote` 也接上（后端有端点就该有 UI）」 | 规则 4.3 允许显式登记"本轮不做"，而该端点是**只判定不落盘**的（注册表里 `promote` 的语义就是纯函数），落盘发生在 `/ranked/run` 内；接上它反而要解释"为什么点了段位没变"。**备选**：接上并写明"仅判定"；**代价**：多一个动作 + 多一条误导性路径 | ❌ 不接；在 §1 显式登记非目标 |
| 5 | 「排行榜分页/本人名次在前端拼（拉 limit=100 自己找）」 | 实测后端**只回前 N 行**（无 offset、无 total、无 self），前端拼分页会：① 上限 100 → 第 101 名以后永远看不到；② 每次翻页都拉全量；③ "本人名次"在**未进前 100 时无法计算**（静默错） | ✅ 走总纲 §2.7：升级为 **D-171**（后端扩展 offset/total/hasMore/self + 段位榜），前端只消费 |
| 6 | 「段位榜也用 `points` 排序（同积分榜，只是加一列段位）」 | 用户口径是"**段位榜（按段位、同段位按到达时间）**"。若按积分排序，段位榜与积分榜会长期重合（积分与段位强相关），"先到者在前"这一信息完全丢失 ⇒ 榜没有独立语义 | ✅ 段位榜 = `order=arrival`：tier 高→低 → 同段位 `tierUpdatedAt` 升序（D-171 已实现并机器核对 LB-5） |
| 7 | 「段位过滤做 5 个按钮，每个一个动作（`board-scope-common`…）」 | 动作注册表 +5 个纯壳动作（每个都要进双向可达核对），而它们的"行为"完全相同、只有参数不同 ⇒ 膨胀且易漂移 | ✅ **一个动作** `board-scope`，段位经 `data-tier` 携带（`render.targetAttrs` + `app.payloadOf` 各加一个键，见 §4 注） |

**与行业主流做法的关系（总纲 §2.5 ①）**：主流排位赛界面多为"赛季进度条 + 段位徽章 + 场次列表"。本项目**刻意不采**图形化段位徽章与进度条（§1.2/§1.3 文本化封闭）；**采**的部分是"批次 = 固定场次 + 段位变化 + 榜单"的信息结构。

---

## 3. 屏幕清单与交互（文本界面）

### 3.1 屏 `tournament`（锦标赛 = 排位赛）

- 静态文字：屏标题 `锦标赛（= 排位赛）`；提示行说明"服务端抽池、每批至多 10 场、缺场如实回报、帧内联可逐场查看"。
- 未跑过：`（尚未发起锦标赛：点「开始锦标赛」）`。
- 跑过之后：
  - **结果区**：`本批 <matches>/<requested> 场（缺口 <shortfall>）· 胜 <wins> / 平 <draws> / 负 <losses> / 无效 <invalids> · 段位 <tier> → <tierAfter>（晋升 <是|否>）· 奖励品质 <reward>`
  - **批次行**：`批次 <batchId> · 冷却回满 <recoveryHours> 小时`
  - **缺口行**（仅当 `shortfall > 0`）：见 §2 反驳 2 文案
  - **分页行**：`第 <page+1>/<pages> 页（每页 5，共 <matches> 场）`
  - **场次行**（每场一行 + 一个按钮 `看这一场`）：`第 <match> 场 · 对手 <opponentPublicId> · 结果 <你赢了|你输了|平局|无效对局> · <ticks> tick · 对局 <battleId|（无）>`
  - **查看区**：当前查看场次的帧文本（与 F6 同一投影 `frameLines`）+ AI 轨迹行（`state.viewer`，共用一个实现）
- 按钮：`开始锦标赛`／`上一页`／`下一页`／每行 `看这一场`／`第一帧|上一帧|下一帧|最后一帧`／`看我方(进攻方)轨迹|看对手(防守方)轨迹`／`AI 逻辑查看器`／`读取本场回放`（仅无内联帧）／`看段位榜`（`goto-leaderboard`）／`看积分榜`（`board-points`）／`返回主界面`。

### 3.2 屏 `leaderboard`（排行榜：两张榜）

- 静态文字：屏标题 `排行榜`；提示行说明"积分榜 = 逐分排名；段位榜 = 段位高→低、同段位按到达时间（先到者在前）；两榜都可分页"。
- 榜头行：`积分榜 · 范围 全部 · 第 <x>/<y> 页 · 共 <total> 人`（`board='tier'` 时为 `段位榜 · 范围 <段位> …`）
- 本人名次行：`我：第 <rank> 名（<publicId>，<points> 分，段位 <tier>）`；不在榜内/未登录 → `我：不在本榜内（未登录或未上榜）`
- 行列表：每行 `第 <rank> 名 · <nickname>（<publicId>）· <points> 分 · 段位 <tier>`（段位榜额外追加 `· 到达 <YYYY-MM-DD HH:mm>`）
- 按钮：`积分榜`（board-points）／`段位榜`（board-tier）／范围 6 个：`全部`+5 段位（`board-scope`，`data-tier` 携带）／`上一页`／`下一页`／`刷新`／`返回主界面`。
- 边界：`offset=0` 时 `上一页` 禁用；`hasMore=false` 时 `下一页` 禁用；`total=0` 时行区写 `（本榜暂无玩家）`。

---

## 4. 按钮 ↔ 动作白名单（规则 4.1；F7 增量 10 个）

| 动作 | 触发控件 | 行为 | 成功可见文本 | 失败可见文本 |
|---|---|---|---|---|
| `tournament-run` | 锦标赛屏·`开始锦标赛` | `POST /ranked/run {}` → 落 `state.tournament.envelope`（页码归 0，清空查看器） | 结果区（§3.1） | 服务端文案（`no_active_config`/`loadout_invalid`/`banned`…） |
| `tournament-page-prev` | 锦标赛屏·`上一页` | 页码 −1（夹到 0）；**不发请求** | 分页行与场次行更新 | —（首页禁用） |
| `tournament-page-next` | 锦标赛屏·`下一页` | 页码 +1（夹到末页）；**不发请求** | 同上 | —（末页禁用） |
| `tournament-open-battle` | 场次行·`看这一场`（`data-idx` = 场次下标） | 载入该场帧到 `state.viewer`；**无内联帧时自动 `GET /replay/:battleId`** | `已载入本场战斗：第 <n> 场（<k> 帧）` / `已读取回放 <id>：<k> 帧（…）` | `410 replay_expired`／`403 replay_forbidden`／`该场无效（对手快照不可用，无对局 id 可读回放）` |
| `board-points` | 排行榜屏/锦标赛屏·`积分榜` | 切到积分榜（`order=points`，offset 归 0）→ `GET /leaderboard` | 榜头行 + 行列表 | 服务端文案 |
| `board-tier` | 排行榜屏·`段位榜` | 切到段位榜（`order=arrival`，offset 归 0）→ `GET /leaderboard` | 同上 | 服务端文案 |
| `board-scope` | 排行榜屏·`全部`/`common`…`mythic`（`data-tier`） | 改 scope（`global`/`tier:<t>`，offset 归 0）→ 重新拉取 | 同上 | 服务端文案 |
| `board-prev` | 排行榜屏·`上一页` | offset − limit（夹到 0）→ 重新拉取 | 同上 | —（首页禁用） |
| `board-next` | 排行榜屏·`下一页` | offset + limit（`hasMore` 才可用）→ 重新拉取 | 同上 | —（末页禁用） |
| `board-refresh` | 排行榜屏·`刷新` | 按当前 board/scope/offset 重新拉取 | `榜单已刷新` | 服务端文案 |

**注（唯一的 `data-*` 扩展）**：`board-scope` 需要携带段位。本批在 `render.targetAttrs` 增加 `data-tier`（与既有的 `data-slot`/`data-bucket` 同构）、在 `app.payloadOf` 的白名单增加 `tier` —— 这是**搬运字符串**，不是逻辑（`render` 仍零逻辑）；不新增动作名 ×5。
- 帧查看相关动作（`viewer-*`）**已在 F6 注册**，F7 直接复用（同一动作、两屏可达），不重复登记。

---

## 5. 字段来源契约（规则 4.2）

### 5.1 端点字段（进 `contract.AUTH_FIELD_CONTRACT`）

| 端点 | 字段路径 | 用途 |
|---|---|---|
| `ranked/run` | `data.batchId` | 批次行 |
| `ranked/run` | `data.tier` | 结果区·批次前段位 |
| `ranked/run` | `data.requested` | 结果区·本批应该打几场（分页行的"共 n 场"用 `matches`） |
| `ranked/run` | `data.matches` | 结果区 + 分页总数 |
| `ranked/run` | `data.shortfall` | 缺口行的判据与数字 |
| `ranked/run` | `data.wins` / `data.draws` / `data.losses` / `data.invalids` | 结果区胜负平与无效场 |
| `ranked/run` | `data.recoveryHours` | 批次行·冷却回满小时 |
| `ranked/run` | `data.promoted` | 结果区·是否晋升 |
| `ranked/run` | `data.tierAfter` | 结果区·批次后段位 |
| `ranked/run` | `data.reward` | 结果区·奖励品质 |
| `ranked/run` | `data.results` | 场次列表（逐项取 `RANKED_RESULT_FIELDS`） |
| `leaderboard` | `data.scope` | 榜头行·当前范围 |
| `leaderboard` | `data.order` | 榜头行·当前榜（points/arrival） |
| `leaderboard` | `data.offset` | 分页行 |
| `leaderboard` | `data.limit` | 分页行 |
| `leaderboard` | `data.total` | 分页行（全量人数） |
| `leaderboard` | `data.hasMore` | 「下一页」是否可用 |
| `leaderboard` | `data.rows` | 行列表（逐项取 `LEADERBOARD_ROW_FIELDS`） |
| `leaderboard` | `data.self` | 本人名次块（`LEADERBOARD_SELF_FIELDS`；为 `null` = 不在榜内） |

**不读**：`data.seed`（`ranked/run` 也有该字段，但 03 分册已按路径登记为"前端不读"；且它无法喂回任何入参，复现用 `battleId`）；`data.duplicate`/`data.replayed`（只在**重放批次**出现 ⇒ 无法在"新批次"响应里核对；本批不需要它们，"有没有帧"才是判据）。

### 5.2 子对象字段（**不含 `data.` 前缀**；由 `tests/frontend/tournament-board-flow.test.js` 的 **TB-6** 三方核对）

- `results[i]`：`match` `opponentPublicId` `winner` `ticks` `battleId`（**可选**：`frames`、`duplicate` —— 重放批次没有 frames 键；invalid 场次两者都没有）
- `data.rows[i]`：`rank` `publicId` `nickname` `points` `tier` `tierUpdatedAt`
- `data.self`：`rank` `publicId` `nickname` `points` `tier` `tierUpdatedAt`
- **`tierUpdatedAt` 的口径（审查 F7-C 补）**：它是**最后一次段位变化**的时间（升段/降段/管理端 `account-patch` 改档都会刷新），**不是"首次到达该段位"的时间**；缺失（老数据）时**排在本段位末尾**（内部用 MAX_SAFE_INTEGER 表示"未知"），屏上"到达"列写 `未知`。D-171 的读档兜底盖章会把缺失值补成账号创建时间（createdAt，保守代理），见 §9。
- 帧与 AI 轨迹子字段：**沿用 F6 §5.2 的九组清单**（同一份帧投影实现，不另立契约）

---

## 6. 全部失败路径（增量）

| code | HTTP | 触发 | 界面文案 |
|---|---|---|---|
| `no_active_config` | 409 | 没有出战配置 | 服务端文案 + `（先到「出战配置1」装配并激活）` |
| `loadout_invalid` | 409 | 出战快照无法实例化 | 服务端文案 + 字段级 `error.details[0].path` |
| `store_not_found` | 404 | 档案缺失 | 服务端文案 |
| `replay_expired` / `replay_forbidden` | 410 / 403 | 读某场回放失败 | 见 F6 §6（同一文案表） |
| `bad_request` | 400 | `offset`/`limit`/`order` 非法（本地已拦，服务端兜底） | 服务端文案 |
| `bad_scope` | 400 | `tier:<非法>`（本地只渲染合法五段位，服务端兜底） | 服务端文案 |
| `unauthorized` / `session_expired` | 401 | 会话失效 | 按 F1 §6 统一登出 |
| 本地拦截 | — | 首页点「上一页」/末页点「下一页」/`invalid` 场点「看这一场」 | 按钮 `disabled`（不产生点击），**不出现空文案按钮**；若被强制调用则写 `该场无效（对手快照不可用，无对局 id 可读回放）` |

---

## 7. 状态与持久化（`public/store.js`）

```js
// F7：锦标赛（只存最近一次响应信封 + 页码）
tournament: { envelope: null, page: 0 },
// F7：排行榜（只存最近一次响应信封 + 当前榜/范围/分页游标）
board: { envelope: null, board: 'points', scope: 'global', offset: 0, limit: 20 },
```
reducer 动作增量：`tournament.set`（`{envelope}`，页码归 0）／`tournament.page.set`（`{page}`）／`board.set`（`{envelope, board, scope, offset, limit}`）／`board.page.set`（`{offset}`）／`board.mode.set`（`{board, scope}`，偏移归 0）；`viewer.clear` 扩展为"清空所有战斗/榜单态"（登出/会话失效时调用）。
- **持久化**：不新增任何持久化键（榜单与批次都只在内存）。
- 常量：`TOURNAMENT_PAGE_SIZE = 5`、`BOARD_PAGE_SIZE = 20`、`BOARD_ORDERS = ['points','arrival']`、`BOARD_SCOPES = ['global','tier:common',…,'tier:mythic']`（后两者由 `store` 导出，供 `format`/测试共用）。

---

## 8. 边界条件

| # | 边界 | 行为 |
|---|---|---|
| T-1 | `matches = 0`（池内无人） | 结果区照常显示 `0/10（缺口 10）`；分页行 `第 1/1 页（共 0 场）`；场次区 `（本批没有可用的对局）`；`上一页/下一页` 禁用 |
| T-2 | `shortfall > 0` | 缺口行必须出现（含"缺场批次不判晋升"） |
| T-3 | 某场 `winner='invalid'` | 行文案 `无效对局`；`看这一场` **禁用**（无 `battleId`），行内写明原因 |
| T-4 | 某场缺 `frames`（重放批次） | `看这一场` 可用 → 自动读回放；失败写可见文案 |
| T-5 | 页码越界（理论不可达） | `tournament.page.set` 夹取到 `[0, pages-1]` |
| T-6 | `total = 0` | 榜头 `共 0 人`；行区 `（本榜暂无玩家）`；本人名次行 `不在本榜内` |
| T-7 | `self = null`（未登录/未上榜） | 本人名次行写明"未登录或未上榜"（**不伪造**名次） |
| T-8 | 段位榜行缺 `tierUpdatedAt`（老数据） | 到达时间列写 `未知`（D-171 的迁移会补齐；此处只兜底不崩） |
| T-9 | `hasMore=true` 但本页 0 行（服务端不一致） | `下一页` 仍可用（以服务端 `hasMore` 为准）；行区如实显示本页为空 |
| T-10 | 查看某场后再翻页 | 查看器内容**保持**（翻页只改列表；用户可用「第一帧」等继续看） |

---

## 9. 后端变更摘要（**D-171**，唯一的本批后端改动）

| 项 | 内容 |
|---|---|
| 端点 | `GET /api/v1/leaderboard` 扩展：`order=points\|arrival`（缺省 `points`）、`offset`（≥0，缺省 0）；响应新增 `order/offset/total/hasMore/self`，行新增 `tierUpdatedAt` |
| 语义 | `order=points` = 既有积分榜（points → peakPoints → updatedAt，**未变**）；`order=arrival` = **段位榜**（tier 高→低 → 同段位 `tierUpdatedAt` 升序 → publicId） |
| 本人名次 | `data.self` = 调用者在本榜本 scope 的全榜名次（**可选** Bearer；匿名/坏 token → `null`，榜单仍 200）；**不含 `playerId`** |
| 鉴权 | 路由改为 `{tolerant:true}`：带 Bearer 才认身份，不带仍公开可读（既有语义不变） |
| 索引 | `entryOf` 增加 `tierUpdatedAt`；`board()` 成为唯一榜单实现（`leaderboard()` = `board().rows` 薄封装，旧调用方零改动）；段位榜排序独立缓存并在 tier/tierUpdatedAt 变化时失效 |
| 缓存失效口径（**审查 F7-A 修正**） | 失效条件由"逐键手写比较"改为**集中键表** `BOARD_ROW_KEYS = ['publicId','nickname','points','peakPoints','tier','tierUpdatedAt','banned']`：任一变即同时清掉两张榜缓存。修前漏 `banned` ⇒ `/admin/ban` 之后被封禁者**仍留在榜上**（行来自陈旧缓存、`self` 走新鲜数组 ⇒ 同一响应自相矛盾，违反 `systems/11` §8.6「封禁账号一律不进榜」）。回归 = **LB-8** |
| 迁移（**审查 F7-B 修正**） | 老 `index.json` 条目**缺 `tierUpdatedAt` 键** → `open()` 从档案重建索引补齐（info 日志说明原因，不谎称"索引损坏"），重建结果立即落盘。判据必须是"**缺键**"而非"值不是整数"：档案本身缺该值时 `entryOf` 会写 `null`，按值判真会导致**每次开机全量重建且永不收敛**。档案侧的缺值由 `store.archive.stampTierUpdatedAt`（读档时用 `createdAt` 兜底盖章并写回，一次性）负责。回归 = **LB-7**（只缺索引键）+ **LB-9**（档案也缺 → 三次开机收敛） |
| 迁移 | 老 `index.json` 条目缺 `tierUpdatedAt` → `open()` 检测到即**从档案重建索引**补齐（info 日志说明原因，不谎称"索引损坏"），重建结果立即落盘 |
| 错误码 | `offset`/`order` 非法 → 400 `bad_request`；`scope` 非法 → 400 `bad_scope`（不变） |
| 文档 | `docs/decisions.md` §14.9（D-171）、`docs/interfaces.md` §2/§5、`docs/systems/11-account-store.md` §8.6、`docs/server.md` §3.2 |
| 机器核对 | `tests/api/api-leaderboard.test.js` **LB-3…LB-7**（分页一致性 / 本人名次 / 段位榜排序 / 参数负例 / 老索引迁移）+ `tests/contract/store-contract.test.js` CN-12（`board`/`needsTierStamp`） |

---

## 10. 机器核对（本批新增；`tests/frontend/tournament-board-flow.test.js`）

| 编号 | 断言 |
|---|---|
| TB-1 | 真实 HTTP：造 12 账号 → `tournament-run` → 结果区逐字来自真实字段（`matches`/`shortfall`/`wins`…）；`state.tournament.envelope` 与响应同源；页码归 0 |
| TB-2 | 分页：`matches` 场按 `TOURNAMENT_PAGE_SIZE=5` 分页；页内行数正确；`上一页/下一页` 的禁用随页码变化；翻页**零请求**；`tournament.page.set` 越界夹取 |
| TB-3 | 「看这一场」：真实帧入 `state.viewer`（`source='tournament'`），帧数与 `results[i].frames.length` 一致；查看器内容与 F6 同一投影（`frameLines` 无 undefined） |
| TB-4 | 缺口诚实：构造 `shortfall>0`（池内只放 1 个候选）→ 缺口行出现且含"缺场批次不判晋升"；`shortfall=0` 时该行不出现 |
| TB-5 | `invalid`/无帧场次：`看这一场` 的禁用/可用与 `battleId`/`frames` 的真实存在性一致；无 `battleId` 时按钮禁用且行内写明原因 |
| TB-6 | 子对象字段三方一致（contract == 05 §5.2 == format.js 实读 + 真实响应逐字段） |
| TB-7 | 排行榜：真实 `GET /leaderboard` → 榜头行逐字来自 `scope/order/offset/limit/total`；行列表逐字来自行字段；本人名次行与 `data.self` 同源；`self=null` 时文案写明不伪造 |
| TB-8 | 分页与切榜：`board-prev/next` 的禁用随 `offset/hasMore`；`board-points`/`board-tier`/`board-scope` 切换后**重新请求**且请求参数正确（`order`/`scope`/`offset`）；`board-refresh` 不改变 board/scope/offset |
| TB-9 | 动作双向闭合：锦标赛屏与排行榜屏渲染出的 `data-action` 全部命中注册表；注册表里的 F7 动作在两屏（含分页/self 两种态）全部可达 || TB-10 | `busy` 时两屏全部按钮禁用；`tournament-run`/`board-*` 不重入；`data-tier` 寻址链三处可核：① 渲染出 `data-tier`（真 HTML 正则断言）、② `app.payloadOf` 白名单含 `tier`（源码级断言 —— 与 CF-8 对 `loadout.aiId` 的手法同构）、③ 动作消费 `payload.tier` 后发出正确查询（真 HTTP）。DOM 事件的通用委托路径由既有 `admin-ui-contract.test.js` AU-8 覆盖 |
| TB-11 | 榜人数在会话中途缩水（删号/封禁）→ `offset` 越界必须**回退到有效页**（不得显示 `第 2/1 页`），且回退是"最多一次"（再刷新只发一次请求）（审查 F7-D 的回归） |
| TB-12 | 锦标赛屏的查看器**只显示属于本批**的帧（`source='tournament'` 且 `battleId` 在本批 `results[]` 里）——与 F6 的 QB-11 同口径，防跨屏残留 |

---

## 11. 人工走查剧本（总纲 §4.4）

前置：`npm start`；池内至少 3 个账号（或 `DL_DEBUG_BOTS=1` + 管理员注入 bot）。

| 步 | 点哪里 | 看什么 | 期望文本 |
|---|---|---|---|
| 1 | 主界面 → `锦标赛` | 锦标赛屏 | 标题 `锦标赛（= 排位赛）`；`（尚未发起锦标赛：点「开始锦标赛」）` |
| 2 | 点 `开始锦标赛` | 结果区 | `本批 <n>/10 场（缺口 <s>）· 胜 … 平 … 负 … 无效 … · 段位 common → common（晋升 否）· 奖励品质 common` |
| 3 | 看分页行/场次区 | 文本区 | `第 1/2 页（每页 5，共 <n> 场）`；每行 `第 k 场 · 对手 u_… · 结果 … · <t> tick · 对局 b_…` |
| 4 | 点 `下一页` | 场次区 | 变成 `第 2/2 页`；`下一页` 变灰 |
| 5 | 点第 1 页某场 `看这一场` | 查看区 | 该场帧文本（`第 1/<n> 帧（tick 1）` …）；提示 `已载入本场战斗：第 k 场（<n> 帧）` |
| 6 | 点 `最后一帧` | 查看区 | 末帧含 `判决：…` |
| 7 | 点 `AI 逻辑查看器` | 弹窗 | 与 F6 相同的只读程序树 + 执行标记 + 双方轨迹 |
| 8 | 点 `看段位榜` | 排行榜屏 | 标题 `排行榜`；榜头 `段位榜 · 范围 全部 · 第 1/1 页 · 共 <n> 人`；行含 `段位 … 到达 …` |
| 9 | 点 `积分榜` | 排行榜屏 | 榜头 `积分榜 · 范围 全部 …`；按分数降序（与第 8 步顺序可能不同） |
| 10 | 点某段位（如 `legendary`） | 榜头与行区 | `范围 legendary`；无该段位玩家时 `（本榜暂无玩家）` |
| 11 | 点 `下一页`/`上一页` | 行区 | 行随页码变化；总数不变；首页/末页对应按钮变灰 |
| 12 | 看本人名次行 | 文本区 | `我：第 <r> 名（<你的 publicId>，<p> 分，段位 <t>）`（未登录状态走空页兜底，不会出现伪造名次） |
| 13 | 刷新浏览器（F5） | 两屏 | 批次与榜单清空（不落盘） |

---

## 12. 定稿判定（总纲 §2.5 四项）

本批**不自署**四项结论；判定结论由独立上下文审查记录 `docs/reviews/F7.md` 出具。

---

## 13. 已知未覆盖 / 已知风险（不得为空）

| # | 项 | 说明 |
|---|---|---|
| R-1 | 人工走查未覆盖"`shortfall>0` + 重放批次"两条边缘 | 需要构造薄池与同 seed 二次请求；机器侧由 TB-4/TB-5 覆盖，人工留待用户在真实多人环境顺手验证 |
| R-2 | 不接 `/ranked/promote` | 见 §2 反驳 4：它是"只判定不落盘"的端点，接上会误导；晋升状态一律读 `/ranked/run` 的 `promoted`/`tierAfter` |
| R-3 | 不显示"距离晋升还差几胜" | 后端不提供该数据（无阈值/次段位/剩余场次字段）⇒ 前端不编；用户走查时若需要，须先升级后端契约（新 D 编号） |
| R-4 | 榜单不做"我的名次跳转" | 只显示名次数字，不提供"跳到我的位置"（需要 offset = rank-1 的额外请求；F7 不含，登记为后续可选） |
| R-5 | `总人数` 上限 | 服务端单页 ≤100 行、offset 无上限，但超大账号量下每页都全量排序（既有实现，登记为 `docs/security-backlog.md` 的性能项而非本批缺陷）。**审查 F7-A/F7-B 修掉的是"缓存漏失效"与"迁移不收敛"两个真缺陷**（见 §9 与 `docs/reviews/F7.md`），与排序复杂度无关 |
| R-8 | 锦标赛屏不显示"距离晋升还差几胜" | 后端无该数据（见 §13 R-3） |
| R-9 | 前端**不缓存**历史批次 | 翻回上一批需重新 `POST /ranked/run`（同 seed 幂等 → 拿到同一批的"重放"响应：`results[]` **无 `frames`**，靠「看这一场」自动读回放；已在 §8 T-4 与 TB-5 覆盖） |
| R-6 | 段位榜的"到达时间"语义 | `tierUpdatedAt` 是**最后一次段位变化**的时间（含升与降/管理端改档），不是"首次到达该段位"的时间；如实显示为 `到达`，并在此声明 |
| R-7 | 未接 `/me/records`、`/me/defense` | 战绩/防守列表属后续批次；本批只做"刚打完的这一批"与两张榜 |

---

## 14. 实施与对账

- 实施顺序：**后端 D-171**（`index-file.js` → `adapter-json.js` → `quickmatch.js` → `index.js` → 契约测试 LB-3…LB-7 / CN-12）→ 前端（`store.js` → `format.js` → `api.js` → `actions.js` → `render.js`+`app.js` 的 `data-tier` → `contract.js`）→ 测试（`tournament-board-flow.test.js` + 四处登记同步）→ 文档（本文件 + D-171 + `interfaces.md` / `systems/11` / `server.md` / `tasks.md` / `progress.md`）。
- 对账（实现完成后逐条回填）：
  - §1 端点映射：`ranked/run` ✅ / `leaderboard` ✅（D-171）/ `replay/:id` ✅ 复用；`ranked/promote` ⛔ 显式不做
  - §4 动作 10 个 ✅（AU-1/UI-2 双向断言）
  - §5 字段 19 条 + 3 组子对象 ✅（FC-1/FC-2/FC-3 + TB-6）
  - §6 失败路径 ✅（TB-4/TB-5 + 文案表）
  - §9 后端 D-171 ✅（LB-3…LB-9 + CN-12）
  - §10 独立审查 `docs/reviews/F7.md` 的 P1（F7-A 封禁缓存漏失效、F7-B 迁移不收敛）与 P2（F7-C 文档口径、F7-D 页号回退、F7-E 死分支）**已逐条修复**，并新增 **LB-8/LB-9/TB-11/TB-12** 回归 ✅
