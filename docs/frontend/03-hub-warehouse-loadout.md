# F3 设计与实现冻结：主界面 / 用户 / 仓库 / 开箱 / 设置 / 出战配置

> 版本：**v1**　创建：2026-09-22　更新：2026-09-22（**提交① 后端契约已落地**，见 §15 实现对账）
> 状态：**口径已由用户逐条拍板（本轮 30+ 项问答）；提交① 已实施（D-159…D-162 + 附录 A 已写入 `docs/decisions.md`、附录 B 已同步 `docs/interfaces.md`）；提交② /③（前端屏与出战配置编辑器）待做**
> 依据：`docs/frontend/00-rules.md`（总纲：§1 绘制边界 / §2 协作协议 / §4 验收机制）；`docs/interfaces.md` §2（接口唯一权威，**变更见附录 B**）；`docs/systems/11-account-store.md`（档案与存储权威，**D-130 部分被推翻见附录 A**）；`docs/decisions.md`（新 D 编号见附录 A）
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md` > `docs/frontend/*`
> 定位：本文件是 **P6 批次 `F3` 的唯一实现依据**（三提交合一：后端契约 ① / 主界面线 ② / 出战配置编辑器 ③）。

---

## 0. 本轮的取证方式（总纲 §2.3）

本分册所有"现状/字段/错误码"均来自**进程内起真实服务 + 真实 HTTP 请求**（临时数据根，未污染仓库），不使用二手结论。取证覆盖：

| 探针 | 覆盖 |
|---|---|
| 1 | 注册 / `GET /me` / `GET /me/configs` 槽位数 / `POST /box` 物品形状 / `GET /warehouse` 空骨架 / 单人 `quick`·`ranked` / 排行榜 / `unlock` / `records` |
| 2 | 默认槽 loadout 全文 / 原样保存 / `assemble` 成功与 409 / 拆卸 404 / 含 `pluginUid` 保存是否需要 warehouse / 仓库镜像往返 / 槽 id 复用 / 删默认槽 409 / 双人 `quick` |
| 3 | 排位 `matches/shortfall`（2 人与 3 人两种顺序）/ 24h 去重硬底线 / 战绩与防守战绩 |
| 4 | 默认配置逐字段 / **空配置是否可存**（5 种半成品逐条）/ 是否复制出战配置 / AI 库端点探测（4 个全 404） |
| 5 | 开箱随机性：同 seed 复现 / 不传 seed 才随机 / 扫 40 个 seed 找到 seed=7 出 3 件 legendary / 重复使用同一 seed 可无限复制 |

---

## 1. 范围与端点 UI 映射（规则 4.3）

| # | 端点 | 本批 UI 路径 | 状态 |
|---|---|---|---|
| 1 | `GET /api/v1/me` | 主界面摘要 + 用户详情屏 + 启动自检（F1 既有） | ✅ 已有 |
| 2 | `POST /api/v1/auth/logout` | 设置屏·登出（**从 F1 的 profile 移入**） | ✅ 已有（入口移位） |
| 3 | `POST /api/v1/auth/password` | 设置屏·改密 → 复用 F1 的 password 屏 | ✅ 已有 |
| 4 | `PUT /api/v1/me/nickname` | 设置屏·改名 | ✅ 已有（F3 首次接 UI） |
| 5 | `GET /api/v1/me/warehouse` | 仓库屏（**真源**） | 🆕 语义变更（原为进程内镜像） |
| 6 | `POST /api/v1/me/warehouse/assemble` | 装配（出战配置弹窗内） | 🆕 新增 |
| 7 | `POST /api/v1/me/warehouse/disassemble` | 拆卸 | 🆕 新增 |
| 8 | `POST /api/v1/me/box` | 开箱屏 | 🆕 新增（**`seed` 不是入参**） |
| 9 | `GET /api/v1/me/configs` | 出战配置 1/2/3 弹窗 | ✅ 已有 |
| 10 | `PUT /api/v1/me/configs/:slotId` | 保存配置（**非出战槽不校验完整性**） | 🆕 语义变更 |
| 11 | `POST /api/v1/me/configs/:slotId/activate` | 选择出战（**此时才校验完整性**） | 🆕 语义变更 |
| 12 | `GET /api/v1/me/ai` | 配置弹窗·AI 位置的可选列表 | 🆕 新增 |
| 13 | `POST /api/v1/me/ai` | （本批仅后端：命名保存） | 🆕 新增，前端不做 |
| 14 | `DELETE /api/v1/me/ai/:aiId` | （本批仅后端：删除） | 🆕 新增，前端不做 |
| 15 | `POST /api/v1/quick/run` | 快速对战屏 | ⛔ **空页**（F6） |
| 16 | `POST /api/v1/ranked/run\|promote` | 锦标赛（=排位赛）屏 | ⛔ **空页**（F6/F7；`shortfall` 文案一并留到该批） |
| 17 | `GET /api/v1/leaderboard` | 排行榜屏 | ⛔ **空页**（F7） |
| 18 | `POST /api/v1/ai/validate\|compile\|battle`、`GET /unlock`、`GET /data/:table` | AI 编辑屏 | ⛔ **空页**（F5） |
| 19 | `GET /api/v1/health`、`GET/POST /api/v1/log-level` | — | ⛔ 非玩家动作（F1 §1 已登记） |
| 20 | `GET /api/v1/warehouse`、`POST /api/v1/warehouse/assemble\|disassemble`、`POST /api/v1/box`、`PUT /api/v1/me/warehouse` | 遗留无状态路径（保留给离线/测试，**前端不接**） | 登记"本批不接 UI" |

**非目标**：不做样式/动画/布局（§1.1）；不做 AI 编辑界面（F5）；不做匹配与排行界面（F6/F7）；不做 URL 路由；不做多语言。

---

## 2. 采用的模式与被否决的替代（总纲 §2.5 ①）

**采用**：沿用 F1/F2 的单页 + 单向数据流（纯 `render(vm)`、自研 store、事件委托、单一网络出口 `api.js`、单一 DOM 写入点 `app.js`、投影单一真源 `format.js`），**不新增 `public/` 文件**（仍为 F1 冻结的 9 个，UI-1 不变）。

**本批新增的两个渲染约定**（用户 2026-09-22 明确）：

1. **弹窗 = 屏内绘制的区块**（不是浏览器 `dialog`/`alert`，也不是新窗口）：由 `state.modal` 描述，渲染进 `#view` 之内。
2. **点击弹窗外 = 取消**：渲染一个承担外部点击的背景元素（`data-action="modal-close"`），点击即关闭并**丢弃未提交输入**；弹窗内另有显式"取消"按钮。

被否决的替代：

| 替代 | 否决理由 |
|---|---|
| 浏览器原生弹窗 / 新窗口 | 破坏"单一 DOM 写入点 + 零逻辑渲染"，且引入布局与层级（违反 §1.1/§1.2） |
| 每个屏一个 HTML 页面 | 后端是 Bearer + JSON 信封，无 Cookie 会话；页面跳转无法携带 token |
| 引入框架/组件库 | 违反 D-124 与零依赖 |
| 仓库继续留 localStorage（保持 D-130） | 用户明确推翻：**仓库由服务端权威**（附录 A 的 D-159） |
| `seed` 作为开箱入参 | 实测可复现 → 可被"找到好 seed 后无限复制"（探针 5）；用户裁定**接口不设该字段** |

---

## 3. 屏幕清单与弹窗机制

9 个屏（`state.view`）+ 5 类屏内弹窗（`state.modal`）。`#view` 仍是唯一 DOM 写入点。

### 3.1 屏 `hub`（主界面）—— 登录后的落点

- 静态文字：标题 `Debug-Lite`；摘要行（由 `format.hubSummary()` 产出）。
- 摘要行内容（**只读 `GET /me`**）：`昵称` · `段位` · `积分` · `未读 进攻<a>/防守<d>` · `在池/不在池`。
- 按钮（11 个）：`用户`(goto-profile)、`仓库`(goto-warehouse)、`开箱`(goto-box)、`快速对战`(goto-quick)、`锦标赛`(goto-tournament)、`排行榜`(goto-leaderboard)、`出战配置1`(config-open:slot1)、`出战配置2`(config-open:slot2)、`出战配置3`(config-open:slot3)、`AI编辑`(goto-ai-editor)、`设置`(goto-settings)。
- 另：`刷新`(refresh-hub，重取 `GET /me`)。
- 进入条件：登录/注册成功；或启动时本地 token 经 `GET /me` 校验通过；或从任一子屏返回。

### 3.2 屏 `profile`（用户详情）—— F1 的 `home` 降级

- 内容与 F1 §3.3 **逐字不变**（档案摘要各行的字段与文案沿用 F1 的 `format.homeLines()` 投影）。
- 按钮：`刷新档案`(refresh-profile)、`设置密码`(goto-password) —— **`登出` 按钮移除**（用户裁定：登出只保留在设置屏）。
- 返回：`返回主界面`(goto-hub)。

### 3.3 屏 `warehouse`（仓库）

- 数据源：`GET /me/warehouse`（**服务端权威**，含 `usage` 映射标记"出战于配置几"）。
- 静态文字：标题 `仓库`；容量行 `角色 <n>/500 · 技能 <n>/500 · 角色插件 <n>/500 · 技能插件 <n>/500`。
- 分桶切换按钮（4）：`角色`/`技能`/`角色插件`/`技能插件`(warehouse-bucket:role|skill|rolePlugin|skillPlugin)。
- 列表：**每行只显示物品名字**（+ 简要标记 `[装配于配置1]` 若 `usage` 命中）；每行是可点元素（`item-open:<uid>`）。
- 物品详情：**屏内弹窗**（`state.modal={kind:'item-detail',uid}`），显示该物品的全部字段（按 §5.3 的字段清单），右下 `关闭`(modal-close)。
- 其它按钮：`刷新`(refresh-warehouse)、`返回主界面`(goto-hub)。
- 空仓库：显示 `仓库为空：点「开箱」获取物品`，列表区无行。

### 3.4 屏 `box`（开箱）

- 输入框：`开箱次数`（单行数字，缺省 1；界面上限 `100` = `BOX_TIMES_MAX`）。
- 按钮：`开箱`(box-open)、`返回主界面`(goto-hub)。
- 结果区：`本次获得 <n> 件：` + 逐件一行（`<名字>（<分类>·<品质>）`）。
- **不渲染 `seed`**（不是入参，也不显示）。
- **进入本屏时取一次 `GET /me/warehouse`（静默，不轮询）** —— 这是下面"本地禁用"的前提（否则手上没有 `caps`/桶长度）；读取失败不影响进入本屏，按钮保持可用，由服务端 409 兜底。
- 超限行为：目标分类已达 500 → `开箱` 按钮**禁用** + 提示 `仓库已满（<分类> 500/500），请先清理`（**不发请求**）；开箱成功后**静默刷新一次仓库**，使"连续开箱 → 满仓立刻禁用"成立。

### 3.5 屏 `settings`（设置）

- 输入框：`新昵称`（单行，≤16 字符，客户端先拦）。
- 按钮：`保存昵称`(settings-nickname-save)、`修改密码`(goto-password)、`登出`(logout)、`返回主界面`(goto-hub)。
- 结果区：最近一次操作的结果文案。

### 3.6 空页（4 个）：`quick` / `tournament` / `leaderboard` / `ai-editor`

- 统一结构：标题（`快速对战` / `锦标赛`（副标题 `= 排位赛`）/ `排行榜` / `AI 编辑`）+ 一行 `尚未实现（计划批次 F6/F7/F5）` + `返回主界面`(goto-hub)。
- **不做**任何请求；**不渲染**任何其它按钮。

### 3.7 屏内弹窗：出战配置（`state.modal={kind:'config',slotId}`）

按用户 2026-09-22 的口径逐条：

| 位置 | 显示 | 点击后 |
|---|---|---|
| 角色模板 | 已装：角色名（+ 品质）；未装：`空` | 打开 `slot-pick` 弹窗（该位置可选替换） |
| 角色插槽（0..n） | **只有装了模板才显示**，有几个显示几个，每个标注**插槽类型**（`def`/`sp`/`hp`/`atk`/`special`…）；未装插件显示 `空` | 打开 `plugin-pick` 弹窗（该槽可装的插件，**不匹配的标灰 + 写原因**） |
| 技能1/2/3 | 已装：技能名（+ 品质）；未装：`空` | 打开 `slot-pick` 弹窗 |
| 技能插槽 | 同上（每技能各自的槽） | 打开 `plugin-pick` 弹窗 |
| 战斗AI | 已装：AI 名字；未装：`空` | 打开 `ai-pick` 弹窗（列 `GET /me/ai`） |
| 状态行 | `出战配置2：未保存/已保存 · 非出战/出战中` | — |
| 按钮 | `保存`(config-save)、`设为出战`(config-activate)、`关闭`(modal-close) | — |

**⚠️ 提交③ 必须遵守的两步顺序（后端语义决定，D-159/D-160）**：

1. **插件装配分两步、且顺序不可颠倒** —— 插件的"装上/拆下"改的是**仓库里那件物品**的 `slots[]`
   （`POST /me/warehouse/assemble|disassemble`），而**配置里存的是物品正文的副本**（loadout 自足）。
   因此"给某个插槽换插件"= ① 调装配端点 → ② 用响应里的 `warehouse` 取回**更新后的那件物品**，
   用它替换草稿里的对应物品 → ③ 再 `PUT /me/configs/:slotId` 保存。**只做①不做②③ = 界面看起来换了、
   保存后依旧没换**（最容易踩的坑）。
   - 装配返回体已含 `warehouse`（四桶全文）与 `usage`，无需额外再拉 `GET /me/warehouse`（拉了也无害）。
2. **替换角色/技能模板不需要"先拆插件"**：模板是仓库里的**另一件物品**，它的插槽状态就是它自己的
   （旧模板上的插件仍留在旧物品上，`usage` 只是不再标记它）。所以"替换时自动拆掉插件、新插槽显示空"
   是**天然成立**的，**不要**为此写清理代码。
3. **"空"位置与出战态**：把草稿的某位置置 `空` 后保存 —— 非出战槽允许（200，`complete:false`）；
   若该槽**正在出战**则必被拒（409 `loadout_invalid` + 逐位置 details），界面要把它翻成玩家可读文案
   （`出战中的配置必须完整，只能替换，不能拆卸`），而不是原样抛服务端 message。
4. **`设为出战` 才校验完整性**：不完整 → 409 `cannot_activate_incomplete`（details 逐位置）；
   完整 → 200 且 `activeSlotId` 切换。界面需在切换后刷新主界面/仓库的"出战于配置几"标记。

- 配置 2/3 初始为 **3 个空槽**（见 §9.1 的注册口径），5 个位置全部显示 `空`，且 `空` 是可点元素。
- **出战中的配置不可拆卸模板**：出战中时，`slot-pick` 里**不提供"空"选项**（只能替换），且不渲染"拆空"按钮；非出战配置可选中 `空`。
  - ⚠️ **口径澄清（审查 F-6）**：这里（以及 D-160 的"只能替换、不能拆卸"）说的是**模板位置** —— 角色与 3 个技能**不允许置空**（服务端 409 `loadout_invalid`，逐位置可读文案）。**插槽里的插件不在其内**：出战中的配置同样可以「清空此槽」（服务端 200，`CF-4②` 真实 HTTP 实测）。两者不矛盾：完整性判据（D-160）只看 角色 + 恰 3 技能 + AI，**允许插槽为空**。
- **拆掉模板后**：该模板及其插件回到"未出战"状态（`usage` 不再标记该配置）。
- **替换模板不写"拆插件"代码**：插件装在**仓库物品**上（`slots[].pluginUid` 存在服务端仓库里），替换 = 换用仓库里的另一件物品，新物品的插槽状态天然是它自己的（通常全空）。这是服务端权威仓库带来的**简化**，不需要前端清理逻辑。
- **候选的可用性标灰（D-163，2026-09-25 热修）**：`slot-pick` / `plugin-pick` 里**点了必然 409** 的候选一律**标灰 + 行内写明原因**（与 §3.7 的 B-8 类型不符同一条规则）：
  - `已被配置N使用（一件物品同时只能装配到一份配置）` —— 该 uid 被**别的配置**引用（跨配置独占；服务端 409 `item_in_use`）；
  - `本配置已在其它位置使用（一件物品只能占一个位置）` —— 本份草稿的**其它位置**已用该 uid（服务端 409 `loadout_invalid`）；
  - `已被装配（请先拆卸）` —— 该插件已装在仓库某件物品的槽上（等价服务端 `equipped=true`；前端**不读** `equipped` 字段，而是从已登记的 `slots[].pluginUid` 推导）；
  - `此槽只能装 <type>` —— 类型不符（既有 B-8）。
  标灰只是**提前告知**，唯一判据仍在服务端（客户端拦截失败时仍会收到上面的 409 文案）。

### 3.8 弹窗通用规则

- 同时只存在一个 `state.modal`；打开新弹窗即替换旧的。
- 任何弹窗渲染 `data-action="modal-close"` 的背景元素；点击 = 关闭 + 丢弃未提交输入。
- `Esc` 键不在本批范围（§1.2 未含键盘语义；表单 `Enter` 提交沿用 F1 的 `data-enter` 机制）。

---

## 4. 按钮 ↔ 动作白名单（规则 4.1）

`public/actions.js` 的 `ACTIONS` 仍是唯一注册表。**本批新增 26 个动作**（下表 28 行中 `logout` 与 `goto-password` 是 F1 既有动作的重用；F1 的 9 + F2 的 16 = 25，合计 **51**）。

| 动作 | 触发 | 行为 | 成功可见文本 | 失败可见文本 |
|---|---|---|---|---|
| `goto-hub` | 各子屏·返回主界面 | 切 `hub` + 清 `modal` | 主界面 | — |
| `goto-profile` | hub·用户 | 切 `profile` | 用户详情 | — |
| `goto-warehouse` | hub·仓库；设置结果区返回 | 切 `warehouse`，请求仓库 | 仓库 | 服务端文案 |
| `goto-box` | hub·开箱 | 切 `box` **并静默取一次仓库**（`GET /me/warehouse`，不轮询；失败不挡人） | 开箱 | — |
| `goto-quick` / `goto-tournament` / `goto-leaderboard` / `goto-ai-editor` | hub·对应按钮 | 切到空页 | 空页标题 | — |
| `goto-settings` | hub·设置 | 切 `settings` | 设置 | — |
| `refresh-hub` | hub·刷新 | `GET /me` | 摘要更新 | 服务端文案；401 按 F1 §6 登出 |
| `refresh-warehouse` | 仓库·刷新 | `GET /me/warehouse` | 列表更新 | 服务端文案 |
| `warehouse-bucket` | 仓库·4 个分桶按钮 | 切当前桶（纯本地） | 列表切换 | — |
| `item-open` | 仓库·物品行（`data-uid`） | 打开 `item-detail` 弹窗 | 详情 | — |
| `box-open` | 开箱·开箱 | 客户端预校验次数 → `POST /me/box {times}`；**成功后静默刷新一次仓库** | `本次获得 n 件：…` | `仓库已满（…）` / 服务端文案 |
| `config-open` | hub·出战配置1/2/3（`data-slot`） | `GET /me/configs` → 打开 `config` 弹窗 | 配置内容 | 服务端文案 |
| `config-save` | 配置弹窗·保存 | `PUT /me/configs/:slotId`（带完整 loadout） | `已保存` | `loadout_invalid` 逐条 details 文案 |
| `config-activate` | 配置弹窗·设为出战 | `POST /me/configs/:slotId/activate` | `已设为出战配置` | `配置不完整：缺少<角色/技能N/AI>`（409） |
| `slot-pick` | 配置弹窗·某位置（`data-slot` `data-pos`） | 打开 `slot-pick` 弹窗（候选取自仓库同分类物品 + `空`） | 候选列表 | — |
| `slot-set` | `slot-pick`·某个候选（`data-uid` 或 `data-empty`） | 本地替换该位置 | 位置更新 | — |
| `ai-pick` | 配置弹窗·战斗AI | `GET /me/ai` → 打开 `ai-pick` 弹窗 | AI 列表 | 服务端文案 |
| `ai-set` | `ai-pick`·某条（`data-ai-id`） | 本地替换 AI 位置 | 位置更新 | — |
| `plugin-pick` | 配置弹窗·某插槽（`data-slot` `data-pos` `data-idx`） | 打开 `plugin-pick` 弹窗（候选=仓库同分类插件，**类型不匹配的标灰 + 原因**） | 候选列表 | — |
| `plugin-set` | `plugin-pick`·某插件 | `POST /me/warehouse/assemble {targetUid,pluginUid,slotIndex}` | `已装配` | 409 文案（含 `slot_type_mismatch` 的**可读改写**） |
| `plugin-clear` | `plugin-pick`·`清空此槽` | `POST /me/warehouse/disassemble {targetUid,slotIndex}` | `已拆卸` | 404 `slot_empty` 文案 |
| `modal-close` | 任何弹窗·背景 / 关闭 / 取消 | 关弹窗 + 丢弃未提交输入 | 回到发起屏 | — |
| `settings-nickname-save` | 设置·保存昵称 | 预校验（≤16）→ `PUT /me/nickname` | `昵称已更新为 <n>` | 服务端文案 |
| `logout` | 设置·登出（F1 既有动作，**入口移位**） | 同 F1 §4 | 切 `login` + `已登出` | 同 F1（失败也清本地会话） |
| `goto-password` | profile·设置密码；settings·修改密码（F1 既有动作，**新增一个入口**） | 同 F1 §4 | 设置密码屏 | — |

**双向机器核对**（沿用 F1 UI-2 / F2 AU-1 的做法）：非管理员态下，`login/register/home(=profile)/password/hub/warehouse/box/settings` 各屏渲染的 `data-action` 集合 == 注册表中**非管理动作**集合（F3 落地时把 F1 的"恰好 9"改为"恰好 51 − 16（管理动作）= 35，且管理动作在非管理员态不出现"）。

> **`goto-home` 语义**：F1 的 `goto-home`（设置密码屏·返回主页）在 F3 中指"切回 `profile`（原 `home`）"。由于密码屏现在有两个入口（profile 的「设置密码」与 settings 的「修改密码」），该屏**同时渲染**「返回用户详情」(`goto-home`) 与「返回设置」(`goto-settings`)，不新增动作。

---

## 5. 字段来源契约（规则 4.2）

### 5.1 已实现端点（本批实测，可直接进 FC 核对）

| 端点 | 字段路径 | 用途 |
|---|---|---|
| `me` | `data.nickname` / `data.publicId` | hub 摘要、profile |
| `me` | `data.progress.tier` / `data.progress.peakTier` | 段位 |
| `me` | `data.rating.points` / `data.rating.games` / `data.rating.wins` / `data.rating.losses` / `data.rating.draws` | 积分与场次 |
| `me` | `data.record.unread.attack` / `data.record.unread.defense` | 未读红点 |
| `me` | `data.pool.inPool` | 是否在池 |
| `me` | `data.slots`（逐项 `slotId`/`name`/`isDefault`） | 配置槽清单 |
| `me` | `data.activeSlotId` / `data.activeSlotName` | 出战配置标记 |
| `me` | `data.flags.unverifiedLoadout` / `data.flags.isBot` / `data.flags.isAdmin` | profile 行（F1 既有） |
| `me/configs` | `data.slots[]`（`slotId`/`name`/`isDefault`/`createdAt`/`updatedAt`） | 配置弹窗 |
| `me/configs` | `data.slots[].loadout.role`（`uid`/`templateId`/`name`/`quality`/`slotCount`/`slots[].type`/`slots[].pluginUid`/`stats`/`regen`/`pluginPoints`） | 角色位置与插槽 |
| `me/configs` | `data.slots[].loadout.skills[]`（`uid`/`templateId`/`name`/`quality`/`slotCount`/`slots[]`/`params`） | 技能 1/2/3 |
| `me/configs` | `data.slots[].loadout.ai`（`program` 正文） | 战斗 AI 位置 |
| `me/configs` | `data.slots[].loadout.aiId`（**库内引用**） | AI 位置的**显示名**来源（`aiId` → `GET /me/ai` 的条目名；取不到时回落裸 `aiId`）。服务端 `aiRefsOf` 也按此字段统计引用 → `DELETE /me/ai/:aiId` 的 409 `ai_in_use` 判据（审查 F-2 登记） |
| `me/configs` | ~~`data.slots[].snapshot.hash`~~（**前端不读**） | 状态行的「已保存/未保存」由本地 `dirty` 标记决定，不读服务端快照；写出该行属设计稿笔误，实现不依赖它 |
| `me/configs` | `data.activeSlotId` / `data.maxSlots` | 出战标记 / 槽位上限 |
| `box`（遗留） | `data.items[]`（`uid`/`kind`/`name`/`quality`/`templateId`/`slotCount`/`slots`/`stats`/`params`/`affixes`/`pointCost`/`costDeltaByTier`） | 物品详情字段来源（与新增 `me/box` 同形） |

### 5.2 新增端点（**字段为设计约定，落地后必须用真实响应回填并纳入 FC-1**，总纲 §3.3/§4.2）

| 端点 | 字段路径（约定） | 用途 |
|---|---|---|
| `me/warehouse` | `data.buckets.role[]` / `.skill[]` / `.rolePlugin[]` / `.skillPlugin[]` | 四桶列表（物品对象形状同 §5.1 `box`） |
| `me/warehouse` | `data.usage[uid].slotIds[]` | 仓库行"装配于配置几"（可多处引用） |
| `me/warehouse` | `data.caps.{role,skill,rolePlugin,skillPlugin}` | 容量行 `n/500` |
| `me/box` | `data.items[]` / `data.times` / `data.seed`（服务端生成，仅审计用） | 开箱结果 |
| `me/ai` | `data.items[].{aiId,name,program}` / `data.caps.max=100` | AI 位置候选列表 |
| `me/warehouse/assemble` | `data.warehouse` / `data.usage` | 装配后回带 |
| `me/configs/:id/activate` | `data.activeSlotId` | 出战标记更新 |

### 5.3 物品详情弹窗显示的字段（**逐条来自实测响应**）

- 共通：`name` / `kind` / `quality` / `uid`
- 角色：`templateId` / `stats.{hp,atk,def,sp,mp}` / `regen.{mp,sp}` / `pluginPoints` / `slotCount` / `slots[].{type,pluginUid}`
- 技能：`templateId` / `params.{multiplier,cost.{hp,mp,sp},cooldown,bulletLevel}` / `slotCount` / `slots[].{type,pluginUid}`
- 角色插件：`id` / `desc` / `slot` / `category` / `tier` / `pointCost` / `affixes[].{id,desc,params.v}`
- 技能插件：`id` / `desc` / `slot` / `category` / `tier` / `costDeltaByTier` / `affixes[].{id,desc,params.v}`

---

## 6. 全部失败路径

| code | HTTP | 触发 | 界面文案 |
|---|---|---|---|
| `unauthorized` / `session_expired` | 401 | 会话失效 | 按 F1 §6 统一登出 |
| `forbidden` | 403 | 越权 | 服务端文案 |
| `bad_request` | 400 | 参数非法（如开箱次数越界、昵称超长由客户端先拦） | 服务端文案 |
| `bad_times` | 400 | 开箱次数不在 1..100 | `开箱次数需为 1~100 的整数` |
| `warehouse_full` | 409 | **新增**：目标分类已达 500 | `仓库已满（<分类> 500/500），请先清理`（正常情况下由按钮禁用拦截） |
| `slot_type_mismatch` | 409 | 插件类型与插槽不符 / 槽位不可用（**同一码两种含义**，实测确认） | 优先客户端预过滤；若仍发生 → `该插件不能装入此槽（类型不符）` + 服务端 `message` 原文附注 |
| `slot_occupied` | 409 | 插槽已占用 | `该插槽已装配插件，请先拆卸` |
| `points_exceeded` | 409 | 角色插件点数不足 | `插件点数不足（需要 <x>，剩余 <y>）` |
| `plugin_equipped` | 409 | 插件已被引用 | `该插件已被装配，请先拆卸` |
| `item_missing` | 409 | 目标/插件不存在于仓库 | `物品不存在（可能已被清除）` |
| `slot_empty` / `plugin_missing` | **404** | 拆卸时槽为空 / 悬挂引用 | `该插槽当前为空` |
| `loadout_invalid` | 409 | 保存出战配置失败（`details[]` 逐条 `path`） | 逐条渲染：`缺少角色物品` / `技能位置缺失: N` / `技能必须恰 3 个（实际 N）` / `缺少 AI 程序` / `missing_warehouse` |
| `cannot_activate_incomplete` | 409 | **新增**：设为出战时配置不完整 | `该配置不完整，无法设为出战（缺少 <位置>）` |
| `item_in_use` | 409 | **新增（D-163）**：该物品已被**另一份配置**引用（一件物品同时只能装配到一份配置） | `物品 <uid> 已被配置 <slotIds> 使用：一件物品同时只能装配到一份配置（请先在那边替换或拆卸）`；候选弹窗里**预先标灰**（`已被配置N使用（一件物品同时只能装配到一份配置）`） |
| `loadout_invalid` 的 D-163 分支 | 409 | **新增（D-163）**：物品 uid 不在本人仓库（`物品不在仓库: <uid>`）/ 同一份配置内重复占位（`同一物品被多处引用: <uid>`）/ 技能位 > 3 | 同上逐条渲染；候选弹窗里同样预先标灰（`本配置已在其它位置使用（一件物品只能占一个位置）`），插件另有 `已被装配（请先拆卸）` |
| `ai_limit` | 409 | **新增**：AI 库已满 100 | （本批前端不实现，登记） |
| `ai_in_use` | 409 | **新增**：删除被出战配置引用的 AI | （本批前端不实现，登记） |
| `rate_limited` | 429 | 全局限速 600/分 | 按 F1 §6 |
| `store_unavailable` / `internal_error` | 503 / 500 | 按 F1 §6 | 按 F1 §6 |

---

## 7. 状态与持久化

```js
// public/store.js（initialState 增量；**以下为提交③ 收口后的实际形状**，§15.7 已对账）
view: 'hub',                                    // hub|profile|warehouse|box|settings|quick|tournament|leaderboard|ai-editor|login|register|password|admin|accounts
modal: null,                                    // {kind:'item-detail'|'config'|'slot-pick'|'plugin-pick'|'ai-pick', ...}
warehouse: { envelope: null, loading: false },  // **只存最近一次响应信封**（buckets/usage/caps 都在里面；真源永远重取）
warehouseBucket: 'role',
box: { times: 1, result: null },
configs: { data: null, ai: null, draft: null, dirty: false },  // data = GET /me/configs 信封；ai = GET /me/ai 信封；draft = 弹窗内未保存的副本
settings: { nickname: '', result: null },
```

- **持久化只剩会话**：`dl.token` / `dl.session`（F1 已冻结）。**不再有 `dl.warehouse`**（仓库改为服务端权威，用户裁定）。
- reducer 动作增量：`warehouse.set` / `warehouse.bucket.set` / `box.result.set` / `configs.set` / `configs.ai.set` / `configs.draft.set` / `configs.draft.patch` / `modal.set` / `modal.setIfOpen` / `modal.close` / `settings.set`。
- **`modal.setIfOpen`（提交③ 收口期新增，审查 F-1）**：**"当前还有弹窗才替换"** 的条件 reducer。用于弹窗内异步动作（装配/拆卸、取 AI 库）在 `await` 回来后"回弹编辑器"——用户若在等待响应期间点了背景关闭（`modal-close` 丢弃草稿），就**不得**把弹窗复活（否则编辑器按服务端副本渲染"未改动"，与"已装配"提示、仓库实际状态三方矛盾）。条件必须放在 reducer：动作拿到的 `ctx.state` 是**动作开始时**的快照（`public/app.js` 的 `buildCtx`），`await` 之后读它判不出用户是否已取消。
- 配置弹窗采用**本地草稿**（`configs.draft`）：所有替换/装配先在草稿上生效，点「保存」才 `PUT`；点背景关闭即丢弃（§3.8）。

---

## 8. 边界条件

| # | 边界 | 行为 |
|---|---|---|
| B-1 | 仓库空 | 仓库屏显示空态文案；开箱屏正常可用 |
| B-2 | 某分类已满 500 | 开箱按钮禁用 + 提示；不发送请求 |
| B-3 | 开箱次数越界（0 / 101 / 小数 / 非数字） | 客户端拦下，`开箱次数需为 1~100 的整数` |
| B-4 | 配置 2/3 全空 | 5 个位置全部显示 `空`（可点）；`设为出战` 返回 409 → `配置不完整` |
| B-5 | 出战中的配置 | `slot-pick` 不提供"空"选项；不渲染"拆空"；提示 `出战中的配置只能替换，不能拆卸` |
| B-6 | 拆掉模板后 | 该模板与其插件在仓库的 `usage` 里不再标记任何配置 |
| B-7 | 替换模板 | 新模板的插槽状态取自**仓库里那件物品自身**（通常全空）；不写"清插件"逻辑 |
| B-8 | 插件类型不匹配 | 候选列表**标灰 + 原因**（`此槽只能装 <type>`） |
| B-9 | 弹窗点外面 | 关闭 + 丢弃草稿；未提交输入不保留 |
| B-10 | 同一物品被多个配置引用 | 允许（服务端不禁止）；`usage[uid].slotIds` 列出全部 |
| B-11 | 昵称 > 16 字符 | 客户端拦下（服务端也会夹到 ≤16，前端提示为准，沿用 F1 §8 B-5） |
| B-12 | 刷新页面 | 一律回 `hub`（不恢复上次所在屏） |
| B-13 | 空页 | 只有标题 + 说明 + 返回键；点击返回可回到 hub |

---

## 9. 后端变更摘要（详见附录 A / B）

### 9.1 仓库上云 + starter（D-159）

- 档案新增仓库段（四桶，**每桶上限 500**，上限值入 `service-config.json` 并由 schema 冻结）。
- **注册事务**：生成 starter（1 角色 + 3 技能 + 2~3 插件，品质 `common`，种子由玩家身份派生，**保证角色/技能 `slotCount ≥ 1`**）→ 写入该玩家服务端仓库 → 按 starter 装配出配置 → 写进 `slot1`（`默认配置`，出战）→ **同时创建 `slot2`/`slot3` 为空槽**（用户口径：配置 2/3 初始"没有物品，所有位置显示空"）。
- 装配/拆卸改为服务端写（新增 `POST /me/warehouse/assemble|disassemble`），`GET /me/warehouse` 为真源。
- 快照的 `warehouseExcerpt` / `loadWarehouse` 三级来源可简化（服务端已有整仓）。
- `11-account-store §15.1` 的作弊面**关闭**；`security-backlog` 相关条目回填"已处置"。
- 老账号**保持空仓**（用户裁定：验收前删号重注册）。

### 9.2 配置完整性校验时机（D-160）

- `PUT /me/configs/:slotId`：**非出战槽**保存时只校验结构与引用（不要求角色/3 技能/AI 齐全）；**出战槽**仍要求完整。
- `POST /me/configs/:slotId/activate`：**此时**校验完整性（角色 + 恰 3 技能 + AI；**允许插槽为空**）→ 不完整 → 409 `cannot_activate_incomplete`。
- `POST /me/configs`：改为**创建空槽**（不再复制当前出战配置），仍受 `maxSlots=3` 与 `slot_limit` 约束。
- 非出战槽保存时是否冻结快照：**本分册建议不冻结**（等 `activate` 时冻结），落地时以实测为准并在 §13 备案。

### 9.3 AI 库（D-161，本批仅后端）

- `GET /me/ai`（列表）、`POST /me/ai`（命名保存，上限 **100**，满 → 409 `ai_limit`）、`DELETE /me/ai/:aiId`（**被出战配置引用 → 409 `ai_in_use`**）。
- 库与物品**分别计数**；可删任意未被引用的 AI。
- 前端本批只用 `GET /me/ai` 作为配置弹窗的候选来源；AI 编辑/管理界面属 F5。

### 9.4 开箱 `seed`（D-162）

- `POST /me/box` 的**请求体没有 `seed` 字段**；seed 一律服务端生成（响应可回带，仅供审计/复现日志）。
- `server/box.js` 的 `openBoxes({seed})` **保持**（离线 `npm run play`/`demo`/核心单测仍可确定性注入）。
- `start()` 增加实例级注入缝（同 `start({replayLimit})` 风格）供 e2e/压测确定性使用。
- 受影响的 9 处调用点（`tests/api/api-box.test.js` T-AP-5、`api-replay-auth`、`e2e-play`、`tests/helpers/{e2e,load}.js`、`scripts/e2e.js`、`cli box --seed`）在提交①内一并修改；`docs/interfaces.md` §2 的 `/box` 行与 T-AP-5 注记同步。

---

## 10. 机器核对（本批新增）

| 编号 | 断言 |
|---|---|
| UW-1 | `public/` 仍为 9 个文件（UI-1 不变）；`render.js` 中 `pick(` 出现 0 次 |
| UW-2 | 非管理员态：`login/register/profile/password/hub/warehouse/box/settings` 各屏渲染的 `data-action` 集合 == 注册表中非管理动作集合（双向，无死按钮、无未注册入口；总数 = 35） |
| UW-3 | 管理员态：F2 的 25 + F3 的 26 = **51** 全覆盖（沿用 AU-1 口径） |
| UW-4 | `format.js` 的 `pick()` 字面量集合 == `contract.js` 声明 == 本分册 §5.1 表格路径集合（双向；§5.2 新增端点落地后回填） |
| UW-5 | 弹窗机制：任何含弹窗的屏，`data-action="modal-close"` 必存在；`state.modal` 至多一个 |
| UW-6 | `fetch(` 只在 `api.js`；`innerHTML` 只在 `app.js`（F1 既有，回归） |
| UW-7 | 后端：`GET /me/warehouse` 返回真源（不再 404 `warehouse_missing`）；装配后 `usage` 更新 |
| UW-8 | 后端：非出战槽可保存不完整配置；`activate` 不完整 → 409 `cannot_activate_incomplete`；完整 → 200 且 `activeSlotId` 更新 |
| UW-9 | 后端：开箱请求体带 `seed` 时**不被使用**（两次不同请求不产生同内容物品）；同玩家连续开箱内容不同 |
| UW-10 | 后端：每分类第 501 件被拒（`warehouse_full`）；AI 第 101 条被拒（`ai_limit`）；删除被出战配置引用的 AI → 409（本批 api 层覆盖） |
| UW-11 | 后端：注册即得 starter（仓库非空、`slot1` 完整、`slot2`/`slot3` 为空） |

---

## 11. 人工走查剧本（总纲 §4.4）—— **F1 + F2 + F3 一次收口**

前置：`npm start`（首次用新注册账号；老账号无 starter，需删号重注册）。

| 步 | 点哪里 | 看什么 | 期望文本 |
|---|---|---|---|
| 1 | 注册新账号 | 落点 | 直接进**主界面**（不再是 F1 的档案页） |
| 2 | 主界面摘要 | — | `昵称 · common · 0 · 未读 进攻0/防守0 · 在池` |
| 3 | 点「用户」 | 用户详情 | F1 的档案各行照旧；**看不到**「登出」按钮 |
| 4 | 点「仓库」 | 仓库 | 四桶容量行 + starter 的角色/技能/插件（**非空**）；行内可见 `[装配于配置1]` |
| 5 | 点某件物品 | 详情弹窗 | 名字/品质/模板/数值/插槽/词条逐项显示 |
| 6 | 点弹窗外空白 | 弹窗关闭 | 回到仓库列表 |
| 7 | 点「开箱」→ 次数 5 → 开箱 | 结果区 | `本次获得 5 件：…`；回仓库可看到新物品 |
| 8 | 再开箱一次（同次数） | 结果区 | **内容与上次不同**（seed 由服务端生成） |
| 9 | 仓库点「技能插件」桶 | 列表 | 切桶生效；容量行不变 |
| 10 | 返回主界面 → 点「出战配置1」 | 配置弹窗 | 角色/3 技能/AI 均为 starter 实物；插槽按实际数量显示并标注类型 |
| 11 | 点「角色模板」 | 候选弹窗 | 列出仓库里的角色 + `空` |
| 12 | 选另一件角色 | 配置弹窗 | 角色已替换；插槽随新角色变化（通常全空） |
| 13 | 点某插槽 | 插件候选 | 类型匹配的可选；**不匹配的标灰并写明原因** |
| 14 | 选一个插件 | 配置弹窗 | 显示已装配（提示写明"已写入仓库那件物品；点「保存」后才进这份配置"）；**仓库里该插件行此时还没有 `[装配于配置1]`** —— 见下方 ⚠️ |
| 15 | 点「保存」 | 结果区 | `已保存`；**此时**仓库里该插件行才出现 `[装配于配置1]` |
| 16 | 点「出战配置2」 | 配置弹窗 | 5 个位置**全为空**且可点 |
| 17 | 点「设为出战」 | 结果区 | `该配置不完整，无法设为出战（缺少 角色）` |
| 18 | 补上角色但技能只填 2 个 → 保存 → 设为出战 | 结果区 | 保存成功（非出战槽不校验）；设为出战 → `缺少 技能3` |
| 19 | 填满 5 个位置 → 保存 → 设为出战 | 结果区 | `已设为出战配置`；主界面摘要/仓库 `usage` 随之更新 |
| 20 | 对**出战中**的配置点某位置 | 候选弹窗 | **没有「空」选项**，只能替换 |
| 21 | 点「设置」→ 改昵称 → 保存 | 结果区 | `昵称已更新为 …`；主界面摘要同步 |
| 22 | 设置点「修改密码」 | 屏 | 进 F1 的密码屏；改密成功后回设置 |
| 23 | 主界面点「快速对战/锦标赛/排行榜/AI编辑」 | 空页 | 各自标题 + `尚未实现（计划批次 …）` + 返回键可用 |
| 24 | 设置点「登出」 | 登录屏 | `已登出`；刷新后仍在登录屏 |
| 25 | **F2 既有 17 步**（`02-accounts.md` §11） | — | 一并走完 |

**✅ 人工走查已完成并通过（2026-09-25，用户本人在真实浏览器按本表逐条执行；F1+F2+F3 一次收口）** —— 记录见 `docs/reviews/F3.md` **§4**。走查中发现的唯一真缺陷（同一件物品可重复占位）已按 **D-163** 修复并复验（§15.8）。

⚠️ **步 14/15 的口径修正（独立审查 F-7，走查前必读）**：本表原先把"装配后立刻看到 `[装配于配置1]`"写在步 14，但那做不到，也不该做 —— **`usage` 只统计"被某份配置引用"，而引用要等 `PUT /me/configs/:slotId` 落库**（§15.2 行 3）。装配（两步顺序第①步）改的是**仓库里那件物品**的 `slots[].pluginUid`，此时服务端返回的 `usage` 里**还没有**这个插件；点「保存」之后才有。所以：步 14 看"编辑器显示已装配 + 提示写明改的是仓库物品"，步 15 看"仓库里出现 `[装配于配置1]`（需先点「仓库」→「刷新」或重进仓库屏）"。

---

## 12. 定稿判定

**本分册不自署"四项全过"**（总纲 §2.10：判定结论只能由 `docs/reviews/F3.md` 独立出具）。§13 列出全部**已知未覆盖 / 已知风险**，供独立审查使用。
**当前判定（`docs/reviews/F3.md`）**：机器核对 PASS（提交①②③ + D-163 收口后 `npm test` = 1058/0、`gate` 9 PASS、`e2e` 22/22、`play` exit 0）；**浏览器人工走查 PASS（2026-09-25，用户本人，§4）⇒ `F1`/`F2`/`F3` 均判定"能玩"**。

---

## 13. 已知未覆盖 / 已知风险（不得为空）

| # | 项 | 说明 |
|---|---|---|
| K-1 | starter 内容规格 | 由 AI 按现有示例表出草案（1 角色 + 3 技能 + 2~3 插件，`common`，种子由身份派生，保证 `slotCount ≥ 1`），用户逐条改；**未定稿前不得实现** |
| K-2 | 非出战槽是否冻结快照 | 本分册建议"不冻结，等 activate 再冻结"；落地时以实测为准并在 §13 备案 |
| K-3 | `usage` 的具体形状 | §5.2 为设计约定（`data.usage[uid].slotIds[]`）；落地后必须回填实测并纳入 UW-4 |
| K-4 | 插槽类型 ↔ 插件类型的可读映射 | 实测已见 `def`/`sp`/`hp`/`atk`/`special`；完整枚举需从 `role-templates.json`/`skill-mechanics.json`/`plugins.json` 取（提交① 内确认） |
| K-5 | 五屏渲染集合的断言口径 | F1 的 UI-2 断言"恰好 9"必须改写为"非管理动作集合"；F2 的 AU-1 同步 |
| K-6 | 快速对战/锦标赛/排行榜/AI编辑 | 本批为空页；`shortfall` 文案、匹配结果文案、排行榜列定义全部留到 F6/F7 |
| K-7 | AI 编辑/管理界面 | 本批只做后端（D-161）；前端无入口（AI 位置只能从库里选） |
| K-8 | O-9 管理员抢注提权 | 用户裁定**接受风险**，登记进 `security-backlog`（新增条目），不修 |
| K-9 | `public/**` 未纳入 `check-arch.js` 分层 | 总纲 O-7 剩余部分，仍未裁定 |
| K-10 | 限速 | 全局限速 600/分/principal；本批全部为手动刷新，无轮询（若将来轮询需先解决限速） |
| K-11 | 老账号 | 无 starter；验收需删号重注册（用户裁定） |

---

## 14. 实施计划（三个提交 + 一次收口）

| 提交 | 内容 | 出口证据 |
|---|---|---|
| ① 后端契约 | `server/store/*`（仓库段 + `usage` 派生 + 上限 + journal 记录 + 迁移）、`server/account.js`（`assemble`/`disassemble`/`ai*`/starter 装配/activate 校验）、`server/index.js`（新路由）、`server/box.js`（`seed` 注入缝）、`server/data/{service-config.json,schema.js}`、`tests/{api,unit}`、`docs/{decisions,interfaces,server,tasks,progress,security-backlog}.md` | `npm test` / `npm run gate` 9 PASS / `check-docs` PASS |
| ② 前端主界面线 | `public/{store,format,render,actions,api,contract}.js` + `index.html`（hub/profile/warehouse/box/settings + 4 空页）+ F1 契约变更（home→profile、登出移位）+ `tests/frontend/*` | 前端用例全绿 + UW-1/2/4/5/6 |
| ③ 前端配置编辑器 | 出战配置弹窗、模板替换、装配（类型矩阵/标灰/替换天然拆插件/空位）、仓库 `usage` 标记 + 机器核对与走查剧本 | 前端用例全绿 + UW-3 |
| 收口 | `docs/reviews/F3.md`（三段审查 + F1/F2/F3 一次人工走查记录） | 走查表逐条填写 |

---

## 15. 实现对账（**提交① 后端契约，2026-09-22 已落地**）

> 约定同 F2 分册 §13：以本节为准，记录"设计与实现的差异 + 过程中发现并修掉的真问题"。提交②/③（前端屏）落地后在本节继续追加。

### 15.1 交付物

| 层 | 文件 | 说明 |
|---|---|---|
| 决策 | `docs/decisions.md`（改） | **D-159…D-162**（§14.3 新增小节） |
| 接口 | `docs/interfaces.md`（改） | §1 模块 ICD（+`server/starter.js`）、§2 端点表（+6 行 / 改 5 行）、§2.1 错误码（+11 个）、§4.8/§4.12 数据结构、§5 D 落点、§6 日志、§7 注入缝 |
| 存储 | `server/store/{archive,adapter-json,ledger,journal,errors,config,index}.js`（改） | 仓库/AI 段、`ARCHIVE_VERSION=2`+`migrateV1toV2`、5 个新记录类型、`NON_COMPACTABLE`、上限校验、`getWarehouse/grantBox/applyWarehouseChange/listAi/createAi/deleteAi` |
| 生成 | **`server/starter.js`（新）** | 确定性 starter（附录 D 定稿口径）+ `scripts/check-arch.js` 登记 |
| 门面 | `server/account.js`（改） | 仓库真源/装配/拆卸/AI 库；starter 注册事务（建满 3 槽）；D-160 校验时机；镜像退役 |
| HTTP | `server/index.js`（改） | 6 组新端点；`PUT /me/configs/:slotId` / `activate` 语义；归档回放与 `ownLoadoutOf` 改走真源 |
| 编排 | `server/box.js`、`cli/index.js`（改） | `seedFactory` 注入缝；CLI `box` 去 `--seed` |
| 数据表 | `server/data/{service-config.json,schema.js}`（改） | `warehouse.maxPerBucket=500`、`ai.maxPerPlayer=100` + 冻结值与跨字段校验 |
| 测试（新增） | `tests/unit/starter.test.js`(7)、`tests/unit/store-warehouse-recovery.test.js`(3)、`tests/api/api-me-warehouse.test.js`(7)、`tests/api/api-me-box.test.js`(5)、`tests/api/api-me-ai.test.js`(6)、`tests/api/api-configs-incomplete.test.js`(6) | **34 条新用例** |
| 测试（迁移） | `tests/api/*`、`tests/unit/*`、`tests/integration/*`、`tests/cli/*`、`tests/contract/*`、`tests/frontend/*` 的旧契约断言 | 见 §15.3 |

### 15.2 与设计的差异（以本节为准）

| # | 设计稿 | 实现 | 理由 |
|---|---|---|---|
| 1 | §9.1 "starter 随注册响应下发" | **服务端在建档事务里直接写入档案仓库**（响应只回 `starter:{issued,seed,counts,…}` 摘要） | 仓库上云后无需再"下发物品正文"；少一次客户端落盘与一次可能的不一致 |
| 2 | §3.7 "替换模板时自动拆掉插件（前端逻辑）" | **不需要任何清理代码** | 插件装在**仓库物品**上；换模板=换用仓库里另一件物品，新物品的插槽状态天然是它自己的（§3.7 的判断被实现证实） |
| 3 | §5.2 `usage` 语义表述为"装配于配置几" | 实现为 **`usage[uid].slotIds[]` = 被哪些出战配置引用**；**与"该插件是否已装配"是两个概念**（未被任何配置引用的仓库物品即便装在某件物品上，也不出现在 `usage` 里） | 避免把"装配状态"与"出战引用"混为一谈；UWH-3 已按此断言 |
| 4 | 附录 A D-159⑥ "快照 `warehouseExcerpt` 可退役" | **保留**为兜底来源（真源优先：`loadWarehouse` → 账号镜像 → 进程内缓存 → 快照子集）。**D-163 起 HTTP 配置保存不再写入该字段**（路由不传客户端镜像 ⇒ 快照不带 excerpt），只有服务端内部传仓库的路径（注册 starter）仍带 | 兼容旧数据（v1 档案、旧 bot、旧 e2e 流程），零迁移风险 |
| 5 | §9.2 "非出战槽保存时是否冻结快照待定（K-2）" | **不冻结**（`snapshot:null`，`loadout` 正文随 journal 记录落盘） | 不完整配置无可实例化快照；`activate` 时自愈冻结 |
| 6 | §3.1 hub 摘要"昵称+段位+积分+未读+在池" | 后端**已具备**（`GET /me` 现有字段），无需新契约 | 提交② 直接消费 |

### 15.3 过程中发现并修掉的真问题（**代码级审查产出**）

| # | 问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | **装配/拆卸的 `equipped` 未落档**：`warehouse.assemble/disassemble` 的 apply 只写 `slot.pluginUid`，不维护插件物品的 `equipped`；而 `server/loadout.js:95` 用 `p.equipped !== true` 判"插件未装配"、`core/items.assemble` 用 `equipped === true` 判"已装配别处" | ① 拆卸后插件仍 `equipped=true` → **再也装不回去**（409 `plugin_equipped`）；② 新装配的插件 `equipped` 未置位 → **引用它的出战配置无法保存**（409「插件未装配」）→ D-159 的"开箱→装配→出战"在服务端仓库上**走不通** | 已修：apply 与检查点物化两条路径同步 `equipped`（装配置 `true`；拆卸把被拆下的插件置 `false`）；回归用例 `UWH-7`（开箱→装配→配置引用→激活→实战→归档回放→拆卸→再装回） |
| 2 | **归档回放重算的仓库来源过期**：`serveReplay` 只用快照自带的 `warehouse` 子集；D-159 起保存配置**不再要求**提交镜像 → 快照无子集 → 该场回放**永久 410 `replay_expired`** | 打过的对局看不到回放 | 已修：`p1Warehouse/p2Warehouse` 改为 `await rt.loadWarehouse(playerId) || snap.warehouse || null`；`ownLoadoutOf` 同口径改真源优先；实测"不带 warehouse 保存→实战→回放"200（49 帧） |
| 3 | **`boxSeed` 注入缝 off-by-one**：注释/文档写"第 n 次 = `boxSeed+n−1`"，实现为 `boxSeed+n` | 文档与行为不一致（测试无法据文档写期望） | 已修**代码**对齐文档：实测 `start({boxSeed:1000})` 两次开箱回带 `1000,1001` |
| 4 | **旧测试的潜在缺陷被新对局结果触发**：`quickmatch` 回带的 `delta` = 档案落盘值之差（受 §8.3 下限保护 `clamp(…,0,cap)` 影响），而测试按"公式原始 Δ"复算；0 分玩家输球时两者不等 | 该断言只在"无 0 分输球"时成立（flaky by design） | 已改写为**更强**断言：守恒式恒真 + 仅在未裁剪时比公式值 + 裁剪档断言 `pointsAfter===0`；并新增全局对账 `ΣΔ_applied === ΣΔ_formula + floorInjection`（同时把"下限保护会注入分数"记入 `11-account-store.md` §8.3） |
| 5 | **`isRecordApplied` 未覆盖新记录类型**（设计时即考虑）：新记录是"状态量"，若沿用"未知类型 → 视为已应用"会在水位缺口时漏 apply | 崩溃恢复可能丢物品/丢 AI | 已实现内容级幂等键：`box.opened` 用 `grantIds` 环形窗口（256）、`warehouse.*` 用"目标槽当前引用是否已等于记录值"、`ai.*` 用 `aiId` 存在性；`WR-3` 断言重复重放不翻倍、`stats.reapplied === 0` |
| 6 | **`createPlayerArchive` 显式 loadout 路径丢弃入参 `warehouse`**（**独立审查 F-1，中**）：用 `o.warehouse` 做校验与冻结快照，却只把 `starter.warehouse` 落档 | 校验所用镜像 ≠ 落档镜像 → 该配置的插件引用在**档案侧永久悬空**（`GET /me/warehouse` 与 `usage` 自相矛盾），之后连"重存同一份出战配置"都 409；`admin`/工具类调用方踩坑 | 已修为一行为 `warehouse: starter ? starter.warehouse : (o.warehouse \|\| undefined)`（HTTP 注册路由从不传 loadout，故此缝不构成客户端注入面）；回归用例 **WI-1**（落档计数 + 重存配置 200 + 引用齐备） |
| 7 | **`box.opened` 防御分支静默丢弃超限物品**（**独立审查 F-2，低**）：桶满 `continue` 只记 warn，仍返回 `changed:true` 并推进水位 | journal 写"N 件"、档案只落 M<N 件且**永久漂移**（水位已过，rebuild 也补不回）；正常路径由 `grantBox` 前置拒绝（实测 409 原子零写入），仅"档案与 journal 不一致"时可达 | 已修为：逐件 **error** 记录（带 `grantId`/`uid`/桶）+ 把 `dropped`/`droppedUids` 落进 `grantIds` 环形条目（差额**可审计**；不抛错——抛错会让 journal 重放永久失败）；回归用例 **WI-3** |
| 8 | **直接替换槽位引用时未复位旧插件的 `equipped`**（**独立审查加固项**）：HTTP 路径被 `slot_occupied` 拦死，故不可达；畸形/重放记录可构造 | 旧插件永久停在 `equipped=true`（再也装不回去） | 已加固：`warehouse.assemble` 分支在 `prevPluginUid !== record.pluginUid` 时把旧插件复位为 `false`；回归用例 **WI-2**（走 store 层构造替换记录） |

### 15.4 已知项 / 未覆盖（承接 §13）

| # | 项 | 现状 |
|---|---|---|
| N-1 | **AI 库不做 AST 校验** | 只做结构检查（`program.type==='program'`）+ 名称长度；完整校验由 F5 编辑器保存前调 `POST /ai/validate`（D-161 已登记） |
| N-2 | **老账号空仓** | `migrateV1toV2` 只补空结构；验收需删号重注册（用户裁定） |
| N-3 | **`index.seq()` 对 A 类写偏保守** | `queueFor` 路径（开箱/装配/AI/配置保存）不调用 `index.setSeq` → 派生索引水位可能滞后于 journal 水位，使 `journal.compact` 更保守（不压缩）——**行为安全**（真源不丢），属既有特性；本批未改 |
| N-4 | **`validateArchive` 未校验 `equipped` 自洽** | 建议后续补"仓库内 `slot.pluginUid` 指向的插件必须存在且 `equipped===true`"的不变量（本次缺陷若早有此检查即可写档即暴露）；本次**未加**以免与在途测试迁移冲突，登记给 F3 独立审查 |
| N-5 | 前端屏（提交②/③） | 未开始：hub/profile/warehouse/box/settings + 出战配置编辑器 = `docs/frontend/03` 的 §3/§4；机器核对与走查剧本见 §10/§11 |
| N-6 | `PUT /api/v1/warehouse`（遗留纯函数路径） | 未纳入 UI；`POST /api/v1/box`（遗留）同样未接 UI（登记于 §1 第 20 行） |
| N-7 | **`core/effects.js` 的 effect uid 是进程级自增 → 归档回放帧只做到"除 `eff_N` 外逐字节一致"**（**既有缺陷，本批暴露未修**） | `server/core/effects.js:36-44` 模块级 `let uidSeq = 0`；同一场对局在同进程内重算两次会得到不同的 `eff_N` 文本（并进入 `aiTrace` 文案）。旧默认配置无插件 → 无持续效果 → 掩盖了它；D-159 的 starter 带 `castEffect`/`hitEffect` 词条后暴露。**现状**：`tests/api/api-replay-auth.test.js` 的 RP-3/RP-8 按"uid 抹平 + 按首现序重编号后逐字节一致"断言（只放过这一个非确定性维度）。**建议修法**（不在本批范围）：把 uid 改为按对局确定的量（如 `eff_t<tick>_<n>` 或 `createBattle` 内重置计数器），修后需按 `.audit/` 的流程重锚黄金战斗并同步 `interfaces.md` §4.2 |
| N-8 | `PUT /me/warehouse` 回执的两个字段语义分叉 | 已补 `archiveUnverifiedLoadout`（档案真源口径）并保留 `unverifiedLoadout`（本次镜像口径）；`interfaces.md` §2 该行已写清（B29 遗留命名，退役端点） |
| N-9 | **L6 的"读→校验→写"不在 store 的同一把玩家锁内**（独立审查 WI-5 实测）：同一槽并发装配时可能"两次都 200、后写胜出"，而非"一成一败 409" | 后果可控：终态**自洽**（已装配集合 ≡ 被槽引用集合，WI-5 断言），且单客户端界面不会并发；更严格的修法是把校验挪进 store 的 `queueFor` 临界区（本批未做，登记） |
| N-10 | **桶满（500）后玩家无法自行解封**：目前**没有物品删除/分解端点**，D-159 只给了"超限拒绝开箱" | **产品级决策待定**（需用户拍板）：是否新增"删除/分解物品"能力，或把上限做成软限制；在决策前，界面上只能如实提示"仓库已满"（提交② 的禁用 + 提示已按此实现） |
| N-11 | v1 老账号"可玩但配置存不回"：老账号仓库为空（D-159② 有意口径），重存同一份出战配置会 409 `loadout_invalid`（details 逐条 `悬挂引用 <uid>`，**可判定**） | 属过渡态（用户已裁定"老账号删号重注册"）；若要更友好，可在响应里给 `missingWarehouseRefs` 摘要（本批未做，登记） |

### 15.5 机器证据（提交① 收口实跑，2026-09-22）

| 命令 | 结果 |
|---|---|
| `node --test --test-isolation=none tests/unit/starter.test.js` 等 **6 个新文件** | ✅ **34/34**（starter 7 / 仓库 7 / 恢复 3 / 开箱 5 / AI 库 6 / 配置完整性 6） |
| `npm test`（全量） | ✅ **1024 通过 / 0 失败**（迁移前 987；含本轮新增 34 + 迁移后新增/拆分用例） |
| `npm run cov`（覆盖率门禁） | ✅ 逐文件阈值通过（行 ≥90 / 分支 ≥85 / 函数 ≥90；gate 项 7 明细：1024 用例全过） |
| `npm run gate` | ✅ **9 PASS / 0 FAIL / 0 PEND** |
| `node scripts/check-docs.js` | ✅ PASS（批次计数仍 **41**；`docs/frontend/*` 不纳入 D1–D6） |
| `node scripts/check-arch.js` | ✅ PASS（**40** 文件，含新文件 `server/starter.js`） |
| `node scripts/e2e.js`（`npm run e2e`） | ✅ **exit 0，22/22 检查点**（含新增的 D-159-R1 回放回归；连跑 7 次稳定） |
| `node scripts/load-test.js --players 20 --deep` | ✅ **ok=true，7/7 完整性断言**（无 5xx；A6 双方均为真实注册玩家、无 bot） |
| 端到端回归护栏 | `tests/api/api-me-warehouse.test.js` UWH-7（开箱→装配→配置→实战→归档回放→拆卸→再装回）｜`tests/api/api-me-box.test.js` UBX-5（重启后真源仍在）｜`tests/unit/store-warehouse-recovery.test.js` WR-1…WR-4（**仅靠 journal 重放**恢复仓库/AI 库、重复重放幂等、状态量段不压缩） |

### 15.6 提交②（前端主界面线）实现对账 —— ✅ 已落地（2026-09-24）

| # | 设计稿 | 实现 | 理由 |
|---|---|---|---|
| 1 | §4 动作白名单（提交② 部分） | 注册表 **42** 个动作（F1 9 + F2 16 + 提交② 17）；**提交③ 的 9 个编辑器动作未注册空壳** | 保证"注册表 ↔ 渲染集合"双向断言仍有判别力（空壳动作会让断言失去意义） |
| 2 | §4 注释"非管理员态 35（含提交③）" | 提交② 实测 **26**（= 42 − 16 管理动作）；提交③ 完成后为 **35** | 数字随实现推进；断言按**实际注册表**双向核对，不写死与实现不符的数 |
| 3 | §3.4 开箱屏（超限禁用） | 补"进入屏静默取一次仓库 + 成功后静默刷新" | 否则手上没有 `caps`/桶长度，"本地禁用且不发请求"无法成立（原设计漏了这条数据来源） |
| 4 | §5.2 新端点字段 | 全部**以真实响应回填**（9 条信封路径 + 34 条物品详情子路径）；另立「明确不读」清单 4 条并纳入 FC-3/FC-4 双向核对 | 总纲 §4.2「字段名可追溯」+ §3.3「引用即承诺」 |
| 5 | §3.6 空页 | 4 个空页统一（标题 + `尚未实现（计划批次 F5/F6/F7）` + 仅返回键、零请求） | 一致性好、机器可核 |
| 6 | §3.1 hub 摘要 | 额外：注册/登录成功后**自动取一次 `GET /me`** | 否则登录后摘要区显示"尚未读取到档案数据"，与 §11 步 2 的期望不符 |

**提交② 的机器证据**：`tests/frontend/*` **73/73**（原 60 + `hub-warehouse-flow` 13）；`npm test` **1042/0**；`gate` **9 PASS**；`check-docs`/`check-arch` PASS。
**去 flaky（提交② 期间发现）**：① `tests/api/api-ranked.test.js` P2-5「5 场全平局」→ 固定 `publicId`+`playerId`（starter 种子含两者）后确定；② 本分册新增的 `api-me-warehouse.test.js` UWH-3/4/7 原从**随机开箱**结果里挑"类型匹配组合"→ 改为**注入确定性夹具**（`injectAssemblable`），UWH-4 另补"同槽匹配插件必须成功"的归因对照。详见 `docs/reviews/F3.md` §6.4 R-6。

### 15.7 提交③（出战配置编辑器）实现对账 —— ✅ 已落地（2026-09-25）

**交付物**（改动仅 `public/**` 与 `tests/frontend/**`；`docs/**` 由本次收口补写；`server/**` **未改**）

| 文件 | 内容 |
|---|---|
| `public/store.js` | `MODAL_KINDS` +3（`slot-pick`/`plugin-pick`/`ai-pick`）、`CONFIG_POSITIONS`、`SKILL_SLOTS`；`configs = {data, ai, draft, dirty}`；新 reducer `configs.ai.set` / `configs.draft.set` / `configs.draft.patch`（局部替换 = `dirty:true`；无草稿时幂等返回原状态） |
| `public/format.js` | `modalViewModel` 分派 5 种弹窗；编辑器投影 `configEditorRows`（角色模板 / 角色插槽**按实际数量与类型** / 技能1–3 及其插槽 / 战斗AI；**每个位置都是可点按钮，`空` 也可点**）+ `configStatusText` + 三个候选弹窗（`slot-pick` 同分类 + `空`；`plugin-pick` **全部列出**、类型不符 → 置灰 + 行内写明原因；`ai-pick` 取 AI 库条目）；草稿工具 `draftForSlot`/`draftLoadoutOf`/`applySlotChoice`/`setItemAt`/`assemblyTargetOf`/`pluginCandidatesOf`/`aiOptionOf`/`applyAiChoice`/`missingOf`；两步顺序第②步投影 `warehouseChangeEnvelope`/`updatedItemOf` |
| `public/render.js` | `modalHtml` 支持 `modal.rows`（候选行，复用 `rowListHtml`）；`targetAttrs` +`data-pos`/`data-idx`/`data-empty`/`data-ai-id`（全部经 `esc()`） |
| `public/app.js` | `payloadOf` 解析上述 4 个属性 |
| `public/actions.js` | 9 个新动作 + `config-open` 换成真编辑器 + `modal-close` 一并丢弃草稿；公共工具 `loadConfigs`/`loadAiList`/`warehouseChange`/`applyPluginChange` |
| `public/api.js` | +`assemble`/`disassemble`/`saveConfig`/`activateConfig`（仍**唯一** `fetch` 出口） |
| `tests/frontend/config-editor-flow.test.js` | **CF-1…CF-10**（真实 HTTP + 真实前端模块 + 手写假 DOM） |
| `tests/frontend/render-escaping.test.js` | **ESC-1…ESC-5**（转义不变量，见下 P-2） |

**状态机（一句话）**：`config-open`（`GET /me/configs` + 静默 `GET /me/warehouse` + `GET /me/ai`）→ 灌草稿（`dirty=false`）→ `slot-set`/`ai-set` 只改草稿 → `plugin-set`/`plugin-clear` 走**两步**（① 装配端点改仓库那件物品 → ② 用响应回带的 `warehouse` 取回**更新后的那件物品**替换草稿）→「保存」`PUT /me/configs/:slotId`（成功 `dirty=false` + 静默刷新仓库）→「设为出战」`POST …/activate`（成功刷新配置列表 + 仓库 + `/me`）→「关闭 / 点背景」一律关弹窗 + 丢弃草稿。

| # | 设计稿 | 实现 | 理由 |
|---|---|---|---|
| 1 | §4 白名单（提交③ 部分） | 注册表 **51** = F1 9 + F2 16 + 提交② 17 + 提交③ 9；非管理员态 **35** = 51 − 16 管理动作 | UI-2/AU-1 按**实际注册表**双向核对（父代理用独立探针复算：注册表 51、非管理 35、渲染集合与注册表**双向相等**、管理动作零泄漏） |
| 2 | §3.7 状态行「未保存/已保存 · 非出战/出战中」 | 追加「· 草稿完整/不完整（缺少角色物品、技能位置缺失: N…）」 | 玩家在点「保存」前就需要看到缺什么；完整性用**本地镜像** `format.missingOf`（与服务端 `archive.loadoutMissingOf` 逐规则同判、文案与 `loadoutMissingDetails` 逐字一致），**只用于状态行与前置提示，不用于决定是否发请求**（是否 409 一律由服务端判定） |
| 3 | §4 `config-activate` 直接发 `POST …/activate` | 追加客户端前置：草稿 `dirty` 时提示「有未保存的修改：请先点「保存」再设为出战」并**不发请求** | `activate` 作用在**服务端**那份配置上；不拦会出现"看着是新的、出战的是旧的"。可见提示 ≠ 无声按钮（00-rules §4） |
| 4 | §3.7 `config-open` = `GET /me/configs` | 追加 2 个**静默**请求（`GET /me/warehouse` + `GET /me/ai`） | 否则模板候选为空、AI 位置只能显示裸 `aiId` 而非 §3.7 要求的 **AI 名字**；两者失败都可见且不挡开弹窗（候选区显示「尚未读取…」占位） |
| 5 | §3.8 弹窗背景/关闭 = 「关闭并丢弃未提交输入」 | 二级选择弹窗的关闭**按字面**执行：关闭整个弹窗 + **丢弃整个草稿**（不返回编辑器） | 见 **N-12**（待裁定：另一种读法是"取消本次选择并回到编辑器"，但那会让"关闭即丢弃"这条机器核对断言失去意义） |

**过程中发现并修掉的真问题**

- **P-1（本批唯一真缺陷；父代理自查发现）**：`format.js` 三个**玩家可见**的 `hint` 里混入了 Markdown 强调符（`选中即替换**草稿**` 等）。本 UI **没有任何 Markdown 渲染器**（00-rules §1 只允许按钮/文字/输入框），玩家会原样看到 `**草稿**`。已改为纯文本（`…选中即替换草稿`）。**这条正好是"机器测试 ≠ 能玩"的实例**：三种缺陷（含此条）在 1057 条用例全绿时依然存在。
- **P-2（前一批遗留的**测试盲区**，本批补网）**：`render.js` 是**唯一** DOM 字符串产出点，而它的 `esc()` **此前没有任何测试钉住**。新增 `tests/frontend/render-escaping.test.js`：ESC-1 逐插值点注入 `'<b>hack</b>'` / `'"><img src=x onerror=alert(1)>'`（title/notice/result/hint/lines/rows/confirm/modal/fields/buttons/`data-*`）→ 输出不得出现未转义标记、且文本以实体形式**保留**（可见降级而非静默丢弃）；ESC-2 `'` 属性禁用（`esc()` **不**转义单引号，故必须恒用双引号属性）；ESC-3 `esc()` 字符表与边界；ESC-4 **真实 HTTP**：昵称 `<b>hack</b>`、AI 名 `<svg/onload=x>` 都**原样落库并原样返回**——实测证明**服务端不消毒**（`isValidNickname` 只校验长度 1~16、`createAi` 只校验 1~24，字符集均不限），故转义是**唯一防线**；ESC-5 结构断言 `render.js` 不引用 `document`/`innerHTML`（与 `public/app.js:109` 是唯一 `innerHTML` 赋值点互为印证）。

**新增登记项（承接 §13 / §15.4）**

- **N-12**：二级选择弹窗的「关闭/点背景」按字面丢弃**整个**草稿——编辑中途误点背景即丢失全部未保存改动。待裁定：保持字面（当前）或改为"回到编辑器、仅取消本次选择"（可复用 `modal-close`，无需新动作，但需改 §3.8 与 WH-8/CF-7 断言语义）。
- **N-13**：偏差 #3（`activate` 的"先保存"前置）是**超设计稿**的行为，已登记待你确认；若你要求严格照 §4 发请求，则需删掉该前置并同步 CF-6。
- **N-14**：完整性判据有**两份实现**（服务端 `archive.loadoutMissingOf` + 前端镜像 `format.missingOf`，含 5 条中文文案）。当前逐规则一致（本次收口核对），但服务端改文案时前端**不会**报错。缓解：错误路径优先用服务端 `error.details[].message`（前端镜像只服务状态行）。
- **N-15**：`public/**` **不在**覆盖率门禁的四目录（`server/core`、`server/ai`、`shared`、`cli`）内。本次实测（仅前端测试，非全仓）：`format.js` 行 98.74 / `render.js` 99.33 / `contract.js` 99.43 / `store.js` 97.49 / `api.js` 97.30 / `actions.js` 93.44，但**分支**偏低（`app.js` 53.01 / `actions.js` 67.45），未覆盖的集中在防御性早返回分支（如 `format.js:941-947` 的"插槽类型取不到"、`format.js:736` 的"仓库未读到时替换模板"）。
- **N-16**：`plugin-pick`/`plugin-set`/`plugin-clear` 的 `payload === null ? null : payload.idx` 只挡 `null`，传 `undefined` 会抛 TypeError（当前不可达：`public/app.js:138` 唯一调用点已把 `undefined` 归一为 `null`）——**已加固**，见收口修复表 N-16 行。
- **N-17**：§6 要求的 `插件点数不足（需要 <x>，剩余 <y>）` 与 `技能必须恰 3 个（实际 N）` 里**数字**目前拿不到 —— 服务端 `error.details` 只给 `path`/`code`/`message`（`archive.js` 的 `loadoutMissingDetails`）。要满足表格原文需**后端补 need/left**（00-rules §2.7 流程，本批不做）。

### 15.8 D-163 热修（2026-09-25）—— 用户实测报告触发的三个真缺陷

**触发**：用户走查后报告「**同一个物品能被重复装配**；被标记为已装配的物品无法被继续装配，直到被拆卸或替换下来」。按 00-rules §2 的复述协议，我先做复现而不是直接改代码，结果**确认了报告，并顺带挖出两个更严重的缺陷**（全部为真实 HTTP + 真实服务端模块实测）。

| # | 现象与实测证据 | 根因 | 处置（→ `decisions.md` **D-163**） |
|---|---|---|---|
| **P0 作弊面** | `PUT /me/configs/slot2` 提交一件 `stats={hp:100000,atk:99999,def:99999}` 的"角色"（**甚至 uid 完全不在仓库**）→ **200**；`POST …/activate` → **200**；服务端留存与出战快照就是这些数值；用服务端自己的 `battle.buildPlayer` 建玩家 → `maxHp=100000`。而 `quickmatch.js:314/320`（与 ranked）用的正是 `snapshot.loadout` ⇒ **真实对局可被打穿**。另：`warehouseForValidation` 修前**优先返回客户端提交的 `warehouse` 镜像**，所以"同时 PUT 一个自带 buff 物品的镜像"即可让解析从假镜像取数 | `validateLoadout` 只校验 `kind`/`templateId`/`quality` 与**插件**引用（且带 `errors.length === 0` 前置 → 不完整配置整段跳过），**从不校验模板物品是否属于该玩家、也不校验数值**；L6 又把客户端正文原样落盘并冻进快照 | 保存/创建/激活一律按 uid 从**服务端仓库**解析（`loadout.resolveItems`；客户端数值丢弃、未知 uid → 409 `物品不在仓库`）；`loadout.buildPanel` 在有仓库时**同样先解析**（纵深防御 → 历史遗留的被篡改快照也失效）；HTTP 配置路由**不再采纳** `body.warehouse` |
| **同配置内重复占位** | 同一件**无插件**的技能物品占满同一份配置的 3 个技能位 → **200**（连**出战槽**也 200）；而"同一插件被双处引用"是被拒的 ⇒ 两条规则不一致（**正是用户报告的第一句**） | 去重只覆盖插件引用（`T-PB-8`），不含模板物品 uid | `resolveItems` 对 角色 + 3 技能 + 全部插件引用做**全 uid 去重**（`同一物品被多处引用: <uid>`）；`skills.length > 3` 直接 409（不再静默截断） |
| **开箱静默丢件** | 固定 `dataDir` 的**两进程真实重启**探针：A 进程注册+开箱 12（全落）→ 关服务 → B 进程重新登录+开箱 12 → 响应/journal 记 12 件，**档案只新增 2 件、10 件无声消失、仓库相关日志 0 条**；前端却提示"物品已直接入服务端仓库" | 物品 uid 由 `core/items.js` 的**模块级**计数器生成（进程重启归零），而 uid 的身份域是"每仓库唯一" ⇒ 撞车；`archive.js` 的 `box.opened` apply 对撞 uid 件 `continue` **静默丢弃**（无日志、无审计） | `store.grantBox` 在**写 journal 前**调用 `archive.allocateGrantUids` 重映射撞车 uid（**响应 = journal = 档案**）；闸门丢弃改 `error` 日志 + `dropped` 入 `grantIds`（可审计） |

**跨配置独占（用户裁定）**：用户选择「禁止跨配置共享 —— 一件物品同一时间只能被一份配置引用」。实现：`exclusivityDetails` 用 `archive.warehouseUsage`（单一真源）判定，save/create/activate 三处生效 → 409 **`item_in_use`**（`details` 逐 uid，写明占用它的 slotId）。**这推翻了 D-159② 的"同物品可被多配置引用"**（`usage[uid].slotIds` 现在至多一项）。

**前端配套（同一提交）**：`slot-pick`/`plugin-pick` 把"点了必然 409"的候选**预先标灰 + 行内写原因**（`已被配置N使用…` / `本配置已在其它位置使用…` / `已被装配（请先拆卸）` / 既有 `此槽只能装 <type>`）；前端**不读** `equipped` 字段，而是从已登记的 `slots[].pluginUid` 推导"已装配"（避免为 UI 扩大字段契约）。

**连带修正**：`scripts/play.js` 的离线对局原来把**同一份**仓库同时给双方，而 p2 是内置 bot（物品 uid 为 `bot_role`/`bot_skill1..`）→ D-163 下会被拒（`npm run play` 真的坏掉）。已改为**逐侧仓库**（`{p1: wh2, p2: ranked.syntheticVerifiedWarehouse(bot)}`）；`ranked.syntheticVerifiedWarehouse` 同时补上"**角色与技能也在其中**"（修前只有插件项，导致退化路径报 `物品不在仓库`）。

**测试与证据（收口实跑）**：`npm test` = **1058 通过 / 0 失败**（两轮）；`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**（digest `a1c5b11c0092`）；`npm run e2e` = **22/22（exit 0）**；`npm run play` = **exit 0**；`load-test --players 20 --deep` = **ok=true，7/7**；`check-docs` = PASS（批次仍 41）/ `check-arch` = PASS（40 文件）。共 **18 个既有测试文件的夹具按新规则重整**（只改夹具与断言口径，未删断言、未放宽强度）+ 三个缺陷各自的回归断言；逐条处置与登记见 `docs/reviews/F3.md` §8。

**机器证据（提交③ 收口实跑，2026-09-25；父代理独立复跑，非实现者自报）**

| 命令 | 结果 |
|---|---|
| `node --test --test-isolation=none "tests/frontend/*.test.js"` | ✅ **89/89**（HEAD 73 + CF 11 + ESC 5） |
| `npm test`（**连跑两轮**：一次显式 `npm test` + 一次 gate 项 7） | ✅ **1058 通过 / 0 失败**（两轮一致） |
| `npm run gate` | ✅ **9 PASS / 0 FAIL / 0 PEND**（项 7：1058 用例；digest `a1c5b11c0092`）；项 3 = 40 文件无依赖违规 |
| `node scripts/check-docs.js` / `check-arch.js` | ✅ PASS（批次计数仍 **41**）／✅ PASS（**40** 文件） |
| `node scripts/e2e.js` | ✅ **exit 0，22/22 检查点** |
| CF 用例稳定性（去 flaky 复核） | ✅ `config-editor-flow.test.js` **连跑 5 次 = 5×11/11 通过**（CF 夹具在需要处注入确定性物品，不赌随机 starter 内容） |
| 动作注册表独立复算（父代理探针） | ✅ 注册表 **51**（F1 9 + F2 16 + F3 26）；非管理 **35**；我**自己**枚举 14 屏 + 5 类弹窗子态得到的渲染集合与注册表**双向相等**、管理动作零泄漏、无死动作/不可达动作 |
| 两步顺序的最终证据 | `CF-3`：装配请求体逐字 `{targetUid,pluginUid,slotIndex}` → `assert.notStrictEqual(after,before)`（证明换用了**响应回带**的物品）→ 保存后 `GET /me/configs` 的 `slots[2].loadout.role.slots[0].pluginUid` **真的变了**；`CF-4` 拆卸同断言；`CF-9` 在 DOM 层再造一次同链路 |
| 契约与措辞核对 | `contract.js` 把 `data.warehouse` 从「明确不读」移入正式契约（`me/warehouse/assemble` 三行）、新增 `me/configs` 两行 + `CONFIG_SLOT_FIELDS`/`AI_ITEM_FIELDS`；`data.maxSlots`/`data.caps.max` 仍留「不读」并写明**为何不需要**；`missingOf` 与服务端 `loadoutMissingOf` 逐规则一致、文案逐字一致 |

**人工走查注意（补进 §11 步 10–21）**：① 改完位置后**先点「保存」再点「设为出战」**，否则会被偏差 #3 拦下（这是设计意图，不是故障）；② 打开二级候选后**不要点弹窗外面**——按 N-12 会连同未保存改动一起丢弃；③ 出战中的配置候选里**没有**「空」，插件可清空、角色/技能置空会被服务端 409 拦下（文案应逐位置可读）；④ 步 14/15 的 `[装配于配置N]` 时点见 §11 末尾的 ⚠️。

**独立审查（2026-09-25）与收口修复**

方式同提交①：**新上下文子代理只读对抗式审查**（探针全部在系统临时目录，仓库零改动），逐条核对 7 项声称并自跑 `npm test`/`gate`/`check-docs`/`check-arch`。**结论「有条件通过（有需修缺陷）」**：编辑器核心（两步顺序、草稿、B-5/B-8、51/35 计数）经真实 HTTP 验证成立，但发现 **2 条需修 + 3 条疑似 + 3 条记录**。逐条处置：

| # | 审查发现 | 处置 |
|---|---|---|
| **F-1**（需修） | **取消弹窗会被 in-flight 响应撤销**：`modal-close` 无 busy 守卫、背景元素是弹窗内唯一不随 busy 禁用的可点元素；而装配/取 AI 库在两个 `await` 之后**无条件** `modal.set` → 用户在等待响应时点外面关闭，弹窗会被"复活"，且草稿已被丢弃 ⇒ 编辑器按服务端副本渲染"未改动"，与提示「已装配」、仓库里那件物品**真的装上了**三方矛盾 | ✅ **已修**：新增条件 reducer **`modal.setIfOpen`**（"当前还有弹窗才替换"），装配/拆卸、`ai-pick`、`config-open` 一并改走它。**条件必须在 reducer 里判** —— 动作拿到的 `ctx.state` 是**动作开始时**的快照（`public/app.js` buildCtx），`await` 之后读它永远判不出"用户是否已取消"（我第一版用对象引用比较就是这么错的，被新写的 CF-11 立刻抓住）。回归：**CF-11**（延迟 60ms 响应 + 期间点背景关闭 → 弹窗不得复活、草稿保持丢弃、提示仍可见、仓库确实已改） |
| **F-2**（需修） | **槽级字段契约缺失，且"三方一致"是单向的**：`format.js` 用**直接属性访问**读 `loadout.aiId`（AI 位置显示名的来源；服务端 `aiRefsOf` 也按它统计引用 → `DELETE /me/ai/:aiId` 的 409 `ai_in_use` 判据），但 `aiId` 既不在 `contract.js` 也不在 §5.1；CF-8 只断言"声明 ⊆ 实读"，而直接属性访问根本不进 `pick()` 字面量集合 ⇒ 字段漂移会让"删除出战配置正在引用的 AI"静默放行而断言全绿 | ✅ **已修**：`contract.js` 新增 **`CONFIG_LOADOUT_FIELDS = ['role','skills','ai','aiId']`**（含"为何 aiId 非装饰字段"的说明）；§5.1 补登记 `data.slots[].loadout.aiId`；**CF-8 增源码级双向断言**（代码里每个 `loadout.<字段>` ⟺ 声明表，且声明 ⊆ §5.1 登记 + 真实响应可解析）。该断言写完立刻抓到我自己引入的假匹配（文件头注释里的分册文件名 `…-loadout.md` → `md`），故扫描**只看代码行** |
| F-3（疑似） | 取消/切屏只丢弃草稿，**不回滚**两步顺序已造成的仓库改动，且无提示 | ✅ **按"写明"处置（不做回滚）**：服务端第①步已落 journal，回滚不在设计内；改为**成功文案一律写明作用对象** —— `已装配（已写入仓库那件物品；点「保存」后才进这份配置）`／`已拆卸（…）`，两条路径都成立，且顺带解释"为何仓库变了、配置还没变"（CF-3/CF-10 的文案断言同步更新，仍为精确匹配） |
| F-4（疑似） | `points_exceeded` 文案未给"需要 x / 剩余 y"（§6 表格如此要求），`技能必须恰 3 个（实际 N）` 同理；x/y 无法从错误契约推出 | 📌 **登记待裁定（N-17）**：要给出数字需**后端在 `error.details` 里附带 need/left**（走 00-rules §2.7 的后端变更流程），本批不动；当前实现保留"服务端原文"可读兜底 |
| F-5（疑似，不可达） | `missingSummaryText` 对 `path === null` 会 `null.path` 抛 TypeError | ✅ **已加固**（1 行防御写法）：`typeof p === 'string' ? p : (p && typeof p === 'object' ? p.path : '')`；服务端恒给字符串路径，故当前不可达 |
| F-6（疑似） | 「清空此槽」对**出战中**的配置也渲染，而 D-160/§3.7 写"出战中的配置只能替换、不能拆卸" | ✅ **已澄清口径（非代码缺陷）**：该措辞指**模板位置**（角色/技能不允许置空 → 409）；插槽内的插件**可以**清空（服务端 200，CF-4② 实测），与 D-160 的完整性判据（允许插槽为空）一致。§3.7 已就地写明 |
| F-7（记录） | §11 步 14 要求"装配后立刻在仓库看到 `[装配于配置1]`"，但 `usage` 只统计**已保存**配置 ⇒ 该步按字面**无法通过**（而 §11 是 §4.4 的可玩性出口） | ✅ **已改正剧本**：步 14 = 编辑器显示已装配 + 提示写明改的是仓库物品；**步 15（保存后）**才看 `[装配于配置N]`；§11 末尾加了 ⚠️ 说明 |
| F-8（记录） | `store.CONFIG_POSITIONS`/`SKILL_SLOTS` 与 `format.js` 私有副本重复；`contract.js` 注释把 CF-8 误写成 CF-10；§7 的状态形状与实现不符 | ✅ **已修**：注释订正为 CF-8；§7 的状态块改为实测形状（`configs = {data, ai, draft, dirty}`、`warehouse = {envelope, loading}`）并补 `modal.setIfOpen` 语义（私有常量重复保留：`format.js` 不读 store 导出属本项目分层约束，行为已由 CF-1 的"恰好 3 个技能位置"断言覆盖） |
| N-16（父代理探针） | 264 次畸形/敌意 payload 调用中发现：`plugin-pick`/`plugin-set` 在 `payload === undefined` 时抛 TypeError（代码写作 `payload === null ? null : payload.idx`，只挡了 `null`） | ✅ **已加固**（当前不可达：`public/app.js:138` 的 `def.run(ctx, payload \|\| null)` 是唯一调用点，已把 `undefined` 归一为 `null`）。仍修的理由：该"单点归一"一旦消失（第二个调用点/键盘快捷键）就会立刻复活 |

---

## 附录 A：D 编号（**✅ 已落地：提交① 已写入 `docs/decisions.md` §14.3**）

| 编号 | 草案内容 |
|---|---|
| **D-159** | ⚠️ **仓库改为服务端权威（推翻 D-130 的"仓库/物品由客户端 localStorage 持有"）**：档案新增仓库段（四桶，每桶上限 500，入 `service-config.json`）；`GET /me/warehouse` 为真源；新增 `POST /me/warehouse/assemble\|disassemble`；`PUT/GET /me/warehouse` 镜像语义退役；快照的 `warehouseExcerpt` 与 `loadWarehouse` 三级来源简化；`11-account-store §15.1` 的作弊面关闭并回填 `security-backlog`。**注册即发 starter**：生成 1 角色 + 3 技能 + 2~3 插件（`common`，种子由身份派生，`slotCount ≥ 1`）写入仓库、装配进 `slot1`（出战），并创建 `slot2`/`slot3` 空槽。**老账号保持空仓**。 |
| **D-160** | ⚠️ **配置完整性校验时机**：`PUT /me/configs/:slotId` 对**非出战槽**不校验完整性（只校验结构与引用），**出战槽**仍要求完整；`POST /me/configs/:slotId/activate` 校验完整性（角色 + 恰 3 技能 + AI；允许插槽为空）→ 不完整 409 `cannot_activate_incomplete`；`POST /me/configs` 改为**创建空槽**。出战中的配置**只能替换模板、不能拆卸**（前端表现 + 服务端完整性天然约束）。 |
| **D-161** | ⚠️ **AI 库**：`GET/POST /me/ai`、`DELETE /me/ai/:aiId`；命名保存；上限 **100**（与物品分别计数），满 → 409 `ai_limit`；可删任意未被引用的 AI；**被出战配置引用 → 409 `ai_in_use`**；journal 记录。本批**前端不实现**（只用 `GET /me/ai` 作为配置弹窗候选）。 |
| **D-162** | ⚠️ **开箱随机性收归服务端（修订 T-AP-5）**：`POST /me/box` 请求体**不设 `seed`**（客户端不可指定）；seed 一律服务端生成（响应可回带仅供审计）。`server/box.js` 的 `openBoxes({seed})` 保留（离线与单测确定性），`start()` 增加实例级注入缝供 e2e/压测。既有 T-AP-5 与 9 处调用点同步修改。 |

## 附录 B：`docs/interfaces.md` 变更清单（**✅ 已同步：提交① 已按本清单改完**）

| 位置 | 变更 |
|---|---|
| §1 模块 ICD | 新增 `server/store/*` 的仓库/AI 库方法；`server/account.js` 增加 `getWarehouse/saveWarehouse`（真源）、`assemble/disassemble`、`listAi/createAi/deleteAi`、`activateConfig` 的完整性校验 |
| §2 端点表 | 新增 6 行（`me/warehouse` 语义变更、`me/warehouse/assemble`、`me/warehouse/disassemble`、`me/box`、`me/ai` GET/POST、`me/ai/:aiId` DELETE）；`PUT /me/configs/:slotId` 与 `activate` 行加"校验时机"说明；`POST /box` 行标注**遗留路径**且**无 `seed` 入参** |
| §2.1 错误码表 | 新增 `warehouse_full`(409)、`cannot_activate_incomplete`(409)、`ai_limit`(409)、`ai_in_use`(409) |
| §4 冻结数据结构 | 新增 PlayerArchive 的 `warehouse` 段与上限；Snapshot 的 `warehouseExcerpt` 标注退役 |
| §5 D 落点 | 新增 D-159…D-162 落点 |
| §6 日志登记 | `store` 通道新增 `store.warehouse.assemble`/`disassemble`/`full`、`store.ai.create`/`delete`/`limit` |
| §7 环境与门禁 | `service-config.json` 新增 `warehouse{maxPerBucket:500}` 与 `ai{maxPerPlayer:100}` 冻结值；`start()` 新增 `boxSeed` 注入缝 |

## 附录 C：`00-rules.md` 增量提案（**✅ 已写入 §5/§6**）

| 编号 | 内容 |
|---|---|
| FR-10 | **弹窗 = 屏内绘制区块**（`state.modal`），点弹窗外 = 取消并丢弃未提交输入；不引入浏览器原生弹窗/新窗口 |
| FR-11 | **登录落点 = `hub`**；F1 的 `home` 降级为 `profile`；`logout` 只保留在 `settings` |
| FR-12 | **空页规范**：标题 + 一行 `尚未实现（计划批次 F#）` + `返回主界面`；不做任何请求 |
| FR-13 | **仓库为服务端权威**（取代 FR 中一切"客户端持有仓库"的旧表述） |
| O-13 | starter 内容规格（模板/品质/数量/种子派生）**待定稿** |
| O-14 | `usage`（装配于配置几）的最终形状**待实测回填** |
| O-15 | 非出战槽保存时是否冻结快照**待定** |
| O-16 | 插槽类型 ↔ 插件类型完整枚举**待从机制表确认** |

---

## 附录 D：starter 内容（**✅ 已定稿并落地：见 `server/starter.js` 与 `tests/unit/starter.test.js`；O-13 已结**）

**生成方式（建议）**：复用现有生成路径（`items.generateRoleItem` / `generateSkillItem` / `generatePlugin`），**不手写物品对象**——手写会与生成路径的字段形状漂移（实测形状见 §5.3）。下表 id 全部取自真实内容表。

| 项 | 草案 |
|---|---|
| 种子 | `seed = parseInt(sha256('starter|' + publicId).slice(0, 8), 16)` → **同账号永远同一套**（可测）、不同账号不同 |
| 角色 ×1 | 模板 `role_bal`（均衡），品质 `common`。**实测 `qualities.json:6` 的 common `roleSlotRange = [1,3]` → 保证至少 1 个槽** |
| 技能 ×3 | 模板 `skill_melee_whirl`（旋风斩）+ `skill_straight_precise`（精准射击）+ 二者之一重复一次（与当前默认配置同模板，便于对照），品质 `common`。⚠️ common 的 `skillSlotRange = [0,1]`（`qualities.json:6`）→ 可能 0 槽；草案要求**重掷直到 3 个技能中至少 1 个有槽**（上限 20 次；仍失败则接受全 0 槽并记日志） |
| 角色插件 ×1~2 | 生成角色后读其**实际** `slots[].type`，从 `plugins.json` 筛 `kind==='rolePlugin' && drop!==false && slot ∈ 该集合` 生成（例：槽含 `atk` → `rp_atk_flat`/`rp_atk_pct`；含 `hp` → `rp_hp_pct`；含 `special` → `rp_crit`/`rp_dodge`）。**保证装得上**，避免实测过的 `插件槽 special ≠ 插槽 def` 409 |
| 技能插件 ×1 | 同理按技能实际槽类型筛 `kind==='skillPlugin'`（`basic` → `sp_mult`；`special` → `sp_crit`） |
| 点数约束 | 角色 `pluginPoints`（common=3）≥ 所装角色插件 `pointCost` 之和（实测 `pointCost = tier ∈ 1..3`） |
| AI | 沿用现有 `buildDefaultLoadout` 的预设 AI（variant 由 publicId 派生） |
| 落库 | 物品写入服务端仓库四桶；`slot1` 的 loadout = 角色 + 3 技能 + AI（**已按槽装配插件**）→ 冻结快照 → 设为出战；`slot2`/`slot3` 建为空槽 |
| 装配位置 | 按槽序装入第一个**类型匹配且空闲**的槽 |
| 日志 | `store.starter.issued`(info)：`{playerId, seed, roleSlotCount, plugins, aiVariant}` |
| 必测 | ① 同 publicId 两次生成逐值相同；② 角色 `slotCount ≥ 1`；③ 装入的每个插件 `slot === 目标槽.type`；④ 生成后对它们调用 `assemble` 不产生 409；⑤ 物品总数（1 + 3 + n）远低于 500/桶 |

**备选（不推荐）**：手写固定物品对象——内容完全可控，但字段与生成路径易漂移，且品质/数值不再来自品质表。
