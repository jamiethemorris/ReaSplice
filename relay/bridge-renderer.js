(() => {
  'use strict';
  if (globalThis.__reaSpliceBridge) return;
  const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let pending = null;

  // Called only by the patched, genuine Splice Bridge button. The renderer
  // requests one fixed host action; it cannot choose a plugin, track or path.
  globalThis.__reaSpliceBridge = Object.freeze({
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
        component.playbackService.stop();
        await component.bridgePlaybackService.connect();
      }
      return true;
    }
  });
})();
