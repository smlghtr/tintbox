# Caveman + Token Saver

Be terse. Few words. Same substance.

- No preamble, no recap, no sign-off, no "Great question". Answer first.
- Drop filler and hedging. Short sentences. Fragments ok. Code and technical terms stay exact.
- Never restate the user's request or re-summarize files/diffs just written. One line: what changed, what's next.
- Don't re-read files already in context or unchanged. Don't repeat searches.
- Batch independent tool calls in one turn. Chain shell steps with `&&`.
- Read whole files or big ranges, not many tiny reads. Use grep/search before opening files.
- Edit with minimal diffs. No rewriting untouched code. No unrequested refactors, docs, or extra files.
- Don't paste large outputs back; quote only the relevant lines.
- Ask a question only when blocked or truly ambiguous.
- Switch to normal full sentences only for: security warnings, destructive actions, or when user asks for explanation.

# Anti-Slop (UI and code)

- Before building UI, activate the `anti-slop-design` skill.
- No filler code: no dead comments restating code, no placeholder TODO stubs, no fake data presented as real.
- Prefer deleting code to adding it. Match existing project conventions.

# Web / JS / three.js

- For HTML/CSS/client JS, use the `modern-web-guidance` skill first.
- For three.js or JS tasks, activate `threejs-javascript` skill. Use Context7 for current library docs.

# Tintbox Rules

- Caveman mode always. Terse replies, minimal diffs.
- Stack: Vite + TypeScript strict + vanilla DOM + canvas. No UI framework until needed.
- `src/core/*` is pure: no DOM, no globals. All logic tested in `core.test.ts`. UI only in `src/ui/*`.
- Pixel buffers are `Uint8ClampedArray` RGBA, one per layer per frame. Never mutate them outside tools.
- Modifiers are pure functions over pixels. Never write modifier output back to source cels.
- Run `npm run build && npm test` before saying done.
- Design: workbench look. Tokens in `src/style.css` `:root`. One accent only (lime). No gradients, glass, emoji icons.
- Out of scope until MVP is solid: 3D painter, AI features, accounts, cloud.

# Agent Workflow (read before coding)

- Read order: `REQUIREMENTS.md`, `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/UX-DESIGN.md`, `docs/BUILD-PLAN.md`.
- One phase at a time, in order. No scope creep. Unknown = `docs/OPEN-QUESTIONS.md` + simplest safe choice.
- Tests first for `core/`. `npm run check` must be green before "done". Quote its output.
- Layering: `core <- state <- ui`, `core <- io`. `core` has no DOM.
- Every doc mutation is an undoable Command. No direct state writes from UI.
- No `any`, `@ts-ignore`, `console.log`, TODO stubs, dead buttons, fake data.
- Follow banned list in `docs/UX-DESIGN.md`. Tokens only from `:root`.
- Each phase ends with `docs/REPORT-P<n>.md`, then stop for review.
