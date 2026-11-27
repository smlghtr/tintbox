import type { Pt, Symmetry } from './types';

export function defaultSymmetry(w: number, h: number): Symmetry {
  return { mode: 'none', x: w / 2, y: h / 2, locked: false };
}

export function mirrorPoint(p: Pt, sym: Symmetry): Pt[] {
  if (sym.mode === 'none') return [p];
  const out: Pt[] = [p];
  const mx = Math.round(2 * sym.x - 1 - p.x);
  const my = Math.round(2 * sym.y - 1 - p.y);
  const pushUnique = (x: number, y: number) => {
    if (!out.some((q) => q.x === x && q.y === y)) out.push({ x, y });
  };
  if (sym.mode === 'x' || sym.mode === 'xy') pushUnique(mx, p.y);
  if (sym.mode === 'y' || sym.mode === 'xy') pushUnique(p.x, my);
  if (sym.mode === 'xy') pushUnique(mx, my);
  return out;
}

export function mirrorPoints(pts: Pt[], sym: Symmetry): Pt[] {
  if (sym.mode === 'none') return pts;
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const p of pts) {
    for (const mp of mirrorPoint(p, sym)) {
      const k = `${mp.x},${mp.y}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(mp);
      }
    }
  }
  return out;
}
