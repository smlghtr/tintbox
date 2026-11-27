import { applyDiff, diffByteSize } from '../core/diff';
import {
  addFrame,
  cloneLayer,
  cloneModifier,
  clonePalette,
  createAnimation,
  createFrame,
  createLayer,
  createPalette,
  createReferenceLayer,
  flattenVisible,
  getActivePalette,
  getLayerCel,
  mergeDown,
  removeFrame,
  reorderFrame,
  reorderLayer,
  resizeDoc,
  scaleDoc,
  setLayerCelCount,
  uid,
} from '../core/doc';
import { applySingleModifier } from '../core/modifiers';
import { rgbaEqual } from '../core/palette';
import type { ResampleAlgorithm } from '../core/scale';
import { cloneMask, type SelectionMask } from '../core/selection';
import {
  cloneMapLayer,
  cloneTileDef,
  createMapLayer,
  hashRgba,
  resizeTileMapData,
  resolveTilePixels,
  validateMapDim,
  validateTileDim,
} from '../core/tiles';
import type {
  Anchor9,
  Animation,
  BlendMode,
  Frame,
  Layer,
  LayerGroup,
  Modifier,
  Palette,
  PaletteEntry,
  PixelDiff,
  ReferenceImage,
  RGBA,
  SelectionSlice,
  TileCategory,
  TileDef,
  TileMapLayer,
} from '../core/types';
import type { Command, CommandContext } from './history';

const layerBytes = (l: Layer): number => l.cels.reduce((sum, c) => sum + c.byteLength, 256);

export function pixelPatchCommand(
  layerId: string,
  frame: number,
  diff: PixelDiff,
  label: string,
): Command {
  return {
    label,
    layerId,
    frame,
    byteSize: diffByteSize(diff),
    do(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      const cel = layer ? getLayerCel(layer, frame) : undefined;
      if (layer && cel) {
        applyDiff(cel, ctx.doc.w, diff, 'after');
        ctx.markDirty(layer.cels.length === ctx.doc.frames.length ? frame : undefined);
      }
    },
    undo(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      const cel = layer ? getLayerCel(layer, frame) : undefined;
      if (layer && cel) {
        applyDiff(cel, ctx.doc.w, diff, 'before');
        ctx.markDirty(layer.cels.length === ctx.doc.frames.length ? frame : undefined);
      }
    },
  };
}

export function selectionCommand(
  before: SelectionMask | null,
  after: SelectionMask | null,
  label = 'Selection',
): Command {
  const bCopy = before ? cloneMask(before) : null;
  const aCopy = after ? cloneMask(after) : null;
  const byteSize = (bCopy?.bits.byteLength ?? 0) + (aCopy?.bits.byteLength ?? 0) + 64;
  return {
    label,
    byteSize,
    do(ctx) {
      ctx.setSelection(aCopy ? cloneMask(aCopy) : null);
    },
    undo(ctx) {
      ctx.setSelection(bCopy ? cloneMask(bCopy) : null);
    },
  };
}

export function addLayerCommand(name?: string): Command {
  let created: Layer | null = null;
  let prevLayerId = '';
  return {
    label: 'Add layer',
    byteSize: 512,
    do(ctx) {
      prevLayerId = ctx.getActiveLayerId();
      if (!created) created = createLayer(ctx.doc, name);
      ctx.doc.layers.push(cloneLayer(created, false));
      ctx.setActiveLayerId(created.id);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!created) return;
      ctx.doc.layers = ctx.doc.layers.filter((l) => l.id !== created?.id);
      if (prevLayerId && ctx.doc.layers.some((l) => l.id === prevLayerId)) {
        ctx.setActiveLayerId(prevLayerId);
      }
      ctx.markDirty();
    },
  };
}

export function duplicateLayerCommand(sourceId: string): Command {
  let copySnapshot: Layer | null = null;
  let insertIdx = -1;
  let prevLayerId = '';
  return {
    label: 'Duplicate layer',
    byteSize: 1024,
    do(ctx) {
      prevLayerId = ctx.getActiveLayerId();
      if (!copySnapshot) {
        const idx = ctx.doc.layers.findIndex((l) => l.id === sourceId);
        if (idx < 0) return;
        insertIdx = idx + 1;
        copySnapshot = cloneLayer(ctx.doc.layers[idx], true);
        copySnapshot.name = `${ctx.doc.layers[idx].name} copy`;
      }
      if (insertIdx < 0) return;
      ctx.doc.layers.splice(insertIdx, 0, cloneLayer(copySnapshot, false));
      ctx.setActiveLayerId(copySnapshot.id);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!copySnapshot) return;
      ctx.doc.layers = ctx.doc.layers.filter((l) => l.id !== copySnapshot?.id);
      if (prevLayerId) ctx.setActiveLayerId(prevLayerId);
      ctx.markDirty();
    },
  };
}

export function removeLayerCommand(layerId: string): Command {
  let removed: Layer | null = null;
  let removedIdx = -1;
  let computedBytes = 512;
  return {
    label: 'Delete layer',
    get byteSize() {
      return computedBytes;
    },
    do(ctx) {
      if (ctx.doc.layers.length <= 1) return;
      const idx = ctx.doc.layers.findIndex((l) => l.id === layerId);
      if (idx < 0) return;
      removedIdx = idx;
      removed = cloneLayer(ctx.doc.layers[idx], false);
      computedBytes = layerBytes(removed);
      ctx.doc.layers.splice(idx, 1);
      const fallback = ctx.doc.layers[Math.min(idx, ctx.doc.layers.length - 1)];
      if (fallback) ctx.setActiveLayerId(fallback.id);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!removed || removedIdx < 0) return;
      ctx.doc.layers.splice(removedIdx, 0, cloneLayer(removed, false));
      ctx.setActiveLayerId(removed.id);
      ctx.markDirty();
    },
  };
}

export function reorderLayerCommand(fromIndex: number, toIndex: number): Command {
  return {
    label: 'Reorder layer',
    byteSize: 64,
    do(ctx) {
      if (reorderLayer(ctx.doc, fromIndex, toIndex)) ctx.markDirty();
    },
    undo(ctx) {
      if (reorderLayer(ctx.doc, toIndex, fromIndex)) ctx.markDirty();
    },
  };
}

export interface LayerPropsPatch {
  name?: string;
  visible?: boolean;
  locked?: boolean;
  alphaLock?: boolean;
  clipped?: boolean;
  opacity?: number;
  blend?: BlendMode;
}

export function layerPropCommand(
  layerId: string,
  patch: LayerPropsPatch,
  label: string,
): Command {
  let before: LayerPropsPatch | null = null;
  return {
    label,
    layerId,
    byteSize: 128,
    do(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer) return;
      if (!before) {
        before = {};
        if (patch.name !== undefined) before.name = layer.name;
        if (patch.visible !== undefined) before.visible = layer.visible;
        if (patch.locked !== undefined) before.locked = layer.locked;
        if (patch.alphaLock !== undefined) before.alphaLock = layer.alphaLock;
        if (patch.clipped !== undefined) before.clipped = Boolean(layer.clipped);
        if (patch.opacity !== undefined) before.opacity = layer.opacity;
        if (patch.blend !== undefined) before.blend = layer.blend;
      }
      Object.assign(layer, patch);
      ctx.markDirty();
    },
    undo(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer || !before) return;
      Object.assign(layer, before);
      ctx.markDirty();
    },
  };
}

export function mergeDownCommand(index: number): Command {
  let prevLower: Layer | null = null;
  let prevUpper: Layer | null = null;
  let prevActive = '';
  let computedBytes = 512;
  return {
    label: 'Merge down',
    get byteSize() {
      return computedBytes;
    },
    do(ctx) {
      if (index <= 0 || index >= ctx.doc.layers.length) return;
      prevActive = ctx.getActiveLayerId();
      if (!prevLower || !prevUpper) {
        prevLower = cloneLayer(ctx.doc.layers[index - 1], false);
        prevUpper = cloneLayer(ctx.doc.layers[index], false);
        computedBytes = layerBytes(prevLower) + layerBytes(prevUpper);
      }
      const merged = mergeDown(ctx.doc, index);
      if (merged) ctx.setActiveLayerId(merged.id);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!prevLower || !prevUpper) return;
      ctx.doc.layers.splice(index - 1, 1, cloneLayer(prevLower, false), cloneLayer(prevUpper, false));
      if (prevActive) ctx.setActiveLayerId(prevActive);
      ctx.markDirty();
    },
  };
}

