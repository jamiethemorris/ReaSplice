'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(`${__dirname}/bridge-renderer.js`, 'utf8'), context);
const api = context.__reaSpliceBridge;
let stops = 0, connects = 0;
const component = {
  isBridgeCoachMarkOpen: true, isBridgeSuspended: true,
  playbackService: { stop() { stops++; } },
  bridgePlaybackService: { async connect() { connects++; } }
};
(async () => {
  const listeners = {};
  let finishStop;
  const engine = {
    isActive$: { value: false, next(value) { this.value = value; } },
    bridgeSupportsPreviewDownload$: { next() {} },
    betterIpcRenderer: { on(name, handler) { listeners[name] = handler; } },
    stop: () => new Promise(resolve => { finishStop = resolve; })
  };
  api.bindEngine(engine);
  listeners['vst-connection-enabled'](null, { previewDownload: true });
  const lost = listeners['vst-connection-lost']();
  listeners['vst-connection-enabled'](null, { previewDownload: true });
  finishStop(); await lost;
  assert.equal(api.getEngineStatus().active, true, 'late disconnect completion cannot disable a newer connection');
  const finalLost = listeners['vst-connection-lost'](); finishStop(); await finalLost;
  assert.equal(api.getEngineStatus().active, false, 'a genuine final disconnect disables the engine');
  api.request(component);
  const first = api.getRequest().id;
  api.request(component);
  assert.equal(api.getRequest().id, first, 'rapid clicks coalesce');
  assert.equal(await api.complete('stale', true), false);
  assert.equal(await api.complete(first, false), true);
  assert.equal(connects, 0, 'native failure must not connect');
  api.request(component);
  const second = api.getRequest().id;
  assert.notEqual(second, first);
  await api.complete(second, true);
  assert.equal(api.getRequest(), null);
  assert.equal(stops, 0); assert.equal(connects, 0, 'renderer completion must not initiate another connection');
  assert.equal(component.isBridgeSuspended, false);
  assert.equal(component.isBridgeCoachMarkOpen, false);
  await api.complete(second, true);
  assert.equal(connects, 0, 'duplicate completion must not reconnect');
  console.log('Bridge renderer checks passed: click coalescing, stale replies, native errors, completion without optimistic connection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
