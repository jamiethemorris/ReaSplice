(function (root) {
  'use strict';
  function createBridgeVolumeController({ request, onChange = () => {}, onError = () => {} }) {
    let projectId = null, snapshot = null, pending = [], writing = false, revision = 0;
    const emit = () => onChange(snapshot ? { ...snapshot } : null);
    function updateProject(next) {
      if (projectId === next) return;
      projectId = next; snapshot = null; pending = []; revision++; emit();
    }
    async function refresh() {
      if (!projectId || writing || pending.length) return;
      const expected = projectId, generation = revision;
      try {
        const state = await request({});
        if (projectId !== expected || revision !== generation || state.projectId !== expected) return;
        snapshot = state.trackId && Number.isFinite(state.volume) ? state : null;
        emit();
      } catch (_) { /* Keep the last fader value; a later poll can recover. */ }
    }
    async function drain() {
      if (writing) return;
      writing = true;
      try {
        while (pending.length) {
          const change = pending.shift();
          try {
            const state = await request(change);
            if (!pending.length && projectId === change.projectId && snapshot?.trackId === change.trackId) {
              snapshot = state; emit();
            }
          } catch (error) {
            if (projectId === change.projectId) onError(error.message);
          }
        }
      } finally { writing = false; }
    }
    function changeControl(key, value) {
      if (!snapshot || snapshot.projectId !== projectId) return;
      revision++;
      snapshot = { ...snapshot, [key]: value };
      const change = { projectId, trackId: snapshot.trackId, [key]: value };
      const index = pending.findIndex(item => item.projectId === projectId && item.trackId === snapshot.trackId && key in item);
      if (index < 0) pending.push(change); else pending[index] = change;
      emit();
      void drain();
    }
    function setVolume(volume) {
      if (Number.isFinite(volume) && volume >= 0 && volume <= 4) changeControl('volume', volume);
    }
    function setSolo(solo) {
      if (typeof solo === 'boolean') changeControl('solo', solo);
    }
    return { updateProject, refresh, setVolume, setSolo };
  }
  if (typeof module === 'object' && module.exports) module.exports = createBridgeVolumeController;
  else root.createBridgeVolumeController = createBridgeVolumeController;
})(globalThis);