export function flattenVisibleCommand(): Command {
  let prevLayers: Layer[] | null = null;
  let nextLayers: Layer[] | null = null;
  let flatId = '';
  let prevActive = '';
  let computedBytes = 512;
  return {
    label: 'Flatten visible',
    get byteSize() {
      return computedBytes;
    },
    do(ctx) {
      prevActive = ctx.getActiveLayerId();
      if (!prevLayers) {
        prevLayers = ctx.doc.layers.map((l) => cloneLayer(l, false));
        computedBytes = prevLayers.reduce((s, l) => s + layerBytes(l), 0);
        const flat = flattenVisible(ctx.doc);
        if (flat) {
          flatId = flat.id;
          nextLayers = ctx.doc.layers.map((l) => cloneLayer(l, false));
          ctx.setActiveLayerId(flatId);
        }
      } else if (nextLayers) {
        ctx.doc.layers = nextLayers.map((l) => cloneLayer(l, false));
        if (flatId) ctx.setActiveLayerId(flatId);
      }
      ctx.markDirty();
    },
    undo(ctx) {
      if (!prevLayers) return;
      ctx.doc.layers = prevLayers.map((l) => cloneLayer(l, false));
      if (prevActive) ctx.setActiveLayerId(prevActive);
      ctx.markDirty();
    },
  };
}

export function addFrameCommand(afterIndex: number, copy: boolean): Command {
  let insertedIdx = -1;
  let prevFrame = 0;
  let createdFrame: Frame | null = null;
  return {
    label: copy ? 'Duplicate frame' : 'Add blank frame',
    byteSize: 256,
    do(ctx) {
      prevFrame = ctx.getActiveFrame();
      if (!createdFrame) {
        const idx = Math.max(0, Math.min(ctx.doc.frames.length - 1, afterIndex));
        const dur = copy ? ctx.doc.frames[idx].duration : Math.round(1000 / Math.max(1, ctx.doc.fps));
        createdFrame = createFrame(dur);
      }
      insertedIdx = addFrame(ctx.doc, afterIndex, copy, createdFrame);
      ctx.setActiveFrame(insertedIdx);
      ctx.markDirty();
    },
    undo(ctx) {
      if (insertedIdx < 0) return;
      removeFrame(ctx.doc, insertedIdx);
      ctx.setActiveFrame(Math.min(prevFrame, ctx.doc.frames.length - 1));
      ctx.markDirty();
    },
  };
}

export function removeFrameCommand(index: number): Command {
  let savedCels: { layerId: string; cel: Uint8ClampedArray }[] | null = null;
  let savedFrame: Frame | null = null;
  let savedAnims: Animation[] | null = null;
  let computedBytes = 256;
  return {
    label: 'Delete frame',
    get byteSize() {
      return computedBytes;
    },
    do(ctx) {
      if (ctx.doc.frames.length <= 1) return;
      if (!savedCels) {
        savedFrame = { ...ctx.doc.frames[index] };
        savedAnims = ctx.doc.animations.map((a) => ({ ...a }));
        savedCels = ctx.doc.layers.map((l) => ({ layerId: l.id, cel: l.cels[index].slice() }));
        computedBytes = savedCels.reduce((s, x) => s + x.cel.byteLength, 128);
      }
      const next = removeFrame(ctx.doc, index);
      ctx.setActiveFrame(next);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!savedCels || !savedFrame) return;
      ctx.doc.frames.splice(index, 0, { ...savedFrame });
      for (const l of ctx.doc.layers) {
        const entry = savedCels.find((x) => x.layerId === l.id);
        l.cels.splice(
          index,
          0,
          entry ? entry.cel.slice() : new Uint8ClampedArray(l.kind === 'reference' ? 4 : ctx.doc.w * ctx.doc.h * 4),
        );
      }
      if (savedAnims) ctx.doc.animations = savedAnims.map((a) => ({ ...a }));
      ctx.setActiveFrame(index);
      ctx.markDirty();
    },
  };
}

export function reorderFrameCommand(fromIndex: number, toIndex: number): Command {
  return {
    label: 'Reorder frame',
    byteSize: 64,
    do(ctx) {
      if (reorderFrame(ctx.doc, fromIndex, toIndex)) {
        ctx.setActiveFrame(toIndex);
        ctx.markDirty();
      }
    },
    undo(ctx) {
      if (reorderFrame(ctx.doc, toIndex, fromIndex)) {
        ctx.setActiveFrame(fromIndex);
        ctx.markDirty();
      }
    },
  };
}

export function setFrameDurationCommand(frameIndex: number, duration: number): Command {
  let prev = 0;
  let captured = false;
  const clamped = Math.max(16, Math.min(10000, Math.round(duration)));
  return {
    label: `Frame ${frameIndex + 1} duration ${clamped}ms`,
    frame: frameIndex,
    byteSize: 64,
    do(ctx) {
      const f = ctx.doc.frames[frameIndex];
      if (!f) return;
      if (!captured) {
        prev = f.duration;
        captured = true;
      }
      f.duration = clamped;
      ctx.markDirty(frameIndex);
    },
    undo(ctx) {
      const f = ctx.doc.frames[frameIndex];
      if (!f || !captured) return;
      f.duration = prev;
      ctx.markDirty(frameIndex);
    },
  };
}

export function addAnimationCommand(
  name: string,
  from: number,
  to: number,
  direction: Animation['direction'] = 'forward',
  loop = true,
): Command {
  let created: Animation | null = null;
  return {
    label: `Add animation: ${name}`,
    byteSize: 128,
    do(ctx) {
      if (!created) created = createAnimation(name, from, to, direction, loop);
      ctx.doc.animations.push({ ...created });
      ctx.markDirty();
    },
    undo(ctx) {
      if (!created) return;
      ctx.doc.animations = ctx.doc.animations.filter((a) => a.id !== created?.id);
      ctx.markDirty();
    },
  };
}

export function updateAnimationCommand(before: Animation, after: Animation, label = 'Edit animation'): Command {
  const bSnap = { ...before };
  const aSnap = { ...after };
  return {
    label,
    byteSize: 128,
    do(ctx) {
      const idx = ctx.doc.animations.findIndex((a) => a.id === aSnap.id);
      if (idx >= 0) ctx.doc.animations[idx] = { ...aSnap };
      ctx.markDirty();
    },
    undo(ctx) {
      const idx = ctx.doc.animations.findIndex((a) => a.id === bSnap.id);
      if (idx >= 0) ctx.doc.animations[idx] = { ...bSnap };
      ctx.markDirty();
    },
  };
}

export function removeAnimationCommand(animId: string): Command {
  let saved: Animation | null = null;
  let savedIdx = -1;
  return {
    label: 'Delete animation',
    byteSize: 128,
    do(ctx) {
      const idx = ctx.doc.animations.findIndex((a) => a.id === animId);
      if (idx < 0) return;
      savedIdx = idx;
      saved = { ...ctx.doc.animations[idx] };
      ctx.doc.animations.splice(idx, 1);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!saved || savedIdx < 0) return;
      ctx.doc.animations.splice(savedIdx, 0, { ...saved });
      ctx.markDirty();
    },
  };
}

export function reorderModifierCommand(
  scope: 'layer' | 'doc',
  layerId: string | null,
  fromIdx: number,
  toIdx: number,
): Command {
  return {
    label: 'Reorder modifier',
    layerId: scope === 'layer' && layerId ? layerId : undefined,
    byteSize: 64,
    do(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list || fromIdx < 0 || toIdx < 0 || fromIdx >= list.length || toIdx >= list.length || fromIdx === toIdx) return;
      const [moved] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, moved);
      ctx.markDirty();
    },
    undo(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list || fromIdx < 0 || toIdx < 0 || fromIdx >= list.length || toIdx >= list.length || fromIdx === toIdx) return;
      const [moved] = list.splice(toIdx, 1);
      list.splice(fromIdx, 0, moved);
      ctx.markDirty();
    },
  };
}

export function duplicateModifierCommand(
  scope: 'layer' | 'doc',
  layerId: string | null,
  modId: string,
): Command {
  let copySnap: Modifier | null = null;
  let insertIdx = -1;
  return {
    label: 'Duplicate modifier',
    layerId: scope === 'layer' && layerId ? layerId : undefined,
    byteSize: 256,
    do(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list) return;
      if (!copySnap) {
        const idx = list.findIndex((m) => m.id === modId);
        if (idx < 0) return;
        insertIdx = idx + 1;
        copySnap = cloneModifier(list[idx], true);
      }
      if (insertIdx < 0) return;
      list.splice(insertIdx, 0, cloneModifier(copySnap, false));
      ctx.markDirty();
    },
    undo(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list || !copySnap) return;
      const idx = list.findIndex((m) => m.id === copySnap?.id);
      if (idx >= 0) list.splice(idx, 1);
      ctx.markDirty();
    },
  };
}

export function bakeModifierCommand(
  scope: 'layer' | 'doc',
  layerId: string | null,
  modId: string,
): Command {
  let savedMod: Modifier | null = null;
  let savedIdx = -1;
  let savedCels: { layerId: string; cels: Uint8ClampedArray[] }[] | null = null;
  let computedBytes = 512;

  return {
    label: 'Bake modifier to pixels',
    layerId: scope === 'layer' && layerId ? layerId : undefined,
    get byteSize() {
      return computedBytes;
    },
    do(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list) return;
      const idx = list.findIndex((m) => m.id === modId);
      if (idx < 0) return;
      const targetMod = list[idx];
      const targetLayers =
        scope === 'layer'
          ? ctx.doc.layers.filter((l) => l.id === layerId && l.kind === 'pixel')
          : ctx.doc.layers.filter((l) => l.kind === 'pixel');

      if (!savedMod) {
        savedIdx = idx;
        savedMod = cloneModifier(targetMod, false);
        savedCels = targetLayers.map((l) => ({ layerId: l.id, cels: l.cels.map((c) => c.slice()) }));
        computedBytes = savedCels.reduce((s, x) => s + x.cels.reduce((cs, c) => cs + c.byteLength, 0), 256);
      }

      const palColors = getActivePalette(ctx.doc).colors.map((e) => e.rgba);
      for (const l of targetLayers) {
        l.cels = l.cels.map((c) => applySingleModifier(c, ctx.doc.w, ctx.doc.h, targetMod, palColors));
      }
      list.splice(idx, 1);
      ctx.markDirty();
    },
    undo(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list || !savedMod || savedIdx < 0 || !savedCels) return;
      for (const entry of savedCels) {
        const l = ctx.doc.layers.find((x) => x.id === entry.layerId);
        if (l) l.cels = entry.cels.map((c) => c.slice());
      }
      list.splice(savedIdx, 0, cloneModifier(savedMod, false));
      ctx.markDirty();
    },
  };
}

function getModifierList(ctx: CommandContext, scope: 'layer' | 'doc', layerId: string | null): Modifier[] | null {
  if (scope === 'doc') return ctx.doc.modifiers;
  const layer = ctx.doc.layers.find((l) => l.id === layerId);
  return layer ? layer.modifiers : null;
}

export function addModifierCommand(scope: 'layer' | 'doc', layerId: string | null, mod: Modifier): Command {
  const snap = cloneModifier(mod, false);
  return {
    label: `Add ${mod.type} modifier`,
    layerId: scope === 'layer' && layerId ? layerId : undefined,
    byteSize: 128,
    do(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list) return;
      list.push(cloneModifier(snap, false));
      ctx.markDirty();
    },
    undo(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list) return;
      const idx = list.findIndex((m) => m.id === snap.id);
      if (idx >= 0) list.splice(idx, 1);
      ctx.markDirty();
    },
  };
}

export function removeModifierCommand(scope: 'layer' | 'doc', layerId: string | null, modId: string): Command {
  let saved: Modifier | null = null;
  let savedIdx = -1;
  return {
    label: 'Remove modifier',
    layerId: scope === 'layer' && layerId ? layerId : undefined,
    byteSize: 128,
    do(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list) return;
      const idx = list.findIndex((m) => m.id === modId);
      if (idx < 0) return;
      savedIdx = idx;
      saved = cloneModifier(list[idx], false);
      list.splice(idx, 1);
      ctx.markDirty();
    },
    undo(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list || !saved || savedIdx < 0) return;
      list.splice(savedIdx, 0, cloneModifier(saved, false));
      ctx.markDirty();
    },
  };
}

export function updateModifierCommand(
  scope: 'layer' | 'doc',
  layerId: string | null,
  before: Modifier,
  after: Modifier,
  label = 'Edit modifier',
): Command {
  const bSnap = cloneModifier(before, false);
  const aSnap = cloneModifier(after, false);
  return {
    label,
    layerId: scope === 'layer' && layerId ? layerId : undefined,
    byteSize: 256,
    do(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list) return;
      const idx = list.findIndex((m) => m.id === aSnap.id);
      if (idx >= 0) list[idx] = cloneModifier(aSnap, false);
      ctx.markDirty();
    },
    undo(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      if (!list) return;
      const idx = list.findIndex((m) => m.id === bSnap.id);
      if (idx >= 0) list[idx] = cloneModifier(bSnap, false);
      ctx.markDirty();
    },
  };
}

export function resizeCanvasCommand(newW: number, newH: number, anchor: Anchor9): Command {
  let prevW = 0;
  let prevH = 0;
  let prevLayers: Layer[] | null = null;
  let prevSel: SelectionMask | null = null;
  let computedBytes = 512;
  return {
    label: `Resize canvas ${newW}x${newH}`,
    get byteSize() {
      return computedBytes;
    },
    do(ctx) {
      if (!prevLayers) {
        prevW = ctx.doc.w;
        prevH = ctx.doc.h;
        prevLayers = ctx.doc.layers.map((l) => cloneLayer(l, false));
        prevSel = ctx.getSelection() ? cloneMask(ctx.getSelection() as SelectionMask) : null;
        computedBytes = prevLayers.reduce((s, l) => s + layerBytes(l), 256);
      }
      resizeDoc(ctx.doc, newW, newH, anchor);
      ctx.setSelection(null);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!prevLayers) return;
      ctx.doc.w = prevW;
      ctx.doc.h = prevH;
      ctx.doc.layers = prevLayers.map((l) => cloneLayer(l, false));
      ctx.setSelection(prevSel ? cloneMask(prevSel) : null);
      ctx.markDirty();
    },
  };
}

export function scaleCanvasCommand(newW: number, newH: number, algorithm: ResampleAlgorithm = 'nearest'): Command {
  let prevW = 0;
  let prevH = 0;
  let prevLayers: Layer[] | null = null;
  let prevSel: SelectionMask | null = null;
  let computedBytes = 512;
  return {
    label: `Scale canvas ${newW}x${newH} (${algorithm})`,
    get byteSize() {
      return computedBytes;
    },
    do(ctx) {
      if (!prevLayers) {
        prevW = ctx.doc.w;
        prevH = ctx.doc.h;
        prevLayers = ctx.doc.layers.map((l) => cloneLayer(l, false));
        prevSel = ctx.getSelection() ? cloneMask(ctx.getSelection() as SelectionMask) : null;
        computedBytes = prevLayers.reduce((s, l) => s + layerBytes(l), 256);
      }
      scaleDoc(ctx.doc, newW, newH, algorithm);
      ctx.setSelection(null);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!prevLayers) return;
      ctx.doc.w = prevW;
      ctx.doc.h = prevH;
      ctx.doc.layers = prevLayers.map((l) => cloneLayer(l, false));
      ctx.setSelection(prevSel ? cloneMask(prevSel) : null);
      ctx.markDirty();
    },
  };
}

export function multiFramePixelPatchCommand(
  layerId: string,
  patches: { frame: number; diff: PixelDiff }[],
  label: string,
): Command {
  const bytes = patches.reduce((sum, p) => sum + diffByteSize(p.diff), 64);
  return {
    label,
    layerId,
    byteSize: bytes,
    do(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer) return;
      for (const p of patches) {
        const cel = layer.cels[p.frame];
        if (cel) {
          applyDiff(cel, ctx.doc.w, p.diff, 'after');
          ctx.markDirty(p.frame);
        }
      }
    },
    undo(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer) return;
      for (const p of patches) {
        const cel = layer.cels[p.frame];
        if (cel) {
          applyDiff(cel, ctx.doc.w, p.diff, 'before');
          ctx.markDirty(p.frame);
        }
      }
    },
  };
}

export interface LayerCelPatch {
  layerId: string;
  frame: number;
  diff: PixelDiff;
}

export interface LayerRefPatch {
  layerId: string;
  beforeX: number;
  beforeY: number;
  afterX: number;
  afterY: number;
}

