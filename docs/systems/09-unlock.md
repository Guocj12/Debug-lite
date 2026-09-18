# 解锁系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。

## 1. 职责

- 段位 → 内容解锁的映射与查询。
- 对 AI 语法、模板、技能、掉落池做门控。
- 服务端与编辑器共用的校验。

## 2. 依赖

- `unlock.json`（解锁表）。
- 段位顺序定义（common < rare < epic < legendary < mythic）。

## 3. 数据结构

- 解锁表：每段位一条，含 `tier`、`aiNodes[]`（该段位新解锁的**权限名**）、`roleTemplates[]`、`skills[]`；表根另含 `nodePermissions`（权限名 → 真实节点类型的展开声明）。
  - **权限名 ≠ 节点类型**：`aiNodes[]` 里的 `while`（= `loop` 的 `kind:'while'`，折叠为节点 `loop`）与 `arith_ext`（"扩展算术权限"预留位，标记 `implemented:false`）在 `ai/ast.js` 的 17 类节点白名单里**并不存在**；仅 `if`/`loop`/`break`/`random`/`logic`/`function`/`call` 是真实节点类型（真实节点单一数据源 = `server/data/ai-nodes.json` 的 `nodes`，共 17 类）。
  - **口径已于 2026-09-16 收口（已实现）**：`server/data/unlock.json` 新增 `nodePermissions`；`core/unlock.js` 的 `availableNodes(tier)` **只返回真实节点类型**，权限名不再出现在返回值里，调用方**无需**再自行忽略非节点类型项。展开规则三条：①显式 `grants` 覆盖；②`implemented:false` 的预留权限**不授予任何节点**；③未声明者 = 权限名本身即真实节点类型。
  - **累计真实节点数（已实测，2026-09-16）**：`common 11` / `rare 13` / `epic 15` / `legendary 15` / `mythic 17`（`common` = 10 个基础节点 + `if`）。旧口径 11/14/17/17/19（"权限名个数"）**已作废**。
- 段位序号：`common=0`、`rare=1`、`epic=2`、`legendary=3`、`mythic=4`。

## 4. 核心流程（代码逻辑）

### 4.1 映射表（已明确项）

- 绿 common：条件分支（if/else）、均衡模板、基础技能。
- 蓝 rare：循环（for/while/break）、特化模板、进阶技能。
- 紫 epic：**概率随机（`random`）+ 更多运算符**、进阶技能。（**已确认**，D-120）
- 橙 legendary：专家模板、高阶技能。
- 青 mythic：函数（function/call）、顶级技能。

### 4.2 查询 `isUnlocked(tier, key)`

1. 把 `tier` 转为段位序号。
2. 查询该段位及更低段位是否解锁了 `key`（低段位解锁的内容高段位自动可用）。
3. `key` 可以是**真实节点类型**（查 `availableNodes` 展开集），也可以是**权限名别名**（如 `while`，折叠到 `loop`）——别名只有在真能展开出节点时才算解锁。
4. `implemented:false` 的预留权限（`arith_ext`）**恒返回 false**（不授予任何节点，避免编辑器插入不可用积木）。
5. 未知 `tier`/`key` → 返回 false（保守拒绝）。
   - 实测（2026-09-16）：`isUnlocked('rare','while') === true`（折叠为 `loop`）；`isUnlocked('epic','arith_ext') === isUnlocked('mythic','arith_ext') === false`。

### 4.3 过滤 `filterByTier(list, tier)`

1. 遍历列表，剔除 `unlockTier` 段位序号 > 当前段位序号的项。
2. 用于掉落池、模板/技能列表。

### 4.4 校验 AI `ai/ast.validate(program, tier)`

> ⚠️ **接口迁移（B13 起）**：原 `unlock.validateAi` **已退役**——`server/core/unlock.js` 头注释明确"AI 程序校验（结构/合法性/段位门控）由 `ai/ast.js`（B12/B13）统一承担"，`docs/interfaces.md` §1 亦标注 `core/unlock.js` 不再导出 `validateAi`。本文档此前把它当现行接口，属**过期描述**。

1. 由 `ai/ast.validate(program, tier)` 执行三段校验：结构（`validateProgram`）→ 合法性（`checkLegality`，D-101 分支 action 规则）→ **段位门控**。
2. 门控段：遍历程序用到的节点类型，逐个调本模块原语 `isUnlocked(tier, nodeType)`，未解锁 → `{code:'node_locked', path, node}`。
3. 未知 `tier`/节点 → 保守拒绝（`isUnlocked` 对未知 `key` 返回 false）。

### 4.5 校验出战配置 `validateLoadout(loadout, tier)`

1. 检查角色模板、技能模板、插件的 `unlockTier` 均 ≤ 当前段位。

### 4.6 编辑器 `availableNodes(tier)`

1. 返回该段位可用的**真实节点类型**集合（累计：10 个基础节点 + 各段位 `aiNodes` 经 `nodePermissions` 展开后的并集），供编辑器"可添加节点"菜单渲染（**不再供 Blockly 工具盒**：现行前端为表单式 AST 编辑器，见 `docs/frontend-spec.md` v3 §12；Blockly 已废弃）。
   - 返回值为**累计列表且只含真实节点类型**（`while` 已折叠为 `loop`，`arith_ext` 不出现，见 §3）——调用方**无需**再过滤别名项。段位累计数：11/13/15/15/17。

## 5. 边界与异常

- 未解锁内容：不产出、不可装配、编辑器不可用、服务端拒绝。
- 数据缺 `unlockTier` 的项视为已解锁。

## 6. 对外接口

- `isUnlocked`、`filterByTier`、`validateLoadout`、`availableNodes`（**只返回真实节点类型**，权限名已按 `unlock.json` 的 `nodePermissions` 展开）、`tierIndex`（`server/core/unlock.js` 实际导出；**`validateAi` 已退役**，AI 校验改由 `ai/ast.validate(program, tier)` 承担——`docs/interfaces.md` §1）。

## 7. 测试要点

- 各段位解锁项正确（累计真实节点数 11/13/15/15/17）。
- 低段位内容高段位可用（继承）。
- 过滤掉落池、AI 校验、装配校验。
- 未知 key 返回 false；`while` 折叠为 `loop`；`arith_ext`（`implemented:false`）恒 false。
