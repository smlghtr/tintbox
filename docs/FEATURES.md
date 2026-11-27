# Feature Spec

Every feature has an ID, exact behavior, and acceptance criteria (AC). Build in phase order (see `BUILD-PLAN.md`). Do not invent behavior not written here. If a spec is ambiguous, pick the simplest option, write the choice in `docs/DECISIONS.md`, move on.

Legend: **[done]** exists in repo today. **[P1..P6]** phase.

---

## 1. Canvas, viewport, zoom

### F-ZOOM [P1]
- Zoom is **integer only**. Steps: `1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64` (x). Never fractional, never blurry. Canvas CSS `image-rendering: pixelated`.
- Mouse wheel: one step per notch. Ctrl+wheel and trackpad pinch: same. `+` / `-` keys step. `1` key = 100%. `0` key = fit to viewport (largest step that fits with 16px padding).
- **Anchor on cursor**: pixel under cursor stays under cursor after zoom. Keyboard zoom anchors on viewport center.
- Pan: Space+drag, middle-mouse drag, or Hand tool. Scrollbars optional. Pan clamps so at least 32px of canvas stays visible.
- Pixel grid overlay: shown only when zoom >= 8x, 1px lines at 12% ink alpha, toggle `#`. Never exported.
- Status bar shows: zoom %, cursor pixel `x, y`, canvas size, active color hex under cursor.
- Touch: two-finger pinch zoom + pan, one finger draws. Stylus pressure ignored in v1.
- AC: zoom 3x then wheel at canvas corner keeps that pixel under pointer (±0 px). No fractional zoom value ever in state. Resize window keeps center.

### F-CANVAS [P1]
- New document dialog: width, height (1..1024 each), presets 16, 32, 64, 128, 256, background transparent (default).
- Resize canvas (anchor 9-point grid, crop or pad transparent) and scale (nearest-neighbor only). Both undoable.
- Transparent checkerboard behind canvas, fixed screen-space squares (not scaled with zoom).
- Repeat Tile Mode (F-TILEMODE): see 8.

---

## 2. Drawing tools

All tools: draw on the **active layer's active cel**, honor selection mask, layer lock, alpha lock, symmetry. One stroke = one undo step.

| ID | Tool | Key | Behavior |
|---|---|---|---|
| F-PEN [done, P1 extend] | Pencil | B | 1..32px square or round brush (size slider, `[` `]` keys). Pixel-perfect mode toggle (default on): removes L-corner doubles on size 1. Interpolates between pointer events with Bresenham, never skips pixels on fast drags |
| F-ERASER [done, P1 extend] | Eraser | E | Same brush options, writes alpha 0 |
| F-LINE [done] | Line | L | Drag. Shift = snap to 15 degree steps. Live preview |
| F-CURVE [done] | Curve | C | Drag ends, click to bend, click to commit, Esc cancel. Replaced by live vector paths in P6 |
| F-RECT / F-ELLIPSE [P1] | Rectangle, Ellipse | U / O | Drag. Shift = square/circle. Alt = from center. Outline or filled toggle. Midpoint algorithm, no gaps |
| F-FILL [done] | Bucket | G | 4-way flood, tolerance 0 default (exact RGBA match). Options: contiguous / global, sample layer / all visible |
| F-PICK [done, P2 extend] | Color grabber | I | See F-GRAB |
| F-MOVE [P1] | Move | V | Moves selection content, or whole cel if no selection. Arrow keys nudge 1px. Wrap-around toggle |
| F-SELECT [P1] | Rect select, Lasso select, Magic wand | M / Q / W | See 2.1 |
| F-HAND [P1] | Pan | H | |
| F-DITHER [P6] | Dither brush | D | Bayer 2x2/4x4 patterns, density slider |

AC (all tools): fast diagonal drag across the canvas leaves a gap-free 1px line. Drawing outside the canvas edge clips, never throws. Pointer events captured, so drag continues outside the canvas element.

