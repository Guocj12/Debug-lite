# Debug-Lite v3 前端详细设计（实现级）

> 版本：v2（实现级）　更新：2026-09-12
> 定位：**P6 前端实现的唯一依据**——精确到每个功能、每个模块、每个场景如何实现、如何与后端对接、如何绘制。**自然语言可直接转代码**。
> 权威链：`docs/decisions.md` > `docs/interfaces.md`（API 契约）> 本文 > `docs/tasks.md` §7。
> 关联：服务器部署/端点见 `docs/server.md`；帧结构见 `docs/battle-walkthrough.md` §4；AI 后端接口见 `interfaces.md` §1/§2。

---

## §0 总则（转代码的人先读）

1. **零框架零构建**（D-124）：原生 ES Modules + CSS；`public/index.html` 只挂一个 `<div id="app">`、一个 `<canvas id="battle">` 和一个 `<script type="module" src="js/app.js">`。
2. **三个全局调试设施**（本设计的核心，回答"AI 看不到画面"）：
   - **确定性盒模型**：所有界面元素由 `layout(state) → Box[]` 纯函数产出**数值坐标**，不依赖浏览器布局引擎推算关键位置（jsdom 也能断言）。
   - **像素级绘制日志**：canvas 每个图元、DOM 每个盒子都产出结构化日志（含 px 坐标），见 §3.3/§6.5。
   - **布局自检器 `verifyLayout`**：每次布局后自动检测 重叠 / 越界 / 零尺寸 / 隐藏 / z 冲突，输出报告（§4.4）。
3. **日志通道**：前端复用 `shared/log.js`（`window.DLLog`），新增通道 `ui`（界面）、`render`（绘制）、`api`（与后端同一通道名）、`store`、`editor`。前端所有日志**默认 debug/trace 级**开发期全开（`?log=trace`）。
4. **设计基准**：视口 **1280×720**（CSS px）；战斗画布 **1024×128**（1 引擎 px = 1 CSS px，可整体缩放）；缩放因子 `s = canvas.width / 1024`。
5. **状态归属**：`warehouse / loadout / tier / seed / logPrefs` 均存客户端 `localStorage`（D-123 无服务端状态）；后端只做校验与回带。

---

## §1 运行环境与装配

### 1.1 静态托管（后端 P6 需新增，属于后端改动）

`server/index.js` 增加（express 引入时）或手写静态路由（沿用零依赖）：

| 路由 | 目录 |
|---|---|
| `/`、`/index.html` | `public/` |
| `/js/*` | `public/js/`（`content-type` 按扩展名） |
| `/css/*` | `public/css/` |
| `/shared/*` | `shared/`（即 `window.DLLog` 的 UMD 文件） |
| `/vendor/blockly/*` | `node_modules/blockly/`（P6 安装后） |
| `/assets/*` | `assets/`（占位美术表，已存在） |

> 静态路由必须继续走 `/api/v1/*` 之外的路径；`/api/v1` 处理优先级高于静态。

### 1.2 `index.html`（骨架）

```html
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=1280, initial-scale=1">
<title>Debug-Lite v3</title>
<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/style.css">
<script src="/shared/log.js"></script></head>
<body>
  <div id="app"></div>
  <canvas id="battle" width="1024" height="128" style="display:none"></canvas>
  <script type="module" src="/js/app.js"></script>
</body></html>
```

### 1.3 启动流程 `js/app.js`

```
1. window.DLLog 已就绪 → util/log.js 初始化：读 URL ?log= 与 localStorage.logPrefs → setLevel/setChannelLevel
2. api/client.js 创建（注入 fetch、base='/api/v1'）
3. store 读取 localStorage（schemaVersion 校验，见 §8）→ 初始 state
4. views 注册（7 屏）→ mount 挂到 #app → dispatch {type:'goto', screen:'menu'}
5. 异步：GET /api/v1/health → state.meta.serverOk；GET /api/v1/unlock?tier= → state.tierInfo
6. 日志：`store.boot`(info) {state:{tier,loadoutHash,warehouseCount}}
```

### 1.4 视觉令牌（`public/css/tokens.css`，P6 第一行代码）

```css
:root{
  --color-bg:#0e1116; --color-panel:#161b22; --color-line:#30363d;
  --color-text:#e6edf3; --color-muted:#8b949e; --color-accent:#58a6ff;
  --color-danger:#f85149; --color-ok:#3fb950;
  --color-q-common:#2ecc71; --color-q-rare:#3498db; --color-q-epic:#9b59b6;
  --color-q-legendary:#e67e22; --color-q-mythic:#1abc9c;   /* 品质色 = items-data §2 */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
  --space-5:24px; --space-6:32px; --space-7:48px; --space-8:64px;
  --font-ui:system-ui,sans-serif; --font-mono:ui-monospace,monospace;
  --radius-s:4px; --radius-m:8px; --radius-l:12px;
  --z-base:0; --z-panel:10; --z-modal:90; --z-snack:95; }
```
- **纪律**：间距只用 `--space-*`；颜色只用 `--color-*`；类名前缀 `.dl-`；禁止行内样式与魔法数字（审查核对项）。
- 品质映射辅助函数 `qColor(quality)` 与 `qBadge(quality)`（24×24 圆）在 `ui/quality.js`。

