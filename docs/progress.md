# 当前状态与下一步

> 更新：2026-09-19（**P7 在线服务（B27–B33）已全部交付并收口**；本节复核标记均指对应日期复核；决策编号见 `docs/decisions.md` §14 的 **D-137…D-153**）
> 用途：跨会话续接，**本项目唯一状态源**。只记录**当前状态**与**待办**，不保留历史（历史仅可在带「历史记录」标注的小节中保留）。
> 写法约定：凡"现状"必须标明复核日期与证据；凡"计划中"必须显式标注批次（如「计划中（P6/F1–F7）」），不得与现状混写。

---

## 0. P7 在线服务与存档（D-129…D-136）—— **✅ 已交付（2026-09-19）**

> ✅ **本节原为"计划中（代码 0 行）"，2026-09-19 已全部落地**：B27–B33（存储层 / 身份档案 / 排位 / 快速对战 / HTTP·CLI 接线）全部实现并接线，`docs/reviews/B27.md`…`B33.md` 审查记录齐全。**交付实测**：`npm test` = 942 通过 / 0 失败、`npm run gate` = 9 PASS / 0 FAIL / 0 PEND、`npm run check:docs` = PASS、`node scripts/fe-spec-check.js` = 9 PASS、`npm run e2e` = 22/22、`npm run load-test -- --players 50 --deep` = 7/7 完整性断言（均 exit 0）。

- **已实现的设计文档**：`docs/systems/11-account-store.md`（账号与存档：身份鉴权 / 三配置槽 / append-only journal + 物化档案 / 异步排位双向记账 / 快速对战非对称 Elo / 回放只存引用按需重算 / 容量与数据库判据）。
- **已落地决策**：D-129 服务端持久化档案（**部分推翻 D-123**）、D-130 混合权威（段位/积分服务端、仓库仍客户端；**段位/积分不具备竞技可信度**已登记）、D-131 配置槽规则（≤3、唯一出战、必有出战、注册即默认配置）、D-132 异步排位（保留 D-122 的 10 场 x=6；发起者同步结算 + 双向记账；防守方离线只记战绩不掉段不掉分）、D-133 积分双轨 + 非对称 Elo（0 起、上限 3000、均衡点 `R = cap×(2×胜率−1)`，**仅在未触发 `kMin/kMax` 裁剪时精确**）、D-134 journal + 幂等 apply、D-135 回放只存引用 + 帧 LRU 上限 64、D-136 仅对手去重（24h 硬底线 / ≥72h 优先 / 24–72h 记 `relaxed:true`）、D-152 匹配池＝真实玩家档案（池不足回报 `shortfall`，**禁止 bot 充数**）。
- **已同步文档**：`decisions.md`（§13，只追加）、`interfaces.md`（模块 ICD/端点/D 落点/日志事件/环境变量/错误码）、`server.md`（进程模型/环境变量/端点/状态码/CLI/runtime 目录 —— **2026-09-19 已由"计划中"改为"现状"**）、`systems/10-ranked.md`（档案驱动，删 `BOT_LD`）、`systems/11-account-store.md`、`tasks.md`（P7 批次勾选 + MS7）、`.gitignore`（`runtime/`）、`security-backlog.md`（SEC-01/SEC-03/SEC-22 处置回填）。
- **仍待办（P6）**：`docs/frontend-spec.md` 与 `docs/screens.md` 的账号/战绩相关屏**尚未同步**（登录屏、我的战绩、防守战绩、排行榜、token 存储、`GET /me` 启动拉取流程）；前端代码 0 行（main 上无 `public/`）。
- **容量结论（实测）**：单场战斗 0.175~0.280 ms、**回放帧实测 61–268 KB/场（17–63 tick，≈2.7–3.5 KB/帧；旧口径 7.0~20.5 KB 偏小约一个数量级，2026-09-16 修正）**、索引 ~200 B/玩家 → **单进程 JSON 存储在 1 万玩家量级绰绰有余，暂不需要数据库**；>5 万玩家或写 QPS >500 时切 `node:sqlite` 适配器（`11-account-store.md` §11.4）。
- **已修正的口径漂移（2026-09-19）**：`pool.ttlDays` 与 `dailyBattleLimit` 均为"参数已留、**无消费方**"；`relaxed`/`invalids` **已落** `ranked.batch`；`nextSince` → `latestSeq`；§8.3 积分上界为 `kBase`(32)/`kMax`(64)（旧文"Δ ≤ 16"是错的，曾导致合法败局误报）。

---

## 1. 文档体系（权威链）

```
docs/decisions.md      决策记录（**D-01…D-153**；D-129…D-136 与 D-137…D-153 均已落地，见 §0）  ← 最高权威
docs/systems/01~10.md  各系统实现细则（`11-account-store.md` 为**已实现（P7/B27–B33，2026-09-19）**的账号与存档权威设计）
docs/v3-design.md      主设计文档（架构/数据模型/数值）
docs/items-data.md     物品数值、名称、贴图占位
docs/interfaces.md     接口冻结（ICD v1：模块/API/CLI/数据结构/D 落点）
docs/server.md         服务器文档（部署、端点速查、信封与错误码、**单进程 + 服务端档案**：runtime 数据根 / journal / 快照库 / 回放 LRU）
docs/frontend-spec.md  前端设计文档（**v3 重设计**：可玩优先；按钮↔动作↔数据字段三重契约 + `scripts/fe-spec-check.js` 自检）
docs/tasks.md          开发计划（铁律/接口/测试矩阵/批次/门禁）
docs/examples/         分支示例集（10 系统 + 索引），计算细节的唯一出处
docs/battle-walkthrough.md  端到端走查：**系统间数值与状态传递**（§3.1 = 真实引擎复算：seed 20260912 / 18 tick / p2 胜）
docs/security-backlog.md    安全与防作弊问题登记册（**record-only**，SEC-01…；不派发任务、不改门禁）
docs/progress.md       本文件
```

---

## 2. 已定型的核心规则（速查）

