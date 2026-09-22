# F1 设计与实现冻结：登录与注册

> 版本：v1　创建：2026-09-20　状态：**设计已冻结（§2.5 四项判定全过）；实现与机器核对已落地；人工走查见 `docs/reviews/F1.md`**
> 依据：`docs/frontend/00-rules.md`（总纲，§2 协作协议 / §1 绘制边界 / §4 验收机制）；`docs/tasks.md` §7（仍生效约束）；`docs/interfaces.md` §2（接口唯一权威）；`docs/systems/11-account-store.md`（账号与存档权威设计）。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md` > `docs/frontend/*`。
> 定位：本文件是 **P6 批次 `F1`（登录与注册）的唯一实现依据**。屏幕清单、按钮↔动作白名单、字段来源契约三者只在本文件与本批代码里各出现一次。

---

## 1. 范围与端点 UI 映射（规则 4.3）

| # | `docs/interfaces.md` §2 端点 | 本批 UI 路径 | 状态 |
|---|---|---|---|
| 1 | `POST /api/v1/auth/register` | 「注册」屏 → 按钮「注册」 | ✅ 本批实现 |
| 2 | `POST /api/v1/auth/login` | 「登录」屏 → 按钮「登录」 | ✅ 本批实现 |
| 3 | `POST /api/v1/auth/logout` | 「主页」屏 → 按钮「登出」 | ✅ 本批实现 |
| 4 | `POST /api/v1/auth/password`（别名 `/auth/change-password`） | 「设置密码」屏 → 按钮「提交改密」 | ✅ 本批实现（= Q2 结论 A：仅登录后改密） |
| 5 | `GET /api/v1/me` | 启动自检（校验本地 token）+「主页」屏档案摘要 + 按钮「刷新」 | ✅ 本批实现 |
| 6 | `POST /api/v1/auth/logout` 之外的 `/auth/*` | — | 无（`/auth/*` 仅上述 4 条） |
| 7 | `GET /api/v1/health` | — | ⛔ **本轮不做**（运维探活，非玩家动作） |
| 8 | `GET /api/v1/unlock`｜`GET /api/v1/data/:table` | — | ⛔ **本轮不做**（后续批次：内容/编辑器） |
| 9 | `POST /api/v1/box`｜`GET /api/v1/warehouse`｜`POST /api/v1/warehouse/assemble\|disassemble` | — | ⛔ **本轮不做**（后续批次：开箱与仓库） |
| 10 | `GET/POST /api/v1/loadout`｜`POST /api/v1/panel` | — | ⛔ **本轮不做**（后续批次：出战配置） |
| 11 | `POST /api/v1/ai/validate\|compile\|battle` | — | ⛔ **本轮不做**（后续批次：AI 编辑器） |
| 12 | `POST /api/v1/battle`｜`GET /api/v1/replay/:id` | — | ⛔ **本轮不做**（后续批次：对战与回放） |
| 13 | `POST /api/v1/ranked/run\|promote`｜`POST /api/v1/quick/run`｜`GET /api/v1/leaderboard` | — | ⛔ **本轮不做**（后续批次：排位/快速对战/排行榜） |
| 14 | `GET /api/v1/me/configs*`｜`PUT /api/v1/me/nickname`｜`PUT/GET /api/v1/me/warehouse`｜`GET /api/v1/me/records`｜`POST /api/v1/me/records/seen`｜`GET /api/v1/me/defense` | — | ⛔ **本轮不做**（后续批次：配置槽/战绩/仓库镜像） |
| 15 | `POST /api/v1/admin/:op`｜`GET/POST /api/v1/log-level` | — | ⛔ **本轮不做**（运维面，非玩家动作；规则 4.3 显式登记） |

**非目标**（本批明确不做，避免范围蔓延）

1. 不做「忘记密码 / 免登录重置」——后端无该端点，且无邮件设施（Q2 结论 A）。若将来要做，须按总纲 §2.7 先走决策记录 + `docs/interfaces.md` 变更。
2. 不做昵称修改（属 `PUT /me/nickname`，后续批次）；本批注册屏只在注册时提交 `nickname`。
3. 不做样式、动画、布局与视觉呈现（总纲 §1.1）；不引入画布/图形/精灵（§1.2）。
4. 不做 URL 路由/可分享链接（见 §2 模式选择理由）。
5. 不做多语言（界面文字为简体中文，与 `docs/interfaces.md` 的既有中文错误文案一致）。

---

## 2. 采用的模式与被否决的替代（总纲 §2.5 ①）

**采用：单页 + 单向数据流（Redux 风格）——纯函数 `render(state) → HTML` 字符串、自研 store（`dispatch` + 订阅）、事件委托、单一网络出口、单一 DOM 写入点、状态机式视图切换（`state.view`）。**

为什么是行业主流做法：该形态是 D-124「无框架 + 纯 DOM 视图（`state → 节点描述`）+ 自研 store」的直接落地，与 `shared/log.js` 已验证的零依赖双模（浏览器 / Node 可 `require`）同源，因而**视图与投影可无头测试**——正是规则 4.1/4.2 要求的「机器可判定」的前提。

被否决的替代方案：

| 替代 | 否决理由 |
|---|---|
| 引入 React/Vue 等框架 | 违反 D-124（无框架）与零依赖约束（`package.json` 无 `dependencies`） |
| 每屏一个独立 HTML 页面 + 传统表单提交/跳转 | 后端是 JSON 信封 + `Authorization: Bearer`（无 Cookie 会话），页面级跳转无法携带 token，必须由 JS 发请求 |
| 服务端渲染（SSR）模板 | 后端零依赖且无模板引擎；且会新增 `/api/v1` 之外的渲染契约，违反「后端契约不可前端私改」 |
| `hash` 路由（`#/login`） | 本批无「可分享 URL / 深链」需求；状态机视图待定项更少、无 URL 解析分支；将来需要时另立决策 |
| `file://` 直接打开前端（不做静态托管） | 实测不可用：`file://` → `http://127.0.0.1:3000` 属跨源且服务端默认不发 CORS 头，浏览器直接拦截 `fetch` |
| 把 token 存 Cookie（HttpOnly） | 后端无 Set-Cookie 会话语义（`docs/interfaces.md:103` 明确 Bearer）；改用 Cookie 属**后端契约变更**，须走决策记录 |

**模块清单（`public/`，9 个文件；`tests/frontend/auth-ui-contract.test.js` 的 UI-1 断言磁盘清单与此逐字一致）**

| 文件 | 职责 | 硬约束（机器核对） |
|---|---|---|
| `index.html` | 唯一外壳；`#view` 挂载点；无内联脚本 | — |
| `store.js` | 自研状态容器（纯 reducer + 订阅） | 不读响应字段 |
| `format.js` | **投影单一真源**：字段读取 + 四屏视图模型 + 文案 | 唯一持有 `pick(env, '<路径>')` 的文件 |
| `render.js` | 纯渲染 `render(vm) → HTML` | 零逻辑：无字段读取、无 `state`、无请求 |
| `actions.js` | **按钮↔动作白名单**（9 个）+ 客户端预校验 | 不读响应字段、不碰 DOM |
| `api.js` | **单一网络出口** | 全前端唯一 `fetch(`；不解释信封 |
| `app.js` | 装配 + **单一 DOM 写入点** + 事件委托 + `localStorage` | 全前端唯一 `innerHTML` |
| `boot.js` | 浏览器引导（避免内联脚本） | 不写 DOM、不发请求 |
| `contract.js` | 字段来源契约声明（38 条）+「不读取字段」清单 | 供测试与文档三方核对 |

---

## 3. 屏幕清单（文本规格，总纲 §1.2/§1.4）

四屏共用一个 `index.html` 外壳；`#view` 是**唯一 DOM 写入点**。所有由数据派生的文字一律来自 `public/format.js`（**投影单一真源**），`public/render.js` 只把已生成的字符串放进标签，**不得再查状态、再算公式、再拼字符串**（§1.4「绘制方法零逻辑」）。

### 3.1 屏 `login`（登录）

- 静态文字：`Debug-Lite v3 · 账号`（页面标题）／`登录`（屏标题）／提示行 `用户名 3~24 字符，仅 [A-Za-z0-9_-]；密码 8~72 字符`。
- 输入框：`用户名`（单行文本，`id=input-username`）／`密码`（单行密码，`id=input-password`）。
- 按钮：`登录`（动作 `submit-login`）／`去注册`（动作 `goto-register`）。
- 状态文本区：`#notice`（显示已投影好的提示/错误文字；无内容时不渲染该行）。
- 进入条件：应用启动后无有效会话；或从其它屏主动返回；或收到 401 时被强制切回。

### 3.2 屏 `register`（注册）

- 静态文字：屏标题 `注册`；提示行 `用户名 3~24 字符，仅 [A-Za-z0-9_-]；密码 8~72 字符；昵称可留空，最长 16 字符`。
- 输入框：`用户名`／`密码`／`确认密码`／`昵称（可留空）`。
- 按钮：`注册`（动作 `submit-register`）／`返回登录`（动作 `goto-login`）。
- 状态文本区：`#notice`。

### 3.3 屏 `home`（已登录：档案摘要）

- 静态文字：屏标题 `已登录`。
- 文本区（全部由 `format.homeLines()` 产出，逐行渲染）：账号 / 昵称 / 段位 / 峰值段位 / 积分 / 场次与胜负平 / 出战槽 / 配置槽清单 / 未读（进攻·防守）/ 是否在匹配池 / 仓库校验状态 / 是否机器人 / 会话到期时间。
- 按钮：`刷新档案`（动作 `refresh-profile`）／`设置密码`（动作 `goto-password`）／`登出`（动作 `logout`）。
- 进入条件：注册或登录成功；或启动时本地 token 经 `GET /me` 校验通过。

### 3.4 屏 `password`（设置密码 / 改密）

- 静态文字：屏标题 `设置密码`／提示行 `新密码 8~72 字符；改密成功后其他设备的会话会被撤销`。
- 输入框：`原密码`／`新密码`／`确认新密码`。
- 按钮：`提交改密`（动作 `submit-password`）／`返回主页`（动作 `goto-home`）。
- 状态文本区：`#notice`。

---

## 4. 按钮 ↔ 动作白名单（总纲 §4.1「按钮永不无声」）

`public/actions.js` 的 `ACTIONS` 是**唯一动作注册表**；`public/render.js` 产出的每个 `data-action` 必须命中它（双向：不存在「注册了但没实现」，也不存在「实现了但无入口」）。机器核对见 §10.2。

| 动作名 | 触发控件（屏） | 行为 | 成功结果（可见文本） | 失败结果（可见文本） |
|---|---|---|---|---|
| `submit-login` | 登录屏·`登录` | `POST /auth/login` | 写入会话 → 切 `home`，显示 `登录成功：<昵称>（<账号>）` | 停留登录屏，`#notice` 显示服务端文案（如 `用户名或密码错误`），**并清空密码框**（保留用户名；见 §8 B-14） |
| `submit-register` | 注册屏·`注册` | 客户端预校验 → `POST /auth/register` | 写入会话 → 切 `home`，显示 `注册成功：<昵称>（<账号>）` | 停留注册屏，`#notice` 显示服务端文案（如 `用户名已被占用（大小写不敏感）`），**并清空两个密码框**（保留用户名/昵称） |
| `goto-register` | 登录屏·`去注册` | 切屏 `register`，清空 `#notice` | 显示注册屏 | 无（不可失败） |
| `goto-login` | 注册屏·`返回登录` | 切屏 `login`，清空 `#notice` | 显示登录屏 | 无 |
| `goto-password` | 主页·`设置密码` | 切屏 `password`，清空密码输入与 `#notice` | 显示设置密码屏 | 无 |
| `goto-home` | 设置密码屏·`返回主页` | 切屏 `home`，清空 `#notice` | 显示主页 | 无 |
| `submit-password` | 设置密码屏·`提交改密` | 客户端预校验（新密码两次一致）→ `POST /auth/password` | 停留本屏，显示 `改密成功：已撤销其他设备会话 <n> 个`（`n` 取 `revokedOthers`） | 停留本屏，`#notice` 显示 `原密码错误` / 密码规则文案，**并清空三个密码框** |
| `logout` | 主页·`登出` | `POST /auth/logout` → 清本地会话 | 切 `login`，显示 `已登出` | 即使请求失败也**清本地会话并切 `login`**，显示 `已登出（服务端未确认：<原因>）` |
| `refresh-profile` | 主页·`刷新档案` | `GET /me` | 更新文本区，显示 `档案已刷新` | 显示服务端文案；401 时按 §6 强制登出 |

**输入框提交**：四屏的表单均支持 `Enter` 键提交（`<form>` 的 `submit` 事件委托到对应 `submit-*` 动作）——「输入框 + 回车」也是玩家动作，故一并纳入白名单核对（`data-enter` 属性指向动作名）。

---

## 5. 字段来源契约（总纲 §4.2「字段名不得来自散文」）

- 投影函数（`public/format.js`）一律接收**完整响应信封**（`{ok:true,data}|{ok:false,error}`），只用 `pick(envelope, '<路径>')` 读取字段。
- 下表路径**逐条来自 2026-09-20 实测真实 HTTP 响应**（探针抓取，见 §10.1 的回归手段）；`docs/frontend/01-auth.md` 本表、`public/contract.js`、`public/format.js` 的 `pick()` 字面量三者由测试强制一致。

| 端点 | 字段路径 | 本批用途 |
|---|---|---|
| `POST /auth/register`、`POST /auth/login` | `data.publicId` | 会话·账号显示 |
| 同上 | `data.nickname` | 会话·昵称显示 |
| 同上 | `data.token` | 写入 `localStorage['dl.token']` |
| 同上 | `data.expiresAt` | 会话到期时间文本 |
| 同上 | `data.player.tier` | 登录后主页段位（首屏即时显示，无需等 `/me`） |
| 同上 | `data.player.points` | 登录后主页积分 |
| 同上 | `data.player.activeSlotName` | 登录后主页出战槽名 |
| `GET /me` | `data.publicId` | 账号 |
| `GET /me` | `data.nickname` | 昵称 |
| `GET /me` | `data.progress.tier` | 段位 |
| `GET /me` | `data.progress.peakTier` | 峰值段位 |
| `GET /me` | `data.rating.points` | 积分 |
| `GET /me` | `data.rating.games` | 总场次 |
| `GET /me` | `data.rating.wins` | 胜 |
| `GET /me` | `data.rating.losses` | 负 |
| `GET /me` | `data.rating.draws` | 平 |
| `GET /me` | `data.activeSlotId` | 出战槽 id |
| `GET /me` | `data.activeSlotName` | 出战槽名 |
| `GET /me` | `data.slots` | 配置槽清单（数组，逐项取 `slotId`/`name`/`isDefault`） |
| `GET /me` | `data.pool.inPool` | 是否在匹配池 |
| `GET /me` | `data.pool.drawnCount` | 被抽次数 |
| `GET /me` | `data.record.stats.attack.wins` | 进攻·胜 |
| `GET /me` | `data.record.stats.attack.losses` | 进攻·负 |
| `GET /me` | `data.record.stats.attack.draws` | 进攻·平 |
| `GET /me` | `data.record.stats.defense.wins` | 防守·胜 |
| `GET /me` | `data.record.stats.defense.losses` | 防守·负 |
| `GET /me` | `data.record.stats.defense.draws` | 防守·平 |
| `GET /me` | `data.record.unread.attack` | 未读进攻战绩数 |
| `GET /me` | `data.record.unread.defense` | 未读防守战绩数 |
| `GET /me` | `data.flags.unverifiedLoadout` | 仓库校验状态文本 |
| `GET /me` | `data.flags.isBot` | 是否机器人 |
| `POST /auth/password` | `data.changed` | 改密是否生效 |
| `POST /auth/password` | `data.revokedOthers` | 已撤销的其他会话数 |
| `POST /auth/logout` | `data.revoked` | 登出是否生效 |
| 任意端点（信封根） | `ok` | 成功 / 失败判定（信封根字段，唯一分支依据） |
| 任意端点的错误分支 | `error.code` | 错误分类与文案选择（§6） |
| 同上 | `error.message` | 默认展示文案（服务端中文文案） |
| 同上 | `error.details` | 逐条字段级错误（取首条的 `path`，拼进文案尾部 `（字段：…）`） |

**不读取的字段**（明确登记，防止"散文式字段"）：`data.player.playerId`、`data.record.appliedSeq`、`data.pool.lastDrawnAt`、`data.flags.banReason`、`data.progress.lastBatchId`、`player.publicId` 以外的身份字段。响应中的 `playerId` 经服务端 `stripPlayerId()` 脱敏后**根本不存在**（实测确认）。

---

## 6. 全部失败路径 → 可见文本（总纲 §2.5 ③）

`code`/`HTTP` 列取自实测响应与 `docs/server.md` §4 错误码总表。文案策略：**默认直接展示服务端 `error.message`**（服务端文案已是玩家可读的中文），仅在下表「界面附加文案」非空时前置一句更具体的指引。

| code | HTTP | 触发 | 落点屏 | 界面附加文案 | 副作用 |
|---|---|---|---|---|---|
| `username_taken` | 409 | 注册重名（大小写不敏感） | register | `换个用户名试试` | 无 |
| `weak_password` | 400 | 密码 8~72 字符 / ≤256 字节不满足 | register、password | `密码需 8~72 字符` | 无 |
| `bad_request` | 400 | 用户名 3~24 且仅 `[A-Za-z0-9_-]`；昵称超长；字段缺失 | register | `检查用户名与昵称格式` | 无 |
| `invalid_credentials` | 401 | 登录用户名/密码错；改密原密码错 | login、password | `注意：密码区分大小写，且不要有多余空格或全角字符`（2026-09-22 实测：7 位密码 / 全角数字 / 末尾空格都会落到本码，服务端文案无法区分，故补可排查指引） | **清空密码类输入框**（§8 B-14） |
| `too_many_attempts` | 429 | 登录失败锁定（5 次 / 5 分钟） | login | `稍后再试` | 无 |
| `rate_limited` | 429 | 全局限速（600 次/分/principal） | 任意 | `请求过于频繁` | 无 |
| `unauthorized` / `session_expired` | 401 | 本地 token 缺失/失效/过期 | 任意（含启动自检） | `会话已失效，请重新登录` | **清本地会话 → 切 login** |
| `banned` | 403 | 档案被封禁 | 任意 | `账号已被封禁` | 清本地会话 → 切 login |
| `payload_too_large` | 413 | 请求体 > 1MB | 任意 | `输入过长` | 无 |
| `store_unavailable` | 503 | 服务未装配档案存储 | 任意 | `服务暂不可用（存储未启用）` | 无 |
| `internal_error` | 500 | 服务端异常 | 任意 | `服务端内部错误` | 无 |
| （网络层失败，无响应） | — | `fetch` 抛错 / 服务未启动 | 任意 | `无法连接服务器：<原因>` | 无 |
| （客户端预校验） | — | 必填为空 / 两次密码不一致 / 用户名或密码格式不符 | register、password | `请填写用户名与密码` / `两次输入的密码不一致` / 格式文案 | 不发请求 |

**401 的统一处理**（一处实现，`public/actions.js` 的 `ensureSession`）：任何经鉴权的调用返回 401 → 清 `dl.token`/`dl.session` → 切 `login` → `#notice` = `会话已失效，请重新登录`。

---

## 7. 状态、reducer 与持久化

### 7.1 状态形状（`public/store.js` 的 `initialState()`）

```js
{
  view: 'login',        // 'login' | 'register' | 'home' | 'password'
  form: { username:'', password:'', confirm:'', nickname:'', oldPassword:'', newPassword:'', newConfirm:'' },
  session: { token:null, publicId:null, nickname:null, expiresAt:null },   // 明文只在内存 + localStorage
  auth: null,           // 最近一次 register/login 的**完整信封**（首屏即时显示；/me 返回后由 profile 取代）
  profile: null,        // GET /me 的**完整信封**（投影在 format.js）
  notice: null,         // { kind:'info'|'error', text:string } —— text 已是最终文案
  busy: false,          // 请求进行中：按钮 disabled，防重复提交
  booted: false         // 启动自检完成
}
```

### 7.2 reducer 动作（纯函数，`store.js` 的 `reducers`）

| 动作 | 载荷 | 语义 |
|---|---|---|
| `form.set` | `{field, value}` | 写单个输入框 |
| `form.clear` | `['password','confirm',…]` | 清空指定输入框（切屏/成功后） |
| `view.go` | `view` | 切屏（唯一视图切换点） |
| `session.set` | `{token,publicId,nickname,expiresAt}` | 写入会话 |
| `session.clear` | — | 清空会话 |
| `auth.set` | 信封 \| null | 写入最近一次登录/注册响应（首屏即时显示） |
| `profile.set` | 信封 \| null | 写入档案摘要响应 |
| `notice.set` | `{kind,text}` \| null | 写入提示文本（已投影） |
| `busy.set` | `boolean` | 请求中标志 |
| `booted.set` | `boolean` | 自检完成 |

### 7.3 持久化（Q4 结论 A：localStorage）

| 键 | 内容 | 说明 |
|---|---|---|
| `dl.token` | `data.token` 原值 | 唯一凭据；所有鉴权请求经 `Authorization: Bearer` |
| `dl.session` | `JSON.stringify({publicId,nickname,expiresAt})` | 仅用于**首屏即时显示**；真伪一律以 `GET /me` 为准 |
| `dl.expiresAt` | 不需要（已含在 `dl.session`） | — |

启动自检（`boot`）：读 `dl.token` → 无 → `login`（`booted=true`）；有 → `GET /me` → 200 → `home` + `profile`；401 → 清本地 → `login` + `#notice='会话已失效，请重新登录'`；网络失败 → `login` + `#notice='无法连接服务器：…'`（**不**清 token，允许稍后刷新重试）。

`localStorage` 不可用（隐私模式抛错）时降级为内存会话并显示 `本机浏览器禁用了本地存储：刷新后需重新登录`。

---

## 8. 边界条件（总纲 §2.5 ④）

| # | 边界 | 行为 |
|---|---|---|
| B-1 | 输入框为空 | 客户端预校验拦下，不发请求，`#notice` 提示必填 |
| B-2 | 用户名含非法字符 / 长度越界 | 客户端预校验（与服务端同规则：3~24、`[A-Za-z0-9_-]`）；服务端仍为权威 |
| B-3 | 密码 < 8 或 > 72 字符 / UTF-8 > 256 字节 | 客户端预校验长度；字节上限交给服务端（`weak_password`） |
| B-4 | 两次密码不一致（注册/改密） | 客户端拦下，不发请求 |
| B-5 | 昵称超长（> 16） | 客户端拦下（服务端会夹到 ≤16，本批以前端提示为准，避免"静默截断"） |
| B-6 | 请求进行中重复点击 | `busy=true` 时按钮 `disabled`，动作入口直接返回 |
| B-7 | `fetch` 抛错（服务未启动 / 断网） | `#notice` 显示 `无法连接服务器：<原因>`，**保留**已填表单（传输失败不清任何输入，用户直接重试） |
| B-8 | 任意鉴权调用返回 401 | 统一登出（§6） |
| B-9 | 改密成功后旧 token | 服务端保留当前会话（`keepSession:true`）、撤销其他会话；前端**继续使用当前 token**，不强制重登；提示 `已撤销其他设备会话 n 个` |
| B-10 | 登出请求失败 | 本地会话照清、切 `login`（登出是"本地意图"，不因网络失败而失败） |
| B-11 | 同一 token 在新标签打开 | 因 localStorage 共享，另一标签不会自动登出（无跨标签同步，本批不做） |
| B-12 | 昵称留空 | 允许；服务端回带默认昵称，界面显示服务端返回的 `nickname` |
| B-13 | 中文/emoji 输入 | 请求体按 UTF-8 发送；响应按 `Buffer` 整段解码（服务端已有该修复） |
| B-14 | 业务失败（服务端返回错误信封）后的输入框 | **清空当前屏的密码类输入框**（登录屏 `password`；注册屏 `password`+`confirm`；设置密码屏三个），**保留**用户名与昵称。理由（2026-09-22 实测）：密码框残留旧值时，用户再次输入会变成"追加"，得到一个与真实密码不同的字符串，表现为反复 `invalid_credentials`；网络失败不清（B-7） |
| B-15 | 用户名首尾含空格（复制粘贴常见） | 校验与提交一律用 `trim()` 后的值；`'  '` 视为空 → 预校验拦下。密码**不** trim（允许含空格是合法密码语义，故改为在失败文案里提示排查，见 §6） |

---

## 9. 静态托管契约（O-7 落地：结论 A＝同源静态托管）

改动落在 `server/index.js`（L6），**不新增 `/api/v1` 端点、不改任何既有端点语义**。

| 规则 | 内容 |
|---|---|
| 生效方法 | 仅 `GET`（`POST` 等非 API 路径仍返回既有 404 `unknown_endpoint`） |
| 生效范围 | 仅 `public/` 目录（`server/index.js` 的 `PUBLIC_DIR`，可用 `start({publicDir})` 覆盖——测试缝） |
| 路径映射 | `/` → `public/index.html`；`/<相对路径>` → `public/<相对路径>` |
| 扩展名白名单 | `.html` `.js` `.css` `.json` `.svg` `.ico`（其余一律**不**由静态分支处理） |
| 穿越防护 | 解码后拒绝空段/`..`/`\0`；`path.resolve` 后必须仍位于 `publicDir` 前缀内；失败 → 落到既有 404 `unknown_endpoint` |
| 响应头 | `content-type` 按扩展名；`cache-control: no-store`（开发期避免旧资源） |
| 优先级 | `/api/v1/*` 与动态路由（`/data/:table`、`/replay/:id`、`/admin/:op`、`/me/configs/:slotId`）**先于**静态分支；静态分支插在"最终 404"之前 |
| 日志 | 复用既有 `api.req` / `api.res`（**不新增日志事件**，避免改动日志矩阵与门禁项 6） |
| 目录不存在 | `public/` 缺失 → 静态分支整体不生效（行为与改动前逐字一致） |
| 架构检查 | `public/**` 不在 `scripts/check-arch.js` 的 `SCAN_ROOTS` 内；本轮**不**扩展 L7 分层登记（O-7 的剩余部分） |

---

## 10. 机器核对（总纲 §4.1 / §4.2 的"机器可判定"手段）

测试全部落在 `tests/frontend/`（**不使用**已删除的旧 `tests/frontend/*` 内容，全部重写）。

### 10.1 `auth-field-contract.test.js` —— 字段名可追溯到真实响应
1. 用 `tests/helpers/http.js` 起**真实服务**（临时 `DL_DATA_DIR` + 快速 scrypt），按注册/登录/改密/登出/`/me` 顺序发真实 HTTP 请求并抓取原始 JSON。
2. 断言 `public/contract.js` 声明的每条路径在上述真实响应中**可解析存在**。
3. 断言 `public/format.js` 中 `pick('...')` 字面量集合 == 契约路径集合（双向：不多读、不少读）。
4. 断言 `docs/frontend/01-auth.md` §5 表格里出现的反引号路径集合 == 契约路径集合（文档↔代码不漂移）。

### 10.2 `auth-ui-contract.test.js` —— 按钮永不无声 + 投影单一真源
1. 对四屏逐一 `render(state)`，正则提取所有 `data-action` 与 `data-enter`，断言其集合 == `Object.keys(ACTIONS)`（双向）。
2. 断言每个 `ACTIONS[x].run` 是函数（不存在"注册了但没实现"）。
3. 断言 `public/render.js` 源码中 `pick(` 出现次数为 **0**（渲染层零逻辑）。
4. 断言 `public/format.js` 之外的 `public/*.js` 不出现契约字段路径字面量（投影单一真源）。
5. 断言 `fetch(` 只出现在 `public/api.js`（单一网络出口）；`document.` 写入只出现在 `public/app.js`（单一 DOM 写入点）。

### 10.3 `auth-flow.test.js` —— 真实 HTTP 全流程（无头驱动同一套动作代码）
用真实服务 + `public/api.js` + `public/store.js` + `public/actions.js`（`fetch` 由 Node 提供）跑通：
注册 → 主页文本含新账号 → 改密成功（含 `revokedOthers` 文本）→ 登出 → 旧 token 失效（401 → 自动登出切 login）→ 重登（用新密码）→ 失败路径（重名 409、弱密码 400、原密码错 401、无 token 401）逐条断言 `#notice` 文案。

### 10.4 `static-hosting.test.js` —— 托管契约
`GET /` → 200 `text/html`；`GET /app.js` → 200（`javascript`）；`GET /nope.js` → 404 `unknown_endpoint`；`GET /../package.json`、`/..%2Fpackage.json`、`/a/../../package.json` → 404；`POST /` → 404 `unknown_endpoint`；`GET /api/v1/bogus` → 仍为 404 `unknown_endpoint`（回归保护，`tests/api/api.test.js` AP-4/AP-7 亦覆盖）。

---

## 11. 人工走查剧本（总纲 §4.4；结论记入 `docs/reviews/F1.md`）

前置：`npm start`（默认 `http://127.0.0.1:3000`），浏览器打开 `http://127.0.0.1:3000/`。

| 步 | 点哪里 | 看什么 | 期望文本 |
|---|---|---|---|
| 1 | 地址栏 | 登录屏 | 标题 `登录`，可见 `用户名`/`密码` 输入框与 `登录`/`去注册` 按钮 |
| 2 | 直接点 `登录`（空输入） | `#notice` | `请填写用户名与密码`；**未发请求** |
| 3 | 点 `去注册` | 注册屏 | 标题 `注册`，四个输入框 |
| 4 | 填 `alice` / `pw12345678` / 同 / 昵称留空 → 点 `注册` | 主页 | 出现 `注册成功：…`、`账号：u_…`、`段位：common`、`积分：0` |
| 5 | 点 `刷新档案` | 主页文本 | `档案已刷新`，出现 `配置槽`、`战绩`、`未读` 行 |
| 6 | 点 `设置密码` | 设置密码屏 | 三个输入框 + `提交改密`/`返回主页` |
| 7 | 新密码填 `short` → 点 `提交改密` | `#notice` | `密码需 8~72 字符`（**客户端预校验**，未发请求；§8 B-3） |
| 8 | 新密码与确认不一致 → 点 `提交改密` | `#notice` | `两次输入的密码不一致`；**未发请求** |
| 9 | 原密码填错、新密码合法 → 点 `提交改密` | `#notice` | `原密码错误` |
| 10 | 原密码正确、新密码 `pw87654321` → 点 `提交改密` | `#notice` | `改密成功：已撤销其他设备会话 n 个` |
| 11 | 点 `返回主页` → `登出` | 登录屏 | `已登出` |
| 12 | 用新密码 `pw87654321` 登录 | 主页 | `登录成功：…` |
| 13 | 刷新浏览器（F5） | 主页 | **仍处于登录态**（本地 token 生效，直接显示档案摘要） |
| 14 | 手工把 `localStorage['dl.token']` 改成 `x` 后刷新 | 登录屏 | `会话已失效，请重新登录：会话不存在或已失效`（= §6 的「附加指引：服务端 message」拼接口径） |
| 15 | 注册同一用户名 `alice` | 注册屏 `#notice` | `用户名已被占用（大小写不敏感）` |
| 16 | 关闭 `npm start` 的服务，点 `登录` | `#notice` | `无法连接服务器：…`（表单内容保留） |
| 17 | 密码故意输错 → 点 `登录` | `#notice` + 输入框 | `注意：密码区分大小写，且不要有多余空格或全角字符：用户名或密码错误`；**密码框已被清空**、用户名仍在（B-14） |

---

## 12. 定稿判定（总纲 §2.5 四项）

| 项 | 判定 | 证据 |
|---|---|---|
| ① 行业主流做法（点名模式 + 被否决替代） | ✅ | §2（单向数据流 + 纯 render + 事件委托 + 单一出口；6 个替代方案逐条列否决理由） |
| ② 既有约束下合理 | ✅ | 无框架/零依赖（D-124）；不复制战斗公式（本批不涉战斗）；无 `/api/v1` 契约改动（§1/§9）；`public/**` 不在门禁扫描范围（§9） |
| ③ 功能完整（全部用户动作 + 全部失败路径） | ✅ | §3 四屏全部控件；§4 九个动作 + 回车提交；§6 十三条失败路径 + 预校验；§8 十三条边界 |
| ④ 已明确到可逐行实现 | ✅ | §5 字段路径逐条（实测响应）、§7 状态与 reducer 逐项、§6 文案与副作用逐条、§9 托管规则逐条；无待定项 |

**结论：允许写入实现**（本文件即冻结稿；此后如需变更，按总纲 §2.7/§3.4 同提交更新）。
