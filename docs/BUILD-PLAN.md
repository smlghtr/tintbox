# Build Plan

Read order for an agent: `AGENTS.md` -> `REQUIREMENTS.md` -> `docs/ARCHITECTURE.md` -> `docs/FEATURES.md` -> `docs/UX-DESIGN.md` -> this file.

## Working rules for the agent
1. **One phase at a time.** Do not start phase N+1 until phase N passes its Definition of Done.
2. Inside a phase, **tests first** for every `core/` algorithm, then implementation, then UI wiring.
3. Do not add features, tools, dependencies, settings or visual styles not in the docs. If something seems missing, add a question to `docs/OPEN-QUESTIONS.md` and continue with the simplest safe choice.
4. Do not rewrite working files. Minimal diffs. Do not rename the public types in `core/types.ts` without migrating all call sites and tests.
5. After each phase, write `docs/REPORT-P<n>.md`: what shipped, what was cut, known bugs, measured performance numbers vs the budgets, screenshots.
6. Never claim done without running `npm run check` and quoting the result.
7. Never leave stubs, `TODO`, dead buttons, commented-out code, or fake data.

## Status
- [done] **P0 Foundation**: Vite+TS, canvas, pen/eraser/line/curve/fill/picker, layers (basic), color+outline modifiers, hue-shift ramp, frames + playback, PNG/sheet export, basic undo.
- [done] **P1 Core editor**: command-pattern undo/redo (sparse diffs, 200 steps / 128 MB), integer cursor-anchored zoom/pan/grid, dual-canvas stage, full drawing/selection/move/symmetry tools, full layers (lock, alpha lock, opacity, blend, reorder, merge, flatten), keymap, dialogs, status bar, toasts, responsive workbench. See `docs/REPORT-P1.md`.
- [done] **P2 Color tools**: palette panel + `.gpl`/`.hex`/`.pal`/`.png` import/export + restrict-to-palette (OKLab), loupe color grabber + Alt-grab + EyeDropper, deterministic reference image palette extraction (4/8/16/custom, median cut / OKLab K-means / most frequent + Bayer remap), reference image layers (not exported, transformable, grabber-samplable), orphan pixel remover (4/8-conn, size 1-3, merge/delete, live accent preview, single undo step), ramp extensions. See `docs/REPORT-P2.md`.
- [done] **P3 Animation**: `Frame[]` durations, `Animation[]` named animations + ping-pong + real-clock `performance.now()` playback, Layers × Frames timeline matrix (drag reorder, inline duration edit), `F-ONION` onion skin (`N`, tinted/original, composed/active, wrap, ignored during playback, export-equal), modifier extensions (reorder, duplicate, Alt-solo, selection slice mask, outline width 1-4 / 4-or-8 conn / bounds, bake to pixels), palette usage count badges, clickable History panel. See `docs/REPORT-P3.md`.
- [done] **P4 Persistence and export**: `.tintbox` zip format (`fflate`, lossless straight-alpha PNG cels/refs) + schema versioning & v0->v1 migrations with fixtures, IndexedDB 10 s autosave + startup draft recovery `<dialog>`, File System Access API Save/Open (`Ctrl+S`/`Ctrl+O`) with download/input fallback & corrupt-file safety, Export `<dialog>` (`Ctrl+E`: PNG, animated GIF via `gifenc` honoring per-frame delays/single transparent index/no local tables/no dither, Spritesheet PNG + JSON atlas with padding, PNG sequence `.zip`, nearest-neighbor `1×–16×`, hidden layer toggle), unsaved `beforeunload` guard + dirty indicator, Drop shadow & Palette map modifiers, PWA manifest + Service Worker (`/sw.js`). See `docs/REPORT-P4.md`.
- [done] **P5 Tiles**: `F-TILEMODE` Repeat Tile Mode (`T`, X/Y/XY wrap for brush/shapes/curve/bucket + 3×3 reduced-opacity stage preview, never exported tiled), Tile Builder (presets `8/16/24/32/48/64` + custom W×H, categories, pixel-hash deduplication with warning, live canvas-linked tiles), interactive Map Editor (Brush/Rect/Fill/Eraser/Pick, multiple map layers, snap-to-grid, undoable commands, JSON `{tileSize, width, height, layers}` + PNG atlas export with `0/1/2px` zero-bleed edge extrusion), `.tintbox` schema v2 persistence (`v0→v1→v2` migrations). See `docs/REPORT-P5.md`.
- [done] **P6 Advanced (Pixel-art core pack)**: mini-specs appended to `docs/FEATURES.md`; `F-DITHER` Dither brush (`D`, Checker / Bayer 2×2 / Bayer 4×4 / Diagonal / Scanline, density, single/dual color), `F-VECTOR` Live vector paths (`C`, editable vertex handles, Smooth/Polyline, Closed, width `1..8`, Apply/Cancel), `F-SHAPES` Live shape presets (`U`/`O`, Square / Oval / Star / Cube / 2:1 Isometric, draggable live corner handles, Outline/Filled), `F-LAYERFRAMES` Per-layer frame counts (`- Nc +` timeline controls, modulo cel looping in compose/playback/export, `.tintbox` persistence). Deferred: 3D blockout/UV painter, Tauri wrap, cloud sync. See `docs/REPORT-P6.md`.

