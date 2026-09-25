# F6 设计与实现冻结：快速对战屏（含战斗查看器 + AI 逻辑查看器）

> 版本：v1　创建：2026-09-25　状态：**设计已冻结（总纲 §2 协作协议）；实现与机器核对中；人工走查待用户执行**
> 依据：`docs/frontend/00-rules.md`（总纲：§1 绘制边界 / §2 协作协议 / §3 文档体系 / §4 验收机制）；`docs/interfaces.md` §2/§4.3（接口唯一权威）；`docs/decisions.md` §14.4/§14.5/§14.6/§14.7（D-164…D-169）。
> 权威链：`docs/decisions.md` > `docs/systems/*` > `docs/v3-design.md` > `docs/interfaces.md` > `docs/tasks.md` > `docs/frontend/*`。
> 本文件是 P6 批次 **F6** 的唯一实现依据；实现期内任何改动按 §3.4 在同一提交内更新本文件与 `docs/progress.md`。

---

## 0. 本轮的取证方式（总纲 §2.3：运行时事实必须实测）

| 探针 | 覆盖 | 结论落点 |
|---|---|---|
| `%TEMP%\probe-f6\probe-f67-shapes.js`（进程内起真实服务 + 真实 HTTP） | `POST /quick/run` 的 `data` 键集与逐字段值；`frames[i]` 与 `diff` 键集；`players.p1/p2` 键集；`bullets[]/damages[]/verdict` 形状；**`aiTrace` 是扁平数组**（不是按侧容器）与条目键集；`GET /replay/:id`（`?frames=render|debug|nope`）；`GET /leaderboard`；`GET /me`；`GET /me/ai`；`GET /me/configs`；`GET /me/records`；`GET /me/defense`（`/me/stats` 404） | §3/§5/§6/§8 |
| 独立上下文子代理（后端契约清点，只读） | 上表逐项的 `file:line` 出处 + **文档与代码不一致清单 10 条** | §9.3、§13 |

实测要点（本批全部设计基于此，不引文档二手结论）：
- `quick/run.data` 键集 = `battleId, seed, winner, ticks, window, opponentWeight, recoveryHours, zeroSum, self{pointsBefore,pointsAfter,delta,winProbability}, opponent{publicId,nickname,tier,isBot,pointsBefore,pointsAfter,delta}, replayId, frames, duplicate`。
- 帧 = `{tick, diff}`，`diff` 键集 = `tick, players{p1,p2}, bullets[], bases{p1,p2}, collision, baseHits[], bulletHits[], damages[], verdict, aiTrace[]`。
- **`data.seed`（对局种子）本批刻意不读**：它无法喂回任何入参复现对局（请求 `seed` 只影响匹配抽选），且 `data.seed` 已被 03 分册登记为「前端不读」（`me/box` 的 D-162 口径，FC-4 按路径强校验）→ 复现/排查一律用 `battleId`（回放句柄）。
- `players.<side>` = `fromX,toX,facing,hp,mp,sp,maxHp,maxMp,maxSp,atk,def,defending,dodging,fullDodge,action{kind,dir?,sid?,cells?},effects[]`。
- `verdict = {winner, phase} | null`（**非末帧为 `null`**；`phase ∈ base|role`）。
- `aiTrace` = **扁平数组**，条目 `{tick, owner, seq, path, nodeType, phase, depth, result?}`，`result` 仅 `action` 节点有。
- `GET /replay/:id` 默认就带 `frames`；`?frames=debug` 需管理员（本批**不用**）。

---

## 1. 范围与端点 UI 映射（规则 4.3）

| # | 端点 | 本批 UI 路径 | 状态 |
|---|---|---|---|
| 1 | `POST /api/v1/quick/run` | 快速对战屏·「开始快速对战」→ 结果行 + 内联完整战斗过程逐帧查看 | ✅ 本批接 UI（D-167 已内联 `frames`） |
| 2 | `GET /api/v1/replay/:id` | 快速对战屏·「读取本场回放」（**仅当本次响应未带帧**时出现） | ✅ 本批接 UI |
| 3 | `GET /api/v1/me/configs` | AI 逻辑查看器·读取**我方出战配置的 AI 程序正文**（`slot.loadout.ai`） | ✅ 复用提交③ 出口 |
| 4 | `GET /api/v1/me` | 已有（hub/profile） | 复用 |
| 5 | `GET /api/v1/leaderboard` | — | ⛔ F7 |
| 6 | `POST /api/v1/ranked/run`、`/ranked/promote`、`/me/records`、`/me/defense` | — | ⛔ F7 |
| 7 | 其余 P0–P7 端点 | — | ⛔ 已由 F1/F2/F3 接 UI 或显式不做（`01/02/03` 分册 §1） |

