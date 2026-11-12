#!/bin/sh
# Android launcher icons + splash from the same source as the PWA icons (design/icon-source.png).
#   npm run icons:android
# Adaptive icon: the artwork sits in the 72dp safe zone of the 108dp layer, on a background of the art's own
# corner colour, so any launcher mask (circle, squircle, teardrop) keeps the whole record visible.
set -e
cd "$(dirname "$0")/.."
SRC="${1:-design/icon-source.png}"
BG="160d0d"          # sampled from the artwork's corners
SPLASH_BG="160d0d"
RES=android/app/src/main/res
[ -f "$SRC" ] || { echo "✗ source image not found: $SRC"; exit 1; }
TMP=$(mktemp -d)

for pair in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  d=${pair%%:*}; rest=${pair#*:}; legacy=${rest%%:*}; fg=${rest#*:}
  out="$RES/mipmap-$d"
  sips -z "$legacy" "$legacy" "$SRC" --out "$out/ic_launcher.png" >/dev/null
  cp "$out/ic_launcher.png" "$out/ic_launcher_round.png"
  inner=$((fg * 70 / 100))
  sips -z "$inner" "$inner" "$SRC" --out "$TMP/fg.png" >/dev/null
  sips -p "$fg" "$fg" --padColor "$BG" "$TMP/fg.png" --out "$out/ic_launcher_foreground.png" >/dev/null 2>&1
done
cat > "$RES/values/ic_launcher_background.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#$BG</color>
</resources>
XML

# splash: the record icon, small and centred on the app's dark background
for f in "$RES"/drawable*/splash.png; do
  w=$(sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2}'); h=$(sips -g pixelHeight "$f" | awk '/pixelHeight/{print $2}')
  m=$w; [ "$h" -lt "$m" ] && m=$h
  s=$((m * 30 / 100))
  sips -z "$s" "$s" "$SRC" --out "$TMP/s.png" >/dev/null
  sips -p "$h" "$w" --padColor "$SPLASH_BG" "$TMP/s.png" --out "$f" >/dev/null 2>&1
done
rm -rf "$TMP"
echo "✓ Android launcher icons + splash written to $RES"
