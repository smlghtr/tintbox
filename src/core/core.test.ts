import { describe, expect, it } from 'vitest';
import {
  addFrame,
  addLayer,
  compose,
  composeRect,
  createDoc,
  createReferenceLayer,
  duplicateLayer,
  flattenVisible,
  mergeDown,
  newModifier,
  removeFrame,
  removeLayer,
  reorderLayer,
  resizeDoc,
  sampleDocColor,
  scaleDoc,
} from './doc';
import { applyModifiers } from './modifiers';
import { hexToRgba, makeRamp, makeTriadRamp, rgbaToHex, sampleReferencePixel } from './palette';
import {
  StrokeTracker,
  bresenham,
  brushOffsets,
  floodFill,
  moveCelPixels,
  pixelCurve,
  pixelEllipse,
  pixelLine,
  pixelRect,
  setPixel,
  snapLineAngle,
  stampBrush,
} from './raster';
import { rectMask } from './selection';
import type { ColorMod, OutlineMod } from './types';

describe('raster', () => {
  it('bresenham hits both endpoints', () => {
    const p = bresenham({ x: 0, y: 0 }, { x: 5, y: 2 });
    expect(p[0]).toEqual({ x: 0, y: 0 });
    expect(p.at(-1)).toEqual({ x: 5, y: 2 });
  });

  it('pixel-perfect line has no L corners (golden coordinates)', () => {
    const p = pixelLine({ x: 0, y: 0 }, { x: 6, y: 6 });
    expect(p).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 },
      { x: 4, y: 4 }, { x: 5, y: 5 }, { x: 6, y: 6 },
    ]);
  });

  it('StrokeTracker strips L-corners even during 1px-by-1px drags', () => {
    const tr = new StrokeTracker({ x: 0, y: 0 }, true);
    const s1 = tr.step({ x: 1, y: 0 });
    expect(s1).toEqual({ add: [{ x: 1, y: 0 }], remove: [] });
    const s2 = tr.step({ x: 1, y: 1 });
    expect(s2).toEqual({ add: [{ x: 1, y: 1 }], remove: [{ x: 1, y: 0 }] });
  });

  it('snapLineAngle snaps to 15-degree steps', () => {
    const s45 = snapLineAngle({ x: 0, y: 0 }, { x: 10, y: 9 });
    expect(s45.x).toBe(s45.y);
    const s0 = snapLineAngle({ x: 0, y: 0 }, { x: 10, y: 1 });
    expect(s0.y).toBe(0);
  });

  it('brushOffsets builds square and round stamps', () => {
    expect(brushOffsets(1, 'square')).toHaveLength(1);
    expect(brushOffsets(3, 'square')).toHaveLength(9);
    expect(brushOffsets(3, 'round')).toHaveLength(5);
  });

  it('stampBrush respects selection mask and alphaLock', () => {
    const w = 4, h = 4;
    const d = new Uint8ClampedArray(w * h * 4);
    setPixel(d, w, h, 1, 1, [10, 10, 10, 255]);
    const mask = rectMask(w, h, { x: 0, y: 0 }, { x: 1, y: 1 });
    stampBrush(d, w, h, [{ x: 1, y: 1 }, { x: 2, y: 2 }], [255, 0, 0, 255], { mask, alphaLock: true });
    expect(d[(1 * w + 1) * 4]).toBe(255);
    expect(d[(2 * w + 2) * 4 + 3]).toBe(0);
    stampBrush(d, w, h, [{ x: 0, y: 0 }], [255, 0, 0, 255], { mask, alphaLock: true });
    expect(d[3]).toBe(0);
  });

  it('curve starts and ends at anchors, stays connected', () => {
    const p = pixelCurve({ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 20, y: 10 });
    expect(p[0]).toEqual({ x: 0, y: 10 });
    expect(p.at(-1)).toEqual({ x: 20, y: 10 });
    for (let i = 1; i < p.length; i++) {
      expect(Math.max(Math.abs(p[i].x - p[i - 1].x), Math.abs(p[i].y - p[i - 1].y))).toBeLessThanOrEqual(2);
    }
  });

  it('pixelRect outlines and fills with square and center options', () => {
    const outline = pixelRect({ x: 1, y: 1 }, { x: 3, y: 3 }, { filled: false });
    expect(outline).toHaveLength(8);
    const filled = pixelRect({ x: 1, y: 1 }, { x: 3, y: 3 }, { filled: true });
    expect(filled).toHaveLength(9);
    const centered = pixelRect({ x: 5, y: 5 }, { x: 7, y: 6 }, { filled: false, square: true, fromCenter: true });
    expect(centered.some((p) => p.x === 3 && p.y === 3)).toBe(true);
    expect(centered.some((p) => p.x === 7 && p.y === 7)).toBe(true);
  });

  it('pixelEllipse draws symmetric gap-free circle (golden)', () => {
    const pts = pixelEllipse({ x: 0, y: 0 }, { x: 6, y: 6 }, { filled: false });
    const set = new Set(pts.map((p) => `${p.x},${p.y}`));
    // Golden 7x7 circle symmetry & 8-connectivity
    for (const p of pts) {
      expect(set.has(`${6 - p.x},${p.y}`)).toBe(true);
      expect(set.has(`${p.x},${6 - p.y}`)).toBe(true);
      const hasNeighbor = pts.some((q) => q !== p && Math.abs(q.x - p.x) <= 1 && Math.abs(q.y - p.y) <= 1);
      expect(hasNeighbor).toBe(true);
    }
    const filled = pixelEllipse({ x: 0, y: 0 }, { x: 4, y: 4 }, { filled: true });
    expect(filled.some((p) => p.x === 2 && p.y === 2)).toBe(true);
  });

  it('flood fill stops at walls, supports global, tolerance, mask, and alphaLock', () => {
    const w = 4, h = 4, d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) setPixel(d, w, h, 2, y, [1, 1, 1, 255]);
    floodFill(d, w, h, 0, 0, [9, 9, 9, 255]);
    expect(d[0]).toBe(9);
    expect(d[(0 * w + 3) * 4]).toBe(0);

    floodFill(d, w, h, 3, 0, [7, 7, 7, 255], { contiguous: false });
    expect(d[(0 * w + 3) * 4]).toBe(7);

    const mask = rectMask(w, h, { x: 0, y: 0 }, { x: 1, y: 1 });
    floodFill(d, w, h, 0, 0, [50, 60, 70, 255], { mask, tolerance: 2, alphaLock: true });
    expect(d[0]).toBe(50);
    expect(d[(3 * w + 0) * 4]).toBe(9);
  });

  it('moveCelPixels shifts whole cel or selection with optional wrap', () => {
    const w = 4, h = 4, d = new Uint8ClampedArray(w * h * 4);
    setPixel(d, w, h, 3, 0, [50, 60, 70, 255]);
    const shifted = moveCelPixels(d, w, h, 1, 0, { wrap: false });
    expect(shifted[3]).toBe(0);
    const wrapped = moveCelPixels(d, w, h, 1, 0, { wrap: true });
    expect(wrapped[0]).toBe(50);
    const mask = rectMask(w, h, { x: 3, y: 0 }, { x: 3, y: 0 });
    const maskedMove = moveCelPixels(d, w, h, -1, 0, { mask, wrap: false });
    expect(maskedMove[(0 * w + 2) * 4]).toBe(50);
    expect(maskedMove[(0 * w + 3) * 4 + 3]).toBe(0);
  });
});

