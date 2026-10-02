# 12 · AI 积木节点系统（D-178）

> 本文是**玩家层 AI**（积木节点）的权威说明。执行层（16 类 AST 节点、runtime、回放）见 `docs/systems/08-ai.md`；
> 数据单一来源 = `server/data/ai-node-catalog.json`（目录）+ `server/data/ai-blueprint-presets.json`（预设模板）；
> 编译器 = `server/ai/blueprint.js`（L5）。
> 决策：`docs/decisions.md` **D-178**；接口：`docs/interfaces.md` §2（`/me/ai*`）、§4.15（AiNodeStack）。

## §1 设计原则（用户 2026-09-28 拍板）

1. **只有原语，没有战术宏**：节点的粒度是"一个动作 / 一个条件 / 一次计算 / 一层流程"；
   类似"风筝""连招"这类打包招式**不做成节点**（它们由原语组合而成，且一旦打包就无法微调）。
2. **每个节点只有一个固定品质**：品质 = **功能阶梯**（不是同节点的强度档）。绿 = 最基础，青 = 最高级。
   **高段位解锁的是"更高级的基本功能"**，不是更强的招式。
3. **蓝图 → 编译 → 旧 AST**：玩家只与积木层打交道；编译器把蓝图确定性翻译成旧 AST ⇒
   `runtime / engine / 回放 / 排名 / programHash` **零改动**。
4. **记忆不写变量名**：玩家说"记住这个数"，编译器自动命名变量。
5. **可收集**：节点是仓库物品（第 6 桶，可堆叠）；**装配时消耗、卸下恢复、总数量守恒**；
   **跨 AI 独占**（同一个副本同一时间只能装在一套 AI 里）。

## §2 节点目录（54 个）

字段含义：`inputs` = 子节点个数与类别（`stmt` 语句 / `bool` 条件 / `value` 数值）；`params` = 可调参数。
**距离类阈值是小数**（`type:"num"`）——半格差（如 2.5）必须能与整格差（3）区分开，否则同一族的多个变体会塌成同一个程序。

### 绿（24）—— 对战基础：能动、能打、能判断
| id | 名称 | 类别 | 子节点 | 参数 | 编译成 |
|---|---|---|---|---|---|
| `f_seq` | 按顺序 | 流程 | N×语句 | — | `seq`（编译期扁平化） |
| `f_if` | 如果…否则 | 流程 | 条件,语句[,语句] | — | `if`（缺否则 → `wait`） |
| `a_advance` | 推进（朝对手） | 动作 | — | — | `action move_right` |
| `a_retreat` | 后撤（远离对手） | 动作 | — | — | `action move_left` |
| `a_dodge_back` | 闪避（远离对手） | 动作 | — | — | `action dodge_left` |
| `a_defend` | 防御 | 动作 | — | — | `action defend` |
| `a_wait` | 等待 | 动作 | — | — | `action wait` |
| `a_skill` | 释放技能 | 动作 | — | 技能槽 1/2/3 | `action skill:skillN` |
| `v_number` | 数字 | 取值 | — | 数值 0~1000 | `literal` |
| `s_my_hp` | 我的血量 | 感知 | — | — | `get self.hp`（绝对值；按比例判断用 `s_my_hp_pct`） |
| `s_my_hp_pct` | 我的血量% | 感知 | — | — | `arith(/, self.hp, self.maxHp)` |
| `s_my_mp_pct` | 我的法力% | 感知 | — | — | `arith(/, self.mp, self.maxMp)` |
| `s_my_sp` | 我的体力 | 感知 | — | — | `get self.sp` |
| `s_my_cd` | 我的技能冷却 | 感知 | — | 技能槽 | `get self.cooldowns.skillN` |
| `s_tick` | 当前帧数 | 感知 | — | — | `get tick` |
| `s_gap` | 与对手的距离 | 感知 | — | — | `arith(-, enemy.x, self.x)` |
| `s_foe_hp_pct` | 对手血量% | 感知 | — | — | `arith(/, enemy.hp, enemy.maxHp)` |
| `c_hp_below` | 我的血量低于X% | 条件 | — | 百分比 1~100 | `cmp(<, hp%, X/100)` |
| `c_gap_less` | 距离小于X格 | 条件 | — | 格数 0~15 | `cmp(<, gap, X)` |
| `c_gap_greater` | 距离大于X格 | 条件 | — | 格数 0~15 | `cmp(>, gap, X)` |
| `c_skill_ready` | 技能N已就绪 | 条件 | — | 技能槽 | `cmp(==, cd, 0)` |
| `c_random` | 随机X% | 条件 | — | 百分比 | `random{prob}`（**表达式位**） |
| `c_and` | 且 | 条件 | 条件×2 | — | `logic and` |
| `c_or` | 或 | 条件 | 条件×2 | — | `logic or` |