**非目标（本批显式不做）**：不做自动播放/动画（§2 反驳 1）；不做战斗画面绘制（总纲 §1.2）；不做 AI 编辑（F5 正式批次）；不做对手 AI 源码（后端不提供，§13 R-2）；不做战绩列表/防守记录屏（F7 之后的批次）；不改任何 `/api/v1` 契约（本批**零后端改动**）。

---

## 2. 采用的模式与被否决的替代（总纲 §2.5 ①）

**采用**：沿用 F1–F3 的既有模式 —— 零依赖双模模块、纯 `render(vm)`、`state` 单容器、唯一网络出口 `api.js`、唯一 DOM 写入点 `app.js`、动作注册表 `actions.js`、投影单一真源 `format.js`。F6 只**新增状态切片与投影**，不新增 `public/` 文件（`UI-1` 锁死 9 文件）。

**反驳清单（对"最自然的实现方式"的自我攻击；每条都给反例与代价）**

| # | 被反驳的提案 | 反例 / 后果（按该设计实现会怎么坏） | 本批处置 |
|---|---|---|---|
| 1 | 「战斗查看器要能自动播放（定时器逐帧推进）」 | ① 自动播放需在 `format.js` 里维护"播放中/帧率"状态 → 违反"绘制方法零逻辑"（渲染时要读时钟）；② 需在 `app.js` 引入 `setInterval` 这个**第二个副作用源**，而现有测试对"唯一 DOM 写入点 / 单入口"是机器断言的（`auth-ui-contract` UI-8），定时器会让"每次状态变化都重绘"变成"每秒重绘 N 次"，测试必须注入假时钟才可判定；③ 文本界面里"动画"本身就是被 §1.3 排除的东西。**备选**：定时器 + 可暂停；**代价**：功能冗余、状态机翻倍、可玩性不增（用户仍要等待） | ❌ 不做自动播放；只提供 `第一帧/上一帧/下一帧/最后一帧` 四个按钮（点击即确定性重绘） |
| 2 | 「查看器状态各屏一份（`state.quick.frames` + `state.tournament.frames`）」 | 同一事实（当前正在看的帧数组）会有两个来源；F7 的"看这一场"要么复制一份投影代码（违反投影单一真源 §1.5），要么在两个切片间同步 → 出现"在看 F6 的帧但按钮显示 F7 的页码"这类不可判定的中间态 | ✅ 抽公共切片 `state.viewer`（帧 + 帧游标 + 侧位 + 数据源），F6/F7 共用同一组动作 |
| 3 | 「`duplicate`/幂等重放时帧缺失就直接显示空」 | 实测：`quick/run` 命中幂等路径仍回带 `frames`，但 `ranked/run` 的**重放批次**里 `results[i]` **根本没有 `frames` 键**（子代理清点：`server/ranked.js:527-559`）。若不做兜底，用户会遇到"点了开始、有 10 场结果、点进去一片空白且无路可走" → 违反"按钮永不无声"的实质（有按钮但语义不完整） | ✅ 帧为空时**必须**渲染「读取本场回放」按钮（`GET /replay/:battleId`），并在文案里说明原因 |
| 4 | 「前端自己算"谁赢了/伤害多少"更省字段」 | 违反总纲 §1.5「禁止前端复制战斗公式」：胜负与伤害已由服务端给出（`winner`/`damages[]`），前端再算一份会与服务端的背击/暴击/衰减口径漂移 | ✅ 只消费 `winner`/`verdict`/`damages[]`/`bullets[].outcome`；前端不做任何命中/伤害推演 |
| 5 | 「AI 逻辑查看器顺便把对手的 AI 程序也画出来」 | 后端**不提供**对手 AI 源码（`/me/ai` 只回调用者自己的库；帧里只有 `aiTrace`），硬做等于前端伪造数据；且 D-167/SEC-33 只接受了"轨迹可见" | ✅ 我方显示**程序树 + 本帧执行标记**；对手只显示**轨迹**并明确写出「源码不外泄（SEC-33）」 |
| 6 | 「帧列表全部渲染成按钮（N≈60 → 60 个按钮）」 | 60 个按钮 × 每帧 10+ 行文本 = 单屏上千行，且每个按钮都要进"动作可达"核对集合（`AU-1`/`UI-2`），徒增噪声；文本界面下"跳到第 N 帧"用按钮墙表达的收益极低 | ✅ 四个步进按钮 + 「第 i/n 帧」文字；被否决的按钮墙记入 §13 |