| 主题 | 结论 | 决策 |
|---|---|---|
| 空间 | 16 格 × 64px = 1024px 连续坐标，1px 精度，格心定位，clamp `[32,992]` | D-01~D-08 |
| 移动/碰撞 | 穿敌四情形；碰撞 = 目标间距**严格 <64**；碰撞伤害 `atk×0.8`（`collisionDmgMul`）；被动位移同样结算 | D-10~D-17、D-35 |
| 朝向 | **只能通过 `turn` 动作改变**（翻转 `facing`，不移动、不消耗）；`move`/`dodge`/位移**都不改朝向**；写回统一在引擎**步骤 7**，背击用"本 tick 写回后"的朝向 | 用户决定 2026-09-16 |
| 机制数据驱动 | 技能类型机制 → `skill-mechanics.json`；词条语义（agg/skillOp/hitEffect/castEffect）→ `affix-registry.json`；AI 真实节点与动作词汇表 → `ai-nodes.json`；代码只解释表里声明的 `pattern`/`op`，不按类型或词条 id 写分支 | 2026-09-16 |
| 位移伤害 | **沿声明路径每格一枚 0 速弹幕**（等级取模板 `bulletLevel`），与碰撞伤害**分别结算** | D-18、D-118 |
| 弹幕 | 不跨 tick、当 tick 飞完全射程、连续方程求交、按生成顺序递归抵消、`t∈[0,1]`（含 t=0 立即拦截） | D-20~D-32 |
| 伤害 | 倍率相乘后只取整一次；`defend` = `def×1.6`；背击用**位移后**朝向；吸血 floor 封顶 | D-40~D-51 |
| 基地 | **弹幕不伤基地**；唯一途径是"面向基地并移动"（停原地 + `atk×baseHitMul`，`baseHitMul=0.8`，与碰撞倍率分列） | D-60~D-62 |
| 效果 | 新效果下一 tick 起效；控制复写不扣资源；`fullDodgeDuring` 免疫伤害+控制且**不参与弹幕判定** | D-70~D-72、D-84 |
| AI | 隐式不可跳出的 `while(true)`；循环体**所有分支**须含 action（`call` 按**行动产出定点分析**计入，纯检测函数不算）；函数=打包代码块（无参返回，有独立作用域+调用栈）；字段枚举校验（`logic.op`/`loop.kind`+`times`/`cond`/`arith.op`/`cmp.op`）；每 tick 每用途随机流；兜底返回 `wait`；动作名不校验期拒绝（D-80） | D-80~D-104、2026-09-16 |
| 数据表 | 角色模板必填 `regen`；技能模板带 `slotWeights`/`falloff`/`bulletLevel`（含位移）；三表可选 `unlockTier`；`costDeltaByTier` 逐档数组；插件变体拆独立 id | D-110~D-118 |
| 产品 | 紫段位=随机+扩展运算符；晋升 x=6；前端无框架 | D-120~D-124 |
| 在线服务 | **✅ 已实现（P7/B27–B33，2026-09-19）**：服务端存档（段位/积分/配置槽≤3/战绩；`runtime/` + journal + 快照库）；仓库仍客户端；异步排位双向记账（防守方离线只记战绩）；快速对战非对称 Elo（0 起/上限 3000，与段位双轨）；回放只存引用按需重算 | **D-129~D-136** |
| 门控（2026-09-16 拍板） | **默认关闭段位门控**：所有功能默认全解锁、**段位不参与判定**（内容解锁/物品级/开箱品质上限/出战配置/AI 节点/装配六处）；门控逻辑与数据字段**保留为可回退开关**（`unlock.json` 的 `gating.enabled`）；排位晋升与段位奖励暂留（属进度）；快速对战按 Elo 积分匹配 | **D-137**（执行＝P7-0，在途） |
| AI 观测边界（2026-09-16 拍板） | **AI 无法观测弹幕是设计**：语言无 `bullets` 节点、快照不投影 `bullets`（弹幕当 tick 全解算）；节点 16 类 / `base` 9 / 段位累计 **10/12/14/14/16**；`aiTrace` **每 tick** 上限 2000 | **D-138/D-140**（已落地） |

**开放数值项已全部关闭**：`dodgeChanceBonus=0.20`（D-127）、`defK=40` 入表（D-128）——B21 校准收口，battle-config 全部数值冻结。

---

## 3. 待办（按优先级）