### 蓝（10）—— 逻辑补全、对手侦察、通用数值
| id | 名称 | 子节点 | 参数 | 编译成 |
|---|---|---|---|---|
| `c_not` | 非 | 条件 | — | **德摩根展开**（cmp 反转 / and↔or / random→1−p） |
| `c_gap_between` | 距离在X~Y格 | — | X≤Y | `and(>=X, <=Y)` |
| `c_tick_after` | 第X帧之后 | — | 帧数 | `cmp(>, tick, X)` |
| `c_compare` | 比较 | 数值×2 | 运算符 | `cmp` |
| `v_arith` | 计算 | 数值×2 | `+ - * /` | `arith`（除数为字面 0 → 编译期报错） |
| `s_foe_sp` / `s_my_atk` / `s_my_def` | 对手体力 / 我的攻击力 / 我的防御力 | — | — | `get` |
| `s_foe_cd` | 对手技能冷却 | — | 技能槽 | `get enemy.cooldowns.skillN` |
| `s_base_hp_pct` | 基地血量% | — | 我方/敌方 | `arith(/, bases.X.hp, bases.X.maxHp)` |

### 紫（8）—— 循环与绝对方向
`f_loop_n` 重复N次（`loop{count}`）、`f_loop_until` 重复直到（`loop{while}` + 取反）、`f_forever` 一直重复、`f_break` 打断、
`a_move_left` / `a_move_right`（绝对方向）、`a_dodge_front` 闪避（朝对手）、`a_turn` 转身。

### 橙（6）—— 记忆与自身技能数据
| id | 名称 | 说明 |
|---|---|---|
| `m_remember` | 记住 | `set __m_<uid> = <数值>`（**自动命名，跨帧持久**） |
| `m_counter` | 计数+1 | `set __m_<uid> = __m_<uid> + 1` |
| `m_timer` | 计时器N帧 | 每 N 帧执行一次子节点（阈值 = N−1，计数自身归零） |
| `m_read` | 读取记忆 | 选一个记忆节点 → `getVar __m_<uid>`（未存过 = 0） |
| `s_my_skill_range` | 我的技能射程 | `get self.skills[N-1].range`（**只投影自己**） |
| `s_my_skill_type` | 我的技能类型 | `get self.skills[N-1].type` |

### 青（6）—— 子程序与状态读取
`r_sub` 子程序（`function sub_<uid>`）、`r_call` 调用子程序（`call`）、
`c_foe_stunned` 对手被控制、`c_has_effect` 我身上有效果、`s_effect_left` 我的效果剩余帧、`c_any_skill_ready` 有技能就绪。
（"存在性"类条件按**固定索引展开** `effects[0..3]`，不需要玩家理解索引。）

## §3 编译规则（`server/ai/blueprint.js`）

1. **扁平化**：运行时的 `st === 'seq'` **没有分支**（嵌套 `seq` 语句会被静默忽略）⇒ 编译器组装语句列表时
   把内层 `seq` 就地展开；因此 `traceMap` 改为**编译后二次扫描**生成（编译期只给语句节点打临时标签，最后剥掉，不污染 `programHash`）。
2. **分支必然是 `seq` 且必然含动作**：`if.then/else`、`loop.body`、`function.body` 统一编译成 `seq`；
   分支内没有动作时自动补 `wait`（否则 AST 合法层报 `branch_without_action`）。
3. **取反（德摩根）**：`c_not` 只作用于条件类节点；`random` 取反 = 概率取补 `1−p`。
4. **记忆**：AST 合法层要求 `getVar/set` 的名字在程序某处被 `var` 声明过，而**顶层 `var` 会随隐式主循环每轮重跑**
   （= 每轮清空记忆）⇒ 声明放进**执行 0 次**的循环体（`loop{count,times:0}`），真实写入靠 `set` 落到跨帧持久的根作用域。
5. **产物必过 `ast.validate`**：编译器最后一步跑 AST 校验；不通过则整个编译失败（不产出半成品）。
   失败时错误 path：结构类 = `body[i].inputs[j]`；规则类 = 节点 `uid`（编辑器两者都能定位）。
6. **确定性**：同一蓝图 → 逐字节相同的 AST（记忆变量名由节点 uid 派生）。

## §4 限额（`server/ai/ast.js` LIMITS，D-178 重标定）

| 项 | 值 | 说明 |
|---|---|---|
| 蓝图节点数 | **128** | 蓝图自身上限（`blueprint.limits.maxSlots`） |
| 蓝图嵌套 | 24 层 | UI 与可读性保护 |
| AST `maxNodes` | 20000 | 积木层编译后会膨胀 3~10 倍 |
| AST `maxDepth` / `analyzeDepth` | 128 / 128 | **必须同级**，否则深层分支被误判"分支缺少动作" |
| AST `maxBytes` | 512KB | |
| `stepLimit` / `traceLimit` | 10000 / 20000 | 每 tick；trace 提高以覆盖整 tick（对外按积木层投影） |

## §5 收集与占用

- **产出**：AI 节点包（`packageKind='aiNode'`）每包 1~3 个节点堆叠；**节点品质** = 包品质及以下**均匀**
  （`package-config.nodeQualityCurve`）；**包质量百分比只决定个数**（`itemCountCurve`）。
