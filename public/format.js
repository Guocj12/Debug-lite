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
  //   F6 起 `quick` 已是真屏（04 分册）；F7 起 `tournament`/`leaderboard` 已是真屏（05 分册）；
  //   仅剩 `ai-editor`（F5：AI 编辑器）
  var EMPTY_PAGES = Object.freeze({
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
  // D-170：改账号（段位/积分）结果文案。峰值单独展示 —— 服务端显式不写峰值（§2.5），
  //   把它打出来才能让管理员一眼看到"改档没有伪造历史峰值"。
  function patchText(env, publicId) {
    return '已改 ' + or(pick(env, 'data.publicId'), or(publicId, '该账号'))
      + '：段位 ' + or(pick(env, 'data.tier'), '?')
      + '（峰值 ' + or(pick(env, 'data.peakTier'), '?') + '）'
      + '· 积分 ' + or(pick(env, 'data.points'), '?')
      + '（峰值 ' + or(pick(env, 'data.peakPoints'), '?') + '）';
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

  // ==== D-163（2026-09-25 热修）：候选可用性 —— 把"点了必然 409"的选项**标灰并写明原因** ====
  //   服务端规则（用户 2026-09-25 裁定）：
  //     ① 同一件物品同时只能被**一份配置**引用 → 被他配置引用的物品不可选（409 item_in_use）；
  //     ② 同一份配置内一件物品只能占**一个位置** → 本配置已在别处用过的物品不可选（409 loadout_invalid）；
  //     ③ 已装配的插件不能再装（409 plugin_equipped / slot_occupied）。
  //   修前这三种情况都照常渲染成可点按钮 → 玩家点下去必然吃 409（"被标记为已装配的物品无法被继续装配"）。
  function loadoutUidsOf(loadout) {
    var out = [];
    var push = function (uid) {
      var s = str(uid);
      if (s !== null && out.indexOf(s) === -1) out.push(s);
    };
    var ld = loadout && typeof loadout === 'object' ? loadout : null;
    if (ld === null) return out;
    var role = ld.role && typeof ld.role === 'object' ? ld.role : null;
    if (role !== null) {
      push(role.uid);
      var rs = arrayOf(pick(role, 'slots'));
      for (var a = 0; a < rs.length; a += 1) push(pick(rs[a], 'pluginUid'));
    }
    var skills = skillsOf3(ld);
    for (var i = 0; i < SKILL_SLOTS; i += 1) {
      var sk = skills[i];
      if (!sk || typeof sk !== 'object') continue;
      push(sk.uid);
      var ss = arrayOf(pick(sk, 'slots'));
      for (var b = 0; b < ss.length; b += 1) push(pick(ss[b], 'pluginUid'));
    }
    return out;
  }

  // 该物品被**哪些别的配置**引用（不含 exceptSlotId）→ ['slot2','slot3'] 或 []
  function otherConfigsOf(state, exceptSlotId, uid) {
    var out = [];
    var env = state && state.configs ? state.configs.data : null;
    if (env === null || uid === null) return out;
    var slots = arrayOf(pick(env, 'data.slots'));
    for (var i = 0; i < slots.length; i += 1) {
      var slotId = str(pick(slots[i], 'slotId'));
      if (slotId === null || slotId === exceptSlotId) continue;
      if (loadoutUidsOf(pick(slots[i], 'loadout')).indexOf(uid) !== -1) out.push(slotId);
    }
    return out;
  }

  // 该 uid 是否已被**本份草稿的其它位置**用掉（exceptPos = 正在挑选的位置）
  function usedElsewhereInDraft(state, slotId, exceptPos, uid) {
    if (uid === null) return false;
    var ld = draftLoadoutOf(state, slotId);
    var role = itemAt(ld, POS_ROLE);
    if (exceptPos !== POS_ROLE && role !== null && str(pick(role, 'uid')) === uid) return true;
    for (var i = 0; i < SKILL_SLOTS; i += 1) {
      var pos = 'skill' + i;
      if (pos === exceptPos) continue;
      var sk = itemAt(ld, pos);
      if (sk !== null && str(pick(sk, 'uid')) === uid) return true;
    }
    return false;
  }

  // 该插件是否已装在仓库某件物品的槽上（= 服务端的 `equipped=true`；此处不读 equipped 字段，
  //   而是从已登记的 `slots[].pluginUid` 推导，避免为 UI 扩大字段契约）
  function pluginEquippedOf(state, uid) {
    if (uid === null) return false;
    var env = state && state.warehouse ? state.warehouse.envelope : null;
    if (env === null) return false;
    for (var k = 0; k < 2; k += 1) {
      var items = bucketItems(env, k === 0 ? 'role' : 'skill');
      for (var i = 0; i < items.length; i += 1) {
        var slots = arrayOf(pick(items[i], 'slots'));
        for (var j = 0; j < slots.length; j += 1) {
          if (str(pick(slots[j], 'pluginUid')) === uid) return true;
        }
      }
    }
    return false;
  }

  // 候选不可选的原因文案（'' = 可选）
  function candidateBlockReasonOf(state, slotId, pos, uid) {
    var others = otherConfigsOf(state, slotId, uid);
    if (others.length > 0) return '已被配置' + others.join('、') + '使用（一件物品同时只能装配到一份配置）';
    if (usedElsewhereInDraft(state, slotId, pos, uid)) return '本配置已在其它位置使用（一件物品只能占一个位置）';
    return '';
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
        var uid = str(pick(items[i], 'uid'));
        var blocked = candidateBlockReasonOf(state, slotId, pos, uid, {});
        rows.push({
          text: blocked,
          buttons: [{
            action: 'slot-set', label: itemTitle(items[i]), kind: 'button', disabled: busy || blocked !== '',
            slot: slotId, pos: pos, uid: uid,
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
      hint: '候选来自服务端仓库的' + (pos === POS_ROLE ? '角色' : '技能') + '分类；选中即替换草稿。'
        + '已被其它配置引用、或本配置已在别处使用的候选会标灰并写明原因（D-163）',
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
      // 不可选原因按优先级取第一条：类型不符（B-8）→ 已被他配置引用 / 本配置已用 / 已被装配（D-163）
      var why = !match ? reason
        : (candidateBlockReasonOf(state, slotId, pos, candidate.uid)
          || (pluginEquippedOf(state, candidate.uid) ? '已被装配（请先拆卸）' : ''));
      return {
        text: why,
        buttons: [{
          action: 'plugin-set', label: candidate.label, kind: 'button',
          disabled: busy || why !== '', slot: slotId, pos: pos, idx: String(idx), uid: candidate.uid,
        }],
      };
    });
    return {
      title: '选择插件（' + posLabelOf(pos) + ' 插槽' + (idx + 1) + '：' + type + '）',
      hint: '类型不匹配的候选已标灰并写明原因（' + reason + '）；已被装配或已被其它配置使用的候选同样标灰（D-163）',
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

  /* ---------- F6：快速对战 + 战斗查看器 + AI 逻辑查看器（04 §3/§5） ----------
   *
   * 本段是**帧 → 文字**的投影单一真源（总纲 §1.5）：只读服务端结果，不做任何命中/伤害/胜负推演。
   * 所有信封级字段经本文件的字段读取原语读取（路径清单登记在 contract.AUTH_FIELD_CONTRACT）；
   * 帧/AI 轨迹的子对象字段经同一原语读取（登记在 contract.FRAME_*，由 QB-6 三方核对）。
   */

  // AI 节点类型（16 类；与 `server/ai/ast.js` 的 `NODE_TYPES` 逐值相等 —— QB-7 机器核对）
  var AI_NODE_TYPES = Object.freeze(['literal', 'get', 'var', 'set', 'getVar', 'arith', 'cmp', 'logic',
    'random', 'if', 'loop', 'break', 'function', 'call', 'action', 'seq']);
  // 程序树最大显示深度（防病态程序把屏幕打爆；04 §8 Q-11）
  var AI_MAX_DEPTH = 32;

  var QUICK_IDLE_TEXT = '（尚未发起对局：点「开始快速对战」）';
  var QUICK_NO_FRAMES_TEXT = '（本场没有帧数据：点「读取本场回放」）';
  var QUICK_NO_ID_TEXT = '（本场没有帧数据，且响应未带回对局 id：无法读取回放）';
  var QUICK_OTHER_BATTLE_TEXT = '（当前查看器里是**别处**的战斗：点「开始快速对战」重新发起本屏对局）';
  var QUICK_NO_TRACE_TEXT = '（本帧无 AI 轨迹）';
  var AI_LOGIC_TRACE_NOTE = '对手 AI 只提供执行轨迹、不提供源码（D-167 / SEC-33）';
  var AI_LOGIC_NO_CONFIGS = '（尚未读取到出战配置：点「AI 逻辑查看器」重新读取）';
  var AI_LOGIC_NO_AI = '（该配置没有 AI）';
  var REPLAY_OK_TEXT = '已读取回放';
  var AI_LOGIC_OK_TEXT = 'AI 逻辑查看器已就绪（只读：程序树 + 本帧执行轨迹）';
  // AI 库（只用来把 aiId 显示成名字）读取失败时的提示：**弹窗仍打开**，名字回落 aiId（审查 F6-3）
  var AI_LOGIC_NAME_FAIL_TEXT = 'AI 逻辑查看器已就绪（AI 库读取失败：AI 名回落为 aiId）';

  // 快速对战专属失败指引（04 §6）：补上"下一步怎么办"，其余 code 走 F1 的 HINTS
  var QUICK_HINTS = Object.freeze({
    no_opponent: '稍后再试（可先注入调试 bot 或注册更多账号）',
    no_active_config: '先到「出战配置1」装配并激活',
    loadout_invalid: '出战配置引用的物品可能已变动，请到配置屏重新保存',
    replay_expired: '回放已过期（快照已淘汰或引擎/数据版本不符）',
    replay_forbidden: '该回放只对参战双方开放',
    store_not_found: '该账号档案不存在或已被删除',
  });

  // PVP 面（快速对战/锦标赛/榜单）共用的失败文案：附加指引 + 服务端文案 + 字段名。
  //   三个出口名指向同一实现（`quickNoticeText`/`rankedNoticeText`/`boardNoticeText`）—— 语义完全相同，
  //   分开命名只为调用点可读；**不复制第二份实现**。
  function pvpNoticeText(env) {
    var code = errorCodeOf(env);
    var extra = QUICK_HINTS[code] === undefined ? '' : QUICK_HINTS[code];
    var base = noticeText(env);
    return extra === '' || base.indexOf(extra) !== -1 ? base : base + '（' + extra + '）';
  }

  // 绝对口径 → 用户视角（快速对战/锦标赛里请求者恒为 p1：实测 data.opponent 即 p2）
  function battleWinnerText(winner) {
    if (winner === 'p1') return '你赢了';
    if (winner === 'p2') return '你输了';
    if (winner === 'draw') return '平局';
    if (winner === 'invalid') return '无效对局（对手快照不可用）';
    return '未知结果';
  }

  // 帧内一律用**绝对侧位**（p1=我方/进攻方，p2=对手/防守方），避免"镜像坐标系"误读
  function absoluteWinnerText(winner) {
    if (winner === 'p1') return 'p1（我方）';
    if (winner === 'p2') return 'p2（对手）';
    if (winner === 'draw') return '平局';
    if (winner === 'invalid') return '无效';
    return '未知';
  }

  function signedText(v) { return typeof v === 'number' && isFinite(v) ? (v >= 0 ? '+' : '') + String(v) : '—'; }
  function percentText(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    return String(Math.round(v * 1000) / 10) + '%';
  }
  function dirText(dir) { return dir === 1 ? '右' : (dir === -1 ? '左' : '—'); }

  function actionText(action) {
    var kind = str(pick(action, 'kind'));
    if (kind === null) return '未知';
    var dir = pick(action, 'dir');
    var sid = str(pick(action, 'sid'));
    if (kind === 'move') return '移动' + dirText(dir);
    if (kind === 'dodge') return '闪避' + dirText(dir);
    if (kind === 'forced_move') return '被推' + dirText(dir) + '（' + num(pick(action, 'cells')) + ' 格）';
    if (kind === 'cast') return '释放' + or(sid, '技能');
    if (kind === 'displacement') return '位移' + or(sid, '技能') + ' ' + dirText(dir);
    if (kind === 'defend') return '格挡';
    if (kind === 'turn') return '转身';
    if (kind === 'wait') return '待机';
    return kind;
  }

  function effectsText(effects) {
    var list = arrayOf(effects);
    if (list.length === 0) return '无';
    return list.map(function (effect) {
      var displacement = pick(effect, 'displacement');
      return or(pick(effect, 'kind'), '效果') + '（' + or(pick(effect, 'stat'), '?')
        + signedText(pick(effect, 'delta'))
        + (typeof displacement === 'number' && isFinite(displacement) && displacement !== 0
          ? '，位移' + signedText(displacement) : '')
        + '，剩' + num(pick(effect, 'remaining')) + '）';
    }).join('、');
  }

  function stateTextOf(player) {
    var flags = [];
    if (pick(player, 'defending') === true) flags.push('格挡中');
    if (pick(player, 'dodging') === true) flags.push('闪避中');
    if (pick(player, 'fullDodge') === true) flags.push('完全闪避');
    var eff = effectsText(pick(player, 'effects'));
    return (flags.length === 0 ? '无' : flags.join('/')) + (eff === '无' ? '' : ' · buff ' + eff);
  }

  function sideLineText(label, player) {
    return label + '：位置 ' + num(pick(player, 'fromX')) + '→' + num(pick(player, 'toX'))
      + ' 朝向 ' + (pick(player, 'facing') === -1 ? '-1（向左）' : (pick(player, 'facing') === 1 ? '+1（向右）' : '—'))
      + ' · hp ' + num(pick(player, 'hp')) + '/' + num(pick(player, 'maxHp'))
      + ' · mp ' + num(pick(player, 'mp')) + '/' + num(pick(player, 'maxMp'))
      + ' · sp ' + num(pick(player, 'sp')) + '/' + num(pick(player, 'maxSp'))
      + ' · atk ' + num(pick(player, 'atk')) + ' · def ' + num(pick(player, 'def'))
      + ' · 行动 ' + actionText(pick(player, 'action'))
      + ' · 状态 ' + stateTextOf(player);
  }

  function baseLineText(base) {
    return 'hp ' + num(pick(base, 'hp')) + '/' + num(pick(base, 'maxHp')) + '（def ' + num(pick(base, 'def')) + '）';
  }

  function bulletLineText(bullet) {
    var outcome = str(pick(bullet, 'outcome'));
    var tail = '';
    if (outcome === 'hit') tail = '命中 ' + or(pick(bullet, 'hitTarget'), '?');
    else if (outcome === 'collide') {
      tail = '对撞 ' + or(pick(bullet, 'collideWith'), '?')
        + (str(pick(bullet, 'collideWinner')) === null ? '' : '（胜者 ' + str(pick(bullet, 'collideWinner')) + '）');
    } else if (outcome === 'expire') tail = '消散';
    else tail = or(outcome, '未知结局');
    if (pick(bullet, 'collided') === true) tail += '·已对撞';
    if (pick(bullet, 'expired') === true && outcome !== 'expire') tail += '·已消散';
    return '弹幕 ' + or(pick(bullet, 'uid'), '?') + '（' + or(pick(bullet, 'owner'), '?') + '，'
      + or(pick(bullet, 'btype'), '?') + '，dir ' + dirText(pick(bullet, 'dir'))
      + '，v ' + num(pick(bullet, 'v')) + '，长 ' + num(pick(bullet, 'len'))
      + '，等级 ' + num(pick(bullet, 'level')) + '）'
      + num(pick(bullet, 'spawnX')) + '→' + num(pick(bullet, 'endX')) + ' ' + tail
      + (pick(bullet, 'falloffFactor') === undefined || pick(bullet, 'falloffFactor') === null
        ? '' : '（衰减 ' + num(pick(bullet, 'falloffFactor')) + '）');
  }

  function damageLineText(damage) {
    return '伤害：' + or(pick(damage, 'target'), '?') + ' -' + num(pick(damage, 'amount'))
      + ' @' + num(pick(damage, 'atX')) + '（' + or(pick(damage, 'kind'), '?')
      + '，来源 ' + or(pick(damage, 'attacker'), '?') + '/' + or(pick(damage, 'srcUid'), '?') + '）'
      + (pick(damage, 'crit') === true ? ' 暴击×' + num(pick(damage, 'critM')) : '')
      + (pick(damage, 'backstab') === true ? ' 背击×' + num(pick(damage, 'backM')) : '')
      + (pick(damage, 'dodged') === true ? '（被闪避）' : '');
  }

  // 单帧 → 文字行数组（只读；末帧才有 verdict）
  function frameLines(frame, index, total) {
    if (frame === null || frame === undefined || typeof frame !== 'object') {
      return ['第 ' + String(index + 1) + '/' + String(total) + ' 帧：数据缺失'];
    }
    var diff = pick(frame, 'diff');
    var out = ['第 ' + String(index + 1) + '/' + String(total) + ' 帧（tick ' + num(pick(frame, 'tick')) + '）'];
    var players = pick(diff, 'players');
    out.push(sideLineText('我方 p1', pick(players, 'p1')));
    out.push(sideLineText('对手 p2', pick(players, 'p2')));
    var bases = pick(diff, 'bases');
    out.push('基地：p1 ' + baseLineText(pick(bases, 'p1')) + ' · p2 ' + baseLineText(pick(bases, 'p2')));
    arrayOf(pick(diff, 'bullets')).forEach(function (b) { out.push(bulletLineText(b)); });
    var collision = pick(diff, 'collision');
    if (collision !== null && collision !== undefined) {
      out.push('碰撞：接触点 ' + num(pick(collision, 'contactX')) + '（t=' + num(pick(collision, 't')) + '）');
    }
    arrayOf(pick(diff, 'baseHits')).forEach(function (hit) {
      out.push('撞基地：' + or(pick(hit, 'owner'), '?') + ' 被 ' + or(pick(hit, 'by'), '?')
        + ' 撞 @' + num(pick(hit, 'atX')));
    });
    arrayOf(pick(diff, 'bulletHits')).forEach(function (hit) {
      out.push('弹幕命中：' + or(pick(hit, 'uid'), '?') + ' → ' + or(pick(hit, 'target'), '?')
        + ' @' + num(pick(hit, 'atX')));
    });
    arrayOf(pick(diff, 'damages')).forEach(function (d) { out.push(damageLineText(d)); });
    var verdict = pick(diff, 'verdict');
    if (verdict !== null && verdict !== undefined) {
      out.push('判决：' + absoluteWinnerText(pick(verdict, 'winner')) + '（phase=' + or(pick(verdict, 'phase'), '?') + '）');
    }
    return out;
  }

  function traceEntriesOf(frame, owner) {
    var list = arrayOf(pick(pick(frame, 'diff'), 'aiTrace'));
    var out = [];
    for (var i = 0; i < list.length; i++) if (str(pick(list[i], 'owner')) === owner) out.push(list[i]);
    return out;
  }

  function traceEntryText(entry) {
    var path = or(pick(entry, 'path'), '?');
    var result = str(pick(entry, 'result'));
    var depth = numOr(pick(entry, 'depth'), 1);
    var pad = '';
    for (var i = 1; i < depth && i < 8; i++) pad += '· ';
    return pad + '#' + num(pick(entry, 'seq')) + ' ' + or(pick(entry, 'owner'), '?') + ' ' + path
      + ' ' + or(pick(entry, 'nodeType'), '?') + (result === null ? '' : ' → ' + result);
  }

  function traceSummaryText(frame, owner) {
    var label = owner === 'p2' ? '对手(防守方)' : '我方(进攻方)';
    var list = frame === null || frame === undefined ? [] : traceEntriesOf(frame, owner);
    if (list.length === 0) return label + ' AI 本帧轨迹：' + QUICK_NO_TRACE_TEXT;
    return label + ' AI 本帧轨迹（' + String(list.length) + ' 条）：'
      + list.map(traceEntryText).join(' ｜ ');
  }

  // 帧数组与游标（查看器唯一数据源 = state.viewer）
  function viewerFrames(state) {
    return state && state.viewer ? arrayOf(state.viewer.frames) : [];
  }

  function viewerSource(state) {
    return state && state.viewer ? str(state.viewer.source) : null;
  }

  function viewerBattleId(state) {
    return state && state.viewer ? str(state.viewer.battleId) : null;
  }

  // F6-1（审查）：**本屏是否拥有当前查看器里的帧**。
  //   共享 `state.viewer` 是 F6/F7 的刻意设计（04 §2 反驳 2），代价是跨屏残留 ——
  //   若不加门控，快速对战屏会把锦标赛里"看这一场"的帧当作"本场"渲染（实测：同屏 `共 2 tick` + `第 1/3 帧`）。
  //   判据 = 数据源 + 对局 id 属于本屏。
  function quickViewerActive(state, env) {
    var src = viewerSource(state);
    if (src !== 'quick' && src !== 'replay') return false;
    var mine = str(pick(env, 'data.battleId'));
    return mine !== null && viewerBattleId(state) === mine;
  }

  function tournamentViewerActive(state, env) {
    if (viewerSource(state) !== 'tournament') return false;
    var id = viewerBattleId(state);
    if (id === null) return false;
    return resultsOf(env).some(function (result) {
      return str(pick(result, 'battleId')) === id;
    });
  }

  // 当前**屏**拥有的帧（AI 逻辑查看器的"本帧"必须用它 —— 弹窗由两屏共用，取错了就会把别屏的帧标成"本帧执行"）
  function activeViewerFrames(state) {
    var view = state ? state.view : null;
    if (view === 'quick') {
      var q = state.quick ? state.quick.envelope : null;
      return q !== null && isOk(q) && quickViewerActive(state, q) ? viewerFrames(state) : [];
    }
    if (view === 'tournament') {
      var t = state.tournament ? state.tournament.envelope : null;
      return t !== null && isOk(t) && tournamentViewerActive(state, t) ? viewerFrames(state) : [];
    }
    return [];
  }

  function viewerIndex(state, total) {
    if (total <= 0) return 0;
    var raw = state && state.viewer ? numOr(state.viewer.index, 0) : 0;
    if (raw < 0) return 0;
    return raw > total - 1 ? total - 1 : raw;
  }

  function quickResultText(env) {
    return '对手 ' + or(pick(env, 'data.opponent.nickname'), '（无昵称）')
      + '（' + or(pick(env, 'data.opponent.publicId'), '未知账号')
      + '，段位 ' + or(pick(env, 'data.opponent.tier'), '?')
      + '，' + (pick(env, 'data.opponent.isBot') === true ? 'bot' : '玩家') + '）'
      + ' · 结果 ' + battleWinnerText(pick(env, 'data.winner'))
      + ' · 积分 ' + num(pick(env, 'data.self.pointsBefore')) + '→' + num(pick(env, 'data.self.pointsAfter'))
      + '（' + signedText(pick(env, 'data.self.delta')) + '）'
      + ' · 胜率预测 ' + percentText(pick(env, 'data.self.winProbability'))
      + ' · 共 ' + num(pick(env, 'data.ticks')) + ' tick';
  }

  function quickPoolText(env) {
    return '抽池窗口 ' + num(pick(env, 'data.window'))
      + ' · 对手冷却权重 ' + num(pick(env, 'data.opponentWeight'))
      + ' · 回满小时 ' + num(pick(env, 'data.recoveryHours'))
      + ' · 零和 ' + yesNo(pick(env, 'data.zeroSum'), '是', '否')
      + ' · 本次为重复对局 ' + yesNo(pick(env, 'data.duplicate'), '是', '否');
  }

  function quickOpponentPointsText(env) {
    return '对手积分 ' + num(pick(env, 'data.opponent.pointsBefore')) + '→'
      + num(pick(env, 'data.opponent.pointsAfter'))
      + '（' + signedText(pick(env, 'data.opponent.delta')) + '）'
      + ' · 对局 id ' + or(pick(env, 'data.battleId'), '—')
      + '（回放 id ' + or(pick(env, 'data.replayId'), '—') + '）';
  }

  /* ---------- F6：AI 逻辑查看器（程序树 + 本帧执行标记） ---------- */

  function indentOf(depth) {
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';
    return pad;
  }

  // 表达式 → 文字（只覆盖 16 类节点里的表达式类；未知类型原样打印类型名）
  //   `literal` 的取值可能缺失（历史/迁移遗留）→ 显式打 `?`，**不泄漏 undefined/null**（审查 F6-12）
  function literalText(value) {
    if (value === undefined) return '?';
    try {
      var text = JSON.stringify(value);
      return typeof text === 'string' ? text : '?';
    } catch (e) {
      return '?';
    }
  }

  function exprText(node) {
    if (node === null || node === undefined || typeof node !== 'object') return '?';
    var type = str(pick(node, 'type'));
    if (type === 'literal') return literalText(pick(node, 'value'));
    if (type === 'get') return or(pick(node, 'path'), '?');
    if (type === 'getVar') return or(pick(node, 'name'), '?');
    if (type === 'arith' || type === 'cmp' || type === 'logic') {
      return '(' + exprText(pick(node, 'left')) + ' ' + or(pick(node, 'op'), '?') + ' '
        + exprText(pick(node, 'right')) + ')';
    }
    if (type === 'random') return 'random(' + exprText(pick(node, 'prob')) + ')';
    if (type === 'call') return or(pick(node, 'name'), '?') + '()';
    return or(type, '未知节点');
  }

  // 语句节点 → 缩进文本行（`path` 与帧里 aiTrace[].path 同一语法；分支标题行 path=null 永不标记）
  function walkProgramNode(node, path, depth, out) {
    if (out.length > 200) return;
    if (depth > AI_MAX_DEPTH) {
      out.push({ path: null, text: indentOf(depth) + '…（超出显示深度）' });
      return;
    }
    if (node === null || node === undefined || typeof node !== 'object') {
      out.push({ path: null, text: indentOf(depth) + '(空)' });
      return;
    }
    var type = str(pick(node, 'type'));
    if (type === 'seq') {
      var statements = arrayOf(pick(node, 'statements'));
      if (statements.length === 0) out.push({ path: null, text: indentOf(depth) + '(空语句块)' });
      for (var i = 0; i < statements.length; i++) {
        walkProgramNode(statements[i], path + '.s[' + i + ']', depth, out);
      }
      return;
    }
    if (type === 'if') {
      out.push({ path: path, text: indentOf(depth) + 'if ' + exprText(pick(node, 'cond')) });
      out.push({ path: null, text: indentOf(depth) + '  then:' });
      walkProgramNode(pick(node, 'then'), path + '.then', depth + 2, out);
      var other = pick(node, 'else');
      if (other !== null && other !== undefined) {
        out.push({ path: null, text: indentOf(depth) + '  else:' });
        walkProgramNode(other, path + '.else', depth + 2, out);
      }
      return;
    }
    if (type === 'random') {
      out.push({ path: path, text: indentOf(depth) + 'random ' + exprText(pick(node, 'prob')) });
      out.push({ path: null, text: indentOf(depth) + '  then:' });
      walkProgramNode(pick(node, 'then'), path + '.then', depth + 2, out);
      var rElse = pick(node, 'else');
      if (rElse !== null && rElse !== undefined) {
        out.push({ path: null, text: indentOf(depth) + '  else:' });
        walkProgramNode(rElse, path + '.else', depth + 2, out);
      }
      return;
    }
    if (type === 'loop') {
      var kind = str(pick(node, 'kind'));
      out.push({
        path: path,
        text: indentOf(depth) + (kind === 'count'
          ? 'loop count ×' + exprText(pick(node, 'times'))
          : 'loop while ' + exprText(pick(node, 'cond'))),
      });
      walkProgramNode(pick(node, 'body'), path + '.body', depth + 1, out);
      return;
    }
    if (type === 'function') {
      out.push({ path: path, text: indentOf(depth) + 'function ' + or(pick(node, 'name'), '?') + ':' });
      walkProgramNode(pick(node, 'body'), path + '.body', depth + 1, out);
      return;
    }
    if (type === 'action') {
      out.push({ path: path, text: indentOf(depth) + 'action ' + or(pick(node, 'name'), '?') });
      return;
    }
    if (type === 'call') {
      out.push({ path: path, text: indentOf(depth) + 'call ' + or(pick(node, 'name'), '?') + '()' });
      return;
    }
    if (type === 'var') {
      out.push({ path: path, text: indentOf(depth) + 'var ' + or(pick(node, 'name'), '?') + ' = ' + exprText(pick(node, 'value')) });
      return;
    }
    if (type === 'set') {
      out.push({ path: path, text: indentOf(depth) + 'set ' + or(pick(node, 'name'), '?') + ' = ' + exprText(pick(node, 'value')) });
      return;
    }
    if (type === 'break') {
      out.push({ path: path, text: indentOf(depth) + 'break' });
      return;
    }
    // 兜底：类型名原样打印（**不隐藏**未知节点，便于发现契约漂移）
    out.push({ path: path, text: indentOf(depth) + or(type, '未知节点') });
  }

  function programLines(program) {
    var out = [];
    if (program === null || program === undefined || typeof program !== 'object') return out;
    walkProgramNode(pick(program, 'body'), 'body', 0, out);
    return out;
  }

  // 本帧执行过的节点加标记；**每行都带稳定路径**（与帧里 aiTrace[].path 同一语法）——
  //   这是"树节点 ↔ 轨迹条目"可对照的唯一手段（04 §3.3 第 2 条；审查 F6-4 修）
  function markedProgramLines(program, executed) {
    return programLines(program).map(function (line) {
      var text = line.path === null ? line.text : line.text + '  ' + line.path;
      if (line.path !== null && executed[line.path] === true) return text + '  ← 本帧执行';
      return text;
    });
  }

  function viewerConfigsEnvelope(state) {
    return state && state.viewer ? state.viewer.configs : null;
  }

  function viewerAiEnvelope(state) {
    return state && state.viewer ? state.viewer.ai : null;
  }

  function activeSlotOf(env) {
    var slots = arrayOf(pick(env, 'data.slots'));
    var activeId = str(pick(env, 'data.activeSlotId'));
    for (var i = 0; i < slots.length; i++) {
      if (str(pick(slots[i], 'slotId')) === activeId) return slots[i];
    }
    return slots.length > 0 ? slots[0] : null;
  }

  function aiNameOf(state, loadout) {
    var aiId = loadout === null || loadout === undefined ? null : str(pick(loadout, 'aiId'));
    var items = arrayOf(pick(viewerAiEnvelope(state), 'data.items'));
    for (var i = 0; i < items.length; i++) {
      if (str(pick(items[i], 'aiId')) === aiId) return or(pick(items[i], 'name'), aiId);
    }
    return aiId === null ? '（未登记 aiId）' : aiId;
  }

  function executedPathsOf(frame, owner) {
    var out = {};
    traceEntriesOf(frame, owner).forEach(function (entry) {
      var path = str(pick(entry, 'path'));
      if (path !== null) out[path] = true;
    });
    return out;
  }

  // AI 逻辑查看器弹窗（04 §3.3）：我方程序树（带本帧执行标记 + 稳定路径）+ 双方轨迹（对手只有轨迹）
  function aiLogicLines(state) {
    var out = [];
    var env = viewerConfigsEnvelope(state);
    // F6-1：本弹窗的"本帧"同样必须取自**本屏拥有的**帧（否则会把别屏的帧标成"本帧执行"）
    var frames = activeViewerFrames(state);
    var idx = viewerIndex(state, frames.length);
    var frame = frames.length > 0 ? frames[idx] : null;
    var mine = frame === null ? [] : traceEntriesOf(frame, 'p1');
    var theirs = frame === null ? [] : traceEntriesOf(frame, 'p2');
    if (env === null || !isOk(env)) {
      out.push(AI_LOGIC_NO_CONFIGS);
    } else {
      var slot = activeSlotOf(env);
      var loadout = slot === null ? null : pick(slot, 'loadout');
      var program = loadout === null || loadout === undefined ? null : pick(loadout, 'ai');
      var hasAi = program !== null && program !== undefined && typeof program === 'object';
      // 审查 F6-11：无槽/loadout 缺失时**只写一次** `（该配置没有 AI）`，不再重复第二行
      if (loadout === null || loadout === undefined) out.push('我方 AI：' + AI_LOGIC_NO_AI);
      else out.push('我方 AI：' + aiNameOf(state, loadout));
      if (loadout !== null && loadout !== undefined && !hasAi) out.push(AI_LOGIC_NO_AI);
      if (hasAi) {
        out.push('出战槽：' + or(slot === null ? null : pick(slot, 'slotId'), '?')
          + '　本帧：' + (frames.length === 0
            ? '无帧（本屏暂无可查看的对局）'
            : '第 ' + String(idx + 1) + '/' + String(frames.length) + ' 帧'));
        out.push('程序（行尾为稳定路径；`← 本帧执行` = 该节点本帧被求值）：');
        out = out.concat(markedProgramLines(program, executedPathsOf(frame, 'p1')));
      }
    }
    out.push('本帧执行轨迹（我方 ' + String(mine.length) + ' 条 / 对手 ' + String(theirs.length) + ' 条）：');
    if (mine.length + theirs.length === 0) out.push(QUICK_NO_TRACE_TEXT);
    else mine.concat(theirs).forEach(function (entry) { out.push(traceEntryText(entry)); });
    out.push(AI_LOGIC_TRACE_NOTE);
    return out;
  }

  // 动作层需要的"取载荷 + 成功文案"投影（动作层不读响应字段：UI-9；故一律经这里）
  function quickFrames(env) {
    var frames = pick(env, 'data.frames');
    return Array.isArray(frames) ? frames : null;
  }

  function quickBattleId(env) {
    var id = str(pick(env, 'data.battleId'));
    return id === null ? str(pick(env, 'data.replayId')) : id;
  }

  function quickOkText(env) {
    return '快速对战完成：' + battleWinnerText(pick(env, 'data.winner'))
      + '（积分 ' + signedText(pick(env, 'data.self.delta')) + '）';
  }

  function replayFrames(env) {
    var frames = pick(env, 'data.frames');
    return Array.isArray(frames) ? frames : null;
  }

  function replayOkText(env) {
    var frames = replayFrames(env);
    return REPLAY_OK_TEXT + ' ' + or(pick(env, 'data.id'), '?') + '：'
      + String(frames === null ? 0 : frames.length) + ' 帧（'
      + absoluteWinnerText(pick(env, 'data.winner')) + '，phase=' + or(pick(env, 'data.phase'), '?')
      + '，共 ' + num(pick(env, 'data.ticks')) + ' tick）';
  }

  function quickViewModel(state, notice, busy) {
    var env = state.quick ? state.quick.envelope : null;
    var loaded = env !== null && isOk(env);
    // F6-1/F6-2（审查修正）：可见的帧**必须**属于本屏这一场 —— 数据源为 quick/replay 且 battleId 与本屏对局一致。
    //   否则（例如刚在锦标赛屏点过「看这一场」）共享查看器里装的是别场的帧。
    var active = loaded && quickViewerActive(state, env);
    var envBattleId = loaded ? str(pick(env, 'data.battleId')) : null;
    var frames = active ? viewerFrames(state) : [];
    var total = frames.length;
    var idx = viewerIndex(state, total);
    var lines = [];
    if (!loaded) {
      lines.push(QUICK_IDLE_TEXT);
    } else {
      lines.push(quickPoolText(env));
      lines.push(quickOpponentPointsText(env));
      if (total === 0) {
        if (envBattleId === null) lines.push(QUICK_NO_ID_TEXT);
        else lines.push(active ? QUICK_NO_FRAMES_TEXT : QUICK_OTHER_BATTLE_TEXT);
      } else {
        lines = lines.concat(frameLines(frames[idx], idx, total));
        lines.push(traceSummaryText(frames[idx], state.viewer ? state.viewer.traceOwner : 'p1'));
      }
    }
    var noFrames = total === 0;
    var buttons = [
      { action: 'quick-run', label: '开始快速对战', kind: 'button', disabled: busy },
      { action: 'viewer-first', label: '第一帧', kind: 'button', disabled: busy || noFrames || idx === 0 },
      { action: 'viewer-prev', label: '上一帧', kind: 'button', disabled: busy || noFrames || idx === 0 },
      { action: 'viewer-next', label: '下一帧', kind: 'button', disabled: busy || noFrames || idx >= total - 1 },
      { action: 'viewer-last', label: '最后一帧', kind: 'button', disabled: busy || noFrames || idx >= total - 1 },
      { action: 'viewer-trace-p1', label: '看我方(进攻方)轨迹', kind: 'button', disabled: busy || noFrames },
      { action: 'viewer-trace-p2', label: '看对手(防守方)轨迹', kind: 'button', disabled: busy || noFrames },
      { action: 'viewer-ai-logic', label: 'AI 逻辑查看器', kind: 'button', disabled: busy },
    ];
    // 「读取本场回放」**仅当本屏已有对局、但本场没有可显示的帧**时出现（审查 F6-2）：
    //   修前它只看 viewer.battleId ⇒ 本屏没跑过对局时也会渲染，点成功却"屏幕无任何变化"。
    if (loaded && noFrames && envBattleId !== null) {
      buttons.push({ action: 'viewer-load-replay', label: '读取本场回放', kind: 'button', disabled: busy });
    }
    buttons.push({ action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy });
    return vm('快速对战', {
      notice: notice,
      hint: '由服务端抽对手并内联完整战斗过程（D-167）；帧里 p1=我方(进攻方)、p2=对手(防守方)；'
        + '玩家 AI 一律按 p1 坐标系书写，守方位由服务端镜像（D-164）',
      result: loaded ? { kind: 'info', text: quickResultText(env) } : null,
      lines: lines,
      buttons: buttons,
      modal: modalViewModel(state, busy),
    });
  }

  /* ---------- F7：锦标赛 + 排行榜（05 §3/§5） ----------
   * 布局与 F6 同构：结果区 = 批次汇总、lines = 批次/缺口/分页行 + 当前查看的帧、
   * rows = 本页场次（每行一个「看这一场」按钮）或榜单行。战斗查看器**复用 F6 的 state.viewer 与投影**。
   */

  var TOURNAMENT_PAGE_SIZE = 5;
  // 五段位（与 server/store/index-file.js 的 TIERS、store.BOARD_TIERS 同序；05 §3.2 的范围按钮）
  var BOARD_TIERS = Object.freeze(['common', 'rare', 'epic', 'legendary', 'mythic']);
  var TOURNAMENT_NO_BATCH_TEXT = '（尚未发起锦标赛：点「开始锦标赛」）';
  var TOURNAMENT_EMPTY_TEXT = '（本批没有可用的对局）';
  var BOARD_EMPTY_TEXT = '（本榜暂无玩家）';
  var BOARD_SELF_NONE_TEXT = '我：不在本榜内（未登录或未上榜）';
  var BOARD_OK_TEXT = '榜单已刷新';
  var BATTLE_LOADED_TEXT = '已载入本场战斗';
  var NO_BATTLE_ID_TEXT = '该场无效（对手快照不可用，无对局 id 可读回放）';
  var BOARD_POINTS_LABEL = '积分榜';
  var BOARD_TIER_LABEL = '段位榜';
  var BOARD_ALL_LABEL = '全部';

  function rankedNoticeText(env) { return pvpNoticeText(env); }
  function boardNoticeText(env) { return pvpNoticeText(env); }
  var quickNoticeText = pvpNoticeText;

  function resultsOf(env) { return arrayOf(pick(env, 'data.results')); }

  // 本批场数 / 页数 / 当前页（页码在投影里夹取，脏状态打不崩）
  function tournamentPager(state) {
    var env = state.tournament ? state.tournament.envelope : null;
    var total = env !== null && isOk(env) ? resultsOf(env).length : 0;
    var pages = total === 0 ? 1 : Math.ceil(total / TOURNAMENT_PAGE_SIZE);
    var raw = state.tournament ? numOr(state.tournament.page, 0) : 0;
    var page = raw < 0 ? 0 : (raw > pages - 1 ? pages - 1 : raw);
    return { total: total, pages: pages, page: page, size: TOURNAMENT_PAGE_SIZE };
  }

  function rankedResultText(env) {
    var promoted = pick(env, 'data.promoted') === true;
    return '本批 ' + num(pick(env, 'data.matches')) + '/' + num(pick(env, 'data.requested')) + ' 场'
      + '（缺口 ' + num(pick(env, 'data.shortfall')) + '）'
      + ' · 胜 ' + num(pick(env, 'data.wins')) + ' / 平 ' + num(pick(env, 'data.draws'))
      + ' / 负 ' + num(pick(env, 'data.losses')) + ' / 无效 ' + num(pick(env, 'data.invalids'))
      + ' · 段位 ' + or(pick(env, 'data.tier'), '?') + ' → ' + or(pick(env, 'data.tierAfter'), '?')
      + '（晋升 ' + yesNo(promoted, '是', '否') + '）'
      + ' · 奖励品质 ' + or(pick(env, 'data.reward'), '?');
  }

  function rankedBatchText(env) {
    return '批次 ' + or(pick(env, 'data.batchId'), '?')
      + ' · 冷却回满 ' + num(pick(env, 'data.recoveryHours')) + ' 小时';
  }

  // 缺口行（05 §8 T-2）：池不足**不是**失败，但必须如实说明"缺场批次不判晋升"（server/ranked.js:749）
  function rankedShortfallText(env) {
    var shortfall = numOr(pick(env, 'data.shortfall'), 0);
    if (shortfall <= 0) return null;
    return '池内候选不足：本批少打 ' + String(shortfall) + ' 场（D-152 禁止 bot 充数；缺场批次不判晋升）';
  }

  function rankedResultLine(result) {
    var battleId = str(pick(result, 'battleId'));
    var frames = pick(result, 'frames');
    var tail = battleId === null ? '对局 （无）' : '对局 ' + battleId;
    if (battleId !== null && !Array.isArray(frames)) tail += '（本场无内联帧：点「看这一场」读回放）';
    if (pick(result, 'duplicate') === true) tail += ' · 重复场次（该对局此前已记录）';
    return '第 ' + num(pick(result, 'match')) + ' 场 · 对手 ' + or(pick(result, 'opponentPublicId'), '?')
      + ' · 结果 ' + battleWinnerText(pick(result, 'winner'))
      + ' · ' + num(pick(result, 'ticks')) + ' tick · ' + tail;
  }

  function tournamentViewModel(state, notice, busy) {
    var env = state.tournament ? state.tournament.envelope : null;
    var loaded = env !== null && isOk(env);
    var pager = tournamentPager(state);
    var lines = [];
    var rows = [];
    if (!loaded) {
      lines.push(TOURNAMENT_NO_BATCH_TEXT);
    } else {
      lines.push(rankedBatchText(env));
      var missing = rankedShortfallText(env);
      if (missing !== null) lines.push(missing);
      lines.push('第 ' + String(pager.page + 1) + '/' + String(pager.pages) + ' 页（每页 '
        + String(pager.size) + '，共 ' + String(pager.total) + ' 场）');
      if (pager.total === 0) lines.push(TOURNAMENT_EMPTY_TEXT);
      var results = resultsOf(env);
      var start = pager.page * pager.size;
      var pageRows = results.slice(start, start + pager.size);
      rows = pageRows.map(function (result, i) {
        var idx = start + i;
        var battleId = str(pick(result, 'battleId'));
        var ok = battleId !== null;
        return {
          text: rankedResultLine(result) + (ok ? '' : ' · ' + NO_BATTLE_ID_TEXT),
          buttons: [{
            action: 'tournament-open-battle', label: '看这一场', kind: 'button',
            disabled: busy || !ok, idx: String(idx),
          }],
        };
      });
      // 查看区：与 F6 共用同一份 state.viewer 与同一套投影；**只显示属于本批的场次**（F6-1 同口径）
      var frames = tournamentViewerActive(state, env) ? viewerFrames(state) : [];
      if (frames.length > 0) {
        var fi = viewerIndex(state, frames.length);
        lines = lines.concat(frameLines(frames[fi], fi, frames.length));
        lines.push(traceSummaryText(frames[fi], state.viewer ? state.viewer.traceOwner : 'p1'));
      } else if (viewerFrames(state).length > 0) {
        lines.push('（当前查看器里是别处的战斗：点上面某场的「看这一场」载入本批的帧）');
      }
    }
    var noFrames = !tournamentViewerActive(state, env) || viewerFrames(state).length === 0;
    var viewerId = viewerBattleId(state);
    var ownsViewerId = loaded && viewerId !== null && resultsOf(env).some(function (r) {
      return str(pick(r, 'battleId')) === viewerId;
    });
    var buttons = [
      { action: 'tournament-run', label: '开始锦标赛', kind: 'button', disabled: busy },
      { action: 'tournament-page-prev', label: '上一页', kind: 'button', disabled: busy || pager.page <= 0 },
      { action: 'tournament-page-next', label: '下一页', kind: 'button', disabled: busy || pager.page >= pager.pages - 1 },
      { action: 'viewer-first', label: '第一帧', kind: 'button', disabled: busy || noFrames },
      { action: 'viewer-prev', label: '上一帧', kind: 'button', disabled: busy || noFrames },
      { action: 'viewer-next', label: '下一帧', kind: 'button', disabled: busy || noFrames },
      { action: 'viewer-last', label: '最后一帧', kind: 'button', disabled: busy || noFrames },
      { action: 'viewer-trace-p1', label: '看我方(进攻方)轨迹', kind: 'button', disabled: busy || noFrames },
      { action: 'viewer-trace-p2', label: '看对手(防守方)轨迹', kind: 'button', disabled: busy || noFrames },
      { action: 'viewer-ai-logic', label: 'AI 逻辑查看器', kind: 'button', disabled: busy },
    ];
    if (noFrames && ownsViewerId) {
      buttons.push({ action: 'viewer-load-replay', label: '读取本场回放', kind: 'button', disabled: busy });
    }
    buttons.push({ action: 'goto-leaderboard', label: '看段位榜', kind: 'button', disabled: busy });
    buttons.push({ action: 'board-points', label: '看积分榜', kind: 'button', disabled: busy });
    buttons.push({ action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy });
    return vm('锦标赛（= 排位赛）', {
      notice: notice,
      hint: '服务端抽池，每批至多 10 场；池不足如实回报缺口（D-152 禁止 bot 充数）；已内联的帧可直接逐场查看',
      result: loaded ? { kind: 'info', text: rankedResultText(env) } : null,
      lines: lines,
      rows: rows,
      buttons: buttons,
      modal: modalViewModel(state, busy),
    });
  }

  /* ---------- F7：排行榜 ---------- */

  function boardRows(env) {
    return arrayOf(pick(env, 'data.rows')).map(function (row) {
      return {
        rank: num(pick(row, 'rank')),
        publicId: or(pick(row, 'publicId'), '未知账号'),
        nickname: or(pick(row, 'nickname'), '（无昵称）'),
        points: num(pick(row, 'points')),
        tier: or(pick(row, 'tier'), '?'),
        tierUpdatedAt: pick(row, 'tierUpdatedAt'),
      };
    });
  }

  function boardSelfOf(env) {
    var self = pick(env, 'data.self');
    if (self === null || self === undefined || typeof self !== 'object') return null;
    return {
      rank: num(pick(self, 'rank')),
      publicId: or(pick(self, 'publicId'), '未知账号'),
      nickname: or(pick(self, 'nickname'), '（无昵称）'),
      points: num(pick(self, 'points')),
      tier: or(pick(self, 'tier'), '?'),
      tierUpdatedAt: pick(self, 'tierUpdatedAt'),
    };
  }

  function boardScopeLabel(scope) {
    var s = str(scope);
    if (s === null || s === 'global') return BOARD_ALL_LABEL;
    var idx = s.indexOf('tier:');
    return idx === 0 ? s.slice(5) : s;
  }

  function boardHeadText(env) {
    var order = str(pick(env, 'data.order'));
    var offset = numOr(pick(env, 'data.offset'), 0);
    var limit = numOr(pick(env, 'data.limit'), 0);
    var total = numOr(pick(env, 'data.total'), 0);
    var pages = limit > 0 && total > 0 ? Math.ceil(total / limit) : 1;
    var page = limit > 0 ? Math.floor(offset / limit) + 1 : 1;
    return (order === 'arrival' ? BOARD_TIER_LABEL : BOARD_POINTS_LABEL)
      + ' · 范围 ' + boardScopeLabel(pick(env, 'data.scope'))
      + ' · 第 ' + String(page) + '/' + String(pages) + ' 页 · 共 ' + String(total) + ' 人';
  }

  function boardSelfText(env) {
    var self = boardSelfOf(env);
    if (self === null) return BOARD_SELF_NONE_TEXT;
    return '我：第 ' + self.rank + ' 名（' + self.publicId + '，' + self.points + ' 分，段位 ' + self.tier + '）';
  }

  function boardLineText(row, env) {
    var order = str(pick(env, 'data.order'));
    return '第 ' + row.rank + ' 名 · ' + row.nickname + '（' + row.publicId + '）· ' + row.points
      + ' 分 · 段位 ' + row.tier
      + (order === 'arrival' ? ' · 到达 ' + stamp(row.tierUpdatedAt) : '');
  }

  function leaderboardViewModel(state, notice, busy) {
    var env = state.board ? state.board.envelope : null;
    var loaded = env !== null && isOk(env);
    var lines = [];
    var rows = [];
    var offset = state.board ? state.board.offset : 0;
    var hasMore = false;
    if (!loaded) {
      lines.push('（尚未读取榜单：点「积分榜」或「段位榜」）');
    } else {
      lines.push(boardHeadText(env));
      lines.push(boardSelfText(env));
      hasMore = pick(env, 'data.hasMore') === true;
      var list = boardRows(env);
      if (list.length === 0) lines.push(BOARD_EMPTY_TEXT);
      rows = list.map(function (row) {
        return { text: boardLineText(row, env), buttons: [] };
      });
    }
    var scope = state.board ? state.board.scope : 'global';
    var scopeButtons = [{ action: 'board-scope', label: BOARD_ALL_LABEL, kind: 'button', disabled: busy || scope === 'global', tier: 'global' }];
    BOARD_TIERS.forEach(function (tier) {
      scopeButtons.push({
        action: 'board-scope', label: tier, kind: 'button',
        disabled: busy || scope === 'tier:' + tier, tier: tier,
      });
    });
    var buttons = [
      { action: 'board-points', label: BOARD_POINTS_LABEL, kind: 'button', disabled: busy },
      { action: 'board-tier', label: BOARD_TIER_LABEL, kind: 'button', disabled: busy },
    ].concat(scopeButtons).concat([
      { action: 'board-prev', label: '上一页', kind: 'button', disabled: busy || offset <= 0 },
      { action: 'board-next', label: '下一页', kind: 'button', disabled: busy || !hasMore },
      { action: 'board-refresh', label: '刷新', kind: 'button', disabled: busy },
      { action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy },
    ]);
    return vm('排行榜', {
      notice: notice,
      hint: '积分榜 = 逐分排名；段位榜 = 段位高→低、同段位按到达时间（先到者在前）；带登录态时显示本人名次',
      lines: lines,
      rows: rows,
      buttons: buttons,
      modal: modalViewModel(state, busy),
    });
  }

  // 动作层用的"取载荷 + 文案"投影（动作层不读响应字段：UI-9）
  function rankedResultAt(env, index) {
    var list = resultsOf(env);
    return index >= 0 && index < list.length ? list[index] : null;
  }

  function rankedFramesOf(env, index) {
    var result = rankedResultAt(env, index);
    var frames = result === null ? null : pick(result, 'frames');
    return Array.isArray(frames) ? frames : null;
  }

  function rankedBattleIdOf(env, index) {
    var result = rankedResultAt(env, index);
    return result === null ? null : str(pick(result, 'battleId'));
  }

  function rankedOkText(env) {
    return '锦标赛完成：' + num(pick(env, 'data.matches')) + ' 场（胜 ' + num(pick(env, 'data.wins'))
      + ' / 平 ' + num(pick(env, 'data.draws')) + ' / 负 ' + num(pick(env, 'data.losses')) + '）'
      + ' · 段位 ' + or(pick(env, 'data.tierAfter'), '?')
      + (pick(env, 'data.promoted') === true ? '（已晋升）' : '');
  }

  function battleLoadedText(index, frames) {
    return BATTLE_LOADED_TEXT + '：第 ' + String(index + 1) + ' 场（'
      + String(Array.isArray(frames) ? frames.length : 0) + ' 帧）';
  }

  function boardHasMore(env) { return pick(env, 'data.hasMore') === true; }

  // 榜单全量人数（动作层用它夹取 offset；审查 F7-D）。缺失/非法 → -1（表示"未知，不要夹取"）
  function boardTotal(env) {
    var total = pick(env, 'data.total');
    return typeof total === 'number' && isFinite(total) && total >= 0 ? total : -1;
  }

  // 榜单请求的查询串（**只由状态/参数推导**，不读响应字段）
  function boardQuery(board, scope, offset, limit) {
    return 'order=' + (board === 'arrival' ? 'arrival' : 'points')
      + '&scope=' + encodeURIComponent(scope === undefined || scope === null || scope === '' ? 'global' : String(scope))
      + '&offset=' + String(offset < 0 ? 0 : offset)
      + '&limit=' + String(limit);
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
    // F6：AI 逻辑查看器（只读；04 §3.3）
    if (modal.kind === 'ai-logic') {
      return {
        title: 'AI 逻辑查看器',
        hint: '只读：程序树 + 本帧执行轨迹（不提供编辑；AI 编辑见后续批次 F5）',
        lines: aiLogicLines(state),
        buttons: [closeButton(busy)],
      };
    }
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
        // D-170：改账号（段位/积分）——验收与运维用；只改当前值，不动历史峰值
        { name: 'adminPatchPublicId', label: '改账号目标 publicId', type: 'text', value: state.admin.patch.publicId },
        { name: 'adminPatchTier', label: '目标段位（留空=不改；common/rare/epic/legendary/mythic）', type: 'text', value: state.admin.patch.tier },
        { name: 'adminPatchPoints', label: '目标积分（留空=不改；0~3000）', type: 'text', value: state.admin.patch.points },
      ],
      buttons: [
        { action: 'admin-refresh-accounts', label: '刷新账号列表', kind: 'button', disabled: busy },
        { action: 'admin-stats', label: '服务统计', kind: 'button', disabled: busy },
        { action: 'admin-rebuild-index', label: '重建索引', kind: 'button', disabled: busy },
        { action: 'admin-bots', label: '注入调试 bot', kind: 'button', disabled: busy },
        { action: 'admin-clear-bots', label: '清除调试 bot', kind: 'button', disabled: busy },
        { action: 'admin-ban-row', label: '封禁目标', kind: 'button', disabled: busy },
        { action: 'admin-account-patch', label: '改账号（段位/积分）', kind: 'button', disabled: busy },
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
    if (state.view === 'quick') return quickViewModel(state, notice, busy);   // F6（04 分册）
    if (state.view === 'tournament') return tournamentViewModel(state, notice, busy);   // F7（05 分册）
    if (state.view === 'leaderboard') return leaderboardViewModel(state, notice, busy); // F7（05 分册）
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
    patchText: patchText,
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
    // F6：快速对战 + 战斗查看器 + AI 逻辑查看器（04 §3/§5；QB-1…QB-10 的断言对象）
    battleWinnerText: battleWinnerText,
    absoluteWinnerText: absoluteWinnerText,
    quickNoticeText: quickNoticeText,
    rankedNoticeText: rankedNoticeText,
    boardNoticeText: boardNoticeText,
    // F7：锦标赛 + 排行榜（05 §3/§5；TB-1…TB-10 的断言对象）
    rankedResultText: rankedResultText,
    rankedBatchText: rankedBatchText,
    rankedShortfallText: rankedShortfallText,
    rankedResultLine: rankedResultLine,
    rankedResultAt: rankedResultAt,
    rankedFramesOf: rankedFramesOf,
    rankedBattleIdOf: rankedBattleIdOf,
    rankedOkText: rankedOkText,
    resultsOf: resultsOf,
    tournamentPager: tournamentPager,
    tournamentViewModel: tournamentViewModel,
    battleLoadedText: battleLoadedText,
    boardRows: boardRows,
    boardSelfOf: boardSelfOf,
    boardScopeLabel: boardScopeLabel,
    boardHeadText: boardHeadText,
    boardSelfText: boardSelfText,
    boardLineText: boardLineText,
    boardQuery: boardQuery,
    boardHasMore: boardHasMore,
    boardTotal: boardTotal,
    quickViewerActive: quickViewerActive,
    tournamentViewerActive: tournamentViewerActive,
    activeViewerFrames: activeViewerFrames,
    viewerSource: viewerSource,
    viewerBattleId: viewerBattleId,
    QUICK_OTHER_BATTLE_TEXT: QUICK_OTHER_BATTLE_TEXT,
    leaderboardViewModel: leaderboardViewModel,
    BOARD_OK_TEXT: BOARD_OK_TEXT,
    BOARD_EMPTY_TEXT: BOARD_EMPTY_TEXT,
    BOARD_SELF_NONE_TEXT: BOARD_SELF_NONE_TEXT,
    BOARD_TIERS: BOARD_TIERS,
    TOURNAMENT_PAGE_SIZE: TOURNAMENT_PAGE_SIZE,
    TOURNAMENT_NO_BATCH_TEXT: TOURNAMENT_NO_BATCH_TEXT,
    TOURNAMENT_EMPTY_TEXT: TOURNAMENT_EMPTY_TEXT,
    NO_BATTLE_ID_TEXT: NO_BATTLE_ID_TEXT,
    quickResultText: quickResultText,
    quickPoolText: quickPoolText,
    quickOpponentPointsText: quickOpponentPointsText,
    frameLines: frameLines,
    traceEntriesOf: traceEntriesOf,
    traceEntryText: traceEntryText,
    traceSummaryText: traceSummaryText,
    viewerFrames: viewerFrames,
    viewerIndex: viewerIndex,
    programLines: programLines,
    markedProgramLines: markedProgramLines,
    aiLogicLines: aiLogicLines,
    activeSlotOf: activeSlotOf,
    aiNameOf: aiNameOf,
    executedPathsOf: executedPathsOf,
    AI_NODE_TYPES: AI_NODE_TYPES,
    AI_MAX_DEPTH: AI_MAX_DEPTH,
    AI_LOGIC_TRACE_NOTE: AI_LOGIC_TRACE_NOTE,
    AI_LOGIC_OK_TEXT: AI_LOGIC_OK_TEXT,
    AI_LOGIC_NAME_FAIL_TEXT: AI_LOGIC_NAME_FAIL_TEXT,
    quickFrames: quickFrames,
    quickBattleId: quickBattleId,
    quickOkText: quickOkText,
    replayFrames: replayFrames,
    replayOkText: replayOkText,
    QUICK_IDLE_TEXT: QUICK_IDLE_TEXT,
    QUICK_NO_FRAMES_TEXT: QUICK_NO_FRAMES_TEXT,
    QUICK_NO_TRACE_TEXT: QUICK_NO_TRACE_TEXT,
    REPLAY_OK_TEXT: REPLAY_OK_TEXT,
    modalViewModel: modalViewModel,
    viewModel: viewModel,
  };
});
