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
  // 提交③（出战配置编辑器）的文案常量见下方 §3.7 段（CONFIG_ACTIVE_HINT / CONFIG_DRAFT_HINT …）
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

  /* ---------- F3 提交③：出战配置编辑器（03 §3.7/§3.8/§4/§6） ----------
   *
   * 两级弹窗：① `config`（逐位置：角色模板 / 角色插槽 / 技能1..3 / 技能插槽 / 战斗AI）
   *           ② `slot-pick` / `plugin-pick` / `ai-pick`（选择要替换成什么）。
   * 所有编辑只落在**本地草稿**（state.configs.draft）上；「保存」才 PUT（草稿→服务端）。
   * 插件装配是**两步**（D-159/§3.7 ⚠️）：先 assemble 改仓库里那件物品，再用服务端回带的
   *   仓库取回**更新后的那件物品**替换草稿 —— 只做①不做② = 界面看着换了、保存后没换。
   */

  // 技能位置数（D-160：完整性 = 角色 + **恰 3 技能** + AI；与 store.SKILL_SLOTS 同口径）
  var SKILL_SLOTS = 3;
  // 位置键（与 store.CONFIG_POSITIONS 逐条相等；`skillN` = 第 N 个技能，0 起）
  var POS_ROLE = 'role';
  var POS_AI = 'ai';
  var POS_LABELS = Object.freeze({ role: '角色模板', skill0: '技能1', skill1: '技能2', skill2: '技能3', ai: '战斗AI' });
  var EMPTY_LABEL = '空';
  // B-5 / §3.7 ③：出战中的配置只能替换，不能拆卸
  var CONFIG_ACTIVE_HINT = '出战中的配置只能替换，不能拆卸';
  // §3.7 ③ 明文指定的"保存出战槽失败"可读文案（服务端 message 是「出战配置必须完整（…）」，
  //   但玩家视角要说明**为什么**只能替换：出战配置不能有空的角色/技能/AI）
  var CONFIG_INCOMPLETE_SAVE_TEXT = '出战中的配置必须完整，只能替换，不能拆卸';
  var CONFIG_DRAFT_HINT = '编辑先落在本地草稿：点「保存」才写入服务端';
  var CONFIG_NO_WAREHOUSE_TEXT = '（尚未读取仓库：点「关闭」后重新打开出战配置）';
  var CONFIG_NO_AI_TEXT = '（尚未读取 AI 库：点「关闭」后重新打开）';
  var CONFIG_NO_ITEM_TEXT = '该位置尚未安装物品：先选角色/技能模板，再装插件';
  // §6：装配/拆卸失败码 → 玩家可读文案（服务端原文附注，便于诊断）
  var PLUGIN_HINTS = Object.freeze({
    slot_type_mismatch: '该插件不能装入此槽（类型不符）',
    slot_occupied: '该插槽已装配插件，请先拆卸',
    points_exceeded: '插件点数不足',
    plugin_equipped: '该插件已被装配，请先拆卸',
    item_missing: '物品不存在（可能已被清除）',
    slot_empty: '该插槽当前为空',
    plugin_missing: '该插槽当前为空',
  });

  function seqOf(pos) {
    var m = /^skill([0-2])$/.exec(String(pos));
    return m === null ? null : Number(m[1]);
  }

  function isConfigPos(pos) {
    return pos === POS_ROLE || pos === POS_AI || seqOf(pos) !== null;
  }

  function posLabelOf(pos) {
    var s = POS_LABELS[pos];
    if (s !== undefined) return s;
    var i = seqOf(pos);
    return i === null ? '未知位置' : '技能' + (i + 1);
  }

  // 物品标题：`名字（品质）`（03 §3.7「已装：角色名（+ 品质）」）
  function itemTitle(item) {
    var name = or(pick(item, 'name'), '（未命名物品）');
    var quality = str(pick(item, 'quality'));
    return quality === null ? name : name + '（' + quality + '）';
  }

  // 三个技能位置（长度恒 3：服务端 `skills[3]`）
  function skillsOf3(loadout) {
    var raw = loadout && Array.isArray(loadout.skills) ? loadout.skills : [];
    var out = [];
    for (var i = 0; i < SKILL_SLOTS; i += 1) out.push(raw[i] === undefined ? null : raw[i]);
    return out;
  }

  function emptyLoadout() {
    return { role: null, skills: [null, null, null], ai: null };
  }

  function configSlotOf(env, slotId) {
    var slots = arrayOf(pick(env, 'data.slots'));
    for (var i = 0; i < slots.length; i += 1) if (str(pick(slots[i], 'slotId')) === slotId) return slots[i];
    return null;
  }

  // GET /me/configs 的槽的 loadout 副本 → 弹窗草稿（槽不存在 → null，调用方须报错而不是开空编辑器）
  function draftForSlot(env, slotId) {
    if (env === null) return null;
    var slot = configSlotOf(env, slotId);
    if (slot === null) return null;
    var loadout = pick(slot, 'loadout');
    return { slotId: slotId, loadout: loadout && typeof loadout === 'object' ? loadout : emptyLoadout() };
  }

  // 草稿正文（优先草稿；无草稿时回落配置列表里的服务端副本；都没有 → 空配置）
  function draftLoadoutOf(state, slotId) {
    var cfg = state && state.configs ? state.configs : null;
    var draft = cfg === null ? null : cfg.draft;
    if (draft && typeof draft === 'object' && draft.loadout && typeof draft.loadout === 'object') {
      if (draft.slotId === undefined || draft.slotId === slotId) return draft.loadout;
    }
    var env = cfg === null ? null : cfg.data;
    var slot = env === null ? null : configSlotOf(env, slotId);
    var loadout = slot === null ? null : pick(slot, 'loadout');
    return loadout && typeof loadout === 'object' ? loadout : emptyLoadout();
  }

  function isActiveSlot(state, slotId) {
    var env = state && state.configs ? state.configs.data : null;
    return env !== null && str(pick(env, 'data.activeSlotId')) === slotId;
  }

  // D-160 完整性判据的**前端本地镜像**（服务端权威仍是 store/archive.loadoutMissingOf；
  //   这里只为"状态行 + 保存/出战前置提示"服务，**不作为是否发请求的依据**）
  function missingOf(loadout) {
    var missing = [];
    if (!loadout || typeof loadout !== 'object' || Array.isArray(loadout)) return ['loadout'];
    if (!loadout.role || typeof loadout.role !== 'object') missing.push('role');
    var skills = Array.isArray(loadout.skills) ? loadout.skills : [];
    for (var i = 0; i < SKILL_SLOTS; i += 1) if (!skills[i] || typeof skills[i] !== 'object') missing.push('skills[' + i + ']');
    if (skills.length > SKILL_SLOTS) missing.push('skills.length');
    if (!loadout.ai || typeof loadout.ai !== 'object') missing.push('ai');
    return missing;
  }

  // 缺项 → 玩家可读消息（**与服务端 store/archive.loadoutMissingDetails 同措辞**：
  //   §6 表格要求 `缺少角色物品` / `技能位置缺失: N` / `缺少 AI 程序` 逐条渲染）
  function missingMessageOf(p) {
    if (p === 'loadout') return '缺少出战配置';
    if (p === 'role') return '缺少角色物品';
    if (p === 'ai') return '缺少 AI 程序';
    if (p === 'skills.length') return '技能必须恰 3 个';
    var m = /^skills\[(\d+)\]$/.exec(String(p));
    return m === null ? String(p) : '技能位置缺失: ' + m[1];
  }

  // 缺项路径 → 消息列表（审查 F-5：`p` 为 null 时 `p.path` 会抛 —— 服务端恒给字符串，此处按防御写法）
  function missingSummaryText(missing) {
    var list = missing === undefined || missing === null ? [] : missing;
    return list.map(function (p) {
      return missingMessageOf(typeof p === 'string' ? p : (p && typeof p === 'object' ? p.path : ''));
    }).join('、');
  }

  // 错误信封 details（00-rules §4.2：逐位置 path/message 都来自真实响应）
  function detailListOf(env) {
    var details = arrayOf(pick(env, 'error.details'));
    var out = [];
    for (var i = 0; i < details.length; i += 1) {
      out.push({ path: str(pick(details[i], 'path')), message: str(pick(details[i], 'message')) });
    }
    return out;
  }

  function isPositionDetailPath(p) {
    return p === 'role' || p === 'ai' || p === 'loadout' || p === 'skills.length' || /^skills\[\d+\]$/.test(String(p));
  }

  // §6 表格：details[] 逐条渲染（path → 可读消息；服务端给了 message 就用它）
  function detailSummaryText(details) {
    return (details || []).map(function (d) {
      if (d.message !== null && d.message !== undefined && d.message !== '') return d.message;
      return missingMessageOf(d.path === null ? '' : d.path);
    }).join('、');
  }

  // 保存失败（§6 loadout_invalid）：出战槽不完整 → 翻成玩家可读文案（不原样抛服务端 message）
  function configSaveFailText(env) {
    var code = errorCodeOf(env);
    if (code !== 'loadout_invalid') return noticeText(env);
    var details = detailListOf(env);
    var missing = details.filter(function (d) { return isPositionDetailPath(d.path); });
    if (details.length === 0 || missing.length !== details.length) return noticeText(env);
    return CONFIG_INCOMPLETE_SAVE_TEXT + '（' + detailSummaryText(missing) + '）';
  }

  // 设为出战失败（§6 cannot_activate_incomplete）：逐条显示缺什么
  function configActivateFailText(env) {
    var code = errorCodeOf(env);
    if (code !== 'cannot_activate_incomplete') return noticeText(env);
    var details = detailListOf(env);
    var missing = details.filter(function (d) { return isPositionDetailPath(d.path); });
    var text = missing.length === 0 ? missingSummaryText(details.map(function (d) { return d.path; })) : detailSummaryText(missing);
    return '该配置不完整，无法设为出战（' + text + '）';
  }

  // 装配/拆卸失败（§6 slot_type_mismatch / slot_occupied / points_exceeded / plugin_equipped /
  //   item_missing / slot_empty）：可读改写 + 服务端原文附注
  function pluginFailText(env) {
    var hint = PLUGIN_HINTS[errorCodeOf(env)];
    if (hint === undefined) return noticeText(env);
    var message = or(pick(env, 'error.message'), '');
    return message === '' ? hint : hint + '（服务端原文：' + message + '）';
  }

  // 装配/拆卸响应 = `{warehouse, usage, counts, caps}`（**不是** GET /me/warehouse 的信封形状）
  //   → 归一成仓库信封，使 `state.warehouse` 与仓库屏共用同一份数据（无需再拉一次）
  function warehouseChangeEnvelope(env) {
    var warehouse = pick(env, 'data.warehouse');
    var usage = pick(env, 'data.usage');
    var caps = pick(env, 'data.caps');
    var buckets = warehouse && typeof warehouse === 'object' && warehouse.buckets && typeof warehouse.buckets === 'object'
      ? warehouse.buckets
      : { role: [], skill: [], rolePlugin: [], skillPlugin: [] };
    return {
      ok: pick(env, 'ok') === true,
      data: {
        buckets: buckets,
        usage: usage && typeof usage === 'object' ? usage : {},
        caps: caps && typeof caps === 'object' ? caps : {},
        counts: {},
      },
    };
  }

  // **两步顺序的第②步**：从装配/拆卸响应回带的仓库里取回**更新后的那件物品**
  function updatedItemOf(env, uid) {
    if (uid === null) return null;
    return findItem(warehouseChangeEnvelope(env), uid);
  }

  // 某位置上已装的物品（角色 / 技能N；AI 位置不是物品）
  function itemAt(loadout, pos) {
    if (loadout === null || typeof loadout !== 'object') return null;
    if (pos === POS_ROLE) return loadout.role && typeof loadout.role === 'object' ? loadout.role : null;
    var i = seqOf(pos);
    if (i === null) return null;
    var item = skillsOf3(loadout)[i];
    return item && typeof item === 'object' ? item : null;
  }

  // 替换草稿某位置上的物品（**就地换整件物品**：新物品的插槽状态天然是它自己的 —— §3.7 B-7）
  function setItemAt(loadout, pos, item) {
    if (!isConfigPos(pos) || pos === POS_AI) return null;
    var next = Object.assign({}, loadout);
    next.skills = skillsOf3(loadout);
    if (pos === POS_ROLE) next.role = item;
    else next.skills[seqOf(pos)] = item;
    return next;
  }

  // `slot-pick` 选中（本地；候选来自仓库同分类物品）：choice = {pos, uid} 或 {pos, empty:true}
  function applySlotChoice(state, loadout, choice) {
    var pos = choice && choice.pos;
    if (!isConfigPos(pos) || pos === POS_AI) return null;
    if (choice.empty === true) return setItemAt(loadout, pos, null);
    var env = state && state.warehouse ? state.warehouse.envelope : null;
    if (env === null) return null;
    var bucket = pos === POS_ROLE ? 'role' : 'skill';
    var items = bucketItems(env, bucket);
    for (var i = 0; i < items.length; i += 1) {
      if (str(pick(items[i], 'uid')) === str(choice.uid)) return setItemAt(loadout, pos, items[i]);
    }
    return null;
  }

  // `plugin-pick` 的装配目标：该位置物品的 uid + 插槽序号（装配端点的 body 就是这两个值）
  function assemblyTargetOf(loadout, pos, idx) {
    var item = itemAt(loadout, pos);
    if (item === null) return null;
    var slots = arrayOf(pick(item, 'slots'));
    if (!Number.isInteger(idx) || idx < 0 || idx >= slots.length) return null;
    var uid = str(pick(item, 'uid'));
    return uid === null ? null : { targetUid: uid, slotIndex: idx };
  }

  // 插槽类型（用于候选预过滤与"不匹配 → 标灰 + 原因"，B-8）
  function slotTypeAt(loadout, pos, idx) {
    var item = itemAt(loadout, pos);
    if (item === null) return null;
    var slots = arrayOf(pick(item, 'slots'));
    if (!Number.isInteger(idx) || idx < 0 || idx >= slots.length) return null;
    return str(pick(slots[idx], 'type'));
  }

  // 插件候选（**全部列出**；不匹配的由调用方标灰 + 写原因 —— 用户口径）
  function pluginCandidatesOf(state, pos) {
    var env = state && state.warehouse ? state.warehouse.envelope : null;
    if (env === null) return [];
    var bucket = pos === POS_ROLE ? 'rolePlugin' : 'skillPlugin';
    return bucketItems(env, bucket).map(function (plugin) {
      return { uid: str(pick(plugin, 'uid')), label: itemTitle(plugin), slot: str(pick(plugin, 'slot')) };
    });
  }

  // 已装配插件的显示名（仓库里查名字；查不到回落 uid）
  function pluginLabelOf(state, pluginUid) {
    if (pluginUid === null) return EMPTY_LABEL;
    var env = state && state.warehouse ? state.warehouse.envelope : null;
    var item = env === null ? null : findItem(env, pluginUid);
    var name = item === null ? null : str(pick(item, 'name'));
    return name === null ? '已装配 ' + pluginUid : name;
  }

  // `ai-pick` 候选（GET /me/ai 的 data.items）
  function aiCandidatesOf(env) {
    return arrayOf(pick(env, 'data.items')).map(function (ai) {
      return { aiId: str(pick(ai, 'aiId')), name: str(pick(ai, 'name')), program: pick(ai, 'program') };
    });
  }

  function aiOptionOf(env, aiId) {
    if (aiId === null) return null;
    var list = aiCandidatesOf(env);
    for (var i = 0; i < list.length; i += 1) if (list[i].aiId === aiId) return list[i];
    return null;
  }

  // `ai-set`：替换草稿的 AI 位置（`ai` = 程序正文、`aiId` = 库内引用；服务端按 aiId 校验）
  function applyAiChoice(loadout, option) {
    var next = Object.assign({}, loadout);
    if (option === null) {
      next.ai = null;
      next.aiId = null;
      return next;
    }
    next.ai = option.program;
    next.aiId = option.aiId;
    return next;
  }

  function aiLabelOf(state, loadout) {
    if (!loadout || !loadout.ai || typeof loadout.ai !== 'object') return EMPTY_LABEL;
    var aiId = typeof loadout.aiId === 'string' && loadout.aiId !== '' ? loadout.aiId : null;
    var option = aiOptionOf(state && state.configs ? state.configs.ai : null, aiId);
    if (option !== null && option.name !== null) return option.name;
    return aiId === null ? '（已装 AI）' : aiId;
  }

  // 状态行（03 §3.7）：`出战配置N：未保存/已保存 · 非出战/出战中` + 草稿完整性
  function configStatusText(state, slotId) {
    var draftIsDirty = state && state.configs && state.configs.dirty === true;
    var missing = missingOf(draftLoadoutOf(state, slotId));
    return '出战配置' + String(slotId).replace(/^slot/, '')
      + '：' + (draftIsDirty ? '未保存' : '已保存')
      + ' · ' + (isActiveSlot(state, slotId) ? '出战中' : '非出战')
      + ' · 草稿' + (missing.length === 0 ? '完整' : '不完整（' + missingSummaryText(missing) + '）');
  }

  // 编辑器逐位置行：每个位置 = 一个**可点按钮**（`空` 同样是可点按钮）
  function configEditorRows(state, slotId, busy) {
    var loadout = draftLoadoutOf(state, slotId);
    var rows = [];
    var role = itemAt(loadout, POS_ROLE);
    rows.push({
      text: posLabelOf(POS_ROLE),
      buttons: [{
        action: 'slot-pick', label: role === null ? EMPTY_LABEL : itemTitle(role), kind: 'button',
        disabled: busy, slot: slotId, pos: POS_ROLE,
      }],
    });
    if (role !== null) {
      var roleSlots = arrayOf(pick(role, 'slots'));
      for (var i = 0; i < roleSlots.length; i += 1) {
        rows.push({
          text: '插槽' + (i + 1) + '（' + or(pick(roleSlots[i], 'type'), '未知类型') + '）',
          buttons: [{
            action: 'plugin-pick', label: pluginLabelOf(state, str(pick(roleSlots[i], 'pluginUid'))), kind: 'button',
            disabled: busy, slot: slotId, pos: POS_ROLE, idx: String(i),
          }],
        });
      }
    }
    var skills = skillsOf3(loadout);
    for (var k = 0; k < SKILL_SLOTS; k += 1) {
      var pos = 'skill' + k;
      var skill = skills[k] && typeof skills[k] === 'object' ? skills[k] : null;
      rows.push({
        text: posLabelOf(pos),
        buttons: [{
          action: 'slot-pick', label: skill === null ? EMPTY_LABEL : itemTitle(skill), kind: 'button',
          disabled: busy, slot: slotId, pos: pos,
        }],
      });
      if (skill === null) continue;
      var skillSlots = arrayOf(pick(skill, 'slots'));
      for (var j = 0; j < skillSlots.length; j += 1) {
        rows.push({
          text: '技能' + (k + 1) + '·插槽' + (j + 1) + '（' + or(pick(skillSlots[j], 'type'), '未知类型') + '）',
          buttons: [{
            action: 'plugin-pick', label: pluginLabelOf(state, str(pick(skillSlots[j], 'pluginUid'))), kind: 'button',
            disabled: busy, slot: slotId, pos: pos, idx: String(j),
          }],
        });
      }
    }
    rows.push({
      text: posLabelOf(POS_AI),
      buttons: [{
        action: 'ai-pick', label: aiLabelOf(state, loadout), kind: 'button', disabled: busy, slot: slotId, pos: POS_AI,
      }],
    });
    return rows;
  }

  // 弹窗 A：出战配置编辑器
  function configModal(state, modal, busy) {
    var slotId = str(modal.slotId) === null ? 'slot1' : str(modal.slotId);
    var active = isActiveSlot(state, slotId);
    return {
      title: '出战配置' + slotId.replace(/^slot/, ''),
      hint: active ? CONFIG_ACTIVE_HINT + '：' + CONFIG_DRAFT_HINT : CONFIG_DRAFT_HINT,
      lines: [configStatusText(state, slotId)],
      rows: configEditorRows(state, slotId, busy),
      buttons: [
        { action: 'config-save', label: '保存', kind: 'button', disabled: busy },
        { action: 'config-activate', label: '设为出战', kind: 'button', disabled: busy },
        closeButton(busy),
      ],
    };
  }

  // 弹窗 B-1：选择角色/技能模板（仓库同分类物品 + `空`；**出战中的配置不提供 `空`** —— B-5）
  function slotPickModal(state, modal, busy) {
    var slotId = str(modal.slotId) === null ? 'slot1' : str(modal.slotId);
    var pos = str(modal.pos);
    var bucket = pos === POS_ROLE ? 'role' : 'skill';
    var active = isActiveSlot(state, slotId);
    var env = state && state.warehouse ? state.warehouse.envelope : null;
    var rows = [];
    var lines = [];
    if (env === null) lines.push(CONFIG_NO_WAREHOUSE_TEXT);
    else {
      var items = bucketItems(env, bucket);
      for (var i = 0; i < items.length; i += 1) {
        rows.push({
          text: '',
          buttons: [{
            action: 'slot-set', label: itemTitle(items[i]), kind: 'button', disabled: busy,
            slot: slotId, pos: pos, uid: str(pick(items[i], 'uid')),
          }],
        });
      }
    }
    if (active) lines.push(CONFIG_ACTIVE_HINT + '：候选里没有「' + EMPTY_LABEL + '」');
    else {
      rows.push({
        text: '',
        buttons: [{ action: 'slot-set', label: EMPTY_LABEL, kind: 'button', disabled: busy, slot: slotId, pos: pos, empty: true }],
      });
    }
    return {
      title: '选择' + posLabelOf(pos),
      hint: '候选来自服务端仓库的' + (pos === POS_ROLE ? '角色' : '技能') + '分类；选中即替换草稿',
      lines: lines,
      rows: rows,
      buttons: [closeButton(busy)],
    };
  }

  // 弹窗 B-2：某插槽的插件候选（**全部列出**；类型不匹配 → 标灰 + 写原因，B-8）
  function pluginPickModal(state, modal, busy) {
    var slotId = str(modal.slotId) === null ? 'slot1' : str(modal.slotId);
    var pos = str(modal.pos);
    var idx = Number(modal.idx);
    var loadout = draftLoadoutOf(state, slotId);
    var type = slotTypeAt(loadout, pos, idx);
    if (type === null) {
      return {
        title: '选择插件',
        lines: [CONFIG_NO_ITEM_TEXT],
        rows: [],
        buttons: [closeButton(busy)],
      };
    }
    var reason = '此槽只能装 ' + type;
    var rows = pluginCandidatesOf(state, pos).map(function (candidate) {
      var match = candidate.slot === type;
      return {
        text: match ? '' : reason,
        buttons: [{
          action: 'plugin-set', label: candidate.label, kind: 'button',
          disabled: busy || !match, slot: slotId, pos: pos, idx: String(idx), uid: candidate.uid,
        }],
      };
    });
    return {
      title: '选择插件（' + posLabelOf(pos) + ' 插槽' + (idx + 1) + '：' + type + '）',
      hint: '类型不匹配的候选已标灰并写明原因（' + reason + '）',
      lines: ['目标槽类型：' + type],
      rows: rows,
      buttons: [
        { action: 'plugin-clear', label: '清空此槽', kind: 'button', disabled: busy, slot: slotId, pos: pos, idx: String(idx) },
        closeButton(busy),
      ],
    };
  }

  // 弹窗 B-3：AI 库候选（GET /me/ai 的条目；出战中的配置不提供 `空`）
  function aiPickModal(state, modal, busy) {
    var slotId = str(modal.slotId) === null ? 'slot1' : str(modal.slotId);
    var env = state && state.configs ? state.configs.ai : null;
    var active = isActiveSlot(state, slotId);
    var lines = [];
    var rows = [];
    if (env === null) lines.push(CONFIG_NO_AI_TEXT);
    else {
      var items = aiCandidatesOf(env);
      for (var i = 0; i < items.length; i += 1) {
        rows.push({
          text: '',
          buttons: [{
            action: 'ai-set', label: items[i].name === null ? '（未命名 AI）' : items[i].name, kind: 'button',
            disabled: busy, slot: slotId, aiId: items[i].aiId,
          }],
        });
      }
    }
    if (active) lines.push(CONFIG_ACTIVE_HINT + '：候选里没有「' + EMPTY_LABEL + '」');
    else {
      rows.push({
        text: '',
        buttons: [{ action: 'ai-set', label: EMPTY_LABEL, kind: 'button', disabled: busy, slot: slotId, empty: true }],
      });
    }
    return {
      title: '选择战斗AI',
      hint: '候选来自 GET /me/ai；选中即替换草稿里的 AI 位置',
      lines: lines,
      rows: rows,
      buttons: [closeButton(busy)],
    };
  }

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
    // 提交③：出战配置编辑器（弹窗 A）与它的两级选择弹窗（弹窗 B）
    if (modal.kind === 'slot-pick') return slotPickModal(state, modal, busy);
    if (modal.kind === 'plugin-pick') return pluginPickModal(state, modal, busy);
    if (modal.kind === 'ai-pick') return aiPickModal(state, modal, busy);
    return configModal(state, modal, busy);
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
    SKILL_SLOTS: SKILL_SLOTS,
    CONFIG_ACTIVE_HINT: CONFIG_ACTIVE_HINT,
    CONFIG_INCOMPLETE_SAVE_TEXT: CONFIG_INCOMPLETE_SAVE_TEXT,
    CONFIG_DRAFT_HINT: CONFIG_DRAFT_HINT,
    PLUGIN_HINTS: PLUGIN_HINTS,
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
    // 提交③：出战配置编辑器（03 §3.7/§3.8）
    itemTitle: itemTitle,
    posLabelOf: posLabelOf,
    isConfigPos: isConfigPos,
    skillsOf3: skillsOf3,
    draftForSlot: draftForSlot,
    draftLoadoutOf: draftLoadoutOf,
    isActiveSlot: isActiveSlot,
    missingOf: missingOf,
    missingMessageOf: missingMessageOf,
    missingSummaryText: missingSummaryText,
    detailSummaryText: detailSummaryText,
    detailListOf: detailListOf,
    configSaveFailText: configSaveFailText,
    configActivateFailText: configActivateFailText,
    pluginFailText: pluginFailText,
    warehouseChangeEnvelope: warehouseChangeEnvelope,
    updatedItemOf: updatedItemOf,
    itemAt: itemAt,
    setItemAt: setItemAt,
    applySlotChoice: applySlotChoice,
    assemblyTargetOf: assemblyTargetOf,
    slotTypeAt: slotTypeAt,
    pluginCandidatesOf: pluginCandidatesOf,
    pluginLabelOf: pluginLabelOf,
    aiCandidatesOf: aiCandidatesOf,
    aiOptionOf: aiOptionOf,
    applyAiChoice: applyAiChoice,
    aiLabelOf: aiLabelOf,
    configStatusText: configStatusText,
    configEditorRows: configEditorRows,
    emptyPageText: emptyPageText,
    emptyPageTitle: emptyPageTitle,
    modalViewModel: modalViewModel,
    viewModel: viewModel,
  };
});
