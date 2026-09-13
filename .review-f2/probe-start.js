(async () => {
  const mod = await import('../public/js/app.js');
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a);
  try {
    const p = mod.start({
      log: {
        info: () => { throw new Error('boom'); },
        warn: () => {}, debug: () => {}, error: () => {},
        setLevel: () => {}, setChannelLevel: () => {},
      },
      loadPersist: () => null,
      fetchImpl: () => Promise.reject(new Error('x')),
    });
    await p;
  } finally {
    console.error = orig;
  }
  console.log('errs:', errs.length);
})().catch((e) => { console.error('top', e); process.exit(1); });
