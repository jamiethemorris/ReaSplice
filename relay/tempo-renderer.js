/* ReaSplice's project-tempo policy for Splice 5.4.13's sample search presenter.
 * Prepend this file to each private copy's desktop main/companion bundle,
 * then insert the two register/unregister hooks in its shared search presenter.
 * Uses the app's Angular router and NgZone; no network or account API override.
 */
(() => {
  'use strict';
  if (globalThis.__reaSpliceTempo) return;

  const MIN_BPM = 1;
  const MAX_BPM = 300; // Shipped sp-filter-bpm input/slider constraints.
  const presenters = new Map();
  const updaters = new Map();
  const routers = new Map();
  let policy = null;
  let revision = 0;
  let scheduled = false;
  let applying = false;
  let applyAgain = false;
  let error = null;
  const clamp = n => Math.min(MAX_BPM, Math.max(MIN_BPM, n));

  function normalize(input) {
    if (!input || !['none', 'exact', 'range'].includes(input.mode)) {
      throw new Error('Invalid tempo filter mode.');
    }
    const bpm = Number(input.bpm);
    const range = Number(input.range);
    if (input.mode !== 'none' && (!Number.isFinite(bpm) || bpm <= 0)) {
      throw new Error('Project tempo is unavailable.');
    }
    if (input.mode === 'range' && (!Number.isFinite(range) || range < 1 || range > 100)) {
      throw new Error('Tempo range must be between 1 and 100 BPM.');
    }
    const next = {
      mode: input.mode,
      bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
      range: Number.isFinite(range) && range >= 1 && range <= 100 ? range : 10,
      effectiveBpm: null,
      min: null,
      max: null,
      query: {bpm: null, min_bpm: null, max_bpm: null},
    };
    if (next.mode === 'exact') {
      next.effectiveBpm = clamp(Math.round(bpm));
      next.query.bpm = String(next.effectiveBpm);
    } else if (next.mode === 'range') {
      next.min = clamp(Math.ceil(bpm - range));
      next.max = clamp(Math.floor(bpm + range));
      next.query.min_bpm = next.min;
      next.query.max_bpm = next.max;
    }
    return next;
  }

  function matches(params) {
    if (!policy) return true;
    const comparable = value => value == null || value === '' ? null : String(value);
    return Object.keys(policy.query).every(key => comparable(params?.[key]) === comparable(policy.query[key]));
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    // Run after the current Angular navigation/constructor completes.
    setTimeout(() => { scheduled = false; void enforce(); }, 0);
  }

  async function enforce() {
    if (!policy) return;
    if (applying) { applyAgain = true; return; }
    applying = true;
    try {
      // One URL update per router; multiple sample lists can share its query.
      const activeByRouter = new Map();
      for (const [presenter, record] of presenters) activeByRouter.set(record.router, presenter);
      for (const presenter of activeByRouter.values()) {
        const record = presenters.get(presenter);
        if (!record || matches(record.updater.route?.snapshot?.queryParams)) continue;
        // This is the same path as SamplesSearchComponent.updateBpm(). It
        // resets pagination and incompatible column sorting, merges unrelated
        // query params, and executes router.navigate inside the app's NgZone.
        await presenter.updateQuery({...policy.query, ...presenter.removeColumnSort()});
      }
      error = null;
    } catch (_) {
      // Never return route contents, filenames, typed text, or account state.
      error = 'Splice could not apply the tempo filter on this page.';
    } finally {
      applying = false;
      if (applyAgain) { applyAgain = false; schedule(); }
    }
  }

  function register(presenter) {
    if (!presenter || presenter.assetType !== 'sample' || presenters.has(presenter)) return;
    const updater = presenter.paramsUpdater;
    const router = updater?.router;
    if (!router?.events?.subscribe || !updater.route || typeof updater.updateQuery !== 'function' ||
        typeof presenter.updateQuery !== 'function' || typeof presenter.removeColumnSort !== 'function') return;

    let updaterRecord = updaters.get(updater);
    if (!updaterRecord) {
      const originalUpdate = updater.updateQuery;
      // One wrapper per updater, even when Angular scopes share that updater
      // between presenters. Restore it only after its last presenter leaves.
      const policyUpdate = function(query, options) {
        return originalUpdate.call(this, policy ? {...query, ...policy.query} : query, options);
      };
      updater.updateQuery = policyUpdate;
      updaterRecord = {originalUpdate, policyUpdate, count: 0};
      updaters.set(updater, updaterRecord);
    }
    updaterRecord.count++;
    presenters.set(presenter, {updater, router});
    let routeRecord = routers.get(router);
    if (!routeRecord) {
      const subscription = router.events.subscribe(event => {
        // Angular's NavigationEnd EventType is 1 in both shipped renderers.
        if (event?.type === 1) schedule();
      });
      routeRecord = {subscription, count: 0};
      routers.set(router, routeRecord);
    }
    routeRecord.count++;
    schedule();
  }

  function unregister(presenter) {
    const record = presenters.get(presenter);
    if (!record) return;
    presenters.delete(presenter);
    const updaterRecord = updaters.get(record.updater);
    if (updaterRecord && --updaterRecord.count === 0) {
      if (record.updater.updateQuery === updaterRecord.policyUpdate) record.updater.updateQuery = updaterRecord.originalUpdate;
      updaters.delete(record.updater);
    }
    const routeRecord = routers.get(record.router);
    if (routeRecord && --routeRecord.count === 0) {
      routeRecord.subscription.unsubscribe();
      routers.delete(record.router);
    }
  }

  function settingsAnchor() {
    const row = globalThis.document?.querySelector('core-top-bar .drag-handle');
    const settings = row?.querySelector('.drag-handle__settings');
    if (!row || !settings) return null;
    const bounds = row.getBoundingClientRect();
    const settingsBounds = settings.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || settingsBounds.width <= 0) return null;
    return {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      availableWidth: Math.max(0, settingsBounds.left - bounds.left),
    };
  }

  function getStatus() {
    const row = settingsAnchor();
    const active = [...presenters.values()].at(-1);
    const actualParams = active?.updater.route?.snapshot?.queryParams;
    const numericValue = value => value != null && /^\d{1,3}(?:\.\d{1,6})?$/.test(String(value)) ? String(value) : null;
    const currentQuery = actualParams ? {
      bpm: numericValue(actualParams.bpm),
      min_bpm: numericValue(actualParams.min_bpm),
      max_bpm: numericValue(actualParams.max_bpm),
    } : null;
    return {
      installed: true,
      supported: true,
      ready: presenters.size > 0,
      sampleSearchActive: presenters.size > 0,
      mode: policy?.mode ?? 'none',
      bpm: policy?.bpm ?? null,
      range: policy?.range ?? 10,
      effectiveBpm: policy?.effectiveBpm ?? null,
      min: policy?.min ?? null,
      max: policy?.max ?? null,
      query: policy ? {...policy.query} : null,
      currentQuery,
      matchesPolicy: !!actualParams && !!policy && matches(actualParams),
      limits: {min: MIN_BPM, max: MAX_BPM},
      revision,
      applying,
      error,
      settingsRow: !!row,
      row,
    };
  }

  function setPolicy(input) {
    const next = normalize(input);
    if (JSON.stringify(next) !== JSON.stringify(policy)) {
      policy = next;
      revision++;
      error = null;
      schedule();
    }
    return getStatus();
  }

  globalThis.__reaSpliceTempo = Object.freeze({register, unregister, setPolicy, getStatus});
})();
