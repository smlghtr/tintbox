import { describe, expect, it } from 'vitest';
import { ditherMatches, stampDitherBrush } from './dither';
import { addFrame, compose, createDoc, createLayer, fitImageToCanvas, setLayerCelCount } from './doc';
import { flipCelPixels, rotateCelPixels90, setPixel } from './raster';
import { rasterizeShapePreset, rasterizeVectorPath } from './shapes';

describe('P6 F-DITHER brush', () => {
  it('checker pattern stamps exact (x + y) % 2 === 0 parity and dual mode fills alternate pixels', () => {
    const w = 8;
    const h = 8;
    const cel = new Uint8ClampedArray(w * h * 4);
    const pts = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) pts.push({ x, y });
    }
    stampDitherBrush(cel, w, h, pts, [198, 244, 50, 255], {
      size: 1,
      pattern: 'checker',
      dual: false,
    });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = cel[(y * w + x) * 4 + 3];
        expect(a).toBe((x + y) % 2 === 0 ? 255 : 0);
      }
    }

    // Dual mode fills false parity with secondary color
    stampDitherBrush(cel, w, h, pts, [255, 0, 0, 255], {
      size: 1,
      pattern: 'checker',
      dual: true,
      secondary: [0, 0, 255, 255],
    });
    expect(cel[0]).toBe(255); // (0,0) primary
    expect(cel[4 + 2]).toBe(255); // (1,0) secondary
  });

  it('supports bayer2, bayer4, diag, and scanline patterns with edge wrap', () => {
    expect(ditherMatches(0, 0, 'scanline')).toBe(true);
    expect(ditherMatches(0, 1, 'scanline')).toBe(false);
    expect(ditherMatches(0, 0, 'bayer2', 50)).toBe(true);
    expect(ditherMatches(0, 0, 'bayer4', 50)).toBe(true);
    expect(ditherMatches(0, 0, 'diag', 25)).toBe(true);

    const cel = new Uint8ClampedArray(8 * 8 * 4);
    stampDitherBrush(cel, 8, 8, [{ x: 0, y: 0 }], [255, 255, 255, 255], {
      size: 3,
      pattern: 'checker',
      wrapX: true,
      wrapY: true,
    });
    // Wrapped corner (7,7) has (7+7)%2 === 0 -> stamped
    expect(cel[(7 * 8 + 7) * 4 + 3]).toBe(255);
  });
});

describe('P6 F-VECTOR & F-SHAPES presets', () => {
  it('rasterizes editable vector paths (polyline, smooth, closed, width > 1) crisply', () => {
    const open = rasterizeVectorPath(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      { closed: false, smooth: false, width: 1 },
    );
    expect(open.length).toBeGreaterThanOrEqual(21);

    const smoothClosed = rasterizeVectorPath(
      [{ x: 4, y: 4 }, { x: 20, y: 4 }, { x: 20, y: 20 }, { x: 4, y: 20 }],
      { closed: true, smooth: true, width: 2 },
    );
    expect(smoothClosed.length).toBeGreaterThan(open.length);
  });

  it('rasterizes square, oval, star, cube, and exact 2:1 isometric presets', () => {
    const a = { x: 2, y: 2 };
    const b = { x: 22, y: 22 };
    expect(rasterizeShapePreset(a, b, { preset: 'square', filled: false }).length).toBeGreaterThan(20);
    expect(rasterizeShapePreset(a, b, { preset: 'oval', filled: true }).length).toBeGreaterThan(100);
    expect(rasterizeShapePreset(a, b, { preset: 'star', filled: false, starPoints: 5 }).length).toBeGreaterThan(30);
    expect(rasterizeShapePreset(a, b, { preset: 'star', filled: true, starPoints: 6 }).length).toBeGreaterThan(80);
    expect(rasterizeShapePreset(a, b, { preset: 'cube', filled: false }).length).toBeGreaterThan(40);
    expect(rasterizeShapePreset(a, b, { preset: 'cube', filled: true }).length).toBeGreaterThan(150);

    // Isometric diamond has strict 2:1 horizontal steps per row
    const iso = rasterizeShapePreset({ x: 0, y: 0 }, { x: 15, y: 7 }, { preset: 'isometric', filled: false });
    expect(iso.length).toBeGreaterThan(12);
    const byY = new Map<number, number[]>();
    for (const p of iso) {
      const row = byY.get(p.y) ?? [];
      row.push(p.x);
      byY.set(p.y, row);
    }
    for (const xs of byY.values()) {
      // Every row of a 2:1 outline diamond has 4 pixels (2 left, 2 right)
      expect(xs.length).toBe(4);
    }
  });
});

describe('P6 F-LAYERFRAMES per-layer frame counts', () => {
  it('loops a 2-cel layer seamlessly across a 6-frame document in compose()', () => {
    const doc = createDoc(4, 4);
    for (let i = 0; i < 5; i++) addFrame(doc, i, false);
    expect(doc.frames).toHaveLength(6);

    const glow = createLayer(doc, 'Glow');
    setLayerCelCount(doc, glow, 2);
    expect(glow.cels).toHaveLength(2);
    setPixel(glow.cels[0], 4, 4, 0, 0, [255, 0, 0, 255]); // red on even frames
    setPixel(glow.cels[1], 4, 4, 0, 0, [0, 255, 0, 255]); // green on odd frames
    doc.layers.push(glow);

    for (let f = 0; f < 6; f++) {
      const composed = compose(doc, f);
      if (f % 2 === 0) {
        expect(Array.from(composed.subarray(0, 4))).toEqual([255, 0, 0, 255]);
      } else {
        expect(Array.from(composed.subarray(0, 4))).toEqual([0, 255, 0, 255]);
      }
    }
  });

  it('supports Photoshop-style clipping masks, darken/lighten/difference blends, flip/rotate, and image-to-layer fit', () => {
    const doc = createDoc(4, 4);
    // Base pixel at (1,1)
    setPixel(doc.layers[0].cels[0], 4, 4, 1, 1, [100, 100, 100, 255]);

    const shade = createLayer(doc, 'Shade');
    shade.clipped = true;
    shade.blend = 'difference';
    // Paint whole row y=1 -> only (1,1) should appear because clipped to Layer 1!
    for (let x = 0; x < 4; x++) setPixel(shade.cels[0], 4, 4, x, 1, [200, 50, 100, 255]);
    doc.layers.push(shade);

    const comp = compose(doc, 0);
    // (0,1) outside base silhouette -> stays transparent
    expect(comp[(1 * 4 + 0) * 4 + 3]).toBe(0);
    // (1,1) inside base silhouette -> difference(|100-200|, |100-50|, |100-100|) = [100, 50, 0, 255]
    expect(Array.from(comp.subarray((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4))).toEqual([100, 50, 0, 255]);

    // Flip & Rotate 90 CW
    const buf = new Uint8ClampedArray(4 * 4 * 4);
    setPixel(buf, 4, 4, 0, 0, [255, 0, 0, 255]);
    const flippedH = flipCelPixels(buf, 4, 4, 'h');
    expect(flippedH[(0 * 4 + 3) * 4]).toBe(255);
    const rotCw = rotateCelPixels90(buf, 4, 4, 'cw');
    expect(rotCw[(0 * 4 + 3) * 4]).toBe(255);

    // fitImageToCanvas centers and downscales cleanly
    const img = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < img.length; i += 4) img.set([10, 20, 30, 255], i);
    const fitted = fitImageToCanvas(img, 8, 8, 4, 4);
    expect(Array.from(fitted.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });
});
