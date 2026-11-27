import { describe, expect, it } from 'vitest';
import { findOrphans, removeOrphans } from './cleanup';
import { computeDiff } from './diff';
import { addLayer, cloneDoc, compose, createDoc, newModifier } from './doc';
import { extractPalette } from './quantize';
import { StrokeTracker, floodFill, setPixel, stampBrush } from './raster';
import type { ColorMod, OutlineMod } from './types';
import { centerViewport, screenToDoc, zoomAtScreenPoint } from './viewport';
import { pixelPatchCommand } from '../state/commands';
import { History, type CommandContext } from '../state/history';

describe('performance budgets (ARCHITECTURE.md)', () => {
  it('64x64 stroke per pointer event < 4 ms', () => {
    const doc = createDoc(64, 64);
    const cel = doc.layers[0].cels[0];
    const tracker = new StrokeTracker({ x: 0, y: 0 }, true);
    const t0 = performance.now();
    const steps = 60;
    for (let i = 1; i <= steps; i++) {
      const { add } = tracker.step({ x: i, y: i });
      stampBrush(cel, 64, 64, add, [198, 244, 50, 255], { size: 3, shape: 'round' });
    }
    const perEventMs = (performance.now() - t0) / steps;
    expect(perEventMs).toBeLessThan(4);
  });

  it('256x256 compose with 8 layers + 3 modifiers < 12 ms', () => {
    const doc = createDoc(256, 256);
    for (let l = 1; l < 8; l++) addLayer(doc, `L${l + 1}`);
    for (let l = 0; l < 8; l++) {
      const cel = doc.layers[l].cels[0];
      for (let i = 0; i < 400; i++) {
        setPixel(cel, 256, 256, (i * 13 + l * 7) % 256, (i * 17 + l * 11) % 256, [200, 100, 50, 255]);
      }
    }
    const m1 = newModifier('color') as ColorMod;
    m1.hue = 30;
    const m2 = newModifier('color') as ColorMod;
    m2.sat = 20;
    const m3 = newModifier('outline') as OutlineMod;
    doc.layers[0].modifiers.push(m1);
    doc.layers[1].modifiers.push(m2);
    doc.layers[2].modifiers.push(m3);

    // Warmup JIT
    compose(doc, 0);
    const samples: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      compose(doc, 0);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[Math.floor(samples.length / 2)];
    expect(medianMs).toBeLessThan(12);
  });

  it('1024x1024 flood fill < 100 ms', () => {
    // Warmup JIT
    floodFill(new Uint8ClampedArray(16 * 16 * 4), 16, 16, 8, 8, [1, 2, 3, 255]);
    const data = new Uint8ClampedArray(1024 * 1024 * 4);
    const t0 = performance.now();
    floodFill(data, 1024, 1024, 512, 512, [198, 244, 50, 255]);
    const elapsed = performance.now() - t0;
    expect(data[0]).toBe(198);
    expect(elapsed).toBeLessThan(100);
  });

  it('P2: palette extract 1024px image, 16 colors < 300 ms', () => {
    const w = 1024, h = 1024;
    const img = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        img[i] = x & 255;
        img[i + 1] = y & 255;
        img[i + 2] = ((x + y) >> 1) & 255;
        img[i + 3] = 255;
      }
    }
    // Warmup
    extractPalette(img.subarray(0, 16 * 16 * 4), 16, 16, { count: 8, method: 'median-cut' });
    const t0 = performance.now();
    const res = extractPalette(img, w, h, { count: 16, method: 'median-cut' });
    const elapsed = performance.now() - t0;
    expect(res.colors).toHaveLength(16);
    expect(elapsed).toBeLessThan(300);
  });

  it('P2: orphan scan 512x512 < 50 ms', () => {
    const w = 512, h = 512;
    const img = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        img[i] = 40;
        img[i + 1] = 120;
        img[i + 2] = 80;
        img[i + 3] = 255;
      }
    }
    // Scatter 200 lone orphan pixels
    for (let k = 0; k < 200; k++) {
      setPixel(img, w, h, (k * 37) % w, (k * 53) % h, [255, 50, 50, 255]);
    }
    findOrphans(new Uint8ClampedArray(16 * 16 * 4), 16, 16);
    const t0 = performance.now();
    const orphans = findOrphans(img, w, h, { connectivity: 4, minClusterSize: 1 });
    const elapsed = performance.now() - t0;
    expect(orphans.length).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(50);
    const cleaned = removeOrphans(img, w, h, { connectivity: 4, minClusterSize: 1, action: 'merge' });
    expect(cleaned.count).toBe(orphans.length);
  });

  it('P1 manual script: draw 50 strokes, corner zoom, undo 50x, redo 50x -> byte identical', () => {
    const doc = createDoc(64, 64);
    const hist = new History();
    let activeLayerId = doc.layers[0].id;
    let activeFrame = 0;
    const ctx: CommandContext = {
      doc,
      getSelection: () => null,
      setSelection: () => {},
      getActiveLayerId: () => activeLayerId,
      setActiveLayerId: (id) => { activeLayerId = id; },
      getActiveFrame: () => activeFrame,
      setActiveFrame: (f) => { activeFrame = f; },
      markDirty: () => {},
    };

    const initialBytes = doc.layers[0].cels[0].slice();

    for (let i = 0; i < 50; i++) {
      const before = doc.layers[0].cels[0].slice();
      const after = before.slice();
      setPixel(after, 64, 64, i % 64, Math.floor(i / 2), [i * 4, 200, 50, 255]);
      const diff = computeDiff(before, after, 64, 64)!;
      hist.execute(pixelPatchCommand(activeLayerId, 0, diff, `Stroke ${i}`), ctx);
    }
    const after50 = cloneDoc(doc).layers[0].cels[0];

    // Zoom at bottom-right corner
    const vp0 = centerViewport(900, 600, 64, 64, 3);
    const sx = vp0.panX + 63 * vp0.zoom + 1;
    const sy = vp0.panY + 63 * vp0.zoom + 1;
    const vp1 = zoomAtScreenPoint(vp0, 12, sx, sy, 900, 600, 64, 64);
    expect(screenToDoc(vp1, sx, sy)).toEqual({ x: 63, y: 63 });

    for (let i = 0; i < 50; i++) expect(hist.undo(ctx)).not.toBeNull();
    expect(doc.layers[0].cels[0]).toEqual(initialBytes);

    for (let i = 0; i < 50; i++) expect(hist.redo(ctx)).not.toBeNull();
    expect(doc.layers[0].cels[0]).toEqual(after50);
  });
});
