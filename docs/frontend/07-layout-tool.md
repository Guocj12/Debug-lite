# 布局工具（tools/layout/）—— 拖控件改界面，一键落到工作区

主界面**不再手写 HTML/CSS**，而是由一张「布局表」+ 一堆素材文件驱动。
这个工具就是画/改那张表的：拖动控件摆位置、画不规则形状、绑定数据、配弹窗流程，
然后**一键写进工作区**，AI（或你自己）跑一条命令就能替换前端页面。

---

## 1. 启动

```bash
npm run lab          # = node tools/layout/lab-server.js（只监听 127.0.0.1:4319）
# 浏览器打开 http://127.0.0.1:4319/
```

**入口地址**（都指向同一个布局台，随便敲哪个都行）：
`http://127.0.0.1:4319/` ｜ `/index.html` ｜ `/lab` ｜ `/lab.html` ｜ `/tools/layout/lab.html`

> 浏览器导航到打错的路径会**自动跳回首页**（不会把一段 JSON 错误当页面显示）；
> 而页面脚本 fetch 打错的 `/api/*` 仍返回 JSON —— 两种情况分别有测试钉住（LS-3 / LS-5）。

也可以直接双击 `tools/layout/lab.html`（`file://`）：页面会自动去连 `http://127.0.0.1:4319`
（本地服务已开 CORS，所以跨源也能用）；连不上时按钮会给出"先执行 npm run lab"的提示，
服务起来之后点**「刷新状态」**即可自动连上，无需重开页面。

> 端口不是 4319 时用 `?port=xxxx` 打开页面，例如 `lab.html?port=5000`。

### 本地服务的接口契约（有回归测试钉住）

| 约定 | 为什么 |
|---|---|
| **所有响应都是 JSON**（含未匹配路由、静态文件缺失、坏请求体） | 页面统一走 `r.json()`；回纯文本会让它抛 `Unexpected token 'o', "not found: "...`（真实发生过的缺陷） |
| 响应带 `access-control-allow-origin: *` 并处理 `OPTIONS` 预检 | 页面可能从 `file://` 或别的本地页面（如 GUI 预览）打开 |
| `ok:false` 时一律带 `error`（必要时带 `hint`） | 页面把 `error`+`hint` 直接显示在素材面板上，用户能照做 |
| 只监听 `127.0.0.1` | 这是本机开发工具，不对外 |

机器核对：`tests/frontend/layout-tool-server.test.js`（LS-1..4）。

### 界面速览

| 区域 | 能做什么 |
|---|---|
| 顶部工具栏 | 画面切换（整屏/弹窗）、加元素、复制、删除、导入/导出 JSON、校验、**预览**、**存到工作区 / 素材清单 / 归位素材 / 一键应用** |
| 左侧 | **层级树（默认）**：界面/弹窗的包含关系，谁包含谁、点谁能进哪个画面；可切「平铺」看当前画面的元素清单。另有素材目录匹配、**存盘 / 素材面板** |
| 中间舞台 | 拖动、八向缩放、旋转（Shift 吸附 15°）、吸附与辅助线、按 `P` 切形状编辑（拖顶点 / Alt 点击删点 / 双击加点）、缩放与平移 |
| 右侧 | 元素属性（id/显示名/**注释**/动作/载荷/目标画面/形状/素材/绑定/替换文字/`when`）、画面属性（角色、背景、遮罩）、断点预览、径向生成器、设计期状态、校验结果、布局 JSON |

### 层级树：一眼看清"谁包含谁"（2026-10-04 新增）

主界面里点「角色卡」弹出插槽弹窗、弹窗里再点插槽又弹出候选屏 —— 这种**包含关系**在平铺清单里看不出来。
左栏默认就是**层级树**：

```
▢ hub                       整屏  16 元素 · 无人指向
 ├─ ● 用户头像               goto-profile
 ├─ ● 角色卡                 config-open
 │   └─ ▣ modal_role_slots  弹窗  ← 从 crest_role 进入 · 7 元素 · 被 1 处指向
 │       ├─ ● center_role    config-open
 │       │   └─ ▣ modal_role_pick   弹窗  ← 从 center_role 进入
 │       ├─ ● slot_1         plugin-pick
 │       │   └─ ▣ modal_role_plugin_pick  弹窗  ← 从 slot_1 进入
 │       └─ ● slot_2         plugin-pick
 │           └─ ↩ modal_role_plugin_pick  已在上方        ← **不重复展开**
 └─ ● 登录按钮               goto-login

还有这些画面（2）（没有任何元素指向它们，所以不在上面的包含关系里）
 ▢ records / ▢ settings
```

