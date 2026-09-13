# 当前状态与下一步

> 更新：2026-09-12
> 用途：跨会话续接。只记录**当前状态**与**待办**，不保留历史。

---

## 1. 文档体系（权威链）

```
docs/decisions.md      决策记录（D-01…D-128）  ← 最高权威
docs/systems/01~10.md  各系统实现细则
docs/v3-design.md      主设计文档（架构/数据模型/数值）
docs/items-data.md     物品数值、名称、贴图占位
docs/interfaces.md     接口冻结（ICD v1：模块/API/CLI/数据结构/D 落点）
docs/server.md         服务器文档（部署、端点速查、信封与错误码、无状态契约）
docs/frontend-spec.md  前端设计文档（P6 唯一前端规范）
docs/tasks.md          开发计划（铁律/接口/测试矩阵/批次/门禁）
docs/examples/         分支示例集（10 系统 + 索引），计算细节的唯一出处
docs/battle-walkthrough.md  端到端走查：**系统间数值与状态传递**
docs/progress.md       本文件
```

---

## 2. 已定型的核心规则（速查）

| 主题 | 结论 | 决策 |
|---|---|---|
| 空间 | 16 格 × 64px = 1024px 连续坐标，1px 精度，格心定位，clamp `[32,992]` | D-01~D-08 |
| 移动/碰撞 | 穿敌四情形；碰撞 = 目标间距**严格 <64**；碰撞伤害 `atk×0.8`；被动位移同样结算 | D-10~D-17、D-35 |
| 位移伤害 | **沿声明路径每格一枚 0 速弹幕**（等级取模板 `bulletLevel`），与碰撞伤害**分别结算** | D-18、D-118 |
| 弹幕 | 不跨 tick、当 tick 飞完全射程、连续方程求交、按生成顺序递归抵消、`t∈[0,1]`（含 t=0 立即拦截） | D-20~D-32 |
| 伤害 | 倍率相乘后只取整一次；`defend` = `def×1.6`；背击用**位移后**朝向；吸血 floor 封顶 | D-40~D-51 |
| 基地 | **弹幕不伤基地**；唯一途径是"面向基地并移动"（停原地 + `atk×0.8`） | D-60~D-62 |
| 效果 | 新效果下一 tick 起效；控制复写不扣资源；`fullDodgeDuring` 免疫伤害+控制且**不参与弹幕判定** | D-70~D-72、D-84 |
| AI | 隐式不可跳出的 `while(true)`；循环体**所有分支**须含 action；函数=打包代码块（无参返回，有独立作用域+调用栈）；每 tick 每用途随机流；兜底返回 `wait` | D-80~D-104 |
| 数据表 | 角色模板必填 `regen`；技能模板带 `slotWeights`/`falloff`/`bulletLevel`（含位移）；三表可选 `unlockTier`；`costDeltaByTier` 逐档数组；插件变体拆独立 id | D-110~D-118 |
| 产品 | 紫段位=随机+扩展运算符；晋升 x=6；本轮不做存档；前端无框架 | D-120~D-124 |

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
- [x] **P0-8** HTTP/CLI 骨架：零依赖 node:http（express 白名单保留未引入）+ 统一信封 + health/data/log-level + CLI 退出码 0/1/2（AP-1..10/CLI-1..14；真实进程闭环 health=0/data=1/bogus=2；审查 `docs/reviews/P0-8.md`，P2×4 已修；**gate 项 9 激活 → 8 PASS/0 FAIL/1 PEND**）
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
- [x] **B25（P5 收尾）** 晋升判定（x=6/D-122）+ 段位→奖励品质 tierReward + `POST /api/v1/ranked/promote`（ranked.promote 事件；promotedAt 顶段口径分离 + wins 上限 + 开箱上限交叉绑定；审查 PASS；450 用例；`docs/reviews/B25.md`）—— **P5 阶段 2/2 批收口，后端全量完成（P0..P5 共 31 批）**
- [x] **F0（P6 首）** 静态托管（public/shared/assets 六前缀 + 穿越加固）、gate 五目录阈值、check-arch public→L7（ESM 扫描）、public 骨架（index.html/tokens/ util/log 三态 / app boot）；P2×4 当批落实；457 用例；审查 `docs/reviews/F0.md`（PASS）
- [x] **F1（P6 基建）** 布局引擎（sizes/layout/verifyLayout 四类自检）+ api client（信封/seed 回带/signal）+ store（reducer buckets 形状 + effects + persist schemaVersion）+ app boot 主流程；P1×5 已修（契约形状断裂/标志缺失/key 分叉）；479 用例；审查 `docs/reviews/F1.md`（CONDITIONAL PASS → 修复后 PASS）
- [ ] **F2 起**（P6 外壳：mount/事件委托 + menu + settings 日志面板）按 `docs/frontend-spec.md` §11 推进
- [ ] 每批按 §5 节拍：先冻结接口 → 先红 → 实现 → `npm run gate` 全绿 → 独立审查 → 一个 commit
- [ ] B11 落地黄金战斗 `tests/regression/golden-battle.test.js`（依据 `battle-walkthrough.md` 的 17 tick 轨迹，同 seed 逐帧一致）

