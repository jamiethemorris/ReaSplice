'use strict';

// Runs inside a private local copy of Splice. Authentication, networking,
// licensing, downloads, playback and page rendering remain in the real app.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { app, ipcMain } = require('electron');
const bridgeSession = require('./bridge-session.js')();

const options = JSON.parse(fs.readFileSync(path.join(__dirname, 'dock-options.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(options.configPath, 'utf8'));
const token = Buffer.from(config.token);
const port = Number(process.env.SPLICE_DOCK_PORT || config.port || 17864);
const windows = new Map();
const handlers = new Map();
let selected = 'companion';
let surfaceReason = 'startup';
let surfaceRevision = 0;
let docked = true;
let seq = 0;
let drag = null;
let dragId = 0;
let captureBusy = false;
let lastConsumer = 0;
let lastCapture = 0;
let pendingInput = Promise.resolve();
let desired = { width: 400, height: 800 };
let lastError = null;
let tempoPolicy = null;
let tempoRevision = 0;
let bridgeRequest = null;
const inputTypes = ['mouseDown', 'mouseUp', 'mouseMove', 'mouseEnter', 'mouseLeave', 'mouseWheel', 'keyDown', 'keyUp', 'char', 'text'];
const diagnostics = {
  inputReceived: Object.fromEntries(inputTypes.map(type => [type, 0])),
  inputDispatched: Object.fromEntries(inputTypes.map(type => [type, 0])),
  inputFailures: 0, mouseMovesWithButton: 0,
  dragInvocations: 0, dragRequests: 0, dragPrepared: 0, dragRejected: 0, dragAcknowledged: 0
};

process.env.SPLICE_DISABLE_AUTO_UPDATES = '1';
delete process.env.SPLICE_FORCE_AUTO_UPDATES;
// The private copy must not take over the system's splice:// association.
app.setAsDefaultProtocolClient = () => false;
app.removeAsDefaultProtocolClient = () => false;

// ReaSplice is controlled from REAPER. Keep its Electron process functional
// while omitting the separate macOS Dock icon. Splice explicitly calls
// dock.show() when it constructs Companion, so suppress that call in this copy.
// Leave the signed Info.plist and the original app's session identity intact.
if (process.platform === 'darwin' && app.dock) {
  const macDock = app.dock;
  macDock.show = () => Promise.resolve();
  app.whenReady().then(() => macDock.hide()).catch(rememberError);
}

const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function (name, handler) {
  handlers.set(name, handler);
  const destination = {
    showMainWindow: 'main', openRouteInMainWindow: 'main',
    showCompanionWindow: 'companion', openRouteInCompanionWindow: 'companion'
  }[name];
  if (name !== 'dragFile' && !destination) return originalHandle(name, handler);
  return originalHandle(name, async (event, ...args) => {
    if (name === 'dragFile') diagnostics.dragInvocations++;
    const result = await handler(event, ...args);
    // Only an explicit call from the real app renderer changes the dock's
    // selected surface. Background startup/show events must not override it.
    if (destination && docked && event?.sender) await selectSurface(destination, 'app');
    return result;
  });
};

function isDesktop(name) { return name === 'companion' || name === 'main'; }
function alive(record) { return record && !record.window.isDestroyed() && !record.window.webContents.isDestroyed(); }
function current() { const record = windows.get(selected); return alive(record) ? record : null; }
function rememberError(error) { lastError = String(error?.message || error).slice(0, 300); }

// prepare-splice.py inserts only these bounded hooks into its copied index.js.
globalThis.__spliceDock = {
  bridgeManager(manager) { bridgeSession.attach(manager); },
  windowOptions(name, original) {
    if (!isDesktop(name)) return original;
    return {
      ...original, show: false, minWidth: 240, minHeight: 240,
      maxWidth: 1800, maxHeight: 1800,
      webPreferences: { ...original.webPreferences, offscreen: true, backgroundThrottling: false }
    };
  },
  windowCreated(name, window) { if (isDesktop(name)) registerWindow(name, window); },
  filterWindowState(name, state) {
    if (!docked || !isDesktop(name)) return state;
    const { dimensions, isOpen, ...rest } = state;
    return rest;
  },
  shouldKeepHidden(window) {
    return docked && Array.from(windows.values()).some(record => record.window === window);
  },
  updatesDisabled: true
};

function publishPreparedDrag(record) {
  if (record.name !== selected || !(record.buttons & 1) || !record.dragMoved || !record.preparedDrag) return;
  diagnostics.dragPrepared++;
  drag = { id: ++dragId, ...record.preparedDrag };
  record.preparedDrag = null;
}

function registerWindow(name, window) {
  const wc = window.webContents;
  const record = {
    name, window, originalBounds: window.getBounds(), originalMin: name === 'main' ? [992, 640] : [400, 600],
    originalMax: name === 'main' ? [0, 0] : [480, 1400],
    frame: null, frameWidth: 0, frameHeight: 0, frameSeq: 0,
    loaded: false, buttons: 0, debuggerReady: null,
    dragOrigin: null, dragMoved: false, preparedDrag: null,
    tempo: null, tempoRevision: -1, tempoBusy: false, bridgeBusy: false, bridgeEngine: null
  };
  windows.set(name, record);
  wc.setBackgroundThrottling(false);
  if (wc.isOffscreen()) wc.setFrameRate(20);
  const originalStartDrag = wc.startDrag.bind(wc);
  wc.startDrag = payload => {
    if (!docked) return originalStartDrag(payload);
    diagnostics.dragRequests++;
    const candidates = Array.isArray(payload.files) ? payload.files : [payload.file];
    // Only forward files that Splice has prepared and actually exist. This
    // excludes the app's placeholder path for an unlicensed/unavailable sound.
    const files = candidates.filter(file => {
      try { return typeof file === 'string' && path.isAbsolute(file) && fs.statSync(file).isFile(); }
      catch { return false; }
    });
    if (!files.length) {
      diagnostics.dragRejected++;
      return;
    }
    // Splice may prepare a drag before any real drag gesture. A click, a late
    // preparation after release, or an unavailable placeholder should be silent.
    if (!(record.buttons & 1) || !record.dragOrigin || selected !== name) return;
    record.preparedDrag = { files, icon: typeof payload.icon === 'string' ? payload.icon : payload.icon?.toDataURL?.() || null };
    publishPreparedDrag(record);
  };
  window.on('show', () => {
    if (docked) window.hide();
  });
  wc.on('did-finish-load', async () => {
    record.loaded = true;
    try {
      if (docked) window.hide();
      await ensureDebugger(record);
      await refreshTempo(record);
      if (selected === name) resize(record);
      await capture(record);
    } catch (error) { rememberError(error); }
  });
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) lastError = `Splice page failed to load: ${description} (${code})`;
  });
  wc.on('render-process-gone', (_event, detail) => { lastError = `Splice renderer stopped: ${detail.reason}`; });
  window.on('closed', () => { if (windows.get(name) === record) windows.delete(name); });
}