### 2.1 Selection [P1]
- Mask is a 1-bit-per-pixel buffer, same size as canvas. Marching-ants outline drawn on an overlay, animation disabled under `prefers-reduced-motion`.
- Modes: replace (default), add (Shift), subtract (Alt), intersect (Shift+Alt).
- Ctrl+A all, Ctrl+D deselect, Ctrl+I invert. Ctrl+C / X / V copy, cut, paste (paste lands at viewport center on a floating layer until committed with Enter, canceled with Esc).
- Selection is undoable.

### F-SYMMETRY [P1]
- Mirror X, mirror Y, or both. Axis defaults to canvas center, draggable. Applies to pen, eraser, line, shapes, fill off.
- AC: odd and even canvas widths both mirror exactly (no 1px offset between halves).

### F-ORPHAN: Orphan pixel remover [P2]
Definition: an **orphan pixel** is a non-transparent pixel with **no 4-connected neighbor of the same RGBA color** (a lone dot). Optional stricter mode: no 8-connected same-color neighbor.

Command: `Edit > Clean orphan pixels` + panel with:
- Connectivity: 4 (default) | 8.
- Min cluster size: 1 (default) | 2 | 3. Removes whole clusters of same-color connected pixels with size <= N.
- Action: **Merge** into the most frequent neighboring color (default; ties break by lowest luminance difference) | **Delete** (set transparent).
- Scope: selection, else active layer cel (default) | all frames of the layer.
- Live preview: orphans highlighted with 1px magenta-free marker (use accent outline), count shown "12 orphans found". Apply button. Esc cancels.
- Single undo step. Pure function in `src/core/cleanup.ts`: `findOrphans(data,w,h,opts) -> Pt[]`, `removeOrphans(...)`.
- AC (unit tests): lone pixel found; 2-pixel cluster not found at min size 1, found at 2; diagonal-only neighbor is orphan in 4-conn, not in 8-conn; transparent pixels never counted; merge picks most frequent neighbor; operation is idempotent (running twice changes nothing more).

---

## 3. Layers [P1]

Model: ordered list bottom-to-top. Each layer: `id, name, visible, locked, alphaLock, opacity (0-100), blend (normal|multiply|screen|overlay|add), cels[], modifiers[]`.

- Panel lists top layer first. Per row: eye, lock, name (double-click rename), thumbnail of the current cel (nearest-neighbor, 32px).
- Actions: new, duplicate, delete (min 1 layer), move up/down (drag reorder + buttons), merge down, flatten visible, rename.
- Locked: tools refuse to edit, show a toast "Layer locked". Alpha lock: only existing opaque pixels can change.
- Merge down bakes modifiers of both layers. Warn once if modifiers exist.
- Active layer highlighted, and `aria-current`.
- Reference layer type (F-REF): image, not exported, not drawable, opacity + position, see 5.3.
- AC: every layer op is undoable and redoable. Delete last layer is disabled. Reorder keeps modifiers attached. Opacity and blend visible live on canvas and baked into export.

---

## 4. Undo / Redo [P1]

Architecture: **command pattern**, not bitmap snapshots of the whole document.

- Every mutation of document state goes through `history.execute(cmd)` where `cmd = { label, do(doc), undo(doc) }`.
- Pixel edits store a **sparse diff**: bounding rect + before/after pixel arrays of only changed region. Never store full cels per stroke.
- Covered (all must be undoable): pixel edits, selection changes, layer add/delete/reorder/rename/visibility/lock/opacity/blend, frame add/delete/duplicate/reorder, modifier add/remove/toggle/param change, canvas resize/scale, palette edits, tile edits, onion/animation settings that live in the document.
- **Coalescing**: slider drags (modifier params, opacity) merge into one step per drag (commit on pointerup). Typing in a field commits on blur/Enter.
- Shortcuts: Ctrl+Z undo, Ctrl+Shift+Z and Ctrl+Y redo. Buttons in the top bar with disabled state and tooltip showing the label ("Undo: Pencil stroke").
- Limits: max 200 steps AND max 128 MB total diff memory, whichever hits first, drop oldest. New action clears redo stack.
- History panel (optional P3): list of labels, click to jump.
- Undo while a stroke is in progress: ignored. Undo restores the previously active layer/frame so the user sees the change.
- AC (unit tests): do/undo/redo round-trip yields byte-identical document for every command type; 1000 random commands then undo-all returns the initial document; memory cap evicts oldest.

