# 当前状态与下一步

> 更新：2026-09-25（**P7 在线服务（B27–B33）已全部交付并收口；F3 全批已落地**——提交① 后端契约（`D-159`…`D-162`）、提交② 前端主界面线、提交③ 出战配置编辑器；**另有 `D-163` 热修**（用户实测报告触发的 3 个真缺陷：`/me/configs` 物品数值可伪造、同配置内模板可重复占位、重启后开箱静默丢件）**已交付**；**战斗线后端修复批进行中（§0.5）：`D-164` 守方 AI 完整镜像 / `D-165` 回放 410 修复 / `D-166` 注入 bot 多样化 三条已交付，帧契约·软冷却·winner 统一·`admin/account-patch` 未做**；**`F1`/`F2`/`F3` 的浏览器人工走查已于 2026-09-25 由用户本人完成并通过（三批自此刻起均判定"能玩"；记录见 `docs/reviews/F3.md` §4）——P6 当前无待办走查项**；本节复核标记均指对应日期复核；决策编号见 `docs/decisions.md` §14 的 **D-137…D-153**、**D-158…D-163**）
> 用途：跨会话续接，**本项目唯一状态源**。只记录**当前状态**与**待办**，不保留历史（历史仅可在带「历史记录」标注的小节中保留）。
> 写法约定：凡"现状"必须标明复核日期与证据；凡"计划中"必须显式标注批次（如「计划中（P6/F1–F7）」），不得与现状混写。

---

## 0. P7 在线服务与存档（D-129…D-136）—— **✅ 已交付（2026-09-19）**

> ✅ **本节原为"计划中（代码 0 行）"，2026-09-19 已全部落地**：B27–B33（存储层 / 身份档案 / 排位 / 快速对战 / HTTP·CLI 接线）全部实现并接线，`docs/reviews/B27.md`…`B33.md` 审查记录齐全。**交付实测**：`npm test` = 942 通过 / 0 失败、`npm run gate` = 9 PASS / 0 FAIL / 0 PEND、`npm run check:docs` = PASS、`npm run e2e` = 22/22、`npm run load-test -- --players 50 --deep` = 7/7 完整性断言（均 exit 0）。

- **已实现的设计文档**：`docs/systems/11-account-store.md`（账号与存档：身份鉴权 / 三配置槽 / append-only journal + 物化档案 / 异步排位双向记账 / 快速对战非对称 Elo / 回放只存引用按需重算 / 容量与数据库判据）。
- **已落地决策**：D-129 服务端持久化档案（**部分推翻 D-123**）、D-130 混合权威（段位/积分服务端、仓库仍客户端；**⚠️ "仓库仍客户端"已由 `D-159` 推翻**——仓库/物品/装配/开箱改服务端权威，见 §0.1；**段位/积分不具备竞技可信度**的结论**不变**）、D-131 配置槽规则（≤3、唯一出战、必有出战、注册即默认配置 → **D-159/D-160 起注册即建满 3 槽**：slot1 出战、slot2/3 空槽）、D-132 异步排位（保留 D-122 的 10 场 x=6；发起者同步结算 + 双向记账；防守方离线只记战绩不掉段不掉分）、D-133 积分双轨 + 非对称 Elo（0 起、上限 3000、均衡点 `R = cap×(2×胜率−1)`，**仅在未触发 `kMin/kMax` 裁剪时精确**；**下限保护会向系统注入分数**，故"全局 `ΣΔ ≤ 0`"只对公式层成立）、D-134 journal + 幂等 apply、D-135 回放只存引用 + 帧 LRU 上限 64、D-136 仅对手去重（24h 硬底线 / ≥72h 优先 / 24–72h 记 `relaxed:true`）、D-152 匹配池＝真实玩家档案（池不足回报 `shortfall`，**禁止 bot 充数**）。
- **已同步文档**：`decisions.md`（§13，只追加）、`interfaces.md`（模块 ICD/端点/D 落点/日志事件/环境变量/错误码）、`server.md`（进程模型/环境变量/端点/状态码/CLI/runtime 目录 —— **2026-09-19 已由"计划中"改为"现状"**；**2026-09-22 又按 `D-159`…`D-162` 更新为服务端权威仓库 + AI 库 + 开箱 seed 收归服务端**，见 §0.1）、`systems/10-ranked.md`（档案驱动，删 `BOT_LD`）、`systems/11-account-store.md`、`tasks.md`（P7 批次勾选 + MS7）、`.gitignore`（`runtime/`）、`security-backlog.md`（SEC-01/SEC-03/SEC-22 处置回填；**2026-09-22：SEC-07 回填已处置 + 新增 SEC-31**）。
- **仍待办（P6）**：**前端设计已重启并落地 `F1`（登录与注册）/`F2`（账号与管理面板）/`F3`（主界面/仓库/开箱/设置/出战配置编辑器）三批，且三批的浏览器人工走查已于 2026-09-25 通过 ⇒ 均可判定"能玩"** —— 规则总纲 `docs/frontend/00-rules.md` + 分册 `01-auth.md`/`02-accounts.md`/`03-hub-warehouse-loadout.md`；实现 = `public/**`（零依赖双模模块，**恰好 9 文件**）+ `server/index.js` 的 `public/` 只读静态托管；机器核对 = `tests/frontend/*.test.js`（89 用例）；审查与走查记录 = `docs/reviews/F1.md`/`F2.md`/`F3.md`。**旧稿**（`frontend-spec.md`/`screens.md`/自检器/样本）已于 2026-09-20 **全量作废并删除**；**剩余屏幕**（快速对战 / 锦标赛·排位 / 排行榜 / 战绩·回放 / AI 编辑器）待按新规则逐批设计（4 个空页已在界面上占位，批次标签见 `public/format.js` 的 `EMPTY_PAGES`）。
- **容量结论（实测）**：单场战斗 0.175~0.280 ms、**回放帧实测 61–268 KB/场（17–63 tick，≈2.7–3.5 KB/帧；旧口径 7.0~20.5 KB 偏小约一个数量级，2026-09-16 修正）**、索引 ~200 B/玩家 → **单进程 JSON 存储在 1 万玩家量级绰绰有余，暂不需要数据库**；>5 万玩家或写 QPS >500 时切 `node:sqlite` 适配器（`11-account-store.md` §11.4）。**D-159 补充**：仓库每桶上限 500（单玩家仓库正文约 1 MB 量级）且含状态量记录的 journal 段不参与压缩，容量判据需按此重估（`11-account-store.md` §11.2.1）。
- **D-159 暴露的既有缺陷（未修，已登记）**：`server/core/effects.js` 的 effect uid 为**进程级自增**，使"归档回放重算的帧逐字节一致"（D-90/D-91 的可复现性口径）只成立到"除 `eff_N` 外逐字节一致"；旧默认配置无持续效果词条故未暴露，starter 带 `castEffect`/`hitEffect` 后暴露（`tests/api/api-replay-auth.test.js` 的 RP-3/RP-8 现按"uid 抹平 + 首现序重编号"断言）。修法建议见 `docs/frontend/03-hub-warehouse-loadout.md` §15.4 N-7（改 uid 为按对局确定 + 重锚黄金战斗）。
- **已修正的口径漂移（2026-09-19）**：`pool.ttlDays` 与 `dailyBattleLimit` 均为"参数已留、**无消费方**"；`relaxed`/`invalids` **已落** `ranked.battle`；`nextSince` → `latestSeq`；§8.3 积分上界为 `kBase`(32)/`kMax`(64)（旧文"Δ ≤ 16"是错的，曾导致合法败局误报）。

---

## 0.1 F3 后端契约 ①（`D-159`…`D-162`）—— **✅ 已交付（2026-09-22）**
> **本次未新增批次号**（F3 不是编号批次，见 `docs/frontend/00-rules.md` FR-6）：`docs/tasks.md`/`docs/progress.md` 的"**共 41 批**"**保持不变**（P0–P5 的 34 + P7/B27–B33 的 7）。本节记录的是 `docs/frontend/03-hub-warehouse-loadout.md` §14 的**提交①（后端契约）**；该分册的提交②（主界面线）/③（出战配置编辑器）**尚未开始**。

