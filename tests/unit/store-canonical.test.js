'use strict';
/* tests/unit/store-canonical.test.js —— canonical JSON / 内容 hash / 原子写（D-129 §5.4/§6.6） */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const canonical = require('../../server/store/canonical.js');
const fa = require('../../server/store/fsatomic.js');
const { StoreError } = require('../../server/store/errors.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-fa-'));
}

test('CANON-1 canonicalJson：键排序 + 无空白 + 数组保序', () => {
  assert.equal(canonical.canonicalJson({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}');
  assert.equal(canonical.canonicalJson({ a: 1, b: 2 }), canonical.canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonical.canonicalJson({ x: undefined, y: null }), '{"y":null}');
  assert.equal(canonical.canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  assert.equal(canonical.canonicalJson(7), '7');
});

test('CANON-2 contentHash 可复现且带 sha256: 前缀；shortDigest 定长', () => {
  const a = canonical.contentHash({ role: 'r', skills: [1, 2, 3] });
  const b = canonical.contentHash({ skills: [1, 2, 3], role: 'r' });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, canonical.contentHash({ role: 'r', skills: [1, 2, 4] }));
  assert.equal(canonical.shortDigest('x|1|2', 16).length, 16);
  assert.equal(canonical.digestOf('sha256:abcdef'), 'abcdef');
  assert.equal(canonical.digestOf('abcdef'), 'abcdef');
  assert.equal(canonical.isHash('sha256:' + 'a'.repeat(64)), true);
  assert.equal(canonical.isHash('sha256:zz'), false);
  assert.equal(canonical.isHash(null), false);
});

test('CANON-3 deepClone 深拷贝（嵌套互不影响；null/undefined 原样）', () => {
  const src = { a: { b: [1, { c: 2 }] } };
  const copy = canonical.deepClone(src);
  copy.a.b[1].c = 99;
  assert.equal(src.a.b[1].c, 2);
  assert.equal(canonical.deepClone(null), null);
  assert.equal(canonical.deepClone(undefined), undefined);
});

test('FA-1 原子写：内容完整落盘、无 tmp 残留、目录自动创建', () => {
  const dir = mkTmp();
  try {
    const target = path.join(dir, 'nested', 'a.json');
    fa.writeJsonAtomicSync(target, { ok: true }, { logger: null });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: true });
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['a.json'], '不应残留 tmp 文件');
    // canonical / pretty 变体
    const c = path.join(dir, 'c.json');
    fa.writeJsonAtomicSync(c, { b: 1, a: 2 }, { canonical: true });
    assert.equal(fs.readFileSync(c, 'utf8'), '{"a":2,"b":1}');
    const p = path.join(dir, 'p.json');
    fa.writeJsonAtomicSync(p, { a: 1 }, { pretty: true });
    assert.ok(fs.readFileSync(p, 'utf8').includes('\n  "a"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('FA-2 原子写是"替换"而非截断：写失败不破坏旧内容（模拟目标为目录）', () => {
  const dir = mkTmp();
  try {
    const target = path.join(dir, 'x.json');
    fa.writeJsonAtomicSync(target, { v: 1 });
    // 用一个不可 rename 的目标名（其父路径为文件）触发失败 → 必须抛 store_write_failed 且旧文件完好
    assert.throws(() => fa.writeFileAtomicSync(path.join(target, 'sub.json'), 'x'),
      (e) => e instanceof StoreError && e.code === 'store_write_failed');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 1 });
    assert.equal(fa.writeFileAtomicSync(target, 'raw'), target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'raw');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('FA-3 readJsonSync：缺失/损坏分别走 fallback 与 store_corrupt', () => {
  const dir = mkTmp();
  try {
    assert.equal(fa.readJsonSync(path.join(dir, 'nope.json'), null), null);
    assert.equal(fa.readJsonSync(path.join(dir, 'nope.json'), { d: 1 }).d, 1);
    assert.throws(() => fa.readJsonSync(path.join(dir, 'nope.json')), (e) => e.code === 'store_corrupt');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{oops', 'utf8');
    assert.equal(fa.readJsonSync(bad, null), null);
    assert.throws(() => fa.readJsonSync(bad), (e) => e.code === 'store_corrupt');
    assert.equal(fa.readText(bad), '{oops');
    assert.equal(fa.pathExists(bad), true);
    assert.equal(fa.pathExists(path.join(dir, 'nope.json')), false);
    assert.equal(fa.statSafe(path.join(dir, 'nope.json')), null);
    assert.ok(fa.statSafe(bad).size > 0);
    assert.equal(fa.removeFile(path.join(dir, 'nope.json')), false);
    assert.equal(fa.removeFile(bad), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('FA-4 sweepTmpSync 只删 *.tmp-*；listDirFiles 对不存在目录返回空', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, 'keep.json'), '{}');
    fs.writeFileSync(path.join(dir, 'a.json.tmp-1-ff'), 'half');
    fs.writeFileSync(path.join(dir, 'b.json.tmp-2-aa'), 'half');
    assert.equal(fa.listDirFiles(path.join(dir, 'nope')).length, 0);
    assert.equal(fa.sweepTmpSync(path.join(dir, 'nope')), 0);
    assert.equal(fa.sweepTmpSync(dir), 2);
    assert.deepEqual(fs.readdirSync(dir), ['keep.json']);
    assert.equal(fa.sweepTmpSync(dir), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('FA-5 renameSafe 覆盖已存在目标；sleepSync(0/正数) 不抛错', () => {
  const dir = mkTmp();
  try {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'B');
    fa.renameSafe(a, b);
    assert.equal(fs.readFileSync(b, 'utf8'), 'A');
    assert.equal(fa.pathExists(a), false);
    fa.sleepSync(0);
    fa.sleepSync(1);
    assert.ok(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('FA-6 fsyncDir/ensureDir 幂等；目录不可 fsync 时忽略（Windows 分支）', () => {
  const dir = mkTmp();
  try {
    fa.ensureDir(path.join(dir, 'a', 'b'));
    fa.ensureDir(path.join(dir, 'a', 'b'));
    const logged = [];
    const logger = { debug: (ch, ev, msg, data) => logged.push({ ch, ev, msg, data }), warn: () => {}, info: () => {} };
    fa.fsyncDir(path.join(dir, 'a', 'b'), logger);
    assert.equal(fs.existsSync(path.join(dir, 'a', 'b')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
