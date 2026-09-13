// editor/main.js —— Blockly 编辑器装配（frontend-spec §6.2；Blockly 依赖注入——浏览器全局/测试 fake；
// 装配点唯一调用方 = mount（见 mount/index.js syncEditor）；node 无 Blockly/document → 安全跳过）
// ★F6 审查 P1：原 createEditor 全仓无调用点 + presetLoop 为纯桩 + 高亮调用点缺失——本文件补真实实现
// （presetLoop 真建根循环 movable/deletable false；highlightByPath 供 errors 行点击消费）。
import { toAst, findBlockByPath } from './bridge.js';

// createEditor({Blockly, toolbox, dispatch, debounceMs, setTimeout, clearTimeout, programRoot, container})
// → {created, reason?, widget, programRoot, dispose}；Blockly 缺省 → {created:false, reason:'no-blockly'}；
// 容器解析（document.getElementById('blocklyDiv') 回退；node 无 document 安全）；inject 抛错 → 'inject-failed'。
export function createEditor(deps) {
  const o = deps || {};
  const B = o.Blockly || null;
  if (!B) return { created: false, reason: 'no-blockly' };
  let container = o.container;
  if (!container && typeof document !== 'undefined') container = document.getElementById('blocklyDiv');
  if (!container) return { created: false, reason: 'no-container' };
  const dispatch = o.dispatch || (() => {});
  const debounceMs = o.debounceMs === undefined ? 300 : o.debounceMs;
  let widget = null;
  const rootOf = () => {
    if (o.programRoot) return o.programRoot();
    return widget && typeof widget.getTopBlocks === 'function' ? widget.getTopBlocks()[0] : null;
  };
  try {
    widget = B.inject(container, {
      toolbox: o.toolbox || [],
      grid: { spacing: 24 },
      zoom: { controls: true },
    });
  } catch (e) {
    return { created: false, reason: 'inject-failed' };
  }
  let timer = null;
  const schedule = (fn) => {
    if (timer !== null && o.clearTimeout) o.clearTimeout(timer);
    timer = (o.setTimeout || setTimeout)(() => { timer = null; fn(); }, debounceMs);
  };
  // §6.2 实时校验：change → debounce 300ms → toAst（后端程序形状）→ ai/edit → /ai/validate
  widget.addChangeListener(() => {
    schedule(() => {
      try {
        dispatch({ type: 'ai/edit', payload: { program: toAst(rootOf()) } });
      } catch (e) { /* 桥转换畸形积木安全兜底：不清空编辑器、不中断监听 */ }
    });
  });
  const handle = {
    created: true,
    widget,
    programRoot: rootOf,
    dispose: () => {
      if (timer !== null && o.clearTimeout) o.clearTimeout(timer);
      timer = null;
      if (widget && typeof widget.dispose === 'function') widget.dispose();
    },
  };
  return handle;
}

// D-100 预置：工作区顶部根 loop_forever（movable:false, deletable:false——引擎隐式主循环的唯一可视表示）。
// ★F6 审查 P1：原为桩（仅返回 B&&widget truthy）；现以真实 Blockly 建块（newBlock + initSvg + render + moveBy）。
// 无 newBlock API（测试 fake/精简环境）或建块抛错 → false（同 createEditor 的 no-blockly 语义，调用方记录日志）。
export function presetLoop(B, widget) {
  if (!B || !widget || typeof widget.newBlock !== 'function') return false;
  let blk = null;
  try {
    blk = widget.newBlock('loop_forever');
    if (!blk) return false;
    if (typeof blk.setMovable === 'function') blk.setMovable(false);
    if (typeof blk.setDeletable === 'function') blk.setDeletable(false);
    if (typeof blk.initSvg === 'function') blk.initSvg();
    if (typeof blk.render === 'function') blk.render();
    if (typeof blk.moveBy === 'function') blk.moveBy(24, 0);
  } catch (e) { return false; }
  return true;
}

// §6.2 高亮：错误路径 → 积木 id → Blockly 高亮（workspace.highlightBlock）；未找到 → null（调用方 toast「程序已变化」）
export function highlightByPath(widget, root, path) {
  const id = findBlockByPath(root, path);
  if (!id) return null;
  if (widget && typeof widget.highlightBlock === 'function') widget.highlightBlock(id);
  return id;
}