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
| 顶部工具栏 | 画面切换（整屏/弹窗）、加元素、复制、删除、导入/导出 JSON、校验、预览弹窗流程、**存到工作区 / 素材清单 / 归位素材 / 一键应用** |
| 左侧 | 元素列表（显示 `when` 条件命中情况与断点覆盖）、素材目录匹配、**存盘 / 素材面板** |
| 中间舞台 | 拖动、八向缩放、旋转（Shift 吸附 15°）、吸附与辅助线、按 `P` 切形状编辑（拖顶点 / Alt 点击删点 / 双击加点）、缩放与平移 |
| 右侧 | 元素属性（id/动作/载荷/目标画面/形状/素材/绑定/替换文字/`when`）、画面属性（角色、背景、遮罩）、断点预览、径向生成器、设计期状态、校验结果、布局 JSON |

### 三条约定（改的时候记住，机器会核对）

1. **布局表是唯一真源**：工具只改数据，不生成代码；渲染层吃同一张表。
2. **`target` 只是设计期注解**：真正点下去做什么由 `actions.js` 决定；校验会检查目标画面存在。
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

### 3.2 出图与归位

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
