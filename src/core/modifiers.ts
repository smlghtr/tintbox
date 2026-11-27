import { hslToRgb, rgbToHsl } from './palette';
import { remapToPalette } from './quantize';
import { getMaskBit } from './selection';
import type {
  ColorMod,
  DitherMod,
  LightingMod,
  Modifier,
  OutlineMod,
  PaletteMapMod,
  RGBA,
  SelectionMaskData,
  ShadowMod,
  ToneMod,
} from './types';

const BAYER2_M = [
  [0, 2],
  [3, 1],
];
const BAYER4_M = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function inMask(mask: SelectionMaskData | undefined, x: number, y: number): boolean {
  if (!mask) return true;
  return getMaskBit(mask, x, y);
}

function colorMod(src: Uint8ClampedArray, w: number, h: number, m: ColorMod): Uint8ClampedArray {
  const out = m.mask ? src.slice() : new Uint8ClampedArray(src.length);
  const satDelta = m.sat / 100;
  const lightDelta = m.light / 100;
  const opScale = m.opacity / 100;
  const mask = m.mask;

  if (!mask) {
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3];
      if (a === 0) continue;
      const [hue, s, l] = rgbToHsl(src[i], src[i + 1], src[i + 2]);
      const [r, g, b] = hslToRgb(hue + m.hue, clamp(s + satDelta, 0, 1), clamp(l + lightDelta, 0, 1));
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = Math.round(a * opScale);
    }
    return out;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!getMaskBit(mask, x, y)) continue;
      const i = (y * w + x) * 4;
      const a = src[i + 3];
      if (a === 0) continue;
      const [hue, s, l] = rgbToHsl(src[i], src[i + 1], src[i + 2]);
      const [r, g, b] = hslToRgb(hue + m.hue, clamp(s + satDelta, 0, 1), clamp(l + lightDelta, 0, 1));
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = Math.round(a * opScale);
    }
  }
  return out;
}

function outlinePass(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  m: OutlineMod,
): Uint8ClampedArray {
  const out = src.slice();
  const [cr, cg, cb, ca] = m.color;
  const outer = m.mode === 'outer';
  const conn8 = m.connectivity === 8;
  const onlyOutsideBounds = Boolean(m.onlyOutsideBounds);
  const mask = m.mask;
  const rowStride = w * 4;

  for (let y = 0; y < h; y++) {
    const rowOff = y * rowStride;
    for (let x = 0; x < w; x++) {
      if (!inMask(mask, x, y)) continue;
      const i = rowOff + x * 4;
      const filled = src[i + 3] > 0;
      if (outer) {
        if (filled) continue;
        if (onlyOutsideBounds && x > 0 && x + 1 < w && y > 0 && y + 1 < h) continue;
        let touches =
          (x > 0 && src[i - 1] > 0) ||
          (x + 1 < w && src[i + 7] > 0) ||
          (y > 0 && src[i - rowStride + 3] > 0) ||
          (y + 1 < h && src[i + rowStride + 3] > 0);
        if (!touches && conn8) {
          touches =
            (x > 0 && y > 0 && src[i - rowStride - 1] > 0) ||
            (x + 1 < w && y > 0 && src[i - rowStride + 7] > 0) ||
            (x > 0 && y + 1 < h && src[i + rowStride - 1] > 0) ||
            (x + 1 < w && y + 1 < h && src[i + rowStride + 7] > 0);
        }
        if (touches) {
          out[i] = cr;
          out[i + 1] = cg;
          out[i + 2] = cb;
          out[i + 3] = ca;
        }
      } else {
        if (!filled) continue;
        const onEdge = x === 0 || x + 1 === w || y === 0 || y + 1 === h;
        let touches =
          (!onlyOutsideBounds && onEdge) ||
          (x > 0 && src[i - 1] === 0) ||
          (x + 1 < w && src[i + 7] === 0) ||
          (y > 0 && src[i - rowStride + 3] === 0) ||
          (y + 1 < h && src[i + rowStride + 3] === 0);
        if (!touches && conn8) {
          touches =
            (x > 0 && y > 0 && src[i - rowStride - 1] === 0) ||
            (x + 1 < w && y > 0 && src[i - rowStride + 7] === 0) ||
            (x > 0 && y + 1 < h && src[i + rowStride - 1] === 0) ||
            (x + 1 < w && y + 1 < h && src[i + rowStride + 7] === 0);
        }
        if (touches) {
          out[i] = cr;
          out[i + 1] = cg;
          out[i + 2] = cb;
          out[i + 3] = ca;
        }
      }
    }
  }
  return out;
}

