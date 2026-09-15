'use strict';
// F8 布局合规回归 —— docs/screens.md 七屏盒子表**逐行直译**为断言（表 = 期望快照；允许 ≤1px，本文坐标皆整数 → 期望 0 差）。
// 覆盖：① 表中每一行 → 存在同 id 盒且 x/y/w/h/z 逐字段相等；② 每屏 verifyLayout 全绿（无 clip/overlap/zero/zconflict）。
// 例外（表中"画布内容"行，非 DOM 盒）见文末第二个用例：p1/p2/bullet/base_l/base_r 为引擎 px 投影，由 planFrame 产出。
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 全屏共用前两行（表：menu/editor/warehouse/gacha/battle/replay/settings 表首两行一致）
const HEAD = [
  ['logo', 16, 9, 180, 46, 1],
  ['tierBadge', 1080, 20, 72, 24, 1],
];

// ── 期望快照：抄自 docs/screens.md（id, x, y, w, h, z） ──
const EXPECT = {
  menu: [
    ...HEAD,
    ['seedLit', 1160, 20, 112, 24, 1],
    ['panel_menu', 360, 180, 560, 360, 2],
    ['title', 408, 216, 464, 32, 3],
    ['btn_ai', 560, 268, 160, 40, 4],
    ['btn_wh', 560, 320, 160, 40, 4],
    ['btn_gacha', 560, 372, 160, 40, 4],
    ['btn_battle', 560, 424, 160, 40, 4],
    ['btn_settings', 560, 476, 160, 40, 4],
    ['hint', 408, 540, 464, 24, 4],
  ],
  editor: [
    ...HEAD,
    ['toolbox', 0, 64, 120, 592, 2],
    ['blocklyDiv', 120, 64, 1024, 432, 2], // 表内行名 workspace；元素 id 由 frontend-spec §6.2 定为 blocklyDiv
    ['panel_right', 1144, 64, 136, 592, 2],
    ['btn_validate', 1156, 80, 112, 32, 3],
    ['btn_compile', 1156, 120, 112, 32, 3],
    ['btn_run', 1156, 160, 112, 32, 3],
    ['hash', 1156, 216, 112, 40, 3],
    ['errCount', 1156, 272, 112, 24, 3],
    ['errors', 120, 496, 1024, 160, 2],
  ],
  warehouse: [
    ...HEAD,
    ['buckets', 16, 80, 168, 500, 2],
    ['grid', 200, 80, 864, 500, 2],
    ['card1', 200, 80, 168, 108, 3],
    ['card2', 384, 80, 168, 108, 3],
    ['card3', 568, 80, 168, 108, 3],
    ['card4', 752, 80, 168, 108, 3],
    ['card5', 200, 204, 168, 108, 3],
    ['card6', 384, 204, 168, 108, 3],
    ['detail', 1080, 80, 184, 500, 2],
    ['points', 16, 592, 1248, 40, 2],
  ],
  gacha: [
    ...HEAD,
    ['panel_gacha', 400, 210, 480, 300, 2],
    ['sel_tier', 424, 250, 432, 40, 3],
    ['fld_times', 424, 306, 432, 40, 3],
    ['btn_open', 560, 368, 160, 40, 4],
    ['results', 96, 420, 1088, 240, 2],
    ['res1', 96, 420, 168, 108, 3],
    ['res2', 280, 420, 168, 108, 3],
    ['res3', 464, 420, 168, 108, 3],
    ['res4', 648, 420, 168, 108, 3],
  ],
  battle: [
    ...HEAD,
    ['config', 16, 80, 640, 400, 2],
    ['sel_opp', 40, 120, 600, 40, 3],
    ['loadoutSum', 40, 176, 600, 120, 3],
    ['fld_seed', 40, 312, 280, 40, 3],
    ['btn_seed', 336, 312, 120, 40, 3],
    ['preview', 680, 80, 584, 400, 2],
    ['stats', 704, 140, 536, 240, 3],
    ['btn_start', 560, 500, 160, 40, 4],
  ],
  replay: [
    ...HEAD,
    ['canvas', 16, 80, 1024, 128, 1],
    ['hp1', 16, 84, 96, 8, 4],
    ['hp2', 912, 84, 96, 8, 4],
    ['controls', 16, 220, 1024, 56, 2],
    ['aiTrace', 1064, 80, 200, 400, 2],
  ],
  settings: [
    ...HEAD,
    ['left', 16, 80, 560, 400, 2],
    ['fld_seed', 40, 120, 280, 40, 3],
    ['sel_tier', 40, 176, 280, 40, 3],
    ['about', 40, 240, 512, 140, 3],
    ['logPanel', 600, 80, 664, 400, 2],
    ['sel_level', 624, 120, 120, 40, 3],
    ['channels', 624, 176, 616, 140, 3],
    ['ring', 624, 348, 616, 120, 3],
    ['save_row', 16, 500, 560, 80, 2],
    ['btn_export', 40, 516, 120, 40, 3],
    ['btn_import', 176, 516, 120, 40, 3],
  ],
};

