'use strict';
const assert = require('node:assert/strict');
const create = require('./preview-volume');
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  let context = { ready: true, bridge: { connected: false }, projectId: 'a', sessionId: 'runtime', surface: 'companion', spliceVolume: { supported: true, volume: .7 } };
  const writes = [], bridgeWrites = [], errors = [];
  const volume = create({
    writeSplice: payload => new Promise(resolve => writes.push({ payload, resolve })),
    writeBridge: value => bridgeWrites.push(value), onError: error => errors.push(error)
  });
  volume.observe(context);
  assert.equal(volume.state().label, '70%');
  const normalKey = volume.state().key;
  volume.setValue(50); volume.setValue(40); volume.setValue(30);
  assert.equal(writes.length, 1);
  volume.observe(context);
  assert.equal(volume.state().label, '30%', 'polls cannot reset a pending fader gesture');
  writes[0].resolve({ supported: true, volume: .5 }); await tick();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].payload.volume, .3, 'coalesce intermediate changes');
  context = { ...context, bridge: { connected: true, projectId: 'a' } };
  volume.observe(context);
  volume.observeTrack({ projectId: 'a', volume: 1 });
  assert.equal(volume.state().label, '0.0 dB');
  writes[1].resolve({ supported: true, volume: .3 }); await tick();
  assert.equal(volume.state().source, 'Bridge', 'late ordinary-volume reply cannot change the active output');
  volume.setValue(-6, normalKey);
  assert.equal(bridgeWrites.length, 0, 'gesture begun on Splice cannot modify Bridge');
  volume.setValue(-6);
  assert.ok(Math.abs(bridgeWrites[0] - Math.pow(10, -6 / 20)) < 1e-10);
  volume.setValue(-60); assert.equal(bridgeWrites[1], 0);
  const bridgeKey = volume.state().key;
  context = { ...context, projectId: 'b' }; volume.observe(context);
  assert.equal(volume.state().enabled, false, 'do not adjust a different project during handoff');
  volume.observeTrack({ projectId: 'b', volume: .5 });
  assert.equal(volume.state().enabled, false, 'wait for the actual Bridge project to match');
  context = { ...context, bridge: { connected: true, projectId: 'b' } }; volume.observe(context);
  volume.setValue(-20, bridgeKey); assert.equal(bridgeWrites.length, 2);
  context = { ...context, bridge: { connected: false }, spliceVolume: { supported: true, volume: .3 } }; volume.observe(context);
  assert.equal(volume.state().label, '30%', 'disconnect restores the independent Splice setting');
  volume.setValue(NaN); volume.setValue(101); volume.setValue(-1);
  assert.equal(writes.length, 2);
  volume.setValue(0); assert.equal(volume.state().label, 'Muted');
  writes[2].resolve({ supported: true, volume: 0 }); await tick();
  volume.observe({ ...context, ready: false }); assert.equal(volume.state().enabled, false);
  assert.deepEqual(errors, []);
  console.log('Preview volume checks passed: output switching, independent levels, coalescing, muted state, and stale gesture/project guards.');
})().catch(error => { console.error(error); process.exitCode = 1; });