async function refreshTempo(record) {
  if (!alive(record) || !record.loaded || record.tempoBusy) return;
  record.tempoBusy = true;
  const revision = tempoRevision;
  try {
    const policy = tempoPolicy && record.tempoRevision !== revision ? JSON.stringify(tempoPolicy) : 'null';
    // This is a fixed, local interoperability API. No caller-supplied code or
    // general evaluation endpoint is exposed by the loopback relay.
    record.tempo = await record.window.webContents.executeJavaScript(`(() => {
      const api = globalThis.__reaSpliceTempo;
      if (!api) return {supported:false,error:'BPM integration is not loaded. Rebuild and relaunch ReaSplice.'};
      const policy = ${policy};
      if (policy) api.setPolicy(policy);
      return api.getStatus();
    })()`, false);
    if (record.tempo?.supported !== false) record.tempoRevision = revision;
  } catch (error) { record.tempo = { supported: false, error: String(error.message || error).slice(0, 240) }; }
  finally { record.tempoBusy = false; }
}

async function refreshBridge(record) {
  if (!alive(record) || !record.loaded || record.bridgeBusy) return;
  record.bridgeBusy = true;
  const volumeRevision = record.volumeRevision || 0;
  try {
    const request = await record.window.webContents.executeJavaScript(
      '({request:globalThis.__reaSpliceBridge?.getRequest() || null,engine:globalThis.__reaSpliceBridge?.getEngineStatus() || null,volume:globalThis.__reaSpliceVolume?.getStatus() || null})', false);
    record.bridgeEngine = request?.engine || null;
    if (!record.volumeWriting && volumeRevision === (record.volumeRevision || 0)) record.volume = request?.volume || null;
    const pending = request?.request;
    if (pending && typeof pending.id === 'string' && /^[a-z0-9-]{1,100}$/i.test(pending.id)) {
      if (!bridgeRequest) bridgeRequest = { id: pending.id, surface: record.name };
    } else if (bridgeRequest?.surface === record.name) bridgeRequest = null;
  } catch (error) { rememberError(error); }
  finally { record.bridgeBusy = false; }
}

