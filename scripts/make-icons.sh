#!/bin/sh
# Turn one square source image (ideally 1024×1024 PNG, full-bleed, no rounded corners) into every icon the app uses.
#   npm run icons                     → uses design/icon-source.png
#   npm run icons -- path/to/art.png  → any other file
# Needs macOS (sips) and Google Chrome (for the padded maskable / rounded variants).
set -e
cd "$(dirname "$0")/.."
SRC="${1:-design/icon-source.png}"
OUT="public/icons"
BG="#0c0a0b"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

[ -f "$SRC" ] || { echo "✗ source image not found: $SRC"; exit 1; }
[ -x "$CHROME" ] || { echo "✗ Google Chrome not found at $CHROME"; exit 1; }
W=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/{print $2}'); H=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/{print $2}')
[ "$W" = "$H" ] || echo "! source is ${W}×${H}, not square — it will be centre-cropped"
[ "$W" -ge 512 ] || echo "! source is only ${W}px — 1024px gives the sharpest results"

TMP=$(mktemp -d)
cp "$SRC" "$TMP/src.png"
# render a 512×512 composition: $1 = output, $2 = artwork scale (1 = full bleed), $3 = corner radius in px
render() {
  cat > "$TMP/c.html" <<HTML
<html><body style="margin:0;background:transparent">
<div id="box" style="width:512px;height:512px;background:$BG;border-radius:$3px;overflow:hidden;display:grid;place-items:center">
<img id="art" src="src.png" style="width:calc(512px*$2);height:calc(512px*$2);object-fit:cover;border-radius:calc($3px*$2)"></div>
<script>
  // pad with the artwork's own background: average of its four corners
  const img = document.getElementById('art')
  img.onload = () => {
    try {
      const c = document.createElement('canvas'), n = 64; c.width = c.height = n
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, n, n)
      let r = 0, gg = 0, b = 0, k = 0
      for (const [x, y] of [[0, 0], [n - 6, 0], [0, n - 6], [n - 6, n - 6]]) {
        const d = g.getImageData(x, y, 6, 6).data
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; k++ }
      }
      document.getElementById('box').style.background = 'rgb(' + [r, gg, b].map(v => Math.round(v / k)).join(',') + ')'
    } catch (e) { /* keep the default */ }
  }
</script>
</body></html>
HTML
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --virtual-time-budget=2000 --default-background-color=00000000 \
    --window-size=512,512 --force-device-scale-factor=1 --screenshot="$TMP/$1" "file://$TMP/c.html" >/dev/null 2>&1
}
render any.png 1 0          # full bleed: browsers/OSes apply their own mask
render maskable.png 0.8 0   # artwork inside Android's 80% safe zone, padded with the art's own corner colour
render rounded.png 1 112    # rounded tile for the browser-tab favicon

cp "$TMP/any.png" "$OUT/icon-512.png"
cp "$TMP/any.png" "$OUT/icon-192.png";        sips -z 192 192 "$OUT/icon-192.png" >/dev/null
cp "$TMP/any.png" "$OUT/apple-touch-icon.png"; sips -z 180 180 "$OUT/apple-touch-icon.png" >/dev/null
cp "$TMP/maskable.png" "$OUT/maskable-512.png"
cp "$TMP/rounded.png" "$OUT/favicon.png";      sips -z 64 64 "$OUT/favicon.png" >/dev/null
rm -rf "$TMP"
echo "✓ icons written to $OUT: icon-512, icon-192, apple-touch-icon (180), maskable-512, favicon (64)"
