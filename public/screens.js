'use strict';
/* public/screens.js —— **屏幕登记表**（前端有哪些屏、每屏有哪些入口与端点）
 *
 * 设计依据：docs/decisions.md **D-180**（建立）/ **D-181**（恢复完整文字前端）/ **D-182**（关闭布局渲染）。
 *
 * ⚠️ **本文件的效力（诚实说明）**：
 *   · **屏清单的权威是 `store.VIEWS`**，**屏→投影的权威是 `format.js` 的 `viewModel` 分发表**（if 链）。
 *     本文件的 `VIEWS` 与 `store.VIEWS` **逐条相等**（tests/frontend/auth-ui-contract.test.js 的 UI-13 核对）。
 *   · `project` 是**说明性字段**：写的是 `format.js` 分发表里真实使用的函数名（`(inline vm)` = 该屏在
 *     分发表尾部就地 `vm(...)`，没有独立函数名）。**运行时不查它** —— 别把它当契约。
 *   · `actions` / `data` 同样是**登记**：回答"这屏有哪些入口、读哪些端点"，与 `ACTIONS` 键集核对
 *     （tests/frontend/admin-ui-contract.test.js 的 F1/F2/F3/F5/F6/F7/F9/F10 分组并集断言）。
 *
 * 字段：
 *   title     页面标题
 *   status    'ready'（已实现）/ 'todo'（占位页：零请求，只有一颗返回主界面）
 *   plan      status==='todo' 时的"计划"说明
 *   layout    若有：layout-data.js 里的整屏名（**D-182 起布局渲染已关闭**，此字段只记录能力）
 *   project   该屏的投影函数（说明性；`(inline vm)` = 分发表内就地构造）
 *   actions   该屏渲染集合（登记；与 ACTIONS 核对）
 *   data      该屏读取的端点（登记）
 *
 * 本文件**不读响应字段、不发请求、不碰 DOM**（纯声明）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.screens = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCREENS = {
    "login": {
      title: "登录",
      status: 'ready',
      plan: null,
      layout: null,
      project: "(inline vm)",
      actions: ["submit-login","goto-register"],
      data: [],
    },
    "register": {
      title: "注册",
      status: 'ready',
      plan: null,
      layout: null,
      project: "(inline vm)",
      actions: ["submit-register","goto-login"],
      data: [],
    },
    "hub": {
      title: "Debug-Lite",
      status: 'ready',
      plan: null,
      layout: "hub",
      project: "hubViewModel",
      // D-188：仓库从独立屏改为**弹窗**（`warehouse-open`），新增物品详情/分解/开包/选定显示配置。
      actions: ["goto-profile","goto-quick","goto-tournament","goto-leaderboard","goto-ai-editor","goto-settings","goto-records","config-open","refresh-hub","goto-hub","layout-open","layout-assemble","layout-disassemble","layout-activate","layout-set-slot","modal-close","warehouse-open","warehouse-tab","warehouse-item-open","warehouse-dismantle","warehouse-package-open","config-select"],
      data: ["me","me/configs","me/warehouse"],
    },
    "profile": {
      title: "用户详情",
      status: 'ready',
      plan: null,
      layout: null,
      project: "profileViewModel",
      actions: ["refresh-profile","goto-password","goto-hub"],
      data: ["me"],
    },
    "password": {
      title: "设置密码",
      status: 'ready',
      plan: null,
      layout: null,
      project: "(inline vm)",
      actions: ["submit-password","goto-home","goto-settings"],
      data: [],
    },
    "admin": {
      title: "管理员面板",
      status: 'ready',
      plan: null,
      layout: null,
      project: "adminViewModel",
      actions: ["admin-refresh-accounts","admin-stats","admin-rebuild-index","admin-bots","admin-clear-bots","admin-ban-row","admin-account-patch","goto-hub","goto-admin"],
      data: ["admin/accounts"],
    },
    "accounts": {
      title: "账号列表",
      status: 'ready',
      plan: null,
      layout: null,
      project: "accountsViewModel",
      actions: ["accounts-prev","accounts-next","accounts-size-20","accounts-size-50","accounts-size-100","admin-delete-account","confirm-yes","confirm-no","goto-admin","goto-hub","admin-refresh-accounts"],
      data: ["admin/accounts"],
    },
    // D-188：`warehouse` **独立屏已删除** —— 仓库改为覆盖在主界面上的**弹窗**
    //   （用户口径：「仓库不是一个页面而是弹窗」）。它的入口是 hub 的 `warehouse-open`，
    //   内容由布局表的 `modal_warehouse` 承载；旧屏的投影/动作随之下线。
    "settings": {
      title: "设置",
      status: 'ready',
      plan: null,
      layout: null,
      project: "settingsViewModel",
      actions: ["settings-nickname-save","goto-password","logout","goto-hub"],
      data: ["me/nickname"],
    },
    "quick": {
      title: "快速对战",
      status: 'ready',
      plan: null,
      layout: null,
      project: "quickViewModel",
      actions: ["quick-run","viewer-first","viewer-prev","viewer-next","viewer-last","viewer-trace-p1","viewer-trace-p2","viewer-ai-logic","viewer-load-replay","goto-hub","modal-close"],
      data: ["quick/run"],
    },
    "tournament": {
      title: "锦标赛",
      status: 'ready',
      plan: null,
      layout: null,
      project: "tournamentViewModel",
      actions: ["tournament-run","tournament-page-prev","tournament-page-next","tournament-open-battle","viewer-first","viewer-prev","viewer-next","viewer-last","viewer-trace-p1","viewer-trace-p2","viewer-ai-logic","viewer-load-replay","goto-hub"],
      data: ["ranked/run"],
    },
    "leaderboard": {
      title: "排行榜",
      status: 'ready',
      plan: null,
      layout: null,
      project: "leaderboardViewModel",
      actions: ["board-points","board-tier","board-scope","board-prev","board-next","board-refresh","goto-hub"],
      data: ["leaderboard"],
    },
    "records": {
      title: "对战历史",
      status: 'ready',
      plan: null,
      layout: null,
      project: "recordsViewModel",
      actions: ["records-filter","records-seen","refresh-records","goto-hub"],
      data: ["me/records","me/defense"],
    },
    "ai-editor": {
      title: "AI 编辑器",
      status: 'ready',
      plan: null,
      // D-194/D-195：积木蓝图草稿走布局表版（方案 A）；旧 AST 程序仍按文字版渲染
      layout: "ai_editor",
      project: "aiEditorViewModel",
      actions: ["ai-new","ai-open","ai-delete","ai-confirm-yes","ai-confirm-no","ai-refresh","ai-select-node","ai-insert","ai-replace","ai-move-up","ai-move-down","ai-wrap-if","ai-delete-node","ai-slot-clear","ai-block-remove","ai-set-field","ai-set-literal-type","ai-save","ai-save-as","ai-save-draft","ai-validate","ai-import-open","ai-import-apply","ai-import-close","ai-close","ai-discard-yes","ai-discard-no","ai-bp-new","ai-bp-preset","ai-node-append","ai-node-del","ai-node-up","ai-node-down","ai-param-set","ai-param-step","ai-palette-toggle","ai-detail-close","ai-undo","ai-redo","ai-node-drop","ai-list-select","goto-hub"],
      data: ["me/ai","me/ai/nodes"],
    },
  };

  Object.freeze(SCREENS);

  // 注册表派生的视图名清单（**顺序即声明顺序**；store.VIEWS 必须逐条等于它）
  var VIEWS = Object.freeze(Object.keys(SCREENS));

  /** 某屏的注册信息（未知屏名 → null，调用方负责兜底） */
  function screenOf(view) {
    return Object.prototype.hasOwnProperty.call(SCREENS, view) ? SCREENS[view] : null;
  }

  /** 注册表里所有 ready 屏的渲染集合**并集**（供"无不可达动作"双向核对） */
  function reachableActions() {
    var out = [];
    VIEWS.forEach(function (v) {
      var s = SCREENS[v];
      if (s.status !== 'ready') return;
      s.actions.forEach(function (a) { if (out.indexOf(a) < 0) out.push(a); });
    });
    return out;
  }

  return {
    SCREENS: SCREENS,
    VIEWS: VIEWS,
    screenOf: screenOf,
    reachableActions: reachableActions,
  };
});
