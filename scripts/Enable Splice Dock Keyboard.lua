-- @description Splice Dock: Enable safe keyboard routing
-- Load this once into the current session after opening the Splice Dock panel.
local script = debug.getinfo(1, 'S').source:sub(2)
local root = script:match('^(.*)/scripts/[^/]+$')
if not root then error('Cannot resolve the Splice Dock project directory.') end
reaper.SetExtState('SpliceDock', 'ui_path', root .. '/ui/index.html', false)
local arch = reaper.GetOS() == 'macOS-arm64' and 'arm64' or 'x86_64'
local load, message = package.loadlib(root .. '/native/build/splice_dock_keyboard-' .. arch .. '.dylib', 'SpliceDockKeyboard_Load')
if not load then error(tostring(message)) end
load()
