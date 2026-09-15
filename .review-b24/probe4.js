'use strict';
/* B24 审查探针 4：CLI ranked run 0/1/2 全路径（含 --pool 非数组 → 2 / --seed 缺值静默 / --seed abc → 1）
 * 可复跑：node .review-b24/probe4.js
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const cli = require('../cli/index.js');
const serverMod = require('../server/index.js');
const { createLogger } = require('../shared/log.js');

const LD_FILE = path.join(__dirname, '..', 'tests', 'fixtures', 'loadout-ok.json');
const tmp = path.join(__dirname, 'tmp');
fs.mkdirSync(tmp, { recursive: true });

async function quiet(fn) {
  const o1 = console.log, o2 = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = o1; console.error = o2; }
}

let ok = 0, fail = 0;
async function chk(name, fn) {
  try { await fn(); ok++; console.log(`  [ok] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}

(async () => {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    const baseUrl = `http://127.0.0.1:${s.port}`;
    await chk('正常路径 ranked run --seed 11 --tier mythic --loadout → 0', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--seed', '11', '--tier', 'mythic', '--loadout', LD_FILE], { baseUrl })), 0);
    });
    await chk('缺 --loadout → 2', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'run'], { baseUrl })), 2);
    });
    await chk('--loadout 缺值（结尾）→ 2', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--loadout'], { baseUrl })), 2);
    });
    await chk('未知子命令 ranked bogus → 2', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'bogus'], { baseUrl })), 2);
    });
    await chk('loadout 文件不存在 → 2', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--loadout', path.join(tmp, 'no.json')], { baseUrl })), 2);
    });
    await chk('loadout 文件坏 JSON → 2', async () => {
      fs.writeFileSync(path.join(tmp, 'bad.json'), '{nope');
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--loadout', path.join(tmp, 'bad.json')], { baseUrl })), 2);
    });
    await chk('--pool 文件非数组 → 2', async () => {
      fs.writeFileSync(path.join(tmp, 'pool-obj.json'), JSON.stringify({ loadout: {} }));
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--loadout', LD_FILE, '--pool', path.join(tmp, 'pool-obj.json')], { baseUrl })), 2);
    });
    await chk('--pool 文件不存在 → 2', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--loadout', LD_FILE, '--pool', path.join(tmp, 'nopool.json')], { baseUrl })), 2);
    });
    await chk('--pool 数组（2 项）→ 0', async () => {
      const pool = Array.from({ length: 2 }, (_, i) => {
        const x = JSON.parse(fs.readFileSync(LD_FILE, 'utf8')).loadout;
        x.skills[0].uid = `pool${i}`; return x;
      });
      fs.writeFileSync(path.join(tmp, 'pool-arr.json'), JSON.stringify(pool));
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--loadout', LD_FILE, '--pool', path.join(tmp, 'pool-arr.json')], { baseUrl })), 0);
    });
    await chk('--seed abc → 服务端 400 bad_seed → 1', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--seed', 'abc', '--loadout', LD_FILE], { baseUrl })), 1);
    });
    await chk('--seed 0 → 服务端 400 bad_seed → 1', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--seed', '0', '--loadout', LD_FILE], { baseUrl })), 1);
    });
    await chk('--seed 缺值（末尾）→ 观察（P2 候选：静默不传 → 服务端生成）', async () => {
      const c = await quiet(() => cli.main(['ranked', 'run', '--loadout', LD_FILE, '--seed'], { baseUrl }));
      console.log(`    现象: exit=${c}（--seed 缺值被当作未提供，服务端自生成 seed）`);
      assert.equal(c, 0);
    });
    await chk('--seed 吞旗标（--seed --loadout file）→ 后随文件变未知旗标 → 2（拒绝合理，提示文案误导 P2）', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--seed', '--loadout', LD_FILE], { baseUrl })), 2);
    });
    await chk('--tier platinum → 400 bad_tier → 1；--tier 末尾缺值 → 静默默认 mythic（P2 候选）', async () => {
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--tier', 'platinum', '--loadout', LD_FILE], { baseUrl })), 1);
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--loadout', LD_FILE, '--tier'], { baseUrl })), 0);
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--loadout', LD_FILE, '--seed'], { baseUrl })), 0);
    });
    await chk('服务端未运行 → 1（连接失败，非 2——replay 之外接受既有连接语义）', async () => {
      const c = await quiet(() => cli.main(['ranked', 'run', '--seed', '11', '--loadout', LD_FILE], { baseUrl: 'http://127.0.0.1:1' }));
      assert.equal(c, 1);
    });
    await chk('{loadout,warehouse} 包装文件解包 + warehouse 可空（无装配引用）→ 0', async () => {
      const raw = JSON.parse(fs.readFileSync(LD_FILE, 'utf8'));
      const lite = JSON.parse(JSON.stringify(raw.loadout));
      lite.role.slots = []; lite.skills.forEach((sk) => { sk.slots = []; });
      fs.writeFileSync(path.join(tmp, 'wrap.json'), JSON.stringify({ loadout: lite }));
      assert.equal(await quiet(() => cli.main(['ranked', 'run', '--loadout', path.join(tmp, 'wrap.json')], { baseUrl })), 0);
    });
  } finally {
    await s.close();
  }
  console.log(`\nprobe4: ${ok} ok / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();