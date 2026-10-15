(() => {
  'use strict';
  if (globalThis.__reaSpliceBridge) return;
  const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let pending = null;
  let engine = null;

  // Called only by the patched, genuine Splice Bridge button. The renderer
  // requests one fixed host action; it cannot choose a plugin, track or path.
  globalThis.__reaSpliceBridge = Object.freeze({
    bindEngine(value) {
      engine = value;
      let revision = 0;
      value.betterIpcRenderer.on('vst-connection-enabled', (_event, { previewDownload }) => {
        revision++;
        value.bridgeSupportsPreviewDownload$.next(previewDownload);
        value.isActive$.next(true);
      });
      value.betterIpcRenderer.on('vst-connection-lost', async () => {
        const disconnected = ++revision;
        try { await value.stop(); }
        finally {
          // Splice's original async stop can finish after the next connection
          // event. Only the latest event may change the playback engine state.
          if (revision === disconnected) value.isActive$.next(false);
        }
      });
    },
    getEngineStatus() {
      return engine ? { active: engine.isActive$.value === true } : null;
    },
    request(component) {
      if (pending && Date.now() - pending.created < 90000) return;
      component.isBridgeCoachMarkOpen = false;
      pending = { id: `${session}-${++sequence}`, created: Date.now(), component };
    },
    getRequest() {
      if (pending && Date.now() - pending.created >= 90000) pending = null;
      return pending ? { id: pending.id } : null;
    },
    async complete(id, ok) {
      if (!pending || pending.id !== id) return false;
      const { component } = pending;
      pending = null;
      if (ok) {
        component.isBridgeSuspended = false;
        component.isBridgeCoachMarkOpen = false;
        // The main-process handoff already observed Splice's real connection.
        // Its IPC updates drive the original icon and playback-engine state.
      }
      return true;
    }
  });
})();