/** Single undoable command that updates cels and/or reference positions across multiple layers (e.g. moving/transforming a group). */
export function multiLayerPatchCommand(
  celPatches: LayerCelPatch[],
  refPatches: LayerRefPatch[],
  label: string,
): Command {
  const bytes = celPatches.reduce((sum, p) => sum + diffByteSize(p.diff), 64) + refPatches.length * 64;
  return {
    label,
    byteSize: bytes,
    do(ctx) {
      for (const p of celPatches) {
        const layer = ctx.doc.layers.find((l) => l.id === p.layerId);
        const cel = layer?.cels[p.frame];
        if (cel) {
          applyDiff(cel, ctx.doc.w, p.diff, 'after');
          ctx.markDirty(p.frame);
        }
      }
      for (const r of refPatches) {
        const layer = ctx.doc.layers.find((l) => l.id === r.layerId);
        if (layer?.ref) {
          layer.ref.x = r.afterX;
          layer.ref.y = r.afterY;
          ctx.markDirty();
        }
      }
    },
    undo(ctx) {
      for (const p of celPatches) {
        const layer = ctx.doc.layers.find((l) => l.id === p.layerId);
        const cel = layer?.cels[p.frame];
        if (cel) {
          applyDiff(cel, ctx.doc.w, p.diff, 'before');
          ctx.markDirty(p.frame);
        }
      }
      for (const r of refPatches) {
        const layer = ctx.doc.layers.find((l) => l.id === r.layerId);
        if (layer?.ref) {
          layer.ref.x = r.beforeX;
          layer.ref.y = r.beforeY;
          ctx.markDirty();
        }
      }
    },
  };
}

export function toggleAllLayerModifiersCommand(layerId: string, enabled: boolean): Command {
  let prev: boolean[] | null = null;
  return {
    label: enabled ? 'Show layer effects' : 'Hide layer effects',
    layerId,
    byteSize: 128,
    do(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer) return;
      if (!prev) prev = layer.modifiers.map((m) => m.enabled);
      for (const m of layer.modifiers) m.enabled = enabled;
      ctx.markDirty();
    },
    undo(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer || !prev) return;
      layer.modifiers.forEach((m, i) => {
        if (prev && i < prev.length) m.enabled = prev[i];
      });
      ctx.markDirty();
    },
  };
}

export function addReferenceLayerCommand(name: string, ref: ReferenceImage): Command {
  let created: Layer | null = null;
  let prevLayerId = '';
  const bytes = ref.pixels.byteLength + ref.dataUrl.length + 256;
  return {
    label: 'Add reference image',
    byteSize: bytes,
    do(ctx) {
      prevLayerId = ctx.getActiveLayerId();
      if (!created) created = createReferenceLayer(ctx.doc, name, ref);
      ctx.doc.layers.push(cloneLayer(created, false));
      ctx.setActiveLayerId(created.id);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!created) return;
      ctx.doc.layers = ctx.doc.layers.filter((l) => l.id !== created?.id);
      if (prevLayerId && ctx.doc.layers.some((l) => l.id === prevLayerId)) {
        ctx.setActiveLayerId(prevLayerId);
      }
      ctx.markDirty();
    },
  };
}

export interface ReferencePropsPatch {
  x?: number;
  y?: number;
  scale?: number;
  smooth?: boolean;
  flipX?: boolean;
  flipY?: boolean;
}

export function referencePropCommand(
  layerId: string,
  patch: ReferencePropsPatch,
  label: string,
): Command {
  let before: ReferencePropsPatch | null = null;
  return {
    label,
    layerId,
    byteSize: 128,
    do(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer?.ref) return;
      if (!before) {
        before = {};
        if (patch.x !== undefined) before.x = layer.ref.x;
        if (patch.y !== undefined) before.y = layer.ref.y;
        if (patch.scale !== undefined) before.scale = layer.ref.scale;
        if (patch.smooth !== undefined) before.smooth = layer.ref.smooth;
        if (patch.flipX !== undefined) before.flipX = layer.ref.flipX;
        if (patch.flipY !== undefined) before.flipY = layer.ref.flipY;
      }
      Object.assign(layer.ref, patch);
      ctx.markDirty();
    },
    undo(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer?.ref || !before) return;
      Object.assign(layer.ref, before);
      ctx.markDirty();
    },
  };
}

export function addPaletteCommand(name: string, colors: RGBA[]): Command {
  let created: Palette | null = null;
  let prevActiveId = '';
  return {
    label: `New palette: ${name}`,
    scope: 'settings',
    byteSize: colors.length * 16 + 128,
    do(ctx) {
      prevActiveId = ctx.doc.activePaletteId;
      if (!created) created = createPalette(name, colors);
      ctx.doc.palettes.push(clonePalette(created, false));
      ctx.doc.activePaletteId = created.id;
      ctx.markDirty();
    },
    undo(ctx) {
      if (!created) return;
      ctx.doc.palettes = ctx.doc.palettes.filter((p) => p.id !== created?.id);
      if (prevActiveId && ctx.doc.palettes.some((p) => p.id === prevActiveId)) {
        ctx.doc.activePaletteId = prevActiveId;
      }
      ctx.markDirty();
    },
  };
}

export function removePaletteCommand(paletteId: string): Command {
  let saved: Palette | null = null;
  let savedIdx = -1;
  let prevActive = '';
  return {
    label: 'Delete palette',
    scope: 'settings',
    byteSize: 512,
    do(ctx) {
      if (ctx.doc.palettes.length <= 1) return;
      const idx = ctx.doc.palettes.findIndex((p) => p.id === paletteId);
      if (idx < 0) return;
      prevActive = ctx.doc.activePaletteId;
      savedIdx = idx;
      saved = clonePalette(ctx.doc.palettes[idx], false);
      ctx.doc.palettes.splice(idx, 1);
      if (ctx.doc.activePaletteId === paletteId) {
        ctx.doc.activePaletteId = ctx.doc.palettes[Math.min(idx, ctx.doc.palettes.length - 1)].id;
      }
      ctx.markDirty();
    },
    undo(ctx) {
      if (!saved || savedIdx < 0) return;
      ctx.doc.palettes.splice(savedIdx, 0, clonePalette(saved, false));
      ctx.doc.activePaletteId = prevActive;
      ctx.markDirty();
    },
  };
}

export function renamePaletteCommand(paletteId: string, newName: string): Command {
  let prevName = '';
  return {
    label: 'Rename palette',
    scope: 'settings',
    byteSize: 128,
    do(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p) return;
      if (!prevName) prevName = p.name;
      p.name = newName;
      ctx.markDirty();
    },
    undo(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p) return;
      p.name = prevName;
      ctx.markDirty();
    },
  };
}

export function setActivePaletteCommand(paletteId: string): Command {
  let prevId = '';
  return {
    label: 'Switch palette',
    scope: 'settings',
    byteSize: 64,
    do(ctx) {
      if (!ctx.doc.palettes.some((p) => p.id === paletteId)) return;
      if (!prevId) prevId = ctx.doc.activePaletteId;
      ctx.doc.activePaletteId = paletteId;
      ctx.markDirty();
    },
    undo(ctx) {
      if (prevId && ctx.doc.palettes.some((p) => p.id === prevId)) {
        ctx.doc.activePaletteId = prevId;
        ctx.markDirty();
      }
    },
  };
}

function cloneEntries(entries: PaletteEntry[]): PaletteEntry[] {
  return entries.map((e) => ({ rgba: [e.rgba[0], e.rgba[1], e.rgba[2], e.rgba[3]], locked: Boolean(e.locked) }));
}

export function replacePaletteColorsCommand(paletteId: string, colors: RGBA[], label = 'Replace palette'): Command {
  let before: PaletteEntry[] | null = null;
  let after: PaletteEntry[] | null = null;
  return {
    label,
    scope: 'settings',
    byteSize: colors.length * 16 + 256,
    do(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p) return;
      if (!before) {
        before = cloneEntries(p.colors);
        // Preserve locked swatches per F-PALETTE ("Lock icon on swatch prevents deletion/remap")
        const locked = p.colors.filter((e) => e.locked).map((e) => ({ rgba: [...e.rgba] as RGBA, locked: true }));
        const incoming: PaletteEntry[] = colors
          .filter((c) => !locked.some((l) => rgbaEqual(l.rgba, c)))
          .map((c) => ({ rgba: [c[0], c[1], c[2], c[3]], locked: false }));
        after = [...locked, ...incoming];
      }
      if (after) p.colors = cloneEntries(after);
      ctx.markDirty();
    },
    undo(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p || !before) return;
      p.colors = cloneEntries(before);
      ctx.markDirty();
    },
  };
}

