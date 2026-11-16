#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "1. Building offline web bundle for Steam Deck..."
npm run build

STAGE_DIR="$ROOT_DIR/release/ceki-bali-steamdeck"
TAR_PATH="$ROOT_DIR/release/Ceki-Bali-SteamDeck.tar.gz"

rm -rf "$STAGE_DIR" "$TAR_PATH"
mkdir -p "$STAGE_DIR/web"

cp -R "$ROOT_DIR/dist/"* "$STAGE_DIR/web/"
cp "$ROOT_DIR/steamdeck/launch-steamdeck.sh" "$STAGE_DIR/launch-steamdeck.sh"
cp "$ROOT_DIR/steamdeck/STEAM_DECK_INSTALL.md" "$STAGE_DIR/STEAM_DECK_INSTALL.md"
chmod +x "$STAGE_DIR/launch-steamdeck.sh"

if [ -f "$ROOT_DIR/release/Ceki Bali.app/Contents/Resources/AppIcon.icns" ]; then
  sips -s format png "$ROOT_DIR/release/Ceki Bali.app/Contents/Resources/AppIcon.icns" --out "$STAGE_DIR/icon.png" >/dev/null 2>&1 || true
fi

tar -czf "$TAR_PATH" -C "$ROOT_DIR/release" "ceki-bali-steamdeck"
echo "Done! Steam Deck package created at:"
ls -lh "$TAR_PATH"