---

## §2 日志规范（前端，像素级）

### 2.1 统一记录结构

```jsonc
{ "seq":9001, "ts":1726400000000,
  "tick": null,                       // 战斗相关时填帧号
  "level":"debug", "levelValue":4,
  "channel":"render",                 // render|ui|api|store|editor|perf|log
  "event":"render.box",
  "data": { "view":"replay", "boxId":"char_p1", "x":224, "y":96, "w":64, "h":64, "z":3, "color":"#58a6ff" } }
```

约定：
- `x,y,w,h` 一律 **CSS px**（canvas 内按引擎 px，另加 `"scale":s` 字段注明）。
- 每个可点元素带 `boxId`（`data-box-id`），点击事件日志 `ui.click {boxId, x, y}`。
- **开发期（P6 全程）前端日志级别默认 `debug`，`render` 通道 `trace`**——由 `app.js` 启动时强制（除非 `?log=` 显式覆盖，见 §2.4）。

### 2.2 日志事件清单（必须实现并断言，`T-LG-10` 前端部分）

| 事件 | 级别 | data（必含字段） |
|---|---|---|
| `store.boot` / `store.dispatch` | info / debug | `{action, screen, sideEffects}` |
| `store.state` | trace | 完整 state（去重/摘要） |
| `api.req` / `api.res` / `api.err` | info / info / error | `{method, path, ms, bytes, code} ` |
| `ui.layout` | debug | `{view, boxes:[{id,x,y,w,h,z,visible}]}`（**每次 layout 后必打**） |
| `ui.layout.report` | warn | `verifyLayout` 的 issue 数组（非空时） |
| `ui.click` | debug | `{boxId, x, y}` |
| `view.render` | debug | `{view, phase}`（phase=loading/empty/error/ready） |
| `render.frame` | trace | `{tick, primitives, scale, actors:[{id,x,y,w,h}]}` |
| `render.box` / `render.text` / `render.sprite` / `render.clear` | trace | 单个图元（完整格式见 **§7.4**） |
| `store.save` / `store.load` | info | `{schemaVersion, bytes, keys}` |
| `editor.ast.encode/decode` / `editor.toolbox` / `editor.block.pos` | debug | 见 §7 |

### 2.3 绘制日志 = 调试的"眼睛"

**规则：任何会改变画面内容的调用，都必须有一行日志说明"画了什么、画在哪"。** 具体：

- **canvas 侧**：`render/battle.js` 内每个 `ctx.*` 调用前一行日志（`render.box/text/sprite/clear`），字段见 §6.5。`render.frame` 每帧汇总（图元数量、所有演员的坐标）。
- **DOM 侧**：视图 `render(state)` 产出 HTML 后，`mount` 在挂载前调用 `collectBoxes(html)`（解析 `data-box-id` + 样式表推算坐标）输出 `ui.layout`；浏览器实跑后再用 `getBoundingClientRect` 输出 `ui.rect`(debug) 做**实测校准**（差异 >1px 时 `ui.layout.report` warn）。
- **Blockly 侧**：`editor.block.pos` 记录每个积木 `getRelativeToSurfaceXY()` 坐标（见 §7.4）。

### 2.4 总控与导出

| 开关 | 行为 |
|---|---|
| URL `?log=trace` / `?log=ui:trace,render:trace` | 覆盖默认级别（解析与后端 `parseChannelOverrides` 相同语法） |
| `localStorage.logPrefs` | `{level, channels}`，设置屏日志面板写入 |
| `window.DLLog.setLevel(...)` | 运行时切换（F12 控制台） |
| `dlui.exportTrace()` | 把环形缓冲导出为 JSON 下载（文件名 `dl-trace-<ts>.json`） |
| `dlui.dumpBoxes()` / `dlui.dumpTree()` | 控制台打印当前所有盒子 / DOM 树 + 坐标 |

---

## §3 确定性盒模型与布局引擎

### 3.1 Box（唯一坐标事实源）

```js
{ id:'btn_open_box', kind:'button', parent:'panel_gacha',
  x:400, y:420, w:160, h:40, z:5, visible:true,
  style:'primary', text:'开箱' }        // kind 决定渲染模板
```

