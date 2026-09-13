# 后端验收手册（给用户的检查流程）

> 版本：v1　更新：2026-09-13（**本次实测记录**：B25 之后的全量验收）
> 用途：AI 声称"后端开发完成、测试全过"时，按本手册逐项复核并给出结论。
> 适用对象：`dev` 分支（目前领先 `main` **36 个提交**；main 尚未合流，见 §7）。

---

## 0. 验收结论（2026-09-13 实测）

| 项 | 结论 |
|---|---|
| 批次完成度 | ✅ 34/34 批勾选（P0~P5 全收口，`tasks.md §6`） |
| 审查记录 | ✅ 34 份（`docs/reviews/P0-1.md … B25.md`，每批独立审查） |
| 门禁实测 | ✅ **`npm run gate` = 9 PASS / 0 FAIL / 0 PEND**（本条命令本人实跑） |
| 测试规模 | ✅ 450 用例（B25 提交自报；gate 实测通过即含覆盖率阈值：core/ai/shared/cli 行≥90/分支≥85/函数≥90） |
| CLI/HTTP 冒烟 | ✅ 全部符合预期（§4 记录） |
| 确定性抽查 | ✅ 同 seed 内容级一致；golden 战斗 trace↔silent 逐帧一致（gate 项 8） |
| 遗留项 | ⚠ 3 条非阻断项（§6：flake 观察中、`.review-*` 53 文件待清理、`main` 未合流） |

**结论：可以接受。** 后端"完成"属实；建议合流 `main` 前先处理 §6 的两条仓库卫生项。

---

## 1. 证据链（先在纸上核对，10 分钟）

```bash
git log --oneline -6 dev            # 应看到 B21…B25 收口提交，消息含用例数与 gate 结果
git status --short                  # 工作区应干净（除进行中批次）
Select-String docs\tasks.md -Pattern '`\[x\]`'   # 34/34 批勾选
Get-ChildItem docs\reviews -File    # 34 份审查记录；每批应有「审查 → PASS/FAIL→PASS」结论
```

**判定**：提交消息、勾选数、审查记录三者齐 → PASS。

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
- `npm test` 与 `npm run cov` 应同为 **450 用例 / 0 失败**（B25 之后）。
- gateway 已含覆盖率判定，故 `npm run gate` 通过即可视为覆盖达标；`cov` 用于看明细。

## 4. 活体冒烟（起服务后逐条执行）

```bash
$env:DL_PORT=3000; node server/index.js     # 另开一个终端
npm run cli -- health                        # {ok:true, data:{status:'ok', version:'3.0.0'}}
npm run cli -- data battle-config            # 返回完整数据表
npm run cli -- box --seed 42 --tier rare --times 2   # 返回 2 件物品；重复执行仅 uid 不同（内容一致）
npm run cli -- ai validate --file good.json --tier common    # {ok:true}
npm run cli -- ai validate --file bad.json  --tier common    # 退出码 1，错误含 path+code+message
npm run cli -- ai battle --file good.json --opponent kiter --seed 7   # 返回 seed/winner/ticks/frames
npm run cli -- wh list                      # 空仓库骨架
npm run cli -- panel --loadout <file>       # 面板聚合（need 合法 loadout 文件）
npm run cli -- ranked run --seed 11         # P5：10 场离线结算
```

**判定**：
- `ai validate` 的**错误信息必须精确**（示例实测：`action 缺必填字段 name`、`body 必须为 seq（隐式主循环结构契约，D-100）`，带 `path`）——这是 AI 系统质量的试金石。
- box 同 seed 两次输出：**内容级一致**（uid 例外属设计：B17 进程内单调，不参与内容比较）。

## 5. 确定性抽查（本项目灵魂）

1. 同 seed 战斗两次 → `frames` 逐字节一致（golden 问题）；可用 `npm run demo -- --seed 20260912` 目测两次输出一致。
2. `--log-level trace` 的结果与 `silent` **逐帧一致**（gate 项 8 已断言，手工抽查一次即可）。
3. 黄金战斗：`.audit/golden-battle.json`（seed 20260912，18 tick，`winner=p2`）可作基线对比。

## 6. 已知遗留（验收时同步确认，非阻断）

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| L-1 | gate 项 7 偶发 flake（约 1/7，未定位用例） | 本次验收 3 次实跑**未复现** | 合 main 前导入"连续 5 次全绿"作为合流条件；持续观察 |
| L-3 | `.review-*` 探针目录 53 个文件已被 git 追踪（审查工作产物） | 仍在 dev 上 | 移出追踪 + 加入 `.gitignore`（与 `docs/reviews/` 并存即可） |
| L-4 | `.audit/verify-rest.js`（设计期临时校验器）残留 | 仍在 | 删除（`golden-battle.*`/`replay-audit.js` 是 gate/审计依赖，保留） |
| L-5 | `main` 落后 dev 36 提交，无自动合流 | 未合 | 合流前跑"门禁+连续复跑+文档同步"检查清单；`docs/` 冲突以 main 版（最新全套）为准 |

## 7. 合流 main 检查清单（批准前后各一次）

1. `npm run gate` = 9/9（合流前最后跑一次）；
2. `npm run gate` ×3 连续全绿（flake 观察）；
3. `git log main..dev --stat` 人工过目：只应有 server/ tests/ cli/ scripts/ shared/ 与少量 docs 更新；
4. `docs/` 冲突处理：以 **main 的文档版**为准（main 已有完整最新全套 + screens.md），dev 侧文档改动逐个核对；**前端实现代码不在本轮**（P6）；
5. `git checkout main && git merge dev --no-ff` → 验收冒烟 §4 再跑一遍 → `git push origin main`。

---

## 附：验收中曾经踩过的坑（别再踩）

- CLI **必须**在服务端运行时执行（CLI 只走 HTTP，设计如此，不是 bug）。
- box 确定性比较要**剥离 uid**（进程内单调，设计语义）。
- PowerShell 5.1 直读中文文档会乱码（显示层），以 `git show` / Node 读取为准。
- 验收用的临时文件用完即删（不污染 `.audit/`）。