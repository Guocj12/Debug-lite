# 解锁系统 详细设计

> 所属：Debug-Lite v3　本文档精确到代码逻辑（自然语言，不写代码）。与 `../v3-design.md` 冲突时以本文档为准。
>
> ⚠️ **2026-09-16 用户决策：默认关闭段位门控，段位不参与判定**——"目前默认所有功能全部解锁，段位不参与判定"。
> 本文 §4~§7 描述的是**门控开启（回退模式）**下的口径；**当前默认**行为见 **§8 门控开关**。门控逻辑与数据
> （`unlockTier`、段位树 `unlocks`、`nodePermissions`）**全部保留**，只改"是否参与判定"，开关一个字段即可整体回退。

## 1. 职责

- 段位 → 内容解锁的映射与查询。
- 对 AI 语法、模板、技能、掉落池做门控（**默认不生效**，见 §8）。
- 服务端与编辑器共用的校验。

## 2. 依赖

- `unlock.json`（解锁表）。
- 段位顺序定义（common < rare < epic < legendary < mythic）。

## 3. 数据结构

- 解锁表：每段位一条，含 `tier`、`aiNodes[]`（该段位新解锁的**权限名**）、`roleTemplates[]`、`skills[]`；表根另含 `nodePermissions`（权限名 → 真实节点类型的展开声明）。
  - **权限名 ≠ 节点类型**：`aiNodes[]` 里的 `while`（= `loop` 的 `kind:'while'`，折叠为节点 `loop`）与 `arith_ext`（"扩展算术权限"预留位，标记 `implemented:false`）在 `ai/ast.js` 的 16 类节点白名单里**并不存在**；仅 `if`/`loop`/`break`/`random`/`logic`/`function`/`call` 是真实节点类型（真实节点单一数据源 = `server/data/ai-nodes.json` 的 `nodes`，共 16 类）。
  - **口径已于 2026-09-16 收口（已实现）**：`server/data/unlock.json` 新增 `nodePermissions`；`core/unlock.js` 的 `availableNodes(tier)` **只返回真实节点类型**，权限名不再出现在返回值里，调用方**无需**再自行忽略非节点类型项。展开规则三条：①显式 `grants` 覆盖；②`implemented:false` 的预留权限**不授予任何节点**；③未声明者 = 权限名本身即真实节点类型。
  - **累计真实节点数（已实测，2026-09-17）**：`common 10` / `rare 12` / `epic 14` / `legendary 14` / `mythic 16`（`common` = 9 个基础节点 + `if`；`bullets` 节点已按用户决策移除——AI 无法观测弹幕，弹幕当 tick 全解算）。旧口径 11/13/15/15/17（含 `bullets`）与 11/14/17/17/19（"权限名个数"）**均已作废**。
- 段位序号：`common=0`、`rare=1`、`epic=2`、`legendary=3`、`mythic=4`。
- **门控开关**（2026-09-16 新增）：`server/data/unlock.json` 表根 `gating`：`{ "enabled": false, "note": "…" }`。
  `enabled:false`（**当前默认**）= 段位不参与判定；`enabled:true` = 恢复下方全部门控。字段缺失按"启用"处理（旧表兼容）。

## 4. 核心流程（代码逻辑）

### 4.1 映射表（已明确项）

- 绿 common：条件分支（if/else）、均衡模板、基础技能。
- 蓝 rare：循环（for/while/break）、特化模板、进阶技能。
- 紫 epic：**概率随机（`random`）+ 更多运算符**、进阶技能。（**已确认**，D-120）
- 橙 legendary：专家模板、高阶技能。
- 青 mythic：函数（function/call）、顶级技能。

### 4.2 查询 `isUnlocked(tier, key)`

> 下 1~5 为**门控开启**时的口径；**默认关闭**时恒返回 `true`（§8）。

1. 把 `tier` 转为段位序号。
2. 查询该段位及更低段位是否解锁了 `key`（低段位解锁的内容高段位自动可用）。
3. `key` 可以是**真实节点类型**（查 `availableNodes` 展开集），也可以是**权限名别名**（如 `while`，折叠到 `loop`）——别名只有在真能展开出节点时才算解锁。
4. `implemented:false` 的预留权限（`arith_ext`）**恒返回 false**（不授予任何节点，避免编辑器插入不可用积木）。
5. 未知 `tier`/`key` → 返回 false（保守拒绝）。
   - 实测（2026-09-16）：`isUnlocked('rare','while') === true`（折叠为 `loop`）；`isUnlocked('epic','arith_ext') === isUnlocked('mythic','arith_ext') === false`。

### 4.3 过滤 `filterByTier(list, tier)`

> **门控关闭（默认）时原样返回入参列表**（§8）。

1. 遍历列表，剔除 `unlockTier` 段位序号 > 当前段位序号的项。
2. 用于掉落池、模板/技能列表。

