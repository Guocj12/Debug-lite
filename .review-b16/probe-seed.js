'use strict';
/* 随机 seed 复现探针：/ai/battle 无 seed（服务端生成随机 seed）是否偶发失败 */
const http = require('node:http');
const path = require('node:path');
const serverMod = require('../server/index.js');
const { createLogger } = require('../shared/log.js');
const fs = require('node:fs');
const OK_FILE = path.join(__dirname, '..', 'tests', 'fixtures', 'cli-ai-ok.json');
const program = JSON.parse(fs.readFileSync(OK_FILE, 'utf8'));

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: urlPath, headers: { 'content-type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: d }); });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  for (const level of ['silent', 'debug']) {
    const logger = createLogger({ level, ringSize: 4000 });
    const s = await serverMod.start({ logger });
    let bad = 0; const samples = [];
    for (let i = 0; i < 120; i++) {
      const r = await post(s.port, '/api/v1/ai/battle', { program });
      if (r.status !== 200) { bad++; if (samples.length < 3) samples.push({ status: r.status, raw: r.raw.slice(0, 400) }); }
    }
    const errs = logger.records.filter((r) => r.level === 'error').map((r) => `${r.event} ${r.msg} ${JSON.stringify(r.data && r.data.message)}`);
    console.log(`level=${level}: 120 次随机 seed battle，失败 ${bad}`, JSON.stringify(samples, null, 1), 'server errors:', errs.slice(0, 3));
    await s.close();
  }
})();