# Debug-Lite v3 前端设计（可玩优先 · 实现级）

> ⚠️ **2026-09-16 影响通告（D-129…D-136，尚未同步进本文）**：服务端已新增**账号与会话（Bearer token）**、**服务端档案**（配置槽 ≤3、唯一出战、必有出战、段位/积分/战绩服务端权威）、**异步排位双向记账**（防守方离线也产生战绩，需新增"我的防守战绩"入口）、**快速对战积分（非对称 Elo）**、**回放参与者鉴权与 `410 replay_expired`**。
> 本文中"仓库/配置由 localStorage 权威"的表述**仍然成立**（D-130 混合权威），但**段位/积分不再是前端权威**，且新增 `GET /me` 启动拉取、token 存储与刷新、登录/注册屏。
> 待同步章节与新增屏清单见 `docs/systems/11-account-store.md` 附录 B；在同步完成前，**不要按本文实现账号/段位/积分/战绩相关界面**。
>
> **⚠️ 缺口清单（全部「未设计 · 待用户手动设计」，依据 `docs/systems/11-account-store.md` 附录 B；本文与 `docs/screens.md` 均不含这些屏的设计，禁止代为设计）**：
>
> | # | 缺口 | 缺口内容（现状 = 完全没有） | 依据 |
> |---|---|---|---|
> | G1 | **账号/登录注册屏** | 无登录、注册、改密、登出界面；`/auth/register|login|logout|password` 已存在但前端无入口 | 附录 B / D-129 |
> | G2 | **我的战绩** | 无战斗记录列表（`GET /me/records`）、无未读游标（`POST /me/records/seen`）界面 | 附录 B / D-134 |
> | G3 | **防守战绩** | 无"被抽取方"战绩入口（`GET /me/defense`；防守方离线也产生战绩） | 附录 B / D-132 |
> | G4 | **排行榜** | 无积分排行界面（服务端索引已预留 `leaderboard`） | 附录 B / D-133 |
> | G5 | **配置槽管理** | 无 ≤3 套配置槽的创建/改名/删除/切换出战界面（`/me/configs*`） | 附录 B / D-131 |
> | G6 | **Bearer token 存储与刷新** | 本文只有单机 `api/client.js`（无鉴权头、无 401 处理、无 token 持久化/刷新流程） | 附录 B / D-129 |
> | G7 | **`GET /me` 启动拉取** | 本文 §1.4 启动流程只 `GET /health` + `GET /unlock`，未拉取服务端档案（段位/积分/战绩/未读） | 附录 B / D-131 |
> | G8 | **回放 `403/410`** | 本文 §6.6 只列 404 `unknown_replay`；未覆盖参与者鉴权 `403 replay_forbidden` 与 `410 replay_expired` | 附录 B / D-135 |
>
> 以上 8 项**一律待用户手动设计**（本文只登记缺口，不新增屏、不定布局、不定按钮）。

> 版本：**v3（重设计）**　创建：2026-09-15　上次前端两轮（F0–F8 / R0–R7）均落地失败，本文是**第三次也是唯一一次前端依据**。
> 权威链：`docs/decisions.md` > `docs/interfaces.md`（API 契约）> 本文 > `docs/tasks.md` §7。
> 数据来源：本文所有字段名/响应形状**逐字取自实跑响应**（`.audit/fe-samples.js` 探针，58 个样本落盘 `.audit/fe-samples.json`），不是散文描述。

---

## §0 前两轮失败根因（本文的每一条设计都对应一条根因）

| # | 现象（审查实证） | 根因 | 本文对策 |
|---|---|---|---|
| R1 | 浏览器里**所有屏的盒子堆在左上角**，回放画布不可见 | 旧规范要求"坐标由 JS 注入 `.dl-box` 的 `position:left/top`"，而实现里这段注入从未存在（`style.css` 注释声明、全仓无代码） | **废弃 Box/坐标模型**：布局一律走浏览器自身（块流 + flex/grid）→ §3 |
| R2 | 文字压文字、按钮被遮挡、点不到 | 绝对坐标 + 固定尺寸常量（168×108 卡片、56 行高）与实际文本长度不符，靠人肉算坐标 | 位置由 CSS 决定，**只在战斗场一处用绝对定位**（战场内元素本身就是像素语义）→ §3.2/§8 |
| R3 | 回放屏"进入即弹结算遮罩"，控制条全程不可点 | 结算弹窗条件写成"result 存在"（而 result 在 `battle/loaded` 时就恒有值） | 每个弹层/控件的显示条件写成**状态机判定式**，逐条列出 → §11 |
| R4 | 「暂停」是死按钮（点不动） | UI 里写 `data-action="replay/pause"`，effect 表与 reducer 里都没有这个键 | **按钮唯一 ID + 动作白名单 + 机器自检**（每个按钮必须命中动作表，缺一即失败）→ §5.3 |
| R5 | aiTrace 右栏每行空白 | 渲染读 `t.name / t.type`，真实帧字段是 `{path,nodeType,result}` | 字段名全部来自实跑样本，并有自检器核对 → §6、附录 A |
| R6 | 文档写 `diff.players[]`（数组）与 `actor:'p1'`，实现是 `players:{p1,p2}` 对象 | 规范用散文描述结构，没人核对 | 附录 A 给**逐字段真实样本**；`scripts/fe-spec-check.js` 逐字段存在性校验 → §14 |
| R7 | 玩不下去：开箱→装配→出战→对战链路断 | 旧规范按"屏"组织，没有端到端剧本与前置数据条件（装配点数为负、loadout 恒缺 3 技能） | **主线剧本 + 每屏"空/缺前置"引导按钮** → §2.2、§10 |
| R8 | AI 编辑器是最大故障源（Blockly bridge 方言、预置积木、门控、高亮两轮都错） | 唯一不可测的第三方 DOM + 双向映射 | **改为纯 DOM 表单式 AST 编辑器**（无第三方依赖、可无头测）→ §12 |

**三条不可违反的工程纪律**（写在最前面）：

1. **单一网络出口**：只有 `public/js/api/client.js` 能调用 `fetch`。
2. **单一 DOM 写入点**：只有 `public/js/mount/index.js` 能写 `innerHTML` / 创建元素；视图层只产出"节点描述数组"。
3. **点击永不无声**：每个 `data-action` 必须在动作表里有 reducer 分支；副作用失败必须落到一个可见提示。存在性由自检器强制。

---

## §1 范围与交付物

### 1.1 七屏

`menu`（主菜单）· `gacha`（开箱）· `warehouse`（仓库/装配/出战）· `editor`（AI 编辑器）· `battle`（对战配置 + 排位）· `replay`（回放/结算）· `settings`（存档/种子/日志/关于）

屏幕切换只允许：`dispatch({type:'goto', screen})`（顶栏与屏内菜单按钮），或副作用收尾时由 effect 层派发（例：起战成功后 `goto replay`）。

### 1.2 目录与文件（一次到位，不留"以后再说"）

```public
public/
  index.html                 骨架（#dl-root + 顶栏 + 屏容器 + toast 容器）
  css/tokens.css             颜色/间距/字号令牌 + 战场/角色/弹幕等纯视觉类
  css/app.css                布局（块流/flex/grid）、组件（按钮/卡片/表格/弹窗）
  js/app.js                  启动装配（唯一 bootstrap）
  js/api/client.js           唯一 network 出口 + 错误归一
  js/store/reducer.js        纯函数 reducer（唯一状态变更入口）
  js/store/effects.js        副作用表（async，按动作名索引）
  js/store/persist.js        localStorage 读写 + 版本迁移
  js/store/selectors.js      派生数据（仓库索引、loadout 校验、战场快照重建）
  js/views/actions.js        【生成物】动作白名单 + 按钮表（从 §15 注册表逐字照抄）
  js/views/shell.js          顶栏/状态条/toast 宿主
  js/views/*.js              七屏视图（纯函数：state → 节点描述数组）
  js/render/battle.js        战场绘制（唯一绝对定位处）
  js/mount/index.js          唯一 DOM 写入点 + 事件委托
  js/editor/nodes.js         16 类 AST 节点的表单元数据（标签/字段/枚举）
  js/util/log.js             DLLog 接线（已注册通道）+ ui 层级日志辅助
  js/util/format.js          数字/品质/段位/cost 文案
tests/frontend/              前端测试（§17）
```

- **服务端需新增静态托管**（唯一后端改动，见 §16）：`GET /`、`/index.html`、`/css/*`、`/js/*`、`/shared/*`、`/assets/*` → 读文件返回，`/api/v1` 优先级最高。
- 清单里的 `tests/frontend/` 不属 `public/`；`actions.js` 是**由 §15 注册表逐字照抄**的常量文件（自检器 C9 比对实现）。

### 1.3 index.html 骨架（逐字可用）

```html
<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Debug-Lite v3</title>
<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app.css">
<script src="/shared/log.js"></script></head>
<body>
  <header id="dl-topbar"></header>
  <main id="dl-screen"></main>
  <div id="dl-toasts" aria-live="polite"></div>
  <script type="module" src="/js/app.js"></script>
</body></html>
```

- 顶栏与屏容器是**两个固定宿主**，`paint()` 只重建 `#dl-screen` 与 `#dl-toasts`，顶栏由 `paintTopbar()` 单独更新（避免重挂导致输入框失焦）。
- 无 canvas 固定骨架：战场 DOM 由 replay 视图产出（§8），离屏时随 `#dl-screen` 一起消失。

### 1.4 启动流程（`app.js`，顺序固定）

```
1. DLLog 就绪 → util/log.js 按 URL ?log= 与 localStorage.dl.logPrefs 设级别（缺省 debug，channel render=trace）
2. api/client.js 建立（base='/api/v1'，超时 8s；/battle 与 /ai/battle 用 120s）
3. persist.load() → 初始 state（版本不符 → 用默认 state + toast「存档已重置」）
4. mount.mountApp({root, store, api, log}) → 事件委托就绪 → dispatch({type:'goto',screen:'menu'})
5. boot()：GET /health → meta.serverOk；GET /unlock?tier=<state.tier> → meta.unlock
   失败 → meta.serverOk=false（顶栏红点 + 各屏"重试"按钮走 btn_retry_boot）
6. log.info('store','store.boot', …)
```

---

## §2 玩法主线（先把"能玩"钉死）

### 2.1 端到端剧本（每次改前端后手工过一遍，§17 有对应的机器/人工验收）

| 步 | 屏幕 | 操作 | 期望（可观察） |
|---|---|---|---|
| 1 | menu | 点「开箱」 | 进 gacha，段位下拉默认 `common`，次数 `10` |
| 2 | gacha | 点「开箱 ×10」 | 按钮变「开箱中…」禁用；出现 10 张结果卡（品质色边）→ toast「获得 10 件」；仓库计数 +10 |
| 3 | warehouse | 点「角色」页签 → 点一张角色卡 | 右栏显示五维/槽位表；`出战` 按钮可用 |
| 4 | warehouse | 点「出战」 | toast「已出战：<角色名>」；顶部出战栏出现角色；`技能` 页签两两重复 3 次点「出战」→ 3 格填满 |
| 5 | warehouse | 点角色卡 → 点槽位行「装配」→ 抽屉里点一个候选 | 槽位显示插件名；点数条 `已用/上限` 增加；**超预算时该候选禁用并显示原因** |
| 6 | warehouse | 点「查看面板」 | 右栏出现五维/regen/special 与 3 个技能参数（来自 `POST /panel`） |
| 7 | editor | 点「预设：稳健」→「应用到出战配置」 | 程序 JSON 出现在左栏；点「校验」显示 `校验通过`；错误时错误列表逐行可点 |
| 8 | menu | 点「快速对战」 | 进 battle（若 loadout 不合法 → toast 指出缺什么，并给「去仓库」按钮） |
| 9 | battle | 点「开始对战」 | 进 replay；HUD 显示双方血条/资源/基地；`▶ 播放` 可点 |
| 10 | replay | 点「▶ 播放」 | 角色按帧移动；`tick 7/23` 前进；播到末帧自动暂停并弹结算 |
| 11 | replay | 点「×1」→「×4」 | 播放速度变化（间隔 1000/500/250ms） |
| 12 | replay | 点「返回菜单」 | 回 menu；顶栏段位/种子保持 |
| 13 | battle | 点「开始排位（10 场）」 | 结果表 10 行 + 胜/平/负/无效计数；胜 ≥7 时显示晋升按钮 |
| 14 | settings | 点「导出存档」 | 下载 `dl-save-<ts>.json`；「导入存档」选回该文件 → toast「存档已导入」且仓库/出战恢复 |

### 2.2 断链保护（R7 的对策，逐条实现）

| 断点 | 处理 |
|---|---|
| 仓库为空 | warehouse/gacha/editor/battle 四屏都显示「仓库为空 → 去开箱」（`btn_go_gacha`） |
| 没有角色物品 | battle 屏「开始对战」禁用 + 文案「缺少角色物品」+「去仓库」按钮 |
| 技能不足 3 件 | battle 禁用 + 文案「技能 0/3」+「去仓库」 |
| 没有 AI 程序 | battle 禁用 + 文案「未设置 AI 程序」+「去编辑器」；编辑器首屏预填「预设：稳健」 |
| 段位不足（开箱 `tier_locked`/装配 `tier_locked`） | toast 原文 + 顶栏段位下拉高亮提示 |
| 后端未启动 | 每屏顶部红条「无法连接服务器」+「重试」按钮 |
| 装配点数超限 | 候选按钮禁用 + 行内原因「需 3 点，剩 1 点」，不依赖 toast |

---

## §3 布局与样式（简单但不会坏）

### 3.1 规则

1. **不用坐标**：没有任何 `layout(state) → Box[]`、没有 `data-box`、没有 JS 写 `style.left/top`。位置全部由正常文档流与 flex/grid 决定。
2. **固定槽位尺寸只在需要的三处**：按钮 `min-width:96px;height:36px`、卡片 `width:200px;min-height:96px`、战场 `width:1024px;height:128px`（比例容器，见 §8.1）。其余自适应。
3. **文字不裁不叠**：卡片/行/表格用 `overflow-wrap:anywhere`；列表用 `display:flex;gap`。任何"文字压文字"都视为回归缺陷。
4. **视觉令牌**（`tokens.css`）：颜色只允许用令牌，类名前缀 `dl-`；禁止行内 `style="..."`（唯一例外：战场内元素与进度条宽度，见 §8.3）。
5. **四态齐全**：每屏必须实现 `loading`（请求中骨架文本）/`empty`（空数据 + 引导按钮）/`error`（错误文本 + 重试）/`ready`。

```css tokens
:root{
  --bg:#0e1116; --panel:#161b22; --line:#30363d; --text:#e6edf3; --muted:#8b949e;
  --accent:#58a6ff; --ok:#3fb950; --danger:#f85149; --warn:#d29922; --hit:#f0883e;
  --q-common:#2ecc71; --q-rare:#3498db; --q-epic:#9b59b6; --q-legendary:#e67e22; --q-mythic:#1abc9c;
  --p1:#58a6ff; --p2:#f85149;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px; --sp-6:32px;
  --fs-xs:12px; --fs-s:13px; --fs-m:15px; --fs-l:18px; --fs-xl:24px;
  --radius:6px; --field-w:1024px; --field-h:128px; --cell:64px;
}
```
- 品质色令牌必须与 `server/data/qualities.json` 的 `color` 逐值一致（自检器 C6 强制）；`--field-w/--field-h/--cell` 的数值取自 `/data/battle-config`（`fieldPx/cellPx`），JS 侧不得另写一份（§8.1 允许的内联像素样式读这两个令牌）。

### 3.2 屏级骨架（所有屏同一套，杜绝各屏自创坐标）

```
#dl-topbar   [Logo] [段位▾] [种子] [快速对战] [设置] [仓库 n]      —— 常驻，任何屏可点
#dl-screen
  └ .dl-page
      ├ .dl-page-head   标题 + 一句话说明 + （可选）返回按钮
      ├ .dl-banner      错误/警告条（后端不可用、缺前置数据）
      └ .dl-cols        两栏或三栏 flex：.dl-col（min-width:0，可滚动）
```

- 三栏屏（warehouse/editor）在 <1100px 时降级为纵向堆叠（`flex-wrap:wrap`），不追求移动端完美。
- toast：`#dl-toasts` 固定右上，`position:fixed`（唯一的 fixed 定位），3s 自动消失。

### 3.3 组件清单（只允许这些，避免每个屏各写一套）

| 组件 | 标记 | 必备属性 |
|---|---|---|
| 按钮 | `button.dl-btn` | `data-action`（必填）、`data-id`（唯一，§5.3）、`disabled` 可选 |
| 主按钮/危险按钮 | `+ .dl-primary` / `.dl-danger` | — |
| 卡片 | `div.dl-card` | `data-action` + `data-id`；内含品质色条 `.dl-q-<quality>` |
| 行 | `div.dl-row` | 左文本 + 右控件；用于槽位行/列表行 |
| 表格 | `table.dl-table` | 排位结果、日志面板 |
| 弹窗 | `div.dl-modal` + `.dl-modal-mask` | 只在 §11 列出的条件成立时渲染；必带关闭按钮 |
| 输入 | `input.dl-input` / `select.dl-select` | `data-action` + `data-id`；**必须实现 change 委托** |
| 状态点 | `span.dl-dot` | 后端在线/离线、段位锁定提示 |
| 日志行 | `div.dl-logline` | 级别 + 通道 + 事件 + 摘要 |

---

## §4 状态模型

### 4.1 完整 state（唯一状态源）

```js
{
  screen: 'menu',                    // 七屏之一
  meta: {
    serverOk: true, version: '3.0.0',        // /health
    unlock: null,                            // /unlock?tier= 的 data（nodes/roleTemplates/skills/plugins）
    tables: {},                              // /data/:table 缓存（qualities/skill-templates/…）
  },
  tier: 'common',                    // 玩家段位（持久化；决定开箱品质上限、物品门控）
  seed: '',                          // 空串 = 让服务端生成并回带；否则整数
  warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
  loadout: { role: null, skills: [null, null, null], ai: null },   // 形状 = 后端 loadout（引用物品对象本体）
  panel: null,                       // POST /panel 的 data.panel（只读展示）
  selected: { warehouseUid: null, gachaIndex: null },
  editor: {
    program: null,                   // 当前编辑中的 AST（version=2）
    draft: null,                     // 上一次 /ai/validate 的 details 数组
    validateState: 'idle',           // idle | checking | ok | invalid | error
    compile: null,                   // /ai/compile 的 data（programHash/stats）
    applyState: 'idle',              // idle | applied
  },
  battle: {
    mode: 'ai',                      // 'ai'（/ai/battle，示例对手）| 'duel'（/battle，完整双方）
    opponent: 'kiter',               // 'kiter' | 'charger'（后端 OPPONENTS 全集）
    frames: [], tick: 0, playing: false, speed: 1,
    summary: null,                   // {id?, seed, winner, phase, ticks, programHash?}
    running: 'idle',                 // idle | requesting | error
    errorText: '',
  },
  ranked: { wins: 0, running: 'idle', result: null, promote: null },
  gacha: { tier: 'common', times: 10, running: 'idle', results: [] },
  logPrefs: { level: 'debug', channels: { render: 'trace' }, filter: '' },
  ui: { busy: false, toasts: [], modal: null },   // modal: null | 'assemble' | null（结算不在此列，见 §11）
}
```

### 4.2 不变量（reducer 每次返回前必须成立；测试直接断言）

1. `loadout.skills.length === 3`（不足补 `null`）。
2. `loadout.role` / `loadout.skills[i]` 若是对象，则**必须与 `warehouse.buckets` 中的同 `uid` 对象内容一致**（出战引用从仓库取，禁止复制改数值）。
3. `warehouse.buckets` 四键恒存在（即使为空数组）。
4. `battle.tick ∈ [0, max(0, frames.length-1)]`；`frames` 变化时立即 clamp。
5. `battle.playing === true` 时必有 `frames.length > 0`。
6. `gacha.times ∈ [1,100]`（后端上限 `BOX_TIMES_MAX=100`）。
7. `tier ∈ ['common','rare','epic','legendary','mythic']`。

### 4.3 持久化（`dl.v3.save`，schemaVersion 1）

只落盘：`{schemaVersion, tier, seed, warehouse, loadout, logPrefs}`。**不落盘**：`frames/panel/editor/ranked/gacha/ui`（含 `battle.playing`）。导入时缺字段 → 拒绝并 toast `bad_save`；`schemaVersion` 不符 → 尝试迁移，无迁移则丢弃 + toast（`store.load` warn）。

---

## §5 交互层：按钮、动作、事件委托

### 5.1 事件委托（`mount/index.js`，唯一实现）

```
click  → 向上找最近的 [data-action] → {type, ...dataset} → dispatch
change → 同上；再按控件类型补值：
         input[type=range]  → {[data-value-key]: Number(value)}
         input[type=number] → {[data-value-key]: Number(value)}
         input[type=text]   → {[data-value-key]: value}（空串按 '' 传，交由 reducer 归一）
         input[type=file]   → 读 FileReader 文本 → {text}
         select             → {[data-value-key]: value}
```

规则：`data-action` 缺失的可点元素**不允许存在**（自检器扫描视图源码）；`payload` 一律走 `data-*` 扁平字段，不用 JSON 字符串（旧实现 `JSON.parse(dataset.payload)` 是错误高发点）。

### 5.2 动作白名单（唯一真相：本节 + §15 注册表，二者由自检器比对）

| 动作 | 载荷 | reducer | 副作用（effects 表） |
|---|---|---|---|
| `goto` | `screen` | 切屏、清 `ui.modal` | 离屏清理（见 §5.5） |
| `retry_boot` | — | `meta.serverOk=null` | `boot()` 重跑 |
| `tier/set` | `tier` | 写 `tier` | `GET /unlock`；持久化 |
| `seed/set` | `seed` | 归一并写 `seed`（`''` 合法） | 持久化 |
| `seed/random` | — | — | 写 `seed = 1..2147483647` 随机整数（UI 层 `Math.random` 允许，非战斗逻辑） |
| `gacha/tier` | `tier` | 写 `gacha.tier` | — |
| `gacha/times` | `times` | clamp 1..100 | — |
| `gacha/roll` | — | `running='requesting'` | `POST /box`（见 §10.2） |
| `gacha/select` | `index` | 写 `selected.gachaIndex` | — |
| `wh/select` | `uid` | 写 `selected.warehouseUid` | 拉 `panel`（若已填满则刷新） |
| `loadout/equip` | `uid` | 按 `kind` 填角色位或第一个空技能位 | 持久化 + `panel` 刷新 + toast |
| `loadout/unequip` | `slot`（`role` 或 `0/1/2`） | 清位 | 持久化 + `panel` 刷新 |
| `modal/open` | `modal` | 写 `ui.modal` | — |
| `modal/close` | — | `ui.modal=null` | — |
| `assembly/run` | `targetUid, pluginUid, slotIndex` | 保持 busy | `POST /warehouse/assemble`（§10.3） |
| `assembly/take` | `targetUid, slotIndex` | 保持 busy | `POST /warehouse/disassemble` |
| `panel/refresh` | — | `panel=null` | `POST /panel` |
| `editor/set` | `path, field, value` | 改 `editor.program` 对应节点字段 | debounce 400ms → `/ai/validate` |
| `editor/add` | `path, index, nodeType` | 在 seq 指定位置插入新节点 | 同上 |
| `editor/remove` | `path` | 删除节点 | 同上 |
| `editor/preset` | `preset` | 覆盖 `editor.program` | 立即 `/ai/validate` |
| `editor/json` | `text` | 解析 JSON → `editor.program`（失败 → toast） | 同上 |
| `editor/validate` | — | `validateState='checking'` | `/ai/validate` |
| `editor/compile` | — | — | `/ai/compile` → `editor.compile` |
| `editor/apply` | — | `loadout.ai = editor.program` | 持久化 + toast「已应用到出战配置」 |
| `battle/mode` | `mode` | 写 `battle.mode` | — |
| `battle/opponent` | `opponent` | 写 `battle.opponent` | — |
| `battle/run` | — | `running='requesting'` | 起战（§10.5）→ 成功 `goto replay` |
| `battle/clear` | — | 清 frames/summary/tick | — |
| `replay/play` | — | `playing=true` | 启动定时器 |
| `replay/pause` | — | `playing=false` | 清定时器 |
| `replay/step` | `delta`（+1/-1） | `tick=clamp(tick+delta)` | 暂停播放 |
| `replay/speed` | `speed`（1/2/4） | 写 `speed` | 若在播放则按新间隔重启 |
| `replay/seek` | `tick` | 写 `tick` | 暂停播放 |
| `ranked/run` | — | `ranked.running='requesting'` | `POST /ranked/run` |
| `ranked/promote` | — | — | `POST /ranked/promote`（§10.6） |
| `save/export` | — | — | 下载存档 |
| `save/import` | `text` | — | 校验并写入（§4.3） |
| `save/reset` | — | 重置为默认 state | 清 localStorage + toast |
| `settings/log-level` | `level` | 写 `logPrefs.level` | `DLLog.setLevel` + 持久化 |
| `settings/log-channel` | `channel, level` | 写 `logPrefs.channels[channel]` | `DLLog.setChannelLevel` |
| `settings/log-filter` | `text` | 写 `logPrefs.filter` | — |
| `log/export` | — | — | 导出 `DLLog.dump()` JSON |
| `log/clear` | — | — | `DLLog.reset()` |
| `toast/close` | `id` | 移除该 toast | — |

**禁止的动作名**（旧实现踩过的坑）：`replay/pause` 之外的任何"UI 里出现但表里没有"的名字由自检器直接判失败（§14）。

### 5.3 按钮唯一 ID 规则

`data-id` 全局唯一，格式 `<屏/域>_<语义>[_<后缀>]`，后缀用于列表项：`btn_wh_equip_<uid>`、`btn_asm_pick_<uid>`。
- 卡片/列表项这类重复元素，ID 必须带 uid，事件读取 `data-uid` 而不是解析 ID。
- 自检器要求：同一屏内 `data-id` 不重复；每个可见按钮/可点元素都有 `data-action`。

### 5.4 统一错误处理（不让任何请求失败静默）

`api/client.js` 把任何失败归一为 `{ok:false, code, message, details, status}`：

| 情形 | code | UI 行为 |
|---|---|---|
| `fetch` 抛错 / 网络不可达 | `network` | toast「无法连接服务器（重试）」+ `meta.serverOk=false` + 顶栏红点 |
| AbortController 超时 | `timeout` | toast「请求超时」；按钮恢复可点 |
| HTTP 200 但 `ok:false` | 后端 code 原文 | toast 原文 message；错误码写入日志 |
| HTTP 4xx/5xx | 后端 code 原文 | 同上；`loadout_invalid`/`ai_invalid` 的 `details` 逐条上屏（不截断到 1 条） |
| JSON 解析失败 | `protocol` | toast「响应格式异常」+ `api.err` 日志（含原始文本前 200 字符） |

业务错误的**文案映射**（`util/format.js`，只做中文补充，不改 code）：`tier_locked`→「段位不足」、`points_exceeded`→「插槽点数超限」、`slot_type_mismatch`→「插件与实际插槽类型不符」、`slot_occupied`→「该插槽已装配」、`plugin_equipped`→「该插件已装在别处」、`item_missing`→「物品不在仓库」、`slot_empty`→「该插槽为空」、`plugin_missing`→「插件缺失（存档可能损坏）」、`already_max`→「已是最高段位」、`no_loadout`→「请先装配出战配置」。

### 5.5 离屏清理（R3 的同类根因）

`goto` 的 effect 统一执行：停播放定时器（`playing=false`）、清 `ui.modal`、清屏内瞬态（`gacha.running/editor.validateState/battle.running`）、保留 `frames` 与 `summary`（允许从 battle 屏"查看上一次回放"）。

