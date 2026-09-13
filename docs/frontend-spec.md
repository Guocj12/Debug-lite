# Debug-Lite v3 前端设计文档

> 版本：v1　创建：2026-09-12
> 定位：**P6 前端的唯一设计规范**。后端先行期间冻结方向（L15），**本文只设计、不实现**（`public/` 尚未创建；实现归 P6，需重新排批次）。
> 权威链：`docs/decisions.md` > `docs/interfaces.md`（API 契约）> 本文 > `docs/tasks.md` §7。
> 关联：服务器部署与端点使用见 `docs/server.md`；帧结构与数据契约见 `docs/battle-walkthrough.md` §4。

---

## 1. 技术决策（已冻结）

| 项 | 决策 | 依据 |
|---|---|---|
| 框架 | **无框架**：纯函数 `render(state) → HTML` + 自研 store + 事件委托 | D-124（用户已确认） |
| 构建 | **零构建步骤**：原生 ES 模块 scripts + CSS；不引入打包器 | 与后端零依赖哲学一致 |
| 编辑器 | Blockly（P6 引入，唯一的前端重依赖） | `v3-design` §15.5 |
| 战斗画面 | **canvas** 自绘，只消费 `frame.diff` | T-FE-4（禁止重算） |
| 状态持久 | localStorage（P6 落地），服务器无状态（D-123） | `server.md` §6 |
| 网络 | 原生 `fetch`，唯一出口 `public/js/api/` | L14/L15 |

**为什么无框架**（`examples/README` 无，这里记结论）：项目没有复杂组件状态需求（列表/表单/canvas/Blockly 编辑器）；纯函数视图可被 `node:test` 直接断言（`render(state)` 返回字符串），与门禁的单进程测试哲学一致；Blockly 自己管 DOM，无框架不会因重渲染冲掉它。

---

## 2. 屏幕与导航（7 屏）

| 屏幕 | id | 职责 | 出口 |
|---|---|---|---|
| 主菜单 | `menu` | 段位/种子/入口；四态：loading（拉 unlock/health）、error、ready、empty（无存档引导） | → editor / warehouse / gacha / battle / settings |
| AI 编辑器 | `editor` | Blockly 编辑、校验、编译、试运行 | 保存 loadout.ai |
| 仓库/装配 | `warehouse` | 分类仓库、组装/拆卸、点数/槽位/门控校验 | 保存 loadout |
| 开箱 | `gacha` | 抽箱（seed/tier/次数）、结果入仓 | 入仓库 |
| 对战 | `battle` | 发起战斗（AI vs 示例对手或双配置） | → replay |
| 回放/结算 | `replay` | 逐 tick 播放控制、AI 轨迹、胜负结算 | → menu |
| 设置 | `settings` | 种子、日志面板、存档导入/导出（localStorage 的 `export/import`） | — |

**导航唯一入口**：`store.dispatch({type:'goto', screen})`；禁止视图自行改路由/历史。

---

## 3. 状态模型（store）

### 3.1 状态形状（草案，P6 冻结）

```js
appState = {
  screen: 'menu',
  meta:  { version, serverOk, tables: [...], env: { logLevel } },
  tier:  'common',                 // 客户端权威（D-123，随请求传参）
  seed:  null,                     // 缺省由服务端生成并回带（T-AP-5）
  warehouse: { roles:[], skills:[], rolePlugins:[], skillPlugins:[] },   // 客户端权威
  loadout:  { role:null, skills:[null,null,null], ai:null },             // 客户端权威
  aiDraft:  { program:null, programHash:null, errors:[] },               // 编辑器草稿
  panel:    null,                  // 最近一次 /panel 结果（只读展示）
  gacha:    { lastBox: null, opening:false },
  battle:   { running:false, frames:[], result:null, tick:0 },
  logPrefs: { level:'debug', channels:{}, panelOpen:false },             // 本地持久
  ui: { snackbar:[], busy:false },
}
```

### 3.2 数据流（单向）

```
api/（fetch 封装，唯一网络出口）
   │ ① 请求（带 seed/tier/warehouse/loadout）
   ▼
store/（reducer 纯函数：旧 state + action → 新 state；校验失败把 error.code 变成 ui.snackbar）
   │ ② state 订阅
   ▼
views/*.render(state) → HTML 字符串（纯函数，无副作用）
   │ ③
mount/（事件委托 → dispatch）＋ render/（canvas，只消费 battle.frames[tick].diff）
```

**规则**：
- `views/*` 只读 `state`，**不调用 api、不写 DOM**；纯函数保证可测（`render(state)` 字符串断言）。
- 事件回调只做 `dispatch`；副作用集中在 `mount/` 与 `store` 的 effect 层（P6 实现时再定 effect 机制，如 dispatch 后 `await api.xxx` 再 dispatch 结果）。
- 禁止：跨视图直接改 DOM、模块级可变全局、行内样式（调试除外）、魔法数字。

