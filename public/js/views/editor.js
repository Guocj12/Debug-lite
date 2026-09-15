// views/editor.js —— AI 编辑器屏布局（frontend-spec §6.2；坐标口径 = docs/screens.md「AI 编辑器 editor」盒子表）

// screens.md editor 表：toolbox(0,64,120,592,z2) workspace(120,64,1024,432,z2) loop_forever(144,88,200,48,z3)
// panel_right(1144,64,136,592,z2) btn_validate(1156,80,112,32,z3) btn_compile(1156,120,112,32,z3)
// btn_run(1156,160,112,32,z3) hash(1156,216,112,40,z3) errCount(1156,272,112,24,z3) errors(120,496,1024,160,z2)
// 注 1：表内 workspace 行 = Blockly 注入容器，其元素 id 由 frontend-spec §6.2 规定为 blocklyDiv（盒 id 沿用）。
// 注 2：表内 loop_forever 为 Blockly 管理的预置积木（presetLoop），位置由 Blockly 自持，不建 DOM 盒。
const TOOLBOX_BOX = { x: 0, y: 64, w: 120, h: 592, z: 2 };
const WORKSPACE = { x: 120, y: 64, w: 1024, h: 432, z: 2 };
const PANEL = { x: 1144, y: 64, w: 136, h: 592, z: 2 };
const BTN = { x: 1156, w: 112, h: 32, z: 3 };
const HASH = { x: 1156, y: 216, w: 112, h: 40, z: 3 };
const ERR_COUNT = { x: 1156, y: 272, w: 112, h: 24, z: 3 };
const ERRORS = { x: 120, y: 496, w: 1024, h: 160, z: 2 };
const TB_CHIP = { x: 8, y: 80, w: 104, h: 28, pitch: 32 }; // toolbox 容器内条目
const ERR_ROW = { x: 136, y: 528, w: 992, h: 22, pitch: 26, max: 5 }; // errors 容器内行

// 缺省出战 AI（编辑器未产出程序时的兜底）：隐式主循环内恒有一个可达 action → ast 合法性与门控均可通过。
// 必要性：/battle 与 /panel 的 loadout 校验要求 「缺少 AI 程序 → loadout_invalid」（server/loadout.js I-12a），
// 无兜底则装配完也无法对战/看面板（回放屏不可达）。
export const DEFAULT_AI_PROGRAM = Object.freeze({
  type: 'program', version: 1,
  body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] },
});