export function appendPaletteColorsCommand(paletteId: string, colors: RGBA[], label = 'Add to palette'): Command {
  let before: PaletteEntry[] | null = null;
  let after: PaletteEntry[] | null = null;
  return {
    label,
    scope: 'settings',
    byteSize: colors.length * 16 + 256,
    do(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p) return;
      if (!before) {
        before = cloneEntries(p.colors);
        const next = cloneEntries(p.colors);
        for (const c of colors) {
          if (!next.some((e) => rgbaEqual(e.rgba, c))) {
            next.push({ rgba: [c[0], c[1], c[2], c[3]], locked: false });
          }
        }
        after = next;
      }
      if (after) p.colors = cloneEntries(after);
      ctx.markDirty();
    },
    undo(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p || !before) return;
      p.colors = cloneEntries(before);
      ctx.markDirty();
    },
  };
}

export function removeSwatchCommand(paletteId: string, index: number): Command {
  let saved: PaletteEntry | null = null;
  return {
    label: 'Remove swatch',
    scope: 'settings',
    byteSize: 64,
    do(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p || index < 0 || index >= p.colors.length) return;
      if (p.colors[index].locked) return;
      saved = { rgba: [...p.colors[index].rgba] as RGBA, locked: p.colors[index].locked };
      p.colors.splice(index, 1);
      ctx.markDirty();
    },
    undo(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p || !saved) return;
      p.colors.splice(index, 0, { rgba: [...saved.rgba] as RGBA, locked: saved.locked });
      ctx.markDirty();
    },
  };
}

export function reorderSwatchCommand(paletteId: string, fromIdx: number, toIdx: number): Command {
  return {
    label: 'Reorder swatch',
    scope: 'settings',
    byteSize: 64,
    do(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p || fromIdx < 0 || toIdx < 0 || fromIdx >= p.colors.length || toIdx >= p.colors.length || fromIdx === toIdx) return;
      const [moved] = p.colors.splice(fromIdx, 1);
      p.colors.splice(toIdx, 0, moved);
      ctx.markDirty();
    },
    undo(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p || fromIdx < 0 || toIdx < 0 || fromIdx >= p.colors.length || toIdx >= p.colors.length || fromIdx === toIdx) return;
      const [moved] = p.colors.splice(toIdx, 1);
      p.colors.splice(fromIdx, 0, moved);
      ctx.markDirty();
    },
  };
}

export function toggleSwatchLockCommand(paletteId: string, index: number): Command {
  let prevLocked = false;
  let captured = false;
  return {
    label: 'Toggle swatch lock',
    scope: 'settings',
    byteSize: 64,
    do(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p || index < 0 || index >= p.colors.length) return;
      if (!captured) {
        prevLocked = Boolean(p.colors[index].locked);
        captured = true;
      }
      p.colors[index].locked = !prevLocked;
      ctx.markDirty();
    },
    undo(ctx) {
      const p = ctx.doc.palettes.find((x) => x.id === paletteId);
      if (!p || index < 0 || index >= p.colors.length) return;
      p.colors[index].locked = prevLocked;
      ctx.markDirty();
    },
  };
}

// ---- P5 Tile Builder & Map Editor Commands ----

export function setTileSizeCommand(tileW: number, tileH: number): Command {
  validateTileDim(tileW, tileH);
  let prevW = 16;
  let prevH = 16;
  let prevTiles: TileDef[] | null = null;
  let prevMapLayers: TileMapLayer[] | null = null;
  return {
    label: `Set tile size ${tileW}×${tileH}`,
    byteSize: 512,
    do(ctx) {
      if (!prevTiles) {
        prevW = ctx.doc.tileset.tileW;
        prevH = ctx.doc.tileset.tileH;
        prevTiles = ctx.doc.tileset.tiles.map((t) => cloneTileDef(t, false));
        prevMapLayers = ctx.doc.tilemap.layers.map((l) => cloneMapLayer(l, false));
      }
      ctx.doc.tileset.tileW = tileW;
      ctx.doc.tileset.tileH = tileH;
      if (tileW !== prevW || tileH !== prevH) {
        ctx.doc.tileset.tiles = [];
        for (const ml of ctx.doc.tilemap.layers) ml.data.fill(0);
      }
      ctx.markDirty();
    },
    undo(ctx) {
      if (!prevTiles || !prevMapLayers) return;
      ctx.doc.tileset.tileW = prevW;
      ctx.doc.tileset.tileH = prevH;
      ctx.doc.tileset.tiles = prevTiles.map((t) => cloneTileDef(t, false));
      ctx.doc.tilemap.layers = prevMapLayers.map((l) => cloneMapLayer(l, false));
      ctx.markDirty();
    },
  };
}

export function addTileCommand(tile: TileDef): Command {
  const snap = cloneTileDef(tile, false);
  return {
    label: `Add tile: ${tile.name}`,
    byteSize: tile.pixels.byteLength + 128,
    do(ctx) {
      ctx.doc.tileset.tiles.push(cloneTileDef(snap, false));
      ctx.markDirty();
    },
    undo(ctx) {
      ctx.doc.tileset.tiles = ctx.doc.tileset.tiles.filter((t) => t.id !== snap.id);
      ctx.markDirty();
    },
  };
}

export function removeTileCommand(tileId: string): Command {
  let savedTile: TileDef | null = null;
  let savedIdx = -1;
  let prevMapLayers: TileMapLayer[] | null = null;
  return {
    label: 'Delete tile',
    byteSize: 512,
    do(ctx) {
      const idx = ctx.doc.tileset.tiles.findIndex((t) => t.id === tileId);
      if (idx < 0) return;
      if (!savedTile) {
        savedIdx = idx;
        savedTile = cloneTileDef(ctx.doc.tileset.tiles[idx], false);
        prevMapLayers = ctx.doc.tilemap.layers.map((l) => cloneMapLayer(l, false));
      }
      const removedOneBased = idx + 1;
      ctx.doc.tileset.tiles.splice(idx, 1);
      for (const ml of ctx.doc.tilemap.layers) {
        for (let i = 0; i < ml.data.length; i++) {
          if (ml.data[i] === removedOneBased) ml.data[i] = 0;
          else if (ml.data[i] > removedOneBased) ml.data[i] -= 1;
        }
      }
      ctx.markDirty();
    },
    undo(ctx) {
      if (!savedTile || savedIdx < 0 || !prevMapLayers) return;
      ctx.doc.tileset.tiles.splice(savedIdx, 0, cloneTileDef(savedTile, false));
      ctx.doc.tilemap.layers = prevMapLayers.map((l) => cloneMapLayer(l, false));
      ctx.markDirty();
    },
  };
}

export function updateTileMetaCommand(
  tileId: string,
  patch: { name?: string; category?: TileCategory; linked?: boolean },
  label = 'Update tile',
): Command {
  let beforeSnap: TileDef | null = null;
  let afterSnap: TileDef | null = null;
  return {
    label,
    byteSize: 256,
    do(ctx) {
      const idx = ctx.doc.tileset.tiles.findIndex((t) => t.id === tileId);
      if (idx < 0) return;
      const cur = ctx.doc.tileset.tiles[idx];
      if (!beforeSnap) {
        beforeSnap = cloneTileDef(cur, false);
        const next = cloneTileDef(cur, false);
        if (patch.name !== undefined) next.name = patch.name;
        if (patch.category !== undefined) next.category = patch.category;
        if (patch.linked !== undefined) {
          // When unlinking, freeze current resolved pixels into tile.pixels
          if (!patch.linked && cur.linked) {
            const frozen = resolveTilePixels(ctx.doc, cur);
            next.pixels = frozen.slice();
            next.hash = hashRgba(next.pixels);
          }
          next.linked = patch.linked && Boolean(next.source);
        }
        afterSnap = next;
      }
      if (afterSnap) ctx.doc.tileset.tiles[idx] = cloneTileDef(afterSnap, false);
      ctx.markDirty();
    },
    undo(ctx) {
      const idx = ctx.doc.tileset.tiles.findIndex((t) => t.id === tileId);
      if (idx < 0 || !beforeSnap) return;
      ctx.doc.tileset.tiles[idx] = cloneTileDef(beforeSnap, false);
      ctx.markDirty();
    },
  };
}

