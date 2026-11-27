import { describe, expect, it } from 'vitest';
import { computeDiff } from '../core/diff';
import { cloneDoc, createDoc, newModifier } from '../core/doc';
import { setPixel } from '../core/raster';
import { maskEqual, rectMask, type SelectionMask } from '../core/selection';
import type { ColorMod, Doc } from '../core/types';
import {
  addAnimationCommand,
  addFrameCommand,
  addLayerCommand,
  addModifierCommand,
  addPaletteCommand,
  addReferenceLayerCommand,
  appendPaletteColorsCommand,
  bakeModifierCommand,
  duplicateLayerCommand,
  duplicateModifierCommand,
  flattenVisibleCommand,
  layerPropCommand,
  mergeDownCommand,
  multiFramePixelPatchCommand,
  pixelPatchCommand,
  referencePropCommand,
  removeAnimationCommand,
  removeFrameCommand,
  removeLayerCommand,
  removeModifierCommand,
  removePaletteCommand,
  removeSwatchCommand,
  renamePaletteCommand,
  reorderFrameCommand,
  reorderLayerCommand,
  reorderModifierCommand,
  reorderSwatchCommand,
  replacePaletteColorsCommand,
  resizeCanvasCommand,
  scaleCanvasCommand,
  selectionCommand,
  setActivePaletteCommand,
  setFrameDurationCommand,
  toggleSwatchLockCommand,
  updateAnimationCommand,
  updateModifierCommand,
} from './commands';
import { History, type Command, type CommandContext } from './history';
import { createStore } from './store';
import { createInitialState } from './ui';

function makeHarness(w = 8, h = 8) {
  const doc = createDoc(w, h);
  let sel: SelectionMask | null = null;
  let activeLayerId = doc.layers[0].id;
  let activeFrame = 0;
  let dirtyCount = 0;
  const ctx: CommandContext = {
    doc,
    getSelection: () => sel,
    setSelection: (m) => { sel = m; },
    getActiveLayerId: () => activeLayerId,
    setActiveLayerId: (id) => { activeLayerId = id; },
    getActiveFrame: () => activeFrame,
    setActiveFrame: (f) => { activeFrame = f; },
    markDirty: () => { dirtyCount++; },
  };
  return { doc, ctx, getSel: () => sel, getActiveLayerId: () => activeLayerId, getActiveFrame: () => activeFrame, getDirty: () => dirtyCount };
}

function docSignature(doc: Doc): string {
  return JSON.stringify({
    version: doc.version,
    w: doc.w,
    h: doc.h,
    frames: doc.frames,
    fps: doc.fps,
    animations: doc.animations,
    modifiers: doc.modifiers,
    palettes: doc.palettes,
    activePaletteId: doc.activePaletteId,
    layers: doc.layers.map((l) => ({
      ...l,
      cels: l.cels.map((c) => Array.from(c)),
      ref: l.ref ? { ...l.ref, pixels: Array.from(l.ref.pixels) } : undefined,
    })),
  });
}

describe('store and ui state', () => {
  it('notifies subscribers only when their slice changes', () => {
    const store = createStore(createInitialState());
    let toolCalls = 0;
    let zoomCalls = 0;
    const u1 = store.subscribe((s) => s.tool, () => toolCalls++);
    store.subscribe((s) => s.viewport.zoom, () => zoomCalls++);

    store.setState({ tool: 'eraser' });
    expect(toolCalls).toBe(1);
    expect(zoomCalls).toBe(0);

    u1();
    store.setState({ tool: 'line' });
    expect(toolCalls).toBe(1);
  });
});