约定：

| 记号 | 含义 |
|---|---|
| ▢ / ▣ | 整屏 / 弹窗（弹窗是**覆盖在当前画面之上**的，不是切场景） |
| `├─` `└─` `│` | 缩进导轨 = 包含层级 |
| ● / ◇ | 按钮 / 装饰件 |
| 💬 | 这个元素**写了注释**（鼠标悬停看全文） |
| ⚠ 缺 action … | **按注释看还有未落地的部分**（缺动作 / target 没有对应动作 / 缺素材）—— 这就是"要补齐"的清单 |
| ↩ 已在上方 | 该画面已在树的上面画过 → 只显示一行引用，**避免 A→B→A 这类合法循环无限展开** |
| 顶部统计 | `N 个画面（M 弹窗 / K 整屏） · E 个元素 · 注释 x/E · 待补齐 y` |

点击行为：**点画面行** = 切到那个画面（左栏与舞台跟着变）；**点元素行** = 选中它（属性面板跟着变）。
左下角两个按钮在「层级 / 平铺」间切换（平铺 = 原来的当前画面元素清单）。

### 注释字段（`desc`）：把"这一块干什么"写进布局表

右侧属性面板每个元素都有 **注释** 输入框。写的是**自然语言**：这一块干什么、点了会发生什么、有哪些失败路径。

- 它是**设计期字段**：产品渲染**不读它**（`render.js`/`layout-data.js` 都不消费），只用来
  ① 让界面上的每个元素有可读的职责说明；② **作为"补齐功能"的依据** ——
  某个元素的功能不完整或没实现时，照这条注释把它补上。
- 边打边存（`input` 事件即时落进布局表，JSON 面板可见），**每次输入一个撤销快照**；
  清空即删掉该字段（不留空串，不污染布局表）。
- 下方状态行会实时提示：
  - 没写 → 「还没写注释」（并建议写什么）
  - 写了但如果 `action` 缺失 / `target` 没有对应动作 / 缺素材 → 「按注释看还有未落地的部分：…」
  - 写了且没检测到空缺 → 「注释已写；当前没有检测到明显的空缺」

### 层级与注释的机器校验（`validateBundle` 里新增）

| 级别 | 判据 |
|---|---|
| error | 元素的 `target` 指向**不存在的画面**（点它会跳进空处） |
| error | 声明了 `target`，但 `action` 是**纯本地动作**（空 / `wait` / `none` / `noop`）→ 点了进不去那个画面 |
| warn | `role='modal'` 且**没有任何元素指向它** → 永远不会弹出来 |
| warn | `role='screen'` 且没有任何元素指向它（也不是 `hub`）→ 从别的画面进不去 |

> ⚠️ 第二条**刻意不写成固定动作白名单**：本项目的布局表在导入期会被 `import-layout.js` 重写动作
> （`config-open` / `plugin-pick` / `slot-set` … → `layout-open`），合法取值是一整个家族。
> **循环引用是合法的**（返回主界面、来回弹窗都算），只按"被指向"处理，不报错。

### 容器 / 滚动 / 图标大小 / 网格（2026-10-04 新增，D-185）

#### 能不能设计"固定大小的框 + 里面滚动的列表"？

**能**。布局表新增 **`parent`（装进谁）** 与 **`scroll`（滚动容器）** 两个字段：

```jsonc
{ "id": "bag_list", "kind": "deco", "rect": [40, 100, 400, 300],
  "desc": "背包列表：固定 400×300 的框，里面按 72px 图标排网格，纵向滚动",
  "scroll": { "dir": "v", "fade": true },                 // v 纵向 / h 横向 / both 双向 / none 只裁剪
  "grid":   { "cellW": 72, "cellH": 72, "gapX": 8, "gapY": 8, "padX": 8, "padY": 8 } },
{ "id": "bag_item_1", "kind": "button", "parent": "bag_list", "rect": [8, 8, 72, 72] }
```

