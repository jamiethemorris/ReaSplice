# ReaSplice

Use the real Splice desktop app inside a resizable REAPER dock on macOS.
Browse new sounds and your library, use Splice's own sample workflows, and drag
downloaded samples directly into your project.

ReaSplice is an experimental, unofficial integration. It uses your locally
installed Splice app and account; this repository contains the host and integration
code, not a copy of Splice or any sounds.

## Features

- **Compact and Full app views.** Compact uses Splice's responsive Companion UI;
  Full app provides its wider desktop interface.
- **A separate REAPER docker tab.** Remembers its dock location and can share the
  right-hand docker with other tools.
- **Native sample drag-and-drop.** Download through Splice, then drag the prepared
  audio file into REAPER.
- **Project-aware BPM searches.** Choose any BPM, the current project BPM, or an
  adjustable range around it in both Library and Browse sample searches.
- **Always-visible preview volume.** The top slider controls Splice's volume
  when disconnected and the dedicated, hidden Bridge track when connected.
  Connecting does not open the plugin window.
- **Bridge Solo.** Solo the hidden preview track with the button beside the
  volume slider, and turn it off even after Bridge disconnects.
- **Project switching options.** Disconnect Bridge when changing projects, or
  have it follow the active project. The icon reflects the actual connection.

## Requirements

- macOS 12 or later. Tested on Apple Silicon with native arm64 REAPER 7.78.
- Splice installed at `/Applications/Splice.app`, signed in to your account.
  The current patches were tested with **Splice 5.4.13 (20260921)**.
- REAPER with **js_ReaScriptAPI** installed and loaded. The Lua launcher uses its
  exported API to load the native host without restarting REAPER. Restart REAPER
  after first installing that extension.
- Xcode Command Line Tools, Python 3, and Git to build from source.
- Node.js 18 or later only if you want to run the offline checks.

This is a Cocoa/WebKit host, so only macOS is currently supported.

## Install

1. Quit the normal Splice app. ReaSplice uses the same account session, so the two
   copies must not run together.
2. Clone the repository into a location you will keep:

   ```sh
   git clone https://github.com/jamiethemorris/ReaSplice.git
   cd ReaSplice
   ```

3. Prepare the private runtime and build the native REAPER host:

   ```sh
   python3 relay/prepare-splice.py
   zsh scripts/build-native.sh
   ```

   The default build is arm64. For Intel REAPER, use
   `SPLICE_DOCK_ARCH=x86_64 zsh scripts/build-native.sh` instead. The architecture
   must match the REAPER process, including when running under Rosetta.

4. In REAPER, open **Actions → Show action list…**, choose **New action → Load
   ReaScript…**, and select `scripts/ReaSplice.lua` from this checkout.
5. Run **Script: ReaSplice.lua**. Choose **Launch ReaSplice** in the panel if it is
   disconnected. The launcher also registers **Script: Reload ReaSplice.lua**.

The build creates `build/ReaSplice.app` and a native library under `native/build/`.
It leaves `/Applications/Splice.app` unchanged. Both generated directories are
ignored by Git. Keep the checkout in place: REAPER loads the UI and library from
it. After moving it, rebuild the host and load the script from its new location.

## Use

Run **ReaSplice.lua** to open or close the tab. Drag REAPER's docker divider to
resize it. Choose **Compact** for a narrow side panel; **Full app** retains more
of Splice's desktop layout requirements.

Place the ReaSplice tab alongside your other right-hand dock tabs to share the
whole sidebar. Closing, reopening, or reloading ReaSplice preserves that dock
location instead of forcing a separate pane. REAPER stores the location in its
own docking preferences.

Browse or search through **Your Library** and **Browse**. To insert a sample,
download it through Splice and drag its sample handle into the REAPER arrangement.
Keep the mouse button held until the native file drag starts. Splice continues to
handle downloads, account permissions and credit/licensing workflows. Unavailable
files cannot be dragged and do not produce a warning; preview clicks do not start
a native drag.

The reconnect icon reconnects the viewer. The power icon quits the private Splice
runtime; use it before reopening normal Splice. Closing the tab alone does not
quit that runtime. Account dialogs and external links may open outside the dock.

### BPM preference

The controls share the settings row in Compact and occupy a separate row below
the header in Full app.

| Mode | Search filter |
| --- | --- |
| **Any BPM** | Removes the BPM constraint. |
| **Project** | Matches the active project's tempo, rounded to a whole BPM. |
| **Range** | Searches within ±10 BPM by default; adjustable from 1 to 100. |

