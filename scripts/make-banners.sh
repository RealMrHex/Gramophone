#!/bin/sh
# README banner + GitHub social preview from design/banner.html (headless Chrome, then JPEG via sips).
#   npm run banners
# Uses the screenshots in .github/assets/ — refresh those first if the app's look changed.
set -e
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT=.github/assets
TMP=$(mktemp -d)
render() { # $1 layout, $2 width, $3 height, $4 scale, $5 output, $6 jpeg quality
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --virtual-time-budget=3000 \
    --window-size="$2,$3" --force-device-scale-factor="$4" --screenshot="$TMP/$1.png" "file://$PWD/design/banner.html#$1" >/dev/null 2>&1
  sips -s format jpeg -s formatOptions "$6" "$TMP/$1.png" --out "$OUT/$5" >/dev/null
}
render readme 1280 420 2 banner.jpg 84         # 2560×840, crisp on retina READMEs
render social 1280 640 1 social-preview.jpg 88 # GitHub wants 1280×640 and < 1 MB
rm -rf "$TMP"
ls -la "$OUT/banner.jpg" "$OUT/social-preview.jpg"
