# 后端验收手册（给用户的检查流程）

> 版本：v1　更新：2026-09-19（**P7/B27–B33 交付后复核**；2026-09-16 记录与 §8 历史保留）
> 用途：AI 声称"后端开发完成、测试全过"时，按本手册逐项复核并给出结论。
> 适用对象：**`main` 分支**。⚠ **`dev` 分支已不存在**（`git branch` = `main` / `deepseek-v4.1f` / `glm-5.3f`）；本文原以 `dev` 为对象，相关表述已修正或降级为历史。
> 阅读约定：**「现状」= 2026-09-19 实测；「计划中」= 未实现，不得当作可用能力验收**。

---

## 0. 验收结论（2026-09-19 复核）

| 项 | 结论 |
|---|---|
| 批次完成度 | ✅ **41 批**（P0–P5 的 34 批 + **P7/B27–B33 的 7 批**；`tasks.md` §6 头部、`progress.md` 与本表一致，由 `node scripts/check-docs.js` 机器核对） |
| 审查记录 | ✅ **41 份**（`docs/reviews/P0-1.md … B33.md`，每批独立审查；P7 另有 `docs/reviews/P7-7-test-audit.md`、`P7-7-wave2-code-review-residual.md`） |
| 门禁实测 | ✅ **`npm run gate` = 9 PASS / 0 FAIL / 0 PEND**；`node scripts/check-docs.js` = PASS；`node scripts/fe-spec-check.js` = 9 PASS（2026-09-19 实跑） |
| 测试规模 | ✅ **`npm test` = 915 通过 / 0 失败**（2026-09-19 实跑；gate 项 7 已含覆盖率阈值：core/ai/shared/cli 行≥90/分支≥85/函数≥90） |
| 联网闭环 | ✅ **`npm run e2e` = 22/22 检查点**（真实玩家全链路，exit 0）；✅ **`npm run load-test -- --players 50 --deep` = 7/7 完整性断言**（含积分守恒、无 bot 参与、无 5xx） |
| CLI/HTTP 冒烟 | ✅ 按 §4 执行；⚠ 原 `ranked run --seed 11`（缺 `--loadout`）与裸 `wh list` 两个命令参数不足会以退出码 2 失败，已修正；`npm run demo` / `npm run play` **现已可执行** |
| 确定性抽查 | ✅ 同 seed 内容级一致；golden 战斗 trace↔silent 逐帧一致（gate 项 8） |
| 遗留项 | ⚠ 见 `docs/security-backlog.md`（SEC-01 部分处置 / SEC-03 与 SEC-22 已处置等）与 §6 |
| 前端 / 在线服务 | ✅ **在线服务（P7/B27–B33）已交付**；⏳ **前端（P6）未开始**（0 行代码） |

**结论：可以接受。** 后端"完成"属实且覆盖面扩至 **P7 在线服务**（服务端档案 / 鉴权 / 异步排位 / 快速对战 / 回放鉴权）；**P6 前端**属计划中，不在本次验收范围。§8 的"前端 F0–F7 全部落地"结论已于 2026-09-16 判定**不成立**，保留为历史记录。

---

## 1. 证据链（先在纸上核对，10 分钟）

```bash
git branch --show-current              # 应为 main（dev 分支已不存在）
git log --oneline -6                   # 应看到 B25 收口提交 (6317b3f/ecdd7d4 等) 与前端相关提交；HEAD = cee2ebf
git status --short                     # 工作区可含未提交的前端文档 v3 改动（2026-09-16 现状）
Select-String docs\tasks.md -Pattern '\[x\]'   # 批次勾选：应为 41（P0–P5 的 34 + P7/B27–B33 的 7）
Get-ChildItem docs\reviews -File       # 41 份审查记录；每批应有「审查 → PASS/FAIL→PASS」结论
node scripts/check-docs.js             # D1–D6：批次计数/勾选/审查记录覆盖（应为 PASS）
```

**判定**：提交消息、勾选数、审查记录三者齐 → PASS。

> 2026-09-19 复核：`docs/reviews/` 含 P0-1…B25 与 B27…B33（41 份批次审查）+ P7-7 审计两份。

## 2. 门禁（机器判决，唯一硬指标）

```bash
npm run gate
```

| 预期 | 说明 |
|---|---|
| 项1-3 PASS | 静态：core 无 `Math.random`/`eval`；core 无 `console.*`；依赖方向无违规 |
| 项4-5 PASS | 数据表 schema + 文档↔数据一致性 + D 编号落点（T-DC-1/2/8） |
| 项6 PASS | 日志事件命名规范 + 战斗数值未硬编码 |
| 项7 PASS | 全量测试 + 覆盖率阈值（四目录） |
| 项8 PASS | trace 跑黄金战斗：cid 链路完整、trace↔silent 逐帧一致 |
| 项9 PASS | listen(0) → /api/v1 → CLI 闭环 |