---

## §6 数据契约速查（字段名全部经实跑核对）

> 完整样本见 **附录 A**；`.audit/fe-samples.json` 是机器可读版。

### 6.1 `/api/v1/unlock?tier=<t>`
`{ok, data:{tier, nodes:[string], roleTemplates:[id], skills:[id], plugins:[id]}, log}`
- `nodes` 是**累计可用**节点类型（§12 用它过滤编辑器节点菜单）：`common→[…,'if']`，`rare→['loop','while','break']`，`epic→['random','logic','arith_ext']`，`legendary→[]`，`mythic→['function','call']`。
- ✅ **口径已收口（B4，2026-09-16）**：`nodes` **只含真实节点类型**——`unlock.json` 的 `aiNodes[]`（权限名）经 `nodePermissions` 展开后返回：`while` 折叠为 `loop`、`arith_ext`（`implemented:false`）不授予任何节点，故二者**不会**出现在 `nodes` 里，编辑器**无需**再自行过滤别名。`ai/ast.js` 白名单共 **16 类**，`mythic` 下 `nodes` 即这 **16 类**（累计 10/12/14/14/16）。注意 `.audit/fe-samples.json` 里的 `unlock_*` 样本是**收口前**抓取的（仍含 `bullets`/`while`/`arith_ext`），需重跑 `node .audit/fe-samples.js` 刷新。
- 注意：`nodes` 里出现的是 `loop`（`while` 是它 `kind` 的取值，不是独立节点）；编辑器循环控件用 `kind:'count'|'while'` 覆盖二者（§12.3）。

### 6.2 `/api/v1/box`（POST `{seed?, tier, times}`）
`{ok, data:{seed, tier, times, items:[item]}}`；`items` 是**平铺数组**（不分桶），前端按 `kind` 入桶。
`item` 三种形状（实跑样本）：

```jsonc
// 角色
{"uid":"item_demo_role","kind":"role","templateId":"role_bal","name":"均衡","quality":"rare",
 "slotCount":2,"slots":[{"type":"atk","pluginUid":null},{"type":"special","pluginUid":null}],
 "stats":{"hp":100,"atk":10,"def":8,"sp":60,"mp":40},"regen":{"mp":1,"sp":2},
 "unlockTier":"common","pluginPoints":4}
// 技能
{"uid":"item_4","kind":"skill","templateId":"skill_straight_poison","name":"毒瓶","quality":"epic",
 "slotCount":3,"slots":[{"type":"basic","pluginUid":null}, …],
 "params":{"multiplier":0.63,"cost":{"hp":0,"mp":6,"sp":0},"cooldown":5,"bulletLevel":4,
           "range":6,"bulletCount":1,"falloff":0},"unlockTier":"epic"}
// 插件（角色/技能同构，kind 区分；注意用 id 不是 templateId）
{"uid":"item_9","kind":"rolePlugin","id":"rp_atk_pct","name":"攻击提升·百分比","desc":"…",
 "slot":"atk","category":"攻击提升","quality":"rare","tier":3,
 "affixes":[{"id":"atk_pct","desc":"攻击 +8%…","params":{"v":0.1}}],"pointCost":3,"equipped":true}
```
- `equipped` **只在装配后出现**（未装配的插件没有该字段）；判定用 `p.equipped === true`，不要用真值判断。
- 展示名一律 `item.name`（实跑确认存在）；`item.templateId || item.id` 只作降级。

### 6.3 `/api/v1/warehouse` 与装配/拆卸
- `GET` → `{ok,data:{buckets:{role:[],skill:[],rolePlugin:[],skillPlugin:[]}}}`（空骨架；仓库真实内容在前端手里）。
- `POST /warehouse/assemble` body `{warehouse, targetUid, pluginUid, slotIndex, tier?}` → `{ok,data:{warehouse}}`；失败 `{ok:false,error:{code,message,details:[]}}`，code ∈ `slot_type_mismatch|points_exceeded|slot_occupied|tier_locked|plugin_equipped|item_missing`。
- `POST /warehouse/disassemble` body `{warehouse, targetUid, slotIndex}` → 同上；失败 code ∈ `slot_empty|plugin_missing`（HTTP 404）。
- **成功响应整体替换 `state.warehouse`**（响应是克隆后的新仓库，直接采用，不做本地补丁）。
- 后端校验顺序（前端候选预过滤要对齐，避免"点得动但必失败"）：目标存在 → 类别匹配 → 插槽存在且类型匹配 → 段位门控 → 点数预算（仅角色目标） → 插槽为空 → 插件未被别处装配。

### 6.4 `/api/v1/loadout` 与 `/api/v1/panel`
- `GET /loadout` → `{ok,data:{loadout:{role:null,skills:[null,null,null],ai:null}}}`（规范骨架）。
- `POST /loadout` body `{loadout, warehouse?, tier?}` → 通过则 `{ok,data:{loadout}}`；失败 409 `{code:'loadout_invalid',message,details:[{where,code,message}]}`。
- `POST /panel` body 同上 → `{ok,data:{panel:{role:{stats,special,regen,pluginPoints,quality},skills:[{templateId,uid,params}]}}}`；失败同上。
- 校验要点（前端在"出战/起战"前本地预检，再让后端定案）：角色 1 件 + 技能**恰 3 件** + `ai` 存在；含插件引用时必须带 `warehouse`（否则 `missing_warehouse`）；同一插件不得被两处引用；物品与插件须满足 `unlockTier ≤ tier`。

### 6.5 `/api/v1/ai/validate|compile|battle`
- `validate` body `{program|ai, tier?}` → 200 `{ok:true,data:{ok:true}}`；400 `{code:'ai_invalid',details:[{path,code,message}]}`（**path 形如 `body.s[0].body.s[0].else`**，编辑器用它定位节点）。
- `compile` body `{program}` → `{ok:true,data:{programHash, version, migrated, stats:{nodes,depth,usedNodeTypes}}}`（不查合法性/门控）。
- `ai/battle` body `{program, seed?, tier?, opponent?}`（`opponent` 默认 `kiter`，全集 `kiter|charger`）→
  `{ok,data:{seed, programHash, winner, phase, ticks, frames:[{tick,players,collision,bulletHits,verdict,aiTrace}]}}`
  - **注意**：该端点用**基准面板**（无 loadout、无技能实例），所以程序里的 `skill:skillN` 会落成无效行动（引擎归一化为 `wait`）。前端用它做「语法/门控/流程」演练时必须在界面上写明这一点（§10.5）。

### 6.6 `/api/v1/battle` 与 `/api/v1/replay/:id`
- `POST /battle` body `{p1, p2, warehouse?, seed?, tier?}`（`p1/p2` 是完整 loadout 对象）→ 200：
  `{ok,data:{id:'r1', seed, tier, winner:'p1'|'p2'|'draw', phase:'role'|'base'|null, ticks, frames:[frame]}}`
- `GET /replay/:id?from=&to=`（1-based 含端）→ `{ok,data:{id,seed,winner,phase,ticks,frames}}`；未知 id → 404 `unknown_replay`。
- 失败：409 `loadout_invalid`（`details` 逐条）/ 400 `bad_seed` / 400 `bad_tier`。

### 6.7 `/api/v1/ranked/run|promote`
- `run` body `{loadout, warehouse?, pool?, seed?, tier?}` → `{ok,data:{tier, seed, matches:10, wins, draws, losses, invalids, promoted, results:[{match,winner,ticks}]}}`；缺 loadout → 409 `no_loadout`。
  - `winner ∈ 'p1'|'p2'|'draw'|'invalid'`（`invalid` 计入 `invalids`，不计胜负）。
- `promote` body `{tier, wins}` → `{ok,data:{tier, promoted, reward, wins}}`；wins ≤ 6 → `promoted:false`；顶段位 + wins>6 → 409 `already_max`；`wins` 必须 ≤ 10（`bad_wins`）。

### 6.8 帧（回放唯一输入，自足）

```jsonc
{"tick":1,"diff":{
  "players":{"p1":{"fromX":224,"toX":224,"facing":1,"hp":100,"mp":35,"sp":60},
             "p2":{"fromX":800,"toX":736,"facing":-1,"hp":100,"mp":40,"sp":60}},
  "bullets":[{"uid":"b_0","owner":"p1","type":"straight","level":4,"dir":1,"x":224,"len":384,"v":384}],
  "bases":{"p1":{"hp":100,"def":64},"p2":{"hp":100,"def":64}},
  "events":[{…日志记录，含 cid/tick/level/channel/event/msg/data…}],
  "aiTrace":[{"tick":1,"owner":"p1","seq":0,"path":"body.s[0]","nodeType":"action","phase":"eval","depth":1,"result":"skill:skill1"}],
  "collision":{"contactX":256,"t":0},          // 无碰撞 → null
  "bulletHits":[{"uid":"b_0","target":"p2","atX":736}],   // 无命中 → []
  "verdict":{"winner":"p1","phase":"role"}     // 未结束 → null
}}
```

关键约定（**逐条都有实跑证据**）：
- `players` 是**对象** `{p1,p2}`，不是数组；没有 `actor` 字段。坐标是 `fromX/toX`（本 tick 起点/终点，1px 整数）。
- `bullets[].x` 是**起点 x**，`len` 是带符号长度（方向 = `dir`）：区间 = `[x, x+len]`（`len` 为负则反向）；`v` 是速度（px/tick）。
- `hp/mp/sp` 是该 tick **结束后**的值；资源上限要自己从首帧或 loadout 面板取（帧里没有 `maxHp`）。
- `collision.contactX` 是碰撞位置；`bulletHits[].atX` 是命中位置。
- `verdict` 只在结束帧出现（`winner='draw'` 也可能）。
- `events[]` 是**该 tick 的完整日志记录**（含 `tick.step` 调试条目，单帧可达 16~20 条）——回放屏不要把它当"事件流"整屏渲染，只做筛选展示（§10.8）。

---

## §7 状态条（顶栏：一处实现，七屏共用）

| 元素 | data-id | 数据源 | 行为 |
|---|---|---|---|
| Logo + 标题 | — | — | 点它 = `goto menu`（`data-action=goto`） |
| 后端状态点 | `top_server` | `meta.serverOk` | 离线红点 + tooltip「无法连接服务器」 |
| 段位下拉 | `top_tier` | `state.tier` | change → `tier/set`（切段位会重取 unlock；锁定物品即时变色）；取值 `common` / `rare` / `epic` / `legendary` / `mythic` |
| 种子输入 | `top_seed` | `state.seed` | change → `seed/set`（空 = 服务端生成并回带） |
| 随机种子 | `top_seed_rand` | — | `seed/random` |
| 快速对战 | `top_quick` | loadout 合法性 | 合法 → 进 battle；非法 → toast 缺失项 + 进 warehouse |
| 仓库计数 | `top_wh` | `warehouse.buckets` 合计 | 点它 → `goto warehouse` |
| 设置 | `top_settings` | — | `goto settings` |

---

## §8 战场渲染（唯一使用绝对定位的地方）

### 8.1 容器与坐标系

```html
<div class="dl-field" data-id="field">          <!-- width:1024px;height:128px;position:relative;overflow:hidden -->
  <div class="dl-actor" style="left:224px" data-id="actor_p1">…</div>   <!-- 32px 宽居中的块 -->
</div>
```
- 引擎坐标 → CSS：`left = x px`（1:1，`battle-config.fieldPx=1024 / cellPx=64 / actorHalfPx=32`）。
- 场地 1024px 宽度放进弹性的页面里：外层 `.dl-field-wrap{max-width:100%;overflow-x:auto}`（宁可横向滚动，不做缩放变形，避免点击坐标错位）。
- 高度 128px 固定；角色块 64×64、底部贴地线（`bottom:0`）。

### 8.2 图元（每帧画什么，逐条）

| 图元 | 判定 | 位置 | 视觉 |
|---|---|---|---|
| 地面格 | 恒有 16 格 | `left = i*64` | 交替底色 + 中线 |
| 基地 | `diff.bases[owner]` | p1 `left:0`、p2 `left:992`（`992 = 1024-32`） | 32×26 块 + 血量文本 |
| 角色 | `diff.players[owner]` | `left = fromX + (toX-fromX)*t`（`t∈[0,1]`，见 §8.4） | 64×64 块；朝向箭头；`hp<=0` 变灰 |
| 弹幕 | `diff.bullets[]` | 区间 `[min(x,x+len), max(x,x+len)]` 的横条 | 等级配色（L1–L4） |
| 命中火花 | `diff.bulletHits[]` | `left = atX` | 16×16 星形块（仅该帧） |
| 碰撞火花 | `diff.collision` | `left = contactX` | 24×24 块 + 文本 `-dmg`（若能在 events 找到 `damage.calc`） |
| 胜负标记 | `diff.verdict` | 场地中央 | 文本「p1 胜 / p2 胜 / 平局」 |

### 8.3 内联样式的唯一例外

战场内元素与进度条允许内联 `style`（因为是像素语义的数据，不是装饰）。允许的键只有：`left`、`width`、`bottom`、`height`。其余样式一律类名。

### 8.4 累积状态与插值（关键：不能只画当帧）

```
frameAt(frames, tick) → 累积快照
  players[owner] = 最后一个 tick' ≤ tick 的 {fromX,toX,facing,hp,mp,sp}
  bases[owner]   = 同上最后一帧的 {hp,def}
  其余（bullets/bulletHits/collision/verdict/aiTrace/events）只用当帧
```
- 播放时 `t = (now - frameStartMs) / (1000/speed)`，clamp `[0,1]`；拖动滑块/单步时 `t=1`。
- **禁止重算战斗**：不判断伤害、不推进位置、不消费随机；一切数值来自帧。

### 8.5 绘制日志（`render` 通道，trace）

每帧一条汇总 + 每图元一条明细（用于"看不到画面"时定位）：

