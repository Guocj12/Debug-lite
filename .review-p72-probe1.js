const { openFixture, registerPlayer, makeLogger, PASSWORD } = require('./tests/helpers/account.js');
(async () => {
  const fx = await openFixture({ logger: makeLogger() });
  console.log('auth cfg:', JSON.stringify(fx.auth.config));
  const u = await registerPlayer(fx.auth, { username: 'Lock_1', ip: '8.8.8.8' });
  console.log('register ok', u.res.ok, u.res.code);
  for (let i = 1; i <= 5; i++) {
    const r = await fx.auth.login({ username: 'Lock_1', password: 'wrong-pass', ip: '8.8.8.8' });
    console.log('fail', i, r.code, 'limiter:', JSON.stringify(fx.auth.limiter.lockedUntil('lock_1')), fx.auth.limiter.stats());
  }
  console.log('events:', fx.events().join(','));
  const r6 = await fx.auth.login({ username: 'Lock_1', password: PASSWORD, ip: '8.8.8.8' });
  console.log('sixth:', r6.code, r6.status);
  await fx.cleanup();
})().catch(e => { console.error(e); process.exit(1); });