### 3.1 开发（进行中）
- [x] **P0-1** `package.json` + `.gitignore` + `README.md`（2026-09-12；7 脚本接线、cov 修 P1、审查 `docs/reviews/P0-1.md`）
- [x] **P0-2** 目录骨架 + 各目录 README 地图（2026-09-12；含 `tests/helpers/` 解读，审查 `docs/reviews/P0-2.md`）
- [x] **P0-3** 测试基建：runner 契约固化（`tests/README.md`）、`tests/helpers/gen.js`（G-1..12）、覆盖率阈值实测（2026-09-12；审查 `docs/reviews/P0-3.md`）
- [x] **P0-4** 日志子系统：`shared/log.js`（UMD 零依赖）+ `tests/helpers/log.js` + T-LG-1/2/3/6/7（51 用例绿；审查 `docs/reviews/P0-4.md`；suppressed 取向=每 100 丢弃，B11 可调）
- [x] **P0-5** 门禁：`scripts/gate.js` 9 项 + `scripts/check-arch.js` + T-DC-3..7（实测 4 PASS/0 FAIL/5 PEND；**4 条 Node 覆盖率机制**已固化进 `scripts/README.md`；审查 `docs/reviews/P0-5.md`，P1×5 已修；T-DC-2 接线为 P0-6 必做）
- [x] **P0-6** 数据表：`schema.js`（T-DC-1/2）+ 7 张表（battle-config 冻结值/11 角色/10 技能/29 插件/5 品质/unlock）；门禁 6 PASS/0 FAIL/3 PEND（项 4/6② 激活，T-DC-2 接线进项 5；审查 `docs/reviews/P0-6.md`，P2×2 已修）
- [x] **P0-7** 接口冻结：`docs/interfaces.md`（模块 ICD + API/CLI v1 + **D 落点表 78 条** + 日志矩阵）+ IF-1..5 契约测试（审查 `docs/reviews/P0-7.md`，P2×4 已修；**gate 项 5 T-DC-8 激活 → 7 PASS/0 FAIL/2 PEND**）
- [x] **P0-8** HTTP/CLI 骨架：**零依赖 `node:http`（2026-09-16 复核：`express` 从未引入，`package.json` 无 `dependencies`）** + 统一信封 + health/data/log-level + CLI 退出码 0/1/2（AP-1..10/CLI-1..14；真实进程闭环 health=0/data=1/bogus=2；审查 `docs/reviews/P0-8.md`，P2×4 已修；**gate 项 9 激活 → 8 PASS/0 FAIL/1 PEND**）
- [x] **P0-9** assets 占位表：sprites/animations 纳入 T-DC-1 + 经 /api/v1/data/:table 提供（DS-11/AP-2 扩展；审查 `docs/reviews/P0-9.md`，P2×4 已修）—— **P0 阶段 9/9 批收口**
- [x] **B1**（P1 首）`core/rng.js`（D-90/91/92：全局种子 + deriveStream(tick,purpose) + state/restore）+ `core/field.js`（clampX/cellOf/cellRange/touchesBase，数值全来自 battle-config）（R-1..10/F-1..9，153 用例；审查 `docs/reviews/B1.md`，P2×3 已修；修复 checkNumericHardcode 标识符误报）
- [x] **B2** `core/effects.js`（addEffect/resolveContinuous/resolveControl/resolveControlMove + withLogger；E-1..8 全分支）（EF-1..13，167 用例；审查 `docs/reviews/B2.md`，P1×3 已修——remaining:0 边界/ICD 补全/失败路径）
- [x] **B3** `core/items.js` 数值层（rollQuality/rollSlotCount/tierOf/generate*/openBox/applyAffixes/validateUnlock；T-RO-7 regen 直透；门禁新增 `// cl:` 行级豁免）（IT-1..14，186 用例；审查 `docs/reviews/B3.md`，P1×1 已修——flat 入包即时取整）
- [x] **B4** `core/unlock.js`（tierIndex/isUnlocked/filterByTier/validateAi/validateLoadout/availableNodes + `/api/v1/unlock` 端点）（UL-1..10，197 用例；审查 `docs/reviews/B4.md`，P2×3 已修——拒绝日志/防错/L14 端点）
- [x] **B5** `core/roles.js`（instantiateRole/applyTypeModifier/equipPlugins/getFinalStats；typeModifiers L9 入表 + schema 冻结）（RO-1..10，210 用例；审查 `docs/reviews/B5.md`，P1×1 已修——修饰系数硬编码）
- [x] **B6** `core/skills.js`（instantiateSkill/applySkillPlugins/canCast/buildSkillAction/coveredCellRanges；四类型释放指令 + 路径弹幕 M 系一致）（SK-1..12，224 用例；审查 `docs/reviews/B6.md`，P1×1 已修——costDelta 兜底字面量）
- [x] **B7** `core/bullets.js`（当 tick 全解算：连续方程命中/互撞等级矩阵/两阶段递归/C9 双变体；falloff 系数）（BU-1..10，234 用例；审查 `docs/reviews/B7.md`，P1×2 已修——事件名/ICD 接口名）
- [x] **B8** `core/engine.js`（14 步管线/统一落位五步/碰撞伤害基础链路/judge/runFull；M/N/O/P 全矩阵）（EN-1..20，259 用例；审查 `docs/reviews/B8.md`，P1×1 已修——撞基地 owner 规则）
- [x] **B9** 完整伤害链路（闪避/背击/暴击/吸血/真实/附加效果 + damage.* 事件；**背击追尾语义用户拍板 2026-09-12**）（DM-1..13，273 用例；审查 `docs/reviews/B9.md`，P2×3 已修）
- [x] **B10** 结束判定 + 超时扣血 + runFull 回放一致（T-EN-2/3/4 + T-BT-2/4/11；BE-1..8，281 用例；审查 `docs/reviews/B10.md`，P1×1 已修——T-BT-2 边界断言）
- [x] **B11（P1 收尾）** 黄金战斗（固定 loadout×AI×seed，crit 路径真实消费）+ `.audit/` 复算脚本 + **门禁项 8 激活 → gate 9 PASS/0 FAIL/0 PEND**（285 用例；审查 `docs/reviews/B11.md`，P1×1 已修——T-EN 编号归属）—— **P1 阶段 11/11 批收口**
- [x] **B12（P2 首）** `ai/ast.js`（validateProgram/collectUsedNodeTypes/nodePathOf/limits；random 分支盲区修复 + 自引用环防御）+ 覆盖型 fixtures（AF-1..13，298 用例；审查 `docs/reviews/B12.md`，P1×2 已修——random 盲区/接口名）
- [x] **B13** 合法性检测（分支 action 全案 D-101/break/call hoisting）+ 段位门控三段合一 + **unlock.validateAi 退役**（AV-*，302 用例；审查 `docs/reviews/B13.md`，P2×4 已修——表达式位逃逸/文档同步）
- [x] **B14** `ai/runtime.js` 显式状态机（隐式主循环/作用域链/循环计数/函数独立作用域+调用栈/break/每 tick 每用途随机流/只读快照/防御兜底全谱）（RT-12..17，323 用例；审查 `docs/reviews/B14.md`，P0×1 已修——函数作用域链跨 resume 重建）
- [x] **B15** `ai/runtime.js` 兜底与轨迹（步数统一兜底 wait+重置入口 / 递归上限 64 弹栈 / ai.node trace 事件 + 2000 截断 / ai.error 内部异常捕获；病态 fixtures pBurnSteps/pDeepRec）（RT-18..23 → runtime-limit 6 测试，329 用例；审查 `docs/reviews/B15.md`，PASS，P2×5 登记）
- [x] **B16（P2 收尾）** AI 全链路：canonicalize/programHash（纯 JS sha256）/版本迁移 v2 + serialize/restore/destroyContext + /api/v1/ai/validate|compile|battle + CLI ai + 引擎 aiTrace 接线（P1×1 已修——函数体内嵌套帧序列化帧路径规范化，P2×9 全落实；355 用例；审查 `docs/reviews/B16.md`）—— **P2 阶段 5/5 批收口**
- [x] **B17（P3 首）** 开箱 + 掉落池门控 + `POST /api/v1/box` + CLI `box`（**D-122 段位品质上限 + 截断后重归一**，P1×1 已修；unit/api/cli 共 12 用例，367 用例；审查 `docs/reviews/B17.md`）
- [x] **B18** 仓库 + 装配/拆卸 API（`GET /warehouse` 骨架 + assemble/disassemble 纯函数 L3 + HTTP + CLI `wh`；I-10 四道校验/原子性/T-PB-1..8 + T-PB-4 数据表单调；P1×2 已修——插件当目标/畸形桶崩溃 500；387 用例；审查 `docs/reviews/B18.md`）
- [x] **B19** loadout API + 校验 + `POST /api/v1/panel`（server/loadout.js L6 编排：I-12 全案/T-PB-9 引用完整/T-PB-8 双引用/门控 + 面板聚合五维/regen/special/技能参数；P1×3 已修——skills 畸形 500、双引用面板双计、无 warehouse 空转；404 用例；审查 `docs/reviews/B19.md`）
- [x] **B20** 技能插件消耗补偿与聚合 + 面板一致性（skills.applySkillPlugins 接入 buildPanel：delta=costDeltaBase×tier、减耗 ceil、倍率/冷却聚合；插件 unlockTier×2 数据门控真分支——T-PB-7/U-5d 兑现；P1×1 已修——聚合路径未知模板 500；411 用例；审查 `docs/reviews/B20.md`）
- [x] **B21（P3 收尾）** 属性测试全套（T-PB-10 往返包裹 T-PB-1..10）+ 数值校准收口（dodgeChanceBonus 0.20 定稿 D-127 / defK=40 入表 D-128 / 附加效果·melee·regen 冻结；schema 冻结清单同步；P1×1 已修；420 用例；审查 `docs/reviews/B21.md`）—— **P3 阶段 5/5 批收口，开放数值项全部关闭**
- [x] **B22（P4 首）** 回放帧契约完备性 + `POST /api/v1/battle`（双方 loadout + AI + seed → 完整帧）+ `GET /api/v1/replay/:id` 分片（server/battle.js L6：buildPlayer 面板聚合 + 双 AI 驱动 + 进程内回放注册表；engine tick/cid 感知日志装饰 + tick.end 入帧；同 seed 帧字节级复现；T-EN-9 + T-BT-1 帧可重建；P1×2 已修；427 用例；审查 `docs/reviews/B22.md`）
- [x] **B23（P4 收尾）** 文本回放器 CLI（`replay --file/--tick` 打印 px/碰撞/命中/verdict/事件）+ 帧充分性审计（.audit/replay-audit.js：六维 + 第七维链完整性/hp 守恒；雕像局破除——技能局 11 tick/3 命中真实执行；P1×1 已修——畸形帧崩溃误报；433 用例；审查 `docs/reviews/B23.md`）—— **P4 阶段 2/2 批收口**
- [x] **B24（P5 首）** 排位核心：快照不可变深拷贝（T-RK-5）+ 匹配 10 场（bot 补齐/排除自己/平局不计胜）+ `POST /api/v1/ranked/run` + CLI ranked run（ranked.js L6：抽签确定性、逐场派生种子、invalid 单独计数、ranked.* 日志；P1×1 已修——bot 技能不足 3 全 invalid；444 用例；审查 `docs/reviews/B24.md`）
- [x] **B25（P5 收尾）** 晋升判定（x=6/D-122）+ 段位→奖励品质 tierReward + `POST /api/v1/ranked/promote`（ranked.promote 事件；promotedAt 顶段口径分离 + wins 上限 + 开箱上限交叉绑定；审查 PASS；450 用例；`docs/reviews/B25.md`）—— **P5 阶段 2/2 批收口；连同 P7 的 7 批，§6 全量共 41 批 = P0–P5 的 9+11+5+5+2+2 + B27–B33 的 7（计数经 2026-09-19 复核）**
- [x] **B27–B33（P7 收尾，2026-09-19）** 在线服务与存档全部交付：B27 存储层（`server/store/*`：原子写/journal/物化档案/索引/单进程锁/崩溃恢复/两张参数表/`player.removed` 墓碑）、B28–B30 身份与档案（`auth.js`/`account.js`：账号会话、三配置槽、快照冻结、战绩与防守视图、排行榜）、B31–B33 排位/快速/接线（服务端抽池双向记账、非对称 Elo、回放鉴权 + LRU 64 + 按需重算、`admin` 端点、CLI/HTTP 接线）；同期 P7-5 e2e、P7-6 批量压测、P7-7 测试体系审查（`docs/reviews/B27.md`…`B33.md`、`docs/reviews/P7-7-test-audit.md`）。**至此 §6 批次总数 = 41 = P0–P5 的 34 + P7 的 7**（P6 前端仍为计划）
- [x] **前端文档 v3 重设计（2026-09-15）**：旧版（v2 绝对坐标盒模型 + Blockly）被判定"按文档写出来不能玩"（两轮实现 F0–F8 / R0–R7 均失败，根因见 `frontend-spec.md` §0）。新 `docs/frontend-spec.md` v3：**可玩优先**——废弃坐标注入与 Blockly，改浏览器正常布局 + 表单式 AST 编辑器；按钮→动作→数据字段三重契约由 `scripts/fe-spec-check.js`（C1–C9，含 5 个投毒用例）机器强制；真实响应样本落盘 `.audit/fe-samples.json`（58 个）；`docs/screens.md` 标记废弃。（该项完成时实跑 459/0；**当前实跑数字见 §3.3 与 §5.3**）
- [ ] **P6 前端实现（按 `frontend-spec.md` §18 的 F1–F7 批次；2026-09-16 复核：main 上无 `public/`、`server/index.js` 无静态托管路由，即 0 行前端代码）**：F1 静态托管+store/api/mount/顶栏 → F2 menu+gacha → F3 warehouse → F4 editor → F5 battle+排位 → F6 replay 战场 → F7 settings+存档+收尾；**每批必跑** `node scripts/fe-spec-check.js` 与 §2.1 的 14 步剧本
- [ ] 每批按 §5 节拍：先冻结接口 → 先红 → 实现 → `npm run gate` 全绿 → 独立审查 → 一个 commit（**§5.1 硬性规则**：改代码的提交必须同提交更新 `tasks.md` 勾选 + `progress.md` 状态，提交信息写明批次号与实跑结果）
- [x] **黄金战斗正式回归（D-150①）**：`tests/regression/golden-battle.test.js` **已落地并进入 `npm test`**（依据 `battle-walkthrough.md` §3.1 的**真实引擎复算轨迹：seed 20260912 / 18 tick / p2 胜**，与 `.audit/golden-battle.json` 逐帧一致）——**用户 2026-09-16 明确：只补这一条回归，不补空的 `tests/contract`/`tests/property` 目录**（空目录会静默通过）。**现状（2026-09-16 复核）**：`tests/regression/` 含该测试；`tests/property/` 现含 `items-invariants.test.js`（**在途**，属 P7 相关属性测试）；`tests/contract/` 仍为 `.gitkeep`（**不补空目录**）。回归另由 gate 项 8（黄金战斗 18 tick 日志冒烟 + 与 silent 逐帧一致）与 `node .audit/walkthrough.js` 复算承担。

