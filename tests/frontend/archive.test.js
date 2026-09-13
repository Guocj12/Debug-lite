'use strict';
// F7 测试 —— 存档导出/导入（§8 纯函数 + effects）、AI 轨迹 planTrail、自定义块注册、settings 新控件
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('archive：exportState/parseImport 往返 + 版本/形状校验', async () => {
  const { exportState, parseImport } = await import('../../public/js/util/archive.js');
  const { initialState, reducer } = await import('../../public/js/store/reducer.js');
  let st = initialState();
  st = reducer(st, { type: 'tier/set', payload: { tier: 'legendary' } });
  st = reducer(st, { type: 'wh/replaced', payload: { warehouse: { buckets: { role: [{ uid: 'r1' }], skill: [], rolePlugin: [], skillPlugin: [] } } } });
  st = reducer(st, { type: 'seed/set', payload: { seed: 42 } });
  const text = exportState(st);
  const r = parseImport(text);
  assert.equal(r.ok, true);
  assert.equal(r.data.tier, 'legendary');
  assert.equal(r.data.seed, 42);
  assert.equal(r.data.warehouse.buckets.role[0].uid, 'r1');
  assert.equal(r.data.loadout.role, null);
  // 非法/版本不符
  assert.equal(parseImport('{nope').code, 'bad_json');
  assert.equal(parseImport(JSON.stringify({ schemaVersion: 999, tier: 'rare' })).code, 'bad_version');
  assert.equal(parseImport(null).code, 'bad_json');
  assert.equal(parseImport('[]').code, 'bad_json', '数组 → 非对象 → bad_json');
  assert.equal(parseImport('123').code, 'bad_json', '标量 → 非对象 → bad_json');
  // 形状归一：扁平仓库 → buckets 分层（normWh 同语义；F7 审查 P1：parseImport 归一——reducer save/import
  // 直存无 normWh，扁平 import 会让 warehouse 屏读 buckets 断裂）；缺 loadout → null
  const legacy = parseImport(JSON.stringify({ schemaVersion: 1, tier: 'common', warehouse: { role: [{ uid: 'x' }] }, seed: 5 }));
  // 扁平 warehouse → buckets 包装（role → buckets.role）
  assert.equal(legacy.data.warehouse.buckets.role[0].uid, 'x');
  assert.equal(legacy.data.warehouse.buckets.skill.length, 0);
  assert.equal(legacy.data.warehouse.buckets.rolePlugin.length, 0);
  assert.equal(legacy.data.warehouse.buckets.skillPlugin.length, 0);
  assert.equal(legacy.data.loadout, null);
  // 缺省臂：缺 tier/缺 warehouse/缺 seed + 富 loadout（truthy 臂全走）
  const rich = parseImport(JSON.stringify({ schemaVersion: 1, loadout: { role: 'rock', skills: ['a', 'b', 'c'], ai: { program: {} } } }));
  assert.equal(rich.data.tier, 'common', '缺 tier → common');
  assert.equal(rich.data.warehouse, null, '缺 warehouse → null');
  assert.equal(rich.data.loadout.role, 'rock');
  assert.equal(rich.data.loadout.skills.join(','), 'a,b,c', 'skills 透传');
  assert.ok(rich.data.loadout.ai, 'ai 透传');
  assert.equal(rich.data.seed, null, '缺 seed → null');
  // skills 三槽归一（§4.1：空/不足补 null、超长截断）
  const pad = parseImport(JSON.stringify({ schemaVersion: 1, loadout: { role: 'a', skills: ['x'] } }));
  assert.deepEqual(pad.data.loadout.skills, ['x', null, null], '缺槽补 null');
  const trunc = parseImport(JSON.stringify({ schemaVersion: 1, loadout: { role: 'a', skills: ['x', 'y', 'z', 'w'] } }));
  assert.deepEqual(trunc.data.loadout.skills, ['x', 'y', 'z'], '超长截断 3');
  const noSkills = parseImport(JSON.stringify({ schemaVersion: 1, loadout: { role: 'a' } }));
  assert.deepEqual(noSkills.data.loadout.skills, [null, null, null], '缺 skills → 三槽 null');
});

