import { describe, expect, it } from 'vitest';
import { compose, composeRect, createDoc, newModifier } from './doc';
import { applySingleModifier, paletteMapMod, shadowMod } from './modifiers';
import { createMask, setMaskBit } from './selection';
import type { PaletteMapMod, RGBA, ShadowMod } from './types';

describe('P4 modifiers: Drop shadow & Palette map', () => {
  it('shadowMod offsets silhouette behind existing pixels and respects selection mask', () => {
    const w = 6;
    const h = 6;
    const src = new Uint8ClampedArray(w * h * 4);
    // Single opaque pixel at (2, 2)
    src.set([255, 0, 0, 255], (2 * w + 2) * 4);

    const mod: ShadowMod = {
      id: 'sh1',
      type: 'shadow',
      enabled: true,
      offsetX: 1,
      offsetY: 2,
      color: [10, 20, 30, 200],
    };
    const out = shadowMod(src, w, h, mod);
    // Original pixel at (2,2) stays on top
    expect(Array.from(out.subarray((2 * w + 2) * 4, (2 * w + 2) * 4 + 4))).toEqual([255, 0, 0, 255]);
    // Shadow pixel placed at (3,4)
    expect(Array.from(out.subarray((4 * w + 3) * 4, (4 * w + 3) * 4 + 4))).toEqual([10, 20, 30, 200]);

    // With mask only covering (2,2), shadow at (3,4) is outside mask and clipped
    const mask = createMask(w, h);
    setMaskBit(mask, 2, 2, true);
    const maskedOut = applySingleModifier(src, w, h, { ...mod, mask });
    expect(maskedOut[(4 * w + 3) * 4 + 3]).toBe(0);
  });

  it('paletteMapMod remaps pixels to active palette with and without dither', () => {
    const w = 4;
    const h = 4;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      src.set([99, 99, 99, 255], i * 4);
    }
    const palette: RGBA[] = [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ];
    const modNoDither: PaletteMapMod = { id: 'pm1', type: 'palette-map', enabled: true, dither: false };
    const outFlat = paletteMapMod(src, w, h, modNoDither, palette);
    for (let i = 0; i < w * h; i++) {
      const r = outFlat[i * 4];
      expect(r === 0 || r === 255).toBe(true);
    }

    const modDither: PaletteMapMod = { id: 'pm2', type: 'palette-map', enabled: true, dither: true };
    const outDither = paletteMapMod(src, w, h, modDither, palette);
    let blacks = 0;
    let whites = 0;
    for (let i = 0; i < w * h; i++) {
      if (outDither[i * 4] === 0) blacks++;
      else if (outDither[i * 4] === 255) whites++;
    }
    expect(blacks + whites).toBe(w * h);
    expect(blacks).toBeGreaterThan(0);
    expect(whites).toBeGreaterThan(0);

    // Empty palette leaves pixels unchanged
    expect(Array.from(paletteMapMod(src, w, h, modNoDither, []))).toEqual(Array.from(src));
  });

  it('compose and composeRect handle shadow and palette-map modifiers identically', () => {
    const doc = createDoc(8, 8);
    doc.layers[0].cels[0].set([240, 10, 10, 255], (3 * 8 + 3) * 4);
    doc.layers[0].modifiers.push(newModifier('shadow'), newModifier('palette-map'));

    const full = compose(doc, 0);
    const partial = new Uint8ClampedArray(8 * 8 * 4);
    composeRect(doc, 0, partial, { x: 3, y: 3, w: 1, h: 1 });
    expect(Array.from(partial)).toEqual(Array.from(full));
  });
});
