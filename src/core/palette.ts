import type { ReferenceImage, RGBA } from './types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function hexToRgba(hex: string): RGBA {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

export function rgbaToHex([r, g, b]: RGBA): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function rgbaEqual(a: RGBA, b: RGBA): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export interface RampOpts {
  steps: number;
  /** degrees of hue rotation per step away from the base; lights go +, shadows go - */
  hueShift: number;
  /** saturation lost per step toward the lights, in percent */
  satShift: number;
  /** lightness gained per step toward the lights, in percent */
  lightStep: number;
}

/** Dark-to-light ramp centered on `base`. */
export function makeRamp(base: RGBA, o: RampOpts): RGBA[] {
  const [h, s, l] = rgbToHsl(base[0], base[1], base[2]);
  const mid = (o.steps - 1) / 2;
  return Array.from({ length: o.steps }, (_, i) => {
    const d = i - mid;
    const [r, g, b] = hslToRgb(
      h + d * o.hueShift,
      clamp(s - (d * o.satShift) / 100, 0, 1),
      clamp(l + (d * o.lightStep) / 100, 0.04, 0.96),
    );
    return [r, g, b, 255];
  });
}

function lerpHue(h1: number, h2: number, t: number): number {
  let diff = ((h2 - h1 + 540) % 360) - 180;
  return (h1 + diff * t + 360) % 360;
}

/** Dark / Base / Light HSL interpolation ramp with contrast multiplier (50..200%). */
export function makeTriadRamp(
  dark: RGBA,
  base: RGBA,
  light: RGBA,
  steps: number,
  multiplier = 100,
): RGBA[] {
  const n = Math.max(3, Math.min(9, Math.round(steps)));
  const [h0, s0, l0] = rgbToHsl(dark[0], dark[1], dark[2]);
  const [h1, s1, l1] = rgbToHsl(base[0], base[1], base[2]);
  const [h2, s2, l2] = rgbToHsl(light[0], light[1], light[2]);
  const mult = clamp(multiplier, 50, 200) / 100;
  const mid = (n - 1) / 2;

  return Array.from({ length: n }, (_, i) => {
    let h: number;
    let s: number;
    let l: number;
    if (i <= mid) {
      const t = mid === 0 ? 1 : i / mid;
      const tm = clamp(1 - (1 - t) * mult, 0, 1);
      h = lerpHue(h0, h1, tm);
      s = s0 + (s1 - s0) * tm;
      l = l0 + (l1 - l0) * tm;
    } else {
      const t = (i - mid) / (n - 1 - mid);
      const tm = clamp(t * mult, 0, 1);
      h = lerpHue(h1, h2, tm);
      s = s1 + (s2 - s1) * tm;
      l = l1 + (l2 - l1) * tm;
    }
    const [r, g, b] = hslToRgb(h, clamp(s, 0, 1), clamp(l, 0.02, 0.98));
    return [r, g, b, 255];
  });
}

/** Sample a reference image layer in canvas coordinates (honoring position, scale, flip). */
export function sampleReferencePixel(ref: ReferenceImage, docX: number, docY: number): RGBA | null {
  if (ref.scale <= 0 || ref.w <= 0 || ref.h <= 0) return null;
  const localX = (docX + 0.5 - ref.x) / ref.scale;
  const localY = (docY + 0.5 - ref.y) / ref.scale;
  if (localX < 0 || localY < 0 || localX >= ref.w || localY >= ref.h) return null;
  let sx = Math.floor(localX);
  let sy = Math.floor(localY);
  if (ref.flipX) sx = ref.w - 1 - sx;
  if (ref.flipY) sy = ref.h - 1 - sy;
  const i = (sy * ref.w + sx) * 4;
  const a = ref.pixels[i + 3];
  if (a === 0) return null;
  return [ref.pixels[i], ref.pixels[i + 1], ref.pixels[i + 2], a];
}

export function defaultPaletteColors(): RGBA[] {
  return [
    '#14130f', '#2c2920', '#5a5343', '#968d76',
    '#d8d0bc', '#f4f0e4', '#c6f432', '#6ec442',
    '#2f7d4d', '#1d4d4f', '#3a86b8', '#7ac7e8',
    '#f2c94c', '#e67e35', '#c83e37', '#6e252c',
  ].map(hexToRgba);
}
