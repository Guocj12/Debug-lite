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
  // ---- F2 设置/日志动作 ----
  // boot：menu error 态「重试」按钮（§6.1 data-action="boot"；F2 审查 P1：原无 EFFECTS['boot'] → 死按钮）
  // 语义：重查 /health → meta/loaded（等价于 app 启动步骤 5 的健康检查；unlock 拉取见 P2 登记）
  'boot': async (ctx) => {
    const r = await ctx.api.get('/health');
    ctx.dispatch({ type: 'meta/loaded', payload: { ok: !!r.ok, version: r.ok && r.data && r.data.version, tableNames: r.ok && r.data && r.data.tableNames } });
    if (ctx.log) {
      const fn = r.ok ? ctx.log.info : ctx.log.warn;
      if (fn) fn('store', 'store.boot', r.ok ? 'server ok (retry)' : 'server unreachable (retry)', { ok: !!r.ok });
    }
  },
  'log/level': async (ctx, action) => {
    const level = action.payload && action.payload.level;
    if (!level) return;
    ctx.dispatch({ type: 'log/set', payload: { level } });
    if (ctx.log && ctx.log.setLevel) ctx.log.setLevel(level);
  },
  'log/reset': async (ctx) => {
    ctx.dispatch({ type: 'log/set', payload: { level: 'debug', channels: {} } });
    if (ctx.log && ctx.log.setLevel) ctx.log.setLevel('debug');
  },
  'log/toggle': async (ctx) => {
    ctx.dispatch({ type: 'goto', payload: { screen: 'settings' } }); // 外壳日志按钮 → 设置屏
  },
  'log/export': async (ctx) => {
    const records = ctx.records ? ctx.records() : [];
    const { exportLogs } = await import('../views/settings.js');
    const text = exportLogs(records, {});
    const doc = ctx.doc;
    if (doc && typeof doc.createElement === 'function') {
      try {
        const blob = new Blob([text], { type: 'application/json' });
        const a = doc.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dl-logs-${Date.now()}.json`;
        a.click();
      } catch (e) { /* 导出失败静默（浏览器环境差异） */ }
    }
  },
};

export function runEffect(ctx, action) {
  const fn = EFFECTS[action.type];
  return fn ? fn(ctx, action) : Promise.resolve();
}