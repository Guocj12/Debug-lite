// views/editor.js —— AI 编辑器屏布局（frontend-spec §6.2：toolbox 左 / workspace / panel 右 / errors 底）
import { SIZES } from '../ui/sizes.js';
import { panel, button } from '../ui/layout.js';

// §6.2 布局坐标：toolbox(0,64,120,592) / workspace(120,64,1024,432) / panel(1144,64,136,592) / errors(120,496,1024,160)。
// ★F6 审查 P1：workspace 盒 id 必须为 blocklyDiv（Blockly.inject 容器；main.createEditor 的 document 回退即取此 id
// ——原 editor_workspace 使应用内无任何 Blockly 注入可达点）。
export function editorLayout(state) {
  const boxes = [
    panel(0, 64, 120, 592, '积木', 'editor_toolbox'),
    { id: 'blocklyDiv', kind: 'workspace', parent: null, x: 120, y: 64, w: 1024, h: 432, z: 1, visible: true, text: 'Blockly 区' },
  ];
  boxes.push(panel(1144, 64, 136, 592, '控制', 'editor_panel'));
  // §6.2 面板：校验/编译/试运行 + programHash + 错误计数；宽 136 → 按钮 ghost 96×32（F6 自检修正）
  boxes.push(button('editor_validate', 1156, 72, '校验', { parent: 'editor_panel', z: 1, ghost: true, action: 'ai/validate' }));
  boxes.push(button('editor_compile', 1156, 116, '编译', { parent: 'editor_panel', z: 1, ghost: true, action: 'ai/compile' }));
  boxes.push(button('editor_run', 1156, 160, '试运行', { parent: 'editor_panel', z: 1, ghost: true, action: 'ai/run', payload: { opponent: 'kiter' } }));
  const d = state.aiDraft || {};
  const hash = d.hash;
  boxes.push({ id: 'editor_hash', kind: 'text', parent: 'editor_panel', x: 1156, y: 208, w: 112, h: 20, z: 1, visible: true, text: hash ? `hash ${hash.slice(0, 8)}` : '未编译' });
  const errs = d.errors || [];
  boxes.push({ id: 'editor_err_count', kind: 'text', parent: 'editor_panel', x: 1156, y: 240, w: 112, h: 20, z: 1, visible: true, text: `错误 ${errs.length}` });
  // 错误列表（底栏 120,496,1024,160；≤5 行；行点击 → 高亮对应积木（§6.2 errors 行点击 → highlight））
  boxes.push(panel(120, 496, 1024, 160, '错误', 'editor_errors'));
  let ey = 528;
  for (const e of errs.slice(0, 5)) {
    boxes.push({
      id: `editor_err_${ey}`, kind: 'listitem', parent: 'editor_errors',
      x: 136, y: ey, w: 992, h: 22, z: 1, visible: true,
      text: `${e.path || ''} ${e.code || ''}`, detail: e.message || '',
      // F6 审查 P1：高亮调用点（原缺失）——行 action → reducer aiDraft.highlightPath → mount 消费定位积木
      action: e.path ? 'editor/highlight' : null,
      payload: e.path ? { path: e.path } : undefined,
    });
    ey += 26;
  }
  if (errs.length === 0) {
    boxes.push({ id: 'editor_err_ok', kind: 'text', parent: 'editor_errors', x: 136, y: 528, w: 400, h: 20, z: 1, visible: true, text: '（无错误）' });
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