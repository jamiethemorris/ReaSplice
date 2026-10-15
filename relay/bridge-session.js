'use strict';

// Bounded access to Splice's own connection manager. No renderer code or paths
// are accepted from callers, and connection state is never inferred from a click.
module.exports = function bridgeSession({ connectTimeout = 4000, stopTimeout = 750 } = {}) {
  const sessionId = require('node:crypto').randomUUID();
  let manager = null, subscription = null;
  let connected = false, projectId = null, error = null, revision = 0;
  let queue = Promise.resolve();
  const bounded = (operation, milliseconds, message) => {
    let timer;
    return Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })
    ]).finally(() => clearTimeout(timer));
  };
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const status = () => ({ supported: !!manager, connected, projectId, error, revision, sessionId });
  async function disconnect() {
    if (!manager) throw new Error('Rebuild and relaunch ReaSplice to update Bridge support.');
    projectId = null;
    error = null;
    try { await bounded(manager.sendStop(), stopTimeout, 'Bridge did not stop in time.'); }
    catch (_) { /* A non-processing project must not prevent disconnection. */ }
    manager.disconnect();
    revision++;
    return status();
  }
  return {
    attach(value) {
      subscription?.unsubscribe();
      manager = value;
      projectId = null;
      subscription = manager.isVstConnected$.subscribe(value => {
        connected = value === true;
        if (!connected) projectId = null;
        revision++;
      });
    },
    status,
    disconnect: () => serial(disconnect),
    connect(id) {
      if (typeof id !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(id)) return Promise.reject(new Error('Invalid Bridge project.'));
      return serial(async () => {
        await disconnect();
        const attempt = Promise.resolve(manager.tryInitVstConnection());
        const client = manager.client;
        let expired = false;
        // A late ping after our timeout must not revive an unclaimed connection.
        attempt.then(() => { if (expired && manager.client === client) manager.disconnect(); }, () => {});
        try {
          // A freshly loaded plugin announces its new port asynchronously. The
          // first ping may still target the just-unloaded instance. Keep waiting
          // for Splice's real connection event within the same bounded window.
          const handshake = (async () => {
            await attempt;
            while (!connected && !expired) await new Promise(resolve => setTimeout(resolve, Math.min(40, connectTimeout / 4)));
          })();
          await bounded(handshake, connectTimeout, 'Bridge did not connect. Click Bridge to retry.');
          projectId = id;
          error = null;
          revision++;
          return status();
        } catch (problem) {
          expired = true;
          manager.disconnect();
          error = String(problem.message || problem).slice(0, 240);
          revision++;
          throw problem;
        }
      });
    }
  };
};
