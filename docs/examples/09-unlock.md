# 示例集 · 解锁系统（全分支）

> 依据：`decisions.md`（D-112、D-120）；实现细则见 `systems/09-unlock.md`。
> 段位序号：`common=0 < rare=1 < epic=2 < legendary=3 < mythic=4`。

---

## 1. 各段位解锁表（`unlock.json` 驱动）

> **节点计数口径（已修正）**：`availableNodes(tier)` **只返回真实节点类型**——单一数据源是 `server/data/ai-nodes.json`（`base` 10 个 + `nodes` 17 类白名单）。`unlock.json` 的 `aiNodes[]` 里写的是**权限名**，其中 `while` 是别名（折叠为真实节点 `loop`，不额外授予节点）、`arith_ext` 是**未实现的预留权限**（`implemented:false` → 不授予任何节点，故 `isUnlocked(tier,'arith_ext') === false`）。因此下表按**真实节点类型**计数。

| 段位 | 新解锁（权限名） | 其中授予的真实节点 | 累计可用节点数（**真实节点类型**） |
|---|---|---|---|
| **绿 common** | `if` | `if` | **11**（10 基础 + `if`） |
| **蓝 rare** | `loop`、`while`、`break` | `loop`、`break`（`while` 折叠为 `loop`，不新增） | **13** |
| **紫 epic** | `random`、`logic`、`arith_ext` | `random`、`logic`（`arith_ext` 未实现 → 不授予） | **15** |
| **橙 legendary** | —（不新增语法节点） | — | **15**（与 epic 相同） |
| **青 mythic** | `function`、`call` | `function`、`call` | **17** |

> `legendary` 不新增语法（所以与 epic 同为 15），其解锁体现在**模板/技能池**。
> **与旧口径对照**：若不展开 `nodePermissions` 而直接累计 `unlock.json` 的权限名，会得到 11/14/17/17/19——那是**权限名个数**，不是节点类型个数；`while`（1 个）与 `arith_ext`（1 个）都不是节点，故逐段差 1~2。
> `unlock.json` / `ai-nodes.json` 是**机制层**表；`aiNodes` 里的模板/技能清单属**内容层**（当前为示例数据，待用户设计）。

### U-1 累计与继承

| # | 查询 | 结果 |
|---|---|---|
| U-1a | `availableNodes('rare')` 是否含 `if` | ✅ **含**（继承低段位） |
| U-1b | `availableNodes('common')` 是否含 `random` | ❌ 不含 |
| U-1c | `availableNodes('mythic')` 是否含全部 | ✅ **17 个真实节点类型**（= `ai-nodes.json` 的 10 基础 + 7 增量） |
| U-1d | 低段位解锁的内容在高段位 | **自动可用**（单调递增，`T-UL-2`） |
| U-1e | `availableNodes('rare')` 是否含权限别名 `while` | ❌ **不含**（别名只作权限门，折叠为 `loop`；`isUnlocked('rare','while') === true`） |
| U-1f | `availableNodes('epic')` 是否含 `arith_ext` | ❌ **不含**（未实现，不授予任何节点；`isUnlocked('epic','arith_ext') === false`） |

## 2. 查询 `isUnlocked(tier, key)`

| # | 查询 | 结果 | 说明 |
|---|---|---|---|
| U-2a | `isUnlocked('rare', 'loop')` | **true** | rare 自身解锁 |
| U-2b | `isUnlocked('rare', 'random')` | **false** | 需 epic |
| U-2c | `isUnlocked('epic', 'loop')` | **true** | 继承 |
| U-2d | `isUnlocked('common', 'if')` | **true** | — |
| U-2e | `isUnlocked('nope', 'if')` | **false** | 未知 tier → 保守拒绝 |
| U-2f | `isUnlocked('mythic', 'no_such_node')` | **false** | 未知 key → 保守拒绝 |
| U-2g | 物品未定义 `unlockTier` | **视为已解锁** | `09-unlock` §5 |
| U-2h | `isUnlocked('rare', 'while')` | **true** | 权限别名：`while` 是 `loop` 的 `kind` 取值，`nodePermissions.while.grants=[loop]`，故该权限名"可用"，但**不新增节点** |
| U-2i | `isUnlocked('epic', 'arith_ext')` | **false** | 预留权限 `implemented:false` → `grants:[]`；权限命中但未展开出任何节点 → 判 false（宁缺勿错，避免编辑器插入不可用积木） |
| U-2j | `isUnlocked('common', 'seq')` | **true** | 基础节点恒可用（10 个） |

