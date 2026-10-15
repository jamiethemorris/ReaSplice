/* Keep all Bridge transitions in one queue. Project reads guard both sides of
   native setup and the app's asynchronous connection handshake. */
(function (root, factory) {
  const create = factory();
  if (typeof module === 'object' && module.exports) module.exports = create;
  else root.createBridgeController = create;
})(typeof window === 'object' ? window : globalThis, () => {
  'use strict';

  return function createBridgeController({ readProject, ensure, control, onChange = () => {}, onMessage = () => {} }) {
    let projectId = null;
    let switchMode = 'disconnect';
    let state = { supported: false, connected: false, projectId: null, error: null, revision: -1 };
    let epoch = 0;
    let wanted = false;
    let work = Promise.resolve();
    let jobs = 0;
    let reconcileQueued = false;
    let lastMismatch = '';
    const handled = new Set();

    const emit = () => onChange({ ...state, busy: jobs > 0, switchMode });
    const stale = () => Object.assign(new Error('The active project changed. Bridge was disconnected.'), { stale: true });

    function observe(next) {
      if (!next || !Number.isFinite(next.revision)) return;
      if (next.sessionId && state.sessionId && next.sessionId !== state.sessionId) {
        epoch++;
        wanted = false;
        lastMismatch = '';
        state = { revision: -1 };
      }
      if (next.revision < state.revision) return;
      state = { ...next, connected: next.connected === true };
      emit();
      if (jobs || !projectId) return;
      wanted = state.connected;
      if (state.connected && state.projectId !== projectId) {
        const mismatch = `${epoch}:${state.revision}:${state.projectId}`;
        if (mismatch === lastMismatch) return;
        lastMismatch = mismatch;
        wanted = switchMode === 'follow';
        scheduleReconcile();
      }
    }

    async function command(payload) {
      const result = await control(payload);
      if (result?.bridge) observe(result.bridge);
      return result;
    }

    function enqueue(action) {
      jobs++;
      emit();
      const task = work.catch(() => {}).then(action);
      work = task.catch((error) => onMessage(error.message || 'Bridge could not complete that action.', true)).finally(() => {
        jobs--;
        emit();
      });
      return work;
    }

    function updateProject(nextId) {
      if (!nextId || nextId === projectId) return;
      const wasActive = wanted || state.connected;
      projectId = nextId;
      epoch++;
      lastMismatch = '';
      if (wasActive) {
        wanted = switchMode === 'follow';
        scheduleReconcile();
      }
    }

    async function guard(expectedId, revision) {
      const current = await readProject();
      updateProject(current?.projectId);
      if (!current?.projectId || expectedId !== current.projectId || revision !== epoch) throw stale();
    }

    async function disconnect() {
      await command({ type: 'bridge-disconnect' });
    }

    async function connectTo(expectedId, revision, requestId) {
      let acknowledged = false;
      try {
        await guard(expectedId, revision);
        await disconnect();
        await guard(expectedId, revision);
        const result = await ensure({ projectId: expectedId, show: false });
        if (result.projectId !== expectedId) throw stale();
        await guard(expectedId, revision);
        acknowledged = true;
        await command(requestId
          ? { type: 'bridge-result', id: requestId, ok: true, projectId: expectedId }
          : { type: 'bridge-connect', projectId: expectedId });
        await guard(expectedId, revision);
        if (!state.connected || state.projectId !== expectedId) throw new Error('Splice Bridge did not connect. Try the Bridge button again.');
        wanted = true;
        if (requestId) onMessage('Splice Bridge is connected. The top volume control now adjusts Bridge.');
      } catch (error) {
        if (!error.stale) {
          try { await guard(expectedId, revision); }
          catch (guardError) { if (guardError.stale) error = guardError; }
        }
        // A project can change during the connection handshake. Always tear
        // that connection down before allowing the queued latest target to run.
        await disconnect().catch(() => {});
        if (!acknowledged && requestId) await command({ type: 'bridge-result', id: requestId, ok: false }).catch(() => {});
        if (!error.stale) { wanted = false; throw error; }
        if (requestId && switchMode !== 'follow') onMessage(error.message);
      }
    }

    function scheduleReconcile() {
      if (reconcileQueued) return;
      reconcileQueued = true;
      enqueue(async () => {
        reconcileQueued = false;
        const expectedId = projectId;
        const revision = epoch;
        if (wanted && switchMode === 'follow' && expectedId) await connectTo(expectedId, revision);
        else {
          await disconnect();
          if (revision === epoch) onMessage('Bridge disconnected. Samples use Splice’s audio output.');
        }
      });
    }

    return {
      observe,
      updateProject,
      updatePreferences(preferences) {
        switchMode = preferences?.switchMode === 'follow' ? 'follow' : 'disconnect';
        emit();
        // Choosing Follow while disconnected does not start Bridge.
      },
      connectRequest(request) {
        if (!request?.id || handled.has(request.id)) return work;
        handled.add(request.id);
        if (handled.size > 100) handled.delete(handled.values().next().value);
        const expectedId = projectId;
        const revision = ++epoch;
        wanted = true;
        return enqueue(async () => {
          if (!expectedId) {
            wanted = false;
            await command({ type: 'bridge-result', id: request.id, ok: false });
            throw new Error('The current REAPER project is not available yet. Try Bridge again.');
          }
          onMessage('Connecting Splice Bridge to this project…');
          await connectTo(expectedId, revision, request.id);
        });
      },
      disconnectRequest() {
        epoch++;
        wanted = false;
        return enqueue(async () => {
          await disconnect();
          onMessage('Bridge disconnected. Samples use Splice’s audio output.');
        });
      },
      reset() {
        epoch++;
        wanted = false;
        state = { supported: false, connected: false, projectId: null, error: null, revision: -1 };
        lastMismatch = '';
        emit();
      },
      async idle() {
        // Tests can wait for reconciliation scheduled during a project guard.
        let current;
        do { current = work; await current; } while (current !== work);
      }
    };
  };
});