- **`parent`** 把平铺列表变成**层级**：子元素 `rect` 变成"相对父块内容原点"，父块会**裁剪**它们。
- **`scroll.dir`** 决定要不要真滚；渲染层用**原生 `overflow` 滚动**（`-webkit-overflow-scrolling:touch` +
  `overscroll-behavior:contain`）⇒ 手感是浏览器原生的"丝滑"；滚动条外观在 `app.css` 里收敛成游戏 UI 的细样式。
- **`scroll.fade`** 两端渐隐遮罩，提示"还有内容"。
- **`scroll.top` / `scroll.left`** 是**设计期初始偏移**：渲染成 `scrollTop`/`scrollLeft`，
  设计器里也按它定格 —— 打开就能看到"滚到中间"那一屏长什么样。
- 引擎（`layoutAt`）会**把祖先的滚动偏移从子元素位置上扣掉** ⇒ 设计器与产品的坐标算法是**同一份**
  （两边都只画在算好的坐标上，不各写一遍语义）。

界面里怎么用：选中一个块 → 右侧「**变成容器＋收进去**」一键把它盖住的元素收成子元素并开启滚动；
「**图标大小**」填 `cellW×cellH` → 「**排成网格**」按这个尺寸等距排开（列数由容器宽自动算，写在提示行里）。

#### 常用游戏 UI 设计功能一览

| 能力 | 字段 / 控件 | 说明 |
|---|---|---|
| **滚动容器** | `scroll.dir` / `fade` / `top` / `left` | 原生丝滑滚动；`none` = 只裁剪不滚 |
| **父容器（层级）** | `parent` | 坐标转相对空间；父块裁剪子元素；移动父块子元素跟着走 |
| **图标/卡片大小** | `grid.cellW` / `cellH` | 「排成网格」按它排；列数随容器宽自动算 |
| **网格间距与内边距** | `grid.gapX/gapY/padX/padY` | 等距排布 |
| **文字大小** | `font.size`（+「按高度自算」） | 走 CSS 变量 `--dl-fs` |
| **文字对齐 / 颜色 / 粗体** | `font.align` / `color` / `bold` | `--dl-align` / `--dl-color` |
| **九宫格拉伸** | `nine.slice` | `border-image … fill stretch`，圆角/边框不糊 |
| **不透明度** | `opacity`（0..1） | 走 `style` |
| **不可点（透传）** | `clickThrough` | `pointer-events:none` |
| **隐藏 / 层级 z** | `hidden` / `z` | 隐藏的既不上屏也不参与命中；层序 = `10+z` |
| **断点覆盖** | `overrides[bp].rect` | 「固化到本断点」写一份独立布局 |
| **条件显示** | `when.{activeSlot,battleSlot}` | 设计期可切状态预览命中与否 |
| **数据绑定** | `{nickname}` `{roleIcon}` … | 文字键与素材键（键表见引擎 `TPL_*_KEYS`） |

> ⚠️ **字段名注意**：文字样式叫 **`font`**，**不是 `text`** —— 解析后的元素里 `text` 是**渲染后的文字**
> （`layoutAt` 的产出），两个含义撞在一起会静默出错（本轮真踩过）。

> 仍**没有**（登记为未做）：多选与对齐/分布工具、图层拖拽排序面板、标尺与安全区参考线、
> 复制粘贴（现只有「复制」= 原地再放一份）、组件/实例复用。需要的话下一轮加。

#### 容器相关的机器校验（并进 `validateLayout`）

| 级别 | 判据 |
|---|---|
| error | `scroll.dir` 非法（只能 `v`/`h`/`both`/`none`）；`font.size` 不在 1..200；`font.align` 非法 |
| error | `parent` 指向不存在 / 指向自己 / **成环** |
| warn | 声明了 `grid` 但既没 `cellW/cellH` 也没 `cols`（排不出网格）；块里没有子元素（网格排不出东西） |
| warn | 装进了一个 `hit:'path'` 的父块（多边形不裁剪子元素） |
| warn | 九宫格没配 `asset`（看不出拉伸效果） |

> ⚠️ 非法值**不再被静默改掉**：`normalizeElement` 原样保留、交给校验器报 ——
> 静默改成 `v` 会让"看着像滚动容器但没生效"变成最难查的一类问题。

### 预览：**真实产品渲染**（2026-10-05 重做，D-189）

