import { describe, expect, it } from 'vitest';
import { applyDiff, computeDiff, diffByteSize } from './diff';
import { setPixel } from './raster';

describe('sparse pixel diff', () => {
  it('returns null when buffers are identical', () => {
    const a = new Uint8ClampedArray(8 * 8 * 4);
    expect(computeDiff(a, a.slice(), 8, 8)).toBeNull();
  });

  it('captures minimal bounding rect and round-trips before/after', () => {
    const w = 16, h = 16;
    const before = new Uint8ClampedArray(w * h * 4);
    setPixel(before, w, h, 3, 4, [10, 20, 30, 255]);
    const after = before.slice();
    setPixel(after, w, h, 3, 4, [200, 10, 10, 255]);
    setPixel(after, w, h, 5, 6, [5, 5, 5, 255]);

    const diff = computeDiff(before, after, w, h);
    expect(diff).not.toBeNull();
    expect({ x: diff!.x, y: diff!.y, w: diff!.w, h: diff!.h }).toEqual({ x: 3, y: 4, w: 3, h: 3 });
    expect(diffByteSize(diff!)).toBe(3 * 3 * 4 * 2);

    const work = before.slice();
    applyDiff(work, w, diff!, 'after');
    expect(work).toEqual(after);
    applyDiff(work, w, diff!, 'before');
    expect(work).toEqual(before);
  });
});