- **实现范围（`D-159` 仓库改服务端权威，推翻 D-130）**：新文件 `server/starter.js`（注册即发 starter，种子 = `sha256('starter|publicId|playerId')` 前 8 hex → **同身份内容级可复现**；1 角色 `role_bal`/common **必带 ≥1 插槽** + 3 技能（重掷至至少 1 个有槽）+ 1~2 角色插件 + 1 技能插件，**按实际槽类型筛池并已装配**）；档案新增 `warehouse` 四桶（**每桶 500**）与 `ai` 段，`ARCHIVE_VERSION` 1 → 2、`migrateV1toV2` 补**空**仓库（**老账号保持空仓**，需删号重注册）；`GET /me/warehouse` 为**真源**（`buckets/usage/caps/counts/starterIssued`，`usage[uid].slotIds[]` 可多配置引用），新增 `POST /me/warehouse/assemble|disassemble`（**服务端态**，校验由 `core/items` 纯函数单点完成，落 journal 增量记录），`PUT /me/warehouse` **退役**为"只校验形状"（引用不覆盖出战配置不再 409 → 200 + `verified:false`）；注册建满 **3 槽**（`slot2`/`slot3` 空槽无快照）。
- **`D-160` 配置完整性校验时机**：`PUT /me/configs/:slotId` 对**非出战槽允许不完整**（200 + `snapshot:null`/`complete:false`/`missing:[…]`，正文随 journal 落盘）；**出战槽**要求完整（角色 + 恰 3 技能 + AI，允许插槽为空）→ 否则 409 `loadout_invalid`（逐位置 details）；`POST /me/configs/:slotId/activate` **此时**才校验 → 不完整 409 `cannot_activate_incomplete`；完整但缺快照会**自愈冻结**（不再 `no_active_config`）；`POST /me/configs` 改为**创建空槽**。
- **`D-161` AI 库（本批仅后端，前端只用列表）**：`GET /me/ai` → `{items,count,max:100,usage}`；`POST /me/ai {name,program}`（名称 1~24 字符；`program.type='program'`）→ `{aiId,ai,count,max}`，**上限 100 与物品分别计数**（满 → 409 `ai_limit`）；`DELETE /me/ai/:aiId` → `{deleted,referencedBy,count,max}`，**被「出战配置」引用 → 409 `ai_in_use`**（非出战配置引用只在 `referencedBy` 提示）。
- **`D-162` 开箱随机性收归服务端（修订 T-AP-5）**：`POST /box`（遗留无状态、**不入档**）与 `POST /me/box`（**新增服务端权威**：物品入档，回带 `{seed,tier,times,items,counts,caps,grantId}`；任一桶超限 → 409 `warehouse_full` 且**不入档**）**都没有 `seed` 入参**——客户端传了**静默忽略**（不再有 `bad_seed`）；seed 一律服务端生成，HTTP 侧确定性由**实例级注入缝 `start({boxSeed})`** 提供（第 n 次 = `boxSeed+n−1`），进程内 `server/box.js` 的 `openBoxes({seed})` 保留（离线 `npm run play`/`demo`/核心单测不受影响）；CLI `box` **移除 `--seed`**（给了即参数错误 exit 2）。
- **机制细节**：journal 新增 `box.opened`（`grantId = bx_<sha256[0..16]>`，幂等靠 `warehouse.grantIds` 环形窗口 **256**）、`warehouse.assemble`/`warehouse.disassemble`（增量：目标 uid + 槽位下标 + 插件 uid）、`ai.created`/`ai.deleted`；`account.created` 可携带 `warehouse`/`slots`（多槽）/`aiLibrary`；**含状态量记录的 journal 段不参与 compact**（`NON_COMPACTABLE`，记 `store.journal.compact.skip`，真源始终在 journal，检查点里的 `warehouse`/`ai` 只作兜底）。新增 HTTP 错误码 `warehouse_full`/`cannot_activate_incomplete`/`ai_limit`/`ai_in_use`/`item_missing`/`slot_type_mismatch`/`slot_occupied`/`points_exceeded`/`plugin_equipped`（409）与 `slot_empty`/`plugin_missing`（404）。`server/data/service-config.json` 新增 `warehouse:{maxPerBucket:500}` 与 `ai:{maxPerPlayer:100}`（`SERVICE_CONFIG_FROZEN` + 跨字段校验；`server/store/config.js` 同值默认 + 超表兜底）；`scripts/check-arch.js` 的 `LAYER_RULES` 新增 `starter` 到 **L6**。
- **新增用例（30 条）**：`tests/unit/starter.test.js`(7) + `tests/api/api-me-warehouse.test.js`(6) + `tests/api/api-me-box.test.js`(5) + `tests/api/api-me-ai.test.js`(6) + `tests/api/api-configs-incomplete.test.js`(6)；`tests/contract/store-contract.test.js` 的适配器方法清单新增 **6 个方法**（`getWarehouse`/`grantBox`/`applyWarehouseChange`/`listAi`/`createAi`/`deleteAi`）。
- **文档同步**：`docs/server.md`（§1 进程模型 + starter / §2 service-config 与 `start({boxSeed})` / §3.3 新端点组与 `me/configs*`、`PUT /me/warehouse`、`box` 语义更新 / §4 错误码 / §5 端点示例 / §6.1–6.2 服务端权威与 D-162 / §7 CLI / §9–§11）、`docs/security-backlog.md`（SEC-07 回填「已处置（2026-09-22，D-159）」+ 新增 **SEC-31**（`DL_ADMIN_USERS` 按用户名匹配 → 抢注即管理员，record-only））、`docs/frontend/03-hub-warehouse-loadout.md`（F3 唯一实现依据）、`docs/decisions.md`/`docs/interfaces.md`（`D-159`…`D-162` 与端点/错误码/D 落点，由对应负责批次同步）。
- **交付实测**：`node scripts/check-docs.js` = **PASS**（批次计数仍 **41**、勾选 41/41、审查记录 41/41、文档引用的脚本/数据表全部存在）；`scripts/check-arch.js` 分层规则已含 `starter`（L6）。
- **独立审查（提交①，2026-09-24 完成）**：新上下文子代理**只读对抗式审查**（探针在系统临时目录，仓库零改动）→ 结论「未发现高危；2 条真缺陷（1 中 1 低）+ 4 条疑似/含糊；核心链路实测全部成立」。**已闭环**：F-1（`createPlayerArchive` 显式 loadout 路径丢弃入参 `warehouse` → 校验镜像 ≠ 落档镜像、引用永久悬空）已修；F-2（`box.opened` 防御分支静默丢弃超限物品 → journal 与档案永久漂移）已修为逐件 `error` + `dropped` 入 `grantIds` 条目；疑似1（直接替换槽位未复位旧插件 `equipped`）已加固。**新增回归网** `tests/unit/warehouse-invariants.test.js`（WI-1…WI-5，含 **300 次开箱溢出 grantIds(256) 后重建不丢不翻倍**、同槽并发装配的"引用 ↔ equipped"不变量）。**登记待决**：N-9（L6 "读→校验→写"非原子，终态自洽）、N-10（**桶满 500 后无删除/分解端点 → 产品级待决**）、N-11（v1 老账号配置存不回，details 可判定）。审查记录与逐条处置见 `docs/reviews/F3.md` §3.2/§3.4。
- **待办（本批之后）**：① ~~**F1/F2/F3 的浏览器人工走查尚未执行**~~ → **✅ 已于 2026-09-25 由用户本人在真实浏览器完成并通过**（`docs/reviews/F3.md` §4）⇒ `F1`/`F2`/`F3` 均判定"能玩"；② ~~**前端 F3 三屏 + 出战配置编辑器尚未实现**~~ → **已由 §0.2/§0.3 交付**；③ 老账号无 starter，验收需删号重注册（用户裁定，分册 K-11）；④ **N-10 待你拍板**：桶满 500 后是否需要"删除/分解物品"能力（**同时解锁 R-20 的重估**）。

---

## 0.2 F3 提交② 前端主界面线 —— **✅ 已交付（2026-09-24）**

> 设计依据：`docs/frontend/03-hub-warehouse-loadout.md`；实现对账见该分册 **§15.6**；审查/登记项见 `docs/reviews/F3.md` §6。