- 坐标 = 相对视口左上角（CSS px）；`z` 决定层叠（相同时按 id 字典序）。
- **布局计算只允许这里，不许在 CSS 里用 auto/flex 决定关键位置**。CSS 只负责盒内视觉（渐变、边框、字体）。
- 每个屏幕一个 `layout(state) → Box[]` 纯函数；嵌套结构用 `parent` 字段表达。

### 3.2 尺寸常量（组件库，`public/js/ui/sizes.js`）

| 组件 | w×h（px） | 备注 |
|---|---|---|
| Button（primary/danger/ghost） | 160×40 / 同 / 96×32 | 间距由父盒 padding 决定 |
| Panel | 自适应，padding `--space-4`（16） | 细边框 1px `--color-line` |
| ListItem | 全宽 × 56 | 左图标 32 + 标题 + 右说明 |
| GridCell（物品/技能卡） | **168×108** | 品质描边 2px；gap 16 |
| Modal | 480×自适应（max 560） | 遮罩 z=90，面板 z=91 |
| Toast | 320×48 | 右上，z=95，3s 自动消失 |
| Field（输入框） | 全宽 × 40 | label 上 16px |
| Tab | 120×40 | 底部 2px 高亮条 |
| Badge（段位/品质） | 24×24 圆 | 品质色填充 |

### 3.3 坐标计算规则

- 一个屏幕的纵向骨架：`header h=64`；`main y=64`；屏内面板用固定 x/y 或水平居中公式 `x=(1280-w)/2`。
- **禁止浮动三分法**：所有间距来自 `--space-*`；网格布局由 `grid(x0,y0,cols,cellW,cellH,gap)` 纯函数生成坐标（见 §3.4）。
- 坐标必须是整数（`Math.round`），避免浏览器亚像素渲染导致 1px 缝隙/重叠。

### 3.4 布局工具（`public/js/ui/layout.js`）

```js
grid(x0,y0,cols,cellW,cellH,gap,items) → Box[]   // items 顺序填充，坐标= x0+(i%cols)*(cellW+gap), y0+floor(i/cols)*(cellH+gap)
center(w,h,parent) → {x,y}                       // (W-w)/2, (H-h)/2（W/H 为视口或父盒）
stack(y0,items,{gap}) → Box[]                    // 纵向排列
panel(x,y,w,h,title) → Box                       // 生成面板盒
```

### 3.5 `verifyLayout(boxes)`（自检器，对治重叠/不显示/覆盖）

对 Box[] 做四项检查，输出 `[{boxId, issue, detail}]`：

| issue | 判定 | 日志 |
|---|---|---|
| `clip`（越界） | `x<0 || y<0 || x+w>1280 || y+h>720`（可排除 fullscreen 遮罩） | warn |
| `overlap`（重叠） | 两可见盒 `z` 相同时矩形相交 >0（父-子盒除外；父子交集是正常的） | warn |
| `zero`（不显示） | `w<=0 || h<=0` 或 `visible===false` 但被业务逻辑引用 | warn |
| `zconflict`（覆盖） | 父子 z 关系颠倒（子 z ≤ 父 z）或遮罩 z 小于其下内容 | warn |

每次 `mount` 渲染后自动调用；有 issue 时 `ui.layout.report`(warn) 打印完整清单，**且开发期在此处断点提示**（`debugger` 仅在 `window.__DL_UI_DEBUG__` 时）。

### 3.6 无头可测（关键）

`layout(state)` 与 `verifyLayout` 均为纯函数 → jsdom 测试无需布局引擎：

```
tests/frontend/layout.test.js
  - 每屏 layout(state) 快照：与 goldenJSON 逐字段相等
  - verifyLayout：构造重叠/越界/零尺寸用例 → 断言报告
  - grid/center/stack：坐标断言（含边界：0 项、1 项、多行）
```

---

## §4 状态层（store）

### 4.1 state（完整形状）

```js
{
  screen:'menu',                        // 7 屏之一
  meta:{ serverOk:true, version:'3.0.0', tableNames:[...] },
  tier:'common', tierInfo:{ nodes:[...], roleTemplates:[...], skills:[...], plugins:[...] },
  seed:null,
  warehouse:{ roles:[], skills:[], rolePlugins:[], skillPlugins:[] },   // 物品实例数组（uid 判定：内容级比较按 B17 语义）
  loadout:{ role:null, skills:[null,null,null], ai:null },
  panel:null,                            // 最近 /panel 的结果
  aiDraft:{ program:null, hash:null, errors:[], compiling:false },
  gacha:{ opening:false, lastResult:null },            // lastResult.items[]
  battle:{ config:null, running:false, frames:[], result:null, tick:0, speed:1 },
  logPrefs:{ level:'debug', channels:{ render:'trace' }, panelOpen:false },
  ui:{ busy:false, snackbar:[], modal:null, activeTab:{} },
}
```

