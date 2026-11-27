import { describe, expect, it } from 'vitest';
import { findOrphans, removeOrphans } from './cleanup';
import { setPixel } from './raster';

describe('F-ORPHAN cleanup', () => {
  it('finds lone pixel, ignores transparent pixels', () => {
    const w = 5, h = 5;
    const data = new Uint8ClampedArray(w * h * 4);
    setPixel(data, w, h, 2, 2, [255, 0, 0, 255]);
    expect(findOrphans(data, w, h, { connectivity: 4, minClusterSize: 1 })).toEqual([{ x: 2, y: 2 }]);
  });

  it('respects minClusterSize 1 vs 2', () => {
    const w = 5, h = 5;
    const data = new Uint8ClampedArray(w * h * 4);
    setPixel(data, w, h, 1, 1, [200, 100, 50, 255]);
    setPixel(data, w, h, 2, 1, [200, 100, 50, 255]);
    expect(findOrphans(data, w, h, { connectivity: 4, minClusterSize: 1 })).toHaveLength(0);
    expect(findOrphans(data, w, h, { connectivity: 4, minClusterSize: 2 })).toHaveLength(2);
  });

  it('treats diagonal-only neighbor as orphan in 4-conn, not in 8-conn', () => {
    const w = 4, h = 4;
    const data = new Uint8ClampedArray(w * h * 4);
    setPixel(data, w, h, 1, 1, [10, 200, 50, 255]);
    setPixel(data, w, h, 2, 2, [10, 200, 50, 255]);
    expect(findOrphans(data, w, h, { connectivity: 4, minClusterSize: 1 })).toHaveLength(2);
    expect(findOrphans(data, w, h, { connectivity: 8, minClusterSize: 1 })).toHaveLength(0);
  });

  it('merge picks most frequent neighbor and breaks ties by lowest luminance difference', () => {
    const w = 5, h = 5;
    const data = new Uint8ClampedArray(w * h * 4);
    // Surround (2,2) with 3 blue pixels and 1 green pixel -> must pick blue
    const blue: [number, number, number, number] = [20, 40, 220, 255];
    const green: [number, number, number, number] = [20, 200, 40, 255];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) setPixel(data, w, h, x, y, blue);
    setPixel(data, w, h, 2, 1, green);
    setPixel(data, w, h, 2, 0, green);
    setPixel(data, w, h, 2, 2, [255, 0, 0, 255]);

    const res = removeOrphans(data, w, h, { connectivity: 4, minClusterSize: 1, action: 'merge' });
    expect(res.count).toBe(1);
    const i = (2 * w + 2) * 4;
    expect([res.data[i], res.data[i + 1], res.data[i + 2], res.data[i + 3]]).toEqual(blue);

    // Tie-break test: 2 dark neighbors, 2 bright neighbors around a bright-ish orphan -> picks bright
    const tie = new Uint8ClampedArray(w * h * 4);
    const dark: [number, number, number, number] = [10, 10, 10, 255];
    const bright: [number, number, number, number] = [230, 230, 230, 255];
    // Left + top = dark (clusters >= 2); right + bottom = bright (clusters >= 2)
    setPixel(tie, w, h, 0, 2, dark); setPixel(tie, w, h, 1, 2, dark);
    setPixel(tie, w, h, 2, 0, dark); setPixel(tie, w, h, 2, 1, dark);
    setPixel(tie, w, h, 3, 2, bright); setPixel(tie, w, h, 4, 2, bright);
    setPixel(tie, w, h, 2, 3, bright); setPixel(tie, w, h, 2, 4, bright);
    setPixel(tie, w, h, 2, 2, [200, 200, 200, 255]);
    const tieRes = removeOrphans(tie, w, h, { connectivity: 4, minClusterSize: 1, action: 'merge' });
    expect([tieRes.data[i], tieRes.data[i + 1], tieRes.data[i + 2]]).toEqual([230, 230, 230]);
  });

  it('is idempotent (running twice changes nothing more) for both merge and delete', () => {
    const w = 6, h = 6;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 1; y < 5; y++) for (let x = 1; x < 5; x++) setPixel(data, w, h, x, y, [50, 120, 80, 255]);
    setPixel(data, w, h, 2, 2, [255, 0, 0, 255]);
    setPixel(data, w, h, 0, 0, [0, 255, 255, 255]);

    for (const action of ['merge', 'delete'] as const) {
      const r1 = removeOrphans(data, w, h, { connectivity: 4, minClusterSize: 1, action });
      expect(r1.count).toBe(2);
      const r2 = removeOrphans(r1.data, w, h, { connectivity: 4, minClusterSize: 1, action });
      expect(r2.count).toBe(0);
      expect(r2.data).toEqual(r1.data);
    }
  });
});
