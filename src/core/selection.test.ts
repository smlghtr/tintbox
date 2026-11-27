import { describe, expect, it } from 'vitest';
import { setPixel } from './raster';
import {
  clearSelection,
  combineMasks,
  countSelected,
  createMask,
  extractSelection,
  getMaskBit,
  invertMask,
  isEmptyMask,
  lassoMask,
  magicWandMask,
  maskBounds,
  maskEdges,
  rectMask,
  selectAll,
  setMaskBit,
  stampBuffer,
} from './selection';

describe('selection mask (1-bit per pixel)', () => {
  it('uses 1 bit per pixel and gets/sets cleanly', () => {
    const m = createMask(10, 10);
    expect(m.bits.byteLength).toBe(Math.ceil(100 / 8));
    expect(isEmptyMask(m)).toBe(true);
    setMaskBit(m, 3, 4, true);
    expect(getMaskBit(m, 3, 4)).toBe(true);
    expect(getMaskBit(m, 4, 4)).toBe(false);
    expect(countSelected(m)).toBe(1);
    setMaskBit(m, 3, 4, false);
    expect(isEmptyMask(m)).toBe(true);
  });

  it('supports rect, all, invert, and boolean modes', () => {
    const a = rectMask(8, 8, { x: 1, y: 1 }, { x: 3, y: 3 });
    expect(countSelected(a)).toBe(9);
    expect(maskBounds(a)).toEqual({ x: 1, y: 1, w: 3, h: 3 });

    const b = rectMask(8, 8, { x: 3, y: 3 }, { x: 5, y: 5 });
    expect(countSelected(combineMasks(a, b, 'add'))).toBe(17);
    expect(countSelected(combineMasks(a, b, 'subtract'))).toBe(8);
    expect(countSelected(combineMasks(a, b, 'intersect'))).toBe(1);
    expect(countSelected(combineMasks(a, b, 'replace'))).toBe(9);

    const all = selectAll(4, 4);
    expect(countSelected(all)).toBe(16);
    expect(countSelected(invertMask(all))).toBe(0);
  });

  it('lasso fills polygon interior', () => {
    const m = lassoMask(10, 10, [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }, { x: 2, y: 6 }]);
    expect(getMaskBit(m, 4, 4)).toBe(true);
    expect(getMaskBit(m, 0, 0)).toBe(false);
  });

  it('magic wand selects contiguous or global matching RGBA', () => {
    const w = 6, h = 4;
    const data = new Uint8ClampedArray(w * h * 4);
    setPixel(data, w, h, 0, 0, [255, 0, 0, 255]);
    setPixel(data, w, h, 1, 0, [255, 0, 0, 255]);
    setPixel(data, w, h, 4, 2, [255, 0, 0, 255]);

    const c = magicWandMask(data, w, h, 0, 0, { contiguous: true });
    expect(countSelected(c)).toBe(2);
    const g = magicWandMask(data, w, h, 0, 0, { contiguous: false });
    expect(countSelected(g)).toBe(3);
  });

  it('computes 4 contour edges for a single selected pixel', () => {
    const m = createMask(4, 4);
    setMaskBit(m, 1, 1, true);
    expect(maskEdges(m)).toHaveLength(4);
  });

  it('extracts, clears, and stamps selection buffer', () => {
    const w = 6, h = 6;
    const cel = new Uint8ClampedArray(w * h * 4);
    setPixel(cel, w, h, 1, 1, [100, 200, 50, 255]);
    setPixel(cel, w, h, 2, 1, [50, 60, 70, 255]);
    const m = rectMask(w, h, { x: 1, y: 1 }, { x: 2, y: 1 });
    const ext = extractSelection(cel, w, h, m);
    expect(ext).not.toBeNull();
    clearSelection(cel, w, h, m);
    expect(cel[(1 * w + 1) * 4 + 3]).toBe(0);
    stampBuffer(cel, w, h, ext!.pixels, ext!.rect, 3, 4, { maskBits: ext!.maskBits });
    expect(cel[(4 * w + 3) * 4]).toBe(100);
    expect(cel[(4 * w + 4) * 4]).toBe(50);
  });
});
