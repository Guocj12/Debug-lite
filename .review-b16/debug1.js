'use strict';
const runner = require('../server/runner.js');
const ast = require('../server/ai/ast.js');
const FIX = require('../tests/fixtures/ai-programs.json');

const a1 = JSON.parse(JSON.stringify(FIX.a1Countdown));
const c = runner.compileAi(a1, undefined);
console.log('compile a1Countdown:', c.status, c.code || '', JSON.stringify(c.details || {}));
console.log('validate a1:', JSON.stringify(ast.validate(a1, 'mythic'), null, 1));

const burn = JSON.parse(JSON.stringify(FIX.pBurnSteps));
const b = runner.runAiBattle({ program: burn, seed: 7, tier: 'mythic' });
console.log('battle pBurnSteps:', b.status, b.code, JSON.stringify(b.details));
console.log('validate burn:', JSON.stringify(ast.validate(burn, 'mythic'), null, 1));