'use strict';
/* B20 独立审查探针（.review-b20/，非测试代码路径，可复跑）
 * 验证点：
 *   A. 面板聚合输出完整转储（fixture）：s1 有插件 vs s2/s3 无插件 的 params 字段集差异
 *   B. 数据数组值 vs 实现公式偏差实证：sp_mult rare tier3 → delta=9（数组字面 tier3=6）
 *   C. skillPlugin 引用门控：legendary 技能插件引用 + rare → 拒绝（refs 路径）
 *   D. 缺 tier 插件 → 补偿静默跳过（防御分支形态）
 *   E. 白名单投影：有插件路径丢弃非白名单参数（归一化实证）
 *   F. 多插件聚合（双槽技能装 sp_mult + sp_cooldown）
 *   G. 减耗类面板聚合（sp_cost_down ceil）
 */
const items = require('../server/core/items.js');
const skills = require('../server/core/skills.js');
const loadout = require('../server/loadout.js');
const LD = require('../tests/fixtures/loadout-ok.json');
const PLUGINS = require('../server/data/plugins.json').plugins;

const out = [];
const log = (tag, x) => { out.push(`[${tag}] ${typeof x === 'string' ? x : JSON.stringify(x)}`); };

// A. 面板完整转储
const p = loadout.buildPanel(LD.loadout, { warehouse: LD.warehouse, tier: 'mythic' });
log('A.panel.skills[0].params', p.panel.skills[0].params);   // 有插件（qx）
log('A.panel.skills[1].params', p.panel.skills[1].params);   // 无插件
log('A.panel.skills[2].params', p.panel.skills[2].params);   // 无插件
log('A.s1 keys', Object.keys(p.panel.skills[0].params).sort().join(','));
log('A.s2 keys', Object.keys(p.panel.skills[1].params).sort().join(','));

// B. 公式 vs 数组字面值（rare tier3 的 sp_mult：数组说 tier3=6，公式 costDeltaBase.rare=3 → 9）
const mk = (id, tier, quality, extra) => {
  const def = PLUGINS.find((x) => x.id === id);
  return Object.assign({ uid: 'px', kind: 'skillPlugin', id, slot: def.slot, quality, tier,
    affixes: def.affixes, costDeltaByTier: def.costDeltaByTier }, extra || {});
};
const base = { type: 'straight', cost: { hp: 0, mp: 10, sp: 0 }, multiplier: 1.2, cooldown: 3, bulletLevel: 3, range: 10, bulletCount: 3, affixes: [] };
log('B.rare tier3 sp_mult cost.mp (公式 10+9=19, 数组字面 10+6=16)', skills.applySkillPlugins({ ...base }, [mk('sp_mult', 3, 'rare')]).cost.mp);
log('B.common tier2 sp_mult cost.mp (公式 10+4=14 == 数组字面 [2,4,6] 第2档=4)', skills.applySkillPlugins({ ...base }, [mk('sp_mult', 2, 'common')]).cost.mp);

// C. legendary 技能插件引用 + rare → validateLoadout 拒绝（refs 门控对 skillPlugin 生效）
const LD2 = JSON.parse(JSON.stringify(LD));
LD2.loadout.skills[0].slots = [{ type: 'basic', pluginUid: 'lx' }];
LD2.warehouse.buckets.skillPlugin[0] = { uid: 'lx', kind: 'skillPlugin', id: 'sp_displacement', slot: 'basic', quality: 'legendary', tier: 1, affixes: [], costDeltaByTier: { sp: [2, 4, 6] }, unlockTier: 'legendary', equipped: true };
log('C.skillPlugin ref gate @rare', JSON.stringify(loadout.validateLoadout(LD2.loadout, { warehouse: LD2.warehouse, tier: 'rare' })));
log('C.skillPlugin ref gate @legendary', JSON.stringify(loadout.validateLoadout(LD2.loadout, { warehouse: LD2.warehouse, tier: 'legendary' })));

// D. 缺 tier 插件：补偿跳过（词条仍生效 → 免费强度形态）
const rD = skills.applySkillPlugins({ ...base }, [{ id: 'sp_mult', quality: 'rare', affixes: [{ id: 'mult_up', params: { v: 0.15 } }], costDeltaByTier: { mp: [2, 4, 6] }, kind: 'skillPlugin' }]);
log('D.缺 tier: multiplier', rD.multiplier, 'cost.mp', rD.cost.mp);

// E. 白名单投影：有插件路径丢弃非白名单参数
const LD3 = JSON.parse(JSON.stringify(LD));
LD3.loadout.skills[0].params.junkField = 'x';
LD3.warehouse.buckets.skill[0].params.junkField = 'x';
const p3 = loadout.buildPanel(LD3.loadout, { warehouse: LD3.warehouse, tier: 'mythic' });
log('E.s1 有插件 junkField 保留?', 'junkField' in p3.panel.skills[0].params, Object.keys(p3.panel.skills[0].params).sort().join(','));
log('E.s2 无插件 junkField 保留?', 'junkField' in p3.panel.skills[1].params);

// F. 多插件聚合（双槽技能装 sp_mult + sp_cooldown）
const base2 = { ...base, cost: { hp: 0, mp: 10, sp: 0 } };
const rF = skills.applySkillPlugins({ ...base2 }, [mk('sp_mult', 2, 'rare'), mk('sp_cooldown', 1, 'rare')]);
log('F.双插件 multiplier/cooldown/cost', rF.multiplier, rF.cooldown, JSON.stringify(rF.cost));

// G. 减耗类面板聚合（sp_cost_down tier1 rare：cost×0.8 ceil）
const rG = skills.applySkillPlugins({ ...base2 }, [mk('sp_cost_down', 1, 'rare')]);
log('G.减耗 cost (10×0.8 ceil)', JSON.stringify(rG.cost));

console.log(out.join('\n'));