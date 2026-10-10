'use strict';

// Offline contract checks. No Splice process, network listener, session files,
// credentials, or actual audio files are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const bootstrap = fs.readFileSync(path.join(__dirname, 'bootstrap.js'), 'utf8');
const app = new EventEmitter();
const ipcMain = { handle() {} };
const server = new EventEmitter();
server.listen = () => {};
server.close = () => {};
let handler;
const context = {
  require(name) {
    if (name === 'electron') return { app, ipcMain };
    if (name === './index.js') return {};
    if (name === 'node:http') return { createServer(fn) { handler = fn; return server; } };
    if (name === 'node:fs') return {
      readFileSync(file) {
        if (file.endsWith('dock-options.json')) return '{"configPath":"/unused-relay-config"}';
        if (file === '/unused-relay-config') return '{"token":"unit-test-only-token","port":17864}';
        throw new Error(`Unexpected file read: ${file}`);
      },
      statSync() { throw new Error('No actual audio files in contract check'); }
    };
    return require(name);
  },
  __dirname: '/private-copy', Buffer, URL, console,
  process: { env: {} }, setInterval() { return 1; }, clearInterval() {}
};
vm.createContext(context);
vm.runInContext(bootstrap + '\nglobalThis.__test = {control, status, authenticate, handlers, windows};', context);
const test = context.__test;
const hooks = context.__spliceDock;
const normalize = value => JSON.parse(JSON.stringify(value));

async function check() {
  assert.deepEqual(normalize(hooks.filterWindowState('main', { dimensions: { width: 250 }, isOpen: false, alwaysOnTop: true })), { alwaysOnTop: true });
  assert.deepEqual(normalize(hooks.filterWindowState('settings', { dimensions: { width: 250 } })), { dimensions: { width: 250 } });
  assert.equal(test.authenticate({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:17864' } }, new URL('http://127.0.0.1/status?token=wrong')), false);
  assert.equal(test.authenticate({ socket: { remoteAddress: '192.0.2.1' }, headers: { host: '127.0.0.1:17864' } }, new URL('http://127.0.0.1/status?token=unit-test-only-token')), false);
  assert.equal(test.authenticate({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'attacker.invalid:17864' } }, new URL('http://127.0.0.1/status?token=unit-test-only-token')), false);
  assert.equal(test.authenticate({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:17864' } }, new URL('http://127.0.0.1/status?token=unit-test-only-token')), true);
  await assert.rejects(test.control({ type: 'evaluate', code: 'process.exit()' }), /Unsupported command/);
  await assert.rejects(test.control({ type: 'resize', width: NaN, height: 300 }), /Invalid viewport/);
  for (const patch of [{ mode: 'unknown' }, { bpm: NaN }, { bpm: 0 }, { bpm: '120' }, { range: 0 }, { range: 101 }]) {
    await assert.rejects(test.control({ type: 'tempo', mode: 'range', bpm: 120, range: 10, ...patch }), /Invalid BPM preference/);
  }
  await test.control({ type: 'resize', width: -20, height: 9000 });
  assert.equal(test.status().width, 240);
  assert.equal(test.status().height, 1800);

  const sent = [];
  const wc = new EventEmitter();
  Object.assign(wc, { isDestroyed: () => false, setBackgroundThrottling() {}, isOffscreen: () => true, setFrameRate() {}, invalidate() {}, startDrag() {},
    debugger: { isAttached: () => false, attach() {}, async sendCommand(method, payload) { sent.push({ method, payload }); } },
    async capturePage() { return { isEmpty: () => true }; } });
  const win = new EventEmitter();
  let size = [400, 800];
  Object.assign(win, { webContents: wc, isDestroyed: () => false, getBounds: () => ({ x: 1, y: 2, width: 400, height: 800 }), getContentSize: () => size,
    setContentSize(w, h) { size = [w, h]; }, setMinimumSize() {}, setMaximumSize() {}, hide() {}, setBounds() {}, show() {} });
  hooks.windowCreated('companion', win);
  test.windows.get('companion').loaded = true;
  await test.control({ type: 'input', event: { type: 'mouseDown', x: 45, y: 72, button: 'left' } });
  await test.control({ type: 'input', event: { type: 'mouseMove', x: 49, y: 73 } });
  await test.control({ type: 'input', event: { type: 'mouseUp', x: 49, y: 73, button: 'left' } });
  const mouse = sent.filter(item => item.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouse.map(item => item.payload.buttons), [1, 1, 0]);
  assert.equal(mouse[1].payload.button, 'left');
  await test.control({ type: 'input', event: { type: 'mouseWheel', x: 10, y: 10, deltaY: -50 } });
  assert.equal(sent.at(-1).payload.deltaY, 50);
  await test.control({ type: 'input', event: { type: 'keyDown', keyCode: 'Backspace' } });
  assert.equal(sent.at(-1).payload.windowsVirtualKeyCode, 8);
  await test.control({ type: 'input', event: { type: 'keyDown', keyCode: 'Enter' } });
  assert.equal(sent.at(-1).payload.text, '\r');
  await test.control({ type: 'surface', surface: 'main' });
  assert.equal(test.status().surfaceReason, 'control');
  win.emit('show');
  assert.equal(test.status().surface, 'main', 'ordinary window show cannot replace the requested surface');
  await test.control({ type: 'surface', surface: 'companion' });
  wc.startDrag({ files: ['/nonexistent-audio.wav'] });
  const diagnosticStatus = test.status(true);
  assert.equal(diagnosticStatus.diagnostics.dragRequests, 1);
  assert.equal(diagnosticStatus.diagnostics.dragRejected, 1);
  assert.equal(diagnosticStatus.diagnostics.inputReceived.mouseDown, 1);
  assert.equal(diagnosticStatus.diagnostics.inputDispatched.mouseDown, 1);
  assert.equal(diagnosticStatus.diagnostics.mouseMovesWithButton, 1);
  assert.equal(JSON.stringify(diagnosticStatus.diagnostics).includes('nonexistent'), false);
  assert.equal('diagnostics' in test.status(), false);
  await assert.rejects(test.control({ type: 'input', event: { type: '__proto__' } }), /Unsupported input/);
  assert.equal(typeof handler, 'function');
  app.emit('before-quit');
  console.log('Relay contract checks passed: local authorization, bounded controls, geometry filtering, drag buttons, wheel/key dispatch.');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
