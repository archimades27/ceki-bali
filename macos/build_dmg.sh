#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="Ceki Bali"
BUNDLE_DIR="$ROOT_DIR/release/$APP_NAME.app"
STAGING_DIR="$ROOT_DIR/release/dmg_staging"
DMG_PATH="$ROOT_DIR/release/Ceki-Bali-1.0.0.dmg"

echo "1. Building offline web bundle..."
npm run build

echo "2. Generating native macOS AppIcon.icns..."
ICON_PNG="$ROOT_DIR/macos/icon_1024.png"
ICONSET_DIR="$ROOT_DIR/macos/AppIcon.iconset"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

swift - "$ICON_PNG" << 'SWIFT'
import Cocoa

let outPath = CommandLine.arguments[1]
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()

let ctx = NSGraphicsContext.current!.cgContext
let rect = CGRect(origin: .zero, size: size)

// Rounded squircle background in deep Balinese emerald + teak border
let bgPath = CGPath(roundedRect: rect.insetBy(dx: 40, dy: 40), cornerWidth: 200, cornerHeight: 200, transform: nil)
ctx.addPath(bgPath)
ctx.setFillColor(NSColor(calibratedRed: 0.06, green: 0.25, blue: 0.16, alpha: 1.0).cgColor)
ctx.fillPath()

ctx.addPath(bgPath)
ctx.setStrokeColor(NSColor(calibratedRed: 0.85, green: 0.68, blue: 0.18, alpha: 1.0).cgColor)
ctx.setLineWidth(28)
ctx.strokePath()

// Two fanned classic Ceki cards in center
func drawCard(angleDeg: CGFloat, dx: CGFloat, dy: CGFloat, fill: NSColor, border: NSColor) {
    ctx.saveGState()
    ctx.translateBy(x: 512 + dx, y: 512 + dy)
    ctx.rotate(by: angleDeg * .pi / 180)
    let cardRect = CGRect(x: -135, y: -300, width: 270, height: 600)
    let cardPath = CGPath(roundedRect: cardRect, cornerWidth: 26, cornerHeight: 26, transform: nil)
    ctx.addPath(cardPath)
    ctx.setFillColor(fill.cgColor)
    ctx.fillPath()
    ctx.addPath(cardPath)
    ctx.setStrokeColor(border.cgColor)
    ctx.setLineWidth(16)
    ctx.strokePath()

    // Inner traditional motif
    let innerRect = cardRect.insetBy(dx: 36, dy: 44)
    ctx.setStrokeColor(NSColor(calibratedRed: 0.72, green: 0.11, blue: 0.11, alpha: 1.0).cgColor)
    ctx.setLineWidth(14)
    ctx.stroke(innerRect)
    ctx.fillEllipse(in: CGRect(x: -54, y: -54, width: 108, height: 108))
    ctx.restoreGState()
}

drawCard(angleDeg: 10, dx: -70, dy: -10,
         fill: NSColor(calibratedRed: 0.96, green: 0.94, blue: 0.88, alpha: 1.0),
         border: NSColor(calibratedRed: 0.18, green: 0.12, blue: 0.09, alpha: 1.0))
drawCard(angleDeg: -10, dx: 70, dy: 10,
         fill: NSColor(calibratedRed: 0.98, green: 0.96, blue: 0.91, alpha: 1.0),
         border: NSColor(calibratedRed: 0.85, green: 0.68, blue: 0.18, alpha: 1.0))

image.unlockFocus()
if let tiff = image.tiffRepresentation,
   let rep = NSBitmapImageRep(data: tiff),
   let png = rep.representation(using: .png, properties: [:]) {
    try! png.write(to: URL(fileURLWithPath: outPath))
}
SWIFT

for sz in 16 32 128 256 512; do
  sips -z $sz $sz "$ICON_PNG" --out "$ICONSET_DIR/icon_${sz}x${sz}.png" >/dev/null
  sz2=$((sz * 2))
  sips -z $sz2 $sz2 "$ICON_PNG" --out "$ICONSET_DIR/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET_DIR" -o "$ROOT_DIR/macos/AppIcon.icns"

echo "3. Compiling native Swift app..."
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/Contents/MacOS" "$BUNDLE_DIR/Contents/Resources/web"

swiftc -O -target arm64-apple-macosx13.0 \
  -framework Cocoa -framework WebKit \
  "$ROOT_DIR/macos/main.swift" \
  -o "$BUNDLE_DIR/Contents/MacOS/CekiBali"

cp "$ROOT_DIR/macos/Info.plist" "$BUNDLE_DIR/Contents/Info.plist"
cp "$ROOT_DIR/macos/AppIcon.icns" "$BUNDLE_DIR/Contents/Resources/AppIcon.icns"
cp -R "$ROOT_DIR/dist/"* "$BUNDLE_DIR/Contents/Resources/web/"

codesign --force --deep --sign - "$BUNDLE_DIR"

echo "4. Packaging DMG installer..."
rm -rf "$STAGING_DIR" "$DMG_PATH"
mkdir -p "$STAGING_DIR"
cp -R "$BUNDLE_DIR" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create -volname "Ceki Bali" \
  -srcfolder "$STAGING_DIR" \
  -ov -format UDZO \
  "$DMG_PATH"

rm -rf "$STAGING_DIR" "$ICONSET_DIR" "$ICON_PNG"

echo "Done!"
ls -lh "$BUNDLE_DIR" "$DMG_PATH"