function outlineMod(src: Uint8ClampedArray, w: number, h: number, m: OutlineMod): Uint8ClampedArray {
  const rawW = m.width ?? 1;
  if (rawW > 0 && rawW < 1) {
    const fineAlpha = Math.max(1, Math.round(m.color[3] * Math.max(0.2, rawW)));
    return outlinePass(src, w, h, { ...m, color: [m.color[0], m.color[1], m.color[2], fineAlpha] });
  }
  const width = Math.max(1, Math.min(4, Math.round(rawW)));
  let cur = src;
  for (let step = 0; step < width; step++) {
    cur = outlinePass(cur, w, h, m);
  }
  return cur;
}

/** Drop shadow: renders offset silhouette behind original pixels (pure, non-destructive). */
export function shadowMod(src: Uint8ClampedArray, w: number, h: number, m: ShadowMod): Uint8ClampedArray {
  const out = src.slice();
  const ox = Math.round(m.offsetX);
  const oy = Math.round(m.offsetY);
  const [sr, sg, sb, saByte] = m.color;
  const mask = m.mask;

  for (let y = 0; y < h; y++) {
    const sy = y - oy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - ox;
      if (sx < 0 || sx >= w) continue;
      if (!inMask(mask, x, y)) continue;
      const si = (sy * w + sx) * 4;
      const srcAlpha = src[si + 3];
      if (srcAlpha === 0) continue;

      const di = (y * w + x) * 4;
      const dstAlpha = src[di + 3];
      if (dstAlpha === 255) continue;

      const shadowA = (srcAlpha / 255) * (saByte / 255);
      if (dstAlpha === 0) {
        out[di] = sr;
        out[di + 1] = sg;
        out[di + 2] = sb;
        out[di + 3] = Math.round(shadowA * 255);
      } else {
        // Place shadow strictly behind existing semi-transparent pixel
        const fa = dstAlpha / 255;
        const oa = fa + shadowA * (1 - fa);
        if (oa > 0) {
          out[di] = Math.round((src[di] * fa + sr * shadowA * (1 - fa)) / oa);
          out[di + 1] = Math.round((src[di + 1] * fa + sg * shadowA * (1 - fa)) / oa);
          out[di + 2] = Math.round((src[di + 2] * fa + sb * shadowA * (1 - fa)) / oa);
          out[di + 3] = Math.round(oa * 255);
        }
      }
    }
  }
  return out;
}

export function paletteMapMod(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  m: PaletteMapMod,
  palette: RGBA[] | undefined,
): Uint8ClampedArray {
  if (!palette || palette.length === 0) return src;
  return remapToPalette(src, w, h, palette, { dither: m.dither, mask: m.mask ?? null });
}

/** Ordered dither effect modifier: quantizes RGB channels with Bayer 2x2 / 4x4 / Checker threshold. */
export function ditherEffectMod(src: Uint8ClampedArray, w: number, h: number, m: DitherMod): Uint8ClampedArray {
  const out = src.slice();
  const levels = Math.max(2, Math.min(8, Math.round(m.levels)));
  const str = clamp(m.strength, 0, 100) / 100;
  const step = 255 / (levels - 1);
  const mask = m.mask;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inMask(mask, x, y)) continue;
      const i = (y * w + x) * 4;
      if (src[i + 3] === 0) continue;
      let thr = 0;
      if (m.pattern === 'checker') thr = ((x + y) & 1) === 0 ? 0.25 : -0.25;
      else if (m.pattern === 'bayer2') thr = (BAYER2_M[y & 1][x & 1] + 0.5) / 4 - 0.5;
      else thr = (BAYER4_M[y & 3][x & 3] + 0.5) / 16 - 0.5;
      const bias = thr * step * str;
      for (let c = 0; c < 3; c++) {
        const q = Math.round(clamp(src[i + c] + bias, 0, 255) / step) * step;
        out[i + c] = Math.round(clamp(q, 0, 255));
      }
    }
  }
  return out;
}

