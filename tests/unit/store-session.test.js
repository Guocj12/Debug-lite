'use strict';
/* tests/unit/store-session.test.js —— 会话表持久化（D-129 §4.3；可丢弃：损坏=全员登出） */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sessMod = require('../../server/store/session-table.js');
const { nullLogger } = require('../../shared/log.js');

const DAY = 86400000;
const PID = 'pl_1111111111111111';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-session-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function table(dir, config) {
  return sessMod.createSessionTable({
    file: path.join(dir, 'sessions.json'), logger: nullLogger, config: config || { session: { maxPerPlayer: 5 } },
  });
}

test('SES-1 落盘往返；缺文件/损坏文件 → 空表（可丢弃）', () => {
  const dir = mkTmp();
  try {
    const t = table(dir);
    assert.equal(t.load(), 0);
    t.put({ tokenHash: 'a', playerId: PID, createdAt: 1, expiresAt: Date.now() + DAY });
    t.put({ tokenHash: 'b', playerId: PID, createdAt: 2, expiresAt: Date.now() + DAY });
    assert.equal(fs.existsSync(t.file), true);
    const reloaded = table(dir);
    assert.equal(reloaded.load(), 2);
    assert.equal(reloaded.get('a').playerId, PID);
    // 损坏 → 空表 + store.error
    fs.writeFileSync(t.file, '{bad', 'utf8');
    const errors = [];
    const broken = sessMod.createSessionTable({
      file: t.file,
      logger: { error: (ch, ev) => errors.push(ev), info: () => {}, debug: () => {}, warn: () => {}, trace: () => {}, log: () => {} },
      config: {},
    });
    assert.equal(broken.load(), 0);
    assert.deepEqual(errors, ['store.error']);
    // JSON 合法但结构不对 → 同样空表
    fs.writeFileSync(t.file, JSON.stringify({ sessions: 'nope' }), 'utf8');
    assert.equal(table(dir).load(), 0);
    // 条目缺 tokenHash → 跳过
    fs.writeFileSync(t.file, JSON.stringify({ sessions: [{ playerId: PID }, { tokenHash: 'ok', playerId: PID }] }), 'utf8');
    assert.equal(table(dir).load(), 1);
    assert.ok(sessMod.SESSION_VERSION === 1 && sessMod.MS_PER_DAY === DAY);
  } finally {
    rmTmp(dir);
  }
});

test('SES-2 maxPerPlayer 淘汰最旧（按 lastUsedAt/createdAt）；touch 刷新使用时间', () => {
  const dir = mkTmp();
  try {
    const t = table(dir, { session: { maxPerPlayer: 2 } });
    const now = Date.now();
    t.put({ tokenHash: 't1', playerId: PID, createdAt: now + 1, expiresAt: now + DAY });
    t.put({ tokenHash: 't2', playerId: PID, createdAt: now + 2, expiresAt: now + DAY });
    t.touch('t1', { lastUsedAt: now + 100 });
    t.put({ tokenHash: 't3', playerId: PID, createdAt: now + 3, expiresAt: now + DAY });
    assert.equal(t.size(), 2);
    assert.equal(t.get('t2'), null, '最旧（t2 lastUsedAt 未刷新）被淘汰');
    assert.ok(t.get('t1') && t.get('t3'));
    assert.equal(t.maxPerPlayer, 2);
    assert.equal(t.touch('nope', {}), null);
    assert.equal(t.stats().sessions, 2);
    assert.equal(t.stats().players, 1);
    // 非法记录
    assert.throws(() => t.put({ playerId: PID }), (e) => e.code === 'bad_request');
  } finally {
    rmTmp(dir);
  }
});

test('SES-3 TTL 过期：get 读取即失效并落盘；prune 批量清理', () => {
  const dir = mkTmp();
  try {
    const t = table(dir);
    const now = Date.now();
    t.put({ tokenHash: 'exp', playerId: PID, createdAt: now - DAY, expiresAt: now - 1 });
    t.put({ tokenHash: 'live', playerId: PID, createdAt: now, expiresAt: now + DAY });
    assert.equal(t.get('exp'), null);
    assert.equal(t.size(), 1, '过期会话被删除');
    assert.equal(t.get('live').tokenHash, 'live');
    t.put({ tokenHash: 'x1', playerId: PID, createdAt: now, expiresAt: now + 1 });
    t.put({ tokenHash: 'x2', playerId: PID, createdAt: now, expiresAt: now + 2 });
    const pruned = t.prune(now + 2);
    assert.equal(pruned.removed, 2);
    assert.equal(pruned.remaining, 1);
    assert.equal(t.prune(now).removed, 0);
  } finally {
    rmTmp(dir);
  }
});

test('SES-4 revoke / revokePlayer（keep）/ list / all', () => {
  const dir = mkTmp();
  try {
    const t = table(dir);
    const now = Date.now();
    t.put({ tokenHash: 'a', playerId: PID, createdAt: now, expiresAt: now + DAY });
    t.put({ tokenHash: 'b', playerId: PID, createdAt: now + 1, expiresAt: now + DAY });
    t.put({ tokenHash: 'c', playerId: 'pl_2222222222222222', createdAt: now + 2, expiresAt: now + DAY });
    const res = t.revokePlayer(PID, { keepTokenHash: 'b' });
    assert.equal(res.revoked, 1, 'a 被撤销，b 保留');
    assert.equal(t.revoke('a'), false, '已撤销的 token 再撤销返回 false');
    assert.ok(t.get('b'));
    assert.equal(t.revoke('b'), true);
    assert.equal(t.revokePlayer('pl_9999999999999999').revoked, 0);
    assert.equal(t.list(PID).length, 0);
    assert.equal(t.all().length, 1);
    assert.deepEqual(t.all().map((r) => r.tokenHash), ['c']);
    assert.deepEqual(t.list('pl_2222222222222222').map((r) => r.tokenHash), ['c']);
  } finally {
    rmTmp(dir);
  }
});
