'use strict';
/* scripts/load-test.js —— P7-6 批量测试 / 压力与完整性（`node scripts/load-test.js [选项]`）
 *
 * 目标（docs/plan-p7-playable.md §P7-6）：注册 N 个**真实玩家** → 每人配齐完整出战配置
 *   （开箱 → 仓库镜像 → 装配 → 配置槽 → 各自不同的 AI 程序，经 /ai/validate + /ai/compile）
 *   → **先建池、后匹配** → 并发发起排位与快速对战 → 统计吞吐/延迟/错误率/状态码分布
 *   → **七条完整性断言**（逐条失败即非零退出）→ 报告 `runtime/load-report.json` + 终端摘要。
 *
 * 🚫 **必须用真实玩家，不用占位 bot**（用户 2026-09-16 明确要求）：匹配池只由 `/auth/register`
 *     注册出来的档案构成（真实默认配置 / 真实开箱产物 / 真实 AI 快照）；池不足由服务端按设计少打几场
 *     并回报 `shortfall`（D-152），本脚本**不注入任何 bot**。
 *
 * 硬约束：零依赖；**禁 `child_process`**；**禁 `Math.random`**（用 `tests/helpers/load.js` 的种子化 RNG）；
 *   进程内起服务 + 随机端口（port 0）+ `DL_DATA_DIR` 等价隔离（`os.tmpdir()` 下的临时目录，跑完删除）。
 *
 * 用法：
 *   node scripts/load-test.js [--players 200] [--concurrency 24] [--rank-runs 1] [--quick-runs 1]
 *     [--boxes 16] [--tier common] [--seed 20260918] [--slots 2] [--deep] [--fast-auth]
 *     [--out <file>] [--quiet] [--keep-data]
 * 退出码：0 = 全部断言通过且无 5xx；1 = 有断言失败 / 致命错误；2 = 参数错误。
 */
const path = require('node:path');
const load = require('../tests/helpers/load.js');

const USAGE = `用法：node scripts/load-test.js [选项]

  --players <n>        注册并驱动 n 个真实玩家（默认 200）
  --concurrency <n>    并发批宽（默认 24；有界并发，避免打满机器）
  --rank-runs <n>      每个玩家发起的排位批次数（默认 1 → 每人 ≤10 场）
  --quick-runs <n>     每个玩家发起的快速对战次数（默认 1）
  --boxes <n>          每人开箱次数（默认 16；一次请求 times=n）
  --tier <t>           开箱/装配段位（默认 common）
  --slots <n>          每个目标物品最多装配几个插件槽（默认 2）
  --seed <n>           种子（默认 20260918；一切随机性由它派生）
  --deep               开启索引重建比对（大 N 下较慢；默认关闭）
  --fast-auth          用 scrypt N=1024（压缩时长；默认 N=16384 = 生产真实成本）
  --out <file>         报告路径（默认 runtime/load-report.json）
  --keep-data          保留临时数据根（诊断用）
  --quiet              只打印最终摘要

  示例：node scripts/load-test.js --players 50 --deep
`;

function parseArgs(argv) {
  const out = {
    players: load.DEFAULTS.players,
    concurrency: load.DEFAULTS.concurrency,
    rankRuns: load.DEFAULTS.rankRuns,
    quickRuns: load.DEFAULTS.quickRuns,
    boxes: load.DEFAULTS.boxes,
    tier: load.DEFAULTS.tier,
    seed: load.DEFAULTS.seed,
    slotsMax: load.DEFAULTS.slotsMax,
    deep: false,
    fastAuth: false,
    out: null,
    keepDataDir: false,
    quiet: false,
    help: false,
    bad: null,
  };
  const num = (raw, name) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) { out.bad = `${name} 需要非负整数（收到 ${raw}）`; return null; }
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--players') { const n = num(argv[++i], '--players'); if (n !== null) out.players = n; }
    else if (a === '--concurrency') { const n = num(argv[++i], '--concurrency'); if (n !== null) out.concurrency = n; }
    else if (a === '--rank-runs') { const n = num(argv[++i], '--rank-runs'); if (n !== null) out.rankRuns = n; }
    else if (a === '--quick-runs') { const n = num(argv[++i], '--quick-runs'); if (n !== null) out.quickRuns = n; }
    else if (a === '--boxes') { const n = num(argv[++i], '--boxes'); if (n !== null) out.boxes = n; }
    else if (a === '--slots') { const n = num(argv[++i], '--slots'); if (n !== null) out.slotsMax = n; }
    else if (a === '--seed') { const n = num(argv[++i], '--seed'); if (n !== null) out.seed = n; }
    else if (a === '--tier') out.tier = String(argv[++i]);
    else if (a === '--out') out.out = String(argv[++i]);
    else if (a === '--deep') out.deep = true;
    else if (a === '--fast-auth') out.fastAuth = true;
    else if (a === '--keep-data') out.keepDataDir = true;
    else if (a === '--quiet') out.quiet = true;
    else out.bad = `未知参数 ${a}`;
    if (out.bad) break;
  }
  return out;
}

function fmtMs(v) { return `${v}ms`; }