describe('modifiers', () => {
  const px = () => {
    const d = new Uint8ClampedArray(3 * 3 * 4);
    setPixel(d, 3, 3, 1, 1, [200, 50, 50, 255]);
    return d;
  };

  it('is non-destructive', () => {
    const src = px();
    const copy = src.slice();
    const m = newModifier('color') as ColorMod;
    m.hue = 120;
    applyModifiers(src, 3, 3, [m]);
    expect(src).toEqual(copy);
  });

  it('hue shift recolors, keeps alpha', () => {
    const m = newModifier('color') as ColorMod;
    m.hue = 120;
    const out = applyModifiers(px(), 3, 3, [m]);
    const i = (1 * 3 + 1) * 4;
    expect(out[i + 1]).toBeGreaterThan(out[i]);
    expect(out[i + 3]).toBe(255);
  });

  it('outer and inner outline fill 4 neighbors only (golden)', () => {
    const m = newModifier('outline') as OutlineMod;
    const out = applyModifiers(px(), 3, 3, [m]);
    const filled = [...Array(9).keys()].filter((i) => out[i * 4 + 3] > 0);
    expect(filled).toEqual([1, 3, 4, 5, 7]);

    const inner = newModifier('outline') as OutlineMod;
    inner.mode = 'inner';
    inner.color = [0, 255, 0, 255];
    const inOut = applyModifiers(px(), 3, 3, [inner]);
    expect(inOut[(1 * 3 + 1) * 4 + 1]).toBe(255);
  });

  it('disabled modifier is skipped', () => {
    const m = newModifier('color') as ColorMod;
    m.hue = 90;
    m.enabled = false;
    const src = px();
    expect(applyModifiers(src, 3, 3, [m])).toBe(src);
  });
});

