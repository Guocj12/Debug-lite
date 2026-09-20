'use strict';
/* public/contract.js —— F1「字段来源契约」（设计依据 docs/frontend/01-auth.md §5；总纲规则 4.2）
 *
 * 这张表是「前端读哪些响应字段」的**唯一清单**，三者必须逐条相等（由
 * tests/frontend/auth-field-contract.test.js 强制）：
 *   ① 本文件 AUTH_FIELD_CONTRACT 的 path 集合；
 *   ② public/format.js 中 pick(<expr>, '<path>') 的字面量集合；
 *   ③ docs/frontend/01-auth.md §5 表格里反引号标注的路径集合。
 * 每条 path 都来自 2026-09-20 对真实 HTTP 响应的实测抓取（探针见 docs/reviews/F1.md）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.contract = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var AUTH_FIELD_CONTRACT = [
    // POST /api/v1/auth/register、POST /api/v1/auth/login（两者同形）
    { endpoint: 'register|login', path: 'data.publicId', use: '会话·账号显示' },
    { endpoint: 'register|login', path: 'data.nickname', use: '会话·昵称显示' },
    { endpoint: 'register|login', path: 'data.token', use: '写入 localStorage[dl.token]' },
    { endpoint: 'register|login', path: 'data.expiresAt', use: '会话到期时间文本' },
    { endpoint: 'register|login', path: 'data.player.tier', use: '登录后主页段位（首屏即时）' },
    { endpoint: 'register|login', path: 'data.player.points', use: '登录后主页积分（首屏即时）' },
    { endpoint: 'register|login', path: 'data.player.activeSlotName', use: '登录后主页出战槽名（首屏即时）' },
    // GET /api/v1/me
    { endpoint: 'me', path: 'data.publicId', use: '账号' },
    { endpoint: 'me', path: 'data.nickname', use: '昵称' },
    { endpoint: 'me', path: 'data.progress.tier', use: '段位' },
    { endpoint: 'me', path: 'data.progress.peakTier', use: '峰值段位' },
    { endpoint: 'me', path: 'data.rating.points', use: '积分' },
    { endpoint: 'me', path: 'data.rating.games', use: '总场次' },
    { endpoint: 'me', path: 'data.rating.wins', use: '胜' },
    { endpoint: 'me', path: 'data.rating.losses', use: '负' },
    { endpoint: 'me', path: 'data.rating.draws', use: '平' },
    { endpoint: 'me', path: 'data.activeSlotId', use: '出战槽 id' },
    { endpoint: 'me', path: 'data.activeSlotName', use: '出战槽名' },
    { endpoint: 'me', path: 'data.slots', use: '配置槽清单（数组）' },
    { endpoint: 'me', path: 'data.pool.inPool', use: '是否在匹配池' },
    { endpoint: 'me', path: 'data.pool.drawnCount', use: '被抽次数' },
    { endpoint: 'me', path: 'data.record.stats.attack.wins', use: '进攻·胜' },
    { endpoint: 'me', path: 'data.record.stats.attack.losses', use: '进攻·负' },
    { endpoint: 'me', path: 'data.record.stats.attack.draws', use: '进攻·平' },
    { endpoint: 'me', path: 'data.record.stats.defense.wins', use: '防守·胜' },
    { endpoint: 'me', path: 'data.record.stats.defense.losses', use: '防守·负' },
    { endpoint: 'me', path: 'data.record.stats.defense.draws', use: '防守·平' },
    { endpoint: 'me', path: 'data.record.unread.attack', use: '未读进攻战绩数' },
    { endpoint: 'me', path: 'data.record.unread.defense', use: '未读防守战绩数' },
    { endpoint: 'me', path: 'data.flags.unverifiedLoadout', use: '仓库校验状态' },
    { endpoint: 'me', path: 'data.flags.isBot', use: '是否机器人' },
    // POST /api/v1/auth/password
    { endpoint: 'password', path: 'data.changed', use: '改密是否生效' },
    { endpoint: 'password', path: 'data.revokedOthers', use: '已撤销的其他会话数' },
    // POST /api/v1/auth/logout
    { endpoint: 'logout', path: 'data.revoked', use: '登出是否生效' },
    // 任意端点：统一信封（server/index.js okEnvelope/errEnvelope）
    { endpoint: 'any', path: 'ok', use: '成功/失败判定（唯一分支依据）' },
    { endpoint: 'any', path: 'error.code', use: '错误分类与文案选择' },
    { endpoint: 'any', path: 'error.message', use: '默认展示文案（服务端中文文案）' },
    { endpoint: 'any', path: 'error.details', use: '字段级错误（取首条 path）' },
  ];

  // 明确「不读取」的字段（防止散文式字段混入）：与上表必须无交集
  var UNUSED_FIELDS = ['data.player.playerId', 'data.record.appliedSeq', 'data.pool.lastDrawnAt',
    'data.flags.banReason', 'data.progress.lastBatchId'];

  return { AUTH_FIELD_CONTRACT: AUTH_FIELD_CONTRACT, UNUSED_FIELDS: UNUSED_FIELDS };
});
