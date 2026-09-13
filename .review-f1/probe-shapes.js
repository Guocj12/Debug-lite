// Red-team F1 probe: P1-1/P1-2 定案三连（真实后端契约形状 vs 前端 reducer 假设）
// 用法: node .review-f1/probe-shapes.js  —— 全绿 = 缺陷仍然存在（退出码 1 表示缺陷被证实）
// ① /box data.items 是数组（每元素带 kind），前端 box/done 按分桶对象索引 → 永不合并
// ② emptyWarehouse 权威形状是 {buckets:{role,skill,rolePlugin,skillPlugin}}
// ③ 前端扁平仓库 {role:[]...} 走服务端 assemble → item_missing（findItem 读 wh.buckets）
const boxApi = require('../server/box.js');
const items = require('../server/core/items.js');
let bad = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) bad++; };

(async () => {
  // ① /box 响应形状
  const r = boxApi.openBoxes({ seed: 12345, tier: 'epic', times: 3, logger: null });
  ok('box data.items is Array', Array.isArray(r.data.items));
  ok('box item carries kind', typeof r.data.items[0].kind === 'string');
  // 前端 reducer 行为（现状）
  const { reducer, initialState } = await import('../public/js/store/reducer.js');
  let s = reducer(initialState(), { type: 'box/open', payload: { times: 3 } });
  let s2 = reducer(s, { type: 'box/done', payload: { ok: true, data: r.data } });
  const merged = ['role', 'skill', 'rolePlugin', 'skillPlugin'].reduce((a, b) => a + s2.warehouse[b].length, 0);
  ok('reducer merges real /box items into warehouse (P1-2: expect FAIL=0 merged)', merged > 0);
  console.log(`  merged count = ${merged}（任务书声称分桶合并；现状 0 = P1-2 证实）`);

  // ② 仓库权威形状
  const ew = items.emptyWarehouse();
  ok('emptyWarehouse has buckets wrapper', !!ew.buckets && Array.isArray(ew.buckets.role));
  console.log('  emptyWarehouse =', JSON.stringify(ew));

  // ③ 前端扁平仓库 → 服务端 assemble
  const flat = { role: [{ uid: 'item_1', kind: 'role' }], skill: [], rolePlugin: [], skillPlugin: [] };
  const a1 = items.assemble(flat, { targetUid: 'item_1', pluginUid: 'x', slotIndex: 0 });
  ok('assemble(flat frontend wh) rejects item_missing (P1-1: expect FAIL, i.e. rejects)', a1.code === 'item_missing');
  const bk = { buckets: { role: [{ uid: 'item_1', kind: 'role' }], skill: [], rolePlugin: [], skillPlugin: [] } };
  const a2 = items.assemble(bk, { targetUid: 'item_1', pluginUid: 'y', slotIndex: 0 });
  ok('assemble(backend wh) passes target lookup (fails only at plugin)', a2.code === 'item_missing' && a2.message.includes('插件'));
  // 扁平仓库被 wh/replaced 装入后，box/done 的展开崩溃面
  const s3 = reducer(s2, { type: 'wh/replaced', payload: { warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } } });
  let crashed = false;
  try { reducer(s3, { type: 'box/done', payload: { ok: true, data: { seed: 3, items: [{ kind: 'role' }] } } }); } catch (e) { crashed = true; }
  ok('box/done(array items) after wh/replaced does NOT crash (current shape interplay)', !crashed);
  // 潜伏崩溃面：分桶形状 items（当前测试夹具形状）+ {buckets} 仓库 → [...undefined] TypeError
  let crashed2 = false;
  try { reducer(s3, { type: 'box/done', payload: { ok: true, data: { seed: 3, items: { role: [{ kind: 'role' }] } } } }); } catch (e) { crashed2 = true; }
  ok('box/done(bucketed items) after wh/replaced crashes with TypeError (P1-1b latent surface)', crashed2);

  console.log(bad === 0 ? 'probe-shapes: 全部通过（现状形状与后端契约一致）' : `probe-shapes: ${bad} 项证实缺陷（P1-1/P1-2 修复前预期）`);
  process.exit(0);
})();