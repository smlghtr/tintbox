import { describe, expect, it } from 'vitest';
import {
  ONION_PREV_TINT,
  buildOnionBuffer,
  buildPlaybackSequence,
  computeOnionFrames,
  countPaletteUsage,
  frameDurationMs,
  resolvePlaybackRange,
  stepPlayback,
} from './animation';
import { addFrame, compose, createAnimation, createDoc, newModifier, reorderFrame } from './doc';
import { applyModifiers } from './modifiers';
import { setPixel } from './raster';
import { rectMask } from './selection';
import type { ColorMod, OutlineMod, RGBA } from './types';

describe('animation playback & sequences', () => {
  it('builds forward, reverse, and ping-pong sequences cleanly', () => {
    expect(buildPlaybackSequence(0, 3, 'forward')).toEqual([0, 1, 2, 3]);
    expect(buildPlaybackSequence(0, 3, 'reverse')).toEqual([3, 2, 1, 0]);
    expect(buildPlaybackSequence(0, 3, 'pingpong')).toEqual([0, 1, 2, 3, 2, 1]);
    expect(buildPlaybackSequence(2, 2, 'pingpong')).toEqual([2]);
  });

  it('steps playback with loop on/off and resolves named animations', () => {
    const seq = [0, 1, 2];
    expect(stepPlayback(seq, 2, true)).toEqual({ nextSeqIdx: 0, frame: 0, stopped: false });
    expect(stepPlayback(seq, 2, false)).toEqual({ nextSeqIdx: 2, frame: 2, stopped: true });

    const doc = createDoc(4, 4);
    addFrame(doc, 0, false);
    addFrame(doc, 1, false);
    doc.frames[1].duration = 250;
    const anim = createAnimation('Walk', 1, 2, 'pingpong', true);
    doc.animations.push(anim);

    expect(resolvePlaybackRange(doc, anim.id)).toEqual({ from: 1, to: 2, direction: 'pingpong', loop: true });
    expect(frameDurationMs(doc, 1)).toBe(250);
  });

  it('reorders frames and keeps layer cels aligned', () => {
    const doc = createDoc(2, 2);
    setPixel(doc.layers[0].cels[0], 2, 2, 0, 0, [10, 0, 0, 255]);
    addFrame(doc, 0, false);
    setPixel(doc.layers[0].cels[1], 2, 2, 0, 0, [20, 0, 0, 255]);
    doc.frames[0].duration = 100;
    doc.frames[1].duration = 300;

    expect(reorderFrame(doc, 0, 1)).toBe(true);
    expect(doc.frames[0].duration).toBe(300);
    expect(doc.layers[0].cels[0][0]).toBe(20);
    expect(doc.layers[0].cels[1][0]).toBe(10);
  });
});

describe('F-ONION onion skin', () => {
  it('on frame 0, previous frame shows ONLY when wrap is on', () => {
    const noWrap = computeOnionFrames(0, 4, { from: 0, to: 3 }, { before: 1, after: 1, wrap: false });
    expect(noWrap.some((e) => e.kind === 'prev')).toBe(false);
    expect(noWrap.some((e) => e.kind === 'next' && e.frame === 1)).toBe(true);

    const wrapped = computeOnionFrames(0, 4, { from: 0, to: 3 }, { before: 1, after: 1, wrap: true });
    expect(wrapped.some((e) => e.kind === 'prev' && e.frame === 3)).toBe(true);
    expect(wrapped.some((e) => e.kind === 'next' && e.frame === 1)).toBe(true);
  });

  it('falls off linearly from 50% opacity across steps', () => {
    const entries = computeOnionFrames(3, 6, { from: 0, to: 5 }, { before: 2, after: 0, wrap: false });
    expect(entries).toHaveLength(2);
    // Farthest first: step 2 = 25%, step 1 = 50%
    expect(entries[0]).toMatchObject({ frame: 1, step: 2, opacity: 0.25 });
    expect(entries[1]).toMatchObject({ frame: 2, step: 1, opacity: 0.5 });
  });

  it('builds tinted and original buffers without mutating source and never affects compose/export', () => {
    const doc = createDoc(4, 4);
    setPixel(doc.layers[0].cels[0], 4, 4, 1, 1, [200, 50, 50, 255]);
    addFrame(doc, 0, false);
    setPixel(doc.layers[0].cels[1], 4, 4, 2, 2, [50, 200, 50, 255]);

    const exportBefore = compose(doc, 1).slice();
    const prevBuf = compose(doc, 0);
    const tinted = buildOnionBuffer(prevBuf, 'tinted', ONION_PREV_TINT, 0.5);
    const orig = buildOnionBuffer(prevBuf, 'original', ONION_PREV_TINT, 0.5);
    expect(tinted[(1 * 4 + 1) * 4]).toBe(ONION_PREV_TINT[0]);
    expect(tinted[(1 * 4 + 1) * 4 + 3]).toBe(128);
    expect(orig[(1 * 4 + 1) * 4]).toBe(200);
    expect(compose(doc, 1)).toEqual(exportBefore);
  });
});

describe('P3 modifier extensions & palette usage counts', () => {
  it('supports outline width 1..4, 8-neighbor connectivity, selection mask, and solo without altering source bytes', () => {
    const w = 7, h = 7;
    const src = new Uint8ClampedArray(w * h * 4);
    setPixel(src, w, h, 3, 3, [255, 0, 0, 255]);
    const copy = src.slice();

    const m8 = newModifier('outline') as OutlineMod;
    m8.connectivity = 8;
    m8.width = 1;
    const out8 = applyModifiers(src, w, h, [m8]);
    // 8 neighbors + center = 9 filled pixels
    let count8 = 0;
    for (let i = 0; i < w * h; i++) if (out8[i * 4 + 3] > 0) count8++;
    expect(count8).toBe(9);

    const mw2 = newModifier('outline') as OutlineMod;
    mw2.width = 2;
    const outW2 = applyModifiers(src, w, h, [mw2]);
    expect(outW2[(1 * w + 3) * 4 + 3]).toBe(255); // 2px above center

    // Selection slice mask limits color modifier strictly to masked area
    const cm = newModifier('color') as ColorMod;
    cm.hue = 120;
    cm.mask = rectMask(w, h, { x: 0, y: 0 }, { x: 2, y: 2 });
    const maskedOut = applyModifiers(src, w, h, [cm]);
    expect(maskedOut[(3 * w + 3) * 4]).toBe(255); // untouched outside mask

    // Solo applies only targeted modifier
    const soloOut = applyModifiers(src, w, h, [m8, cm], cm.id);
    expect(soloOut[(3 * w + 4) * 4 + 3]).toBe(0); // m8 skipped

    // Source bytes strictly untouched
    expect(src).toEqual(copy);
  });

  it('counts canvas pixel usage per palette swatch accurately', () => {
    const pal: RGBA[] = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];
    const buf = new Uint8ClampedArray(4 * 4 * 4);
    setPixel(buf, 4, 4, 0, 0, [255, 0, 0, 255]);
    setPixel(buf, 4, 4, 1, 0, [255, 0, 0, 255]);
    setPixel(buf, 4, 4, 2, 0, [0, 0, 255, 255]);
    expect(countPaletteUsage(buf, pal)).toEqual([2, 0, 1]);
  });
});