---

## 5. Color

### F-PALETTE: Palette panel [P2]
- Swatches grid, click = set primary, right-click or Alt+click = set secondary. `X` swaps primary/secondary. Add current color, remove, drag reorder, rename palette. Lock icon on swatch prevents deletion/remap.
- Palettes stored in the project. Import: `.gpl` (GIMP), `.hex` (one hex per line), `.pal` (JASC), `.png` strip. Export `.gpl`, `.hex`, `.png`.
- Mode toggle "Restrict to palette": drawing tools snap incoming color to nearest palette entry (OKLab distance).
- Shows palette usage: swatch badge with count of canvas pixels using it (P3).

### F-GRAB: Color grabber [P2]
- Tool I, and **hold Alt** with any drawing tool for a temporary grab.
- Sample source option: **active layer** | **composed image** (default, what you see).
- Click or drag-scrub: primary color updates live, a loupe (8x8 pixel magnified, 96px) follows the cursor. Transparent pixel = no change + loupe shows checker.
- Middle option "add to palette on Shift+click".
- Works on the reference image layer too (samples it even when not drawable).
- Optional: native `EyeDropper` API button to grab from anywhere on screen, feature-detected, hidden if unsupported.
- AC: grabbing a pixel then drawing reproduces its exact RGBA. Loupe never shows blurred pixels.

### F-RAMP: Hue-shift ramp generator [done]
Existing. Extend in P2: lock ramp to palette, "send ramp to palette" button, dark/base/light HSL + multiplier mode.

### F-EXTRACT: Palette from reference image [P2]
Generate a palette by quantizing an imported image.

UI: `Palette > Generate from image`. Steps in one dialog:
1. Pick image (file picker, drag-drop, paste from clipboard). Shows preview.
2. Choose **color count**: **4**, **8**, **16** (segmented buttons, required presets) plus a custom field 2..64.
3. Choose **method**: `Median cut` (default, deterministic) | `K-means (OKLab)` (seeded, deterministic, 12 iterations max) | `Most frequent`.
4. Options: ignore transparent pixels (always), ignore near-white/near-black toggle, sort by `luminance` (default) | `hue`, downscale input to max 256px longest side first (nearest) for speed.
5. Live result: swatch row updates under 300 ms for a 1024px image. Each swatch shows percentage of pixels it covers.
6. Actions: **Replace palette**, **Append to palette**, **New palette**, **Recolor canvas to this palette** (remap every pixel of selection/active layer to nearest entry in OKLab, no dithering default, optional Bayer dither toggle).

Rules:
- Result has **exactly N colors** unless the image has fewer unique colors, then return the unique count and say so ("Image only has 6 colors").
- Deterministic: same image + same settings = same palette every time. No `Math.random` unseeded.
- Pure functions in `src/core/quantize.ts`: `extractPalette(rgba, w, h, {count, method, ignoreTransparent}) -> RGBA[]`, `remapToPalette(data, palette, {dither}) -> data`.
- AC (unit tests): count 4/8/16 each return that many colors on a gradient image; a 2-color image with count 8 returns 2; same input twice equals; transparent pixels excluded; remap output contains only palette colors.

### 5.3 F-REF: Reference image [P2]
- Import image as reference layer (drag-drop, paste, file). Not exported, never edited. Transform: move, scale (free, nearest or smooth toggle), opacity, flip. Lock toggle. Hide toggle.
- Lives in project file as PNG data URL. Counts toward project size warning at 20 MB.

---

## 6. Animation [P3]

Model: `Doc.animations[]` each `{ id, name, from, to, direction (forward|reverse|pingpong), loop }`, frames have `duration ms` (default 1000/fps). Cels exist per layer per frame.

- Timeline panel: rows = layers, columns = frames. Click cell selects (layer, frame). Frame header shows number and duration, double-click edit duration. Drag frames to reorder. Add blank, duplicate, delete, link cel (optional).
- Playback: Space play/stop, `,` `.` prev/next frame, loop, ping-pong. FPS field plus per-frame duration override. Playback uses a real clock (`performance.now`), not setInterval drift accumulation.
- Per-layer frame count (Manabit parity) is P6, behind the single global frame count in P3. Do not build both at once.
- Named animations: create from frame range, rename, switch in dropdown, export each separately (idle, walk...).

