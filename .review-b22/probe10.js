'use strict';
// B22 审查探针 10：HTTP 层 bad_json / 畸形 URI / 编码 id / from/to 解析边界
const http = require('node:http');
const serverMod = require('../server/index.js');
const { createLogger } = require('../shared/log.js');

function req(port, method, urlPath, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body !== undefined ? { 'content-type': 'application/json' } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', (e) => resolve({ status: -1, err: e.message }));
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    const p = s.port;
    const badJson = await req(p, 'POST', '/api/v1/battle', '{oops');
    console.log('POST /battle 坏 JSON →', badJson.status, badJson.body && badJson.body.error && badJson.body.error.code);
    const badUri = await req(p, 'GET', '/api/v1/replay/%zz');
    console.log('GET /replay/%zz →', badUri.status, badUri.body && badUri.body.error && badUri.body.error.code);
    const enc = await req(p, 'GET', '/api/v1/replay/r%31');
    console.log('GET /replay/r%31（编码 id）→', enc.status, enc.body && enc.body.error && enc.body.error.code);
    const empty = await req(p, 'GET', '/api/v1/replay/');
    console.log('GET /replay/（空 id）→', empty.status, empty.body && empty.body.error && empty.body.error.code);
    const t1 = await req(p, 'POST', '/api/v1/battle', {});
    console.log('POST /battle 空 body →', t1.status, t1.body && t1.body.error && t1.body.error.code);
  } finally {
    await s.close();
  }
})();