export function editorLayout(state) {
  const d = state.aiDraft || {};
  const errs = d.errors || [];
  const nodes = (state.tierInfo && state.tierInfo.nodes) || null;
  const entries = buildToolbox(nodes);
  const boxes = [
    { id: 'toolbox', kind: 'panel', parent: null, ...TOOLBOX_BOX, visible: true, text: '积木' },
  ];
  entries.forEach((e, i) => {
    boxes.push({
      id: `tb_${e.type}`, kind: 'chip', parent: 'toolbox',
      x: TB_CHIP.x, y: TB_CHIP.y + i * TB_CHIP.pitch, w: TB_CHIP.w, h: TB_CHIP.h, z: 3, visible: true,
      text: e.label, disabled: true,
    });
  });
  boxes.push({ id: 'blocklyDiv', kind: 'workspace', parent: null, ...WORKSPACE, visible: true, text: 'Blockly 区' });
  boxes.push({ id: 'panel_right', kind: 'panel', parent: null, ...PANEL, visible: true, text: '控制' });
  const btn = (id, y, text, action, payload) => ({
    id, kind: 'button', parent: 'panel_right', style: 'ghost',
    x: BTN.x, y, w: BTN.w, h: BTN.h, z: BTN.z, visible: true, text, action,
    ...(payload === undefined ? {} : { payload }),
    disabled: !!d.compiling && action === 'ai/compile',
  });
  boxes.push(btn('btn_validate', 80, '校验', 'ai/validate'));
  boxes.push(btn('btn_compile', 120, d.compiling ? '编译中…' : '编译', 'ai/compile'));
  boxes.push(btn('btn_run', 160, '试运行', 'ai/run', { opponent: 'kiter' }));
  boxes.push({
    id: 'hash', kind: 'text', parent: 'panel_right', style: 'wrap muted',
    x: HASH.x, y: HASH.y, w: HASH.w, h: HASH.h, z: HASH.z, visible: true,
    text: d.hash ? `HASH ${String(d.hash).slice(0, 8)}` : '未编译',
  });
  boxes.push({
    id: 'errCount', kind: 'text', parent: 'panel_right',
    x: ERR_COUNT.x, y: ERR_COUNT.y, w: ERR_COUNT.w, h: ERR_COUNT.h, z: ERR_COUNT.z, visible: true,
    text: `错误 ${errs.length}`,
  });
  // 错误列表（容器 + 行；行点击 → 高亮对应积木，§6.2）
  boxes.push({ id: 'errors', kind: 'panel', parent: null, ...ERRORS, visible: true, text: '错误列表' });
  if (errs.length === 0) {
    boxes.push({
      id: 'editor_err_ok', kind: 'text', parent: 'errors',
      x: ERR_ROW.x, y: ERR_ROW.y, w: 400, h: ERR_ROW.h, z: 3, visible: true, text: '（无错误）',
    });
  } else {
    errs.slice(0, ERR_ROW.max).forEach((e, i) => {
      boxes.push({
        id: `editor_err_${i}`, kind: 'listitem', parent: 'errors',
        x: ERR_ROW.x, y: ERR_ROW.y + i * ERR_ROW.pitch, w: ERR_ROW.w, h: ERR_ROW.h, z: 3, visible: true,
        text: `${e.path || ''} ${e.code || ''}`, detail: e.message || '',
        action: e.path ? 'editor/highlight' : null,
        payload: e.path ? { path: e.path } : undefined,
      });
    });
  }
  return boxes;
}

// toolbox 过滤（纯）：unlock nodes（后端 availableNodes 键）→ 可用积木条目（门控；spec §6.2 按 tierInfo.nodes 过滤）。
// ★F6 审查 P1：门控键由"编辑器方言键"改为**后端节点键**——原 11 型中 num/loop_forever 不在 availableNodes（19 键）
// → 真实 mythic 门控只放行 9/11（核心循环/数字永不可建）；且 8 个后端节点无积木（break/function/call/bullets/
// getVar/get/literal/loop_count 漏项）。下表 16 条目覆盖后端 16 节点（seq 为隐式结构、arith_ext 为 arith 的 op 扩展：
// 见 F6.md 登记）。根循环（D-100 隐式主循环）由 presetLoop 预置、不入门控（恒有）。
const TOOLBOX = [
  { type: 'action', label: '行动', node: 'action' },
  { type: 'var', label: '变量', node: 'var' },
  { type: 'set', label: '赋值', node: 'set' },
  { type: 'if', label: '条件', node: 'if' },
  { type: 'loop_forever', label: '无限循环', node: 'loop' },
  { type: 'loop_count', label: '计数循环', node: 'loop' },
  { type: 'random', label: '随机分支', node: 'random' },
  { type: 'num', label: '数字', node: 'literal' },
  { type: 'get', label: '读取', node: 'getVar' },
  { type: 'bullets', label: '子弹表', node: 'bullets' },
  { type: 'arith', label: '运算', node: 'arith' },
  { type: 'cmp', label: '比较', node: 'cmp' },
  { type: 'logic', label: '逻辑', node: 'logic' },
  { type: 'function', label: '函数', node: 'function' },
  { type: 'call', label: '调用', node: 'call' },
  { type: 'break', label: '跳出', node: 'break' },
];

export function buildToolbox(nodes) {
  const set = new Set(nodes || []);
  return TOOLBOX.filter((b) => set.has(b.node)).map((b) => ({ kind: 'block', type: b.type, label: b.label }));
}