import { describe, expect, it } from 'vitest';
import { compositeLayer, compositeLayerRect } from './blend';
import { setPixel } from './raster';

describe('blend', () => {
  it('normal blend at 50% opacity halves alpha over transparent', () => {
    const dst = new Uint8ClampedArray(4);
    const src = new Uint8ClampedArray([200, 100, 50, 255]);
    compositeLayer(dst, src, 1, 1, 50, 'normal');
    expect(dst[0]).toBe(200);
    expect(dst[1]).toBe(100);
    expect(dst[2]).toBe(50);
    expect(dst[3]).toBe(128);
  });

  it('multiply darkens opaque pixels', () => {
    const dst = new Uint8ClampedArray([200, 100, 50, 255]);
    const src = new Uint8ClampedArray([128, 255, 0, 255]);
    compositeLayer(dst, src, 1, 1, 100, 'multiply');
    expect(dst[0]).toBeCloseTo(100, -1);
    expect(dst[1]).toBe(100);
    expect(dst[2]).toBe(0);
    expect(dst[3]).toBe(255);
  });

  it('screen lightens opaque pixels', () => {
    const dst = new Uint8ClampedArray([100, 0, 255, 255]);
    const src = new Uint8ClampedArray([100, 128, 128, 255]);
    compositeLayer(dst, src, 1, 1, 100, 'screen');
    expect(dst[0]).toBeGreaterThan(100);
    expect(dst[1]).toBe(128);
    expect(dst[2]).toBe(255);
  });

  it('overlay combines multiply (dark dst) and screen (light dst)', () => {
    const dst = new Uint8ClampedArray([64, 200, 128, 255]);
    const src = new Uint8ClampedArray([128, 128, 128, 255]);
    compositeLayer(dst, src, 1, 1, 100, 'overlay');
    expect(dst[0]).toBeLessThanOrEqual(66);
    expect(dst[1]).toBeGreaterThanOrEqual(198);
  });

  it('add clamps at 255', () => {
    const dst = new Uint8ClampedArray([200, 100, 50, 255]);
    const src = new Uint8ClampedArray([100, 50, 50, 255]);
    compositeLayer(dst, src, 1, 1, 100, 'add');
    expect([...dst]).toEqual([255, 150, 100, 255]);
  });

  it('normal blend blends semi-transparent source over opaque destination', () => {
    const dst = new Uint8ClampedArray([100, 100, 100, 255]);
    const src = new Uint8ClampedArray([200, 0, 50, 128]);
    compositeLayer(dst, src, 1, 1, 100, 'normal');
    expect(dst[0]).toBeGreaterThan(140);
    expect(dst[1]).toBeLessThan(60);
    expect(dst[3]).toBe(255);
  });

  it('compositeLayerRect only touches target rect', () => {
    const dst = new Uint8ClampedArray(4 * 4 * 4);
    const src = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(src, 4, 4, x, y, [10, 20, 30, 255]);
    compositeLayerRect(dst, src, 4, 4, { x: 1, y: 1, w: 2, h: 2 }, 100, 'normal');
    expect(dst[0]).toBe(0);
    expect(dst[(1 * 4 + 1) * 4]).toBe(10);
    expect(dst[(2 * 4 + 2) * 4]).toBe(10);
    expect(dst[(3 * 4 + 3) * 4]).toBe(0);
  });
});
