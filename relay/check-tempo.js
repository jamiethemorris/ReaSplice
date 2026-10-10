#!/usr/bin/env node
'use strict';

// Offline contract tests: no Electron process, account, network, or app files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'tempo-renderer.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const timers = [];
  const context = vm.createContext({setTimeout(fn) { timers.push(fn); }, document: {querySelector() { return null; }}});
  vm.runInContext(source, context, {filename: 'tempo-renderer.js'});
  return {
    api: context.__reaSpliceTempo,
    context,
    async settle() {
      for (let i = 0; i < 50; i++) {
        for (const fn of timers.splice(0)) fn();
        await new Promise(resolve => setImmediate(resolve));
        if (!timers.length && !context.__reaSpliceTempo.getStatus().applying) return;
      }
      assert.fail('Tempo policy failed to settle; possible navigation loop.');
    },
  };
}

function searchPage(initial = {}, sharedRouter) {
  const listeners = new Set();
  const router = sharedRouter || {
    listeners, subscriptions: 0, unsubscriptions: 0,
    events: {
      subscribe(fn) {
        router.subscriptions++;
        listeners.add(fn);
        return {unsubscribe() { router.unsubscriptions++; listeners.delete(fn); }};
      },
    },
    emit(type = 1) { for (const fn of listeners) fn({type}); },
  };
  const route = {snapshot: {queryParams: {...initial}}};
  const calls = [];
  const updater = {
    router, route,
    async updateQuery(query, options) {
      assert.equal(this, updater, 'Original updater must retain its receiver.');
      calls.push({query: plain(query), options: plain(options || {})});
      for (const [key, value] of Object.entries(query)) {
        if (value == null) delete route.snapshot.queryParams[key];
        else route.snapshot.queryParams[key] = value;
      }
      router.emit();
      return true;
    },
  };
  function presenter(assetType = 'sample') {
    return {
      assetType, paramsUpdater: updater,
      removeColumnSort() { return {column_sort: null, order: null}; },
      updateQuery(query) { return this.paramsUpdater.updateQuery({...query, page: null}, {replaceUrl: true}); },
    };
  }
  return {router, route, updater, calls, presenter, params: () => route.snapshot.queryParams};
}

const tests = [];
function test(name, run) { tests.push({name, run}); }

test('initial state and non-sample pages leave native filters alone', async () => {
  const h = harness(), page = searchPage({bpm: '88'}), sample = page.presenter();
  const initial = h.api.getStatus();
  assert.equal(initial.installed, true);
  assert.equal(initial.supported, true);
  assert.equal(initial.ready, false);
  assert.equal(initial.range, 10);
  h.api.register(page.presenter('preset'));
  h.api.register(null);
  h.api.register({assetType: 'sample'});
  assert.equal(h.api.getStatus().sampleSearchActive, false);
  h.api.register(sample);
  await h.settle();
  assert.equal(page.calls.length, 0);
  assert.equal(page.params().bpm, '88');
  h.api.unregister(sample);
});

test('exact rounds, preserves other filters, clears conflicting bounds and pagination', async () => {
  const h = harness(), page = searchPage({filepath: 'drums', tags: ['breakbeat'], licensed: 'true', collection: 'collection-id', min_bpm: '80', max_bpm: '150', page: '7', column_sort: 'name', order: 'ASC'});
  h.api.register(page.presenter());
  h.api.setPolicy({mode: 'exact', bpm: 123.6, range: 10});
  await h.settle();
  assert.deepEqual(page.params(), {filepath: 'drums', tags: ['breakbeat'], licensed: 'true', collection: 'collection-id', bpm: '124'});
  assert.equal(page.calls.length, 1);
  assert.deepEqual(page.calls[0].options, {replaceUrl: true});
  assert.deepEqual(plain(h.api.getStatus().currentQuery), {bpm: '124', min_bpm: null, max_bpm: null});
  assert.equal(h.api.getStatus().matchesPolicy, true);
});