点顶部工具栏的 **「▶ 预览」** 进入预览层。它**不是**画一批近似方块，而是**直接跑产品的渲染管线**：

```
布局表（当前编辑中的内存版）
        ↓  format.setLayout(engine, bundle)
format.viewModel(state)   ← 用 mock 的 /me、/me/configs、/me/warehouse 响应喂进去
        ↓  render.render(vm)
真实 HTML  ← 塞进预览舞台；样式与产品同一套（.dl-*）
```

**因此预览里看到的就是产品实际输出**：百分比定位、多边形命中、径向插槽流、滚动容器、
`grid.flow` 自动换行、按钮按下四模式、九宫格拉伸、弹窗层叠与遮罩阻断 —— 全都成立。

**点任意可交互控件都会执行它的真实动作**：事件委托按 `data-action` + `data-*` 载荷调用
`public/actions.js` 的注册表，弹窗栈由**产品状态机**（`state.hub.modals`）维护。
所以"点仓库 → 弹窗 → 切分类 → 点物品 → 详情 → 分解"这条链路在预览里是**跑真的**。

| 预览能做什么 | 说明 |
|---|---|
| 点所有控件 | 走真实动作注册表；只读动作与本地动作真跑 |
| 看完整界面 | 产品渲染输出（不是近似块）；缺素材处显示产品的占位框 |
| 看弹窗流程 | 弹窗层叠、遮罩阻断背景、点遮罩逐层关闭 —— 全由产品状态机驱动 |
| 看滚动视图 | 「仓库件数」切到 **60 / 200**，网格必须换行并出现滚动条 |
| 切断点 | 顶部「横屏 / 平板 / 竖屏」循环切换，按断点重算 |
| 重来 | 重建 mock 状态、回到主界面（反复试同一段交互） |

> **预览不发网络请求**（设计期工具不该改真实数据）：`api` 出口换成桩，**读接口回带 mock 数据**
> （否则动作顺手重取一次会把界面清空），写接口回 `{}` 并在状态行提示"已模拟调用 xxx"。

> **前提：必须用 `npm run lab` 打开**。产品模块从**同源** `/public/*.js` 加载；
> 直接双击 HTML（`file://`）拿不到 → 预览层会**明确告诉你原因**，不会假装能用。

**mock 数据**（`MOCK_*`，形状与真服务逐字段一致）：六桶各 24 件（可切 4 / 24 / 60 / 200）、
三份出战配置（含一个空槽）、AI 库 6 条、`/me` 带段位/积分/未读/`viewedSlotId`。
**改了后端字段这里要跟着改**（它是"照真响应写的"，不是编的）。

### 三条约定（改的时候记住，机器会核对）

1. **布局表是唯一真源**：工具只改数据，不生成代码；渲染层吃同一张表。
2. **`target` 是设计期注解，但必须与 `action` 说得通**：真正点下去做什么由 `actions.js` 决定；
   校验会检查 ① 目标画面存在 ② 动作不是"进不去画面"的那种（否则报 error）。
3. **数据绑定用 `{键}`**：文字键（`{nickname}` `{roleName}` `{skill1Name}` …）与素材键
   （`{roleIcon}` `{skill1Icon}` `{tierIcon}` `{qualityFrame}` …）；`when` 只支持 `activeSlot` / `battleSlot`。

---

## 2. 存到工作区（给 AI 的那份 JSON）

点**「💾 存到工作区」**，服务会：

1. 把当前布局表写进 **`tools/layout/layout-bundle.raw.json`**（工作区里的真实文件；同时留一份到 `tools/layout/exports/`）；
2. 立刻跑 `import-layout.js`：应用「意图修正」（把写在名字里的功能翻成字段）→ 规范化
   → 生成 **`public/layout-data.js`**（前端直接加载的模块）与 `tools/layout/layout-bundle.normalized.json`。

命令行等价：

```bash
npm run layout:apply            # = node tools/layout/import-layout.js
```

> 布局引擎 `public/layout-engine.js` 由 `tools/layout/make-engine.js` 从布局台里的 `<script id="core">` 生成
> （core digest 写在产物头部，保证"布局台与产品用同一份逻辑"）。改了引擎就重跑一次：
> `node tools/layout/make-engine.js`。

---

## 3. 素材：缺哪些图、叫什么名字、怎么归位