### 3.2 文档（可选收尾）
- [ ] 设计期 `.audit/verify-*.js` 校验器已按 `examples/README.md` §3 在验证通过后删除；B11 黄金用例需用**真实引擎**重写校验，不复用脚手架（**2026-09-16 执行：`.audit/verify-rest.js` 已删除**（零引用）；`.audit/golden-battle.js/json` 保留为 gate 项 8 依赖）
- [ ] 实现期若发现新边界，按 `V-x` 编号登记到 `docs/examples/README.md` §4 并由用户拍板

### 3.3 本轮完成项（2026-09-16：数据驱动改造 + 机制接线）

> 均**已实测**（`npm test` 484/0、`npm run gate` 9 PASS/0 FAIL/0 PEND、`npm run check:docs` PASS；逐项有 `tests/unit/mechanics.test.js` 等用例）。本轮**未新增批次号**（P0–P5 仍为 34 批）。

- [x] **AI 节点表数据驱动**：新增 `server/data/skill-mechanics.json`（技能类型机制：params/slots/emit pattern）、`affix-registry.json`（词条语义：agg/skillOp/hitEffect/castEffect）、`ai-nodes.json`（AI 真实节点 **16 类** + `base` **9** + `actions` 词汇表）；`core/skills.js`、`core/engine.js`、`core/items.js`、`core/roles.js`、`core/unlock.js`、`ai/ast.js` 不再按技能类型/词条 id 写分支，只解释表里声明的 `pattern`/`op`。相关文档（`systems/03-skills.md`、`systems/01-items.md`、`items-data.md`、`examples/09-unlock.md`、`server/data/README.md`）已同步。
- [x] **机制接线（此前"已设计未生效"）**：`fullDodgeDuring` 三态（伤害/控制/弹幕判定，D-72）；技能插件词条 `crit_chance`/`lifesteal` → `skill.specials`（随弹幕 payload 参与命中结算、叠加面板值并按 1 封顶）、`cast_buff` → `skill.castEffects`（步骤 6 入队、下一 tick 起效 D-70、`duration` 缺省 2）；命中类 `stun/knockback/pull/dot/true_dmg` 由引擎按注册表 `hitEffect` 结算；角色插件 `hp_regen/sp_regen/mp_regen` 在引擎步骤 10 逐 tick 生效（`hp` 不在 `hp≤0` 时复活）；`loadout.buildPanel` 补 regen 叠加与 `specials/castEffects/affixes` 投影（此前 API 路径会静默丢失机制）；撞基地倍率改用 `battle-config.baseHitMul`（此前误用 `collisionDmgMul`，真值同为 0.8）。
- [x] **新增 `turn` 动作**（用户 2026-09-16 决定：朝向只能通过 `turn` 改变）：`core/engine.js` 行动集 = `move_left/move_right/dodge_left/dodge_right/wait/defend/turn`；`turn` 翻转朝向（`facing×−1`）、不移动不消耗；朝向写回统一在**步骤 7**（因此背击判定用"本 tick 写回后的朝向"）；`move_*`/`dodge_*`/位移都不改变朝向；引擎只在开战初始化与 `turn` 时写 `facing`。
- [x] **AI 合法性 + 字段枚举校验**：`call` 采用**调用链定点分析**（函数体直接含 `action`，或调用其它行动产出函数才算；"循环体只调用纯检测函数"被拒，纯检测函数本身可定义、顶层调用合法）；`ai/ast.js` 新增字段枚举校验（`logic.op∈{and,or}`、`loop.kind∈{count,while}` 且 count 必填 `times`/while 必填 `cond`、`arith.op∈{+,-,*,/}`、`cmp.op∈{>,<,>=,<=,==,!=}`）。**动作名仍不做校验期拒绝**（D-80：未知名运行期归一化为 `wait` + `action.invalid` warn）。
- [x] **节点段位口径收口（2026-09-16 二次修订：见 §3.4 删除 `bullets` 后的复算）**：`availableNodes(tier)` 只返回真实节点类型（单一数据源 `ai-nodes.json` 的 `nodes`，现为 **16 类**）；`unlock.json` 新增 `nodePermissions`；权限别名 `while` 折叠为 `loop`；预留权限 `arith_ext`（`implemented:false`）不授予任何节点（`isUnlocked` 恒 false）。当年口径 **11/13/15/15/17**（含 `bullets`）**已作废**，现行口径 **10/12/14/14/16**（见 §3.4 与 `systems/09-unlock.md`）。
- [x] **示例数据声明**：数据表当前为**示例数据**（角色/技能/插件/解锁内容待用户手动设计）——已在 `server/data/unlock.json`、`skill-mechanics.json` 等表头与 `server/data/README.md` 标注。
- [x] **安全与防作弊登记册**：新增 `docs/security-backlog.md`（record-only：**SEC-01…SEC-30 共 30 条**（高 7 / 中 16 / 低 7，2026-09-16 复核更正），含现状证据/风险/处置方向/优先级，**不派发任务、不改门禁**）。
- [x] **`npm run demo` 补齐**：新增 `scripts/demo.js`（默认 seed 20260912、逐 tick 摘要、`--log-level`/`--quality` 可选；`npm run demo:log` ≡ trace）——修掉安全登记册 SEC-19 记录的"脚本指向不存在文件"。
- [x] **走查 §3.1 按真实引擎重算**：`docs/battle-walkthrough.md` §3.1 由设计期 17 tick 改为**真实引擎结果 18 tick / p2 胜**（复算脚本 `.audit/walkthrough.js` → `.audit/walkthrough.json`，与 `.audit/golden-battle.json` 逐字段一致）。（**2026-09-16 已同步**：`docs/ai-handoff-prompt.md` 第 29 行已改为「**18 tick 轨迹**…已按真实引擎重算」，与本文件一致。）
- [x] **门禁机器强制 + 文档一致性检查（2026-09-16 落地）**：新增 `.githooks/pre-commit`（代码改动未更新 `tasks.md`/`progress.md` → 拒绝提交；随后强制 `check-docs`）、`.githooks/pre-push`（推送前跑 `scripts/gate.js`）、`scripts/check-docs.js`（D1–D6：npm 脚本双向一致 / 引用文件存在 / 批次计数一致 / 勾选数=批次数 / 审查记录覆盖）、`tests/integration/check-docs.test.js`（纳入 `npm test`）、`.github/workflows/gate.yml`（CI）、`package.json` 的 `check:docs` 与 `hooks:install`。**安装钩子**：`npm run hooks:install`（= `git config core.hooksPath .githooks`）；**本仓库已安装并实测生效**（`git config core.hooksPath` 返回 `.githooks`，本轮两次提交均由 pre-commit 实际执行了 `check-docs`）；新克隆仓库需自行执行一次。
- [x] **覆盖率回归修复并转绿**：数据驱动改造后 `server/core/skills.js` 分支覆盖率一度 80.17% < 85%（gate 项 7 FAIL，未覆盖的是"注入机制表"才能触发的 4 组防御分支）；修法为导出 `withTables(tables, logger)` 并补 6 个用例（478 → 484 用例），**`npm run gate` 现为 9 PASS / 0 FAIL / 0 PEND**。
- [x] **文档同步**：`docs/tasks.md`（34 批计数、P0-4 勾选、§5.1 提交前更新任务清单硬性规则、`turn`/枚举/`baseHitMul` 口径）、`docs/interfaces.md`（§1 模块与机制表、§2 端点状态「已实现 / ⏳ 计划」、§4 结构与序列化字段、§6 新增事件）、`docs/systems/07-engine.md`、`docs/systems/09-unlock.md` 已按实现更新。

