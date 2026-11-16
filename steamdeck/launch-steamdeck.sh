#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$HERE/web"

if [ ! -f "$WEB_DIR/index.html" ]; then
  echo "Error: web/index.html tidak ditemukan di $WEB_DIR" >&2
  exit 1
fi

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WEB_DIR" >/dev/null 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

URL="http://127.0.0.1:${PORT}/index.html"

# Wait briefly until local server responds
for _ in $(seq 1 20); do
  if python3 -c "import urllib.request; urllib.request.urlopen('$URL')" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

CHROME_FLAGS=(
  "--app=$URL"
  "--window-size=1280,800"
  "--start-fullscreen"
  "--no-first-run"
  "--disable-infobars"
  "--autoplay-policy=no-user-gesture-required"
)

if command -v google-chrome >/dev/null 2>&1; then
  exec google-chrome "${CHROME_FLAGS[@]}"
elif command -v chromium >/dev/null 2>&1; then
  exec chromium "${CHROME_FLAGS[@]}"
elif command -v chromium-browser >/dev/null 2>&1; then
  exec chromium-browser "${CHROME_FLAGS[@]}"
elif command -v flatpak >/dev/null 2>&1 && flatpak info com.google.Chrome >/dev/null 2>&1; then
  exec flatpak run com.google.Chrome "${CHROME_FLAGS[@]}"
elif command -v flatpak >/dev/null 2>&1 && flatpak info org.chromium.Chromium >/dev/null 2>&1; then
  exec flatpak run org.chromium.Chromium "${CHROME_FLAGS[@]}"
elif command -v flatpak >/dev/null 2>&1 && flatpak info com.microsoft.Edge >/dev/null 2>&1; then
  exec flatpak run com.microsoft.Edge "${CHROME_FLAGS[@]}"
elif command -v firefox >/dev/null 2>&1; then
  exec firefox --kiosk "$URL"
elif command -v flatpak >/dev/null 2>&1 && flatpak info org.mozilla.firefox >/dev/null 2>&1; then
  exec flatpak run org.mozilla.firefox --kiosk "$URL"
else
  echo "Membuka via browser default: $URL"
  xdg-open "$URL"
  wait "$SERVER_PID"
fi
