(() => {
  'use strict';
  if (globalThis.__reaSpliceVolume) return;
  let service = null, zone = null;
  function getStatus() {
    const volume = service?.store?.volume();
    return Number.isFinite(volume) && volume >= 0 && volume <= 1
      ? { supported: true, volume } : { supported: false };
  }
  globalThis.__reaSpliceVolume = Object.freeze({
    bind(playback, angularZone) {
      service = playback; zone = angularZone;
      document.documentElement.classList.add('reasplice-volume-ready');
    },
    getStatus,
    async setVolume(volume) {
      if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('Invalid Splice volume');
      if (!getStatus().supported) throw new Error('Splice volume is not ready');
      if (globalThis.__reaSpliceBridge?.getEngineStatus()?.active) throw new Error('Bridge is now active; adjust its preview volume instead');
      // Use the same service and Angular zone as Splice's own volume control.
      // Its shared store handles playback-engine updates and persistence.
      zone.run(() => service.adjustVolume(volume));
      const deadline = Date.now() + 1500;
      while (Math.abs(getStatus().volume - volume) > 0.00001) {
        if (Date.now() >= deadline) throw new Error('Splice did not confirm its volume change');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return getStatus();
    }
  });
})();
