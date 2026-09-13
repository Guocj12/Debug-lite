(async () => {
  // P1 定案探针：① DLLog records 接缝（数组 vs 函数）② levelValue 刻度 vs settings LOG_LEVELS 索引
  const { createLogger } = require('../shared/log.js');
  const lgr = createLogger({ level: 'all', ringSize: 100 });
  lgr.info('render', 'probe.info', 'm1');
  lgr.debug('ui', 'probe.debug', 'm2');
  lgr.trace('render', 'probe.trace', 'm3');
  const recs = lgr.dump();
  console.log('records type:', typeof lgr.records, Array.isArray(lgr.records), '| dump len:', recs.length);
  for (const r of recs) console.log(`record: level=${r.level} levelValue=${r.levelValue}`);
  // app.js 默认 records 源模拟
  const raw = lgr;
  const defaultRecords = () => (raw && typeof raw.records === 'function' ? raw.records() : []);
  console.log('app default records via fn-arm →', JSON.stringify(defaultRecords().length), '(期望 3，实际应暴露接缝)');
  // ② settings 刻度：模拟 filterLogs 的 mapLevel（当前实现）
  const LOG_LEVELS = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace', 'all'];
  const mapLevel = (name) => { const i = LOG_LEVELS.indexOf(name); return i === -1 ? 4 : i; };
  // 用户选 info（radio）→ state.logPrefs.level='info' → 阈值
  const thresholdInfo = mapLevel('info'); // 当前实现 4
  const dllogInfoValue = 3; // DLLog LEVELS.info
  const ok0 = recs.find((r) => r.level === 'info');
  console.log(`threshold(info)=${thresholdInfo} vs DLLog info=${dllogInfoValue} debug=${recs.find(r=>r.level==='debug').levelValue} trace=${recs.find(r=>r.level==='trace').levelValue}`);
  const debugKept = recs.filter((r) => r.levelValue <= thresholdInfo).map((r) => r.level);
  console.log('选 info 档实际保留记录:', JSON.stringify(debugKept), '← debug 混入即刻度偏差实证');
  const thresholdDebug = mapLevel('debug');
  const traceKept = recs.filter((r) => r.levelValue <= thresholdDebug).map((r) => r.level);
  console.log('选 debug 档实际保留记录:', JSON.stringify(traceKept), '← trace 混入即刻度偏差实证');
})().catch((e) => { console.error(e); process.exit(1); });