'use strict';
// F2 mount 测试 —— frontend-spec §3.1/§6.0（Box↔HTML 往返 / 事件委托路由 / mountApp 装配 / 日志动作 effects）
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('render：Box → HTML → collectBoxes 往返（坐标/标注/payload 转义/visible）', async () => {
  const { boxToHtml, boxesToHtml, collectBoxes, validateBoxIds } = await import('../../public/js/mount/render.js');
  const boxes = [
    { id: 'a', kind: 'button', parent: null, x: 10, y: 20, w: 160, h: 40, z: 5, visible: true, text: '开箱"测试"', action: 'box/open', payload: { times: 1 } },
    { id: 'b', kind: 'text', parent: 'a', x: 0, y: 0, w: 100, h: 20, z: 1, visible: false, text: '<hidden>' },
    { id: 'c', kind: 'listitem', parent: null, x: 7, y: 8, w: 200, h: 56, z: 0, visible: true, text: 't', detail: 'd', goto: 'gacha' },
    { id: 'd', kind: 'badge', parent: null, x: 1, y: 2, w: 24, h: 24, z: 0, visible: true, text: 'rare', style: 'q-rare' },
    { id: 'e', kind: 'radio', parent: null, x: 1, y: 2, w: 20, h: 20, z: 0, visible: true, text: 'n', style: 'on', action: 'log/level', payload: { level: 'trace' } },
    { kind: 'text', parent: null, x: 5, y: 5, w: 50, h: 10, z: 0, visible: true, text: '无 id 兜底' },
    { id: 'f', kind: 'text', parent: null, x: 5, y: 5, w: 50, h: 10, z: 0, visible: true, text: 'A&B<tag>"q"', detail: 'D&E<d>"' },
  ];
  const html = boxesToHtml(boxes);
  const round = collectBoxes(html);
  assert.equal(round.length, 7);
  assert.equal(round[5].id.startsWith('box_'), true, '无 id 兜底生成');
  assert.equal(round[6].text, 'A&B<tag>"q"', '实体往返（& < "）');
  assert.equal(round[6].detail, 'D&E<d>"', 'detail 实体往返');
  assert.deepEqual([round[0].x, round[0].y, round[0].w, round[0].h, round[0].z], [10, 20, 160, 40, 5]);
  assert.equal(round[0].action, 'box/open');
  assert.deepEqual(round[0].payload, { times: 1 }, 'payload JSON 往返');
  assert.equal(round[0].text, '开箱"测试"', '文本实体反转');
  assert.equal(round[1].visible, false, 'hidden 盒 visible=false');
  assert.equal(round[2].goto, 'gacha');
  assert.equal(round[2].detail, 'd');
  // id 唯一性校验
  const dups = validateBoxIds([...boxes, { id: 'a' }]);
  assert.deepEqual(dups.dups, ['a']);
  assert.ok(validateBoxIds(boxes).ok);
  // 真实视图盒子（shell 全字段 → style/class 臂 + 往返一致性）
  const { shellLayout } = await import('../../public/js/views/shell.js');
  const { menuLayout } = await import('../../public/js/views/menu.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const viewState = { screen: 'menu', tier: 'rare', seed: 7, meta: { serverOk: true }, loadout: { role: { uid: 'r' }, skills: [], ai: null } };
  const all = [...shellLayout(viewState), ...menuLayout(viewState)];
  const vhtml = boxesToHtml(all);
  const vboxes = collectBoxes(vhtml);
  assert.equal(vboxes.length, all.length, '真实视图盒子全量往返');
  assert.equal(vboxes.find((b) => b.id === 'tierBadge').style, 'q-rare', 'style 属性往返');
  assert.equal(vboxes.find((b) => b.id === 'shell_tier'), undefined, '旧未登记盒已移除（F8：坐标全量对齐 screens.md）');
  assert.equal(vboxes.find((b) => b.id === 'btn_gacha').goto, 'gacha');
  // id 属性（F8：injectBoxGeom 经 getElementById 注入几何 → 渲染必须带 id）——boxToHtml 输出含 id="<boxId>"
  assert.ok(vhtml.includes('id="tierBadge"'), 'boxToHtml 输出 id 属性（否则浏览器中所有盒堆在 (0,0)）');
  assert.ok(validateBoxIds(vboxes).ok, '真实视图无重复 id');
  assert.equal(verifyLayout(vboxes).ok, true, '真实视图布局自检通过');
  // 空/null 安全 + 无 box-id 块跳过
  assert.deepEqual(collectBoxes(''), []);
  assert.deepEqual(collectBoxes('<div class="x">no id</div>'), []);
  assert.equal(boxesToHtml(null), '');
  // 畸形防护：无闭合 div 的块（extractText 兜底）+ 非数字坐标 → 0 + 无文本 span
  const partial = '<div class="dl-box dl-text" data-box-id="z" data-box-x="abc" data-box-y="7">孤立文本';
  const p = collectBoxes(partial);
  assert.equal(p.length, 1, '无闭合仍解析');
  assert.equal(p[0].x, 0, '非数字坐标 → 0');
  assert.equal(p[0].text, '', '非自产 HTML 无 span → 文本空（契约面：boxToHtml 恒包 span）');
  const noSpan = collectBoxes('<div class="dl-box" data-box-id="n" data-box-x="1"></div>');
  assert.equal(noSpan[0].text, '', '无文本 span → 空');
  // 空 payload 属性（data-payload=""）→ 解析为 null 不抛
  const emptyPayload = collectBoxes('<div class="dl-box" data-box-id="e" data-box-x="1" data-action="x" data-payload=""></div>');
  assert.equal(emptyPayload[0].payload, null);
  // 极端形状矩阵（分支锤）：零值/字符串坐标/混合标注
  const exotic = [
    { id: 'z0', kind: '', parent: '', x: '0', y: 0, w: 0, h: '', z: 0, visible: true, text: 0 },
    { kind: 'g', x: NaN, y: null, w: undefined, h: 0, z: '', visible: false, text: null },
  ];
  const ehtml = boxesToHtml(exotic.map((b) => ({ ...b, id: b.id })));
  const eround = collectBoxes(ehtml);
  assert.equal(eround.length, 2, '零值/畸形盒可解析');
  assert.equal(eround[0].x, 0, '字符串 0 坐标');
  assert.equal(eround[1].kind, 'g');
  assert.equal(eround[1].visible, false);
  // 文本数字/null 兜底
  assert.equal(eround[0].text, '', '数字文本 → 空');
  // goto 与 action 同盒（双标注）
  const both = collectBoxes(boxesToHtml([{ id: 'ba', kind: 'button', parent: null, x: 0, y: 0, w: 10, h: 10, z: 0, visible: true, text: 'x', action: 'a', goto: 'g' }]));
  assert.equal(both[0].action, 'a');
  assert.equal(both[0].goto, 'g');
});

test('delegate：routeEvent goto/action/payload/坏 payload 不抛/无匹配 null', async () => {
  const { routeEvent } = await import('../../public/js/mount/delegate.js');
  const dispatched = [];
  const dispatch = (a) => dispatched.push(a);
  const mkEl = (attrs, payload) => ({
    dataset: payload === undefined ? attrs : { ...attrs, payload },
    closest: (sel) => (sel === '[data-goto]' && attrs.goto ? mkStar() : sel === '[data-action]' && attrs.action ? mkStar() : null),
  });
  const mkStar = () => null; // 简化：单层匹配场景直接由测试驱动
  // 直接构造两种命中形态：goto 元素
  const elGoto = { closest: (sel) => (sel === '[data-goto]' ? { dataset: { goto: 'warehouse', boxId: 'btn_wh' } } : null) };
  const r1 = routeEvent(elGoto, dispatch, null);
  assert.deepEqual(dispatched[0], { type: 'goto', payload: { screen: 'warehouse' } });
  assert.equal(r1.kind, 'goto');
  // action + payload
  const elAct = { closest: (sel) => (sel === '[data-action]' ? { dataset: { action: 'box/open', payload: '{"times":3}', boxId: 'x' } } : null) };
  const r2 = routeEvent(elAct, dispatch, null);
  assert.deepEqual(dispatched[1], { type: 'box/open', payload: { times: 3 } });
  assert.equal(r2.kind, 'action');
  // 坏 payload → badPayload 且不抛
  const elBad = { closest: (sel) => (sel === '[data-action]' ? { dataset: { action: 'tier/set', payload: '{broken' } } : null) };
  const r3 = routeEvent(elBad, dispatch, null);
  assert.equal(r3.badPayload, true);
  assert.ok(r3.payload === null);
  // 无匹配
  assert.equal(routeEvent({ closest: () => null }, dispatch, null), null);
  // el 无 closest → null
  assert.equal(routeEvent({}, dispatch, null), null);
  // 带 log：debug/warn 各臂
  const logs = [];
  const lg2 = { debug: (ch, ev, msg, d) => logs.push([ev, msg, d]), warn: () => logs.push(['warn']) };
  routeEvent(elGoto, dispatch, lg2);
  routeEvent(elAct, dispatch, lg2);
  routeEvent(elBad, dispatch, lg2);
  assert.ok(logs.some(([ev]) => ev === 'ui.click'), 'click 日志');
  assert.ok(logs.some(([ev]) => ev === 'warn'), '坏 payload warn');
  // action 命中但无 payload 属性（uuid dataset 无 payload）
  const elPlain = { closest: (sel) => (sel === '[data-action]' ? { dataset: { action: 'boot' } } : null) };
  assert.equal(routeEvent(elPlain, dispatch, null).kind, 'action');
});

test('mountApp：no-doc/no-app 跳过；装配后 paint/verify/订阅解除/日志动作 effect 链', async () => {
  const { mountApp } = await import('../../public/js/mount/index.js');
  const { createStore } = await import('../../public/js/store/index.js');
  const { initialState } = await import('../../public/js/store/reducer.js');
  assert.equal(mountApp({}).mounted, false, 'no-doc');
  assert.equal(mountApp({ doc: {} }).reason, 'no-doc', 'doc 无 getElementById → no-doc');
  assert.equal(mountApp({ doc: { getElementById: () => null } }).reason, 'no-app');
  // fake doc 最小装配（无真实 DOM——测装配分支与 store 订阅链）
  let innerHTML = '';
  const fakeDoc = {
    getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : null),
    createElement: () => ({ id: '', href: '', download: '', click: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const store = createStore({
    api: { get: async () => ({ ok: false }), post: async () => ({ ok: false }) },
    log: null,
    records: () => [],
    doc: fakeDoc,
  });
  const renderScreen = (st) => ({ shell: [{ id: 'h', kind: 'text', parent: null, x: 0, y: 0, w: 100, h: 20, z: 0, visible: true, text: st.screen }], main: [] });
  const mount = mountApp({ doc: fakeDoc, store, log: null, records: () => [], renderScreen });
  assert.equal(mount.mounted, true);
  const v1 = mount.lastVerify();
  assert.equal(v1.ok, true, '布局自检通过');
  // store 变化 → 订阅重绘
  store.dispatch({ type: 'goto', payload: { screen: 'settings' } });
  mount.unsubscribe();
  store.dispatch({ type: 'goto', payload: { screen: 'menu' } });
  // 变体：toasts 已存在 + 畸形布局（clip）→ verify warn 日志
  const warnLogs = [];
  const fakeDoc2 = {
    getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : id === 'dl-toasts' ? { id } : null),
    createElement: () => ({ id: '', href: '', download: '', click: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const store2 = createStore({ api: {}, log: null, records: () => [], doc: fakeDoc2 });
  const badRender = (st) => ({ shell: [], main: [{ id: 'overflow', kind: 'text', parent: null, x: -5, y: 0, w: 100, h: 10, z: 0, visible: true, text: st.screen }] });
  const lg3 = { debug: () => {}, warn: (ch, ev, msg, d) => warnLogs.push([ev, d]) };
  const mount2 = mountApp({ doc: fakeDoc2, store: store2, log: lg3, records: () => [], renderScreen: badRender });
  assert.equal(mount2.mounted, true);
  assert.equal(mount2.lastVerify().ok, false, 'clip 被抓');
  assert.ok(warnLogs.some(([ev]) => ev === 'ui.layout.report'), '渲染后布局自检 warn');
  assert.equal(mount2.toastsEl.id, 'dl-toasts', '已存在的 toasts 复用');
  // 变体：无 createElement（朴素 doc）→ toasts null + 不抛
  const fakeDoc3 = { getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : null), addEventListener: () => {}, removeEventListener: () => {} };
  const store3 = createStore({ api: {}, log: null, doc: fakeDoc3 });
  const mount3 = mountApp({ doc: fakeDoc3, store: store3, log: null, records: () => [], renderScreen: (st) => ({ shell: [], main: [] }) });
  assert.equal(mount3.toastsEl, null);
  // 重复 id → warn
  const dupLogs = [];
  const mkDup = createStore({ api: {}, log: null, doc: fakeDoc3 });
  const dupRender = (st) => ({ shell: [{ id: 'x', kind: 'text', parent: null, x: 0, y: 0, w: 10, h: 10, z: 0, visible: true, text: 'a' }], main: [{ id: 'x', kind: 'text', parent: null, x: 0, y: 0, w: 10, h: 10, z: 0, visible: true, text: 'b' }] });
  mountApp({ doc: fakeDoc3, store: mkDup, log: { debug: () => {}, warn: (ch, ev) => dupLogs.push(ev) }, records: () => [], renderScreen: dupRender });
  assert.ok(dupLogs.includes('ui.layout.report'), '重复 id warn');
  // handleClick 测试钩子：事件委托路由直达
  const dispatchLog = [];
  const fakeDoc4 = {
    getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: { appendChild: () => {} } } : null),
    createElement: () => ({ id: '', href: '', download: '', click: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const store4 = createStore({ api: {}, log: null, doc: fakeDoc4 });
  const m4 = mountApp({ doc: fakeDoc4, store: store4, log: null, records: () => [], renderScreen: (st) => ({ shell: [], main: [] }) });
  assert.equal(m4.toastsEl.id, 'dl-toasts', 'parentNode 存在 → 追加 toasts');
  m4.handleClick({ target: { closest: (sel) => (sel === '[data-goto]' ? { dataset: { goto: 'gacha' } } : null) } });
  assert.equal(store4.getState().screen, 'gacha', 'handleClick 路由 goto');
  // removeEventListener 缺失的朴素 doc
  const fakeDoc5 = { getElementById: () => ({ innerHTML: '', parentNode: null }), createElement: () => null, addEventListener: () => {} };
  const m5 = mountApp({ doc: fakeDoc5, store: createStore({ api: {}, log: null, doc: fakeDoc5 }), log: null, records: () => [], renderScreen: (st) => ({ shell: [], main: [] }) });
  m5.unsubscribe(); // removeEventListener falsy 臂不抛
  // 日志动作 effects（无 doc → 导出安全跳过）
  const { runEffect } = await import('../../public/js/store/effects.js');
  const actions = [];
  const ctx = {
    api: { get: async () => ({ ok: false }), post: async () => ({ ok: false }) },
    store: () => ({}),
    dispatch: (a) => actions.push(a),
    log: { setLevel: () => {} },
    records: () => [{ level: 'info', levelValue: 4, channel: 'ui', event: 'x' }],
    doc: null,
    save: null,
  };
  await runEffect(ctx, { type: 'log/level', payload: { level: 'trace' } });
  assert.deepEqual(actions[0], { type: 'log/set', payload: { level: 'trace' } }, 'log/level → log/set');
  await runEffect(ctx, { type: 'log/level', payload: {} });
  assert.equal(actions.length, 1, '空 level → noop');
  await runEffect(ctx, { type: 'log/reset' });
  assert.equal(actions[1].payload.level, 'debug');
  await runEffect(ctx, { type: 'log/toggle' });
  assert.deepEqual(actions[2], { type: 'goto', payload: { screen: 'settings' } });
  await runEffect(ctx, { type: 'log/export' }); // doc null → 不抛
  // 带 doc 导出（Blob 在 node 有全局——守卫下走错误路径或成功，二者均不抛）
  const ctxDoc = { ...ctx, doc: { createElement: () => { throw new Error('no blob'); } } };
  await runEffect(ctxDoc, { type: 'log/export' });
  // F2 审查 P1：boot 重试 effect（menu error 态死按钮修复）——ok/失败双臂
  const bootActions = [];
  const bootOkCtx = { ...ctx, dispatch: (a) => bootActions.push(a), api: { get: async () => ({ ok: true, data: { version: '3.0.0', tableNames: ['t1'] } }) } };
  await runEffect(bootOkCtx, { type: 'boot' });
  assert.deepEqual(bootActions[0], { type: 'meta/loaded', payload: { ok: true, version: '3.0.0', tableNames: ['t1'] } }, 'boot → /health → meta/loaded');
  await runEffect({ ...bootOkCtx, api: { get: async () => ({ ok: false }) } }, { type: 'boot' });
  assert.equal(bootActions[1].payload.ok, false, 'boot 失败 → serverOk=false');
});

test('mount：snackbar → #dl-toasts 渲染 + 注入 toastMs 自动消散（含无容器跳过臂）', async () => {
  const { mountApp } = await import('../../public/js/mount/index.js');
  const { createStore } = await import('../../public/js/store/index.js');
  const { initialState } = await import('../../public/js/store/reducer.js');
  const mkDoc = (toastsEl) => {
    const app = { innerHTML: '', parentNode: { appendChild: () => {} } };
    return {
      app,
      doc: {
        getElementById: (id) => (id === 'app' ? app : id === 'dl-toasts' ? toastsEl : null),
        createElement: () => ({ style: {}, className: '', textContent: '', id: '' }),
        addEventListener: () => {}, removeEventListener: () => {},
      },
    };
  };
  // ① 有 #dl-toasts 容器 → 渲染子元素 + toastMs 后消散
  const seen = [];
  const toastsEl = { innerHTML: '', appendChild: (el) => seen.push(el) };
  const a = mkDoc(toastsEl);
  const storeA = createStore({ api: {}, log: null, doc: a.doc, state: initialState() });
  const logsA = [];
  mountApp({
    doc: a.doc, store: storeA, log: { debug: (ch, ev, msg, d) => logsA.push([ev, msg, d]), warn: () => {} },
    records: () => [], renderScreen: () => ({ shell: [], main: [] }), toastMs: 5,
  });
  storeA.dispatch({ type: 'ui/toast', payload: { text: '开始对战: loadout_invalid', kind: 'danger' } });
  assert.equal(seen.length, 1, 'toast 元素已挂载');
  assert.equal(seen[0].className, 'dl-toast dl-danger', 'kind → 类名');
  assert.equal(seen[0].textContent, '开始对战: loadout_invalid');
  assert.ok(logsA.some(([ev]) => ev === 'ui.toast'), 'ui.toast 日志');
  assert.equal(storeA.getState().ui.snackbar.length, 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(storeA.getState().ui.snackbar.length, 0, 'toastMs 后自动消散（ui/toast/dismiss）');
  assert.equal(seen.length, 1, '消散不重复挂载');
  // ② 无容器（toastsEl null）→ 跳过渲染但不抛
  const b = mkDoc(null);
  const storeB = createStore({ api: {}, log: null, doc: b.doc, state: initialState() });
  mountApp({
    doc: b.doc, store: storeB, log: { debug: () => {}, warn: () => {} },
    records: () => [], renderScreen: () => ({ shell: [], main: [] }), toastMs: 5,
  });
  storeB.dispatch({ type: 'ui/toast', payload: { text: '无容器' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(storeB.getState().ui.snackbar.length, 0, '无容器仍正常消散');
});

test('app boot：带 fake doc 的挂载路径（renderScreen 注入）', async () => {
  const mod = await import('../../public/js/app.js');
  const events = [];
  const fakeDoc = {
    getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : null),
    createElement: () => ({ id: '', href: '', download: '', click: () => {} }),
    addEventListener: (t, fn) => events.push([t, fn]),
    removeEventListener: () => {},
  };
  const stubLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, setLevel: () => {}, setChannelLevel: () => {}, setChannels: () => {}, raw: null };
  const b = await mod.boot({
    fetchImpl: () => Promise.resolve({ text: () => Promise.resolve('{"ok":true,"data":{}}') }),
    log: stubLog,
    doc: fakeDoc,
    loadPersist: () => null,
    renderScreen: (st) => ({ shell: [{ id: 'h', kind: 'text', parent: null, x: 0, y: 0, w: 10, h: 10, z: 0, visible: true, text: st.screen }], main: [] }),
  });
  assert.ok(b.mount && b.mount.mounted, 'fake doc 装配成功');
  assert.ok(events.some(([t]) => t === 'click'), '事件委托已挂');
  await b.health;
});

test('start（模块级启动包装）：boot 拒绝 → 经 log.error 报告（无 console，F2 审查 P1），不产生未处理拒绝', async () => {
  const mod = await import('../../public/js/app.js');
  const errs = [];
  const p = mod.start({
    log: {
      info: () => {}, // boot 起手 info 不抛
      warn: () => { throw new Error('boom-at-warn'); }, // 版本不符同步路径抛 → boot 拒绝
      debug: () => {},
      error: (...a) => errs.push(a),
      setLevel: () => {}, setChannelLevel: () => {},
    },
    loadPersist: () => ({ schemaVersion: 999 }),
    fetchImpl: () => Promise.reject(new Error('x')),
  });
  await p;
  assert.ok(errs.some((a) => a[1] === 'store.boot' && a[2] === 'boot failed'), '启动失败经注入 logger 报告（public/js 全域无 console）');
});

test('app boot 全链路：box/open → effects → ctx.save 落盘 + 视图消费 records + seed 回带', async () => {
  const mod = await import('../../public/js/app.js');
  const mem = {};
  const win = {
    localStorage: {
      setItem: (k, v) => { mem[k] = v; },
      getItem: (k) => (k in mem ? mem[k] : null),
      removeItem: (k) => { delete mem[k]; },
    },
    document: {
      getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : null),
      createElement: () => ({ id: '', href: '', download: '', click: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
  const opaqueLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, setLevel: () => {}, setChannelLevel: () => {}, raw: null };
  let recordsConsumed = 0;
  const b = await mod.boot({
    win,
    fetchImpl: (url) => Promise.resolve({
      text: () => Promise.resolve(url.includes('/box')
        ? JSON.stringify({ ok: true, data: { seed: 9, items: [{ uid: 'r9', kind: 'role' }], tier: 'common' } })
        : JSON.stringify({ ok: true, data: {} })),
    }),
    log: opaqueLog,
    loadPersist: () => null,
    records: () => [{ level: 'info', levelValue: 4, channel: 'ui', event: 'x' }],
    renderScreen: (st, opts) => { recordsConsumed += (opts.records ? opts.records().length : 0); return { shell: [], main: [{ id: 'm', kind: 'text', parent: null, x: 0, y: 0, w: 10, h: 10, z: 0, visible: true, text: st.screen }] }; },
  });
  await b.health;
  // box/open 全链：效果 → box/done → store/save（ctx.save → localStorage dl.v3.state）
  b.store.dispatch({ type: 'box/open', payload: { times: 1 } });
  await new Promise((r) => setTimeout(r, 20));
  const st = b.store.getState();
  assert.equal(st.warehouse.buckets.role[0].uid, 'r9', '开箱并入仓库');
  assert.equal(st.seed, 9, 'seed 回带');
  assert.ok(mem['dl.v3.state'], 'store/save 落盘（ctx.save 链）');
  assert.equal(mem['dl.v3.seed'], '9', 'seed 回带落盘（F2 审查 P1：seed/set 入 SAVE_ON_ACTIONS——F1 声称落实未落码）');
  assert.ok(recordsConsumed >= 1, '视图消费 records 源');
  assert.equal(b.mount.mounted, true, 'win.document 装配');
});

test('app boot：DLLog records 数组接缝（P1 修复）+ dispatch boot 重试全链', async () => {
  const mod = await import('../../public/js/app.js');
  // DLLog.createLogger 的 api.records 是活数组（shared/log.js）——app 默认 records 源必须读数组面
  const recordsArr = [{ level: 'info', levelValue: 3, channel: 'ui', event: 'x' }];
  const events = [];
  const fakeDoc = {
    getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : null),
    createElement: () => ({ id: '', href: '', download: '', click: () => {} }),
    addEventListener: (t, fn) => events.push([t, fn]),
    removeEventListener: () => {},
  };
  const consumed = [];
  const b = await mod.boot({
    fetchImpl: () => Promise.resolve({ text: () => Promise.resolve('{"ok":true,"data":{"version":"3.0.0","tableNames":["x"]}}') }),
    log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, setLevel: () => {}, setChannelLevel: () => {}, raw: { records: recordsArr } },
    doc: fakeDoc,
    loadPersist: () => null,
    renderScreen: (st, opts) => { consumed.push(opts.records ? opts.records().length : 0); return { shell: [], main: [{ id: 'm', kind: 'text', parent: null, x: 0, y: 0, w: 10, h: 10, z: 0, visible: true, text: st.screen }] }; },
  });
  await b.health;
  assert.ok(consumed.some((n) => n === 1), 'DLLog records 数组面接线（P1 修复：原函数面 typeof 永假 → 恒 0 条）');
  assert.equal(b.mount.mounted, true);
  // 兜底臂：raw 存在但 records 非函数非数组 → []
  const consumed2 = [];
  await mod.boot({
    fetchImpl: () => Promise.resolve({ text: () => Promise.resolve('{"ok":true,"data":{}}') }),
    log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, setLevel: () => {}, setChannelLevel: () => {}, raw: { records: 'bogus' } },
    doc: fakeDoc,
    loadPersist: () => null,
    renderScreen: (st, opts) => { consumed2.push(opts.records ? opts.records().length : -1); return { shell: [], main: [] }; },
  });
  assert.ok(consumed2.every((n) => n === 0), '畸形 records 臂 → []');
  // boot effect 全链：menu error 态重试 → /health → meta/loaded（经真实 store.dispatch 路径）
  b.store.dispatch({ type: 'boot' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.store.getState().meta.serverOk, true, 'boot effect 重查 health → serverOk=true');
  assert.equal(b.store.getState().meta.version, '3.0.0', 'version 回填');
});

test('mount：editor 屏 Blockly 装配（createEditor 一次 + presetLoop 真预置 + 高亮消费/toast + 离屏 dispose）', async () => {
  // ★F6 审查 P1 回归锁：createEditor 全仓唯一装配点；workspace 盒 id=blocklyDiv 由 body 级骨架承载；
  // errors 行点击（editor/highlight）→ highlightByPath → 找不到 toast「程序已变化」。
  const { mountApp } = await import('../../public/js/mount/index.js');
  const { createStore } = await import('../../public/js/store/index.js');
  const { initialState } = await import('../../public/js/store/reducer.js');
  const { editorLayout } = await import('../../public/js/views/editor.js');
  const rootBlk = () => ({ id: 'blk_root', type: 'loop_forever', fields: {}, inputs: { body0: { block: { id: 'blk_a', type: 'action', fields: { name: 'wait' }, inputs: {}, next: null } } }, next: null });
  let changeFn = null;
  let disposed = false;
  const hlIds = [];
  const made = [];
  const widget = {
    opts: null,
    addChangeListener: (fn) => { changeFn = fn; },
    getTopBlocks: () => [rootBlk()],
    dispose: () => { disposed = true; },
    highlightBlock: (id) => hlIds.push(id),
    newBlock: (type) => {
      const blk = { type, flags: {} };
      for (const m of ['setMovable', 'setDeletable']) blk[m] = (v) => { blk.flags[m] = v; };
      for (const m of ['initSvg', 'render']) blk[m] = () => { blk.flags[m] = true; };
      blk.moveBy = (x, y) => { blk.flags.move = [x, y]; };
      made.push(blk);
      return blk;
    },
  };
  const fakeBlockly = { inject: (el, opts) => { widget.opts = opts; return { ...widget }; } };
  const prevB = globalThis.Blockly;
  globalThis.Blockly = fakeBlockly;
  try {
    const els = {};
    const elOf = (id) => { if (!els[id]) els[id] = { id, style: {}, innerHTML: '' }; return els[id]; };
    const fakeDoc = {
      getElementById: (id) => elOf(id),
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => ({ id: '', href: '', download: '', click: () => {} }),
    };
    const store = createStore({
      api: { get: async () => ({ ok: true, data: {} }), post: async () => ({ ok: true, data: {} }) },
      log: null,
      doc: fakeDoc,
      state: initialState(),
    });
    const { renderScreen } = await import('../../public/js/views/index.js');
    const mount = mountApp({ doc: fakeDoc, store, log: null, records: () => [], renderScreen });
    // 非 editor 屏：骨架隐藏、不装配
    assert.equal(els.blocklyDiv.style.display, 'none');
    assert.equal(made.length, 0);
    // goto editor → 装配一次：显隐/定位 + createEditor + presetLoop（D-100 根循环 movable/deletable false）
    store.dispatch({ type: 'goto', payload: { screen: 'editor' } });
    const edBox = editorLayout(store.getState()).find((b) => b.id === 'blocklyDiv');
    assert.equal(els.blocklyDiv.style.display, 'block');
    assert.equal(els.blocklyDiv.style.left, `${edBox.x}px`);
    assert.equal(els.blocklyDiv.style.width, `${edBox.w}px`);
    assert.equal(widget.opts.grid.spacing, 24, 'inject 选项（§6.2 grid）');
    assert.equal(widget.opts.zoom.controls, true, 'zoom controls');
    assert.equal(made.length, 1);
    assert.equal(made[0].type, 'loop_forever');
    assert.equal(made[0].flags.setMovable, false);
    assert.equal(made[0].flags.setDeletable, false);
    // 重复 paint（再次 dispatch）不重复装配
    store.dispatch({ type: 'seed/set', payload: { seed: 1 } });
    assert.equal(made.length, 1, '装配仅一次');
    // change 触发 → debounce 300 → ai/edit（后端形状 program，真定时器）
    assert.ok(changeFn, '监听器已挂');
    changeFn();
    await new Promise((r) => setTimeout(r, 380));
    const prog = store.getState().aiDraft.program;
    assert.equal(prog.type, 'program', '实时校验链：change → toAst → ai/edit');
    assert.equal(prog.body.statements[0].type, 'action');
    // 高亮命中：errors 行 action editor/highlight → mount 消费 → highlightBlock + 状态清空
    store.dispatch({ type: 'editor/highlight', payload: { path: 'body.s[0]' } });
    assert.deepEqual(hlIds, ['blk_a']);
    assert.equal(store.getState().aiDraft.highlightPath, null, '消费后清空（editor/highlight/done）');
    // 高亮 miss：路径越界 → toast「程序已变化」
    store.dispatch({ type: 'editor/highlight', payload: { path: 'body.s[99]' } });
    const toast = store.getState().ui.snackbar[0];
    assert.ok(toast, 'miss → toast');
    assert.equal(toast.text, '程序已变化');
    // 离屏 → dispose + 骨架隐藏；再进 → 重新装配
    store.dispatch({ type: 'goto', payload: { screen: 'menu' } });
    assert.equal(disposed, true, '离屏 dispose（清 debounce 定时器 + widget.dispose）');
    assert.equal(els.blocklyDiv.style.display, 'none');
    store.dispatch({ type: 'goto', payload: { screen: 'editor' } });
    assert.equal(made.length, 2, '再进重新装配');
    mount.unsubscribe();
  } finally {
    if (prevB === undefined) delete globalThis.Blockly;
    else globalThis.Blockly = prevB;
  }
});