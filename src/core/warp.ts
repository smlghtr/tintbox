import { getMaskBit, maskBounds, type SelectionMask } from './selection';
import type { Pt } from './types';

export type WarpPreset = 'quad' | 'arc' | 'bulge' | 'wave' | 'skew' | 'perspective';

export const WARP_PRESETS: { id: WarpPreset; label: string }[] = [
  { id: 'quad', label: 'Free Corner Warp' },
  { id: 'arc', label: 'Arc / Bend' },
  { id: 'bulge', label: 'Bulge / Pinch' },
  { id: 'wave', label: 'Wave' },
  { id: 'skew', label: 'Skew / Shear' },
  { id: 'perspective', label: 'Perspective' },
];

export interface WarpParams {
  preset: WarpPreset;
  /** Primary bend/strength (-100..100). */
  strength: number;
  /** Secondary frequency or vertical skew (-100..100). */
  secondary: number;
  /** Four normalized corner positions [TL, TR, BR, BL] in [0..1] for Free Corner / Perspective warp. */
  corners: [Pt, Pt, Pt, Pt];
}

export function defaultWarpParams(): WarpParams {
  return {
    preset: 'quad',
    strength: 35,
    secondary: 20,
    corners: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  };
}

/**
 * Invert bilinear quad mapping: given normalized destination (u, v) and 4 deformed corners [TL, TR, BR, BL],
 * solve for source (su, sv) via fast Newton-Raphson iterations so nearest-neighbor sampling leaves zero holes.
 */
function invertBilinearQuad(u: number, v: number, c: [Pt, Pt, Pt, Pt]): Pt | null {
  const [p00, p10, p11, p01] = c;
  let s = u;
  let t = v;
  for (let iter = 0; iter < 8; iter++) {
    const a = 1 - s;
    const b = 1 - t;
    const fx = a * b * p00.x + s * b * p10.x + s * t * p11.x + a * t * p01.x - u;
    const fy = a * b * p00.y + s * b * p10.y + s * t * p11.y + a * t * p01.y - v;
    if (Math.abs(fx) < 1e-4 && Math.abs(fy) < 1e-4) break;

    const dfxDs = b * (p10.x - p00.x) + t * (p11.x - p01.x);
    const dfxDt = a * (p01.x - p00.x) + s * (p11.x - p10.x);
    const dfyDs = b * (p10.y - p00.y) + t * (p11.y - p01.y);
    const dfyDt = a * (p01.y - p00.y) + s * (p11.y - p10.y);
    const det = dfxDs * dfyDt - dfxDt * dfyDs;
    if (Math.abs(det) < 1e-7) return null;
    s -= (fx * dfyDt - fy * dfxDt) / det;
    t -= (dfxDs * fy - dfyDs * fx) / det;
  }
  if (s < -0.001 || s > 1.001 || t < -0.001 || t > 1.001) return null;
  return { x: Math.max(0, Math.min(1, s)), y: Math.max(0, Math.min(1, t)) };
}

/**
 * Pure nearest-neighbor pixel-art warp (zero anti-aliasing blur, zero holes).
 * Warps selection bounding box if `mask` is provided, else the full cel.
 */
export function warpCelPixels(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  params: WarpParams,
  mask?: SelectionMask | null,
): Uint8ClampedArray {
  const bounds = mask ? maskBounds(mask) : { x: 0, y: 0, w, h };
  if (!bounds || bounds.w < 1 || bounds.h < 1) return src.slice();

  const out = mask ? src.slice() : new Uint8ClampedArray(w * h * 4);
  if (mask) {
    for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
        if (!getMaskBit(mask, x, y)) continue;
        const i = (y * w + x) * 4;
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
      }
    }
  }

  const bw = bounds.w;
  const bh = bounds.h;
  const str = params.strength / 100;
  const sec = params.secondary / 100;

  for (let dy = 0; dy < bh; dy++) {
    const v = bh > 1 ? dy / (bh - 1) : 0.5;
    for (let dx = 0; dx < bw; dx++) {
      const u = bw > 1 ? dx / (bw - 1) : 0.5;
      let su = u;
      let sv = v;

      if (params.preset === 'quad') {
        const inv = invertBilinearQuad(u, v, params.corners);
        if (!inv) continue;
        su = inv.x;
        sv = inv.y;
      } else if (params.preset === 'arc') {
        const bend = Math.sin(u * Math.PI) * str * 0.45;
        sv = v + bend;
      } else if (params.preset === 'bulge') {
        const nx = (u - 0.5) * 2;
        const ny = (v - 0.5) * 2;
        const r = Math.hypot(nx, ny);
        if (r < 1 && r > 1e-5) {
          const factor = Math.pow(r, str >= 0 ? 1 + str * 1.2 : 1 / (1 - str * 1.2));
          su = 0.5 + (nx / r) * factor * 0.5;
          sv = 0.5 + (ny / r) * factor * 0.5;
        }
      } else if (params.preset === 'wave') {
        const freq = 1 + Math.abs(sec) * 4;
        sv = v + Math.sin(u * Math.PI * 2 * freq) * str * 0.22;
      } else if (params.preset === 'skew') {
        su = u - (v - 0.5) * str * 0.8;
        sv = v - (u - 0.5) * sec * 0.8;
      } else if (params.preset === 'perspective') {
        const shrink = Math.max(-0.42, Math.min(0.42, str * 0.42));
        const corners: [Pt, Pt, Pt, Pt] = [
          { x: Math.max(0, shrink), y: 0 },
          { x: Math.min(1, 1 - shrink), y: 0 },
          { x: Math.min(1, 1 + Math.min(0, shrink)), y: 1 },
          { x: Math.max(0, -Math.min(0, shrink)), y: 1 },
        ];
        const inv = invertBilinearQuad(u, v, corners);
        if (!inv) continue;
        su = inv.x;
        sv = inv.y;
      }

      if (su < 0 || su > 1 || sv < 0 || sv > 1) continue;
      const sx = bounds.x + Math.round(su * (bw - 1));
      const sy = bounds.y + Math.round(sv * (bh - 1));
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      if (mask && !getMaskBit(mask, sx, sy)) continue;

      const si = (sy * w + sx) * 4;
      const di = ((bounds.y + dy) * w + (bounds.x + dx)) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }

  return out;
}