### 3.4 第二波完成项（2026-09-16：核心/数据重构 + AI 语言修正 + 校验硬化 + 可玩性工具）

> **实测（2026-09-16 收尾；本波各项的决策编号见 `decisions.md` §14 的 D-137…D-153）**：
> · 本波代码落地时曾实测 `npm test` = 505 通过 / 0 失败、`npm run gate` = 9 PASS / 0 FAIL / 0 PEND、`npm run check:docs` = PASS、`node scripts/fe-spec-check.js` = 9 PASS。
> · **最近一次复测（2026-09-16；仓库处于 P7 多线并行状态——**用例数与红项每轮在途改动都在变，以你实测的当次输出为准**）**：`npm test` = **683 用例 / 680 通过 / 3 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、`npm run check:docs` = **PASS**、`node scripts/fe-spec-check.js` = **9 PASS**；D 落点相关 `tests/integration/interfaces.test.js` = **6/6 绿**、`tests/api/api-ai.test.js`（含本轮新增的"快照不含 bullets"防回归断言）= **10/10 绿**，**项 5 文档↔数据一致性 + D 编号落点 = PASS（含 D-137…D-153 落点）**。
> · **当次 3 条红的归属（不是本轮文档同步引入的）**：`PS-1 重启一致`/`PS-2 journal 记录类型`/`PS-4 崩溃点补放`——均在**在途的持久化用例**（`server/store/*` + `tests/unit/store-persist*.test.js`，P7-1/P7-2 在途）。**转绿条件**：持久化阶段收敛（**不是放宽阈值**）。
> · **更早的中间态（仅说明历史，均已自行收敛）**：517 用例 / 15 红（P7-0 门控与 `check-arch` 未登记，随 commit `948ae6e` 消失）→ 643 用例 / 2 红（`AD-1`/`AD-6`）→ 665 用例 / 4 红（`AU-5`/`AU-6`/`AU-7`/`BR-6`）→ 668 用例 / 1 红（`LIM-2`）→ 当次 3 红。**以上各批红均非本轮文档同步引入。**