### 4.2 action 清单（reducer + 副作用分开写）

| action | payload | reducer 要点 | 副作用（effect 层，调用 api 后 dispatch 结果） |
|---|---|---|---|
| `goto` | `{screen}` | 设置 screen；清临时 ui 态 | `view.render` 日志 |
| `tier/set` | `{tier}` | 更新 tier；写入 localStorage | `GET /api/v1/unlock` → `tierInfo` |
| `box/open` | `{times}` | busy=true | `POST /box` → `gacha.lastResult` + 仓库合并 → `box/done` |
| `box/done` | `{resp}` | 合并 items（按 kind 追加），busy=false | `store.save` |
| `wh/assemble` | `{targetUid,pluginUid,slotIndex}` | 乐观更新或等响应；错误 → snackbar | `POST /warehouse/assemble` → 用**响应中的 warehouse** 整体替换 |
| `wh/disassemble` | `{targetUid,slotIndex}` | 同上 | `POST /warehouse/disassemble` |
| `loadout/set` | `{loadout}` | 替换 loadout；写入 localStorage | `POST /loadout` 校验（可延迟到"出战"时） |
| `loadout/validate` | `{}` | aiDraft.errors=[] | `POST /loadout` → 拒绝时把 details 展开到 snackbar/面板 |
| `ai/edit` | `{program}` | 写 aiDraft | debounce 300ms → `POST /ai/validate` → errors（带 path） |
| `ai/compile` | `{}` | compiling=true | `POST /ai/compile` → hash + stats → aiDraft |
| `ai/run` | `{opponent}` | battle.running=true | `POST /ai/battle` → frames/result → `battle/loaded` |
| `battle/loaded` | `{frames,result}` | 存入；tick=0 | `goto replay` |
| `battle/seek` | `{tick}` | 设置当前帧 | 渲染层订阅变化 |
| `replay/play` / `replay/pause` / `replay/speed` | `{}` / `{speed}` | 播放控制 | 定时器（effect 层）每次 tick+1 dispatch seek |
| `panel/show` | `{loadout}` | panel=null→调用 | `POST /panel` → panel 结果 |
| `log/set` | `{level,channels}` | 写 logPrefs + localStorage | `DLLog.setLevel/setChannelLevel`；`POST /api/v1/log-level`（仅开发期同步后端） |
| `save/export` / `save/import` | `{file}` | 见 §8 | 下载/读文件 |
| `ui/toast` | `{text,kind}` | push snackbar（3s 后自消） | — |

> 所有副作用函数写在 `store/effects.js`，签名 `(ctx, action) → Promise`，ctx={api,store(state),dispatch,log}。测试可注入假 api。

### 4.3 localStorage

- key：`dl.v3.state`（schemaVersion=1，见 §8）；`dl.v3.logPrefs`；`dl.v3.seed`。
- 写入时机：tier/warehouse/loadout/gacha.lastResult 变化后（`store.save` 事件 info）。
- 读取：`app.js` 启动时，schemaVersion 不符 → 走迁移或清空并 toast。

---

## §5 API 客户端（`public/js/api/client.js`）

```js
async function request(method, path, body, {signal}={}) {
  // 1. 日志 api.req{method,path,bodyBytes}
  // 2. fetch(`/api/v1${path}`, {method, headers:{'content-type':'application/json'}, body: body?JSON.stringify(body):undefined, signal})
  // 3. 解析信封：ok:true→data；ok:false→Err(code,message,details)
  // 4. 网络/解析异常 → Err('network', ...)
  // 5. 日志 api.res{ms,bytes,code} / api.err
  // 6. 若响应 data.seed 存在且请求未带 seed → store 回写 seed（回带，T-AP-5）
}
export const api = {
  health: () => get('/health'),
  unlock: (tier) => get(`/unlock?tier=${tier}`),
  data: (table) => get(`/data/${table}`),
  logLevel: { get: () => get('/log-level'), set: (lvl) => post('/log-level', lvl) },
  aiValidate: (p) => post('/ai/validate', p),
  aiCompile: (p) => post('/ai/compile', p),
  aiBattle: (p) => post('/ai/battle', p),
  box: ({seed,tier,times}) => post('/box', {seed,tier,times}),
  wh: { list: () => get('/warehouse'), assemble: (b) => post('/warehouse/assemble', b), disassemble: (b) => post('/warehouse/disassemble', b) },
  loadout: { get: () => get('/loadout'), save: (b) => post('/loadout', b) },
  panel: (b) => post('/panel', b),
  battle: (b) => post('/battle', b),          // B22 后启用
  replay: (id, from, to) => get(`/replay/${id}?from=${from}&to=${to}`),  // B22 后启用
};
```

