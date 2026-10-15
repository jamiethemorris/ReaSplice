'use strict';

const assert = require('node:assert/strict');
const createBridgeController = require('./bridge-controller');

function fixture({ mode = 'disconnect', connected = false, claim = 'A' } = {}) {
  const f = {
    projectId: 'A', events: [], messages: [], rendered: [],
    status: { supported: true, connected, projectId: connected ? claim : null, revision: 0, error: null }
  };
  f.controller = createBridgeController({
    readProject: async () => ({ projectId: f.projectId }),
    ensure: async (payload) => {
      f.events.push(['ensure', payload.projectId, payload.show]);
      if (f.onEnsure) await f.onEnsure(payload);
      return { projectId: payload.projectId };
    },
    control: async (payload) => {
      f.events.push([payload.type, payload.projectId, payload.ok]);
      if (f.onControl) await f.onControl(payload);
      if (payload.type === 'bridge-disconnect') {
        f.status = { ...f.status, connected: false, projectId: null, revision: f.status.revision + 1 };
      } else if (payload.type === 'bridge-connect' || (payload.type === 'bridge-result' && payload.ok)) {
        f.status = { ...f.status, connected: true, projectId: payload.projectId, revision: f.status.revision + 1 };
      }
      return { bridge: { ...f.status } };
    },
    onChange: (state) => f.rendered.push({ ...state }),
    onMessage: (message, error = false) => f.messages.push([message, error])
  });
  f.controller.updatePreferences({ switchMode: mode });
  f.controller.updateProject('A');
  f.controller.observe(f.status);
  f.switch = (id) => { f.projectId = id; f.controller.updateProject(id); };
  f.connections = () => f.events.filter(([type, , ok]) => type === 'bridge-connect' || (type === 'bridge-result' && ok));
  f.ensures = () => f.events.filter(([type]) => type === 'ensure');
  return f;
}

async function main() {
  {
    const f = fixture({ connected: true });
    f.switch('B');
    await f.controller.idle();
    assert.equal(f.status.connected, false, 'Default switch disconnects');
    assert.equal(f.ensures().length, 0, 'Default never creates a Bridge on switch');
  }
  {
    const f = fixture();
    f.controller.updatePreferences({ switchMode: 'follow' });
    f.switch('B');
    await f.controller.idle();
    assert.equal(f.events.length, 0, 'Opting in while disconnected does not connect');
  }
  {
    const f = fixture({ mode: 'follow', connected: true });
    f.switch('B');
    await f.controller.idle();
    assert.deepEqual(f.events.map(([type]) => type), ['bridge-disconnect', 'ensure', 'bridge-connect']);
    assert.deepEqual(f.ensures(), [['ensure', 'B', false]], 'Automatic connection does not open FX');
    assert.equal(f.status.projectId, 'B');
  }
  {
    const f = fixture({ connected: true, claim: null });
    await f.controller.idle();
    assert.equal(f.status.connected, false, 'Unclaimed startup connection is disconnected by default');
  }
  {
    const f = fixture({ connected: true, claim: null, mode: 'follow' });
    await f.controller.idle();
    assert.equal(f.status.projectId, 'A', 'Opted-in startup reestablishes the active preview track');
  }
  {
    const f = fixture();
    const request = { id: 'button-1' };
    f.controller.connectRequest(request);
    f.controller.connectRequest(request);
    await f.controller.idle();
    assert.deepEqual(f.ensures(), [['ensure', 'A', false]], 'Explicit button prepares the hidden track without opening FX');
    assert.equal(f.connections().length, 1);
    assert.equal(f.rendered.find((state) => state.connected)?.projectId, 'A', 'Only an observed successful handshake marks connected');
  }
  {
    const f = fixture({ mode: 'follow', connected: true });
    f.onEnsure = async ({ projectId }) => { if (projectId === 'B') { f.switch('C'); f.switch('D'); } };
    f.switch('B');
    await f.controller.idle();
    assert.deepEqual(f.connections().map(([, id]) => id), ['D'], 'A stale native setup never reconnects the wrong project');
    assert.equal(f.status.projectId, 'D');
  }
  {
    const f = fixture({ mode: 'follow', connected: true });
    f.onControl = async ({ type, projectId }) => { if (type === 'bridge-connect' && projectId === 'B') f.switch('C'); };
    f.switch('B');
    await f.controller.idle();
    const firstConnect = f.events.findIndex(([type]) => type === 'bridge-connect');
    assert.equal(f.events[firstConnect + 1][0], 'bridge-disconnect', 'A switch during handshake tears down its stale connection first');
    assert.equal(f.status.projectId, 'C');
  }
  {
    const f = fixture();
    f.onEnsure = async () => f.switch('B');
    f.controller.connectRequest({ id: 'stale-manual' });
    await f.controller.idle();
    assert.equal(f.connections().length, 0);
    assert.ok(f.events.some(([type, , ok]) => type === 'bridge-result' && ok === false), 'Cancelled button requests are acknowledged');
    assert.equal(f.status.connected, false);
  }
  {
    const f = fixture({ mode: 'follow', connected: true });
    f.onEnsure = async ({ projectId }) => {
      if (projectId === 'B') { f.projectId = 'C'; throw new Error('Active project changed'); }
    };
    f.switch('B');
    await f.controller.idle();
    assert.equal(f.status.projectId, 'C', 'Native rejection before the next tempo poll still follows the new project');
    assert.ok(!f.messages.some(([, error]) => error));
  }
  {
    const f = fixture();
    f.onEnsure = async () => { throw new Error('Bridge is not installed'); };
    await f.controller.connectRequest({ id: 'missing-plugin' });
    assert.equal(f.status.connected, false);
    assert.ok(f.messages.some(([text, error]) => error && text === 'Bridge is not installed'));
    assert.equal(f.connections().length, 0);
  }
  {
    const f = fixture({ connected: true, mode: 'follow' });
    await f.controller.disconnectRequest();
    f.switch('B');
    await f.controller.idle();
    assert.equal(f.connections().length, 0, 'Explicit disconnect cancels following');
    f.controller.observe({ supported: true, connected: true, projectId: 'A', revision: 0 });
    assert.equal(f.rendered.at(-1).connected, false, 'Older status cannot relight Bridge');
  }
  {
    const f = fixture();
    f.controller.observe({ ...f.status, sessionId: 'old-runtime', revision: 100 });
    f.controller.observe({ ...f.status, sessionId: 'new-runtime', revision: 1 });
    assert.equal(f.rendered.at(-1).sessionId, 'new-runtime', 'Restarted runtime resets stale revision ordering');
    assert.equal(f.rendered.at(-1).revision, 1);
  }
  console.log('Bridge viewer checks passed (13 scenarios).');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
