# Tintbox

Browser-based pixel-art studio paired with **Tintbox Pad**, a minimal near-zero-latency Android drawing pad companion.

## Repository Layout
- `/` — **Tintbox Web Studio** (Vite + strict TypeScript + vanilla DOM + Canvas 2D)
- `/scripts/pad-bridge.mjs` — Zero-dependency `TCP_NODELAY` binary WebSocket relay for USB & Wi-Fi pad connections
- `/android-pad` — **Tintbox Pad** native Kotlin Android companion app

## Highlights

### Tintbox Web Studio
- **Photoshop-style layers & groups**: inline rename (`F2`), duplicate (`Ctrl+J`), reorder (`Ctrl+]`/`[`), drag in/out of groups, `Ctrl+Click` pixel/group selection, clipping masks, alpha lock, and non-destructive `fx` modifier trees (Outline, Drop Shadow, Dither, Light, Tone, Warp).
- **Drawing & pixel tools**: Pencil (pixel-perfect mode), Dither brush, Gradient, Eraser, Line, Vector/Bezier Curve, Live Shapes, Flood Fill, Eyedropper, Rect/Lasso/Wand selections, Direct-canvas Resize & Free Warp, Symmetry (X/Y/XY + axis lock), Repeat Tile Mode.
- **Animation & Tilemap**: Timeline with Onion Skinning, named animation tags, Batch Smart Commands (`Alt+O/S/A/T`), Selection Slices (`Alt+K` + ZIP export), Independent Navigator, and Map Builder with tile rotate/flip (`Alt+[/]/H/V`).
- **Palettes & I/O**: Reference image palette extraction (4/8/16 colors), Orphan pixel cleaner, `.tintbox`, `.ase`/`.aseprite`, `.psd`, Animated GIF import, and PNG/BMP/PSD/GIF/JS export.
- **Preferences (`Ctrl+,`)**: 5 themes + System auto, 6 accents, 85–125% UI scale, density, checkerboard/grid customization, history limits, and JSON preferences backup.

### Tintbox Pad (`android-pad/`)
- **Near-zero-latency binary input**: 12-byte little-endian protocol over raw `Socket` (`TCP_NODELAY` + `IPTOS_LOWDELAY`), `requestUnbufferedDispatch`, and `event.historySize` unbatched stylus/touch sampling.
- **Real-time Canvas Mirror (`LIVE`)**: streams composited Tintbox frames via fast RGBA-RLE binary packets rendered crisp (nearest-neighbor) under your stylus.
- **Tablet essentials**: Pinch-to-Zoom (1×–12×) & 2-finger pan with exact pixel mapping, 2-finger tap Undo / 3-finger tap Redo, synced color palette strip, 12 Express Keys, stylus hover & barrel/tail eraser, `PEN ONLY` palm rejection, animation frame stepper, and Left/Right-handed layout flip.
- **3 Transports**: USB (`adb reverse`), Wi-Fi LAN, and Bluetooth RFCOMM SPP (plug-and-play Chrome Web Serial).

## Quick Start

### Web Studio
```bash
npm install
npm run dev
```

### Verify Types, Tests & Production Build
```bash
npm run check
```

### Connect Android Drawing Pad
1. Build & install the Android app:
   ```bash
   cd android-pad
   ./gradlew assembleDebug
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
2. Start the local bridge (for USB / Wi-Fi):
   ```bash
   npm run pad-bridge
   ```
3. In Tintbox, click **Pad** in the top-right bar → **Connect** (or **Bluetooth Serial** for BT).
4. See [android-pad/README.md](android-pad/README.md) for USB, Wi-Fi, and Bluetooth connection steps.

## License
[MIT](LICENSE)
