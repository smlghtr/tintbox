# Decisions

Format: date, decision, reason. Newest last.

- 2026-11-26: Vite + TS + vanilla DOM + Canvas 2D. Keeps core portable for a later Tauri wrap.
- 2026-11-26: Added devDependencies `@vitest/coverage-v8` and `jsdom` for mandatory >= 90% coverage reporting and `ui/` smoke tests (no runtime bundle impact).
- 2026-11-26: Kept `Doc.frames` as `number` in P1 (upgrading to `Frame[]` + `animations[]` in P3); added `Doc.version: 1` and P1 `Layer` fields (`kind`, `locked`, `alphaLock`, `opacity`, `blend`) now.
- 2026-11-26: Fixed minor doc contradictions (Onion key `O`->`N`, `F-TILEMODE` section 6->8, live vector paths P5->P6, PWA deduplicated to P4, P4 modifiers aligned, Vite 7->8).
- 2026-11-26: Included `F-LINE` Shift 15-degree snap and `F-FILL` contiguous/global + sample source + scanline fill in P1 so all Section 1-4 AC pass.
- 2026-11-26: Browser tabs reserve `Ctrl+N` (cannot preventDefault outside PWA/Tauri); bound `Ctrl+N` plus `Alt+N` fallback and File > New menu item.
- 2026-11-26: F-ORPHAN merge action: when an orphan cluster has zero non-transparent neighbors (completely isolated floating dot), merge sets it transparent so running cleanup twice is strictly idempotent.
- 2026-11-26: Upgraded `Doc.frames` to `Frame[]` (`{ id, duration }`) and added `Doc.animations: Animation[]` in P3 as planned; migrated all call sites and tests.
- 2026-11-26: Outline modifier `onlyOutsideBounds` (default `false`): when enabled, outer outline applies only along canvas edge pixels and inner outline skips canvas border pixels.
