'use strict';
// T-LG-2 补充：UMD 双入口 —— Node require 与浏览器（window.DLLog）都可用（§4.10）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'log.js'), 'utf8');

test('T-LG-2g UMD：浏览器环境（无 module/exports）挂到全局 DLLog', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.window = undefined; // 模拟非 window 脚本上下文（worker/老浏览器）
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'shared/log.js' });
  assert.equal(typeof sandbox.DLLog, 'object', 'DLLog 全局挂载');
  assert.equal(typeof sandbox.DLLog.createLogger, 'function');
  assert.equal(typeof sandbox.DLLog.nullLogger, 'object');
  assert.deepEqual(sandbox.DLLog.LEVELS.silent, -1);
  // 浏览器环境下 createLogger 默认级别无 process.env → debug
  const log = sandbox.DLLog.createLogger({ level: 'all' });
  log.info('engine', 'e', 'm');
  assert.equal(log.records.length, 1);
  // 无 process.env 的上下文：不传 level → 默认 debug（env 缺失分支的行为验证）
  assert.equal(sandbox.DLLog.createLogger().getLevel(), 'debug', 'vm 无 process.env → debug');
  assert.equal(globalThis.DLLog, undefined, '不得污染 Node 全局');
});

test('T-LG-2h UMD：window 形式的浏览器环境同样挂载（浏览器中 window === 全局对象）', () => {
  const sandbox = {};
  sandbox.window = sandbox; // 真实浏览器语义：window.window === window
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'shared/log.js' });
  assert.equal(typeof sandbox.window.DLLog, 'object');
  assert.equal(sandbox.window.DLLog, sandbox.DLLog);
});