The caption shows the project tempo and effective search values. The mode and
range are saved in REAPER preferences, and the target follows the active project.
The preference applies to sample lists in Library and Browse, including pack and
collection sample lists, while preserving search text and other filters.

Splice's filter accepts whole BPM values from 1–300. Range includes the whole BPM
values inside the requested interval, clamped to those limits. Pack discovery
cards, presets and mixed overview pages are not sample lists; the preference
takes effect when opening their Samples results.

### Splice Bridge

Bridge is optional and separate from the BPM search preference. Install Splice
Bridge, make sure REAPER has scanned it, then click **Bridge** in either Compact or
Full app. ReaSplice creates a dedicated **Splice Bridge** track in the active
project, hidden from both the track panel (TCP) and mixer (MCP), and asks Splice to
connect without opening the plugin window. The track is outside folders and
remains audible when other tracks are soloed. It is not record armed.

The **volume slider below ReaSplice's header** is always visible in both Compact
and Full app. It automatically switches between **Splice** (0–100%) when
disconnected and **Bridge** (track gain in dB) when connected. Splice's duplicate
bottom volume control is hidden. The two output levels remain independent;
switching outputs recalls the appropriate level rather than copying it.

In Bridge mode, the slider controls the hidden track's fader without changing
the master or other track levels. The far-left position silences the preview;
the remaining range is −59 to +12 dB. Each project retains its own Bridge level.
The hidden track remains accessible through REAPER's Track Manager if you need
its routing or FX. Master processing still affects previews.

**Solo** beside the top volume slider toggles solo on the hidden Bridge track.
It turns blue when active and follows the track's actual state, including changes
made in REAPER. Other tracks' existing solo settings are preserved. You can still
turn Solo off after Bridge disconnects; starting Solo requires Bridge to be
connected to the current project.

Subsequent connections reuse the marked track even after it is renamed or
reordered, preserve its volume, and hide it again. An unrelated track with the
same name is left alone. Existing Bridge on the project's master or in monitoring
FX is moved to the dedicated track with its plugin settings intact, including
instances inside containers. Other effects retain their order and settings.

Use the **…** menu in ReaSplice's header to choose what happens when switching
projects:

- **Disconnect** (default): stop the Bridge preview and return to Splice's normal
  audio output. Click Bridge when you want to connect the new project.
- **Follow active project**: while connected, automatically add or reuse Bridge
  on the new project's hidden preview track and reconnect there.

The choice is saved. **Disconnect Bridge** in the same menu disconnects at any
time. Bridge's icon is white when disconnected and blue only when Splice reports
a connection.

Bridge supports one fully active plugin instance. Connecting takes other Bridge
instances in open projects' track/master chains and monitoring FX offline, then reloads
the selected instance. The FX and their saved settings remain in place; other
plugins, including Splice Sounds, are unchanged. This avoids a preview waiting
indefinitely for Bridge in an inactive project.

Each project keeps its preview track and volume when saved. Current-project
setup is grouped in undo history; changes to other projects' Bridge offline
states are not part of that same undo entry. The hidden track still feeds the
master/render path, so stop previews before rendering.

ReaSplice initializes Splice 5.4.13's installation detector so an installed Bridge
plugin is recognized. If you install Bridge while ReaSplice is running and the
button still says **Install Bridge**, stop and relaunch the private runtime.

## Updates and troubleshooting

- **Updating ReaSplice:** stop the private runtime with the power icon, pull the
  latest repository changes, then run `python3 relay/prepare-splice.py` and
  `zsh scripts/build-native.sh`. Run **Reload ReaSplice.lua**, then launch the
  private runtime again. Version 0.10 can replace a running 0.3–0.9 host without
  restarting REAPER. Rebuilding an already loaded 0.10 host requires a REAPER
  restart to load changes to that native library.
- **After updating Splice:** stop ReaSplice with the power icon, quit normal Splice,
  then run `python3 relay/prepare-splice.py --refresh`. Preparation checks its exact
  source anchors and stops if the installed version is incompatible. ReaSplice's
  private copy does not run Splice's updater; update the normal app instead.
- **After changing UI files:** run **Reload ReaSplice.lua**. This reloads the local
  viewer without rebuilding or restarting the Splice runtime.