- **屏与落点**：新增 `hub`（主界面）/`profile`（F1 `home` 降级）/`warehouse`/`box`/`settings` + 4 个空页（`quick`/`tournament`/`leaderboard`/`ai-editor`）；**登录/注册/启动自检的落点改为 `hub`**（FR-11）；**`logout` 只在设置屏**；`public/` **仍恰好 9 个文件**（UI-1）。
- **动作**：注册表 **42**（F1 9 + F2 16 + 提交② 17）；非管理员态渲染 **26**（= 42 − 16 管理动作，UI-2 按实际注册表双向核对）；提交③ 的 9 个编辑器动作**未注册空壳**。
- **弹窗**：屏内区块 + `data-action="modal-close"` 背景（点外面 = 取消并丢弃未提交输入）+ 显式「关闭」；至多一个（FR-10）。
- **字段契约**：`contract.js` 新增 9 条信封路径（全部来自**真起服务的实测抓取**）+ 34 条物品详情子路径；另立「明确不读」4 条并纳入 FC-3/FC-4 双向核对。
- **一个规格修正**：进入开箱屏时**静默取一次 `GET /me/warehouse`**、开箱成功后静默刷新 —— 否则"满仓按钮禁用且不发请求"无法本地判定（分册 §3.4 已同步）。
- **收口实跑（2026-09-24）**：前端 `tests/frontend/*` = **73/73**；`npm test` = **1042 通过 / 0 失败**；`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**；`check-docs`/`check-arch` PASS。
- **去 flaky**：`api-ranked` P2-5 与新增的 `api-me-warehouse` UWH-3/4/7 原依赖"随机 starter/开箱掉落"里的匹配组合 → 分别改为**固定 `publicId`+`playerId`** 与**注入确定性夹具**（连续多次运行恒定）。
- **待办**：① ~~浏览器人工走查（分册 §11 的 25 步 + F2 的 17 步一次收口）~~ → **✅ 已完成（2026-09-25，用户本人；`docs/reviews/F3.md` §4）**；② ~~提交③ 出战配置编辑器~~ → **已由 §0.3 交付（2026-09-25）**；③ N-10 产品级待决（桶满解封，同时解锁 R-20 重估）。

---

## 0.3 F3 提交③ 出战配置编辑器 —— **✅ 已交付（2026-09-25）**

> 设计依据：`docs/frontend/03-hub-warehouse-loadout.md` §3.7/§3.8/§4/§5；实现对账见该分册 **§15.7**；审查/登记项见 `docs/reviews/F3.md` §7。

- **两级弹窗**：弹窗 A = 编辑器（逐位置：角色模板 / 角色插槽**按实际数量与类型** / 技能1–3 及其插槽 / 战斗AI；**每个位置都是可点按钮，`空` 也可点**）；弹窗 B = 三个候选弹窗（`slot-pick` 同分类 + `空`；`plugin-pick` **全部列出**、类型不符 → 置灰 + 行内写明原因；`ai-pick` 取 AI 库条目）。复用提交② 的弹窗机制，仍**至多一个** `state.modal`。
- **动作**：注册表 **51**（F1 9 + F2 16 + 提交② 17 + 提交③ 9：`config-save`/`config-activate`/`slot-pick`/`slot-set`/`ai-pick`/`ai-set`/`plugin-pick`/`plugin-set`/`plugin-clear`）；非管理员态渲染 **35**（= 51 − 16 管理动作）。父代理用**独立探针**复算：注册表 51、非管理 35、渲染集合 ↔ 注册表**双向相等**、管理动作零泄漏、无死动作。
- **⚠️ 两步顺序（本批最容易错的点）**：`plugin-set`/`plugin-clear` = ① 调装配/拆卸端点（改的是**仓库里那件物品**）→ ② 用响应回带的 `data.warehouse` 取回**更新后的那件物品**替换草稿 → ③ 用户点「保存」才 `PUT /me/configs/:slotId`。只做① = 界面看着换了、保存后没换。最终证据 `CF-3`：保存后 `GET /me/configs` 的插槽引用**真的变了**（`CF-9` 在 DOM 层再造一次）。
- **草稿语义**：所有编辑先落本地 `state.configs.draft`；`关闭/点背景` 一律关弹窗 + 丢弃草稿；`dirty` 时点「设为出战」被本地前置拦下并提示先保存（**偏差，待裁定 → N-13**）。
- **字段契约**：`contract.js` 新增 `me/configs` 两行 + `me/warehouse/assemble` 三行（`data.warehouse` 从「明确不读」移入正式契约）+ `CONFIG_SLOT_FIELDS`/`AI_ITEM_FIELDS`；`data.maxSlots`/`data.caps.max` 留「不读」并写明理由。完整性判据前端镜像 `format.missingOf` 与服务端 `archive.loadoutMissingOf` **逐规则 + 逐字**一致（漂移风险登记为 **N-14**）。
- **本批真缺陷（3 条，均已修）**：① 父代理自查 —— `format.js` 三个**玩家可见** `hint` 混入 Markdown `**`（本 UI 无 Markdown 渲染器 → 玩家会看到 `**草稿**`）；② 独立审查 **F-1** —— 取消弹窗会被 in-flight 响应撤销（弹窗复活 + 草稿已丢弃 ⇒ 界面/提示/仓库三方矛盾）→ 新增条件 reducer `modal.setIfOpen` + 回归 CF-11；③ 独立审查 **F-2** —— `loadout.aiId` 未登记进字段契约、"三方一致"断言**单向**（直接属性访问不进 `pick()` 集合）⇒ 字段漂移可让"删除出战配置正在引用的 AI"静默放行 → 新增 `CONFIG_LOADOUT_FIELDS` + CF-8 源码级双向断言。**前一批遗留的测试盲区（1 条）**：`render.js` 的 `esc()` 此前无任何测试钉住 → 新增 `tests/frontend/render-escaping.test.js`（ESC-1…ESC-5；含**真实 HTTP 证明服务端不消毒**昵称/AI 名 → 转义是唯一防线）。
- **收口实跑（2026-09-25，父代理独立复跑 + 独立审查者复跑）**：`tests/frontend/*` = **89/89**；`npm test` = **1058 通过 / 0 失败**（连跑两轮一致）；`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**（digest `a1c5b11c0092`）；`check-docs` = PASS（批次仍 **41**）/ `check-arch` = PASS（**40** 文件）；`npm run e2e` = **22/22 exit 0**；`config-editor-flow` 连跑 **5×11/11**（无 flaky）。**独立审查**（新上下文只读子代理）= 「有条件通过」→ 2 条需修已修（**F-1** 取消弹窗被 in-flight 响应撤销 → 新增条件 reducer `modal.setIfOpen` + 回归 CF-11；**F-2** `loadout.aiId` 未登记进契约且断言单向 → 新增 `CONFIG_LOADOUT_FIELDS` + CF-8 源码级双向断言），另有 3 疑似/3 记录逐条处置（见分册 §15.7 与 `docs/reviews/F3.md` §7.5）。
- **待办**：① ~~**浏览器人工走查**（分册 §11 步 10–21）——未走查前 `F3` 不得判定"能玩"~~ → **✅ 已完成（2026-09-25，用户本人；三批一次收口 PASS，`docs/reviews/F3.md` §4）**；② 待裁定：**N-12**（二级弹窗关闭丢弃整个草稿）、**N-13**（`activate` 先保存前置）、**N-10**（桶满 500 无删除/分解）、**N-11**（v1 老账号配置存不回）；③ 已登记未修：**N-7**（effect uid 进程级自增 → 回放帧"除 `eff_N` 外"逐字节一致）、**N-9**（L6 读→校验→写非原子）、**N-14**（完整性判据双份实现）、**N-15**（`public/**` 不在覆盖率门禁四目录内 → 新代码行覆盖 ~93–99% 但分支最低 53%）。

---

## 0.4 D-163 热修（2026-09-25）—— 用户实测报告触发的三个真缺陷 —— **✅ 已交付**

> 触发：用户走查后报告「同一个物品能被重复装配；被标记为已装配的物品无法被继续装配，直到被拆卸或替换下来」。按 00-rules §2 先复现（真实 HTTP + 真实服务端模块），**确认报告并查出另外两个更严重的缺陷**。规则落地见 `decisions.md` **D-163**，实现对账见 `docs/frontend/03-hub-warehouse-loadout.md` **§15.8**，审查与登记见 `docs/reviews/F3.md` §8。

- **① 同配置内重复占位（用户报告的那条）**：`loadout.js` 原来只查"插件被双处引用"，不含模板物品 uid ⇒ 同一件**无插件**的技能物品可占满同一份配置的 3 个技能位（连**出战槽**都 200）。**已修**：`resolveItems` 对 角色 + 3 技能 + 全部插件引用做全 uid 去重；`skills.length > 3` 直接 409。
- **② P0 作弊面（连带查出）**：`PUT /me/configs/:slotId` 接受客户端任意 `stats`（实测 `hp=100000/atk=99999`）甚至**仓库里不存在的 uid** → 200；`activate` → 200；快照冻结该正文，而 `quick/ranked` 用 `snapshot.loadout`（`battle.buildPlayer` 直接读 `role.stats`）⇒ **真实对局可被打穿**。**已修**：保存/创建/激活按 uid 从**服务端仓库**解析物品（客户端数值丢弃、未知 uid → 409 `物品不在仓库`）；`buildPanel` 有仓库时同样先解析（历史遗留的被篡改快照也失效）；HTTP 配置路由**不再采纳**客户端 `warehouse` 镜像（修前 `warehouseForValidation` 优先返回它 ⇒ 自带 buff 镜像即可绕过）。**登记册更正**：`SEC-07` 的"已处置（D-159）"改为"`D-159` 未覆盖 `/me/configs`，由 `D-163` 关闭"。
- **③ 开箱静默丢件（连带查出）**：uid 由 `core/items.js` 的**进程级**计数器生成、重启归零 ⇒ 跨重启发放撞 uid；apply 分支静默 `continue`。两进程实测：重启后开箱 12 件 → 档案只落 **2** 件、**10 件无声消失、日志 0 条**，前端却提示"物品已直接入服务端仓库"。**已修**：`grantBox` 写 journal 前重映射撞车 uid（**响应 = journal = 档案**）+ 闸门丢弃改 `error` 日志与 `grantIds.dropped` 审计（新增 **SEC-32**，已处置）。修复后同一探针 = **12/12 落档、0 重复 uid**。
- **④ 跨配置独占（用户 2026-09-25 裁定）**：一件物品同一时间只能被一份配置引用 → save/create/activate 三处判 → 409 **`item_in_use`**（供玩家可读文案 + details 逐 uid）。**推翻 D-159② 的"同物品可被多配置引用"**（`usage[uid].slotIds` 至多一项）。
- **⑤ 前端配套**：`slot-pick`/`plugin-pick` 把"点了必然 409"的候选**预先标灰 + 行内写原因**（`已被配置N使用…` / `本配置已在其它位置使用…` / `已被装配（请先拆卸）` / 既有类型不符）；"已装配"由已登记的 `slots[].pluginUid` 推导，不为 UI 扩大字段契约。
- **⑥ 连带修正**：`scripts/play.js` 改为**逐侧仓库**（`{p1: wh2, p2: syntheticVerifiedWarehouse(bot)}`）—— 否则 D-163 的解析规则会把 `npm run play` 打坏；`ranked.syntheticVerifiedWarehouse` 补上"角色与技能也在其中"。
- **⑦ 测试**：新增/改写覆盖上列各条（API/单元/前端/e2e），并对既有 18 个文件的 fixture 按新规则重整（**只改夹具与断言口径，未删断言、未放宽强度**）；收口实跑见提交信息与 `docs/reviews/F3.md` §8。
- **⑧ 收口实跑（2026-09-25，本轮全部修复完成后）**：`npm test` = **1058 通过 / 0 失败**（两轮一致）；`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**（digest `a1c5b11c0092`）；`npm run e2e` = **22/22（exit 0）**；`npm run play` = **exit 0**（修复前被解析规则打坏）；`load-test --players 20 --deep` = **ok=true，7/7 完整性断言**；`check-docs` = PASS（批次仍 **41**）/ `check-arch` = PASS（**40** 文件）。**修复前后对照（同一探针）**：篡改数值/捏造 uid → 200/200/`maxHp=100000` **→** 409 / 服务端回落仓库真值（`maxHp` = 仓库值 + 插件词条）；同一裸技能 ×3 → 200 **→** 409；两进程重启后开箱 12 件 → 落 2 丢 10（日志 0） **→** 12/12 落档、0 重复 uid。
- **待办**：① ~~**浏览器人工走查仍需重做一遍**（编辑器候选现在会标灰，走查预期随之更新）~~ → **✅ 已完成（2026-09-25，用户本人；走查含 D-163 后的候选标灰预期，三批一次收口 PASS——`docs/reviews/F3.md` §4）**；② 修复前已落档的历史档案里可能仍有"同 uid 两件"（`findItem` 只认第一件）——建议后续在档案自检里加"四桶 uid 唯一"的不变量断言（本次未做）；③ `POST /loadout`/`POST /panel` 仍是无状态展示端点（按客户端提交返回面板，不落账）——若将来被用于记账/判定必须先堵；④ ~~`rt.loadWarehouse` 的 `covers()` 只看 `pluginUid`（D-163 后③级来源无法实例化；当前不可利用，但**一旦给物品加删除/分解（N-10）必须重估**——见 `docs/reviews/F3.md` §8.4 R-20）~~ → **✅ 已由 `D-165` 关闭（2026-09-25）**：覆盖判据改为与 `resolveItems` 同谓词（`loadout.warehouseResolves`），且注入 bot 携带真实仓库；实测 bot 对手回放由 10/10 场 410 变为可取（`tests/api/api-replay-bot.test.js` RB-1）。R-20 的重估条件仍然成立（给物品加删除/分解时需再评估）。

---

## 0.5 战斗线后端修复批（D-164…D-166）—— **🔄 进行中（2026-09-25）**

> 触发：用户 2026-09-25 就"快速对战 / 锦标赛"逐条问答后冻结规格（守方镜像 / 回放不含日志 / bot 必须是完整账号与完整 AI / 4 小时软冷却 / 胜负统一 / 管理员改段位积分 / 段位榜+积分榜）。本批**无前端**，先修后端。

- **✅ D-164 守方 AI 完整镜像（已交付）**：新增 `server/runner.js` 的 `mirrorSnapshot`/`unmirrorAction`/`makeAiDriver`（唯一实现处），`server/battle.js`（`/battle` + 回放重算）与 `server/ranked.js`（`battleOne`，排位/快速共用）改为调用它。**语义**：玩家 AI 一律按 p1 帧书写，p2 侧给它镜像快照（`x→fieldPx−x`、`facing→−facing`、`displacement→−displacement`）并把方向动作反镜像；`turn`/`wait`/`defend`/`skill:*` 不映射；内置对手 `OPPONENTS` 排除。**证据**：`tests/unit/ai-mirror.test.js` M-1…M-7（含"写死 move_right 的 AI 当守方改为迎面推进"与"默认 AI 恒等不变"两条行为锚）；实测 `永远 move_right` 当守方从"退到墙角、进攻方满血"变为"逼近至 480 并交战"。
- **✅ D-165 回放 410 修复（已交付）**：新增 `loadout.warehouseResolves`（**与 `resolveItems` 同谓词**：角色 + 3 技能 + 全部插件引用都要在库），`rt.loadWarehouse` 各来源改用它；`admin.injectDebugBots` 注入时写入**真实合成仓库**。**根因**：修前覆盖判据只看 `pluginUid` ⇒ bot 的空仓库"空转通过" ⇒ 回放重算 `resolveItems` 报 `物品不在仓库: bot_role` ⇒ **10/10 场 410**。**证据**：`tests/api/api-replay-bot.test.js` RB-1/RB-2/RB-5。
- **✅ D-166 注入 bot 多样化 + `preset`（已交付）**：每个 bot 按自身 `botKey` 派生不同预设（3 族 × 3 子变体），新增可选 `preset`（非法 → 400），响应回带 `preset`。**根因**：修前整批 bot 共用同一个 `steady/0` ⇒ 互打**恒平局**（实测 10 场 0 胜 10 平），段位晋升无法验收。**证据**：RB-3/RB-4。
- **✅ D-167 回放帧契约重构（已交付）**：引擎 `diff` 补画面字段（五维/上限/`action`/`effects`/`bases.maxHp`）+ 新增 `baseHits[]`（**修掉"同 tick 双方各撞基地只结算一侧"**）与 `damages[]`（伤害数值/暴击/背击/来源）+ `bullets[]` 升级为**完整生命周期**（`spawnX/endX/outcome/hitTarget/collideWith`）；**对外帧剥掉 `events`**（实测日志占 76–84% ⇒ 帧体量 92–219 KB → **10–21 KB/场**）；**`aiTrace` 永远双方都给**（推翻 §9.4；SEC-33 登记为已接受风险；`?trace=*` 废弃）；新增 **`GET /replay/:id?frames=debug`**（管理员：含日志 + 可越权排查 + 审计 warn）；**`quick/run` 与 `ranked/run` 响应内联全量帧**（`data.frames` / `results[].frames`；不写 `battle.REPLAYS`）并修掉 `battleOne` 不传 trace 缓冲导致内联帧 trace 恒空的缺陷。**证据**：`tests/api/api-match-frames.test.js` MF-1…MF-3（帧形状/双方 trace/无日志/体量上限/**内联帧 ≡ 归档回放帧**/伤害归因 hp 下降）、`tests/api/api-replay-auth.test.js` RP-7（重写：双方 trace + debug 需管理员 + 事件 cid 归属 + 非参与者越权审计）、`tests/api/api-battle-legacy-replay-trace.test.js` LR-1…LR-5（重写）、`tests/unit/replay.test.js`、`tests/api/api-battle.test.js`、`tests/cli/cli-replay.test.js`（CLI 回放改读 `damages`）、`.audit/replay-audit.js`（`events` 可选 + 改为**帧内结构**校验：命中链三方一致 + hp 归因 + `hp ≤ maxHp`）。
- **✅ D-168 软冷却取代 D-136 硬底线（已交付）**：新增 `opponentRecoveryHours=4`（`rating-config` + `service-config.pool` + `store/config.js` 默认 + `schema.js` 冻结值/校验；**`opponentCooldownHours` 删除**）；选择改为**加权轮盘**（`weight = clamp(已过小时/4,0,1)`；排位批次内不重复；**全员权重 0 → 取最久未打一组，永不 no_opponent**）；实现唯一处 = `server/ranked.js` 的 `cooldownWeightOf`/`pickByCooldownWeight`/`drawByCooldown`，`quickmatch` 复用；**删除** `splitByCooldown`/`COOLDOWN_RELAX_MULT`/`cooldownHoursOf` 与响应/记录里的 `relaxed`（改回带 `recoveryHours` / `opponentWeight`）。**已知代价**：薄池可刷分/刷晋升 → 登记 **SEC-34**（用户知情接受）。**证据**：T-QM-4/T-QM-4b、T-RK-4a/T-RK-4b、T-QM-R7、E2E-5（第二轮不再 0 场、被抽场次按两轮累计）、load-integrity（不再有 ceil(N/2) 上限）。
- **收口实跑（2026-09-25，D-164…D-168）**：`npm test` = **1073 通过 / 0 失败**；`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**；`check-docs` = **PASS**（批次计数仍 **41**）；`check-arch` = **PASS**（40 文件）。
- **✅ D-169 胜负口径统一（已交付）**：`POST /quick/run` 的 `data.winner` 由请求者视角 `win/loss/draw` 改为**绝对口径 `p1/p2/draw`**（与 `/ranked/run` 的 `results[].winner`、回放帧 `verdict.winner`、journal `verdict.winner` 完全一致）；**档案里每人自己的 `result` 刻意保留 `win/loss/draw`**（`stats`/`records`/Elo 输入依赖"我赢没赢"）。**证据**：`tests/api/api-quick.test.js`、`tests/unit/quickmatch.test.js`、`tests/integration/quickmatch-invariants.test.js`、`tests/api/api-replay-auth.test.js`（重算判决 ≡ 实战判决）、`scripts/e2e.js`。
- **✅ D-170 管理端改账号（已交付）**：新增 `POST /api/v1/admin/account-patch`（`{playerId|publicId, tier?, points?, inPool?, reason?}`，**至少一项**=部分更新；缺省字段不改）；落库走 journal **`account.patched`**（`buildAccountPatchRecord` → `applyRecord`），**可重放**（实测：改档 → 关服 → 同 dataDir 重启 → 值仍在）；**峰值只升不降**（`peakPoints=max(peakPoints,points)`、`peakTier` 按 `TIERS` 序取高）⇒ 无法用改档压低/伪造历史峰值；**不动战绩/仓库/装配**。**用途**：验收排位晋升、快速对战积分、段位榜时可直接造目标档位，不必反复刷局。前端面板同步「改账号（段位/积分）」按钮 + 三格输入（`public/api.js`/`actions.js`/`store.js`/`format.js`/`contract.js` 五处 + 分册 §1/§2.5/§4/§5/§11/§13），满足 **D-158⑥** 双向相等。**证据**：`tests/api/api-admin-account-patch.test.js` AP-1…AP-8（契约逐字段/部分更新/峰值只升不降/不动战绩/重启重放/参数与错误码/权限两路径/`inPool=false` 后不再被抽为对手）、`tests/contract/store-contract.test.js` CN-12、前端四个契约测试（`admin-op-parity` AP-5 / `admin-ui-contract` AU-1 / `auth-ui-contract` UI-2 / `auth-field-contract` FC-1…FC-3）。
- **✅ F6 快速对战屏（已交付，2026-09-25；零后端改动）**：分册 `docs/frontend/04-quickmatch.md`。`quick` 从空页变真屏：结果行（对手身份 / 绝对胜负 → 你赢了/你输了/平局 / 积分双向变化 / 胜率预测 / tick 数）、抽池行（窗口·冷却权重·回满小时·零和·是否重复对局）、**逐帧战斗查看器**（位置/朝向/五维/上限/行动/状态 buff/弹幕生命周期/碰撞/撞基地/伤害归因/判决，全部只读服务端结果）、**AI 逻辑查看器**弹窗（我方 AI 程序树 16 类节点全覆盖 + 本帧执行标记 + 双方轨迹；对手只给轨迹 —— SEC-33）。新增共享切片 `state.viewer`（F7 复用）与 9 个动作。机器核对：`tests/frontend/quick-battle-flow.test.js` **QB-1…QB-10**（真实 HTTP：帧与 ticks 同源、全帧无 undefined 泄漏、步进夹取与零请求、轨迹侧位同源、真实程序树+执行标记、帧字段三方一致、`AI_NODE_TYPES ≡ server/ai/ast.js NODE_TYPES`、失败路径、动作双向闭合、busy 语义）。顺带修 `docs/interfaces.md` 两处文档漂移（`verdict` 实为 `{winner, phase}`、`aiTrace` 是**扁平数组**）与 `/quick/run` 错误码（404 `store_not_found` + 409 `loadout_invalid`）。**未完成项：浏览器人工走查**（§11 的 12 步）→ 待用户执行，记录落 `docs/reviews/F6.md`。
- **下一步**：F7 锦标赛屏（10 场分页）+ 段位榜/积分榜（分页 + 自己名次；**需 D-171 后端契约扩展**）。

---

## 1. 文档体系（权威链）

```
docs/decisions.md      决策记录（**D-01…D-153**；D-129…D-136 与 D-137…D-153 均已落地；**D-158…D-163** 见 §14.3；**D-164…D-170** 见 §14.4–§14.8）  ← 最高权威
docs/systems/01~10.md  各系统实现细则（`11-account-store.md` 为**已实现（P7/B27–B33，2026-09-19）**的账号与存档权威设计）
docs/v3-design.md      主设计文档（架构/数据模型/数值）
docs/items-data.md     物品数值、名称、贴图占位
docs/interfaces.md     接口冻结（ICD v1：模块/API/CLI/数据结构/D 落点）
docs/server.md         服务器文档（部署、端点速查、信封与错误码、**单进程 + 服务端权威档案与仓库**（`D-159` 起）：runtime 数据根 / journal / 快照库 / 回放 LRU）
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
| 在线服务 | **✅ 已实现（P7/B27–B33，2026-09-19）**：服务端存档（段位/积分/配置槽≤3/战绩；`runtime/` + journal + 快照库）；**仓库也由服务端权威（`D-159`，2026-09-22：推翻 D-130 的"仓库仍客户端"——四桶 ≤500 + AI 库 ≤100 + 注册即发 starter + 真源 `GET /me/warehouse`）**；异步排位双向记账（防守方离线只记战绩）；快速对战非对称 Elo（0 起/上限 3000，与段位双轨）；回放只存引用按需重算 | **D-129~D-136**、**D-159~D-162** |
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
- ~~前端文档 v3 重设计（2026-09-15）~~ **全量作废（2026-09-20，用户决策：前端完全重新设计，旧稿清理干净以防影响）**：`docs/frontend-spec.md`（v3）、`docs/screens.md`、`scripts/fe-spec-check.js`、`tests/frontend/*`、`.audit/fe-samples.*` 均已从仓库删除。前两轮实现失败根因（坐标注入缺失 / Blockly 方言 / 死按钮 / 字段错读）仅作为**历史教训**保留在其审查记录与 `docs/reviews/` 中，**不得再作为实现依据**。
- [ ] **P6 前端（重新设计 + 实现）**：旧 v3 设计已作废（见上一条）。新设计须**先冻结到文档**（屏幕清单 / 按钮↔动作白名单 / 字段来源契约）再写代码；**每批收口必须在真实浏览器按端到端剧本人工验收**（不得以 `npm test` 绿作为"能玩"的证据 —— 两轮失败均发生在测试全绿时）。后端配合项：静态托管（`public/`、`/shared`、`/assets`）。
  - [x] **F1 登录与注册（2026-09-20）**：规则总纲 `docs/frontend/00-rules.md`（FR-1…FR-8）+ 分册 `docs/frontend/01-auth.md` 冻结 → 实现 `public/**`（index.html / store / format / render / actions / api / app / boot / contract）→ `server/index.js` 同源静态托管（仅 GET + 扩展名白名单 + 穿越防护）→ 机器核对 `tests/frontend/{auth-field-contract,auth-ui-contract,auth-flow,static-hosting}.test.js`（35 用例：字段三重一致 / 按钮永不无声双向 / 真实 HTTP 全流程 / 托管契约与回归）→ 审查与走查记录 `docs/reviews/F1.md`。**范围**：`/auth/register|login|logout|password` + `GET /me`；「忘记密码」显式登记为本轮不做（后端无该端点）。**走查**：✅ **已通过（2026-09-25，用户本人在真实浏览器执行；`docs/reviews/F1.md` §4）⇒ `F1` 判定"能玩"**。
  - [ ] **F2+**：其余屏幕（快速对战 / 锦标赛·排位 / 排行榜 / 战绩·回放 / AI 编辑器）按 `00-rules.md` §2 协议逐批设计（**一批一轮**）。**已完成**：`F1`/`F2`/`F3` 三批（含走查通过）。
  - [x] **F3 后端契约 ①（2026-09-22，`D-159`…`D-162`，非编号批次）**：设计冻结 `docs/frontend/03-hub-warehouse-loadout.md`（主界面/用户/仓库/开箱/设置/出战配置；含 §14 三提交计划）。**本批只做提交①（后端契约）**：仓库改**服务端权威**（`warehouse` 四桶 ≤500 + `ai` 库 ≤100；`ARCHIVE_VERSION` 1→2；`GET /me/warehouse` 为真源；新增 `/me/warehouse/assemble|disassemble`；`PUT /me/warehouse` 退役）、**注册即发 starter**（新文件 `server/starter.js`；3 槽初始形态）、**D-160** 配置完整性校验时机（非出战槽可存半成品 / `activate` 才校验 / `POST /me/configs` 建空槽）、**D-161** AI 库后端（`/me/ai*`）、**D-162** 开箱 seed 收归服务端（`start({boxSeed})` 注入缝；CLI `box` 移除 `--seed`）。**新增 30 条用例**（`tests/unit/starter.test.js` 7 + `tests/api/api-me-{warehouse,box,ai}.test.js` 6/5/6 + `tests/api/api-configs-incomplete.test.js` 6）+ 契约适配器方法清单 +6。**收口实跑（2026-09-22）**：`node scripts/check-docs.js` = **PASS**（批次计数仍 **41**）。**待办**：① ~~F1/F2/F3 的**浏览器人工走查尚未执行**（F3 剧本 = 分册 §11 的 25 步 + F2 的 17 步）~~ → **✅ 已完成（2026-09-25，用户本人；三批一次收口 PASS，`docs/reviews/F3.md` §4）**；② ~~前端 F3 三屏 + 出战配置编辑器（提交②/③）尚未实现~~ → **已交付**（提交② = §0.2／提交③ = §0.3）；③ 老账号无 starter（验收需删号重注册）。详见 §0.1。
  - [ ] **F1 现场故障修复（2026-09-22）**：用户报"test01/12345678 登录报用户名或密码错误"。查证 = 服务端数据无误（四种密码形态对照：半角 8 位 200；7 位 / 全角 / 末尾空格均 401）；根因是**密码框残留旧值使下次输入变"追加"**等前端缺陷。已修：业务失败清空密码类输入（保留用户名）、用户名 `trim()`、`invalid_credentials` 增可排查指引、新增 FL-12/FL-13/FL-14 回归（`docs/reviews/F1.md` §2.5）。
  - [x] **F1 假红根因（2026-09-22）**：`tests/cli/cli.test.js` 的 CLI-13 原依赖"3000 端口空闲"——按文档跑 `npm start` 时 CLI 会真的连上开发服务 → 断言 rc 1 失败（表现为 gate 偶发红）。已修为"端口被占用则改用临时端口 + diagnostic"，`npm start` 挂着时实测通过（`docs/reviews/F1.md` R-7）。
  - [x] **F2 账号管理与管理员面板（2026-09-22）**：设计冻结 `docs/frontend/02-accounts.md`（含 §13 实现对账）+ `decisions.md` **D-158**（`DL_ADMIN_USERS` 白名单 / 账号优先·令牌回落的访问判定 / 新增 `POST /admin/accounts`（分页、**total 无上限**）与 `POST /admin/delete-account`（`player.removed` 墓碑、禁删自己）/ admin 面豁免玩家级 `playerId` 一致性检查）。**机器核对**：`tests/api/api-admin-accounts.test.js`（AA-1…AA-7）+ `tests/frontend/{admin-op-parity,admin-ui-contract,admin-flow}.test.js`（AP 5 / AU 8 / AF 9，含**后端 admin 能力 ↔ 前端面板双向相等**、**106 账号分页无重复无遗漏**、删除二次确认与 409 禁删自己）+ F1 的 FC/UI 同步扩展。**收口实跑（2026-09-22）**：`npm test` = **987 通过 / 0 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、`check-docs` = PASS。**待办**：浏览器人工走查（`02-accounts.md` §11 的 17 步）→ ✅ **已通过（2026-09-25，用户本人；`docs/reviews/F2.md` §4）⇒ `F2` 计入"可玩"**；证据与登记项见 `docs/reviews/F2.md`。
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
> · 本波代码落地时曾实测 `npm test` = 505 通过 / 0 失败、`npm run gate` = 9 PASS / 0 FAIL / 0 PEND、`npm run check:docs` = PASS。
> · **最近一次复测（2026-09-16；仓库处于 P7 多线并行状态——**用例数与红项每轮在途改动都在变，以你实测的当次输出为准**）**：`npm test` = **683 用例 / 680 通过 / 3 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、`npm run check:docs` = **PASS**；D 落点相关 `tests/integration/interfaces.test.js` = **6/6 绿**、`tests/api/api-ai.test.js`（含本轮新增的"快照不含 bullets"防回归断言）= **10/10 绿**，**项 5 文档↔数据一致性 + D 编号落点 = PASS（含 D-137…D-153 落点）**。
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
- [x] **P7-2/P7-3/P7-4/P7-5/P7-6/P7-7（2026-09-19 全部交付）**：身份与会话（`auth.js`：并发注册闭合 / `session_expired` / 启动 prune + 读时懒清理）、排位与快速对战（**去占位 bot + `shortfall`**、D-136 去重窗口裁定、双向记账、Elo 可复算与积分守恒）、HTTP·CLI 接线（Bearer/401/403/409/410/429、`DL_*` 五个变量、回放 LRU 64 + 410、CLI 退出码 3、`readBody` → 413）、P7-5 全链路 e2e（`npm run e2e` 22/22）、P7-6 批量测试（`npm run load-test`，真实玩家 + 7 条完整性断言）、P7-7 测试体系冗余与缺口审查（`docs/reviews/P7-7-test-audit.md`、`docs/reviews/P7-7-wave2-code-review-residual.md`）。**实测**：`npm test` = 942 通过 / 0 失败、`npm run gate` = 9 PASS / 0 FAIL / 0 PEND、`check-docs` PASS。
- [x] **`POST /quick/run` 抽池/实例化可用性口径不一致 —— 已修复（2026-09-19，D-157）**：原症状为"发起者带装配引用 + 抽到默认配置对手 + 进程内仓库镜像缓存缺失 → `409 no_opponent`"。修法：新增 `ranked.sideInstantiable(loadout, warehouse, tier)`（用与 `battleOne` **同一实现**的 `battle.buildPlayer` 证明"真的能实例化"），**抽池与实例化共用该判定**——`server/quickmatch.js` 的 `candidatePool`（带装配引用的候选不可实例化 → `skipped.notInstantiable`、不入池）与 `requireArchive`/`run`（发起者侧同样先判，失败给可解释错误码）两处一致；回归用例 `tests/unit/quickmatch-availability.test.js`。**仍不得注入 bot**（D-152）；匹配池的硬性要求见 `docs/systems/10-ranked.md` §4.3。