### 3.1 看清单

```bash
npm run assets:manifest          # = node tools/layout/asset-manifest.js
```

会打印并写出：

- **`docs/frontend/assets-manifest.md`** —— 人读版：按类别分组，每项给出
  **状态（已有/待归位/缺）**、**优先级**（★ 先做 = 主界面/对局里立刻看得见的）、**文件名**、**目标路径**、**中文名**、**用途**；
- `tools/layout/assets-manifest.json` —— 机器版（给脚本/AI 用）。

布局台里点「📋 素材清单」看**主界面优先**的那批，「全部（含图鉴类）」看完整清单。

清单来源是**三处合成**的（所以不会漏）：

| 来源 | 覆盖 |
|---|---|
| `server/data/*.json` | 每个角色 / 技能 / 插件族 / 品质 / 段位 / AI 积木节点 / 包 |
| 布局表 | 背景图 + **每个没有素材的按钮**都会给出建议文件名 `assets/ui/<元素id>.webp` |
| 前端拼路径规则（`public/format.js`） | `assets/{role,skill,plugin,ai,frame,tier}/<id>.<ext>` 的命名与扩展名 |

### 3.2 占位素材（**2026-10-04 已清空：当前 0 张**）

> **D-183（2026-10-04）**：用户要求清理占位素材 ⇒ `public/assets/**` 的 **154 张程序生成占位图已全部删除**
> （角色 11 / 技能 4 / 插件 41 / AI 节点 54 / 包 5 / 品质框 5 / 段位 5 / 背景 1 / 界面按钮 28），
> `tools/layout/placeholders.json` 的 `generated` 同时清空。**清单仍完整列出该有的 158 项**
>（`present 0 / missing 154 / coreMissing 54`）—— 它是"要画哪些图"的依据，文件缺失不影响它列出条目。
> 而 **D-182 已关闭布局渲染**，所以主界面不再引用任何图片；重开图形主界面之前，先按下文补素材即可。

要**重新生成占位图**（随时可做，生成器只写清单里的路径、绝不动你的真图）：

```bash
python tools/layout/make-placeholder-assets.py           # 补缺失的
python tools/layout/make-placeholder-assets.py --force    # 连已生成的也重画
```

> 需要 Pillow（本仓库自带的 Python 运行时里就有）。占位图是**按清单的 ID 与规格**生成的，文件名与目录完全对得上。

**安全约定（2026-10-04 复核实测修正）**：生成器只写登记在 `tools/layout/placeholders.json` 的路径。
但判定是**纯登记表**、**不看文件内容**：`can_write()` 只要该路径在登记表里就允许覆盖。
因此——你**直接覆盖** `public/assets/` 下的同名文件后，路径仍在登记表里 ⇒ 再跑一次生成器**会覆盖掉你的真图**，
而且清单仍显示 `🧩 占位`（`asset-manifest.js` 同样只按登记表判定）。
**正确做法**：用 `npm run assets:apply` 归位真图，**并把该路径从 `tools/layout/placeholders.json` 的 `generated` 里删掉**
（归位脚本会顺带刷新清单，届时才会显示 `✅ 真素材`）。这条偏差已登记，待后续把"登记表"换成"按内容/时间戳判定"。

占位素材的风格（都**不带文字**，文字由界面自己渲染，避免重影）：

| 类别 | 画的是什么 |
|---|---|
| 背景 | 深蓝渐变 + 中央光晕 + 极淡六边形暗纹 + 平滑暗角 |
| 角色 | 六边形盾牌（按 id 取色）+ 内圈 + 徽记 |
| 技能 | 菱形盘 + 按技能类型的方向符号（斩击 / 箭头 / 定点 / 位移） |
| 插件 | 圆角方牌；角色插件=圆环、技能插件=三角，右上角小点表示点数 |
| AI 节点 | 代码块样式的圆角块（左侧类别色条 + 代码条） |
| 包 | 箱体 + 缎带 |
| 品质框 / 段位 | SVG（颜色取自 `server/data/qualities.json`，段位用星点表示档位） |
| 界面按钮 | 按元素框生成的底版；多边形元素直接画成同形多边形，被 clip-path 裁切后完全贴合 |

