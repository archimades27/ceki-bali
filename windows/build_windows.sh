#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "1. Building offline web bundle for Windows..."
npm run build

STAGE_DIR="$ROOT_DIR/release/ceki-bali-win"
ICON_PNG="$ROOT_DIR/windows/AppIcon.png"
ICON_ICO="$ROOT_DIR/windows/AppIcon.ico"
OUT_EXE="$STAGE_DIR/Ceki Bali.exe"
OUT_INSTALLER="$ROOT_DIR/release/Ceki-Bali-Setup-1.0.0.exe"
OUT_ZIP="$ROOT_DIR/release/Ceki-Bali-Windows-Portable.zip"

rm -rf "$STAGE_DIR" "$OUT_INSTALLER" "$OUT_ZIP"
mkdir -p "$STAGE_DIR/web"

cp -R "$ROOT_DIR/dist/"* "$STAGE_DIR/web/"
cp "$ROOT_DIR/windows/CekiBali.ps1" "$STAGE_DIR/CekiBali.ps1"

echo "2. Generating Windows AppIcon.ico..."
if [ -f "$ROOT_DIR/release/Ceki Bali.app/Contents/Resources/AppIcon.icns" ]; then
  sips -s format png "$ROOT_DIR/release/Ceki Bali.app/Contents/Resources/AppIcon.icns" --out "$ICON_PNG" >/dev/null
fi
python3 - << EOF
from PIL import Image
img = Image.open("$ICON_PNG").convert("RGBA")
img.save("$ICON_ICO", format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
EOF
cp "$ICON_ICO" "$STAGE_DIR/AppIcon.ico"

echo "3. Compiling Windows launcher (Ceki Bali.exe)..."
makensis -V2 -DOUT_EXE="$OUT_EXE" -DICON_FILE="$ICON_ICO" "$ROOT_DIR/windows/launcher.nsi"

echo "4. Compiling Windows GUI Installer (Ceki-Bali-Setup-1.0.0.exe)..."
makensis -V2 -DSTAGE_DIR="$STAGE_DIR" -DICON_FILE="$ICON_ICO" -DOUT_INSTALLER="$OUT_INSTALLER" "$ROOT_DIR/windows/installer.nsi"

echo "5. Creating Portable Windows ZIP..."
(cd "$ROOT_DIR/release" && zip -qr "$OUT_ZIP" "ceki-bali-win")

echo "Done!"
ls -lh "$OUT_INSTALLER" "$OUT_ZIP" "$OUT_EXE"