---

## 4. 关键约定（避免走弯路）

1. **改中文文档禁止用 PowerShell 5.1 的 `Get-Content`/`Set-Content`**（会造成双重编码损坏）；用文件工具或 Node（UTF-8 无 BOM）。
2. **数值必须机器复算**：示例/走查/测试断言里的每个数字都要有独立可复跑的机器计算验证（脚本或测试内的计算），不靠手算；冻结常量注明复算方式。
3. **机制在代码、数值在表**：所有战斗数值来自 `battle-config.json` 等数据表。
4. **计算与文档分工**：分支穷举在 `examples/`，端到端串联在 `battle-walkthrough.md`，实现细则在 `systems/`。
5. **分支现状（2026-09-19 复核）**：`main` 是唯一主线（合流已完成）；**`dev` 分支已不存在**。现存分支仅 `main` / `deepseek-v4.1f` / `glm-5.3f`（后两个为前端实验分支，未合并）。下文 §5.1 L-5、§5.2 中凡以 `dev` 为对象的表述均已失效，仅作历史记录保留。⚠ **门禁现状（2026-09-19 最后实测）**：`npm test` = **942 通过 / 0 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、`npm run check:docs` = **PASS**、`npm run e2e` = **22/22**、`npm run load-test -- --players 50 --deep` = **7/7 完整性断言**；P7 已收口，此前的在途红项（`PS-1`/`PS-2`/`PS-4` 等持久化用例）已全部转绿（见 §3.4）。

