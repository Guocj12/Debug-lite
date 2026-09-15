'use strict';
// T-DC-1/2 数据表校验契约测试 —— 契约见 server/data/README.md
// 失败路径用「真实表复制→定点破坏」fixture（保证数量/结构基线真实）；门禁语义测 gate 项 4/5 接线。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const schema = require('../../server/data/schema.js');
const gate = require('../../scripts/gate.js');

const REPO_DATA = path.join(__dirname, '..', '..', 'server', 'data');
const REPO_ASSETS = path.join(__dirname, '..', '..', 'assets');

// 复制真实数据表（含 assets 占位表）到临时目录，再执行破坏
function corruptTable(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-data-'));
  for (const f of fs.readdirSync(REPO_DATA)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(REPO_DATA, f), path.join(root, f));
  }
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(REPO_ASSETS)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(REPO_ASSETS, f), path.join(root, 'assets', f));
  }
  if (mutate) mutate(root);
  return root;
}

function writeJSON(dir, file, obj) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 1), 'utf8');
}

function readJSON(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

function withRoot(mutate, fn) {
  const root = corruptTable(mutate);
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('DS-1 真实数据表：结构 + 一致性校验全过（T-DC-1/2 门禁语义）', () => {
  assert.equal(schema.validateStructure(REPO_DATA).ok, true);
  assert.equal(schema.validateConsistency(REPO_DATA).ok, true);
  assert.equal(schema.validate(REPO_DATA).ok, true);
});

test('DS-2 battle-config 冻结数值改动 → fail（§2.5.7 逐值；含 B21 defK 入表）', () => {
  withRoot((root) => {
    const bc = readJSON(root, 'battle-config.json');
    bc.cellPx = 63;
    writeJSON(root, 'battle-config.json', bc);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, "assets"));
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('cellPx'), r.detail);
  });
  // P1-1 回归（审查 docs/reviews/B21.md）：defK 漂移/缺失必须被冻结校验拦截
  withRoot((root) => {
    const bc = readJSON(root, 'battle-config.json');
    bc.defK = 41;
    writeJSON(root, 'battle-config.json', bc);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, "assets"));
    assert.equal(r.ok, false, 'defK 漂移 40→41 应 fail');
    assert.ok(r.detail.includes('defK'), r.detail);
  });
  withRoot((root) => {
    const bc = readJSON(root, 'battle-config.json');
    delete bc.defK;
    writeJSON(root, 'battle-config.json', bc);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, "assets"));
    assert.equal(r.ok, false, 'defK 缺失应 fail');
  });
});

test('DS-3 角色模板缺 regen（D-110 必填）→ fail', () => {
  withRoot((root) => {
    const t = readJSON(root, 'role-templates.json');
    delete t.roleTemplates[0].regen;
    writeJSON(root, 'role-templates.json', t);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, "assets"));
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('regen'), r.detail);
  });
});

test('DS-4 技能模板出现已删除字段 bulletSpeed（D-21）→ fail', () => {
  withRoot((root) => {
    const t = readJSON(root, 'skill-templates.json');
    t.skillTemplates[0].bulletSpeed = 8;
    writeJSON(root, 'skill-templates.json', t);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, "assets"));
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('bulletSpeed'), r.detail);
  });
});

test('DS-5 品质 tiers 不接续 / dropRates 和不为 1 → fail', () => {
  withRoot((root) => {
    const q = readJSON(root, 'qualities.json');
    q.qualities[0].tiers[1][0] = 0.88; // 与上一段终点 0.88 接续 ✓，改下一段起点破坏
    q.qualities[0].tiers[2][0] = 0.96; // 应接 0.97
    writeJSON(root, 'qualities.json', q);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, "assets"));
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('接续'), r.detail);
  });
  withRoot((root) => {
    const ic = readJSON(root, 'items-config.json');
    ic.dropRates.common = 0.56;
    writeJSON(root, 'items-config.json', ic);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, "assets"));
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('dropRates'), r.detail);
  });
});

test('DS-6 unlock 与三表 unlockTier 交叉不一致 → fail（防双源漂移）', () => {
  withRoot((root) => {
    const t = readJSON(root, 'role-templates.json');
    t.roleTemplates[0].unlockTier = 'rare'; // 表改 rare，unlock 仍登记在 common
    writeJSON(root, 'role-templates.json', t);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, "assets"));
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('unlock'), r.detail);
  });
});

