'use strict';
// B22 回放帧契约测试 —— 依据 interfaces §4.3（frame = tick + diff{players,bullets,bases,events,aiTrace}，1px + cid）；
// tasks §3.2 T-BT-1（帧可重建状态：累积 diff == battle.state，随机 20 tick）+ T-EN-9（diff 字段齐备）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../../server/core/engine.js');
const battle = require('../../server/battle.js');
const battleApi = require('../../server/battle.js');
const LD = require('../fixtures/loadout-ok.json');

const mk = (P, atk) => ({
  id: P, owner: P, x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1,
  hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60,
  atk: atk || 12, def: 8, regen: { mp: 1, sp: 2 }, special: {},
  cooldowns: {}, effects: [],
});

test('T-EN-9/diff 字段齐备：players/bullets/bases/events/aiTrace + 1px 位置 + 事件带 tick/cid + 链事件', () => {
  const { createLogger } = require('../../shared/log.js');
  const eventsBuf = [];
  const battleLogger = createLogger({ level: 'all', ringSize: 20000, now: () => 0, onRecord: (r) => eventsBuf.push(r) });
  const b = engine.createBattle(undefined, { seed: 21, players: { p1: mk('p1', 20), p2: mk('p2', 20) }, logger: battleLogger });
  const buf = [];
  // 相向移动 → 碰撞伤害链（move.resolve/collision.resolve/damage.calc）+ tick 事件
  const r = b.runFull({ actions: { aiTrace: buf, p1: (s) => { buf.push({ tick: s.tick, owner: 'p1', seq: 1 }); return 'move_right'; }, p2: () => 'move_left' }, eventsBuf });
  assert.ok(r.diffs.length >= 1);
  const allEvents = [];
  for (const d of r.diffs) {
    for (const k of ['tick', 'players', 'bullets', 'bases', 'events', 'aiTrace', 'collision', 'bulletHits', 'verdict']) {
      assert.ok(k in d, `diff 缺字段 ${k}`);
    }
    for (const owner of ['p1', 'p2']) {
      for (const v of [d.players[owner].fromX, d.players[owner].toX]) assert.ok(Number.isInteger(v), `${owner} 位置 1px`);
    }
    for (const e of d.events) {
      assert.equal(typeof e.event, 'string', '事件带 event');
      assert.equal(e.tick, d.tick, `diff.events 归属于本 tick（cid/tick 提升契约）`);
      assert.ok(typeof e.cid === 'string' && e.cid.startsWith(`t${d.tick}:`), `事件带 cid（t${d.tick}:seq，B22 P1-1）`);
      allEvents.push(e.event);
    }
    assert.ok(Array.isArray(d.bullets), 'bullets 数组');
    assert.ok(d.bases && typeof d.bases === 'object' && 'hp' in d.bases.p1 && 'hp' in d.bases.p2, 'bases 按 p1/p2 分侧（含 hp/def）');
  }
  // 链事件齐备（§4.3 契约不再空心化）：碰撞链路 + tick 完成
  assert.ok(allEvents.includes('collision.resolve'), '引擎链事件（collision.resolve）');
  assert.ok(allEvents.includes('damage.calc'), '链事件（damage.calc）');
  assert.ok(allEvents.includes('move.resolve'), '链事件（move.resolve）');
  assert.ok(allEvents.includes('tick.end'), 'tick.end');
  assert.ok(allEvents.includes('tick.begin'), 'tick.begin');
});

test('T-BT-1 帧可重建状态：累积 diff 重建 == 逐步 step 的 battle.state（随机抽 20 tick）', () => {
  const b = engine.createBattle(undefined, { seed: 31, players: { p1: mk('p1', 20), p2: mk('p2', 20) } });
  const eventsBuf = [];
  const buf = [];
  const diffs = [];
  const states = []; // 每 tick 的 state 快照（runFull 后 state 即终态，必须在 step 时对拍）
  for (let i = 0; i < 64; i++) {
    const d = b.step({ actions: { aiTrace: buf, p1: () => 'move_right', p2: () => 'move_left' }, eventsBuf });
    diffs.push(d);
    const st = b.state;
    states.push({
      p1: { x: st.players.p1.x, hp: st.players.p1.hp, mp: st.players.p1.mp, sp: st.players.p1.sp, facing: st.players.p1.facing },
      p2: { x: st.players.p2.x, hp: st.players.p2.hp, mp: st.players.p2.mp, sp: st.players.p2.sp, facing: st.players.p2.facing },
      bases: { p1: st.bases.p1.hp, p2: st.bases.p2.hp },
    });
    if (b.state.verdict) break;
  }
  assert.ok(diffs.length >= 1);
  // 确定性采样 20 tick
  const sample = new Set();
  for (let i = 1; i <= 20; i++) sample.add(Math.min(diffs.length, Math.ceil((i * diffs.length) / 20)));
  const rebuilt = {
    p1: { x: 224, hp: 100, mp: 40, sp: 60, facing: 1 },
    p2: { x: 800, hp: 100, mp: 40, sp: 60, facing: -1 },
    bases: { p1: 100, p2: 100 },
  };
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i];
    rebuilt.p1 = { x: d.players.p1.toX, hp: d.players.p1.hp, mp: d.players.p1.mp, sp: d.players.p1.sp, facing: d.players.p1.facing };
    rebuilt.p2 = { x: d.players.p2.toX, hp: d.players.p2.hp, mp: d.players.p2.mp, sp: d.players.p2.sp, facing: d.players.p2.facing };
    rebuilt.bases.p1 = d.bases.p1.hp;
    rebuilt.bases.p2 = d.bases.p2.hp;
    if (sample.has(d.tick)) {
      assert.deepEqual(rebuilt, states[i], `tick ${d.tick} 帧可重建（T-BT-1）`);
    }
  }
});

test('battle.buildPlayer：面板聚合（角色 22/150 + 技能消耗补偿 mp16）进战斗运行时', () => {
  const r = battleApi.buildPlayer('p1', LD.loadout, LD.warehouse, 'mythic');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const p = r.player;
  assert.equal(p.hp, 150, '角色面板 hp（hp_flat +50）');
  assert.equal(p.atk, 22, 'atk_pct 10% → 22');
  assert.equal(p.skills.skill1.cost.mp, 16, '技能聚合参数（sp_mult rare tier2 → +6）');
  assert.equal(p.skills.skill1.multiplier, 1.38);
  assert.equal(p.x, 224, 'startX 入位');
  const r2 = battleApi.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 7, tier: 'mythic' });
  assert.equal(r2.status, 200);
  assert.ok(r2.data.frames.length === r2.data.ticks && r2.data.frames.length > 0);
  assert.equal(typeof r2.data.id, 'string');
  // 回放读取：全量 + 分片
  const full = battleApi.getReplay(r2.data.id);
  assert.equal(full.status, 200);
  assert.equal(full.data.frames.length, r2.data.ticks);
  const slice = battleApi.getReplay(r2.data.id, 2, 4);
  assert.equal(slice.data.frames.length, 3);
  assert.equal(slice.data.frames[0].tick, 2);
  assert.equal(battleApi.getReplay('nope').status, 404);
});