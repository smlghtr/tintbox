import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { addFrame, createDoc } from '../core/doc';
import { setPixel } from '../core/raster';
import { decodeAseprite, isAsepriteBytes } from './aseprite';
import { exportGifBytes, exportSlicesZipBytes } from './export-pack';
import { decodeAnimatedGif, isGifBytes } from './gif-import';
import { deserializeTintboxArchive, serializeTintboxArchive } from './project-io';

/** Build a minimal valid 32bpp Aseprite (.aseprite) binary fixture with 1 layer, 2 frames, and 1 tag. */
function makeMinimalAsepriteFixture(): Uint8Array {
  const w = 2;
  const h = 2;
  const enc = new TextEncoder();

  const makeChunk = (type: number, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(6 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, out.length, true);
    v.setUint16(4, type, true);
    out.set(body, 6);
    return out;
  };

  // Layer chunk (0x2004): visible + editable, normal type, opacity 255, name "Hero"
  const nameBytes = enc.encode('Hero');
  const layerBody = new Uint8Array(18 + nameBytes.length);
  const lv = new DataView(layerBody.buffer);
  lv.setUint16(0, 3, true); // visible | editable
  lv.setUint16(2, 0, true); // normal layer
  lv.setUint16(10, 0, true); // blend normal
  layerBody[12] = 255; // opacity
  lv.setUint16(16, nameBytes.length, true);
  layerBody.set(nameBytes, 18);
  const layerChunk = makeChunk(0x2004, layerBody);

  // Tags chunk (0x2018): 1 tag "Walk" frames 0..1 forward
  const tagName = enc.encode('Walk');
  const tagBody = new Uint8Array(10 + 19 + tagName.length);
  const tv = new DataView(tagBody.buffer);
  tv.setUint16(0, 1, true); // count
  tv.setUint16(10, 0, true); // from
  tv.setUint16(12, 1, true); // to
  tagBody[14] = 0; // forward
  tv.setUint16(10 + 17, tagName.length, true);
  tagBody.set(tagName, 10 + 19);
  const tagChunk = makeChunk(0x2018, tagBody);

  const makeCelChunk = (rgba: Uint8Array): Uint8Array => {
    const compressed = zlibSync(rgba);
    const body = new Uint8Array(20 + compressed.length);
    const cv = new DataView(body.buffer);
    cv.setUint16(0, 0, true); // layer 0
    cv.setInt16(2, 0, true); // x
    cv.setInt16(4, 0, true); // y
    body[6] = 255; // opacity
    cv.setUint16(7, 2, true); // compressed image
    cv.setUint16(16, w, true);
    cv.setUint16(18, h, true);
    body.set(compressed, 20);
    return makeChunk(0x2005, body);
  };

  const f0Px = new Uint8Array(w * h * 4);
  f0Px.set([255, 0, 0, 255], 0);
  const f1Px = new Uint8Array(w * h * 4);
  f1Px.set([0, 255, 0, 255], 4);

  const makeFrame = (duration: number, chunks: Uint8Array[]): Uint8Array => {
    const total = 16 + chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    const fv = new DataView(out.buffer);
    fv.setUint32(0, total, true);
    fv.setUint16(4, 0xf1fa, true);
    fv.setUint16(6, chunks.length, true);
    fv.setUint16(8, duration, true);
    fv.setUint32(12, chunks.length, true);
    let off = 16;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  };

  const frame0 = makeFrame(120, [layerChunk, tagChunk, makeCelChunk(f0Px)]);
  const frame1 = makeFrame(180, [makeCelChunk(f1Px)]);

  const file = new Uint8Array(128 + frame0.length + frame1.length);
  const hv = new DataView(file.buffer);
  hv.setUint32(0, file.length, true);
  hv.setUint16(4, 0xa5e0, true);
  hv.setUint16(6, 2, true); // 2 frames
  hv.setUint16(8, w, true);
  hv.setUint16(10, h, true);
  hv.setUint16(12, 32, true); // 32bpp RGBA
  hv.setUint16(16, 100, true);
  file.set(frame0, 128);
  file.set(frame1, 128 + frame0.length);
  return file;
}

describe('Aseprite, Animated GIF, and Slices IO', () => {
  it('decodes Aseprite (.aseprite) binary preserving layers, frames, durations, pixels, and tags', () => {
    const bytes = makeMinimalAsepriteFixture();
    expect(isAsepriteBytes(bytes)).toBe(true);
    const doc = decodeAseprite(bytes);
    expect(doc.w).toBe(2);
    expect(doc.h).toBe(2);
    expect(doc.frames).toHaveLength(2);
    expect(doc.frames[0].duration).toBe(120);
    expect(doc.frames[1].duration).toBe(180);
    expect(doc.layers[0].name).toBe('Hero');
    expect(doc.layers[0].cels[0][0]).toBe(255);
    expect(doc.layers[0].cels[1][5]).toBe(255);
    expect(doc.animations).toHaveLength(1);
    expect(doc.animations[0].name).toBe('Walk');
    expect(doc.animations[0].to).toBe(1);
  });

  it('decodes animated GIF exported by Tintbox preserving multi-frame pixels & timing', () => {
    const src = createDoc(8, 8);
    setPixel(src.layers[0].cels[0], 8, 8, 1, 1, [255, 0, 0, 255]);
    addFrame(src, 0, false);
    src.frames[0].duration = 100;
    src.frames[1].duration = 200;
    setPixel(src.layers[0].cels[1], 8, 8, 5, 5, [0, 255, 0, 255]);

    const gifBytes = exportGifBytes(src, [0, 1], { scale: 1 });
    expect(isGifBytes(gifBytes)).toBe(true);
    const decoded = decodeAnimatedGif(gifBytes);
    expect(decoded.w).toBe(8);
    expect(decoded.h).toBe(8);
    expect(decoded.frames).toHaveLength(2);
    expect(decoded.frames[0].duration).toBe(100);
    expect(decoded.frames[1].duration).toBe(200);
    expect(decoded.layers[0].cels[0][(1 * 8 + 1) * 4]).toBe(255);
    expect(decoded.layers[0].cels[1][(5 * 8 + 5) * 4 + 1]).toBe(255);
  });

  it('persists SelectionSlices in .tintbox round-trip and exports slices ZIP', () => {
    const doc = createDoc(16, 16);
    setPixel(doc.layers[0].cels[0], 16, 16, 2, 2, [198, 244, 50, 255]);
    doc.slices = [
      { id: 's1', name: 'Hero', layerId: doc.layers[0].id, rect: { x: 0, y: 0, w: 8, h: 8 } },
    ];
    const archive = serializeTintboxArchive(doc);
    const reloaded = deserializeTintboxArchive(archive);
    expect(reloaded.slices).toHaveLength(1);
    expect(reloaded.slices?.[0].name).toBe('Hero');
    expect(reloaded.slices?.[0].rect).toEqual({ x: 0, y: 0, w: 8, h: 8 });

    const zip = exportSlicesZipBytes(reloaded, 0, { scale: 2 });
    expect(zip.byteLength).toBeGreaterThan(50);
  });
});
