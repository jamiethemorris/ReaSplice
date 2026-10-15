'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let current = .7, bridge = false, inZone = false;
const context = vm.createContext({
  setTimeout,
  document: { documentElement: { classList: { add(name) { assert.equal(name, 'reasplice-volume-ready'); } } } },
  __reaSpliceBridge: { getEngineStatus: () => ({ active: bridge }) }
});
vm.runInContext(fs.readFileSync(`${__dirname}/volume-renderer.js`, 'utf8'), context);
const api = context.__reaSpliceVolume;
(async () => {
  assert.equal(api.getStatus().supported, false);
  api.bind({ store: { volume: () => current }, adjustVolume(value) { assert.equal(inZone, true); setTimeout(() => { current = value; }, 5); } },
    { run(fn) { inZone = true; fn(); inZone = false; } });
  assert.equal(api.getStatus().volume, .7);
  assert.equal((await api.setVolume(.4)).volume, .4, 'wait for the real shared store to confirm');
  assert.equal((await api.setVolume(0)).volume, 0);
  for (const value of [NaN, Infinity, -1, 1.01, '0.5', null]) await assert.rejects(api.setVolume(value), /Invalid/);
  bridge = true;
  await assert.rejects(api.setVolume(.8), /Bridge is now active/);
  assert.equal(current, 0, 'Bridge activation cannot alter the remembered ordinary volume');
  console.log('Splice volume checks passed: shared-store confirmation, Angular zone, validation, and Bridge guard.');
})().catch(error => { console.error(error); process.exitCode = 1; });