**与行业主流做法的关系（总纲 §2.5 ① 要求点名）**：主流是"用 canvas/WebGL 回放战斗 + 时间轴拖动"。本项目**刻意不采**：① 零依赖、无框架、无图形（§1.2）；② 本批只验证"前后端交互与按钮完整性"，画面呈现不是本批的合格线。**采**的部分：帧数据的组织方式（服务端权威、客户端只投影）与主流一致。

---

## 3. 屏幕清单与交互（文本界面；总纲 §1.2/§1.4）

### 3.1 屏 `quick`（快速对战）

- 静态文字：屏标题 `快速对战`；提示行说明"由服务端抽对手、内联完整战斗过程、AI 一律按 p1 坐标系书写（D-164）"。
- 未跑过：文本区一行 `（尚未发起对局：点「开始快速对战」）`。
- 跑过之后（`state.quick.envelope` 非空）：
  - **结果区**（`#result`）：`对手 <nickname>（<publicId>，段位<tier>，<bot|玩家>）· 结果 <你赢了|你输了|平局|无效对局> · 积分 <before>→<after>（<+delta>）· 胜率预测 <winProbability> · 共 <ticks> tick`
  - **抽池行**：`抽池窗口 <window> · 对手冷却权重 <opponentWeight> · 回满小时 <recoveryHours> · 零和 <是|否> · 本次为重复对局 <是|否>`
  - **查看器行**：`战斗查看器：第 <i+1>/<n> 帧（tick <tick>）` + 该帧全部文本（§3.2）
  - **AI 轨迹行**：`<我方|对手> AI 本帧轨迹（<k> 条）：<path 列表>`（§3.4）
- 按钮：`开始快速对战`（`quick-run`）／`第一帧`（`viewer-first`）／`上一帧`（`viewer-prev`）／`下一帧`（`viewer-next`）／`最后一帧`（`viewer-last`）／`看我方(进攻方)轨迹`（`viewer-trace-p1`）／`看对手(防守方)轨迹`（`viewer-trace-p2`）／`AI 逻辑查看器`（`viewer-ai-logic`）／`读取本场回放`（`viewer-load-replay`，**仅当无内联帧**）／`返回主界面`（`goto-hub`）。
- 边界禁用：`busy` 时全部禁用；无帧时四个步进按钮与两个轨迹按钮禁用；已是第一/最后一帧时对应按钮禁用（禁用即"不发请求、不静默"）。

### 3.2 战斗查看器（`state.viewer`，屏内文本区，非弹窗）

把 `frames[i].diff` 逐项转文字（**只读**，不做任何推演）：
```
第 3/41 帧（tick 3）
我方 p1：位置 352→416 朝向 +1 · hp 89/89 · mp 39/39 · sp 53/53 · atk 10 · def 9 · 行动 右移 · 状态 无
对手 p2：位置 672→608 朝向 -1 · hp 100/100 · mp 40/40 · sp 60/60 · atk 10 · def 8 · 行动 左移 · 状态 无
基地：p1 100/100（def 64） · p2 100/100（def 64）
弹幕：b_43（p2，straight，dir -1，v 512，长 512）672→608 命中 p1
碰撞：接触点 640（t=3）
撞基地：p1 撞 p2 基地 @608
伤害：p1 -7（bullet，来源 p2/b_43）暴击×1 背击×1
判决：p2 胜（phase=role）
```
- 空数组时对应行**整行不出现**（不打印空标题）。
- `action` 文本：`move→左移/右移`、`dodge→左闪/右闪`、`forced_move→被推左/右`、`cast→释放<sid>`、`displacement→位移<sid>`、`defend→格挡`、`turn→转身`、`wait→待机`。
- `effects[]` 文本：`<kind>(<stat><delta>，剩<remaining>)`，多个用 `、` 连接；空则 `无`。

### 3.3 AI 逻辑查看器（屏内弹窗 `state.modal.kind='ai-logic'`，FR-10）