async function finishBridge(command) {
  if (typeof command.id !== 'string' || typeof command.ok !== 'boolean') throw new Error('Invalid Bridge result');
  if (!bridgeRequest || bridgeRequest.id !== command.id) return;
  const request = bridgeRequest;
  const record = windows.get(request.surface);
  if (!alive(record)) { bridgeRequest = null; return; }
  let ok = false;
  try {
    if (command.ok) { await bridgeSession.connect(command.projectId); ok = true; }
  } finally {
    await record.window.webContents.executeJavaScript(
      `globalThis.__reaSpliceBridge?.complete(${JSON.stringify(request.id)}, ${ok})`, false);
    if (bridgeRequest?.id === request.id) bridgeRequest = null;
  }
}

function validateTempo(command) {
  const { mode, bpm, range } = command;
  if (!['none', 'exact', 'range'].includes(mode) || typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0 || bpm > 10000 ||
      typeof range !== 'number' || !Number.isFinite(range) || range < 1 || range > 100) throw new Error('Invalid BPM preference');
  return { mode, bpm, range };
}

async function ensureDebugger(record) {
  if (!alive(record)) throw new Error('Splice window is unavailable');
  if (!record.debuggerReady) {
    record.debuggerReady = (async () => {
      const dbg = record.window.webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    })().catch(error => { record.debuggerReady = null; throw error; });
  }
  return record.debuggerReady;
}

function resize(record) {
  if (!alive(record)) return;
  record.window.setMinimumSize(240, 240);
  record.window.setMaximumSize(1800, 1800);
  record.window.setContentSize(desired.width, desired.height, false);
  record.frame = null;
  record.window.webContents.invalidate();
}

async function capture(record) {
  if (!alive(record) || !record.loaded || captureBusy || Date.now() - lastCapture < 50) return;
  captureBusy = true;
  lastCapture = Date.now();
  try {
    const image = await record.window.webContents.capturePage(undefined, { stayHidden: true });
    if (!image.isEmpty() && alive(record)) {
      const size = image.getSize();
      record.frame = image.toJPEG(96);
      record.frameWidth = size.width;
      record.frameHeight = size.height;
      record.frameSeq = ++seq;
    }
  } catch (error) { rememberError(error); }
  finally { captureBusy = false; }
}

async function selectSurface(name, reason = 'control') {
  if (!isDesktop(name)) throw new Error('Unknown Splice surface');
  selected = name;
  surfaceReason = reason;
  surfaceRevision++;
  let record = windows.get(name);
  if (!alive(record)) {
    const handler = handlers.get(name === 'main' ? 'showMainWindow' : 'showCompanionWindow');
    if (!handler) return;
    await handler(null, {});
    record = windows.get(name);
  }
  if (alive(record)) {
    resize(record);
    if (docked) record.window.hide();
    await capture(record);
  }
}

function modifierBits(modifiers = []) {
  return (modifiers.includes('alt') ? 1 : 0) |
    (modifiers.includes('control') ? 2 : 0) |
    (modifiers.includes('meta') || modifiers.includes('command') ? 4 : 0) |
    (modifiers.includes('shift') ? 8 : 0);
}