```
render.frame  {tick, primitives, scale:1, actors:[{id,x,y,w,h,hp}]}
render.box    {kind:'actor'|'base', id, x, y, w, h, z}
render.sprite {kind:'bullet'|'hit'|'collision', id, x, y, w, h, level?}
render.text   {kind:'hp'|'verdict', text, x, y}
```

排查法（照抄旧审查的教训）：画面缺东西 → 先看 `render.frame.primitives` 里有没有该图元 → 没有则是数据/投影问题（查 `frameAt` / 帧字段）；有则是样式问题（查类名/尺寸/被 `overflow:hidden` 裁掉）。

---

## §9 通用交互规范（防"死按钮""点了没反应"）

1. 请求进行中：触发按钮 `disabled` + 文案追加 `…`（如「开箱中…」「对战中…」）；完成后必须恢复（`finally` 语义）。
2. 双击保护：`ui.busy` 或域内 `running==='requesting'` 时 reducer 直接返回原 state（并记 `store.dispatch` 忽略日志）。
3. 每个异步按钮都必须有**成功路径**与**失败路径**的可见结果（toast 或行内文本）。
4. 输入类控件：`Enter` 等价提交（`keydown` 委托可选实现，但 `change` 必须实现）。
5. 列表项点击 = 选中（不改数据）；写操作必须另有明确按钮（避免误触）。
6. 任何"禁用"的按钮必须带上原因文本（`title` + 行内原因），不允许只灰不解释。
7. 弹窗必带「关闭」，且 `Esc` 关闭（键盘委托）。遮罩点击 = 关闭。

---

## §10 七屏逐个：完整按钮表 + 场景状态机

> 每屏格式：**布局**（DOM 结构，不讲坐标）→ **按钮表**（每行必须有 `data-id` / `data-action` / 可用条件 / 失败表现）→ **状态机**（loading/empty/error/ready 的具体判定式）。

### 10.1 `menu` 主菜单

布局：`.dl-cols` 两栏。左栏「开始玩」按钮组 + 状态摘要；右栏「当前出战配置」摘要卡（角色/3 技能/AI 程序哈希）+ 「上一次对战结果」。

| data-id | 文案 | data-action | 可用条件 | 成功后 | 失败表现 |
|---|---|---|---|---|---|
| `btn_menu_gacha` | 开箱 | `goto{gacha}` | 恒可 | 进 gacha | — |
| `btn_menu_wh` | 仓库与装配 | `goto{warehouse}` | 恒可 | 进 warehouse | — |
| `btn_menu_editor` | AI 编辑器 | `goto{editor}` | 恒可 | 进 editor（无程序则预填预设） | — |
| `btn_menu_battle` | 对战 | `goto{battle}` | 恒可（内部再校验） | 进 battle | — |
| `btn_menu_ranked` | 排位赛 | `goto{battle, mode:'ranked'}` | 仓库非空且有角色 | 进 battle（滚到排位区） | — |
| `btn_menu_settings` | 设置 | `goto{settings}` | 恒可 | 进 settings | — |
| `btn_retry_boot` | 重试连接 | `retry_boot` | `meta.serverOk !== true` 时显示 | 重跑 boot | toast「仍无法连接」 |
| `btn_menu_quick` | 快速对战 | `battle/run` | loadout 合法 | 进 replay 并开始播放 | 非法 → toast 缺失项 + `goto warehouse` |

状态机：`loading`（`meta.serverOk==null` 且无 unlock）→ 显示「正在连接服务器」；`error`（`serverOk===false`）→ 红条 + `btn_retry_boot`，其余按钮仍可点（离线暂存操作不写后端）；`empty`（仓库四桶全空）→ 左栏加提示「仓库为空，先开箱」；`ready` → 正常。

### 10.2 `gacha` 开箱

布局：顶部控制条（段位下拉、次数输入、开箱按钮、随机种子）+ 结果区（结果卡网格，每卡显示名称/kind 中文/品质/关键数值）+ 右栏「本次结果汇总」。

| data-id | 文案 | data-action | 可用条件 | 成功后 | 失败表现 |
|---|---|---|---|---|---|
| `gacha_tier` | 段位 | `gacha/tier` | 恒可 | 更新选择 | — |
| `gacha_times` | 次数(1–100) | `gacha/times` | 恒可 | clamp 后写 state | — |
| `btn_gacha_roll` | 开箱 ×N | `gacha/roll` | `running!=='requesting'` | `results` 渲染 + 入仓库 + toast「获得 N 件」 | `tier_locked`→toast 原文 + 段位下拉高亮；`bad_times`→toast；网络错→toast + 重试 |
| `btn_go_wh` | 去仓库 | `goto{warehouse}` | `results.length>0` | 进仓库 | — |
| `btn_gacha_again` | 再来一次 | `gacha/roll` | 同上 | 同上 | 同上 |

状态机：`loading`（`running==='requesting'`）→ 按钮禁用文案「开箱中…」，结果区保留上次；`empty`（`results.length===0`）→ 提示「还没有开箱结果」；`error` → 顶部红条 + 保留输入；`ready` → 网格渲染。

细节：`data.seed` 回带后写 `state.seed`（顶栏同步显示）；结果卡按 `kind` 显示中文（`role`角色/`skill`技能/`rolePlugin`角色插件/`skillPlugin`技能插件）；品质色边用 `--q-<quality>` 令牌（令牌值取自 `qualities.json` 的 `color`，禁止另写一份）。

### 10.3 `warehouse` 仓库与装配（最关键的一屏）

布局：三栏。

- 左栏：4 个页签（角色/技能/角色插件/技能插件，带数量）+ 下方「当前出战」块（角色 1 格 + 技能 3 格，每格有「卸下」）+ 「查看面板」按钮。
- 中栏：卡片网格（每卡：名称、品质、关键数值摘要、`出战`/`已出战` 按钮、插件显示 `装/拆` 入口）。
- 右栏：选中物品详情 —— 基础信息、五维或技能参数、**槽位表**（每行：插槽类型 / 已装插件名 / `装配` 或 `卸下`）。

| data-id | 文案 | data-action | 可用条件 | 成功后 | 失败表现 |
|---|---|---|---|---|---|
| `wh_tab_<bucket>` | 页签 | `wh/tab` | 恒可 | 切列表 | — |
| `btn_wh_equip_<uid>` | 出战 | `loadout/equip{uid}` | 角色卡：未被占用；技能卡：有空技能位 | toast「已出战：<name>」+ 顶部出战块更新 + 面板刷新 | 技能位满 → 按钮文案改「技能位已满」并禁用 |
| `btn_wh_unequip_<slot>` | 卸下 | `loadout/unequip{slot}` | 该位非空 | 清位 + 面板刷新 | — |
| `btn_wh_slot_<index>` | 装配/卸下 | `modal/open{modal:'assemble',targetUid,slotIndex}` / `assembly/take` | 槽位存在 | 抽屉弹出 / 直接卸下 | 卸下失败 → toast（`slot_empty`/`plugin_missing`） |
| `btn_asm_pick_<uid>` | ＋<插件名> | `assembly/run{targetUid,pluginUid,slotIndex}` | 候选预过滤通过（见下） | 抽屉内行变「已装」+ 仓库整体替换 + 点数条更新 | toast（`points_exceeded`/`slot_type_mismatch`/`tier_locked`/`plugin_equipped`/`item_missing`） |
| `btn_asm_close` | 关闭 | `modal/close` | 抽屉打开时 | 关闭 | — |
| `btn_wh_panel` | 查看面板 | `panel/refresh` | loadout 有角色 | 右栏面板区出现五维/regen/special/技能参数 | `loadout_invalid` → 逐条 details 上屏（不 toast 截断） |
| `btn_go_gacha` | 去开箱 | `goto{gacha}` | 四桶全空时显示 | 进 gacha | — |
| `btn_wh_clear_filter` | 清除筛选 | `wh/filter` | 有筛选时 | 重置 | — |

**装配候选预过滤（对齐后端校验顺序，避免"点得动但必失败"）**：
```
candidate(p, target, slot):
  1) p.kind === (target.kind==='role' ? 'rolePlugin' : 'skillPlugin')
  2) p.slot === target.slots[slotIndex].type
  3) p.equipped !== true
  4) tierIndex(p.unlockTier) <= tierIndex(state.tier)
  5) 角色目标：usedPoints + (p.pointCost||0) <= (target.pluginPoints||0)
  全部通过 → 可点；否则按钮禁用 + 行内原因（「槽位不符」「点数不足：需 3，剩 1」「段位不足：需 rare」）
```
点数条：`已用 = Σ(已装插件 pointCost)`，`上限 = target.pluginPoints`，同时显示 `已装件数/槽位数`。

状态机：`loading`（装配请求中 → 抽屉内按钮禁用）；`empty`（当前页签 0 件）→ 「该分类为空 → 去开箱」；`error`（装配失败）→ 错误就地显示在抽屉内（toast + 行内保留），仓库保持原状（后端原子性）；`ready` → 正常。

### 10.4 `editor` AI 编辑器（表单式，无 Blockly）

布局：三栏。左栏「程序结构树」（可折叠，每个节点一行，行内按钮 `＋`/`×`）；中栏「节点编辑表单」（选中节点的字段控件，按 §12.3 元数据生成）；右栏「工具区」（预设、校验、编译、应用到出战、JSON 导入导出、错误列表）。

| data-id | 文案 | data-action | 可用条件 | 成功后 | 失败表现 |
|---|---|---|---|---|---|
| `editor_tree_node_<path>` | 节点行 | `editor/select{path}` | 恒可 | 中栏显示该节点表单 | — |
| `editor_add_<path>` | ＋ | `editor/add{path,index?,nodeType}` | 该位置可插入 | 新节点出现在树中 | 未选类型 → 弹出选择行 |
| `editor_del_<path>` | × | `editor/remove{path}` | 非根、非隐式循环 | 节点删除 | 根节点 → 按钮不渲染 |
| `editor_field_<path>_<field>` | 字段控件 | `editor/set{path,field,value}` | 恒可 | 立即改 state + 400ms 后自动校验 | — |
| `btn_ed_preset_<id>` | 预设 | `editor/preset{preset}` | 恒可 | 覆盖程序 + 立即校验 | — |
| `btn_ed_validate` | 校验 | `editor/validate` | 有程序 | 显示「校验通过」或错误列表 | 400 `ai_invalid` → `details[]` 逐条上屏（带 path） |
| `btn_ed_compile` | 编译 | `editor/compile` | 有程序 | 显示 `programHash` 前 12 位 + `stats{nodes,depth}` | `bad_field`/`ai_too_large` → toast + 错误列表 |
| `btn_ed_apply` | 应用到出战配置 | `editor/apply` | `validateState==='ok'` | toast「已应用」+ 顶栏/菜单摘要更新 | 未通过校验 → 按钮禁用 + 提示先校验 |
| `btn_ed_import` | 导入 JSON | 打开文本域 | 恒可 | 解析成功 → 写程序 | JSON 解析失败 → toast「JSON 格式错误」 |
| `btn_ed_export` | 导出 JSON | 下载 `ai-program.json` | 有程序 | 下载 | — |
| `editor_err_<i>` | 错误行 | `editor/highlight{path}` | 有错误 | 树中该节点高亮 + 滚动到位 | 路径失效（程序已改）→ toast「程序已变化，请重新校验」 |

**隐式主循环**：根 `body` 恒为 `{type:'seq',statements:[…]}`，界面顶部固定显示一行「每个 tick 从第一条执行；跑完自动回到第一条（隐式 while(true)）」且不可删除（对应 `docs/examples/08-ai.md` §1）。

状态机：`loading`（`validateState==='checking'` → 「校验中…」）；`empty`（无程序）→ 预填预设「稳健」并提示；`error`（校验失败）→ 右栏红框错误列表（每条：`path` + 中文 message）；`ready` → 「校验通过 · 节点 12 · 深度 3」。

### 10.5 `battle` 对战配置 + 排位

布局：上下两块。上块「对战」：左栏模式与对手选择、中栏「我的出战配置」摘要、右栏「面板预览」（五维/技能/CD/消耗）；底部「开始对战」+「查看上一次回放」。下块「排位赛」：种子、开始按钮、结果表、晋升区。

| data-id | 文案 | data-action | 可用条件 | 成功后 | 失败表现 |
|---|---|---|---|---|---|
| `battle_mode_ai` / `battle_mode_duel` | 模式切换 | `battle/mode` | 恒可 | 切换控件组 | — |
| `battle_opp_kiter` / `battle_opp_charger` | 对手：风筝/冲锋 | `battle/opponent` | `mode==='ai'` | 选中态 | — |
| `btn_battle_run` | 开始对战 | `battle/run` | loadout 预检通过（角色+3 技能+AI） | 进 replay（不自动播放，停在第 1 帧） | `loadout_invalid` → 逐条 details；网络错 → toast + 按钮恢复 |
| `btn_battle_replay_last` | 查看上一次回放 | `goto{replay}` | `frames.length>0` | 进 replay | — |
| `btn_go_wh_from_battle` | 去仓库 | `goto{warehouse}` | 预检不通过时显示 | 进仓库 | — |
| `btn_go_ed_from_battle` | 去编辑器 | `goto{editor}` | 无 AI 时显示 | 进编辑器 | — |
| `btn_panel_refresh` | 刷新面板 | `panel/refresh` | 有角色 | 面板刷新 | 同 §10.3 |
| `btn_ranked_run` | 开始排位（10 场） | `ranked/run` | loadout 合法 | 表格显示 10 行 + 计数 + 晋升按钮（若 `promoted`） | 409 `no_loadout`/`loadout_invalid` → 逐条上屏 |
| `btn_ranked_promote` | 晋升到下一段位 | `ranked/promote` | `ranked.result.promoted === true` | 段位 +1，顶栏同步，显示奖励品质 | 409 `already_max` → toast「已是最高段位」并隐藏按钮 |

