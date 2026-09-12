'use strict';
/* .review-b17/boxseed.js —— B17 独立复核：种子确定性与每箱独立流
 * ① 同 seed 两次开箱：内容级一致但 uid 不同（进程级自增）——判定「同 seed 可复现」口径；
 * ② 每箱独立流：times=2 与 times=3 的前两箱内容一致（deriveStream(i,'box') 各自独立不串流）；
 * ③ 缺 seed 生成回带；④ 非法 seed/times 在 helper 层的行为（400 码）；⑤ 409 RangeError 映射与非 RangeError 抛穿。
 */
const box = require('../server/box.js');
const items = require('../server/core/items.js');
const { createRng } = require('../server/core/rng.js');

function contentOf(item) {
  const c = { kind: item.kind, templateId: item.templateId, quality: item.quality, slotCount: item.slotCount };
  if (item.params) c.params = JSON.stringify(item.params);
  if (item.stats) c.stats = JSON.stringify(item.stats);
  return c;
}

console.log('== ① 同 seed 两次开箱：内容 vs uid ==');
{
  const a = box.openBoxes({ seed: 424242, tier: 'epic', times: 6 });
  const b = box.openBoxes({ seed: 424242, tier: 'epic', times: 6 });
  const aContent = a.data.items.map(contentOf);
  const bContent = b.data.items.map(contentOf);
  const sameContent = JSON.stringify(aContent) === JSON.stringify(bContent);
  const sameUid = JSON.stringify(a.data.items.map((x) => x.uid)) === JSON.stringify(b.data.items.map((x) => x.uid));
  const uidUnique = new Set(a.data.items.map((x) => x.uid)).size === a.data.items.length;
  console.log(`内容一致=${sameContent}；uid 全同=${sameUid}；单批内 uid 唯一=${uidUnique}`);
  console.log(`uid 样例：${a.data.items.map((x) => x.uid).join(',')}`);
  console.log(`另一批 uid：${b.data.items.map((x) => x.uid).join(',')}`);
}

console.log('== ② 每箱独立流：times=2 与 times=3 前两箱内容 ==');
{
  const two = box.openBoxes({ seed: 777, tier: 'rare', times: 2 });
  const three = box.openBoxes({ seed: 777, tier: 'rare', times: 3 });
  const eq = JSON.stringify(two.data.items.map(contentOf)) === JSON.stringify(three.data.items.slice(0, 2).map(contentOf));
  console.log(`times=2 与 times=3 前两箱内容一致=${eq}`);
  // 第三箱是否与「第 2 箱直接续抽」不同（独立流证据：直接比较 deriveStream(2,'box') 生成的单箱）
  const direct = items.openBox(createRng(777).deriveStream(2, 'box'), { tier: 'rare' });
  console.log(`times=3 第三箱 == deriveStream(2,'box') 直抽：${JSON.stringify(three.data.items[2].templateId)} vs ${JSON.stringify(direct.templateId)} 质量 ${three.data.items[2].quality}/${direct.quality}`);
}

console.log('== ③ 缺 seed 回带 ==');
{
  const r = box.openBoxes({ tier: 'common', times: 1 });
  console.log(`status=${r.status} seed=${r.data.seed}（整数≥1: ${Number.isInteger(r.data.seed) && r.data.seed >= 1}）`);
}

console.log('== ④ 参数校验矩阵 ==');
{
  const cases = [
    ['tier=diamond', { tier: 'diamond' }],
    ['times=0', { times: 0 }],
    ['times=101', { times: 101 }],
    ['times=1.5', { times: 1.5 }],
    ['times="5"', { times: '5' }],
    ['seed=0', { seed: 0 }],
    ['seed=-3', { seed: -3 }],
    ['seed="abc"', { seed: 'abc' }],
    ['seed=3.5', { seed: 3.5 }],
  ];
  for (const [name, o] of cases) {
    const r = box.openBoxes(o);
    console.log(`${name} → status=${r.status} code=${r.code}`);
  }
  // 边界正例
  console.log(`times=1 → ${box.openBoxes({ tier: 'common', times: 1 }).status}`);
  console.log(`times=100 → ${box.openBoxes({ tier: 'common', times: 100 }).status}`);
  console.log(`seed=2147483647 → ${box.openBoxes({ seed: 2147483647, times: 1 }).status}`);
  console.log(`seed=4294967296（≥2^32，回绕检查）→ code=${box.openBoxes({ seed: 4294967296, tier: 'common', times: 1 }).code} status=${box.openBoxes({ seed: 4294967296, tier: 'common', times: 1 }).status}`);
  const s1 = box.openBoxes({ seed: 1, tier: 'common', times: 1 });
  const sWrap = box.openBoxes({ seed: 4294967297, tier: 'common', times: 1 }); // 2^32+1 >>> 0 = 1
  console.log(`seed=4294967297（≡seed=1 的流）内容与 seed=1 相同：${JSON.stringify(s1.data.items.map(contentOf)) === JSON.stringify(sWrap.data.items.map(contentOf))}（响应回带各自原值 1 / 4294967297）`);
}

console.log('== ⑤ 409 映射 / 抛穿 ==');
{
  const stubEmpty = { openBox: () => { throw new RangeError('该段位无可用角色模板'); } };
  const r = box.openBoxes({ seed: 1, tier: 'rare', times: 1, items: stubEmpty });
  console.log(`空池 RangeError → status=${r.status} code=${r.code} message=${r.message}`);
  try {
    box.openBoxes({ seed: 1, tier: 'rare', times: 1, items: { openBox: () => { throw new TypeError('boom'); } } });
    console.log('非 RangeError → 未抛穿（异常！）');
  } catch (e) {
    console.log(`非 RangeError → 抛穿 ${e.constructor.name}（符合预期）`);
  }
}

console.log('== ⑥ 各段位掉落池非空（数据事实 + 实测）==');
{
  // 确定性数据事实：按 unlockTier 逐档统计 role/skill/plugin 池大小
  const ROLES = require('../server/data/role-templates.json').roleTemplates;
  const SKILLS = require('../server/data/skill-templates.json').skillTemplates;
  const PLUGINS = require('../server/data/plugins.json').plugins;
  const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
  const idx = TIERS.indexOf.bind(TIERS);
  const gate = (x, tier) => x.unlockTier === undefined || x.unlockTier === null || idx(x.unlockTier) !== -1 && idx(x.unlockTier) <= idx(tier);
  for (const tier of TIERS) {
    const nr = ROLES.filter((x) => gate(x, tier)).length;
    const ns = SKILLS.filter((x) => gate(x, tier)).length;
    const np = PLUGINS.filter((x) => gate(x, tier)).length;
    console.log(`tier=${tier} → role 池 ${nr} / skill 池 ${ns} / plugin 池 ${np}（role_bal=${ROLES[0].unlockTier}, skill_melee_whirl=${SKILLS[0].unlockTier}, skill_straight_precise=${SKILLS[2].unlockTier}）`);
  }
  for (const tier of ['common', 'rare', 'epic', 'legendary', 'mythic']) {
    const r = box.openBoxes({ seed: 1, tier, times: 100 });
    const kinds = new Set(r.data.items.map((x) => x.kind));
    const quals = new Set(r.data.items.map((x) => x.quality));
    console.log(`实测 tier=${tier} 100 箱 → kinds=${[...kinds].join(',')} qualities=${[...quals].join(',')}`);
  }
}