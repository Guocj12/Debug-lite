'use strict';
// P6 R0 app.js 启动骨架契约测试 —— spec §1.3；模块加载即引导（node 环境 noop 安全）
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('R0 app.js：start() 为引导入口且模块加载即执行（noop 环境）', async () => {
  const app = await import('../../public/js/app.js');
  assert.equal(typeof app.start, 'function');
  assert.doesNotThrow(() => app.start());
});
