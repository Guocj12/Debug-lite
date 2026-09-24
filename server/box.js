'use strict';
/* server/box.js —— 开箱服务端编排（P3 B17；契约 docs/interfaces.md §2 POST /api/v1/box）
 * L6（server 层，与 runner.js 同层）：校验（tier/times/seed）→ 每箱独立 rng 流（deriveStream(i,'box')）→ items.openBox。
 * 错误码：400 bad_tier / bad_times / bad_seed；409 tier_locked = 门控后掉落池为空（RangeError 映射——当前数据
 * 各段位池恒非空，属防御路径；opts.items 为测试接缝，T-AP-3 在 helper 级覆盖）。
 * 缺省口径：**API 层 tier 缺省 common**（本文件）；core items.openBox 缺省 mythic（B3 兼容）——层次不同，勿混用。
 * 事件：api.*（api 行）；items.roll 与 items.generate（items 行）。
 *
 * D-162（2026-09-22，用户裁决）：**随机性收归服务端**——HTTP 接口**不设 `seed` 入参**（客户端不可指定），
 *   seed 一律由服务端生成（响应可回带，仅供审计/复现日志）。`opts.seed` 保留给**进程内调用方**
 *   （离线 `npm run play`/`demo`/核心单测）；HTTP 层的确定性由实例级注入缝 `opts.seedFactory`
 *   （= `start({boxSeed})`，见 docs/interfaces.md §7）提供。
 */
const items = require('./core/items.js');
const unlock = require('./core/unlock.js');
const rng = require('./core/rng.js');
const crypto = require('node:crypto');

const BOX_TIMES_MAX = 100; // 单次开箱次数上限（请求防护常量，非战斗数值）

function openBoxes(opts) {
  const tier = opts.tier === undefined ? 'common' : String(opts.tier);
  if (unlock.tierIndex(tier) === null) {
    return { status: 400, code: 'bad_tier', data: null, message: `非法段位 ${tier}（可选: common/rare/epic/legendary/mythic）` };
  }
  const times = opts.times === undefined ? 1 : opts.times;
  if (!Number.isInteger(times) || times < 1 || times > BOX_TIMES_MAX) {
    return { status: 400, code: 'bad_times', data: null, message: `非法次数 ${times}（必须是 1..${BOX_TIMES_MAX} 的整数）` };
  }
  // D-162：HTTP 层**不传** seed（随机性服务端独占）；本参数的语义只对**进程内调用方**有效：
  //   · 未提供（undefined/null）→ 用 `opts.seedFactory`（= `start({boxSeed})` 注入缝）或 `crypto.randomInt`；
  //   · **显式提供了非法值**（非整数 / 越界）→ 如实 400 `bad_seed`（不静默忽略，便于内部调用方及早发现拼错参数）。
  const seedProvided = opts.seed !== undefined && opts.seed !== null;
  const seed = seedProvided
    ? opts.seed
    : (typeof opts.seedFactory === 'function' ? opts.seedFactory() : crypto.randomInt(1, 0x7fffffff));
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 1 || seed > 0x7fffffff) {
    return { status: 400, code: 'bad_seed', data: null, message: `非法 seed ${seed}（必须是 1..2147483647 的整数）` };
  }
  const itemsApi = opts.items || (opts.logger ? items.withLogger(opts.logger) : items);
  const seedRng = rng.createRng(seed);
  const boxed = [];
  try {
    for (let i = 0; i < times; i++) {
      boxed.push(itemsApi.openBox(seedRng.deriveStream(i, 'box'), { tier }));
    }
  } catch (e) {
    if (e instanceof RangeError) {
      // 门控后掉落池为空 → 段位业务拒绝（数据形态下防御路径；T-AP-3 语义）
      return { status: 409, code: 'tier_locked', data: null, message: e.message };
    }
    throw e;
  }
  return { status: 200, code: null, data: { seed, tier, times, items: boxed }, message: null };
}

module.exports = { openBoxes, BOX_TIMES_MAX };