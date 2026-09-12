'use strict';
/* .review-b17/http-probe.js —— B17 独立 HTTP 红队探针（真实 socket，非测试代码路径）
 * ① 正常信封（seed/tier/times 回带 + items 形状 + api.* 日志）；② bad_json；
 * ③ bad_tier/bad_times(101)/bad_seed；④ 同 seed 两次请求内容级复现（uid 不同）；
 * ⑤ CLI box 退出码 0/1(业务)/2(参数) 经真实 HTTP。
 */
const http = require('node:http');
const { start } = require('../server/index.js');
const { createLogger } = require('../shared/log.js');
const cli = require('../cli/index.js');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body !== undefined ? { 'content-type': 'application/json' } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: json, raw: d });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const logger = createLogger({ level: 'debug', ringSize: 5000 });
  const s = await start({ logger });
  const port = s.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const contentOf = (it) => ({ kind: it.kind, templateId: it.templateId, quality: it.quality, slotCount: it.slotCount });

  console.log('== ① 正常信封 ==');
  {
    const r = await request(port, 'POST', '/api/v1/box', { seed: 20260913, tier: 'rare', times: 3 });
    console.log(`status=${r.status} ok=${r.body.ok} seed=${r.body.data.seed} tier=${r.body.data.tier} times=${r.body.data.times} items=${r.body.data.items.length}`);
    console.log(`log 事件：api.req=${logger.records.some((x) => x.event === 'api.req' && x.data.path === '/api/v1/box')} api.res=${logger.records.some((x) => x.event === 'api.res')} items.generate=${logger.records.some((x) => x.event === 'items.generate')} items.roll.quality=${logger.records.some((x) => x.event === 'items.roll.quality')}`);
  }
  console.log('== ② bad_json ==');
  {
    const r = await request(port, 'POST', '/api/v1/box', '{nope');
    console.log(`status=${r.status} code=${r.body.error.code}`);
  }
  console.log('== ③ 参数矩阵 ==');
  for (const [name, body1] of [
    ['tier=diamond', { tier: 'diamond' }], ['times=101', { times: 101 }], ['times=0', { times: 0 }], ['seed=0', { seed: 0 }], ['seed="abc"', { seed: 'abc' }], ['seed=-1', { seed: -1 }],
  ]) {
    const r = await request(port, 'POST', '/api/v1/box', body1);
    console.log(`${name} → ${r.status} ${r.body.error.code}`);
  }
  console.log('== ④ 同 seed 内容级复现 ==');
  {
    const a = await request(port, 'POST', '/api/v1/box', { seed: 98765, tier: 'epic', times: 4 });
    const b = await request(port, 'POST', '/api/v1/box', { seed: 98765, tier: 'epic', times: 4 });
    const same = JSON.stringify(a.body.data.items.map(contentOf)) === JSON.stringify(b.body.data.items.map(contentOf));
    const uidSame = JSON.stringify(a.body.data.items.map((x) => x.uid)) === JSON.stringify(b.body.data.items.map((x) => x.uid));
    console.log(`内容一致=${same} uid同=${uidSame}（a: ${a.body.data.items.map((x) => x.uid).join(',')} / b: ${b.body.data.items.map((x) => x.uid).join(',')}）`);
  }
  console.log('== ⑤ CLI 退出码（真实 HTTP）==');
  {
    const prevLog = console.log, prevErr = console.error;
    console.log = () => {}; console.error = () => {};
    const out = [];
    try {
      const cases = [
        ['box ok', ['box', '--seed', '7', '--tier', 'rare', '--times', '3']],
        ['box 缺省', ['box']],
        ['box --tier diamond', ['box', '--tier', 'diamond']],
        ['box --times 0', ['box', '--times', '0']],
        ['box --seed abc', ['box', '--seed', 'abc']],
        ['box --bogus', ['box', '--bogus']],
        ['box --times 101', ['box', '--times', '101']],
        ['box --times 1.5', ['box', '--times', '1.5']],
      ];
      for (const [name, argv] of cases) {
        out.push(`${name} → ${await cli.main(argv, { baseUrl })}`);
      }
    } finally {
      console.log = prevLog; console.error = prevErr;
    }
    for (const line of out) console.log(line);
  }
  await s.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });