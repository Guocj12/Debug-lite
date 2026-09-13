// editor/blocks.js —— 自定义 Blockly 块定义（F6 P2-1/F7：Blockly.Blocks 注册；注入式——node 可测注册清单）
// 块型 = **bridge.js 识别块型全集**（F6 契约直译 16 型：bridge.toBlocks/toAst 的块 JSON type 分支全集，
// 见 bridge.js stmtToBlock/exprToBlock）。★F7 审查 P0 修正：原 20 键（loop_forever/num 之外的
// statement_seq/move_right/var_declare…"显示词汇"）与 bridge 块型命名几乎全异（仅 2/16 重名）→
// 工具箱（buildToolbox 的 action/var/if…）与序列化 round-trip 无法实例化（Block type not registered）——
// 本版改为与 bridge 逐一对应的 16 键（数量与命名一一对应，审查探针实证）。
// registerBlockTypes(Blockly) → 注册清单 [{type, hasNext}...]；幂等；null/无 Blocks 安全。

export const BLOCK_TYPES = {
  var: { fields: ['name'] },
  set: { fields: ['name'] },
  if: { fields: [] },
  loop_forever: { fields: [] },
  loop_count: { fields: [] },
  random: { fields: [] },
  action: { fields: ['name'] },
  break: { fields: [] },
  function: { fields: ['name'] },
  call: { fields: ['name'] },
  num: { fields: ['value'] },
  get: { fields: ['path', 'name'] }, // get|getVar 双语义（bridge 单块按 path/name 判别）
  bullets: { fields: [] },
  arith: { fields: ['op'] },
  cmp: { fields: ['op'] },
  logic: { fields: ['op'] },
};

export function blockTypeKeys() {
  return Object.keys(BLOCK_TYPES);
}

// 注册（浏览器调用）：Blockly.Blocks[key] = {init}（视觉由打磨阶段完善；此处最小可用 init 防空白块）
export function registerBlockTypes(Blockly) {
  if (!Blockly || !Blockly.Blocks) return { registered: 0 };
  let n = 0;
  for (const key of blockTypeKeys()) {
    if (Blockly.Blocks[key]) continue; // 幂等
    Blockly.Blocks[key] = {
      init() {
        this.setColour(160);
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.appendDummyInput().appendField(key);
      },
    };
    n += 1;
  }
  return { registered: n };
}