- 超时：AbortController，8s（`ai/battle`/`battle` 120s）；超时 → Err('timeout') → UI 重试。
- **测试**：`tests/frontend/api.test.js` 注入假 fetch（返回信封对象），断言请求路径/体、错误归一、seed 回带。

---

## §6 视图层：七屏逐个实现细节

> 每屏给出：布局坐标（1280×720 基准）、HTML 模板要点、事件→dispatch、API 对接、日志。`render(state)→HTML` 一律纯函数；所有可交互元素写 `data-action="...|参数"` 与 `data-box-id`。

### 6.0 通用外壳（`views/shell.js`）

```
header: x0,y0,w1280,h64        logo(16..180) tier badge(1120..1176) seed(1184..1272) log 按钮(右)
main:   y=64..720
```
- `mount` 先渲染 shell，再渲染当前屏；`goto` 只替换 main 区（shell 不重挂）。
- shell 每次渲染调用 `ui.layout`(debug)。

### 6.1 主菜单 `menu`

| 场景 | 行为 |
|---|---|
| loading | 拉 health/unlock；中心面板显示"加载中" |
| ready | 中央面板（`center(560,360)` → x360 y184），标题 40，按钮栈：AI 编辑 / 仓库装配 / 开箱 / 对战 / 设置（各 160×40，gap 12；y 从 260 起） |
| error | `meta.serverOk=false` → 面板显示连接失败 + 重试按钮（`data-action="boot"`） |
| empty | 无存档 → 提示 + 默认 loadout 提示 |

- 事件：`btn->goto editor|warehouse|gacha|battle|settings`；`boot` → 重跑 app.js 启动步骤。
- 日志：`view.render menu ready`；`ui.click btn_ai …`。
- API: `GET /health`、`GET /unlock?tier=`。

### 6.2 AI 编辑器 `editor`

布局：
```
toolbox(左): x0,y64,w120,高 592      # 按 tierInfo.nodes 过滤的积木目录（置灰不可拖）
workspace:  x120,y64,w1024,高 432   # Blockly 注入点（绝对定位容器 div#blocklyDiv）
panel(右):  x1144,y64,w136,高 592   # 校验/编译/试运行按钮 + programHash + 错误计数
errors(底): x120,y496,w1024,高 160  # 错误列表（每行：path + code + 消息，点击→高亮对应积木）
```

| 功能 | 实现 |
|---|---|
| Blockly 初始化 | `editor/main.js`：`Blockly.inject('blocklyDiv',{toolbox:buildToolbox(tierInfo.nodes), grid:{spacing:24}, zoom:{controls:true}})`；工作区顶部**预置外层 `while(true)` 积木**（`loop_forever`，`movable:false, deletable:false`，§7.2） |
| 实时校验 | `workspace.addChangeListener(debounce(()=>{ const p=bridge.toAst(); dispatch('ai/edit',{program:p}); },300))`；成功后错误列表= `aiDraft.errors` |
| 编译 | 按钮 → `ai/compile` → hash 显示（前 8 字符 + 复制钮） |
| 试运行 | 按钮 → `ai/run{opponent:kiter}` → `battle/loaded` → goto replay |
| 高亮 | `errors` 行点击 → `bridge.highlight(path)`（按 path 定位积木：逐层 `getInputTargetBlock`；找不到 → toast「程序已变化」） |

- 日志：`editor.ast.encode{blocks:N, roots:M}`、`editor.ast.decode{programBytes}`、`editor.toolbox{visible:count}`、`editor.block.pos{id,x,y}`（collectWorkspaceBoxes 每 250ms 或拖动结束时）。
- Blockly 区 DOM 由 Blockly 管理：**our mount 不触碰 workspace 内部**；`data-box-id` 只加在容器与工具栏。

### 6.3 仓库/装配 `warehouse`

```
buckets(左):  x16,  y80,  w168, 高 500   # 4 个 Tab：角色/技能/角色插件/技能插件
grid(中):     x200, y80,  w864, 高 500   # grid(200,80,4,168,108,16) → 每行 4 卡
detail(右):   x1080,y80,  w184, 高 500   # 选中物品详情：槽位表/点数/装配按钮
点数提示条:    y592..640                # 装配区：插槽清单 + 已用点数/上限
```

| 场景/事件 | 实现 |
|---|---|
| 卡片点击 | dispatch `wh/select{uid}` → detail 显示 |
| `wh/assemble` | 打开装配抽屉（Modal 480 宽）：显示目标模板槽位列表（槽 type + 已装/空）+ 每个槽的可装配插件复选框（本地按 `slot`/点数/门控过滤，`ui.layout.report` 保障不重叠）→ 确认 → 副作用调 API → 失败 snackbar(code) |
| `wh/disassemble` | detail 的"拆卸"按钮（槽位非空时可用） |
| 品质描边 | 卡片左边 2px 品质色条（`--color-q-*` 映射，tokens §8 旧文件 → 沿用） |
| empty | 无物品：grid 区显示空提示 + 「去开箱」按钮 |
| error | 仓库校验失败（如 uid 悬挂）：toast + 建议 export/import 修复 |

