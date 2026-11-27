# Tintbox

Browser pixel-art workbench for sprites, animation, palettes and tiles. Clone-inspired by **Manabit** (Coldfox Co). Own name, own code, own assets.

## Doc map

| File | Purpose |
|---|---|
| `AGENTS.md` | Hard rules for any coding agent |
| `REQUIREMENTS.md` | This file: goals, scope, prerequisites, reference |
| `docs/FEATURES.md` | Every feature: exact behavior + acceptance criteria |
| `docs/ARCHITECTURE.md` | Stack, layering, data model, perf budgets, testing |
| `docs/UX-DESIGN.md` | Tokens, layout, interaction, a11y, banned slop list |
| `docs/BUILD-PLAN.md` | Phases P0-P6, Definition of Done, starter prompt |
| `docs/DECISIONS.md` | Log of choices that deviate or fill gaps |
| `docs/OPEN-QUESTIONS.md` | Agent's questions when specs are ambiguous |

## Prerequisites

- Node 20+, npm 10+, evergreen browser.
- `npm install` / `npm run dev` / `npm run check` (typecheck + tests + build).

## Product goals

1. Fast, precise pixel drawing that never blurs, skips pixels, or loses work.
2. Non-destructive workflow: modifiers, layers, palette-driven color.
3. Animation workflow: timeline, onion skin, named animations, export.
4. Palette tooling: color grabber, hue-shift ramps, **palette from reference image (4/8/16)**, **orphan pixel cleaner**.
5. Game-dev output: spritesheet + JSON, GIF, tilesets and maps.

Non-goals: AI image generation, accounts, cloud (until P6), copying Manabit assets/branding, photo editing.

## Essentials checklist (must exist by end of the named phase)

| Essential | Phase | Spec |
|---|---|---|
| Undo / redo (command pattern, all doc changes) | P1 | FEATURES 4 |
| Integer zoom, cursor-anchored, pan, pixel grid | P1 | FEATURES 1 |
| Layers: lock, alpha lock, opacity, blend, merge, reorder | P1 | FEATURES 3 |
| Selection, move, symmetry, shapes, brush size | P1 | FEATURES 2 |
| Color grabber with loupe, Alt-grab | P2 | F-GRAB |
| Palette panel + import/export | P2 | F-PALETTE |
| Palette from reference image: 4 / 8 / 16 / custom | P2 | F-EXTRACT |
| Reference image layer | P2 | F-REF |
| Orphan pixel remover | P2 | F-ORPHAN |
| Timeline, named animations, durations | P3 | FEATURES 6 |
| Onion skin | P3 | F-ONION |
| Save/load, autosave, export PNG/GIF/sheet | P4 | FEATURES 9 |
| Repeat tile mode, tile builder, maps | P5 | FEATURES 8 |

## Reference: Manabit

Source: web search summaries (itch.io, Steam, YouTube). Not verified against product pages.

- Pixel art studio + game-dev tool: sprites, animation, tile maps, levels in one project.
- Browser (PC, tablet, phone) + Windows desktop, cloud sync. One-time purchase, lifetime updates (~$19.99 reported).
- Editor tools, layers, custom palettes, live vector paths, live shapes (cube, iso block), non-destructive Color/Outline modifiers on layers or selection slices.
- Per-layer frame counts, named animations, Repeat Tile Mode, Map/Tile Builder, 3D blockout.
- Seen in reel only: hue-shift palette, per-slice GIF export, UV 3D painter.

## Current state (P0, shipped)

64x64 canvas, pen/eraser/line/curve/fill/picker, layers, Color + Outline modifiers (layer or whole animation), hue-shift ramp, frames + playback, PNG/spritesheet export, pixel-edit undo/redo. 12 core tests.

Known gaps: undo only covers pixels, fixed 64x64, no save/load, no selection, no zoom steps/pan.

## Browser vs wrap

Browser first (PWA in P4). Keep `src/core` DOM-free so a Tauri wrap in P6 is packaging only.