// 结果态 Modal（表 replay 末行：modal 400,280,480,160,z90；遮罩 z90 之上 → 面板 z91，≤1 层差已在代码注释登记）
const EXPECT_MODAL = ['modal', 400, 280, 480, 160, 91];

const roleItem = (uid, quality) => ({
  uid, kind: 'role', name: `角色${uid}`, templateId: 'role_bal', quality,
  slots: [{ type: 'atk', pluginUid: null }, { type: 'def', pluginUid: null }],
  stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
  pluginPoints: 4, unlockTier: 'common',
});

const NODES = ['action', 'var', 'set', 'if', 'loop', 'random', 'literal', 'getVar', 'bullets', 'arith', 'cmp', 'logic', 'function', 'call', 'break'];

// 每屏最小可用 state（只为产出表中各盒；四态细节由各屏自身测试覆盖）
const STATES = {
  menu: () => ({
    screen: 'menu', tier: 'rare', seed: 20260912, meta: { serverOk: true, version: '3.0.0', tableNames: [] },
    loadout: { role: roleItem('r1', 'rare'), skills: [null, null, null], ai: null },
  }),
  editor: () => ({ screen: 'editor', tier: 'rare', tierInfo: { nodes: NODES }, aiDraft: { errors: [], hash: null, compiling: false } }),
  warehouse: () => ({
    screen: 'warehouse', tier: 'rare',
    warehouse: { buckets: { role: [roleItem('r1', 'rare'), roleItem('r2', 'epic'), roleItem('r3', 'common'), roleItem('r4', 'rare'), roleItem('r5', 'rare'), roleItem('r6', 'rare')], skill: [], rolePlugin: [], skillPlugin: [] } },
    ui: { activeTab: { warehouse: 'role' }, snackbar: [] },
  }),
  gacha: () => ({
    screen: 'gacha', tier: 'rare', seed: 3, gacha: {
      opening: false, times: 3,
      lastResult: { items: [1, 2, 3, 4].map((i) => ({ uid: `g${i}`, kind: 'role', name: `物品${i}`, quality: 'rare' })) },
    },
  }),
  battle: () => ({
    screen: 'battle', tier: 'rare', seed: 20260912, loadout: { role: roleItem('r1', 'rare'), skills: [null, null, null], ai: null },
    panel: { role: { ...roleItem('r1', 'rare'), pluginPoints: 4 }, skills: [{ params: { multiplier: 1.5, cost: { mp: 8 } } }] },
    aiDraft: { errors: [] },
  }),
  replay: () => ({
    screen: 'replay',
    battle: {
      frames: [
        { tick: 1, diff: { players: { p1: { toX: 224, hp: 100 }, p2: { toX: 800, hp: 100 } }, bases: { p1: { hp: 100 }, p2: { hp: 100 } }, aiTrace: [{ owner: 'p1', path: '0:action', nodeType: 'action', result: 'move_right' }] } },
        { tick: 2, diff: { players: { p1: { toX: 288, hp: 100 }, p2: { toX: 736, hp: 60 } }, bases: { p1: { hp: 100 }, p2: { hp: 60 } }, aiTrace: [] } },
      ],
      result: null, tick: 0, speed: 1, playing: false, running: false,
    },
  }),
  settings: () => ({
    screen: 'settings', tier: 'rare', seed: 7,
    logPrefs: { level: 'debug', channels: { render: 'trace' }, panelOpen: false },
  }),
};

