import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { addFrame, compose, createAnimation, createDoc, createLayer, createReferenceLayer, newModifier } from '../core/doc';
import { ValidationError } from '../core/errors';
import { createMask, setMaskBit } from '../core/selection';
import {
  exportGifBytes,
  exportPngSequenceZip,
  exportSinglePngBytes,
  exportSpritesheetBundle,
  resolveExportFrames,
  scaleRgbaNearest,
  type SpritesheetAtlas,
} from './export-pack';
import { decodePngRgba, encodePngRgba } from './png';
import { deserializeTintboxArchive, serializeTintboxArchive } from './project-io';

/** Minimal GIF89a parser for verifying frame count and GCE centisecond delays. */
function parseGifFrames(bytes: Uint8Array): { width: number; height: number; delaysCs: number[]; localTables: number } {
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  expect(header).toBe('GIF89a');
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  const packed = bytes[10];
  let pos = 13;
  if (packed & 0x80) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    pos += gctSize;
  }

  const delaysCs: number[] = [];
  let localTables = 0;

  while (pos < bytes.length) {
    const b = bytes[pos++];
    if (b === 0x3b) break; // trailer
    if (b === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9) {
        const blockSize = bytes[pos++];
        expect(blockSize).toBe(4);
        pos++; // packed
        const delay = bytes[pos] | (bytes[pos + 1] << 8);
        delaysCs.push(delay);
        pos += 3; // delay(2) + transparentIdx(1)
        expect(bytes[pos++]).toBe(0); // terminator
      } else {
        while (pos < bytes.length) {
          const sz = bytes[pos++];
          if (sz === 0) break;
          pos += sz;
        }
      }
    } else if (b === 0x2c) {
      pos += 8; // x, y, w, h
      const imgPacked = bytes[pos++];
      if (imgPacked & 0x80) {
        localTables++;
        pos += 3 * (1 << ((imgPacked & 0x07) + 1));
      }
      pos++; // LZW min code size
      while (pos < bytes.length) {
        const sz = bytes[pos++];
        if (sz === 0) break;
        pos += sz;
      }
    } else {
      throw new Error(`Unexpected GIF byte 0x${b.toString(16)} at ${pos - 1}`);
    }
  }
  return { width, height, delaysCs, localTables };
}