## 3. 过滤 `filterByTier(list, tier)`

| # | 场景 | 输入 | 输出 |
|---|---|---|---|
| U-3a | 掉落池（模板） | `[均衡(common), 特化(rare), 专家(legendary)]` @ `rare` | `[均衡, 特化]`（剔除 expert） |
| U-3b | 技能池 | `[基础技能(common), 进阶(rare), 高阶(legendary), 顶级(mythic)]` @ `epic` | `[基础, 进阶]` |
| U-3c | 列表项缺 `unlockTier` | 保留该项 | — |
| U-3d | 空列表 | 返回空数组（不报错） | — |
| U-3e | 全部超段位 | 返回空数组（调用方需处理"池为空"） | — |

## 4. AI 语法门控 `validateAi(program, tier)`

| # | 程序用到的节点 | 玩家段位 | 结果 | 错误 |
|---|---|---|---|---|
| U-4a | 仅 `if/cmp/action` | common | ✅ 通过 | — |
| U-4b | 含 `loop` | common | ❌ 拒绝 | `node_locked`，`detail.node='loop'`（**必须带 path 与节点名**） |
| U-4c | 含 `random` | rare | ❌ 拒绝 | 需 epic（D-120） |
| U-4d | 含 `random` | epic | ✅ 通过 | — |
| U-4e | 含 `function/call` | epic | ❌ 拒绝 | 需 mythic |
| U-4f | 含 `function` 但**从未 call** | mythic | ✅ 通过（用到了该节点即需门控，但已满足） | — |
| U-4g | 未知节点 `eval` | 任意 | ❌ 拒绝 | 结构校验先于门控（白名单） |

**校验顺序（冻结）**：① 结构/白名单 → ② 深度/大小/危险键 → ③ **分支 action 合法性** → ④ 段位门控。任一步失败都返回带 `path` 的 `details`。

## 5. 出战配置门控 `validateLoadout(loadout, tier)`

| # | 场景 | 结果 |
|---|---|---|
| U-5a | 角色/3 技能/全部插件 `unlockTier ≤ tier` | ✅ 通过 |
| U-5b | 角色模板 `unlockTier = legendary`，玩家 `rare` | ❌ `tier_locked`（角色） |
| U-5c | 3 个技能之一超段位 | ❌ `tier_locked`（技能槽 2） |
| U-5d | 插件超段位（已装在槽里） | ❌ `tier_locked`（插件 uid） |
| U-5e | AI 使用未解锁节点 | ❌ 转由 `validateAi` 拒绝 |
| U-5f | 段位满足但点数超限 | ❌ 由 `assemble` 的规则拒绝（不属门控） |

## 6. 编辑器工具箱 `availableNodes(tier)`

> **返回值口径**：**只含真实节点类型**（§1 说明的别名/预留权限已被 `nodePermissions` 展开剔除），可直接作为"可添加积木"清单使用，**调用方不需要再过滤**。

| # | 行为 | 期望 |
|---|---|---|
| U-6a | 工具箱渲染 | 只列出 `availableNodes(tier)` 的真实节点类型 |
| U-6b | 未解锁积木 | **隐藏或置灰**（P6 前端决定表现，服务端只给集合） |
| U-6c | 实时合法性提示 | 编辑器本地调用同一套 `checkLegality`（含**分支 action** 规则），给出 `path` |
| U-6d | 客户端与服务端一致 | 服务端**重新校验**，不信任客户端结果（`T-AP-4`） |
| U-6e | `while` 的呈现方式 | 不作为独立节点列出——`while` 是 `loop` 节点的 `kind` 取值（`loop.kind='while'`），编辑器在 `loop` 内选项里体现 |
| U-6f | 越界/未知段位 | `availableNodes('nope')` → 空数组（`tierIndex` 为 null，保守） |

> ⏳ **计划（未实现）**：P6 编辑器尚未落地；现行前端设计为**纯 DOM 表单式 AST 编辑器**（`docs/frontend-spec.md` v3 §12），非 Blockly 工具盒。

## 7. 测试要点映射

U-1/U-2 → T-UL-1 / T-UL-2｜U-3 → T-UL-3｜U-4 → T-UL-4 / T-AI-3｜U-5 → T-AF-5｜U-6 → 编辑器端到端（P6）

> 本文件未引出新的待确认子项。