### 3.2 文档（可选收尾）
- [ ] 设计期 `.audit/verify-*.js` 校验器已按 `examples/README.md` §3 在验证通过后删除（未入库）；B11 黄金用例需用**真实引擎**重写校验，不复用脚手架
- [ ] 实现期若发现新边界，按 `V-x` 编号登记到 `docs/examples/README.md` §4 并由用户拍板

---

## 4. 关键约定（避免走弯路）

1. **改中文文档禁止用 PowerShell 5.1 的 `Get-Content`/`Set-Content`**（会造成双重编码损坏）；用文件工具或 Node（UTF-8 无 BOM）。
2. **数值必须机器复算**：示例/走查/测试断言里的每个数字都要有独立可复跑的机器计算验证（脚本或测试内的计算），不靠手算；冻结常量注明复算方式。
3. **机制在代码、数值在表**：所有战斗数值来自 `battle-config.json` 等数据表。
4. **计算与文档分工**：分支穷举在 `examples/`，端到端串联在 `battle-walkthrough.md`，实现细则在 `systems/`。
5. **开发提交一律在 `dev` 分支**（2026-09-12 用户指示）；`main` 保持门禁全绿才合并。

---

## 5. 遗留问题审查（2026-09-12 记录，按优先级）

### 5.1 质量类（建议 B22 前处理）

| # | 问题 | 证据 | 建议处置 |
|---|---|---|---|
| L-1 | **偶发 flake：gate 项 7 有约 1/7 概率 2 个用例失败** | 首跑 `[FAIL] 项7 … 2 个用例失败（总 420）`；随后 6 次（npm test / npm run cov / gate×2 / 独立进程×4）全部 420/0。**未定位到具体用例** | B22 批内加"连续 5 次全量复跑全绿"回归并定位根因（疑：order/时序/端口类用例） |
| L-2 | **走查文档与真实引擎黄金战斗不一致** | `battle-walkthrough.md` §3.1 为设计期轨迹 **17 tick / P1 胜**；`.audit/golden-battle.json`（gate 项 8 在用）为 **18 tick / P2 胜**（seed 20260912） | 按真实引擎输出重生成走查 §3.1 轨迹表（或以 golden-battle.json 为准并标注），消除文档漂移 |
| L-3 | **临时审查目录被提交**：`.review-b16..b20`（24 文件，探针脚本）已入库 | `git ls-files ".review-*"` = 24；审查结论另有 `docs/reviews/`（30 文件，正常） | 移出追踪 + 追加 `.gitignore`；若需保留探针则归入 `tools/scratch/` 并说明 |
| L-4 | **设计期临时校验器残留**：`.audit/verify-rest.js` 等 | 约定"验完即删"；`.audit/golden-battle.js/json` 为 gate 项 8 依赖**必须保留** | 删除已无用的 verify-* 临时脚本；保留 golden-battle.*；`.audit/.v8cov*` 确认是否入库，若是则移出 |
| L-5 | **main 落后 dev 32 个提交**，无合流检查清单 | `git log --oneline main..dev` = 32 | 制定合 main 检查清单（gate 9/9 + 连续复跑 + 文档同步），B24/B25 后合一次 |

### 5.2 功能未完成（预期内，非缺陷）

| 项 | 批次 | 现状 |
|---|---|---|
| 回放：`/api/v1/battle` + `/api/v1/replay/:id` + 文本回放 CLI + 帧自足审计 | B22/B23 | **⚠ 审查时观察到 `server/battle.js` 正在被并发实施**（`index.js` +52 行等改动在途）；落地后将同步 `server.md` §3.2 与 `interfaces.md` 状态列 |
| 排位：`/ranked/run` + `/ranked/promote`（快照/bot 池/晋升 x=6） | B24/B25 | 未接线；`ranked.js` 未实现 |
| 前端全部 | P6 | 0 行代码；`docs/frontend-spec.md` 已备（7 屏/store/渲染/Blockly/日志面板/API 映射）；还需静态托管（/public、/shared、/vendor/blockly）、localStorage 存档（D-123）、T-LG-10 前端日志 |
| 数值开放项 | — | 已全部关闭（D-127 dodgeChanceBonus、D-128 defK 入表，B21 收口） |

### 5.3 说明

- 门禁实测：后两次 `npm run gate` = **9 PASS / 0 FAIL / 0 PEND**；`npm test` 与 `npm run cov` 均为 420/0。
- 测试规模：**420 用例 / 48 个测试文件**；覆盖率阈值（行 90 / 分支 85 / 函数 90）通过。
- 黄金战斗为 gate 项 8 的冒烟基准（18 tick，P2 胜），B11 黄金回归测试 `tests/regression/golden-battle.test.js` 尚未单独落地（L-2 一并处理）。
