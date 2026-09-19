'use strict';
/* server/core/effects.js —— 效果系统（P1 B2，契约 docs/interfaces.md §1）
 * 依据：systems/05-effects.md（数据结构与结算顺序）；examples/05-effects.md E-1..E-8（数值期望）。
 * 纯函数内核（L11）：无 IO / 无随机 / 无 console；日志经 withLogger 注入（缺省 nullLogger）。
 * 事件：effect.add(debug) / effect.continuous(trace) / effect.expire(debug) / effect.control.override(debug)（§4.6）。
 * 接口形态（B2 登记）：
 *   addEffect(state, effect) → effect（补 uid；addedTick=state.tick 保证"下一 tick 起效"，E-1①/EF-10）
 *   resolveContinuous(state) → 结算所有 continuous（hp/mp/sp clamp [0,max]；atk/def clamp ≥0；remaining-=1 归零移除）
 *     缺陷 1（2026-09-19）：atk/def 面板修饰到期**回滚累计已生效增量**（临时增益不得变永久收益）；
 *     hp/mp/sp 资源流量按 E-1 结算即生效、到期不回滚。语义分界见 RESOURCE_STATS / PANEL_STATS 注释。
 *   resolveControl(effects, aiAction) → {action}：'wait'（眩晕）| {action:'forced_move', dir, cells}（位移意图，
 *      不可穿标记由引擎 B8 统一落位消费，D-71；碰撞伤害 B8 结算，D-35）| 原行动（无控制）
 *   resolveControlMove(x, otherX, cells) → 单方落位（clamp + 中心距 ≥64 约束，T-FD-4；对方静止假设，
 *      双方同时移动的权威解算在 engine 步骤 7 统一落位，B8）
 */
const { nullLogger } = require('../../shared/log.js');
const config = require('../data/battle-config.json');

const CELL_PX = config.cellPx;
const CLAMP_LOW = config.actorHalfPx;
const CLAMP_HIGH = config.fieldPx - config.actorHalfPx;
const MIN_GAP = config.minGapPx;

// stat → max 上限字段映射（hp→maxHp 等）
const MAX_FIELD = { hp: 'maxHp', mp: 'maxMp', sp: 'maxSp' };

// 两种持续效果语义（缺陷 1 修复口径，2026-09-19）：
//   ① **资源池流量**（hp/mp/sp）：delta 是"每 tick 的流量"（DoT/回血/回蓝），结算即**永久改变**资源量，
//      效果到期**不回滚**——依据 examples/05-effects.md E-1（hp 132→129→126→123 后保持 123）/E-2a/b/e。
//   ② **属性面板修饰**（atk/def）：delta 是"对面板属性的临时修饰"，每 tick 叠加一次；效果到期必须把
//      **本效果累计已生效的增量**减回，否则临时增益变成**永久增益**（缺陷 1：cast_buff 净 +4 且不回滚）。
//      `atk/def` 无上限、下限 0，故回滚按"实际生效增量"（含 clamp 修正）而非 `delta × 次数`。
const RESOURCE_STATS = new Set(['hp', 'mp', 'sp']);
const PANEL_STATS = new Set(['atk', 'def']);

let uidSeq = 0;

