'use strict';
/* editor/blocks.js —— Blockly 自定义块注册（F7 P0 原则：块词汇 = bridge 块型全集 16，逐字一致）。
 * 视觉最小化（setColour/appendDummyInput/顺序连接），表达式输出留待打磨（spec §11 打磨项）。
 */
export const BLOCK_TYPES = [
  'var', 'set', 'if', 'loop_forever', 'loop_count', 'random', 'action', 'break', 'function', 'call',
  'num', 'get', 'bullets', 'arith', 'cmp', 'logic',
];

import { STMT_TYPES, EXPR_TYPES } from './bridge.js';

// 注册全部块型（幂等：已注册跳过；tests 用 stub 核验方法面）
export function registerBlocks(Blockly) {
  if (!Blockly || typeof Blockly.Blocks !== 'object') return [];
  const colours = { stmt: 250, expr: 180 };
  const registered = [];
  const fieldOf = (type) => {
    switch (type) {
      case 'var': case 'set': case 'function': case 'call': case 'action': case 'get':
        return ['名', 'name'];
      case 'num':
        return ['值', 'value'];
      case 'arith': case 'cmp': case 'logic':
        return ['op', 'op'];
      default:
        return null;
    }
  };
  for (const type of Object.keys(STMT_TYPES).concat(Object.keys(EXPR_TYPES))) {
    if (Blockly.Blocks[type]) continue; // 幂等：已注册跳过
    Blockly.Blocks[type] = {
      init() {
        const b = this;
        const isExpr = !!EXPR_TYPES[type];
        if (typeof b.setColour === 'function') b.setColour(isExpr ? colours.expr : colours.stmt);
        if (isExpr && typeof b.setOutput === 'function') b.setOutput(true);
        if (!isExpr) {
          if (typeof b.setPreviousStatement === 'function') b.setPreviousStatement(true);
          if (typeof b.setNextStatement === 'function') b.setNextStatement(true);
        }
        if (typeof b.appendDummyInput === 'function') {
          const input = b.appendDummyInput();
          input.appendField(type);
          const f = fieldOf(type);
          if (f) input.appendField(f[0], f[1]);
        }
      },
    };
    registered.push(type);
  }
  return registered;
}

// toolbox：按段位可用节点门控（块型 → 节点键映射；未解锁剔除）
// 键映射（对齐 server unlock availableNodes 词汇）：loop_forever↔loop/while；loop_count↔loop；num↔literal；get↔get/getVar
const NODE_KEYS = {
  loop_forever: ['loop', 'while'], loop_count: ['loop'],
  num: ['literal'], get: ['get', 'getVar'],
};

export function buildToolbox(nodes) {
  const set = new Set(nodes || []);
  const open = (t) => {
    const keys = NODE_KEYS[t] || [t];
    return keys.some((k) => set.has(k));
  };
  return {
    kind: 'categoryToolbox',
    contents: [
      { kind: 'category', name: '语句', contents: Object.keys(STMT_TYPES).filter(open).map((t) => ({ kind: 'block', type: t })) },
      { kind: 'category', name: '表达式', contents: Object.keys(EXPR_TYPES).filter(open).map((t) => ({ kind: 'block', type: t })) },
    ],
  };
}