test('DS-7 T-DC-2：插件缺失 / 技能数值改动 → consistency fail', () => {
  withRoot((root) => {
    const p = readJSON(root, 'plugins.json');
    p.plugins = p.plugins.filter((x) => x.id !== 'rp_atk_pct');
    writeJSON(root, 'plugins.json', p);
  }, (root) => {
    const r = schema.validateConsistency(root);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('rp_atk_pct'), r.detail);
  });
  withRoot((root) => {
    const t = readJSON(root, 'skill-templates.json');
    t.skillTemplates[2].baseMultiplier = 2.0; // 精准射击应为 0.9
    writeJSON(root, 'skill-templates.json', t);
  }, (root) => {
    const r = schema.validateConsistency(root);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('baseMultiplier'), r.detail);
  });
});

test('DS-7b T-DC-2：插件词条基础值改动 / sp_buff duration 改动 → fail（审查 P2-1）', () => {
  withRoot((root) => {
    const p = readJSON(root, 'plugins.json');
    const plug = p.plugins.find((x) => x.id === 'rp_atk_pct');
    plug.affixes[0].params.v = 0.09; // items-data §5 应为 0.08
    writeJSON(root, 'plugins.json', p);
  }, (root) => {
    const r = schema.validateConsistency(root);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('词条基础值'), r.detail);
  });
  withRoot((root) => {
    const p = readJSON(root, 'plugins.json');
    const plug = p.plugins.find((x) => x.id === 'sp_buff');
    plug.affixes[0].params.duration = 3;
    writeJSON(root, 'plugins.json', p);
  }, (root) => {
    const r = schema.validateConsistency(root);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes('duration'), r.detail);
  });
});

test('DS-8 机器复算：品质 tiers 三等分性质（步长一致、段间接续、首尾=statRange）', () => {
  const q = readJSON(REPO_DATA, 'qualities.json');
  for (const quality of q.qualities) {
    const [lo, hi] = quality.statRange;
    // common 为用户显式指定（items-data §2.1：0.80~0.88/0.88~0.97/0.97~1.05），非严格三等分
    if (quality.id === 'common') {
      assert.equal(quality.tiers[0][0], 0.80);
      assert.equal(quality.tiers[2][1], 1.05);
      assert.deepEqual(quality.tiers, [[0.80, 0.88], [0.88, 0.97], [0.97, 1.05]]);
      continue;
    }
    // 其余品质：期望由计算生成（4 位小数四舍五入）
    const step = (hi - lo) / 3;
    const expected = [0, 1, 2].map((i) => [
      Math.round((lo + step * i) * 10000) / 10000,
      Math.round((lo + step * (i + 1)) * 10000) / 10000,
    ]);
    assert.deepEqual(quality.tiers, expected, `${quality.id} tiers 应为三等分 ${JSON.stringify(expected)}`);
    assert.equal(quality.tiers[0][0], lo);
    assert.equal(quality.tiers[2][1], hi);
  }
});

