'use strict';
/* public/contract.js —— 「字段来源契约」（设计依据 docs/frontend/01-auth.md §5 + docs/frontend/02-accounts.md §5
 *   + docs/frontend/03-hub-warehouse-loadout.md §5；总纲规则 4.2「字段名不得来自散文」）
 *
 * 这张表是「前端读哪些响应字段」的**唯一清单**，三者必须逐条相等（由
 * tests/frontend/auth-field-contract.test.js 强制）：
 *   ① 本文件 AUTH_FIELD_CONTRACT 的 path 集合；
 *   ② public/format.js 中 pick(<expr>, '<path>') 的字面量集合（信封级，第一实参为 env）；
 *   ③ docs/frontend/{01,02,03}*.md 的 §5 表格里反引号标注的路径集合（并集）。
 * F1 的每条 path 来自 2026-09-20 对真实 HTTP 响应的实测抓取（探针见 docs/reviews/F1.md）；
 * F2 的每条 path 来自 2026-09-22 的实测抓取（tests/api/api-admin-accounts.test.js 的同源契约）；
 * F3 的每条 path 来自 2026-09-22 提交① 后端契约落地后的实测抓取（真起服务；见
 *   tests/frontend/hub-warehouse-flow.test.js 的 WH-C1/WH-C2 与 docs/frontend/03 §5.2/O-14）。
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
    { endpoint: 'register|login', path: 'data.player.isAdmin', use: '是否管理员（02-accounts.md §5；决定是否渲染管理入口）' },
    // GET /api/v1/me
    { endpoint: 'me', path: 'data.publicId', use: '账号' },
    { endpoint: 'me', path: 'data.nickname', use: '昵称' },
    { endpoint: 'me', path: 'data.progress.tier', use: '段位（hub 摘要 + profile 行）' },
    { endpoint: 'me', path: 'data.progress.peakTier', use: '峰值段位' },
    { endpoint: 'me', path: 'data.rating.points', use: '积分（hub 摘要 + profile 行）' },
    { endpoint: 'me', path: 'data.rating.games', use: '总场次' },
    { endpoint: 'me', path: 'data.rating.wins', use: '胜' },
    { endpoint: 'me', path: 'data.rating.losses', use: '负' },
    { endpoint: 'me', path: 'data.rating.draws', use: '平' },
    { endpoint: 'me', path: 'data.activeSlotId', use: '出战槽 id' },
    { endpoint: 'me', path: 'data.activeSlotName', use: '出战槽名' },
    { endpoint: 'me', path: 'data.slots', use: '配置槽清单（数组）' },
    { endpoint: 'me', path: 'data.pool.inPool', use: '是否在匹配池（hub 摘要 + profile 行）' },
    { endpoint: 'me', path: 'data.pool.drawnCount', use: '被抽次数' },
    { endpoint: 'me', path: 'data.record.stats.attack.wins', use: '进攻·胜' },
    { endpoint: 'me', path: 'data.record.stats.attack.losses', use: '进攻·负' },
    { endpoint: 'me', path: 'data.record.stats.attack.draws', use: '进攻·平' },
    { endpoint: 'me', path: 'data.record.stats.defense.wins', use: '防守·胜' },
    { endpoint: 'me', path: 'data.record.stats.defense.losses', use: '防守·负' },
    { endpoint: 'me', path: 'data.record.stats.defense.draws', use: '防守·平' },
    { endpoint: 'me', path: 'data.record.unread.attack', use: '未读进攻战绩数（hub 摘要 + profile 行）' },
    { endpoint: 'me', path: 'data.record.unread.defense', use: '未读防守战绩数（hub 摘要 + profile 行）' },
    { endpoint: 'me', path: 'data.flags.unverifiedLoadout', use: '仓库校验状态' },
    { endpoint: 'me', path: 'data.flags.isBot', use: '是否机器人' },
    { endpoint: 'me', path: 'data.flags.isAdmin', use: '是否管理员（02-accounts.md §5；刷新后仍能判定）' },
    // POST /api/v1/auth/password
    { endpoint: 'password', path: 'data.changed', use: '改密是否生效' },
    { endpoint: 'password', path: 'data.revokedOthers', use: '已撤销的其他会话数' },
    // POST /api/v1/auth/logout
    { endpoint: 'logout', path: 'data.revoked', use: '登出是否生效' },
    // PUT /api/v1/me/nickname（F3 设置屏·改名；03 §3.5）
    { endpoint: 'me/nickname', path: 'data.nickname', use: '改名成功文案「昵称已更新为 <n>」（服务端夹到 ≤16 后回带）' },
    // GET /api/v1/me/warehouse（F3 仓库真源；D-159；03 §5.2）
    { endpoint: 'me/warehouse', path: 'data.buckets.role', use: '角色桶列表（仓库行 / 容量行 / 物品详情）' },
    { endpoint: 'me/warehouse', path: 'data.buckets.skill', use: '技能桶列表' },
    { endpoint: 'me/warehouse', path: 'data.buckets.rolePlugin', use: '角色插件桶列表' },
    { endpoint: 'me/warehouse', path: 'data.buckets.skillPlugin', use: '技能插件桶列表' },
    { endpoint: 'me/warehouse', path: 'data.usage', use: '物品行 `[装配于配置N]` 标记（usage[uid].slotIds[]）' },
    { endpoint: 'me/warehouse', path: 'data.caps', use: '容量行上限（n/500）与「仓库已满」判定（B-2）' },
    // POST /api/v1/me/box（F3 开箱；D-162：**没有 seed 入参**，响应里的 seed 前端不读不显示）
    { endpoint: 'me/box', path: 'data.items', use: '开箱结果逐件行（名字/分类/品质）' },
    { endpoint: 'me/box', path: 'data.times', use: '结果区「本次获得 <n> 件」' },
    // GET /api/v1/me/ai（F3 只用列表；提交③ 的配置弹窗才消费候选）
    { endpoint: 'me/ai', path: 'data.items', use: 'AI 库列表（本批仅登记契约，投影在提交③）' },
    // POST /api/v1/admin/accounts（02-accounts.md §2.3/§5）
    { endpoint: 'admin/accounts', path: 'data.total', use: '账号总数（**无上限**）·分页信息行' },
    { endpoint: 'admin/accounts', path: 'data.offset', use: '当前页起点·分页信息行' },
    { endpoint: 'admin/accounts', path: 'data.limit', use: '每页条数·分页信息行' },
    { endpoint: 'admin/accounts', path: 'data.hasMore', use: '「下一页」是否可用（A-3/A-7）' },
    { endpoint: 'admin/accounts', path: 'data.rows', use: '账号行数组（逐项取 ADMIN_ROW_FIELDS）' },
    // POST /api/v1/admin/delete-account
    { endpoint: 'admin/delete-account', path: 'data.removed', use: '删除是否生效' },
    { endpoint: 'admin/delete-account', path: 'data.publicId', use: '成功文案「已删除 <publicId>」' },
    // POST /api/v1/admin/stats
    { endpoint: 'admin/stats', path: 'data.players', use: '统计摘要行 players=<n>' },
    { endpoint: 'admin/stats', path: 'data.seq', use: '统计摘要行 seq=<n>' },
    { endpoint: 'admin/stats', path: 'data.snapshots', use: '统计摘要行 snapshots=<…>' },
    // POST /api/v1/admin/rebuild-index
    { endpoint: 'admin/rebuild-index', path: 'data.players', use: '重建结果文案「重建完成：<players> 玩家」' },
    // POST /api/v1/admin/bots
    { endpoint: 'admin/bots', path: 'data.injected', use: '注入结果文案「已注入 <n> 个」' },
    { endpoint: 'admin/bots', path: 'data.skipped', use: '注入结果文案（跳过 <n> 个）' },
    // POST /api/v1/admin/clear-bots
    { endpoint: 'admin/clear-bots', path: 'data.removed', use: '清除结果文案「已清除 <n> 个」' },
    // POST /api/v1/admin/ban（unban 同形）
    { endpoint: 'admin/ban', path: 'data.banned', use: '封禁/解封结果文案' },
    // 任意端点：统一信封（server/index.js okEnvelope/errEnvelope）
    { endpoint: 'any', path: 'ok', use: '成功/失败判定（唯一分支依据）' },
    { endpoint: 'any', path: 'error.code', use: '错误分类与文案选择' },
    { endpoint: 'any', path: 'error.message', use: '默认展示文案（服务端中文文案）' },
    { endpoint: 'any', path: 'error.details', use: '字段级错误（取首条 path）' },
  ];

  // 账号行的逐项字段（02-accounts.md §5 的 `data.rows` 行「逐项取 …」；值**不含** `data.rows.` 前缀，
  //   故不参与 FC-2/FC-3 的路径核对，而由 tests/frontend/admin-ui-contract.test.js 单独三方核对：
  //   本表 == public/format.js 的 ADMIN_ROW_FIELDS == 02-accounts.md §5 该单元格里的反引号字段串）
  var ADMIN_ROW_FIELDS = ['playerId', 'publicId', 'nickname', 'tier', 'points', 'inPool', 'isBot', 'banned', 'lastSeenAt'];

  // 物品详情读的子对象路径（03 §5.3 的字段清单；**不含** `data.` 前缀 —— 它们从
  //   `data.buckets.*[i]` / `data.items[i]` 的单件物品上读取，故不参与 FC-2/FC-3 的信封级核对，
  //   而由 tests/frontend/hub-warehouse-flow.test.js 的 WH-C2 三方核对：
  //   本表 == 03 §5.1（box 行）+ §5.3 反引号字段集合（花括号展开后）== format.js 实际读取的路径）
  var ITEM_DETAIL_FIELDS = [
    // §5.3 共通
    'name', 'kind', 'quality', 'uid',
    // 角色（§5.3 角色行）/ 技能（§5.3 技能行）
    'templateId', 'slotCount', 'slots', 'stats', 'regen.mp', 'regen.sp', 'pluginPoints',
    'stats.hp', 'stats.atk', 'stats.def', 'stats.sp', 'stats.mp',
    'params', 'params.multiplier', 'params.cost.hp', 'params.cost.mp', 'params.cost.sp',
    'params.cooldown', 'params.bulletLevel',
    // 角色插件 / 技能插件（§5.3 两行）
    'id', 'desc', 'slot', 'category', 'tier', 'pointCost', 'costDeltaByTier', 'affixes',
    // 插槽与词条：在 `slots[i]` / `affixes[i]` 子对象上读取（`slots[].{type,pluginUid}`、
    //   `affixes[].{id,desc,params.v}`）—— 故路径就是它在子对象内的相对位置
    'type', 'pluginUid', 'params.v',
  ];

  // 分册 §5 登记了、但**本批前端明确不读取**的路径（FC-3 的双向核对靠它闭合：
  //   documented == AUTH_FIELD_CONTRACT ∪ DOC_NOT_READ，且两者无交集）
  var DOC_NOT_READ = [
    { path: 'data.seed', reason: '03 §5.2 me/box：D-162 规定 seed 由服务端生成、不是入参；前端**不传也不显示**（防"找到好 seed 无限复制"）' },
    { path: 'data.maxSlots', reason: '03 §5.1 me/configs：出战配置编辑器（提交③）才需要；本批只渲染占位弹窗，不请求 /me/configs' },
    { path: 'data.caps.max', reason: '03 §5.2 me/ai：AI 库上限（F5/提交③ 的 AI 选择弹窗才用）；本批只做只读候选登记' },
    { path: 'data.warehouse', reason: '03 §5.2 me/warehouse/assemble：装配/拆卸入口在提交③；本批不调用该端点' },
  ];

  // 明确「不读取」的字段（防止散文式字段混入）：与上表必须无交集
  var UNUSED_FIELDS = ['data.player.playerId', 'data.record.appliedSeq', 'data.pool.lastDrawnAt',
    'data.flags.banReason', 'data.progress.lastBatchId',
    // 02-accounts.md §5 的行字段清单里没有 peakPoints → 不读（响应里有，但本批不用）
    'data.rows.peakPoints',
    // 03 §5.2 me/warehouse 响应里有 counts（服务端权威计数），但客户端的桶长度即可推出同一数字
    //   → 不读，避免同一事实两个来源（容量行一律 `桶长度/caps`）
    'data.counts'];

  return {
    AUTH_FIELD_CONTRACT: AUTH_FIELD_CONTRACT,
    ADMIN_ROW_FIELDS: ADMIN_ROW_FIELDS,
    ITEM_DETAIL_FIELDS: ITEM_DETAIL_FIELDS,
    DOC_NOT_READ: DOC_NOT_READ,
    UNUSED_FIELDS: UNUSED_FIELDS,
  };
});
