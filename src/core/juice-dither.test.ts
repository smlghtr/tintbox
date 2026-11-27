import { describe, expect, it } from 'vitest';
import {
  ditherMatches,
  normalizeStopWeights,
  renderDitherGradient,
  sampleWeightedGradientDither,
  type DitherGradientStop,
} from './dither';
import { defaultJuiceParams, evalJuiceFrame, generateJuiceFrames, JUICE_PRESETS } from './juice';
import type { RGBA } from './types';

function makeSpriteBox(w: number, h: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 8; y < 24; y++) {
    for (let x = 10; x < 22; x++) {
      const i = (y * w + x) * 4;
      buf[i] = 198;
      buf[i + 1] = 244;
      buf[i + 2] = 50;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

describe('Juice FX procedural animator (core/juice.ts)', () => {
  it('generates deterministic frames without mutating source buffer across all presets', () => {
    const src = makeSpriteBox(32, 32);
    const snapshot = src.slice();

    for (const preset of JUICE_PRESETS) {
      const params = { ...defaultJuiceParams(preset.id), frames: 6 };
      const framesA = generateJuiceFrames(src, 32, 32, params);
      const framesB = generateJuiceFrames(src, 32, 32, params);

      expect(framesA.length).toBe(6);
      expect(src).toEqual(snapshot);
      for (let i = 0; i < framesA.length; i++) {
        expect(framesA[i]).toEqual(framesB[i]);
      }
    }
  });

  it('produces animated variation across frames for squash-bounce, tree-sway, and hit-flash', () => {
    const src = makeSpriteBox(32, 32);

    const bounce = generateJuiceFrames(src, 32, 32, defaultJuiceParams('squash-bounce'));
    expect(bounce[0]).not.toEqual(bounce[2]);

    const flash = generateJuiceFrames(src, 32, 32, defaultJuiceParams('hit-flash'));
    // Frame 0 hit flash mixes towards white
    const midIdx = (16 * 32 + 16) * 4;
    expect(flash[0][midIdx]).toBeGreaterThan(220);
    expect(flash[0][midIdx + 2]).toBeGreaterThan(180);
  });

  it('adds 1px outer outline when outline option is enabled and preserves crisp alpha in pixelArt mode', () => {
    const src = makeSpriteBox(32, 32);
    const p = {
      ...defaultJuiceParams('custom'),
      scaleX: 0,
      scaleY: 0,
      outline: true,
      outlineColor: [10, 20, 30, 255] as RGBA,
      pixelArt: true,
    };
    const f = evalJuiceFrame(src, 32, 32, 0, p);
    // Pixel immediately outside box at (9, 12) should be outline color
    const i = (12 * 32 + 9) * 4;
    expect([f[i], f[i + 1], f[i + 2], f[i + 3]]).toEqual([10, 20, 30, 255]);
  });
});

describe('Dither Machine multi-stop weighted gradients & Bayer 8x8 (core/dither.ts)', () => {
  it('supports Bayer 8x8 density monotonicity', () => {
    let low = 0;
    let high = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (ditherMatches(x, y, 'bayer8', 25)) low++;
        if (ditherMatches(x, y, 'bayer8', 75)) high++;
      }
    }
    expect(low).toBe(16);
    expect(high).toBe(48);
  });

  it('normalizes stop weights and renders 3-stop weighted gradient using only stop colors', () => {
    const stops: DitherGradientStop[] = [
      { color: [20, 30, 60, 255], weight: 20 },
      { color: [120, 200, 90, 255], weight: 60 },
      { color: [250, 240, 120, 255], weight: 20 },
    ];
    const bounds = normalizeStopWeights(stops);
    expect(bounds[0]).toBeCloseTo(0.2);
    expect(bounds[1]).toBeCloseTo(0.8);
    expect(bounds[2]).toBe(1);

    expect(sampleWeightedGradientDither(0, 0.5, stops)).toEqual(stops[0].color);
    expect(sampleWeightedGradientDither(1, 0.5, stops)).toEqual(stops[2].color);

    const buf = new Uint8ClampedArray(32 * 8 * 4);
    renderDitherGradient(buf, 32, 8, { x: 0, y: 0 }, { x: 31, y: 0 }, {
      shape: 'linear',
      pattern: 'bayer8',
      from: stops[0].color,
      to: stops[2].color,
      stops,
    });

    const counts = [0, 0, 0];
    for (let i = 0; i < buf.length; i += 4) {
      const idx = stops.findIndex(
        (s) => s.color[0] === buf[i] && s.color[1] === buf[i + 1] && s.color[2] === buf[i + 2],
      );
      expect(idx).toBeGreaterThanOrEqual(0);
      counts[idx]++;
    }
    // Middle stop has 60% weight so it must dominate
    expect(counts[1]).toBeGreaterThan(counts[0]);
    expect(counts[1]).toBeGreaterThan(counts[2]);
  });
});
