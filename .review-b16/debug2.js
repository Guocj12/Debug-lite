'use strict';
const path = require('node:path');
const cli = require('../cli/index.js');
const serverMod = require('../server/index.js');
const { createLogger } = require('../shared/log.js');
const OK_FILE = path.join(__dirname, '..', 'tests', 'fixtures', 'cli-ai-ok.json');

(async () => {
  const logger = createLogger({ level: 'debug', ringSize: 5000 });
  const s = await serverMod.start({ logger });
  const baseUrl = `http://127.0.0.1:${s.port}`;
  const code = await cli.main(['ai', 'battle', '--file', OK_FILE], { baseUrl });
  console.log('CLI code =', code);
  await s.close();
  const errs = logger.records.filter((r) => r.level === 'error' || r.level === 'warn').map((r) => `${r.channel} ${r.event} ${r.msg}`);
  console.log('server warn/error:', JSON.stringify(errs.slice(-10), null, 1));
})();