模式差异（必须写清，否则实现会混）：
- `mode:'ai'`（默认，单机演练）：`POST /ai/battle {program: loadout.ai, seed, tier, opponent}`；**基准面板、无技能实例** → 界面显式提示「演练模式使用基准面板，技能不会被释放」；`frames` 无 `bases`、无 `events`（字段只在响应里存在的那几项）。
- `mode:'duel'`：`POST /battle {p1: loadout, p2: 对手 loadout, warehouse, seed, tier}`；对手 loadout 由前端从**数据表**构造（`role_bal` + 三个 common 技能 + 简单 AI 程序），**不硬编码数值**：从 `/data/role-templates`、`/data/skill-templates`、`/data/qualities` 取基准值。

状态机：`loading`（`battle.running==='requesting'` → 按钮「对战中…」禁用，其余控件禁用）；`empty`（无 frames）→ 「还没有对战记录」；`error` → 顶部红条 + 错误 details 列表；`ready` → 摘要 + 结果。

### 10.6 `replay` 回放与结算（§8 的宿主）

布局：`HUD`（双方：名称、HP 条、MP/SP 条、基地 HP）→ `.dl-field`（战场）→ 控制条（播放/暂停、步进 ±1、倍速 ×1/×2/×4、tick 滑块、`tick n/N` 文本）→ 下方两栏（左：本 tick 事件筛选表；右：本 tick AI 轨迹）。

| data-id | 文案 | data-action | 可用条件 | 成功后 | 失败表现 |
|---|---|---|---|---|---|
| `btn_rp_play` | ▶ 播放 | `replay/play` | `frames.length>0` 且 `!playing` 且 `tick < frames.length-1` | 开始推进（间隔 `1000/speed`） | 末帧时按钮变「重播」（`replay/seek{0}` + play） |
| `btn_rp_pause` | ⏸ 暂停 | `replay/pause` | `playing===true` | 停止推进，tick 保持 | — |
| `btn_rp_prev` / `btn_rp_next` | ◀ / ▶| | `replay/step{delta:-1/+1}` | `frames.length>0` | tick 变化 + 立即重绘（`t=1`） | 边界时禁用 |
| `btn_rp_speed_1/2/4` | ×1/×2/×4 | `replay/speed` | 恒可 | 播放中间隔立即改变 | — |
| `rp_tick` | tick 滑块 | `replay/seek{tick}` | `frames.length>1` | 跳到该 tick 并暂停 | — |
| `btn_rp_menu` | 返回菜单 | `goto{menu}` | 恒可 | 回菜单（frames 保留） | — |
| `btn_rp_again` | 再来一局 | `battle/run` | loadout 仍合法 | 重新起战（覆盖 frames） | 同 §10.5 |
| `btn_rp_settle_close` | 继续查看 | `modal/close` | 结算弹窗打开时 | 关闭弹窗，可继续拖时间轴 | — |
| `rp_event_filter` | 事件通道筛选 | `replay/filter` | 有事件 | 过滤 `events[]` 展示 | — |
| `rp_trace_owner` | 轨迹归属筛选 | `replay/trace-owner` | 有轨迹 | 只显示 p1/p2/双方 | — |

**结算判定式（R3 的修复点，逐字实现）**：
```
showSettle = summary !== null
          && frames.length > 0
          && tick >= frames.length - 1        // 只有到末帧才弹
          && !playing                          // 播放中不弹
```
- 弹窗内容：`winner` 中文（p1 胜 / p2 胜 / 平局）+ `phase`（角色阵亡 / 基地被毁 / 超时平局）+ `ticks` + 「再来一局」「返回菜单」「继续查看」。
- `winner==='draw'` 也必须能结算（后端存在平局）。

状态机：`loading`（无 frames）→ 「正在载入回放…」（实际是同步数据，仅用于空态一致）；`empty`（`frames.length===0`）→ 「没有可回放的战斗」+「去对战」；`error`（起战失败）→ 顶部红条 + 详情；`ready` → 渲染 + 控制条可用。

### 10.7 `settings` 设置

布局：三栏（存档 / 种子与段位 / 日志面板）。

| data-id | 文案 | data-action | 可用条件 | 成功后 | 失败表现 |
|---|---|---|---|---|---|
| `btn_set_export` | 导出存档 | `save/export` | 恒可 | 下载 `dl-save-<ts>.json` | — |
| `btn_set_import` | 导入存档 | `save/import{text}` | 恒可 | 仓库/出战/段位恢复 + toast | 结构不符 → toast `bad_save`，不动现有状态 |
| `btn_set_reset` | 清空存档 | `save/reset` | 恒可 | 回默认 state + toast | — |
| `set_level` | 日志级别 | `settings/log-level` | 恒可 | 立即生效 + 持久化 | — |
| `set_ch_<channel>` | 通道级别 | `settings/log-channel` | 恒可 | 立即生效 | — |
| `set_filter` | 日志筛选 | `settings/log-filter` | 恒可 | 列表过滤 | — |
| `btn_log_export` | 导出日志 | `log/export` | 恒可 | 下载 `dl-log-<ts>.json` | — |
| `btn_log_clear` | 清空日志 | `log/clear` | 恒可 | 缓冲清空 | — |
| `btn_set_reboot` | 重新连接服务端 | `retry_boot` | 恒可 | 重跑 boot | toast |

关于区：显示 `meta.version`、文档指针（`docs/frontend-spec.md`）、`battle-config` 关键值（从 `/data/battle-config` 读，界面只读展示——**不写死数值**）。

状态机：`loading`（日志未就绪）→ 「日志初始化中」；`empty`（日志 0 条）→ 「暂无日志」；`error`（导入失败）→ 红字就地显示；`ready` → 列表。

---

## §11 弹窗与瞬态（显示条件逐条列，避免"进屏即遮罩"）

| 弹窗 | 显示条件 | 关闭方式 | 内含按钮 |
|---|---|---|---|
| 装配抽屉 `modal==='assemble'` | `ui.modal==='assemble'` 且有 `selected` 目标物品 | 关闭按钮 / `Esc` / 遮罩点击 | `btn_asm_pick_*`、`btn_asm_close` |
| 结算弹窗 | §10.6 的 `showSettle` 判定式 | 「继续查看」/「返回菜单」/`Esc` | `btn_rp_again`、`btn_rp_menu`、`btn_rp_settle_close` |
| toast | `ui.toasts.length>0` | 3s 自动 / 点关闭 / `toast/close` | `toast_close_<id>` |

**禁止**：任何"因为某个数据字段有值就整屏遮罩"的写法（旧实现 `result` 恒有值 → 回放屏永久遮罩）。

---

## §12 AI 编辑器：AST 表单规格（替代 Blockly）

### 12.1 程序外壳（唯一合法形态）

```jsonc
{ "type":"program", "version":2,
  "body":{ "type":"seq", "statements":[ /* 语句节点 */ ] } }
```
- `version` 固定写 `2`（当前 `CURRENT_VERSION=2`；`version:1` 会被服务端迁移，前端不主动产生旧版本）。
- 根 `body` 必须是 `seq`（D-100 隐式主循环契约），界面不提供修改。

### 12.2 节点类型（16 类，来自 `ai/ast.js` 白名单 + `unlock.nodes` 门控）

| 类别 | 节点 | 表达式/语句 | 关键字段 |
|---|---|---|---|
| 结构 | `seq` | 语句 | `statements[]` |
| | `if` | 语句 | `cond`(表达式), `then`(语句), `else`(语句,可选) |
| | `loop` | 语句 | `kind:'count'|'while'`, `times`(表达式,count), `cond`(表达式,while), `body`(语句) |
| | `break` | 语句 | —（仅循环体内） |
| | `function` | 语句 | `name`(string), `body`(语句) |
| | `call` | 语句 | `name`(string，必须是已定义函数) |
| | `action` | 语句 | `name`(string，§12.4) |
| 变量 | `var` / `set` / `getVar` | 语句/表达式 | `name`(string), `value`(表达式，var/set) |
| 值 | `literal` | 表达式 | `value`(数字/布尔) |
| | `get` | 表达式 | `path`(string，白名单根 `tick|self|enemy|bases|field`，形如 `根.字段` / `根.cooldowns.<sid>` / `根.effects[i].<字段>`；详见下方清单) |
| 运算 | `arith` | 表达式 | `op ∈ + - * /`, `left`, `right` |
| | `cmp` | 表达式 | `op ∈ < > <= >= == !=`, `left`, `right` |
| | `logic` | 表达式 | `op ∈ and, or`（**与 `runtime.js` 逐值核对**；`&&`/`||`/`not` **均未实现**——非 `and`/`or` 的取值一律求值为 `false`，`ast.js` 暂无枚举校验，见 `systems/08-ai.md` §3）, `left`, `right` |
| | `random` | 表达式 | `prob`(表达式), `then`(表达式), `else`(表达式) |

- **门控**：节点是否出现在"可添加"菜单，取决于 `/unlock` 的 `nodes`。该数组**只含真实节点类型**（`server/data/ai-nodes.json` 的 `nodes`，共 16 类）：权限别名 `while` 折叠为 `loop`、未实现的预留权限 `arith_ext` 不授予任何节点（故 `isUnlocked(tier,'arith_ext')===false`）——编辑器**无需再自行过滤别名**。`function/call` 归 `function/call` 权限。段位不足时节点显示为不可添加并给出「需 <tier> 段位」。
- **合法性**（服务端会拒，前端在编辑时就提示）：循环体内所有 `if` 的**每个分支**（含隐式空 `else`）必须含 `action`，**或调用一个"能（传递）产出 action"的函数**（调用链定点分析：函数体直接含 action，或调用其它行动产出函数）；`break` 只能在循环体内；`call` 的目标函数必须存在。纯检测函数（无 action）可以定义，但不能用来满足"分支须含 action"——这样 `while(true){ call 纯检测() }` 这类**空死循环**会在校验期被拒。
- 表达式可用的 `get` 路径（与 `ai/ast.js` 的 `get.path` 白名单一致）：`tick`、`self|enemy.<字段>`（`hp|maxHp|mp|maxMp|sp|maxSp|atk|def|x|facing|baseHp`）、`self|enemy.cooldowns.<sid>`、`self|enemy.effects[i].<字段>`（`uid|kind|stat|delta|displacement|remaining`）、`bases.self|enemy.<字段>`（`hp|maxHp|def`）、`field.fieldPx`、`field.cellPx`。**容器不可当值读**（`self` / `self.cooldowns` / `self.effects[i]` / `bases.self` 等本身不是合法路径）；非法/越界路径在**校验层**报 `bad_path`，运行层兜底为安全默认 `0`（不抛）。
- **AI 无法观测弹幕**：`get` 读不到弹幕，也**不存在** `bullets` 节点——**弹幕在生成当 tick 全解算完毕**，这是设计而非缺陷。编辑器不应提供任何"读弹幕"节点或路径；回放帧 `diff.bullets[]` 与日志通道 `bullets` 是**展示/诊断**用途，与 AI 快照无关。

### 12.3 表单生成（`editor/nodes.js` 数据结构）

```js
{ type:'loop', label:'循环', category:'语句',
  fields:[ {key:'kind', label:'类型', kind:'select', options:['count','while']},
           {key:'times', label:'次数', kind:'node', when:n=>n.kind==='count'},
           {key:'cond',  label:'条件', kind:'node', when:n=>n.kind==='while'},
           {key:'body',  label:'循环体', kind:'node'} ] }
```
- `kind:'node'` 的字段渲染为「子节点编辑区」（嵌套一层），`seq` 的 `statements` 渲染为可增删的列表（每项 `＋/×`）。
- **所有节点字段必须来自这张元数据表**：视图层禁止出现 `if (node.type === 'xxx')` 的散落判断（保证新增节点只改一处）。

### 12.4 动作名（`action.name` 的合法取值）

| 分类 | 取值 | 说明 |
|---|---|---|
| 移动 | `move_left` / `move_right` | 移动 1 格（64px）；**不改变朝向** |
| 转向 | `turn` | **翻转朝向**（`facing × −1`），不移动、不消耗；背击判定用本 tick 写回后的朝向（06-field §4.2 / D-50） |
| 闪避 | `dodge_left` / `dodge_right` | 闪避 2 格（128px），本 tick 闪避 +20%；**不改变朝向** |
| 其他 | `wait` / `defend` | 等待 / 防御（def×1.6） |
| 技能 | `skill:skill1` / `skill:skill2` / `skill:skill3` | **必须写 `skill:` 前缀**；`skill1..3` 对应出战配置里的 3 个技能位 |

- 引擎的动作白名单是 `['move_left','move_right','dodge_left','dodge_right','wait','defend','turn']`（`core/engine.js` 的 `ACTIONS`，自检器 C6 逐值核对）。
- **非法动作名不会被 `/ai/validate` 拒绝**：服务端把它归一化成 `wait` 并记 `action.invalid`(warn)。因此编辑器**必须在下拉里只给合法值**——自由文本会造成"程序校验通过但角色一直不动"的隐性故障（旧轮回放屏就踩过：写 `skill_skill1` 全是无效行动）。
- 引擎动作词汇表同时登记在 `server/data/ai-nodes.json` 的 `actions`（`fixed` + `parametric: ["skill:"]`），供编辑器与文档共用。
- 对手/示例 AI 的常见写法：`(skill:skill1, move_right, defend)` 循环 —— 内置预设（§12.5）覆盖这些。

### 12.5 内置预设（首屏可用，保证"一定有能打的程序"）

| id | 名称 | 程序要点 |
|---|---|---|
| `steady` | 稳健 | `defend` + `skill:skill1` 交替 |
| `aggressive` | 强攻 | `move_right` ×2 + `skill:skill1` |
| `kite` | 风筝 | 若 `self.x < enemy.x` → `dodge_left` 否则 `skill:skill2` |
| `counter` | 反击 | 若 `enemy.hp < self.hp` → `skill:skill3` 否则 `defend` |

预设用于：编辑器首次进入、`btn_ed_preset_*`、以及 battle 屏 duel 模式构造对手（`steady` 变体）。

---

## §13 日志与自检（保留可观测性，但不做坐标仪式）

### 13.1 通道与事件（前端只用已注册通道）