export function setMapLayerDataCommand(
  layerId: string,
  before: number[],
  after: number[],
  label = 'Edit tile map',
): Command {
  const bCopy = before.slice();
  const aCopy = after.slice();
  return {
    label,
    byteSize: (bCopy.length + aCopy.length) * 4 + 64,
    do(ctx) {
      const ml = ctx.doc.tilemap.layers.find((l) => l.id === layerId);
      if (!ml) return;
      ml.data = aCopy.slice();
      ctx.markDirty();
    },
    undo(ctx) {
      const ml = ctx.doc.tilemap.layers.find((l) => l.id === layerId);
      if (!ml) return;
      ml.data = bCopy.slice();
      ctx.markDirty();
    },
  };
}

export function addMapLayerCommand(name?: string): Command {
  let created: TileMapLayer | null = null;
  return {
    label: 'Add map layer',
    byteSize: 256,
    do(ctx) {
      if (!created) {
        const lbl = name?.trim() || `Layer ${ctx.doc.tilemap.layers.length + 1}`;
        created = createMapLayer(lbl, ctx.doc.tilemap.width, ctx.doc.tilemap.height);
      }
      ctx.doc.tilemap.layers.push(cloneMapLayer(created, false));
      ctx.markDirty();
    },
    undo(ctx) {
      if (!created) return;
      ctx.doc.tilemap.layers = ctx.doc.tilemap.layers.filter((l) => l.id !== created?.id);
      ctx.markDirty();
    },
  };
}

export function removeMapLayerCommand(layerId: string): Command {
  let saved: TileMapLayer | null = null;
  let savedIdx = -1;
  return {
    label: 'Delete map layer',
    byteSize: 256,
    do(ctx) {
      if (ctx.doc.tilemap.layers.length <= 1) return;
      const idx = ctx.doc.tilemap.layers.findIndex((l) => l.id === layerId);
      if (idx < 0) return;
      savedIdx = idx;
      saved = cloneMapLayer(ctx.doc.tilemap.layers[idx], false);
      ctx.doc.tilemap.layers.splice(idx, 1);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!saved || savedIdx < 0) return;
      ctx.doc.tilemap.layers.splice(savedIdx, 0, cloneMapLayer(saved, false));
      ctx.markDirty();
    },
  };
}

export function toggleMapLayerVisibleCommand(layerId: string): Command {
  let prev = true;
  let captured = false;
  return {
    label: 'Toggle map layer visibility',
    byteSize: 64,
    do(ctx) {
      const ml = ctx.doc.tilemap.layers.find((l) => l.id === layerId);
      if (!ml) return;
      if (!captured) {
        prev = ml.visible;
        captured = true;
      }
      ml.visible = !prev;
      ctx.markDirty();
    },
    undo(ctx) {
      const ml = ctx.doc.tilemap.layers.find((l) => l.id === layerId);
      if (!ml || !captured) return;
      ml.visible = prev;
      ctx.markDirty();
    },
  };
}

export function resizeTileMapCommand(newW: number, newH: number): Command {
  validateMapDim(newW, newH);
  let prevW = 0;
  let prevH = 0;
  let prevLayers: TileMapLayer[] | null = null;
  return {
    label: `Resize map ${newW}×${newH}`,
    byteSize: 512,
    do(ctx) {
      if (!prevLayers) {
        prevW = ctx.doc.tilemap.width;
        prevH = ctx.doc.tilemap.height;
        prevLayers = ctx.doc.tilemap.layers.map((l) => cloneMapLayer(l, false));
      }
      for (const ml of ctx.doc.tilemap.layers) {
        ml.data = resizeTileMapData(ml.data, ctx.doc.tilemap.width, ctx.doc.tilemap.height, newW, newH);
      }
      ctx.doc.tilemap.width = newW;
      ctx.doc.tilemap.height = newH;
      ctx.markDirty();
    },
    undo(ctx) {
      if (!prevLayers) return;
      ctx.doc.tilemap.width = prevW;
      ctx.doc.tilemap.height = prevH;
      ctx.doc.tilemap.layers = prevLayers.map((l) => cloneMapLayer(l, false));
      ctx.markDirty();
    },
  };
}

// ---- P6 Per-Layer Frame Count Command ----

export function setLayerFrameCountCommand(layerId: string, nextCount: number): Command {
  const target = Math.max(1, Math.min(256, Math.round(nextCount)));
  let prevCels: Uint8ClampedArray[] | null = null;
  let computedBytes = 512;
  return {
    label: `Set layer cels (${target})`,
    layerId,
    get byteSize() {
      return computedBytes;
    },
    do(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer || layer.kind === 'reference') return;
      if (!prevCels) {
        prevCels = layer.cels.map((c) => c.slice());
        computedBytes = prevCels.reduce((s, c) => s + c.byteLength, 128);
      }
      setLayerCelCount(ctx.doc, layer, target);
      ctx.markDirty();
    },
    undo(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer || !prevCels) return;
      layer.cels = prevCels.map((c) => c.slice());
      ctx.markDirty();
    },
  };
}

export function addImagePixelLayerCommand(name: string, pixels: Uint8ClampedArray): Command {
  let created: Layer | null = null;
  let prevLayerId = '';
  const pxCopy = pixels.slice();
  return {
    label: `Import image layer: ${name}`,
    byteSize: pxCopy.byteLength + 256,
    do(ctx) {
      prevLayerId = ctx.getActiveLayerId();
      if (!created) {
        created = createLayer(ctx.doc, name);
        const f = Math.max(0, Math.min(created.cels.length - 1, ctx.getActiveFrame()));
        created.cels[f].set(pxCopy);
      }
      ctx.doc.layers.push(cloneLayer(created, false));
      ctx.setActiveLayerId(created.id);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!created) return;
      ctx.doc.layers = ctx.doc.layers.filter((l) => l.id !== created?.id);
      if (prevLayerId && ctx.doc.layers.some((l) => l.id === prevLayerId)) {
        ctx.setActiveLayerId(prevLayerId);
      }
      ctx.markDirty();
    },
  };
}

export function soloLayerVisibilityCommand(layerId: string): Command {
  let prevVis: { id: string; visible: boolean }[] | null = null;
  let nextVis: { id: string; visible: boolean }[] | null = null;
  return {
    label: 'Solo layer visibility',
    layerId,
    byteSize: 128,
    do(ctx) {
      if (!prevVis) {
        prevVis = ctx.doc.layers.map((l) => ({ id: l.id, visible: l.visible }));
        const alreadySolo = ctx.doc.layers.every((l) => (l.id === layerId ? l.visible : !l.visible));
        nextVis = ctx.doc.layers.map((l) => ({
          id: l.id,
          visible: alreadySolo ? true : l.id === layerId,
        }));
      }
      for (const entry of nextVis ?? []) {
        const l = ctx.doc.layers.find((x) => x.id === entry.id);
        if (l) l.visible = entry.visible;
      }
      ctx.markDirty();
    },
    undo(ctx) {
      for (const entry of prevVis ?? []) {
        const l = ctx.doc.layers.find((x) => x.id === entry.id);
        if (l) l.visible = entry.visible;
      }
      ctx.markDirty();
    },
  };
}

// ---- Layer Groups & Layer/Effect Masks (Photoshop-style) ----

