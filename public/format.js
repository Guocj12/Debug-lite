'use strict';
/* public/format.js —— **投影单一真源**（总纲 §1.5；设计依据 docs/frontend/01-auth.md §3/§5/§6
 *   + F2 增量 docs/frontend/02-accounts.md §3/§5/§6
 *   + F3 增量 docs/frontend/03-hub-warehouse-loadout.md §3/§5/§6）
 *
 * 职责：把「状态 / 响应信封」投影成**最终文字与视图模型**。全前端只有本文件读响应字段，
 * 且一律经字段读取原语（路径为字符串字面量）—— 路径清单与 public/contract.js 逐条相等（测试强制）。
 * 本文件不碰 DOM、不发请求、不复制任何战斗公式。
 *
 * F3 新增投影：
 *   · hub 摘要行（只读 GET /me；03 §3.1）；
 *   · 仓库四桶容量行 / 物品行（名字 + `[装配于配置N]`）/ 物品详情各行（03 §5.3 字段）；
 *   · 开箱结果逐件行（**不读也不显示 `data.seed`**，D-162）；
 *   · 屏内弹窗视图模型（FR-10：弹窗 = 屏内区块，标题 + 文字行 + 按钮）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.format = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAGE_TITLE = 'Debug-Lite v3 · 账号';

  // F3：开箱次数上限（与 server/box.js 的 BOX_TIMES_MAX、store.BOX_TIMES_MAX 同口径；03 §3.4）
  var BOX_TIMES_MAX = 100;
  // F3：仓库四桶的**显示名**（03 §3.3；容量行与开箱结果都用它）
  var BUCKET_LABELS = Object.freeze({ role: '角色', skill: '技能', rolePlugin: '角色插件', skillPlugin: '技能插件' });
  var BUCKET_ORDER = Object.freeze(['role', 'skill', 'rolePlugin', 'skillPlugin']);
  // 每桶上限缺省值（正常一律以响应的 data.caps 为准；缺失时才回落，避免整屏崩）
  var CAP_FALLBACK = 500;
  // F3：四个空页的标题与计划批次（03 §3.6；FR-12）
  var EMPTY_PAGES = Object.freeze({
    quick: { title: '快速对战', batch: 'F6' },
    tournament: { title: '锦标赛', sub: '= 排位赛', batch: 'F7' },
    leaderboard: { title: '排行榜', batch: 'F7' },
    'ai-editor': { title: 'AI 编辑', batch: 'F5' },
  });
  // 提交③（出战配置编辑器）未实现 —— 本批只做占位弹窗（03 §3.7；14 §实施计划）
  var CONFIG_PLACEHOLDER_TEXT = '尚未实现（计划批次 F3-③）';
  var CONFIG_HINT = '出战配置编辑器属提交③：本批只显示占位（点弹窗外或「关闭」返回）';
  var ITEM_GONE_TEXT = '（仓库中已找不到该物品，可能已被清理：点「刷新」重新读取）';
  var NO_DATA_TEXT = '（尚未读取到档案数据）';
  var CLOSE_LABEL = '关闭';

  // 唯一的字段读取原语（路径为字面量，便于机器核对）
  function pick(obj, path) {
    var cur = obj;
    var segs = String(path).split('.');
    for (var i = 0; i < segs.length; i++) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = cur[segs[i]];
    }
    return cur;
  }

  function isOk(env) { return pick(env, 'ok') === true; }
  function errorCodeOf(env) {
    var code = pick(env, 'error.code');
    return typeof code === 'string' && code !== '' ? code : 'unknown_error';
  }
  function isSessionError(env) {
    var code = errorCodeOf(env);
    return code === 'unauthorized' || code === 'session_expired' || code === 'banned';
  }

  function str(v) { return typeof v === 'string' && v !== '' ? v : null; }
  function or(v, fallback) { var s = str(v); return s === null ? fallback : s; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? String(v) : '—'; }
  function numOr(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function yesNo(v, yes, no) { return v === true ? yes : no; }
  function arrayOf(v) { return Array.isArray(v) ? v : []; }

  function stamp(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '未知';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 详情里的字段级错误（取首条 path）；F1 与 F2 共用同一口径
  function fieldTail(env) {
    var details = pick(env, 'error.details');
    var first = Array.isArray(details) && details.length > 0 ? details[0] : null;
    var fieldPath = first && typeof first.path === 'string' && first.path !== '' ? first.path : null;
    return fieldPath === null ? '' : '（字段：' + fieldPath + '）';
  }

  /* ---------- 会话 ---------- */

  // 登录/注册响应 与 /me 响应都含 data.publicId / data.nickname（/me 无 token → 传 null 保留原 token）
  function sessionOf(env) {
    return {
      token: str(pick(env, 'data.token')),
      publicId: str(pick(env, 'data.publicId')),
      nickname: str(pick(env, 'data.nickname')),
      expiresAt: typeof pick(env, 'data.expiresAt') === 'number' ? pick(env, 'data.expiresAt') : null,
      isAdmin: isAdminOf(env),
    };
  }

  // 02-accounts.md §5：管理员身份的两个回带位置（register|login 的 player.isAdmin / me 的 flags.isAdmin）
  function isAdminOf(env) {
    return pick(env, 'data.player.isAdmin') === true || pick(env, 'data.flags.isAdmin') === true;
  }

  /* ---------- 成功文案（01-auth.md §4） ---------- */

  function loginOkText(env) {
    return '登录成功：' + or(pick(env, 'data.nickname'), '（无昵称）') + '（' + or(pick(env, 'data.publicId'), '未知账号') + '）';
  }
  function registerOkText(env) {
    return '注册成功：' + or(pick(env, 'data.nickname'), '（无昵称）') + '（' + or(pick(env, 'data.publicId'), '未知账号') + '）';
  }
  function passwordOkText(env) {
    var n = num(pick(env, 'data.revokedOthers'));
    var changed = pick(env, 'data.changed') === true;
    return '改密成功：已撤销其他设备会话 ' + n + ' 个' + (changed ? '' : '（服务端未确认 changed）');
  }
  function logoutOkText(env) {
    return pick(env, 'data.revoked') === true ? '已登出' : '已登出（服务端未确认）';
  }
  function logoutUnconfirmedText(reason) {
    return '已登出（服务端未确认：' + or(reason, '未知原因') + '）';
  }
  var REFRESH_OK_TEXT = '档案已刷新';
  // F3：仓库刷新与开箱成功的可见文案（03 §4 表格「成功可见文本」）
  var WAREHOUSE_OK_TEXT = '仓库已刷新';
  var BOX_OK_TEXT = '开箱完成：物品已入仓库';

  // F3：设置屏·改名成功文案（03 §3.5「昵称已更新为 <n>」；昵称取响应回带值）
  function nicknameOkText(env) {
    return '昵称已更新为 ' + or(pick(env, 'data.nickname'), '（未知）');
  }
  var NICKNAME_MAX_TEXT = '昵称需 1~16 字符';

  /* ---------- 失败文案（01-auth.md §6） ---------- */

  var HINTS = Object.freeze({
    username_taken: '换个用户名试试',
    weak_password: '密码需 8~72 字符',
    bad_request: '检查用户名与昵称格式',
    invalid_credentials: '注意：密码区分大小写，且不要有多余空格或全角字符',
    too_many_attempts: '稍后再试',
    rate_limited: '请求过于频繁',
    unauthorized: '会话已失效，请重新登录',
    session_expired: '会话已失效，请重新登录',
    banned: '账号已被封禁',
    payload_too_large: '输入过长',
    // F3（03 §6）：仓库已满（正常情况下由开箱按钮禁用拦截；未读过仓库时靠服务端这条兜底）
    warehouse_full: '仓库已满，请先清理对应分类',
    store_unavailable: '服务暂不可用（存储未启用）',
    internal_error: '服务端内部错误',
  });

  function hintFor(code) { return HINTS[code] === undefined ? '' : HINTS[code]; }

  // 失败文案 = 附加指引（若有）+ 服务端 message + 首条 details 的字段名（若有）
  function noticeText(env) {
    var message = or(pick(env, 'error.message'), '请求失败');
    var hint = hintFor(errorCodeOf(env));
    var text = hint === '' ? message : hint + '：' + message;
    return text + fieldTail(env);
  }

  function networkText(reason) { return '无法连接服务器：' + or(reason, '未知错误'); }

  /* ---------- 管理面文案（02-accounts.md §4/§6） ---------- */

  // §6 全部失败路径的界面文案（与 F1 的 HINTS **分开**：F1 的 bad_request 指引是"用户名与昵称"，
  //   用在分页参数/bots count 上会误导，故管理面自成一表；未登记 code 一律只展示服务端文案）
  var ADMIN_HINTS = Object.freeze({
    forbidden: '需要管理员权限（登录管理员账号，或填写管理员令牌）',
    admin_token_missing: '服务端未配置管理员令牌（DL_ADMIN_TOKEN），且当前账号不是管理员',
    debug_bots_disabled: '调试 bot 注入已关闭（需服务端设 DL_DEBUG_BOTS=1）',
    cannot_delete_self: '不能删除当前登录的管理员账号',
    store_not_found: '该账号不存在或已被删除',
    rate_limited: '请求过于频繁',
    unauthorized: '会话已失效，请重新登录',
    session_expired: '会话已失效，请重新登录',
    banned: '账号已被封禁',
    store_unavailable: '服务暂不可用（存储未启用）',
    internal_error: '服务端内部错误',
  });

  // 非管理员被拦下时的固定文案（§6 forbidden 行；本地兜底与 403 响应同文案）
  var ADMIN_FORBIDDEN_TEXT = ADMIN_HINTS.forbidden;

  function adminNoticeText(env) {
    var message = or(pick(env, 'error.message'), '请求失败');
    var hint = ADMIN_HINTS[errorCodeOf(env)] === undefined ? '' : ADMIN_HINTS[errorCodeOf(env)];
    // 服务端文案已含该指引时不再重复前置（如 cannot_delete_self 的 message 与指引同文）
    var text = (hint === '' || message.indexOf(hint) !== -1) ? message : hint + '：' + message;
    return text + fieldTail(env);
  }

  // data.stats 摘要行（§11 走查步 4 期望 `players=<n> seq=<n> snapshots=<n>`）
  function statsText(env) {
    var snapshots = pick(env, 'data.snapshots');
    var snapText = snapshots === null || snapshots === undefined ? '不可用' : '已装配';
    return 'players=' + num(pick(env, 'data.players'))
      + ' seq=' + num(pick(env, 'data.seq'))
      + ' snapshots=' + snapText;
  }
  function rebuildText(env) { return '重建完成：' + num(pick(env, 'data.players')) + ' 玩家'; }
  function botsText(env) {
    return '已注入 ' + num(pick(env, 'data.injected')) + ' 个（跳过 ' + num(pick(env, 'data.skipped')) + ' 个）';
  }
  function clearBotsText(env) { return '已清除 ' + num(pick(env, 'data.removed')) + ' 个'; }
  function deleteAccountText(env, fallbackPublicId) {
    var removed = pick(env, 'data.removed') === true;
    return (removed ? '已删除 ' : '服务端未确认删除：') + or(pick(env, 'data.publicId'), or(fallbackPublicId, '该账号'));
  }
  function banText(env, publicId) {
    var banned = pick(env, 'data.banned') === true;
    return (banned ? '已封禁 ' : '已解封 ') + or(publicId, '该账号');
  }

  /* ---------- 账号列表（02-accounts.md §3.2/§5） ---------- */

  // 行字段清单（§5 的 `data.rows` 行「逐项取 …」；与 public/contract.js 的 ADMIN_ROW_FIELDS
  //   逐条相等，由 tests/frontend/admin-ui-contract.test.js 机器核对）
  var ADMIN_ROW_FIELDS = Object.freeze(['playerId', 'publicId', 'nickname', 'tier', 'points', 'inPool', 'isBot', 'banned', 'lastSeenAt']);

  function rowValueOf(row) {
    var out = {};
    for (var i = 0; i < ADMIN_ROW_FIELDS.length; i++) out[ADMIN_ROW_FIELDS[i]] = pick(row, ADMIN_ROW_FIELDS[i]);
    return out;
  }

  function accountRows(env) {
    var rows = pick(env, 'data.rows');
    if (!Array.isArray(rows)) return [];
    var offset = numOr(pick(env, 'data.offset'), 0);
    return rows.map(function (row, i) {
      var r = rowValueOf(row);
      var marks = (r.inPool === true ? '[在池]' : '[不在池]')
        + (r.isBot === true ? ' [bot]' : '')
        + (r.banned === true ? ' [已封禁]' : '');
      return {
        playerId: str(r.playerId),
        publicId: str(r.publicId),
        text: (offset + i + 1) + '. ' + or(r.publicId, '未知账号') + '  ' + or(r.nickname, '（无昵称）')
          + '  段位' + or(r.tier, '未知') + '  积分' + num(r.points) + '  ' + marks
          + '  playerId=' + or(r.playerId, '未知') + '  最后活跃' + stamp(r.lastSeenAt),
      };
    });
  }

  // 分页信息行（§3.2：`共 <total> 个账号，第 <page>/<pages> 页（每页 <limit>）`）
  function accountsInfoText(env) {
    var total = numOr(pick(env, 'data.total'), 0);
    var offset = numOr(pick(env, 'data.offset'), 0);
    var limit = Math.max(1, numOr(pick(env, 'data.limit'), 20));
    var pages = Math.max(1, Math.ceil(total / limit));
    var page = Math.min(pages, Math.floor(Math.max(0, offset) / limit) + 1);
    return '共 ' + total + ' 个账号，第 ' + page + '/' + pages + ' 页（每页 ' + limit + '）';
  }
  function accountsHasMore(env) { return pick(env, 'data.hasMore') === true; }

  /* ---------- 档案文本行（01-auth.md §3.3/§5） ---------- */

  // 首屏（登录/注册刚成功，尚未取 /me）：来自 register|login 响应
  function authLines(env) {
    return [
      '账号：' + or(pick(env, 'data.publicId'), '未知'),
      '昵称：' + or(pick(env, 'data.nickname'), '（未设置）'),
      '段位：' + or(pick(env, 'data.player.tier'), '未知'),
      '积分：' + num(pick(env, 'data.player.points')),
      '出战槽：' + or(pick(env, 'data.player.activeSlotName'), '未知'),
      '会话到期：' + stamp(pick(env, 'data.expiresAt')),
      '档案明细尚未读取：点「刷新档案」获取',
    ];
  }

  // 完整档案（GET /me）
  function profileLines(env) {
    var slots = pick(env, 'data.slots');
    var slotText = Array.isArray(slots) && slots.length > 0
      ? slots.map(function (s) {
        var name = s && s.name ? s.name : '（未命名）';
        return name + (s && s.isDefault === true ? '（默认）' : '');
      }).join('、')
      : '无';
    return [
      '账号：' + or(pick(env, 'data.publicId'), '未知'),
      '昵称：' + or(pick(env, 'data.nickname'), '（未设置）'),
      '段位：' + or(pick(env, 'data.progress.tier'), '未知') + '（峰值 ' + or(pick(env, 'data.progress.peakTier'), '未知') + '）',
      '积分：' + num(pick(env, 'data.rating.points')),
      '总场次：' + num(pick(env, 'data.rating.games')) + '（胜 ' + num(pick(env, 'data.rating.wins'))
        + ' / 负 ' + num(pick(env, 'data.rating.losses')) + ' / 平 ' + num(pick(env, 'data.rating.draws')) + '）',
      '出战槽：' + or(pick(env, 'data.activeSlotId'), '未知') + '（' + or(pick(env, 'data.activeSlotName'), '未命名') + '）',
      '配置槽：' + slotText,
      '战绩·进攻：胜 ' + num(pick(env, 'data.record.stats.attack.wins')) + ' / 负 ' + num(pick(env, 'data.record.stats.attack.losses'))
        + ' / 平 ' + num(pick(env, 'data.record.stats.attack.draws')),
      '战绩·防守：胜 ' + num(pick(env, 'data.record.stats.defense.wins')) + ' / 负 ' + num(pick(env, 'data.record.stats.defense.losses'))
        + ' / 平 ' + num(pick(env, 'data.record.stats.defense.draws')),
      '未读：进攻 ' + num(pick(env, 'data.record.unread.attack')) + ' / 防守 ' + num(pick(env, 'data.record.unread.defense')),
      '匹配池：' + yesNo(pick(env, 'data.pool.inPool'), '在池', '不在池') + '（被抽 ' + num(pick(env, 'data.pool.drawnCount')) + ' 次）',
      '仓库校验：' + yesNo(pick(env, 'data.flags.unverifiedLoadout'), '未校验（提交仓库镜像后转已校验）', '已校验'),
      '机器人账号：' + yesNo(pick(env, 'data.flags.isBot'), '是', '否'),
    ];
  }

  // F3 §3.2：用户详情屏 = F1 的 home 降级（文案与字段**逐字不变**；登出按钮已移入设置屏）
  function detailLines(state) {
    if (state && state.profile) return profileLines(state.profile);
    if (state && state.auth) return authLines(state.auth);
    return [NO_DATA_TEXT];
  }

  /* ---------- F3 §3.1：hub 摘要行（**只读 GET /me**） ---------- */

  // `昵称 · 段位 · 积分 · 未读 进攻<a>/防守<d> · 在池/不在池`
  function hubSummary(state) {
    var env = state && state.profile ? state.profile : null;
    if (env === null) return NO_DATA_TEXT;
    return or(pick(env, 'data.nickname'), '（无昵称）')
      + ' · ' + or(pick(env, 'data.progress.tier'), '未知')
      + ' · ' + num(pick(env, 'data.rating.points'))
      + ' · 未读 进攻' + num(pick(env, 'data.record.unread.attack')) + '/防守' + num(pick(env, 'data.record.unread.defense'))
      + ' · ' + yesNo(pick(env, 'data.pool.inPool'), '在池', '不在池');
  }

  /* ---------- F3 §3.3：仓库（GET /me/warehouse 为真源） ---------- */

  function bucketLabel(bucket) { return BUCKET_LABELS[bucket] === undefined ? '角色' : BUCKET_LABELS[bucket]; }

  // 响应里某一桶的物品数组（**按桶名分派到不同的 pick 字面量** —— 契约要求路径为字面量）
  function bucketItems(env, bucket) {
    if (bucket === 'skill') return arrayOf(pick(env, 'data.buckets.skill'));
    if (bucket === 'rolePlugin') return arrayOf(pick(env, 'data.buckets.rolePlugin'));
    if (bucket === 'skillPlugin') return arrayOf(pick(env, 'data.buckets.skillPlugin'));
    return arrayOf(pick(env, 'data.buckets.role'));
  }

  function capOf(env, bucket) {
    var caps = pick(env, 'data.caps');
    var cap = caps && typeof caps === 'object' ? caps[bucket] : undefined;
    return typeof cap === 'number' && isFinite(cap) && cap > 0 ? cap : CAP_FALLBACK;
  }

  // 容量行：`角色 <n>/500 · 技能 <n>/500 · 角色插件 <n>/500 · 技能插件 <n>/500`（03 §3.3）
  function warehouseCapacityText(env) {
    return BUCKET_ORDER.map(function (bucket) {
      return bucketLabel(bucket) + ' ' + bucketItems(env, bucket).length + '/' + capOf(env, bucket);
    }).join(' · ');
  }

  // `usage[uid].slotIds[]` → `[装配于配置1、配置2]`（03 §5.2；O-14 已按实测回填）
  function usageText(env, uid) {
    var usage = pick(env, 'data.usage');
    var entry = usage && typeof usage === 'object' && uid !== null ? usage[uid] : null;
    var slotIds = entry && Array.isArray(entry.slotIds) ? entry.slotIds : [];
    if (slotIds.length === 0) return '';
    var names = slotIds.map(function (id) {
      var s = str(id);
      return s === null ? '未知配置' : '配置' + s.replace(/^slot/, '');
    });
    return '[装配于' + names.join('、') + ']';
  }

  // 仓库每一行：**只显示物品名字**（+ `[装配于配置N]` 标记；03 §3.3）
  function itemLabel(env, item) {
    var name = or(pick(item, 'name'), '（未命名物品）');
    var mark = usageText(env, str(pick(item, 'uid')));
    return mark === '' ? name : name + ' ' + mark;
  }

  function itemRows(env, bucket, busy) {
    return bucketItems(env, bucket).map(function (item) {
      return {
        text: '',
        buttons: [{ action: 'item-open', label: itemLabel(env, item), kind: 'button', disabled: busy === true, uid: str(pick(item, 'uid')) }],
      };
    });
  }

  function findItem(env, uid) {
    for (var i = 0; i < BUCKET_ORDER.length; i++) {
      var list = bucketItems(env, BUCKET_ORDER[i]);
      for (var j = 0; j < list.length; j++) if (str(pick(list[j], 'uid')) === uid) return list[j];
    }
    return null;
  }

  // 插槽行：`插槽1（mp）：空` / `插槽1（mp）：已装配 item_4`
  function slotLines(item) {
    var slots = arrayOf(pick(item, 'slots'));
    return slots.map(function (slot, i) {
      var pluginUid = str(pick(slot, 'pluginUid'));
      return '插槽' + (i + 1) + '（' + or(pick(slot, 'type'), '未知类型') + '）：'
        + (pluginUid === null ? '空' : '已装配 ' + pluginUid);
    });
  }

  function affixLines(item) {
    var affixes = arrayOf(pick(item, 'affixes'));
    return affixes.map(function (affix) {
      var v = pick(affix, 'params.v');
      return '词条：' + or(pick(affix, 'id'), '未知') + '（' + or(pick(affix, 'desc'), '无说明') + '，v=' + num(v) + '）';
    });
  }

  // costDeltaByTier：`sp=2/4/6`（角色插件无此字段 → 返回空数组）
  function costDeltaLines(item) {
    var table = pick(item, 'costDeltaByTier');
    if (!table || typeof table !== 'object') return [];
    var parts = Object.keys(table).map(function (key) {
      var v = table[key];
      return key + '=' + (Array.isArray(v) ? v.join('/') : num(v));
    });
    return parts.length === 0 ? [] : ['各段位消耗：' + parts.join(' · ')];
  }

  // 物品详情（03 §5.3 的字段清单，逐条来自实测响应）
  function itemDetailLines(env, item) {
    var kind = str(pick(item, 'kind'));
    var lines = [
      '名字：' + or(pick(item, 'name'), '（未命名物品）'),
      '类别：' + (kind === null ? '未知' : bucketLabel(kind)),
      '品质：' + or(pick(item, 'quality'), '未知'),
      'uid：' + or(pick(item, 'uid'), '未知'),
    ];
    if (kind === 'role') {
      lines.push('模板：' + or(pick(item, 'templateId'), '未知'));
      lines.push('数值：hp ' + num(pick(item, 'stats.hp')) + ' · atk ' + num(pick(item, 'stats.atk'))
        + ' · def ' + num(pick(item, 'stats.def')) + ' · sp ' + num(pick(item, 'stats.sp')) + ' · mp ' + num(pick(item, 'stats.mp')));
      lines.push('回复：mp ' + num(pick(item, 'regen.mp')) + ' · sp ' + num(pick(item, 'regen.sp')));
      lines.push('插件点数：' + num(pick(item, 'pluginPoints')));
      lines.push('插槽数：' + num(pick(item, 'slotCount')));
    } else if (kind === 'skill') {
      lines.push('模板：' + or(pick(item, 'templateId'), '未知'));
      lines.push('倍率：' + num(pick(item, 'params.multiplier')) + ' · 冷却：' + num(pick(item, 'params.cooldown'))
        + ' · 弹幕等级：' + num(pick(item, 'params.bulletLevel')));
      lines.push('消耗：hp ' + num(pick(item, 'params.cost.hp')) + ' · mp ' + num(pick(item, 'params.cost.mp'))
        + ' · sp ' + num(pick(item, 'params.cost.sp')));
      lines.push('插槽数：' + num(pick(item, 'slotCount')));
    } else {
      lines.push('插件 id：' + or(pick(item, 'id'), '未知'));
      lines.push('说明：' + or(pick(item, 'desc'), '无'));
      lines.push('目标槽类型：' + or(pick(item, 'slot'), '未知'));
      lines.push('分类：' + or(pick(item, 'category'), '未知') + ' · 等级：' + num(pick(item, 'tier')));
      if (kind === 'rolePlugin') lines.push('点数：' + num(pick(item, 'pointCost')));
      var costDeltas = costDeltaLines(item);
      for (var i = 0; i < costDeltas.length; i++) lines.push(costDeltas[i]);
    }
    var slots = slotLines(item);
    for (var j = 0; j < slots.length; j++) lines.push(slots[j]);
    var affixes = affixLines(item);
    for (var k = 0; k < affixes.length; k++) lines.push(affixes[k]);
    var mark = usageText(env, str(pick(item, 'uid')));
    if (mark !== '') lines.push('出战引用：' + mark);
    return lines;
  }

  // 仓库空态（03 §3.3 / B-1）
  var EMPTY_WAREHOUSE_TEXT = '仓库为空：点「开箱」获取物品';

  /* ---------- F3 §3.4：开箱（POST /me/box；**不显示也不传 seed**） ---------- */

  // 逐件行：`<名字>（<分类>·<品质>）`
  function boxResultLines(env) {
    var items = arrayOf(pick(env, 'data.items'));
    var lines = ['本次获得 ' + num(pick(env, 'data.times')) + ' 件：'];
    for (var i = 0; i < items.length; i++) {
      var kind = str(pick(items[i], 'kind'));
      lines.push(or(pick(items[i], 'name'), '（未命名物品）')
        + '（' + (kind === null ? '未知' : bucketLabel(kind)) + '·' + or(pick(items[i], 'quality'), '未知') + '）');
    }
    return lines;
  }

  // B-2：某分类已达上限 → 返回该桶 key（否则 null）。数据源 = 仓库响应（桶长度 vs caps）
  function fullBucket(state) {
    var env = state && state.warehouse ? state.warehouse.envelope : null;
    if (env === null) return null;
    for (var i = 0; i < BUCKET_ORDER.length; i++) {
      var bucket = BUCKET_ORDER[i];
      if (bucketItems(env, bucket).length >= capOf(env, bucket)) return bucket;
    }
    return null;
  }

  // `仓库已满（<分类> 500/500），请先清理`（03 §3.4 / §6 warehouse_full）
  function boxFullNotice(state) {
    var env = state && state.warehouse ? state.warehouse.envelope : null;
    var bucket = fullBucket(state);
    if (bucket === null) return null;
    return '仓库已满（' + bucketLabel(bucket) + ' ' + capOf(env, bucket) + '/' + capOf(env, bucket) + '），请先清理';
  }

  var BOX_TIMES_RANGE_TEXT = '开箱次数需为 ' + 1 + '~' + BOX_TIMES_MAX + ' 的整数';
  var BOX_STALE_HINT = '物品已直接入服务端仓库：点「仓库」→「刷新」可看到新物品';

  /* ---------- F3 §3.6：四个空页 ---------- */

  function emptyPageText(view) {
    var page = EMPTY_PAGES[view];
    return '尚未实现（计划批次 ' + (page === undefined ? '待定' : page.batch) + '）';
  }

  function emptyPageTitle(view) {
    var page = EMPTY_PAGES[view];
    return page === undefined ? '尚未实现' : page.title;
  }

  /* ---------- 视图模型（render 的唯一输入；render 内不得再查状态） ---------- */

  function vm(title, extra) {
    return Object.assign({
      pageTitle: PAGE_TITLE,
      title: title,
      notice: null,
      hint: '',
      result: null,
      lines: [],
      rows: [],
      confirm: null,
      fields: [],
      buttons: [],
      enterAction: null,
      modal: null,
    }, extra || {});
  }

  function noticeOf(state) {
    return state.notice && state.notice.text ? { kind: state.notice.kind || 'info', text: state.notice.text } : null;
  }

  function closeButton(busy) {
    return { action: 'modal-close', label: CLOSE_LABEL, kind: 'button', disabled: busy };
  }

  /* ---------- F3 §3.7/§3.8：屏内弹窗（至多一个；点背景 = 关闭并丢弃未提交输入） ---------- */

  function modalViewModel(state, busy) {
    var modal = state.modal;
    if (!modal || typeof modal.kind !== 'string') return null;
    if (modal.kind === 'item-detail') {
      var env = state.warehouse ? state.warehouse.envelope : null;
      var uid = str(modal.uid);
      var item = env === null || uid === null ? null : findItem(env, uid);
      return {
        // 背景元素（data-action="modal-close"）由 render 统一产出，点击即关闭
        title: '物品详情',
        lines: item === null ? [ITEM_GONE_TEXT] : itemDetailLines(env, item),
        buttons: [closeButton(busy)],
      };
    }
    // kind === 'config'：提交③ 的编辑器未实现 → 只显示占位（03 §3.7）
    var slotId = str(modal.slotId);
    var slotNo = slotId === null ? '？' : slotId.replace(/^slot/, '');
    return {
      title: '出战配置' + slotNo,
      hint: CONFIG_HINT,
      lines: ['出战配置' + slotNo + '：' + CONFIG_PLACEHOLDER_TEXT],
      buttons: [closeButton(busy)],
    };
  }

  /* ---------- 各屏视图模型 ---------- */

  // F3 §3.1：hub（登录/注册成功后的落点；FR-11）
  function hubViewModel(state, notice, busy) {
    var buttons = [
      { action: 'goto-profile', label: '用户', kind: 'button', disabled: busy },
      { action: 'goto-warehouse', label: '仓库', kind: 'button', disabled: busy },
      { action: 'goto-box', label: '开箱', kind: 'button', disabled: busy },
      { action: 'goto-quick', label: '快速对战', kind: 'button', disabled: busy },
      { action: 'goto-tournament', label: '锦标赛', kind: 'button', disabled: busy },
      { action: 'goto-leaderboard', label: '排行榜', kind: 'button', disabled: busy },
      { action: 'config-open', label: '出战配置1', kind: 'button', disabled: busy, slot: 'slot1' },
      { action: 'config-open', label: '出战配置2', kind: 'button', disabled: busy, slot: 'slot2' },
      { action: 'config-open', label: '出战配置3', kind: 'button', disabled: busy, slot: 'slot3' },
      { action: 'goto-ai-editor', label: 'AI编辑', kind: 'button', disabled: busy },
      { action: 'goto-settings', label: '设置', kind: 'button', disabled: busy },
    ];
    // 02-accounts.md §3.3：仅 state.session.isAdmin === true 才渲染管理入口；普通账号**完全**不出现
    if (state.session && state.session.isAdmin === true) {
      buttons.push({ action: 'goto-admin', label: '管理员面板', kind: 'button', disabled: busy });
    }
    buttons.push({ action: 'refresh-hub', label: '刷新', kind: 'button', disabled: busy });
    return vm('Debug-Lite', {
      notice: notice,
      hint: '摘要只读 GET /me；点「刷新」重新读取',
      lines: [hubSummary(state)],
      buttons: buttons,
      modal: modalViewModel(state, busy),
    });
  }

  // F3 §3.2：profile（用户详情 = F1 的 home 降级；**无登出按钮**）
  function profileViewModel(state, notice, busy) {
    return vm('用户详情', {
      notice: notice,
      lines: detailLines(state),
      buttons: [
        { action: 'refresh-profile', label: '刷新档案', kind: 'button', disabled: busy },
        { action: 'goto-password', label: '设置密码', kind: 'button', disabled: busy },
        { action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy },
      ],
      modal: modalViewModel(state, busy),
    });
  }

  // F3 §3.3：仓库
  function warehouseViewModel(state, notice, busy) {
    var env = state.warehouse ? state.warehouse.envelope : null;
    var bucket = state.warehouseBucket;
    var rows = env === null ? [] : itemRows(env, bucket, busy);
    var lines = [env === null ? '（尚未读取仓库：点「刷新」）' : warehouseCapacityText(env)];
    if (env !== null && rows.length === 0) lines.push(EMPTY_WAREHOUSE_TEXT);
    return vm('仓库', {
      notice: notice,
      hint: '每行只显示物品名字：点名字看详情；数据源 = GET /me/warehouse（服务端权威）',
      lines: lines,
      rows: rows,
      buttons: [
        { action: 'warehouse-bucket', label: '角色', kind: 'button', disabled: busy, bucket: 'role' },
        { action: 'warehouse-bucket', label: '技能', kind: 'button', disabled: busy, bucket: 'skill' },
        { action: 'warehouse-bucket', label: '角色插件', kind: 'button', disabled: busy, bucket: 'rolePlugin' },
        { action: 'warehouse-bucket', label: '技能插件', kind: 'button', disabled: busy, bucket: 'skillPlugin' },
        { action: 'refresh-warehouse', label: '刷新', kind: 'button', disabled: busy },
        { action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy },
      ],
      modal: modalViewModel(state, busy),
    });
  }

  // F3 §3.4：开箱
  function boxViewModel(state, notice, busy) {
    var lines = [];
    var full = boxFullNotice(state);
    if (full !== null) lines.push(full);
    var result = state.box ? state.box.result : null;
    if (result && Array.isArray(result.lines)) {
      for (var i = 0; i < result.lines.length; i++) lines.push(result.lines[i]);
      if (result.lines.length > 1) lines.push(BOX_STALE_HINT);
    }
    return vm('开箱', {
      notice: notice,
      hint: '开箱次数 1~' + BOX_TIMES_MAX + '；物品直接入服务端仓库',
      lines: lines,
      fields: [{ name: 'boxTimes', label: '开箱次数（1~' + BOX_TIMES_MAX + '）', type: 'text', value: state.box ? state.box.times : '1' }],
      buttons: [
        { action: 'box-open', label: '开箱', kind: 'submit', disabled: busy || full !== null },
        { action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy },
      ],
      enterAction: 'box-open',
      modal: modalViewModel(state, busy),
    });
  }

  // F3 §3.5：设置（登出**只在此屏**；FR-11）
  function settingsViewModel(state, notice, busy) {
    return vm('设置', {
      notice: notice,
      hint: '昵称最长 16 字符；登出会清除本机会话',
      lines: [],
      fields: [{ name: 'settingsNickname', label: '新昵称（≤16 字符）', type: 'text', value: state.settings ? state.settings.nickname : '' }],
      buttons: [
        { action: 'settings-nickname-save', label: '保存昵称', kind: 'submit', disabled: busy },
        { action: 'goto-password', label: '修改密码', kind: 'button', disabled: busy },
        { action: 'logout', label: '登出', kind: 'button', disabled: busy },
        { action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy },
      ],
      enterAction: 'settings-nickname-save',
      modal: modalViewModel(state, busy),
    });
  }

  // F3 §3.6：空页（标题 + 一行「尚未实现（计划批次 F#）」+ 返回主界面；**不做任何请求**）
  function emptyPageViewModel(state, notice, busy) {
    var page = EMPTY_PAGES[state.view];
    var title = emptyPageTitle(state.view);
    return vm(page !== undefined && page.sub !== undefined ? title + '（' + page.sub + '）' : title, {
      notice: notice,
      lines: [emptyPageText(state.view)],
      buttons: [{ action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy }],
    });
  }

  // 管理面板（02-accounts.md §3.1）
  function adminViewModel(state, notice, busy) {
    return vm('管理员面板', {
      notice: notice,
      hint: '你是管理员账号：' + or(state.session && state.session.publicId, '未知')
        + '；下方为后端已实现的管理能力（管理员令牌仅存于本页内存：刷新页面后需重填）',
      result: state.admin.result,
      fields: [
        { name: 'adminToken', label: '管理员令牌（可留空：用管理员账号身份免填）', type: 'password', value: state.adminToken },
        { name: 'adminTarget', label: '封禁目标 publicId', type: 'text', value: state.admin.target },
        { name: 'adminCount', label: '注入数量', type: 'text', value: state.admin.count },
      ],
      buttons: [
        { action: 'admin-refresh-accounts', label: '刷新账号列表', kind: 'button', disabled: busy },
        { action: 'admin-stats', label: '服务统计', kind: 'button', disabled: busy },
        { action: 'admin-rebuild-index', label: '重建索引', kind: 'button', disabled: busy },
        { action: 'admin-bots', label: '注入调试 bot', kind: 'button', disabled: busy },
        { action: 'admin-clear-bots', label: '清除调试 bot', kind: 'button', disabled: busy },
        { action: 'admin-ban-row', label: '封禁目标', kind: 'button', disabled: busy },
        { action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy },
      ],
      enterAction: 'admin-refresh-accounts',
    });
  }

  // 账号列表（02-accounts.md §3.2）
  function accountsViewModel(state, notice, busy) {
    var envelope = state.admin.accounts;
    var rows = envelope ? accountRows(envelope) : [];
    var hasMore = envelope ? accountsHasMore(envelope) : false;
    var offset = state.admin.offset;
    var confirm = state.admin.confirm;
    var confirmVm = confirm && confirm.kind === 'delete'
      ? {
        text: '确认删除 ' + or(confirm.publicId, '该账号') + '？此操作不可撤销',
        buttons: [
          { action: 'confirm-yes', label: '确认删除', kind: 'button', disabled: busy },
          { action: 'confirm-no', label: '取消', kind: 'button', disabled: busy },
        ],
      }
      : null;
    return vm('账号列表', {
      notice: notice,
      result: state.admin.result,
      lines: [envelope ? accountsInfoText(envelope) : '（尚未加载账号列表：点「刷新」）'],
      rows: rows.map(function (row) {
        return {
          text: row.text,
          buttons: [
            { action: 'admin-delete-account', label: '删除', kind: 'button', disabled: busy, playerId: row.playerId, publicId: row.publicId },
            { action: 'admin-ban-row', label: '封禁此行', kind: 'button', disabled: busy, playerId: row.playerId, publicId: row.publicId },
            { action: 'admin-unban-row', label: '解封此行', kind: 'button', disabled: busy, playerId: row.playerId, publicId: row.publicId },
          ],
        };
      }),
      confirm: confirmVm,
      buttons: [
        { action: 'accounts-prev', label: '上一页', kind: 'button', disabled: busy || offset <= 0 },
        { action: 'accounts-next', label: '下一页', kind: 'button', disabled: busy || !hasMore },
        { action: 'admin-refresh-accounts', label: '刷新', kind: 'button', disabled: busy },
        { action: 'goto-admin', label: '返回面板', kind: 'button', disabled: busy },
        { action: 'accounts-size-20', label: '每页 20', kind: 'button', disabled: busy },
        { action: 'accounts-size-50', label: '每页 50', kind: 'button', disabled: busy },
        { action: 'accounts-size-100', label: '每页 100', kind: 'button', disabled: busy },
      ],
    });
  }

  function viewModel(state) {
    var notice = noticeOf(state);
    var busy = state.busy === true;

    // F2 两屏仅管理员可达（02-accounts.md §3）；非管理员态一律兜底到主界面（A-1：入口完全不渲染）
    var isAdmin = state.session && state.session.isAdmin === true;
    if ((state.view === 'admin' || state.view === 'accounts') && !isAdmin) return hubViewModel(state, notice, busy);

    if (state.view === 'admin') return adminViewModel(state, notice, busy);
    if (state.view === 'accounts') return accountsViewModel(state, notice, busy);
    if (state.view === 'hub') return hubViewModel(state, notice, busy);
    if (state.view === 'profile') return profileViewModel(state, notice, busy);
    if (state.view === 'warehouse') return warehouseViewModel(state, notice, busy);
    if (state.view === 'box') return boxViewModel(state, notice, busy);
    if (state.view === 'settings') return settingsViewModel(state, notice, busy);
    if (EMPTY_PAGES[state.view] !== undefined) return emptyPageViewModel(state, notice, busy);

    if (state.view === 'register') {
      return vm('注册', {
        notice: notice,
        hint: '用户名 3~24 字符，仅 [A-Za-z0-9_-]；密码 8~72 字符；昵称可留空，最长 16 字符',
        fields: [
          { name: 'username', label: '用户名', type: 'text', value: state.form.username },
          { name: 'password', label: '密码', type: 'password', value: state.form.password },
          { name: 'confirm', label: '确认密码', type: 'password', value: state.form.confirm },
          { name: 'nickname', label: '昵称（可留空）', type: 'text', value: state.form.nickname },
        ],
        buttons: [
          { action: 'submit-register', label: '注册', kind: 'submit', disabled: busy },
          { action: 'goto-login', label: '返回登录', kind: 'button', disabled: busy },
        ],
        enterAction: 'submit-register',
      });
    }

    if (state.view === 'password') {
      // F3 §4：密码屏现有两个入口（profile 的「设置密码」/settings 的「修改密码」），
      //   故同时渲染「返回用户详情」与「返回设置」（不新增动作）
      return vm('设置密码', {
        notice: notice,
        hint: '新密码 8~72 字符；改密成功后其他设备的会话会被撤销',
        fields: [
          { name: 'oldPassword', label: '原密码', type: 'password', value: state.form.oldPassword },
          { name: 'newPassword', label: '新密码', type: 'password', value: state.form.newPassword },
          { name: 'newConfirm', label: '确认新密码', type: 'password', value: state.form.newConfirm },
        ],
        buttons: [
          { action: 'submit-password', label: '提交改密', kind: 'submit', disabled: busy },
          { action: 'goto-home', label: '返回用户详情', kind: 'button', disabled: busy },
          { action: 'goto-settings', label: '返回设置', kind: 'button', disabled: busy },
        ],
        enterAction: 'submit-password',
      });
    }

    // 缺省 = login
    return vm('登录', {
      notice: notice,
      hint: '用户名 3~24 字符，仅 [A-Za-z0-9_-]；密码 8~72 字符',
      fields: [
        { name: 'username', label: '用户名', type: 'text', value: state.form.username },
        { name: 'password', label: '密码', type: 'password', value: state.form.password },
      ],
      buttons: [
        { action: 'submit-login', label: '登录', kind: 'submit', disabled: busy },
        { action: 'goto-register', label: '去注册', kind: 'button', disabled: busy },
      ],
      enterAction: 'submit-login',
    });
  }

  return {
    PAGE_TITLE: PAGE_TITLE,
    BOX_TIMES_MAX: BOX_TIMES_MAX,
    BUCKET_LABELS: BUCKET_LABELS,
    BUCKET_ORDER: BUCKET_ORDER,
    EMPTY_PAGES: EMPTY_PAGES,
    CONFIG_PLACEHOLDER_TEXT: CONFIG_PLACEHOLDER_TEXT,
    NICKNAME_MAX_TEXT: NICKNAME_MAX_TEXT,
    BOX_TIMES_RANGE_TEXT: BOX_TIMES_RANGE_TEXT,
    EMPTY_WAREHOUSE_TEXT: EMPTY_WAREHOUSE_TEXT,
    pick: pick,
    isOk: isOk,
    errorCodeOf: errorCodeOf,
    isSessionError: isSessionError,
    sessionOf: sessionOf,
    isAdminOf: isAdminOf,
    loginOkText: loginOkText,
    registerOkText: registerOkText,
    passwordOkText: passwordOkText,
    logoutOkText: logoutOkText,
    logoutUnconfirmedText: logoutUnconfirmedText,
    nicknameOkText: nicknameOkText,
    REFRESH_OK_TEXT: REFRESH_OK_TEXT,
    WAREHOUSE_OK_TEXT: WAREHOUSE_OK_TEXT,
    BOX_OK_TEXT: BOX_OK_TEXT,
    hintFor: hintFor,
    noticeText: noticeText,
    networkText: networkText,
    ADMIN_HINTS: ADMIN_HINTS,
    ADMIN_FORBIDDEN_TEXT: ADMIN_FORBIDDEN_TEXT,
    adminNoticeText: adminNoticeText,
    statsText: statsText,
    rebuildText: rebuildText,
    botsText: botsText,
    clearBotsText: clearBotsText,
    deleteAccountText: deleteAccountText,
    banText: banText,
    ADMIN_ROW_FIELDS: ADMIN_ROW_FIELDS,
    accountRows: accountRows,
    accountsInfoText: accountsInfoText,
    accountsHasMore: accountsHasMore,
    authLines: authLines,
    profileLines: profileLines,
    detailLines: detailLines,
    hubSummary: hubSummary,
    bucketItems: bucketItems,
    capOf: capOf,
    warehouseCapacityText: warehouseCapacityText,
    usageText: usageText,
    itemLabel: itemLabel,
    itemRows: itemRows,
    itemDetailLines: itemDetailLines,
    boxResultLines: boxResultLines,
    fullBucket: fullBucket,
    boxFullNotice: boxFullNotice,
    emptyPageText: emptyPageText,
    emptyPageTitle: emptyPageTitle,
    modalViewModel: modalViewModel,
    viewModel: viewModel,
  };
});
