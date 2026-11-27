import { describe, expect, it } from 'vitest';
import { renderDitherGradient, renderMaskGradient } from './dither';
import { compose, createDoc, newModifier, scaleDoc } from './doc';
import { applySingleModifier } from './modifiers';
import { setPixel, stampBrush, stampMaskBrush } from './raster';
import { resampleRgba, upscaleEpx2x, upscaleHq2x, upscaleScale3x, type ResampleAlgorithm } from './scale';
import { countSelected, layerAlphaMask } from './selection';
import { autoSmoothBezierAnchors, rasterizeBezierPath, rasterizeCubicBezier } from './shapes';
import type { BezierAnchor, DitherMod, LightingMod, OutlineMod, ToneMod } from './types';
import { clampPan } from './viewport';
import { defaultWarpParams, warpCelPixels, type WarpPreset } from './warp';

describe('Pro Upscaler & Resampling algorithms', () => {
  it('supports EPX2x, Scale3x, HQ2x, EPX4x, Bilinear, Bicubic, Lanczos, and Nearest cleanly', () => {
    const src = new Uint8ClampedArray(4 * 4 * 4);
    // Diagonal pixel step to exercise EPX / Scale3x edge expansion
    for (let i = 0; i < 4; i++) setPixel(src, 4, 4, i, i, [198, 244, 50, 255]);

    const e2 = upscaleEpx2x(src, 4, 4);
    expect(e2.w).toBe(8);
    expect(e2.h).toBe(8);
    const s3 = upscaleScale3x(src, 4, 4);
    expect(s3.w).toBe(12);
    expect(s3.h).toBe(12);
    const hq = upscaleHq2x(src, 4, 4);
    expect(hq.w).toBe(8);
    expect(hq.h).toBe(8);

    const algos: ResampleAlgorithm[] = ['nearest', 'epx2x', 'scale3x', 'hq2x', 'epx4x', 'bilinear', 'bicubic', 'lanczos'];
    for (const algo of algos) {
      const res = resampleRgba(src, 4, 4, 8, 8, algo);
      expect(res.length).toBe(8 * 8 * 4);
      let opaque = 0;
      for (let i = 3; i < res.length; i += 4) if (res[i] > 0) opaque++;
      expect(opaque).toBeGreaterThan(0);
    }

    const doc = createDoc(8, 8);
    setPixel(doc.layers[0].cels[0], 8, 8, 2, 2, [255, 0, 0, 255]);
    scaleDoc(doc, 16, 16, 'epx2x');
    expect(doc.w).toBe(16);
    expect(doc.layers[0].cels[0].length).toBe(16 * 16 * 4);
  });
});

describe('Warp engine (quad, arc, bulge, wave, skew, perspective)', () => {
  it('warps pixels cleanly across all presets with zero blur or NaN', () => {
    const w = 12;
    const h = 12;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let y = 2; y <= 9; y++) {
      for (let x = 2; x <= 9; x++) setPixel(src, w, h, x, y, [100, 200, 50, 255]);
    }
    const presets: WarpPreset[] = ['quad', 'arc', 'bulge', 'wave', 'skew', 'perspective'];
    for (const preset of presets) {
      const p = defaultWarpParams();
      p.preset = preset;
      p.strength = 45;
      if (preset === 'quad') {
        p.corners = [
          { x: 0.15, y: 0.1 },
          { x: 0.9, y: 0.05 },
          { x: 0.95, y: 0.95 },
          { x: 0.05, y: 0.9 },
        ];
      }
      const out = warpCelPixels(src, w, h, p);
      let count = 0;
      for (let i = 3; i < out.length; i += 4) if (out[i] === 255) count++;
      expect(count).toBeGreaterThan(10);
    }
  });
});

describe('Cubic Bezier Pen tool & curvature control', () => {
  it('rasterizes cubic Bezier segments, auto-smooth tension, and filled closed paths', () => {
    const seg = rasterizeCubicBezier({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 });
    expect(seg.length).toBeGreaterThan(20);
    expect(seg[0]).toEqual({ x: 0, y: 0 });
    expect(seg[seg.length - 1]).toEqual({ x: 20, y: 10 });

    const anchors: BezierAnchor[] = [{ x: 2, y: 2 }, { x: 18, y: 2 }, { x: 18, y: 18 }, { x: 2, y: 18 }];
    const smoothed = autoSmoothBezierAnchors(anchors, true, 75);
    expect(smoothed[0].outHandle).toBeDefined();
    expect(smoothed[0].inHandle).toBeDefined();

    const outline = rasterizeBezierPath(smoothed, { closed: true, filled: false, width: 1 });
    const filled = rasterizeBezierPath(smoothed, { closed: true, filled: true, width: 1 });
    expect(filled.length).toBeGreaterThan(outline.length);
  });
});

