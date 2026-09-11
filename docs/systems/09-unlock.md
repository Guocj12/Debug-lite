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

- 解锁表：每段位一条，含 `tier`、`aiNodes[]`（解锁的 AST 节点）、`roleTemplates[]`、`skills[]`。
- 段位序号：`common=0`、`rare=1`、`epic=2`、`legendary=3`、`mythic=4`。

## 4. 核心流程（代码逻辑）

### 4.1 映射表（已明确项）

- 绿 common：条件分支（if/else）、均衡模板、基础技能。
- 蓝 rare：循环（for/while/break）、特化模板、进阶技能。
- 紫 epic：概率随机（random）、更多运算符、进阶技能（设计补充，待确认）。
- 橙 legendary：专家模板、高阶技能。
- 青 mythic：函数（function/call）、顶级技能。

### 4.2 查询 `isUnlocked(tier, key)`

1. 把 `tier` 转为段位序号。
2. 查询该段位及更低段位是否解锁了 `key`（低段位解锁的内容高段位自动可用）。
3. 未知 `tier`/`key` → 返回 false（保守拒绝）。

### 4.3 过滤 `filterByTier(list, tier)`

1. 遍历列表，剔除 `unlockTier` 段位序号 > 当前段位序号的项。
2. 用于掉落池、模板/技能列表。

### 4.4 校验 AI `validateAi(program, tier)`

1. 收集程序用到的所有语法节点类型。
2. 每个节点都必须已解锁，否则拒绝。

### 4.5 校验出战配置 `validateLoadout(loadout, tier)`

1. 检查角色模板、技能模板、插件的 `unlockTier` 均 ≤ 当前段位。

### 4.6 编辑器 `availableNodes(tier)`

1. 返回该段位可用的积木集合，供 Blockly 工具盒渲染。

## 5. 边界与异常

- 未解锁内容：不产出、不可装配、编辑器不可用、服务端拒绝。
- 数据缺 `unlockTier` 的项视为已解锁。

## 6. 对外接口

- `isUnlocked`、`filterByTier`、`validateAi`、`validateLoadout`、`availableNodes`。

## 7. 测试要点

- 各段位解锁项正确。
- 低段位内容高段位可用（继承）。
- 过滤掉落池、AI 校验、装配校验。
- 未知 key 返回 false。
