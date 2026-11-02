#!/usr/bin/env bash
# Regenerates extension/icons/*.png from the SVG sources in this folder.
# Requires ImageMagick 7 (`magick`) built with the librsvg delegate.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../../extension/icons"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"

# 16px: dedicated pixel-aligned plain "Z" (the arrow tips turn to mush at 16).
magick -background none "$here/icon-16.svg" -resize 16x16 "PNG32:$out/icon-16.png"
# 32px: dedicated pixel-aligned arrow-Z.
magick -background none "$here/icon-32.svg" -resize 32x32 "PNG32:$out/icon-32.png"
# 48px: large design with most of the transparent margin trimmed.
sed 's/viewBox="0 0 128 128"/viewBox="4 4 120 120"/' "$here/icon-large.svg" > "$tmp/icon-48.svg"
magick -background none -density 36 "$tmp/icon-48.svg" -resize 48x48 "PNG32:$out/icon-48.png"
# 128px: large design with the usual store-style margin.
magick -background none "$here/icon-large.svg" -resize 128x128 "PNG32:$out/icon-128.png"

magick identify "$out"/icon-*.png
