'use strict';
/* mount/editor.js —— editor 屏 Blockly 装配（spec §6.2；mount 独占 DOM，视图不触碰 workspace 内部）。
 * wireEditor：入屏创建（预置 loop_forever/变更→ai/edit）；离屏 dispose；错误高亮消费 ui.highlight。
 */
import { createEditor } from '../editor/main.js';
import { toBlocks } from '../editor/bridge.js';

export function wireEditor(options) {
  const opts = options || {};
  const doc = opts.doc || null;
  const store = opts.store || null;
  const log = opts.log || null;
  const blockly = opts.blockly || null;
  const registerBlocksFn = opts.registerBlocks || null;
  if (!doc || !store || !blockly) return null;
  const div = doc.querySelector ? doc.querySelector('[data-box-id="workspace"]') : null;
  if (!div) return null;

  const editor = createEditor({
    blockly,
    div,
    nodes: (store.getState().tierInfo && store.getState().tierInfo.nodes) || [],
    registerBlocks: registerBlocksFn,
    timers: opts.timers || null,
    debounceMs: opts.debounceMs,
    onChange: (program) => {
      if (program) store.dispatch({ type: 'ai/edit', program });
    },
  });
  if (log) log.debug('editor', 'editor.toolbox', 'Blockly 装配', { nodes: (store.getState().tierInfo.nodes || []).length });

  let lastHighlightSeq = 0;
  const offHighlight = store.subscribe((s) => {
    const hl = s.ui && s.ui.highlight;
    if (!hl || hl.seq === lastHighlightSeq) return;
    lastHighlightSeq = hl.seq;
    // 高亮定位：保存的程序积木 JSON 内按路径定位（真实 Blockly 由 block id 映射滚动/选中）
    const program = (s.aiDraft && s.aiDraft.program) || null;
    const json = program ? toBlocks(program) : null;
    const block = json ? editor.findPath(json, hl.path) : null;
    log && log.debug('editor', 'editor.block.pos', hl.path, { block: block ? block.id || block.type : null });
  });

  return { editor, offHighlight, dispose() { if (editor) editor.dispose(); offHighlight(); } };
}