const keyNames = {
  Return: ['Enter', 'Enter', 13], Enter: ['Enter', 'Enter', 13], Backspace: ['Backspace', 'Backspace', 8],
  Delete: ['Delete', 'Delete', 46], Escape: ['Escape', 'Escape', 27], Esc: ['Escape', 'Escape', 27],
  Tab: ['Tab', 'Tab', 9], Space: [' ', 'Space', 32], Left: ['ArrowLeft', 'ArrowLeft', 37],
  Right: ['ArrowRight', 'ArrowRight', 39], Up: ['ArrowUp', 'ArrowUp', 38], Down: ['ArrowDown', 'ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33],
  PageDown: ['PageDown', 'PageDown', 34], Shift: ['Shift', 'ShiftLeft', 16],
  Control: ['Control', 'ControlLeft', 17], Alt: ['Alt', 'AltLeft', 18], Meta: ['Meta', 'MetaLeft', 91]
};

async function dispatchInput(event) {
  const record = current();
  if (!record?.loaded) throw new Error('Splice is still loading');
  await ensureDebugger(record);
  const wc = record.window.webContents;
  const send = (method, payload) => wc.debugger.sendCommand(method, payload);
  const modifiers = modifierBits(event.modifiers);
  const mouseTypes = { mouseDown: 'mousePressed', mouseUp: 'mouseReleased', mouseMove: 'mouseMoved', mouseEnter: 'mouseMoved', mouseLeave: 'mouseMoved', mouseWheel: 'mouseWheel' };
  if (Object.hasOwn(mouseTypes, event.type)) {
    const [width, height] = record.window.getContentSize();
    const x = Math.max(0, Math.min(width - 1, Number(event.x) || 0));
    const y = Math.max(0, Math.min(height - 1, Number(event.y) || 0));
    let button = ['left', 'right', 'middle', 'back', 'forward'].includes(event.button) ? event.button : 'none';
    const buttonBit = { left: 1, right: 2, middle: 4, back: 8, forward: 16 }[button] || 0;
    if (event.type === 'mouseDown') record.buttons |= buttonBit;
    if (event.type === 'mouseUp') record.buttons &= ~buttonBit;
    if (event.type === 'mouseDown' && button === 'left') {
      record.dragOrigin = { x, y };
      record.dragMoved = false;
      record.preparedDrag = null;
      drag = null;
    } else if (event.type === 'mouseUp' && button === 'left') {
      record.dragOrigin = null;
      record.dragMoved = false;
      record.preparedDrag = null;
    } else if (event.type === 'mouseMove' && (record.buttons & 1) && record.dragOrigin) {
      if (Math.hypot(x - record.dragOrigin.x, y - record.dragOrigin.y) >= 4) record.dragMoved = true;
      publishPreparedDrag(record);
    }
    if (event.type === 'mouseMove' && button === 'none' && record.buttons) {
      button = record.buttons & 1 ? 'left' : record.buttons & 2 ? 'right' : record.buttons & 4 ? 'middle' : record.buttons & 8 ? 'back' : 'forward';
    }
    if (event.type === 'mouseMove' && record.buttons) diagnostics.mouseMovesWithButton++;
    const payload = { type: mouseTypes[event.type], x, y, modifiers, button, buttons: record.buttons, clickCount: event.type === 'mouseMove' ? 0 : Math.max(0, Math.min(3, Number(event.clickCount) || 1)) };
    if (event.type === 'mouseMove' || event.type === 'mouseDown') payload.force = record.buttons ? 0.5 : 0;
    if (event.type === 'mouseWheel') {
      // Electron wheel delta follows the native direction; CDP uses DOM wheel.
      payload.deltaX = -(Number(event.deltaX) || 0);
      payload.deltaY = -(Number(event.deltaY) || 0);
    }
    await send('Input.dispatchMouseEvent', payload);
  } else if (['keyDown', 'keyUp', 'char'].includes(event.type)) {
    const keyCode = String(event.keyCode || '');
    if (!keyCode || keyCode.length > 64) throw new Error('Invalid key');
    const known = keyNames[keyCode];
    const key = known?.[0] || keyCode;
    const code = event.code || known?.[1] || (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : '');
    const virtualKey = Number(event.windowsVirtualKeyCode) || known?.[2] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const payload = { type: event.type === 'keyDown' ? 'rawKeyDown' : event.type, key, code, modifiers, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: 0, autoRepeat: !!event.isAutoRepeat || (event.modifiers || []).includes('isAutoRepeat') };
    if (event.type === 'char') payload.text = key === 'Enter' ? '\r' : key;
    // The viewer sends explicit char events for printable keys. Enter needs
    // its own keypress/default action for form submission and text areas.
    if (event.type === 'keyDown' && key === 'Enter') {
      payload.type = 'keyDown';
      payload.text = '\r';
      payload.unmodifiedText = '\r';
    }
    const command = (event.modifiers || []).includes('meta') || (event.modifiers || []).includes('command');
    if (command && event.type === 'keyDown') {
      const action = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: (event.modifiers || []).includes('shift') ? 'redo' : 'undo' }[key.toLowerCase()];
      if (action) { wc[action](); return; }
    }
    await send('Input.dispatchKeyEvent', payload);
  } else {
    throw new Error('Unsupported input event');
  }
}