- API：`wh.list`（骨架）、`wh.assemble/disassemble`、`data/role-templates|skill-templates|plugins`（图标/描述）。
- 日志：`view.render warehouse ready`；每次布局 `ui.layout`（盒子 ~40 个）；装配成功 `wh.assemble.ok{targetUid,pluginUid}`。

### 6.4 开箱 `gacha`

```
panel(中): center(480,300) → x400,y210   # 段位选择(下拉) + 次数 Field(1..10) + 开箱按钮
results:  grid(96, 420, 6, 168, 108, 16) # 结果卡片（品质描边 + 名称 + 类型图标）
```

| 场景 | 实现 |
|---|---|
| 开箱 | busy=true（按钮转圈 disabled）→ `POST /box {seed,tier,times}`；响应 `data.seed` 回写 state.seed（日志必记）→ 结果并入 warehouse → `gacha.lastResult` 驱动 results 渲染 |
| 动画 | 结果卡**按数组顺序逐张出现**（每张间隔 120ms，纯 CSS transition + `setTimeout` 链；每张出现打 `render.box` 日志）→ 完成后 toast「新物品 xN」 |
| tier_locked | snackbar(code + message)，段位下拉置灰不可选档 |
| 满仓 | 结果直接展示 + 提示仓库上限？（后端无上限；前端不设限，仅提示"建议整理"） |

### 6.5 对战配置 `battle`

```
config(左): x16,  y80, w640, h400   # 对手选择（示例 AI：kiter/chaser/cautious）+ 我方 loadout 摘要 + seed Field
preview(右): x680, y80, w584, h400  # 己方 panel（调 /panel）与对手属性简表
start:      center 底部 y 500 按钮「开始对战」
```

| 场景 | 实现 |
|---|---|
| B22 前 | `POST /ai/battle {program,seed,tier,opponent}`（己方 AI 来自 loadout.ai 或 aiDraft） |
| B22 后 | `POST /battle {p1,p2,seed}`（完整双配置）；回放 id 存入 battle.meta |
| 开始前 | `loadout/validate`（POST /loadout）失败 → 提示先修装配 |
| seed | 空 → 后端生成回带（T-AP-5）；按钮「随机」= 填入 `Date.now()%1e9` |

### 6.6 回放与结算 `replay`（战斗渲染见 §7）

```
canvas:  x16, y80,  w1024,h128    # #battle 画布（显示）
HUD:     canvas 上方叠加（absolute）：双方 hp/资源/基地条（y=84..112）
控制条:  x16, y220, w1024,h56     # 播放/暂停/步进/倍速(1/2/4)/tick 滑块(0..frames-1)
aiTrace(右): x1064,y80,w200,h400  # 本 tick 轨迹列表（path/type/result）
结算弹窗: 胜负 + reason + 「再来一局」「返回菜单」
```

- 帧数据：`battle.frames[i].diff`（自足，T-BT-1）；**渲染层只读 frames，绝不重算**。
- 播放状态机：`playing` 时 effect 每 `1000/speed` ms dispatch `battle/seek{tick+1}`；到最后一帧自动 pause + 结算。
- 结算：`battle.result`（winner/reason/final）→ Modal；日志 `battle.end{winner,reason,tick}`。

### 6.7 设置 `settings`

```
left(16,80,560,400):  种子 Field、段位选择（写 localStorage）、关于/版本
right(600,80,664,400): 日志面板：级别下拉、通道勾选（19 通道）、环形缓冲列表（最近 200 条）、导出按钮、复位按钮
存档(16, 500, 560, 80): 「导出存档」「导入存档」
```

- 日志面板数据源：`DLLog.dump()`；过滤按 level/channel；`export` → 下载 JSON。
- `log/set` 副作用同步 `POST /api/v1/log-level`（仅开发期）。

---

## §7 战斗渲染层（`public/js/render/battle.js`，像素级）

### 7.1 坐标与缩放

| 项 | 规则 |
|---|---|
| 引擎 px → 画布 | `sx = x*s`，`s = canvas.width/1024`（默认 1）；`sy = y*s` |
| 角色 | 64×64（引擎 1 格），绘制锚点 = 角色中心（`x-32, y-32`，y 底部贴地线 128） |
| 插值 | 播放时 `t = (now - frameStartMs)/frameMs`（clamp 0..1）：`x(t)=fromX+(toX-fromX)*t`；速度 1x 时 frameMs=1000 |
| z 层 | 0 地面 → 1 拖影 → 2 弹幕 → 3 角色 → 4 HUD → 5 特效（火花/伤害数字） |