test('DS-9 门禁项 4/5 接线：真实仓库 checkSchema → pass；T-DC-2 子检查 → pass', () => {
  const s4 = gate.checkSchema(); // 默认 REPO
  assert.equal(s4.status, 'pass', s4.detail);
  const tdc2 = gate.checkDocConsistency();
  assert.equal(tdc2.status, 'pass', tdc2.detail);
  // 无 schema.js 的 fixture → pending（阶段语义：P0-6 前）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-data-'));
  try {
    assert.equal(gate.checkSchema({ projectRoot: root }).status, 'pending');
    assert.equal(gate.checkDocConsistency({ projectRoot: root }).status, 'pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // 项 5 全过分支：interfaces + decisions + schema stub（T-DC-8/T-DC-2 双过）
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-data-'));
  try {
    fs.mkdirSync(path.join(root2, 'server/data'), { recursive: true });
    fs.mkdirSync(path.join(root2, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root2, 'docs/interfaces.md'), '## D-001 落点\n', 'utf8');
    fs.writeFileSync(path.join(root2, 'docs/decisions.md'), '# D-001 决策\n', 'utf8');
    fs.writeFileSync(path.join(root2, 'server/data/schema.js'),
      "module.exports = { validateConsistency: () => ({ ok: true, detail: '一致' }) };", 'utf8');
    const all = gate.checkDocData({ projectRoot: root2 });
    assert.equal(all.status, 'pass', all.detail);
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test('DS-10 T-DC-1 破坏矩阵：12 类结构违规逐一 fail（分支覆盖）', () => {
  const cases = [
    // [描述, 文件, 破坏函数, detail 关键字]
    ['角色 type 非法', 'role-templates.json', (t) => { t.roleTemplates[0].type = 'wizard'; }, 'type 非法'],
    ['特化无 highStat', 'role-templates.json', (t) => { delete t.roleTemplates[1].highStat; }, 'highStat'],
    ['baseStats 缺键', 'role-templates.json', (t) => { delete t.roleTemplates[0].baseStats.mp; }, 'baseStats'],
    ['slotWeights 键缺失', 'role-templates.json', (t) => { delete t.roleTemplates[0].slotWeights.special; }, 'slotWeights'],
    ['技能 type 非法', 'skill-templates.json', (t) => { t.skillTemplates[0].type = 'gun'; }, 'type 非法'],
    ['冷却为负', 'skill-templates.json', (t) => { t.skillTemplates[0].cooldown = -1; }, 'cooldown'],
    ['bulletLevel 越界', 'skill-templates.json', (t) => { t.skillTemplates[0].bulletLevel = 5; }, 'bulletLevel'],
    ['平射 range=0', 'skill-templates.json', (t) => { t.skillTemplates[2].range = 0; }, 'straight'],
    ['位移 distance=0', 'skill-templates.json', (t) => { t.skillTemplates[8].distance = 0; }, 'distance'],
    ['位移开关非布尔', 'skill-templates.json', (t) => { t.skillTemplates[8].dealDamage = 'yes'; }, 'dealDamage'],
    ['插件 kind 非法', 'plugins.json', (p) => { p.plugins[0].kind = 'weapon'; }, 'kind 非法'],
    ['插件 pointCostByTier 错', 'plugins.json', (p) => { p.plugins[0].pointCostByTier = [2, 3]; }, 'pointCostByTier'],
    ['costDeltaByTier 空对象', 'plugins.json', (p) => { p.plugins[14].costDeltaByTier = {}; }, 'costDeltaByTier'],
    ['costDeltaByTier 非 3 元', 'plugins.json', (p) => { p.plugins[14].costDeltaByTier = { mp: [2, 4] }; }, 'costDeltaByTier'],
    ['品质 id 非法', 'qualities.json', (q) => { q.qualities[0].id = 'epix'; }, '品质 id'],
    ['品质 statRange 倒置', 'qualities.json', (q) => { q.qualities[0].statRange = [1.05, 0.80]; }, 'statRange'],
    ['解锁缺段位', 'unlock.json', (u) => { u.unlocks = u.unlocks.filter((x) => x.tier !== 'epic'); }, '缺段位 epic'],
    ['解锁 aiNodes 集错', 'unlock.json', (u) => { u.unlocks.find((x) => x.tier === 'rare').aiNodes.push('function'); }, 'aiNodes'],
    ['角色 unlockTier 非法', 'role-templates.json', (t) => { t.roleTemplates[0].unlockTier = 'gold'; }, 'unlockTier 非法'],
    ['技能 slotWeights 缺失', 'skill-templates.json', (t) => { delete t.skillTemplates[0].slotWeights; }, 'slotWeights'],
    ['近战 range 非法', 'skill-templates.json', (t) => { t.skillTemplates[0].range = [2, 1]; }, 'melee'],
    ['垂直 range=0', 'skill-templates.json', (t) => { t.skillTemplates[6].range = 0; }, 'vertical'],
    ['垂直 area 非法', 'skill-templates.json', (t) => { t.skillTemplates[6].area = 3; }, 'area'],
    ['插件槽位非法', 'plugins.json', (p) => { p.plugins[0].slot = 'weapon'; }, '槽位非法'],
    ['插件 affixes 空', 'plugins.json', (p) => { p.plugins[0].affixes = []; }, 'affixes'],
    ['品质 tiers 非 3 段', 'qualities.json', (q) => { q.qualities[0].tiers = [[1, 2]]; }, 'tiers 须 3 段'],
    ['品质重复 id', 'qualities.json', (q) => { q.qualities[1].id = 'common'; }, '品质 id 重复'],
    ['dropRates 键缺失', 'items-config.json', (ic) => { delete ic.dropRates.common; }, 'dropRates'],
    ['kindWeights 键缺失', 'items-config.json', (ic) => { delete ic.kindWeights.skill; }, 'kindWeights'],
    ['角色数量错', 'role-templates.json', (t) => { t.roleTemplates.pop(); }, '应 11 个'],
    ['技能数量错', 'skill-templates.json', (t) => { t.skillTemplates.pop(); }, '应 10 个'],
    ['插件数量错', 'plugins.json', (p) => { p.plugins.pop(); }, '14 角色 + 15 技能'],
    ['基地缺失', 'battle-config.json', (b) => { delete b.bases.p2; }, 'bases.p2 缺失'],
    ['costDelta 维度键非法', 'plugins.json', (p) => { p.plugins[14].costDeltaByTier = { x: [1, 2, 3] }; }, 'costDeltaByTier'],
  ];
  for (const [label, file, mutate, keyword] of cases) {
    withRoot((root) => {
      const obj = readJSON(root, file);
      mutate(obj);
      writeJSON(root, file, obj);
    }, (root) => {
      const r = schema.validateStructure(root, path.join(root, "assets"));
      assert.equal(r.ok, false, `${label}: 应 fail`);
      assert.ok(r.detail.includes(keyword), `${label}: detail 应含 "${keyword}"，实际: ${r.detail}`);
    });
  }
});

test('DS-12 typeModifiers 入表（B5 审查 P1）：漂移 → fail；roles.js 读取表值', () => {
  // 漂移检测（真实表通过由 DS-1 覆盖）
  withRoot((root) => {
    const t = readJSON(root, 'role-templates.json');
    t.typeModifiers.specialized.high = 1.20;
    writeJSON(root, 'role-templates.json', t);
  }, (root) => {
    const res = schema.validateStructure(root, path.join(root, 'assets'));
    assert.equal(res.ok, false, 'typeModifiers 漂移应 fail');
    assert.ok(res.detail.includes('typeModifiers'), res.detail);
  });
  // roles.js 从表读取（不再硬编码）
  const rolesMod = require('../../server/core/roles.js');
  const t = readJSON(REPO_DATA, 'role-templates.json');
  const base = rolesMod.instantiateRole(
    JSON.parse(require('node:fs').readFileSync(require('node:path').join(REPO_DATA, 'role-templates.json'), 'utf8')).roleTemplates[0],
    'rare', { float: () => 1.0, int: () => 0, pick: () => 0 }
  );
  assert.equal(base.type, 'balanced');
  assert.equal(rolesMod.applyTypeModifier(
    { type: 'specialized', highStat: 'atk', baseStats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 } },
    { int: () => 3 }
  ).atk, 11.5, '修饰系数取表值：10×1.15（high 漂移会被 schema 拦）');
});

test('DS-11 assets 占位表（P0-9）：真实通过；缺条目/描边色漂移/形状枚举/帧非法 → fail', () => {
  // 真实仓库（默认推导 assets 路径）
  assert.equal(schema.validateStructure(REPO_DATA).ok, true, '真实仓库 assets 校验应通过');
  const withAssets = (mutate) => withRoot((root) => {
    const sp = readJSON(path.join(root, 'assets'), 'sprites.json');
    mutate(sp);
    writeJSON(path.join(root, 'assets'), 'sprites.json', sp);
  }, (root) => schema.validateStructure(root, path.join(root, 'assets')));

  // 破坏 1：缺一条角色占位（与 role-templates 交叉不一致）
  const r1 = withAssets((sp) => { sp.roleTemplates = sp.roleTemplates.filter((x) => x.templateId !== 'role_bal'); });
  assert.equal(r1.ok, false, '缺 role_bal 占位应 fail');
  assert.ok(r1.detail.includes('role_bal'), r1.detail);
  // 破坏 2：品质描边色与 qualities.json 不一致
  const r2 = withAssets((sp) => { sp.palette.quality.common = '#ffffff'; });
  assert.equal(r2.ok, false, '描边色漂移应 fail');
  assert.ok(r2.detail.includes('quality.common'), r2.detail);
  // 破坏 3：形状不在枚举
  const r3 = withAssets((sp) => { sp.skillTemplates[0].shape = 'circle'; });
  assert.equal(r3.ok, false, '形状枚举外应 fail');
  assert.ok(r3.detail.includes('circle'), r3.detail);
  // 破坏 4：动画帧非法
  const r4 = withRoot((root) => {
    const an = readJSON(path.join(root, 'assets'), 'animations.json');
    an.animations.role.idle.frames = 0;
    writeJSON(path.join(root, 'assets'), 'animations.json', an);
  }, (root) => schema.validateStructure(root, path.join(root, 'assets')));
  assert.equal(r4.ok, false, 'frames=0 应 fail');
  assert.ok(r4.detail.includes('frames'), r4.detail);
  // 破坏 5：缺 animations.role.idle
  const r5 = withRoot((root) => {
    const an = readJSON(path.join(root, 'assets'), 'animations.json');
    delete an.animations.role.idle;
    writeJSON(path.join(root, 'assets'), 'animations.json', an);
  }, (root) => schema.validateStructure(root, path.join(root, 'assets')));
  assert.equal(r5.ok, false, '缺 role.idle 应 fail');
});
