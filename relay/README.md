# Splice renderer relay

The private runtime uses the installed application's own Electron renderer,
preload, services and account session. It does not implement a partial sound
catalog or copy credentials. The original app and the dock runtime must not run
at the same time. Splice enforces its normal single-instance lock.

Run `python3 relay/prepare-splice.py` to create `build/ReaSplice.app`. Preparation
validates nine main-process anchors, two sample-presenter anchors per renderer,
and each renderer's Bridge button and three installed-state tooltips before
writing the generated bundle.
It also appends `renderer.css` to each private renderer stylesheet to hide
scrollbar chrome without changing scrolling behavior.
`relay/launch-splice.sh` refuses to launch while normal Splice is running.
The original installed app is never modified. The generated runtime is local
only; do not distribute it. Re-run preparation after updating installed Splice.

On macOS, the private copy hides its Dock icon after Electron is ready and
suppresses Splice's explicit Companion `dock.show()` call. Its windows and relay
continue running. `/status` reports `applicationName` and `macDockVisible`.
The signed Info.plist, executable name, account paths and bundle identity stay
unchanged; `ReaSplice.app` is the name of the private bundle and REAPER host.

`build/relay-config.json` contains `baseUrl`, `port`, and a random `token` for this
local relay. This is a relay capability, not a Splice account credential.
The server listens on 127.0.0.1 only and checks token and Host on every request.
Pass the token as `?token=...` or `X-Splice-Dock-Token` header. All responses are
uncacheable. The UI can be served from a local file.

| Route | Result |
| --- | --- |
| `GET /status` | `{ready,surface,surfaceReason,surfaceRevision,width,height,seq,frameWidth,frameHeight,drag,error,docked,surfaces,bridge,volume}` |
| `GET /status?diagnostics=1` | Same status plus fixed input-event and drag-stage counters; no key/text/path/coordinate logs |
| `GET /frame?after=N` | JPEG plus `X-Frame-Seq`, `X-Frame-Width`, `X-Frame-Height`; 204 if no newer frame |
| `POST /control` | JSON command below; returns status or HTTP 400 error |

Commands:

`surfaceReason` is `startup`, `control` (viewer request), or `app` (explicit
navigation from the real Splice UI). `surfaceRevision` increments for each
surface selection. Ordinary native window show/focus events do not change it.

- `{type:"tempo",mode:"none"|"exact"|"range",bpm,range}` sets the project-tempo preference. Range is 1–100; sample filters use Splice’s native 1–300 integer bounds. Both renderers keep this policy across sample searches and navigation. `/status.tempo` exposes the effective policy, sanitized current BPM query, match state, and settings-row bounds.
- `{type:"resize",width,height}` uses real layout viewport dimensions, clamped
  to 240–1800 logical pixels. The supplied `scale` is currently ignored.
- `{type:"input",event:{type:"mouseDown"|"mouseUp"|"mouseMove"|"mouseWheel",x,y,button,clickCount,deltaX,deltaY,modifiers}}`
  uses Electron event conventions (wheel direction is opposite DOM WheelEvent).
- `{type:"input",event:{type:"keyDown"|"keyUp"|"char",keyCode,code,modifiers}}`
  uses Electron keyboard conventions. Modifiers: `shift`, `alt`, `control`, `meta`.
- `{type:"text",text}` inserts composed/pasted text into the real focused input.
- `{type:"surface",surface:"companion"|"main"}` selects the genuine app surface.
- `{type:"bridge-result",id,ok,projectId}` completes a pending Bridge button
  request after the native `bridge.ensure` action. Successful setup performs a
  fresh, bounded handshake through Splice's connection manager. Stale IDs are
  ignored; this command cannot choose a plugin, track, or execute code.
- `{type:"bridge-connect",projectId}` reconnects for an automatic project handoff.
- `{type:"bridge-disconnect"}` stops the preview (bounded to 750ms) and disconnects.
  Handshakes time out after four seconds. `/status.bridge` reports actual
  `connected`, the claimed `projectId`, `supported`, `revision`, `sessionId` and a bounded error.
  A click or successful native setup never counts as a connection by itself.
- `{type:"volume",volume,surface,sessionId}` changes ordinary Splice preview
  volume from 0–1. Requires the current runtime session and a known surface;
  rejected while Bridge is connected. Bridge gain and Solo use the native host.
