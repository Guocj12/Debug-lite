// store/effects.js —— 副作用层（frontend-spec §4.2：签名 (ctx, action) → Promise；ctx={api,store,dispatch,log}）
// 测试可注入假 api；网络失败一律不抛（toast 兜底）。
import { clampTick } from '../render/planFrame.js';

// 播放定时器来源（F5：ctx.timers 注入缝；缺省浏览器定时器——测试注入假 timers）
function storedTimers(ctx) {
  return ctx.timers || { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) };
}

export function toastCtx(ctx, action, r) {
  if (r && !r.ok) {
    ctx.dispatch({ type: 'ui/toast', payload: { text: `${action.type.slice(0, 20)}: ${r.code || '失败'}`, kind: 'danger' } });
  }
}

// wh/disassemble / wh/take（详情槽位拆卸，F3）：POST → 整体替换（共用实现）
async function doDisassemble(ctx, action) {
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
}

// 播放停止（共用：清 playbackTimer + 复位 playing；battle/pause 与 replay/pause 同语义）
function stopPlayback(ctx) {
  const timers = storedTimers(ctx);
  if (ctx.playbackTimer !== undefined && ctx.playbackTimer !== null && timers.clearInterval) {
    timers.clearInterval(ctx.playbackTimer);
  }
  ctx.playbackTimer = null;
  ctx.dispatch({ type: 'battle/pause' });
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
  // wh/disassemble / wh/take（详情槽位拆卸，F3）：共用 doDisassemble（定义在上方）
  'wh/disassemble': doDisassemble,
  'wh/take': doDisassemble,
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
  // ---- F4 对战动作 ----
  // battle/run：POST /battle（B22 完整双配置）→ battle/loaded → goto replay
  // F4 审查 P1：请求体必须带 warehouse——loadout 装配引用（role/skills[].slots[].pluginUid）需要
  // 仓库做引用完整性校验（T-PB-9）；缺省 → 后端 409 missing_warehouse（真后端探针实证）。
  'battle/run': async (ctx, action) => {
    const st = ctx.store();
    const r = await ctx.api.post('/battle', {
      p1: st.loadout, p2: (action.payload && action.payload.opponent) || null,
      seed: st.seed, tier: st.tier, warehouse: st.warehouse,
    });
    if (r.ok) {
      ctx.dispatch({ type: 'battle/loaded', payload: { frames: r.data.frames || [], result: { winner: r.data.winner, ticks: r.data.ticks } } });
      ctx.dispatch({ type: 'goto', payload: { screen: 'replay' } });
    } else {
      toastCtx(ctx, action, r);
    }
  },
  // seed/random：随机种子（ctx.randomInt 注入缝——app 浏览器侧可注入 crypto；缺省 Date.now 派生；
  // 随机性属客户端选择域，非战斗确定性输入（同 seed 复现语义不受影响）
  'seed/random': async (ctx) => {
    const rnd = (ctx.randomInt && ctx.randomInt()) || ((Date.now() >>> 0) % 0x7fffffff) + 1;
    ctx.dispatch({ type: 'seed/set', payload: { seed: rnd } });
  },
  // battle/opp：对手选择（无副作用——仅存 activeTab）
  'battle/opp': async (ctx, action) => {
    const st = ctx.store();
    ctx.dispatch({ type: 'battle/opp/set', payload: { id: action.payload.id } });
    void st;
  },
  // ---- F5 回放播放状态机（§6.6：playing 时每 1000/speed ms seek tick+1；末帧自动 pause；timers 经 storedTimers）----
  'replay/step': async (ctx, action) => {
    const st = ctx.store();
    const delta = (action.payload && action.payload.delta) || 1;
    ctx.dispatch({ type: 'battle/seek', payload: { tick: clampTick(st.battle.tick, st.battle.frames, delta) } });
  },
  'replay/play': async (ctx) => {
    if (ctx.playbackTimer !== undefined && ctx.playbackTimer !== null) return; // 防重入
    const st = ctx.store();
    const frames = st.battle.frames || [];
    if (frames.length <= 1) return;
    if (!st.battle.playing) ctx.dispatch({ type: 'battle/play' });
    const timers = storedTimers(ctx);
    const ms = Math.max(50, Math.floor(1000 / (st.battle.speed || 1))); // 倍速映射（F5：≤20fps 防抖）
    ctx.playbackTimer = timers.setInterval(() => {
      const s = ctx.store();
      const framesN = s.battle.frames || [];
      const n = clampTick(s.battle.tick, framesN, 1);
      const done = framesN.length > 0 && n === framesN.length - 1;
      ctx.dispatch({ type: 'battle/seek', payload: { tick: n } });
      if (done) {
        if (ctx.playbackTimer !== null && timers.clearInterval) timers.clearInterval(ctx.playbackTimer);
        ctx.playbackTimer = null;
        ctx.dispatch({ type: 'battle/pause' });
      }
    }, ms);
  },
  // battle/pause 与 replay/pause（§4.2 契约 action 名=播放/暂停切换，F5 审查 P1：播放中按钮 action 为
  // replay/pause，原 EFFECTS 无此键 → 暂停按钮是死按钮（定时器不清、playing 不复位）——补齐别名实现）
  'battle/pause': async (ctx) => { stopPlayback(ctx); },
  'replay/pause': async (ctx) => { stopPlayback(ctx); },
  'replay/speed': async (ctx, action) => {
    ctx.dispatch({ type: 'battle/speed', payload: { speed: action.payload.speed } });
    // 播放中改速 → 重启定时器（保持节奏一致）
    if (ctx.playbackTimer !== undefined && ctx.playbackTimer !== null) {
      const timers = storedTimers(ctx);
      if (timers.clearInterval) timers.clearInterval(ctx.playbackTimer);
      ctx.playbackTimer = null;
      await runEffect(ctx, { type: 'replay/play' });
    }
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