**判定**：9/9 全绿 → PASS。任何 FAIL → 打回；任何"PEND"→ 该项功能未激活，问 AI 原因。

## 3. 测试规模与覆盖

```bash
npm run cov        # 末尾应显示行/分支/函数覆盖（四目录达标）
```
- `npm test` 与 `npm run cov` 应同为 **915 通过 / 0 失败**（2026-09-19 复核实测 `npm test` = 915/0；`cov` 由 gate 项 7 同阈值判定）。
- gateway 已含覆盖率判定，故 `npm run gate` 通过即可视为覆盖达标；`cov` 用于看明细。

## 4. 活体冒烟（起服务后逐条执行）

```bash
$env:DL_PORT=3000; node server/index.js     # 另开一个终端
npm run cli -- health                        # {ok:true, data:{status:'ok', version:'3.0.0'}}
npm run cli -- data battle-config            # 返回完整数据表
npm run cli -- box --seed 42 --tier rare --times 2   # 返回 2 件物品；重复执行仅 uid 不同（内容一致）
npm run cli -- ai validate --file good.json --tier common    # {ok:true}
npm run cli -- ai validate --file bad.json  --tier common    # 退出码 1，错误含 path+code+message
npm run cli -- ai battle --file good.json --opponent kiter --seed 7   # 返回 seed/programHash/winner/phase/ticks/frames（B16，已实现；与 `npm run demo` 无关）
npm run cli -- wh list --file wh.json       # 本地仓库摘要（分桶 + 装配状态；注意 `--file` 必填，原写法的裸 `wh list` 会因参数非法退出码 2）
npm run cli -- panel --loadout <file>       # 面板聚合（need 合法 loadout 文件）
npm run cli -- battle --p1 a.json --p2 b.json --seed 20260912   # P4：双方对战 → 完整回放帧（B22，已实现）
npm run cli -- replay --file replay.json --tick 3               # P4：文本回放（B23，本地文件）
npm run cli -- ranked run --seed 11 --loadout <loadout.json>   # P5：10 场离线结算（B24，已实现；有 token 时改走档案驱动）
# P7（已交付）：auth register|login / me / quick run / leaderboard / ranked promote
# 全链路一键：npm run e2e（22 检查点）｜批量：npm run load-test -- --players 50 --deep（7/7 断言）
```

> ✅ **已可执行**：`npm run demo` / `npm run demo:log` / `npm run play`（`scripts/demo.js`、`scripts/play.js` 已落地并实跑通过；`play` 为离线可玩闭环，无需 `npm start`）。

**判定**：
- `ai validate` 的**错误信息必须精确**（示例实测：`action 缺必填字段 name`、`body 必须为 seq（隐式主循环结构契约，D-100）`，带 `path`）——这是 AI 系统质量的试金石。
- box 同 seed 两次输出：**内容级一致**（uid 例外属设计：B17 进程内单调，不参与内容比较）。

## 5. 确定性抽查（本项目灵魂）

1. 同 seed 战斗两次 → `frames` 逐字节一致（golden 问题）。**可用 `npm run cli -- ai battle --file good.json --seed 20260912` 跑两次比对 `frames` 数组**（也可直接 `npm run demo -- --seed 20260912`，脚本已落地）。
2. `--log-level trace` 的结果与 `silent` **逐帧一致**（gate 项 8 已断言，手工抽查一次即可）。
3. 黄金战斗：`.audit/golden-battle.json`（seed 20260912，18 tick，`winner=p2`）可作基线对比（gate 项 8 依赖，属现状）。

## 6. 已知遗留（验收时同步确认，非阻断）

| # | 项 | 现状（2026-09-16 复核） | 建议 |
|---|---|---|---|
| L-1 | gate 项 7 偶发 flake（约 1/7，未定位用例） | 本次复核实跑 `npm test` 459/0、`npm run gate` 9/0/0，**未复现**；根因仍未定位 | 合流前导入"连续 5 次全绿"作为条件；持续观察 |
| L-3 | `.review-*` 探针目录 **53** 个文件已被 git 追踪（审查工作产物；分布在 `.review-b16/b17/b18/b19/b20/b22/b23/b24/b25`） | 仍在 **`main`** 上（`dev` 已不存在）；`.gitignore` 尚无 `.review-*` 条目 | 移出追踪 + 加入 `.gitignore`（与 `docs/reviews/` 并存即可） |
| L-4 | `.audit/verify-rest.js`（设计期临时校验器）残留 | 仍在（被 git 追踪） | 删除（`golden-battle.*`/`replay-audit.js` 是 gate/审计依赖，保留） |
| L-5 | ~~`main` 落后 dev 36 提交，无自动合流~~ | ✅ **已失效**：`dev` 分支不存在，`main` 合流已完成（HEAD `cee2ebf`） | 无需动作；清单见 §7 |