export function groupLayersCommand(layerIds: string[], name?: string): Command {
  let group: LayerGroup | null = null;
  let beforeOrder: Layer[] | null = null;
  let beforeGroupIds = new Map<string, string | undefined>();
  let beforeGroups: LayerGroup[] | undefined;
  return {
    label: 'Group layers',
    byteSize: 384,
    do(ctx) {
      const targetSet = new Set(layerIds);
      const targets = ctx.doc.layers.filter((l) => targetSet.has(l.id));
      if (targets.length === 0) return;
      if (!ctx.doc.groups) ctx.doc.groups = [];
      if (!group) {
        beforeOrder = [...ctx.doc.layers];
        beforeGroupIds = new Map(ctx.doc.layers.map((l) => [l.id, l.groupId]));
        beforeGroups = ctx.doc.groups.map((g) => ({ ...g }));
        group = {
          id: uid(),
          name: name?.trim() || `Group ${ctx.doc.groups.length + 1}`,
          visible: true,
          collapsed: false,
          opacity: 100,
        };
      }
      if (!ctx.doc.groups.some((g) => g.id === group?.id)) {
        ctx.doc.groups.push({ ...group });
      }
      // Keep grouped layers contiguous at the topmost selected layer's position (Photoshop-style)
      const highestIdx = Math.max(...targets.map((t) => ctx.doc.layers.indexOf(t)));
      const nonTargetsAbove = ctx.doc.layers.slice(highestIdx + 1).filter((l) => !targetSet.has(l.id));
      const nonTargetsBelow = ctx.doc.layers.slice(0, highestIdx + 1).filter((l) => !targetSet.has(l.id));
      for (const t of targets) t.groupId = group.id;
      ctx.doc.layers = [...nonTargetsBelow, ...targets, ...nonTargetsAbove];
      const used = new Set(ctx.doc.layers.map((l) => l.groupId));
      ctx.doc.groups = ctx.doc.groups.filter((g) => used.has(g.id));
      ctx.markDirty();
    },
    undo(ctx) {
      if (!group || !beforeOrder) return;
      ctx.doc.layers = [...beforeOrder];
      for (const l of ctx.doc.layers) l.groupId = beforeGroupIds.get(l.id);
      ctx.doc.groups = beforeGroups ? beforeGroups.map((g) => ({ ...g })) : [];
      ctx.markDirty();
    },
  };
}

export function ungroupLayersCommand(groupId: string): Command {
  let savedGroup: LayerGroup | null = null;
  let memberIds: string[] = [];
  return {
    label: 'Ungroup layers',
    byteSize: 256,
    do(ctx) {
      const grp = ctx.doc.groups?.find((g) => g.id === groupId);
      if (!grp) return;
      if (!savedGroup) {
        savedGroup = { ...grp };
        memberIds = ctx.doc.layers.filter((l) => l.groupId === groupId).map((l) => l.id);
      }
      for (const id of memberIds) {
        const l = ctx.doc.layers.find((x) => x.id === id);
        if (l) l.groupId = undefined;
      }
      if (ctx.doc.groups) ctx.doc.groups = ctx.doc.groups.filter((g) => g.id !== groupId);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!savedGroup) return;
      if (!ctx.doc.groups) ctx.doc.groups = [];
      ctx.doc.groups.push({ ...savedGroup });
      for (const id of memberIds) {
        const l = ctx.doc.layers.find((x) => x.id === id);
        if (l) l.groupId = savedGroup.id;
      }
      ctx.markDirty();
    },
  };
}

/**
 * Moves layers to `insertAt` (index into the layer list with the moved layers removed)
 * and assigns them to `groupId` (undefined = no group). Empty groups are dropped.
 */
export function moveLayersCommand(layerIds: string[], insertAt: number, groupId: string | undefined, label = 'Move layers'): Command {
  let beforeOrder: Layer[] | null = null;
  let beforeGroupIds = new Map<string, string | undefined>();
  let beforeGroups: LayerGroup[] | undefined;
  return {
    label,
    byteSize: 512,
    do(ctx) {
      if (!beforeOrder) {
        beforeOrder = [...ctx.doc.layers];
        beforeGroupIds = new Map(ctx.doc.layers.map((l) => [l.id, l.groupId]));
        beforeGroups = ctx.doc.groups?.map((g) => ({ ...g }));
      }
      const ids = new Set(layerIds);
      const moved = ctx.doc.layers.filter((l) => ids.has(l.id));
      const rest = ctx.doc.layers.filter((l) => !ids.has(l.id));
      const at = Math.max(0, Math.min(insertAt, rest.length));
      for (const l of moved) l.groupId = groupId;
      ctx.doc.layers = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
      if (ctx.doc.groups) {
        const used = new Set(ctx.doc.layers.map((l) => l.groupId));
        ctx.doc.groups = ctx.doc.groups.filter((g) => used.has(g.id));
      }
      ctx.markDirty();
    },
    undo(ctx) {
      if (!beforeOrder) return;
      ctx.doc.layers = [...beforeOrder];
      for (const l of ctx.doc.layers) l.groupId = beforeGroupIds.get(l.id);
      if (beforeGroups) ctx.doc.groups = beforeGroups.map((g) => ({ ...g }));
      ctx.markDirty();
    },
  };
}

export function groupPropCommand(
  groupId: string,
  patch: Partial<Pick<LayerGroup, 'name' | 'visible' | 'collapsed' | 'opacity'>>,
  label: string,
): Command {
  let before: Partial<LayerGroup> | null = null;
  return {
    label,
    byteSize: 128,
    do(ctx) {
      const g = ctx.doc.groups?.find((x) => x.id === groupId);
      if (!g) return;
      if (!before) {
        before = {};
        if (patch.name !== undefined) before.name = g.name;
        if (patch.visible !== undefined) before.visible = g.visible;
        if (patch.collapsed !== undefined) before.collapsed = g.collapsed;
        if (patch.opacity !== undefined) before.opacity = g.opacity;
      }
      Object.assign(g, patch);
      ctx.markDirty();
    },
    undo(ctx) {
      const g = ctx.doc.groups?.find((x) => x.id === groupId);
      if (!g || !before) return;
      Object.assign(g, before);
      ctx.markDirty();
    },
  };
}

export function setLayerMaskCommand(
  layerId: string,
  nextMask: Uint8Array | undefined,
  label: string,
  maskEnabled?: boolean,
): Command {
  let prevMask: Uint8Array | undefined;
  let prevEnabled: boolean | undefined;
  let captured = false;
  const nextSnap = nextMask ? nextMask.slice() : undefined;
  return {
    label,
    layerId,
    byteSize: (nextSnap?.byteLength ?? 0) + 128,
    do(ctx) {
      const l = ctx.doc.layers.find((x) => x.id === layerId);
      if (!l) return;
      if (!captured) {
        prevMask = l.layerMask ? l.layerMask.slice() : undefined;
        prevEnabled = l.maskEnabled;
        captured = true;
      }
      l.layerMask = nextSnap ? nextSnap.slice() : undefined;
      if (maskEnabled !== undefined) l.maskEnabled = maskEnabled;
      else if (nextSnap && l.maskEnabled === undefined) l.maskEnabled = true;
      ctx.markDirty();
    },
    undo(ctx) {
      const l = ctx.doc.layers.find((x) => x.id === layerId);
      if (!l || !captured) return;
      l.layerMask = prevMask ? prevMask.slice() : undefined;
      l.maskEnabled = prevEnabled;
      ctx.markDirty();
    },
  };
}

export function applyLayerMaskCommand(layerId: string): Command {
  let prevMask: Uint8Array | undefined;
  let prevEnabled: boolean | undefined;
  let prevCels: Uint8ClampedArray[] | null = null;
  let computedBytes = 512;
  return {
    label: 'Apply layer mask',
    layerId,
    get byteSize() {
      return computedBytes;
    },
    do(ctx) {
      const l = ctx.doc.layers.find((x) => x.id === layerId);
      if (!l?.layerMask) return;
      if (!prevCels) {
        prevMask = l.layerMask.slice();
        prevEnabled = l.maskEnabled;
        prevCels = l.cels.map((c) => c.slice());
        computedBytes = prevCels.reduce((s, c) => s + c.byteLength, prevMask.byteLength + 128);
      }
      const mask = l.layerMask;
      for (const cel of l.cels) {
        for (let p = 0; p < mask.length; p++) {
          const m = mask[p];
          if (m >= 255) continue;
          const i = p * 4;
          cel[i + 3] = m <= 0 ? 0 : Math.round((cel[i + 3] * m) / 255);
        }
      }
      l.layerMask = undefined;
      l.maskEnabled = undefined;
      ctx.markDirty();
    },
    undo(ctx) {
      const l = ctx.doc.layers.find((x) => x.id === layerId);
      if (!l || !prevCels) return;
      l.cels = prevCels.map((c) => c.slice());
      l.layerMask = prevMask ? prevMask.slice() : undefined;
      l.maskEnabled = prevEnabled;
      ctx.markDirty();
    },
  };
}

export function setModifierEffectMaskCommand(
  scope: 'layer' | 'doc',
  layerId: string | null,
  modId: string,
  nextMask: Uint8Array | undefined,
  label: string,
): Command {
  let prevMask: Uint8Array | undefined;
  let captured = false;
  const nextSnap = nextMask ? nextMask.slice() : undefined;
  return {
    label,
    layerId: scope === 'layer' && layerId ? layerId : undefined,
    byteSize: (nextSnap?.byteLength ?? 0) + 128,
    do(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      const m = list?.find((x) => x.id === modId);
      if (!m) return;
      if (!captured) {
        prevMask = m.effectMask ? m.effectMask.slice() : undefined;
        captured = true;
      }
      m.effectMask = nextSnap ? nextSnap.slice() : undefined;
      ctx.markDirty();
    },
    undo(ctx) {
      const list = getModifierList(ctx, scope, layerId);
      const m = list?.find((x) => x.id === modId);
      if (!m || !captured) return;
      m.effectMask = prevMask ? prevMask.slice() : undefined;
      ctx.markDirty();
    },
  };
}