/**
 * Controllable directional lighting source modifier:
 * computes a 2D pixel-art bevel normal field from silhouette alpha distance and shades with controllable light angle/elevation/color.
 */
export function lightingMod(src: Uint8ClampedArray, w: number, h: number, m: LightingMod): Uint8ClampedArray {
  const out = src.slice();
  const rad = (m.angle * Math.PI) / 180;
  const elev = (clamp(m.elevation, 5, 89) * Math.PI) / 180;
  const lx = Math.cos(rad) * Math.cos(elev);
  const ly = Math.sin(rad) * Math.cos(elev);
  const lz = Math.sin(elev);
  const intensity = clamp(m.intensity, 0, 100) / 100;
  const ambient = clamp(m.ambient, 0, 100) / 100;
  const bevel = Math.max(1, Math.min(6, Math.round(m.bevel || 2)));
  const [lr, lg, lb] = m.color;
  const mask = m.mask;

  // Compute clamped distance-from-edge height field (0 outside, 1..bevel inside)
  const height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (src[(y * w + x) * 4 + 3] > 0) height[y * w + x] = bevel;
    }
  }
  // 2-pass Chamfer distance from transparent pixels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (height[p] === 0) continue;
      const up = y > 0 ? height[p - w] : 0;
      const left = x > 0 ? height[p - 1] : 0;
      height[p] = Math.min(height[p], Math.min(up, left) + 1);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      if (height[p] === 0) continue;
      const dn = y + 1 < h ? height[p + w] : 0;
      const rt = x + 1 < w ? height[p + 1] : 0;
      height[p] = Math.min(height[p], Math.min(dn, rt) + 1);
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inMask(mask, x, y)) continue;
      const p = y * w + x;
      const i = p * 4;
      if (src[i + 3] === 0) continue;

      const hL = x > 0 ? height[p - 1] : 0;
      const hR = x + 1 < w ? height[p + 1] : 0;
      const hU = y > 0 ? height[p - w] : 0;
      const hD = y + 1 < h ? height[p + w] : 0;

      // Surface normal pointing away from edges toward interior plateau
      let nx = (hL - hR) / bevel;
      let ny = (hU - hD) / bevel;
      let nz = 1;
      const invLen = 1 / Math.hypot(nx, ny, nz);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      const ndotl = Math.max(0, nx * lx + ny * ly + nz * lz);
      const shade = ambient + (1 - ambient) * (0.35 + ndotl * 1.15);
      const spec = Math.pow(Math.max(0, ndotl), 6) * 0.45 * intensity;

      const mix = 1 - intensity + intensity * shade;
      const tintR = lr / 255;
      const tintG = lg / 255;
      const tintB = lb / 255;

      out[i] = Math.round(clamp(src[i] * (1 - intensity + intensity * shade * (0.5 + 0.5 * tintR)) + lr * spec, 0, 255));
      out[i + 1] = Math.round(clamp(src[i + 1] * (1 - intensity + intensity * shade * (0.5 + 0.5 * tintG)) + lg * spec, 0, 255));
      out[i + 2] = Math.round(clamp(src[i + 2] * (1 - intensity + intensity * shade * (0.5 + 0.5 * tintB)) + lb * spec, 0, 255));
      void mix;
    }
  }
  return out;
}