- [x] **核心/数据重构（D-141/D-142/D-143/D-144/D-149）**：超时扣血改为**基地按自身 maxHp** 扣（**D-141**，消除"变强即变弱"）；`typeModifiers` 接入开箱生成路径（**D-142**，11 角色不再数值同质）；掉落改为**每项可控**（`drop`/`dropWeight`/`unlockTier`，**D-143**）；`schema.js` 去掉硬编码数量（改机制自洽校验，`_sample` 仅控示例期望表比对，**D-144**）；合并 `roles.equipPlugins/getFinalStats` 与 `loadout.buildPanel` 双实现（**D-149**，消除 regen 双写与角色 shape 分歧）。
- [x] **AI 语言修正（D-138/D-139/D-140）**：`random` 双语义修复（语句位执行 then/else 分支 + 表达式位返回布尔；**D-139**）；**删除 `bullets` 节点与 `bullets[i].*` 路径、快照不再投影 bullets**（**D-138**："AI 不可观测弹幕"＝设计而非缺陷，弹幕当 tick 全解算；节点 **16 类** / `base` **9**；段位累计 **10/12/14/14/16**；旧口径 17 类 / base 10 / 11/13/15/15/17 **已作废**）；`aiTrace` 改为**每 tick**重置（单 tick 上限 2000；**D-140**）；`server/battle.js` 的 trace 司机同步修正，并在 `tests/api/api-battle.test.js` 增加"**每帧 aiTrace 非空且归属各自 tick**"的契约断言。
- [x] **校验硬化（D-145/D-146）**：**四类一律校验期拒绝**（**D-145**）——① `get.path` 白名单（泛化路径解析支持 `bases.self.hp`、`self.cooldowns.<sid>`、`self.effects[i].<f>`；**容器不可当值读**）；② 变量名拼错（必须先声明）；③ 表达式位写语句节点；④ 无 action 程序。**同时保留运行层兜底**（缺路径 → 安全默认 `0`/`false`，**不抛**；校验层不替代运行层）。`/api/v1/ai/validate|compile` 新增 **warnings** 通道（**非法动作名不拒绝**，保持 D-80 的运行期归一化；**D-146**，响应带 `data.warnings`）。
- [x] **AI 投影与端点（D-147/D-148）**：快照补齐 `tick`/`maxHp|maxMp|maxSp`/`cooldowns`/`effects`/`bases.*`（**D-147**），并修正 **`baseHp` ＝ 基地当前血量**（≠ 角色最大血量；旧实现误填角色 maxHp）；`/api/v1/ai/battle` 明确回报未生效动作（`actionsEffective`/`ineffectiveActions`/`frames[].actions|events`；**D-148**）。
- [x] **可玩性工具（D-150/D-151）**：`scripts/play.js`（`npm run play` 离线文本闭环：开箱→装配→预设 AI→面板→战斗→逐 tick 战报）；`cli replay` 增加**伤害数字与暴击/背击标注**；**只补** `tests/regression/golden-battle.test.js`（黄金战斗正式回归，进入 `npm test` 计数；**不补空的 `tests/contract`/`tests/property` 目录**；**D-150/D-151**）。
- [x] **新增计划文档（D-150/D-152）**：`docs/plan-p7-playable.md`（P7 冲刺蓝图：关段位门控 → 存储层 → 身份档案 → 排位/快速对战 → HTTP/CLI 接线 → 全链路 e2e → 批量测试；含每阶段验收标准与风险；§0 第 7 条＝**阶段级"代码级审查"硬性要求**，§P7-3/§P7-6 明写**禁止占位 bot 充数**）。
- [x] **本轮文档同步（2026-09-16，D-137…D-153 落点）**：`docs/decisions.md` **§14 新增 D-137…D-153 共 17 条**（用户本轮全部拍板）；`docs/interfaces.md` §5 D 落点表**追加 D-137…D-153 行**（仅追加，不动既有行）；`server/data/schema.js` 增加**数据层 D 落点登记块**（gate 项 5 子 A 的可检索落点）；`docs/tasks.md` §3.7.2/§3.7.6（删 `bullets`、快照白名单）；`docs/systems/08-ai.md` §4.5（快照不投影 bullets + 字段清单）；`docs/battle-walkthrough.md` §3/§3.2（快照不含 bullets）；`docs/security-backlog.md` SEC-17（投影字段与行号）+ SEC-19/SEC-03（处置状态）；`README.md`（`npm run play`、脚本与文档索引、实测数字）；`docs/ai-handoff-prompt.md`（过期口径）。**① `docs/decisions.md` 为最高权威：只追加、不改既有 D 条目。**
- [x] **P7-0 关闭段位门控（D-137，2026-09-16 已落地）**：`unlock.json` 新增 `gating.enabled=false` 总开关；`core/unlock.js`（`availableNodes`/`isUnlocked`/`filterByTier`/`validateLoadout`）、`core/items.js`（`validateUnlock`/`rollQuality` 品质截断）、`server/box.js`、`server/loadout.js`、`ai/ast.js`（`node_locked`）读开关；**门控逻辑与数据字段保留**（`unlockTier`/段位树作元数据），`withGating(true|false)` 使**开/关两模式都有测试**；排位晋升与段位奖励不受开关影响（属进度，不属门控）。**现状（2026-09-16 复测）**：门控相关用例全绿（D-137 的开关语义由 `withGating(true)`/`withGating(false)` 两套用例钉死）。
- [x] **P7-1 存储层（B27，2026-09-16 已落地）**：`server/store/*`（适配器契约 + JSON 适配器原子写、append-only journal + 幂等 apply、物化档案、内容寻址快照库、索引、单进程锁、崩溃恢复）；`scripts/check-arch.js` 已登记新层；`tests/unit/store-*.test.js` + `tests/property/items-invariants.test.js`。**现状（2026-09-16 复测）**：`GX-8 check-arch` 已转绿，存储层用例全绿（其中 `AD-1`/`AD-6` 曾在途中红，已由并行改动修绿，见 §3.4 说明）。
- [x] **P7-2/P7-3/P7-4/P7-5/P7-6/P7-7（2026-09-19 全部交付）**：身份与会话（`auth.js`：并发注册闭合 / `session_expired` / 启动 prune + 读时懒清理）、排位与快速对战（**去占位 bot + `shortfall`**、D-136 去重窗口裁定、双向记账、Elo 可复算与积分守恒）、HTTP·CLI 接线（Bearer/401/403/409/410/429、`DL_*` 五个变量、回放 LRU 64 + 410、CLI 退出码 3、`readBody` → 413）、P7-5 全链路 e2e（`npm run e2e` 22/22）、P7-6 批量测试（`npm run load-test`，真实玩家 + 7 条完整性断言）、P7-7 测试体系冗余与缺口审查（`docs/reviews/P7-7-test-audit.md`、`docs/reviews/P7-7-wave2-code-review-residual.md`）。**实测**：`npm test` = 942 通过 / 0 失败、`npm run gate` = 9 PASS / 0 FAIL / 0 PEND、`check-docs` PASS、`fe-spec-check` 9 PASS。
- [x] **`POST /quick/run` 抽池/实例化可用性口径不一致 —— 已修复（2026-09-19，D-157）**：原症状为"发起者带装配引用 + 抽到默认配置对手 + 进程内仓库镜像缓存缺失 → `409 no_opponent`"。修法：新增 `ranked.sideInstantiable(loadout, warehouse, tier)`（用与 `battleOne` **同一实现**的 `battle.buildPlayer` 证明"真的能实例化"），**抽池与实例化共用该判定**——`server/quickmatch.js` 的 `candidatePool`（带装配引用的候选不可实例化 → `skipped.notInstantiable`、不入池）与 `requireArchive`/`run`（发起者侧同样先判，失败给可解释错误码）两处一致；回归用例 `tests/unit/quickmatch-availability.test.js`。**仍不得注入 bot**（D-152）；匹配池的硬性要求见 `docs/systems/10-ranked.md` §4.3。

---

## 4. 关键约定（避免走弯路）

1. **改中文文档禁止用 PowerShell 5.1 的 `Get-Content`/`Set-Content`**（会造成双重编码损坏）；用文件工具或 Node（UTF-8 无 BOM）。
2. **数值必须机器复算**：示例/走查/测试断言里的每个数字都要有独立可复跑的机器计算验证（脚本或测试内的计算），不靠手算；冻结常量注明复算方式。
3. **机制在代码、数值在表**：所有战斗数值来自 `battle-config.json` 等数据表。
4. **计算与文档分工**：分支穷举在 `examples/`，端到端串联在 `battle-walkthrough.md`，实现细则在 `systems/`。
5. **分支现状（2026-09-19 复核）**：`main` 是唯一主线（合流已完成）；**`dev` 分支已不存在**。现存分支仅 `main` / `deepseek-v4.1f` / `glm-5.3f`（后两个为前端实验分支，未合并）。下文 §5.1 L-5、§5.2 中凡以 `dev` 为对象的表述均已失效，仅作历史记录保留。⚠ **门禁现状（2026-09-19 最后实测）**：`npm test` = **942 通过 / 0 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、`npm run check:docs` = **PASS**、`node scripts/fe-spec-check.js` = **9 PASS**、`npm run e2e` = **22/22**、`npm run load-test -- --players 50 --deep` = **7/7 完整性断言**；P7 已收口，此前的在途红项（`PS-1`/`PS-2`/`PS-4` 等持久化用例）已全部转绿（见 §3.4）。

