import { brushOffsets } from './raster';
import { getMaskBit, type SelectionMask } from './selection';
import type { BrushShape, Pt, RGBA } from './types';

export type DitherPattern = 'checker' | 'bayer2' | 'bayer4' | 'bayer8' | 'diag' | 'scanline';

export const DITHER_PATTERNS: { id: DitherPattern; label: string }[] = [
  { id: 'checker', label: 'Checker' },
  { id: 'bayer2', label: 'Bayer 2×2' },
  { id: 'bayer4', label: 'Bayer 4×4' },
  { id: 'bayer8', label: 'Bayer 8×8' },
  { id: 'diag', label: 'Diagonal' },
  { id: 'scanline', label: 'Scanline' },
];

const BAYER_2: readonly (readonly number[])[] = [
  [0, 2],
  [3, 1],
];

const BAYER_4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const BAYER_8: readonly (readonly number[])[] = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/** Pure spatial pattern predicate for integer canvas coordinate (x, y). */
export function ditherMatches(x: number, y: number, pattern: DitherPattern, density = 50): boolean {
  const px = ((x % 8) + 8) % 8;
  const py = ((y % 8) + 8) % 8;
  const t = Math.max(1, Math.min(99, density)) / 100;

  if (pattern === 'checker') return ((x + y) & 1) === 0;
  if (pattern === 'scanline') return (y & 1) === 0;
  if (pattern === 'diag') {
    const band = Math.max(1, Math.min(3, Math.round(t * 4)));
    return (((x + y) % 4) + 4) % 4 < band;
  }
  if (pattern === 'bayer2') {
    return (BAYER_2[py & 1][px & 1] + 0.5) / 4 < t;
  }
  if (pattern === 'bayer8') {
    return (BAYER_8[py][px] + 0.5) / 64 < t;
  }
  return (BAYER_4[py & 3][px & 3] + 0.5) / 16 < t;
}

export interface DitherStampOpts {
  size?: number;
  shape?: BrushShape;
  pattern: DitherPattern;
  density?: number;
  dual?: boolean;
  secondary?: RGBA;
  mask?: SelectionMask | null;
  alphaLock?: boolean;
  wrapX?: boolean;
  wrapY?: boolean;
}

/** Stamp primary (and optionally secondary) color through a deterministic pixel dither pattern. */
export function stampDitherBrush(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  pts: Pt[],
  primary: RGBA,
  opts: DitherStampOpts,
): void {
  const offsets = brushOffsets(opts.size ?? 1, opts.shape ?? 'square');
  const mask = opts.mask ?? null;
  const alphaLock = opts.alphaLock ?? false;
  const wrapX = opts.wrapX ?? false;
  const wrapY = opts.wrapY ?? false;
  const density = opts.density ?? 50;
  const dual = Boolean(opts.dual && opts.secondary);

  for (const p of pts) {
    for (const o of offsets) {
      let x = p.x + o.x;
      let y = p.y + o.y;
      if (wrapX) x = ((x % w) + w) % w;
      else if (x < 0 || x >= w) continue;
      if (wrapY) y = ((y % h) + h) % h;
      else if (y < 0 || y >= h) continue;
      if (mask && !getMaskBit(mask, x, y)) continue;

      const hit = ditherMatches(x, y, opts.pattern, density);
      const col = hit ? primary : dual ? opts.secondary : undefined;
      if (!col) continue;

      const i = (y * w + x) * 4;
      if (alphaLock && data[i + 3] === 0) continue;
      data[i] = col[0];
      data[i + 1] = col[1];
      data[i + 2] = col[2];
      data[i + 3] = alphaLock ? data[i + 3] : col[3];
    }
  }
}

export type GradientShape = 'linear' | 'radial';

export interface DitherGradientStop {
  color: RGBA;
  /** Relative share/weight for this stop band (positive number, auto-normalized). */
  weight: number;
}

export interface DitherGradientOpts {
  shape: GradientShape;
  pattern: DitherPattern;
  from: RGBA;
  to: RGBA;
  /** Optional multi-color weighted stops (Dither Machine style). When length >= 2, overrides from/to. */
  stops?: DitherGradientStop[];
  toTransparent?: boolean;
  mask?: SelectionMask | null;
  alphaLock?: boolean;
}

/** Normalize positive stop weights into cumulative band boundaries in [0..1]. */
export function normalizeStopWeights(stops: readonly DitherGradientStop[]): number[] {
  if (stops.length === 0) return [];
  const safe = stops.map((s) => Math.max(0.01, Number.isFinite(s.weight) ? s.weight : 1));
  const sum = safe.reduce((acc, w) => acc + w, 0);
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < safe.length; i++) {
    acc += safe[i] / sum;
    out.push(i === safe.length - 1 ? 1 : acc);
  }
  return out;
}

/**
 * Resolve a multi-stop weighted dither gradient color at scalar position `t` in [0..1]
 * using ordered threshold `thr` in [0..1]. Adjacent stop centers transition smoothly via dithering.
 */