test('range uses inclusive integer limits and policy changes update the same presenter', async () => {
  const h = harness(), page = searchPage({bpm: '90'});
  h.api.register(page.presenter());
  h.api.setPolicy({mode: 'range', bpm: 123.6, range: 5});
  await h.settle();
  assert.deepEqual(page.params(), {min_bpm: 119, max_bpm: 128});
  h.api.setPolicy({mode: 'exact', bpm: 120, range: 10});
  await h.settle();
  assert.deepEqual(page.params(), {bpm: '120'});
  h.api.setPolicy({mode: 'range', bpm: 120, range: 10});
  await h.settle();
  assert.deepEqual(page.params(), {min_bpm: 110, max_bpm: 130});
});

test('Splice native 1–300 limits apply to exact and both range ends', async () => {
  const h = harness(), page = searchPage();
  h.api.register(page.presenter());
  for (const [policy, expected] of [
    [{mode: 'exact', bpm: 0.1, range: 10}, {bpm: '1'}],
    [{mode: 'exact', bpm: 960, range: 10}, {bpm: '300'}],
    [{mode: 'range', bpm: 0.1, range: 10}, {min_bpm: 1, max_bpm: 10}],
    [{mode: 'range', bpm: 299.5, range: 10}, {min_bpm: 290, max_bpm: 300}],
    [{mode: 'range', bpm: 960, range: 10}, {min_bpm: 300, max_bpm: 300}],
  ]) {
    h.api.setPolicy(policy); await h.settle(); assert.deepEqual(page.params(), expected);
  }
});

test('None clears BPM only and enforces that choice during later native filter changes', async () => {
  const h = harness(), page = searchPage({filepath: 'kick', bpm: '120', min_bpm: '110', max_bpm: '130'});
  h.api.register(page.presenter());
  h.api.setPolicy({mode: 'none', bpm: null, range: 10});
  await h.settle();
  assert.deepEqual(page.params(), {filepath: 'kick'});
  await page.updater.updateQuery({bpm: '99', tags: ['acoustic']}, {replaceUrl: false});
  assert.deepEqual(page.params(), {filepath: 'kick', tags: ['acoustic']});
  assert.equal(h.api.getStatus().matchesPolicy, true);
});

test('native filter updates carry policy atomically without an extra navigation', async () => {
  const h = harness(), page = searchPage();
  h.api.register(page.presenter());
  h.api.setPolicy({mode: 'exact', bpm: 120, range: 10});
  await h.settle();
  const before = page.calls.length;
  await page.updater.updateQuery({bpm: '77', min_bpm: 60, max_bpm: 90, filepath: 'new search'}, {replaceUrl: false});
  await h.settle();
  assert.equal(page.calls.length, before + 1);
  assert.deepEqual(page.params(), {bpm: '120', filepath: 'new search'});
  assert.equal(page.calls.at(-1).options.replaceUrl, false);
});

test('NavigationEnd reapplies policy, equal queries do not loop, new presenters inherit policy', async () => {
  const h = harness(), page = searchPage(), first = page.presenter();
  h.api.register(first);
  h.api.setPolicy({mode: 'range', bpm: 120, range: 10});
  await h.settle();
  page.route.snapshot.queryParams = {filepath: 'new route'};
  page.router.emit(0); await h.settle();
  assert.equal(page.params().min_bpm, undefined);
  page.router.emit(); await h.settle();
  assert.deepEqual(page.params(), {filepath: 'new route', min_bpm: 110, max_bpm: 130});
  const before = page.calls.length, revision = h.api.getStatus().revision;
  page.router.emit(); h.api.setPolicy({mode: 'range', bpm: 120, range: 10}); await h.settle();
  assert.equal(page.calls.length, before); assert.equal(h.api.getStatus().revision, revision);
  h.api.unregister(first);
  const next = searchPage({licensed: 'true'});
  h.api.register(next.presenter()); await h.settle();
  assert.deepEqual(next.params(), {licensed: 'true', min_bpm: 110, max_bpm: 130});
});