async function renderOf(screen, stateOverride) {
  const { renderScreen, allBoxes } = await import('../../public/js/views/index.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const state = { ...STATES[screen](), ...stateOverride };
  const r = renderScreen(state);
  const boxes = allBoxes(r);
  return { boxes, verify: verifyLayout(boxes) };
}

const byId = (boxes, id) => boxes.find((b) => b.id === id);

// ① 表行直译断言（七屏）
for (const screen of Object.keys(EXPECT)) {
  test(`screens.md ${screen}：盒子表逐行坐标一致（id/x/y/w/h/z）`, async () => {
    const { boxes, verify } = await renderOf(screen);
    const missing = [];
    for (const [id, x, y, w, h, z] of EXPECT[screen]) {
      const b = byId(boxes, id);
      if (!b) { missing.push(`${id} 缺失`); continue; }
      const expect = [x, y, w, h, z].join(',');
      const actual = [b.x, b.y, b.w, b.h, b.z].join(',');
      if (actual !== expect) missing.push(`${id} 期望(${expect}) 实际(${actual})`);
    }
    assert.deepEqual(missing, [], `${screen} 屏与 screens.md 不符`);
    assert.equal(verify.ok, true, `verifyLayout 非全绿：${JSON.stringify(verify.issues.slice(0, 6))}`);
  });
}

test('screens.md replay：结果态 Modal（末帧 → modal 400,280,480,160 + 遮罩/内容层）', async () => {
  const { boxes, verify } = await renderOf('replay', { battle: { ...STATES.replay().battle, tick: 1, result: { winner: 'B', ticks: 2 } } });
  const [id, x, y, w, h, z] = EXPECT_MODAL;
  const m = byId(boxes, id);
  assert.deepEqual([m.x, m.y, m.w, m.h, m.z], [x, y, w, h, z]);
  assert.ok(byId(boxes, 'replay_modal_mask'), '遮罩存在（z90）');
  assert.equal(verify.ok, true, `verifyLayout：${JSON.stringify(verify.issues.slice(0, 6))}`);
});

test('screens.md replay 画布内容行：引擎 px 投影（p1/p2/bullet/base_l/base_r）与表值一致', async () => {
  const { planFrame, FIELD_PX } = await import('../../public/js/render/planFrame.js');
  const diff = {
    players: { p1: { fromX: 160, toX: 224, hp: 100 }, p2: { fromX: 864, toX: 800, hp: 100 } },
    bullets: [{ owner: 'p1', x: 686, len: 64, dir: 1 }],
    bases: { p1: { hp: 100, def: 64 }, p2: { hp: 100, def: 64 } },
  };
  const prims = planFrame(diff, 1);
  const p1 = prims.find((p) => p.kind === 'player' && p.owner === 'p1');
  const p2 = prims.find((p) => p.kind === 'player' && p.owner === 'p2');
  // 表：p1 224,96,64,64 —— 96 为锚点中心（bottom 贴地线 128）；投影盒为 top=64, h=64 → 中心 96 ✓
  assert.deepEqual([p1.x, p1.y + p1.h / 2, p1.w, p1.h], [224, 96, 64, 64]);
  assert.deepEqual([p2.x, p2.y + p2.h / 2, p2.w, p2.h], [800, 96, 64, 64]);
  // 表：base_l 0,102,32,26 / base_r 992,102,32,26（引擎 px；992 = fieldPx 1024 − 32）
  const bl = prims.find((p) => p.kind === 'base' && p.owner === 'p1');
  const br = prims.find((p) => p.kind === 'base' && p.owner === 'p2');
  assert.deepEqual([bl.x, bl.y, bl.w, bl.h], [0, 102, 32, 26]);
  assert.deepEqual([br.x, br.y, br.w, br.h], [FIELD_PX - 32, 102, 32, 26]);
  // 表：bullet 686,112,32,32（示意级；引擎形态由 §7.2 决定）——x 与表一致
  assert.equal(prims.find((p) => p.kind === 'bullet').x, 686);
});

test('screens.md 表内未列的通用外壳：basemap/shell_main 为 z0 背景层（不占表行、不遮挡内容）', async () => {
  const { boxes } = await renderOf('menu');
  const base = byId(boxes, 'basemap_header');
  const main = byId(boxes, 'shell_main');
  assert.deepEqual([base.x, base.y, base.w, base.h, base.z], [0, 0, 1280, 64, 0]);
  assert.deepEqual([main.x, main.y, main.w, main.h, main.z], [0, 64, 1280, 656, 0]);
});
