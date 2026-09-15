'use strict';
/* editor/main.js —— Blockly 装配点（spec §6.2）：注入/预置外层 while(true)/变更→程序回调/离屏销毁。
 * 注入参数：toolbox=buildToolbox(nodes)（节点键门控）；mount 不触碰 workspace 内部。
 * Blockly 注入缝：node 测试注入 stub（jsonBlocks + serialization 假件）；浏览器注入真实 blockly。
 */
import { buildToolbox } from './blocks.js';
import { toAst, findBlockByPath } from './bridge.js';

export function createEditor(options) {
  const opts = options || {};
  const blockly = opts.blockly || null;
  const div = opts.div || null;
  if (!blockly || !div) return null; // 无 Blockly 注入 → 跳过（node 环境）

  const timers = opts.timers || null;
  const onChange = opts.onChange || null;
  const debounceMs = opts.debounceMs === undefined ? 300 : opts.debounceMs;

  const workspace = blockly.inject(div, {
    toolbox: buildToolbox(opts.nodes || []),
    grid: { spacing: 24 },
    zoom: { controls: true },
  });

  // 预置外层 loop_forever（D-100 隐式主循环；不可删除/移动）
  let root = null;
  if (blockly.serialization && blockly.serialization.blocks && typeof blockly.serialization.blocks.append === 'function') {
    root = blockly.serialization.blocks.append({ type: 'loop_forever', x: 24, y: 24, deletable: false, movable: false }, workspace);
  }

  let disposed = false;
  let timer = null;
  function emitProgram() {
    if (!onChange) return;
    const hasSave = blockly.serialization && blockly.serialization.workspaces && typeof blockly.serialization.workspaces.save === 'function';
    const json = hasSave ? blockly.serialization.workspaces.save(workspace) : (workspace._rootBlock || null);
    if (!json) { onChange(null); return; }
    const program = toAst(json);
    onChange(program && program.body ? { type: program.type, version: program.version, body: program.body } : null);
  }
  function listener() {
    if (disposed) return;
    if (timers && typeof timers.setTimeout === 'function' && debounceMs !== null) {
      if (timer && timers.clearTimeout) timers.clearTimeout(timer);
      timer = timers.setTimeout(() => {
        timer = null;
        emitProgram();
      }, debounceMs);
    } else {
      emitProgram();
    }
  }
  if (workspace.addChangeListener) workspace.addChangeListener(listener);

  return {
    workspace,
    root,
    // 错误高亮接缝：后端 details.path → 积木 JSON 内定位（供 mount 高亮/滚动）
    findPath(json, path) {
      return findBlockByPath(json, path);
    },
    dispose() {
      disposed = true;
      if (timer && timers && timers.clearTimeout) timers.clearTimeout(timer);
      if (workspace.dispose) workspace.dispose();
    },
  };
}