- 打开时**静默**读取一次 `GET /me/configs`（落 `state.viewer.configs`；**不碰** `state.configs`，避免丢弃配置编辑器里未保存的草稿）。
- 弹窗内容（全文本）：
  1. `我方 AI：<name 或 aiId 或「（该配置没有 AI）」>`
  2. 程序树：按 AST 逐节点缩进一行，行尾带**稳定路径**（与帧里 `aiTrace[].path` 同一语法：`body.s[i]` / `.then` / `.else` / `.body`），**本帧执行过的节点**行尾追加 `← 本帧执行`；
  3. `本帧执行轨迹（我方 <k> 条 / 对手 <m> 条）`：逐条 `#seq <owner> <path> <nodeType>[ → <result>]`；
  4. 固定说明行：`对手 AI 只提供执行轨迹、不提供源码（D-167 / SEC-33）`。
- 按钮：`关闭`（`modal-close`）。点弹窗外背景同样关闭（`render` 统一产出）。
- 程序树节点文案（16 类节点全覆盖，`literal/get/var/set/getVar/arith/cmp/logic/random/if/loop/break/function/call/action/seq`）：以表达式渲染（`self.hp < 30`、`(enemy.x - self.x)`、`random(<p>)`）与语句渲染（`action move_right`、`loop count×3`、`call foo`、`break`）为准；深度上限 32 层（超出打 `…（超出显示深度）`，防病态程序把屏幕打爆）。

### 3.4 AI 轨迹（屏内文本行）

`aiTrace` 是**扁平数组**，按 `owner` 过滤后逐条渲染，仅显示**当前帧 tick 的条目**（引擎每 tick 清空缓冲，实测每帧只含本 tick）。

---

## 4. 按钮 ↔ 动作白名单（规则 4.1；F6 增量 9 个）

| 动作 | 触发控件 | 行为 | 成功可见文本 | 失败可见文本 |
|---|---|---|---|---|
| `quick-run` | 快速对战屏·`开始快速对战` | `POST /quick/run {}` → 落 `state.quick.envelope`；帧数组并入 `state.viewer`（游标归零） | 结果区（§3.1） | 服务端文案（`no_opponent`/`no_active_config`/`loadout_invalid`/`banned`…） |
| `viewer-first` | 查看器·`第一帧` | 帧游标 → 0 | 帧文本更新 | —（无帧时按钮禁用） |
| `viewer-prev` | 查看器·`上一帧` | 帧游标 −1（夹到 0） | 同上 | — |
| `viewer-next` | 查看器·`下一帧` | 帧游标 +1（夹到 n−1） | 同上 | — |
| `viewer-last` | 查看器·`最后一帧` | 帧游标 → n−1 | 同上 | — |
| `viewer-trace-p1` | 查看器·`看我方(进攻方)轨迹` | 轨迹侧 → `p1` | 轨迹行切到 p1 | — |
| `viewer-trace-p2` | 查看器·`看对手(防守方)轨迹` | 轨迹侧 → `p2` | 轨迹行切到 p2 | — |
| `viewer-ai-logic` | 查看器·`AI 逻辑查看器` | 静默 `GET /me/configs` → 打开 `ai-logic` 弹窗 | 弹窗（§3.3） | 网络/401 文案（**不打开空弹窗**） |
| `viewer-load-replay` | 查看器·`读取本场回放`（**仅当无内联帧**） | `GET /replay/<battleId>` → 帧并入 `state.viewer` | `已读取回放：<n> 帧` | `410 replay_expired` / `403 replay_forbidden` 文案 |

- 双向核对口径：`admin-ui-contract.test.js` 的 `F6_ACTIONS` 数组 ←→ 本表 ←→ `actions.ACTIONS` 键集（`AU-1`）；非管理员态可达性由 `auth-ui-contract.test.js` 的 `nonAdminRenderings()` 纳入"快速对战屏（含帧）"状态（`UI-2`）。
- 本批**不新增** `data-*` 寻址键（`app.js` 的 `payloadOf` 白名单 9 键不变）：步进与侧位切换都是"整屏动作"，不需要行级目标。
- `busy` 时全部按钮 `disabled`（`UI-5` 机器核对）。

---

## 5. 字段来源契约（规则 4.2）

### 5.1 端点字段（进 `contract.AUTH_FIELD_CONTRACT`，`FC-1/FC-2/FC-3` 强制）

