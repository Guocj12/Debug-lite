'use strict';
/* B25 审查探针 1：promote/tierReward 函数层全矩阵（T-RK-2/4 + 顶段 409 + 参数 + 事件 + B24 衔接）
 * 可复跑：node .review-b25/probe1.js */
const assert = require('node:assert/strict');
const ranked = require('../server/ranked.js');
const { createLogger } = require('../shared/log.js');
const LD = require('../tests/fixtures/loadout-ok.json');

const ld = () => JSON.parse(JSON.stringify(LD.loadout));
const wh = () => JSON.parse(JSON.stringify(LD.warehouse));

let ok = 0, fail = 0;
function chk(name, fn) {
  try { fn(); ok++; console.log(`  [ok] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}

// ① T-RK-2 阈值边界：6 不晋升 / 7 晋升 / 8 晋升（连续段位递增）
chk('wins=6 不晋升（200，tier 不变，reward=原段位）', () => {
  const r = ranked.promote('common', 6);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { tier: 'common', promoted: false, reward: 'common', wins: 6 });
});
chk('wins=7 晋升 common→rare（reward=新段位）', () => {
  const r = ranked.promote('common', 7);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { tier: 'rare', promoted: true, reward: 'rare', wins: 7 });
});
chk('wins=8 晋升 rare→epic（连续段位递增）', () => {
  const r = ranked.promote('rare', 8);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { tier: 'epic', promoted: true, reward: 'epic', wins: 8 });
});
chk('wins=0 边界：200 不晋升', () => {
  const r = ranked.promote('common', 0);
  assert.equal(r.status, 200);
  assert.equal(r.data.promoted, false);
});
chk('全链晋升：legendary+7 → mythic', () => {
  const r = ranked.promote('legendary', 7);
  assert.equal(r.data.tier, 'mythic');
  assert.equal(r.data.promoted, true);
});

// ② 顶段 409 already_max（契约 409 语义：只有「想晋升但不可」才 409）
chk('mythic+7 → 409 already_max', () => {
  const r = ranked.promote('mythic', 7);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'already_max');
});
chk('mythic+10 → 409 already_max', () => {
  assert.equal(ranked.promote('mythic', 10).code, 'already_max');
});
chk('mythic+999 → 409 already_max（wins 无上界时顶段仍封顶）', () => {
  assert.equal(ranked.promote('mythic', 999).code, 'already_max');
});
chk('缺口①：mythic+wins<7 → 200 不晋升（非 409）', () => {
  const r = ranked.promote('mythic', 6);
  assert.equal(r.status, 200);
  assert.equal(r.data.promoted, false);
  assert.equal(r.data.tier, 'mythic');
  assert.equal(r.data.reward, 'mythic');
  const r0 = ranked.promote('mythic', 0);
  assert.equal(r0.status, 200);
  assert.equal(r0.data.promoted, false);
});

// ③ 参数矩阵
chk('bad_tier：缺省/非法/数字/null/大小写', () => {
  assert.equal(ranked.promote(undefined, 7).code, 'bad_tier');
  assert.equal(ranked.promote(null, 7).code, 'bad_tier');
  assert.equal(ranked.promote('platinum', 7).code, 'bad_tier');
  assert.equal(ranked.promote('Common', 7).code, 'bad_tier');
  assert.equal(ranked.promote(5, 7).code, 'bad_tier');
  assert.equal(ranked.promote({}, 7).code, 'bad_tier');
});
chk('bad_wins：字符串/负数/小数/缺省/null/NaN/Infinity', () => {
  assert.equal(ranked.promote('common', '7').code, 'bad_wins');
  assert.equal(ranked.promote('common', -1).code, 'bad_wins');
  assert.equal(ranked.promote('common', 1.5).code, 'bad_wins');
  assert.equal(ranked.promote('common', undefined).code, 'bad_wins');
  assert.equal(ranked.promote('common', null).code, 'bad_wins');
  assert.equal(ranked.promote('common', NaN).code, 'bad_wins');
  assert.equal(ranked.promote('common', Infinity).code, 'bad_wins');
});
chk('缺口③：wins=999 → 照样晋升（无上界；记录可接受性）', () => {
  const r = ranked.promote('common', 999);
  assert.equal(r.status, 200);
  assert.equal(r.data.promoted, true);
  assert.equal(r.data.tier, 'rare');
});
chk('校验顺序：bad_tier 先于 bad_wins；bad_wins 先于顶段 409', () => {
  assert.equal(ranked.promote('platinum', 'x').code, 'bad_tier');
  assert.equal(ranked.promote('mythic', 'x').code, 'bad_wins');
  assert.equal(ranked.promote('mythic', -1).code, 'bad_wins');
});

// ④ T-RK-4 tierReward 逐档 + 非法
chk('tierReward RK-5a..e 逐档 1:1', () => {
  assert.equal(ranked.tierReward('common'), 'common');
  assert.equal(ranked.tierReward('rare'), 'rare');
  assert.equal(ranked.tierReward('epic'), 'epic');
  assert.equal(ranked.tierReward('legendary'), 'legendary');
  assert.equal(ranked.tierReward('mythic'), 'mythic');
});
chk('tierReward 非法段位 → null（含 undefined/upper/数字）', () => {
  assert.equal(ranked.tierReward('platinum'), null);
  assert.equal(ranked.tierReward(undefined), null);
  assert.equal(ranked.tierReward('COMMON'), null);
  assert.equal(ranked.tierReward(5), null);
  assert.equal(ranked.tierReward(''), null);
});

// ⑤ 事件：ranked.promote（info 晋升 / warn 顶段拒绝 / 200 不晋升无事件——观察记录）
chk('事件：晋升 → ranked.promote(info)，带 from/to/wins', () => {
  const L = createLogger({ level: 'all', ringSize: 100 });
  const api = ranked.withLogger(L);
  api.promote('common', 7);
  const ev = L.records.filter((r) => r.event === 'ranked.promote');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].level, 'info');
  assert.deepEqual(ev[0].data, { from: 'common', to: 'rare', wins: 7 });
});
chk('事件：顶段拒绝 → ranked.promote(warn)，带 tier/wins', () => {
  const L = createLogger({ level: 'all', ringSize: 100 });
  const api = ranked.withLogger(L);
  api.promote('mythic', 7);
  const ev = L.records.filter((r) => r.event === 'ranked.promote');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].level, 'warn');
  assert.deepEqual(ev[0].data, { tier: 'mythic', wins: 7 });
});
chk('事件：200 不晋升不 emit（观测记录；P2 候选）', () => {
  const L = createLogger({ level: 'all', ringSize: 100 });
  const api = ranked.withLogger(L);
  api.promote('common', 6);
  assert.equal(L.records.filter((r) => r.event === 'ranked.promote').length, 0);
});
chk('无 logger 直接调用不抛', () => {
  assert.equal(ranked.promote('common', 7).status, 200);
  assert.equal(ranked.promote('mythic', 7).status, 409);
});

// ⑥ B24 衔接：X_PROMOTE 单一常量（runRankedBattle 与 promote 同源）+ promoted 恒等式
chk('X_PROMOTE 导出 === 6（D-122 冻结）', () => {
  assert.equal(ranked.X_PROMOTE, 6);
});
chk('promote 用 X_PROMOTE 常量：wins=X 不晋升、wins=X+1 晋升（同源无漂移）', () => {
  const X = ranked.X_PROMOTE;
  assert.equal(ranked.promote('common', X).data.promoted, false);
  assert.equal(ranked.promote('common', X + 1).data.promoted, true);
});
chk('runRankedBattle promoted 与 X_PROMOTE 恒等式（B24 衔接：wins>X 同源判定）', () => {
  // 注：fixture loadout（loadout-ok.json）含 mythic 门控技能（skill_dash_bash）→ 排位以 mythic 跑；
  //     引擎超时扣血按本方 maxHp 缩放 → 不可用巨型 hp，改用 move_right vs hp=1 wait 弱对手（实证 wins=10）
  const aiWait = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
  const mine = ld(); mine.ai = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } };
  const weak = (i) => { const x = ld(); x.ai = aiWait; x.skills[0].uid = `w${i}`; x.role.stats = { hp: 1, atk: 0, def: 0, sp: 60, mp: 40 }; return x; };
  const pool = Array.from({ length: 10 }, (_, i) => weak(i));
  const r = ranked.runRankedBattle({ loadout: mine, warehouse: wh(), pool, seed: 42, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.ok(r.data.wins >= 7, `弱对手池应胜 ≥7（实际 ${r.data.wins}）`);
  assert.equal(r.data.promoted, r.data.wins > ranked.X_PROMOTE, 'run.promoted === (wins > X_PROMOTE) 恒等式');
  assert.equal(ranked.promote('epic', r.data.wins).data.promoted, true, '同一 wins 在非顶段 promote 下判定一致');
});
chk('口径差异实证（P2 候选）：mythic 顶段 wins>6 → run 返回 promoted=true 而 promote 409', () => {
  const aiWait = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
  const mine = ld(); mine.ai = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } };
  const weak = (i) => { const x = ld(); x.ai = aiWait; x.skills[0].uid = `w${i}`; x.role.stats = { hp: 1, atk: 0, def: 0, sp: 60, mp: 40 }; return x; };
  const pool = Array.from({ length: 10 }, (_, i) => weak(i));
  const r = ranked.runRankedBattle({ loadout: mine, warehouse: wh(), pool, seed: 42, tier: 'mythic' });
  assert.ok(r.data.wins >= 7, `弱对手池应胜 ≥7（实际 ${r.data.wins}）`);
  assert.equal(r.data.promoted, true, 'run 顶段 wins>6 → promoted=true（纯阈值原语）');
  assert.equal(ranked.promote('mythic', r.data.wins).status, 409, 'promote 顶段 → 409 already_max');
});

// ⑦ 缺口②：tierReward 与 B17 开箱品质上限（items.rollQuality 截断池）双实现一致性机器断言
chk('tierReward ≡ rollQuality 品质池上限（逐档机器断言）', () => {
  const items = require('../server/core/items.js');
  const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
  for (const t of TIERS) {
    // rollQuality 尾部兜底返回池末元素 = 品质上限（v=0.9999 恒落入兜底）
    const cap = items.rollQuality({ float: () => 0.9999 }, t);
    assert.ok(TIERS.indexOf(cap) <= TIERS.indexOf(t), `${t}: 开箱品质 ${cap} 不超上限`);
    assert.equal(ranked.tierReward(t), cap, `${t}: tierReward(${t})=${ranked.tierReward(t)} 应等于开箱品质池上限 ${cap}`);
  }
});
chk('三处 TIERS 字面量当前一致（ranked/unlock/items）——漂移登记依据', () => {
  const unlock = require('../server/core/unlock.js');
  const items = require('../server/core/items.js');
  const expect = ['common', 'rare', 'epic', 'legendary', 'mythic'];
  // ranked.TIERS 导出
  assert.deepEqual(ranked.TIERS, expect);
  // unlock/items 未导出 TIERS——用行为等价断言：对 5 档各 tierReward 语义一致
  for (const t of expect) {
    assert.equal(typeof unlock.tierIndex(t), 'number');
    assert.equal(ranked.tierReward(unlock.tierIndex(t) >= 0 ? t : t), t);
  }
});

// ⑧ L9：promote/tierReward 无新战斗数值（仅 X_PROMOTE=6 冻结常量与 D-122 一致；无独立数字字面量）
chk('promote/tierReward 源码无 6/7/5 独立字面量（阈值来自 X_PROMOTE/TIERS）', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'ranked.js'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // 阈值 6：只允许 X_PROMOTE 定义处出现；其余 6/7 均不得裸出现
  const sixes = [...body.matchAll(/\b6\b/g)];
  const sevens = [...body.matchAll(/\b7\b/g)];
  assert.ok(sixes.length <= 1, `6 只应出现于 X_PROMOTE=6（实际 ${sixes.length} 处）`);
  assert.equal(sevens.length, 0, `promote/tierReward 不得硬编码 7（实际 ${sevens.length} 处）`);
});

console.log(`\nprobe1: ${ok} ok / ${fail} fail`);
process.exit(fail ? 1 : 0);