describe('palette', () => {
  it('hex round-trips', () => {
    expect(rgbaToHex(hexToRgba('#3fa66b'))).toBe('#3fa66b');
  });

  it('ramp runs dark to light and shifts hue; triad ramp interpolates dark/base/light', () => {
    const r = makeRamp(hexToRgba('#3fa66b'), { steps: 5, hueShift: 12, satShift: 6, lightStep: 14 });
    expect(r).toHaveLength(5);
    expect(r[0][1] + r[0][0]).not.toBe(r[4][1] + r[4][0]);
    const lum = (c: number[]) => c[0] + c[1] + c[2];
    expect(lum(r[0])).toBeLessThan(lum(r[4]));

    const triad = makeTriadRamp(hexToRgba('#1d4d4f'), hexToRgba('#3fa66b'), hexToRgba('#c6f432'), 5, 100);
    expect(triad).toHaveLength(5);
    expect(lum(triad[0])).toBeLessThan(lum(triad[4]));
  });

  it('reference layer is excluded from compose/export but sampled by F-GRAB', () => {
    const doc = createDoc(4, 4);
    const refPx = new Uint8ClampedArray(2 * 2 * 4);
    setPixel(refPx, 2, 2, 0, 0, [10, 20, 30, 255]);
    setPixel(refPx, 2, 2, 1, 0, [40, 50, 60, 255]);
    const refLayer = createReferenceLayer(doc, 'Ref', {
      dataUrl: 'data:image/png;base64,',
      w: 2, h: 2, x: 0, y: 0, scale: 1, smooth: false, flipX: false, flipY: false, pixels: refPx,
    });
    doc.layers.push(refLayer);

    // Excluded from compose (so never exported)
    const comp = compose(doc, 0);
    expect(comp[3]).toBe(0);

    // Sampled by F-GRAB in both composed and layer modes
    expect(sampleReferencePixel(refLayer.ref!, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(sampleDocColor(doc, 0, comp, refLayer, 1, 0, 'composed')).toEqual([40, 50, 60, 255]);
    expect(sampleDocColor(doc, 0, comp, refLayer, 0, 0, 'layer')).toEqual([10, 20, 30, 255]);
  });
});

describe('doc', () => {
  it('uses UUIDs, validates bounds, composes layers + modifiers', () => {
    expect(() => createDoc(0, 64)).toThrow();
    expect(() => createDoc(2000, 64)).toThrow();
    const doc = createDoc(2, 1);
    expect(doc.layers[0].id).toMatch(/^[0-9a-f-]{36}$/);
    setPixel(doc.layers[0].cels[0], 2, 1, 0, 0, [255, 0, 0, 255]);
    const m = newModifier('color') as ColorMod;
    m.opacity = 50;
    doc.modifiers.push(m);
    expect(compose(doc, 0)[3]).toBe(128);
  });

  it('supports layer duplicate, reorder, mergeDown, flattenVisible, and min-1 delete', () => {
    const doc = createDoc(4, 4);
    expect(removeLayer(doc, doc.layers[0].id)).toBe(false);
    setPixel(doc.layers[0].cels[0], 4, 4, 0, 0, [255, 0, 0, 255]);
    const dup = duplicateLayer(doc, doc.layers[0].id);
    expect(dup).not.toBeNull();
    expect(doc.layers).toHaveLength(2);
    const mod = newModifier('outline') as OutlineMod;
    mod.color = [0, 255, 0, 255];
    dup!.modifiers.push(mod);

    expect(reorderLayer(doc, 1, 0)).toBe(true);
    expect(doc.layers[0].modifiers).toHaveLength(1);

    const merged = mergeDown(doc, 1);
    expect(merged).not.toBeNull();
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].modifiers).toHaveLength(0);
    // Outline baked at (1,0)
    expect(doc.layers[0].cels[0][1 * 4 + 1]).toBe(255);

    const hidden = addLayer(doc, 'Hidden');
    hidden.visible = false;
    addLayer(doc, 'Top');
    const flat = flattenVisible(doc);
    expect(flat).not.toBeNull();
    expect(doc.layers).toHaveLength(2);
    expect(doc.layers.some((l) => l.id === hidden.id)).toBe(true);
  });

  it('supports frame add/remove, resizeDoc, scaleDoc, and composeRect', () => {
    const doc = createDoc(4, 4);
    setPixel(doc.layers[0].cels[0], 4, 4, 0, 0, [100, 150, 200, 255]);
    addFrame(doc, 0, true);
    expect(doc.frames).toHaveLength(2);
    expect(removeFrame(doc, 1)).toBe(0);
    expect(doc.frames).toHaveLength(1);

    resizeDoc(doc, 6, 6, 'br');
    expect(doc.w).toBe(6);
    expect(doc.layers[0].cels[0][(2 * 6 + 2) * 4]).toBe(100);

    scaleDoc(doc, 12, 12);
    expect(doc.w).toBe(12);
    expect(doc.layers[0].cels[0][(4 * 12 + 4) * 4]).toBe(100);

    const target = compose(doc, 0);
    setPixel(doc.layers[0].cels[0], 12, 12, 0, 0, [9, 8, 7, 255]);
    composeRect(doc, 0, target, { x: 0, y: 0, w: 2, h: 2 });
    expect(target[0]).toBe(9);
  });
});
