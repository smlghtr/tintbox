# UX and Visual Design

Point of view: **a precise workbench for pixel artists.** Dark warm-black surfaces, hairline borders, one lime accent, monospace for numbers. Calm, dense, no decoration. The artwork is the only colorful thing on screen.

## Tokens (live in `src/style.css :root`, never hardcode colors elsewhere)
| Token | Value | Use |
|---|---|---|
| `--base` | `#14130f` | app background |
| `--panel` | `#1b1a15` | panels |
| `--raised` | `#25231c` | inputs, buttons, cards |
| `--line` | `#343126` | 1px borders |
| `--ink` | `#e8e4d8` | text |
| `--dim` | `#8f8a78` | secondary text (check AA on `--panel`) |
| `--accent` | `#c6f432` | active state, focus, primary action. Used sparingly |
| `--danger` | `#ff6b4a` | destructive, errors |
| `--onion-prev` / `--onion-next` | `#4aa8ff` / `#ff8a3d` | onion skin tints only |
Spacing scale 4/8/12/16/24. Radius 2px everywhere. One shadow style, only on menus/dialogs. Type: Space Grotesk (UI), JetBrains Mono (numbers, keys, coordinates). Sizes 11/13/15/20 only.

## Banned (slop list). Reject any PR that has these
- Gradients, glow, blur, glassmorphism, neon, emoji icons, purple/pink anything.
- Stock empty-state illustrations, marketing copy in the app, "Welcome to..." modals.
- Different corner radii, 5 different grays outside the tokens, drop shadows on panels.
- Animated decoration. Motion is only for state change: 120-200 ms ease-out, disabled under `prefers-reduced-motion`.
- Icons: use **one** set (Lucide, inline SVG, 16px, 1.5 stroke). No mixing. Every icon button has `aria-label` + tooltip with shortcut.
- Fake data, lorem ipsum, invented stats, placeholder buttons that do nothing. A feature is either wired or absent.

## Layout (desktop >= 1024 px)
```
+--------------------------------------------------------------+
| top bar: file menu | undo redo | zoom % | export     coords    |
+----+-------------------------------------------+-------------+
|tool|                                           | Palette     |
|bar |   canvas viewport (checker, grid, onion)  | Layers      |
|    |                                           | Modifiers   |
+----+-------------------------------------------+-------------+
| timeline: layers x frames, playback, onion, animation picker |
+--------------------------------------------------------------+
| status: tool hint | zoom | x,y | canvas size | hex under cursor|
+--------------------------------------------------------------+
```
- Right panels are collapsible sections, sizes persisted. Timeline resizable and collapsible.
- Tablet (600-1023): side panels become a drawer. Phone (<600): tools in a bottom bar, panels in a sheet. Drawing area never < 50% of screen.

## Interaction rules
- Every tool shows its hint in the status bar and a custom cursor (crosshair + brush-size outline at zoom >= 4).
- Brush preview outline follows the pointer, snapped to the pixel grid.
- Destructive actions (delete layer, delete frame, clear) are undoable, so no confirm dialogs. Only confirm for unsaved-changes on close.
- Dialogs: native `<dialog>` + `showModal()`, Esc closes, focus is trapped and restored. Primary button on the right, labeled with the verb ("Generate palette"), not "OK".
- Sliders always pair with a numeric input. Number inputs accept arrow keys and shift-arrow for x10.
- Feedback within 100 ms for any action. Long work shows a determinate progress bar, never a spinner-only.
- Errors say what happened and what to do next ("Image is 5000x3000. Max is 4096 per side.").

## Accessibility
- Fully keyboard operable: every panel and dialog reachable by Tab, visible `:focus-visible` ring (`--accent`, 2px).
- Color contrast WCAG AA for all text. State never conveyed by color alone (active tool also has a filled background and `aria-pressed`).
- `aria-live="polite"` region announces undo/redo labels and toasts.
- Canvas has `role="img"` with a summarizing `aria-label` (size, layer count, frame). Real controls carry the semantics.
- Respect `prefers-reduced-motion` and `prefers-color-scheme` is ignored (dark only in v1, stated in the docs).

## Copy
Short, concrete, sentence case. "12 orphans found" not "We detected some stray pixels!". No exclamation marks. No "seamless / powerful / unleash".

## Pre-merge visual checklist
1. Squint test: canvas dominates, one accent visible, hierarchy readable.
2. Tab through the whole app without a mouse.
3. 200% browser zoom and 320 px width do not break layout.
4. Run through the banned list.
5. Screenshot desktop + phone attached to the phase report.