### F-ONION: Onion skin [P3]
- Toggle `N`. Settings: frames before (0-5, default 1), frames after (0-5, default 1), opacity start 50% falling off linearly per step, tint previous = accent-cool, tint next = accent-warm (two fixed tokens in CSS, user-visible swatches), mode: tinted | original colors.
- Source: composed visible layers of the neighbor frames, or active layer only (toggle).
- Drawn **under** current frame content, **above** transparent bg. Never exported, never in thumbnails, ignored while playing.
- Loops across animation range when "wrap" is on.
- AC: with onion on and frame 1, previous frame shows only if wrap on. Toggling never changes document. Export PNG identical with onion on or off.

---

## 7. Modifiers [done basic, P3 extend]

Existing: Color (hue, sat, light, opacity), Outline (inner/outer, color). Scope: layer or whole animation. Non-destructive, pure.

Extend:
- Reorder (drag), duplicate, solo preview (hold Alt on eye icon).
- Apply to **selection slice** (modifier with a mask).
- Outline: width 1..4, 4 or 8 neighbor mode, "outline only outside canvas bounds" off by default.
- Drop shadow (offset x/y, color), Palette map (remap to active palette) as new modifiers in P4.
- Bake: right-click modifier = "Apply to pixels" (destructive, undoable).
- AC: toggling, reordering and removing never alters source cel bytes (tests assert byte equality).

---

## 8. Tile tools [P5]

- **F-TILEMODE Repeat Tile Mode**: toggle `T`; X, Y, or both. Canvas renders 3x3 tiled copies at reduced opacity outside the center; strokes crossing the edge wrap to the opposite side. Never exported tiled.
- **Tile Builder**: set tile size (8, 16, 24, 32, 48, 64, custom WxH). Select rect on canvas, "Add tile" captures it into the tile set. Categories (ground, wall, prop, hazard, custom). Tiles are deduplicated by pixel hash with a warning.
- **Map editor**: grid layer sized in tiles. Brush, rect, fill, eraser, pick-tile from map. Multiple map layers. Snap to grid. Export map as JSON (`{tileSize, width, height, layers:[{name, data:int[]}]}`), tileset as PNG atlas, with optional 1-2px extrusion.
- AC: edit a captured tile source and map updates when "linked". Atlas has no overlap or bleed at nearest sampling.

---

## 9. Project, files, export [P4]

- Project file `.tintbox` = JSON header + base64 PNG cels, or zip (`fflate`) with `project.json` + `cels/*.png`. Choose zip. Includes version integer and migrations.
- Autosave to IndexedDB every 10 s after a change, with recovery prompt on reload. Manual Save = download file. Open = file picker. File System Access API used when available, download fallback.
- Export dialog: format PNG | GIF | spritesheet PNG (+ JSON atlas data) | frames as PNG sequence (zip) | WebP animated optional. Scale 1x..16x (nearest). Include/exclude hidden layers. Selected animation or all. Padding between sprite frames. "Bake modifiers" always on.
- GIF: WebCodecs not required; use a small encoder (`gifenc`). Honors per-frame duration, transparency (single transparent index), local palettes off, dither off.
- Export never includes onion skin, grid, selection, reference layer, symmetry guides.
- AC: export 1x then re-import gives byte-identical pixels. GIF frame count and durations match the timeline.

---

## 10. Quality-of-life [P1-P4]

- Keyboard shortcuts panel (`?`). Table below is the complete default map.
- Tooltips on every icon button showing name + key.
- Toasts for errors, never `alert()`.
- Unsaved-changes guard on tab close.
- Persist UI prefs (panel sizes, grid, onion settings, last palette) in `localStorage`.
- Empty, loading, error states for every panel.