### 4.4 校验 AI `ai/ast.validate(program, tier)`

> ⚠️ **接口迁移（B13 起）**：原 `unlock.validateAi` **已退役**——`server/core/unlock.js` 头注释明确"AI 程序校验（结构/合法性/段位门控）由 `ai/ast.js`（B12/B13）统一承担"，`docs/interfaces.md` §1 亦标注 `core/unlock.js` 不再导出 `validateAi`。本文档此前把它当现行接口，属**过期描述**。

1. 由 `ai/ast.validate(program, tier)` 执行三段校验：结构（`validateProgram`）→ 合法性（`checkLegality`，D-101 分支 action 规则）→ **段位门控**（**默认关闭时不产生 `node_locked`**，§8）。
2. 门控段：遍历程序用到的节点类型，逐个调本模块原语 `isUnlocked(tier, nodeType)`（经 `ast.withGating(true)` 注入的 unlock 实例），未解锁 → `{code:'node_locked', path, node}`。
3. 未知 `tier`/节点 → 保守拒绝（`isUnlocked` 对未知 `key` 返回 false）。

### 4.5 校验出战配置 `validateLoadout(loadout, tier)`

> **门控关闭（默认）时恒 `{ok:true,errors:[]}`**（§8）。`server/loadout.js` 的物品级/AI 级门控全部委托本模块与 `ai/ast.validate`，自身无硬编码段位比较。

1. 检查角色模板、技能模板、插件的 `unlockTier` 均 ≤ 当前段位。

### 4.6 编辑器 `availableNodes(tier)`

> **门控关闭（默认）时不分段位、恒返回全部 16 类真实节点**（§8）——编辑器"可添加节点"菜单默认全开。

1. 返回该段位可用的**真实节点类型**集合（累计：9 个基础节点 + 各段位 `aiNodes` 经 `nodePermissions` 展开后的并集），供编辑器"可添加节点"菜单渲染（**不再供 Blockly 工具盒**：Blockly 已废弃，现行方向为表单式 AST 编辑器；**P6 前端设计已于 2026-09-20 作废待重做**）。
   - 返回值为**累计列表且只含真实节点类型**（`while` 已折叠为 `loop`，`arith_ext` 不出现，见 §3）——调用方**无需**再过滤别名项。段位累计数（**门控开启时**）：10/12/14/14/16；**默认关闭时**任意段位均为 16。

## 5. 边界与异常

- 未解锁内容：不产出、不可装配、编辑器不可用、服务端拒绝（**门控关闭时该边界整体不生效**，见 §8）。
- 数据缺 `unlockTier` 的项视为已解锁。

## 6. 对外接口

- `isUnlocked`、`filterByTier`、`validateLoadout`、`availableNodes`（**只返回真实节点类型**，权限名已按 `unlock.json` 的 `nodePermissions` 展开）、`tierIndex`（`server/core/unlock.js` 实际导出；**`validateAi` 已退役**，AI 校验改由 `ai/ast.validate(program, tier)` 承担——`docs/interfaces.md` §1）。
- **门控工厂（2026-09-16 新增，测试/回退用）**：`unlock.withGating(enabled)`、`items.withGating(enabled)`、`ast.withGating(enabled)`、`roles.withGating(enabled)`、`loadout.withGating(enabled)`；均返回新实例（链式 `.withLogger(log)` 保留门控设置），另有 `*.gatingEnabled` 自省属性与 `GATING_DEFAULT`（unlock/items）。缺省实例按 §8 的开关取值。

## 7. 测试要点

> 门控相关的每条断言都**成对覆盖**：`withGating(true)` 断言下文旧口径，缺省实例（关闭）断言"全解锁"。

- 各段位解锁项正确（累计真实节点数 10/12/14/14/16；**仅在门控开启时**）。
- 低段位内容高段位可用（继承）。
- 过滤掉落池、AI 校验、装配校验。
- 未知 key 返回 false；`while` 折叠为 `loop`；`arith_ext`（`implemented:false`）恒 false。
- **门控关闭（默认）**：任意段位 `availableNodes` = 全部 16 类；`isUnlocked` 恒 true；`filterByTier` 原样返回；`validateLoadout` 恒 `{ok:true,errors:[]}`；`items.validateUnlock` 恒 true；`rollQuality` 不做品质池截断；`ast.validate` 不产生 `node_locked`。

## 8. 门控开关（2026-09-16 用户决策：默认关闭）

### 8.1 决策与语义

- **用户决策原文**："目前默认所有功能全部解锁，段位不参与判定。"
- **开关位置（唯一定义处）**：`server/data/unlock.json` → `gating.enabled`（当前 `false`），说明写在同处 `gating.note`。
- **读取方式**：`server/core/unlock.js` 与 `server/core/items.js` 在模块加载时读该字段得到缺省门控值
  `GATING_DEFAULT = !gating || gating.enabled !== false`（**无 IO / 无环境变量 / 无 `Math.random`**，JSON `require` 属既有 L9 数据读取模式）；两模块用同一字段、同一表达式，避免双源漂移。
