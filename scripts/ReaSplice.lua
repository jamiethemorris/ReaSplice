-- @description ReaSplice: Open or close the responsive Splice browser
-- @version 0.10.0
local script = debug.getinfo(1, 'S').source:sub(2)
local root = script:match('^(.*)/scripts/[^/]+$')
if not root then error('Cannot resolve the ReaSplice project directory.') end
local arch = reaper.GetOS() == 'macOS-arm64' and 'arm64' or 'x86_64'
local action = reaper.NamedCommandLookup('_REASPLICETOGGLE')
local expectedVersion = '0.10.0'
local library = root .. '/native/build/reaper_reasplice-v10-' .. arch .. '.dylib'
reaper.SetExtState('ReaSplice', 'ui_path', root .. '/ui/index.html', false)

if action == 0 or reaper.GetToggleCommandState(action) == -1 or reaper.GetExtState('ReaSplice', 'native_version') ~= expectedVersion then
  -- Resolve the new module first. Versioned filenames, symbols and Objective-C
  -- classes let old machine code remain safely pinned while callbacks migrate.
  local load, message = package.loadlib(library, 'ReaSpliceV10_Load')
  if not load then error('Could not load ReaSplice 0.10: ' .. tostring(message)) end
  local unloadNew, unloadMessage = package.loadlib(library, 'ReaSpliceV10_Unload')
  if not unloadNew then error('Invalid ReaSplice 0.10 module: ' .. tostring(unloadMessage)) end
  local restorePrevious, previousWasOpen

  if action ~= 0 and reaper.GetToggleCommandState(action) ~= -1 then
    local previousVersion = reaper.GetExtState('ReaSplice', 'native_version')
    local previousModules = {
      ['0.3.0'] = {'-', 'ReaSplice_'},
      ['0.4.0'] = {'-v04-', 'ReaSpliceV04_'},
      ['0.5.0'] = {'-v05-', 'ReaSpliceV05_'},
      ['0.6.0'] = {'-v06-', 'ReaSpliceV06_'},
      ['0.7.0'] = {'-v07-', 'ReaSpliceV07_'},
      ['0.8.0'] = {'-v08-', 'ReaSpliceV08_'},
      ['0.9.0'] = {'-v09-', 'ReaSpliceV09_'},
    }
    local module = previousModules[previousVersion]
    if not module then error('Restart REAPER to upgrade this unknown ReaSplice host: ' .. previousVersion) end
    local suffix, prefix = module[1], module[2]
    local previousLibrary = root .. '/native/build/reaper_reasplice' .. suffix .. arch .. '.dylib'
    local unload, problem = package.loadlib(previousLibrary, prefix .. 'Unload')
    restorePrevious = package.loadlib(previousLibrary, prefix .. 'Load')
    if not unload or not restorePrevious then error('Cannot safely migrate the previous ReaSplice host: ' .. tostring(problem)) end
    previousWasOpen = reaper.GetToggleCommandState(action) == 1
    unload()
  end

  -- Also support upgrading directly from the original Splice Dock prototype.
  local previous = reaper.NamedCommandLookup('_SPLICEDOCKTOGGLE')
  if previous ~= 0 and reaper.GetToggleCommandState(previous) ~= -1 then
    local unloadKeys = package.loadlib(root .. '/native/build/splice_dock_keyboard-' .. arch .. '.dylib', 'SpliceDockKeyboard_Unload')
    if unloadKeys then unloadKeys() end
    local unload, message = package.loadlib(root .. '/native/build/reaper_splice_dock-' .. arch .. '.dylib', 'SpliceDock_Unload')
    if not unload then error('Cannot unload the earlier host: ' .. tostring(message)) end
    unload()
  end
  load()
  action = reaper.NamedCommandLookup('_REASPLICETOGGLE')
  if action == 0 or reaper.GetToggleCommandState(action) == -1 or reaper.GetExtState('ReaSplice', 'native_version') ~= expectedVersion then
    unloadNew()
    if restorePrevious then
      restorePrevious()
      if previousWasOpen then reaper.Main_OnCommand(action, 0) end
    end
    error('ReaSplice 0.10 did not initialize. The previous host was restored when available; see the REAPER console.')
  end
end
if action == 0 or reaper.GetToggleCommandState(action) == -1 then
  error('ReaSplice did not initialize. See the REAPER console for details.')
end
reaper.AddRemoveReaScript(true, 0, root .. '/scripts/ReaSplice.lua', true)
reaper.AddRemoveReaScript(true, 0, root .. '/scripts/Reload ReaSplice.lua', true)
reaper.Main_OnCommand(action, 0)