describe('P7 Effects: Dither, Controllable Lighting, Shadow & Highlight', () => {
  it('applies dither, directional lighting, and tone shadow/highlight non-destructively', () => {
    const doc = createDoc(10, 10);
    const cel = doc.layers[0].cels[0];
    for (let y = 2; y <= 7; y++) {
      for (let x = 2; x <= 7; x++) setPixel(cel, 10, 10, x, y, [130, 130, 130, 255]);
    }
    const orig = cel.slice();

    const dMod = newModifier('dither') as DitherMod;
    const dOut = applySingleModifier(cel, 10, 10, dMod);
    expect(cel).toEqual(orig);
    expect(dOut.length).toBe(cel.length);

    // Directional light from top-left (225deg) vs bottom-right (45deg) must light opposite bevel edges differently!
    const lMod = newModifier('lighting') as LightingMod;
    lMod.angle = 225;
    lMod.intensity = 90;
    const lOutTL = applySingleModifier(cel, 10, 10, lMod);
    lMod.angle = 45;
    const lOutBR = applySingleModifier(cel, 10, 10, lMod);
    // Top-left edge pixel (2,2) should be brighter when lit from top-left than from bottom-right
    expect(lOutTL[(2 * 10 + 2) * 4]).not.toBe(lOutBR[(2 * 10 + 2) * 4]);

    // Tone modifier shifts dark & bright pixels differently
    const tMod = newModifier('tone') as ToneMod;
    tMod.shadows = -40;
    tMod.highlights = 40;
    doc.layers[0].modifiers.push(dMod, lMod, tMod);
    const composed = compose(doc, 0);
    expect(cel).toEqual(orig);
    expect(composed[(5 * 10 + 5) * 4 + 3]).toBe(255);
  });

  it('supports sub-pixel 0.2 brush/outline, dither gradient, layer masks, effect masks, groups, Ctrl+Click alpha mask, and free pasteboard', () => {
    const doc = createDoc(8, 8);
    const cel = doc.layers[0].cels[0];

    // 1. Sub-pixel 0.2 brush lays down delicate ~20% alpha micro-dot
    stampBrush(cel, 8, 8, [{ x: 2, y: 2 }], [255, 0, 0, 255], { size: 0.2 });
    expect(cel[(2 * 8 + 2) * 4 + 3]).toBe(51);

    // 2. Sub-pixel 0.2 outline renders hairline low-alpha border
    const om = newModifier('outline') as OutlineMod;
    om.width = 0.2;
    om.color = [255, 255, 255, 255];
    const outlined = applySingleModifier(cel, 8, 8, om);
    expect(outlined[(2 * 8 + 3) * 4 + 3]).toBe(51);

    // 3. Ctrl+Click layer alpha mask matches only non-transparent pixels
    const sel = layerAlphaMask(cel, 8, 8);
    expect(countSelected(sel)).toBe(1);

    // 4. Dither gradient paints Bayer-dithered blend between A and B
    renderDitherGradient(cel, 8, 8, { x: 0, y: 0 }, { x: 7, y: 0 }, {
      shape: 'linear',
      pattern: 'bayer4',
      from: [200, 200, 200, 255],
      to: [20, 20, 20, 255],
    });
    expect(cel[0]).toBe(200);
    expect(cel[(0 * 8 + 7) * 4]).toBe(20);

    // 5. Layer Mask conceals left half when painted black (0)
    const lMask = new Uint8Array(64).fill(255);
    stampMaskBrush(lMask, 8, 8, [{ x: 0, y: 0 }], 0, { size: 1 });
    doc.layers[0].layerMask = lMask;
    doc.layers[0].maskEnabled = true;
    const maskedComp = compose(doc, 0);
    expect(maskedComp[3]).toBe(0);
    expect(maskedComp[(0 * 8 + 7) * 4 + 3]).toBe(255);

    // 6. Effect Mask selectively applies Dither modifier via grayscale mask gradient
    const dm = newModifier('dither') as DitherMod;
    dm.effectMask = new Uint8Array(64);
    renderMaskGradient(dm.effectMask, 8, 8, { x: 0, y: 0 }, { x: 7, y: 0 }, {
      shape: 'linear',
      pattern: 'bayer4',
      dither: false,
      fromVal: 255,
      toVal: 0,
    });
    const effOut = applySingleModifier(cel, 8, 8, dm);
    expect(effOut[(0 * 8 + 7) * 4]).toBe(cel[(0 * 8 + 7) * 4]); // 0 mask -> untouched

    // 7. Layer group visibility hides child layers cleanly
    doc.groups = [{ id: 'g1', name: 'Hero', visible: false, collapsed: false, opacity: 100 }];
    doc.layers[0].groupId = 'g1';
    const hiddenComp = compose(doc, 0);
    expect(hiddenComp[(0 * 8 + 7) * 4 + 3]).toBe(0);

    // 8. Free pasteboard allows wide Illustrator-style panning beyond canvas bounds
    const freeVp = clampPan({ zoom: 4, panX: -900, panY: 500 }, 640, 480, 8, 8, 32, true);
    expect(freeVp.panX).toBe(-900);
    expect(freeVp.panY).toBe(500);
  });
});