function printSummary(report, outFile) {
  const p = report.phases || {};
  const m = report.metrics || { latencyMs: {} };
  const L = (g) => (m.latencyMs && m.latencyMs[g]) || { count: 0, p50: 0, p95: 0, max: 0 };
  const line = (s) => process.stdout.write(`${s}\n`);
  line('');
  line('==================== P7-6 批量测试摘要 ====================');
  line(`目标：${report.options.players} 玩家 / 并发 ${report.options.concurrency} / scrypt ${report.options.scrypt} / seed ${report.options.seed}`);
  line(`注册：${p.register ? `${p.register.ok}/${p.register.requested} 成功，${p.register.ms}ms（${p.register.perSecond}/s）` : '-'}`);
  line(`配齐出战配置：${p.setup ? `${p.setup.ok}/${p.setup.requested} 成功，${p.setup.ms}ms；装配成功 ${p.setup.assemble.placed} 处，服务端拒绝 ${JSON.stringify(p.setup.assemble.rejections)}` : '-'}`);
  line(`建池：${p.pool ? `档案 ${p.pool.archives}、可用快照 ${p.pool.usableSnapshots}、段位分布 ${JSON.stringify(p.pool.byTier)}、isBot 档案 ${p.pool.isBotArchives}` : '-'}`);
  if (p.matches) {
    line(`对局：排位 ${p.matches.ranked.matches} 场（shortfall ${p.matches.ranked.shortfall}、invalid ${p.matches.ranked.invalids}）+ 快速 ${p.matches.quick.ok} 场（no_opponent ${p.matches.quick.noOpponent}）`);
    line(`     合计 ${p.matches.totalMatches} 场 / ${p.matches.ms}ms`);
    line(`吞吐：${p.matches.throughputPerSecond} 场/秒（排位 ${p.matches.ranked.matchesPerSecond}/s、快速 ${p.matches.quick.matchesPerSecond}/s）`);
    line(`排位批次结果分布：${JSON.stringify(p.matches.ranked.runOutcomes)}`);
    line(`快速胜负分布：${JSON.stringify(p.matches.quick.outcomes)}`);
  }
  line(`延迟（ms，P50/P95/max）：注册 ${L('register').p50}/${L('register').p95}/${L('register').max}　开箱 ${L('box').p50}/${L('box').p95}/${L('box').max}`);
  line(`                        装配 ${L('assemble').p50}/${L('assemble').p95}/${L('assemble').max}　AI ${L('ai').p50}/${L('ai').p95}/${L('ai').max}　配置 ${L('config').p50}/${L('config').p95}/${L('config').max}`);
  line(`                        排位 ${L('ranked').p50}/${L('ranked').p95}/${L('ranked').max}　快速 ${L('quick').p50}/${L('quick').p95}/${L('quick').max}　全部 ${L('all').p50}/${L('all').p95}/${L('all').max}`);
  line(`请求：${m.requests} 次；5xx=${m.server5xx}；传输层失败=${m.transportFailures}；错误率=${(m.errorRate * 100).toFixed(3)}%`);
  line('状态码分布：');
  for (const [k, v] of Object.entries(m.statusDistribution || {})) line(`   ${k} × ${v}`);
  if (Object.keys(m.errorCodes || {}).length) line(`错误码分布：${JSON.stringify(m.errorCodes)}`);
  const d = report.distribution || {};
  if (d.rating) {
    line(`玩家水平分布（自然产生）：积分 min ${d.rating.min} / P50 ${d.rating.p50} / P95 ${d.rating.p95} / max ${d.rating.max}`);
    line(`   分段：${(d.rating.bands || []).map((b) => `${b.label}:${b.count}`).join('  ')}`);
    line(`   段位：${JSON.stringify(d.tiers)}；对局总计 ${d.ratingGamesTotal}；攻/守战绩 ${JSON.stringify(d.winLossDraw)}`);
  }
  if (d.aiPrograms) {
    line(`AI 程序：互不相同 ${d.aiPrograms.distinct}/${report.options.players}（每人一份 = ${d.aiPrograms.equalToPlayers}）；预设分布 ${JSON.stringify(d.aiPrograms.presets)}`);
  }
  line('------------------- 完整性断言（7 条） -------------------');
  const checks = (report.integrity && report.integrity.checks) || [];
  for (const c of checks) line(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.title}\n         ${c.detail}`);
  line('----------------------------------------------------------');
  line(`结论：${report.ok ? '全部通过（ok=true，无 5xx）' : '存在失败项（ok=false）'}；总耗时 ${report.wallMs}ms`);
  if (outFile) line(`报告：${outFile}`);
  line('==========================================================');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); return 0; }
  if (args.bad) { process.stdout.write(`${args.bad}\n\n${USAGE}`); return 2; }
  if (!load.TIERS.includes(args.tier)) {
    process.stdout.write(`--tier 非法（可选 ${load.TIERS.join('/')}）\n`);
    return 2;
  }
  if (args.players < 2) {
    process.stdout.write('--players 至少为 2（匹配需要真实对手；本脚本不注入 bot）\n');
    return 2;
  }

  const t0 = Date.now();
  const report = await load.runLoadTest({
    players: args.players,
    concurrency: args.concurrency,
    rankRuns: args.rankRuns,
    quickRuns: args.quickRuns,
    boxes: args.boxes,
    tier: args.tier,
    seed: args.seed,
    slotsMax: args.slotsMax,
    deep: args.deep,
    fastAuth: args.fastAuth,
    keepDataDir: args.keepDataDir,
    level: args.quiet ? 'error' : 'warn',
  });

  const outFile = args.out ? path.resolve(args.out) : load.reportPath();
  try {
    load.writeReport(report, outFile);
  } catch (e) {
    process.stderr.write(`报告写入失败：${e && e.message}\n`);
  }
  if (report.dataDir) process.stdout.write(`[load-test] 数据根保留于 ${report.dataDir}\n`);
  printSummary(report, outFile);
  process.stdout.write(`[load-test] 总墙钟 ${Date.now() - t0}ms\n`);
  return report.ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  process.stderr.write(`load-test 致命错误：${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