- **堆叠**：仓库第 6 桶 `aiNode`，条目 `{uid, kind:'aiNode', nodeId, name, category, quality, count}`；
  同 `nodeId` 自动累加 `count`（不占额外槽位）。
- **新手起步**：注册发放**全部绿档节点**（结构类多份：`f_if`×3、`f_seq`×2），保证开箱前就能搭出完整 AI。
- **占用**：`空闲 = count − Σ(所有 ready 蓝图用量)`；**跨 AI 独占 + 同蓝图独占**；**草稿不占用**；
  超量保存 → `400 ai_node_shortage`。`GET /me/ai/nodes` 回带 `inventory[{nodeId,owned,used,free}]`。
- **段位门控**：由"包品质 = 玩家段位"自然实现（`unlock.json` 不再门控节点）。

## §6 预设模板（`server/data/ai-blueprint-presets.json`）

| id | 名称 | 思路 | 用到的节点 |
|---|---|---|---|
| `preset_rush` | 贴身猛攻 | 距离 <3 放技能 1，否则推进 | `f_if c_gap_less a_skill a_advance` |
| `preset_kite` | 风筝射手 | 血 <30% 后撤；技能 1 就绪且距离 <5 开火，否则闪避拉开 | `f_if c_hp_below a_retreat c_and c_skill_ready c_gap_less a_skill a_dodge_back` |
| `preset_guard` | 防守反击 | 血 <50% 防御；2 格内放技能 1，否则等待 | `f_if c_hp_below a_defend c_gap_less a_skill a_wait` |
| `preset_dodge` | 残血游走 | 血 <40% 闪避远离；距离 >4 推进，否则放技能 3 | `f_if c_hp_below a_dodge_back c_gap_greater a_advance a_skill` |

约束（由 `tests/unit/ai-blueprint-presets.test.js` 机器核对）：**只用绿档节点**、**每节点用量 ≤ 新手自带上限**、
全部可编译且过 `ast.validate`。编辑器提供"一键套用"，套用后即为普通蓝图，可随意拆改。

## §7 高亮与投影（积木层）
- 编译产物附 `traceMap`：**AST 路径 → 积木节点 uid**（只登记语句节点；表达式节点运行时不留 trace）。
- 运行高亮**只显示积木层**（"当前执行到哪个积木节点"）；**底层 AST 与完整 trace 仅管理员/调试模式可见**。
- 对局快照对外**只回蓝图**；内部另存冻结 AST（保证玩家改编译器版本也不会让已存防守 AI 行为漂移）。
- 快照投影新增 `self.skills[0..2].{slotKey,type,range,distance,bulletCount,multiplier,costHp,costMp,costSp,cooldown,ready,level}`
  —— **只给自己**（不投影敌方技能数据）；弹幕维持不投影（同 tick 解算，时序上不可观测）。

## §8 默认 AI 与 bot 预设（D-178 起）

- **默认 AI = 绿档积木蓝图**：`server/ranked.js` 的 `blueprintOf(preset, sub)` 构造蓝图，`buildDefaultLoadout` 编译成 AST
  （编译失败才回退旧的 `aiProgramOf`）；返回体带 `aiBlueprint` / `aiTraceMap` / `aiCompilerVersion`。
  三条分支语义：太远（`gap > threshold`）→ 推进；敌人已在身后（`gap < 0`）→ 后撤；否则开火；带血线时最前加"残血 → 防御"。
- **约束**（写死在新号体验上）：默认蓝图**只用绿档节点**、每节点用量 ≤ 新手自带上限（`f_if`≤3、`f_seq`≤2、其余 1）
  ⇒ starter 的默认 AI 自己就装得上（`tests/unit/ai-node-pack.test.js` NP-6 把关）。
- **9 个子变体必须是 9 个不同程序**（`steady/aggressive/kite` × 3）：阈值保留小数差异，否则同族镜像恒平局、匹配池退化。
- **行为冻结基线**：`tests/unit/ai-blueprint-bots.test.js` 的 BB-1 用固定探针快照锁定 9 个程序的动作序列；
  改预设或改编译器导致决策变化 → 该表必须显式更新（防"悄悄改弱/改强默认 AI"）。
- **starter 的默认 AI 必须等于身份派生的默认 AI**（D-159 契约，`load-integrity` LOAD-0/A8 核对）；
  D-178 起该 AI 同时带蓝图 → **新号开局就有一套可编辑的积木 AI**。

**前端接口（已实现，`public/ai-blueprint.js`）**：`highlightOf(trace, traceMap, isAdmin)` →
- `isAdmin=false`（默认）→ `{mode:'blueprint', rows:[{seq,uid,nodeType,phase,path}], current, dropped}`：
  `rows` 只含**能映射到积木 uid** 的 trace 条目（保序）；`current` = 最后一条（=「现在运行到哪个积木节点」）；
  `dropped` = 被丢弃的合成语句数（记忆声明块、编译器补的 `wait`、表达式节点）。
- `isAdmin=true` → `{mode:'admin', rows:[{seq,path,nodeType,phase,depth}]}`：原样底层，供排障。
- 另有 `projectTrace(trace, traceMap)` / `rawTrace(trace)` 两个分体函数。