### 7.2 逐帧绘制流程（`drawFrame(diff, t)`）

```
1. ctx.clearRect(0,0,w,h)（日志 render.clear{x:0,y:0,w:1024,h:128}）
2. 地面：16 格交替色（s=1 时每格 64px）——日志 render.box{kind:'tile',id:'tile_7',x:448,y:64,w:64,h:64}
3. 弹幕（diff.bullets[]，见 §5 帧结构）：
   - aoe：实心矩形 32×32 居中于 x0（clashAt 时画 24×24 火花，淡出 2 帧）
   - straight：本 tick 起点→命中点连线（2px，等级色），命中点 `hitAt` 火花
   - 日志 render.sprite{kind:'bullet',uid,level,x,y,w,h,color}
4. 角色（diff.players[]）：fromX→toX 插值；朝向三角形指示；defending 金色描边；fullDodge 半透明；buffs 粒子（右上 12×12 圆）
5. 碰撞（diff.collisions[]）：atX 处 40×40 星形火花 + 双方伤害跳字（±20px 上浮 300ms）
6. HUD：血条 96×8、资源条、CD 图标（base 64×20）——日志 render.box{kind:'hud'...}
7. 结束（result 存在时）：胜方高亮描边
8. 汇总结日志 render.frame{tick,primitives:N,actors:[{id,x,y,w,h}],scale:s}
```

### 7.3 帧间差异与 seek

- `battle/seek{tick}` → 渲染层重绘该帧（`drawFrameAt(tick, t=1)`）；拖动滑块不许漏日志（每次 seek 一次 `render.frame`）。
- 回放一致性测试（`tests/frontend/render.test.js`）：同一帧数据驱动渲染器两次 → 图元序列（JSON）完全一致（`render` 纯函数化：`planFrame(diff,t) → primitives[]`，绘制器只执行 primitives → 可无头断言）。

### 7.4 绘制日志完整格式（`render.*`）

```jsonc
// render.box（矩形/血条/瓦片）
{ "seq":9005,"tick":7,"level":"trace","channel":"render","event":"render.box",
  "data":{ "kind":"actor","uid":"p1","x":224,"y":96,"w":64,"h":64,"z":3,
           "fill":"#58a6ff","stroke":"#2ecc71","alpha":1,"framed":true } }
// render.sprite（弹幕/火花/粒子）—— 加 shape 字段
{ "data":{ "kind":"bullet","uid":"b_12","shape":"rect|line|spark|dot","x":686,"y":112,"w":32,"h":32,
           "color":"#{level色}","level":3,"alpha":0.9,"dur":1 } }
// render.text（伤害数字/标签）
{ "data":{ "kind":"dmg","text":"18","x":686,"y":80,"w":32,"h":24,"font":"12px ui-monospace","fill":"#f85149","dur":3 } }
```

**排查法（示例）**：若"命中特效没出现"→ 查 `render.frame` 的 `primitives` 是否含 spark 图元；若缺 → 查帧数据 `diff.bullets[].hitAt` 是否存在（后端问题）；若在 → 查绘制函数分支条件（前端问题）。

---

## §8 存档（localStorage）

- key `dl.v3.state`：`{schemaVersion:1, tier, warehouse, loadout, gacha.lastResult?}`；`dl.v3.logPrefs`、`dl.v3.seed` 分开存。
- 读写封装 `store/persist.js`：`load()`（版本不符 → 尝试迁移表 `persist.migrations[1→2]`，无迁移 → 丢弃 + `store.load` warn）；`save()`（节流 500ms）。
- export/import：`JSON.stringify` 全量；import 校验结构（缺字段 → 拒绝并 toast `bad_save`）；导入后 `goto menu` 并全量重渲染。
- 日志：`store.save{schemaVersion,bytes}`、`store.load{schemaVersion,keys}`。

---

## §9 测试策略（前端，P6 排批次时并入 tasks 矩阵）

| 测试文件 | 断言 |
|---|---|
| `tests/frontend/layout.test.js` | 每屏 layout 快照、verifyLayout 四类 issue、grid/center/stack 边界 |
| `tests/frontend/views.test.js` | 每屏 `render(state)` 四态输出、含 `data-action`/`data-box-id`、字符串非空 |
| `tests/frontend/render.test.js` | `planFrame(diff,t)` 图元序列确定性 + 快照 |
| `tests/frontend/store.test.js` | reducer 纯函数（含 error 路径）、persist 往返、迁移 |
| `tests/frontend/api.test.js` | 假 fetch：路径/体/错误码/seed 回带/超时 |
| `tests/frontend/bridge.test.js` | 积木↔AST 往返无损（T-ED-1）、非法映射拒绝 |
| `tests/frontend/dom.test.js`（jsdom） | mount 后盒子收集与 `data-box-id` 齐全；点击委托 → dispatch 正确 |