/** Shadow & Highlight tonal modifier with luminance-weighted lift, tinting, and contrast. */
export function toneMod(src: Uint8ClampedArray, w: number, h: number, m: ToneMod): Uint8ClampedArray {
  const out = src.slice();
  const shAmt = clamp(m.shadows, -100, 100) / 100;
  const hiAmt = clamp(m.highlights, -100, 100) / 100;
  const cAmt = clamp(m.contrast, -100, 100) / 100;
  const contrastFactor = cAmt >= 0 ? 1 + cAmt * 1.5 : 1 + cAmt * 0.85;
  const [sr, sg, sb, sa] = m.shadowTint;
  const [hr, hg, hb, ha] = m.highlightTint;
  const shTintStr = sa / 255;
  const hiTintStr = ha / 255;
  const mask = m.mask;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inMask(mask, x, y)) continue;
      const i = (y * w + x) * 4;
      if (src[i + 3] === 0) continue;

      let r = src[i] / 255;
      let g = src[i + 1] / 255;
      let b = src[i + 2] / 255;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const shW = (1 - lum) * (1 - lum);
      const hiW = lum * lum;

      // Lift / crush shadows & highlights
      const delta = shAmt * 0.45 * shW + hiAmt * 0.45 * hiW;
      r = clamp(r + delta, 0, 1);
      g = clamp(g + delta, 0, 1);
      b = clamp(b + delta, 0, 1);

      // Tint shadows and highlights independently
      if (shTintStr > 0) {
        const wMix = shW * shTintStr * 0.6;
        r = r * (1 - wMix) + (sr / 255) * wMix;
        g = g * (1 - wMix) + (sg / 255) * wMix;
        b = b * (1 - wMix) + (sb / 255) * wMix;
      }
      if (hiTintStr > 0) {
        const wMix = hiW * hiTintStr * 0.6;
        r = r * (1 - wMix) + (hr / 255) * wMix;
        g = g * (1 - wMix) + (hg / 255) * wMix;
        b = b * (1 - wMix) + (hb / 255) * wMix;
      }

      // Contrast around mid-grey
      if (cAmt !== 0) {
        r = clamp((r - 0.5) * contrastFactor + 0.5, 0, 1);
        g = clamp((g - 0.5) * contrastFactor + 0.5, 0, 1);
        b = clamp((b - 0.5) * contrastFactor + 0.5, 0, 1);
      }

      out[i] = Math.round(r * 255);
      out[i + 1] = Math.round(g * 255);
      out[i + 2] = Math.round(b * 255);
    }
  }
  return out;
}

function blendByEffectMask(
  orig: Uint8ClampedArray,
  mod: Uint8ClampedArray,
  effectMask: Uint8Array,
): Uint8ClampedArray {
  const pixelCount = orig.length / 4;
  if (effectMask.length < pixelCount) return mod;
  const out = new Uint8ClampedArray(orig.length);
  for (let p = 0; p < pixelCount; p++) {
    const m = effectMask[p];
    const i = p * 4;
    if (m >= 255) {
      out[i] = mod[i];
      out[i + 1] = mod[i + 1];
      out[i + 2] = mod[i + 2];
      out[i + 3] = mod[i + 3];
    } else if (m <= 0) {
      out[i] = orig[i];
      out[i + 1] = orig[i + 1];
      out[i + 2] = orig[i + 2];
      out[i + 3] = orig[i + 3];
    } else {
      const t = m / 255;
      const it = 1 - t;
      out[i] = Math.round(orig[i] * it + mod[i] * t);
      out[i + 1] = Math.round(orig[i + 1] * it + mod[i + 1] * t);
      out[i + 2] = Math.round(orig[i + 2] * it + mod[i + 2] * t);
      out[i + 3] = Math.round(orig[i + 3] * it + mod[i + 3] * t);
    }
  }
  return out;
}

export function applySingleModifier(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  m: Modifier,
  palette?: RGBA[],
): Uint8ClampedArray {
  let result: Uint8ClampedArray;
  switch (m.type) {
    case 'color':
      result = colorMod(src, w, h, m);
      break;
    case 'outline':
      result = outlineMod(src, w, h, m);
      break;
    case 'shadow':
      result = shadowMod(src, w, h, m);
      break;
    case 'palette-map':
      result = paletteMapMod(src, w, h, m, palette);
      break;
    case 'dither':
      result = ditherEffectMod(src, w, h, m);
      break;
    case 'lighting':
      result = lightingMod(src, w, h, m);
      break;
    case 'tone':
      result = toneMod(src, w, h, m);
      break;
  }
  if (m.effectMask && m.effectMask.length === w * h) {
    return blendByEffectMask(src, result, m.effectMask);
  }
  return result;
}

/** Pure: never mutates `src`. Returns `src` itself when nothing is enabled. Supports optional soloModifierId & palette. */
export function applyModifiers(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  mods: Modifier[],
  soloModifierId?: string | null,
  palette?: RGBA[],
): Uint8ClampedArray {
  let out = src;
  for (const m of mods) {
    if (soloModifierId) {
      if (m.id !== soloModifierId) continue;
    } else if (!m.enabled) {
      continue;
    }
    out = applySingleModifier(out, w, h, m, palette);
  }
  return out;
}