---

## 5. 遗留问题审查（本节为 **2026-09-12 历史记录**；行内补充的「现状」列均为 2026-09-16 复核）

### 5.1 质量类（建议 B22 前处理）

| # | 问题 | 证据 | 建议处置 |
|---|---|---|---|
| L-1 | **偶发 flake：gate 项 7 有约 1/7 概率 2 个用例失败** | 首跑（B21 时期）`[FAIL] 项7 … 2 个用例失败（总 420）`；随后 6 次（npm test / npm run cov / gate×2 / 独立进程×4）全部 420/0。**未定位到具体用例** | B22 批内加"连续 5 次全量复跑全绿"回归并定位根因（疑：order/时序/端口类用例）。**现状（2026-09-16 实测）：`npm test` = 484 通过 / 0 失败，未复现该 flake；根因仍未定位，仍属观察项** |
| L-2 | **走查文档与真实引擎黄金战斗不一致** | `battle-walkthrough.md` §3.1 为设计期轨迹 **17 tick / P1 胜**；`.audit/golden-battle.json`（gate 项 8 在用）为 **18 tick / P2 胜**（seed 20260912） | 按真实引擎输出重生成走查 §3.1 轨迹表（或以 golden-battle.json 为准并标注），消除文档漂移。**现状（2026-09-16 复核）：✅ 已完全处理**——§3.1 已按真实引擎重算为 **18 tick / p2 胜**（复算 `node .audit/walkthrough.js`，与 `.audit/golden-battle.json` 逐字段一致）；**`tests/regression/golden-battle.test.js` 亦已于 2026-09-16 落地**（见 §3.1/§3.4），本条关闭 |
| L-3 | **临时审查目录被提交**：探针脚本已入库 | 记录时 `git ls-files ".review-*"` = **24**（`.review-b16..b20`）；审查结论另有 `docs/reviews/`。**现状（2026-09-16 复核，实测）：`git ls-files ".review-*"` = 53**（**以 53 为准，24 为旧记录**），分布在 `.review-b16/b17/b18/b19/b20/b22/b23/b24/b25`（覆盖全部后端批次，b21 无独立目录）；`docs/reviews/` = 34 文件 | 移出追踪 + 追加 `.gitignore`；若需保留探针则归入 `tools/scratch/` 并说明。**现状（2026-09-16 已清理）：`.gitignore` 已增 `.review-*/`，`git ls-files ".review-*"` = 0；53 个文件保留在磁盘但不再被追踪；清理提交见 `1b74e3f`** |
| L-4 | **设计期临时校验器残留**：`.audit/verify-rest.js` 等 | 约定"验完即删"；`.audit/golden-battle.js/json` 为 gate 项 8 依赖**必须保留** | 删除已无用的 verify-* 临时脚本；保留 golden-battle.*；`.audit/.v8cov*` 确认是否入库，若是则移出。**现状（2026-09-16 执行）：`.audit/verify-rest.js` 已删除**（全仓零引用）；`.audit/golden-battle.*`、`.audit/walkthrough.*`、`.audit/replay-audit.js` 为 gate/审计依据，保留（`.audit/fe-samples.*` 已于 2026-09-20 随前端设计一并删除） |
| L-5 | **`main` 落后 `dev` 32 个提交**，无合流检查清单 | 记录时 `git log --oneline main..dev` = 32 | 制定合 main 检查清单（gate 9/9 + 连续复跑 + 文档同步），B24/B25 后合一次 |
| ~~L-6~~ **（已于 2026-09-16 当轮修复并转绿）** | `npm run gate` 项 7 曾 FAIL：`server/core/skills.js` 分支覆盖率 80.17% < 85% | gate 曾输出 `[FAIL] 项7 … server/core/skills.js 行96.875%/分支80.17241379310344%/函数100%`；`npm run cov` 按**全局**阈值判定仍 exit 0（全表分支 85.30%），gate 项 7 按**文件**判定故 FAIL。未覆盖行：`skills.js` 40、115-116、142-144、223-225（`fieldValue` 非 Px 分支、未知算子 warn、未登记词条 warn、未知发射模式 warn）——这些防御分支只能通过**注入机制表**触发，而当时 `makeSkills(logger, tables)` 未对外导出 | **已修**：`server/core/skills.js` 导出 `withTables(tables, logger)` 并补 6 个用例（478 → 484 用例）→ **`npm run gate` = 9 PASS / 0 FAIL / 0 PEND**。阈值未放宽（`tasks.md` §5.1 第 4 条 / §10）。 |


