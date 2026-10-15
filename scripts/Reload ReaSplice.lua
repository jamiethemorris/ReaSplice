-- @description ReaSplice: Reload the browser interface
local script = debug.getinfo(1, 'S').source:sub(2)
local root = script:match('^(.*)/scripts/[^/]+$')
if not root then error('Cannot resolve the ReaSplice project directory.') end
local action = reaper.NamedCommandLookup('_REASPLICETOGGLE')
if action == 0 or reaper.GetToggleCommandState(action) == -1 or reaper.GetExtState('ReaSplice', 'native_version') ~= '0.10.0' then
  dofile(root .. '/scripts/ReaSplice.lua')
else
  local arch = reaper.GetOS() == 'macOS-arm64' and 'arm64' or 'x86_64'
  reaper.SetExtState('ReaSplice', 'ui_path', root .. '/ui/index.html', false)
  local reload, message = package.loadlib(root .. '/native/build/reaper_reasplice-v10-' .. arch .. '.dylib', 'ReaSpliceV10_Reload')
  if not reload then error(tostring(message)) end
  reload()
end