| 端点 | 字段路径 | 用途 |
|---|---|---|
| `quick/run` | `data.battleId` | 对局 id（无内联帧时用它读回放；也是唯一可复现句柄） |
| `quick/run` | `data.winner` | 结果行（绝对口径 `p1\|p2\|draw` → 你赢了/你输了/平局） |
| `quick/run` | `data.ticks` | 结果行·总 tick |
| `quick/run` | `data.window` | 抽池行·匹配窗口 |
| `quick/run` | `data.opponentWeight` | 抽池行·对手冷却权重 |
| `quick/run` | `data.recoveryHours` | 抽池行·冷却回满小时 |
| `quick/run` | `data.zeroSum` | 抽池行·零和校验 |
| `quick/run` | `data.duplicate` | 抽池行·是否重复对局 |
| `quick/run` | `data.self.pointsBefore` | 结果行·我的积分前值 |
| `quick/run` | `data.self.pointsAfter` | 结果行·我的积分后值 |
| `quick/run` | `data.self.delta` | 结果行·我的积分变化 |
| `quick/run` | `data.self.winProbability` | 结果行·胜率预测 |
| `quick/run` | `data.opponent.publicId` | 对手行·账号 |
| `quick/run` | `data.opponent.nickname` | 对手行·昵称 |
| `quick/run` | `data.opponent.tier` | 对手行·段位 |
| `quick/run` | `data.opponent.isBot` | 对手行·是否 bot |
| `quick/run` | `data.opponent.pointsBefore` | 对手行·积分前值 |
| `quick/run` | `data.opponent.pointsAfter` | 对手行·积分后值 |
| `quick/run` | `data.opponent.delta` | 对手行·积分变化（双向记账可见） |
| `quick/run` | `data.replayId` | 读回放用的 id（与 `battleId` 同值，实测） |
| `quick/run` | `data.frames` | 内联完整战斗过程（逐帧查看器的唯一数据源） |
| `replay/:id` | `data.id` | 回放头·对局 id |
| `replay/:id` | `data.winner` | 回放头·判决 |
| `replay/:id` | `data.phase` | 回放头·判决依据（`base\|role`） |
| `replay/:id` | `data.ticks` | 回放头·总 tick |
| `replay/:id` | `data.frames` | 无内联帧时的帧来源 |

### 5.2 帧与轨迹的子对象字段（**不含 `data.` 前缀** —— 从 `data.frames[i]` 上读取，故不进 `FC-2/FC-3` 的信封级核对）

由 `tests/frontend/quick-battle-flow.test.js` 的 **QB-6** 三方核对：`contract.js` 的字段数组 == 本节清单 == `format.js` 中出现的字面量；并由 QB-1 在**真实响应**上逐字段验证存在。

- 帧：`tick` `diff`
- `diff`：`players` `bases` `bullets` `baseHits` `bulletHits` `damages` `collision` `verdict` `aiTrace`
- `players.<side>`：`fromX` `toX` `facing` `hp` `mp` `sp` `maxHp` `maxMp` `maxSp` `atk` `def` `defending` `dodging` `fullDodge` `action` `effects`
- `action`：`kind`（**可选**：`dir` 只在 move/dodge/forced_move/displacement；`sid` 只在 cast/displacement；`cells` 只在 forced_move）
- `effects[i]`：`uid` `kind` `stat` `delta` `displacement` `remaining`
- `bullets[i]`：`uid` `owner` `level` `btype` `dir` `v` `len` `spawnX` `endX` `outcome` `hitTarget` `collideWith` `collideWinner` `collided` `expired`（**可选**：`falloffFactor` —— 引擎只对"有衰减的弹幕"补该键，实测近战弹幕没有）
- `damages[i]`：`target` `amount` `atX` `kind` `srcUid` `attacker` `crit` `critM` `backstab` `backM` `dodged`
- `baseHits[i]`：`owner` `by` `atX`
- `bulletHits[i]`：`uid` `target` `atX`
- `collision`：`contactX` `t`
- `verdict`：`winner` `phase`
- `aiTrace[i]`：`tick` `owner` `seq` `path` `nodeType` `phase` `depth`（**可选**：`result` —— **只有 `action` 节点**才有，值为该 action 名，见 `systems/08-ai.md` §3）

### 5.3 AI 程序 AST（`me/configs` 的 `data.slots[i].loadout.ai`；**直接属性访问**，`CONFIG_LOADOUT_FIELDS` 已含 `ai`/`aiId`）

- 节点类型 16 类（`literal` `get` `var` `set` `getVar` `arith` `cmp` `logic` `random` `if` `loop` `break` `function` `call` `action` `seq`）与路径语法（`body` / `.s[i]` / `.then` / `.else` / `.body`）以 `docs/systems/08-ai.md` §3 为权威。
- **机器核对 QB-7**：`format.AI_NODE_TYPES` 必须与 `server/ai/ast.js` 的 `NODE_TYPES` 逐值相等（前端不得少画/多画节点类型）；`format.AI_MAX_DEPTH` 存在且为正整数。