- **After changing native code:** quit REAPER, rebuild with
  `zsh scripts/build-native.sh`, then reopen REAPER. Native modules stay loaded
  until REAPER exits; rebuilding does not replace the running module.
- **Host will not load:** check the REAPER console, confirm js_ReaScriptAPI is
  loaded, and verify that the library architecture matches REAPER.
- **Runtime will not launch:** quit the normal Splice app and confirm preparation
  succeeded. You can also launch with `zsh relay/launch-splice.sh` from the checkout.
- **Drag ends too early:** keep holding the sample until macOS begins the native
  file drag, then release it over the arrangement.
- **Bridge cannot be loaded:** check that Splice Bridge appears in REAPER's FX
  browser. If it was just installed, rescan plug-ins and relaunch the private
  runtime. Follow the update steps above if the native controls or private
  runtime need rebuilding.

The older `Splice Dock.lua` and `Reload Splice Dock.lua` files are compatibility
aliases. The keyboard shim and its build script are retained for the original
prototype; the current v0.10 host includes keyboard routing and does not need them.

## How it works

A small Cocoa extension hosts a local WKWebView inside REAPER. A private copy of
the installed Splice Electron app renders its genuine interface offscreen. A
token-protected loopback relay carries frames and input; the real renderer resizes
with the dock. Prepared sample paths become native macOS file drags from REAPER.

Splice keeps its existing account/session storage. The relay listens only on
`127.0.0.1`, validates the host and token, and exposes a bounded command interface.
`build/relay-config.json` contains a local capability token and must stay private.
Do not redistribute the generated app bundle, account data, or downloaded sounds.

See [the relay documentation](relay/README.md) for commands and implementation
details. The active code lives in `native/`, `ui/`, `relay/`, and `scripts/`.

## Verification and limitations

Live checks on the tested setup cover library/catalog browsing and searching,
dock resizing, native dragging of owned samples, hidden-scrollbar wheel scrolling,
and BPM filtering in Library and Browse. Mode/range preferences survive reloads.
Closing/reopening and reloading the 0.7 host keep ReaSplice in the same full-height
docker as the other sidebar tabs. Persistence through a full REAPER restart uses
REAPER's saved dock preference but has not been tested in this session.
Offline track checks cover creation/reuse, hidden-track settings, fader
preservation, project handoffs, container migration and rollback. Drag checks
cover unavailable files, clicks with minor mouse movement, late preparation and
held drags. Volume and Solo checks cover queued changes, stale replies, project
switches, missing tracks and invalid values. Solo's live on/off behavior has not
yet been independently checked.
The top preview slider was also checked live at 377px dock width in Compact and
Full app: ordinary-volume changes reached Splice's shared playback store, and
connecting Bridge switched it to the independent track fader. Offline checks
cover output changes during gestures and late renderer volume reads.
Live v0.9 checks confirm master-to-hidden-track migration, TCP/MCP hiding,
no plugin popup, and the UI slider changing only the preview-track fader. Both
open projects produced Bridge playback events, with the blue icon agreeing with
both renderer playback engines; switching projects disconnected both engines.
A late disconnect handler can no longer disable a newer connection. Preview
clicks produced no drag warning. Earlier v0.8 checks confirmed
saved switching preferences, and white/blue connection colors. Connection checks
also cover handshake timeouts, delayed plugin announcements, runtime restarts and
explicit disconnection. Audible tempo synchronization across project tabs has
not been independently verified.

Audio output, new-credit purchases, all desktop-only workflows, Intel builds and
extremely narrow layouts have not been comprehensively verified. The integration
depends on Splice's shipped implementation and may need changes after an update.

Run the offline checks from the repository root:

```sh
node --check ui/app.js
node --check relay/bootstrap.js
node --check relay/tempo-renderer.js
node relay/check-relay.js
node relay/check-tempo.js
node relay/check-bridge.js
node relay/check-bridge-session.js
node ui/check-bridge-controller.js
node ui/check-bridge-volume.js
node ui/check-preview-volume.js
node relay/check-volume.js
python3 -m py_compile relay/prepare-splice.py
xcrun clang++ -std=c++17 native/check-bridge-track.cpp -o /tmp/reasplice-check-bridge-track
/tmp/reasplice-check-bridge-track
```

These checks use mocks and do not access your Splice account or spend credits.

ReaSplice is not affiliated with or endorsed by Splice or Cockos. Splice and REAPER
remain the products and trademarks of their respective owners.
