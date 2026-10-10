#!/bin/zsh
set -euo pipefail
project_root="${0:A:h:h}"
build_dir="$project_root/native/build"
mkdir -p "$build_dir"
arch="${SPLICE_DOCK_ARCH:-arm64}"
output_file="$build_dir/splice_dock_keyboard-$arch.dylib"
temporary_file="$build_dir/.splice_dock_keyboard-$arch.$$.dylib"
trap 'rm -f "$temporary_file"' EXIT
xcrun clang++ -std=c++17 -dynamiclib -arch "$arch" -mmacosx-version-min=12.0 \
  -fobjc-arc -fvisibility=hidden -Wall -Wextra -Wno-unused-parameter \
  -install_name "@rpath/splice_dock_keyboard-$arch.dylib" \
  -framework Cocoa -framework WebKit "$project_root/native/keyboard-shim.mm" -o "$temporary_file"
codesign --force --sign - "$temporary_file"
mv -f "$temporary_file" "$output_file"
print -r -- "$output_file"
