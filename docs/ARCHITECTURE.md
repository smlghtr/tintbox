# Architecture

## Stack (fixed, do not swap)
- Vite 8, TypeScript `strict`, vanilla DOM, Canvas 2D. Vitest for tests.
- Allowed deps: `fflate` (zip), `gifenc` (GIF), `@fontsource/*`. Anything else needs a line in `docs/DECISIONS.md` first.
- No React/Vue/Svelte/Tailwind/UI kits. No canvas libraries (Fabric, Konva, Pixi). No lodash.
- Browser target: evergreen Chromium, Firefox, Safari. Features beyond Baseline (EyeDropper, File System Access) must be feature-detected with a fallback.

## Layers of code

```
src/
  core/     pure logic. NO DOM, NO window, NO canvas. Fully unit-tested.
  state/    store + commands + history. Depends on core only.
  ui/       DOM, canvas rendering, input. Depends on state + core.
  io/       file formats, import/export, persistence. Depends on core + state.
  style.css tokens + layout
```
Dependency rule: `core <- state <- ui`, `core <- io`. `core` never imports from any other folder. Enforce with a test that greps imports.

## Data model (single source of truth in `core/types.ts`)

```ts
Doc {
  version: number; w; h;
  layers: Layer[];            // bottom -> top
  frames: Frame[];            // { duration: number }
  animations: Animation[];
  palettes: Palette[]; activePaletteId: string;
  modifiers: Modifier[];      // whole-animation scope
  tileSet?: TileSet; maps?: TileMap[];
}
Layer { id; name; kind: 'pixel' | 'reference'; visible; locked; alphaLock;
        opacity; blend; cels: (Uint8ClampedArray | null)[]; modifiers: Modifier[] }
```
- Pixel buffers: `Uint8ClampedArray` RGBA straight (non-premultiplied), length `w*h*4`. Row-major.
- IDs are `crypto.randomUUID()`, never counters (counters collide after load).
- UI state (tool, zoom, pan, panel open) is **not** in `Doc`. It lives in `state/ui.ts`.
- Serialization: `Doc` -> JSON + PNG cels. Versioned, with `migrate(v)` functions, tested against fixtures in `test/fixtures/`.

## State and commands
- `state/store.ts`: tiny pub-sub. `subscribe(selector, cb)`. UI re-renders only the panels whose slice changed.
- **Every doc mutation is a Command** (`do`, `undo`, `label`). No direct writes from UI handlers, except transient stroke previews which commit as one command on pointerup.
- Pixel commands store sparse before/after diffs of the dirty rect (see F-ZOOM..F-UNDO in FEATURES.md).

## Rendering
- One visible `<canvas>` sized to the **document** (w x h), scaled with CSS integer zoom. Overlays (grid, selection, onion, tile ghosts, symmetry axis, loupe) on a second canvas at **screen resolution** so lines stay 1px crisp at any zoom.
- Compose pipeline per frame: layers bottom-up -> per-layer modifiers -> blend/opacity -> doc modifiers. Cache composed frames keyed by a `revision` counter; invalidate only dirty frames. Dirty-rect recompose for strokes on documents > 256x256.
- Use `requestAnimationFrame` for redraws, coalesce multiple pointer events per frame. Use `PointerEvent.getCoalescedEvents()` for gap-free strokes.
- Canvas context: `{ willReadFrequently: true }` only on scratch contexts that call `getImageData`.

## Input
- Pointer Events only (no mouse/touch duplicates). `setPointerCapture` on pointerdown, `touch-action: none` on the canvas.
- Keyboard map in one table (`ui/keymap.ts`) generated from the shortcut list in FEATURES.md. Ignore shortcuts while focus is in `input, select, textarea, [contenteditable]`.
- Tools implement `interface Tool { id; cursor; down(e); move(e); up(e); cancel(); overlay?(ctx) }`. Tools never touch the DOM except via the context they are given.

## Performance budgets (test and measure, not guess)
| Case | Budget |
|---|---|
| 64x64 stroke, any tool | < 4 ms per pointer event |
| 256x256 compose with 8 layers + 3 modifiers | < 12 ms |
| 1024x1024 flood fill | < 100 ms |
| Palette extract, 1024px image, 16 colors | < 300 ms |
| Orphan scan 512x512 | < 50 ms |
| Cold load JS | < 200 KB gzip excluding fonts |
Heavy work (quantize, GIF encode, big fills) goes to a Web Worker once it breaks a budget. Keep these functions pure so moving them is trivial.

## Testing
- `core/` and `state/`: Vitest, target >= 90% line coverage. Every algorithm has a test written first.
- Golden-image tests: tiny PNG fixtures for line, curve, ellipse, flood fill, outline modifier. Compare bytes.
- `ui/`: minimal smoke tests (mount, tool switch, undo shortcut) via Vitest + jsdom or Playwright. Do not mock `core`.
- CI command `npm run check` = `tsc --noEmit && vitest run && vite build`. Must pass before any phase is "done".

## Errors
- Never swallow errors. `core` throws typed errors, `ui` catches at the boundary and shows a toast. Corrupt file load shows what failed and leaves the current doc untouched.
- No `any`. No non-null `!` outside tests and `getElementById` at the root. No `@ts-ignore`.

## Security
- Imported images and project files are untrusted. Cap dimensions (max 4096 px per side, 64 MP total), cap file size (50 MB), decode with `createImageBitmap`. Never use `innerHTML` with user strings (layer names, palette names). Use `textContent`.