> **L-5 现状（2026-09-16 复核）**：**已失效**——`dev` 分支不存在（`git branch` = `main` / `deepseek-v4.1f` / `glm-5.3f`），`main` 合流已完成（HEAD `cee2ebf`）；两个前端分支未合并。合流清单见 `docs/acceptance.md` §7（已标记为"已完成"）。

### 5.2 功能未完成（预期内，非缺陷）

> 原表两行（回放 / 排位）为 **2026-09-12 的旧快照**，且与 §3.1 的完成记录矛盾，已于 2026-09-16 复核后删除。现状如下：

| 项 | 批次 | 现状（2026-09-16 复核） |
|---|---|---|
| 回放：`/api/v1/battle` + `/api/v1/replay/:id` + 文本回放 CLI + 帧自足审计 | B22/B23 | ✅ **已完成**（`server/index.js` 已注册 `POST /api/v1/battle` 与 `GET /api/v1/replay/:id`，`tests/api` 覆盖，gate 项 9 冒烟通过）。~~2026-09-12 旧记录"`server/battle.js` 正在被并发实施"~~ 已过期；`server.md` §3.2 的状态同步亦已完成（端点已移入 §3.1） |
| 排位：`/ranked/run` + `/ranked/promote`（快照/bot 池/晋升 x=6） | B24/B25 | ✅ **已完成**（`server/ranked.js` 已实现并接线 `POST /api/v1/ranked/run`、`POST /api/v1/ranked/promote`）。~~2026-09-12 旧记录"未接线；`ranked.js` 未实现"~~ 已过期 |
| 前端全部 | P6 | 🔄 **进行中（`F1`/`F2`/`F3` 三批已落地且**人工走查已通过** ⇒ 均判定"能玩"）：`F1`（登录与注册）、`F2`（账号管理与管理员面板）、`F3`（主界面 / 仓库 / 开箱 / 设置 / 出战配置编辑器，提交① 后端契约 `D-159`…`D-162` 2026-09-22 + 提交② 主界面线 2026-09-24 + 提交③ 2026-09-25）+ **`D-163` 热修（2026-09-25）** —— `public/**`（零依赖双模文本界面）、`server/index.js` 同源静态托管（`GET /` + `public/` 白名单资源）、`tests/frontend/*`；设计分册 `docs/frontend/00-rules.md` + `01-auth.md` + `02-accounts.md` + `03-hub-warehouse-loadout.md`；审查与走查记录 `docs/reviews/F1.md`/`F2.md`/`F3.md`。**旧 v3 设计（`frontend-spec.md`/`screens.md`）及配套自检器/样本已于 2026-09-20 全量作废并删除**，不得沿用旧稿。**待办**：~~人工走查~~ **已完成（2026-09-25，用户本人）**；**其余屏幕**（快速对战 / 锦标赛·排位 / 排行榜 / 战绩·回放 / AI 编辑器）待设计（4 个空页已在界面占位）；F3 的登记待裁定项（N-10/N-11/N-12/N-13/N-17）见 §0.3/§0.4。剩余后端配合项：`/shared`、`/assets` 的静态托管（当前只托管 `public/`）。 |
| 在线服务（账号/登录/档案/配置槽/战绩/排行榜/快速对战/异步排位/非对称 Elo/回放鉴权） | P7（B27–B33） | ✅ **已完成（2026-09-19）**：`server/store/*`、`server/auth.js`、`server/account.js`、`server/quickmatch.js`、`server/admin.js` 均已实现并接线，HTTP 层有 Bearer 鉴权分支与 `runtime/`（`DL_DATA_DIR`）。审查记录 `docs/reviews/B27.md`…`B33.md`；交付实测见 §0 与 §5.3 |
| 数值开放项 | — | 已全部关闭（D-127 dodgeChanceBonus、D-128 defK 入表，B21 收口） |