---

## 5. 遗留问题审查（本节为 **2026-09-12 历史记录**；行内补充的「现状」列均为 2026-09-16 复核）

### 5.1 质量类（建议 B22 前处理）

| # | 问题 | 证据 | 建议处置 |
|---|---|---|---|
| L-1 | **偶发 flake：gate 项 7 有约 1/7 概率 2 个用例失败** | 首跑（B21 时期）`[FAIL] 项7 … 2 个用例失败（总 420）`；随后 6 次（npm test / npm run cov / gate×2 / 独立进程×4）全部 420/0。**未定位到具体用例** | B22 批内加"连续 5 次全量复跑全绿"回归并定位根因（疑：order/时序/端口类用例）。**现状（2026-09-16 实测）：`npm test` = 484 通过 / 0 失败，未复现该 flake；根因仍未定位，仍属观察项** |
| L-2 | **走查文档与真实引擎黄金战斗不一致** | `battle-walkthrough.md` §3.1 为设计期轨迹 **17 tick / P1 胜**；`.audit/golden-battle.json`（gate 项 8 在用）为 **18 tick / P2 胜**（seed 20260912） | 按真实引擎输出重生成走查 §3.1 轨迹表（或以 golden-battle.json 为准并标注），消除文档漂移。**现状（2026-09-16 复核）：✅ 已完全处理**——§3.1 已按真实引擎重算为 **18 tick / p2 胜**（复算 `node .audit/walkthrough.js`，与 `.audit/golden-battle.json` 逐字段一致）；**`tests/regression/golden-battle.test.js` 亦已于 2026-09-16 落地**（见 §3.1/§3.4），本条关闭 |
| L-3 | **临时审查目录被提交**：探针脚本已入库 | 记录时 `git ls-files ".review-*"` = **24**（`.review-b16..b20`）；审查结论另有 `docs/reviews/`。**现状（2026-09-16 复核，实测）：`git ls-files ".review-*"` = 53**（**以 53 为准，24 为旧记录**），分布在 `.review-b16/b17/b18/b19/b20/b22/b23/b24/b25`（覆盖全部后端批次，b21 无独立目录）；`docs/reviews/` = 34 文件 | 移出追踪 + 追加 `.gitignore`；若需保留探针则归入 `tools/scratch/` 并说明。**现状（2026-09-16 已清理）：`.gitignore` 已增 `.review-*/`，`git ls-files ".review-*"` = 0；53 个文件保留在磁盘但不再被追踪；清理提交见 `1b74e3f`** |
| L-4 | **设计期临时校验器残留**：`.audit/verify-rest.js` 等 | 约定"验完即删"；`.audit/golden-battle.js/json` 为 gate 项 8 依赖**必须保留** | 删除已无用的 verify-* 临时脚本；保留 golden-battle.*；`.audit/.v8cov*` 确认是否入库，若是则移出。**现状（2026-09-16 执行）：`.audit/verify-rest.js` 已删除**（全仓零引用）；`.audit/golden-battle.*`、`.audit/walkthrough.*`、`.audit/fe-samples.*`、`.audit/replay-audit.js` 为 gate/审计/前端字段依据，保留 |
| L-5 | **`main` 落后 `dev` 32 个提交**，无合流检查清单 | 记录时 `git log --oneline main..dev` = 32 | 制定合 main 检查清单（gate 9/9 + 连续复跑 + 文档同步），B24/B25 后合一次 |
| ~~L-6~~ **（已于 2026-09-16 当轮修复并转绿）** | `npm run gate` 项 7 曾 FAIL：`server/core/skills.js` 分支覆盖率 80.17% < 85% | gate 曾输出 `[FAIL] 项7 … server/core/skills.js 行96.875%/分支80.17241379310344%/函数100%`；`npm run cov` 按**全局**阈值判定仍 exit 0（全表分支 85.30%），gate 项 7 按**文件**判定故 FAIL。未覆盖行：`skills.js` 40、115-116、142-144、223-225（`fieldValue` 非 Px 分支、未知算子 warn、未登记词条 warn、未知发射模式 warn）——这些防御分支只能通过**注入机制表**触发，而当时 `makeSkills(logger, tables)` 未对外导出 | **已修**：`server/core/skills.js` 导出 `withTables(tables, logger)` 并补 6 个用例（478 → 484 用例）→ **`npm run gate` = 9 PASS / 0 FAIL / 0 PEND**。阈值未放宽（`tasks.md` §5.1 第 4 条 / §10）。 |


> **L-5 现状（2026-09-16 复核）**：**已失效**——`dev` 分支不存在（`git branch` = `main` / `deepseek-v4.1f` / `glm-5.3f`），`main` 合流已完成（HEAD `cee2ebf`）；两个前端分支未合并。合流清单见 `docs/acceptance.md` §7（已标记为"已完成"）。

### 5.2 功能未完成（预期内，非缺陷）

> 原表两行（回放 / 排位）为 **2026-09-12 的旧快照**，且与 §3.1 的完成记录矛盾，已于 2026-09-16 复核后删除。现状如下：

| 项 | 批次 | 现状（2026-09-16 复核） |
|---|---|---|
| 回放：`/api/v1/battle` + `/api/v1/replay/:id` + 文本回放 CLI + 帧自足审计 | B22/B23 | ✅ **已完成**（`server/index.js` 已注册 `POST /api/v1/battle` 与 `GET /api/v1/replay/:id`，`tests/api` 覆盖，gate 项 9 冒烟通过）。~~2026-09-12 旧记录"`server/battle.js` 正在被并发实施"~~ 已过期；`server.md` §3.2 的状态同步亦已完成（端点已移入 §3.1） |
| 排位：`/ranked/run` + `/ranked/promote`（快照/bot 池/晋升 x=6） | B24/B25 | ✅ **已完成**（`server/ranked.js` 已实现并接线 `POST /api/v1/ranked/run`、`POST /api/v1/ranked/promote`）。~~2026-09-12 旧记录"未接线；`ranked.js` 未实现"~~ 已过期 |
| 前端全部 | P6 | **未开始（0 行代码；2026-09-19 复核：main 上无 `public/`，`server/index.js` 无静态托管路由）**；`docs/frontend-spec.md` **v3（2026-09-15 重设计：可玩优先）** 已备 —— 7 屏逐屏按钮表 + 动作白名单 + 表单式 AST 编辑器（不用 Blockly）+ 战场渲染 + 前端日志；实现按 §18 的 F1–F7 批次。仍需后端配合：静态托管（`public/`、`/shared`、`/assets`，见 spec §16）。**⚠ 待同步**：P7 使"账号/段位/积分/战绩/回放鉴权"改为服务端权威，`frontend-spec.md`/`screens.md` 尚未同步（登录屏、我的战绩、防守战绩、排行榜、token 存储、`GET /me` 启动拉取） |
| 在线服务（账号/登录/档案/配置槽/战绩/排行榜/快速对战/异步排位/非对称 Elo/回放鉴权） | P7（B27–B33） | ✅ **已完成（2026-09-19）**：`server/store/*`、`server/auth.js`、`server/account.js`、`server/quickmatch.js`、`server/admin.js` 均已实现并接线，HTTP 层有 Bearer 鉴权分支与 `runtime/`（`DL_DATA_DIR`）。审查记录 `docs/reviews/B27.md`…`B33.md`；交付实测见 §0 与 §5.3 |
| 数值开放项 | — | 已全部关闭（D-127 dodgeChanceBonus、D-128 defK 入表，B21 收口） |