## 7. 合流 main（**已于 2026-09-16 复核确认完成**，此处仅存清单备查）

1. `npm run gate` = 9/9（合流前最后跑一次）；
2. `npm run gate` ×3 连续全绿（flake 观察）；
3. `git log main..dev --stat` 人工过目：只应有 server/ tests/ cli/ scripts/ shared/ 与少量 docs 更新；
4. `docs/` 冲突处理：以 **main 的文档版**为准，dev 侧文档改动逐个核对；**前端实现代码不在本轮**（P6）。注意：原清单中提到的 `screens.md` **已被 `frontend-spec.md` v3 判定废弃**，不得再作为对照物；
5. `git checkout main && git merge dev --no-ff` → 验收冒烟 §4 再跑一遍 → `git push origin main`。

> **状态**：上述第 1–5 步对应的合流已完成——`dev` 分支已不存在，`main` HEAD = `cee2ebf`，`npm run gate` = 9 PASS / 0 FAIL / 0 PEND（2026-09-16 复核）。注意第 3–4 步中"dev"相关命令当前不可执行；两个未合并分支是 `deepseek-v4.1f` / `glm-5.3f`（前端实验，均未并入 main）。

---

## 附：验收中曾经踩过的坑（别再踩）

- CLI **必须**在服务端运行时执行（CLI 只走 HTTP，设计如此，不是 bug）。
- box 确定性比较要**剥离 uid**（进程内单调，设计语义）。
- PowerShell 5.1 直读中文文档会乱码（显示层），以 `git show` / Node 读取为准。
- 验收用的临时文件用完即删（不污染 `.audit/`）。

---

## 8. 历史记录：前端（P6）轮次已失败（原 2026-09-13 记录，**已作废**）

> **⚠ 2026-09-16 复核判定：本节原结论全部不成立，已降级为历史记录。**
> 复核证据：`main`（HEAD `cee2ebf`）上**没有任何前端代码**——无 `public/` 目录，`server/index.js` 无静态托管路由（`git branch` 中两个前端分支 `deepseek-v4.1f` / `glm-5.3f` 均未合并）。前端轮次的失败根因见 `docs/frontend-spec.md` §0 与 `docs/progress.md` §3.1。
> **现状**：P6 未开始（0 行代码）；P6 的实现应按 `docs/frontend-spec.md` **v3** 的 F1–F7 批次走。**`docs/screens.md` 已被 frontend-spec v3 判定废弃**，不得再作为验收对照物。

**原记录（保留以备追查，勿作为现状引用）**：

| 检查 | 原声称 | 复核结果（2026-09-16） |
|---|---|---|
| 前端批次 | F0 静态托管 → F1 布局引擎+store → F2 外壳 → F3 gacha/warehouse → F4 battle → F5 replay → F6 Blockly 编辑器 → F7 存档/轨迹 | ❌ 声称的"F0…F7 全部落地（42/42 批勾选）"**不成立**；后端真值为 34 批，前端 0 批 |
| 门禁 | 实跑 `npm run gate` = 9 PASS | ⚠ 该命令本身确实为 9 PASS（2026-09-16 复核一致），但它**不能证明前端存在** |
| 覆盖率 | cov **98.02 / 88.44 / 96.60**（含 `public/js`，check-arch 49 文件） | ❌ 不成立：无 `public/js` |
| 整链路冒烟 | `GET /`、`/js/app.js`、`/css/tokens.css`、`/shared/log.js`、`/js/editor/bridge.js` 全部 200 | ❌ 不成立：无静态托管路由，这些路径均会 404 |
| 确定性与审查 | golden 战斗 18 tick 一致 | ✅ 这一条属实（gate 项 8，`.audit/golden-battle.json`） |

**原"浏览器侧手工验收建议"**：其中"对照 `docs/screens.md` 的 7 屏示意图核对布局"一条**删除**（`screens.md` 已废弃）；其余闭环流程（菜单→开箱→装配→编辑 AI→对战→回放）属 **P6 计划**，当前不可执行。

**原"遗留"一行的复核**：L-1 flake 观察中（属实）；L-3 `.review-*` 原称 **67** 个文件 → 复核实测 `git ls-files ".review-*"` = **53** 个（`progress.md` 旧版曾写 24 个，亦已过期）；L-4 `.audit/verify-rest.js` 仍待删（属实）；L-5 `main` 落后 dev 44 提交 → ❌ 已失效（`dev` 不存在，合流完成）。