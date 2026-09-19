'use strict';
/* tests/cli/cli-utf8-split.test.js —— CLI 读响应体：多字节字符跨 TCP chunk 边界不得损坏
 *
 * 缺陷（与 `server/index.js` 的 `readBody`、`tests/helpers/http.js` **同一根因**）：
 *   `cli/index.js` 的 `httpJson` 曾写 `let d = ''; res.on('data', (c) => { d += c; })` ——
 *   这会对**每个 chunk 各自** `toString('utf8')`；一个多字节字符（中文）恰好跨 chunk 边界时被解成 U+FFFD。
 *   注意这是**静默**损坏：`JSON.parse` 仍会成功（U+FFFD 是合法字符），CLI 只是把中文打错 —— 不报错、不退出非 0。
 * 修法：`Buffer.concat(chunks).toString('utf8')` 整段解码（与 server 侧、tests/helpers/* 同写法）。
 *
 * 本用例手法（参考 `tests/api/api-body-utf8-split.test.js`）：把响应 JSON 字节流**切在多字节字符内部**
 *   分两次写出，并先用一个原始 http 客户端探针确认"客户端确实读到 ≥2 个 chunk" —— 否则传输层一旦把两段
 *   合并成单 chunk，用例就会静默失去判别力（变成永远绿的假护栏）。
 * 零依赖、不 spawn 子进程、不用 `Math.random`（项目铁律）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const cli = require('../../cli/index.js');
const c = require('../helpers/cli.js');

const NICK = '中文昵称·调试员';

// 找一个"切在多字节字符内部"的字节位置（返回 {k, char, bytes}；与 api-body-utf8-split 同一手法）
function splitInsideMultibyte(buf) {
  const text = buf.toString('utf8');
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp < 0x80) continue;
    const bytes = Buffer.from(text[i], 'utf8').length;
    if (bytes > 1) {
      const start = buf.indexOf(Buffer.from(text[i], 'utf8'));
      return { k: start + 1, char: text[i], bytes };
    }
  }
  return null;
}

// 起一个"把响应体切在多字节字符内部、分两次 write"的 HTTP 服务。
// 第一段与第二段之间隔一轮定时器：客户端（与服务器同进程）必然先把第一段读成独立 chunk。
function startSplitServer(bodyBuf, splitAt, status) {
  const server = http.createServer((req, res) => {
    res.writeHead(status === undefined ? 200 : status, { 'content-type': 'application/json; charset=utf-8' });
    res.write(bodyBuf.subarray(0, splitAt));
    setTimeout(() => { res.end(bodyBuf.subarray(splitAt)); }, 25);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// 原始客户端探针：数客户端实际读到几个 chunk（这里自身按 Buffer 累积 —— 探针不测解码，只测分块）
function probeChunks(baseUrl, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${urlPath}`, (res) => {
      let n = 0;
      const parts = [];
      res.on('data', (ch) => { n += 1; parts.push(Buffer.isBuffer(ch) ? ch : Buffer.from(String(ch))); });
      res.on('end', () => resolve({ chunks: n, text: Buffer.concat(parts).toString('utf8') }));
    }).on('error', reject);
  });
}

// 组装"切点确定 + 修前对照 + 传输确已分块"三件套（三条用例共用）
async function splitFixture(t, payload, status) {
  const buf = Buffer.from(payload, 'utf8');
  const split = splitInsideMultibyte(buf);
  assert.ok(split, '测试体必须含多字节字符');
  // 修前行为对照（纯逻辑、确定性）：同一字节流逐 chunk 各自解码必现 U+FFFD —— 证明切点是真触发点
  const legacy = buf.subarray(0, split.k).toString('utf8') + buf.subarray(split.k).toString('utf8');
  assert.ok(legacy.includes('\uFFFD'), `修前逐 chunk 解码必现 U+FFFD（切在第 ${split.k} 字节，字符 ${split.char}）`);
  assert.notEqual(legacy, payload, '修前字节流与原始响应体不等（这就是缺陷本身）');

  const s = await startSplitServer(buf, split.k, status);
  t.after(() => s.close());
  const probe = await probeChunks(s.baseUrl, '/api/v1/health');
  assert.ok(probe.chunks >= 2, `探针必须收到 ≥2 个 chunk（实际 ${probe.chunks}）——否则本用例失去判别力`);
  assert.equal(probe.text, payload, '探针整段解码结果应与原始响应体一致');
  return { s, buf, split };
}

test('CLI-UTF8-1 httpJson：响应体中文跨 chunk 边界 → raw 逐字节一致（修前 U+FFFD）', async (t) => {
  const payload = JSON.stringify({ ok: true, data: { nickname: NICK, note: '跨 chunk 校验·中文' } });
  const { s } = await splitFixture(t, payload, 200);

  const r = await cli.httpJson(s.baseUrl, 'GET', '/api/v1/health');
  assert.equal(r.status, 200);
  assert.equal(r.raw, payload, `raw 必须与原始响应字节流逐字节一致：${JSON.stringify(r.raw)}`);
  assert.ok(!r.raw.includes('\uFFFD'), 'raw 不得含 U+FFFD');
  assert.equal(r.body.data.nickname, NICK, `解析出的昵称被损坏：${JSON.stringify(r.body.data.nickname)}`);
});

test('CLI-UTF8-2 CLI health 输出：跨 chunk 中文响应不出现 U+FFFD（生产路径 cli/index.js）', async (t) => {
  const payload = JSON.stringify({ ok: true, version: '3.0.0', data: { nickname: NICK, note: '中文原文' } });
  const { s } = await splitFixture(t, payload, 200);

  const out = await c.runCli(['health'], { baseUrl: s.baseUrl });
  assert.equal(out.code, 0, `跨 chunk 的中文响应必须正常完成：${out.err}`);
  assert.ok(out.out.includes(NICK), `stdout 应含原始中文昵称：${out.out.slice(0, 300)}`);
  assert.ok(!out.out.includes('\uFFFD'), `stdout 不得含 U+FFFD：${out.out.slice(0, 300)}`);
  assert.ok(!out.err.includes('\uFFFD'), `stderr 不得含 U+FFFD：${out.err}`);
});

test('CLI-UTF8-3 CLI 非 JSON 错误响应：中文原文经 r.raw 完整打到 stderr（无 U+FFFD）', async (t) => {
  const raw = `服务不可用：维护中·请稍后重试（${NICK}）`;
  const { s } = await splitFixture(t, raw, 500);

  const out = await c.runCli(['health'], { baseUrl: s.baseUrl });
  assert.equal(out.code, 1, '500 → 退出码 1（业务失败，行为不变）');
  // finish()：非 200 且响应体非 JSON → stderr 打印 { code:'unknown', message: r.raw }
  assert.ok(out.err.includes(raw), `stderr 应含完整中文原文：${out.err.slice(0, 300)}`);
  assert.ok(!out.err.includes('\uFFFD'), `stderr 不得含 U+FFFD：${out.err}`);
});