### 5.3 说明

- **门禁实测（2026-09-19，P7 收口后）**：`npm test` = **942 通过 / 0 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、`npm run check:docs` = **PASS**、`node scripts/fe-spec-check.js` = **9 PASS**、`npm run e2e` = **22/22**、`npm run load-test -- --players 50 --deep` = **7/7 完整性断言**（全部 exit 0）。（历史上曾因 `server/core/skills.js` 分支覆盖率 80.17% < 85% 而项 7 FAIL，已通过导出 `withTables` 注入机制表并补 6 个用例修复；根因与修法见 §5.1 **L-6**；**禁止放宽阈值**。）
- **历史记录（B21 时期）**：`npm test` / `npm run cov` 均为 420/0；测试规模 420 用例 / 48 个测试文件。覆盖率阈值（行 90 / 分支 85 / 函数 90）持续通过。
- **前一轮实测（2026-09-16 早期复核，本轮改动前）**：`npm run gate` = 9 PASS / 0 FAIL / 0 PEND；`npm test` = 459 通过 / 0 失败。（B25 提交时的同口径记录见 `docs/reviews/B25.md`。）
- 黄金战斗为 gate 项 8 的冒烟基准（**18 tick，p2 胜**，seed 20260912），**B11 黄金回归测试 `tests/regression/golden-battle.test.js` 已于 2026-09-16 落地**并进入 `npm test`；走查 §3.1 已按真实引擎复算（L-2 已关闭）。

- **P7 阶段进展（自动同步，2026-09-19T02:43:36.404Z）**：P7-2 身份与会话（P0 并发注册闭合/session_expired/启动 prune/配置生效）、P7-3 排位与快速对战（**去占位 bot + shortfall**、D-136 去重窗口裁定、双向记账、Elo 可复算与积分守恒）、P7-4 HTTP/CLI 鉴权与端点（Bearer/401/403/404/409/410/429/DL_*/回放 LRU64+410/CLI 退出码 3/readBody→413）、存储层两张数据表与 player.removed 墓碑。实测：npm test 803/0、gate 9 PASS/0 FAIL/0 PEND、check-docs PASS、fe-spec-check 9 PASS。

- **P7-5 e2e 落地**（2026-09-19T02:49:51.781Z）：新增 scripts/e2e.js 与 tests/helpers/e2e.js（全链路 22 检查点）。实测 npm test 803/0、gate 9 PASS/0 FAIL/0 PEND、check-docs PASS、fe-spec-check 9 PASS。

- P7-5/P7-6 阶段进展（2026-09-19T02:54:05.521Z）：e2e/load 脚本与夹具持续落地。实测 npm test 803/0 或更高、gate 9 PASS/0 FAIL/0 PEND。

- **存储层后续项 A+B 完成**（2026-09-19T02:55:34.958Z）：新增 server/data/service-config.json 与 rating-config.json（表为数值单一来源，代码默认值兜底；schema 冻结值+跨字段不变量校验+缺表必 FAIL）；新增 player.removed 墓碑记录类型（全量重放不复活已删玩家，幂等）。store 测试 128/128。

- P7-5/P7-6 用例落地（2026-09-19T02:57:29.951Z）：e2e-play / load-integrity 测试推进。

- P7-5/P7-6 进展（2026-09-19T02:59:09.837Z）。

- P7-5/P7-6/P1修复 进展（2026-09-19T03:02:16.219Z）。

- P7-5/P7-6/P1修复 进展（2026-09-19T03:04:15.056Z）。

- P7-5/P7-6/P1修复 进展（2026-09-19T03:07:35.792Z）。

- 阶段进展（2026-09-19T04:22:33.268Z）。

- 阶段进展（2026-09-19T04:45:59.252Z）。

- 阶段进展（2026-09-19T04:51:48.387Z）。

- 阶段进展（2026-09-19T05:25:03.087Z）：快照自洽/逐侧仓库回放/批次互斥 + P7-7 + e2e 确定化。

- 终局小修与复审（2026-09-19T05:36:41.596Z）。

- 终局进展（2026-09-19T05:42:21.272Z）。

- 终局进展（2026-09-19T05:46:27.316Z）。

- 终局进展（2026-09-19T05:49:52.928Z）。

- 终局进展（2026-09-19T05:53:05.868Z）。

- 终局进展（2026-09-19T05:56:47.026Z）。

- **终局文档同步（2026-09-19，中央文档批）**：`docs/systems/11-account-store.md`（§5.4 快照可选 `warehouse` 装配引用子集 / §7.4 `loadWarehouse` 三级来源 + 逐侧签名 + 归档回放按各自快照取镜像 / §7.2 `relaxed`+`invalids` 落 `ranked.batch` 与去重窗口裁定 / §4.6 限速与 §10.3 错误码 / §5.6 索引合并写语义 / §9.4 `programHash` 口径更正）、`docs/interfaces.md`（§1 补 `server/battle.js`、`server/store/archive.js`、`server/store/ledger.js` 与 `snapshotWarehouseOf`/`snapshotWarehouseRefreshed` 签名）、`docs/server.md`（§1 进程模型 / §2 环境变量 / §3 端点 / §4 状态码与错误码 / §6 状态契约 / §7 CLI / §9.1 runtime 目录全部由「计划中」改为「现状」）、`docs/tasks.md`（B27–B33 勾选 + 共 41 批 + MS7 达成）、`docs/progress.md`（本节）、`docs/security-backlog.md`（SEC-01/SEC-03/SEC-22 处置回填 + 汇总表）、`server/data/README.md`（两张参数表与 `affix-registry` 的 `domain`/`_domainOfKind` 语义）。**实测**：`node scripts/check-docs.js` = PASS（批次勾选 41 / 审查记录 41/41）、`node scripts/fe-spec-check.js` = 9 PASS、`node --test tests/integration/interfaces.test.js tests/integration/check-docs.test.js tests/frontend/fe-spec.test.js` 全绿。

- 终局修复 II 与文档同步（2026-09-19T06:20:41.637Z）。

- 终局修复 II 与文档同步（2026-09-19T06:23:31.257Z）。

- 终局收口（2026-09-19T06:29:36.757Z）。

- 终局收口（2026-09-19T06:32:18.387Z）。

- 终局收口（2026-09-19T06:36:06.918Z）。

- 终局收口（2026-09-19T06:38:29.912Z）。

- 终局收口（2026-09-19T06:41:30.790Z）。

- 终局收口（2026-09-19T06:44:30.429Z）。

- 终局收口（2026-09-19T06:48:02.032Z）。

- 终局收口（2026-09-19T06:50:40.077Z）。

- 终局缺陷收口（2026-09-19T06:54:56.328Z）。

- 终局缺陷收口（2026-09-19T07:07:43.240Z）。