---

## 6. 全部失败路径（增量）

| code | HTTP | 触发 | 界面文案 |
|---|---|---|---|
| `no_opponent` | 409 | 池内无候选/窗口用尽（D-152：不用 bot 充数） | 服务端文案 + `稍后再试（可先注入调试 bot 或注册更多账号）` |
| `no_active_config` | 409 | 没有出战配置 | 服务端文案 + `（先到「出战配置1」装配并激活）` |
| `loadout_invalid` | 409 | 出战快照无法实例化 | 服务端文案 + 字段级 `error.details[0].path` |
| `store_not_found` | 404 | 档案缺失 | 服务端文案 |
| `replay_expired` | 410 | 回放快照已淘汰/版本不符 | `回放已过期（快照已淘汰或引擎/数据版本不符）` |
| `replay_forbidden` | 403 | 非参与者读归档回放 | `该回放只对参战双方开放` |
| `unauthorized` / `session_expired` | 401 | 会话失效 | 按 F1 §6 统一登出 |
| 传输失败 | — | 网络/非 JSON | `无法连接服务器：<原因>` |
| 本地拦截 | — | 无帧时点步进/轨迹按钮 | 按钮 `disabled`（不产生点击），**不出现空文案按钮** |

---

## 7. 状态与持久化（`public/store.js`）

```js
// F6：快速对战（只存最近一次响应信封；投影全在 format.js）
quick: { envelope: null },
// F6/F7 共用：战斗查看器（帧数组 + 游标 + 侧位 + 数据源 + 回放/配置信封）
viewer: { frames: null, index: 0, source: null, battleId: null, traceOwner: 'p1', configs: null, ai: null, replay: null },
```
reducer 动作增量：`quick.set`（`{envelope}`）／`viewer.set`（`{frames, source, battleId}`，游标归零）／`viewer.frame.set`（`{index}`）／`viewer.trace.set`（`{owner}`，仅 `p1|p2`）／`viewer.configs.set`（`{envelope}`）／`viewer.replay.set`（`{envelope}`）／`viewer.clear`。
- **持久化**：本批**不写任何持久化**（`localStorage` 无新键；帧数组只在内存）。登出/会话失效时 `clearUserState` 一并清空 `quick`/`viewer`（不残留上一账号的战斗）。
- 弹窗种类 `MODAL_KINDS` 增量：`ai-logic`（至多一个弹窗的既有约束不变）。

---

## 8. 边界条件

| # | 边界 | 行为 |
|---|---|---|
| Q-1 | `frames` 为空数组 | 查看器区显示 `（本场没有帧数据：点「读取本场回放」）`，步进/轨迹按钮禁用 |
| Q-2 | `frames` 为 `null`/缺失（幂等重放） | 同上，且「读取本场回放」可用（走 `GET /replay/:battleId`） |
| Q-3 | `battleId` 为 `null`（理论上不会） | 不渲染读取回放按钮（无 id 不可请求），文案写明"缺少对局 id" |
| Q-4 | `winner='invalid'` | 结果区 `无效对局（对手快照不可用）`，仍显示帧（若有） |
| Q-5 | `opponent.isBot=true` | 对手行标注 `bot`（不隐藏：调试 bot 是合法对手，D-166） |
| Q-6 | 帧里 `verdict=null` | 不打印判决行；末帧打印 |
| Q-7 | 帧里 `action=null` | 行动打印 `未知`；不抛错（UI-6：初始态/边界态不得渲染 `undefined`） |
| Q-8 | `effects` 为空 | 状态打印 `无` |
| Q-9 | 配置无 AI（`loadout.ai=null`） | AI 逻辑查看器写 `（该配置没有 AI）`，仍列出轨迹 |
| Q-10 | 配置读取失败（网络/401） | 不打开空弹窗；写失败文案（按钮永不无声） |
| Q-11 | 程序深度 > 32 | 截断并写 `…（超出显示深度）` |
| Q-12 | `aiTrace` 为空（某帧 AI 未记录） | 轨迹行写 `（本帧无 AI 轨迹）` |

---

## 9. 后端变更摘要

**本批零后端改动。** F6 完全建立在 D-167 已落地的帧契约与既有 `/quick/run`、`/replay/:id`、`/me/configs` 之上。

### 9.3 顺带修文档漂移（子代理清点，均为 `docs/interfaces.md` 与代码不一致；只改文档，不改代码）

