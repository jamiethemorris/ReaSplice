-- @description ReaSplice: Reload (legacy action alias)
-- Preserve existing Action registrations and shortcuts after the rename.
local script = debug.getinfo(1, 'S').source:sub(2)
local directory = script:match('^(.*)/[^/]+$')
dofile(directory .. '/Reload ReaSplice.lua')