test('effects：save/export（doc 守卫）与 save/import（ok → 落盘 + toast；bad → toast）', async () => {
  const { runEffect } = await import('../../public/js/store/effects.js');
  const actions = [];
  const calls = [];
  const click = [];
  // store 桩模拟 reducer：dispatch save/import 后 store() 即时反映（effect 随后落盘用新状态）
  let state = { tier: 'rare', warehouse: { buckets: {} }, loadout: { role: null, skills: [] }, seed: 1, gacha: { lastResult: null }, logPrefs: {} };
  const ctx = {
    store: () => state,
    dispatch: (a) => {
      actions.push(a);
      if (a.type === 'save/import') {
        const p = a.payload;
        state = {
          ...state,
          tier: p.tier || state.tier,
          warehouse: p.warehouse || state.warehouse,
          loadout: p.loadout || state.loadout,
          seed: p.seed === undefined ? state.seed : p.seed,
        };
      }
    },
    save: (s) => calls.push(['save', s.tier]),
    doc: { createElement: () => ({ href: '', download: '', click: () => click.push('click') }) },
    log: null,
  };
  await runEffect(ctx, { type: 'save/export' });
  assert.equal(click.length, 1, '下载触发');
  await runEffect(ctx, { type: 'save/import', payload: { text: 'not-json' } });
  assert.ok(actions.some((a) => a.type === 'ui/toast' && a.payload.text.includes('导入失败')));
  assert.ok(!actions.some((a) => a.type === 'save/import'));
  const good = JSON.stringify({ schemaVersion: 1, tier: 'epic', warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, seed: 9, loadout: null });
  await runEffect(ctx, { type: 'save/import', payload: { text: good } });
  assert.ok(actions.some((a) => a.type === 'save/import' && a.payload.tier === 'epic'));
  assert.ok(calls.some((c) => c[1] === 'epic'), '导入后落盘');
  assert.ok(actions.some((a) => a.type === 'ui/toast' && a.payload.text === '存档已导入'));
  // 无 text payload → noop
  const before = actions.length;
  await runEffect(ctx, { type: 'save/import', payload: {} });
  assert.equal(actions.length, before);
  // 无 doc → export 静默
  const ctxNoDoc = { ...ctx, doc: null };
  await runEffect(ctxNoDoc, { type: 'save/export' });
});

test('planTrail：玩家 toX 轨迹点（相邻帧连线）+ 限长 32 + 缺字段安全', async () => {
  const { planTrail } = await import('../../public/js/render/trail.js');
  const frames = Array.from({ length: 40 }, (_, i) => ({
    tick: i + 1,
    diff: { players: { p1: { toX: 224 + i * 10 }, p2: { toX: 800 - i * 10 } } },
  }));
  const p1 = planTrail(frames, 39, 'p1');
  assert.equal(p1.length, 1);
  assert.equal(p1[0].kind, 'trail');
  assert.equal(p1[0].points.length, 32, '限长 32');
  assert.equal(p1[0].points[0].x, 224 + (40 - 32) * 10, '最近 32 帧起点');
  // 单帧/空/缺字段 → 无轨迹
  assert.equal(planTrail([{ tick: 1, diff: {} }], 0, 'p1').length, 0);
  assert.equal(planTrail([], 0, 'p1').length, 0);
  assert.equal(planTrail(frames, 39, 'p3').length, 0, '未知 owner');
  // tick 越界安全
  assert.equal(planTrail(frames, 999, 'p1').length, 1);
  assert.equal(planTrail(frames, undefined, 'p1').length, 0, 'tick 未定义 → 只算第一帧');
});