### Default shortcuts
| Key | Action | Key | Action |
|---|---|---|---|
| B | Pencil | E | Eraser |
| L | Line | C | Curve |
| U | Rectangle | O | Ellipse |
| G | Bucket | I | Color grabber |
| M / Q / W | Rect / Lasso / Wand select | V | Move |
| H | Hand | D | Dither |
| X | Swap colors | `[` `]` | Brush size -/+ |
| Space (hold) | Pan | Alt (hold) | Temp grabber |
| + / - | Zoom step | 1 / 0 | Zoom 100% / Fit |
| # | Pixel grid | T | Tile mode |
| N | Onion skin | , . | Prev / next frame |
| Space (tap, timeline focused) | Play | Enter | Commit paste/shape |
| Esc | Cancel / deselect | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | Undo / Redo |
| Ctrl+A / D / I | Select all / none / invert | Ctrl+C / X / V | Copy / cut / paste |
| Ctrl+S / O / E | Save / Open / Export | Ctrl+N | New doc |

Conflict note: onion is `N` (not `O`, which is Ellipse). Space tap plays only when the timeline has focus; otherwise Space is hold-to-pan.

---

## 11. Advanced [P6]

### 11.1 Dither Brush (`F-DITHER`)
- Shortcut `D`. Brush size `1..32` (square/round), patterns: `checker` (50% 2×2), `bayer2` (25%/75%), `bayer4` (ordered threshold `10..90%`), `diag` (diagonal stripes), `scanline` (horizontal lines).
- Modes: **Single color** (stamps primary on pattern-true pixels, leaves false pixels untouched) or **Dual color** (stamps primary on true pixels, secondary on false pixels).
- Honors selection mask, alpha lock, symmetry, and Repeat Tile Mode wrap. Single undo step per stroke.
- AC: painting with `checker` over an 8×8 area produces an exact alternating `(x + y) % 2 === 0` parity pattern; single undo reverts all stamped pixels.

### 11.2 Live Vector Paths (`F-VECTOR`)
- Replaces single-shot Curve (`C`) with a live editable path before rasterization.
- Click to place vertices; drag any vertex handle to reposition live; toggle **Smooth** (quadratic curve through midpoints) vs **Polyline**, **Closed** loop toggle, and stroke width `1..8 px`.
- Preview renders live rasterized pixels on the canvas plus crisp vector handle overlays (never exported).
- `Enter` or **Apply** rasterizes onto the active pixel layer in a single undoable command; `Esc` cancels cleanly. Honors symmetry, tile wrap, mask, and alpha lock.
- AC: moving a vertex updates rasterized pixel preview live without mutating the source cel until commit; committing records 1 undo step.

### 11.3 Live Shape Presets (`F-SHAPES`)
- Available on `U` / `O` shape tools via contextual preset strip: `square` (rect), `oval` (ellipse), `star` (configurable `4..12` points + inner radius), `cube` (3-face orthographic/axonometric pixel cube), and `isometric` (exact 2:1 pixel-art isometric diamond/prism).
- Supports Outline or Filled mode, `Shift` aspect lock, `Alt` draw from center, plus live post-drag adjustment (drag bounding handles or change preset/filled/points live before committing via `Enter`, **Apply**, or starting a new stroke; `Esc` cancels).
- AC: every preset rasterizes crisp integer pixels with zero anti-aliasing; `isometric` edges follow strict 2:1 pixel steps; single undo reverts commit.

### 11.4 Per-Layer Frame Counts (`F-LAYERFRAMES`)
- Any pixel layer may hold an independent cel count `1..N` (`1 <= layer.cels.length <= doc.frames.length` or custom loop count), looping via `layer.cels[frame % layer.cels.length]` during composition, playback, and export.
- Timeline matrix displays each layer's cel count (`+ Cel` / `- Cel` or explicit loop count control) and visually marks looped cells (`frame >= layer.cels.length`).
- Changing a layer's cel count is an undoable command; `.tintbox` archives preserve per-layer cel counts cleanly.
- AC: a 2-cel layer inside a 6-frame document renders cel 0 on frames `0, 2, 4` and cel 1 on frames `1, 3, 5` identically in preview and export, and round-trips through `.tintbox`.

### Deferred P6 items
3D blockout and UV painter (three.js), Tauri wrap, and Cloud sync remain out of scope until requested.
