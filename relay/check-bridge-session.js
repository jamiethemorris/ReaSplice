'use strict';
const assert = require('node:assert/strict');
const createSession = require('./bridge-session');

async function check() {
  const session = createSession({ connectTimeout: 25, stopTimeout: 10 });
  let notify, disconnects = 0, connects = 0, hangingStop = false, connect;
  const manager = {
    isVstConnected$: { subscribe(fn) { notify = fn; fn(false); return { unsubscribe() {} }; } },
    sendStop() { return hangingStop ? new Promise(() => {}) : Promise.resolve(); },
    disconnect() { disconnects++; notify(false); },
    tryInitVstConnection() { connects++; this.client = {}; return connect(); }
  };
  assert.equal(session.status().supported, false);
  session.attach(manager);
  await assert.rejects(session.connect('../invalid'), /Invalid Bridge project/);
  assert.equal(connects, 0);

  let finish;
  connect = () => new Promise(resolve => { finish = () => { notify(true); resolve(); }; });
  const pending = session.connect('project-a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.status().connected, false, 'requesting a connection does not turn the icon blue');
  assert.equal(session.status().projectId, null);
  finish();
  assert.equal((await pending).projectId, 'project-a');
  assert.equal(session.status().connected, true);

  connect = async () => { notify(true); };
  assert.equal((await session.connect('project-b')).projectId, 'project-b');
  assert.equal(disconnects, 2, 'a new project must break the old connection, even if already active');
  notify(false);
  assert.equal(session.status().projectId, null, 'actual connection loss invalidates the project claim');

  hangingStop = true;
  await session.disconnect();
  assert.equal(session.status().connected, false, 'unresponsive playback must not prevent disconnection');
  hangingStop = false;
  connect = async () => {};
  await assert.rejects(session.connect('no-handshake'), /did not connect/);
  assert.equal(session.status().connected, false);
  assert.equal(session.status().projectId, null);

  connect = () => new Promise(resolve => { finish = () => { notify(true); resolve(); }; });
  await assert.rejects(session.connect('timeout'), /did not connect/);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.status().connected, false, 'late completion after timeout must not revive Bridge');
  assert.equal(session.status().projectId, null);
  connect = async () => { setTimeout(() => notify(true), 5); };
  // A new plugin port can arrive after the old-port ping has already returned.
  assert.equal((await session.connect('new-port')).projectId, 'new-port');
  assert.equal(session.status().connected, true);
  console.log('Bridge session checks passed: observed connection state, fresh handoff, stop/connect timeouts, late replies.');
}
check().catch(error => { console.error(error); process.exitCode = 1; });