function makeEffects(logger) {
  const L = logger || nullLogger;

  function addEffect(state, effect) {
    if (!effect.uid) {
      effect.uid = `eff_${uidSeq++}`;
    }
    const player = state.players[effect.target];
    if (!player) {
      throw new RangeError(`addEffect: 未知目标 ${effect.target}`);
    }
    effect.addedTick = state.tick;
    player.effects.push(effect);
    L.debug('effects', 'effect.add', `add ${effect.kind}->${effect.target}`, { kind: effect.kind, target: effect.target, stat: effect.stat, displacement: effect.displacement, remaining: effect.remaining });
    return effect;
  }

  // 面板修饰类（atk/def）到期回滚（缺陷 1）：把该效果**累计实际生效**的增量减回，使属性严格回到施放前。
  //   - `eff.applied` 由 resolveContinuous 逐 tick 累加（= Σ(after - before)，已含 hp/mp/sp clamp 与属性下限 0 的修正）；
  //   - 资源类（hp/mp/sp）不回滚（E-1 口径），未生效过（applied 为 0/undefined，如 remaining≤0 直接移除）不回滚；
  //   - 回滚结果为属性下限 0（不出现负属性）；多个同类效果各记各的 applied → 叠加也能精确回滚。
  //   移除路径统一走本函数（正常到期 + 入口清理两条），保证"条目消失"与"属性回滚"同 tick 发生。
  function revertPanelEffect(player, eff) {
    if (!PANEL_STATS.has(eff.stat)) return 0;
    const applied = typeof eff.applied === 'number' ? eff.applied : 0;
    if (applied === 0) return 0;
    const before = player[eff.stat];
    const after = Math.max(0, before - applied);
    player[eff.stat] = after;
    return after - before; // 负数=净减（回滚掉的增量）
  }

  function resolveContinuous(state) {
    // 入口清理：remaining≤0 立即移除、不结算（05-effects §5）；防御性回滚（正常路径已回滚，此处 applied 通常为 0）
    for (const owner of Object.keys(state.players)) {
      const player = state.players[owner];
      for (const eff of [...player.effects]) {
        if (eff.kind === 'continuous' && eff.remaining <= 0) {
          revertPanelEffect(player, eff);
          player.effects.splice(player.effects.indexOf(eff), 1);
          L.debug('effects', 'effect.expire', `${eff.uid} 过期立即移除`, { uid: eff.uid, stat: eff.stat });
        }
      }
    }
    for (const owner of Object.keys(state.players)) {
      const player = state.players[owner];
      const effects = [...player.effects];
      for (const eff of effects) {
        if (eff.kind !== 'continuous') continue;
        if (eff.addedTick === state.tick) continue; // 新效果下一 tick 起效（E-1①）
        const stat = eff.stat;
        const before = player[stat];
        let after = before + eff.delta;
        if (RESOURCE_STATS.has(stat)) {
          const max = player[MAX_FIELD[stat]];
          if (after > max) after = max;
          if (after < 0) after = 0;
        } else if (after < 0) {
          after = 0; // atk/def 下限 0
        }
        player[stat] = after;
        // 缺陷 1：记录**实际生效**增量（clamp 后），到期时据此回滚面板修饰类属性
        eff.applied = (typeof eff.applied === 'number' ? eff.applied : 0) + (after - before);
        eff.remaining -= 1;
        L.trace('effects', 'effect.continuous', `${eff.uid}: ${stat} ${before} -> ${after}`, { uid: eff.uid, stat: eff.stat, delta: eff.delta, before, after, remaining: eff.remaining });
        if (eff.remaining <= 0) {
          const reverted = revertPanelEffect(player, eff);
          player.effects.splice(player.effects.indexOf(eff), 1);
          L.debug('effects', 'effect.expire', `${eff.uid} 到期移除`, { uid: eff.uid, stat: eff.stat, applied: eff.applied, reverted });
        }
      }
    }
  }

  // 复写 AI 行动：眩晕 > 位移；位移取首个加入顺序（E-6）；所有 control 本 tick 递减 remaining（归零移除，E-4/E-5）
  function resolveControl(effects, aiAction) {
    // 入口清理：remaining≤0 立即移除、不结算、不采用（05-effects §5）
    for (const eff of [...effects]) {
      if (eff.kind === 'control' && eff.remaining <= 0) {
        effects.splice(effects.indexOf(eff), 1);
        L.debug('effects', 'effect.expire', `${eff.uid} 过期立即移除`, { uid: eff.uid, kind: 'control' });
      }
    }
    const stun = effects.find((e) => e.kind === 'control' && e.displacement === 0);
    const displace = effects.find((e) => e.kind === 'control' && e.displacement !== 0);
    let chosen = null;
    if (stun) chosen = { action: 'wait' };
    else if (displace) {
      chosen = {
        action: 'forced_move',
        dir: displace.displacement > 0 ? 1 : -1,
        cells: Math.abs(displace.displacement),
      };
    }
    // 全部 control 效果各自递减（与持续效果同频计时）
    for (const eff of [...effects]) {
      if (eff.kind !== 'control') continue;
      eff.remaining -= 1;
      if (eff.remaining <= 0) {
        effects.splice(effects.indexOf(eff), 1);
        L.debug('effects', 'effect.expire', `${eff.uid} 控制效果到期移除`, { uid: eff.uid, kind: 'control' });
      }
    }
    if (!chosen) return { action: aiAction };
    L.debug('effects', 'effect.control.override', `override ${aiAction} -> ${chosen.action}`, { from: aiAction, to: chosen.action, dir: chosen.dir, cells: chosen.cells });
    return chosen;
  }

  // 单方落位：clamp [actorHalf, fieldPx-actorHalf] + 中心距 ≥ 64（对方静止假设；D-06/T-FD-4/E-5b/c/d）
  // gap 钳位：移动方向朝向对方（(otherX-x)×dir>0）且意图终点距对方 <64（无论终点落在对方哪侧，E-5b/d）→
  // 停在被撞侧前方 64（向右撞 → 敌左 64；向左撞 → 敌右 64）；背离方向或远距离不钳
  function resolveControlMove(x, otherX, displacement) {
    let to = x + displacement * CELL_PX;
    const towardEnemy = (otherX - x) * displacement > 0;
    if (towardEnemy && Math.abs(otherX - to) < MIN_GAP) {
      to = displacement > 0 ? otherX - MIN_GAP : otherX + MIN_GAP;
    }
    if (to < CLAMP_LOW) to = CLAMP_LOW;
    if (to > CLAMP_HIGH) to = CLAMP_HIGH;
    return to;
  }

  return { addEffect, resolveContinuous, resolveControl, resolveControlMove };
}

module.exports = Object.assign(makeEffects(), { withLogger: (logger) => makeEffects(logger) });