> `shared/log.js` 已注册 **21 个通道**：`rng field effects items roles skills bullets engine damage ai.ast ai.runtime unlock api cli ranked store view render editor perf log`（**实测计数 21，逐值以此为准**）。
> **前端只允许用下表中的 5 个**（`store api view render editor`，均为已注册通道）。⏳ **`ui` 通道属"未来新增（未实现）"**：注册表里**没有** `ui`，因此**现行前端不得写 `ui.*` 事件**（旧实现写 `ui` 通道会被日志规范拒绝）。点击日志现行用 `view.click`；下文（§13.1 末条与 §17 人工验收第 3 条）出现 `ui.click` 字样，一律按**未实现**读作 `view.click`。

| 通道 | 事件 | 级别 | 何时 |
|---|---|---|---|
| `store` | `store.boot` / `store.dispatch` / `store.save` / `store.load` | info/debug | 启动、每次 dispatch（含 action 名与是否被拒）、持久化 |
| `api` | `api.req` / `api.res` / `api.err` | info/info/error | 每次请求（含 `method/path/status/durationMs/bytes`） |
| `view` | `view.render` / `view.click` / `view.reject` / `view.toast` | debug/info/warn | 屏渲染四态、点击命中（含 data-id 与 action）、禁用/校验拦截、错误提示上屏 |
| `render` | `render.frame` / `render.box` / `render.sprite` / `render.text` | trace | 战场每帧（§8.5） |
| `editor` | `editor.ast.change` / `editor.validate` / `editor.compile` | debug | 编辑器改树、自动校验结果、编译结果 |

- 事件名必须匹配 `scripts/fe-spec-check.js` 的规则（`<channel>.<name>`，name 只含 `[a-z0-9.]`），且通道必须在注册表内，否则自检失败（C8）。
- 缺省级别 `debug`（URL `?log=trace` 或设置屏可改）；环形缓冲沿用 `shared/log.js`（N=2000）。
- 每个按钮点击都记 `view.click`（`{dataId, action}`），**点击日志与动作受理日志成对出现**——这是"点了没反应"的第一定位手段（旧实现缺这条，只能靠猜）。

### 13.2 调试入口（`window.__DL__`，人工验收用）

```js
__DL__.state()                  // 当前 state（深拷贝）
__DL__.goto('replay')           // 直接切屏
__DL__.samples()                // 打印 .audit/fe-samples.json 中的形状与本地渲染对照（仅开发）
__DL__.dumpDom()                // #dl-screen 的 outerHTML（找"为什么看不到"）
__DL__.exportLog()              // = DLLog.dump() 下载
```

---

## §14 文档自检器（`scripts/fe-spec-check.js`）—— 让本文无法"写完就过期"

自检器解析**本文**并对照真实代码/数据/响应，任一条不满足即 `[FAIL]`：

| # | 检查 | 数据来源 | 拦住的旧故障 |
|---|---|---|---|
| C1 | 本文 §15 注册表可解析（JSON 合法、字段齐全） | 本文 | — |
| C2 | 每个按钮的 `action` 都在 §5.2 动作表内 | 本文 | R4 死按钮 |
| C3 | 每个动作都被至少一个按钮使用（无僵尸动作） | 本文 | 冗余动作 |
| C4 | 每个 `screen` 至少 1 个 `data-action=goto` 入口，且七屏都在注册表 | 本文 | 进不去的屏 |
| C5 | 本文引用的每个数据字段名都存在于 `.audit/fe-samples.json` 对应的真实样本中（`players.p1.toX`、`bulletHits[].atX`、`data.items[].uid`、`panel.role.stats`、`ranked.data.wins` 等） | 探针样本 | R5/R6 字段错读 |
| C6 | 注册表里的段位、对手、品质、动作名取值与后端实现一致（`unlock.js` TIERS、`runner.js` OPPONENTS、`qualities.json`、`ast.js` 节点白名单） | 源码/数据表 | 门控与取值写错 |
| C7 | 本文提到的每个 `public/js/**` 文件都在 §1.2 清单里（反之亦然） | 本文 | 文件漏项 |
| C8 | 日志事件名符合 `<channel>.<name>` 且通道已注册 | `shared/log.js` | 日志规范 |
| C9 | 若 `public/js` 已存在实现：每个 `data-action="X"` 都能在动作表找到 `X`，且每个 `data-id` 在注册表中 | 实现代码 | 实现漂移（F 轮问题） |

> ⚠️ **C4 与注册表硬编码 7 屏**：`scripts/fe-spec-check.js` 的 `SCREEN_IDS` 与脚本内"七屏齐全"判定，以及本文 §15 注册表的 `screensRequired: ["menu","gacha","warehouse","editor","battle","replay","settings"]`，都是**硬编码的 7 屏**。屏数一旦变化（如新增账号屏/战绩屏/排行榜屏），**必须同步更新该脚本与注册表这两处**，否则 C4 直接 FAIL。（该脚本不属本文档，本任务不改脚本，仅在此登记。）
>
> 用法：`node scripts/fe-spec-check.js`（退出码 0/1）；并在 `tests/frontend/fe-spec.test.js` 内以断言方式跑同一函数，保证 `npm test` 也覆盖。
探针过期时重跑：`node .audit/fe-samples.js`（§附录 A 头部有同样提示）。

---

## §15 机器可读注册表（唯一真相，供自检器与代码生成）

> 规则：`screens[].buttons[]` 的 `action` 必须命中 `actions[]`；`dataIds` 是全局唯一 ID 前缀；实现时允许用 `js/views/actions.js` 由本表**手工照抄**（自检器 C9 会比对实现）。