- **保留而非删除**：`unlock.json` 的段位树 `unlocks`、`nodePermissions`、以及三表（`role-templates` / `skill-templates` / `plugins`）的 `unlockTier` 字段**全部保留**，作为**进度/评分元数据**；`core/unlock.js` 的门控分支代码一行未删。
- **边界（用户已确认）**：排位晋升与段位奖励（`server/ranked.js` 的 `promote` / `tierReward`）**不受本开关影响**——属"进度"而非"门控"；P7 快速对战按 Elo 积分匹配，段位不参与。

### 8.2 关闭时（`gating.enabled=false`，当前默认）逐点行为

| # | 位置 | 关闭后行为 |
| --- | --- | --- |
| 1 | `core/unlock.js` `availableNodes(tier)` | 不分段位，恒返回**全部真实节点类型**（`ai-nodes.json` 的 `nodes`，16 类，返回副本） |
| 2 | `core/unlock.js` `isUnlocked(tier,key)` | 恒 `true`（日志 `unlock.check` 仍记，便于对照排查） |
| 3 | `core/unlock.js` `filterByTier(list,tier)` | **原样返回**入参列表（不筛选、不复制） |
| 4 | `core/unlock.js` `validateLoadout(loadout,tier)` | 恒 `{ok:true,errors:[]}`（不产生 `tier_locked`，不记 `unlock.reject`） |
| 5 | `core/items.js` `validateUnlock(item,tier)` | 恒 `true` → 掉落池/装配/loadout 的物品级门控自然消失 |
| 6 | `core/items.js` `rollQuality(rng,tier)` | 不做品质池截断（`capIdx` 恒取全池）→ 等价全池按 `dropRates` 抽；`server/box.js` 仍接受 `tier` 但不再起门控作用（参数保留以兼容 API/CLI） |
| 7 | `core/items.js` `assemble` | 段位检查（`tier_locked`）不再触发（由 ⑤ 单点决定，无独立分支） |
| 8 | `ai/ast.js` `validate(program,tier)` | 门控段经 `unlock.isUnlocked` → 不产生 `node_locked`（**经注入的 unlock 实例**，见 8.3） |
| 9 | `server/loadout.js` / `core/roles.js` | 经 `items.validateUnlock` / `ast.validate`，无硬编码段位判断（已逐行确认）→ 不因段位拒绝 |
| 10 | `server/index.js` `/api/v1/unlock` | 返回全部节点/模板/技能/插件；**`400 bad_tier` 保留**（参数校验与门控是两件事） |

### 8.3 两模式（开 / 关）如何被钉住

- **工厂签名**：`unlock.makeUnlock(logger?, gating?)`、`items.makeItems(logger?, gating?)`（`gating` 缺省 = 开关值）；
  实例级 `withLogger` / `withGating` 可链式；下游 `ast.withGating(enabled)`（内部 `unlock.withGating(enabled)`）、
  `roles.withGating(enabled)`、`loadout.withGating(enabled)`（内部 items 与 ast 取**同一**门控值）。
- **测试覆盖**（两条路径都有护栏，见 `docs/tasks.md` §3.4 覆盖率门禁逐文件阈值）：
  - 走 `withGating(true)`（旧口径）：`tests/unit/unlock.test.js`（T-UL-1/U-1、U-2、U-3、U-5、UL-7、UL-8）、
    `tests/unit/items.test.js`（IT-8、IT-9、IT-16）、`tests/unit/wh.test.js`（I-10c、B18 补充分支）、
    `tests/unit/b20.test.js`（T-PB-7）、`tests/unit/b21.test.js`（T-PB-7）、`tests/unit/roles.test.js`（R-7c、RO-14）、
    `tests/unit/loadout.test.js`（I-12e、P1-3）、`tests/unit/ai-validate.test.js`（T-AI-3、T-AI-1）、
    `tests/unit/box.test.js`（B17-2①、B17-6）、`tests/unit/ranked.test.js`（P2-3）、
    `tests/property/items-invariants.test.js`（PT-IT-3③）。
  - 走缺省（关闭 = 新默认）：同文件内的 `*-b` / `I-12e2` / `T-PB-7b` / `IT-8b` / `IT-9b` / `B17-6b` / `P2-3b` /
    `I-10c2` / `PT-IT-3②` 等对应用例，以及 `tests/api/api.test.js`（AP-11）、`tests/api/api-box.test.js`（T-AP-1）、
    `tests/api/api-wh.test.js`（T-AP-3 段位锁段）。
- **回退步骤**：把 `unlock.json` 的 `gating.enabled` 改成 `true`（仅此一处），门控即整体恢复；既有测试即回到旧口径断言。
