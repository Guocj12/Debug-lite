// Red-team F1 probe: replicate gate 项7 nested run() (isolation:none + coverage) and print failing test names.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const N = Number(process.argv[2] || 8);
const files = fs.readdirSync('tests', { recursive: true })
  .filter((f) => typeof f === 'string' && f.endsWith('.test.js'))
  .map((f) => path.resolve('tests', f));
let fails = 0;
for (let i = 1; i <= N; i++) {
  const script = `
    const { run } = require('node:test');
    const files = ${JSON.stringify(files)};
    (async () => {
      const r = run({ files, isolation: 'none', coverage: true });
      let pass = 0, fail = 0;
      for await (const e of r) {
        if (e.type === 'test:pass') pass++;
        else if (e.type === 'test:fail') { fail++; console.log('FAILED:', e.data && e.data.name); }
      }
      console.log('summary pass=' + pass + ' fail=' + fail);
      process.exit(fail > 0 ? 1 : 0);
    })();
  `;
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: 'inherit', timeout: 120000 });
    console.log(`iter ${i}: OK`);
  } catch (e) {
    fails++;
    console.log(`iter ${i}: RUN FAILED exit=${e.status}`);
  }
}
console.log(`probe done: ${fails}/${N} iterations had failures`);