describe('PNG codec (straight alpha, bit-exact)', () => {
  it('round-trips RGBA bytes including semi-transparent alpha without loss', () => {
    const w = 5;
    const h = 4;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      src[i * 4] = (i * 37) & 255;
      src[i * 4 + 1] = (i * 73) & 255;
      src[i * 4 + 2] = (i * 19) & 255;
      src[i * 4 + 3] = i === 0 ? 0 : i === 1 ? 1 : i === 2 ? 127 : 255;
    }
    const png = encodePngRgba(src, w, h);
    const dec = decodePngRgba(png);
    expect(dec.w).toBe(w);
    expect(dec.h).toBe(h);
    expect(Array.from(dec.data)).toEqual(Array.from(src));
  });

  it('rejects non-PNG garbage bytes', () => {
    expect(() => decodePngRgba(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(ValidationError);
  });
});

describe('.tintbox archive round-trip', () => {
  it('preserves layers, reference images, frames, animations, palettes, and all 4 modifier types byte-identically', () => {
    const doc = createDoc(8, 6);
    // Paint pixels on frame 0
    doc.layers[0].cels[0].set([255, 10, 20, 255], 0);
    doc.layers[0].cels[0].set([10, 200, 30, 128], 4 * 5);

    // Add frame 1 with distinct duration
    addFrame(doc, 0, true);
    doc.frames[0].duration = 80;
    doc.frames[1].duration = 240;
    doc.layers[0].cels[1].set([198, 244, 50, 255], 4 * 9);

    // Add second pixel layer with modifiers (including mask + shadow + palette-map)
    const l2 = createLayer(doc, 'FX');
    l2.blend = 'multiply';
    l2.opacity = 75;
    l2.alphaLock = true;
    l2.cels[0].set([50, 120, 250, 255], 4 * 2);
    const shadow = newModifier('shadow');
    const palMap = newModifier('palette-map');
    const mask = createMask(8, 6);
    setMaskBit(mask, 2, 0, true);
    shadow.mask = mask;
    l2.modifiers.push(shadow, palMap);
    doc.layers.push(l2);

    // Add reference image layer
    const refPx = new Uint8ClampedArray(2 * 2 * 4);
    refPx.set([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const refLayer = createReferenceLayer(doc, 'RefSprite', {
      dataUrl: 'data:image/png;base64,AA==',
      w: 2,
      h: 2,
      x: 1,
      y: 2,
      scale: 1.5,
      smooth: true,
      flipX: true,
      flipY: false,
      pixels: refPx,
    });
    doc.layers.push(refLayer);

    // Add named animation and doc-level modifier
    doc.animations.push(createAnimation('Walk', 0, 1, 'pingpong', false));
    doc.modifiers.push(newModifier('outline'));
    doc.palettes[0].colors[0].locked = true;

    const zipBytes = serializeTintboxArchive(doc);
    const restored = deserializeTintboxArchive(zipBytes);

    expect(restored.w).toBe(doc.w);
    expect(restored.h).toBe(doc.h);
    expect(restored.frames).toEqual(doc.frames);
    expect(restored.animations).toEqual(doc.animations);
    expect(restored.palettes).toEqual(doc.palettes);
    expect(restored.activePaletteId).toBe(doc.activePaletteId);
    expect(restored.layers).toHaveLength(3);

    // Byte-identical cel comparison & composed frame comparison
    for (let li = 0; li < 2; li++) {
      for (let fi = 0; fi < 2; fi++) {
        expect(Array.from(restored.layers[li].cels[fi])).toEqual(Array.from(doc.layers[li].cels[fi]));
      }
    }
    expect(Array.from(compose(restored, 0))).toEqual(Array.from(compose(doc, 0)));
    expect(Array.from(compose(restored, 1))).toEqual(Array.from(compose(doc, 1)));

    // Reference layer pixels + transform intact
    const rRef = restored.layers[2];
    expect(rRef.kind).toBe('reference');
    expect(rRef.ref?.w).toBe(2);
    expect(rRef.ref?.h).toBe(2);
    expect(rRef.ref?.flipX).toBe(true);
    expect(rRef.ref?.smooth).toBe(true);
    expect(Array.from(rRef.ref?.pixels ?? [])).toEqual(Array.from(refPx));

    // Modifiers + mask intact
    expect(restored.layers[1].modifiers).toHaveLength(2);
    expect(restored.layers[1].modifiers[0].type).toBe('shadow');
    expect(Array.from(restored.layers[1].modifiers[0].mask?.bits ?? [])).toEqual(Array.from(mask.bits));
    expect(restored.layers[1].modifiers[1].type).toBe('palette-map');
  });

  it('rejects corrupt archives cleanly', () => {
    expect(() => deserializeTintboxArchive(new Uint8Array([0, 1, 2, 3, 4]))).toThrow(ValidationError);
  });
});

describe('Export formats (PNG, GIF, Spritesheet + Atlas, PNG sequence zip)', () => {
  it('1x PNG export -> decode is byte-identical to composed frame and excludes hidden/reference layers', () => {
    const doc = createDoc(4, 4);
    doc.layers[0].cels[0].set([198, 244, 50, 255], 0);
    doc.layers[0].cels[0].set([20, 40, 60, 180], 4 * 5);

    const hidden = createLayer(doc, 'Hidden');
    hidden.visible = false;
    hidden.cels[0].set([255, 0, 0, 255], 4 * 1);
    doc.layers.push(hidden);

    const refLayer = createReferenceLayer(doc, 'Ref', {
      dataUrl: '',
      w: 2,
      h: 2,
      x: 0,
      y: 0,
      scale: 1,
      smooth: false,
      flipX: false,
      flipY: false,
      pixels: new Uint8ClampedArray(16).fill(255),
    });
    doc.layers.push(refLayer);

    const png1x = exportSinglePngBytes(doc, 0, { scale: 1, includeHidden: false });
    const decoded = decodePngRgba(png1x);
    expect(Array.from(decoded.data)).toEqual(Array.from(compose(doc, 0)));
    // Hidden layer pixel at index 1 must remain transparent
    expect(decoded.data[4 + 3]).toBe(0);

    // Include hidden layers option includes pixel layer but still excludes reference layer
    const pngWithHidden = exportSinglePngBytes(doc, 0, { scale: 1, includeHidden: true });
    const decHidden = decodePngRgba(pngWithHidden);
    expect(Array.from(decHidden.data.subarray(4, 8))).toEqual([255, 0, 0, 255]);
  });

  it('scales nearest-neighbor cleanly at integer factors', () => {
    const src = new Uint8ClampedArray([
      10, 20, 30, 255, 40, 50, 60, 255,
      70, 80, 90, 255, 100, 110, 120, 255,
    ]);
    const scaled = scaleRgbaNearest(src, 2, 2, 2);
    expect(scaled.w).toBe(4);
    expect(scaled.h).toBe(4);
    expect(Array.from(scaled.data.subarray(0, 8))).toEqual([10, 20, 30, 255, 10, 20, 30, 255]);
    expect(Array.from(scaled.data.subarray(4 * 4, 4 * 4 + 8))).toEqual([10, 20, 30, 255, 10, 20, 30, 255]);
  });

  it('exports GIF with exact frame count, matching per-frame durations, and no local color tables', () => {
    const doc = createDoc(6, 4);
    addFrame(doc, 0, false);
    addFrame(doc, 1, false);
    doc.frames[0].duration = 50; // 5 cs
    doc.frames[1].duration = 120; // 12 cs
    doc.frames[2].duration = 350; // 35 cs
    doc.layers[0].cels[0].set([255, 0, 0, 255], 0);
    doc.layers[0].cels[1].set([0, 255, 0, 255], 4);
    doc.layers[0].cels[2].set([0, 0, 255, 255], 8);

    const gif = exportGifBytes(doc, [0, 1, 2], { scale: 2, loop: true });
    const info = parseGifFrames(gif);
    expect(info.width).toBe(12);
    expect(info.height).toBe(8);
    expect(info.delaysCs).toEqual([5, 12, 35]);
    expect(info.localTables).toBe(0);
  });

  it('exports spritesheet PNG + JSON atlas with configurable padding', () => {
    const doc = createDoc(4, 3);
    addFrame(doc, 0, false);
    doc.frames[0].duration = 100;
    doc.frames[1].duration = 200;
    doc.layers[0].cels[0].set([255, 255, 0, 255], 0);
    doc.layers[0].cels[1].set([0, 255, 255, 255], 0);
    doc.animations.push(createAnimation('Idle', 0, 1, 'forward', true));

    const bundle = exportSpritesheetBundle(doc, [0, 1], { scale: 2, padding: 3 });
    // Each frame is 8x6; 2 frames + 3px padding => 19x6
    expect(bundle.w).toBe(19);
    expect(bundle.h).toBe(6);
    const dec = decodePngRgba(bundle.png);
    expect(dec.w).toBe(19);
    expect(dec.h).toBe(6);
    // Padding gap at x=8..10 should be transparent
    expect(dec.data[8 * 4 + 3]).toBe(0);
    // Second frame starts at x=11
    expect(Array.from(dec.data.subarray(11 * 4, 11 * 4 + 4))).toEqual([0, 255, 255, 255]);

    const atlas = JSON.parse(bundle.json) as SpritesheetAtlas;
    expect(atlas.meta.scale).toBe(2);
    expect(atlas.meta.padding).toBe(3);
    expect(atlas.frames['frame_001.png'].frame).toEqual({ x: 0, y: 0, w: 8, h: 6 });
    expect(atlas.frames['frame_002.png'].frame).toEqual({ x: 11, y: 0, w: 8, h: 6 });
    expect(atlas.frames['frame_002.png'].duration).toBe(200);
    expect(atlas.animations['Idle']).toEqual({ from: 0, to: 1, direction: 'forward', loop: true });
  });

  it('exports PNG sequence zip with one valid PNG per frame and resolves ping-pong animations', () => {
    const doc = createDoc(4, 4);
    addFrame(doc, 0, false);
    addFrame(doc, 1, false);
    const anim = createAnimation('Bounce', 0, 2, 'pingpong', true);
    doc.animations.push(anim);

    const resolved = resolveExportFrames(doc, anim.id, 0);
    expect(resolved.frames).toEqual([0, 1, 2, 1]);

    const zipBytes = exportPngSequenceZip(doc, resolved.frames, { scale: 1 });
    const entries = unzipSync(zipBytes);
    expect(Object.keys(entries).sort()).toEqual([
      'frame_001.png',
      'frame_002.png',
      'frame_003.png',
      'frame_004.png',
    ]);
    expect(decodePngRgba(entries['frame_001.png']).w).toBe(4);
  });
});
