'use strict';
/* store/effects.js —— 副作用层（frontend-spec §4.2 右列）：所有 API 调用与定时器在此，
 * 结果经 dispatch 回流 reducer。ctx = {api, state(), dispatch, log, persist, timers, dom}；测试注入假 api。
 */
import { opponentOf } from '../views/battle.js';

// ai/edit 防抖表（ctx → timer id；store 重建即失效）
const debouncers = new Map();

export function toastErr(ctx, code, message) {
  ctx.dispatch({ type: 'ui/toast', text: `${code}${message ? '：' + message : ''}`, kind: 'error' });
}

// 拉取段位解锁信息（§4.2 tier/set 副作用）
async function fetchTierInfo(ctx) {
  const s = ctx.state();
  const r = await ctx.api.unlock(s.tier);
  if (r.ok) {
    ctx.dispatch({ type: 'tier/info', tierInfo: r.data });
  } else {
    toastErr(ctx, r.code, r.message);
  }
  return r;
}

export function effects(apiExtra) {
  return {
    // 启动（§1.3 步骤5/6）：health → serverOk；unlock → tierInfo；store.boot 日志
    async boot(ctx) {
      const s0 = ctx.state();
      const h = await ctx.api.health();
      ctx.dispatch({ type: 'meta/set', patch: h.ok ? { serverOk: true, version: h.data.version } : { serverOk: false } });
      await fetchTierInfo(ctx);
      const s = ctx.state();
      const hash = s.loadout && s.loadout.ai ? (s.loadout.ai.hash || null) : null;
      const count = s.warehouse && s.warehouse.buckets
        ? Object.values(s.warehouse.buckets).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0)
        : 0;
      ctx.log && ctx.log.info('store', 'store.boot', '前端启动', { state: { tier: s.tier, loadoutHash: hash, warehouseCount: count, serverOk: s.meta.serverOk } });
    },

    // 切段位（写 localStorage；重拉 unlock）——reducer 已在初始 dispatch 应用 tier，这里只做副作用
    async 'tier/set'(ctx, action) {
      await fetchTierInfo(ctx);
      ctx.persist.save(ctx.state());
      ctx.persist.saveSeed(ctx.state().seed);
    },

    // 开箱（§6.4）：POST /box → box/done（合并仓库）→ save；seed 回带由 api client 触发 seed/set
    // busy/opening 由初始 dispatch 的 reducer 设置，此处不得再 dispatch 同名 action（防递归）
    async 'box/open'(ctx, action) {
      const s = ctx.state();
      const r = await ctx.api.box({ seed: s.seed, tier: s.tier, times: action.times || 1 });
      if (r.ok) {
        ctx.dispatch({ type: 'box/done', resp: r.data });
        ctx.persist.save(ctx.state());
      } else {
        ctx.dispatch({ type: 'box/fail' });
        toastErr(ctx, r.code, r.message);
      }
    },

    // 装配（§6.3）：响应 warehouse 整体替换（原子性由后端保证）
    async 'wh/assemble'(ctx, action) {
      const s = ctx.state();
      const r = await ctx.api.wh.assemble({
        warehouse: s.warehouse,
        targetUid: action.targetUid,
        pluginUid: action.pluginUid,
        slotIndex: action.slotIndex,
        tier: s.tier,
      });
      if (r.ok) {
        ctx.dispatch({ type: 'wh/set', warehouse: r.data.warehouse });
        ctx.persist.save(ctx.state());
        ctx.dispatch({ type: 'ui/modal' }); // 装配成功 → 关抽屉
        ctx.log && ctx.log.debug('store', 'wh.assemble.ok', '装配成功', { targetUid: action.targetUid, pluginUid: action.pluginUid });
      } else {
        toastErr(ctx, r.code, r.message);
      }
    },

    // 拆卸（§6.3）
    async 'wh/disassemble'(ctx, action) {
      const s = ctx.state();
      const r = await ctx.api.wh.disassemble({
        warehouse: s.warehouse,
        targetUid: action.targetUid,
        slotIndex: action.slotIndex,
        tier: s.tier,
      });
      if (r.ok) {
        ctx.dispatch({ type: 'wh/set', warehouse: r.data.warehouse });
        ctx.persist.save(ctx.state());
      } else {
        toastErr(ctx, r.code, r.message);
      }
    },

    // 播放状态机（§6.6）：timers 注入缝 —— 每 1000/speed ms seek 下一帧；末帧自动 pause。
    // 不自重复 dispatch replay/play（F8 根因：effect→effect 递归会栈溢出）。
    async 'replay/play'(ctx) {
      const timers = ctx.timers;
      if (!timers || typeof timers.setTimeout !== 'function') return; // 测试桩：仅验证状态
      const schedule = () => {
        const st = ctx.state();
        if (!st.battle.playing) return;
        const last = st.battle.frames.length - 1;
        if (st.battle.tick >= last) {
          ctx.dispatch({ type: 'replay/pause' });
          return;
        }
        timers.setTimeout(() => {
          if (!ctx.state().battle.playing) return;
          ctx.dispatch({ type: 'battle/seek', tick: ctx.state().battle.tick + 1 });
          schedule();
        }, 1000 / (st.battle.speed || 1));
      };
      schedule();
    },

    // seed 随机（§6.5）：Date.now 注入在 effect 层（reducer 保持纯）
    async 'seed/random'(ctx) {
      const seed = Date.now() % 1e9;
      ctx.dispatch({ type: 'seed/set', seed });
    },

    // 起战（§6.5 B22 后接 /battle）：u/uid → 物品解析为 p1；对手模板为 p2
    async 'battle/run'(ctx) {
      const s = ctx.state();
      const pair = opponentOf(s.ui.activeTab.battle);
      const find = (uid) => {
        const b = s.warehouse && s.warehouse.buckets;
        if (!b) return null;
        for (const key of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
          const hit = (b[key] || []).find((x) => x.uid === uid);
          if (hit) return hit;
        }
        return null;
      };
      const ld = s.loadout || {};
      const p1 = {
        role: find(ld.role),
        skills: (ld.skills || []).map((u) => (u ? find(u) : null)),
        ai: ld.ai || null,
      };
      const r = await ctx.api.battle({ p1, p2: pair.loadout, warehouse: s.warehouse, seed: s.seed, tier: s.tier });
      if (r.ok) {
        ctx.dispatch({
          type: 'battle/loaded',
          frames: r.data.frames,
          result: { winner: r.data.winner, phase: r.data.phase, ticks: r.data.ticks },
          config: { id: r.data.id, seed: r.data.seed, tier: r.data.tier },
        });
        ctx.dispatch({ type: 'goto', screen: 'replay' });
      } else {
        ctx.dispatch({ type: 'ui/busy', busy: false });
        toastErr(ctx, r.code, r.message);
      }
    },

    // AI 编辑（§4.2 ai/edit）：debounce 300ms → POST /ai/validate → ai/errors；manual 臂立即校验
    async 'ai/edit'(ctx, action) {
      const runValidate = async () => {
        const st = ctx.state();
        const program = (st.aiDraft && st.aiDraft.program) || null;
        if (!program) return;
        const r = await ctx.api.aiValidate({ program, tier: st.tier });
        ctx.dispatch({ type: 'ai/errors', errors: r.ok ? [] : (Array.isArray(r.details) ? r.details : [{ code: r.code, message: r.message }]) });
      };
      if (action && action.manual) { await runValidate(); return; }
      const timers = ctx.timers;
      if (!timers || typeof timers.setTimeout !== 'function') { await runValidate(); return; }
      // debounce 300ms：只留最后一次（防抖状态挂 ctx 外部表）
      debouncers.set(ctx, timers.setTimeout(() => {
        debouncers.delete(ctx);
        runValidate();
      }, 300));
    },

    // AI 编译（§4.2 ai/compile）→ programHash
    async 'ai/compile'(ctx) {
      const st0 = ctx.state();
      const program = (st0.loadout && st0.loadout.ai) || (st0.aiDraft && st0.aiDraft.program) || null;
      if (!program) {
        ctx.dispatch({ type: 'ai/compiled', hash: null });
        ctx.dispatch({ type: 'ui/toast', text: 'ai_empty：先编辑积木再编译', kind: 'error' });
        return;
      }
      const r = await ctx.api.aiCompile({ program, tier: st0.tier });
      if (r.ok) {
        ctx.dispatch({ type: 'ai/compiled', hash: r.data.programHash || null });
        if (st0.loadout) ctx.dispatch({ type: 'loadout/set', loadout: { ...st0.loadout, ai: program } });
        ctx.dispatch({ type: 'ui/toast', text: `编译通过 hash ${String(r.data.programHash || '').slice(0, 8)}`, kind: 'info' });
      } else {
        ctx.dispatch({ type: 'ai/compiled', hash: null });
        toastErr(ctx, r.code, r.message);
      }
    },

    // 错误行点击 → 高亮（mount 消费 ui.highlight；未找到 → 程序已变化提示）
    async 'editor/highlight'(ctx, action) {
      const ok = ctx.dom && typeof ctx.dom.highlight === 'function' ? ctx.dom.highlight(action.path) : null;
      ctx.dispatch({ type: 'ui/toast', text: ok === false ? '程序已变化，请重新校验' : `高亮 ${action.path}`, kind: 'info' });
    },

    // AI 试运行（R6）：POST /ai/battle → battle/loaded → goto replay
    async 'ai/run'(ctx, action) {
      const s = ctx.state();
      const program = (s.loadout && s.loadout.ai) || (s.aiDraft && s.aiDraft.program);
      if (!program) {
        ctx.dispatch({ type: 'ui/busy', busy: false });
        ctx.dispatch({ type: 'ui/toast', text: 'ai_empty：先编译/保存 AI 程序', kind: 'error' });
        return;
      }
      const r = await ctx.api.aiBattle({ program, seed: s.seed, tier: s.tier, opponent: (action && action.opponent) || 'kiter' });
      if (r.ok) {
        ctx.dispatch({
          type: 'battle/loaded',
          frames: r.data.frames,
          result: { winner: r.data.winner, phase: r.data.phase, ticks: r.data.ticks },
          config: { id: r.data.id, seed: r.data.seed, tier: r.data.tier },
        });
        ctx.dispatch({ type: 'goto', screen: 'replay' });
      } else {
        ctx.dispatch({ type: 'ui/busy', busy: false });
        toastErr(ctx, r.code, r.message);
      }
    },

    // 出战装配（详情「出战」按钮）：本地装配 + 落盘 + 提示
    async 'loadout/equip'(ctx) {
      ctx.persist.save(ctx.state());
      ctx.dispatch({ type: 'ui/toast', text: '出战配置已更新（对战时按 /loadout 校验）', kind: 'info' });
    },

    // 出战配置本地保存（§4.2 loadout/set：可延迟到出战时再 POST 校验）
    async 'loadout/set'(ctx) {
      ctx.persist.save(ctx.state());
    },

    // 出战校验（§4.2 loadout/validate：拒绝时 details → snackbar）
    async 'loadout/validate'(ctx) {
      const s = ctx.state();
      const r = await ctx.api.loadout.save({ loadout: s.loadout, warehouse: s.warehouse, tier: s.tier });
      if (r.ok) {
        ctx.dispatch({ type: 'ui/toast', text: '出战配置校验通过', kind: 'info' });
      } else {
        const details = Array.isArray(r.details) && r.details.length ? r.details : [r.message || r.code];
        for (const d of details.slice(0, 3)) {
          ctx.dispatch({ type: 'ui/toast', text: typeof d === 'string' ? d : JSON.stringify(d), kind: 'error' });
        }
      }
    },

    // 面板（§6.5 preview 用）
    async 'panel/show'(ctx) {
      const s = ctx.state();
      const r = await ctx.api.panel({ loadout: s.loadout, warehouse: s.warehouse, tier: s.tier });
      if (r.ok) {
        ctx.dispatch({ type: 'panel/set', panel: r.data.panel });
      } else {
        ctx.dispatch({ type: 'panel/set', panel: null });
        toastErr(ctx, r.code, r.message);
      }
    },

    // 日志级别（§4.2 log/set）：应用 + 落盘 + 同步后端（开发期，失败忽略）
    async 'log/set'(ctx, action) {
      if (action.level) ctx.log && ctx.log.setLevel(action.level);
      if (action.channels) {
        for (const [ch, lv] of Object.entries(action.channels)) {
          if (lv === null || lv === undefined) continue; // off：不设覆盖（跟随全局级别）
          ctx.log && ctx.log.setChannelLevel(ch, lv);
        }
      }
      const s = ctx.state();
      ctx.persist.saveLogPrefs({ level: s.logPrefs.level, channels: s.logPrefs.channels });
      if (ctx.api && ctx.api.logLevel) {
        const payload = {};
        if (action.level) payload.level = action.level;
        if (action.channels) payload.channels = action.channels;
        await ctx.api.logLevel.set(payload); // 网络失败静默（开发期同步，不阻塞界面）
      }
    },

    // 存档导出（§8）：mount 层落 DOM；无 doc 环境 → toast 提示
    async 'save/export'(ctx) {
      const text = ctx.persist.exportState(ctx.state());
      if (ctx.dom && typeof ctx.dom.download === 'function') {
        ctx.dom.download(`dl-save-${Date.now()}.json`, text);
        ctx.dispatch({ type: 'ui/toast', text: '存档已导出', kind: 'info' });
      } else {
        ctx.dispatch({ type: 'ui/toast', text: '导出需要浏览器环境（已复制到控制台）', kind: 'error' });
        ctx.log && ctx.log.info('store', 'store.export', text, {});
      }
    },

    // 存档导入（§8）：mount 层负责文件读取，此处解析/校验/落盘
    async 'save/import'(ctx, action) {
      const r = ctx.persist.parseImport(action.text || '');
      if (!r.ok) {
        ctx.dispatch({ type: 'ui/toast', text: `导入失败：${r.code}`, kind: 'error' });
        return;
      }
      ctx.dispatch({ type: 'save/set', ...r.patch });
      ctx.persist.save(ctx.state());
      ctx.dispatch({ type: 'goto', screen: 'menu' });
      ctx.dispatch({ type: 'ui/toast', text: '存档已导入', kind: 'info' });
    },

    // seed 变化落盘（api client seed 回带 → seed/set）
    async 'seed/set'(ctx) {
      ctx.persist.saveSeed(ctx.state().seed);
    },

    // toast 自动消散（3s，§3.2）
    async 'ui/toast'(ctx, action, ctxExtra) {
      const timers = ctx.timers;
      if (timers && typeof timers.setTimeout === 'function') {
        timers.setTimeout(() => ctx.dispatch({ type: 'ui/toast/pop' }), (action && action.toastMs) || 3000);
      }
    },
  };
}