### 5.3 说明

- **门禁实测（2026-09-19，P7 收口后）**：`npm test` = **942 通过 / 0 失败**、`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**、`npm run check:docs` = **PASS**、`npm run e2e` = **22/22**、`npm run load-test -- --players 50 --deep` = **7/7 完整性断言**（全部 exit 0）。（历史上曾因 `server/core/skills.js` 分支覆盖率 80.17% < 85% 而项 7 FAIL，已通过导出 `withTables` 注入机制表并补 6 个用例修复；根因与修法见 §5.1 **L-6**；**禁止放宽阈值**。）
- **历史记录（B21 时期）**：`npm test` / `npm run cov` 均为 420/0；测试规模 420 用例 / 48 个测试文件。覆盖率阈值（行 90 / 分支 85 / 函数 90）持续通过。
- **前一轮实测（2026-09-16 早期复核，本轮改动前）**：`npm run gate` = 9 PASS / 0 FAIL / 0 PEND；`npm test` = 459 通过 / 0 失败。（B25 提交时的同口径记录见 `docs/reviews/B25.md`。）
- 黄金战斗为 gate 项 8 的冒烟基准（**18 tick，p2 胜**，seed 20260912），**B11 黄金回归测试 `tests/regression/golden-battle.test.js` 已于 2026-09-16 落地**并进入 `npm test`；走查 §3.1 已按真实引擎复算（L-2 已关闭）。

- **P7 阶段进展（自动同步，2026-09-19T02:43:36.404Z）**：P7-2 身份与会话（P0 并发注册闭合/session_expired/启动 prune/配置生效）、P7-3 排位与快速对战（**去占位 bot + shortfall**、D-136 去重窗口裁定、双向记账、Elo 可复算与积分守恒）、P7-4 HTTP/CLI 鉴权与端点（Bearer/401/403/404/409/410/429/DL_*/回放 LRU64+410/CLI 退出码 3/readBody→413）、存储层两张数据表与 player.removed 墓碑。实测：npm test 803/0、gate 9 PASS/0 FAIL/0 PEND、check-docs PASS。

- **P7-5 e2e 落地**（2026-09-19T02:49:51.781Z）：新增 scripts/e2e.js 与 tests/helpers/e2e.js（全链路 22 检查点）。实测 npm test 803/0、gate 9 PASS/0 FAIL/0 PEND、check-docs PASS。

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

- **终局文档同步（2026-09-19，中央文档批）**：`docs/systems/11-account-store.md`（§5.4 快照可选 `warehouse` 装配引用子集 / §7.4 `loadWarehouse` 三级来源 + 逐侧签名 + 归档回放按各自快照取镜像 / §7.2 `relaxed`+`invalids` 落 `ranked.batch` 与去重窗口裁定 / §4.6 限速与 §10.3 错误码 / §5.6 索引合并写语义 / §9.4 `programHash` 口径更正）、`docs/interfaces.md`（§1 补 `server/battle.js`、`server/store/archive.js`、`server/store/ledger.js` 与 `snapshotWarehouseOf`/`snapshotWarehouseRefreshed` 签名）、`docs/server.md`（§1 进程模型 / §2 环境变量 / §3 端点 / §4 状态码与错误码 / §6 状态契约 / §7 CLI / §9.1 runtime 目录全部由「计划中」改为「现状」）、`docs/tasks.md`（B27–B33 勾选 + 共 41 批 + MS7 达成）、`docs/progress.md`（本节）、`docs/security-backlog.md`（SEC-01/SEC-03/SEC-22 处置回填 + 汇总表）、`server/data/README.md`（两张参数表与 `affix-registry` 的 `domain`/`_domainOfKind` 语义）。**实测**：`node scripts/check-docs.js` = PASS（批次勾选 41 / 审查记录 41/41）、`node --test tests/integration/interfaces.test.js tests/integration/check-docs.test.js tests/frontend/fe-spec.test.js` 全绿。

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

- **UTF-8 跨 chunk 解码修复 + 终局缺陷批次（2026-09-19T07:40:45.773Z）**：① 根因定位——`server/index.js` 的 `readBody` 用 `data += chunk` 逐 chunk 解码，中文请求体跨 TCP chunk 边界时被静默损坏为 U+FFFD（`readBody` 上限判定同时改为**字节**口径）；测试夹具同源缺陷曾造成 RP-3/RP-8 间歇假红。已改 `Buffer.concat(chunks).toString('utf8')` 并新增 `tests/api/api-body-utf8-split.test.js`（切在中文昵称字节内部发送，断言逐字节一致）。② 遗留 `r<seq>` 回放：登记调用方 side → 按 side 裁剪 aiTrace；带 token 非参与者 403；**匿名剥离全部 aiTrace** + `api.replay.trace_denied`(warn)。③ `/ai/battle` 新增可选 `skills`/`loadout`（互斥，缺省逐字节沿用 baseline 零回归），带 token 时可用真实档案配置；`skill:skill1` 实测 62 effective / 0 ineffective（修前 62/62 unknown_skill）。④ 同模板双槽冷却改为**按槽位**（`canCast(skill, caster, cooldownKey)`）。⑤ `DL_DATA_DIR` 注入缝修为**覆盖层**语义（注入=覆盖、未提供回退 `process.env`；新增 `enableStore:false` 显式否决）。⑥ D1-residual 关闭：抽池与实例化**共用同一可用性判定**（`ranked.sideInstantiable` = `battle.buildPlayer` 同源），`loadWarehouse` 改覆盖判定链，`skipped.notInstantiable` 不入池。⑦ P2 卫生项：`DL_PORT=0`=临时端口、删幻影 `DL_CONFIG_DIR` 注释、HTTP 边界 `details` 恒含 `path`、全局限速分层 `global.rateLimitPerMinute`、去重窗口单源、清理游离文件并入 `.gitignore`。
- 实测（本轮）：`npm test` **943 通过 / 0 失败**；`npm run gate` **9 PASS / 0 FAIL / 0 PEND**（连跑两次）；`check-docs` PASS；`baseline --compare` 无新增失败（exit 0）；`npm run e2e` **22/22**；`npm run play` exit 0。
- **交接待办（需授权，未做）**：① `cli/index.js:55`（生产 CLI 响应解码，同 UTF-8 跨 chunk 缺陷）与 `scripts/gate.js:573`、`scripts/e2e.js:182`、`tests/helpers/{e2e,load}.js` 的同缺陷点；② P2-4/P2-5 的表键部分需同步 `server/data/schema.js` 的 `SERVICE_CONFIG_FROZEN`；③ `server/loadout.js`(22)/`server/core/unlock.js`(6) 源码侧 `{where}` → `{path}` 统一；④ 模块级 uid 计数（`server/core/items.js:87`、`effects.js:36`）的 `--test-isolation=none` 顺序敏感性。

- **UTF-8 跨 chunk 解码收口（2026-09-19T07:49:12.476Z）**：在上一批（`server/index.js` readBody 改 `Buffer.concat` + 字节上限、`tests/helpers/http.js` 与 7 个 `tests/api/*`、`tests/api/api-body-utf8-split.test.js`）基础上，**收口剩余 5 处同源点**：`cli/index.js:53-65`（**生产 CLI 响应解码**）、`scripts/gate.js:570-582`（项 9 getJson）、`scripts/e2e.js:180-190`、`tests/helpers/e2e.js:54-66`、`tests/helpers/load.js:238-250`（全仓 `on('data'` 18 处现均为 chunks 写法；`gate.js`/`check-arch.js` 的 `out += c` 是源码字符扫描器，非网络数据，未动）。新增 `tests/cli/cli-utf8-split.test.js`（3 条：`httpJson.raw` 逐字节一致 / `cli health` stdout 无 U+FFFD / 非 JSON 500 中文 stderr 完整且退出码 1；**判别力实测**：临时改回逐 chunk 解码 → 3/3 全红，恢复后 3/3 全绿；用例内含"服务端确实写出 ≥2 chunk"的探针断言，避免静默失去判别力）。
- 实测（UTF-8 收口后）：`npm test` = **946 通过 / 0 失败**；`npm run gate` = **9 PASS / 0 FAIL / 0 PEND**；`check-docs` PASS；`baseline --compare` exit 0（无新增失败）；`npm run e2e` **22/22**；`npm run play` exit 0。
  > 注：上一条"UTF-8 跨 chunk 解码修复"记录中的 `npm test` 数字（943）与范围（仅 readBody + 夹具 + api 用例）已由本条更新为 **946** 与"含 5 处收口点 + CLI 回归用例"。