- jsdom 无布局引擎 → **一切坐标断言走 layout 纯函数与 collectBoxes（静态推算）**；浏览器实测 rect 由人工截图核对清单兜底（每屏一次）。
- 覆盖率：`public/js/**`（P6 起纳入 gate 第 7 项阈值目录，见 tasks §3.4 的 THRESHOLD_DIRS 扩展）。

---

## §10 调试指南（AI 专用协议）

### 10.1 看不到画面时的标准动作（按序执行）

1. `dlui.dumpBoxes()` → 看当前屏**实际盒子坐标清单**；对照本文 §6 的布局坐标表，**任何偏差 >1px 都是 bug**。
2. `dlui.dumpTree()` → DOM 树 + 坐标（若想确认嵌套关系）。
3. 查 `ui.layout.report`（warn）→ 重叠/越界/零尺寸即在此。
4. 战斗画面：`dlui.exportTrace()` 导出日志 → 查 `render.frame` 每帧的 `actors[]` 坐标与 `primitives` 数；再对照 `.audit/golden-battle.json` 的帧（期望值）。
5. 期望 vs 实际：把期望坐标写进测试快照（layout/render goldenJSON），跑 `npm test` 得到 diff——**diff 就是调试信息**。

### 10.2 常见问题 → 排查表

| 现象 | 查什么 | 常见根因 |
|---|---|---|
| 按钮/卡重叠、遮挡 | `ui.layout.report` overlap / zconflict | 坐标公式错、z 未赋值、grid 参数（cellW/gap）与卡片实际尺寸不符 |
| 元素不显示 | report 的 `zero`；`ui.layout` 中 visible 字段 | w/h=0、visible=false、父盒被裁（clip） |
| 元素跑到屏外 | report 的 `clip`；坐标绝对值过大 | 忘了 center/grid 边界、负数坐标 |
| 绘制错位 1px 缝隙 | 坐标非整数 | × (`x,y` 需 `Math.round`) |
| 弹幕没画/画错 | `render.frame` 的 primitives 与 actors | 帧数据缺字段（对后端）/ 插值 t 错误 |
| 点击无反应 | `ui.click` 日志缺失；`data-action` 拼写 | action 名与 reducer 分支不一致、事件委托选择器错 |
| 后端返回错误但界面无提示 | `api.err` 日志；snackbar 缺失 | effect 层未 catch → 未 dispatch `ui/toast` |
| Blockly 积木错乱 | `editor.block.pos`、`editor.ast.encode` 的映射表 | bridge 映射缺节点；AST 与积木字段名不一致 |

### 10.3 渲染自检开关

```
window.__DL_UI_DEBUG__ = 1   // 开 verifyLayout 断点 + 全量 ui.layout
window.__DL_TRACE_FRAMES__ = 1 // 每帧递归打印 primitives 数组
```

---

## §11 P6 实施顺序（拆批草案，每批=一个 commit+门禁）

| 批 | 内容 | 出口 |
|---|---|---|
| F1 | 基础设施：tokens.css、sizes/layout/verifyLayout、util/log、api/client、store 骨架 + persist | layout 单测 + api 单测绿 |
| F2 | 外壳 + menu + settings（含日志面板） | 四态测试 + 截图核对 |
| F3 | gacha + warehouse（含 assemble 抽屉、错误映射） | 端到端 jsdom 用例 |
| F4 | panel/loadout 界面 + battle 配置屏（B22 后接 /battle） | API 测试 |
| F5 | replay：canvas planFrame + 控制条 + HUD + 结算（golden 帧快照测试） | render 快照绿 |
| F6 | editor：Blockly blocks/bridge/main + 门控 + 实时校验 + 高亮 | bridge 往返测试 |
| F7 | AI 轨迹可视化 + 存档 export/import + 打磨（伤害跳字/震动可选） | 全流程用例 |

> 每批结束时人工做一次截图核对（保存到 `docs/screens/Px-<批>-<屏>.png` 或至少描述性核对清单），并跑 `npm run gate`（P6 起前端覆盖率并入）。

---

## §12 明确范围与后续

- 本文是**可执行设计**；实现顺序按 §11；任何与本文冲突的行为 → 先改本文再改代码（变更走 tasks §10）。
- 后端仍需配合：静态托管（§1.1）、CORS 不需要（同源）。
- 画布只在 replay 屏显示；菜单等屏用 DOM。
- `render/` 的 `planFrame` 纯函数是"能无头测试"的关键，任何绘制必须经 planFrame 产出图元后由绘制器执行——**禁止在绘制器里直接写业务判断**。