function status(includeDiagnostics = false) {
  const record = current();
  const size = record ? record.window.getContentSize() : [desired.width, desired.height];
  const result = { ready: !!record?.loaded, surface: selected, surfaceReason, surfaceRevision, width: size[0], height: size[1],
    seq: record?.frameSeq || 0, frameWidth: record?.frameWidth || 0, frameHeight: record?.frameHeight || 0,
    drag, error: lastError, docked, surfaces: Array.from(windows.keys()), version: 1,
    applicationName: 'ReaSplice', macDockVisible: process.platform === 'darwin' ? app.dock?.isVisible() ?? null : null,
    tempo: record?.tempo || null, volume: record?.volume || null, bridgeRequest, bridge: bridgeSession.status() };
  if (includeDiagnostics) { result.diagnostics = diagnostics; result.bridgeEngines = Object.fromEntries(Array.from(windows, ([name, win]) => [name, win.bridgeEngine])); }
  return result;
}

function restore() {
  // Keep the geometry filter installed while restoring the original dimensions.
  for (const record of windows.values()) {
    if (!alive(record)) continue;
    record.window.setMinimumSize(...record.originalMin);
    record.window.setMaximumSize(...record.originalMax);
    record.window.setBounds(record.originalBounds, false);
    record.window.hide();
    record.buttons = 0;
  }
  docked = false;
}

