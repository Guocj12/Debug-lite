'use strict';
/* tests/cli/cli-auth.test.js —— P7-4 CLI 新子命令与退出码（含 3 = 未鉴权）
 *
 * 契约：docs/systems/11-account-store.md §10.4（CLI 扩展 + 退出码 0/1/2/3 + token 来源）
 *      docs/interfaces.md §3（CLI 契约：只走 HTTP）
 * 覆盖：auth register|login|logout|change-password、me、quick run、leaderboard、ranked promote
 *      的正例 + 负例（用法错误 2 / 业务拒绝 1 / 未鉴权 3）+ --save-token 文件写入（0600 语义）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../helpers/http.js');
const { main: cliMain } = require('../../cli/index.js');

const PW = h.PASSWORD;

// 捕获 stdout/stderr 后执行 CLI（门禁/测试输出不被污染）
async function cli(s, argv, options) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const code = await cliMain(argv, { baseUrl: s.baseUrl, ...(options || {}) });
    return { code, out: logs.join('\n'), err: errs.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-p7-4-cli-')), name);
}

test('CLI-1 auth register --save-token：退出码 0 + token 落盘 + 可直接用于 me', async () => {
  await h.withServer(null, async (s) => {
    const tokenFile = tmpFile('token.txt');
    const u = h.uniqueName('cli');
    const reg = await cli(s, ['auth', 'register', '--user', u, '--pass', PW, '--nick', '命令行玩家', '--save-token', tokenFile]);
    assert.equal(reg.code, 0, reg.err);
    const saved = JSON.parse(reg.out);
    assert.equal(saved.savedToken, tokenFile);
    assert.equal(saved.nickname, '命令行玩家');
    assert.equal(fs.readFileSync(tokenFile, 'utf8').length >= 40, true, '--save-token 写入 token 明文（0600 语义）');
    const me = await cli(s, ['me', '--token', fs.readFileSync(tokenFile, 'utf8')]);
    assert.equal(me.code, 0, me.err);
    assert.equal(JSON.parse(me.out).publicId, saved.publicId);
    // 不带 --save-token：直接打印注册响应（含 token）
    const plain = await cli(s, ['auth', 'register', '--user', h.uniqueName('cli'), '--pass', PW]);
    assert.equal(plain.code, 0, plain.err);
    assert.equal(typeof JSON.parse(plain.out).token, 'string');
  });
});

test('CLI-2 auth 用法与业务负例：重名/弱密码 → 1；缺旗标/未知子命令/未知旗标 → 2', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('clidup'));
    const dup = await cli(s, ['auth', 'register', '--user', u.username, '--pass', PW]);
    assert.equal(dup.code, 1, dup.err);
    assert.match(dup.err, /username_taken/);
    const weak = await cli(s, ['auth', 'register', '--user', h.uniqueName('cliweak'), '--pass', 'short']);
    assert.equal(weak.code, 1);
    const missing = await cli(s, ['auth', 'register', '--user', u.username]);
    assert.equal(missing.code, 2);
    const noSub = await cli(s, ['auth']);
    assert.equal(noSub.code, 2);
    const bogusFlag = await cli(s, ['auth', 'login', '--user', u.username, '--pass', PW, '--oops', '1']);
    assert.equal(bogusFlag.code, 2);
    const noValue = await cli(s, ['auth', 'login', '--user', u.username, '--pass']);
    assert.equal(noValue.code, 2);
    const cpMissing = await cli(s, ['auth', 'change-password', '--old', PW]);
    assert.equal(cpMissing.code, 2);
  });
});

test('CLI-3 auth login/logout：登录 0；错密码 401 → 3；登出后旧 token → 3；无 token 登出 → 3', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('clilo'));
    const login = await cli(s, ['auth', 'login', '--user', u.username, '--pass', PW]);
    assert.equal(login.code, 0, login.err);
    const token = JSON.parse(login.out).token;
    assert.equal(typeof token, 'string');
    const wrong = await cli(s, ['auth', 'login', '--user', u.username, '--pass', 'wrong-password']);
    assert.equal(wrong.code, 3, wrong.err);
    assert.match(wrong.err, /invalid_credentials/);
    const out = await cli(s, ['auth', 'logout', '--token', token]);
    assert.equal(out.code, 0, out.err);
    assert.equal(JSON.parse(out.out).revoked, true);
    const after = await cli(s, ['me', '--token', token]);
    assert.equal(after.code, 3, '登出后 token 失效 → 未鉴权');
    const noToken = await cli(s, ['auth', 'logout']);
    assert.equal(noToken.code, 3, noToken.err);
    assert.match(noToken.err, /未鉴权/);
  });
});

test('CLI-4 auth change-password：正例 0 + 旧密码错 401 → 3', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('clicp'));
    const ok = await cli(s, ['auth', 'change-password', '--old', PW, '--new', 'brand-new-pw-9', '--token', u.token]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(JSON.parse(ok.out).changed, true);
    const relogin = await cli(s, ['auth', 'login', '--user', u.username, '--pass', 'brand-new-pw-9']);
    assert.equal(relogin.code, 0);
    const badOld = await cli(s, ['auth', 'change-password', '--old', 'not-the-old', '--new', 'another-pw-9', '--token', JSON.parse(relogin.out).token]);
    assert.equal(badOld.code, 3, badOld.err);
  });
});

test('CLI-5 me：缺 token 本地即 3；坏 token 服务端 401 → 3；DL_TOKEN 环境变量与 options.token 生效', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('clime'));
    const none = await cli(s, ['me']);
    assert.equal(none.code, 3);
    assert.match(none.err, /DL_TOKEN/);
    const bad = await cli(s, ['me', '--token', 'garbage-token']);
    assert.equal(bad.code, 3, bad.err);
    assert.match(bad.err, /unauthorized/);
    const prev = process.env.DL_TOKEN;
    try {
      process.env.DL_TOKEN = u.token;
      const viaEnv = await cli(s, ['me']);
      assert.equal(viaEnv.code, 0, viaEnv.err);
      assert.equal(JSON.parse(viaEnv.out).publicId, u.publicId);
    } finally {
      if (prev === undefined) delete process.env.DL_TOKEN; else process.env.DL_TOKEN = prev;
    }
    // 选项注入（进程内调用）优先于环境变量
    const viaOpts = await cli(s, ['me'], { token: u.token });
    assert.equal(viaOpts.code, 0, viaOpts.err);
    const usage = await cli(s, ['me', '--bogus', 'x']);
    assert.equal(usage.code, 2);
  });
});

test('CLI-6 quick run：无对手 409 → 1；缺 token → 3；双人池 → 0 且输出 battleId', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('cliq'));
    const alone = await cli(s, ['quick', 'run', '--token', a.token]);
    assert.equal(alone.code, 1, alone.err);
    assert.match(alone.err, /no_opponent/);
    const none = await cli(s, ['quick', 'run']);
    assert.equal(none.code, 3);
    const badSub = await cli(s, ['quick', 'fly', '--token', a.token]);
    assert.equal(badSub.code, 2);
    const badFlag = await cli(s, ['quick', 'run', '--token', a.token, '--x', '1']);
    assert.equal(badFlag.code, 2);
    await h.register(s.port, h.uniqueName('cliq'));
    const ok = await cli(s, ['quick', 'run', '--seed', '4242', '--token', a.token]);
    assert.equal(ok.code, 0, ok.err);
    const data = JSON.parse(ok.out);
    assert.match(data.battleId, /^b_[0-9a-f]{16}$/);
    assert.ok(Number.isInteger(data.seed) && data.seed >= 1, 'seed 回带（对局种子）');
    // 非法 seed 原样透传 → 服务端 400 → 退出码 1
    const badSeed = await cli(s, ['quick', 'run', '--seed', 'x', '--token', a.token]);
    assert.equal(badSeed.code, 1, badSeed.err);
    assert.match(badSeed.err, /bad_seed/);
  });
});

test('CLI-7 leaderboard：正例 0（无需 token）+ limit/scope 负例 → 1 + 未知旗标 → 2', async () => {
  await h.withServer(null, async (s) => {
    await h.register(s.port, h.uniqueName('clilb'));
    const ok = await cli(s, ['leaderboard']);
    assert.equal(ok.code, 0, ok.err);
    const data = JSON.parse(ok.out);
    assert.equal(data.scope, 'global');
    assert.ok(Array.isArray(data.rows));
    assert.ok(data.rows.length >= 1);
    const limited = await cli(s, ['leaderboard', '--limit', '1', '--scope', 'tier:common']);
    assert.equal(limited.code, 0, limited.err);
    assert.equal(JSON.parse(limited.out).rows.length, 1);
    const badLimit = await cli(s, ['leaderboard', '--limit', '0']);
    assert.equal(badLimit.code, 1, badLimit.err);
    assert.match(badLimit.err, /bad_request/);
    const badScope = await cli(s, ['leaderboard', '--scope', 'nope']);
    assert.equal(badScope.code, 1);
    assert.match(badScope.err, /bad_scope/);
    const usage = await cli(s, ['leaderboard', '--nope', '1']);
    assert.equal(usage.code, 2);
  });
});

test('CLI-8 ranked promote：遗留 --tier 口径 0 / 登录时读档案 0 / 段位不一致 403 → 1 / 缺 --tier 且未登录 → 2', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('clipr'));
    const legacy = await cli(s, ['ranked', 'promote', '--tier', 'common', '--wins', '7']);
    assert.equal(legacy.code, 0, legacy.err);
    assert.equal(JSON.parse(legacy.out).promoted, true);
    const archive = await cli(s, ['ranked', 'promote', '--wins', '7', '--token', u.token]);
    assert.equal(archive.code, 0, archive.err);
    assert.equal(JSON.parse(archive.out).tier, 'rare');
    const mismatch = await cli(s, ['ranked', 'promote', '--tier', 'mythic', '--wins', '7', '--token', u.token]);
    assert.equal(mismatch.code, 1, mismatch.err);
    assert.match(mismatch.err, /forbidden/);
    const noTier = await cli(s, ['ranked', 'promote', '--wins', '7']);
    assert.equal(noTier.code, 2, noTier.err);
    const badWins = await cli(s, ['ranked', 'promote', '--tier', 'common', '--wins', 'x']);
    assert.equal(badWins.code, 1);
    assert.match(badWins.err, /bad_wins/);
    const noSub = await cli(s, ['ranked', 'fly']);
    assert.equal(noSub.code, 2);
  });
});

test('CLI-9 --save-token 写失败 → 1（不静默成功）', async () => {
  await h.withServer(null, async (s) => {
    const bad = path.join(tmpFile('x'), 'no-such-dir', 'token.txt');
    const r = await cli(s, ['auth', 'register', '--user', h.uniqueName('clif'), '--pass', PW, '--save-token', bad]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /失败/);
  });
});

test('CLI-10 连接失败（服务未运行）→ 1；未知命令 → 2', async () => {
  await h.withServer(null, async (s) => {
    const dead = { baseUrl: `http://127.0.0.1:${s.port + 1}` };
    const logs = [];
    const errs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => logs.push(a.join(' '));
    console.error = (...a) => errs.push(a.join(' '));
    let code;
    try {
      code = await cliMain(['me', '--token', 'x'], dead);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.equal(code, 1, errs.join('\n'));
    assert.match(errs.join('\n'), /连接失败/);
    const unknown = await cli(s, ['bogus-command']);
    assert.equal(unknown.code, 2);
  });
});
