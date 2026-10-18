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
 *
 * F5/D-172 新增投影：
 *   · AI 编辑器两态（列表 / 编辑）视图模型：程序树行（带**编辑器地址**）、当前节点表单、
 *     表达式槽与语句块行、校验结果与逐条错误定位、草稿标记、被引用提示（06-ai-editor.md §3）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ai-editor.js'), require('./ai-blueprint.js'));
  else { root.DL = root.DL || {}; root.DL.format = factory(root.DL.aiEditor, root.DL.aiBlueprint); }
})(typeof self !== 'undefined' ? self : this, function (aiEd, aiBlueprint) {
  'use strict';

  var PAGE_TITLE = 'Debug-Lite v3 · 账号';

  // F3/F8：仓库五桶的**显示名**（03 §3.3；容量行与开包结果都用它）
  //   F8/D-176：新增 `package`（包）；D-178：新增 `aiNode`（AI 积木节点，可堆叠）
  var BUCKET_LABELS = Object.freeze({ role: '角色', skill: '技能', rolePlugin: '角色插件', skillPlugin: '技能插件', package: '包', aiNode: 'AI节点' });
  var BUCKET_ORDER = Object.freeze(['role', 'skill', 'rolePlugin', 'skillPlugin', 'package', 'aiNode']);
  // 每桶上限缺省值（正常一律以响应的 data.caps 为准；缺失时才回落，避免整屏崩）
  var CAP_FALLBACK = 500;
  // F3：空页的标题与计划批次（03 §3.6；FR-12）
  //   F6 起 `quick` 已是真屏；F7 起 `tournament`/`leaderboard` 已是真屏；
  //   **F5 起 `ai-editor` 已是真屏 → 本表为空**（四个空页全部落地，FR-12 的占位页不再存在）
  var EMPTY_PAGES = Object.freeze({});
  // 提交③（出战配置编辑器）的文案常量见下方 §3.7 段（CONFIG_ACTIVE_HINT / CONFIG_DRAFT_HINT …）
  var ITEM_GONE_TEXT = '（仓库中已找不到该物品，可能已被清理：点「刷新」重新读取）';
  var NO_DATA_TEXT = '（尚未读取到档案数据）';
  var CLOSE_LABEL = '关闭';

  // D-179：渲染兜底（**渲染自身抛异常**时的最后一道界面）。背景（用户实测）：
  //   public/index.html 漏载某个运行时模块时，任意一屏的 viewModel 抛异常 → app.js 的 mount 中断
  //   → 之前置位的 `busy` 永不复位 → **全屏按钮变灰、点任何键都无声**（刷新才恢复）。
  //   故：viewModel 失败不再向外抛，而是投影成本屏（纯常量，不读 state → 自身不可能再失败）。
  var FATAL_TITLE = '界面内部错误';
  var FATAL_PREFIX = '这一屏渲染失败了：';
  var FATAL_HINT = '界面已回退到可操作状态，**其他功能不受影响**（可点下方按钮回到主界面）。'
    + '请把下面这行的内容反馈给开发者。';
  var FATAL_BACK_LABEL = '返回主界面';
  var FATAL_LOGOUT_LABEL = '退出登录';

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
  // F3：仓库刷新与开包成功的可见文案（03 §4 表格「成功可见文本」）
  var WAREHOUSE_OK_TEXT = '仓库已刷新';
  // F8/D-177：开包成功文案（原「开箱完成」——开箱屏已退役，改为在仓库屏开「包」）
  var PACKAGE_OK_TEXT = '开包完成：物品已入仓库';

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

  // F8/D-176：包种类 → 中文显示名（与 server/data/package-config.json 的 `packages[].name` 同口径）
  var PACKAGE_KIND_LABELS = Object.freeze({
    role: '角色模块包', skill: '技能模块包', rolePlugin: '角色插件包', skillPlugin: '技能插件包', aiNode: 'AI节点包',
  });
  function packageKindLabel(kind) {
    return PACKAGE_KIND_LABELS[kind] === undefined ? '未知包' : PACKAGE_KIND_LABELS[kind];
  }

  // 响应里某一桶的物品数组（**按桶名分派到不同的 pick 字面量** —— 契约要求路径为字面量）
  function bucketItems(env, bucket) {
    if (bucket === 'skill') return arrayOf(pick(env, 'data.buckets.skill'));
    if (bucket === 'rolePlugin') return arrayOf(pick(env, 'data.buckets.rolePlugin'));
    if (bucket === 'skillPlugin') return arrayOf(pick(env, 'data.buckets.skillPlugin'));
    if (bucket === 'package') return arrayOf(pick(env, 'data.buckets.package'));
    if (bucket === 'aiNode') return arrayOf(pick(env, 'data.buckets.aiNode')); // D-178 第 6 桶
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
  //   F8/D-176：包显示为 `<名字>（<品质>·<质量>%）`（如「角色模块包（绿·15%）」）——包不被任何配置引用，
  //   故不叠 `usage` 标记。
  function itemLabel(env, item) {
    var name = or(pick(item, 'name'), '（未命名物品）');
    if (str(pick(item, 'kind')) === 'package') {
      return name + '（' + or(pick(item, 'quality'), '未知品质') + '·' + num(pick(item, 'qualityPercent')) + '%）';
    }
    var mark = usageText(env, str(pick(item, 'uid')));
    return mark === '' ? name : name + ' ' + mark;
  }

  function itemRows(env, bucket, busy) {
    return bucketItems(env, bucket).map(function (item) {
      var uid = str(pick(item, 'uid'));
      // F8/D-176：包桶的行多一个「开包」按钮（`package-open` + `data-uid`）；其余桶只有详情
      var buttons = [];
      if (bucket === 'package') {
        buttons.push({ action: 'package-open', label: '开包', kind: 'button', disabled: busy === true, uid: uid });
      }
      buttons.push({ action: 'item-open', label: itemLabel(env, item), kind: 'button', disabled: busy === true, uid: uid });
      return { text: '', buttons: buttons };
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

  // 专属插件形态（2026-09-28 §6.2）：`forTypes` 绑定技能类型、`exclusive{}` 为声明式覆盖
  //   （推/拉/眩晕/DoT/增益等附加效果与数值全在 `exclusive` 内；通用插件无此字段 → 返回空数组）
  function exclusiveLines(item) {
    var forTypes = arrayOf(pick(item, 'forTypes'));
    if (forTypes.length === 0) return [];
    var ex = pick(item, 'exclusive');
    var keys = ex !== null && typeof ex === 'object' ? Object.keys(ex) : [];
    return ['适用技能类型：' + forTypes.join('/') + (keys.length === 0 ? '' : ' · 专属覆盖：' + keys.join('/'))];
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
      // 展示键（§6.2）：基础模板自带；装上专属插件后被覆盖（帧 action 同步暴露）
      lines.push('动画：' + or(pick(item, 'animKey'), '无') + ' · 音效：' + or(pick(item, 'sfxKey'), '无'));
    } else if (kind === 'package') {
      // F8/D-176：包（模块包）—— 种类决定掉落物类别；品质=段位；质量=该品质 4 档百分比
      var pkgKind = str(pick(item, 'packageKind'));
      lines.push('包种类：' + packageKindLabel(pkgKind));
      lines.push('质量：' + num(pick(item, 'qualityPercent')) + '%');
      lines.push(pkgKind === 'aiNode'
        ? '说明：开包消耗此包，随机掉出 1~3 个 AI 积木节点（品质不高于包品质；同种节点自动堆叠）'
        : '说明：开包消耗此包，随机掉出 1~3 件物品（种类由包种类决定）');
    } else {
      lines.push('插件 id：' + or(pick(item, 'id'), '未知'));
      lines.push('说明：' + or(pick(item, 'desc'), '无'));
      lines.push('目标槽类型：' + or(pick(item, 'slot'), '未知'));
      lines.push('分类：' + or(pick(item, 'category'), '未知') + ' · 等级：' + num(pick(item, 'tier')));
      if (kind === 'rolePlugin') lines.push('点数：' + num(pick(item, 'pointCost')));
      var exclusives = exclusiveLines(item);
      for (var i = 0; i < exclusives.length; i++) lines.push(exclusives[i]);
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
  //   F8/D-176：开箱屏退役 → 指引改为"打快速对战掉包 → 到「包」桶开包"
  var EMPTY_WAREHOUSE_TEXT = '仓库为空：打「快速对战」赢取「包」，再到「包」桶开包';

  /* ---------- F8/D-177：开包（POST /me/warehouse/open-package；**不传也不显示 seed**） ---------- */

  // 逐件行：`<名字>（<分类>·<品质>）`；D-178 起 AI 节点包产出**积木节点条目**（显示为「节点名 ×N」）
  //   注：**不读**响应顶层的 `notice`（历史上的保留包条件字段）——一律按 `data.items` 如实显示。
  function packageResultLines(env) {
    var items = arrayOf(pick(env, 'data.items'));
    var opened = arrayOf(pick(env, 'data.opened'));
    var lines = ['本次开包获得 ' + items.length + ' 件：'];
    for (var i = 0; i < items.length; i += 1) {
      var kind = str(pick(items[i], 'kind'));
      if (kind === 'aiNode') {
        // 节点条目 = 堆叠：{kind:'aiNode', nodeId, quality, count}
        var cnt = pick(items[i], 'count');
        lines.push('AI节点 ' + or(pick(items[i], 'nodeId'), '未知')
          + '·' + or(pick(items[i], 'quality'), '未知')
          + ' ×' + (typeof cnt === 'number' ? cnt : 1));
        continue;
      }
      lines.push(or(pick(items[i], 'name'), '（未命名物品）')
        + '（' + (kind === null ? '未知' : bucketLabel(kind)) + '·' + or(pick(items[i], 'quality'), '未知') + '）');
    }
    if (items.length === 0) lines.push('（本次没有产出物品）');
    // 多包同开（上限 100）时补逐包明细，玩家才知道哪个包给了什么
    if (opened.length > 1) {
      for (var k = 0; k < opened.length; k += 1) {
        lines.push('第 ' + (k + 1) + ' 个包（' + packageKindLabel(str(pick(opened[k], 'packageKind')))
          + '·' + num(pick(opened[k], 'qualityPercent')) + '%）→ ' + num(pick(opened[k], 'count')) + ' 件');
      }
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

  // `仓库已满（<分类> 500/500），请先清理`（03 §6 warehouse_full；F8 起服务开包与开箱两条路径）
  function packageFullNotice(state) {
    var env = state && state.warehouse ? state.warehouse.envelope : null;
    var bucket = fullBucket(state);
    if (bucket === null) return null;
    return '仓库已满（' + bucketLabel(bucket) + ' ' + capOf(env, bucket) + '/' + capOf(env, bucket) + '），请先清理';
  }

  // F8/D-177：开包结果区的尾行提示（物品已入服务端仓库）
  var PACKAGE_STALE_HINT = '物品已直接入服务端仓库：切到对应分桶或点「刷新」可看到新物品';

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
  //   D-172/审查 F5-A：**必须**带上 `status` —— 否则草稿与正式条目在配置弹窗里长得一模一样、
  //   都能点，用户要到"保存配置"时才吃 409（`ai_is_draft`）。带出来后由 `aiPickModal` 标灰并写明原因。
  function aiCandidatesOf(env) {
    return arrayOf(pick(env, 'data.items')).map(function (ai) {
      return {
        aiId: str(pick(ai, 'aiId')),
        name: str(pick(ai, 'name')),
        program: pick(ai, 'program'),
        status: pick(ai, 'status') === 'draft' ? 'draft' : 'ready',
      };
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
      var draftCount = 0;
      for (var i = 0; i < items.length; i += 1) {
        // D-172/审查 F5-A：草稿**标灰 + 写明原因**（点了必然 409 `ai_is_draft`），不留给用户去撞
        var isDraft = items[i].status === 'draft';
        if (isDraft) draftCount += 1;
        rows.push({
          text: '',
          buttons: [{
            action: 'ai-set',
            label: (items[i].name === null ? '（未命名 AI）' : items[i].name) + (isDraft ? '（草稿：校验未通过，不能被出战配置选中）' : ''),
            kind: 'button',
            disabled: busy || isDraft, slot: slotId, aiId: items[i].aiId,
          }],
        });
      }
      if (draftCount > 0) lines.push('其中 ' + String(draftCount) + ' 条是草稿（已标灰）：请到「AI编辑」里让它们通过校验后再选。');
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

  // D-178⑩：**底层轨迹仅管理员可见**。普通玩家看"积木层"（有多少条积木事件、当前跑到哪个积木节点）；
  //   管理员/调试模式才逐条显示底层 AST 路径与节点类型（排障用）。
  function traceSummaryText(frame, owner, isAdmin, traceMap) {
    var label = owner === 'p2' ? '对手(防守方)' : '我方(进攻方)';
    var list = frame === null || frame === undefined ? [] : traceEntriesOf(frame, owner);
    if (list.length === 0) return label + ' AI 本帧轨迹：' + QUICK_NO_TRACE_TEXT;
    if (isAdmin !== true) {
      // 映射优先级：帧自带的 `aiTraceMap[owner]`（服务端投影）> 调用方给的 traceMap（AI 记录，**仅自己那侧**）
      var own = viewerTraceMapOf(frame, owner);
      var map = own !== null && own !== undefined ? own : (owner === 'p1' && traceMap !== undefined ? traceMap : null);
      var mapped = aiBlueprint.projectTrace(list, map);
      if (map === null || mapped.events.length === 0) {
        return label + ' AI 本帧：' + String(list.length) + ' 个执行步骤（底层节点明细仅管理员可见）';
      }
      var cur = mapped.current === null ? '（本帧没有可显示的积木节点）' : ('当前跑到积木节点 ' + mapped.current);
      return label + ' AI 本帧：' + String(mapped.events.length) + ' 个积木步骤 · ' + cur
        + '（底层节点明细仅管理员可见）';
    }
    return label + ' AI 本帧轨迹（底层，' + String(list.length) + ' 条）：'
      + list.map(traceEntryText).join(' ｜ ');
  }

  // D-178：查看器可用的积木高亮映射 —— 取 `state.viewer.ai`（GET /me/ai 信封）里**第一条带 traceMap 的条目**。
  //   为什么能这么取：同一玩家所有 AI 由同一编译器产出、路径语法一致；且**只用于自己那一侧（p1）**，
  //   对手（p2）在非管理员态只报执行步数（避免拿错映射把对手的路径标成自己的积木）。
  function viewerTraceMapFromAiOf(state) {
    var env = state && state.viewer ? state.viewer.ai : null;
    var items = arrayOf(env === null || env === undefined ? null : pick(env, 'data.items'));
    for (var i = 0; i < items.length; i += 1) {
      var m = pick(items[i], 'traceMap');
      if (m !== null && m !== undefined && typeof m === 'object') return m;
    }
    return null;
  }

  // 帧里若带 `aiTraceMap`（服务端投影时附上）就用它做积木层映射；没有则退化为"按路径原样计数"
  function viewerTraceMapOf(frame, owner) {
    var perOwner = pick(pick(frame, 'diff'), 'aiTraceMap');
    if (perOwner === null || perOwner === undefined) return null;
    var m = pick(perOwner, owner);
    return m === null || m === undefined ? null : m;
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

  // F8/D-177：本场掉落的包（`data.drops` **恒在**，无掉落 = `[]`）→ 结算区一行。
  //   逐项只读子对象字段（`packageKind`/`quality`/`qualityPercent`/`name`）。
  function quickDropsText(env) {
    var drops = arrayOf(pick(env, 'data.drops'));
    if (drops.length === 0) return '本场掉落 0 个包';
    var parts = drops.map(function (d) {
      var kind = str(pick(d, 'packageKind'));
      return or(pick(d, 'name'), packageKindLabel(kind))
        + '（' + or(pick(d, 'quality'), '?') + '·' + num(pick(d, 'qualityPercent')) + '%）';
    });
    return '本场掉落 ' + drops.length + ' 个包：' + parts.join(' / ');
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
      lines.push(quickDropsText(env));   // F8/D-177：本场掉落的包（恒在，无掉落 = 0 个）
      lines.push(quickOpponentPointsText(env));
      if (total === 0) {
        if (envBattleId === null) lines.push(QUICK_NO_ID_TEXT);
        else lines.push(active ? QUICK_NO_FRAMES_TEXT : QUICK_OTHER_BATTLE_TEXT);
      } else {
        lines = lines.concat(frameLines(frames[idx], idx, total));
        lines.push(traceSummaryText(frames[idx], state.viewer ? state.viewer.traceOwner : 'p1', state.session ? state.session.isAdmin === true : false, viewerTraceMapFromAiOf(state)));
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
        lines.push(traceSummaryText(frames[fi], state.viewer ? state.viewer.traceOwner : 'p1', state.session ? state.session.isAdmin === true : false, viewerTraceMapFromAiOf(state)));
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

  /* ---------- F10/D-180：战绩 / 防守战绩（`records` 屏；设计依据 05 分册同族的列表口径） ---------- */

  var RECORDS_EMPTY_TEXT = '（没有战绩：打一场快速对战或排位就会出现在这里）';
  var RECORD_RESULT_LABEL = { win: '胜', loss: '负', draw: '平' };
  var RECORD_ROLE_LABEL = { attacker: '进攻', defender: '防守' };
  var RECORD_MODE_LABEL = { quick: '快速', ranked: '排位' };

  function recordsOf(env) {
    var list = pick(env, 'data.records');
    return Array.isArray(list) ? list : [];
  }

  /** 毫秒时间戳 → `MM-DD HH:mm`（本地时区；缺值回落 `—`） */
  function clockText(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—';
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 单条战绩 → 一行文字（`时间 · 对手 · 攻/防 · 胜/负/平 · N tick · 积分 ±d`） */
  function recordLineText(rec) {
    var parts = [clockText(pick(rec, 'at'))];
    parts.push('对手 ' + or(pick(rec, 'opponentPublicId'), '（未知）'));
    var role = str(pick(rec, 'role'));
    parts.push(RECORD_ROLE_LABEL[role] === undefined ? '—' : RECORD_ROLE_LABEL[role]);
    var mode = str(pick(rec, 'mode'));
    parts.push(RECORD_MODE_LABEL[mode] === undefined ? '—' : RECORD_MODE_LABEL[mode]);
    var result = str(pick(rec, 'result'));
    parts.push(RECORD_RESULT_LABEL[result] === undefined ? '无效' : RECORD_RESULT_LABEL[result]);
    parts.push(num(pick(rec, 'ticks')) + ' tick');
    var delta = pick(rec, 'pointsDelta');
    if (typeof delta === 'number' && isFinite(delta)) parts.push('积分 ' + (delta >= 0 ? '+' : '') + String(delta));
    if (pick(rec, 'seen') === false) parts.push('未读');
    var reason = str(pick(rec, 'reason'));
    if (reason !== null) parts.push('（' + reason + '）');
    return parts.join(' · ');
  }

  function recordsHeadText(env) {
    var list = recordsOf(env);
    return '共 ' + num(list.length) + ' 条（本页）'
      + ' · 未读 进攻' + num(pick(env, 'data.unread.attack')) + '/防守' + num(pick(env, 'data.unread.defense'))
      + ' · 全局水位 ' + num(pick(env, 'data.maxSeq'));
  }

  function defenseLineText(env) {
    return '被抽 ' + num(pick(env, 'data.drawnCount')) + ' 场'
      + ' · 胜 ' + num(pick(env, 'data.stats.wins'))
      + ' / 平 ' + num(pick(env, 'data.stats.draws'))
      + ' / 负 ' + num(pick(env, 'data.stats.losses'))
      + ' · 未读 ' + num(pick(env, 'data.unread'));
  }

  function recordsViewModel(state, notice, busy) {
    var rec = state.records ? state.records : { envelope: null, defense: null, role: '', notice: null };
    var env = rec.envelope;
    var loaded = env !== null && isOk(env);
    var lines = [];
    var rows = [];
    // 最近一次操作（推进未读游标）的结果：与屏级 notice 分开显示，避免被切屏清掉时连带丢失
    if (rec.notice !== null) lines.push(rec.notice);
    var defEnv = rec.defense;
    if (defEnv !== null && isOk(defEnv)) lines.push('防守战绩：' + defenseLineText(defEnv));
    else lines.push('防守战绩：（点「刷新」读取）');
    if (!loaded) {
      lines.push('（尚未读取战绩：点「刷新」）');
    } else {
      lines.push(recordsHeadText(env));
      var list = recordsOf(env);
      if (list.length === 0) lines.push(RECORDS_EMPTY_TEXT);
      rows = list.map(function (item) { return { text: recordLineText(item), buttons: [] }; });
    }
    var role = rec.role;
    return vm('对战历史', {
      notice: notice,
      hint: '只读 GET /me/records 与 /me/defense；「标记已读」推进未读游标（游标推进的唯一入口）',
      lines: lines,
      rows: rows,
      buttons: [
        { action: 'records-filter', label: '全部', kind: 'button', disabled: busy || role === '', role: '' },
        { action: 'records-filter', label: '只看进攻', kind: 'button', disabled: busy || role === 'attacker', role: 'attacker' },
        { action: 'records-filter', label: '只看防守', kind: 'button', disabled: busy || role === 'defender', role: 'defender' },
        { action: 'records-seen', label: '标记已读', kind: 'button', disabled: busy },
        { action: 'refresh-records', label: '刷新', kind: 'button', disabled: busy },
        { action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy },
      ],
    });
  }

  // 动作层用的"取载荷 + 文案"投影（动作层不读响应字段：UI-9）
  function recordsOkText(env) {
    return '已推进未读游标：进攻未读 ' + num(pick(env, 'data.unread.attack'))
      + ' / 防守未读 ' + num(pick(env, 'data.unread.defense'));
  }

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

  /* ---------- F5/D-172：AI 编辑器（06-ai-editor.md §3） ---------- */

  var AI_LIST_IDLE_TEXT = '（尚未读取 AI 库：点「刷新」或「新建 AI」）';
  var AI_LIST_HINT_TEXT = '「正式」的 AI 可以被出战配置选中；「草稿」是校验没通过时的暂存，不能被选中。';
  var AI_EMPTY_LIST_TEXT = '（库里还没有 AI，点「新建 AI」开始）';
  var AI_NO_DRAFT_TEXT = '（还没有打开任何 AI：从列表「打开」一条，或点「新建 AI」）';
  var AI_EDIT_HINT_TEXT = '改一下就自动校验一次；校验不通过只能「存为草稿」。程序最外层是引擎自带的 while(true)，不用自己写。';
  var AI_TREE_HEADING = '程序结构（每行的「│ 」表示它属于上一层的括号内；点右侧「选中」编辑该节点）：';
  var AI_TREE_LEGEND = '图例：「那么：/否则：/循环体：」是分支与循环体的开头，其下缩进的就是里面的语句；「← 当前选中」= 你正在编辑的节点。';
  var AI_ROOT_LABEL = 'while(true) 引擎隐式主循环（不可删除）';
  var AI_NAME_LABEL = '名称（1~24 字符）';

  function aiEditorOf(state) { return state.aiEditor ? state.aiEditor : null; }
  function aiItemsOf(env) {
    var items = pick(env, 'data.items');
    return Array.isArray(items) ? items : [];
  }
  function aiCountText(env) {
    if (env === null) return AI_LIST_IDLE_TEXT;
    return 'AI 库：' + num(pick(env, 'data.count')) + '/' + num(pick(env, 'data.max'))
      + '（草稿 ' + num(pick(env, 'data.draftCount')) + ' 条）';
  }
  function aiUsageSlots(env, aiId) {
    var usage = pick(env, 'data.usage');
    if (!usage || typeof usage !== 'object' || typeof aiId !== 'string' || aiId === '') return [];
    var slots = usage[aiId];
    return Array.isArray(slots) ? slots : [];
  }
  function aiUsageText(env, aiId) {
    var slots = aiUsageSlots(env, aiId);
    return slots.length === 0 ? '未被配置引用' : '被配置 ' + slots.join('、') + ' 引用';
  }
  function aiItemStatusText(aiItem) { return pick(aiItem, 'status') === 'draft' ? '草稿' : '正式'; }
  function aiStatusTextOf(status) { return status === 'draft' ? '草稿' : '正式'; }

  function aiValidateEnv(state) {
    var ed = aiEditorOf(state);
    return ed === null ? null : ed.validate;
  }
  function aiValidateOk(state) {
    var env = aiValidateEnv(state);
    return env !== null && isOk(env) && pick(env, 'data.ok') === true;
  }
  function aiValidateErrors(state) {
    var env = aiValidateEnv(state);
    if (env === null || isOk(env)) return [];
    var details = pick(env, 'error.details');
    return Array.isArray(details) ? details : [];
  }
  function aiValidateWarnings(state) {
    var env = aiValidateEnv(state);
    if (env === null || !isOk(env)) return [];
    var w = pick(env, 'data.warnings');
    return Array.isArray(w) ? w : [];
  }
  function aiValidateText(state) {
    var env = aiValidateEnv(state);
    if (env === null) return '校验：修改后会自动校验一次';
    if (isOk(env)) {
      var used = pick(env, 'data.stats.usedNodeTypes');
      return '校验：通过 · 节点 ' + num(pick(env, 'data.stats.nodes'))
        + ' · 深度 ' + num(pick(env, 'data.stats.depth'))
        + ' · 用到 ' + (Array.isArray(used) && used.length > 0 ? used.join('、') : '—')
        + ' · 指纹 ' + or(pick(env, 'data.programHash'), '—');
    }
    return '校验：不通过（' + errorCodeOf(env) + '，' + String(aiValidateErrors(state).length) + ' 处问题）';
  }

  // 校验错误 → 可点击定位的行（addr 由编辑器地址反查；服务端 path 带 .expr/.op 等字段后缀）
  function aiErrorRows(state) {
    var ed = aiEditorOf(state);
    var draft = ed === null ? null : ed.draft;
    var out = [];
    aiValidateErrors(state).forEach(function (d, i) {
      var path = or(pick(d, 'path'), '');
      var addr = aiEd.addrOfRuntimeErrorPath(draft, path);
      out.push({
        index: String(i),
        addr: addr,
        text: '· ' + (path === '' ? '（整程序）' : path) + ' — ' + or(pick(d, 'message'), or(pick(d, 'code'), '校验失败')),
      });
    });
    return out;
  }

  // AI 编辑器输入框的字段名（与 app.js 的 `ai.` 前缀路由一一对应）
  function aiFieldNameOf(addr, key) { return 'ai.' + addr + '.' + key; }

  // 写操作结果文案（POST 新建 / PUT 编辑 / DELETE）
  function aiSaveTarget(env) {
    var aiSaved = pick(env, 'data.ai');
    return {
      aiId: or(pick(env, 'data.aiId'), null),
      name: or(pick(aiSaved, 'name'), ''),
      status: pick(aiSaved, 'status') === 'draft' ? 'draft' : 'ready',
    };
  }
  // 列表里按 aiId 找一条（「打开」用；含 program 正文）
  function aiItemOf(env, aiId) {
    var items = aiItemsOf(env);
    for (var i = 0; i < items.length; i += 1) {
      var aiItem = items[i];
      if (pick(aiItem, 'aiId') === aiId) {
        return {
          aiId: aiId,
          name: or(pick(aiItem, 'name'), ''),
          status: pick(aiItem, 'status') === 'draft' ? 'draft' : 'ready',
          program: pick(aiItem, 'program'),
          // D-178：积木蓝图（编辑器据此回填积木视图）+ 槽位数
          blueprint: pick(aiItem, 'blueprint'),
          slotCount: pick(aiItem, 'slotCount'),
        };
      }
    }
    return null;
  }
  function aiSavedText(env, isNew) {
    var aiSaved = pick(env, 'data.ai');
    var name = or(pick(aiSaved, 'name'), '（未命名）');
    var status = aiStatusTextOf(pick(aiSaved, 'status'));
    var refs = pick(env, 'data.referencedBy');
    var tail = Array.isArray(refs) && refs.length > 0 ? '；被配置 ' + refs.join('、') + ' 引用（改完需在配置编辑器里重新选一次才生效）' : '';
    return (isNew ? '已新建：' : '已保存：') + name + '（' + status + '）' + tail;
  }
  function aiDeleteOkText(env) {
    var refs = pick(env, 'data.referencedBy');
    var tail = Array.isArray(refs) && refs.length > 0 ? '（曾被配置 ' + refs.join('、') + ' 引用）' : '';
    return '已删除 ' + or(pick(env, 'data.deleted'), '该 AI') + tail;
  }
  // 保存被服务端拒绝时的可读文案（409 ai_in_use / ai_limit / ai_is_draft 等）
  function aiWriteFailText(env) {
    var code = errorCodeOf(env);
    if (code === 'ai_in_use') return '这个 AI 正被出战配置引用：请先在配置编辑器里换掉它，再存为草稿。';
    // 审查 F5-B：**不写死 100** —— 上限来自 `service-config.ai.maxPerPlayer`（可配），
    //   同屏列表头用的也是响应里的真实 `data.max`；此处直接引用服务端 message（它带真实上限）。
    if (code === 'ai_limit') return '先删掉不用的 AI 再保存：' + or(pick(env, 'error.message'), 'AI 库已满');
    if (code === 'ai_is_draft') return '草稿 AI 不能被出战配置引用：请先编辑并让它通过校验。';
    if (code === 'ai_invalid') return 'AI 程序不合法：' + noticeText(env) + '（也可以先「存为草稿」）';
    if (code === 'store_not_found') return '这条 AI 已经不在了：请刷新列表。';
    return noticeText(env);
  }

  // D-178：节点目录 / 限额 / 预设模板（GET /me/ai/nodes 信封 → 供积木编辑器注入模型）
  function aiNodesCatalogOf(env) { return env === null ? null : pick(env, 'data.catalog'); }
  function aiNodesLimitsOf(env) { return env === null ? null : pick(env, 'data.limits'); }
  function aiNodesPresetsOf(env) { return arrayOf(env === null ? null : pick(env, 'data.presets')); }

  // D-178：积木节点库存摘要（GET /me/ai/nodes 信封）——AI 库屏给一句"我有多少积木可用"。
  //   全部由 `data.inventory` 推出（不读 `data.counts`：该路径名与别处的"不读取"登记冲突）。
  function aiNodeStockText(env) {
    if (env === null) return '积木节点：点「刷新」后显示（开 AI 节点包可获取更多）';
    var inv = arrayOf(pick(env, 'data.inventory'));
    var kinds = 0;
    var total = 0;
    var used = 0;
    var freeKinds = 0;
    for (var i = 0; i < inv.length; i++) {
      var owned = pick(inv[i], 'owned');
      var use = pick(inv[i], 'used');
      var free = pick(inv[i], 'free');
      if (typeof owned === 'number' && owned > 0) kinds += 1;
      if (typeof owned === 'number') total += owned;
      if (typeof use === 'number') used += use;
      if (typeof free === 'number' && free > 0) freeKinds += 1;
    }
    return '积木节点：已拥有 ' + kinds + ' 种 / 共 ' + total + ' 个 · 占用 ' + used
      + ' 个 · 可用种类 ' + freeKinds + '（开 AI 节点包可获取更多）';
  }

  function aiListViewModel(state, notice, busy) {
    var ed = aiEditorOf(state);
    var env = ed.list;
    var lines = [aiCountText(env), aiNodeStockText(ed.nodes), AI_LIST_HINT_TEXT];
    var items = aiItemsOf(env);
    if (env !== null && items.length === 0) lines.push(AI_EMPTY_LIST_TEXT);
    var rows = items.map(function (aiItem) {
      var aiId = or(pick(aiItem, 'aiId'), '');
      return {
        text: or(pick(aiItem, 'name'), '（未命名）') + ' · ' + aiItemStatusText(aiItem)
          + ' · ' + aiUsageText(env, aiId) + ' · 更新 ' + stamp(pick(aiItem, 'updatedAt')),
        buttons: [
          { action: 'ai-open', label: '打开', kind: 'button', disabled: busy, aiId: aiId },
          { action: 'ai-delete', label: '删除', kind: 'button', disabled: busy, aiId: aiId },
        ],
      };
    });
    var buttons = [
      { action: 'ai-new', label: '新建 AI', kind: 'button', disabled: busy },
      { action: 'ai-refresh', label: '刷新', kind: 'button', disabled: busy },
      { action: 'goto-hub', label: '返回主界面', kind: 'button', disabled: busy },
    ];
    var confirm = null;
    if (ed.confirm && ed.confirm.kind === 'delete') {
      confirm = {
        text: '确认删除这个 AI？删除后无法恢复。',
        buttons: [
          { action: 'ai-confirm-yes', label: '确认删除', kind: 'button', disabled: busy },
          { action: 'ai-confirm-no', label: '取消', kind: 'button', disabled: busy },
        ],
      };
    }
    return vm('AI 编辑', { notice: notice, hint: '查看 / 新建 / 编辑 / 删除你自己的 AI 程序', lines: lines, rows: rows, buttons: buttons, confirm: confirm });
  }

  // 树行前缀（用户实测反馈：U+3000 全角空格在浏览器里几乎看不出层级）——
  //   改用**可见导轨** `│ ` 每层一个，配合「那么：/否则：/循环体：」标签，读起来像 Python 的缩进。
  function aiTreeIndentOf(depth) {
    var out = '';
    for (var i = 0; i < depth; i += 1) out += '│ ';
    return out;
  }

  // F5：AI 编辑器**编辑态**（06 §3.2）。
  //   ⚠️ 这里必须用**有序区块** `blocks`：旧的扁平 vm 会让 render 把"所有文字行"先渲染、"所有行（含程序树）"
  //   后渲染，于是「程序」标题与程序树被拆到屏幕两端、分支标签与节点表单也各归各块 —— 用户实测反馈
  //   "几乎看不出各逻辑之间的关系"。blocks 让"小节标题 → 紧随其后的内容"按声明顺序出现。
  /* ---------- D-178：积木编辑器屏（蓝图草稿；docs/frontend/06-ai-editor.md §16） ---------- */
  //   进入条件：草稿是蓝图（`{type:'blueprint'}`）；旧 AST 程序继续走下面的旧编辑器（过渡期兼容）。
  function aiBlueprintInventoryOf(env) { return arrayOf(env === null ? null : pick(env, 'data.inventory')); }

  // 顶部状态行：槽位用量 + 本次用到的节点种类 + 余量不足的种类数（只提示；判决在服务端）
  function aiBlueprintStockLine(draft, inv) {
    var stats = aiBlueprint.statsOf(draft);
    var shortage = aiBlueprint.shortageOf(draft, inv);
    var kinds = 0;
    var i;
    for (i = 0; i < inv.length; i++) if (pick(inv[i], 'owned') > 0) kinds += 1;
    return '槽位 ' + stats.slots + '/' + aiBlueprint.limits().maxSlots
      + ' · 已拥有 ' + kinds + ' 种节点'
      + (shortage.length > 0 ? ' · ⚠ 其中 ' + shortage.length + ' 种余量不足' : '');
  }

  // 校验回执的 details[]（服务端唯一判据；无回执 → 空数组）
  function aiValidateDetailsOf(state) {
    var ed = aiEditorOf(state);
    if (ed === null || ed.validate === null) return [];
    var env = ed.validate;
    if (!isOk(env)) return arrayOf(pick(env, 'error.details'));
    return [];
  }

  function aiBlueprintViewModel(state, notice, busy) {
    var ed = aiEditorOf(state);
    var draft = ed.draft;
    var cursor = ed.cursor === undefined || ed.cursor === null ? '' : String(ed.cursor);
    var eb = ed.nodes;
    var catalog = aiNodesCatalogOf(eb);
    if (catalog !== null) aiBlueprint.setCatalog(catalog, aiNodesLimitsOf(eb));
    var inv = aiBlueprintInventoryOf(eb);
    // D-179 修复：正在编辑的**既有条目**，其自身占用不该被算作"别人占着"。
    //   服务端 `PUT /me/ai/:aiId` 用 excludeAiId 扣掉该条目自己的旧占用；前端此前不扣 →
    //   打开自己的 AI 就显示「⚠ 节点不足」、节点库里自己用着的节点全是 0 空闲，
    //   玩家会以为保存不了（实际能存），且"再加一个同类节点"被误判为不可用。
    var selfItem = ed.aiId === null ? null : aiItemOf(ed.list, ed.aiId);
    if (selfItem !== null && selfItem.blueprint) inv = aiBlueprint.excludeOwnUsage(inv, selfItem.blueprint);
    var ok = aiValidateOk(state) === true;

    var blocks = [];
    blocks.push({ kind: 'lines', lines: [
      '名称：' + (ed.name === '' ? '（未命名）' : ed.name) + ' · 状态：' + (ed.status === 'draft' ? '草稿' : '正式'),
      ed.aiId === null ? '（新蓝图：保存后才会入库）' : ('库内条目：' + ed.aiId + ' · ' + aiUsageText(ed.list, ed.aiId)),
      aiBlueprintStockLine(draft, inv),
      '模板区：点一下即整套替换当前程序（套用后就是普通蓝图，可随意拆改）',
    ] });
    var presets = aiNodesPresetsOf(eb);
    blocks.push({ kind: 'buttons', buttons: (presets.length > 0 ? presets.map(function (p) {
      return { action: 'ai-bp-preset', label: '套用：' + p.name, kind: 'button', disabled: busy, preset: p.id };
    }) : [{ action: 'ai-bp-new', label: '新建空白蓝图', kind: 'button', disabled: busy }]).concat(
      presets.length > 0 ? [{ action: 'ai-bp-new', label: '清空重来', kind: 'button', disabled: busy }] : []) });

    var groups = aiBlueprint.nodeLibrary(inv);
    for (var gi = 0; gi < groups.length; gi += 1) {
      blocks.push({ kind: 'lines', lines: [groups[gi].category + '（括注 = 空闲/拥有）：'] });
      blocks.push({
        kind: 'buttons',
        buttons: groups[gi].items.map(function (it) {
          return {
            action: 'ai-node-append', kind: 'button', node: it.nodeId,
            label: it.name + '（' + it.qualityLabel + '·' + it.free + '/' + it.owned + '）',
            disabled: busy || it.disabled,
          };
        }),
      });
    }

    blocks.push({ kind: 'lines', lines: ['程序结构（缩进 = 层级；「条件/那么/否则/循环体」是子节点位）：'] });
    var rows = aiBlueprint.treeLines(draft, cursor).map(function (r) {
      if (r.header === true) return { text: aiTreeIndentOf(r.depth) + r.text, buttons: [] };
      return {
        text: aiTreeIndentOf(r.depth) + r.text + (r.selected ? '　← 当前选中' : ''),
        buttons: [
          { action: 'ai-select-node', label: '选中', kind: 'button', disabled: busy, addr: r.addr },
          { action: 'ai-node-up', label: '上移', kind: 'button', disabled: busy || r.depth !== 0, addr: r.addr },
          { action: 'ai-node-down', label: '下移', kind: 'button', disabled: busy || r.depth !== 0, addr: r.addr },
          { action: 'ai-node-del', label: '删除', kind: 'button', disabled: busy, addr: r.addr },
        ],
      };
    });
    blocks.push({ kind: 'rows', rows: rows.length > 0 ? rows : [{ text: '（空蓝图：先套用模板，或点上面的节点加入程序）', buttons: [] }] });

    var form = aiBlueprint.formOf(draft, cursor);
    if (form === null) {
      blocks.push({ kind: 'lines', lines: ['参数区：先在程序结构里点「选中」一个节点'] });
    } else {
      blocks.push({ kind: 'lines', lines: ['参数区 —— ' + form.name + '：' + form.desc] });
      if (form.fields.length === 0) blocks.push({ kind: 'lines', lines: ['（这个节点没有可调参数）'] });
      for (var fi = 0; fi < form.fields.length; fi += 1) {
        blocks.push({ kind: 'buttons', buttons: aiParamButtons(cursor, form.fields[fi], busy) });
      }
    }

    var shortage = aiBlueprint.shortageOf(draft, inv);
    if (shortage.length > 0) {
      blocks.push({ kind: 'lines', lines: ['⚠ 节点不足：' + shortage.map(function (s) { return s.name + '（需 ' + s.need + ' 个 / 空闲 ' + s.free + ' 个）'; }).join('、') + ' —— 可先「存为草稿」，或开 AI 节点包补货'] });
    }
    var details = aiValidateDetailsOf(state);
    if (details.length > 0) {
      blocks.push({ kind: 'lines', lines: ['校验未通过（服务端唯一判据）：'].concat(
        aiBlueprint.errorLines(draft, details).map(function (e) {
          return '· ' + (e.addr === null ? '（全局）' : (e.addr + ' ← ')) + e.message;
        })) });
    } else if (ok) {
      blocks.push({ kind: 'lines', lines: ['校验通过 ✓（服务端已确认，可保存为正式条目）'] });
    } else {
      blocks.push({ kind: 'lines', lines: ['（尚未校验：改动后会自动校验一次）'] });
    }

    // D-179 修复：积木编辑屏此前也不渲染**导入区** —— 点「导入 JSON」只置了状态，屏幕上不出现输入框，
    //   于是"导入"这个功能在积木模式下完全够不着（按钮点了没反应）。此处与旧 AST 编辑屏同形补齐；
    //   应用导入的解析按草稿类型分派（见 actions.js 的 ai-import-apply）。
    if (ed.importOpen) {
      blocks.push({ kind: 'lines', lines: ['导入 JSON：粘贴一份积木蓝图（会替换当前草稿；合法性仍由服务端校验）'] });
      blocks.push({ kind: 'textarea', textarea: { name: 'aiImport', label: '蓝图 JSON', value: ed.importText } });
      blocks.push({
        kind: 'buttons',
        buttons: [
          { action: 'ai-import-apply', label: '应用导入', kind: 'button', disabled: busy },
          { action: 'ai-import-close', label: '取消导入', kind: 'button', disabled: busy },
        ],
      });
    }

    // D-179 修复：积木编辑屏此前**不渲染**「确认丢弃」弹层 —— 而 ai-close 在脏草稿时只会
    //   dispatch `ai.confirm.set {kind:'discard'}`，于是点「返回列表」屏幕上什么都不出现，
    //   玩家以为按钮坏了（有未保存改动就再也退不出编辑器）。此处与旧 AST 编辑屏同形补齐。
    var confirm = null;
    if (ed.confirm && ed.confirm.kind === 'discard') {
      confirm = {
        text: '有未保存改动，确认丢弃并关闭？',
        buttons: [
          { action: 'ai-discard-yes', label: '确认丢弃', kind: 'button', disabled: busy },
          { action: 'ai-discard-no', label: '取消', kind: 'button', disabled: busy },
        ],
      };
    }

    return vm('AI 编辑（积木）', {
      notice: notice,
      hint: '积木编辑器：点节点加入程序 → 在结构里「选中」→ 下方调参数 → 保存（保存前服务端会再校验）',
      blocks: blocks,
      confirm: confirm,
      buttons: [
        { action: 'ai-save', label: '保存', kind: 'button', disabled: busy || !ok },
        { action: 'ai-save-draft', label: '存为草稿', kind: 'button', disabled: busy },
        { action: 'ai-validate', label: '校验', kind: 'button', disabled: busy },
        { action: 'ai-import-open', label: '导入 JSON', kind: 'button', disabled: busy },
        { action: 'ai-close', label: '返回列表', kind: 'button', disabled: busy },
      ],
    });
  }

  // 参数控件：slot/enum → 直选按钮；int/num/pct → 「−/+」步进按钮（避免引入新的输入提交路径）
  function aiParamButtons(addr, f, busy) {
    var out = [];
    var cur = f.value;
    var isChoice = f.kind === 'slot' || f.kind === 'enum';
    if (isChoice) {
      out.push({ action: 'ai-param-set', label: f.label + '：当前 ' + or(String(cur), '未设置') + '（点右侧取值）', kind: 'button', disabled: true, addr: addr, field: f.key, value: cur });
      (f.values || []).forEach(function (o) {
        out.push({
          action: 'ai-param-set', label: f.label + '=' + o, kind: 'button',
          disabled: busy || String(o) === String(cur), addr: addr, field: f.key, value: o,
        });
      });
      return out;
    }
    var step = f.type === 'pct' ? 5 : 1;
    var now = typeof cur === 'number' ? cur : Number(cur);
    if (!isFinite(now)) now = f.min === undefined ? 0 : f.min;
    out.push({ action: 'ai-param-set', label: f.label + '：' + now + '（范围 ' + (f.min === undefined ? '?' : f.min) + '~' + (f.max === undefined ? '?' : f.max) + '）', kind: 'button', disabled: true, addr: addr, field: f.key, value: now });
    out.push({ action: 'ai-param-set', label: '−' + step, kind: 'button', disabled: busy || (f.min !== undefined && now - step < f.min), addr: addr, field: f.key, value: round2num(now - step) });
    out.push({ action: 'ai-param-set', label: '+' + step, kind: 'button', disabled: busy || (f.max !== undefined && now + step > f.max), addr: addr, field: f.key, value: round2num(now + step) });
    return out;
  }
  function round2num(v) { return Math.round(v * 100) / 100; }

  function aiEditViewModel(state, notice, busy) {
    var ed0 = aiEditorOf(state);
    // D-178：蓝图草稿走积木编辑器屏；旧 AST 程序仍走下面的旧编辑器
    if (ed0 !== null && ed0.draft !== null && ed0.draft.type === 'blueprint') return aiBlueprintViewModel(state, notice, busy);
    var ed = aiEditorOf(state);
    var draft = ed.draft;
    var cursor = ed.cursor || 'body';
    var blocks = [];
    var bottom = [];

    if (draft === null) {
      return vm('AI 编辑', {
        notice: notice,
        lines: [AI_NO_DRAFT_TEXT],
        buttons: [
          { action: 'ai-new', label: '新建 AI', kind: 'button', disabled: busy },
          { action: 'ai-close', label: '返回列表', kind: 'button', disabled: busy },
        ],
      });
    }

    // ① 名称（最上方）
    blocks.push({ kind: 'fields', fields: [{ name: 'aiName', label: AI_NAME_LABEL, type: 'text', value: ed.name }] });

    // ② 档案信息
    var head = [];
    head.push('编号：' + (ed.aiId === null ? '（未保存）' : ed.aiId));
    head.push('状态：' + aiStatusTextOf(ed.status) + (ed.dirty ? '（有未保存改动）' : '（已保存）'));
    if (ed.aiId !== null) head.push('引用：' + aiUsageText(ed.list, ed.aiId) + '（改完需在配置编辑器里重新选一次才会生效）');
    head.push(aiValidateText(state));
    aiValidateWarnings(state).forEach(function (w) {
      head.push('· 提示：' + or(pick(w, 'message'), or(pick(w, 'code'), '非阻断提示')));
    });
    var dup = aiEd.duplicateFunctionNames(draft);
    dup.forEach(function (d) {
      head.push('· 函数名重复：' + d.name + '（出现在 ' + d.addrs.join('、') + '）—— 请改名后再保存');
    });
    blocks.push({ kind: 'lines', lines: head });

    // ③ 校验错误（标题 + 逐条，紧跟其后）
    var errs = aiErrorRows(state);
    if (errs.length > 0) {
      blocks.push({ kind: 'lines', lines: ['校验发现 ' + String(errs.length) + ' 处问题（点「定位」跳到该节点）：'] });
      blocks.push({
        kind: 'rows',
        rows: errs.map(function (e) {
          return {
            text: e.text,
            buttons: [{ action: 'ai-select-node', label: '定位', kind: 'button', disabled: busy, addr: e.addr }],
          };
        }),
      });
    }

    // ④ 程序树（标题 + 图例 + 树；缩进用可见导轨）
    //   最外层先画**隐式主循环**（它才是所有语句的容器），其余语句一律缩进在它里面 ——
    //   这样"谁在谁里面"一眼可见（Python 式缩进）。
    blocks.push({ kind: 'lines', lines: [AI_TREE_HEADING, AI_TREE_LEGEND] });
    var treeRows = [{
      text: AI_ROOT_LABEL + (cursor === 'body' ? '　← 当前选中' : ''),
      buttons: [{ action: 'ai-select-node', label: '选中', kind: 'button', disabled: busy, addr: 'body' }],
    }];
    aiEd.treeLines(draft).forEach(function (node) {
      var mark = node.addr === cursor ? '　← 当前选中' : '';
      treeRows.push({
        text: aiTreeIndentOf(node.depth + 1) + node.text + mark,
        buttons: [{ action: 'ai-select-node', label: node.kind === 'block-label' ? '进入' : '选中', kind: 'button', disabled: busy, addr: node.addr }],
      });
    });
    blocks.push({ kind: 'rows', rows: treeRows });

    // ⑤ 当前节点表单（标题 + 说明 + 该节点的字段/选项，全部紧跟标题）
    var form = aiEd.formOf(draft, cursor);
    var formHead = ['—— 当前节点：' + form.typeLabel + '（' + cursor + '）——'];
    form.hints.forEach(function (h) { formHead.push('说明：' + h); });
    if (form.duplicateFunction) formHead.push('⚠️ 这个函数名和别的函数重复了，请改名。');
    blocks.push({ kind: 'lines', lines: formHead });

    var textFields = [];
    form.fields.forEach(function (f) {
      var name = aiFieldNameOf(cursor, f.key);
      var shown = ed.texts && ed.texts[name] !== undefined ? ed.texts[name] : f.value;
      if (f.kind === 'text' || f.kind === 'path' || f.kind === 'literal') {
        textFields.push({ name: name, label: f.label + '（改完点别处生效）', type: 'text', value: shown });
      }
      if (f.kind === 'enum' || f.kind === 'action') {
        blocks.push({ kind: 'lines', lines: [f.label + '：当前 ' + or(f.value, '（未设置）')] });
        blocks.push({
          kind: 'buttons',
          buttons: f.options.map(function (o) {
            return { action: 'ai-set-field', label: o.label, kind: 'button', disabled: busy || o.value === f.value, addr: cursor, field: f.key, value: o.value };
          }),
        });
      }
      if (f.kind === 'literal') {
        blocks.push({
          kind: 'lines',
          lines: ['值类型：' + (f.literalType === 'number' ? '数字' : f.literalType === 'string' ? '文本' : '真/假') + '（改类型会按新类型解释上面的值）'],
        });
        blocks.push({
          kind: 'buttons',
          buttons: f.options.map(function (o) {
            return { action: 'ai-set-literal-type', label: '设为' + o.label, kind: 'button', disabled: busy || o.value === f.literalType, addr: cursor, value: o.value };
          }),
        });
      }
      if (f.kind === 'path') {
        blocks.push({ kind: 'lines', lines: ['可选读取项（服务端白名单；也可在输入框里手写）：'] });
        blocks.push({
          kind: 'buttons',
          buttons: (function () {
            var out = [];
            f.groups.forEach(function (g) {
              g.paths.forEach(function (p) {
                out.push({ action: 'ai-set-field', label: p.label, kind: 'button', disabled: busy || p.value === f.value, addr: cursor, field: f.key, value: p.value });
              });
            });
            return out;
          })(),
        });
      }
    });
    if (textFields.length > 0) blocks.push({ kind: 'fields', fields: textFields });

    // ⑥ 表达式槽 / 语句块（各自带标题）
    if (form.slots.length > 0) {
      blocks.push({ kind: 'lines', lines: ['表达式槽（点「选中」把光标移进该表达式，之后「＋…」就插在它里面）：'] });
      blocks.push({
        kind: 'rows',
        rows: form.slots.map(function (s) {
          return {
            text: '· ' + s.label + '：' + s.summary + (s.present ? '（' + s.typeLabel + '）' : ''),
            buttons: [
              { action: 'ai-select-node', label: '选中', kind: 'button', disabled: busy, addr: s.addr },
              { action: 'ai-slot-clear', label: '清空', kind: 'button', disabled: busy || !s.canDelete, addr: s.addr },
            ],
          };
        }),
      });
    }
    if (form.blocks.length > 0) {
      blocks.push({ kind: 'lines', lines: ['语句块（点「进入」把光标移进该块，之后「＋…」就插在它里面）：'] });
      blocks.push({
        kind: 'rows',
        rows: form.blocks.map(function (b) {
          return {
            text: '· ' + b.label + '：' + (b.present ? String(b.count) + ' 条语句' : '（空）'),
            buttons: [
              { action: 'ai-select-node', label: '进入', kind: 'button', disabled: busy, addr: b.addr },
              { action: 'ai-block-remove', label: '移除', kind: 'button', disabled: busy || !b.canRemove, addr: b.addr },
            ],
          };
        }),
      });
    }

    // ⑦ 结构操作（插入 / 替换 / 上下移 / 包裹 / 删除）
    blocks.push({ kind: 'lines', lines: ['插入（按当前选中位置自动决定：插到语句后面 / 放进语句块 / 填进表达式槽）：'] });
    blocks.push({
      kind: 'buttons',
      buttons: aiEd.NODE_TYPES.map(function (t) {
        return { action: 'ai-insert', label: '＋' + aiEd.NODE_LABELS[t], kind: 'button', disabled: busy, value: t };
      }),
    });
    if (!form.isRoot) {
      blocks.push({ kind: 'lines', lines: ['把当前节点换成（内容会重设为该类型的默认值）：'] });
      blocks.push({
        kind: 'buttons',
        buttons: aiEd.NODE_TYPES.map(function (t) {
          return { action: 'ai-replace', label: '换为' + aiEd.NODE_LABELS[t], kind: 'button', disabled: busy, value: t };
        }),
      });
      blocks.push({
        kind: 'buttons',
        buttons: [
          { action: 'ai-move-up', label: '上移', kind: 'button', disabled: busy },
          { action: 'ai-move-down', label: '下移', kind: 'button', disabled: busy },
          { action: 'ai-wrap-if', label: '包裹进「如果」', kind: 'button', disabled: busy },
          { action: 'ai-delete-node', label: '删除这个节点', kind: 'button', disabled: busy },
        ],
      });
    }

    // ⑧ 导入区（textarea）与其按钮
    if (ed.importOpen) {
      blocks.push({ kind: 'lines', lines: ['导入 JSON：粘贴一段 AI 程序（会替换当前草稿；合法性仍由服务端校验）'] });
      blocks.push({ kind: 'textarea', textarea: { name: 'aiImport', label: '程序 JSON', value: ed.importText } });
      blocks.push({
        kind: 'buttons',
        buttons: [
          { action: 'ai-import-apply', label: '应用导入', kind: 'button', disabled: busy },
          { action: 'ai-import-close', label: '取消导入', kind: 'button', disabled: busy },
        ],
      });
    }

    // ⑨ 底部操作
    var canSave = aiValidateOk(state) && dup.length === 0;
    var saveLabel = ed.status === 'draft' ? '保存（转为正式）' : '保存';
    if (!canSave) {
      bottom.push('保存按钮不可用：' + (dup.length > 0 ? '函数名重复' : aiValidateOk(state) ? '（正常）' : '校验未通过（可先「存为草稿」）'));
    }
    bottom.push('保存 = 把草稿写成「正式」条目（校验必须已通过）；「存为草稿」= 先放着，之后再回来改。');
    blocks.push({ kind: 'lines', lines: bottom });
    blocks.push({
      kind: 'buttons',
      buttons: [
        { action: 'ai-save', label: saveLabel, kind: 'button', disabled: busy || !canSave },
        { action: 'ai-save-draft', label: '存为草稿', kind: 'button', disabled: busy },
        { action: 'ai-save-as', label: '另存为新的 AI', kind: 'button', disabled: busy || !canSave },
        { action: 'ai-validate', label: '重新校验', kind: 'button', disabled: busy },
        { action: 'ai-import-open', label: '导入 JSON', kind: 'button', disabled: busy },
        { action: 'ai-close', label: '关闭编辑', kind: 'button', disabled: busy },
      ],
    });

    var confirm = null;
    if (ed.confirm && ed.confirm.kind === 'discard') {
      confirm = {
        text: '有未保存改动，确认丢弃并关闭？',
        buttons: [
          { action: 'ai-discard-yes', label: '确认丢弃', kind: 'button', disabled: busy },
          { action: 'ai-discard-no', label: '取消', kind: 'button', disabled: busy },
        ],
      };
    }
    return vm(ed.aiId === null ? '新建 AI' : '编辑 AI', {
      notice: notice, hint: AI_EDIT_HINT_TEXT, blocks: blocks, buttons: [],
      confirm: confirm,
    });
  }

  // 列表态 / 编辑态的分派（编辑态的导入按钮已在 blocks 内就地渲染，无需再拼一份）
  /** D-195：AI 库列表的布局版视图模型（列表态） */
  function aiListLayoutVm(state, busy) {
    if (!LAYOUT || !LAYOUT.data.screens.ai_list) return null;
    var ed = aiEditorOf(state);
    var env = ed.list;
    var items = aiItemsOf(env);
    var max = num(pick(env, 'data.max'), 20);
    var stock = aiNodeStockText(ed.nodes);
    var flat = {
      aiListCountText: (env === null ? '（还没读取 AI 库）' : ('我的程序 ' + items.length + ' / ' + max))
        + '　·　' + stock,
      aiListHintText: items.length
        ? '点一行选中它，再用「打开选中 / 删除选中」；「正式」的 AI 才能被出战配置选中'
        : '还没有 AI：点「＋ 新建 AI」开始（新建后点「打开选中」进入积木编辑器）',
    };
    var sstate = { aiListSel: ed.listSel || '' };
    return {
      canvas: LAYOUT.data.canvas,
      background: LAYOUT.data.screens.ai_list.background,
      layers: [{ name: 'ai_list', role: 'screen', mask: null,
                 elements: layScreen(state, 'ai_list', sstate, flat, {}, busy) }],
    };
  }

  function aiEditorViewModel(state, notice, busy) {
    var ed = aiEditorOf(state);
    if (ed === null || ed.mode !== 'edit') {
      // D-195：**列表态也走布局表版**（否则从主界面点「AI 编辑」看到的是文字列表，
      //   用户会以为新屏"没接到按钮上"——这正是本轮实测到的问题）。
      var listLay = aiListLayoutVm(state, busy);
      if (listLay !== null) {
        var listConf = null;
        if (ed.confirm && ed.confirm.kind === 'delete') {
          listConf = {
            text: '确认删除这个 AI？删除后无法恢复。',
            buttons: [
              { action: 'ai-confirm-yes', label: '确认删除', kind: 'button', disabled: busy },
              { action: 'ai-confirm-no', label: '取消', kind: 'button', disabled: busy },
            ],
          };
        }
        return vm('AI 编辑', { notice: notice, layout: listLay, lines: [], buttons: [], confirm: listConf });
      }
      return aiListViewModel(state, notice, busy);
    }
    // D-194/D-195：积木蓝图草稿走**布局表版**编辑器（方案 A）；拿不到布局或仍是旧 AST 程序 → 文字版
    var lay = aiLayoutVm(state, busy);
    if (lay !== null) {
      var conf = null;
      if (ed.confirm && ed.confirm.kind === 'discard') {
        conf = {
          text: '有未保存改动，确认丢弃并关闭？',
          buttons: [
            { action: 'ai-discard-yes', label: '确认丢弃', kind: 'button', disabled: busy },
            { action: 'ai-discard-no', label: '取消', kind: 'button', disabled: busy },
          ],
        };
      }
      return vm('AI 编辑', { notice: notice, layout: lay, lines: [], buttons: [], confirm: conf });
    }
    return aiEditViewModel(state, notice, busy);
  }

  /* ---------- 各屏视图模型 ---------- */

  /* ---------- F9/D-180：布局表驱动的主界面 ----------
   * 分工：**本文件负责投影**（把 /me + /me/configs + /me/warehouse 的信封字段译成扁平数据），
   *   布局引擎（DL.layoutEngine）只做纯布局解算（断点/锚点/占位符替换/多边形），
   *   渲染层（render.js）只把结果变成 DOM。三者都不重复读响应字段（§1.5 投影单一真源）。
   */
  var LAYOUT = null;
  function setLayout(engine, data) {
    LAYOUT = (engine && data && data.screens) ? { engine: engine, data: data } : null;
    // D-194：**必须把布局表声明的状态键注册进引擎**。否则引擎的键表只有默认 3 个，
    //   而 `whenMatches` 只遍历已注册的键 ⇒ 自定义键（aiDetail/aiP1/aiImport…）的 `when`
    //   会被**静默忽略**，变成"写了条件却永远显示"（比不写更难查）。
    if (LAYOUT && typeof engine.setStateKeys === 'function') {
      engine.setStateKeys(data.stateKeys || []);
    }
  }
  function layoutReady() { return LAYOUT !== null; }
  var LAY_TIER_CN = { common: '绿', rare: '蓝', epic: '紫', legendary: '橙', mythic: '青' };
  var LAY_POS = { skill1: 0, skill2: 1, skill3: 2 };
  function layIcon(kind, id) { return id ? ('assets/' + kind + '/' + id + '.webp') : ''; }
  // 插件图标按**族根**命名（数据表里 rp_atk_pct 是族根，rp_atk_pct_c1/_c3 是点数变体，共用一张图）
  function layPluginIconKey(item) {
    var tid = or(layPick(item, 'templateId'), '');
    if (tid !== '') return tid;
    return or(layPick(item, 'id'), '').replace(/_c\d+$/, '');
  }
  function layItem(item) { return item || {}; }
  /** 主界面**显示**哪份配置：0 = 跟随出战（/me 的 activeSlotId）；1..3 = 用户显式切过 */
  function laySlotIndex(state) {
    var explicit = (state.hub && state.hub.slot) || 0;
    if (explicit >= 1) return explicit;
    var active = String(or(layPick(state.profile, 'data.activeSlotId'), 'slot1')).replace(/[^0-9]/g, '');
    return Number(active) || 1;
  }
  function laySlotTypes(item) {
    var sl = arrayOf(pick(item, 'slots'));
    var n = num(pick(item, 'slotCount'), 0);
    if (!(n > 0)) n = sl.length;
    var out = [];
    for (var i = 0; i < n; i++) out.push(or(pick(layItem(sl[i]), 'type'), 'general'));
    return out;
  }
  function layCurrent(state) {
    var slots = arrayOf(layPick(state.configs ? state.configs.data : null, 'data.slots'));
    var slotId = 'slot' + laySlotIndex(state);
    for (var i = 0; i < slots.length; i++) {
      if (or(pick(slots[i], 'slotId'), '') === slotId) return slots[i];
    }
    return null;
  }
  /** 安全投影：信封还没到时（未登录 / 首次进屏）不许抛，一律按"空"处理 */
  function layPick(obj, path) { return (obj === null || obj === undefined) ? undefined : pick(obj, path); }
  function layFlat(state) {
    var me = state.profile, cur = layCurrent(state);
    var lo = layPick(cur, 'loadout') || {};
    var role = layPick(lo, 'role'), skills = arrayOf(layPick(lo, 'skills'));
    var tier = or(layPick(me, 'data.progress.tier'), 'common');
    var battleSlot = String(or(layPick(me, 'data.activeSlotId'), 'slot1')).replace(/[^0-9]/g, '') || '1';
    var idx = laySlotIndex(state);
    function sk(i, f) { return or(layPick(layItem(skills[i]), f), ''); }
    return {
      nickname: or(layPick(me, 'data.nickname'), ''), tier: tier, tierName: LAY_TIER_CN[tier] || tier,
      points: num(layPick(me, 'data.rating.points'), 0),
      wins: num(layPick(me, 'data.rating.wins'), 0), losses: num(layPick(me, 'data.rating.losses'), 0),
      unreadAttack: num(layPick(me, 'data.record.unread.attack'), 0),
      unreadDefense: num(layPick(me, 'data.record.unread.defense'), 0),
      slotName: or(layPick(cur, 'name'), ''), configLabel: '配置' + idx,
      activeSlot: String(idx), configId: 'slot' + idx, battleSlot: battleSlot,
      roleName: or(layPick(role, 'name'), ''),
      roleQuality: LAY_TIER_CN[or(layPick(role, 'quality'), '')] || or(layPick(role, 'quality'), ''),
      roleIcon: layIcon('role', layPick(role, 'templateId')),
      qualityFrame: 'assets/frame/' + or(layPick(role, 'quality'), 'common') + '.svg',
      skill1Name: sk(0, 'name'), skill2Name: sk(1, 'name'), skill3Name: sk(2, 'name'),
      skill1Icon: layIcon('skill', sk(0, 'templateId')), skill2Icon: layIcon('skill', sk(1, 'templateId')),
      skill3Icon: layIcon('skill', sk(2, 'templateId')),
      aiName: or(pick(layItem(pick(lo, 'ai')), 'name'), ''), aiIcon: '',
      tierIcon: 'assets/tier/' + tier + '.svg',
      _role: role, _skills: skills,
    };
  }
  /**
   * D-188：仓库弹窗的**容量行**（`{whCapacity}`）。读 `/me/warehouse` 的 `counts`/`caps`。
   *   形如 `角色 3/500 · 共 37 件`；尚未取到数据时如实写"尚未读取"（不假装有数据）。
   */
  function warehouseCapacityLine(state, bucket) {
    var wh = state.warehouse ? state.warehouse.envelope : null;
    var label = BUCKET_LABELS[bucket] === undefined ? bucket : BUCKET_LABELS[bucket];
    if (wh === null) return label + '：尚未读取仓库（点「关闭」后重开一次）';
    var counts = pick(wh, 'data.counts');
    var caps = pick(wh, 'data.caps');
    var n = counts && typeof counts[bucket] === 'number' ? counts[bucket] : 0;
    var cap = caps && typeof caps[bucket] === 'number' ? caps[bucket] : 0;
    var total = 0;
    if (counts && typeof counts === 'object') {
      Object.keys(counts).forEach(function (k) { if (typeof counts[k] === 'number') total += counts[k]; });
    }
    return label + ' ' + n + '/' + cap + ' · 仓库共 ' + total + ' 件';
  }

  /**
   * D-188：**物品详情**投影（`modal_item_detail` 的 `{detXxx}` 键）。
   *   数据源 = 已读到的 `GET /me/warehouse`（**零新接口**，字段全部来自真实响应）。
   *   用户口径：**全部属性、按类别分组**；包可开包、其他可分解、AI 节点只读。
   *   返回 `{uid,title,sub,icon,lines,canOpen,canDismantle}`；
   *   物品找不到（被分解/换桶）时返回一组**可读的占位**，不当成"空弹窗"。
   */
  function layItemDetail(state) {
    var sel = state.warehouseItem;
    var empty = { uid: '', title: '（没有选中物品）', sub: '', icon: '', lines: ['请从仓库里点一件物品。'], canOpen: false, canDismantle: false };
    if (!sel || typeof sel !== 'object' || !sel.uid) return empty;
    var wh = state.warehouse ? state.warehouse.envelope : null;
    var bucket = sel.bucket || '';
    var list = arrayOf(pick(wh, 'data.buckets.' + bucket));
    var item = null;
    for (var i = 0; i < list.length; i++) { if (or(pick(list[i], 'uid'), '') === sel.uid) { item = list[i]; break; } }
    if (item === null) {
      return {
        uid: sel.uid, title: '（物品不在了）', sub: '它可能已被分解或装箱',
        icon: '', lines: ['仓库里已经没有这件物品。'], canOpen: false, canDismantle: false,
      };
    }
    var lines = [];
    var q = or(pick(item, 'quality'), '');
    var qcn = LAYER_TIER_CN_OR(q);
    var sub = (BUCKET_LABELS[bucket] === undefined ? bucket : BUCKET_LABELS[bucket]) + (q ? ' · ' + qcn + '品' : '');
    var title = or(pick(item, 'name'), '(未命名)');
    var icon = '';
    var canOpen = bucket === 'package';
    // 用户口径：**ai节点和包不可分解，其他都可**
    var canDismantle = bucket !== 'package' && bucket !== 'aiNode';

    if (bucket === 'role') {
      icon = layIcon('role', pick(item, 'templateId'));
      lines.push('【基本信息】');
      lines.push('品质：' + qcn + '　模板：' + or(pick(item, 'templateId'), '未知'));
      lines.push('解锁段位：' + (TIER_CN_OF(or(pick(item, 'unlockTier'), '')) || '未知'));
      lines.push('插槽数：' + String(numOr(pick(item, 'slotCount'), 0)) + '　插件点数：' + String(numOr(pick(item, 'pluginPoints'), 0)));
      var st = pick(item, 'stats') || {};
      lines.push('【五维】');
      lines.push('生命 ' + numOr(pick(st, 'hp'), 0) + '　攻击 ' + numOr(pick(st, 'atk'), 0) + '　防御 ' + numOr(pick(st, 'def'), 0));
      lines.push('技能点 ' + numOr(pick(st, 'sp'), 0) + '　法力 ' + numOr(pick(st, 'mp'), 0));
      var rg = pick(item, 'regen') || {};
      lines.push('【每 tick 回复】技能点 ' + numOr(pick(rg, 'sp'), 0) + '　法力 ' + numOr(pick(rg, 'mp'), 0));
      pushSlotLines(lines, state, item);
    } else if (bucket === 'skill') {
      icon = layIcon('skill', pick(item, 'templateId'));
      var pa = pick(item, 'params') || {};
      lines.push('【基本信息】');
      lines.push('品质：' + qcn + '　模板：' + or(pick(item, 'templateId'), '未知'));
      lines.push('解锁段位：' + (TIER_CN_OF(or(pick(item, 'unlockTier'), '')) || '未知'));
      lines.push('【战斗参数】');
      lines.push('伤害倍率：' + numOr(pick(pa, 'multiplier'), 0));
      lines.push('冷却：' + numOr(pick(pa, 'cooldown'), 0) + ' tick　弹幕等级：' + numOr(pick(pa, 'bulletLevel'), 0) + '（1 最高）');
      var rng = pick(pa, 'range');
      if (Array.isArray(rng)) lines.push('射程：' + numOr(rng[0], 0) + ' ~ ' + numOr(rng[1], 0) + ' 格');
      lines.push('衰减：' + numOr(pick(pa, 'falloff'), 0));
      var cost = pick(pa, 'cost') || {};
      lines.push('【消耗】生命 ' + numOr(pick(cost, 'hp'), 0) + '　法力 ' + numOr(pick(cost, 'mp'), 0) + '　技能点 ' + numOr(pick(cost, 'sp'), 0));
      pushSlotLines(lines, state, item);
      lines.push('【表现】');
      lines.push('动画键：' + or(pick(item, 'animKey'), '—') + '　音效键：' + or(pick(item, 'sfxKey'), '—'));
    } else if (bucket === 'rolePlugin' || bucket === 'skillPlugin') {
      icon = layIcon('plugin', layPluginIconKey(item));
      lines.push('【基本信息】');
      lines.push('类别：' + or(pick(item, 'category'), '—') + '　品质：' + qcn + '　档位：' + String(numOr(pick(item, 'tier'), 0)));
      lines.push('适配槽：' + or(pick(item, 'slot'), '—') + '　装配状态：' + (pick(item, 'equipped') === true ? '已装配' : '未装配'));
      if (bucket === 'rolePlugin') lines.push('点数消耗：' + String(numOr(pick(item, 'pointCost'), 0)));
      lines.push('【词条】');
      var afs = arrayOf(pick(item, 'affixes'));
      if (!afs.length) lines.push('（无词条）');
      afs.forEach(function (a) { lines.push('· ' + or(pick(a, 'desc'), or(pick(a, 'id'), '词条'))); });
      var exc = pick(item, 'exclusive');
      if (exc !== undefined && exc !== null && typeof exc === 'object') {
        lines.push('【专属覆盖】');
        var ft = arrayOf(pick(exc, 'forTypes'));
        if (ft.length) lines.push('适用技能类型：' + ft.join('、'));
        var ovr = pick(exc, 'overrides');
        if (ovr && typeof ovr === 'object') {
          Object.keys(ovr).forEach(function (k) {
            var v = ovr[k];
            lines.push('· ' + k + ' → ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
          });
        }
      }
      var fts = arrayOf(pick(item, 'forTypes'));
      if (fts.length) lines.push('适用技能类型：' + fts.join('、'));
    } else if (bucket === 'package') {
      icon = layIcon('package', or(pick(item, 'packageKind'), ''));
      lines.push('【基本信息】');
      lines.push('包类型：' + or(pick(item, 'packageKind'), '未知') + '　品质：' + qcn);
      lines.push('质量档：' + String(numOr(pick(item, 'qualityPercent'), 0)) + '%');
      lines.push('【说明】');
      lines.push('包只在快速对战中掉落；点下方「开包」使用它（消耗该包并随机获得物品）。');
    } else if (bucket === 'aiNode') {
      icon = layIcon('ai', or(pick(item, 'nodeId'), ''));
      lines.push('【基本信息】');
      lines.push('节点 id：' + or(pick(item, 'nodeId'), '未知') + '　类别：' + or(pick(item, 'category'), '—'));
      lines.push('品质：' + qcn + '　堆叠数量：' + String(numOr(pick(item, 'count'), 1)));
      lines.push('【说明】');
      lines.push('AI 积木节点：在「AI 编辑」里用它们搭逻辑。节点不可分解（它是堆叠条目）。');
    }
    return { uid: sel.uid, title: title, sub: sub, icon: icon, lines: lines, canOpen: canOpen, canDismantle: canDismantle };
  }

  /** 角色/技能共用的「插槽与已装插件」段（D-188；插件名从仓库里现取） */
  function pushSlotLines(lines, state, item) {
    lines.push('【插槽】');
    var slots = arrayOf(pick(item, 'slots'));
    if (!slots.length) { lines.push('（没有插槽）'); return; }
    slots.forEach(function (s, i) {
      var type = or(pick(s, 'type'), '未知');
      var pu = pick(s, 'pluginUid');
      var pname = (pu === undefined || pu === null || pu === '') ? '空' : pluginLabelOf(state, pu);
      lines.push('插槽' + (i + 1) + '［' + type + '］：' + (pname === '' ? '空' : pname));
    });
  }
  function numOr(v, dflt) { return (typeof v === 'number' && isFinite(v)) ? v : dflt; }
  function TIER_CN_OF(t) { return LAY_TIER_CN[t] || null; }
  function LAYER_TIER_CN_OR(q) { return LAY_TIER_CN[q] || q || '未知'; }

  /**
   * D-188：**仓库某个桶 → 网格物品**（供 `gridFrom` 展开）。
   *   与 `layRows` 的分工：那个产出"列表行"（带 `fits`/`reason` 的候选语义，用于装配弹窗）；
   *   这个产出"格子"（带图标 + 品质 + 数量徽标，用于仓库浏览），**不做适配判定**（仓库只是看东西）。
   *   图标规则与 `layRows` 保持一致（插件走 `layPluginIconKey`，其余走 `templateId`）。
   */
  function layBucketItems(state, bucket) {
    var wh = state.warehouse ? state.warehouse.envelope : null;
    var list = arrayOf(pick(wh, 'data.buckets.' + bucket));
    return list.map(function (it) {
      var q = or(pick(it, 'quality'), '');
      var kind = bucket === 'rolePlugin' || bucket === 'skillPlugin' ? 'plugin'
        : (bucket === 'aiNode' ? 'ai' : (bucket === 'package' ? 'package' : bucket));
      var icon;
      if (bucket === 'aiNode') icon = layIcon('ai', or(pick(it, 'nodeId'), ''));
      else if (bucket === 'package') icon = layIcon('package', or(pick(it, 'packageKind'), ''));
      else if (kind === 'plugin') icon = layIcon('plugin', layPluginIconKey(it));
      else icon = layIcon(bucket, pick(it, 'templateId'));
      var rawCount = pick(it, 'count');
      var count = (typeof rawCount === 'number' && isFinite(rawCount) && rawCount > 0) ? Math.floor(rawCount) : 1;
      var name = or(pick(it, 'name'), '(未命名)');
      return {
        uid: or(pick(it, 'uid'), ''), item: it,
        // 格子文字：名字 +（品质）；AI 节点堆叠 >1 时带 ×N
        label: name + (q ? '（' + (LAY_TIER_CN[q] || q) + '）' : '') + (count > 1 ? ' ×' + count : ''),
        icon: icon,
        count: count,
        quality: q,
      };
    });
  }
  /** 后端候选（仓库桶）→ 列表行；按屏幕语义过滤类型 */
  function layRows(state, source, ctx, flat) {
    var wh = state.warehouse ? state.warehouse.envelope : null;
    function wrap(it, i, kind) {
      var q = or(pick(it, 'quality'), '');
      return {
        index: i, uid: or(pick(it, 'uid'), ''), item: it,
        label: or(pick(it, 'name'), '(未命名)') + (q ? '（' + (LAY_TIER_CN[q] || q) + '）' : ''),
        icon: kind === 'plugin' ? layIcon('plugin', layPluginIconKey(it)) : layIcon(kind, pick(it, 'templateId')),
      };
    }
    if (source === 'roles') {
      return arrayOf(pick(wh, 'data.buckets.role')).map(function (it, i) { return wrap(it, i, 'role'); });
    }
    if (source === 'skills') {
      return arrayOf(pick(wh, 'data.buckets.skill')).map(function (it, i) { return wrap(it, i, 'skill'); });
    }
    if (source === 'rolePlugins') {
      // 口径（沿用旧编辑器 B-8「全部列出；不匹配的标灰 + 写原因」）：不在这里过滤，交给渲染标灰
      var types = laySlotTypes(flat._role), want = types[(ctx && ctx.pickIdx) || 0] || null;
      return arrayOf(pick(wh, 'data.buckets.rolePlugin')).map(function (it, i) {
        var row = wrap(it, i, 'plugin');
        row.fits = (want === null) || (or(pick(it, 'slot'), '') === want);
        row.reason = '该插槽是「' + (want === null ? '未知' : want) + '」类型，装不上';
        return row;
      });
    }
    var skill = layItem(flat._skills[LAY_POS[(ctx && ctx.pickPos) || 'skill1']]);
    return arrayOf(pick(wh, 'data.buckets.skillPlugin')).map(function (it, i) {
      var row = wrap(it, i, 'plugin');
      var slot = or(pick(it, 'slot'), '');
      var ft = arrayOf(pick(it, 'forTypes'));
      var tid = or(pick(skill, 'templateId'), ''), ak = or(pick(skill, 'animKey'), '');
      var fits = slot === 'general' || (slot === 'exclusive' && (!ft.length
        || (tid !== '' && ft.indexOf(tid) >= 0)
        || (ak !== '' && (ft.indexOf(ak) >= 0 || ft.some(function (t) { return ak.indexOf(t) >= 0; })))));
      row.fits = fits;
      row.reason = '专属插件，不适用于这个技能';
      return row;
    });
  }
  /** 单屏解算（含插槽按模板 slotCount 展开 / 候选列表按后端数据展开） */
  function layScreen(state, name, sstate, flat, ctx, busy) {
    var C = LAYOUT.engine, bundle = LAYOUT.data;
    var sc = bundle.screens[name];
    if (!sc) return [];
    var out = C.screenAt(bundle, name, 'landscape', sstate, flat);
    // 布局表 → 产品动作（F9）：布局表只描述"这块是什么、点了该去哪"，具体端点由 actions.js 负责。
    //
    // **判据顺序（D-188 定稿，顺序是承重的）**：
    //   ① `target` 指向一个**存在的画面**，**且**当前 `action` 不是"能打开画面"的那一族
    //      → `layout-open`（把目标画面与上下文带给动作）。
    //      为什么要"且"：布局表里 `action` 常常是**设计期遗留值**（如 `config-open`）——
    //      它盖住 `target` 就会造成"指定了 target 却打不开弹窗"；
    //      但 `warehouse-open` 这类**显式接好的**动作本身就会开 `modal_warehouse`，不能改。
    //   ② 否则，`action` 是布局表显式写的非派生动作 → **原样保留**。
    //   ③ 否则 `config-activate` → `layout-activate`（旧编辑器的草稿语义 → 布局路径直打服务端）。
    //
    // ⚠️ 三个方向都踩过真坑（都留了回归断言）：
    //   · 无条件重写 → `btn_warehouse` 的 `warehouse-open` 被改成 `layout-open`（界面没坏、点了走错路）；
    //   · 无条件保留 → 布局表里 `crest_role` 的遗留 `config-open` 盖住了它自己的 `target`，
    //     导致"指定了 target 却打不开弹窗"；
    //   · 只看 target 不看 action → 又回到第一条。
    var DERIVED_ACTIONS = { 'layout-open': 1, 'layout-activate': 1 };
    // 「能打开某个画面」的动作族：这些动作**自带**要开的目标，布局表不应再改写它们。
    var OPENS_SCREEN = {
      'layout-open': 1,      // 布局表的通用开画面动作
      'warehouse-open': 1,   // D-188：打开仓库弹窗（目标就是 modal_warehouse）
    };
    out.forEach(function (e) {
      var opens = OPENS_SCREEN[e.action] === 1;
      // ① `target` 优先 —— **但只对"弹窗"目标**。
      //   `target` 是**设计期注解**，用途是"预览弹窗流程"：标了 target 的按钮在预览里点一下
      //   能看到目标弹窗。整屏（role:'screen'）不是这么打开的 —— 它由真实动作切换视图
      //   （`goto-ai-editor` / `goto-hub` …）。D-195 踩过：给主界面 AI 按钮标上
      //   `target:'ai_list'` 之后，动作被改写成 `layout-open`，于是"点了 AI 编辑没反应"。
      var isScreenTarget = !!(e.target && bundle.screens[e.target] && bundle.screens[e.target].role === 'screen');
      if (!opens && !isScreenTarget && e.target && bundle.screens[e.target]) {
        var pos = (e.payload && e.payload.pos) || 'role';
        var item = pos === 'role' ? flat._role : layItem(flat._skills[LAY_POS[pos] || 0]);
        e.action = 'layout-open';
        e.payload = { screen: e.target, idx: 0, pos: pos, targetUid: or(pick(item, 'uid'), '') };
        return;
      }
      // ② 显式声明的非派生动作 → 原样保留
      if (e.action && e.action !== 'config-activate' && !DERIVED_ACTIONS[e.action]) return;
      // ③ 旧语义兜底
      if (e.action === 'config-activate') e.action = 'layout-activate';
    });
    if (sc.slotsFrom) {
      var item = sc.slotsFrom.kind === 'role' ? flat._role
        : layItem(flat._skills[LAY_POS[sc.slotsFrom.pos] || 0]);
      var types = laySlotTypes(item), count = types.length;
      var protos = out.filter(function (e) { return /^slot_\d+$/.test(e.id); });
      var center = out.filter(function (e) { return e.id === sc.slotsFrom.center; })[0];
      if (center) {
        var c0 = [center.rect[0] + center.rect[2] / 2, center.rect[1] + center.rect[3] / 2];
        protos.sort(function (a, b) {
          return Math.atan2(a.rect[1] + a.rect[3] / 2 - c0[1], a.rect[0] + a.rect[2] / 2 - c0[0])
            - Math.atan2(b.rect[1] + b.rect[3] / 2 - c0[1], b.rect[0] + b.rect[2] / 2 - c0[0]);
        });
      }
      out = out.filter(function (e) { return !/^slot_\d+$/.test(e.id); });
      if (center && protos.length) {
        var r0 = protos[0].rect;
        var radius = Math.hypot(r0[0] + r0[2] / 2 - c0[0], r0[1] + r0[3] / 2 - c0[1]);
        var start = Math.atan2(r0[1] + r0[3] / 2 - c0[1], r0[0] + r0[2] / 2 - c0[0]);
        var itemUid = or(layPick(item, 'uid'), '');
        for (var i = 0; i < count; i++) {
          var installed = layInstalled(state, itemUid, i);
          var rect;
          if (i < protos.length) rect = protos[i].rect.slice();
          else {
            var ang = start + i * 2 * Math.PI / count;
            rect = [c0[0] + radius * Math.cos(ang) - r0[2] / 2, c0[1] + radius * Math.sin(ang) - r0[3] / 2, r0[2], r0[3]];
          }
          out.push({
            id: 'slot_e' + (i + 1), kind: 'button', hit: 'rect', z: 3, rect: rect,
            label: '插槽' + (i + 1) + (installed === '' ? '' : '·' + installed),
            text: '插槽' + (i + 1) + (installed === '' ? '' : '·' + installed),
            action: 'layout-open',
            payload: { screen: sc.slotsFrom.kind === 'role' ? 'modal_role_plugin_pick' : 'modal_skill_plugin_pick',
                       idx: i, pos: sc.slotsFrom.pos, targetUid: or(pick(item, 'uid'), '') },
          });
        }
      }
    }
    if (sc.listFrom) {
      var proto = out.filter(function (e) { return e.id === sc.listFrom.prototype; })[0];
      out = out.filter(function (e) { return e.id !== sc.listFrom.prototype; });
      var rows = layRows(state, sc.listFrom.source, ctx || {}, flat);
      var base = proto ? proto.rect : [880, 208, 340, 56];
      // D-195：**把候选行挂进面板并让它可滚**。以前行是平铺的、面板没有 scroll，
      //   角色/技能/插件候选一多就溢出到弹窗外，滚不动（用户报告的"角色选择列表没滚动"）。
      //   容器 = listFrom.container 指定，否则自动找"把原型完全包住的那块底板"。
      var listBox = sc.listFrom.container
        ? out.filter(function (e) { return e.id === sc.listFrom.container; })[0]
        : out.filter(function (e) {
            if (e.id === sc.listFrom.prototype) return false;
            var r = e.rect || [0, 0, 0, 0];
            return r[0] <= base[0] && r[1] <= base[1]
              && r[0] + r[2] >= base[0] + base[2] && r[1] + r[3] >= base[1] + base[3];
          })[0];
      if (listBox) listBox.scroll = listBox.scroll || { dir: 'v' };
      var relX = listBox ? base[0] - listBox.rect[0] : base[0];
      var relY = listBox ? base[1] - listBox.rect[1] : base[1];
      function pushRow(row) {
        if (listBox) row.parent = listBox.id;
        out.push(row);
      }
      if (!rows.length) {
        pushRow({ id: 'row_empty', kind: 'deco', hit: 'rect', z: 6,
                   rect: [relX, relY, base[2], base[3]],
                   label: '（没有可用候选）', text: '（没有可用候选）' });
      }
      rows.forEach(function (it, i) {
        var isPick = sc.listFrom.source === 'roles' || sc.listFrom.source === 'skills';
        pushRow({
          id: 'row_' + i, kind: 'button', hit: 'rect', z: 6,
          rect: [relX, relY + i * sc.listFrom.pitch, base[2], base[3]],
          label: it.fits === false ? it.label + '（' + it.reason + '）' : it.label,
          text: it.fits === false ? it.label + '（' + it.reason + '）' : it.label,
          asset: it.icon, muted: it.fits === false,
          action: isPick ? 'layout-set-slot' : 'layout-assemble',
          payload: {
            uid: it.uid, pos: (ctx && ctx.pickPos) || 'role',
            slotIndex: (ctx && ctx.pickIdx !== undefined) ? ctx.pickIdx : 0,
            targetUid: (ctx && ctx.targetUid) || or(pick(flat._role, 'uid'), ''),
          },
        });
      });
      // 插件候选屏末尾补一行「清空此槽」（布局表里没有这一行，但"卸下插件"必须有入口）
      if (sc.listFrom.source === 'rolePlugins' || sc.listFrom.source === 'skillPlugins') {
        out.push({
          id: 'row_clear', kind: 'button', hit: 'rect', z: 6,
          parent: listBox ? listBox.id : undefined,
          rect: [relX, relY + rows.length * sc.listFrom.pitch, base[2], base[3]],
          label: '清空此槽', text: '清空此槽', action: 'layout-disassemble',
          payload: { uid: (ctx && ctx.targetUid) || '', slotIndex: (ctx && ctx.pickIdx) || 0 },
        });
      }
      // 内容高：最后一行底部相对面板 → 渲染层据此撑出滚动高度
      if (listBox) {
        var rowCount = rows.length + (sc.listFrom.source === 'rolePlugins' || sc.listFrom.source === 'skillPlugins' ? 1 : 0);
        var contentBottom = relY + Math.max(rowCount, 1) * sc.listFrom.pitch;
        if (contentBottom > listBox.rect[3]) listBox.contentH = contentBottom;
      }
    }
    // D-188：**仓库网格**（`gridFrom`）—— 把当前桶的物品按 `grid.flow` 自动流式排布。
    //   与 `listFrom` 的区别：那个是"一列等距行"（pitch），这个是"按格子尺寸自动算列数 + 换行 + 溢出可滚"。
    //   坐标一律由引擎的 `gridFlowRects` 算（与布局台同一份算法），本层**只喂数据、不重复几何**。
    if (sc.gridFrom) {
      var cell = out.filter(function (e) { return e.id === sc.gridFrom.prototype; })[0];
      var box = out.filter(function (e) { return e.id === sc.gridFrom.container; })[0];
      out = out.filter(function (e) { return e.id !== sc.gridFrom.prototype; });
      // D-188：`source === 'tab'` = 「当前选中的分类桶」（由 `state.warehouseTab` 决定），
      //   仓库弹窗用的就是它 —— 这样切选项卡只改 state，不必改布局表。
      var bucket = sc.gridFrom.source === 'tab' ? (state.warehouseTab || 'role') : sc.gridFrom.source;
      var items = layBucketItems(state, bucket);
      if (box) {
        var flow = C.gridFlowRects(box.rect, box.grid || {}, items.length);
        // grid.autoHeight：行数超出容器高 → 把容器内容高撑开（渲染层据此让 scroll 生效）
        if (box.grid && box.grid.autoHeight === true && flow.contentH > box.rect[3]) {
          box.contentH = flow.contentH;
        }
        box.gridInfo = { cols: flow.cols, rows: flow.rows, contentH: flow.contentH, count: items.length };
        if (!items.length) {
          out.push({
            id: 'ghost_empty', kind: 'deco', hit: 'rect', z: 6, parent: box.id,
            rect: [Number(box.grid && box.grid.padX) || 8, Number(box.grid && box.grid.padY) || 8, 240, 24],
            label: '这个分类里还没有东西', text: '这个分类里还没有东西',
          });
        }
        items.forEach(function (it, i) {
          if (!flow.rects[i]) return;
          var rel = flow.rects[i];
          out.push({
            id: 'gitem_' + i, kind: 'button', hit: 'rect', z: 6,
            parent: box.id,
            // 相对父容器内容原点（与 D-185 的 parent 语义一致）
            rect: [rel[0], rel[1], rel[2], rel[3]],   // 相对父容器（渲染层已按 parent 嵌套）
            label: it.label, text: it.label, asset: it.icon,
            action: 'warehouse-item-open',
            // `bucket` 必须带上：详情弹窗按它决定展示哪一组属性、以及给不给「开包 / 分解」按钮
            payload: { uid: it.uid, bucket: bucket },          });
        });
      }
      // 容量行（`{whCapacity}`）：读投影层自己产出的文本（render 层零逻辑）
      var capEl = out.filter(function (e) { return e.id === 'wh_capacity'; })[0];
      if (capEl) capEl.text = warehouseCapacityLine(state, bucket);
    }
    // D-194：**行模板展开**（`rowsFrom`）—— 节点库 / 程序树这类"按数据缩进的一列".
    //   几何一律走引擎的 `rowRects()`（与布局台同一份算法）；本层只喂行数据。
    //   `rowsFrom` 归一化后是**数组**（一个画面可以有多条行列表）。
    if (sc.rowsFrom) {
      // D-195：**缩放只作用于程序树那一组行**（`source === 'tree'`）。
      //   之前把 zoom 应用到所有行列表，结果"滚轮一滚，左侧节点库的行距也变大"。
      //   缩放 = 行高 + 缩进 + **字号** 一起放大（只放大行距=看着像"只是变松"，不是缩放）。
      var zoomNow = (state.aiEditor && Number(state.aiEditor.zoom)) || 1;
      if (!(zoomNow > 0)) zoomNow = 1;
      sc.rowsFrom.forEach(function (rf, gi) {
        var z = 1;   // 行本身不缩放：整块缩放交给渲染层的 wrapper
        var rfp = out.filter(function (e) { return e.id === rf.prototype; })[0];
        var rfb = out.filter(function (e) { return e.id === rf.container; })[0];
        out = out.filter(function (e) { return e.id !== rf.prototype; });
        if (!rfb) return;
        var rowList = layRowsFromSource(state, rf.source, flat);
        var spec = Object.assign({}, rf);
        // uniform（树）：**所有行同宽**，缩进只移动左边缘；基准宽要扣掉最大缩进，
        //   否则最深一层的右边界会顶出面板。右边界 = base.x + maxIndent*indentPx + w 恒等。
        var maxIndent = 0;
        rowList.forEach(function (r) { maxIndent = Math.max(maxIndent, Math.round(r.indent || 0)); });
        if (spec.uniform === true) spec.maxIndent = maxIndent;
        // 行高也要跟着缩放（只放大间距 = 看着像"只是变松"，不是缩放）
        var protoRect = rfp ? rfp.rect : [0, 0, 200, 26];
        // uniform：框宽恒定，层级由 x 右移体现（不再扣宽度）
        if (z !== 1) protoRect = [protoRect[0], protoRect[1], protoRect[2], Math.round(protoRect[3] * z)];
        var rres = C.rowRects(protoRect, spec, rowList);
        // 容器内容高撑开：原生滚动才真的能滚到底（渲染层据此插撑条）
        if (rres.contentH > rfb.rect[3]) rfb.contentH = rres.contentH;
        if (rf.source === 'tree' && zoomNow !== 1) {
          rfb.zoom = zoomNow;
          rfb.contentH = Math.max(rfb.contentH || 0, rres.contentH);
        }
        // 手势层要按"行高/缩进"把指针换算成落点
        rfb.rowPitch = spec.pitch || 0;
        rfb.rowIndent = spec.indentPx || 0;
        // 手势层要把屏幕像素换算回画布单位（容器在屏幕上被等比放大/缩小过）
        rfb.canvasW = rfb.rect[2];
        rfb.canvasH = rfb.rect[3];
        if (!rowList.length) {
          out.push({ id: 'rows_empty_' + gi, kind: 'deco', hit: 'rect', z: rfp ? rfp.z : 6, parent: rfb.id,
                     rect: [8, 8, 240, 22], label: '（空）', text: '（空）' });
        }
        var rowFont = rfp && rfp.font ? rfp.font : null;

        rowList.forEach(function (r, i) {
          var rr = rres.rects[i];
          if (!rr) return;
          out.push({
            id: 'rf_' + gi + '_' + i, kind: r.kind || 'button', hit: 'rect', z: rfp ? rfp.z : 6,
            parent: rfb.id,                                  // 必须挂进容器：滚动/平移才作用在行上
            rect: [rr[0], rr[1], rr[2], rr[3]],             // 相对父容器（渲染层已按 parent 嵌套）
            label: r.text, text: r.text,
            action: r.action || '', payload: r.payload || {},
            muted: !!r.muted, disabled: !!r.disabled, pressed: !!r.pressed,
            sel: !!r.pressed, slot: !!r.slot,          // D-194：选中行高亮 / 槽位头弱化
            dropHi: !!r.dropHi,                        // 功能B：拖动落点行高亮
            press: rfp && rfp.press ? rfp.press : '', font: rowFont,
            // D-195：节点库的行要能被**拖**（拖动放置）—— 渲染层据此写 `data-drag-node`
            dragNode: r.dragNode || '',
          });
        });
      });
    }
    // D-194：**AI 编辑屏的静态按钮要注入载荷**
    //   布局表里的模板按钮只有 3 个固定位（`ai_preset1..3`），具体套哪个模板由**数据**决定：
    //   这里把 `preset` id 与文案写进 payload —— 否则点了动作只知道"有个模板按钮"却不知道是哪个。
    if (name === 'ai_editor') {
      var aiEd0 = aiEditorOf(state);
      var presetList = aiEd0 === null ? [] : aiNodesPresetsOf(aiEd0.nodes);
      ['ai_preset1', 'ai_preset2', 'ai_preset3'].forEach(function (pid, i) {
        var pel = out.filter(function (e) { return e.id === pid; })[0];
        if (!pel) return;
        var pr = presetList[i];
        if (!pr) { pel.disabled = true; return; }
        pel.payload = { preset: or(pick(pr, 'id'), '') };
        pel.label = '套用：' + or(pick(pr, 'name'), '模板');
        pel.text = pel.label;
      });
    }
    // D-188：**物品详情弹窗** —— 把当前物品（`state.warehouseItem`）展开成"按类别分组的属性行"。
    //   数据全部来自已读到的 `/me/warehouse`（**零新接口**）；`{detXxx}` 键喂给布局表。
    if (name === 'modal_item_detail') {
      var det = layItemDetail(state);
      out.forEach(function (e) {
        if (e.id === 'det_title') e.text = det.title;
        else if (e.id === 'det_sub') e.text = det.sub;
        else if (e.id === 'det_lines') e.text = det.lines.join('\n');
        else if (e.id === 'det_icon') e.asset = det.icon;
      });
      // 操作按钮：按桶决定**显示哪个**（用户口径：包→开包；其他→分解；AI 节点→都不给）
      var keepBtn = { det_open: det.canOpen, det_dismantle: det.canDismantle };
      out = out.filter(function (e) {
        return !(keepBtn[e.id] === false);
      });
      // uid 载荷：详情弹窗的按钮要作用在**当前物品**上（布局表里写的是 `{detUid}`）
      out.forEach(function (e) {
        if (e.payload && e.payload.uid === '{detUid}') e.payload = { uid: det.uid };
      });
    }
    // busy（有请求在飞）时**所有布局按钮一律禁用**（UI-5：防重复提交）；装饰件不受影响
    if (busy) {
      out.forEach(function (e) { if (e.kind !== 'deco') e.disabled = true; });
    }
    // 不规则命中区：多边形 → CSS clip-path 字符串（渲染层直接用，不必懂几何）
    out.forEach(function (e) {
      if (e.hit === 'path' && e.path) {
        var pp = LAYOUT.engine.parsePath(e.path);
        if (pp) {
          e.clip = 'polygon(' + pp.points.map(function (q) {
            return q[0].toFixed(3) + '% ' + q[1].toFixed(3) + '%';
          }).join(', ') + ')';
        }
      }
    });
    return out;
  }
  // 插槽的"装了什么"一律读**仓库**里那件物品（实测：/me/configs 是快照，卸下插件后它仍显示旧 pluginUid）
  function layInstalled(state, itemUid, idx) {
    var env = state.warehouse ? state.warehouse.envelope : null;
    if (env === null || !itemUid) return '';
    var item = findItem(env, itemUid);
    if (item === null) return '';
    var uid = str(pick(layItem(arrayOf(pick(item, 'slots'))[idx]), 'pluginUid'));
    return uid === null ? '' : pluginLabelOf(state, uid);
  }
  /** 当前「显示哪份配置」的槽位 id（投影归 format，动作层不读响应字段） */
  function hubSlotId(state) { return 'slot' + laySlotIndex(state); }
  /** 当前显示配置的 loadout（布局路径的装配 / 换装都以它为基准） */
  function hubLoadout(state) {
    var cur = layCurrent(state);
    if (cur === null) return null;
    var lo = pick(cur, 'loadout');
    return lo === undefined ? null : lo;
  }
  /* ---------- D-194：`rowsFrom` 的数据源（AI 编辑屏用） ---------- */

  /** 行数据源 → [{indent, text, action, payload, muted, disabled, pressed}] */
  function layRowsFromSource(state, source, flat) {
    if (source === 'palette') return aiPaletteRows(state);
    if (source === 'tree') return aiTreeRows(state);
    if (source === 'ailist') return aiListRows(state);
    return [];
  }

  /** D-195：AI 库列表（布局表版）—— 一行一个 AI；点行 = 选中，打开/删除在底栏 */
  function aiListRows(state) {
    var ed = aiEditorOf(state);
    if (ed === null) return [];
    var env = ed.list;
    var items = aiItemsOf(env);
    if (!items.length) {
      return [{ indent: 0, text: env === null ? '（还没读取 AI 库：点右上「刷新」）' : '（还没有 AI：点右上「＋ 新建 AI」开始）', slot: true }];
    }
    var sel = ed.listSel || '';
    return items.map(function (it) {
      var aiId = or(pick(it, 'aiId'), '');
      return {
        indent: 0,
        text: or(pick(it, 'name'), '（未命名）') + '   ·   ' + aiItemStatusText(it)
          + '   ·   ' + aiUsageText(env, aiId) + '   ·   更新 ' + stamp(pick(it, 'updatedAt')),
        action: 'ai-list-select',
        payload: { aiId: aiId },
        pressed: aiId !== '' && aiId === sel,
      };
    });
  }

  /** AI 节点库：按类别分组；`owned === 0` 的**不显示**（用户 R7：只显示总库存里有的） */
  function aiPaletteRows(state) {
    var ed = aiEditorOf(state);
    if (ed === null) return [];
    var eb = ed.nodes;
    var catalog = aiNodesCatalogOf(eb);
    if (catalog !== null) aiBlueprint.setCatalog(catalog, aiNodesLimitsOf(eb));
    var inv = aiBlueprintInventoryOf(eb);
    var groups = aiBlueprint.nodeLibrary(inv);
    var openMap = (ed.paletteOpen && typeof ed.paletteOpen === 'object') ? ed.paletteOpen : {};
    var rows = [];
    groups.forEach(function (g) {
      var usable = g.items.filter(function (it) { return (it.owned || 0) > 0; });
      if (!usable.length) return;                       // 整类都没有货 → 这一类不出现
      // D-194：**默认展开**（一进来就看得见节点，符合"仓库里有什么一眼看到"）；
      //   点分类头才收起。之前写成默认折叠 → 打开编辑器只有 7 个分类标题、一个节点都没有。
      var open = openMap[g.category] !== false;
      rows.push({
        indent: 0,
        text: (open ? '▾ ' : '▸ ') + g.category + '（' + usable.length + '）',
        action: 'ai-palette-toggle', payload: { cat: g.category },
      });
      if (!open) return;
      usable.forEach(function (it) {
        var free = it.free || 0;
        rows.push({
          indent: 1,
          text: it.name + '   ' + free + '/' + (it.owned || 0),
          action: 'ai-node-append', payload: { node: it.nodeId },
          muted: free <= 0,
          disabled: free <= 0,                          // 0/N = 不能拖（R7）
          dragNode: free > 0 ? it.nodeId : '',          // 可拖：手势层据此拖进程序树
        });
      });
    });
    return rows;
  }

  /** AI 程序树：一行一个节点/槽位头，缩进 = 深度（缩放按 zoom 放大行高与缩进，见 D-194 §4.1） */
  function aiTreeRows(state) {
    var ed = aiEditorOf(state);
    if (ed === null || ed.draft === null) return [];
    var draft = ed.draft;
    if (draft.type !== 'blueprint') return [];
    var cursor = ed.cursor === undefined || ed.cursor === null ? '' : String(ed.cursor);
    var rows = aiBlueprint.treeRows(draft, cursor);
    if (rows.length === 0) {
      // 空蓝图要给**引导行**（不是空白一片）：告诉玩家下一步能做什么
      return [{ indent: 0, text: '（空蓝图：套用下方模板，或点左侧节点加入程序）', slot: true }];
    }
    var dropT = ed.dropTarget || null;
    return rows.map(function (r, rowIdx) {
      // 功能B：**落点高亮** —— 拖动时把"要放进去的那一行"整行高亮（不是只有一条细线）。
      //   两种落点区分：slot（放进这个节点的槽）→ 高亮节点所在行；body（插到两节点之间）→ 画落点线。
      var hi = false;
      if (dropT && r.rowKind === 'node') {
        if (dropT.where === 'slot') {
          hi = dropT.parentAddr === r.addr;              // 放进这个节点的槽 → 高亮它自己
        } else if (dropT.pitch) {
          // 插入到两行之间 → 高亮"将被顶下去的那一行"（新节点就落在它上面）
          hi = Math.abs(dropT.anchorY - Math.round(dropT.anchorY / dropT.pitch) * dropT.pitch) < 0.01
            && Math.round(dropT.anchorY / dropT.pitch) === rowIdx;
        }
      }
      return {
        indent: r.depth,
        text: r.header ? r.text : r.text,
        action: r.header ? '' : 'ai-select-node',
        payload: r.header ? {} : { addr: r.addr },
        pressed: r.selected === true,
        slot: r.header === true,                       // 槽位头用浅色
        muted: r.header === true,
        dropHi: hi,
      };
    });
  }

  /** AI 屏的布局版视图模型（D-194）：只有"正在编辑一份积木蓝图"时才走布局 */
  function aiLayoutVm(state, busy) {
    if (!LAYOUT || !LAYOUT.data.screens.ai_editor) return null;
    var ed = aiEditorOf(state);
    if (ed === null || ed.mode !== 'edit' || ed.draft === null || ed.draft.type !== 'blueprint') return null;
    var draft = ed.draft;
    var eb = ed.nodes;
    var catalog = aiNodesCatalogOf(eb);
    if (catalog !== null) aiBlueprint.setCatalog(catalog, aiNodesLimitsOf(eb));
    var inv = aiBlueprintInventoryOf(eb);
    // 正在编辑的既有条目：它自己的占用不算"别人占着"（D-179 修过的坑，这里同样要扣）
    var selfItem = ed.aiId === null ? null : aiItemOf(ed.list, ed.aiId);
    if (selfItem !== null && selfItem.blueprint) inv = aiBlueprint.excludeOwnUsage(inv, selfItem.blueprint);

    // 参数槽：取**第一个选项型**与**第一个数值型**参数（v1 固定 3 选项槽 + 1 数值槽）
    var form = (ed.cursor && ed.cursor !== 'body') ? aiBlueprint.formOf(draft, ed.cursor) : null;
    var optField = null, numField = null;
    ((form && form.fields) || []).forEach(function (f) {
      if (optField === null && (f.kind === 'slot' || f.kind === 'enum')) optField = f;
      if (numField === null && f.kind !== 'slot' && f.kind !== 'enum') numField = f;
    });
    var opts = optField ? (optField.values || []).slice(0, 3) : [];
    var presets = aiNodesPresetsOf(eb);

    var sstate = {
      aiSel: ed.cursor || '',
      aiDetail: ed.detailOpen === true ? '1' : '0',
      aiCanUndo: (ed.history || []).length ? '1' : '0',
      aiCanRedo: (ed.future || []).length ? '1' : '0',
      aiDragging: (ed.dropY === null || ed.dropY === undefined) ? '0' : '1',
      aiDropY: (ed.dropY === null || ed.dropY === undefined) ? '' : String(ed.dropY),
      aiTreeW: ed.detailOpen === true ? '616' : '980',
      aiP1: opts[0] !== undefined ? '1' : '0',
      aiP2: opts[1] !== undefined ? '1' : '0',
      aiP3: opts[2] !== undefined ? '1' : '0',
      aiPNum: numField !== null ? '1' : '0',
      aiImport: ed.importOpen === true ? '1' : '0',
      aiPreset1: presets[0] !== undefined ? '1' : '0',
      aiPreset2: presets[1] !== undefined ? '1' : '0',
      aiPreset3: presets[2] !== undefined ? '1' : '0',
    };

    var details = aiValidateDetailsOf(state);
    var checkText = details.length ? ('✕ ' + String(details.length) + ' 处问题：'
      + aiBlueprint.errorLines(draft, details).map(function (e) { return e.message; }).join('；'))
      : (aiValidateOk(state) === true ? '✓ 已通过（服务端确认）' : '（改动后会自动校验）');
    var shortage = aiBlueprint.shortageOf(draft, inv);

    var flat = {
      aiNameText: ed.name === '' ? '' : ed.name,
      aiStatusText: ed.status === 'draft' ? '草稿' : '正式',
      aiDirtyText: ed.dirty ? '有改动' : '已保存',
      aiUsageText: ed.aiId === null ? '（未入库）' : aiUsageText(ed.list, ed.aiId),
      aiNodeTitle: form ? form.name : '（未选中节点）',
      aiNodeDesc: form ? form.desc : '在中间的树里点一行，这里显示它的参数',
      aiP1Text: optField ? optField.label + '=' + String(opts[0]) : '',
      aiP2Text: optField ? optField.label + '=' + String(opts[1] === undefined ? '' : opts[1]) : '',
      aiP3Text: optField ? optField.label + '=' + String(opts[2] === undefined ? '' : opts[2]) : '',
      aiPNumText: numField ? numField.label + '：' + String(numField.value) : '',
      aiCheckText: checkText,
      aiImportText: ed.importText || '',
      aiShortageText: shortage.length
        ? ('⚠ 节点不足：' + shortage.map(function (s) { return s.name + '（需 ' + s.need + '/空闲 ' + s.free + '）'; }).join('、'))
        : '',
    };

    return {
      canvas: LAYOUT.data.canvas,
      background: LAYOUT.data.screens.ai_editor.background,
      layers: [{ name: 'ai_editor', role: 'screen', mask: null,
                 elements: layScreen(state, 'ai_editor', sstate, flat, {}, busy) }],
    };
  }

  function hubLayoutVm(state, busy) {
    // 无登录态（无 /me）时不走布局：让 hub 继续用旧文字界面，避免"半屏空数据"
    if (!LAYOUT || !state.profile || state.profile.data === null || state.profile.data === undefined) return null;
    var flat = layFlat(state);
    // D-188：`warehouseTab` 进设计期状态 —— 它是仓库弹窗选项卡「选中保持按下」的判据
    //   （`press:'state'` + `pressKey:'warehouseTab'` + `pressWhen:'<桶名>'`）。
    var sstate = { activeSlot: flat.activeSlot, battleSlot: flat.battleSlot, warehouseTab: state.warehouseTab };
    var stack = (state.hub && state.hub.modals) || [];
    var layers = [{ name: 'hub', role: 'screen', mask: null, elements: layScreen(state, 'hub', sstate, flat, {}, busy) }];
    stack.forEach(function (entry) {
      var sc = LAYOUT.data.screens[entry.name];
      if (!sc) return;
      layers.push({
        name: entry.name, role: 'modal', mask: sc.mask || LAYOUT.engine.DEFAULT_MASK,
        elements: layScreen(state, entry.name, sstate, flat, entry.ctx || {}, busy),
      });
    });
    return { canvas: LAYOUT.data.canvas, background: LAYOUT.data.screens.hub.background, layers: layers };
  }

  // F3 §3.1：hub（登录/注册成功后的落点；FR-11）
  function hubViewModel(state, notice, busy) {
    var buttons = [
      { action: 'goto-profile', label: '用户', kind: 'button', disabled: busy },
      { action: 'warehouse-open', label: '仓库', kind: 'button', disabled: busy },
      { action: 'goto-quick', label: '快速对战', kind: 'button', disabled: busy },
      { action: 'goto-tournament', label: '锦标赛', kind: 'button', disabled: busy },
      { action: 'goto-leaderboard', label: '排行榜', kind: 'button', disabled: busy },
      { action: 'config-open', label: '出战配置1', kind: 'button', disabled: busy, slot: 'slot1' },
      { action: 'config-open', label: '出战配置2', kind: 'button', disabled: busy, slot: 'slot2' },
      { action: 'config-open', label: '出战配置3', kind: 'button', disabled: busy, slot: 'slot3' },
      { action: 'goto-ai-editor', label: 'AI编辑', kind: 'button', disabled: busy },
      { action: 'goto-settings', label: '设置', kind: 'button', disabled: busy },
      // F10/D-180：对战历史（真屏，B30 的 /me/records + /me/defense）。
      //   布局表里那颗同名按钮原本是 import-layout 的 intent fix 造成的**死按钮**（只发提示不切屏），
      //   那颗 fix 已删；入口改由这里提供（布局渲染时它落在 footer，文字渲染时它就在这一排里）。
      { action: 'goto-records', label: '对战历史', kind: 'button', disabled: busy },
    ];
    // 02-accounts.md §3.3：仅 state.session.isAdmin === true 才渲染管理入口；普通账号**完全**不出现
    if (state.session && state.session.isAdmin === true) {
      buttons.push({ action: 'goto-admin', label: '管理员面板', kind: 'button', disabled: busy });
    }
    buttons.push({ action: 'refresh-hub', label: '刷新', kind: 'button', disabled: busy });
    // F9/D-180：布局表可用时，主界面 = 布局表渲染（含径向插槽弹窗）；
    //   下方保留"布局里没有的动作入口"：阵容编辑（config-open —— 旧编辑器仍在，作详细编辑用）、刷新、管理员面板。
    //   其余动作（仓库/排行/对战/切显示配置/装配/清空插槽…）全部由布局表里的按钮承担。
    if (layoutReady() && state.profile) {
      // F10/D-180：footer 里保留「布局表没画、但必须有入口」的四类动作：
      //   刷新（取齐三份数据）/ 阵容编辑（旧编辑器的详细编辑）/ 管理面板（仅管理员）/ **对战历史**。
      //   最后这条是把 `goto-records` 从死按钮救回来的入口 —— 布局表里的「对战历史」原本被
      //   import-layout 的 intent fix 造成按钮，那颗 fix 已删（它只发提示不切屏），故入口收在这里。
      var keep = { 'refresh-hub': 1, 'config-open': 1, 'goto-admin': 1, 'goto-records': 1 };
      var seen = {};
      var footer = [];
      buttons.forEach(function (b) {
        if (keep[b.action] !== 1 || seen[b.action] === 1) return;   // 同类只留一个入口
        seen[b.action] = 1;
        footer.push(b.action === 'config-open' ? Object.assign({}, b, { label: '阵容编辑' }) : b);
      });
      return vm('Debug-Lite', {
        notice: notice,
        layout: hubLayoutVm(state, busy),
        lines: [],
        buttons: footer,
        modal: modalViewModel(state, busy),
      });
    }
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

  // D-188：`warehouseViewModel`（旧仓库**屏**的投影）已随该屏删除。
  //   仓库现在由布局表的 `modal_warehouse` 承载，投影走 `layScreen` 的 `gridFrom` 分支；
  //   物品详情走 `layItemDetail`。**不留空实现** —— 留下会渲染出不可达动作（UI-2 判红）。

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

  // D-179：渲染兜底 vm（**不读 state**，只拼常量 + 传入的错误文本）
  //   由 public/app.js 的 mount() 在 viewModel 抛异常时调用；按钮只用注册表里的两个恒安全动作
  //   （goto-hub / logout），因此 UI-2「渲染集合 ⊆ 注册表」对兜底屏同样成立。
  function fatalViewModel(message) {
    return vm(FATAL_TITLE, {
      notice: { kind: 'error', text: FATAL_PREFIX + or(message, '未知错误') },
      hint: FATAL_HINT,
      lines: ['错误详情：' + or(message, '（无消息）')],
      buttons: [
        { action: 'goto-hub', label: FATAL_BACK_LABEL, kind: 'button', disabled: false },
        { action: 'logout', label: FATAL_LOGOUT_LABEL, kind: 'button', disabled: false },
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
    // D-188：`view === 'warehouse'` 已删除 —— 仓库改为覆盖在主界面上的**弹窗**
    //   （`state.hub.modals` 里的 `modal_warehouse`），不再是独立屏。
    // F8/D-176：`view === 'box'` 已删除（开箱屏退役 → 开包在仓库的「包」桶内完成）
    if (state.view === 'settings') return settingsViewModel(state, notice, busy);
    if (state.view === 'quick') return quickViewModel(state, notice, busy);   // F6（04 分册）
    if (state.view === 'tournament') return tournamentViewModel(state, notice, busy);   // F7（05 分册）
    if (state.view === 'leaderboard') return leaderboardViewModel(state, notice, busy); // F7（05 分册）
    if (state.view === 'records') return recordsViewModel(state, notice, busy);         // F10（D-180）
    if (state.view === 'ai-editor') return aiEditorViewModel(state, notice, busy);      // F5（06 分册）
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
    BUCKET_LABELS: BUCKET_LABELS,
    BUCKET_ORDER: BUCKET_ORDER,
    EMPTY_PAGES: EMPTY_PAGES,
    SKILL_SLOTS: SKILL_SLOTS,
    // D-179：渲染兜底（app.js 的 mount 在 viewModel 抛异常时调用）
    fatalViewModel: fatalViewModel,
    FATAL_TITLE: FATAL_TITLE,
    CONFIG_ACTIVE_HINT: CONFIG_ACTIVE_HINT,
    CONFIG_INCOMPLETE_SAVE_TEXT: CONFIG_INCOMPLETE_SAVE_TEXT,
    CONFIG_DRAFT_HINT: CONFIG_DRAFT_HINT,
    PLUGIN_HINTS: PLUGIN_HINTS,
    NICKNAME_MAX_TEXT: NICKNAME_MAX_TEXT,
    EMPTY_WAREHOUSE_TEXT: EMPTY_WAREHOUSE_TEXT,
    PACKAGE_OK_TEXT: PACKAGE_OK_TEXT,
    RECORDS_EMPTY_TEXT: RECORDS_EMPTY_TEXT,
    recordsOkText: recordsOkText,
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
    // D-188：仓库弹窗（网格 + 容量行）与物品详情弹窗（按类别分组的属性行）的投影。
    //   导出供测试与 actions 复用；`layItemDetail` 的返回形状见其函数注释。
    warehouseCapacityLine: warehouseCapacityLine,
    layBucketItems: layBucketItems,
    layItemDetail: layItemDetail,
    // D-194：布局表版 AI 编辑屏的投影（启用前也给测试/探针直接调）
    aiLayoutVm: aiLayoutVm,
    // D-178：积木节点（GET /me/ai/nodes）——目录/限额/模板/库存摘要
    aiNodesCatalogOf: aiNodesCatalogOf,
    aiNodesLimitsOf: aiNodesLimitsOf,
    aiNodesPresetsOf: aiNodesPresetsOf,
    aiNodeStockText: aiNodeStockText,
    usageText: usageText,
    itemLabel: itemLabel,
    itemRows: itemRows,
    // F9/D-180：布局表驱动的主界面（boot.js 注入引擎与布局数据）
    setLayout: setLayout,
    // F9：布局路径要用的投影（动作层不读响应字段，只能问 format 要）
    hubSlotId: hubSlotId,
    hubLoadout: hubLoadout,
    layoutReady: layoutReady,
    hubLayoutVm: hubLayoutVm,
    itemDetailLines: itemDetailLines,
    // F8/D-176/D-177：开包（仓库屏「包」桶）与战斗掉落投影
    packageResultLines: packageResultLines,
    packageKindLabel: packageKindLabel,
    quickDropsText: quickDropsText,
    fullBucket: fullBucket,
    packageFullNotice: packageFullNotice,
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
    // F5/D-172：AI 编辑器的动作层投影（动作层**不读响应字段**，一律经这里）
    aiEditorOf: aiEditorOf,
    aiItemsOf: aiItemsOf,
    aiCountText: aiCountText,
    aiUsageText: aiUsageText,
    aiItemStatusText: aiItemStatusText,
    aiStatusTextOf: aiStatusTextOf,
    aiValidateOk: aiValidateOk,
    aiValidateText: aiValidateText,
    aiValidateErrors: aiValidateErrors,
    aiErrorRows: aiErrorRows,
    aiSavedText: aiSavedText,
    aiSaveTarget: aiSaveTarget,
    aiItemOf: aiItemOf,
    aiDeleteOkText: aiDeleteOkText,
    aiWriteFailText: aiWriteFailText,
    aiDuplicateNames: function (draft) { return aiEd.duplicateFunctionNames(draft); },
  };
});