```json fe-spec-registry
{
  "version": 3,
  "screens": [
    { "id": "menu", "title": "主菜单",
      "buttons": [
        { "dataId": "btn_menu_gacha", "label": "开箱", "action": "goto", "payload": { "screen": "gacha" } },
        { "dataId": "btn_menu_wh", "label": "仓库与装配", "action": "goto", "payload": { "screen": "warehouse" } },
        { "dataId": "btn_menu_editor", "label": "AI 编辑器", "action": "goto", "payload": { "screen": "editor" } },
        { "dataId": "btn_menu_battle", "label": "对战", "action": "goto", "payload": { "screen": "battle" } },
        { "dataId": "btn_menu_ranked", "label": "排位赛", "action": "goto", "payload": { "screen": "battle", "focus": "ranked" } },
        { "dataId": "btn_menu_settings", "label": "设置", "action": "goto", "payload": { "screen": "settings" } },
        { "dataId": "btn_menu_quick", "label": "快速对战", "action": "battle/run" },
        { "dataId": "btn_retry_boot", "label": "重试连接", "action": "retry_boot" }
      ] },
    { "id": "gacha", "title": "开箱",
      "buttons": [
        { "dataId": "gacha_tier", "label": "段位", "action": "gacha/tier", "control": "select" },
        { "dataId": "gacha_times", "label": "次数", "action": "gacha/times", "control": "number" },
        { "dataId": "btn_gacha_roll", "label": "开箱", "action": "gacha/roll" },
        { "dataId": "btn_gacha_again", "label": "再来一次", "action": "gacha/roll" },
        { "dataId": "gacha_result", "label": "结果卡（选中查看属性）", "action": "gacha/select", "listItem": true },
        { "dataId": "btn_go_wh", "label": "去仓库", "action": "goto", "payload": { "screen": "warehouse" } }
      ] },
    { "id": "warehouse", "title": "仓库与装配",
      "buttons": [
        { "dataId": "wh_tab_role", "label": "角色页签", "action": "wh/tab", "payload": { "bucket": "role" } },
        { "dataId": "wh_tab_skill", "label": "技能页签", "action": "wh/tab", "payload": { "bucket": "skill" } },
        { "dataId": "wh_tab_rolePlugin", "label": "角色插件页签", "action": "wh/tab", "payload": { "bucket": "rolePlugin" } },
        { "dataId": "wh_tab_skillPlugin", "label": "技能插件页签", "action": "wh/tab", "payload": { "bucket": "skillPlugin" } },
        { "dataId": "btn_wh_equip", "label": "出战", "action": "loadout/equip", "listItem": true },
        { "dataId": "btn_wh_unequip", "label": "卸下", "action": "loadout/unequip", "listItem": true },
        { "dataId": "wh_card", "label": "物品卡（选中看详情）", "action": "wh/select", "listItem": true },
        { "dataId": "btn_wh_assemble", "label": "装配插件（开抽屉）", "action": "modal/open", "payload": { "modal": "assemble" } },
        { "dataId": "btn_wh_slot", "label": "按槽位装配/卸下", "action": "modal/open", "listItem": true },
        { "dataId": "btn_asm_pick", "label": "装入", "action": "assembly/run", "listItem": true },
        { "dataId": "btn_asm_take", "label": "卸下", "action": "assembly/take", "listItem": true },
        { "dataId": "btn_asm_close", "label": "关闭", "action": "modal/close" },
        { "dataId": "btn_wh_panel", "label": "查看面板", "action": "panel/refresh" },
        { "dataId": "wh_filter", "label": "按名称筛选", "action": "wh/filter", "control": "text" },
        { "dataId": "btn_go_gacha", "label": "去开箱", "action": "goto", "payload": { "screen": "gacha" } }
      ] },
    { "id": "editor", "title": "AI 编辑器",
      "buttons": [
        { "dataId": "editor_tree_node", "label": "结构树节点", "action": "editor/select", "listItem": true },
        { "dataId": "editor_add", "label": "添加子节点", "action": "editor/add", "listItem": true },
        { "dataId": "editor_del", "label": "删除节点", "action": "editor/remove", "listItem": true },
        { "dataId": "editor_field", "label": "节点字段", "action": "editor/set", "control": "mixed" },
        { "dataId": "btn_ed_preset", "label": "预设", "action": "editor/preset", "listItem": true },
        { "dataId": "btn_ed_validate", "label": "校验", "action": "editor/validate" },
        { "dataId": "btn_ed_compile", "label": "编译", "action": "editor/compile" },
        { "dataId": "btn_ed_apply", "label": "应用到出战配置", "action": "editor/apply" },
        { "dataId": "btn_ed_import", "label": "导入 JSON", "action": "editor/json" },
        { "dataId": "btn_ed_export", "label": "导出 JSON", "action": "editor/export" },
        { "dataId": "btn_ed_back_menu", "label": "返回主菜单", "action": "goto", "payload": { "screen": "menu" } },
        { "dataId": "editor_err", "label": "错误行", "action": "editor/highlight", "listItem": true }
      ] },
    { "id": "battle", "title": "对战与排位",
      "buttons": [
        { "dataId": "battle_mode", "label": "模式", "action": "battle/mode", "listItem": true },
        { "dataId": "battle_opp", "label": "对手", "action": "battle/opponent", "listItem": true },
        { "dataId": "btn_battle_run", "label": "开始对战", "action": "battle/run" },
        { "dataId": "btn_battle_replay_last", "label": "查看上一次回放", "action": "goto", "payload": { "screen": "replay" } },
        { "dataId": "btn_battle_clear", "label": "清空战报", "action": "battle/clear" },
        { "dataId": "btn_panel_refresh", "label": "刷新面板", "action": "panel/refresh" },
        { "dataId": "btn_ranked_run", "label": "开始排位", "action": "ranked/run" },
        { "dataId": "btn_ranked_promote", "label": "晋升", "action": "ranked/promote" },
        { "dataId": "btn_go_wh_from_battle", "label": "去仓库", "action": "goto", "payload": { "screen": "warehouse" } },
        { "dataId": "btn_go_ed_from_battle", "label": "去编辑器", "action": "goto", "payload": { "screen": "editor" } }
      ] },
    { "id": "replay", "title": "回放与结算",
      "buttons": [
        { "dataId": "btn_rp_play", "label": "播放", "action": "replay/play" },
        { "dataId": "btn_rp_pause", "label": "暂停", "action": "replay/pause" },
        { "dataId": "btn_rp_prev", "label": "上一帧", "action": "replay/step", "payload": { "delta": -1 } },
        { "dataId": "btn_rp_next", "label": "下一帧", "action": "replay/step", "payload": { "delta": 1 } },
        { "dataId": "btn_rp_speed_1", "label": "×1", "action": "replay/speed", "payload": { "speed": 1 } },
        { "dataId": "btn_rp_speed_2", "label": "×2", "action": "replay/speed", "payload": { "speed": 2 } },
        { "dataId": "btn_rp_speed_4", "label": "×4", "action": "replay/speed", "payload": { "speed": 4 } },
        { "dataId": "rp_tick", "label": "时间轴", "action": "replay/seek", "control": "range" },
        { "dataId": "rp_event_filter", "label": "事件通道筛选", "action": "replay/filter", "control": "select" },
        { "dataId": "rp_trace_owner", "label": "轨迹归属筛选", "action": "replay/trace-owner", "control": "select" },
        { "dataId": "btn_rp_menu", "label": "返回菜单", "action": "goto", "payload": { "screen": "menu" } },
        { "dataId": "btn_rp_again", "label": "再来一局", "action": "battle/run" },
        { "dataId": "btn_rp_settle_close", "label": "继续查看", "action": "modal/close" },
        { "dataId": "btn_go_battle", "label": "去对战", "action": "goto", "payload": { "screen": "battle" } }
      ] },
    { "id": "settings", "title": "设置",
      "buttons": [
        { "dataId": "btn_set_export", "label": "导出存档", "action": "save/export" },
        { "dataId": "btn_set_import", "label": "导入存档", "action": "save/import", "control": "file" },
        { "dataId": "btn_set_reset", "label": "清空存档", "action": "save/reset" },
        { "dataId": "set_level", "label": "日志级别", "action": "settings/log-level", "control": "select" },
        { "dataId": "set_ch", "label": "通道级别", "action": "settings/log-channel", "listItem": true },
        { "dataId": "set_filter", "label": "日志筛选", "action": "settings/log-filter", "control": "text" },
        { "dataId": "btn_log_export", "label": "导出日志", "action": "log/export" },
        { "dataId": "btn_log_clear", "label": "清空日志", "action": "log/clear" },
        { "dataId": "btn_set_reboot", "label": "重新连接", "action": "retry_boot" }
      ] },
    { "id": "shell", "title": "顶栏（常驻）",
      "buttons": [
        { "dataId": "top_tier", "label": "段位", "action": "tier/set", "control": "select" },
        { "dataId": "top_seed", "label": "种子", "action": "seed/set", "control": "text" },
        { "dataId": "top_seed_rand", "label": "随机种子", "action": "seed/random" },
        { "dataId": "top_quick", "label": "快速对战", "action": "battle/run" },
        { "dataId": "top_wh", "label": "仓库", "action": "goto", "payload": { "screen": "warehouse" } },
        { "dataId": "top_settings", "label": "设置", "action": "goto", "payload": { "screen": "settings" } }
      ] }
  ],
  "actions": [
    { "type": "goto", "effect": false, "desc": "切屏（离屏清理）" },
    { "type": "retry_boot", "effect": true, "desc": "重跑启动探测" },
    { "type": "tier/set", "effect": true, "desc": "写段位 + 重取 unlock + 持久化" },
    { "type": "seed/set", "effect": true, "desc": "写种子 + 持久化" },
    { "type": "seed/random", "effect": true, "desc": "随机种子（UI 层 random）" },
    { "type": "gacha/tier", "effect": false, "desc": "开箱段位" },
    { "type": "gacha/times", "effect": false, "desc": "开箱次数 clamp" },
    { "type": "gacha/roll", "effect": true, "desc": "POST /box" },
    { "type": "gacha/select", "effect": false, "desc": "选中结果卡" },
    { "type": "wh/select", "effect": true, "desc": "选中物品（顺带刷新面板）" },
    { "type": "wh/tab", "effect": false, "desc": "切换桶页签" },
    { "type": "wh/filter", "effect": false, "desc": "清筛选" },
    { "type": "loadout/equip", "effect": true, "desc": "填出战位 + 持久化 + 面板" },
    { "type": "loadout/unequip", "effect": true, "desc": "清出战位 + 持久化 + 面板" },
    { "type": "modal/open", "effect": false, "desc": "打开弹窗" },
    { "type": "modal/close", "effect": false, "desc": "关闭弹窗" },
    { "type": "assembly/run", "effect": true, "desc": "POST /warehouse/assemble" },
    { "type": "assembly/take", "effect": true, "desc": "POST /warehouse/disassemble" },
    { "type": "panel/refresh", "effect": true, "desc": "POST /panel" },
    { "type": "editor/select", "effect": false, "desc": "选中节点" },
    { "type": "editor/set", "effect": true, "desc": "改字段 + 防抖校验" },
    { "type": "editor/add", "effect": true, "desc": "插入节点 + 校验" },
    { "type": "editor/remove", "effect": true, "desc": "删除节点 + 校验" },
    { "type": "editor/preset", "effect": true, "desc": "套用预设 + 校验" },
    { "type": "editor/json", "effect": true, "desc": "导入 JSON 文本" },
    { "type": "editor/validate", "effect": true, "desc": "POST /ai/validate" },
    { "type": "editor/compile", "effect": true, "desc": "POST /ai/compile" },
    { "type": "editor/apply", "effect": true, "desc": "写入 loadout.ai" },
    { "type": "editor/highlight", "effect": true, "desc": "按 path 高亮节点" },
    { "type": "editor/export", "effect": true, "desc": "下载程序 JSON" },
    { "type": "battle/mode", "effect": false, "desc": "切换演练/对战模式" },
    { "type": "battle/opponent", "effect": false, "desc": "选择示例对手" },
    { "type": "battle/run", "effect": true, "desc": "起战（按模式选端点）" },
    { "type": "battle/clear", "effect": false, "desc": "清空战报" },
    { "type": "replay/play", "effect": true, "desc": "开始播放定时器" },
    { "type": "replay/pause", "effect": true, "desc": "停止播放定时器" },
    { "type": "replay/step", "effect": false, "desc": "步进 ±1" },
    { "type": "replay/speed", "effect": true, "desc": "倍速（播放中重启定时器）" },
    { "type": "replay/seek", "effect": false, "desc": "跳到指定 tick 并暂停" },
    { "type": "replay/filter", "effect": false, "desc": "事件通道筛选" },
    { "type": "replay/trace-owner", "effect": false, "desc": "轨迹归属筛选" },
    { "type": "ranked/run", "effect": true, "desc": "POST /ranked/run" },
    { "type": "ranked/promote", "effect": true, "desc": "POST /ranked/promote" },
    { "type": "save/export", "effect": true, "desc": "下载存档" },
    { "type": "save/import", "effect": true, "desc": "导入存档文本" },
    { "type": "save/reset", "effect": true, "desc": "清空存档" },
    { "type": "settings/log-level", "effect": true, "desc": "设全局级别" },
    { "type": "settings/log-channel", "effect": true, "desc": "设通道级别" },
    { "type": "settings/log-filter", "effect": false, "desc": "设日志筛选文本" },
    { "type": "log/export", "effect": true, "desc": "下载日志" },
    { "type": "log/clear", "effect": true, "desc": "清空日志缓冲" },
    { "type": "toast/close", "effect": false, "desc": "关闭单条 toast" }
  ],
  "screensRequired": ["menu", "gacha", "warehouse", "editor", "battle", "replay", "settings"],
  "controls": {
    "tiers": ["common", "rare", "epic", "legendary", "mythic"],
    "opponents": ["kiter", "charger"],
    "qualities": ["common", "rare", "epic", "legendary", "mythic"],
    "aiNodes": ["seq", "literal", "get", "var", "set", "getVar", "arith", "cmp", "logic", "random", "if", "loop", "break", "function", "call", "action"],
    "actionNames": ["move_left", "move_right", "dodge_left", "dodge_right", "wait", "defend", "turn"],
    "skillActions": ["skill:skill1", "skill:skill2", "skill:skill3"],
    "channels": ["store", "view", "api", "render", "editor"]
  },
  "dataFields": [
    { "sample": "battle2_frame_with_hit", "path": "diff.bulletHits[0].uid" },
    { "sample": "battle2_frame_with_hit", "path": "diff.bulletHits[0].target" },
    { "sample": "battle2_frame_with_hit", "path": "diff.bulletHits[0].atX" },
    { "sample": "battle_frame_first", "path": "diff.players.p1.fromX" },
    { "sample": "battle_frame_first", "path": "diff.players.p1.toX" },
    { "sample": "battle_frame_first", "path": "diff.players.p1.facing" },
    { "sample": "battle_frame_first", "path": "diff.players.p1.hp" },
    { "sample": "battle_frame_first", "path": "diff.players.p2.mp" },
    { "sample": "battle_frame_first", "path": "diff.players.p2.sp" },
    { "sample": "battle_frame_first", "path": "diff.bullets[0].uid" },
    { "sample": "battle_frame_first", "path": "diff.bullets[0].owner" },
    { "sample": "battle_frame_first", "path": "diff.bullets[0].type" },
    { "sample": "battle_frame_first", "path": "diff.bullets[0].level" },
    { "sample": "battle_frame_first", "path": "diff.bullets[0].dir" },
    { "sample": "battle_frame_first", "path": "diff.bullets[0].x" },
    { "sample": "battle_frame_first", "path": "diff.bullets[0].len" },
    { "sample": "battle_frame_first", "path": "diff.bullets[0].v" },
    { "sample": "battle_frame_first", "path": "diff.bases.p1.hp" },
    { "sample": "battle_frame_first", "path": "diff.bases.p2.def" },
    { "sample": "battle_frame_first", "path": "diff.aiTrace[0].path" },
    { "sample": "battle_frame_first", "path": "diff.aiTrace[0].nodeType" },
    { "sample": "battle_frame_first", "path": "diff.aiTrace[0].result" },
    { "sample": "battle_frame_first", "path": "diff.aiTrace[0].owner" },
    { "sample": "battle_frame_first", "path": "diff.events[0].event" },
    { "sample": "battle_frame_first", "path": "diff.events[0].cid" },
    { "sample": "battle_frame_first", "path": "diff.events[0].channel" },
    { "sample": "battle_frame_first", "path": "diff.events[0].level" },
    { "sample": "battle2_frame_with_collision", "path": "diff.collision.contactX" },
    { "sample": "battle2_frame_with_collision", "path": "diff.collision.t" },
    { "sample": "battle2_frame_verdict", "path": "diff.verdict.winner" },
    { "sample": "battle2_frame_verdict", "path": "diff.verdict.phase" },
    { "sample": "battle2_frame_verdict", "path": "tick" },
    { "sample": "battle_valid_meta", "path": "data.id" },
    { "sample": "battle_valid_meta", "path": "data.seed" },
    { "sample": "battle_valid_meta", "path": "data.tier" },
    { "sample": "battle_valid_meta", "path": "data.winner" },
    { "sample": "battle_valid_meta", "path": "data.phase" },
    { "sample": "battle_valid_meta", "path": "data.ticks" },
    { "sample": "box_10_mythic", "path": "data.seed" },
    { "sample": "box_10_mythic", "path": "data.times" },
    { "sample": "box_10_mythic", "path": "data.items[0].uid" },
    { "sample": "box_10_mythic", "path": "data.items[0].kind" },
    { "sample": "box_10_mythic", "path": "data.items[0].name" },
    { "sample": "box_10_mythic", "path": "data.items[0].quality" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.role[0].uid" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.role[0].templateId" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.role[0].slots[0].type" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.role[0].slots[0].pluginUid" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.role[0].stats.hp" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.role[0].pluginPoints" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.skill[0].params.cooldown" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.skill[0].params.cost.mp" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.rolePlugin[0].id" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.rolePlugin[0].slot" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.rolePlugin[0].pointCost" },
    { "sample": "warehouse_raw_shape", "path": "data.buckets.skillPlugin[0].costDeltaByTier.mp" },
    { "sample": "assemble_equipped_plugin_shape", "path": "data.plugin.equipped" },
    { "sample": "assemble_error_occupied", "path": "error.code" },
    { "sample": "assemble_error_type", "path": "error.message" },
    { "sample": "disassemble_error_empty", "path": "error.code" },
    { "sample": "panel_valid", "path": "data.panel.role.stats.hp" },
    { "sample": "panel_valid", "path": "data.panel.role.regen.sp" },
    { "sample": "panel_valid", "path": "data.panel.role.pluginPoints" },
    { "sample": "panel_valid", "path": "data.panel.role.quality" },
    { "sample": "panel_valid", "path": "data.panel.skills[0].templateId" },
    { "sample": "panel_valid", "path": "data.panel.skills[0].uid" },
    { "sample": "panel_valid", "path": "data.panel.skills[0].params.multiplier" },
    { "sample": "loadout_invalid", "path": "error.details[0].where" },
    { "sample": "loadout_invalid", "path": "error.details[0].message" },
    { "sample": "ai_validate_invalid", "path": "error.details[0].path" },
    { "sample": "ai_validate_invalid", "path": "error.details[0].code" },
    { "sample": "ai_compile_ok", "path": "data.programHash" },
    { "sample": "ai_compile_ok", "path": "data.stats.nodes" },
    { "sample": "ai_compile_ok", "path": "data.stats.depth" },
    { "sample": "ranked_run", "path": "data.wins" },
    { "sample": "ranked_run", "path": "data.draws" },
    { "sample": "ranked_run", "path": "data.losses" },
    { "sample": "ranked_run", "path": "data.invalids" },
    { "sample": "ranked_run", "path": "data.promoted" },
    { "sample": "ranked_run", "path": "data.results[0].match" },
    { "sample": "ranked_run", "path": "data.results[0].winner" },
    { "sample": "ranked_run", "path": "data.results[0].ticks" },
    { "sample": "ranked_promote_7", "path": "data.promoted" },
    { "sample": "ranked_promote_7", "path": "data.reward" },
    { "sample": "ranked_promote_max", "path": "error.code" },
    { "sample": "unlock_common", "path": "data.nodes" },
    { "sample": "unlock_common", "path": "data.roleTemplates" },
    { "sample": "unlock_common", "path": "data.skills" },
    { "sample": "unlock_common", "path": "data.plugins" },
    { "sample": "health", "path": "data.version" },
    { "sample": "data_battle_config", "path": "data.fieldPx" },
    { "sample": "data_battle_config", "path": "data.cellPx" },
    { "sample": "data_battle_config", "path": "data.actorHalfPx" },
    { "sample": "data_battle_config", "path": "data.baseDef" },
    { "sample": "data_qualities", "path": "data.qualities[0].id" },
    { "sample": "data_qualities", "path": "data.qualities[0].color" },
    { "sample": "data_skill_templates", "path": "data.skillTemplates[0].id" },
    { "sample": "data_skill_templates", "path": "data.skillTemplates[0].name" },
    { "sample": "data_role_templates", "path": "data.roleTemplates[0].id" },
    { "sample": "data_plugins", "path": "data.plugins[0].id" },
    { "sample": "data_plugins", "path": "data.plugins[0].slot" },
    { "sample": "err_bad_tier", "path": "error.code" },
    { "sample": "err_unknown_table", "path": "error.details[0]" }
  ]
}
```

---

## §16 服务端静态托管（P6 唯一后端改动）

| 路由 | 目录 | 说明 |
|---|---|---|
| `GET /` 与 `GET /index.html` | `public/index.html` | `text/html; charset=utf-8` |
| `GET /css/*` | `public/css/*` | `text/css` |
| `GET /js/*` | `public/js/*` | `text/javascript` |
| `GET /shared/log.js` | `shared/log.js` | 前端复用 UMD 日志 |
| `GET /assets/*` | `assets/*` | 占位美术表（可选） |

- 优先级：`/api/v1/*` → 其它已注册路由 → 静态 → 404 `unknown_endpoint`。
- 安全：解析后必须落在白名单目录内（拒绝 `..` 与绝对路径）；命中目录 → 404；未知扩展名 → `application/octet-stream`。
- 不改动任何既有 API 行为（`npm run gate` 项 9 仍须全绿）。

