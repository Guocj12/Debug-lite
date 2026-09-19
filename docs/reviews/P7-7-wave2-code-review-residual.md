# 第二波独立代码级审查 · 遗留项清单
> 来源：对提交 `bdcf7d0` 的独立代码级审查（14 项声称：**11 通过 / 3 部分**）。审查规则见 `docs/plan-p7-playable.md` §0 第 7 条 / `docs/tasks.md` §5.1 第 5 条。本文件**只记录未修项**与其归属阶段，供后续轮次逐条闭环；执行时按阶段勾选。

## 已在审查当轮修复（3 项 + 1 项自纠）
- [x] **R-1 CRLF 致命缺陷**：`scripts/fe-spec-check.js:50` 的 `fenced()` 正则 `/^[ \t]*$/` 不容忍 `\r` → 仓库 `core.autocrlf=true` 且无 `.gitattributes`，**默认 Windows 新克隆必然 fe-spec 0 PASS + 8 条 FE-SPEC 测试红**。已改为 `/^[ \t\r]*$/`；并实测（同一份 `frontend-spec.md` 置为 CRLF 时）修复后仍 **9 PASS**。
- [x] **R-9 `scripts/demo.js` require 即执行**：文件末直接 `main()` → 任何 `require` 都会跑一场战斗并刷 stdout。已改 `if (require.main === module) main();` + `module.exports`；实测 `require` 无副作用。
- [x] **R-8 仓库根游离文件**：未跟踪的 `npmtest2.txt`（93 KB 测试日志转储）会被 `git add -A` 误提交 → 已删除（非 `play.js` 造成）。
- [x] 自纠：验证过程中的一次探针误将 `docs/frontend-spec.md` 写成 CRLF，已还原为 LF（CR 剩余 0）并复核 `check-docs` PASS。

## 未修项（按阶段排期）

| # | 阶段 | 问题 | 证据 / 处置 |
|---|---|---|---|
| R-4 | **P7-5 前必须解决** | `/api/v1/ai/battle` 的 `baselinePlayer` 无 `skills` → `skill:*` **恒 ineffective（实测 62/62）**；"技能类 AI 生效"在该端点**没有任何通过的实测路径**（只证明了"不生效"被正确回报） | 不可改 `baselinePlayer`（会破黄金快照与 gate 项 8）→ 加可选 `skills` 入参；或在 P7-5 e2e 用**真实玩家档案**验证技能（与"不许占位 bot 敷衍"一致） |
| R-5 | P7-3 | 同一模板装两个技能槽时**共享冷却键**（`instantiateSkill` 的 `sid`=模板 id，而 `battle.js` 用槽位键 `skill1..3`） | play 默认局（两次"毒瓶"）即可复现；需明确"按槽位冷却 / 按模板冷却"并写入 `docs/systems/03-skills.md`、`07-engine.md` |
| R-10 | P7-3 | `random.else` 在 `ast.js` 为**必填**，而 runtime 注释与 `docs/systems/08-ai.md §4.3` 写"缺 else 跳过" | 二选一统一（建议 `else` 改可选以匹配文档，并补测试） |
| R-11 | P7-4 | `ineffectiveActions.count`/`byOwner` 含**全部 owner**，而 `actionsEffective` 只含 p1 → 调用方乘加会出错 | 已加注释；P7-4 定义响应契约时必须明确口径 |
| R-12 | P7-5 | 黄金回归本局 crit / overtime / 撞基地 / 防御**全为 0** → 这四类数值改动不会被它发现（超时口径另有 `T-EN-4b`/`T-BT-11b` 真断言兜底） | 扩展 `.audit/golden-battle.js` 的行动计划（含 defend 与撞基地）后人工 `--write` 重算快照 |
| R-13 | 记录 | `server/data/schema.js` 三处硬编码镜像：`EMIT_PATTERNS`↔`skills.js` EMITTERS、`PARAM_MODES`↔params 处理、角色 type 枚举↔`items.applyTypeModifier` | 新增第 4 种角色类型 / 新 emit pattern 会被拒（属正确拦截），但三处必须同步改 |
| E-1 | P7-7 | **注册了却无消费方**：`affix-registry.json` 的 `domain` 字段全仓库零 JS 消费（`docs/systems/01-items.md:18,56` 却称其声明 role/skill/both） | 要么消费它，要么从注册表删除并改文档 |
| E-2 | P7-7 | 快照字段 `self.maxMp` / `self.maxSp` **零引用**（`self.maxHp` 仅 1 处） | 属给 AI 作者的只读面；应在 `docs/systems/08-ai.md` 明确用途或标注保留理由 |
| S-1 | P7-4 | `items.validateUnlock` 与 `unlock.isUnlocked` 是**两套独立门控实现**（同受 `gating.enabled` 控制） | 新增第三个门控点时易漏接开关；P7-4 接线时应统一为一处判定 |
| S-2 | P7-7 | 仓库 `core.autocrlf=true` 且**无 `.gitattributes`** | 建议补 `.gitattributes`（如 `* text=auto eol=lf`）从根上消除行尾漂移（本轮只把检查器改为容忍 CRLF） |
| S-3 | 记录 | `unlock.json` 的 `gating.enabled` **未做 schema 结构校验**（写成字符串 `"false"` 会被判为"启用"= 旧行为） | 建议在 `server/data/schema.js` 增加"`gating.enabled` 必须是布尔"的校验 |

## 审查已实测通过的 11 项（要点证据，供复核复用）
1. 超时扣血：自定义 cfg（角色 maxHp 180/60、基地 maxHp 100/40）实测基地按自身 maxHp；缺 maxHp 回退 hp。
2. `typeModifiers` 接入开箱：rare atk 下界 均衡 10 / 特化 12 / 专家 13；`generateRoleItem` vs `instantiateRole` 同 seed **3300 组逐值一致**（消耗顺序未漂移）。
3. `drop/dropWeight` 真被消费：`drop:false` 后 200 次开箱不再出现；权重 1:9 → 0.099/0.901；缺省兼容。
4. `schema` 去硬编码：**11 类造错全部 FAIL 并指出 id**；新增同结构条目/额外字段通过；去 `_sample` 后跳过逐值比对。
5. 面板单一实现：`roles.getFinalStats` ≡ `loadout.buildPanel.role` ≡ `battle.buildPlayer` 逐值一致；regen 只叠一次；8 个形状容错用例不抛。
6. `random` 双语义：语句位 true→move_right / false→move_left；表达式位返回 boolean；crit/dodge 流不被 AI 消耗量平移。
7. `bullets` 删除彻底：nodes 16 / base 9；`withGating(true)` 累计 [10,12,14,14,16]；`bullets[0].x` 校验期 `bad_path`、运行层 0。
8. `aiTrace` 每 tick：62 tick /api/v1/battle 双司机**每帧非空**且归属正确；单 tick 2000 封顶 + `traceTruncated` + 每 tick 1 次 warn。
9. 校验硬化 4 类必拒：错 path / 拼错变量 / 表达式位写语句 / 无 action → 全部拒绝（HTTP 侧 400）；合法写法无误报；运行层兜底→0 不抛。
10. 快照投影：`baseHp`=基地当前血量 ≠ `maxHp`；**38/38 快照叶子路径都在白名单**；改写副本引擎状态不变（只读隔离）。
11. `/ai/battle` 未生效回报：全合法→`actionsEffective=62`/count=0/events 全空；未装配技能→0/62、`unknown_reason=unknown_skill`；Σ帧级 == 顶层 count（已修双计数）。
