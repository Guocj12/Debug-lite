// store/effects.js —— 副作用层（frontend-spec §4.2：签名 (ctx, action) → Promise；ctx={api,store,dispatch,log}）
// 测试可注入假 api；网络失败一律不抛（toast 兜底）。

export function toastCtx(ctx, action, r) {
  if (r && !r.ok) {
    ctx.dispatch({ type: 'ui/toast', payload: { text: `${action.type.slice(0, 20)}: ${r.code || '失败'}`, kind: 'danger' } });
  }
}

export const EFFECTS = {
  // tier/set：GET /unlock?tier= → tierInfo（§4.2 行）
  'tier/set': async (ctx, action) => {
    const r = await ctx.api.get(`/unlock?tier=${action.payload.tier}`);
    if (r.ok) ctx.dispatch({ type: 'tier/loaded', payload: r.data });
    else toastCtx(ctx, action, r);
  },
  // box/open：POST /box → box/done（合并 + 回带 seed + 存档；失败 toast）
  'box/open': async (ctx, action) => {
    const st = ctx.store();
    const r = await ctx.api.post('/box', { times: action.payload.times, tier: st.tier, seed: st.seed });
    ctx.dispatch({ type: 'box/done', payload: r });
    if (r.ok) ctx.dispatch({ type: 'store/save' });
    else toastCtx(ctx, action, r);
  },
  // wh/assemble：POST（带 tier，P2-5）→ 用响应 warehouse 整体替换（§4.2 行）
  'wh/assemble': async (ctx, action) => {
    const st = ctx.store();
    const r = await ctx.api.post('/warehouse/assemble', {
      warehouse: st.warehouse, targetUid: action.payload.targetUid,
      pluginUid: action.payload.pluginUid, slotIndex: action.payload.slotIndex, tier: st.tier,
    });
    if (r.ok) {
      ctx.dispatch({ type: 'wh/replaced', payload: { warehouse: r.data.warehouse } });
      ctx.dispatch({ type: 'store/save' });
    } else {
      toastCtx(ctx, action, r);
    }
  },
  // wh/disassemble：POST → 整体替换
  'wh/disassemble': async (ctx, action) => {
    const st = ctx.store();
    const r = await ctx.api.post('/warehouse/disassemble', {
      warehouse: st.warehouse, targetUid: action.payload.targetUid, slotIndex: action.payload.slotIndex,
    });
    if (r.ok) {
      ctx.dispatch({ type: 'wh/replaced', payload: { warehouse: r.data.warehouse } });
      ctx.dispatch({ type: 'store/save' });
    } else {
      toastCtx(ctx, action, r);
    }
  },
  // loadout/validate：POST /loadout → details 展开（错误入 aiDraft.errors）
  'loadout/validate': async (ctx) => {
    const st = ctx.store();
    const r = await ctx.api.post('/loadout', { loadout: st.loadout, warehouse: st.warehouse, tier: st.tier });
    ctx.dispatch({ type: 'loadout/errors', payload: { errors: r.ok ? [] : (r.details || [{ code: r.code, message: r.message }]) } });
  },
  // ai/compile：POST /ai/compile → hash + stats
  'ai/compile': async (ctx) => {
    const st = ctx.store();
    const r = await ctx.api.post('/ai/compile', { ai: st.aiDraft.program });
    ctx.dispatch({ type: 'ai/compiled', payload: r.ok ? { hash: r.data.hash, errors: r.data.errors || [] } : { hash: null, errors: r.details || [] } });
  },
  // ai/run：POST /ai/validate + /ai/battle → battle/loaded（F5 起对接回放；F1 P1-4：带 tier 防门控放宽）
  'ai/run': async (ctx, action) => {
    const st = ctx.store();
    const r = await ctx.api.post('/ai/battle', { ai: st.aiDraft.program || st.loadout.ai, opponent: action.payload.opponent, seed: st.seed, tier: st.tier });
    if (r.ok) {
      ctx.dispatch({ type: 'battle/loaded', payload: { frames: r.data.frames || [], result: { winner: r.data.winner, ticks: r.data.ticks } } });
      ctx.dispatch({ type: 'goto', payload: { screen: 'replay' } });
    } else {
      toastCtx(ctx, action, r);
    }
  },
  // panel/show：POST /panel → panel/loaded
  'panel/show': async (ctx) => {
    const st = ctx.store();
    const r = await ctx.api.post('/panel', { loadout: st.loadout, warehouse: st.warehouse, tier: st.tier });
    if (r.ok) ctx.dispatch({ type: 'panel/loaded', payload: r.data.panel });
    else toastCtx(ctx, { type: 'panel/show' }, r);
  },
  // store/save：落盘（由各业务 effect 触发）
  'store/save': async (ctx, action) => {
    if (ctx.save) ctx.save(ctx.store());
  },
};

export function runEffect(ctx, action) {
  const fn = EFFECTS[action.type];
  return fn ? fn(ctx, action) : Promise.resolve();
}