---

## §17 测试与验收

| 测试文件 | 断言（必须覆盖） |
|---|---|
| `tests/frontend/fe-spec.test.js` | 跑 `scripts/fe-spec-check.js` 的 `checkSpec()`：注册表 ↔ 动作表 ↔ 真实样本字段 ↔ 源码取值（C1–C9）全绿（另有 5 个"投毒"用例证明检查器非空转） |
| `tests/frontend/reducer.test.js` | §4.2 七条不变量；每个动作至少一例（含"被拒"路径：busy 双击、越界 clamp、技能位已满） |
| `tests/frontend/effects.test.js` | 假 api 注入：每屏动作的成功/失败两路；错误 code → toast 文案；timeout/network 归一；`battle/run` 两模式端点与请求体形状 |
| `tests/frontend/views.test.js` | 七屏四态各一次；每屏渲染结果中每个 `data-action` ∈ 动作表；`data-id` 无重复；空态必含引导按钮 |
| `tests/frontend/frame.test.js` | `frameAt(frames,tick)` 累积规则（含 tick=0、末帧、缺 bases）；`planFrame` 图元整数化；碰撞/命中/结算三态 |
| `tests/frontend/editor.test.js` | 16 类节点表单元数据完整；预设程序通过 `/ai/validate`（用**离线** ast 模块直接校验，不走网络）；错误 path → 节点定位 |
| `tests/frontend/persist.test.js` | 往返一致；坏档拒绝；版本不符迁移/丢弃 |

**人工验收（必须做，机器测不出"能不能玩"）**：
1. `npm start` → 浏览器开 `http://127.0.0.1:3000` → 按 §2.1 剧本走 14 步，逐条核对"期望"列。
2. 每屏截图（`docs/screens/`）：确认没有文字重叠、按钮可点、空态有引导。
3. F12 控制台：`__DL__.exportLog()` 导出的日志里应能看到 `api.req/api.res` 与 `view.click` 成对出现（点击不丢）。⏳ **注**：`ui.click` 属**未来新增通道（未实现）**，现行正确通道是已注册的 `view`（§13.1）。

---

## §18 实施批次（每批一个提交 + 可运行的验收动作）

| 批 | 内容 | 出口（可运行） |
|---|---|---|
| **F1** | 静态托管（§16）+ `index.html`/tokens/app.css + `store`（reducer/persist）+ `api/client` + `mount` 事件委托 + `shell` 顶栏 | 浏览器打开能看到顶栏；点段位下拉切段位；`npm test` 绿 |
| **F2** | `menu` + `gacha` 两屏（含四态） | 剧本 1–2 步可跑：开箱得到物品并入库 |
| **F3** | `warehouse`（页签/卡片/槽位/装配抽屉/点数预算/出战/面板） | 剧本 3–6 步可跑 |
| **F4** | `editor`（结构树 + 表单 + 预设 + 校验/编译/应用 + JSON 导入导出） | 剧本 7 步可跑；非法程序错误列表可点 |
| **F5** | `battle`（两模式 + 排位） | 剧本 8、13 步可跑；请求体形状与样本一致 |
| **F6** | `replay`（战场渲染 + HUD + 控制条 + 结算 + 事件/轨迹栏） | 剧本 9–12 步可跑；末帧才弹结算 |
| **F7** | `settings` + 存档导出导入 + 日志面板 + 收尾（截图核对、`fe-spec-check` C9 生效） | 剧本 14 步可跑；`npm test` + `npm run gate` 全绿 |

**每批必做**：`node scripts/fe-spec-check.js`（文档与实现一致性）+ `npm test`；F7 收口时补 `docs/screens/*.png` 与 `docs/progress.md` 状态更新。

---

## §19 反例清单（旧实现踩过的坑，一律禁止）

| 禁止 | 原因 |
|---|---|
| `layout(state) → Box[]` + JS 注入 `left/top` | R1/R2：注入缺失即全屏不可见，且坐标靠人算必重叠 |
| 视图里写 `data-action` 但动作表没有该键 | R4：死按钮 |
| 弹层条件用"字段有值"判断 | R3：恒有值 → 永远遮罩 |
| 渲染读文档散文里的字段名（如 `t.name`） | R5/R6：字段名不存在 → 空白 UI |
| 前端复制战斗公式（伤害/命中/移动） | 与后端漂移，回放不一致 |
| 视图层直接 `fetch` / 直接写 DOM | 破坏单一出口/单一写入点，无法无头测 |
| Blockly 或任何需要 DOM 布局的第三方编辑器 | R8：不可测、两轮失败 |
| 用 `JSON.parse(dataset.payload)` 传复合参数 | 转义/引号问题高发；改扁平 `data-*` |
| 硬编码品质色/段位列表/战斗数值 | 与数据表漂移；一律读 `/data/*` 或 `unlock` |
| 中文文档用 PowerShell 5.1 读写 | 铁律 L17：双重编码损坏 |

---

## 附录 A 真实样本（前端字段名的唯一依据）

采样器：`.audit/fe-samples.js`，产物：`.audit/fe-samples.json`（58 个样本，全部来自活体 HTTP 响应，`seed=20260912`）。
**样本过期时重跑**：`node .audit/fe-samples.js`（涉及端口 0 临时监听，不影响正在运行的服务）。

下面是前端实际消费的**逐字样本**（字段名与 §6 完全一致）：

```jsonc
// A1 GET /api/v1/health → data
{ "status": "ok", "version": "3.0.0" }

// A2 GET /api/v1/unlock?tier=common → data（节选）
{ "tier": "common",
  "nodes": ["seq","literal","get","var","set","getVar","arith","cmp","action","if"],
  "roleTemplates": ["role_bal"],
  "skills": ["skill_melee_whirl","skill_straight_precise"],
  "plugins": ["rp_atk_pct","rp_atk_flat", "…共 27 项"] }

// A3 POST /api/v1/box {seed:20260912,tier:'mythic',times:12} → data.items[0..2]
[ { "uid":"item_0","kind":"rolePlugin","id":"rp_crit","name":"暴击","desc":"暴击率 +8%…",
    "slot":"special","category":"暴击","quality":"common","tier":1,
    "affixes":[{"id":"crit_chance","desc":"暴击率 +8%","params":{"v":0.07}}],"pointCost":1 },
  { "uid":"item_4","kind":"skill","templateId":"skill_straight_poison","name":"毒瓶","quality":"epic",
    "slotCount":3,"slots":[{"type":"basic","pluginUid":null},{"type":"basic","pluginUid":null},{"type":"basic","pluginUid":null}],
    "params":{"multiplier":0.63,"cost":{"hp":0,"mp":6,"sp":0},"cooldown":5,"bulletLevel":4,
              "range":6,"bulletCount":1,"falloff":0},"unlockTier":"epic" } ]

// A4 POST /api/v1/warehouse/assemble → data（成功）
{ "warehouse": { "buckets": { "role": [{ "uid":"item_demo_role","kind":"role","templateId":"role_bal",
    "name":"均衡","quality":"rare","slotCount":2,
    "slots":[{"type":"atk","pluginUid":"item_9"},{"type":"special","pluginUid":null}],
    "stats":{"hp":100,"atk":10,"def":8,"sp":60,"mp":40},"regen":{"mp":1,"sp":2},
    "unlockTier":"common","pluginPoints":4 }],
  "rolePlugin":[{ "uid":"item_9","kind":"rolePlugin","id":"rp_atk_pct","name":"攻击提升·百分比",
    "slot":"atk","category":"攻击提升","quality":"rare","tier":3,
    "affixes":[{"id":"atk_pct","desc":"攻击 +8%…","params":{"v":0.1}}],"pointCost":3,"equipped":true }],
  "skill": [], "skillPlugin": [] } } }

// A5 装配/拆卸失败（HTTP 409 / 404，error 形状）
{ "ok": false, "error": { "code": "points_exceeded", "message": "点数超限: 3+3 > 4", "details": [] } }
{ "ok": false, "error": { "code": "slot_type_mismatch", "message": "插件槽 special ≠ 插槽 atk", "details": [] } }
{ "ok": false, "error": { "code": "slot_empty", "message": "槽位为空: item_demo_role[1]", "details": [] } }

// A6 POST /api/v1/panel → data.panel
{ "role": { "stats":{"hp":100,"atk":10,"def":8,"sp":60,"mp":40}, "special":{},
            "regen":{"mp":1,"sp":2}, "pluginPoints":4, "quality":"rare" },
  "skills": [ { "templateId":"skill_straight_poison","uid":"item_4",
                "params":{"multiplier":0.63,"cost":{"hp":0,"mp":6,"sp":0},"cooldown":5,
                          "bulletLevel":4,"range":6,"bulletCount":1,"falloff":0} } ] }

// A7 POST /api/v1/loadout 失败（409）
{ "ok": false, "error": { "code":"loadout_invalid", "message":"出战配置不合法",
  "details":[{"where":"skills","code":"loadout_invalid","message":"技能必须恰 3 个（实际 2）"}] } }

// A8 POST /api/v1/ai/validate 失败（400）
{ "ok": false, "error": { "code":"ai_invalid", "message":"AI 程序不合法",
  "details":[{ "path":"body.s[0].body.s[0].else", "code":"branch_without_action",
               "message":"if 的 else 分支必须包含 action（缺 else 视为空分支）" }] } }

// A9 POST /api/v1/ai/compile → data
{ "programHash":"f4231617b7e667bffda95248a37e3ffeb97b6d765c8d6a82a21049ae24bc1ad8",
  "version":2, "migrated":false, "stats":{ "nodes":3, "depth":2, "usedNodeTypes":["seq","action"] } }

// A10 POST /api/v1/battle → data（节选：meta + 首帧 + 命中帧 + 碰撞帧 + 末帧）
{ "id":"r2","seed":7,"tier":"mythic","winner":"p1","phase":"role","ticks":16,
  "frames":[
    { "tick":1, "diff":{
        "players":{"p1":{"fromX":224,"toX":224,"facing":1,"hp":100,"mp":35,"sp":60},
                   "p2":{"fromX":800,"toX":736,"facing":-1,"hp":100,"mp":40,"sp":60}},
        "bullets":[{"uid":"b_0","owner":"p1","type":"straight","level":4,"dir":1,"x":224,"len":384,"v":384}],
        "bases":{"p1":{"hp":100,"def":64},"p2":{"hp":100,"def":64}},
        "events":[{"seq":1,"ts":0,"cid":"t1:1","tick":1,"level":"info","levelValue":3,
                   "channel":"engine","event":"tick.begin","msg":"tick 1","data":{}}, "…共 16 条/帧"],
        "aiTrace":[{"tick":1,"owner":"p1","seq":0,"path":"body.s[0]","nodeType":"action",
                    "phase":"eval","depth":1,"result":"skill:skill1"}],
        "collision":null, "bulletHits":[], "verdict":null } },
    { "tick":1, "diff":{ "…":"命中帧（同一 tick 也可能有命中）",
        "bulletHits":[{"uid":"b_0","target":"p2","atX":736}] } },
    { "tick":9, "diff":{ "collision":{"contactX":256,"t":0}, "bulletHits":[], "verdict":null } },
    { "tick":16, "diff":{ "bullets":[], "collision":{"contactX":256,"t":0},
        "bulletHits":[], "verdict":{"winner":"p1","phase":"role"},
        "events":[ "…尾部含 battle.end / tick.end" ] } } ] }

// A11 GET /api/v1/replay/r1?from=1&to=2 → data
{ "id":"r1","seed":20260912,"winner":"p1","phase":"role","ticks":23,"frames":[ /* 2 帧，形状同 A10 */ ] }

// A12 POST /api/v1/ranked/run → data
{ "tier":"common","seed":11,"matches":10,"wins":10,"draws":0,"losses":0,"invalids":0,"promoted":true,
  "results":[{"match":1,"winner":"p1","ticks":20}, "…共 10 条（winner ∈ p1|p2|draw|invalid）"] }

// A13 POST /api/v1/ranked/promote → data / 失败
{ "tier":"rare","promoted":true,"reward":"rare","wins":7 }
{ "tier":"common","promoted":false,"reward":"common","wins":3 }
{ "ok":false,"error":{"code":"already_max","message":"mythic 已是最高段位","details":[]} }

// A14 通用错误信封
{ "ok":false,"error":{"code":"bad_tier","message":"非法段位 nope（可选: common/rare/epic/legendary/mythic）","details":[]} }
{ "ok":false,"error":{"code":"unknown_table","message":"未知数据表 nope",
                      "details":["可用表: animations, battle-config, items-config, plugins, qualities, role-templates, skill-templates, sprites, unlock"]} }
{ "ok":false,"error":{"code":"bad_times","message":"非法次数 999（必须是 1..100 的整数）","details":[]} }
{ "ok":false,"error":{"code":"bad_json","message":"请求体不是合法 JSON","details":[]} }

// A15 GET /api/v1/data/battle-config → data（前端只读；战场几何与判定阈值全从这里取）
{ "cellPx":64,"cells":16,"fieldPx":1024,"actorHalfPx":32,"minGapPx":64,"movePx":64,"dodgePx":128,
  "collisionDmgMul":0.8,"baseHitMul":0.8,"baseDef":64,"defendDefMul":1.6,"dodgeChanceBonus":0.2,
  "defK":40,"backstab":1.5,"crit":1.5,"overtimeStart":48,"overtimeRatio":0.0625,"hardCapTick":64,
  "startX":{"p1":224,"p2":800},"startFacing":{"p1":1,"p2":-1},
  "bases":{"p1":{"range":[-64,0],"hp":100,"maxHp":100,"def":64},
           "p2":{"range":[1024,1088],"hp":100,"maxHp":100,"def":64}} }
```

> 二次核对提示：A10/A11 的帧字段是渲染层唯一输入；任何"帧里没有但我需要"的字段，必须改后端契约（`docs/interfaces.md` §4）而不是在前端推算（R6 的根因就是"文档没核对就照着写"）。