| # | 文档原说法 | 代码事实 | 处置 |
|---|---|---|---|
| 1 | §4.3 帧 `verdict = {winner, reason, phase, ticks}` | `{winner, phase}`，非末帧 `null` | ✅ 本批改正 |
| 2 | §2 `/leaderboard` 行「只回 `publicId/nickname/points/tier`」+ 只列 `bad_scope` | 行内含 `rank`；`limit` 非法 → `bad_request` | ⏳ F7 一并改（同一端点由 F7 扩展） |
| 3 | §2 `/quick/run` 把 `store_not_found` 记在 409、未记 `loadout_invalid` | 404 `store_not_found`；409 `loadout_invalid` | ✅ 本批改正 |
| 4 | §2 `/ranked/run` 把 `store_not_found` 记在 409 | 404 | ⏳ F7 一并改 |
| 5 | §4.3 暗示 `aiTrace` 是按侧容器 | 扁平数组（每条带 `owner`） | ✅ 本批改正 |
| 6 | §2 `/ranked/run` 未写「`shortfall>0` 时强制不判晋升」 | `ranked.js:749` | ⏳ F7 一并改 |

---

## 10. 机器核对（本批新增；`tests/frontend/quick-battle-flow.test.js`）

| 编号 | 断言 |
|---|---|
| QB-1 | 真实 HTTP：注册 → 注入 bot → `quick-run` → 结果行逐字由真实字段拼出；帧数与 `data.ticks` 相等；`state.viewer.frames` 与响应同源 |
| QB-2 | 帧投影：对真实帧跑 `frameLines`，`第 i/n 帧`、双方位置/血量/行动、弹幕/伤害/判决行齐全，且**不出现 `undefined`/`null`**（全帧遍历） |
| QB-3 | 查看器按钮语义：`viewer-first/prev/next/last` 的夹取边界（0 与 n−1），禁用状态随游标变化；**不发任何请求**（本地动作） |
| QB-4 | 轨迹：`viewer-trace-p1/p2` 切换后，轨迹行的 `owner` 与当前帧 `aiTrace` 同源；条数 == 该 owner 在该帧的条目数 |
| QB-5 | AI 逻辑查看器：真实 `GET /me/configs` → 弹窗含我方 AI 名与程序行；本帧执行节点被标记；对手只有轨迹；点背景可关闭 |
| QB-6 | 帧字段三方一致：`contract` 的 9 个字段数组 == 04 §5.2 清单 == `format.js` 中出现的字面量；并在**真实帧**上逐字段验证存在（`FORMAT-1`） |
| QB-7 | AI 节点类型 16 类与 `server/ai/ast.js` 的 `NODE_TYPES` 逐值相等；程序树渲染对**出厂 starter AI 的真实 program** 全覆盖（无未知节点、无异常） |
| QB-8 | 预校验与失败路径：无帧时步进动作是空操作（不发请求）；`viewer-ai-logic` 在配置读取失败时不打开弹窗且写文案；`replay_expired`/`403` 文案 |
| QB-9 | 「按钮永不无声」闭环：快速对战屏（有帧态）渲染出的 `data-action` 全部命中注册表；注册表里的 F6 动作全部在该屏出现（双向） |
| QB-10 | `busy` 时快速对战屏全部按钮 `disabled`；`quick-run` 在 busy 下不重复发请求 |

---

## 11. 人工走查剧本（总纲 §4.4）

前置：`npm start`；需**至少两个账号**在池内（或 `DL_DEBUG_BOTS=1` + 管理员注入若干 bot）。

