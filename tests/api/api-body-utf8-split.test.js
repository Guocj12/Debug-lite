'use strict';
/* tests/api/api-body-utf8-split.test.js —— 多字节字符跨 chunk 边界不得损坏（server/index.js readBody + 测试夹具解码）
 *
 * 缺陷（2026-09-19 实测，同一根因两处）：把 Buffer chunk 直接用 `s += chunk` 累积，会对**每个 chunk 各自**
 *   `toString('utf8')`；一个多字节字符恰好跨 chunk 边界时被解成 U+FFFD。
 *   确定性实测（3 字节字符 '法'，66 个可能切点中 **10 个**会损坏；切点 36 → `非\uFFFD\uFFFD\uFFFD行动`）。
 *   · 生产侧：`server/index.js` 的 `readBody`（修前中文请求体被静默损坏或 400 bad_json）；
 *   · 夹具侧：`tests/helpers/http.js` 及 `tests/api/*` 的本地 request 辅助（修前让"两次响应逐值相等"的
 *     断言偶发假红——`api-replay-auth.test.js` 的 RP-3/RP-8 即此现象）。
 * 修法：一律 `Buffer.concat(chunks).toString('utf8')` 整段解码（服务端另把上限判定改为**字节**口径）。
 * 对照证据（修前行为，留在本用例内）：同一字节流逐 chunk 解码必现 U+FFFD。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');

const NICK = '中文昵称·调试员';

// 找到一个"切在多字节字符内部"的字节位置（返回 {k, char}）
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

test('BODY-UTF8 请求体中文跨 chunk 边界：服务端入库逐字节一致（修前 U+FFFD 损坏）+ 夹具解码同源修复', async () => {
  await h.withServer(null, async (s) => {
    const username = h.uniqueName('utf8');
    const body = JSON.stringify({ username, password: h.PASSWORD, nickname: NICK });
    const buf = Buffer.from(body, 'utf8');
    const split = splitInsideMultibyte(buf);
    assert.ok(split, '测试体必须含多字节字符');
    // 修前行为对照（纯逻辑，确定性）：逐 chunk 各自 toString 会损坏该字符
    const legacyDecoded = buf.subarray(0, split.k).toString('utf8') + buf.subarray(split.k).toString('utf8');
    assert.ok(legacyDecoded.includes('\uFFFD'), `修前逐 chunk 解码必现 U+FFFD（切在第 ${split.k} 字节，字符 ${split.char}）`);
    assert.notEqual(legacyDecoded, body, '修前字节流与原始请求体不等（这就是缺陷本身）');

    // 以"切在多字节字符内部"的两个 chunk 发送（Transfer-Encoding: chunked）
    // 注册响应对外回带 nickname → 同时覆盖请求体解码（服务端 readBody）与响应体解码（测试夹具）
    const reg = await h.requestChunks(s.port, '/api/v1/auth/register', [buf.subarray(0, split.k), buf.subarray(split.k)]);
    assert.equal(reg.status, 200, `跨 chunk 的中文请求体必须能正常解析：${reg.raw.slice(0, 200)}`);
    assert.equal(reg.body.ok, true);
    assert.equal(reg.body.data.nickname, NICK, `注册响应昵称被损坏：${JSON.stringify(reg.body.data.nickname)}`);
    assert.ok(!reg.raw.includes('\uFFFD'), '响应不得含 U+FFFD（夹具解码缺陷会使这里偶发假红）');

    // 回读：昵称必须与原始输入**逐字节一致**
    const me = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(reg.body.data.token));
    assert.equal(me.status, 200, me.raw);
    assert.equal(me.body.data.nickname, NICK, `入库昵称被损坏：${JSON.stringify(me.body.data.nickname)}`);
    assert.ok(me.raw.includes(NICK), '响应正文必须含原始昵称字节序列');

    // 长度口径：多字节字符按**字节**计（服务端上限判定为字节；此处顺带确认中文长度统计正确）
    assert.equal(Buffer.byteLength(NICK, 'utf8') > NICK.length, true, '中文昵称字节数 > 字符数（上限按字节计）');
  });
});
