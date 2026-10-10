#!/bin/zsh
set -euo pipefail
task_root="${0:A:h:h}"
task_bundle="$task_root/build/ReaSplice.app"
if [[ ! -d "$task_bundle" ]]; then
  /usr/bin/python3 "$task_root/relay/prepare-splice.py"
fi
if /usr/bin/pgrep -f '^/Applications/Splice.app/Contents/MacOS/Splice' >/dev/null; then
  print -u2 'Quit the normal Splice app first. ReaSplice uses the same Splice account session and must run alone.'
  exit 1
fi
exec /usr/bin/open -n "$task_bundle"
