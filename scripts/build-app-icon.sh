#!/bin/zsh
# Regenerates macos/Resources/AppIcon.icns from AppIcon.svg. Needs rsvg-convert
# (brew install librsvg). The .icns is checked in so normal builds do not need it.
set -euo pipefail

repo_dir="${0:A:h}/.."
svg="$repo_dir/macos/Resources/AppIcon.svg"
iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset"

for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" "$svg" -o "$iconset/icon_${size}x${size}.png"
  double=$((size * 2))
  rsvg-convert -w "$double" -h "$double" "$svg" -o "$iconset/icon_${size}x${size}@2x.png"
done

iconutil -c icns "$iconset" -o "$repo_dir/macos/Resources/AppIcon.icns"
print "Wrote macos/Resources/AppIcon.icns"