async function control(command) {
  if (!command || typeof command !== 'object') throw new Error('Expected command object');
  switch (command.type) {
    case 'tempo': {
      tempoPolicy = validateTempo(command);
      tempoRevision++;
      await Promise.all(Array.from(windows.values()).map(refreshTempo));
      break;
    }
    case 'resize': {
      const width = Number(command.width), height = Number(command.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Invalid viewport size');
      desired = { width: Math.max(240, Math.min(1800, Math.round(width))), height: Math.max(240, Math.min(1800, Math.round(height))) };
      docked = true;
      const record = current();
      if (record) { resize(record); record.window.hide(); }
      break;
    }
    case 'input': {
      const event = command.event || {};
      const counted = inputTypes.includes(event.type) && event.type !== 'text';
      if (counted) diagnostics.inputReceived[event.type]++;
      pendingInput = pendingInput.catch(() => {}).then(async () => {
        try {
          await dispatchInput(event);
          if (counted) diagnostics.inputDispatched[event.type]++;
        } catch (error) { diagnostics.inputFailures++; throw error; }
      });
      await pendingInput;
      break;
    }
    case 'text': {
      const record = current();
      if (!record) throw new Error('Splice is still loading');
      const text = String(command.text || '');
      if (text.length > 8192) throw new Error('Text is too long');
      diagnostics.inputReceived.text++;
      await ensureDebugger(record);
      await record.window.webContents.debugger.sendCommand('Input.insertText', { text });
      diagnostics.inputDispatched.text++;
      break;
    }
    case 'surface': docked = true; await selectSurface(command.surface); break;
    case 'volume': {
      if (!Number.isFinite(command.volume) || command.volume < 0 || command.volume > 1) throw new Error('Invalid Splice volume');
      if (command.sessionId !== bridgeSession.status().sessionId) throw new Error('Splice restarted; try the volume control again');
      if (!['companion', 'main'].includes(command.surface)) throw new Error('Invalid Splice volume surface');
      if (bridgeSession.status().connected) throw new Error('Bridge is now active; adjust its preview volume instead');
      const record = windows.get(command.surface);
      if (!alive(record) || !record.loaded) throw new Error('Splice volume is not ready');
      record.volumeRevision = (record.volumeRevision || 0) + 1;
      record.volumeWriting = true;
      try {
        record.volume = await record.window.webContents.executeJavaScript(
          `globalThis.__reaSpliceVolume.setVolume(${command.volume})`, false);
      } finally { record.volumeWriting = false; record.volumeRevision++; }
      return record.volume;
    }
    case 'bridge-result': await finishBridge(command); break;
    case 'bridge-disconnect': await bridgeSession.disconnect(); break;
    case 'bridge-connect': await bridgeSession.connect(command.projectId); break;
    case 'drag-ack': if (drag?.id === command.id) { diagnostics.dragAcknowledged++; drag = null; } break;
    case 'restore': restore(); break;
    case 'shutdown':
      // Reply before closing the listener so the native host can then launch
      // the normal installed app. Splice performs its ordinary cleanup.
      setTimeout(() => app.quit(), 100);
      break;
    case 'clear-error': lastError = null; break;
    default: throw new Error('Unsupported command');
  }
  return status();
}

function authenticate(request, url) {
  if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress)) return false;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) return false;
  const supplied = Buffer.from(request.headers['x-splice-dock-token'] || url.searchParams.get('token') || '');
  return supplied.length === token.length && crypto.timingSafeEqual(supplied, token);
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Splice-Dock-Token');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Expose-Headers', 'X-Frame-Seq, X-Frame-Width, X-Frame-Height');
  const json = (code, object) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(object)); };
  let url;
  try { url = new URL(request.url, `http://127.0.0.1:${port}`); }
  catch { json(400, { error: 'Invalid relay URL' }); return; }
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (!authenticate(request, url)) { json(403, { error: 'Unauthorized relay request' }); return; }
  try {
    lastConsumer = Date.now();
    if (request.method === 'GET' && url.pathname === '/status') { json(200, status(url.searchParams.get('diagnostics') === '1')); return; }
    if (request.method === 'GET' && url.pathname === '/frame') {
      const record = current();
      if (record && !record.frame) await capture(record);
      const after = Number(url.searchParams.get('after') || -1);
      if (!record?.frame || record.frameSeq <= after) { response.writeHead(204); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': record.frame.length,
        'X-Frame-Seq': String(record.frameSeq), 'X-Frame-Width': String(record.frameWidth), 'X-Frame-Height': String(record.frameHeight) });
      response.end(record.frame); return;
    }
    if (request.method === 'POST' && url.pathname === '/control') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 65536) { json(413, { error: 'Request too large' }); return; }
      }
      json(200, await control(JSON.parse(body))); return;
    }
    json(404, { error: 'Unknown relay route' });
  } catch (error) { json(400, { error: String(error.message || error).slice(0, 300) }); }
});

server.on('error', error => { rememberError(error); console.error('[ReaSplice] Relay could not start:', error.code); });
server.listen(port, '127.0.0.1', () => console.log(`[ReaSplice] Local renderer relay ready on port ${port}`));
const captureTimer = setInterval(() => {
  if (Date.now() - lastConsumer < 1500 && docked) capture(current()).catch(rememberError);
}, 50);
const tempoTimer = setInterval(() => {
  if (docked && Date.now() - lastConsumer < 2000) {
    for (const record of windows.values()) {
      refreshTempo(record).catch(rememberError);
      refreshBridge(record).catch(rememberError);
    }
  }
}, 500);

// Default startup is normally Main. Ask the original API to open Companion
// once its handlers exist, without emulating any of the app's business logic.
const startupTimer = setInterval(() => {
  if (!handlers.has('showCompanionWindow')) return;
  clearInterval(startupTimer);
  selectSurface(selected, surfaceReason).catch(rememberError);
}, 100);

app.on('before-quit', () => {
  clearInterval(captureTimer);
  clearInterval(tempoTimer);
  clearInterval(startupTimer);
  for (const record of windows.values()) {
    if (alive(record)) {
      // Preserve normal geometry while the copied app runs its own shutdown.
      record.window.setBounds(record.originalBounds, false);
    }
  }
  server.close();
});

require('./index.js');