describe('command history round-trips', () => {
  it('round-trips every command type byte-identically across do -> undo -> redo', () => {
    const h = makeHarness(8, 8);
    const hist = new History();
    const initialSig = docSignature(h.doc);

    // 1. pixel patch
    const beforeCel = h.doc.layers[0].cels[0].slice();
    const afterCel = beforeCel.slice();
    setPixel(afterCel, 8, 8, 2, 3, [255, 100, 50, 255]);
    const diff = computeDiff(beforeCel, afterCel, 8, 8)!;

    // prepare modifier for add/update/remove
    const mod = newModifier('color') as ColorMod;
    const modAfter: ColorMod = { ...mod, hue: 90, opacity: 60 };

    const cmds: (() => Command)[] = [
      () => pixelPatchCommand(h.doc.layers[0].id, 0, diff, 'Pencil stroke'),
      () => selectionCommand(h.getSel(), rectMask(8, 8, { x: 1, y: 1 }, { x: 3, y: 3 }), 'Rect select'),
      () => addLayerCommand('Top'),
      () => duplicateLayerCommand(h.doc.layers[0].id),
      () => reorderLayerCommand(0, 1),
      () => layerPropCommand(h.doc.layers[0].id, { name: 'Renamed', opacity: 75, blend: 'multiply', locked: true, alphaLock: true, visible: false }, 'Edit layer'),
      () => layerPropCommand(h.doc.layers[0].id, { visible: true, locked: false }, 'Unlock'),
      () => addFrameCommand(0, true),
      () => removeFrameCommand(1),
      () => addModifierCommand('layer', h.doc.layers[0].id, mod),
      () => updateModifierCommand('layer', h.doc.layers[0].id, mod, modAfter, 'Hue shift'),
      () => removeModifierCommand('layer', h.doc.layers[0].id, mod.id),
      () => mergeDownCommand(1),
      () => flattenVisibleCommand(),
      () => addLayerCommand('Extra'),
      () => removeLayerCommand(h.doc.layers[1].id),
      () => resizeCanvasCommand(10, 10, 'mc'),
      () => scaleCanvasCommand(12, 12),
    ];

    for (const build of cmds) {
      const beforeDoc = docSignature(h.doc);
      const beforeSel = h.getSel();
      const cmd = build();
      hist.execute(cmd, h.ctx);
      const afterDoc = docSignature(h.doc);
      const afterSel = h.getSel();

      expect(hist.undo(h.ctx)).not.toBeNull();
      expect(docSignature(h.doc)).toBe(beforeDoc);
      expect(maskEqual(h.getSel(), beforeSel)).toBe(true);

      expect(hist.redo(h.ctx)).not.toBeNull();
      expect(docSignature(h.doc)).toBe(afterDoc);
      expect(maskEqual(h.getSel(), afterSel)).toBe(true);
    }

    while (hist.canUndo) hist.undo(h.ctx);
    expect(docSignature(h.doc)).toBe(initialSig);
    expect(h.getSel()).toBeNull();
  });

  it('round-trips P2 palette, reference layer, and multi-frame orphan commands byte-identically', () => {
    const h = makeHarness(4, 4);
    const hist = new History();
    const initialSig = docSignature(h.doc);
    const p0 = h.doc.palettes[0].id;

    // Multi-frame diff prep
    hist.execute(addFrameCommand(0, false), h.ctx);
    const l0 = h.doc.layers[0];
    const b0 = l0.cels[0].slice();
    const a0 = b0.slice();
    setPixel(a0, 4, 4, 0, 0, [11, 22, 33, 255]);
    const b1 = l0.cels[1].slice();
    const a1 = b1.slice();
    setPixel(a1, 4, 4, 1, 1, [44, 55, 66, 255]);
    const mfCmd = multiFramePixelPatchCommand(
      l0.id,
      [
        { frame: 0, diff: computeDiff(b0, a0, 4, 4)! },
        { frame: 1, diff: computeDiff(b1, a1, 4, 4)! },
      ],
      'Clean orphans',
    );

    const refData = {
      dataUrl: 'data:image/png;base64,AA==',
      w: 2,
      h: 2,
      x: 0,
      y: 0,
      scale: 1,
      smooth: false,
      flipX: false,
      flipY: false,
      pixels: new Uint8ClampedArray(16).fill(255),
    };

    const cmds: (() => Command)[] = [
      () => mfCmd,
      () => addReferenceLayerCommand('Ref', refData),
      () => referencePropCommand(h.doc.layers[h.doc.layers.length - 1].id, { x: 2, y: 3, scale: 2, flipX: true, smooth: true }, 'Move ref'),
      () => addPaletteCommand('Custom', [[10, 20, 30, 255], [200, 100, 50, 255]]),
      () => renamePaletteCommand(h.doc.activePaletteId, 'Custom Renamed'),
      () => appendPaletteColorsCommand(h.doc.activePaletteId, [[255, 255, 0, 255]]),
      () => toggleSwatchLockCommand(h.doc.activePaletteId, 0),
      () => removeSwatchCommand(h.doc.activePaletteId, 0), // locked -> no-op
      () => removeSwatchCommand(h.doc.activePaletteId, 2), // unlocked -> removes
      () => reorderSwatchCommand(h.doc.activePaletteId, 0, 1),
      () => replacePaletteColorsCommand(h.doc.activePaletteId, [[5, 6, 7, 255]]), // keeps locked swatch
      () => setActivePaletteCommand(p0),
      () => removePaletteCommand(h.doc.palettes[1].id),
    ];

    for (const build of cmds) {
      const beforeDoc = docSignature(h.doc);
      hist.execute(build(), h.ctx);
      const afterDoc = docSignature(h.doc);
      expect(hist.undo(h.ctx)).not.toBeNull();
      expect(docSignature(h.doc)).toBe(beforeDoc);
      expect(hist.redo(h.ctx)).not.toBeNull();
      expect(docSignature(h.doc)).toBe(afterDoc);
    }

    while (hist.canUndo) hist.undo(h.ctx);
    expect(docSignature(h.doc)).toBe(initialSig);
  });

  it('round-trips P3 animation, frame reorder/duration, modifier reorder/duplicate/bake, and history jumpTo', () => {
    const h = makeHarness(4, 4);
    const hist = new History();
    const initialSig = docSignature(h.doc);
    setPixel(h.doc.layers[0].cels[0], 4, 4, 1, 1, [200, 50, 50, 255]);
    const afterSeed = docSignature(h.doc);

    const m1 = newModifier('outline');
    const m2 = newModifier('color');

    const cmds: (() => Command)[] = [
      () => addFrameCommand(0, true),
      () => setFrameDurationCommand(1, 240),
      () => reorderFrameCommand(0, 1),
      () => addAnimationCommand('Walk', 0, 1, 'pingpong', true),
      () => updateAnimationCommand(h.doc.animations[0], { ...h.doc.animations[0], name: 'Run', loop: false }),
      () => addModifierCommand('layer', h.doc.layers[0].id, m1),
      () => addModifierCommand('layer', h.doc.layers[0].id, m2),
      () => reorderModifierCommand('layer', h.doc.layers[0].id, 0, 1),
      () => duplicateModifierCommand('layer', h.doc.layers[0].id, m1.id),
      () => bakeModifierCommand('layer', h.doc.layers[0].id, m1.id),
      () => removeAnimationCommand(h.doc.animations[0].id),
    ];

    for (const build of cmds) {
      const beforeDoc = docSignature(h.doc);
      hist.execute(build(), h.ctx);
      const afterDoc = docSignature(h.doc);
      expect(hist.undo(h.ctx)).not.toBeNull();
      expect(docSignature(h.doc)).toBe(beforeDoc);
      expect(hist.redo(h.ctx)).not.toBeNull();
      expect(docSignature(h.doc)).toBe(afterDoc);
    }

    const entries = hist.getEntries();
    expect(entries).toHaveLength(cmds.length + 1);
    expect(hist.jumpTo(0, h.ctx)).toBe(true);
    expect(docSignature(h.doc)).toBe(afterSeed);
    expect(hist.jumpTo(cmds.length, h.ctx)).toBe(true);
    expect(hist.length).toBe(cmds.length);
    expect(initialSig).not.toBe(afterSeed);
  });

  it('ignores undo while a stroke is active and restores active layer/frame', () => {
    const h = makeHarness(4, 4);
    const hist = new History();
    const l0 = h.doc.layers[0].id;
    const b = h.doc.layers[0].cels[0].slice();
    const a = b.slice();
    setPixel(a, 4, 4, 0, 0, [1, 2, 3, 255]);
    hist.execute(pixelPatchCommand(l0, 0, computeDiff(b, a, 4, 4)!, 'Paint'), h.ctx);

    hist.execute(addLayerCommand('L2'), h.ctx);
    expect(h.getActiveLayerId()).not.toBe(l0);
    expect(hist.undo(h.ctx, true)).toBeNull();

    hist.undo(h.ctx);
    hist.undo(h.ctx);
    expect(h.getActiveLayerId()).toBe(l0);
    expect(h.getActiveFrame()).toBe(0);
  });

  it('evicts oldest commands when step cap or byte cap is exceeded', () => {
    const h = makeHarness(4, 4);
    const stepHist = new History(5, 1024 * 1024);
    for (let i = 0; i < 12; i++) {
      stepHist.execute(
        layerPropCommand(h.doc.layers[0].id, { opacity: 50 + i }, `Op ${i}`),
        h.ctx,
      );
    }
    expect(stepHist.length).toBe(5);

    const memHist = new History(200, 1000);
    for (let i = 0; i < 5; i++) {
      const dummy: Command = { label: `Big ${i}`, byteSize: 400, do() {}, undo() {} };
      memHist.execute(dummy, h.ctx);
    }
    expect(memHist.totalBytes).toBeLessThanOrEqual(1000);
    expect(memHist.length).toBeLessThanOrEqual(2);
  });

  it('1000 random commands followed by undo-all returns initial document', () => {
    const h = makeHarness(6, 6);
    const initial = cloneDoc(h.doc);
    const initialSig = docSignature(initial);
    // Raise step cap to 1500 so all 1000 commands stay on stack and undo back to initial
    const hist = new History(1500, 128 * 1024 * 1024);

    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    for (let step = 0; step < 1000; step++) {
      const pick = Math.floor(rand() * 7);
      const l = h.doc.layers[Math.floor(rand() * h.doc.layers.length)];
      const f = Math.floor(rand() * h.doc.frames.length);

      if (pick === 0 || pick === 1) {
        const before = l.cels[f].slice();
        const after = before.slice();
        const x = Math.floor(rand() * h.doc.w);
        const y = Math.floor(rand() * h.doc.h);
        setPixel(after, h.doc.w, h.doc.h, x, y, [step & 255, (step * 7) & 255, 128, 255]);
        const diff = computeDiff(before, after, h.doc.w, h.doc.h);
        if (diff) hist.execute(pixelPatchCommand(l.id, f, diff, 'Paint'), h.ctx);
      } else if (pick === 2 && h.doc.layers.length < 4) {
        hist.execute(addLayerCommand(`L${step}`), h.ctx);
      } else if (pick === 3 && h.doc.layers.length > 1) {
        hist.execute(removeLayerCommand(l.id), h.ctx);
      } else if (pick === 4) {
        hist.execute(layerPropCommand(l.id, { opacity: Math.floor(rand() * 101), visible: rand() > 0.2 }, 'Props'), h.ctx);
      } else if (pick === 5 && h.doc.frames.length < 4) {
        hist.execute(addFrameCommand(f, rand() > 0.5), h.ctx);
      } else if (pick === 6 && h.doc.frames.length > 1) {
        hist.execute(removeFrameCommand(f), h.ctx);
      } else if (h.doc.layers.length > 1) {
        const a = Math.floor(rand() * h.doc.layers.length);
        const b = (a + 1) % h.doc.layers.length;
        hist.execute(reorderLayerCommand(a, b), h.ctx);
      }
    }

    while (hist.canUndo) hist.undo(h.ctx);
    expect(docSignature(h.doc)).toBe(initialSig);
  });

});
