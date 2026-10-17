# F11 设计与实现冻结：布局表驱动界面 + 仓库弹窗 + 物品详情

> 版本：**v1**　创建：2026-10-05
> 状态：**用户已逐条裁定**（本会话 2026-10-05）；本文件是本轮（非编号批次，同 F3/F5/F6/F7/F9/F10 处置）的唯一实现依据。
> 依据：`docs/frontend/00-rules.md`（总纲）；`docs/frontend/07-layout-tool.md`（布局工具）；`docs/decisions.md`（**本轮新增 D-186/D-187**）；`docs/interfaces.md` §2（端点权威 —— **本轮新增 2 个端点**）。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md` > `docs/frontend/*`。

---

## 0. 用户口径（2026-10-05，最高优先）

| # | 口径 | 落点 |
|---|---|---|
| ① | **开始做布局表驱动的界面，删掉所有「纯文字 + 按钮」的约束** | §2（重开布局渲染） |
| ② | **主界面已有完整布局**，不得改其按钮/弹窗**位置与大小** | §2.3 |
| ③ | **仓库是弹窗，不是页面**：上方选项卡切类别，下方窗口显示内容，**超出可滚动**；参考用户给的图 | §4 |
| ④ | **点任意物品 → 中间弹出详情弹窗，显示完整详细属性** | §5 |
| ⑤ | 主界面**装配出战配置的物品列表弹窗**也要**超出可滚动** | §6 |
| ⑥ | **完善主界面各按钮与弹窗的功能**（有些按钮没写具体功能） | §7 |
| ⑦ | **布局台不支持的功能先改布局台与引擎**，**不做任何空实现、不偷换概念**，严格按设计做 | §3 |
| ⑧ | **注册表由我做，用户后续微调位置与大小** | §3.6 |
| ⑨ | 前端布局台缺的功能现在实现；后端缺的接口现在实现；**所有设计以本会话为准** | §3 / §8 |

### 0.1 逐条问答结论（本会话）

| # | 问题 | 用户裁定 |
|---|---|---|
| Q1 | 仓库选项卡数量 | **6 个全放一行**（角色/技能/角色插件/技能插件/包/AI节点，与实际桶一致） |
| Q2 | 仓库入口形态 | **完全改弹窗，删掉 `warehouse` 独立屏** |
| Q3 | 物品详情详细度 | **全部属性，按类别分组** |
| Q4 | 详情弹窗能否操作 | **包→可开包；其他物品→可分解；仓库内不能装配** |
| Q5 | 主界面 1/2/3 槽按钮 | **只切换「主界面显示哪份配置」，但服务端要能持久化当前显示的配置**；**另加一颗「设为出战」按钮** |
| Q6 | 按钮双素材 | **所有按钮类都应有「常态/按下」两张素材**；布局表**新增两个资产字段** |
| Q7 | 按钮按下行为 | **布局表加 `press` 字段，四种模式可选**：悬停即按下／点击期间按下／点击后保持按下／由条件锁定（如出战配置） |
| Q8 | 「对战历史」按钮 | **做成战绩弹窗，但本轮先不做**（写空弹窗占位） |
| Q9 | 占位素材 | **不生成素材，就用占位框** |
| Q10 | 本轮范围 | **接线 + 顺带补齐缺失功能**（物品分解；新增后端接口） |
| Q11 | 仓库弹窗布局 | **选项卡数量按实际物品类型（6）**；**应能设定格子大小**，**不硬性规定几乘几**，视物品数量**从左到右从上到下自行排布**，**横着放不下就换行**，**竖着放不下就滚动**；**取消右上角 X** |
| Q12 | AI 节点详情 | **只读展示 + 节点说明** |
| Q13 | 网格自动排布落在哪层 | **引擎新增 grid 自动流式排布** |
| Q14 | 选项卡生成方式 | **手写 6 个固定选项卡** |
| Q15 | 「当前显示哪份配置」 | **新增 `viewedSlot` 字段 + `select` 接口**（服务端持久化） |
| Q16 | 可分解范围 | **AI 节点与包不可分解，其他都可** |
| Q17 | 分解二次确认 | **直接分解，不确认** |

---

## 1. 实测取证（2026-10-05，真实 HTTP + 真服务端模块）

| 事实 | 证据 | 影响 |
|---|---|---|
| `/me/warehouse` **已回带完整物品属性** | 起真服务注册后 `GET /me/warehouse`：`role` 条目含 `stats{hp,atk,def,sp,mp}`/`regen`/`slots[].type,pluginUid`/`slotCount`/`pluginPoints`/`unlockTier`；`skill` 含 `params{multiplier,cost,cooldown,bulletLevel,range,falloff}`/`animKey`/`sfxKey`；`rolePlugin` 含 `affixes[{id,desc,params}]`/`pointCost`/`equipped`；`skillPlugin` 含 `exclusive{forTypes,overrides}`/`forTypes`；`package` 含 `packageKind`/`qualityPercent`；`aiNode` 含 `nodeId`/`category`/`count` | **物品详情弹窗零新接口** |
| 仓库 **6 桶**，各上限 **500** | `server/store/archive.js` 的 `WAREHOUSE_BUCKETS`；`service-config.json` 的 `warehouse.maxPerBucket` | 选项卡 6 个 |
| 布局引擎**已支持** `parent`/`scroll`/`grid`/`font`/`nine`/`opacity`/`clickThrough` | `public/layout-engine.js` 的 `normalizeElement`；`public/render.js:187-241` 真的消费它们 | 滚动清单**能力已在** |
| 布局引擎**不支持**网格自动换行 | `listFrom` 只有单向 `pitch` 等距排；`grid` 目前只是**布局台的设计期助手**（`applyGrid` 排子元素位置），**引擎 `layoutAt` 不消费 `grid` 生成元素** | **必须新增**（§3.2） |
| 布局引擎**不支持**按钮按下态 | `normalizeElement` 只保留单个 `asset`；`render.js` 只输出一张 `<img>`；无 `press`/`assetPressed` | **必须新增**（§3.3/§3.4） |
| 主界面 `slot_1/2/3` **没有 action** | `layout-bundle.raw.json` 的 hub：三者只有 `setState:{activeSlot:N}`，`action` 为空；`layout-engine.js` 的 `validateLayout` 只要求「有 action **或** 有 setState」 | 引擎判定合法但**产品侧未接线** |
| 主界面「对战历史」是无动作 `deco` | `layout-bundle.raw.json`：`kind:'deco'`, `action:''`；`import-layout.js` 的对应 intent fix **已被 D-180 刻意删除** | 死按钮 |
| **无**物品删除/分解端点 | `server/index.js` 只有 `assemble`/`disassemble`/`open-package`；`/me/warehouse` 的 `PUT` 已退役为形状校验 | **必须新增**（§8） |
| **无**「当前显示哪份配置」的服务端字段 | 档案 `configs` 只有 `slots[]`（含 `isDefault`）；`GET /me` 无 `viewedSlot` | **必须新增**（§8） |

---

## 2. 交付物 A：重新打开布局表驱动渲染（口径 ①）

### 2.1 做法

`public/boot.js` 把那三行 `setLayout` 注入**放回来**（原处已有注释，即"重新打开"的开关）：

```js
if (DL.format && typeof DL.format.setLayout === 'function' && DL.layoutEngine && DL.layoutData) {
  DL.format.setLayout(DL.layoutEngine, DL.layoutData);
}
```

放回后 `format.layoutReady()` 变 `true` ⇒ `hubViewModel` 走**布局版**。

### 2.2 「删掉所有纯文字和按钮的约束」的准确含义

**不是**说文字与按钮从此不许存在，而是：**「界面只能由文字与按钮构成」这条约束作废**。布局表可以自由使用矩形/多边形/椭圆命中、图片、百分比定位、容器、滚动、网格、多层弹窗——这些能力全部由布局表数据驱动。

### 2.3 主界面**位置与大小不可动**（口径 ②）

本轮对 `hub` 屏**只做加法**，**不移动、不缩放任何已有元素**：

- **新增**元素（如「设为出战」按钮）必须放在**当前空位**，不得覆盖或挤压既有元素；
- 既有元素**只允许改** `action`（把空的填上）、`press`/`assetPressed`（新增字段）、`when`（条件显示）；
- 任何 `rect` 的改动都属于"微调"，**留给用户**（口径 ⑧）。

---

## 3. 交付物 B：布局台与引擎补齐（口径 ⑦）

> 原则：**不支持就先改引擎与布局台，不做空实现、不偷换概念**。

### 3.1 引擎新增字段总表

| 字段 | 归属 | 语义 |
|---|---|---|
| `assetPressed` | 元素 | **按下态素材**（常态用既有 `asset`）。两者都存在时，按下切换 `src`；只有一个时不切换（降级为常态） |
| `press` | 元素 | **按下行为模式**，枚举 `'hover' \| 'tap' \| 'sticky' \| 'state'`（见 §3.3） |
| `pressKey` | 元素 | `press==='state'` 时，**由哪个状态键决定按下**（如 `activeSlot`/`battleSlot`） |
| `pressWhen` | 元素 | `press==='state'` 时，**该键等于什么时按下**（如 `1`，或数组 `[1,3]`） |
| `grid.flow` | 容器 | **网格自动流式排布开关**（见 §3.2） |
| `grid.autoHeight` | 容器 | 行数超出容器高时**把内容高度撑开**（配合外层 `scroll` 形成滚动）|

### 3.2 `grid.flow`：网格自动流式排布（本轮核心新增）

**问题**：现在 `listFrom` 只能单向等距排（一个 `pitch`），`radialRects` 只能径向排。**都不能"按容器宽自动算列数 + 逐行填充 + 换行"**，而这是仓库网格的硬需求。

**设计**（在 `layoutAt` 内实现，设计器与产品**共用同一份**）：

```
输入：容器 rect [x,y,w,h]、grid{cellW,cellH,gapX,gapY,padX,padY}、子元素原型（prototype）
计算：
  usableW   = w − 2*padX
  cols      = max(1, floor((usableW + gapX) / (cellW + gapX)))
  for i, item in list:
    row = floor(i / cols);  col = i % cols
    childX = padX + col * (cellW + gapX)
    childY = padY + row * (cellH + gapY)
    rect   = [childX, childY, cellW, cellH]      // 相对父容器内容原点
  rows = ceil(len(list) / cols)
  contentH = padY*2 + rows*cellH + (rows−1)*gapY
  if grid.autoHeight && contentH > h: 内容高度 = contentH   // 撑开 → 外层 scroll 生效
```

**不变量**：

- `cols` **由容器宽与格子尺寸算出**，布局表**不得写死行列数**（口径 Q11）；
- 排布顺序 = **从左到右、从上到下**（口径 Q11）；
- 横放不下 → **自动换行**（`cols` 已经限制每行个数）；
- 竖放不下 → **外层容器 `scroll.dir='v'` 滚动**（`autoHeight` 撑开内容）；
- 子元素 `rect` 语义仍是**相对父块内容原点**（与 D-185 的 `parent` 语义一致）。

**布局台**：新增「**网格自动排布**」开关 + `cellW/cellH/gap/pad` 输入 + 「**预览条数**」（设计期看 N 个物品排出来什么样）。布局台**不再需要**手工「排成网格」（保留，但自动排布开关优先）。

### 3.3 `press`：按钮按下行为四模式（口径 Q7）

| 模式 | 语义 | 落点 |
|---|---|---|
| `'tap'` | **默认**：点击期间按下，松开恢复 | 普通按钮 |
| `'hover'` | 鼠标移上去即显示按下 | 需要悬停反馈的按钮 |
| `'sticky'` | 点击后**保持按下**，直到其他触发条件解除 | 需要"选中"感的按钮 |
| `'state'` | **由状态决定按下**：`pressKey` 的值命中 `pressWhen` → 按下 | **出战配置槽（1/2/3）**、「设为出战」 |

> **用户口径 Q7 的四种情形逐一对应**：① 悬停显示按下 → `hover`；② 点击显示按下、松开恢复 → `tap`；
> ③ 点击显示按下且不恢复 → `sticky`；④ 等待其他触发条件（如出战配置切换）→ `state`。

**`state` 模式的判据**（用户 Q7 原文）：
- **当前显示的配置槽一直保持按下**；切换配置后，**旧按钮恢复、新按钮按下** → `pressKey:'activeSlot'`, `pressWhen:<槽号>`
- **「设为出战」按钮：当前配置是出战 → 显示已按下；未出战 → 常态可点击** → `pressKey:'battleSlot'`, `pressWhen:<槽号>`

### 3.4 双素材渲染

`render.js` 的 `layoutElHtml` 在既有 `<img src=asset>` 基础上：

- 同时声明 `asset` 与 `assetPressed` ⇒ 输出**两张 `<img>`**（`.dl-img-normal` / `.dl-img-pressed`），由 CSS 按元素状态类切换显隐；
- 只有 `asset` ⇒ 保持现状（只输出一张），**不报错、不占位**；
- 状态类：`.dl-pressed`；`hover` 用 `:hover`、`tap` 用 `:active`、`sticky`/`state` 用 JS 加类。

### 3.5 引擎校验新增（`validateLayout`）

| 级别 | 判据 |
|---|---|
| error | `press` 非法值（只能是那四个） |
| error | `press==='state'` 但缺 `pressKey` 或 `pressWhen` |
| error | `pressKey` 不在 `WHEN_KEYS` 内（`activeSlot`/`battleSlot`；本轮按需扩展） |
| error | `grid.flow` 为真但 `cellW`/`cellH` 缺省或 ≤0 |
| warn | 声明了 `assetPressed` 但没声明 `asset` |
| warn | `grid.flow` 容器**没有** `scroll`（物品多了会被裁掉，用户看不到后面的） |
| warn | `grid.autoHeight` 为真但外层没有 `scroll` |

### 3.6 注册表（口径 ⑧）

新增/改动的屏在 `public/screens.js` **登记**；`store.VIEWS` 由它派生（FD-1 逐条相等）。
**位置与大小属"微调"** → 布局台里画，用户后续调；注册表只保证**屏存在、动作可达、字段可追溯**。

---

## 4. 交付物 C：仓库弹窗（口径 ③，Q2/Q11）

### 4.1 形态

- **`warehouse` 独立屏删除**（Q2）；`screens.js` 移除该条目，`store.VIEWS` 随之减少 1。
- 入口：主界面「仓库」按钮 → `goto-warehouse` 动作改为 **`warehouse-open`**（打开弹窗 + 取真源）。
- 弹窗承载在**主界面之上**（`state.layout.modals` 栈），遮罩点击 = 关闭（沿用 FR-10）。

### 4.2 结构（按用户图 + Q11）

```

  ┌──────────────────────────────────────────────┐
  │ [角色][技能][角色插件][技能插件][包][AI节点]  │  ← 6 个选项卡一行（数据来自实际桶）
  ├──────────────────────────────────────────────┤
  │  ┌──┐┌──┐┌──┐┌──┐                            │  ← 网格：格子大小可设定，
  │  └──┘└──┘└──┘└──┘                              从左到右/从上到下自动排布
  │  ┌──┐┌──┐┌──┐┌──┐                              横放不下自动换行
  │  └──┘└──┘└──┘└──┘                              竖放不下 → 本区域滚动
  │  ┌──┐┌──┐  ↑滚动                               │
  └──────────────────────────────────────────────┘
   （无右上角 X —— Q11 明确取消）
```

- **选项卡**：手写 6 个固定元素（Q14），每个是 `press:'sticky'` + `pressKey` 绑定当前桶（选中态按下）；
- **网格区**：`grid.flow` 容器 + `scroll.dir:'v'` + `autoHeight`（Q13）；
- **格子尺寸可设定**：`cellW/cellH/gapX/gapY/padX/padY`（Q11）；
- **关闭方式**：遮罩点击（`modal-close`）+ 一颗显式关闭按钮（FR-10）。

### 4.3 数据

`GET /me/warehouse`（**已有**，零新接口）。切选项卡 = **纯本地**动作（数据一次取全，沿用既有 `warehouse-bucket` 语义）。

---

## 5. 交付物 D：物品详情弹窗（口径 ④，Q3/Q4/Q12）

### 5.1 形态

点仓库格子 → **中间弹出详情弹窗**（第二层弹窗）。数据**全部来自已读到的 `/me/warehouse`**（§1 实测），**零新接口**。

### 5.2 字段分组（Q3「全部属性，按类别分组」）

| 桶 | 展示分组 |
|---|---|
| `role` 角色 | ① 基本信息（名字/品质/模板/解锁段位）② **五维**（hp/atk/def/sp/mp）③ 回复（sp/mp 每 tick）④ **插槽**（逐槽：类型 + 已装插件名）⑤ 点数预算（`pluginPoints`） |
| `skill` 技能 | ① 基本信息 ② **战斗参数**（倍率/冷却/弹幕等级/射程/衰减） ③ **消耗**（hp/mp/sp）④ **插槽**（专属 + 通用，逐个已装插件）⑤ 动画/音效键（`animKey`/`sfxKey`） |
| `rolePlugin` 角色插件 | ① 基本信息（名字/类别/品质/档位） ② **词条逐条**（`affixes[].desc`） ③ 点数消耗（`pointCost`） ④ 适配槽类型（`slot`） ⑤ 是否已装配（`equipped`） |
| `skillPlugin` 技能插件 | ① 基本信息 ② **专属覆盖**（`exclusive.overrides` 逐项展开） ③ 适配技能类型（`forTypes`） ④ 是否已装配 |
| `package` 包 | ① 基本信息 ② **包类型**（`packageKind`） ③ **质量档**（`qualityPercent`） ④ 提示：只在快速对战中掉落 |
| `aiNode` AI节点 | ① 基本信息（名字/类别/品质） ② **堆叠数**（`count`） ③ **节点说明**（只读，Q12） |

### 5.3 详情弹窗内的操作（Q4）

| 桶 | 可用操作 |
|---|---|
| `package` | **开包**（`open-package`，已有接口） |
| `role`/`skill`/`rolePlugin`/`skillPlugin` | **分解**（新增接口，§8） |
| `aiNode` | **无操作**（Q16：不可分解） |
| 任意 | **仓库内不提供装配**（Q4 明确） |

---

## 6. 交付物 E：配置编辑器物品列表弹窗可滚动（口径 ⑤）

主界面装配出战配置时，候选物品列表弹窗（`modal_role_pick` / `modal_skill_pick` / `modal_role_plugin_pick` / `modal_skill_plugin_pick`）**也要超出可滚动**：

- 给候选列表区加 `scroll.dir:'v'` + `grid.flow`（或保持 `listFrom` 但加滚动容器）；
- **不改这些弹窗的位置与大小**（口径 ②）——只在其**内部**把列表区变成滚动容器。

---

## 7. 交付物 F：主界面按钮接线（口径 ⑥）

| 元素 | 现状 | 本轮改为 |
|---|---|---|
| `slot_1/2/3` | 只有 `setState:{activeSlot:N}`，无 action | `action:'config-select'` + `press:'state'`/`pressKey:'activeSlot'`/`pressWhen:N`；动作 = 本地切换 **+** 调 `POST /me/configs/:slotId/select` 持久化（Q5/Q15） |
| `设为出战（…）` | intent fix → `config-activate`（normalized 里已生效） | **保留** `config-activate`，**新增** `press:'state'`/`pressKey:'battleSlot'`/`pressWhen:<槽号>`（Q7：出战则按下） |
| `对战历史` | 无动作 `deco` | **新增**「战绩弹窗」开屏入口；**本轮弹窗内容为空占位**（Q8） |
| 其余 `goto-*` | 已接线 | 保持；逐个复核"按钮永不无声" |

> **位置与大小全部不动**（口径 ②）。「设为出战」的 `press` 状态需要布局投影提供 `battleSlot`
> （当前 `bindData` 已有 `battleSlot` 键，来自 `/me/configs` 的出战槽）——**本轮打通它**。

---

## 8. 交付物 G：后端新增接口（口径 ⑨，Q15/Q16）

> 严格按 `docs/tasks.md` §10 变更流程：先落 `decisions.md`（D-186/D-187）+ `interfaces.md`，再写实现。

### 8.1 `POST /api/v1/me/configs/:slotId/select`（D-186，Q15）

- **语义**：把「主界面当前显示哪份配置」**存到服务端档案**（与"出战配置"`activate` **完全分开**）。
- **体**：`{}`（无参；`slotId` 在路径）。
- **响应**：`{viewedSlot}`。
- **档案**：新增 `viewedSlot` 字段（默认 = 出战槽；`ARCHIVE_VERSION` 2 → **3** + `migrateV2toV3` 补默认值 ⇒ **老账号零迁移痛感**）。
- **错误**：400 `bad_request`；401；404 `slot_not_found`。
- **journal**：新增 `config.viewed` 记录（幂等：同 `viewedSlot` 重复写不产生新记录）。

### 8.2 `POST /api/v1/me/warehouse/dismantle`（D-187，Q16）

- **语义**：**分解（删除）仓库物品**。**无产出**（Q：「先只删除，产出待定」）。
- **体**：`{uids:[…]}`（**1..100 个、不重复**）。
- **响应**：`{dismantled:[uid…], warehouse, usage, counts, caps}`。
- **规则**：
  - **`aiNode` 与 `package` 不可分解** → 409 **`item_not_dismantlable`**（Q16）；
  - **被任何配置引用** → 409 **`item_in_use`**（沿用 D-163 既有错误码语义）；
  - **插件仍装配在某个物品的插槽里**（`equipped:true` 且被 `slots[].pluginUid` 引用）→ 409 **`plugin_equipped`**（沿用既有码）；
  - uid 不存在 → 404 **`item_missing`**；
  - **无二次确认**（Q17 是前端口径；后端不做二次确认）；
  - **一次落盘**：一条 journal 记录 `warehouse.dismantled`（幂等键 = 排序后的 uid 集合 `dismantleId`），走 `grantIds` 式环形窗口。
- **`GET /me`** 回带 `viewedSlot`（§8.1）+ `battleSlot`（出战槽，供 `press:'state'` 用）。

---

## 9. 实施顺序（每步都要过门禁）

| 步 | 内容 | 出口 |
|---|---|---|
| **S-1** | `decisions.md` D-186/D-187 + `interfaces.md` §2/§4/§5 + `tasks.md` §7 | `check:docs` PASS |
| **S-2** | **后端**：档案 v3 + `viewedSlot` + `select` + `dismantle` + journal + 错误码 | 新增 API 测试全绿；`npm test` 0 失败 |
| **S-3** | **引擎**：`grid.flow` + `press` 四模式 + `assetPressed` + 校验 | 引擎单测全绿；布局台 core 同步 |
| **S-4** | **布局台**：新字段面板 + 网格自动排布开关 + 条数预览 | `check-lab.js` + lab 浏览器断言全绿 |
| **S-5** | `boot.js` 重开布局渲染 | 真实 `index.html` 装配下 `layoutReady()===true` |
| **S-6** | **布局表**：仓库弹窗屏 + 物品详情弹窗屏 + hub 元素接线（**不动位置大小**） | `layout:apply` 0 error |
| **S-7** | **前端投影**：仓库弹窗/物品详情/主界面接线 + 契约登记 | `contract.js` 字段全部来自真响应 |
| **S-8** | `screens.js` 删 `warehouse` 屏 + 注册新动作 | FD-1..FD-7 全绿 |
| **S-9** | 全量回归 + 文档同步 + 审查记录 | `npm test` / `gate` / `check-docs` / `check-arch` / `e2e` 全绿 |

---

## 10. 已知未覆盖 / 已知风险（**不得为空**）

| # | 项 | 说明 |
|---|---|---|
| K-1 | **无素材 ⇒ 界面全是占位框** | Q9 明确不生成素材。布局渲染打开后所有 `asset` 路径 404，显示 `.dl-ph` 占位框。**功能可验证，观感不可验证**。 |
| K-2 | `press:'hover'` 在触屏无对应 | 触屏没有 hover，`hover` 模式在移动端退化为无常态反馈。登记不修。 |
| K-3 | **档案 v3 迁移** | 老档案缺 `viewedSlot` → `migrateV2toV3` 补「出战槽」。若老档案**无出战槽**（异常态），回落到 `slot1`。 |
| K-4 | `dismantle` **无产出** | 用户裁定「先只删除，产出待定」。**桶满 500 的解法本轮只给"腾空间"**，不给回报。 |
| K-5 | **战绩弹窗本轮为空占位** | Q8 明确「先不做」。它**违反"按钮永不无声"**吗？不违反——按钮命中 `records-open` 动作、会打开弹窗并显示占位文案，**不是死按钮**；但**功能不完整**，登记为待做。 |
| K-6 | **网格 `cols` 随容器宽变化** | 用户后续微调容器大小时，每行列数会跟着变。这是设计意图（Q11），但**布局台预览与实际浏览器字体/滚动条宽度可能差 1 列**。 |
| K-7 | 布局表 hub 的 `rect` **本轮不动** | 新增元素（战绩入口等）只能放空位；若空位不足，需用户微调。 |
| K-8 | `check-arch.js` 仍不含 L7 | `public/**` 不在分层扫描内（O-7 剩余部分），由 `tests/frontend/*` 代偿。 |
| K-9 | **浏览器人工走查未执行** | 本轮"能玩"出口 = 真实浏览器按 §11 走查；须**用户本人**执行后回填 `docs/reviews/F11.md`。 |

---

## 11. 人工走查剧本（用户本人在真实浏览器执行）

1. `npm start` → 打开 `http://127.0.0.1:3000/`（或实际端口）→ 登录 → 落在**主界面**，看到**布局渲染**（不是文字列表）。
2. 主界面 `1`/`2`/`3` 槽按钮：**当前显示的槽保持按下**；点 `2` → `1` 恢复常态、`2` 按下，且**刷新页面后仍是 2**（服务端持久化生效）。
3. 「设为出战」：对**出战配置**显示已按下；切到**非出战配置**显示常态可点击。
4. 点「仓库」→ **主界面上浮出仓库弹窗**（不是切屏），6 个选项卡一行。
5. 选项卡逐个点 → 下方网格**内容随之切换**，选中的选项卡保持按下。
6. 网格：物品多时**横向放不下自动换行**；**纵向放不下可滚动**（滚轮能滚）。
7. 点任意物品 → **中间弹出详情弹窗**，属性**按类别分组**、**逐项完整**。
8. 详情弹窗里：包 → 有「开包」按钮且能用；角色/技能/插件 → 有「分解」按钮；AI 节点 → 无操作按钮。
9. 点「分解」→ 物品**从仓库消失**、容量行数字**变小**（**直接分解，无二次确认**）。
10. 被出战配置引用的物品 → 点分解 → **报错提示**（不是静默失败）。
11. 关闭仓库弹窗（点遮罩 / 点关闭按钮）→ 回到主界面，**主界面状态没坏**。
12. 点主界面「配置」开装配弹窗 → 候选物品**列表超出时可滚动**。
13. 点「对战历史」→ 打开**空占位弹窗**（本轮口径），能正常关闭。

---

## 12. 验收机制（总纲 §4 四条 + 本批新增）

| 项 | 判据 |
|---|---|
| 按钮永不无声 | 每个可点元素命中已实现动作；`SCREENS[*].actions` 并集 ≡ `ACTIONS` 键集（双向） |
| 字段名不得来自散文 | 详情弹窗**每个字段**可追溯到 §1 实测的真实响应；登记进 `contract.js` |
| 端点可达 | `select`/`dismantle` 有明确 UI 路径；**不得有注册但无入口的动作** |
| 可玩性出口 | §11 剧本**用户本人**在真实浏览器走完 |
| **引擎↔布局台一致** | `lab.html` core digest ≡ `public/layout-engine.js` 的 `CORE_DIGEST`（FD-6） |
| **网格算法唯一** | `grid.flow` 的坐标算法**只有一份**（引擎内），布局台与产品共用 |
