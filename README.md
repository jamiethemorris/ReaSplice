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
- **A separate REAPER docker tab.** Opens in docker 1 and can share the right-hand
  docker with other tools. TK Workbench is not required.
- **Native sample drag-and-drop.** Download through Splice, then drag the prepared
  audio file into REAPER.
- **Project-aware BPM searches.** Choose any BPM, the current project BPM, or an
  adjustable range around it in both Library and Browse sample searches.
- **Matching appearance.** The header and BPM controls use Splice's dark grays and
  blue accents. Scrollbars are hidden; mouse-wheel and trackpad scrolling remain
  enabled.
- **No extra macOS Dock icon.** The private Splice runtime stays available through
  the REAPER panel.

## Requirements

- macOS 12 or later. Tested on Apple Silicon with native arm64 REAPER 7.78.
- Splice installed at `/Applications/Splice.app`, signed in to your account.
  The current patches were tested with **Splice 5.4.13 (20260921)**.
- REAPER with **js_ReaScriptAPI** installed and loaded. The Lua launcher uses its
  exported API to load the native host without restarting REAPER. Restart REAPER
  after first installing that extension.
- Xcode Command Line Tools, Python 3, and Git to build from source.
- Node.js 18 or later only if you want to run the offline checks.

Intel builds can be requested, but have not been tested. Windows and Linux are
not supported by this Cocoa/WebKit host.

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

Browse or search through **Your Library** and **Browse**. To insert a sample,
download it through Splice and drag its sample handle into the REAPER arrangement.
Keep the mouse button held until the native file drag starts. Splice continues to
handle downloads, account permissions and credit/licensing workflows.

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

## Updates and troubleshooting

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

The older `Splice Dock.lua` and `Reload Splice Dock.lua` files are compatibility
aliases. The keyboard shim and its build script are retained for the original
prototype; the current v0.4 host includes keyboard routing and does not need them.

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
python3 -m py_compile relay/prepare-splice.py
```

These checks use mocks and do not access your Splice account or spend credits.

ReaSplice is not affiliated with or endorsed by Splice or Cockos. Splice and REAPER
remain the products and trademarks of their respective owners.
