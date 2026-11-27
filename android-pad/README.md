# Tintbox Pad (Android Drawing Tablet)

Minimal, near-zero-latency Android drawing pad companion for **Tintbox** with real-time pixel-art canvas mirroring.

## Features
- **Near-zero-latency binary input**: 12-byte little-endian packets over raw `Socket` (`TCP_NODELAY` + `IPTOS_LOWDELAY`), `requestUnbufferedDispatch(event)`, and `event.historySize` unbatched stylus/touch capture.
- **Real-time Canvas Mirror (`LIVE`)**: streams composited Tintbox frames via fast RGBA-RLE binary packets and renders nearest-neighbor crisp pixels directly under your stylus (toggleable to dark slate anytime).
- **Pinch-to-Zoom & 2-Finger Pan**: zoom 1×–12× into sprite details right on the pad (`FIT` resets to 100%) with exact `[0..1]` pixel mapping + optional `GRID` overlay.
- **Gestures**: 2-finger tap = Undo, 3-finger tap = Redo (with haptic feedback).
- **Stylus Support**: hover reticle, barrel-button / tail eraser auto-flag, and `PEN ONLY` palm rejection (multi-finger zoom/undo still works with fingers!).
- **Synced Palette Strip & Express Keys**: live Tintbox palette swatches at bottom, 12 express keys (`UNDO`, `REDO`, `PEN`, `ERASE`, `FILL`, `LINE`, `PICK`, `SWAP`, `B-`, `B+`, `SYM X`, `PEN ONLY`), animation frame `< / >` stepper, and Left/Right-handed layout flip.

## Quick Start

### 1. Build & Install APK
```bash
cd tintbox-pad-android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 2. Start Bridge (for USB & Wi-Fi)
```bash
cd tintbox
npm run pad-bridge
```
In Tintbox web app: click **Pad** (top-right) → **Connect**.

### 3. Connect Android (Pick One)
- **USB (~1–2 ms, lowest latency)**:
  - Run `adb reverse tcp:8765 tcp:8765` (also auto-run by `npm run pad-bridge`).
  - In **Tintbox Pad**: **USB (adb)** → **Connect**.
- **Wi-Fi (same router)**:
  - **Setup** → **Wi-Fi LAN** → enter PC LAN IP printed by `pad-bridge` → **Save & Connect**.
- **Bluetooth (Plug-and-Play Chrome Web Serial)**:
  1. Pair Android & PC in OS Bluetooth settings.
  2. In **Tintbox Pad**: **Setup** → **Bluetooth** → select **Wait for PC (Chrome Web Serial)** → **Save & Connect**.
  3. In Tintbox (Chrome / Edge): click **Pad** → **Bluetooth Serial** → select your Android phone and click **Connect**.