### 3.3 错误 → UI 映射（依据 `server.md` §4）

| error.code | UI 表现 |
|---|---|
| `bad_tier` / `bad_level` | 设置屏表单红框 + snackbar |
| `ai_invalid` | 编辑器中按 `details[].path` 高亮积木，错误列表逐条显示 |
| `ai_too_large` | 编辑器提示超限（大小/深度/节点数） |
| `tier_locked` | 仓库/装配弹窗"段位不足"，开箱置灰 |
| `points_exceeded` / `slot_type_mismatch` / `slot_occupied` / `plugin_equipped` | 装配面板就地红框 + 原因文案 |
| `slot_empty` / `plugin_missing` | 拆卸就地提示 |
| `loadout_invalid` | 装配/出战页显示逐条 `details` |
| `unknown_table` / `unknown_endpoint` / `internal_error` | 全局错误页/重试（开发期显示 `details`） |

---

## 4. 目录与文件规划

```
public/
  index.html            # 壳：<div id="app"> + <canvas id="battle"> + <script type="module" src="js/app.js">
  css/tokens.css        # 设计令牌（§8）
  css/style.css         # 布局与组件样式（BEM 前缀 .dl-）
  js/app.js             # 启动：组装 store → views → mount → 首屏 goto
  js/api/client.js      # fetch 封装（信封解包、错误码归一、seed 回带）
  js/store/reducer.js   # 纯 reducer + 初始 state
  js/views/{menu,editor,warehouse,gacha,battle,replay,settings}.js   # render(state) → HTML
  js/mount/index.js     # 事件委托（data-action 属性 → dispatch）
  js/render/battle.js   # canvas：diff → 像素占位绘制（§6）
  js/editor/{blocks.js, bridge.js, main.js}   # Blockly（§7）
  js/util/log.js        # 前端日志门面（§9）
server/index.js         # P6：新增 app.use(express.static(public)) 与 /shared、/vendor/blockly 静态挂载
```

---

## 5. 视图契约（每个屏幕的出口检查）

每个 `views/*.js` 必须满足：

1. `render(state) → HTML 字符串`，**纯函数**（同 state 同输出；`T-FE-1`）。
2. 四态齐全：`loading / empty / error / ready`，每种都有输出且不抛错（`T-FE-2`）。
3. 数据只来自 `state`；需要服务器数据时由 store/effect 预先拉取并写入 state（`views` 不自行 fetch）。
4. 事件一律 `data-action="..."`，由 `mount/` 统一委托到 `dispatch`。
5. 每次渲染记 `view.render`(debug) 日志（屏幕 id + 四态）。
6. 每屏验收（P6）：纯函数测试 + 四态测试 + 无算法复制（静态检查 `public/**` 不引用 `server/**`，`T-FE-3`）+ 截图核对。

---

## 6. 战斗渲染层（canvas）

| 项 | 契约 |
|---|---|
| 输入 | `battle.frames[tick].diff`（**唯一输入**，`T-FE-4`） |
| 坐标 | 引擎输出 px（1px 精度），渲染按 `window.devicePixelRatio` 缩放到画布；格宽 = 64px 逻辑单位 |
| 角色 | `diff.players[].fromX/toX/fromFacing` → 本 tick 线性插值；`hpDelta` 显示伤害跳字 |
| 弹幕 | `diff.bullets[]`：`x0` 起点的 0 速 AOE、`clashAt` 碰撞火花、`hitAt` 命中特效 |
| 碰撞 | `diff.collisions[]`：`atX` 位置打出碰撞特效 |
| 基地 | `diff.bases[].hpDelta` 扣血特效与血条 |
| Buff/控制 | `diff.players[].buffs` 粒子、`defending` 金色描边 |
| 回放控制 | 播放/暂停/步进/倍速由 `store.dispatch({type:'battle/seek', tick})` 驱动；**回放严格按帧**（与引擎结果一致性测试 `T-FE-4`/`T-BT-1`） |
| 日志 | 每帧绘制记 `render.frame`(trace)（tick + diff 元素数）；`render.sprite`(trace) 单体绘制 |

---

## 7. Blockly 编辑器

| 项 | 契约 |
|---|---|
| 积木定义 | `blocks.js`：覆盖 AST 全部节点（`literal/get/bullets/var/set/getVar/arith/cmp/logic/random/if/loop/break/function/call/action/seq`） |
| 双向转换 | `bridge.js`：积木 → AST（存盘/提交）、AST → 积木（载入回显）；**往返无损**（`T-ED-1` 契约测试，P6 补入矩阵） |
| 隐式主循环 | `D-100`：外层 `while(true)` 积木**显式可见且不可删除**，置于工作区根部，程序分支持续接在后面 |
| 段位门控 | 从 `GET /api/v1/unlock?tier=` 拿 `nodes` → 工具箱**隐藏/置灰**未解锁积木 |
| 实时校验 | 监听变化 → 本地调用与 `server/ai/ast.js` 相同语义的校验（或防抖调 `POST /api/v1/ai/validate`）→ 按 `path` 高亮违规积木、列表展示 `details` |
| 试运行 | `POST /api/v1/ai/validate` + `POST /api/v1/ai/battle`（选示例对手）→ 立即进入 replay |
| 日志 | `editor.ast.encode/decode/toolbox`(debug)，trace 可高亮当前执行的积木（配合 `aiTrace`） |

