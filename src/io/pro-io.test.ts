import { describe, expect, it } from 'vitest';
import { addLayer, createDoc } from '../core/doc';
import { decodeBmp, encodeBmp, isBmpBytes } from './bmp';
import { exportBmpBytes, exportJsCode, exportPsdBytes, exportSinglePngBytes } from './export-pack';
import { exportSpriteJs } from './js-export';
import { decodePngRgba } from './png';
import { decodePackBitsRow, decodePsd, encodePackBitsRow, encodePsd, isPsdBytes } from './psd';

describe('BMP 32-bit BGRA codec', () => {
  it('round-trips RGBA pixels losslessly including transparency', () => {
    const w = 5;
    const h = 4;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = (i * 19) % 256;
      rgba[i * 4 + 1] = (i * 37) % 256;
      rgba[i * 4 + 2] = (i * 73) % 256;
      rgba[i * 4 + 3] = i % 3 === 0 ? 0 : 200;
    }
    const bytes = encodeBmp(rgba, w, h);
    expect(isBmpBytes(bytes)).toBe(true);
    const decoded = decodeBmp(bytes);
    expect(decoded.w).toBe(w);
    expect(decoded.h).toBe(h);
    expect(Array.from(decoded.data)).toEqual(Array.from(rgba));
  });

  it('rejects corrupt BMP headers', () => {
    expect(() => decodeBmp(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe('Adobe Photoshop PSD codec', () => {
  it('PackBits RLE round-trips repeated and mixed rows', () => {
    const row = new Uint8Array([7, 7, 7, 7, 7, 1, 2, 3, 4, 9, 9, 9, 255]);
    const enc = encodePackBitsRow(row);
    const dec = decodePackBitsRow(enc, 0, enc.byteLength, row.length);
    expect(Array.from(dec)).toEqual(Array.from(row));
  });

  it('round-trips multi-layer Doc preserving names, blend modes, opacity, visibility, clipping, and pixels', () => {
    const doc = createDoc(12, 10);
    doc.layers[0].name = 'Base';
    doc.layers[0].cels[0][0] = 200;
    doc.layers[0].cels[0][1] = 40;
    doc.layers[0].cels[0][2] = 60;
    doc.layers[0].cels[0][3] = 255;

    const top = addLayer(doc, 'Highlight');
    top.blend = 'screen';
    top.opacity = 0.5;
    top.clipped = true;
    top.visible = false;
    top.cels[0][4] = 10;
    top.cels[0][5] = 250;
    top.cels[0][6] = 120;
    top.cels[0][7] = 180;

    const psdBytes = encodePsd(doc, 0);
    expect(isPsdBytes(psdBytes)).toBe(true);

    const decoded = decodePsd(psdBytes);
    expect(decoded.w).toBe(12);
    expect(decoded.h).toBe(10);
    expect(decoded.layers.length).toBe(2);

    expect(decoded.layers[0].name).toBe('Base');
    expect(decoded.layers[0].blend).toBe('normal');
    expect(decoded.layers[0].visible).toBe(true);
    expect(Array.from(decoded.layers[0].cels[0].slice(0, 4))).toEqual([200, 40, 60, 255]);

    expect(decoded.layers[1].name).toBe('Highlight');
    expect(decoded.layers[1].blend).toBe('screen');
    expect(decoded.layers[1].clipped).toBe(true);
    expect(decoded.layers[1].visible).toBe(false);
    expect(Math.abs(decoded.layers[1].opacity - 0.5)).toBeLessThan(0.01);
    expect(Array.from(decoded.layers[1].cels[0].slice(4, 8))).toEqual([10, 250, 120, 180]);
  });

  it('rejects invalid PSD signature and bad version', () => {
    expect(() => decodePsd(new Uint8Array(30))).toThrow();
    const bad = new Uint8Array(30);
    bad.set([0x38, 0x42, 0x50, 0x53, 0x00, 0x02]); // version 2 PSB
    expect(() => decodePsd(bad)).toThrow();
  });
});

describe('JavaScript & Upscaled Export Pack', () => {
  it('generates valid JS code in canvas2d, dataurl, and rgba modes', () => {
    const doc = createDoc(4, 4);
    doc.layers[0].cels[0].set([198, 244, 50, 255], 0);

    const jsCanvas = exportSpriteJs(doc, [0], { mode: 'canvas2d', scale: 2, algorithm: 'epx2x', varName: 'heroSprite' });
    expect(jsCanvas).toContain('export const heroSprite');
    expect(jsCanvas).toContain('width: 8');
    expect(jsCanvas).toContain('export function drawHeroSprite');
    expect(jsCanvas).toContain('#c6f432');

    const jsData = exportSpriteJs(doc, [0], { mode: 'dataurl', scale: 1, varName: 'coin' });
    expect(jsData).toContain('data:image/png;base64,');
    expect(jsData).toContain('loadCoinImages');

    const jsRgba = exportSpriteJs(doc, [0], { mode: 'rgba', scale: 1, varName: 'rawTex' });
    expect(jsRgba).toContain('new Uint8ClampedArray(');
    expect(jsRgba).toContain('toImageData');
  });

  it('exports scaled PNG, BMP, PSD, and JS through export-pack helpers', () => {
    const doc = createDoc(6, 6);
    doc.layers[0].cels[0].set([255, 80, 20, 255], 0);

    const png = exportSinglePngBytes(doc, 0, { scale: 2, algorithm: 'hq2x' });
    const decPng = decodePngRgba(png);
    expect(decPng.w).toBe(12);
    expect(decPng.h).toBe(12);

    const bmp = exportBmpBytes(doc, 0, { scale: 2, algorithm: 'epx2x' });
    const decBmp = decodeBmp(bmp);
    expect(decBmp.w).toBe(12);
    expect(decBmp.h).toBe(12);

    const psd = exportPsdBytes(doc, 0);
    expect(decodePsd(psd).w).toBe(6);

    const code = exportJsCode(doc, [0], { scale: 1, jsMode: 'canvas2d' });
    expect(code).toContain('export const sprite');
  });
});