test('blocks：注册清单 16 型与 bridge 块型全集一一对应（数量+命名）+ 幂等注册（stub 核验）', async () => {
  const { blockTypeKeys, registerBlockTypes } = await import('../../public/js/editor/blocks.js');
  const keys = blockTypeKeys();
  // F7 审查 P0：bridge.toBlocks/toAst 的块 JSON type 全集 = 16 型（var/set/if/loop_forever/loop_count/random/
  // action/break/function/call/num/get/bullets/arith/cmp/logic——探针实证）。原 20 键（statement_seq/move_right/
  // var_declare…）与 bridge 命名几乎全异 → 工具箱/序列化 round-trip 无法实例化；本断言锁数量与命名逐字一致。
  const BRIDGE_TYPES = ['var', 'set', 'if', 'loop_forever', 'loop_count', 'random', 'action', 'break', 'function', 'call', 'num', 'get', 'bullets', 'arith', 'cmp', 'logic'];
  assert.deepEqual([...keys].sort(), [...BRIDGE_TYPES].sort(), '16 键 = bridge 块型全集（命名逐字一致）');
  for (const k of keys) assert.ok(/^[a-z_]+$/.test(k), `${k} 命名`);
  const registered = [];
  // 真实 Blockly 语义：Blockly.Blocks[key] = def 直接赋值（无 .set 方法）——Proxy 记录赋值轨迹
  const fakeBlocks = new Proxy({}, {
    set(target, prop, val) {
      registered.push({ key: prop, hasNext: !!val.init });
      target[prop] = val;
      return true;
    },
  });
  const fakeB = { Blocks: fakeBlocks };
  const r1 = registerBlockTypes(fakeB);
  assert.equal(r1.registered, 16);
  assert.equal(registered.length, 16);
  assert.deepEqual(registered.map((r) => r.key).sort(), [...BRIDGE_TYPES].sort(), '注册键 = bridge 块型全集');
  // init 分支锤：注册后的块定义可被实例化（fake this 走完 setColour/prev/next/appendField）
  const def = fakeBlocks.loop_forever;
  assert.ok(def && typeof def.init === 'function', '块定义含 init');
  const initCalls = [];
  const stubInput = { appendField: () => initCalls.push('field') };
  const stubThis = {
    setColour: () => initCalls.push('colour'),
    setPreviousStatement: () => initCalls.push('prev'),
    setNextStatement: () => initCalls.push('next'),
    appendDummyInput: () => stubInput,
  };
  def.init.call(stubThis);
  assert.deepEqual(initCalls, ['colour', 'prev', 'next', 'field'], 'init 走完四步');
  // 幂等：已有块型跳过
  const r2 = registerBlockTypes(fakeB);
  assert.equal(r2.registered, 0);
  // null 安全
  assert.equal(registerBlockTypes(null).registered, 0);
  assert.equal(registerBlockTypes({}).registered, 0);
  // 与 bridge 往返可组合（代表性 2 型：action 块 name 字段；num 块 value 字段）
  const { toAst } = await import('../../public/js/editor/bridge.js');
  const prog = { type: 'seq', statements: [{ type: 'action', name: 'use_skill', skill_id: 'skill1' }] };
  assert.equal(toAst({ type: 'action', fields: { name: 'use_skill', skill_id: 'skill1' } }).body.statements[0].name, 'use_skill');
  void prog;
});

test('settings 新控件：seed 行/随机/导出按钮/关于/导入提示', async () => {
  const { settingsLayout } = await import('../../public/js/views/settings.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const st = { screen: 'settings', seed: 7, logPrefs: { level: 'debug', channels: {} }, loadout: { role: null, skills: [] }, meta: {} };
  const boxes = settingsLayout(st, {});
  assert.ok(boxes.find((b) => b.id === 'settings_seed').text.includes('seed：7'));
  assert.equal(boxes.find((b) => b.id === 'settings_seed_rand').action, 'seed/random');
  assert.equal(boxes.find((b) => b.id === 'settings_export').action, 'save/export');
  assert.ok(boxes.find((b) => b.id === 'settings_about').text.includes('Debug-Lite'));
  assert.ok(boxes.find((b) => b.id === 'settings_import_hint'), '导入提示');
  const unset = settingsLayout({ ...st, seed: null }, {});
  assert.ok(unset.find((b) => b.id === 'settings_seed').text.includes('未设'));
  const verify = verifyLayout(boxes);
  assert.equal(verify.ok, true, `设置屏自检：${verify.issues.slice(0, 3).map((i) => `${i.boxId}:${i.issue}`).join(',')}`);
});

test('mount 回放：trail 并入优先序（player 图元之后）——paintCanvas trail 折线绘制', async () => {
  const { paintCanvas } = await import('../../public/js/mount/canvas.js');
  const calls = [];
  const ctx = {
    clearRect: () => {}, fillRect: () => {}, fillStyle: null, strokeStyle: null, globalAlpha: 1,
    beginPath: () => calls.push(['beginPath']), moveTo: (...a) => calls.push(['moveTo', ...a]),
    lineTo: (...a) => calls.push(['lineTo', ...a]), stroke: () => calls.push(['stroke']), fillText: () => {},
  };
  const r = paintCanvas(null, [{ kind: 'trail', owner: 'p1', points: [{ x: 224, y: 96 }, { x: 288, y: 96 }] }], { ctx });
  assert.equal(r.count, 1);
  assert.ok(calls.some(([k]) => k === 'stroke'), '折线绘制');
  // 单点/无 lineTo 的 trail：beginPath+moveTo 后 stroke 空路径不抛（canvas.js trail beginPath 守卫为
  // 防御性——paintCanvas 地面线已无条件 beginPath，false 臂不可达；1 点轨迹仍应安全跳过折线）
  paintCanvas(null, [{ kind: 'trail', owner: 'p1', points: [{ x: 1, y: 1 }] }], { ctx });
});