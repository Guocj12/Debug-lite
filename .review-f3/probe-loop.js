'use strict';
/* .review-f3/probe-loop.js —— F3 审查闭环探针（可复跑：node .review-f3/probe-loop.js）
 * 目标（核查清单 8）：构建「真实后端形状」的 /box + /warehouse/assemble|disassemble 响应，
 * 经 effects → reducer → gachaLayout/warehouseLayout 全链路渲染验证 items 数组 → 桶 → 卡 → 候选按钮 → 装配/拆卸闭环。
 * 后端真身：server/box.js openBoxes + server/core/items.js assemble/disassemble（非 mock 形状）。
 * 期望退出码 0；任一步失败 → 打印 [FAIL] 并退出 1。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
process.chdir(REPO);
const file = (p) => pathToFileURL(path.join(REPO, p)).href; // Windows 下 ESM 需 file:// URL

(async () => {
  const boxApi = require(path.join(REPO, 'server', 'box.js')); // require 在 probe 内合法（L6 纯 node 侧）
  const itemsApi = require(path.join(REPO, 'server', 'core', 'items.js'));
  const { createStore } = await import(file('public/js/store/index.js'));
  const { createApi } = await import(file('public/js/api/client.js'));
  const { gachaLayout } = await import(file('public/js/views/gacha.js'));
  const { warehouseLayout, candidatesFor } = await import(file('public/js/views/warehouse.js'));
  const { verifyLayout } = await import(file('public/js/ui/verify.js'));
  const { initialState } = await import(file('public/js/store/reducer.js'));

  const now = Date.now();
  let line = -1;
  function log(msg) { console.log(`[${++line}] ${msg}`); }

  // 假 fetch：路由到真后端编排（信封与 createApi 契约一致）
  async function fetchImpl(url, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    let env;
    if (url === '/api/v1/box') {
      const r = boxApi.openBoxes({ seed: body.seed, tier: body.tier, times: body.times });
      if (r.status === 200) env = { ok: true, data: { seed: r.data.seed, tier: r.data.tier, times: r.data.times, items: r.data.items } };
      else env = { ok: false, error: { code: r.code, message: r.message } };
    } else if (url === '/api/v1/unlock?tier=legendary') {
      env = { ok: true, data: { tier: 'legendary' } };
    } else if (url === '/api/v1/warehouse/assemble') {
      const r = itemsApi.assemble(body.warehouse, { targetUid: body.targetUid, pluginUid: body.pluginUid, slotIndex: body.slotIndex, tier: body.tier });
      env = r.ok ? { ok: true, data: { warehouse: r.warehouse } } : { ok: false, error: { code: r.code, message: r.message } };
    } else if (url === '/api/v1/warehouse/disassemble') {
      const r = itemsApi.disassemble(body.warehouse, { targetUid: body.targetUid, slotIndex: body.slotIndex });
      env = r.ok ? { ok: true, data: { warehouse: r.warehouse } } : { ok: false, error: { code: r.code, message: r.message } };
    } else {
      env = { ok: false, error: { code: 'unknown', message: 'probe route ' + url } };
    }
    return { text: async () => JSON.stringify(env) };
  }

  const initial = initialState();
  initial.tier = 'common';
  initial.seed = 157; // 预扫 seed（common×5）：role[mp,mp,atk] points3 + plugs[mp(c2),special,mp(c3)]——覆盖装配ok/点数超限/槽型错配/拆卸四段
  const store = createStore({ api: createApi({ fetchImpl }), state: initial });
  const actions = [];
  store.subscribe((s) => actions.push(s));

  // ── 1/7 开箱闭环：box/open → effect → box/done（真后端五连开） ──
  store.dispatch({ type: 'box/open', payload: { times: 5 } });
  await new Promise((r) => setTimeout(r, 50)); // effect 微任务/宏任务让其完成
  let st = store.getState();
  assert.equal(st.gacha.opening, false, 'box/done 复位 opening');
  assert.ok(Number.isInteger(st.seed) && st.seed >= 1, `seed 回带：${st.seed}`);
  const got = ['role', 'skill', 'rolePlugin', 'skillPlugin'].reduce((a, k) => a + st.warehouse.buckets[k].length, 0);
  assert.equal(got, 5, `5 件入桶（实际 ${got}）`);
  log(`box/open×5 → box/done：seed=${st.seed} 分桶 ${['role','skill','rolePlugin','skillPlugin'].map((k) => k + ':' + st.warehouse.buckets[k].length).join(' ')}`);

  // ── 2/7 gachaLayout 渲染真形结果卡（name/quality/slot 字段来自生成器） ──
  const gboxes = gachaLayout(st);
  const cards = gboxes.filter((b) => b.kind === 'gridcell');
  assert.equal(cards.length, 5, '结果卡数 = items 数');
  assert.equal(verifyLayout(gboxes).issues.length, 0, 'gacha 全绿');
  const lr = st.gacha.lastResult;
  lr.items.forEach((it, i) => {
    const c = cards[i];
    assert.ok(c.text && c.text.length > 0, `卡文本 ${c.text}`);
    assert.equal(c.style, `q-${it.quality || 'common'}`, `品质色条 q-${it.quality}`);
    assert.equal(c.detail, it.kind, 'detail=kind');
  });
  log(`gachaLayout 渲染 ${cards.length} 卡全绿（品质色条/名/kind 与真形一致）`);

  // ── 3/7 仓库屏：真形网格 + 详情（点数来自真 pluginPoints） ──
  store.dispatch({ type: 'goto', payload: { screen: 'warehouse' } });
  st = store.getState();
  const wboxes = warehouseLayout(st);
  assert.equal(verifyLayout(wboxes).issues.length, 0, 'warehouse 全绿');
  const roleItem = st.warehouse.buckets.role[0];
  assert.ok(roleItem, '开箱含角色目标（seed157 确定性）');
  store.dispatch({ type: 'wh/select', payload: { uid: roleItem.uid } });
  st = store.getState();
  const dboxes = warehouseLayout(st);
  const pts = dboxes.find((b) => b.id === 'wh_detail_pts');
  const used = roleItem.slots.filter((s) => s && s.pluginUid).length;
  assert.equal(pts.text, `点数 ${used}/${roleItem.pluginPoints}`, '详情点数来自真 pluginPoints');
  const cands = candidatesFor(roleItem, st.warehouse, st.tier);
  // 候选-槽型错配普查（F3 审查 P2 登记面：candidatesFor 无 slot 匹配 → 后端 slot_type_mismatch 兜底）
  const mismatchCount = roleItem.slots.filter((s) => !s.pluginUid).reduce((n, s) => n + cands.filter((p) => p.slot !== s.type).length, 0);
  log(`详情：目标 ${roleItem.name}[${roleItem.quality}] 槽×${roleItem.slots.length} 点数 ${used}/${roleItem.pluginPoints}；候选 ${cands.length}（其中与所选槽错配按钮 ${mismatchCount} 个 → 后端拒绝码经 toast 呈现）`);

  // ── 4/7 装配闭环（真后端 assemble）：槽0 匹配插件装成 → 点数超限拒绝 → 卸下 ──
  const slot0 = roleItem.slots[0]; // mp
  const mpPlugs = cands.filter((p) => p.slot === slot0.type && !p.equipped);
  assert.ok(mpPlugs.length >= 2, '两个 mp 插件候选');
  store.dispatch({ type: 'wh/assemble', payload: { targetUid: roleItem.uid, pluginUid: mpPlugs[0].uid, slotIndex: 0 } });
  await new Promise((r) => setTimeout(r, 20));
  st = store.getState();
  const t1 = st.warehouse.buckets.role.find((x) => x.uid === roleItem.uid);
  assert.equal(t1.slots[0].pluginUid, mpPlugs[0].uid, '真后端装配落槽');
  assert.ok(st.warehouse.buckets.rolePlugin.find((x) => x.uid === mpPlugs[0].uid).equipped, '真后端回带 equipped=true');
  log(`装配闭合 ok：${mpPlugs[0].uid}(cost=${mpPlugs[0].pointCost}) → 槽0(${slot0.type})`);

  // 点数超限：再装第二个 mp（cost2+3 > pluginPoints3）→ 真后端 points_exceeded → toast
  const beforeErr = st.ui.snackbar.length;
  store.dispatch({ type: 'wh/assemble', payload: { targetUid: roleItem.uid, pluginUid: mpPlugs[1].uid, slotIndex: 1 } });
  await new Promise((r) => setTimeout(r, 20));
  st = store.getState();
  const errToast = st.ui.snackbar[st.ui.snackbar.length - 1];
  assert.ok(st.ui.snackbar.length > beforeErr, '拒绝有 toast');
  assert.ok(/wh\/assemble: points_exceeded/.test(errToast.text), `点数超限码经 toast（got "${errToast.text}"）`);
  assert.equal(st.warehouse.buckets.role.find((x) => x.uid === roleItem.uid).slots[1].pluginUid, null, '拒绝后状态不变（无 wh/replaced）');
  log(`点数拒绝链路 ok：${mpPlugs[1].uid}(cost=${mpPlugs[1].pointCost}) → 「${errToast.text}」`);

  // 槽型错配：atk 槽装 special 插件 → 真后端 slot_type_mismatch → toast（候选提示面 vs 后端权威面）
  const specialPlug = cands.find((p) => p.slot === 'special' && !p.equipped);
  const atkIdx = roleItem.slots.findIndex((s) => s.type === 'atk');
  assert.ok(specialPlug && atkIdx >= 0, '错配构造');
  store.dispatch({ type: 'wh/assemble', payload: { targetUid: roleItem.uid, pluginUid: specialPlug.uid, slotIndex: atkIdx } });
  await new Promise((r) => setTimeout(r, 20));
  st = store.getState();
  const misToast = st.ui.snackbar[st.ui.snackbar.length - 1];
  assert.ok(/wh\/assemble: slot_type_mismatch/.test(misToast.text), `槽型错配码经 toast（got "${misToast.text}"）`);
  log(`槽型错配链路 ok：${specialPlug.uid}(slot=special) → 槽${atkIdx}(atk) → 「${misToast.text}」`);

  // ── 5/7 拆卸闭环（wh/take → doDisassemble 共用实现 → 真后端 disassemble） ──
  store.dispatch({ type: 'wh/take', payload: { targetUid: roleItem.uid, slotIndex: 0 } });
  await new Promise((r) => setTimeout(r, 20));
  st = store.getState();
  const t3 = st.warehouse.buckets.role.find((x) => x.uid === roleItem.uid);
  assert.equal(t3.slots[0].pluginUid, null, '拆卸后槽空');
  assert.equal(st.warehouse.buckets.rolePlugin.find((x) => x.uid === mpPlugs[0].uid).equipped, false, '真后端回带 equipped=false（候选恢复可见）');
  log('wh/take 拆卸闭环 ok（槽0 已空，插件恢复候选）');

  // ── 7/7 空态 + 越界总检 ──
  const emptySt = initialState();
  const eb = gachaLayout(emptySt);
  assert.ok(eb.find((b) => b.id === 'gacha_empty'), '空态提示存在');
  assert.equal(verifyLayout(eb).issues.length, 0, '空态全绿');
  const wb2 = warehouseLayout(emptySt);
  assert.equal(verifyLayout(wb2).issues.length, 0, '仓库空态全绿');
  assert.equal(wb2.find((b) => b.id === 'wh_goto_gacha').goto, 'gacha', '去开箱跳转');
  log(`空态双屏全绿（${Date.now() - now}ms）`);
  console.log('PROBE-LOOP PASS');
})().catch((e) => { console.error('[FAIL]', e.message); console.error(e.stack); process.exit(1); });