| 步 | 点哪里 | 看什么 | 期望文本 |
|---|---|---|---|
| 1 | 主界面 → `快速对战` | 快速对战屏 | 标题 `快速对战`；文本区 `（尚未发起对局：点「开始快速对战」）`；步进按钮**禁用** |
| 2 | 点 `开始快速对战` | 结果区 | `对手 <昵称>（u_…，段位 common，bot|玩家）· 结果 你赢了|你输了|平局 · 积分 0→<n>（<±d>）· 胜率预测 0.5 · 共 <t> tick` |
| 3 | 看抽池行 | 文本区 | `抽池窗口 100 · 对手冷却权重 1 · 回满小时 4 · 零和 … · 本次为重复对局 否` |
| 4 | 点 `下一帧` ×3 | 查看器区 | `第 4/<n> 帧（tick 4）`，双方位置/血量随帧推进变化 |
| 5 | 点 `最后一帧` | 查看器区 | `第 <n>/<n> 帧`；出现 `判决：p1|p2|draw 胜（phase=base|role）` |
| 6 | 点 `第一帧` | 查看器区 | `第 1/<n> 帧` |
| 7 | 点 `看对手(防守方)轨迹` | 轨迹行 | 该行 `<owner=p2>` 的 path 列表；再点 `看我方(进攻方)轨迹` 切回 p1 |
| 8 | 点 `AI 逻辑查看器` | 弹窗 | `我方 AI：新手AI` + 程序树（`if`/`action` 逐行，含 `body.s[0]…` 路径）+ 若干行带 `← 本帧执行`；底部 `对手 AI 只提供执行轨迹、不提供源码（D-167 / SEC-33）` |
| 9 | 点弹窗外背景 | 弹窗 | 关闭，回到快速对战屏（草稿/游标不变） |
| 10 | 点 `返回主界面` → 再进 `快速对战` | 屏 | 上一场结果与帧仍在（内存态），步进可用 |
| 11 | 无候选池时点 `开始快速对战`（如把其他账号踢出池） | 结果区/提示 | `no_opponent` 的可读文案（**不是**空白或 5xx） |
| 12 | 刷新浏览器（F5） | 快速对战屏 | 结果清空（不落盘），需重新发起 |

**已知不覆盖**：本剧本不含"无内联帧 → 读取本场回放"这条（需要构造幂等重放批次，见 §13 R-1 与 QB-8 的机器断言）。

---

## 12. 定稿判定（总纲 §2.5 四项）

本批**不自署**四项结论；判定结论由独立上下文审查记录 `docs/reviews/F6.md` 出具（总纲 §2.10 附加要求：「已知未覆盖 / 已知风险」清单见 §13）。

---

## 13. 已知未覆盖 / 已知风险（不得为空）

| # | 项 | 说明 |
|---|---|---|
| R-1 | 人工走查未覆盖「无内联帧 → 读取本场回放」 | 该分支只在幂等重放/重放批次出现；走查需构造重复 `quick-run`（同 token 二次请求命中 `duplicate`）或重放 `ranked` 批次。当前由 QB-8 机器覆盖，**人工留待 F7 走查一并做**（F7 的 10 场里更常见） |
| R-2 | 对手 AI 源码不可见 | 后端不提供（`/me/ai` 只回自己的库）；前端**不伪造**。已接受的可见面 = 对手逐步 `aiTrace`（SEC-33） |
| R-3 | 无"跳到第 N 帧"输入 | 60 帧 ≈ 60 按钮的按钮墙被否决（§2 反驳 6）；代价 = 长对局里定位中间帧需连点 |
| R-4 | 前端不做帧的本地缓存/预取 | 每次 `quick-run` 都是新对局；历史对局回看要走回放（本批已提供入口） |
| R-5 | 文本化的战斗过程信息量上限 | 弹幕/伤害/基地行逐帧打印，长对局（>64 tick）单帧行数有限但**总信息量大**；本批不做折叠/过滤（F5 正式批次的查看器可加过滤） |
| R-6 | 未接 `/me/records` 战绩列表 | 属 F7 之后的批次；本批只做"刚打完的这一场" |
| R-7 | `effects` 的 `uid` 可能为 `null` | 打印为 `-`；不影响可读性 |

---

## 14. 实施与对账

- 实施顺序：`store.js`（切片 + reducer + `MODAL_KINDS`）→ `format.js`（投影 + 屏 + 弹窗 + 导出）→ `api.js`（`quickRun`/`replay`/`replayQuery` 出口）→ `actions.js`（9 个动作 + 会话清理）→ `contract.js`（28 条端点路径 + 9 个帧字段数组 + `AI_NODE_TYPES`）→ `app.js`（**不改**）→ 测试（`quick-battle-flow.test.js` 新增；`auth-ui-contract`/`admin-ui-contract`/`auth-field-contract`/`hub-warehouse-flow` 四处登记同步）→ 文档（本文件 + `interfaces.md` §9.3 漂移修正 + `progress.md`）。
- 对账（实现完成后逐条回填）：
  - §1 端点映射：`quick/run` ✅ / `replay/:id` ✅ / `me/configs` ✅
  - §4 动作 9 个 ✅（`AU-1`/`UI-2` 双向断言）
  - §5 字段 28 条 ✅（`FC-1/FC-2/FC-3`）+ 帧字段 9 组 ✅（`QB-6`）
  - §6 失败路径 ✅（`QB-8` + `format` 文案表）
