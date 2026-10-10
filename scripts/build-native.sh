#!/bin/zsh
set -euo pipefail

project_root="${0:A:h:h}"
build_dir="$project_root/native/build"
mkdir -p "$build_dir"
arch="${SPLICE_DOCK_ARCH:-arm64}"
ui_file="$project_root/ui/index.html"
output_file="$build_dir/reaper_reasplice-v05-$arch.dylib"
temporary_file="$build_dir/.reaper_reasplice-v05-$arch.$$.dylib"
trap 'rm -f "$temporary_file"' EXIT

sources=("$project_root/native/host.mm")
if [[ -f "$project_root/native/bridge.mm" ]]; then
  sources+=("$project_root/native/bridge.mm")
fi

xcrun clang++ -std=c++17 -dynamiclib -arch "$arch" -mmacosx-version-min=12.0 \
  -fobjc-arc -fvisibility=hidden -Wall -Wextra -Wno-unused-parameter \
  -install_name "@rpath/reaper_reasplice-v05-$arch.dylib" \
  '-DSPLICE_DOCK_UI_PATH="'"$ui_file"'"' \
  -framework Cocoa -framework WebKit "${sources[@]}" \
  -o "$temporary_file"
codesign --force --sign - "$temporary_file"
# A loaded dylib may still be mapped in REAPER. Never truncate its inode.
mv -f "$temporary_file" "$output_file"
print -r -- "$output_file"
