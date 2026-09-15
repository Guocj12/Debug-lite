'use strict';
// bridge 往返与路径定位快验（临时脚本，验证后删除）
const fs = require('fs');
const fixtures = require('./tests/fixtures/ai-programs.json');

(async () => {
  const bridge = await import('./public/js/editor/bridge.js');
  let fail = 0;
  for (const [name, fx] of Object.entries(fixtures)) {
    const program = fx.program || fx;
    if (!program || program.type !== 'program') continue;
    const blocks = bridge.toBlocks(program);
    const back = bridge.toAst(blocks);
    const clean = { type: back.type, version: back.version, body: back.body };
    const a = JSON.stringify(program);
    const b = JSON.stringify(clean);
    if (a !== b) {
      fail++;
      console.log(`MISMATCH ${name}`);
      console.log('  want', a.slice(0, 200));
      console.log('  got ', b.slice(0, 200));
    } else {
      console.log(`OK ${name}`);
    }
  }
  // 空程序
  const e = bridge.toAst(bridge.toBlocks({ type: 'program', version: 1, body: { type: 'seq', statements: [] } }));
  console.log('empty stmts', JSON.stringify(e.body));
  // 路径定位
  const fx = fixtures.coverageProgram.program;
  const b2 = bridge.toBlocks(fx);
  console.log('path body.s[1] →', bridge.findBlockByPath(b2, 'body.s[1]') ? 'hit' : 'null');
  console.log('path body.s[2].value.left', bridge.findBlockByPath(b2, 'body.s[2].value.left') ? 'hit' : 'miss');
  console.log('fail', fail);
})();
