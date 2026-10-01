# F5 · AI 编辑器（查看 / 新建 / 编辑 / 删除）设计

> 版本：**v2 交付版（2026-09-25）**　状态：**设计已按用户裁决收口（§0.1 的 11 条）且已实现（§15 实现对账）**；四项定稿判定与走查结论仍须由 `docs/reviews/F5.md`（独立上下文）出具，**本分册不自署"全过"**（总纲 §2.10）。
> 批次：**`F5`**（`format.js` 的 `EMPTY_PAGES` 已登记 `'ai-editor': { batch: 'F5' }`；按 FR-6，**不并入 §6 的「共 41 批」**）。
> 分册文件名 `06-ai-editor.md` 的序号 **06 ≠ 批次号 F5**：`01`–`05` 已被 F1/F2/F3/F6/F7 占用，故取下一个空号。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md` > `docs/frontend/*`。
> 上级依据：`00-rules.md`（§1 绘制边界 / §1.4 绘制零逻辑 / §1.5 投影单一真源 + 禁抄战斗公式 / §2 反驳协议 / §4 验收机制）；`docs/systems/08-ai.md`（AI 语言、校验、快照、trace）；`server/ai/ast.js`（字段表/枚举/上限，**唯一实现真源**）；`docs/decisions.md` **D-80 / D-124 / D-137 / D-145 / D-146 / D-161 / D-162**；`docs/frontend/03-hub-warehouse-loadout.md` §3.7/§9.3（配置弹窗的 `ai-pick` 既成口径）。
> 本文中凡标 **⏳ 未实现** 的，是"设计已写、代码 0 行"；凡标 **✅ 现状** 的，是本轮读码核实的既有能力。

---

## 0. 一句话定位

把 `ai-editor` 空页变成**表单式 AST 编辑器**：左侧程序树（文本行 + 稳定路径 + 本帧执行标记），右侧/下方是**当前选中节点的字段表单**与结构按钮；配 `GET|POST|DELETE /me/ai`（✅ 现状）与**新增的 `PUT /me/ai/:aiId`（⏳ 未实现）**完成查看 / 新建 / 编辑 / 删除闭环。

---

## 0.1 已裁决（v2，2026-09-25，用户逐条拍板）

> 本节的 11 条**已定**，不再开放讨论；实现与本分册其余章节都必须服从本节。原 §7 的"待裁决"表已按本节改写。

| # | 议题 | 裁决 |
|---|---|---|
| 1 | 编辑保存的服务端形态 | **后端新增 `PUT /me/ai/:aiId`**；`aiId` 不变，正在被配置引用的也能改 |
| 2 | 编辑界面形式 | **表单式**（点节点、改字段） |
| 3 | 多行输入框 | **只用于"导入 JSON"**；导出用只读文本行（不新增控件） |
| 4 | 代码放哪 | **新增 `public/ai-editor.js`（第 10 个文件）**；同步更新 `UW-1`/`UI-1` 的"恰好 9 文件"断言与 §1 分层叙述 |
| 5 | `skill:` 下拉 | **只给 `skill:skill1` / `skill:skill2` / `skill:skill3`**（⚠️ **2026-09-25 更正**：引擎的 `p.skills` 键是 `skill1..3`，`engine.js:401` 用 `p.skills[intent.sid]` 查找，`battle.js:42` 注释即写 `skill:skillN`；`skill:1` 会查不到 → 运行期空行动。证据：`tests/unit/play.test.js:78` 断言 `/^skill:skill[123]$/`、`api-ai-battle-skills.test.js:50`） |
| 6 | 段位门控 | **不置灰**（与 D-137「门控默认关闭」一致） |
| 7 | 试打一场 | **本批不做**（不接 `/ai/battle`） |
| 8 | `function` 重名 | **编辑器直接禁止同名**（前端自行扫描；注意：比后端"后定义覆盖"更严，见 R-4） |
| 9 | 校验时机 | **编辑期"有修改就校验一次"并逐个标出问题；校验不通过禁止保存** |
| 10 | 校验接口 | **两个都做**：① 新增登录版实时校验接口；② **保存接口自身也校验**（硬闸门，防绕过界面直接调接口） |
| 11 | 草稿 | **存到服务器，带「草稿」标记**；占一个库位（≤100）；**不能被配置选中**；校验通过后才能转正式 |

### 0.2 两条读码新事实（裁决后补充，实现必须遵守）

**F-1｜`loadout.ai` 是程序**正文副本**，不是引用。**
`archive.loadoutMissingOf` 要求 `loadout.ai` 为对象（`archive.js:153`）；`runtime.createContext(ld.ai)` 直接用这份正文（`battle.js:35`）；快照冻结的也是它（`snapshot-store.js:26-34`）。`loadout.aiId` 只是**来源标记**（`ai_in_use` 判定依据，`adapter-json.js:1199`）。后果两条：
- ✅ **改 AI 不会改写历史回放**（回放按需重算用的是快照里的正文，内容寻址）。
- ⚠️ **已保存的配置不会自动升级**——用户必须在配置编辑器里**重新选一次**该 AI 才会用上新版本。→ 编辑态在"被配置引用"时必须显示这句话（否则用户会以为改完就生效）。

**F-2｜保存配置时服务端**不校验** `loadout.aiId` 是否存在于库中。**
全仓 `aiId` 只出现在 `starter` / `aiBrief` / `createAi` / `deleteAi` / `usage` 计算处；`resolveLoadoutOf` 只解析**物品**（`account.js:293`）。后果：
- 本批的草稿护栏**只做"禁止引用库里存在的草稿"**这一条**窄**规则（不存在/伪造的 `aiId` 是**既存缺口**，不在本批扩大——登记进 `docs/security-backlog.md`）。

---

## 1. 用户口径与本批范围

| 能力 | 现状（读码实测） | 本批要做 |
|---|---|---|
| **查看 AI 逻辑** | ✅ F6 的 `ai-logic` 弹窗可渲染程序树 + 本帧执行标记 + 双方轨迹，但**只能看当前出战配置的 AI**（`GET /me/configs` → activeSlot → `loadout.ai`） | 看**库内任意** AI：树 + `programHash` + 统计 + 被哪些配置引用 |
| **保存** | ✅ `POST /me/ai`（命名保存，上限 100，满 → 409 `ai_limit`） | 接 UI（新建 / 另存为） |
| **编辑** | ❌ **后端无更新端点**（journal 只有 `ai.created` / `ai.deleted`，无 `ai.updated`） | **本批核心**；需新增 `PUT /me/ai/:aiId`（§7 D1） |
| **删除** | ✅ `DELETE /me/ai/:aiId`（被**出战**配置引用 → 409 `ai_in_use`；非出战引用只回 `referencedBy` 提示） | 接 UI + 屏内二次确认 + 引用提示 |
| **校验** | ✅ `POST /ai/validate`（错误带 `path`）、`POST /ai/compile`（`programHash` + `stats`）——**均属遗留端点**（§5.1） | **两处校验**：① 编辑期"有修改就校验一次"（走**新增的登录版校验接口**）；② **保存时服务端再校验一遍**（硬闸门）。不通过 → **禁止保存** |
| **草稿** | ❌ 不存在 | ✅ 新增：校验不过也能**暂存为草稿**（服务端带标记，占库位，不能被配置选中，通过校验后才转正式） |
| **试打** | ✅ `POST /ai/battle`（`opponent ∈ {kiter, charger}`，服务端重执行） | **本批不做**（裁决 ⑦） |
| **绑定到配置** | ✅ 配置弹窗 `ai-pick` / `ai-set`（F3 已交付） | **不动**（F5 不重做装配）；仅新增"**不得选中草稿**"的窄护栏（F-2） |

**非目标（本批显式不做）**：AST 的图形化/积木式编辑（D-124 禁 Blockly）；前端复制战斗公式或校验规则（§1.5）；自动保存 / 乐观更新（F1–F7 一致口径）；多语言 / 样式 / 动画（§1.1）；`/ranked`、`/me/records` 等其它屏。

### 1.1 与既有屏的关系

- `ai-editor` 已是 `store.VIEWS` 的成员（`public/store.js:22-25`），hub 已有 `goto-ai-editor` 入口（`format.js:2069`）——**本批只把空页换成真屏**。
- 配置弹窗的 `ai-pick` 是**选择器**（从库里挑一条绑到 `loadout.aiId`）；本编辑器是**维护器**（增删改库内容）。两者共用 `GET /me/ai`，但**不共用一个 state 切片**（沿用 F6 的教训：查看器与配置编辑器刻意分片，见 `store.js:99-101` 注释）。

---

## 2. 反驳（总纲 §2 协议：先驳再定）

> §2 要求"AI 反驳用户提案"，并给出**反例或后果**；提不出具体反例的不得提出。以下 5 条是本设计的取舍依据。

### R1 反驳"纯 JSON 文本框编辑器"（最省事的做法）——**不采**
- **与既定方向冲突**：`08-ai.md:46` 明写"现行前端方向为**表单式 AST 编辑器**"。
- **后果（控件面）**：需要解禁多行输入 `textarea`（`00-rules.md` O-3 明确"无多行输入（AI 编辑器分册再定）"）。引入它是本项目唯一没有的控件类型，等于给"在框里写代码"开口，下一步必然被要求语法高亮 / 自动补全，直接撞 §1.1「绘制手段封闭为按钮、文字、输入框」。
- **后果（可用性）**：程序上限是 **深度 32 / 节点 2000 / 256KB**（`ast.js` `LIMITS`）。改一个 `arith.op` 要在文本框里手工配对括号与缩进；校验错误只给 `path`（如 `body.s[2].then.s[0].expr`），在纯文本里无法定位。

### R2 反驳"图形积木 / 画布式编辑器"——**不采**
- `00-rules.md` §1.2/§1.3 禁止画布、精灵、动画；D-124 明确不引入 Blockly。**不再做第二遍论证**。

### R3 反驳"编辑器自己判断合法/非法"——**不采（前端不产生判决）**
- §1.5 与 `08-ai.md` §4.2 的分工是**服务端唯一判据**：`ai_invalid` + `details[].path`。
- **反例**：F3 已因"完整性判据双份实现"登记 **N-14**（`format.missingOf` vs `archive.loadoutMissingOf` 需逐字一致才不漂移）。若编辑器再复制一遍"分支是否含 action / 变量是否先声明 / 路径是否白名单"，必然再次漂移。
- **本设计的折中**：前端只做**候选集**（下拉/按钮可选值）与**控件可用性**，不输出任何"合法/非法"结论；一切拒绝文案来自服务端 `details`。候选集与 `ast.js` 的重复度登记为 **R-3**（§10）。

### R4 反驳"编辑即自动保存 / 乐观更新"——**不采**
- 全项目零乐观更新（F1–F7 一致：写操作一律等服务端 200）；且后端编辑端点尚不存在。→ 显式「保存」按钮 + `dirty` 标记 + 关闭前确认。

### R5 反驳"直接用运行时路径当编辑器地址"——**这是本设计最关键的技术约束**
- **事实（读码）**：`server/ai/runtime.js:383-386` 的 `walkChildren` 把节点的**所有表达式字段折叠成同一个 `.expr` 段**：
  ```js
  for (const k of ['value','left','right','cond','prob','times']) { ... cb(v, `${path}.expr`); }
  ```
  于是 `cmp` 的 `left` 与 `right`、`loop` 的 `times` 与 `cond`、`if` 的 `cond` 与它内部的 `left/right`，**路径完全相同**。
- **后果**：若编辑器用运行时路径定位"当前选中节点"，**改 `left` 会改到 `right`**（`cmp.left` 与 `cmp.right` 同为 `<node>.expr`）。
- **附带事实**：`ast.getNodeAtPath` 对 `.expr` 取"**首个**对象"（`ast.js:715-721`），而 `runtime.nodeAtPath` 对 `.expr` 走 `node['expr'] || null` → **返回 `null`**（`runtime.js:361`）。两者本就不一致，`ast.js:702-704` 已自记为登记缺陷（P2-4）。
- **本设计的三条处置**：
  1. 编辑器使用**自有字段限定地址**（§4.3），不复用运行时路径；
  2. 运行时路径**只**用于"本帧执行"标记，且**只标注语句/结构节点**（表达式位不标注）——这与 F6 既有查看器一致（`format.js:1439-1517` 的 `walkProgramNode` 只给语句/结构节点出行）；
  3. 不修改 `ast.js`/`runtime.js`（L5 属上游语义，§2.2 禁止以"更合理"为名侵蚀）→ 该不一致登记为 **R-1**。

### 2.1 用户裁决覆盖了我的建议（2 处，必须显式记账）

| 我的建议 | 用户裁决 | 后果与偿还方式 |
|---|---|---|
| R1：不解禁多行输入 | 裁决 ③：**引入多行输入框，仅限"导入 JSON"** | 这是 §1.1「控件封闭」的**唯一例外**，必须写进本分册的控件清单；机器核对 **AE-10** 断言 `<textarea` 只出现在 `ai-editor.js` 且只服务于导入 |
| R4：前端不产生任何"合法/非法"判决 | 裁决 ⑧：**编辑器禁止函数重名**（服务端亦于 D-172 起拒绝重名，两边**同严**） | 前端多了一条**判决**（仅 UI 层提示用）。登记 **R-4**；机器核对 **AE-5** 收窄为"除函数重名外不得有第二处前端判决" |

---

## 3. 屏与交互（`ai-editor`，两态同屏）

沿用既有约定：屏内模式由 `state.aiEditor.mode` 决定；**弹窗/确认一律用屏内区块**（FR-10），点背景 = 取消并丢弃未提交输入。

### 3.1 列表态（`mode:'list'`，默认）

- **文本行**：`AI 库：N/100`；每条 AI 一行：
  `名称 · 节点数 N · 深度 D · 更新 <时间> · 被配置 X 引用`（`引用` 取自 `GET /me/ai` 的 `usage`）
- **每行按钮**：`打开`(`ai-open`，带 `data-ai-id`)、`删除`(`ai-delete`，带 `data-ai-id`)
- **底部按钮**：`新建 AI`(`ai-new`)、`刷新`(`ai-refresh`)、`返回主界面`(`goto-hub`)
- **空库**：一行 `（库里还没有 AI）`；`新建 AI` 仍渲染（§4.1「按钮永不无声」不因空态放宽）
- **零请求**：仅 `进入屏` 与 `刷新` 各发一次 `GET /me/ai`

### 3.2 编辑态（`mode:'edit'`）

分区（自上而下，全部是文字/输入框/按钮）：

1. **头部**：`名称`（单行输入，1~24 字符）+ `aiId`（只读文本；新建显示 `（未保存）`）+ `哈希` + `节点 N / 深度 D / 用到 <节点类型列表>`（**全部来自 `POST /ai/compile`**，前端不自算）
2. **程序树区**：文本行；每行按钮 `选中`/`进入`(`ai-select-node`，带 `data-addr`)
   - **根行固定**：`while(true)　（引擎隐式主循环，不可删除）`（D-100 / `08-ai.md` §4.1：显式可见、无法删除、不可在编辑器里书写外层循环）
   - **层级可读性（2026-09-25 **用户实测反馈**后修订，AE-14 锁住）**：
     ① 程序树必须**紧跟在「程序结构」标题之后**——用 `vm.blocks` **有序区块**渲染：旧的扁平 vm 会把
        **所有文字行先渲染、所有行（含树）后渲染**，于是标题与树被拆到屏幕两端、读者看不出从属关系；
     ② 缩进用**可见导轨** `│ `（每层一个），不再只靠全角空格 `U+3000`（其在浏览器里层级感极弱）；
     ③ **隐式主循环画在最外层第一行**，其余语句一律缩进在它里面 —— Python 式"谁在谁里面"一眼可见；
     ④ 分支/循环体先出一行标签（`那么：`/`否则：`/`循环体：`），其下语句再缩进一层。
   - 渲染顺序的机器断言见 **AE-14**（导轨层数 + 标题/树/表单三者先后）。
3. **节点编辑区**（当前选中节点）：按 §4.2 的表渲染字段
4. **结构按钮**（只改本地草稿，不发请求）：`插入子语句`、`插入同级`、`替换类型`、`包裹进 if`、`上移`、`下移`、`删除节点`
5. **校验（自动 + 手动重试）**：任何修改（结构变更 / 字段提交）后**自动校验一次**；输入框**防抖**（停手或换框才发，不能每敲一个字发一次）。保留 `重新校验`(`ai-validate`) 仅用于传输失败后手动重试。**校验不通过 → `保存` 按钮 `disabled` 并在按钮旁写明原因**（裁决 ⑨）
6. **底部按钮**：`保存`(`ai-save`，**仅"校验通过"时可用**)、`存为草稿`(`ai-save-draft`，**始终可用**)、`另存为`(`ai-save-as`)、`导入 JSON`(`ai-import-open` → `ai-import-apply`)、`关闭编辑`(`ai-close`)
7. **结果区**：`校验通过：节点 N / 深度 D / 用到 …`（**全部来自服务端**）或**逐条** `path · code · message`，每条带 `选`(`ai-select-error`，带 `data-path`)→ 一键定位
8. **被引用提示（F-1）**：若该 AI 被配置引用，必须显式写 `被配置 2 引用（出战中）：改完需在配置编辑器里重新选一次才会生效`
9. **草稿标记**：草稿条目在头部显示 `草稿（校验未通过，不能被出战配置选中）`；补全并通过校验后 `保存` 转正式
10. **`dirty` 提示**：`有未保存改动`；`关闭编辑` 在 `dirty` 时先出屏内确认（`确认丢弃` / `取消`）

### 3.3 查看态（只读）

- 复用 F6 的树渲染与"本帧执行"标记；**库内任意 AI** 可看（不再依赖 `GET /me/configs` 的 activeSlot）。
- 若该 AI 正被配置引用，附一行 `被配置 2（出战中）引用`。
- 「看某一帧的执行」沿用 F6 的 `state.viewer`（`source:'ai-editor'`，需先有对局：快速对战 / 锦标赛 / 试打）；无帧时如实写 `无帧（先打一场或在快速对战屏查看）`。

---

## 4. 数据模型

### 4.1 状态切片（`public/store.js` 新增 `aiEditor`）

```js
aiEditor: {
  list: null,            // GET /me/ai 的完整信封（投影仍在 format.js）
  mode: 'list',          // 'list' | 'edit'
  aiId: null,            // 正在编辑的库条目；null = 新建
  status: 'ready',       // 'ready' | 'draft'（库条目的状态；新建默认 ready）
  name: '',              // 名称输入（仅内存）
  draft: null,           // 本地草稿：program 的深拷贝（不写 localStorage）
  cursor: null,          // 编辑器地址（§4.3）
  validate: null,        // 校验信封（自动校验 / 手动重试）
  importOpen: false,     // 「导入 JSON」弹窗（FR-10 屏内区块）
  importText: '',        // 导入用多行输入（**唯一**的 textarea 用途，裁决 ③）
  dirty: false,          // 是否有未保存改动
  confirm: null,         // 屏内二次确认（{kind:'delete'|'discard', aiId?}）
}
```
> 说明：**没有** `compile`/`battle` 切片——统计（哈希/节点数/深度）由**校验与保存的响应**一并带回（裁决 ⑩）；试打本批不做（裁决 ⑦）。
- **不落盘**：草稿与名称仅内存（与 F2 的 `adminToken`、F3 的 `configs.draft` 同口径）。
- **与 `state.configs` 分片**：沿用 F6 的既有理由（`store.js:99-101`）——写入 `configs` 会丢弃配置编辑器未保存的草稿。

### 4.2 节点表单表（16 类，**逐值与 `server/ai/ast.js` 对齐**）

> 真源：`ast.js` 的 `FIELD_CHECKS`（类型/必填）、`FIELD_ENUMS`（枚举）、`ENUM_REQUIRED`（枚举决定必填）。机器核对 **AE-3** 逐值比对，防漂移。

| 节点 | 字段 → 控件 | 枚举/必填 | 服务端错误码（编辑器只展示） |
|---|---|---|---|
| `seq` | `statements[]` → 子句行列表（每项：`选`/`上移`/`下移`/`删除`/`在其后插入`） | 数组 | `bad_field` |
| `literal` | `value` → 类型按钮组（数字 / 字符串 / 布尔）+ 单行输入 | 任意 JSON 标量 | `bad_field` |
| `get` | `path` → 单行输入 + **合法路径前缀下拉**（见 §4.4） | `tick` / `self\|enemy.<11 字段>` / `.cooldowns.<sid>` / `.effects[i].<6 字段>` / `bases.self\|enemy.<3 字段>` / `field.fieldPx\|cellPx` | `bad_path` |
| `var` / `set` | `name` 单行 + `value` 表达式子树（`选`） | `value` 必须是表达式节点 | `bad_field` / `not_expression` / `undefined_var` |
| `getVar` | `name` 单行（候选 = 已声明变量，见 §4.4） | 须被 `var` 声明过 | `undefined_var` |
| `arith` | `op` 按钮组 + `left`/`right` 表达式子树 | `+ - * /` | `bad_enum` / `not_expression` |
| `cmp` | `op` 按钮组 + `left`/`right` | `> < >= <= == !=` | 同上 |
| `logic` | `op` 按钮组 + `left`/`right` | `and or` | 同上 |
| `random` | `prob` 表达式 + `then` 语句块 + `else` 语句块 | **`else` 必填**（缺失 → `bad_field`）；**语句位=概率分支 / 表达式位=布尔**（界面必须显式提示当前所处位置，见 §4.5） | `bad_field` |
| `if` | `cond` 表达式 + `then` 语句块 + `else`（**可选**，可加可删） | — | `bad_field` |
| `loop` | `kind` 按钮组（`count` / `while`）+ `times`(count) 或 `cond`(while) + `body` | `count` 必填 `times`；`while` 必填 `cond` | `bad_enum` / `bad_field` |
| `break` | 无字段 | 仅允许在 **loop 体内** | `break_outside_loop` |
| `function` | `name` 单行 + `body` | **重名直接拒绝**（服务端 `duplicate_function`，D-172 附带修复）；编辑器同步禁止同名 | `duplicate_function` |
| `call` | `name` 单行（候选 = 已定义函数名） | 未定义 → 拒绝（hoisting 语义） | `unknown_call` |
| `action` | `name` 单行 + **词汇表下拉** | 自由标签（**不拒绝**，D-80）；下拉 = `move_left` `move_right` `dodge_left` `dodge_right` `wait` `defend` `turn` + `skill:skill1` `skill:skill2` `skill:skill3`（**共 10 项**） | 无（仅 `warnings: unknown_action`）；写错技能槽 → 运行期 `unknown_skill` 空行动 |

### 4.3 编辑器地址（编辑器自有，**不复用运行时路径**）

```
结构步：  .s[i]  |  .then  |  .else  |  .body
表达式字段步（字段名即地址的一部分）：  .value .left .right .cond .prob .times
示例：    body.s[0]                       → 第一条语句
          body.s[0].cond                  → if 的条件表达式根
          body.s[0].cond.right            → cmp 的右操作数（**运行时路径两者都是 …expr，故必须用字段名**）
          body.s[1].then.s[0].value       → 分支内 set 的值
```
- **映射到运行时路径**（仅用于"本帧执行"标记）：删掉**最后一个字段名步**；若最后一步是表达式字段，则该节点**不标注**（R-1）。
- 机器核对 **AE-4**：解析/序列化往返 + `cmp.left`/`cmp.right` 互不串（R5 回归）。

### 4.4 前端允许做的"候选集"（R3 的边界）

| 候选 | 来源 | 边界 |
|---|---|---|
| `get.path` 合法路径 | 快照白名单的**前缀/枚举**（来自 `docs/systems/08-ai.md` §4.5，非前端推断） | 是**候选**；用户仍可手工输入 → 由服务端裁决 |
| `action.name` | `ai-nodes.json` 的 `actions`（7 固定 + `skill:` 前缀） | 同上 |
| `call.name` / `getVar` / `set` 的 name | 扫**当前草稿**得到的函数名集 / 变量声明集 | 同上；扫描结果与 `ast.js` 的保守扫描**不要求等价**（后者不区分作用域与顺序），差异登记 R-3 |
| 枚举（`op` / `kind`） | 固定 4 组枚举 | 按钮组，**不给自由输入**（避免 `bad_enum` 往返） |

> **单位口径（D-174）**：`self.x` / `enemy.x` 是**格序号 0..15**（不是像素）——按钮中文标签为「位置（格序号，0 起）」，与 `server/runner.js` 的投影一致；`field.cellPx` 保留（战场几何信息），但**不再需要**用它把 `x` 换算成格。

### 4.5 `random` 双语义的界面义务（D-156 / `08-ai.md` §4.3）

同一个 `random` 节点按**出现位置**有两种含义：语句位 = 概率分支（真的进入 `then`/`else`），表达式位 = 布尔（只取 `prob`，`then`/`else` 不参与求值）。编辑器**必须**在节点编辑区显式写清当前是哪种（例如 `位置：语句位（概率分支）——then/else 会真的执行` / `位置：表达式位（布尔）——then/else 不执行，仅按 prob 取真假`）。这是本设计里**最容易误导用户**的一处，故列为硬要求。

### 4.6 错误码总表（`ast.js` 实产，编辑器逐条给文案；**不在前端复判**）

| code | 触发 | 编辑器要展示的定位 |
|---|---|---|
| `not_program` / `bad_root` / `bad_version` | 根不是 program / body 不是 `seq` / version 非法（`bad_root` 对应 D-100 隐式主循环结构契约） | 全局（根行） |
| `forbidden_key` | `__proto__` / `constructor` / `prototype` | 该节点 |
| `ai_too_large` / `ai_too_deep` | 字节 256KB / 节点 2000 / 深度 32 超限 | 全局（并显示当前值） |
| `ai_cycle` | 节点自引用/环 | 该节点 |
| `unknown_node` | 节点类型不在 16 类白名单 | 该节点 |
| `bad_field` | 缺必填字段 / 字段类型错（含 `random.else` 缺失、`loop.count` 缺 `times`、`loop.while` 缺 `cond`） | 字段级 `path` |
| `bad_enum` | `arith.op` / `cmp.op` / `logic.op` / `loop.kind` 表外取值 | 字段级 `path` |
| `bad_path` | `get.path` 不在快照白名单 | `.path` 字段 |
| `not_expression` | 表达式位放了语句节点（`path` 以 `.expr` 结尾） | 该表达式字段 |
| `undefined_var` | `getVar`/`set` 的名字未曾被 `var` 声明（**保守**：不区分作用域与顺序） | 该节点 |
| `unknown_call` | `call` 引用未定义函数 | 该节点 |
| `break_outside_loop` | `break` 不在循环体内 | 该节点 |
| `branch_without_action` | 循环体内 `if`/`random` 的**任一分支**（含缺 `else`）不含可达 `action`（D-101/D-155） | `.body` / `.then` / `.else` |
| `no_action_program` | 整棵程序无任何 `action`（含空 body） | 全局 |
| `node_locked` | 段位门控未解锁该节点（**门控默认关闭**，D-137；开启时才可达） | 该节点 |
| `unknown_action` | **不是错误**：`warnings` 通道（D-80 动作名自由标签） | 该节点旁提示，不阻断保存 |

---

## 5. 端点映射（总纲 §4.3「端点可达」）

| 端点 | 用途 | 现状 | 本批 |
|---|---|---|---|
| `GET /api/v1/me/ai` | 库列表 + `usage` | ✅ | 接 UI；**响应新增每条目的 `status`（`ready`/`draft`）** |
| `POST /api/v1/me/ai` | 新建 / 另存为 | ✅ | 接 UI；**请求体新增可选 `status`**；`status='ready'`（缺省）时**服务端校验不通过即拒绝** |
| **`PUT /api/v1/me/ai/:aiId`** | **编辑保存（`aiId` 不变）** | ⏳ **不存在** | **新增**（裁决 ①；须走 `decisions.md` D 编号 + `interfaces.md` §2 同步，总纲 §2.7） |
| **`POST /api/v1/me/ai/validate`** | **登录版实时校验**（+ `programHash`/统计） | ⏳ **不存在** | **新增**（裁决 ⑩；须走 D 编号 + `interfaces.md` 同步） |
| `DELETE /api/v1/me/ai/:aiId` | 删除（草稿与正式同权） | ✅ | 接 UI + 确认 + 引用提示 |
| `POST /api/v1/ai/validate` | 校验（错误带 `path`） | ✅ **遗留端点** | **不再依赖**（改用上面的登录版）；保留为对照 |
| `POST /api/v1/ai/compile` | `programHash` + `stats` | ✅ **遗留端点** | **不再依赖**（统计由校验/保存响应一并带回） |
| `POST /api/v1/ai/battle` | 试打一场 | ✅ **遗留端点** | **不做**（裁决 ⑦） |
| `GET /api/v1/me/configs` | 显示"被哪些配置引用" | ✅ | 接 UI（与 `usage` 互补） |
| `PUT /api/v1/me/configs/:slotId`、`POST …/activate` | 配置保存 / 出战 | ✅ | **加窄护栏**：引用**库内存在的草稿** → 拒绝（F-2） |

### 5.2 字段来源契约（F5 增量；FC-1/FC-2/FC-3 的宿主）

> 信封级路径（带 `data.` 前缀）由 `tests/frontend/auth-field-contract.test.js` 的 **FC-1/FC-2/FC-3** 三方核对；
> 行级/子对象字段（不带前缀，如 `items[].status`）由 `tests/frontend/ai-editor-flow.test.js` 的 **AE-2** 核对。

| 端点 | 路径 | 用途 |
|---|---|---|
| `me/ai` | `data.items` | AI 库列表（编辑器的列表行与「打开」） |
| `me/ai` | `data.count` | 列表头「AI 库：n/100」 |
| `me/ai` | `data.max` | 列表头容量上限 |
| `me/ai` | `data.draftCount` | 列表头「草稿 n 条」 |
| `me/ai` | `data.usage` | 条目行与编辑器头部的「被配置 N 引用」 |
| `me/ai/create` | `data.aiId` | 新建成功后重新打开该条目 |
| `me/ai/create` | `data.ai` | 新建成功后的条目正文（名称/状态回显） |
| `me/ai/update` | `data.aiId` | 编辑保存后重新打开**同一条**（`aiId` 不变） |
| `me/ai/update` | `data.ai` | 编辑保存后的条目正文 |
| `me/ai/update` | `data.referencedBy` | 保存后回带「被哪些配置引用」提示 |
| `me/ai/delete` | `data.deleted` | 删除成功文案回显 |
| `me/ai/delete` | `data.referencedBy` | 删除回带「曾被哪些配置引用」 |
| `me/ai/validate` | `data.ok` | **保存按钮可用性的唯一判据** |
| `me/ai/validate` | `data.warnings` | 非阻断提示（如动作名不在词汇表） |
| `me/ai/validate` | `data.programHash` | 编辑器头部显示的程序指纹 |
| `me/ai/validate` | `data.stats.nodes` | 编辑器头部「节点 N」 |
| `me/ai/validate` | `data.stats.depth` | 编辑器头部「深度 D」 |
| `me/ai/validate` | `data.stats.usedNodeTypes` | 编辑器头部「用到 …」 |
| `any` | `ok` / `error.code` / `error.message` / `error.details` | 统一信封（沿用既有登记） |

**子对象字段（`public/contract.js` 的 `AI_ITEM_FIELDS`，由 AE-2 核对）**：`items[].aiId`、`items[].name`、
`items[].program`、`items[].status`（`ready`/`draft`）、`items[].updatedAt`；写入回执上的 `ai.{aiId?}` 同形。

**结构性输入（提交给服务端，不属于"读响应"）**：`name`、`program`、`status`（`PUT` 的部分更新语义）。

### 5.3 ✅ 遗留端点依赖已被裁决 ⑩ 消除

**背景（读码事实）**：`server/index.js:251-257` 的 `isLegacyPath()` 把 **`/api/v1/ai/*`** 列为遗留无状态端点，`DL_LEGACY_STATELESS=0` 时一律 `410 deprecated`；而 `POST /me/ai` 只做结构检查（名称 1~24 + `program.type==='program'`，`server/account.js:722-741`），**不校验合法性**。按原样实现，"能不能校验"取决于部署开关。

**处置（裁决 ⑩）**：新增**登录版校验接口** + **保存接口自身校验**。于是：

| 场景 | `DL_LEGACY_STATELESS=1`（默认） | `=0` |
|---|---|---|
| 编辑期实时校验 | 走新增的登录版接口 ✅ | 走新增的登录版接口 ✅ |
| 保存 | 服务端校验 ✅ | 服务端校验 ✅ |
| 遗留接口可用性 | — | **不影响本屏**（F5 不再调用任何遗留接口） |

→ 本屏对遗留开关**零依赖**（这是与初稿最大的差别）；历史风险降级为文档说明，仍登记于 §10 R-6。

---

## 6. 失败路径（逐条可达；总纲 §4.1「按钮永不无声」）

| 场景 | 服务端 | 界面行为 |
|---|---|---|
| 名称空 / 超 24 字符 | 400 `bad_request`（`details[].path='name'`） | 行内提示，**保留草稿** |
| 库满 100 | 409 `ai_limit` | `AI 库已满（100/100）：先删除不用的 AI 再保存` |
| 程序非法（结构/合法性/门控） | 400 `ai_invalid` + `details[].path` | 逐条列出 + 每条可 `选` 定位；保留草稿 |
| 节点数 / 深度 / 字节超限 | 400 `ai_too_large` / `ai_too_deep` | 同上（并显示当前 N / D 与服务端上限） |
| 删除被**出战**配置引用 | 409 `ai_in_use`（`details` 含引用的 `slotId`） | `被出战配置 N 引用：请先在配置编辑器里换掉再删除` |
| 删除不存在的 `aiId` | 404 `store_not_found` | `该 AI 已不存在，已刷新列表` |
| 未登录 / 会话过期 / 封禁 | 401 `unauthorized` \| `session_expired`；403 `banned` | 走既有 `sessionLost` → 登录屏 |
| 遗留端点被关闭 | 410 `deprecated` | `服务端已关闭该能力（DL_LEGACY_STATELESS=0）：无法校验/试打` |
| 传输失败 | — | `networkText`，**保留草稿与名称** |
| `dirty` 时关闭编辑 | — | 屏内确认（`确认丢弃` / `取消`） |
| `dirty` 时切换条目 / 新建 | — | 同上 |

---

## 7. 裁决记录（**已定**）

> **裁决结果见 §0.1 的 11 条**，本节不再有"待定项"。下表是初稿提出的选项与代价，**保留备查**（便于日后追溯"为什么当初没选另一条"）。

| # | 议题 | 选项 | 我的建议与代价 |
|---|---|---|---|
| **D1** | **编辑保存的服务端形态**（"编辑"能否保存回同一条） | ① 新增 `PUT /me/ai/:aiId`（新 journal 记录 `ai.updated` + 幂等键 + `NON_COMPACTABLE` 同步 + `aiId` 稳定）<br>② 前端"另存为新条目"（`DELETE`+`POST`）<br>③ 库条目只读，只有未保存草稿可编辑 | **建议 ①**。②的代价：被出战配置引用时 `DELETE` 直接 409 → **根本改不了正在用的 AI**；即使能删，`aiId` 变化会**打断所有配置引用**，用户须手动重绑。③与"编辑是核心"矛盾。<br>①的代价：要改 `server/store/{ledger,archive,adapter-json}.js` + `account.js` + 路由 + `interfaces.md` + 新 D 编号 |
| **D2** | **遗留端点依赖**（`/ai/validate|compile|battle` 在 `DL_LEGACY_STATELESS=0` 下 410） | ① 接受，登记为部署前置（F5 需要 `DL_LEGACY_STATELESS=1`）<br>② 新增鉴权镜像 `POST /me/ai/validate`（+ `compile` / `battle`），扩 D-161 范围<br>③ 放弃校验，只靠 `POST /me/ai` 的结构检查 | **建议 ①（本轮）+ ②（登记为后续）**。③不可取：等于"编辑是核心"却拿不到合法性/门控结论。<br>①的代价：生产若关掉遗留端点，编辑器三项能力**整体失效**（必须写进分册与 `security-backlog`） |
| **D3** | **多行输入 `textarea`（O-3 留给本分册裁）** | ① 不解禁（纯表单）<br>② 解禁，但**仅**用于"整段 JSON 导入/导出"<br>③ 解禁为唯一编辑手段（＝§2 R1，不采） | **建议 ①**，把"JSON 导入/导出"显式登记为 F5 之后（②会让 §1.1 的控件封闭出现第一个例外） |
| **D4** | **文件形态**（`public/` 现为**恰好 9 文件**，且被 `UW-1`/`UI-1` 机器断言） | ① 保持 9 文件（编辑器逻辑并入 `format/actions/store/contract`；`format.js` 由 119KB 涨到约 180KB）<br>② 新增 `public/ai-editor.js` 成为**第 10 个文件**（同步 `UW-1`/`UI-1` 断言 + 分册 §1 分层叙述） | **倾向 ②**（职责单一：树渲染 + 地址解析 + 表单模型自成一文件），但"恰好 9 文件"是**既有机器断言**，改动等于放松一条验收线，须你点头 |
| **D5** | **`skill:<槽位>` 的下拉取值** | ① 只给 `skill:skill1` / `skill:skill2` / `skill:skill3`（= 当前配置的三个技能槽；**引擎寻址键就是 `skill1..3`**，见 `engine.js:401` + `battle.js:42`）<br>② 允许任意 `skill:<文本>` | **裁决 = ①**（✅ 已定）；②的代价：写错槽位在运行期被归一化为空行动（`unknown_skill` warn），用户看不出原因 |
| **D6** | **段位门控是否参与** | ① 不置灰（门控默认关闭，D-137）<br>② 按 `GET /unlock?tier=` 把未解锁节点置灰（`08-ai.md` §4.8 原文） | **建议 ①**，与 D-137「门控默认关闭、段位不参与判定」一致；②会让默认配置下出现"节点全可用但按钮灰着"的矛盾 |
| **D7** | **试打一场的对手** | ① 只给内置对手 `kiter` / `charger` 两个按钮<br>② 另加"用我的出战配置作为技能槽来源" | **建议 ①+②都做**（`/ai/battle` 已支持：显式 `skills/loadout` → 调用方档案出战配置 → baseline，`server/index.js` 的 `/ai/battle` 分支）；②的价值是"技能类 AI 真能被验证" |
| **D8** | **与 F6 查看器的关系** | ① 复用 `state.viewer`（新增 `source:'ai-editor'` 到 `VIEWER_SOURCES` 白名单）<br>② 另建只读树，不接帧 | **建议 ①**（避免第四套树渲染；`VIEWER_SOURCES` 是白名单，加值即可） |
| **D9** | **`function` 同名覆盖与 `program` 版本** | ① 只提示不拒绝（`ast.js:440` 后定义覆盖，与 hoisting 一致）<br>② 编辑器禁止同名 | **建议 ①**（前端不判决，§2 R3）；②需要前端复制 `ast.js` 的口径 |

### 7.1 实现清单（按提交拆分；本项目"一次只做一批 + 每批独立审查"）

**F5a · 后端契约（先做；`docs/interfaces.md` + 新 D 编号先行）**

| # | 文件 | 改动 |
|---|---|---|
| a1 | `docs/decisions.md` | 新增决策条目（草案编号 **D-172**：AI 库可编辑 + 草稿状态 + 保存/实时双校验） |
| a2 | `docs/interfaces.md` | §2 增 `PUT /me/ai/:aiId`、`POST /me/ai/validate`；`GET/POST /me/ai` 增 `status`；§2.1 增错误码；§4.8 档案 `ai.items[].status` |
| a3 | `server/store/ledger.js` | `buildAiRecord` 支持 `op:'update'`（带 `name/program/status`），`ai.created` 带 `status` |
| a4 | `server/store/archive.js` | `ai.items[]` 增可选 `status`（缺省视为 `ready`，**旧档案无需迁移**）；`applyRecord` 幂等键（建议 `updatedAt === record.at`）；`aggregateRecords`、`validateArchive`、`NON_COMPACTABLE` 同步 `ai.updated` |
| a5 | `server/store/adapter-json.js` | 新增 `updateAi({playerId, aiId, name?, program?, status?})`：`store_not_found` / 被出战配置引用时**禁止降级为 draft**；`aiView` 带 `status` |
| a6 | `server/account.js` | 新增 `updateAi` / `validateAi` 门面；`listAi` 透出 `status`；`createAi` 增 `status` + **ready 时校验**；草稿护栏（禁止被配置引用，F-2） |
| a7 | `server/index.js` | 注册 `PUT /me/ai/:aiId`、`POST /me/ai/validate`（均 `auth:true`）；`PUT /me/configs/:slotId` 与 `activate` 加草稿护栏 |
| a8 | `tests/api/api-me-ai.test.js` 等 | 新增 AI-1…AI-N（更新/草稿/双校验/护栏/幂等/上限/引用） |

**F5b · 前端（`public/` 变 10 个文件）**

| # | 文件 | 改动 |
|---|---|---|
| b1 | `public/ai-editor.js`（**新**） | 程序树 → 文本行（复用 `walkProgramNode` 口径）+ **编辑器地址**（§4.3）解析/序列化 + 16 类节点表单模型 + 结构操作（插入/删除/上移/下移/包裹） |
| b2 | `public/store.js` | `aiEditor` 切片 + reducer；`VIEWER_SOURCES` 加 `'ai-editor'` |
| b3 | `public/format.js` | `ai-editor` 两态 viewModel、错误行、草稿标记、被引用提示；`EMPTY_PAGES` **删掉 `ai-editor`** | 
| b4 | `public/actions.js` | 新增动作（约 15 个）：`ai-new/ai-open/ai-refresh/ai-select-node/ai-insert*/ai-move-*/ai-delete-node/ai-wrap-if/ai-save/ai-save-draft/ai-save-as/ai-delete/ai-validate/ai-import-*/ai-close/confirm-*` |
| b5 | `public/api.js` | `aiCreate/aiUpdate/aiDelete/aiValidate` 出口（`ADMIN_OPS` 不变） |
| b6 | `public/contract.js` | `me/ai*` 字段表（含 `status`）、节点表单表（与 `ast.js` 逐值一致） |
| b7 | `tests/frontend/*` | 新增 `ai-editor-flow.test.js`（AE-1…AE-10）；**更新 `UW-1`/`UI-1` 的 9→10 文件断言** |
| b8 | `docs/frontend/03-…md` §3.6 + `docs/progress.md`/`tasks.md` §7 | 空页从 4 个减为 0；F5 交付登记 |

**F5c · 收口**：独立上下文审查（`docs/reviews/F5.md`）+ 你本人走查（§9 的 13 步）。

---

## 8. 机器核对（拟，编号待分配）

> **编号 → 承担用例的映射（独立审查 F5-C 要求；与 F7 的 §9/§10 同做法）**：
>
> | 编号 | 承担用例（**用例名即证据**） |
> |---|---|
> | AE-1 | `ai-editor-flow.test.js` 的「AE-1 F5 动作集合 == 注册表 F5 段」 |
> | AE-2 | 同上「AE-2 字段三方一致」＋ `config-editor-flow.test.js` 的 **CF-8**（真实响应条目逐字段存在） |
> | AE-3 | 同上「AE-3 节点表单表 == 服务端真源」（16 类默认节点 + 枚举逐个被接受/表外被拒 + 动作词汇表） |
> | AE-4 | 同上「AE-4 编辑器地址往返」 |
> | AE-5 | 同上「AE-5 前端不复制判决」＋ `auth-ui-contract` 的 **UI-7/UI-8/UI-9** |
> | AE-6 | 同上「AE-6 校验错误可定位」 |
> | AE-7 | 同上「AE-7 真实 HTTP 全链路」 |
> | AE-8 | **`auth-ui-contract.test.js` 的 UI-1**（`EXPECTED_FILES` 与磁盘清单双向相等，10 个文件）＋ `hub-warehouse-flow.test.js` 的 **WH-2**（`EMPTY_PAGES` 已空） |
> | AE-9 | **`api-me-ai-edit.test.js` 的 AIE-12**（同内容重复保存：不重复/不丢/`stats().reapplied===0` + journal 重放逐值一致）＋ **AIE-2**（`aiId` 稳定）＋ **AIE-5**（引用不断）＋ **AIE-3**（错误码同口径）＋ **AIE-9**（草稿占库位） |
> | AE-10 | 同上「AE-10 多行输入只在导入区块」 |
> | AE-11 | **`api-me-ai-edit.test.js` 的 AIE-13**（草稿护栏覆盖 `POST /me/configs` / `PUT` / **`activate`** 三条写路径）＋ AIE-6 |
> | AE-12 | 同上「AE-12 实时校验不逐键」 |
> | （核心不变量） | **`api-me-ai-edit.test.js` 的 AIE-12 ④**：「库里每一条 `status==='ready'` 的条目都必须通过 `ast.validate`」（独立审查 F5-C 指出的最大缺口） |
> | （路径边界） | **`api-me-ai-edit.test.js` 的 AIE-11**：编码斜杠/点点 → 400；`PUT /me/ai/validate` → 404；末尾斜杠 → 404 |
> | **AE-14** | `ai-editor-flow.test.js` 的「AE-14 程序树：有序区块 + 可见缩进导轨 + 隐式主循环在最外层」（**用户实测反馈**的回归：标题/树/表单三者渲染顺序 + 每层导轨数 + 分支同层） |


| 编号 | 断言 |
|---|---|
| AE-1 | **按钮双向闭合**：`ai-editor` 渲染的 `data-action` 集合 == 注册表新增的 F5 动作集合（无死按钮、无不可达） |
| AE-2 | **字段契约三方一致**：`ai-editor` 实读路径 ⊆ `public/contract.js` 声明 ⊆ 本分册 §5 表（双向核对） |
| AE-3 | **节点表单表 == 服务端真源**：16 类的字段/枚举/枚举必填与 `ast.js` 的 `FIELD_CHECKS`/`FIELD_ENUMS`/`ENUM_REQUIRED` **逐值相等** |
| AE-4 | **地址往返**：`aiAddr` 对 16 类各 ≥1 例解析→序列化相等；**`cmp.left`/`cmp.right` 不互相串**（R5 回归） |
| AE-5 | **不复制判决（唯一例外已登记）**：除"函数重名"（裁决 ⑧ / §2.1）外，`public/*` 不出现第二处合法/非法判决；`render.js` 的 `pick(` 仍为 0；`fetch(` 仅 `api.js`；`innerHTML` 仅 `app.js` |
| AE-6 | **错误可定位**：真实 `ai_invalid` 的 `details[].path` 经地址映射后，≥N 条能落到具体树行 |
| AE-7 | **真实 HTTP 全链路**：新建 → 校验不通过 → **`保存` 不可用而 `存为草稿` 成功** → 列表出现草稿标记 → 重开 → 改好 → **自动校验通过** → `保存`（转正式，**`aiId` 不变**）→ 在配置里选中它 → 回编辑器 `删除` → 409 `ai_in_use` |
| AE-8 | **文件数**：`public/` = **10**，且 `UW-1`/`UI-1` 已同步为 10 |
| AE-9 | **后端** `PUT /me/ai/:aiId`：幂等（同 `updatedAt` 重放不产生二次变更）、`aiId` 稳定、既有配置引用不断、`ai.updated` 经 journal 重放后一致、错误码与 `POST` 同口径；**被出战配置引用时禁止降级为草稿** |
| AE-10 | **`textarea` 唯一用途**：`<textarea` 只出现在 `public/ai-editor.js`，且只服务"导入 JSON"（§2.1 的例外记账） |
| AE-11 | **草稿护栏**：`PUT /me/configs/:slotId` 与 `activate` 引用**库内存在的草稿** → 拒绝；引用"不存在的 aiId"→ **行为与改动前逐字一致**（不新增要求，F-2） |
| AE-12 | **实时校验不逐键**：输入框连续输入 N 次只发 1 次校验请求（防抖）；结构操作每次 1 次 |

---

## 9. 人工走查剧本（拟，13 步；总纲 §4.4 的唯一"能玩"出口）

| 步 | 操作 | 期望 |
|---|---|---|
| 1 | 主界面点 `AI编辑` | 进入 `ai-editor`，显示 `AI 库：N/100` 与现有条目（或"还没有 AI"） |
| 2 | 点 `新建 AI` | 进入编辑态；根行显示 `while(true)（引擎隐式主循环，不可删除）` |
| 3 | 输入名称 → 点 `插入子语句` → 选 `action` → 下拉选 `move_right` | 树出现 `action move_right`，行尾有稳定路径 |
| 4 | 点 `插入子语句` → 选 `action` → 下拉选 `move_right` | 树出现 `action move_right`（行尾稳定路径）；**自动校验触发**，结果区 `校验通过：节点 N / 深度 D` |
| 5 | 删掉唯一的 `action` | 自动校验失败（`no_action_program`）；**`保存` 变灰**并写明原因 |
| 6 | 点 `存为草稿` | 回到列表态，该条带 `草稿` 标记；`AI 库：N+1/100` |
| 7 | 点 `打开` 这个草稿 | 编辑态载入；头部显示 `草稿（校验未通过，不能被出战配置选中）` |
| 8 | 把 `action` 补回来 | **自动校验通过**；`保存` 恢复可用 |
| 9 | 点 `保存` | 保存成功；**`aiId` 不变**、草稿标记消失、更新时间变化 |
| 10 | 选中根语句 → `包裹进 if` → 给 `cond` 插 `cmp` → 把 `left` 改成 `get self.hp` | `left` 与 `right` **各改各的**（§2 R5 的人工对照） |
| 11 | 点 `导入 JSON`，粘一段合法程序 → 应用 | 整棵树被替换；自动校验通过（`textarea` 唯一用途） |
| 12 | 去配置编辑器把某配置的 AI 换成它 → 回 `ai-editor` | 头部出现 `被配置 N 引用：改完需在配置编辑器里重新选一次才会生效`；点 `删除` → 409 `ai_in_use` 文案 |
| 13 | 在配置里换掉引用 → 回 `ai-editor` 点 `删除` → 确认 | 条目消失；`AI 库：N/100` 减一 |

---

## 10. 已知未覆盖 / 已知风险（**不得为空**）

| # | 项 | 说明 |
|---|---|---|
| R-1 | **表达式位无"本帧执行"标记** | 运行时 `.expr` 路径碰撞（§2 R5）；F5 只标注语句/结构节点，与 F6 查看器同口径。修法须改上游（`ast.js`/`runtime.js`），本批不做 |
| R-2 | **大程序的可用性未验证** | 上限是 2000 节点 / 深度 32；树渲染已限 200 行（`format.js:1440`）与显示深度（`AI_MAX_DEPTH`）。>200 行的程序在单屏文本视图下的可用性**未实测** |
| R-3 | **候选集与 `ast.js` 的声明扫描是两份实现** | 前端"已声明变量/已定义函数"扫描与 `ast.js:489-580` 的保守扫描不要求等价；缓解靠 AE-3/AE-5，彻底消除需后端导出"声明集"（登记为后续） |
| R-4 | **`function` 同名** | **D-172 附带修复后两边同严**：服务端 `ast.js` 校验期拒绝重名（`duplicate_function`），编辑器再拦一次（即时反馈）。修前两边**不同**：校验按"后定义覆盖"、运行按"取首个"，可造出"校验通过但每 tick 空转到步数上限"的 AI。§2.1 已记账；机器核对 AE-5 限定"唯一一处前端判决" |
| R-5 | **后端新增记录类型的兼容** | 新记录 `ai.updated` 需定幂等键（建议 `updatedAt`）、加入 `NON_COMPACTABLE`（`archive.js:31`）、`validateRecord`/`applyRecord`/`aggregateRecords` 三处同步；`ai.items[].status` 缺省视为 `ready` → **旧档案无需迁移** |
| R-6 | **新增可写面带来的 DoS/滥用面** | F5 不再依赖遗留端点（§5.1），但 `PUT` + 草稿让 AI 库成为**可反复写**的面：单条上限 256KB/2000 节点 × 100 条 = 约 25MB/玩家，且 journal 每次写一条。→ 必须登记进 `docs/security-backlog.md`（新 SEC 项），并复用既有全局限速（600/分） |
| R-8 | **已保存配置不自动升级（F-1）** | 改 AI 后，配置里仍是旧程序副本 → 必须靠界面的"需重新选一次"提示；若用户忽略，会以为改动无效。**不做**"自动跟随"（那会让历史快照语义与配置语义打架） |
| R-7 | **本轮未跑的门禁** | 同 F6/F7 的 K-6 口径：本草案未跑 `gate`/`e2e`/`play`/`load-test`；`public/**` 仍不在覆盖率门禁四目录内（N-15） |
| R-9 | **"本帧执行"标记在编辑器里不适用** | 裁决 ⑦ 已取消"试打"，编辑器**没有帧来源** ⇒ `store.js` 的 `VIEWER_SOURCES` **不含** `'ai-editor'`（避免死代码）。要看某一帧的执行轨迹，仍走 F6 的快速对战屏 / F7 的锦标赛屏（那里的 `ai-logic` 弹窗是只读查看器） |

---

## 11. 交付物清单（拟，裁决后定）

| 层 | 文件 | 内容 |
|---|---|---|
| 设计 | `docs/frontend/06-ai-editor.md` | 本文（冻结后） |
| 前端 | **`public/ai-editor.js`（新，第 10 个文件）** + `public/{store,format,actions,api,contract}.js` | 列表/编辑/查看三态、16 类节点表单、地址解析、错误定位、导入 JSON |
| 前端（契约） | `public/contract.js` | `me/ai*` 字段（含 `status`）、`AI_*` 节点表单表 |
| 后端 | `server/store/{ledger,archive,adapter-json}.js`、`server/account.js`、`server/index.js` | `PUT /me/ai/:aiId`、`POST /me/ai/validate`、`ai.updated` 记录、`status` 字段、草稿护栏 |
| 契约同步 | `docs/interfaces.md`、`docs/decisions.md`（草案 **D-172**）、`docs/systems/11-account-store.md`、`docs/security-backlog.md`（R-6 新 SEC 项） | 端点、记录类型、档案字段 |
| 测试 | `tests/frontend/ai-editor-flow.test.js` + `tests/api/api-me-ai*.test.js` + 更新 `UI-1`/`UW-1`（9→10） | AE-1…AE-12 |
| 审查 | `docs/reviews/F5.md` | 独立上下文子代理出具（四项判定 + 走查记录） |

---

## 15. 实现对账（2026-09-25 交付）

> 本节记录"设计 → 代码"的落点，供独立审查逐条复核；**四项定稿判定与走查结论一律由 `docs/reviews/F5.md` 出具**。

### 15.1 后端（D-172）

| 落点 | 实现 |
|---|---|
| `PUT /api/v1/me/ai/:aiId` | `server/index.js` 的 `/me/ai/` 动态块（先分流 `POST /me/ai/validate`，再 PUT/DELETE）→ `server/account.js:updateAi` → `server/store/adapter-json.js:updateAi` → journal `ai.updated` |
| `POST /api/v1/me/ai/validate` | 同上动态块 → `server/account.js:validateAi`（`tier` 取**档案**，不接受客户端传）→ `ast.validate` + `ast.statsOf` + `ast.programHash` |
| `ai.items[].status` | `server/store/archive.js` 的 `aiStatusOf`/`AI_STATUSES`（缺省 = `ready` ⇒ 旧档案**零迁移**）；`ai.created`/`ai.updated` 两条记录都携带 `status`；`aggregateRecords` 与检查点路径同步 |
| 幂等 | `isRecordApplied` 的 `ai.updated` 分支 = **内容比对**（name/status/program 逐字段）且 `updatedAt === at`；刻意不用纯时间键（同毫秒两次不同编辑会被误判"已应用"而丢第二次） |
| 保存时校验 | `createAi`（`status` 缺省/`ready`）与 `updateAi`（按**结果态**判定）都跑完整校验；失败 → 400 `ai_invalid` + `details[].path` |
| 草稿护栏（窄） | `account.js:draftAiDetails` 用于 `createSlot`/`saveConfig`/`activateConfig`：引用**库内存在的草稿** → 409 `ai_is_draft`；**不新增**"aiId 必须存在于库"的要求（既存缺口，见 §0.2 F-2） |
| 引用保护的扩展 | 被**出战配置**引用的 AI 禁止降级为 `draft` → 409 `ai_in_use`（与删除同码） |
| 附带修复 | `ast.js` 的 `duplicate_function`：**重名函数校验期拒绝**（修前校验按"后定义覆盖"、运行按"取首个"，实测可造出"校验通过但每 tick 空转到步数上限"的程序） |

### 15.2 前端

| 落点 | 实现 |
|---|---|
| `public/ai-editor.js`（**新，第 10 个文件**） | 16 类节点目录（中文标签/枚举/动作词汇表/49 条合法读取路径）、编辑器地址（解析/读写/增删移/包裹）、程序树 → 带地址的文本行、当前节点表单模型、导入 JSON 预检、`duplicateFunctionNames`（唯一的前端判决）、`contextualizeNode`（插入 `call`/`set`/`getVar` 时自动改用已定义的函数/变量名） |
| `public/store.js` | `aiEditor` 切片（list/mode/aiId/status/name/draft/cursor/texts/validate/importOpen/importText/dirty/confirm）+ 12 个 reducer；`AI_FIELD_PREFIX`/`isAiField`；`AI_NAME_FIELD` 并入 `SCREEN_FIELDS` |
| `public/format.js` | `aiEditorViewModel`（列表态/编辑态两态 + 导入区）、`aiErrorRows`（错误 → 可点地址）、`aiValidateText`（节点数/深度/节点类型/指纹）、`aiSavedText`/`aiDeleteOkText`/`aiWriteFailText`（全中文）、`EMPTY_PAGES` **清空** |
| `public/actions.js` | 28 个 F5 动作（含事件型 `ai-field-commit`）；保存前本地拦截（重名/未校验通过/名称空）与 `aiValidateSeq` 序号守卫（旧响应不覆盖新结论） |
| `public/api.js` | `aiCreate`/`aiUpdate`/`aiDelete`/`aiValidate` 四个出口（仍是唯一 `fetch` 点） |
| `public/contract.js` | 18 条新契约路径（me/ai、me/ai/create、me/ai/update、me/ai/delete、me/ai/validate）+ `AI_ITEM_FIELDS` 扩到 5 项 |
| `public/render.js` | `targetAttrs` 增加 `data-addr`/`data-field`/`data-value`；新增 `textareaHtml`（**唯一**多行输入用途 = 导入 JSON）；`enterAction` 缺省不再包 `<form>`（AI 编辑器是"纯输入区"） |
| `public/app.js` | `ai.` 前缀字段路由（input → 只记文本不重绘；**change → 提交 + 自动校验**）、`aiImport` 文本域路由、新增 `change` 委托 |
| `public/index.html` | 新增 `<script src="/ai-editor.js">`（在 `format.js` 之前） |

### 15.3 机器核对实跑

| 命令 | 结果 |
|---|---|
| `node --test --test-isolation=none tests/frontend/ai-editor-flow.test.js` | **9 pass / 0 fail**（AE-1/2/3/4/5/6/7/10/12） |
| `node --test --test-isolation=none tests/api/api-me-ai-edit.test.js` | **13 pass / 0 fail**（AIE-1…AIE-13，含 **AIE-12 核心不变量**与 **AIE-13 三写路径草稿护栏**） |
| `node --test --test-isolation=none tests/frontend/config-editor-flow.test.js` | **12 pass / 0 fail**（含 **CF-12 草稿 AI 在配置弹窗标灰**＝审查 F5-A 的回归） |
| `tests/frontend/{auth-ui-contract,admin-ui-contract,auth-field-contract,hub-warehouse-flow}.test.js` | 全绿（含 UI-1 文件数 9→10、AU-1 双向闭合补 28 个 F5 动作、WH-2 改为"空页已清零"、FC-1/FC-3 纳入 06 分册与新端点） |
| `npm test` / `npm run gate` / `node scripts/check-docs.js` / `npm run e2e` | **1135 通过 / 0 失败**；gate **9 PASS / 0 FAIL / 0 PEND**；check-docs **PASS**；e2e **22/22、退出码 0** |

### 15.4 与设计的偏离（逐条）

| # | 设计 | 实现 | 判定 |
|---|---|---|---|
| 1 | §4.4 候选集：`get.path` 用"合法路径前缀下拉" | 实现为**分组按钮**（战场/自身/对手/基地，共 49 项）+ 手写输入框 | ✅ 等价（按钮即候选；仍可手写，合法性由服务端裁决） |
| 2 | §7 D8：复用 F6 的 `state.viewer`（`source:'ai-editor'`） | **不适用**：裁决 ⑦ 已取消"试打"，编辑器没有帧来源 ⇒ 不加入 `VIEWER_SOURCES`（避免死代码） | ✅ 依裁决 |
| 3 | §3.2 的「校验」按钮 | 实现为**自动校验 + `重新校验` 手动重试**（裁决 ⑨） | ✅ 依裁决 |
| 4 | §3.3 查看态（只读树） | 并入编辑态的树渲染（同一套行与地址）；`ai-logic` 弹窗仍保留 F6 的只读视图 | ⚠️ 合并实现（更少代码、行为等价；若独立审查要求分离，再拆） |
| 5 | §4.2 `literal` 的"类型按钮组 + 单行输入" | 已实现（`ai-set-literal-type` + `ai.<addr>.value` 文本输入） | ✅ |