for (const order of [[0, 1], [1, 0]]) {
  test(`shared updater restores exactly once when presenters unregister ${order.join(' then ')}`, async () => {
    const h = harness(), page = searchPage(), original = page.updater.updateQuery;
    const presenters = [page.presenter(), page.presenter()];
    h.api.register(presenters[0]);
    const wrapped = page.updater.updateQuery;
    h.api.register(presenters[1]); h.api.register(presenters[1]);
    assert.equal(page.updater.updateQuery, wrapped, 'Do not layer wrappers for shared updaters.');
    assert.equal(page.router.subscriptions, 1);
    h.api.setPolicy({mode: 'exact', bpm: 120, range: 10}); await h.settle();
    assert.equal(page.calls.length, 1, 'Only one navigation per router.');
    h.api.unregister(presenters[order[0]]); h.api.unregister(presenters[order[0]]);
    assert.equal(page.updater.updateQuery, wrapped);
    await page.updater.updateQuery({bpm: '70'}); assert.equal(page.params().bpm, '120');
    h.api.unregister(presenters[order[1]]);
    assert.equal(page.updater.updateQuery, original);
    assert.equal(page.router.unsubscriptions, 1);
    assert.equal(h.api.getStatus().ready, false);
    await page.updater.updateQuery({bpm: '70'}); await h.settle();
    assert.equal(page.params().bpm, '70', 'Destroyed presenters must stop enforcing policy.');
  });
}

test('independent routers both receive policy', async () => {
  const h = harness(), first = searchPage(), second = searchPage();
  h.api.register(first.presenter()); h.api.register(second.presenter());
  h.api.setPolicy({mode: 'exact', bpm: 128, range: 10}); await h.settle();
  assert.equal(first.params().bpm, '128'); assert.equal(second.params().bpm, '128');
});

test('invalid policy is rejected without replacing the last valid policy', async () => {
  const h = harness(); h.api.setPolicy({mode: 'exact', bpm: 120, range: 10});
  const before = plain(h.api.getStatus());
  for (const policy of [null, {mode: 'unknown'}, {mode: 'exact', bpm: NaN}, {mode: 'exact', bpm: 0}, {mode: 'range', bpm: 120, range: 0}, {mode: 'range', bpm: 120, range: 101}]) {
    assert.throws(() => h.api.setPolicy(policy));
  }
  assert.equal(h.api.getStatus().revision, before.revision);
  assert.deepEqual(plain(h.api.getStatus().query), before.query);
});

test('status contains only numeric BPM query values and correct settings-row bounds', async () => {
  const h = harness(), page = searchPage({bpm: 'not numeric', min_bpm: '110', filepath: 'private search', token: 'private token'});
  h.api.register(page.presenter());
  assert.deepEqual(plain(h.api.getStatus().currentQuery), {bpm: null, min_bpm: '110', max_bpm: null});
  assert(!JSON.stringify(h.api.getStatus()).includes('private'));
  h.context.document.querySelector = () => ({
    getBoundingClientRect: () => ({x: 0, y: 0, left: 0, width: 313, height: 48}),
    querySelector: () => ({getBoundingClientRect: () => ({left: 265, width: 48})}),
  });
  assert.equal(h.api.getStatus().settingsRow, true);
  assert.deepEqual(plain(h.api.getStatus().row), {x: 0, y: 0, width: 313, height: 48, availableWidth: 265});
});

test('navigation failure returns a sanitized error and can recover on a later route event', async () => {
  const h = harness(), page = searchPage();
  const original = page.updater.updateQuery;
  let fail = true;
  page.updater.updateQuery = function(...args) {
    if (fail) return Promise.reject(new Error('private account or route detail'));
    return original.apply(this, args);
  };
  h.api.register(page.presenter()); h.api.setPolicy({mode: 'exact', bpm: 120, range: 10}); await h.settle();
  assert.equal(h.api.getStatus().error, 'Splice could not apply the tempo filter on this page.');
  assert(!JSON.stringify(h.api.getStatus()).includes('private'));
  fail = false; page.router.emit(); await h.settle();
  assert.equal(h.api.getStatus().error, null); assert.equal(page.params().bpm, '120');
});

(async () => {
  for (const {name, run} of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`Tempo renderer: ${tests.length} offline checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