## P1 Core editor
Scope: F-ZOOM, F-CANVAS, F-PEN (size, pixel-perfect), F-ERASER, F-RECT/ELLIPSE, F-SELECT (rect, lasso, wand), F-MOVE, F-HAND, F-SYMMETRY, Layers (full, sec. 3), **Undo/Redo rewrite to command pattern (sec. 4)**, keyboard map, status bar, toasts, new/resize doc.
First task: migrate existing history to commands and cover every existing mutation. Everything after builds on it.
DoD: all AC in sections 1-4 pass as automated tests where possible. Manual script in the report: draw, zoom at corner, undo 50 times, redo 50 times, document identical.

## P2 Color tools
Scope: F-PALETTE (panel, import/export .gpl .hex .pal .png), F-GRAB (loupe, Alt-grab, source option), **F-EXTRACT 4/8/16 + custom, remap to palette**, F-REF reference image, **F-ORPHAN**, ramp extensions, restrict-to-palette.
DoD: AC of F-EXTRACT, F-ORPHAN, F-GRAB pass. Quantize and orphan perf within budget on a 512x512 test image.

## P3 Animation
Scope: timeline panel, frame durations, named animations, ping-pong, **F-ONION**, modifier extensions (reorder, selection mask, outline width), palette usage counts, history panel.
DoD: AC of sections 6-7 pass. Export equality test (onion on/off).

## P4 Persistence and export
Scope: `.tintbox` zip format + versioning + migrations, autosave + recovery, export dialog (PNG, GIF, spritesheet+JSON, PNG sequence), scale export, drop shadow & palette map modifiers, unsaved guard, PWA manifest + service worker (offline).
DoD: round-trip save/load byte-identical, GIF frame count/durations match, offline reload works.

## P5 Tiles
Scope: Repeat Tile Mode, Tile Builder, map editor, JSON + atlas export.
DoD: AC of section 8.

## P6 Advanced
Live vector paths, live shapes, per-layer frame counts, dither brush, 3D blockout/painter, Tauri wrap, cloud sync. Each needs its own mini-spec appended to FEATURES.md **before** coding.

## Definition of Done (every phase)
- `npm run check` green (typecheck, tests, build).
- Coverage of `core/` and `state/` >= 90%.
- Performance budgets in ARCHITECTURE.md measured and listed in the report.
- UX checklist in UX-DESIGN.md done, screenshots attached.
- No new `any`, `!`, `@ts-ignore`, `console.log`.
- Docs updated if behavior differs from the spec (and the change is justified in `docs/DECISIONS.md`).

## Starter prompt (paste into the coding agent)
```
You are building Tintbox, a browser pixel art editor. Read AGENTS.md, REQUIREMENTS.md and everything in docs/ before writing code.
Work on exactly one phase: P1. Do not touch later phases.
Tests first for core logic. Follow ARCHITECTURE.md layering. Follow UX-DESIGN.md tokens and banned list.
Do not add anything not in the docs; log questions in docs/OPEN-QUESTIONS.md.
When finished: run `npm run check`, write docs/REPORT-P1.md with results and screenshots, then stop and wait for review.
Reply tersely.
```
