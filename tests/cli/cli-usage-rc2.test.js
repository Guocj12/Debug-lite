'use strict';
/* tests/cli/cli-usage-rc2.test.js —— CLI「用法 / 参数错误 → 退出码 2」的**唯一**表驱动用例（P7-7 §R5）
 *
 * 为什么集中到一张表：
 *   · 抽取前，同类断言（缺子命令 / 未知子命令 / 未知旗标 / 旗标缺值 / 文件不存在 / 畸形回放帧）
 *     散落在 9 个 CLI 测试文件的 ~47 处 assert 里，每处都要自建一套 console 捕获 + 调用包装；
 *   · 它们的**判据完全相同**（`code === 2` 且不触达服务端业务逻辑），差异只有 argv —— 正是表驱动的形态。
 *
 * 覆盖面（**不降级**）：
 *   · 本表逐条保留原用例的 argv 与语义（每条 `src` 标注来源文件 + 原用例号）；
 *   · 退出码 0（成功）/ 1（业务拒绝）/ 3（未鉴权）仍由**原本的** fixtures 文件断言，见各 `src` 文件：
 *       cli.test.js（0/1）、cli-auth.test.js（0/1/3）、cli-box/cli-panel/cli-battle/cli-ranked/cli-wh/
 *       cli-ai（0/1）、cli-replay.test.js（0）；
 *   · 断言数不减少：本表还为每条**额外**钉住"不得静默失败"（两个输出通道都不得全空）。
 *
 * 契约：docs/interfaces.md §3（CLI 只走 HTTP；退出码 0/1/2）；docs/systems/11-account-store.md §10.4（+3=未鉴权）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../helpers/http.js');
const c = require('../helpers/cli.js');

const FIX = (n) => path.join(__dirname, '..', 'fixtures', n);
const LD_OK = FIX('loadout-ok.json');
const WH_OK = FIX('wh-ok.json');
const AI_OK = FIX('cli-ai-ok.json');
const NOSUCH = path.join(__dirname, 'no-such-file-9527.json');
const PW = h.PASSWORD;

// 表：argv + 该条的存在理由（why）+ 来源（src）。ctx 提供需要运行时才有的值（用户名/token/回放文件）。
function buildRows(ctx, malformed) {
  const { user, token, replayFile, noFrames } = ctx;
  const rows = [
    // ---------- cli.test.js：顶层用法 / data / log ----------
    { id: 'top-unknown-subcommand', src: 'cli.test.js CLI-4', why: '未知顶层子命令', argv: ['frobnicate'], expectErr: /usage|unknown/i },
    { id: 'data-missing-arg', src: 'cli.test.js CLI-5', why: 'data 缺表名', argv: ['data'] },
    { id: 'log-bad-level', src: 'cli.test.js CLI-5', why: 'log 非法级别（本地校验）', argv: ['log', '--level', 'bogus'] },
    { id: 'log-bad-channel-format', src: 'cli.test.js CLI-5', why: 'log --channel 非法格式（无 =）', argv: ['log', '--channel', 'bad'] },
    { id: 'log-bad-channel-level', src: 'cli.test.js CLI-9', why: 'log --channel ch=非法级别', argv: ['log', '--channel', 'bullets=bogus'] },
    { id: 'log-unknown-flag', src: 'cli.test.js CLI-10', why: 'log 未知旗标', argv: ['log', '--nonsense'] },
    { id: 'log-level-missing-value', src: 'cli.test.js CLI-13b', why: 'log --level 缺值（args[++i] 未定义短路）', argv: ['log', '--level'] },

    // ---------- cli-auth.test.js：auth / me / quick / leaderboard / ranked ----------
    { id: 'auth-missing-subcommand', src: 'cli-auth.test.js CLI-2', why: 'auth 缺子命令', argv: ['auth'] },
    { id: 'auth-register-missing-pass', src: 'cli-auth.test.js CLI-2', why: 'auth register 缺 --pass', argv: ['auth', 'register', '--user', user] },
    { id: 'auth-login-unknown-flag', src: 'cli-auth.test.js CLI-2', why: 'auth login 未知旗标', argv: ['auth', 'login', '--user', user, '--pass', PW, '--oops', '1'] },
    { id: 'auth-login-pass-missing-value', src: 'cli-auth.test.js CLI-2', why: 'auth login --pass 缺值', argv: ['auth', 'login', '--user', user, '--pass'] },
    { id: 'auth-change-password-missing-new', src: 'cli-auth.test.js CLI-2', why: 'auth change-password 缺 --new', argv: ['auth', 'change-password', '--old', PW] },
    { id: 'me-unknown-flag', src: 'cli-auth.test.js CLI-5', why: 'me 未知旗标', argv: ['me', '--bogus', 'x'] },
    { id: 'quick-unknown-subcommand', src: 'cli-auth.test.js CLI-6', why: 'quick 未知子命令', argv: ['quick', 'fly', '--token', token] },
    { id: 'quick-run-unknown-flag', src: 'cli-auth.test.js CLI-6', why: 'quick run 未知旗标', argv: ['quick', 'run', '--token', token, '--x', '1'] },
    { id: 'leaderboard-unknown-flag', src: 'cli-auth.test.js CLI-7', why: 'leaderboard 未知旗标', argv: ['leaderboard', '--nope', '1'] },
    { id: 'ranked-promote-missing-tier-unauth', src: 'cli-auth.test.js CLI-8', why: 'ranked promote 既无 --tier 又未登录', argv: ['ranked', 'promote', '--wins', '7'] },
    { id: 'ranked-unknown-subcommand', src: 'cli-auth.test.js CLI-8', why: 'ranked 未知子命令', argv: ['ranked', 'fly'] },
    { id: 'unknown-command-b', src: 'cli-auth.test.js CLI-10', why: '未知命令（第二个入口，语义同上）', argv: ['bogus-command'] },

    // ---------- cli-ai.test.js ----------
    { id: 'ai-missing-subcommand', src: 'cli-ai.test.js 失败路径', why: 'ai 缺子命令', argv: ['ai'] },
    { id: 'ai-unknown-subcommand', src: 'cli-ai.test.js 失败路径', why: 'ai 未知子命令', argv: ['ai', 'bogus', '--file', AI_OK] },
    { id: 'ai-validate-missing-file-flag', src: 'cli-ai.test.js 失败路径', why: 'ai validate 缺 --file', argv: ['ai', 'validate'] },
    { id: 'ai-compile-file-not-found', src: 'cli-ai.test.js 失败路径', why: 'ai compile --file 文件不存在', argv: ['ai', 'compile', '--file', NOSUCH] },

    // ---------- cli-ranked.test.js ----------
    { id: 'ranked-run-missing-loadout', src: 'cli-ranked.test.js', why: 'ranked run 缺 --loadout', argv: ['ranked', 'run', '--seed', '11'] },
    { id: 'ranked-unknown-subcommand-bogus', src: 'cli-ranked.test.js', why: 'ranked 未知子命令（bogus）', argv: ['ranked', 'bogus'] },
    { id: 'ranked-run-loadout-not-found', src: 'cli-ranked.test.js', why: 'ranked run --loadout 文件不存在', argv: ['ranked', 'run', '--loadout', NOSUCH] },

    // ---------- cli-box.test.js ----------
    { id: 'box-unknown-flag', src: 'cli-box.test.js', why: 'box 未知旗标', argv: ['box', '--bogus'] },

    // ---------- cli-panel.test.js ----------
    { id: 'panel-missing-loadout', src: 'cli-panel.test.js', why: 'panel 缺 --loadout', argv: ['panel'] },
    { id: 'panel-loadout-not-found', src: 'cli-panel.test.js', why: 'panel --loadout 文件不存在', argv: ['panel', '--loadout', NOSUCH] },

    // ---------- cli-battle.test.js ----------
    { id: 'battle-missing-p2', src: 'cli-battle.test.js', why: 'battle 缺 --p2', argv: ['battle', '--p1', LD_OK] },
    { id: 'battle-p1-not-found', src: 'cli-battle.test.js', why: 'battle --p1 文件不存在', argv: ['battle', '--p1', NOSUCH, '--p2', LD_OK] },
    { id: 'battle-unknown-flag', src: 'cli-battle.test.js', why: 'battle 未知旗标', argv: ['battle', '--p1', LD_OK, '--p2', LD_OK, '--bogus'] },

    // ---------- cli-wh.test.js ----------
    { id: 'wh-list-file-not-found', src: 'cli-wh.test.js', why: 'wh list --file 文件不存在', argv: ['wh', 'list', '--file', NOSUCH] },
    { id: 'wh-missing-subcommand', src: 'cli-wh.test.js', why: 'wh 缺子命令', argv: ['wh'] },
    { id: 'wh-unknown-subcommand', src: 'cli-wh.test.js', why: 'wh 未知子命令', argv: ['wh', 'bogus', '--file', WH_OK] },
    { id: 'wh-assemble-missing-item-slot', src: 'cli-wh.test.js', why: 'wh assemble 缺 --item/--slot', argv: ['wh', 'assemble', '--file', WH_OK] },
    { id: 'wh-assemble-missing-plugin', src: 'cli-wh.test.js', why: 'wh assemble 缺 --plugin', argv: ['wh', 'assemble', '--file', WH_OK, '--item', 'r1', '--slot', '0'] },

    // ---------- cli-replay.test.js ----------
    { id: 'replay-missing-file-flag', src: 'cli-replay.test.js 失败路径', why: 'replay 缺 --file', argv: ['replay'] },
    { id: 'replay-file-not-found', src: 'cli-replay.test.js 失败路径', why: 'replay --file 文件不存在', argv: ['replay', '--file', NOSUCH] },
    { id: 'replay-tick-out-of-range', src: 'cli-replay.test.js 失败路径', why: 'replay --tick 越界', argv: ['replay', '--file', replayFile, '--tick', '999'] },
    { id: 'replay-no-frames-field', src: 'cli-replay.test.js 失败路径', why: 'replay 文件无 frames 字段', argv: ['replay', '--file', noFrames] },
    { id: 'replay-unknown-flag', src: 'cli-replay.test.js B23 P1-1', why: 'replay 未知旗标（旗标校验先于读文件）', argv: ['replay', '--file', 'x.json', '--bogus'] },
  ];
  // B23 P1-1：畸形帧变体（4 种）都必须是"参数/数据错误 → 2"，不得抛穿、不得误判成 1
  for (const [i, m] of malformed.entries()) {
    rows.push({
      id: `replay-malformed-${i}`,
      src: 'cli-replay.test.js B23 P1-1',
      why: `畸形帧变体 ${i}：${JSON.stringify(m.data).slice(0, 48)}`,
      argv: ['replay', '--file', m.file],
    });
  }
  return rows;
}

test('CLI-RC2 表驱动：用法/参数错误一律退出码 2（缺子命令/未知子命令/未知旗标/旗标缺值/文件不存在/畸形帧）', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('cliuse'));
    const { file: replayFile, dir: replayDir } = c.makeReplayFile();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-cli-rc2-'));
    const noFrames = path.join(scratch, 'noframes.json');
    fs.writeFileSync(noFrames, JSON.stringify({ foo: 1 }));
    const malformed = [
      { frames: [{}] },
      { frames: [{ tick: 1, diff: { players: { p1: { fromX: 1, toX: 2 } }, events: [] } }] },
      { frames: [{ tick: 1, diff: null }] },
      { frames: null },
    ].map((data, i) => {
      const f = path.join(scratch, `malformed-${i}.json`);
      fs.writeFileSync(f, JSON.stringify(data));
      return { file: f, data };
    });
    try {
      const rows = buildRows({ user: u.username, token: u.token, replayFile, noFrames }, malformed);
      const failures = [];
      for (const row of rows) {
        const r = await c.runCli(row.argv, { baseUrl: s.baseUrl });
        const argvText = `argv=[${row.argv.join(' ')}]`;
        if (r.code !== 2) {
          failures.push(`${row.id}（${row.src}｜${row.why}）${argvText} → 期望 2 实得 ${r.code}｜stderr=${r.err.slice(0, 160)}`);
          continue;
        }
        if (row.expectErr && !row.expectErr.test(r.err)) {
          failures.push(`${row.id} ${argvText} → 退出码 2 ✔ 但 stderr 未匹配 ${row.expectErr}｜stderr=${r.err.slice(0, 160)}`);
        }
        // 额外钉死：退出码 2 必须**有可读输出**（不得静默失败）
        if (r.err === '' && r.out === '') failures.push(`${row.id} ${argvText} → 退出码 2 但两个输出通道都为空（静默失败）`);
      }
      assert.ok(rows.length >= 46, `表规模下限（防表被误删）：期望 ≥46 行，实得 ${rows.length}`);
      assert.deepEqual(failures, [], `退出码 2 表驱动失败 ${failures.length}/${rows.length} 条：\n${failures.join('\n')}`);
    } finally {
      fs.rmSync(replayDir, { recursive: true, force: true });
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/* 表本身的元信息校验（零成本、不依赖服务端）：id 唯一 + 每条都有 why/src，防止"复制粘贴后忘改" */
test('CLI-RC2 表结构：id 唯一、每条都标注来源与理由（防表退化成重复行）', () => {
  const rows = buildRows({ user: 'u', token: 't', replayFile: 'r.json', noFrames: 'n.json' }, [{ file: 'm.json', data: { frames: [{}] } }]);
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `表内 id 必须唯一：${ids.filter((x, i) => ids.indexOf(x) !== i).join(',')}`);
  for (const r of rows) {
    assert.ok(r.src && r.src.length > 0, `${r.id} 缺 src（来源标注）`);
    assert.ok(r.why && r.why.length > 0, `${r.id} 缺 why（存在理由）`);
    assert.ok(Array.isArray(r.argv) && r.argv.length > 0, `${r.id} argv 必须是非空数组`);
  }
});