---

## 8. 视觉令牌（tokens.css 草案）

```css
:root {
  --color-bg:#0e1116; --color-panel:#161b22; --color-line:#30363d;
  --color-text:#e6edf3; --color-muted:#8b949e; --color-accent:#58a6ff; --color-danger:#f85149; --color-ok:#3fb950;
  --color-q-common:#2ecc71; --color-q-rare:#3498db; --color-q-epic:#9b59b6;
  --color-q-legendary:#e67e22; --color-q-mythic:#1abc9c;   /* 品质色，与 items-data §2 一致 */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:24px; --space-6:32px; --space-7:48px; --space-8:64px;
  --font-ui:system-ui,sans-serif; --font-mono:ui-monospace,monospace;
  --radius-s:4px; --radius-m:8px; --radius-l:12px;
  --z-base:0; --z-panel:10; --z-modal:20; --z-snack:30;
}
```
- **规则**：间距只用 `--space-*`；颜色只用 `--color-*`；组件类名前缀 `.dl-`；禁止行内样式与魔法数字（审查核对）。

---

## 9. 日志面板（前端可观测性）

| 项 | 契约 |
|---|---|
| 门面 | `public/js/util/log.js` 转发到 `window.DLLog`（`shared/log.js` UMD，P6 由 `<script src="/shared/log.js">` 加载） |
| 入口 | URL `?log=trace` / `?log=bullets:trace`；`window.DL_LOG_LEVEL`；设置屏面板勾选（写入 localStorage） |
| 面板 | 显示环形缓冲（`DLLog.dump()`）最近 N 条，按级别/通道过滤；可一键 `reset()` |
| 事件登记（P6 落地，事件名已冻结） | `store.dispatch`(debug)、`store.state`(trace)、`view.render`(debug)、`render.frame`(trace)、`render.sprite`(trace)、`editor.ast.encode/decode`(debug)、`editor.toolbox`(debug) |
| 纪律 | 浏览器 console 只输出 ≥debug 且面板开启时；其余只入内存环形缓冲（T-LG-7 零成本：先 `log.on()` 再构造载荷） |

---

## 10. 每屏与后端端点的消费映射

| 屏幕 | 端点 |
|---|---|
| menu / settings | `GET /api/v1/health`、`GET /api/v1/unlock?tier=`、`GET /api/v1/log-level`、`POST /api/v1/log-level` |
| editor | `POST /api/v1/ai/validate`、`POST /api/v1/ai/compile`、`POST /api/v1/ai/battle`（试运行） |
| warehouse | `GET /api/v1/warehouse`（骨架）、`POST /api/v1/warehouse/assemble`、`POST /api/v1/warehouse/disassemble`、`GET /api/v1/data/:table`（物品图标/名称） |
| gacha | `POST /api/v1/box`（结果入本地仓库） |
| battle/replay | `POST /api/v1/ai/battle`（B16 现网）；`POST /api/v1/battle` + `GET /api/v1/replay/:id`（B22 就绪后切换为完整双配置对战） |
| panel 展示 | `POST /api/v1/panel`（entire loadout 的面板聚合） |

> 依赖 `data/:table` 的地方以 `tableNames()` 返回值为准（`server/index.js`）。

---

## 11. 前端测试策略（P6 排批次时并入 `tasks.md` 矩阵）

- 视图纯函数测试：`render(state)` 输出字符串断言（jsdom 可测 DOM 结构），四态全覆盖 → `T-FE-1/2`。
- 静态检查：`public/**` 不得引用 `server/**`、不得出现 `Math.random`、无行内样式扫描 → `T-FE-3`。
- 渲染一致性：回放渲染结果 = 按帧数据人工推演结果（T-FE-4）；与引擎黄金测试（T-BT-13）共用同一帧源。
- 桥接测试：积木↔AST 往返无损（T-ED-1）。
- 日志：每次绘制有 `render.frame`（T-LG-10）。

---

## 12. 明确范围

- 本文是**设计规范**，不是已交付实现；`public/` 尚未创建。
- 前端实现归 P6，需按 `docs/tasks.md` §6 重新排批次（Blockly 编辑器、仓库/装配/开箱 UI、对战回放、HUD、AI 轨迹可视化、日志面板）。
- 编辑器/仓库/装配等 UI 的交互细节（拖拽、气泡、键盘）在设计定稿时补充到本文件，**实现前必须过一遍 §5 的出口检查**。