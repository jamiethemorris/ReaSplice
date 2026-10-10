(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const viewport = $('viewport');
  const canvas = $('surface');
  const context = canvas.getContext('2d', { alpha: false });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const BUTTONS = ['left', 'middle', 'right'];
  const KEY_CODES = { Enter: 'Return', Escape: 'Esc', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space', Meta: 'Super', Control: 'Control', Alt: 'Alt', Shift: 'Shift' };
  let config = null;
  let session = 0;
  let connected = false;
  let frameSequence = 0;
  let surface = 'companion';
  let surfaceSync = null;
  let requestedSurface = 'companion';
  let needsSurfaceRestore = true;
  let surfaceVersion = 0;
  let seenSurfaceRevision = null;
  let sourceWidth = 0;
  let sourceHeight = 0;
  let lastFrameAt = 0;
  let lastStatusAt = 0;
  let lastResize = '';
  let pointer = { x: 0, y: 0, buttons: 0 };
  let nativeDragging = false;
  let consumedDrag = null;
  let inputQueue = Promise.resolve();
  let inputEpoch = 0;
  let moveFrame = 0;
  let pendingMove = null;
  let wakeStatus = null;
  let statusUrgent = false;
  let resizeTimer;
  let messageTimer;
  let composing = false;
  let launching = false;
  let statusFailures = 0;
  let relayReady = false;
  let tempoPreferences = { mode: 'none', range: 10 };
  let projectTempo = null;
  let tempoInitialized = false;
  let tempoError = '';
  let tempoRevision = 0;
  let sentTempo = '';
  let tempoSync = null;
  let tempoSaving = Promise.resolve();
  let rangeEditing = false;
  let rangeCommitTimer;
  let bridgeBusy = false;
  const handledBridgeRequests = new Set();
  const heldKeys = new Map();
  try { if (localStorage.getItem('spliceDock.surface') === 'main') surface = 'main'; } catch (_) { /* Storage is optional in the native host. */ }
  requestedSurface = surface;

  function hasNative() {
    return typeof window.spliceNative?.request === 'function';
  }

  function native(type, payload = {}) {
    if (!hasNative()) return Promise.reject(new Error('Open this panel in REAPER to use this action.'));
    return window.spliceNative.request(type, payload);
  }

  function validConfig(candidate) {
    if (!candidate || typeof candidate.baseUrl !== 'string' || typeof candidate.token !== 'string' || !candidate.token) return null;
    try {
      const url = new URL(candidate.baseUrl);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
      return { baseUrl: url.origin, token: candidate.token };
    } catch (_) { return null; }
  }

  async function readConfig() {
    const injected = validConfig(window.spliceRelay);
    if (hasNative()) {
      try {
        const fresh = validConfig(await native('relay.config'));
        if (fresh) return fresh;
      } catch (_) { /* Initial document config can still be valid. */ }
    }
    return injected;
  }

  function endpoint(path, params = {}) {
    const url = new URL(path, config.baseUrl);
    url.searchParams.set('token', config.token);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return url.href;
  }

  async function request(path, options = {}, params = {}, timeout = 7000) {
    if (!config) throw new Error('The Splice connection is not configured yet.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(endpoint(path, params), { cache: 'no-store', ...options, signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'The Splice connection needs to be refreshed.' : `Splice connection returned ${response.status}.`);
      return response;
    } finally { clearTimeout(timer); }
  }

  async function control(payload) {
    const response = await request('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (response.status === 204) return null;
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('json')) {
      const result = await response.json();
      if (result?.error) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || 'Splice could not complete that action.');
      return result;
    }
    return null;
  }

  function input(event) {
    if (!connected || nativeDragging) return Promise.resolve();
    const generation = session;
    const epoch = inputEpoch;
    inputQueue = inputQueue.catch(() => {}).then(async () => {
      if (generation !== session || epoch !== inputEpoch || !connected || nativeDragging) return;
      await control({ type: 'input', event });
      if (pointer.buttons & 1) requestStatus();
    }).catch((error) => {
      if (generation === session) showMessage(error.message, true);
    });
    return inputQueue;
  }

  function insertText(text) {
    if (!connected || !text) return;
    const generation = session;
    const epoch = inputEpoch;
    inputQueue = inputQueue.catch(() => {}).then(() => {
      if (generation === session && epoch === inputEpoch && connected && !nativeDragging) return control({ type: 'text', text });
    }).catch((error) => { if (generation === session) showMessage(error.message, true); });
  }

  function setState(title, description, { busy = false, canLaunch = false, retry = false, detail = '' } = {}) {
    connected = false;
    viewport.classList.remove('connected');
    $('connection-state').hidden = false;
    $('state-title').textContent = title;
    $('state-description').textContent = description;
    $('launch').hidden = !canLaunch;
    $('retry').hidden = !retry;
    $('state-detail').textContent = detail;
    $('state-detail').hidden = !detail;
    $('connection-dot').className = `connection-dot${busy ? '' : ' error'}`;
    $('connection-dot').title = title;
    $('shutdown').disabled = !relayReady;
    $('state-mark').innerHTML = busy ? '<span class="spinner"></span>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22h8M12 18v4m-4-11 8 8m0-8-8 8"/></svg>';
  }

  function setConnected() {
    connected = true;
    statusFailures = 0;
    viewport.classList.add('connected');
    canvas.classList.add('visible');
    $('connection-state').hidden = true;
    $('connection-dot').className = 'connection-dot connected';
    $('connection-dot').title = 'Connected to your Splice app';
    $('shutdown').disabled = false;
  }

  function showMessage(text, error = false) {
    clearTimeout(messageTimer);
    $('message-text').textContent = String(text);
    $('message').classList.toggle('error', error);
    $('message').hidden = false;
    messageTimer = setTimeout(() => { $('message').hidden = true; }, error ? 8000 : 4500);
  }

  function selectSurface(next) {
    surface = next === 'main' ? 'main' : 'companion';
    ['main', 'companion'].forEach((name) => {
      $(name).classList.toggle('active', surface === name);
      $(name).setAttribute('aria-pressed', String(surface === name));
    });
  }

  function renderTempo() {
    const bpm = projectTempo?.bpm;
    const format = (value) => Number(value.toFixed(2)).toString();
    $('tempo-mode').querySelectorAll('button').forEach((button) => {
      button.disabled = !tempoInitialized;
      button.setAttribute('aria-pressed', String(button.dataset.mode === tempoPreferences.mode));
    });
    $('tempo-range-label').hidden = tempoPreferences.mode !== 'range';
    if (!rangeEditing && document.activeElement !== $('tempo-range')) $('tempo-range').value = tempoPreferences.range;
    let note = 'Reading project tempo…';
    if (Number.isFinite(bpm)) {
      const target = tempoPreferences.mode === 'none' ? 'Any tempo'
        : tempoPreferences.mode === 'exact' ? `Search ${Math.max(1, Math.min(300, Math.round(bpm)))} BPM`
        : `Search ${Math.max(1, Math.min(300, Math.ceil(bpm - tempoPreferences.range)))}–${Math.max(1, Math.min(300, Math.floor(bpm + tempoPreferences.range)))} BPM`;
      note = `Project ${format(bpm)} · ${target}`;
    }
    $('tempo-note').textContent = tempoError || note;
    $('tempo-note').title = tempoError || `${note}. Applies to Library and Browse searches.`;
    $('tempo-note').classList.toggle('error', Boolean(tempoError));
  }

  async function tempoLoop() {
    while (hasNative()) {
      try {
        if (!tempoInitialized) {
          tempoPreferences = await native('tempo.preferences');
          tempoInitialized = true;
        }
        const current = await native('project.tempo');
        if (Number.isFinite(current?.bpm) && current.bpm > 0) {
          if (current.bpm !== projectTempo?.bpm || current.projectId !== projectTempo?.projectId) {
            projectTempo = current;
            tempoRevision++;
            requestStatus();
          }
        } else throw new Error('Project tempo unavailable');
      } catch (error) { tempoError = error.message; }
      renderTempo();
      await sleep(650);
    }
  }

  async function syncTempo() {
    if (!tempoInitialized || !projectTempo || !config || tempoSync) return;
    const payload = { type: 'tempo', mode: tempoPreferences.mode, range: tempoPreferences.range, bpm: projectTempo.bpm };
    const key = JSON.stringify([payload, projectTempo.projectId]);
    if (sentTempo === key) return;
    const revision = tempoRevision;
    tempoSync = (async () => {
      try {
        const result = await control(payload);
        if (result?.tempo?.error) throw new Error(result.tempo.error);
        if (revision === tempoRevision) { sentTempo = key; tempoError = ''; }
      } catch (error) { tempoError = `BPM filter: ${error.message}`; }
      finally { renderTempo(); }
    })();
    try { await tempoSync; } finally { tempoSync = null; }
  }

  function changeTempoPreference(mode = tempoPreferences.mode) {
    const range = Number($('tempo-range').value);
    if (!Number.isFinite(range) || range < 1 || range > 100) {
      $('tempo-range').value = tempoPreferences.range;
      return;
    }
    tempoPreferences = { mode, range };
    tempoRevision++;
    renderTempo();
    const preference = { ...tempoPreferences };
    tempoSaving = tempoSaving.catch(() => {}).then(() => native('tempo.preferences', preference))
      .catch((error) => { tempoError = `Could not save BPM preference: ${error.message}`; renderTempo(); });
    requestStatus();
  }

  async function changeSurface(next) {
    surfaceVersion += 1;
    selectSurface(next);
    requestedSurface = surface;
    try { localStorage.setItem('spliceDock.surface', surface); } catch (_) { /* Storage is optional. */ }
    if (!config) return;
    try {
      await releaseInput();
      await syncSurface();
      viewport.focus({ preventScroll: true });
    } catch (error) { showMessage(error.message, true); }
  }

  async function syncSurface() {
    if (surfaceSync) return surfaceSync;
    const wanted = surface;
    const generation = session;
    surfaceSync = (async () => {
      await control({ type: 'surface', surface: wanted });
      if (generation !== session) return;
      frameSequence = 0;
      lastResize = '';
      await resizeSurface();
    })();
    try { await surfaceSync; }
    finally { surfaceSync = null; }
    if (surface !== wanted && generation === session) return syncSurface();
  }

  async function resizeSurface() {
    if (!config) return;
    const bounds = viewport.getBoundingClientRect();
    const width = Math.max(240, Math.round(bounds.width));
    const height = Math.max(100, Math.round(bounds.height));
    const size = `${surface}:${width}:${height}`;
    if (lastResize === size) return;
    await control({ type: 'resize', width, height });
    lastResize = size;
    $('resize-status').textContent = `Splice view resized to ${width} by ${height}.`;
  }

  async function handleDrag(drag) {
    if (nativeDragging || !drag || drag.id === consumedDrag || !Array.isArray(drag.files) || !drag.files.length) return;
    if (!hasNative()) {
      consumedDrag = drag.id;
      showMessage('Open this panel in REAPER to drag sounds into your project.', true);
      await control({ type: 'drag-ack', id: drag.id });
      return;
    }
    consumedDrag = drag.id;
    let started = false;
    try {
      if (!(pointer.buttons & 1)) {
        showMessage('Keep the mouse button held while dragging the sound into REAPER.');
        return;
      }
      // Start Cocoa's drag while the physical button is still held. Pending
      // moves are discarded and the remote button is released immediately after.
      cancelMove();
      inputEpoch += 1;
      nativeDragging = true;
      await native('drag', { files: drag.files });
      started = true;
      await inputQueue;
      await control({ type: 'input', event: { type: 'mouseUp', x: pointer.x, y: pointer.y, button: 'left', clickCount: 1, modifiers: [] } });
    } catch (error) {
      showMessage(error.message || 'Could not start the file drag.', true);
    } finally {
      await control({ type: 'drag-ack', id: drag.id }).catch(() => {});
      if (!started) nativeDragging = false;
      pointer.buttons = 0;
    }
  }

  function requestStatus() {
    statusUrgent = true;
    if (wakeStatus) wakeStatus();
  }

  async function handleBridge(request) {
    if (bridgeBusy || handledBridgeRequests.has(request.id)) return;
    bridgeBusy = true;
    handledBridgeRequests.add(request.id);
    if (handledBridgeRequests.size > 100) handledBridgeRequests.delete(handledBridgeRequests.values().next().value);
    let ok = false;
    try {
      showMessage('Opening Splice Bridge in monitoring FX…');
      const result = await native('bridge.ensure');
      ok = true;
      showMessage(result.created ? 'Splice Bridge added at the end of monitoring FX.' : 'Splice Bridge is ready at the end of monitoring FX.');
    } catch (error) {
      showMessage(error.message || 'Could not open Splice Bridge.', true);
    } finally {
      try { await control({ type: 'bridge-result', id: request.id, ok }); }
      catch (error) { showMessage(`Bridge connection: ${error.message}`, true); }
      bridgeBusy = false;
    }
  }

  function waitForStatus(delay) {
    if (statusUrgent) { statusUrgent = false; return Promise.resolve(); }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (wakeStatus === done) wakeStatus = null;
        statusUrgent = false;
        resolve();
      };
      const timer = setTimeout(done, delay);
      wakeStatus = done;
    });
  }

  async function statusLoop(generation) {
    while (generation === session && config) {
      try {
        const version = surfaceVersion;
        const result = await (await request('/status')).json();
        if (generation !== session) return;
        lastStatusAt = Date.now();
        statusFailures = 0;
        relayReady = Boolean(result.ready);
        if (Number.isFinite(result.seq) && result.seq < frameSequence) { frameSequence = 0; consumedDrag = null; needsSurfaceRestore = true; sentTempo = ''; }
        if (Number(result.width) > 0) sourceWidth = Number(result.width);
        if (Number(result.height) > 0) sourceHeight = Number(result.height);
        if (!result.ready) {
          needsSurfaceRestore = true;
          setState('ReaSplice is opening', 'Waiting for the app view to become available.', { busy: true, canLaunch: hasNative(), retry: true });
        } else {
          // Restore the toolbar choice once at startup/reconnect. Afterwards
          // honor app-driven navigation, such as a Companion-only feature
          // opening the main window, without overwriting the user's preference.
          const knownSurface = result.surface === 'main' || result.surface === 'companion';
          const appNavigation = result.surfaceReason === 'app' && result.surfaceRevision !== seenSurfaceRevision;
          if (appNavigation && knownSurface && !surfaceSync && version === surfaceVersion) {
            selectSurface(result.surface);
            needsSurfaceRestore = false;
            lastResize = '';
          } else if (needsSurfaceRestore) {
            selectSurface(requestedSurface);
            await syncSurface();
            needsSurfaceRestore = false;
          } else if (result.surfaceReason !== 'startup' && !surfaceSync && version === surfaceVersion && knownSurface && result.surface !== surface) {
            selectSurface(result.surface);
            lastResize = '';
          }
          seenSurfaceRevision = result.surfaceRevision ?? null;
          document.querySelector('.dock').classList.toggle('settings-row', surface === 'companion' && result.tempo?.settingsRow === true);
          if (result.tempo?.error) { tempoError = result.tempo.error; renderTempo(); }
          await syncTempo();
          if (lastFrameAt && !connected && Date.now() - lastFrameAt < 5000) setConnected();
          resizeSurface().catch(() => {});
          if (result.drag) handleDrag(result.drag);
          if (result.bridgeRequest) handleBridge(result.bridgeRequest);
        }
      } catch (error) {
        if (generation !== session) return;
        statusFailures += 1;
        relayReady = false;
        needsSurfaceRestore = true;
        if (statusFailures >= 2 && hasNative()) {
          const fresh = await readConfig();
          if (generation !== session) return;
          if (fresh && (fresh.token !== config.token || fresh.baseUrl !== config.baseUrl)) {
            config = fresh;
            frameSequence = 0;
            consumedDrag = null;
            lastResize = '';
          }
        }
        if (statusFailures >= 2 || !lastFrameAt) {
          setState('ReaSplice is disconnected', 'Launch ReaSplice, then reconnect to continue.', { canLaunch: hasNative(), retry: true, detail: error.name === 'AbortError' ? 'The app did not respond.' : error.message });
        }
      }
      await waitForStatus(pointer.buttons & 1 ? 35 : statusFailures ? 1600 : 400);
    }
  }

  async function frameLoop(generation) {
    while (generation === session && config) {
      try {
        const response = await request('/frame', {}, { after: frameSequence }, 12000);
        if (generation !== session) return;
        if (response.status === 204) { await sleep(45); continue; }
        const blob = await response.blob();
        if (!blob.size) { await sleep(90); continue; }
        const bitmap = await createImageBitmap(blob);
        if (generation !== session) { bitmap.close(); return; }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const sequence = Number(response.headers.get('X-Frame-Seq') || response.headers.get('X-Sequence') || response.headers.get('X-Seq'));
        if (Number.isFinite(sequence) && sequence > 0) frameSequence = sequence;
        lastFrameAt = Date.now();
        if (relayReady && Date.now() - lastStatusAt < 5000) setConnected();
        await sleep(16);
      } catch (error) {
        if (generation !== session) return;
        if (lastFrameAt && Date.now() - lastFrameAt > 7000) {
          setState('ReaSplice view is unavailable', 'Reconnect to restore the live app view.', { canLaunch: hasNative(), retry: true });
        }
        await sleep(600);
      }
    }
  }

  async function connect() {
    requestStatus();
    const generation = ++session;
    frameSequence = 0;
    lastFrameAt = 0;
    lastStatusAt = 0;
    lastResize = '';
    relayReady = false;
    sentTempo = '';
    needsSurfaceRestore = true;
    selectSurface(requestedSurface);
    sourceWidth = 0;
    sourceHeight = 0;
    consumedDrag = null;
    seenSurfaceRevision = null;
    nativeDragging = false;
    cancelMove();
    canvas.classList.remove('visible');
    pointer.buttons = 0;
    heldKeys.clear();
    setState('Connecting to ReaSplice', 'Opening your Splice app in this dock.', { busy: true });
    config = await readConfig();
    if (generation !== session) return;
    if (!config) {
      setState(hasNative() ? 'ReaSplice isn’t running yet' : 'Open in REAPER', hasNative() ? 'Launch ReaSplice to use the full app here.' : 'This panel displays your Splice app inside a REAPER dock. Open it from REAPER to connect.', { canLaunch: hasNative(), retry: hasNative() });
      return;
    }
    statusLoop(generation);
    frameLoop(generation);
  }

  async function shutdown() {
    if (!config || $('shutdown').disabled) return;
    $('shutdown').disabled = true;
    try {
      await releaseInput();
      await control({ type: 'shutdown' });
      ++session;
      requestStatus();
      relayReady = false;
      canvas.classList.remove('visible');
      setState('ReaSplice is stopped', 'You can now use the regular Splice app, or launch the dock copy again.', { canLaunch: hasNative() });
    } catch (error) {
      $('shutdown').disabled = false;
      showMessage(error.message || 'Could not stop ReaSplice.', true);
    }
  }

  async function launch() {
    if (launching) return;
    launching = true;
    ++session;
    requestStatus();
    $('launch').disabled = true;
    setState('Launching ReaSplice', 'Waiting for ReaSplice to start.', { busy: true });
    try {
      await native('launch');
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const candidate = await readConfig();
        if (candidate) {
          config = candidate;
          try {
            const response = await request('/status', {}, {}, 1500);
            if (response.ok) { await connect(); return; }
          } catch (_) { /* The app may still be loading its relay. */ }
        }
        await sleep(600);
      }
      setState('ReaSplice is still starting', 'The app has launched, but its dock connection is not ready yet.', { retry: true, canLaunch: true });
    } catch (error) {
      setState('Couldn’t launch ReaSplice', 'Try launching the dock copy again.', { retry: true, canLaunch: true, detail: error.message });
    } finally {
      launching = false;
      $('launch').disabled = false;
    }
  }

  function point(event) {
    const bounds = viewport.getBoundingClientRect();
    const width = sourceWidth || bounds.width;
    const height = sourceHeight || bounds.height;
    return { x: Math.max(0, Math.min(Math.floor(width - 1), Math.round((event.clientX - bounds.left) * width / bounds.width))), y: Math.max(0, Math.min(Math.floor(height - 1), Math.round((event.clientY - bounds.top) * height / bounds.height))) };
  }

  function modifiers(event) {
    const values = [];
    if (event.shiftKey) values.push('shift');
    if (event.ctrlKey) values.push('control');
    if (event.altKey) values.push('alt');
    if (event.metaKey) values.push('meta');
    if (event.buttons & 1) values.push('leftButtonDown');
    if (event.buttons & 2) values.push('rightButtonDown');
    if (event.buttons & 4) values.push('middleButtonDown');
    return values;
  }

  function isAppEvent(event) {
    return connected && !nativeDragging && (event.target === viewport || event.target === canvas);
  }

  function sendMove(event) {
    pointer = { ...point(event), buttons: event.buttons };
    pendingMove = { type: 'mouseMove', x: pointer.x, y: pointer.y, modifiers: modifiers(event) };
    if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
  }

  function flushMove() {
    if (moveFrame) cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    const move = pendingMove;
    pendingMove = null;
    if (move) input(move);
  }

  function cancelMove() {
    if (moveFrame) cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    pendingMove = null;
  }

  viewport.addEventListener('pointerdown', (event) => {
    if (!isAppEvent(event) || event.button > 2) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    flushMove();
    pointer = { ...point(event), buttons: event.buttons };
    try { viewport.setPointerCapture(event.pointerId); } catch (_) { /* Native drag can take ownership. */ }
    input({ type: 'mouseDown', ...point(event), button: BUTTONS[event.button], clickCount: Math.min(3, event.detail || 1), modifiers: modifiers(event) });
    if (event.button === 0) requestStatus();
  });
  viewport.addEventListener('pointermove', (event) => { if (isAppEvent(event)) { event.preventDefault(); sendMove(event); } });
  viewport.addEventListener('pointerup', (event) => {
    flushMove();
    pointer = { ...point(event), buttons: event.buttons };
    if (!isAppEvent(event) || event.button > 2) return;
    event.preventDefault();
    input({ type: 'mouseUp', ...point(event), button: BUTTONS[event.button], clickCount: Math.min(3, event.detail || 1), modifiers: modifiers(event) });
    try { viewport.releasePointerCapture(event.pointerId); } catch (_) { /* A native drag may have released capture. */ }
  });
  viewport.addEventListener('pointercancel', () => { releaseInput(); });
  viewport.addEventListener('dragstart', (event) => { event.preventDefault(); });
  viewport.addEventListener('contextmenu', (event) => { if (isAppEvent(event)) event.preventDefault(); });
  viewport.addEventListener('wheel', (event) => {
    if (!isAppEvent(event)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    input({ type: 'mouseWheel', ...point(event), deltaX: -event.deltaX * unit, deltaY: -event.deltaY * unit, canScroll: true, modifiers: modifiers(event) });
  }, { passive: false });

  viewport.addEventListener('keydown', (event) => {
    if (!isAppEvent(event) || composing || event.isComposing) return;
    event.preventDefault();
    const keyCode = KEY_CODES[event.key] || event.key;
    const mods = modifiers(event);
    heldKeys.set(event.code, { keyCode, modifiers: mods });
    input({ type: 'keyDown', keyCode, modifiers: event.repeat ? [...mods, 'isAutoRepeat'] : mods });
    if (Array.from(event.key).length === 1 && !event.metaKey && !event.ctrlKey) input({ type: 'char', keyCode: event.key, modifiers: mods });
  });
  viewport.addEventListener('keyup', (event) => {
    if (!isAppEvent(event) || composing || event.isComposing) return;
    event.preventDefault();
    heldKeys.delete(event.code);
    input({ type: 'keyUp', keyCode: KEY_CODES[event.key] || event.key, modifiers: modifiers(event) });
  });
  viewport.addEventListener('compositionstart', () => { composing = true; });
  viewport.addEventListener('compositionend', (event) => {
    composing = false;
    if (isAppEvent(event) && event.data) insertText(event.data);
  });
  viewport.addEventListener('paste', (event) => {
    if (!isAppEvent(event)) return;
    const text = event.clipboardData?.getData('text/plain');
    if (text) { event.preventDefault(); insertText(text); }
  });

  async function releaseInput() {
    if (nativeDragging) return;
    flushMove();
    for (const [mask, button] of [[1, 'left'], [2, 'right'], [4, 'middle']]) {
      if (pointer.buttons & mask) await input({ type: 'mouseUp', x: pointer.x, y: pointer.y, button, clickCount: 1, modifiers: [] });
    }
    pointer.buttons = 0;
    for (const key of heldKeys.values()) await input({ type: 'keyUp', keyCode: key.keyCode, modifiers: [] });
    heldKeys.clear();
  }

  window.addEventListener('blur', () => { releaseInput(); });
  window.addEventListener('splice:native-drag-ended', () => {
    nativeDragging = false;
    pointer.buttons = 0;
    heldKeys.clear();
    if (connected) control({ type: 'input', event: { type: 'mouseUp', x: pointer.x, y: pointer.y, button: 'left', clickCount: 1, modifiers: [] } }).catch(() => {});
  });
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeSurface().catch(() => {}); }, 100);
  }).observe(viewport);
  $('companion').addEventListener('click', () => changeSurface('companion'));
  $('main').addEventListener('click', () => changeSurface('main'));
  $('reconnect').addEventListener('click', connect);
  $('shutdown').addEventListener('click', shutdown);
  $('retry').addEventListener('click', connect);
  $('launch').addEventListener('click', launch);
  $('dismiss-message').addEventListener('click', () => { $('message').hidden = true; });
  $('tempo-mode').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => changeTempoPreference(button.dataset.mode)));
  $('tempo-range').addEventListener('change', () => changeTempoPreference());
  $('tempo-range').addEventListener('pointerdown', () => {
    $('tempo-range').focus({ preventScroll: true });
  });
  $('tempo-range').addEventListener('focus', () => { rangeEditing = true; });
  $('tempo-range').addEventListener('blur', () => {
    rangeEditing = false;
    clearTimeout(rangeCommitTimer);
    changeTempoPreference();
  });
  $('tempo-range').addEventListener('input', () => {
    clearTimeout(rangeCommitTimer);
    // Keep the edit draft while typing; search once the number settles.
    rangeCommitTimer = setTimeout(() => {
      const range = Number($('tempo-range').value);
      if (Number.isFinite(range) && range >= 1 && range <= 100) changeTempoPreference();
    }, 350);
  });
  selectSurface(surface);
  tempoLoop();
  connect();
})();