素材接进布局表由 `tools/layout/wire-assets-into-layout.js` 负责（幂等；给缺 `asset` 的元素补路径）。
它和生成器都以**修正后**的布局为准（真源里「设为出战」还是 deco，导入期才变成 button）。
**F10 回退批（D-180）起**：指向待重做屏的入口按钮（`仓库`/`快速对战`/`锦标赛`/`排行`/`AI 编辑`/`设置`）与死按钮
`对战历史` 已从布局表移除，「对战历史」的 intent fix 也随之删除 —— 那些屏改为在 `public/screens.js`
注册表里以 `status:'todo'` 的占位页待重做（见 `docs/frontend/08-foundation.md` §3.2）。

### 3.3 出图与归位

把图按**清单里的 ID** 命名，丢进仓库根的 **`assets-inbox/`**（可以带子目录、可以 PNG/JPG），然后：

```bash
npm run assets:apply             # = node tools/layout/apply-assets.js
node tools/layout/apply-assets.js --dry             # 只预演
node tools/layout/apply-assets.js --inbox D:\我的素材  # 换收件夹
```

脚本会：**识别 → 改名 → 位图转 WebP（保留透明通道）→ 缩放到建议尺寸 → 放进 `public/assets/<类别>/`**，
然后报告：已归位 / 名字对上了但失败（原因）/ **认不出来的文件** / 归位后仍缺什么。
规格与命名细则见 [`assets-inbox/README.md`](../../assets-inbox/README.md)。

> 需要的 Python 只需有 Pillow（本仓库自带运行时里有）；没有时会退化为"只搬移不转换"并提示。

---

## 4. 一键应用

布局台点**「⚡ 一键应用」**（或分别点存盘 / 清单 / 归位），等价于：

```bash
npm run layout:apply && npm run assets:manifest && npm run assets:apply
```

跑完前端就是最新布局 + 最新素材。若界面仍显示虚线占位框，说明那个元素的图还没归位（清单里会列出它的名字）。

---

## 5. 机器核对（不靠人眼）

`tests/frontend/layout-tool-assets.test.js`：

- LT-1 布局表合法、引擎校验 0 error；
- LT-2 布局表里引用的每个字面素材路径都在清单里；
- LT-3 数据表里每个可见对象都有图名（角色/技能/品质/段位/插件族/AI 节点）；
- LT-4 清单里的 id 都真实存在于数据表（防拼错/防过期），且核对 `format.js` 的路径规则与清单同步；
- LT-5 归位脚本认 `<id>` / `<目标名>` / `<kind>_<id>` / `<kind>/<id>` 四种写法，认不出必须返回 null 并报告；
- LT-6 位图类收到 SVG、或没有 Pillow 时"假装转换成功"都会被拦下。

另外测试套里还有：`layout-hub-vm.test.js`（投影层 LH-1..7）、`hub-warehouse-flow.test.js`（WH-1 真装配/清空）、
`static-hosting.test.js`（SH-2b 素材类型白名单）。

---

## 6. 目录与产物一览

| 路径 | 是什么 | 入库 |
|---|---|---|
| `tools/layout/lab.html` | 布局台本体（自包含：引擎内联、无外部依赖） | ✅ |
| `tools/layout/lab-server.js` | 本地服务：存盘 / 清单 / 归位 / 一键应用 | ✅ |
| `tools/layout/import-layout.js` | 导出 JSON → 意图修正 → `public/layout-data.js` | ✅ |
| `tools/layout/make-engine.js` | 布局台 core → `public/layout-engine.js` | ✅ |
| `tools/layout/asset-manifest.js` | 素材清单生成器 | ✅ |
| `tools/layout/apply-assets.js` | 收件夹 → `public/assets/` 归位（改名/转格式/缩放） | ✅ |
| `tools/layout/layout-bundle.raw.json` | **布局表真源**（「存到工作区」写它） | ✅ |
| `tools/layout/assets-manifest.json` | 素材清单（机器版） | ✅ |
| `public/layout-data.js` | 前端加载的布局数据（生成物） | ✅ |
| `public/layout-engine.js` | 前端布局引擎（生成物） | ✅ |
| `public/app.css` | 界面样式（百分比定位 / 多边形命中 / 遮罩 / 占位 / 标灰） | ✅ |
| `public/assets/**` | 归位后的素材（最终产物） | ✅ |
| `assets-inbox/**` | 你的原图收件夹（只提交 README） | 图不入库 |
