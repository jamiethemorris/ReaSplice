(function (root) {
  'use strict';
  function createPreviewVolumeController({ writeSplice, writeBridge, onChange = () => {}, onError = () => {} }) {
    let context = {}, track = null, spliceVolume = null, pending = null, writing = false;
    function state() {
      const bridge = context.bridge?.connected === true;
      const source = bridge ? 'Bridge' : 'Splice';
      const key = `${source}:${context.sessionId}:${bridge ? context.projectId : context.surface}`;
      const volume = bridge ? track?.volume : spliceVolume;
      const available = bridge
        ? track?.projectId === context.projectId && context.bridge.projectId === context.projectId
        : Number.isFinite(volume);
      const enabled = !!(context.ready && !context.bridge?.busy && available);
      const value = bridge ? volume > 0 ? 20 * Math.log10(volume) : -60 : (volume ?? 0) * 100;
      const label = !enabled ? '—' : volume === 0 ? 'Muted' : bridge
        ? `${value > 0 ? '+' : ''}${value.toFixed(1)} dB` : `${Math.round(value)}%`;
      return { key, source, enabled, value, min: bridge ? -60 : 0, max: bridge ? 12 : 100, label };
    }
    const emit = () => onChange(state());
    function observe(next) {
      const previous = state().key;
      context = next;
      if (previous !== state().key) pending = null;
      if (!writing && !pending) spliceVolume = next.spliceVolume?.supported ? next.spliceVolume.volume : null;
      emit();
    }
    function observeTrack(next) { track = next; emit(); }
    async function drain() {
      if (writing) return;
      writing = true;
      try {
        while (pending) {
          const change = pending; pending = null;
          try {
            const result = await writeSplice(change.payload);
            if (!pending && state().key === change.key) spliceVolume = result.volume;
          } catch (error) {
            if (state().key === change.key) { spliceVolume = context.spliceVolume?.volume ?? null; onError(error.message); }
          }
        }
      } finally { writing = false; emit(); }
    }
    function setValue(value, key = state().key) {
      const current = state();
      // A drag or keyboard gesture begun on one output must never change the
      // other output if Bridge/project/view changes underneath it.
      if (!current.enabled || key !== current.key || !Number.isFinite(value) || value < current.min || value > current.max) return;
      if (current.source === 'Bridge') writeBridge(value <= -60 ? 0 : Math.pow(10, value / 20));
      else {
        spliceVolume = value / 100;
        pending = { key, payload: { volume: spliceVolume, sessionId: context.sessionId, surface: context.surface } };
        emit(); void drain();
      }
    }
    return { observe, observeTrack, setValue, state };
  }
  if (typeof module === 'object' && module.exports) module.exports = createPreviewVolumeController;
  else root.createPreviewVolumeController = createPreviewVolumeController;
})(globalThis);