// ---- Selection Slices & Batch Tileset Commands ----

export function addSliceCommand(slice: SelectionSlice): Command {
  const snap: SelectionSlice = { ...slice, rect: { ...slice.rect } };
  return {
    label: `Add slice "${snap.name}"`,
    byteSize: 128,
    do(ctx) {
      if (!ctx.doc.slices) ctx.doc.slices = [];
      if (!ctx.doc.slices.some((s) => s.id === snap.id)) {
        ctx.doc.slices.push({ ...snap, rect: { ...snap.rect } });
      }
      ctx.markDirty();
    },
    undo(ctx) {
      if (ctx.doc.slices) {
        ctx.doc.slices = ctx.doc.slices.filter((s) => s.id !== snap.id);
      }
      ctx.markDirty();
    },
  };
}

export function addSlicesBatchCommand(slices: SelectionSlice[], label = 'Auto slice'): Command {
  const snaps = slices.map((s) => ({ ...s, rect: { ...s.rect } }));
  const ids = new Set(snaps.map((s) => s.id));
  return {
    label,
    byteSize: snaps.length * 128 + 64,
    do(ctx) {
      if (!ctx.doc.slices) ctx.doc.slices = [];
      for (const s of snaps) {
        if (!ctx.doc.slices.some((x) => x.id === s.id)) {
          ctx.doc.slices.push({ ...s, rect: { ...s.rect } });
        }
      }
      ctx.markDirty();
    },
    undo(ctx) {
      if (ctx.doc.slices) {
        ctx.doc.slices = ctx.doc.slices.filter((s) => !ids.has(s.id));
      }
      ctx.markDirty();
    },
  };
}

export function removeSliceCommand(sliceId: string): Command {
  let removed: SelectionSlice | null = null;
  let removedIdx = -1;
  return {
    label: 'Delete slice',
    byteSize: 128,
    do(ctx) {
      const list = ctx.doc.slices;
      if (!list) return;
      const idx = list.findIndex((s) => s.id === sliceId);
      if (idx < 0) return;
      removed = { ...list[idx], rect: { ...list[idx].rect } };
      removedIdx = idx;
      list.splice(idx, 1);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!removed) return;
      if (!ctx.doc.slices) ctx.doc.slices = [];
      const at = Math.max(0, Math.min(removedIdx, ctx.doc.slices.length));
      ctx.doc.slices.splice(at, 0, { ...removed, rect: { ...removed.rect } });
      ctx.markDirty();
    },
  };
}

export function renameSliceCommand(sliceId: string, name: string): Command {
  let prev = '';
  const next = name.trim();
  return {
    label: 'Rename slice',
    byteSize: 64,
    do(ctx) {
      const s = ctx.doc.slices?.find((x) => x.id === sliceId);
      if (!s || !next) return;
      if (!prev) prev = s.name;
      s.name = next;
      ctx.markDirty();
    },
    undo(ctx) {
      const s = ctx.doc.slices?.find((x) => x.id === sliceId);
      if (!s || !prev) return;
      s.name = prev;
      ctx.markDirty();
    },
  };
}

export function replaceTilesetCommand(nextTiles: TileDef[], label = 'Create map tileset'): Command {
  let prevTiles: TileDef[] | null = null;
  let prevMapData: number[][] | null = null;
  const nextSnaps = nextTiles.map((t) => cloneTileDef(t, false));
  return {
    label,
    byteSize: nextSnaps.reduce((sum, t) => sum + t.pixels.byteLength + 64, 256),
    do(ctx) {
      if (!prevTiles) {
        prevTiles = ctx.doc.tileset.tiles.map((t) => cloneTileDef(t, false));
        prevMapData = ctx.doc.tilemap.layers.map((ml) => ml.data.slice());
      }
      ctx.doc.tileset.tiles = nextSnaps.map((t) => cloneTileDef(t, false));
      for (const ml of ctx.doc.tilemap.layers) ml.data.fill(0);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!prevTiles || !prevMapData) return;
      ctx.doc.tileset.tiles = prevTiles.map((t) => cloneTileDef(t, false));
      ctx.doc.tilemap.layers.forEach((ml, i) => {
        if (prevMapData && prevMapData[i]) ml.data = prevMapData[i].slice();
      });
      ctx.markDirty();
    },
  };
}

export function bakeJuiceAnimationCommand(
  layerId: string,
  startFrame: number,
  frames: Uint8ClampedArray[],
  frameDurationMs: number,
  animName: string,
): Command {
  const snaps = frames.map((f) => f.slice());
  const dur = Math.max(16, Math.min(10000, Math.round(frameDurationMs)));
  let prevFrameCount = 0;
  let prevDurations: number[] = [];
  let prevLayerCels: Uint8ClampedArray[] | null = null;
  let prevOtherLayerCounts: { id: string; count: number }[] = [];
  let prevActiveFrame = 0;
  let createdAnim: Animation | null = null;
  let captured = false;

  return {
    label: `Bake ${animName} (${snaps.length}f)`,
    byteSize: snaps.reduce((s, f) => s + f.byteLength, 256),
    do(ctx) {
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer || snaps.length === 0) return;
      const neededFrames = startFrame + snaps.length;
      if (!captured) {
        prevFrameCount = ctx.doc.frames.length;
        prevDurations = ctx.doc.frames.map((f) => f.duration);
        prevLayerCels = layer.cels.map((c) => c.slice());
        prevOtherLayerCounts = ctx.doc.layers.map((l) => ({ id: l.id, count: l.cels.length }));
        prevActiveFrame = ctx.getActiveFrame();
        createdAnim = createAnimation(animName, startFrame, neededFrames - 1, 'forward', true);
        captured = true;
      }
      while (ctx.doc.frames.length < neededFrames) {
        ctx.doc.frames.push(createFrame(dur));
      }
      for (const l of ctx.doc.layers) {
        if (l.id === layerId) {
          while (l.cels.length < neededFrames) {
            l.cels.push(new Uint8ClampedArray(ctx.doc.w * ctx.doc.h * 4));
          }
        } else if (l.cels.length === prevFrameCount && neededFrames > prevFrameCount) {
          const lastCel = l.cels[l.cels.length - 1];
          while (l.cels.length < neededFrames) {
            l.cels.push(lastCel ? lastCel.slice() : new Uint8ClampedArray(l.kind === 'reference' ? 4 : ctx.doc.w * ctx.doc.h * 4));
          }
        }
      }
      for (let i = 0; i < snaps.length; i++) {
        const fi = startFrame + i;
        ctx.doc.frames[fi].duration = dur;
        layer.cels[fi] = snaps[i].slice();
      }
      if (createdAnim && !ctx.doc.animations.some((a) => a.id === createdAnim?.id)) {
        ctx.doc.animations.push({ ...createdAnim });
      }
      ctx.setActiveFrame(startFrame);
      ctx.markDirty();
    },
    undo(ctx) {
      if (!captured || !prevLayerCels) return;
      const layer = ctx.doc.layers.find((l) => l.id === layerId);
      if (!layer) return;
      ctx.doc.frames = ctx.doc.frames.slice(0, prevFrameCount);
      for (let i = 0; i < prevDurations.length && i < ctx.doc.frames.length; i++) {
        ctx.doc.frames[i].duration = prevDurations[i];
      }
      layer.cels = prevLayerCels.map((c) => c.slice());
      for (const entry of prevOtherLayerCounts) {
        if (entry.id === layerId) continue;
        const other = ctx.doc.layers.find((l) => l.id === entry.id);
        if (other && other.cels.length > entry.count) {
          other.cels = other.cels.slice(0, entry.count);
        }
      }
      if (createdAnim) {
        ctx.doc.animations = ctx.doc.animations.filter((a) => a.id !== createdAnim?.id);
      }
      ctx.setActiveFrame(Math.min(prevActiveFrame, ctx.doc.frames.length - 1));
      ctx.markDirty();
    },
  };
}
