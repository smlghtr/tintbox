import { describe, expect, it } from 'vitest';
import { nearestPaletteColor, oklabToRgb, rgbToOklab } from './color';
import { extractPalette, remapToPalette } from './quantize';
import { setPixel } from './raster';
import type { RGBA } from './types';

function makeGradient(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.round((x / (w - 1)) * 255);
      const g = Math.round((y / (h - 1)) * 255);
      const b = Math.round(((x + y) / (w + h - 2)) * 255);
      setPixel(data, w, h, x, y, [r, g, b, 255]);
    }
  }
  return data;
}

describe('OKLab color math', () => {
  it('round-trips sRGB <-> OKLab accurately', () => {
    const samples: [number, number, number][] = [[0, 0, 0], [255, 255, 255], [198, 244, 50], [63, 166, 107]];
    for (const [r, g, b] of samples) {
      const lab = rgbToOklab(r, g, b);
      const [rr, gg, bb] = oklabToRgb(lab.L, lab.a, lab.b);
      expect(Math.abs(rr - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(gg - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(bb - b)).toBeLessThanOrEqual(1);
    }
  });

  it('snaps color to nearest palette entry in OKLab', () => {
    const pal: RGBA[] = [[20, 20, 20, 255], [220, 40, 40, 255], [40, 200, 80, 255]];
    expect(nearestPaletteColor([210, 50, 45, 255], pal)).toEqual([220, 40, 40, 255]);
  });
});

describe('F-EXTRACT quantize', () => {
  it('returns exactly 4, 8, and 16 colors on a gradient image across methods', () => {
    const grad = makeGradient(64, 64);
    for (const count of [4, 8, 16]) {
      for (const method of ['median-cut', 'kmeans-oklab', 'most-frequent'] as const) {
        const res = extractPalette(grad, 64, 64, { count, method });
        expect(res.colors).toHaveLength(count);
        expect(res.coverages).toHaveLength(count);
        const sumCov = res.coverages.reduce((a, b) => a + b, 0);
        expect(sumCov).toBeCloseTo(100, 1);
      }
    }
  });

  it('returns only unique count when image has fewer colors than requested', () => {
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        setPixel(data, 8, 8, x, y, x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
      }
    }
    const res = extractPalette(data, 8, 8, { count: 8 });
    expect(res.uniqueCount).toBe(2);
    expect(res.colors).toHaveLength(2);
  });

  it('is strictly deterministic (same input twice produces identical palette)', () => {
    const grad = makeGradient(48, 48);
    const a = extractPalette(grad, 48, 48, { count: 8, method: 'kmeans-oklab', sortBy: 'hue' });
    const b = extractPalette(grad, 48, 48, { count: 8, method: 'kmeans-oklab', sortBy: 'hue' });
    expect(a.colors).toEqual(b.colors);
  });

  it('excludes transparent pixels and optionally ignores near-white/black', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    setPixel(data, 4, 4, 0, 0, [255, 255, 255, 255]);
    setPixel(data, 4, 4, 1, 0, [2, 2, 2, 255]);
    setPixel(data, 4, 4, 2, 0, [100, 180, 50, 255]);
    setPixel(data, 4, 4, 3, 0, [50, 100, 200, 255]);
    // Remaining 12 pixels are transparent [0,0,0,0]
    const withExtremes = extractPalette(data, 4, 4, { count: 8 });
    expect(withExtremes.colors).toHaveLength(4);
    const noExtremes = extractPalette(data, 4, 4, { count: 8, ignoreNearExtremes: true });
    expect(noExtremes.colors).toHaveLength(2);
  });

  it('remapToPalette outputs only colors from the target palette (with and without dither)', () => {
    const grad = makeGradient(16, 16);
    const pal: RGBA[] = [[20, 20, 20, 255], [200, 50, 50, 255], [50, 200, 50, 255], [240, 240, 220, 255]];
    const palKeys = new Set(pal.map((c) => `${c[0]},${c[1]},${c[2]}`));

    for (const dither of [false, true]) {
      const remapped = remapToPalette(grad, 16, 16, pal, { dither });
      for (let i = 0; i < remapped.length; i += 4) {
        expect(palKeys.has(`${remapped[i]},${remapped[i + 1]},${remapped[i + 2]}`)).toBe(true);
      }
    }
  });
});