export function sampleWeightedGradientDither(
  t: number,
  thr: number,
  stops: readonly DitherGradientStop[],
): RGBA {
  if (stops.length === 0) return [0, 0, 0, 0];
  if (stops.length === 1) return stops[0].color;
  const clampedT = Math.max(0, Math.min(1, t));
  const bounds = normalizeStopWeights(stops);
  // Compute center of each weighted band so each stop occupies its configured weight share
  const centers: number[] = [];
  let prev = 0;
  for (let i = 0; i < bounds.length; i++) {
    centers.push((prev + bounds[i]) * 0.5);
    prev = bounds[i];
  }
  if (clampedT <= centers[0]) return stops[0].color;
  if (clampedT >= centers[centers.length - 1]) return stops[stops.length - 1].color;
  for (let i = 0; i < centers.length - 1; i++) {
    const c0 = centers[i];
    const c1 = centers[i + 1];
    if (clampedT >= c0 && clampedT <= c1) {
      const span = Math.max(1e-6, c1 - c0);
      const localT = (clampedT - c0) / span;
      return localT < thr ? stops[i].color : stops[i + 1].color;
    }
  }
  return stops[stops.length - 1].color;
}

function gradientT(x: number, y: number, a: Pt, b: Pt, shape: GradientShape): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return 0;
  if (shape === 'radial') {
    const dist = Math.hypot(x - a.x, y - a.y);
    return Math.max(0, Math.min(1, dist / Math.sqrt(lenSq)));
  }
  const proj = ((x - a.x) * dx + (y - a.y) * dy) / lenSq;
  return Math.max(0, Math.min(1, proj));
}

function bayerThreshold(x: number, y: number, pattern: DitherPattern): number {
  const px = ((x % 8) + 8) % 8;
  const py = ((y % 8) + 8) % 8;
  if (pattern === 'bayer2') return (BAYER_2[py & 1][px & 1] + 0.5) / 4;
  if (pattern === 'bayer8') return (BAYER_8[py][px] + 0.5) / 64;
  if (pattern === 'checker') return ((x + y) & 1) === 0 ? 0.25 : 0.75;
  if (pattern === 'scanline') return (y & 1) === 0 ? 0.25 : 0.75;
  if (pattern === 'diag') return ((((x + y) % 4) + 4) % 4 + 0.5) / 4;
  return (BAYER_4[py & 3][px & 3] + 0.5) / 16;
}

/** Render a direct-canvas dither gradient (2-stop or multi-stop weighted) between points A and B into RGBA pixels. */
export function renderDitherGradient(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  a: Pt,
  b: Pt,
  opts: DitherGradientOpts,
): void {
  const sel = opts.mask ?? null;
  const alphaLock = opts.alphaLock ?? false;
  const useStops = Boolean(opts.stops && opts.stops.length >= 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (sel && !getMaskBit(sel, x, y)) continue;
      const i = (y * w + x) * 4;
      if (alphaLock && data[i + 3] === 0) continue;
      const t = gradientT(x, y, a, b, opts.shape);
      const thr = bayerThreshold(x, y, opts.pattern);
      if (useStops && opts.stops) {
        const col = sampleWeightedGradientDither(t, thr, opts.stops);
        if (col[3] === 0 && opts.toTransparent) continue;
        data[i] = col[0];
        data[i + 1] = col[1];
        data[i + 2] = col[2];
        data[i + 3] = alphaLock ? data[i + 3] : col[3];
        continue;
      }
      const useFrom = t < thr;
      if (useFrom) {
        data[i] = opts.from[0];
        data[i + 1] = opts.from[1];
        data[i + 2] = opts.from[2];
        data[i + 3] = alphaLock ? data[i + 3] : opts.from[3];
      } else if (!opts.toTransparent) {
        data[i] = opts.to[0];
        data[i + 1] = opts.to[1];
        data[i + 2] = opts.to[2];
        data[i + 3] = alphaLock ? data[i + 3] : opts.to[3];
      }
    }
  }
}

/** Render a linear or radial gradient directly into a 1-byte-per-pixel Layer Mask or Effect Mask. */
export function renderMaskGradient(
  maskBuf: Uint8Array,
  w: number,
  h: number,
  a: Pt,
  b: Pt,
  opts: { shape: GradientShape; pattern: DitherPattern; dither: boolean; fromVal: number; toVal: number; mask?: SelectionMask | null },
): void {
  const sel = opts.mask ?? null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (sel && !getMaskBit(sel, x, y)) continue;
      const t = gradientT(x, y, a, b, opts.shape);
      const idx = y * w + x;
      if (opts.dither) {
        const thr = bayerThreshold(x, y, opts.pattern);
        maskBuf[idx] = t < thr ? opts.fromVal : opts.toVal;
      } else {
        maskBuf[idx] = Math.round(opts.fromVal * (1 - t) + opts.toVal * t);
      }
    }
  }
}