- `{type:"drag-ack",id}` acknowledges `status.drag`. Start a native host drag with
  the supplied absolute `files`. Splice has already downloaded/prepared them.
- `{type:"restore"}` restores original bounds and leaves offscreen windows hidden.
  It does not activate Splice or move focus out of REAPER.
- `{type:"shutdown"}` replies, then gracefully quits the private Splice process.
  Prefer this when switching back to the installed application; the offscreen
  runtime cannot become a conventional on-screen renderer without recreation.
- `{type:"clear-error"}` clears the displayed relay error.

Frames come from the app's own `webContents.capturePage`, at no more than 20 FPS
and only while a viewer polls. Input goes through the Chromium debugger Input
domain with focus emulation, so an invisible Splice window need not steal focus
from REAPER. The narrow API exposes no arbitrary JavaScript execution or paths.

The private copy disables updater initialization, manual checks and update
installation before loading the native updater, and prevents itself from becoming
the default splice:// handler. While docked it filters the normal window-state
geometry/isOpen writes, retaining pre-existing window dimensions. Normal account,
library, downloads, playback and user-selected preferences remain Splice's own.

Splice 5.4.13 constructs `VstInstallManager` without initializing its plugin
scanner or renderer IPC streams. Preparation adds that startup call and makes
initialization idempotent, with IPC registered before the asynchronous scan.
Installation and compatibility states still come from Splice's own scanner and
version checks. `bridge-renderer.js` redirects the genuine Bridge button into a
bounded request/response handoff. The v0.10 native host loads or reuses Bridge on
a marked, dedicated track hidden from TCP and MCP. Legacy master/monitoring
instances migrate with their settings. Button clicks and automatic handoffs both
use `show:false`. `bridge.volume` reads the current preview fader and accepts a
linear gain from 0–4 only with matching active-project and track IDs. The viewer
coalesces slider changes and rejects stale read/write replies. `bridge.preferences` persists a switch mode
of `disconnect` (default) or `follow`; `bridge.ensure` rejects a stale project ID.
The viewer serializes transitions and checks the active project before setup and
after the actual connection handshake.

Native setup takes competing Bridge instances in all open project track/master chains
and monitoring FX offline before reloading the selected instance. Bypass alone
does not release Bridge's primary-instance ownership. Existing master or monitoring Bridge
is migrated when the dedicated track has none. Other effects are left unchanged.
`bridge-session.js` observes Splice's `isVstConnected$`; the renderer's original
connection notifications drive the blue icon, with white styling when inactive.
Both renderers guard the original asynchronous stop/disconnect handler with an
event revision, so a late stop cannot disable a newer connection. Diagnostic
status includes each renderer's observed Bridge engine state.

`volume-renderer.js` binds Splice's existing playback service and Angular zone.
The fixed `volume` command accepts a finite 0–1 value, a known surface and the
current runtime session ID; it refuses ordinary-volume writes while Bridge is
active. It calls Splice's original `adjustVolume` and waits for the shared store
to confirm the value. Status exposes only the numeric volume and availability.
The host's always-visible slider switches between this control and native
`bridge.volume`, with separate percentage/dB scales and independent remembered
levels. Queued changes are coalesced, and a gesture started on one output or
project cannot modify another after a connection, project or surface change.
The duplicate bottom volume widget is hidden once the integration binds.

The v0.10 host also exposes `bridge.solo`, with the same active-project and track
ID guards as `bridge.volume` and a strict boolean `solo` payload. It changes only
the marked track's `I_SOLO` (2 for solo in place, 0 for off), records an undo entry,
and returns its actual state with each track-control reply. The viewer shares a
write queue for gain and solo so rapid changes do not overwrite one another.
The visible Solo toggle can release a solo even while Bridge is disconnected.

Limitations requiring runtime validation: installed Electron/code-signing policy;
OSR capture and CDP input; native dialogs and external authentication still use
their original windows; native drag handoff latency. Companion has its existing
app feature set, with Main available for the wider desktop surface. Widths below
Splice's shipped 400px minimum may need narrowly scoped CSS refinements.

The drag adapter silently ignores Splice's unavailable-file placeholders. A
prepared local file becomes a native drag only while the left mouse button is
held and has moved at least four logical pixels; releasing a click clears its
pending preparation. This prevents preview clicks from producing drag warnings.
