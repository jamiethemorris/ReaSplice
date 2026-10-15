#!/usr/bin/env python3
"""Prepare a private Splice runtime. Never alters /Applications/Splice.app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path('/Applications/Splice.app')
BUILD = ROOT / 'build'
TARGET = BUILD / 'ReaSplice.app'
LEGACY_TARGET = BUILD / 'Splice Dock.app'


def replace_once(text, before, after, label):
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f'Splice layout changed: {label} matched {count} times; no private runtime written')
    return text.replace(before, after, 1)


def prepare(refresh=False):
    if not SOURCE.is_dir():
        raise RuntimeError(f'Splice is not installed at {SOURCE}')
    source_app = SOURCE / 'Contents/Resources/app'
    index = (source_app / 'index.js').read_text()
    digest = hashlib.sha256(index.encode()).hexdigest()
    package = json.loads((source_app / 'package.json').read_text())
    # Validate every targeted patch before creating or modifying the private copy.
    index = replace_once(index,
        '    this.window = new import_electron11.BrowserWindow({\n      ...this.options,\n      width,\n      height,\n      x: x2,\n      y: y2\n    });',
        '    this.window = new import_electron11.BrowserWindow(globalThis.__spliceDock.windowOptions(this.name, {\n      ...this.options,\n      width,\n      height,\n      x: x2,\n      y: y2\n    }));\n    globalThis.__spliceDock.windowCreated(this.name, this.window);',
        'DesktopWindow construction')
    index = replace_once(index,
        '  updateState(state) {\n    this.appState.updateWindowState(this.name, state);\n  }',
        '  updateState(state) {\n    this.appState.updateWindowState(this.name, globalThis.__spliceDock.filterWindowState(this.name, state));\n  }',
        'Window geometry persistence')
    index = replace_once(index,
        '    window2.show();\n  });\n  return new Promise((resolve6, reject) => {\n    import_electron10.ipcMain.on(eventRemoveSplashScreen,',
        '    if (!globalThis.__spliceDock.shouldKeepHidden(window2)) window2.show();\n  });\n  return new Promise((resolve6, reject) => {\n    import_electron10.ipcMain.on(eventRemoveSplashScreen,',
        'Splash visibility')
    index = replace_once(index,
        '      async init() {\n        if (channel === "dev" && !import_environment_variables14.FORCE_UPDATER)',
        '      async init() {\n        if (globalThis.__spliceDock.updatesDisabled) return;\n        if (channel === "dev" && !import_environment_variables14.FORCE_UPDATER)',
        'Automatic updater')
    index = replace_once(index,
        '      promptUpdate() {\n        this.manualUpdateCheck$.next();',
        '      promptUpdate() {\n        if (globalThis.__spliceDock.updatesDisabled) return;\n        this.manualUpdateCheck$.next();',
        'Manual updater')
    index = replace_once(index,
        '      triggerRestartForUpdate(automatic = false) {\n        const appState = this.appStateManager.appState;',
        '      triggerRestartForUpdate(automatic = false) {\n        if (globalThis.__spliceDock.updatesDisabled) return;\n        const appState = this.appStateManager.appState;',
        'Update install entrypoint')

    # Splice 5.4.13 constructs this service through its injector without calling
    # init(), so its installation streams stay empty even when Bridge is present.
    # Use the original scanner and IPC streams; never synthesize install state.
    index = replace_once(index,
        '    this.details$ = new import_rxjs29.BehaviorSubject(BRIDGE_PLUGIN);\n  }\n  static {\n    __name(this, "VstInstallManager");',
        '    this.details$ = new import_rxjs29.BehaviorSubject(BRIDGE_PLUGIN);\n    this.init().catch((error) => log.error("ReaSplice Bridge detection failed", error));\n  }\n  static {\n    __name(this, "VstInstallManager");',
        'Bridge installation detector startup')
    index = replace_once(index,
        '  async init() {\n    this.finder = new PluginFinder();\n    this.refreshInstalled();\n    this.setupIpc();\n  }',
        '  async init() {\n    if (this.finder) return;\n    this.finder = new PluginFinder();\n    this.setupIpc();\n    await this.refreshInstalled();\n  }',
        'Bridge installation detector initialization')
    index = replace_once(index,
        '    this.isVstConnected$ = this._isVstConnected$.asObservable();',
        '    this.isVstConnected$ = this._isVstConnected$.asObservable();\n    globalThis.__spliceDock.bridgeManager(this);',
        'Bridge connection observer')

    # Keep the native filter chips and the actual search request in agreement:
    # the private renderer uses Splice's own sample-search presenter/router.
    tempo_source = (ROOT / 'relay/tempo-renderer.js').read_text()
    bridge_source = (ROOT / 'relay/bridge-renderer.js').read_text()
    volume_source = (ROOT / 'relay/volume-renderer.js').read_text()
    renderer_css = (ROOT / 'relay/renderer.css').read_text()
    renderers = []
    stylesheets = []
    for surface in ('desktop-companion', 'desktop-main'):
        bundles = list((source_app / surface).glob('main.*.js'))
        if len(bundles) != 1:
            raise RuntimeError(f'Splice layout changed: expected one {surface} main bundle')
        bundle = bundles[0]
        renderer = bundle.read_text()
        renderer = replace_once(renderer,
            'this.globalSearch.register(this),this.config?.itemRemoved$',
            'this.globalSearch.register(this),globalThis.__reaSpliceTempo?.register(this),this.config?.itemRemoved$',
            surface + ' sample search registration')
        renderer = replace_once(renderer,
            'ngOnDestroy(){this.globalSearch.unregister(this)}',
            'ngOnDestroy(){globalThis.__reaSpliceTempo?.unregister(this),this.globalSearch.unregister(this)}',
            surface + ' sample search cleanup')
        # Guard the shipped asynchronous disconnect handler against a newer
        # connection event arriving while stop() is still awaiting IPC.
        receiver, helper, inner, arg, feature = ('a', 'He', 'o', 'h', 'w') if surface == 'desktop-companion' else ('C', 'qt', 'h', 'M', 'H')
        original_binding = (
            f'bindIpcEvents(){{var {receiver}=this;this.betterIpcRenderer.on("vst-connection-enabled",function(){{var {inner}=(0,{helper}.A)(function*({arg},{{previewDownload:{feature}}}){{'
            f'{receiver}.bridgeSupportsPreviewDownload$.next({feature}),{receiver}.isActive$.next(!0)}});return function({arg},{feature}){{return {inner}.apply(this,arguments)}}}}()),'
            f'this.betterIpcRenderer.on("vst-connection-lost",(0,{helper}.A)(function*(){{yield {receiver}.stop(),{receiver}.isActive$.next(!1)}}))}}')
        renderer = replace_once(renderer, original_binding,
            'bindIpcEvents(){globalThis.__reaSpliceBridge.bindEngine(this)}', surface + ' Bridge connection event ordering')
        renderer = replace_once(renderer, 'onBridgeClick(){',
            'onBridgeClick(){return globalThis.__reaSpliceBridge.request(this)}__reaSpliceOriginalBridgeClick(){',
            surface + ' Bridge button')
        renderer = replace_once(renderer, 'this.initializeVolume(),',
            'globalThis.__reaSpliceVolume.bind(this.playbackService,this.zone),this.initializeVolume(),',
            surface + ' playback volume service')
        for tooltip in ('Activate Bridge', 'Deactivate Bridge', 'Add Bridge to a track in your DAW'):
            renderer = replace_once(renderer, json.dumps(tooltip),
                '"Connect Bridge to REAPER"', surface + ' Bridge tooltip: ' + tooltip)
        renderers.append((bundle.relative_to(source_app), tempo_source + '\n' + bridge_source + '\n' + volume_source + '\n' + renderer))
        styles = list((source_app / surface).glob('styles.*.css'))
        if len(styles) != 1:
            raise RuntimeError(f'Splice layout changed: expected one {surface} stylesheet')
        stylesheet = styles[0]
        stylesheets.append((stylesheet.relative_to(source_app), stylesheet.read_text() + '\n' + renderer_css))

    # Even an in-place bootstrap refresh changes executable resources. Never
    # update them while the private runtime is using this bundle.
    for bundle in (TARGET, LEGACY_TARGET):
        executable = str(bundle / 'Contents/MacOS/Splice')
        processes = subprocess.run(['pgrep', '-f', executable], capture_output=True, text=True)
        if processes.returncode == 0:
            raise RuntimeError('Private ReaSplice is running; quit it before rebuilding its bundle')
        if processes.returncode != 1:
            raise RuntimeError('Cannot inspect running processes; retry preparation with local process access')
    BUILD.mkdir(parents=True, exist_ok=True)
    if LEGACY_TARGET.exists() and not TARGET.exists():
        LEGACY_TARGET.rename(TARGET)
    manifest_file = BUILD / 'splice-runtime.json'
    existing = json.loads(manifest_file.read_text()) if manifest_file.exists() else {}
    if TARGET.exists() and (refresh or existing.get('sourceSha256') != digest):
        # This directory is exclusively a generated artifact owned by this project.
        shutil.rmtree(TARGET)
    if not TARGET.exists():
        print('Cloning the installed Splice bundle into build/ReaSplice.app...')
        subprocess.run(['/bin/cp', '-cR', str(SOURCE), str(TARGET)], check=True)

    app_dir = TARGET / 'Contents/Resources/app'
    (app_dir / 'index.js').write_text(index)
    for relative, renderer in renderers:
        (app_dir / relative).write_text(renderer)
    for relative, stylesheet in stylesheets:
        (app_dir / relative).write_text(stylesheet)
    shutil.copyfile(ROOT / 'relay/bootstrap.js', app_dir / 'dock-bootstrap.js')
    shutil.copyfile(ROOT / 'relay/bridge-session.js', app_dir / 'bridge-session.js')
    package['main'] = 'dock-bootstrap.js'
    (app_dir / 'package.json').write_text(json.dumps(package, indent=2) + '\n')
    config_path = BUILD / 'relay-config.json'
    if config_path.exists():
        config = json.loads(config_path.read_text())
    else:
        config = {'baseUrl': 'http://127.0.0.1:17864', 'port': 17864, 'token': secrets.token_urlsafe(32)}
    config.update({'appPath': str(TARGET), 'sourceVersion': package.get('versionString', package['version'])})
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    config_path.chmod(0o600)
    (app_dir / 'dock-options.json').write_text(json.dumps({'configPath': str(config_path)}) + '\n')

    # macOS binds the executable signature to Info.plist. Preserve it byte for
    # byte; changing display names or Sparkle keys makes LaunchServices reject
    # this copy. Updater initialization/manual/install are disabled above, before
    # the JS updater can load libconveyor. Account credentials stay in Splice.
    shutil.copyfile(SOURCE / 'Contents/Info.plist', TARGET / 'Contents/Info.plist')
    manifest = {'source': str(SOURCE), 'target': str(TARGET), 'sourceSha256': digest,
                'sourceVersion': package.get('versionString', package['version']),
                'note': 'Private local copy. Original app unchanged. Account session remains in Splice userData.'}
    manifest_file.write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared {TARGET}')
    print(f'Relay config: {config_path} (capability token not printed)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='Recreate the generated bundle from the installed version')
    args = parser.parse_args()
    try:
        prepare(args.refresh)
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f'Cannot prepare ReaSplice: {error}', file=sys.stderr)
        sys.exit(1)
