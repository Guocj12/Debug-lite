# F10 设计与实现冻结：前端地基（回退到文字+按钮 + 屏幕注册表）

> 版本：**v1**　创建：2026-10-04
> 状态：**用户已裁定范围**（2026-10-04 会话）；本文件是 `F10`（非编号批次，同 F3/F5/F6/F7/F9 处置）的唯一实现依据。
> 依据：`docs/frontend/00-rules.md`（总纲：§1 绘制边界 / §2 协作协议 / §4 验收机制）；`docs/frontend/07-layout-tool.md`（布局工具）；
> `docs/decisions.md`（**本批新增 D-180**）；`docs/interfaces.md` §2（端点唯一权威 —— **本批不动后端**）。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md` > `docs/frontend/*`。

---

## 0. 用户口径（2026-10-04，最高优先）

| # | 口径 | 落点 |
|---|---|---|
| ① | **回退到「只有文字和按钮」的干净状态** —— 除登录链以外的屏全部退回占位页 | §3 |
| ② | **先给完整前端打基础**（本批的真正交付物 = 屏幕注册表 + 门禁），之后用户**依次手工实现每个屏幕的完整布局** | §2 / §4 |
| ③ | **保留布局工具**（`tools/layout/**`）与**已经完成的主界面 UI 布局**（`hub` 布局表 + 引擎 + 样式） | §3.1 |
| ④ | **管理面板 / 账号列表一起清掉**，留成占位页 | §3.2（用户二选一：选「一起清掉」） |
| ⑤ | **主界面底部三颗补充入口全部清理掉**（刷新 / 阵容编辑 / 管理面板） | §3.3（用户口径：「都清理掉」） |
| ⑥ | **后端一律不动**（所有 `/api/v1` 端点保留，只是没有前端入口） | §5 |

> 口径 ⑤ 的直接后果：`hub` 布局表里的按钮**全部**由布局表承担；`format.hubViewModel` 不再追加任何 footer。
> 「按钮永不无声」（总纲 §4.1）由布局表的 `target`/`action` 与注册表双向核对保证，不再靠 footer 兜底。

---

## 1. 现状与目标（实测盘点）

### 1.1 现状（2026-10-04 复核，`git status` 干净）

| 文件 | 现状大小 | 现状职责 |
|---|---|---|
| `public/store.js` | 33 KB | 13 个 view + 11 个状态切片 + 70 余个 reducer case |
| `public/format.js` | 183 KB | 130 个函数；13 个屏的投影 + 布局投影 |
| `public/actions.js` | 118 KB | **111** 个注册动作 |
| `public/render.js` | 16 KB | 通用文字渲染 + 布局渲染 |
| `public/app.js` | 15 KB | 外壳（单一 DOM 写入点 + 事件委托） |
| `public/ai-editor.js` | 35 KB | AI 编辑器（旧 AST） |
| `public/ai-blueprint.js` | 22 KB | 积木节点模型 |
| `public/contract.js` | 30 KB | 字段契约（仅测试加载，不进浏览器） |
| `public/boot.js` / `index.html` / `app.css` | 1/1/3 KB | 引导 / 入口 / 样式 |

**渲染分流**：`render.js:230` 判 `vm.layout.layers` 有则走布局渲染；只有 `hub` 挂得上 layout（`format.js:3113`），其余 12 个 view 走通用文字渲染。

### 1.2 目标

| 文件 | 目标 | 变化 |
|---|---|---|
| `public/store.js` | ~11 KB | 4 个 view + 3 个状态切片 + ~15 个 reducer case |
| `public/format.js` | ~55 KB | ~45 个函数 |
| `public/actions.js` | ~22 KB | **19** 个注册动作（下表） |
| `public/render.js` | ~14 KB | 删掉只为被删屏存在的搬运块 |
| `public/app.js` | ~12 KB | 删掉被删屏的载荷键与 `change` 委托 |
| `public/ai-editor.js` / `ai-blueprint.js` | **删除** | 落地时归档（§3.2） |
| `public/contract.js` | ~8 KB | 只留 F1 + hub 布局契约 |
| `public/index.html` | 脚本清单 10 → 9 | 删两个 AI 文件 |
| `public/screens.js` | **新增** ~4 KB | 屏幕注册表（§2） |
| `tests/frontend/*` | 21 文件 → **8** 文件 | §4.1 |

**保留的 19 个动作**（口径 ⑤ 与各方裁决的结果）：

| 组 | 动作 |
|---|---|
| 登录链（F1，7） | `submit-login` `submit-register` `submit-password` `logout` `goto-register` `goto-login` `goto-password` |
| 导航（4） | `goto-hub` `goto-profile` `goto-home` `refresh-profile` |
| 布局（7） | `layout-open` `layout-switch-config` `layout-assemble` `layout-disassemble` `layout-activate` `layout-set-slot` `modal-close` |
| 兜底屏（1） | `refresh-layout`（**只服务 hub 的非布局兜底屏**，见 §3.4） |
| 占位页（1） | `goto-hub`（复用导航组。占位页的"返回主界面"就是它） |

> 相对现状，被删的动作组：管理面 17 / 旧配置编辑器 16 / 仓库+开包 6 / 设置 2 / 快速对战+查看器 10 /
> 锦标赛+排行 12 / AI 编辑器 37 / `goto-warehouse` `goto-quick` `goto-tournament` `goto-leaderboard`
> `goto-ai-editor` `goto-settings` `goto-admin`（布局表里的这 7 个入口按钮随口径 ⑤ 一并删） / `goto-records`（死按钮）。
> **`goto-records` 同时要从 `layout-bundle.raw.json` 的 hub 里删除该按钮**（否则布局表会引用不存在的动作 → FD-4 红）。

---
## 2. 交付物 A：屏幕注册表（本批的核心）

### 2.1 为什么需要它

现状下「加一个屏」要同时改 **5 处**（`store.VIEWS` / `format.viewModel` 分发 / `format` 投影 / `actions` 注册 / `contract` 字段），
且 `store.VIEWS` 与 `layout-data.screens` 之间**没有任何机器核对** —— 加屏/删屏不会被任何测试拦住。
布局表驱动的界面还必须额外改 `hubLayoutVm`（它把 `'hub'` 与 `hub.background` 写死了，`format.js:3068/3077`）。

### 2.2 契约

新增 `public/screens.js`（**零依赖双模模块**，与 `store.js`/`format.js` 同形态），导出**冻结**的 `SCREENS`：

```js
{
  '<view>': {
    title:   string,                  // 页面标题（<title> 与 <h2>）
    status:  'ready' | 'todo',        // todo = 占位页（本批除 hub/login/register/password/profile 外全是 todo）
    plan:    string | null,           // status==='todo' 时显示的"计划"说明（就地写清，不用编号体系）
    layout:  string | null,           // 若有：layout-data.screens 里的整屏名（走布局渲染）
    project: string | null,           // 若有：format.js 里投影函数的名字（status==='ready' 时必需）
    actions: string[],                // 该屏渲染集合 ⊆ 注册表（总纲 §4.1 双向核对用）
    data:    string[],                // 进屏读取的数据（文档用途；todo 屏必须为空 = 不做任何请求）
    back:    string | null,           // 占位页的返回目标（默认 'hub'）
  }
}
```

**不变量（全部由 §4 门禁机器核对）**：

- I-1 `Object.keys(SCREENS)` **逐条等于** `store.VIEWS`（顺序与内容都相等）。
- I-2 `status === 'ready'` ⇒ `project` 非 null 且 `format` 上确实存在该函数。
- I-3 `status === 'todo'` ⇒ `data` 为空数组 且 `project === null`（**占位页零请求**，总纲 FR-12）。
- I-4 `layout` 非 null ⇒ `layout-data.js` 的 `screens` 里有同名整屏。
- I-5 `actions` 的每个名字都在 `actions.js` 的 `ACTIONS` 里；反向：每个注册动作至少在**某屏**的 `actions` 里出现一次（无死动作）。
- I-6 `layout-data.screens` 里 `role === 'screen'` 的每一屏，都必须被某个注册表条目以 `layout` 引用（**反之亦然**）。
- I-7 `store.js` **不出现**屏名数组字面量（`VIEWS` 必须由注册表派生）。
- I-8 `format.js` 的 `viewModel` **不出现** `state.view === '<屏名>'` 形式的链式分发（必须查注册表）。

### 2.3 消费方改造（4 处）

| 文件 | 改法 |
|---|---|
| `public/store.js` | `var VIEWS = Object.freeze(Object.keys(require('./screens.js').SCREENS))`；**不再手写数组** |
| `public/format.js` | `viewModel(state)` 改为：查 `SCREENS[state.view]` → `status==='todo'` 走 `placeholderViewModel`；`layout` 非 null 走 `layoutScreenVm(state, view, busy)`；否则调 `SCREENS[view].project` |
| `public/format.js` | `hubLayoutVm` → **`layoutScreenVm(state, view, busy)`**：把写死的 `'hub'`（`:3068`）与 `hub.background`（`:3077`）改为按 `view` 取；`state.hub.modals` → `state.layoutModals`（**更名**，见 §2.4） |
| `public/app.js` | `payloadOf` 的键表收敛到 F1 + 布局两组；删掉 `change` 委托（只服务 AI 编辑器） |

### 2.4 状态更名（消歧义）

`state.hub` 现在同时承载「当前显示的出战配置」与「径向弹窗栈」两件事，而它其实**是布局渲染的通用状态**（任何布局屏都要用）。
本批更名为 `state.layout = { slot: 0, modals: [] }`，reducer `hub.slot.set`/`hub.modal.push`/`hub.modal.pop`/`hub.modals.clear`
更名为 `layout.slot.set`/`layout.modal.push`/`layout.modal.pop`/`layout.modals.clear`。
（**不做兼容别名**：本批是回退批，不留双名。）

---

## 3. 交付物 B：保留 / 删除清单

### 3.1 保留（用户口径 ③）

| 项 | 位置 |
|---|---|
| 布局工具全套 | `tools/layout/**`（lab.html / lab-server.js / import-layout.js / make-engine.js / asset-manifest.js / apply-assets.js / make-placeholder-assets.py / wire-assets-into-layout.js / art-spec.js / layout-bundle.raw.json / assets-manifest.json / placeholders.json） |
| 四条 npm 脚本 | `lab` / `layout:apply` / `assets:manifest` / `assets:apply` |
| 布局引擎 | `public/layout-engine.js`（生成物，digest `feb4900cd5a65392`） |
| **主界面布局表** | `public/layout-data.js` 的 `hub` 整屏 + 8 个弹窗 + 全部元素/素材绑定 |
| 布局样式 | `public/app.css` |
| 布局投影 | `format.js` 的 `setLayout`/`layoutReady`/`layIcon`/`layPluginIconKey`/`layItem`/`laySlotIndex`/`laySlotTypes`/`layCurrent`/`layPick`/`layFlat`/`layRows`/`layScreen`/`layInstalled`/`layoutScreenVm` |
| 布局动作（6） | `layout-open` / `layout-switch-config` / `layout-assemble` / `layout-disassemble` / `layout-activate` / `layout-set-slot` |
| 素材 | `public/assets/**`（154 个文件） |

### 3.2 删除（用户口径 ①④）

| 组 | 动作数 | `format.js` 待删函数（行号 = 当前文件） | `store.js` 待删 | 备注 |
|---|---|---|---|---|
| F2 管理面 | 17 | `adminNoticeText`(198) `statsText`(207) `rebuildText`(214) `botsText`(215) `clearBotsText`(218) `deleteAccountText`(219) `banText`(223) `patchText`(229) `rowValueOf`(243) `accountRows`(249) `accountsInfoText`(269) `accountsHasMore`(277) `adminViewModel`(3208) `accountsViewModel`(3238)；`ADMIN_HINTS`/`ADMIN_FORBIDDEN_TEXT` 常量 | `emptyAdmin` `ADMIN_VIEWS` `ADMIN_LIMITS` `ADMIN_FIELDS` `ADMIN_DEFAULT_*` `adminToken`/`admin` 切片 + 7 个 `admin.*` case | `goto-admin` 入口由布局表删除 |
| F3 旧出战配置编辑器 | 16 | `seqOf`(597) `isConfigPos`(602) `posLabelOf`(606) `itemTitle`(614) `skillsOf3`(621) `emptyLoadout`(628) `configSlotOf`(632) `draftForSlot`(639) `draftLoadoutOf`(648) `isActiveSlot`(660) `missingOf`(667) `missingMessageOf`(680) `missingSummaryText`(690) `detailListOf`(698) `isPositionDetailPath`(707) `detailSummaryText`(712) `configSaveFailText`(720) `configActivateFailText`(730) `pluginFailText`(741) `warehouseChangeEnvelope`(750) `updatedItemOf`(769) `itemAt`(775) `setItemAt`(785) `applySlotChoice`(795) `assemblyTargetOf`(810) `slotTypeAt`(820) `pluginCandidatesOf`(829) `pluginLabelOf`(839) `aiCandidatesOf`(850) `aiOptionOf`(861) `applyAiChoice`(869) `aiLabelOf`(881) `configStatusText`(890) `configEditorRows`(900) `configModal`(956) `loadoutUidsOf`(978) `otherConfigsOf`(1004) `usedElsewhereInDraft`(1018) `pluginEquippedOf`(1034) `candidateBlockReasonOf`(1051) `slotPickModal`(1059) `pluginPickModal`(1100) `aiPickModal`(1142) + `CONFIG_*` 常量 | `emptyConfigs` + `configs.*` 3 个 case | **例外：`layInstalled` 用 `pluginLabelOf`/`findItem`** → `pluginLabelOf` 需保留（§3.4） |
| F3/F8 仓库屏 | 6 | `bucketLabel`(345) `packageKindLabel`(351) `bucketItems`(356) `capOf`(365) `warehouseCapacityText`(372) `usageText`(379) `itemLabel`(394) `itemRows`(403) `slotLines`(425) `affixLines`(434) `exclusiveLines`(444) `itemDetailLines`(453) `packageResultLines`(511) `fullBucket`(540) `packageFullNotice`(551) `warehouseViewModel`(3143) + `BUCKET_*`/`EMPTY_WAREHOUSE_TEXT`/`PACKAGE_*`/`SKILL_SLOTS` 常量 | `emptyWarehouse` `emptyConfigs` 的 `warehouse`/`warehouseBucket`/`packages` 切片 + `warehouse.*`/`package.*` 4 个 case | `layRows` 依赖 `state.warehouse` → **保留** `warehouse.set` + `warehouse` 切片（§3.4） |
| F3 设置屏 | 2 | `settingsViewModel`(3179) + `nicknameOkText`(141) `NICKNAME_MAX_TEXT` 常量 | `SCREEN_FIELDS`/`NICKNAME_FIELD`/`emptySettings` + `screen.form.set`/`settings.set` | |
| F6 快速对战 + 查看器 | 10 | 帧/查看器投影 35 个（`pvpNoticeText`(1223) … `quickViewModel`(1760)）、`quickFrames`/`quickBattleId`/`quickOkText`/`replayFrames`/`replayOkText`、`viewer*` 全部 | `emptyQuick` `emptyViewer` `VIEWER_OWNERS` `VIEWER_SOURCES` + 8 个 `quick.*`/`viewer.*` case | |
| F7 锦标赛 + 排行 | 12 | `rankedNoticeText`(1832) `boardNoticeText`(1833) `resultsOf`(1836) `tournamentPager`(1839) `rankedResultText`(1848) `rankedBatchText`(1859) `rankedShortfallText`(1865) `rankedResultLine`(1871) `tournamentViewModel`(1882) `boardRows`(1958) `boardSelfOf`(1971) `boardScopeLabel`(1984) `boardHeadText`(1991) `boardSelfText`(2003) `boardLineText`(2009) `leaderboardViewModel`(2016) `rankedResultAt`(2063) `rankedFramesOf`(2068) `rankedBattleIdOf`(2074) `rankedOkText`(2079) `battleLoadedText`(2086) `boardHasMore`(2091) `boardTotal`(2094) `boardQuery`(2100) | `emptyTournament` `emptyBoard` `TOURNAMENT_PAGE_SIZE` `BOARD_*` + 6 个 case | |
| F5/D-178 AI 编辑器 | 37 | `aiEditorOf`(2190) … `aiEditorViewModel`(2807) 共 40 个函数 + `aiEd`/`aiBlueprint` 形参 | `emptyAiEditor` `AI_NAME_FIELD` `AI_FIELD_PREFIX` `isAiField` + 14 个 `ai.*` case | **`aiImport` 的 textarea 也随之删除** → `render.js` 的 `textareaHtml`/`blocksHtml` 可删 |
| 死按钮 | 1 | `emptyPageText`(2109) `emptyPageTitle`(2114) `emptyPageViewModel`(3197)（`EMPTY_PAGES` 已是空对象 → 三者不可达） | — | 占位页由注册表驱动（§3.5） |

**文件级删除**：`public/ai-editor.js`、`public/ai-blueprint.js`（落地前把内容抄进 `docs/archive/`，见 §5.3）。

### 3.3 主界面底部入口（用户口径 ⑤）

`format.hubViewModel` 的 footer 逻辑（`format.js:3099-3118`）**整段删除**；布局路径下不再追加 `refresh-hub`/`config-open`/`goto-admin`。
`layout-activate`（设为出战）与 `layout-switch-config`（切换显示配置）**保留** —— 它们是布局表自带按钮的动作，不是 footer 兜底。

### 3.4 保留但归属变化的函数（**易错点，先登记**）

| 函数 | 谁还需要它 |
|---|---|
| `findItem`(416) | `layInstalled`（插槽显示"装了什么"） |
| `pluginLabelOf`(839) | `layInstalled` |
| `warehouse.set` reducer + `state.warehouse` 切片 | `layFlat`/`layRows` 读 `state.warehouse.envelope` |
| `configs.set` reducer + `state.configs.data` | `layCurrent`/`layFlat` 读 `/me/configs` 的**响应信封** |
| `ai.list.set` reducer（**仅列表**） | `layout-activate` 不依赖；但 `layout-assemble` 的候选来自 `warehouse` ⇒ **不需要** |
| `REFRESH_OK_TEXT`/`WAREHOUSE_OK_TEXT` | `refresh-hub`（保留动作）的可见文案 |
| `hintFor`/`noticeText`/`networkText` | 通用失败文案（所有保留动作都用） |
| `detailLines`/`authLines`/`hubSummary` | `profile`（保留为 `ready` 屏）与 `hub` 的**非布局兜底**路径 |

> **`hub` 的非布局兜底**：`layoutReady() && state.profile` 为假时（未注入布局 / `/me` 未到）退回 `hubSummary` 文字屏。
> 本批**保留**该兜底（它是 D-179「界面绝不锁死」的一部分）。口径 ⑤ 要求"底部三颗入口都清掉"，
> 但兜底屏若一颗按钮都没有，用户在数据取不齐时**无路可走**（总纲 §4.1「按钮永不无声」）。
> 处置：兜底屏保留**恰好一颗** `refresh-layout`（= 一次取齐 `/me` + `/me/configs` + `/me/warehouse`），
> 该动作**只属于兜底屏**，不出现在布局表里。这是对口径 ⑤ 的**一处有意偏差**（§7 K-1，需用户确认）。

### 3.5 占位页规格（回归总纲 FR-12）

- 内容：`<h2>标题</h2>` + 一行 `尚未实现` + 一行 `计划：<plan>` + 一颗 `返回主界面`（`goto-hub`）。
- **不做任何请求**（`data: []` 由 I-3 机器核对）。
- 除 `hub`/`login`/`register`/`password`/`profile` 外，**其余屏全部是占位页**：
  `admin`/`accounts`/`warehouse`/`settings`/`quick`/`tournament`/`leaderboard`/`ai-editor`。
- `goto-*` 动作**全部保留**（它们只是 `view.go`，占位页也有入口价值）；这就是「按钮永不无声」的落点。

---
## 4. 交付物 C：机器门禁（本批新增 5 条）

新增 `tests/frontend/foundation-contract.test.js`（零依赖，`require` 形态）：

| 编号 | 断言 | 对应不变量 |
|---|---|---|
| FD-1 | `Object.keys(SCREENS)` ≡ `store.VIEWS`（顺序+内容） | I-1 |
| FD-2 | `status==='ready'` ⇒ `project` 存在且 `typeof format[project]==='function'`；`status==='todo'` ⇒ `data.length===0` 且 `project===null` | I-2 / I-3 |
| FD-3 | 每个非 null 的 `layout` 都在 `layout-data.screens` 里；**且** `layout-data.screens` 里每个 `role==='screen'` 都被恰好一条注册表条目引用 | I-4 / I-6 |
| FD-4 | `SCREENS[*].actions` 的并集 ≡ `Object.keys(ACTIONS)`（双向相等：无未登记动作、无不可达动作） | I-5 |
| FD-5 | 源码级：`store.js` 不含 `\[[\s\n]*'login'` 之类的 VIEWS 字面量数组；`format.js` 不含 `state\.view === '` 链式比较 | I-7 / I-8 |

追加到既有测试文件的两条：

| 编号 | 断言 | 位置 |
|---|---|---|
| FD-6 | `tools/layout/lab.html` 的 `<script id="core">` 与 `public/layout-engine.js` 的 `CORE_DIGEST` **相等**（当前 `make-engine.js:6` 声称有这条测试，实际不存在） | `tests/frontend/layout-tool-assets.test.js`（LT-7） |
| FD-7 | `public/app.css` 覆盖 `render.js` 会输出的每个 `dl-*` 类名（当前 `dl-ph`/`dl-screen-bg` 无规则） | 同上（LT-8） |

### 4.1 既有门禁的改写（**只改口径，不放宽强度**）

| 测试 | 改法 |
|---|---|
| `auth-ui-contract.test.js` UI-1 | `public/` 文件数 10 → **8**（删两个 AI 文件），且清单由 `boot-wiring` 的脚本清单派生 |
| UI-2 / AU-1（管理面） | `AU-1`/`admin-*` 三个测试文件随功能**删除**；UI-2 的可见动作集合改为「注册表里 `status==='ready'` 的屏的 actions 并集」 |
| UI-7/UI-8/UI-9 | 保留（render 纯净性 / 单一 fetch / 单一 innerHTML） |
| `WH-2`（`EMPTY_PAGES` 为空） | 改为「`SCREENS` 里 `status==='todo'` 的屏都渲染占位页且**零请求**」 |
| `hub-warehouse-flow.test.js` WH-1 | 保留布局渲染断言，删掉 footer（`阵容编辑`/`刷新`）相关断言 |
| `layout-hub-vm.test.js` LH-1..7 | 保留；`state.hub` → `state.layout` 更名同步 |
| `config-editor-flow` / `quick-battle-flow` / `tournament-board-flow` / `ai-editor-flow` / `ai-editor-actions` / `ai-blueprint-model` / `admin-flow` / `admin-op-parity` / `admin-ui-contract` / `render-escaping` | **删除**（对应功能已删） |
| `static-hosting` / `boot-wiring` / `button-payload-contract` / `browser-flows` | 保留并按新动作/载荷集合收紧 |

---
## 5. 后端与周边

### 5.1 后端：零改动

所有 `/api/v1` 端点、`server/**`、`cli/**`、`scripts/**` **一行不改**。
`scripts/e2e.js`、`scripts/load-test.js`、`scripts/play.js`、`tests/api/**`、`tests/integration/**`、`tests/unit/**` 不受影响（它们不经过前端）。

### 5.2 文档同步

| 文档 | 改法 |
|---|---|
| `docs/decisions.md` | **新增 D-180**（本批：回退范围 + 屏幕注册表 + 5 条门禁）；同时回填 `public/format.js:3099` 一直悬空的「D-180」引用（F9 从未登记） |
| `docs/progress.md` | 新增 §0.10 记录本批；§3.1 的 P6 段更新 |
| `docs/tasks.md` §7 | 更新"仍生效约束"（加：屏必须登记进 `SCREENS`） |
| `docs/frontend/00-rules.md` | §5 追加 FR-14（回退范围）与 FR-15（新屏必须登记进 `SCREENS`）；O-1/O-7 状态更新 |
| `docs/frontend/06-ai-editor.md` | 顶部加「已随 F10 回退，待重做」横幅（不删除旧稿，避免丢失设计信息） |
| `docs/frontend/07-layout-tool.md` | 素材计数 143 → **154**（实测）；`runtime/` 路径 → `tools/layout/` |
| `assets-inbox/README.md` | `runtime/apply-assets.js` → `npm run assets:apply`；ui 25 → 28、package 1 → 5 |
| `docs/reviews/F10.md` | 新增（本批审查与走查记录） |

### 5.3 被删代码的归档

`docs/archive/frontend-f2-f8/`（新建）存放被删的实现快照，供用户后续"依次手工实现"时参考：
`ai-editor.js`、`ai-blueprint.js`、`format.js` 被删段、`store.js` 被删段、`actions.js` 被删段、被删的 `tests/frontend/*`。
**归档目录不参与任何机器核对**（`check-docs` 的 `DOC_FILES` 为固定清单，不含它）。

---
## 6. 测试矩阵（本批收口必须全绿）

| 命令 | 期望 |
|---|---|
| `node --test --test-isolation=none "tests/frontend/*.test.js"` | 8 个文件全绿 |
| `npm test` | 通过数**下降**是预期（被删屏的用例随之删除）；**失败必须为 0** |
| `npm run gate` | 9 PASS / 0 FAIL / 0 PEND |
| `npm run check:docs` | PASS（批次仍 **41**） |
| `node scripts/check-arch.js` | PASS |
| `npm run e2e` | 22/22（**不经过前端，必须不受影响**） |
| `npm start` + 浏览器 | `hub` 布局照旧渲染；点「仓库/快速对战/…」进占位页并**零请求**；点「返回主界面」回得来 |

---
## 7. 已知未覆盖 / 已知风险（**不得为空**）

| # | 项 | 说明 |
|---|---|---|
| K-1 | **口径 ⑤ 与「按钮永不无声」的冲突** | 布局渲染下没有任何 footer 兜底；若 `/me` 取不到数据，兜底文字屏上没有按钮可点。处置：兜底屏保留**一颗** `refresh-hub`（§3.4）。这是对口径 ⑤ 的**一处有意偏差**，需用户确认。 |
| K-2 | `profile` 屏保留但降级 | 它的入口是布局表的「用户头像」按钮（`goto-profile`）。本批保留 `profile` 为 `ready` 屏（只显示档案摘要 + 返回），因为它已存在且无删的必要；用户若要求也可降为占位页。 |
| K-3 | `contract.js` 的字段契约只覆盖保留部分 | 被删屏的字段路径（管理面/查看器/编辑器）从契约中移除后，**这些端点的字段不再有机器核对**。它们仍是后端已实现能力，但在前端重做前处于"无契约保护"状态 —— 登记为待重做项。 |
| K-4 | `check-arch.js` 未含 L7 | `public/screens.js` 新增后，L7 分层登记**仍不在** `check-arch.js`（O-7 的剩余部分）。本批不改（避免扩大范围），由 FD-1..FD-5 代偿。 |
| K-5 | 归档目录无机器核对 | `docs/archive/**` 里抄进去的旧实现可能立刻与主干漂移；它只是参考资料，**不得**被 `require`。 |
| K-6 | 未做真实浏览器走查 | 本批的"能玩"出口 = §6 的 `npm start` 人工走查（点每个未实现屏 + 返回 + 布局按钮逐个点）。**结论必须由用户本人在真实浏览器执行**后回填 `docs/reviews/F10.md`（总纲 §4.4）。 |

---
## 8. 实施顺序（每步都要能过 FD-1..FD-5）

1. **S-1** 新增 `public/screens.js`（注册表）+ 改 `store.js` 的 `VIEWS` 派生 + `format.viewModel` 查表 + 占位页。**此时功能未删，注册表先把现状全部登记**（`status:'ready'`），门禁全绿。
2. **S-2** 按 §3.2 逐组删投影/动作/状态，每删一组同步把注册表里该屏改 `status:'todo'` 并清空 `actions`，跑一次 `tests/frontend/*`。
3. **S-3** 删 `ai-editor.js`/`ai-blueprint.js` + `render.js` 的死块 + `app.js` 的死键。
4. **S-4** 修产品端缺陷（§4 的 FD-6/FD-7 对应项）：`alpha` 命中、`.dl-ph` 样式、`layout.background` 渲染、`import-layout.js` 的 `model_skill1_slots` 拼写。
5. **S-5** 重写 `tests/frontend/*` 到新基数（删 13 个文件、改写 5 个、新增 `foundation-contract.test.js`）。
6. **S-6** 文档同步（§5.2）+ 归档（§5.3）+ 登记 D-180。
7. **S-7** 全量实测（§6）+ 用户浏览器走查。
