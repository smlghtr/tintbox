import { clampAnimationsToFrameCount } from './animation';
import { applyClippingAlpha, compositeLayer, compositeLayerRect } from './blend';
import { BoundsError, ValidationError } from './errors';
import { applyModifiers } from './modifiers';
import { defaultPaletteColors, sampleReferencePixel } from './palette';
import { resampleRgba, type ResampleAlgorithm } from './scale';
import { createDefaultTileMap, createDefaultTileSet } from './tiles';
import type {
  Anchor9,
  Animation,
  ColorMod,
  DitherMod,
  Doc,
  Frame,
  Layer,
  LightingMod,
  Modifier,
  OutlineMod,
  Palette,
  PaletteMapMod,
  Rect,
  ReferenceImage,
  RGBA,
  ShadowMod,
  ToneMod,
} from './types';

export const MAX_DIM = 1024;

export function uid(): string {
  return crypto.randomUUID();
}

export function validateDimensions(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) {
    throw new ValidationError(`Canvas dimensions ${w}x${h} out of range (1..${MAX_DIM}).`);
  }
}

export const blankCel = (w: number, h: number): Uint8ClampedArray => new Uint8ClampedArray(w * h * 4);

/** Map doc frame index into a layer's own cel array (supports per-layer frame counts via modulo loop). */
export function getLayerCelIndex(layer: Layer, frame: number): number {
  const len = layer.cels.length;
  if (len <= 0) return 0;
  return ((frame % len) + len) % len;
}

export function getLayerCel(layer: Layer, frame: number): Uint8ClampedArray | undefined {
  if (layer.cels.length === 0) return undefined;
  return layer.cels[getLayerCelIndex(layer, frame)];
}

/** Resize a pixel layer's independent cel count (1..256), padding with blank cels or trimming. */
export function setLayerCelCount(doc: Doc, layer: Layer, count: number): void {
  if (layer.kind === 'reference') return;
  const target = Math.max(1, Math.min(256, Math.round(count)));
  while (layer.cels.length < target) {
    layer.cels.push(blankCel(doc.w, doc.h));
  }
  if (layer.cels.length > target) {
    layer.cels.length = target;
  }
}

export function createFrame(duration = 125): Frame {
  return { id: uid(), duration: Math.max(16, Math.round(duration)) };
}

export function createPalette(name: string, colors: RGBA[]): Palette {
  return {
    id: uid(),
    name,
    colors: colors.map((c) => ({ rgba: [c[0], c[1], c[2], c[3]], locked: false })),
  };
}

export function clonePalette(p: Palette, freshId = false): Palette {
  return {
    id: freshId ? uid() : p.id,
    name: p.name,
    colors: p.colors.map((e) => ({ rgba: [e.rgba[0], e.rgba[1], e.rgba[2], e.rgba[3]], locked: Boolean(e.locked) })),
  };
}

export function getActivePalette(doc: Doc): Palette {
  return doc.palettes.find((p) => p.id === doc.activePaletteId) ?? doc.palettes[0];
}

export function createDoc(w = 64, h = 64): Doc {
  validateDimensions(w, h);
  const pal = createPalette('Workbench 16', defaultPaletteColors());
  const fps = 8;
  const doc: Doc = {
    version: 1,
    w,
    h,
    frames: [createFrame(Math.round(1000 / fps))],
    fps,
    animations: [],
    layers: [],
    modifiers: [],
    palettes: [pal],
    activePaletteId: pal.id,
    tileset: createDefaultTileSet(16, 16),
    tilemap: createDefaultTileMap(16, 12),
  };
  addLayer(doc);
  return doc;
}

export function createLayer(doc: Doc, name = `Layer ${doc.layers.length + 1}`): Layer {
  return {
    id: uid(),
    name,
    kind: 'pixel',
    visible: true,
    locked: false,
    alphaLock: false,
    clipped: false,
    opacity: 100,
    blend: 'normal',
    cels: Array.from({ length: doc.frames.length }, () => blankCel(doc.w, doc.h)),
    modifiers: [],
  };
}

export function createReferenceLayer(doc: Doc, name: string, ref: ReferenceImage): Layer {
  return {
    id: uid(),
    name,
    kind: 'reference',
    visible: true,
    locked: false,
    alphaLock: false,
    opacity: 60,
    blend: 'normal',
    cels: Array.from({ length: doc.frames.length }, () => blankCel(1, 1)),
    modifiers: [],
    ref: cloneReference(ref),
  };
}

export function cloneReference(ref: ReferenceImage): ReferenceImage {
  return {
    ...ref,
    pixels: ref.pixels.slice(),
  };
}

export function addLayer(doc: Doc, name = `Layer ${doc.layers.length + 1}`): Layer {
  const layer = createLayer(doc, name);
  doc.layers.push(layer);
  return layer;
}

export function cloneModifier(m: Modifier, freshId = false): Modifier {
  const id = freshId ? uid() : m.id;
  const mask = m.mask ? { w: m.mask.w, h: m.mask.h, bits: m.mask.bits.slice() } : undefined;
  const effectMask = m.effectMask ? m.effectMask.slice() : undefined;
  if (m.type === 'color' || m.type === 'palette-map' || m.type === 'dither') return { ...m, id, mask, effectMask };
  if (m.type === 'tone') {
    return {
      ...m,
      id,
      shadowTint: [m.shadowTint[0], m.shadowTint[1], m.shadowTint[2], m.shadowTint[3]],
      highlightTint: [m.highlightTint[0], m.highlightTint[1], m.highlightTint[2], m.highlightTint[3]],
      mask,
      effectMask,
    };
  }
  return { ...m, id, color: [m.color[0], m.color[1], m.color[2], m.color[3]], mask, effectMask };
}

export function cloneLayer(layer: Layer, freshIds = false): Layer {
  return {
    ...layer,
    id: freshIds ? uid() : layer.id,
    layerMask: layer.layerMask ? layer.layerMask.slice() : undefined,
    cels: layer.cels.map((c) => c.slice()),
    modifiers: layer.modifiers.map((m) => cloneModifier(m, freshIds)),
    ref: layer.ref ? cloneReference(layer.ref) : undefined,
  };
}

export function cloneDoc(doc: Doc): Doc {
  return {
    ...doc,
    frames: doc.frames.map((f) => ({ ...f })),
    animations: doc.animations.map((a) => ({ ...a })),
    layers: doc.layers.map((l) => cloneLayer(l, false)),
    groups: doc.groups ? doc.groups.map((g) => ({ ...g })) : undefined,
    modifiers: doc.modifiers.map((m) => cloneModifier(m, false)),
    palettes: doc.palettes.map((p) => clonePalette(p, false)),
  };
}

export function duplicateLayer(doc: Doc, id: string): Layer | null {
  const idx = doc.layers.findIndex((l) => l.id === id);
  if (idx < 0) return null;
  const copy = cloneLayer(doc.layers[idx], true);
  copy.name = `${doc.layers[idx].name} copy`;
  doc.layers.splice(idx + 1, 0, copy);
  return copy;
}

export function removeLayer(doc: Doc, id: string): boolean {
  if (doc.layers.length <= 1) return false;
  const idx = doc.layers.findIndex((l) => l.id === id);
  if (idx < 0) return false;
  doc.layers.splice(idx, 1);
  return true;
}

export function reorderLayer(doc: Doc, fromIndex: number, toIndex: number): boolean {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= doc.layers.length ||
    toIndex >= doc.layers.length ||
    fromIndex === toIndex
  ) {
    return false;
  }
  const [moved] = doc.layers.splice(fromIndex, 1);
  doc.layers.splice(toIndex, 0, moved);
  return true;
}

export function mergeDown(doc: Doc, index: number): Layer | null {
  if (index <= 0 || index >= doc.layers.length) return null;
  const upper = doc.layers[index];
  const lower = doc.layers[index - 1];
  if (upper.kind === 'reference' || lower.kind === 'reference') return null;
  const mergedCels: Uint8ClampedArray[] = [];
  for (let f = 0; f < doc.frames.length; f++) {
    const dst = blankCel(doc.w, doc.h);
    const lCel = getLayerCel(lower, f);
    if (lCel) {
      const lowerPx = applyModifiers(lCel, doc.w, doc.h, lower.modifiers);
      compositeLayer(dst, lowerPx, doc.w, doc.h, lower.opacity, lower.blend);
    }
    const uCel = getLayerCel(upper, f);
    if (uCel) {
      const upperPx = applyModifiers(uCel, doc.w, doc.h, upper.modifiers);
      compositeLayer(dst, upperPx, doc.w, doc.h, upper.opacity, upper.blend);
    }
    mergedCels.push(dst);
  }
  lower.cels = mergedCels;
  lower.modifiers = [];
  lower.opacity = 100;
  lower.blend = 'normal';
  doc.layers.splice(index, 1);
  return lower;
}

export function flattenVisible(doc: Doc): Layer | null {
  const visibleIndices: number[] = [];
  for (let i = 0; i < doc.layers.length; i++) {
    if (doc.layers[i].visible && doc.layers[i].kind === 'pixel') visibleIndices.push(i);
  }
  if (visibleIndices.length === 0) return null;
  const cels: Uint8ClampedArray[] = [];
  for (let f = 0; f < doc.frames.length; f++) {
    const out = blankCel(doc.w, doc.h);
    let clipBase: Uint8ClampedArray | null = null;
    for (const idx of visibleIndices) {
      const l = doc.layers[idx];
      const cel = getLayerCel(l, f);
      if (!cel) continue;
      let modPx = applyModifiers(cel, doc.w, doc.h, l.modifiers);
      if (l.clipped) {
        if (!clipBase) continue;
        modPx = applyClippingAlpha(modPx, clipBase);
      } else {
        clipBase = modPx;
      }
      compositeLayer(out, modPx, doc.w, doc.h, l.opacity, l.blend);
    }
    cels.push(out);
  }
  const flat: Layer = {
    id: uid(),
    name: 'Flattened',
    kind: 'pixel',
    visible: true,
    locked: false,
    alphaLock: false,
    clipped: false,
    opacity: 100,
    blend: 'normal',
    cels,
    modifiers: [],
  };
  const insertAt = visibleIndices[0];
  doc.layers = doc.layers.filter((l) => !l.visible || l.kind === 'reference');
  doc.layers.splice(Math.min(insertAt, doc.layers.length), 0, flat);
  return flat;
}

export function addFrame(doc: Doc, after: number, copy: boolean, frameObj?: Frame): number {
  const prevLen = doc.frames.length;
  const idx = Math.max(0, Math.min(prevLen - 1, after));
  const dur = copy ? doc.frames[idx].duration : Math.round(1000 / Math.max(1, doc.fps));
  const nextFrame = frameObj ? { ...frameObj } : createFrame(dur);
  doc.frames.splice(idx + 1, 0, nextFrame);
  for (const l of doc.layers) {
    if (l.kind === 'reference') {
      l.cels.splice(idx + 1, 0, blankCel(1, 1));
    } else if (l.cels.length === prevLen) {
      l.cels.splice(idx + 1, 0, copy ? l.cels[idx].slice() : blankCel(doc.w, doc.h));
    }
  }
  return idx + 1;
}

export function removeFrame(doc: Doc, index: number): number {
  const prevLen = doc.frames.length;
  if (prevLen <= 1) return 0;
  if (index < 0 || index >= prevLen) throw new BoundsError(`Frame ${index} out of range.`);
  doc.frames.splice(index, 1);
  for (const l of doc.layers) {
    if (l.cels.length === prevLen && l.cels.length > 1) l.cels.splice(index, 1);
  }
  doc.animations = clampAnimationsToFrameCount(doc.animations, doc.frames.length);
  return Math.min(index, doc.frames.length - 1);
}

export function reorderFrame(doc: Doc, fromIndex: number, toIndex: number): boolean {
  const prevLen = doc.frames.length;
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= prevLen ||
    toIndex >= prevLen ||
    fromIndex === toIndex
  ) {
    return false;
  }
  const [movedFrame] = doc.frames.splice(fromIndex, 1);
  doc.frames.splice(toIndex, 0, movedFrame);
  for (const l of doc.layers) {
    if (l.cels.length === prevLen) {
      const [movedCel] = l.cels.splice(fromIndex, 1);
      l.cels.splice(toIndex, 0, movedCel);
    }
  }
  return true;
}

export function createAnimation(
  name: string,
  from: number,
  to: number,
  direction: Animation['direction'] = 'forward',
  loop = true,
): Animation {
  return { id: uid(), name, from, to, direction, loop };
}

export function anchorOffset(
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
  anchor: Anchor9,
): { ox: number; oy: number } {
  const col = anchor[1];
  const row = anchor[0];
  const ox = col === 'l' ? 0 : col === 'r' ? newW - oldW : Math.floor((newW - oldW) / 2);
  const oy = row === 't' ? 0 : row === 'b' ? newH - oldH : Math.floor((newH - oldH) / 2);
  return { ox, oy };
}

export function resizeCel(
  src: Uint8ClampedArray,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
  ox: number,
  oy: number,
): Uint8ClampedArray {
  const dst = blankCel(newW, newH);
  for (let y = 0; y < oldH; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= newH) continue;
    for (let x = 0; x < oldW; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= newW) continue;
      const si = (y * oldW + x) * 4;
      const di = (dy * newW + dx) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return dst;
}

export function scaleCelNearest(
  src: Uint8ClampedArray,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): Uint8ClampedArray {
  const dst = blankCel(newW, newH);
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(oldH - 1, Math.floor((y * oldH) / newH));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(oldW - 1, Math.floor((x * oldW) / newW));
      const si = (sy * oldW + sx) * 4;
      const di = (y * newW + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return dst;
}

function applyLayerMaskAlpha(px: Uint8ClampedArray, mask: Uint8Array | undefined, enabled: boolean | undefined): Uint8ClampedArray {
  if (!mask || enabled === false || mask.length !== px.length / 4) return px;
  const out = px.slice();
  for (let p = 0; p < mask.length; p++) {
    const m = mask[p];
    if (m >= 255) continue;
    const i = p * 4;
    if (m <= 0) {
      out[i + 3] = 0;
    } else {
      out[i + 3] = Math.round((out[i + 3] * m) / 255);
    }
  }
  return out;
}

export function isLayerVisibleInDoc(doc: Doc, layer: Layer): boolean {
  if (!layer.visible) return false;
  if (!layer.groupId || !doc.groups) return true;
  const grp = doc.groups.find((g) => g.id === layer.groupId);
  return grp ? grp.visible : true;
}

export function effectiveLayerOpacity(doc: Doc, layer: Layer): number {
  if (!layer.groupId || !doc.groups) return layer.opacity;
  const grp = doc.groups.find((g) => g.id === layer.groupId);
  return grp ? Math.round((layer.opacity * grp.opacity) / 100) : layer.opacity;
}

function resizeGrayMask(src: Uint8Array, oldW: number, oldH: number, newW: number, newH: number, ox: number, oy: number): Uint8Array {
  const dst = new Uint8Array(newW * newH).fill(255);
  for (let y = 0; y < oldH; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= newH) continue;
    for (let x = 0; x < oldW; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= newW) continue;
      dst[dy * newW + dx] = src[y * oldW + x];
    }
  }
  return dst;
}

function scaleGrayMask(src: Uint8Array, oldW: number, oldH: number, newW: number, newH: number): Uint8Array {
  const dst = new Uint8Array(newW * newH);
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(oldH - 1, Math.floor((y * oldH) / newH));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(oldW - 1, Math.floor((x * oldW) / newW));
      dst[y * newW + x] = src[sy * oldW + sx];
    }
  }
  return dst;
}

export function resizeDoc(doc: Doc, newW: number, newH: number, anchor: Anchor9): void {
  validateDimensions(newW, newH);
  const { ox, oy } = anchorOffset(doc.w, doc.h, newW, newH, anchor);
  for (const l of doc.layers) {
    if (l.kind === 'reference') continue;
    l.cels = l.cels.map((c) => resizeCel(c, doc.w, doc.h, newW, newH, ox, oy));
    if (l.layerMask) l.layerMask = resizeGrayMask(l.layerMask, doc.w, doc.h, newW, newH, ox, oy);
    for (const m of l.modifiers) {
      m.mask = undefined;
      if (m.effectMask) m.effectMask = resizeGrayMask(m.effectMask, doc.w, doc.h, newW, newH, ox, oy);
    }
  }
  for (const m of doc.modifiers) {
    m.mask = undefined;
    if (m.effectMask) m.effectMask = resizeGrayMask(m.effectMask, doc.w, doc.h, newW, newH, ox, oy);
  }
  doc.w = newW;
  doc.h = newH;
}

export function scaleDoc(
  doc: Doc,
  newW: number,
  newH: number,
  algorithm: ResampleAlgorithm = 'nearest',
): void {
  validateDimensions(newW, newH);
  for (const l of doc.layers) {
    if (l.kind === 'reference') continue;
    l.cels = l.cels.map((c) => resampleRgba(c, doc.w, doc.h, newW, newH, algorithm));
    if (l.layerMask) l.layerMask = scaleGrayMask(l.layerMask, doc.w, doc.h, newW, newH);
    for (const m of l.modifiers) {
      m.mask = undefined;
      if (m.effectMask) m.effectMask = scaleGrayMask(m.effectMask, doc.w, doc.h, newW, newH);
    }
  }
  for (const m of doc.modifiers) {
    m.mask = undefined;
    if (m.effectMask) m.effectMask = scaleGrayMask(m.effectMask, doc.w, doc.h, newW, newH);
  }
  doc.w = newW;
  doc.h = newH;
}

export interface ComposeOpts {
  solo?: { scope: 'layer' | 'doc'; layerId: string | null; modId: string } | null;
  includeHidden?: boolean;
}

/** Layer modifiers run per layer, then doc modifiers run on the flattened frame. Reference layers are excluded. */
export function compose(doc: Doc, frame: number, opts?: ComposeOpts): Uint8ClampedArray {
  const solo = opts?.solo ?? null;
  const includeHidden = Boolean(opts?.includeHidden);
  const pal = getActivePalette(doc)?.colors.map((e) => e.rgba);
  const out = blankCel(doc.w, doc.h);
  let clipBase: Uint8ClampedArray | null = null;
  for (const l of doc.layers) {
    if ((!isLayerVisibleInDoc(doc, l) && !includeHidden) || l.kind === 'reference') continue;
    const cel = getLayerCel(l, frame);
    if (!cel) continue;
    const layerSolo = solo && solo.scope === 'layer' && solo.layerId === l.id ? solo.modId : null;
    let modPx = applyModifiers(cel, doc.w, doc.h, l.modifiers, layerSolo, pal);
    modPx = applyLayerMaskAlpha(modPx, l.layerMask, l.maskEnabled);
    if (l.clipped) {
      if (!clipBase) continue;
      modPx = applyClippingAlpha(modPx, clipBase);
    } else {
      clipBase = modPx;
    }
    compositeLayer(out, modPx, doc.w, doc.h, effectiveLayerOpacity(doc, l), l.blend);
  }
  const docSolo = solo && solo.scope === 'doc' ? solo.modId : null;
  return applyModifiers(out, doc.w, doc.h, doc.modifiers, docSolo, pal);
}

/** Compose a single active pixel layer with its modifiers (for F-ONION active-layer source). */
export function composeLayerOnly(doc: Doc, layer: Layer, frame: number): Uint8ClampedArray {
  if (layer.kind === 'reference') return blankCel(doc.w, doc.h);
  const cel = getLayerCel(layer, frame);
  if (!cel) return blankCel(doc.w, doc.h);
  const pal = getActivePalette(doc)?.colors.map((e) => e.rgba);
  return applyLayerMaskAlpha(applyModifiers(cel, doc.w, doc.h, layer.modifiers, null, pal), layer.layerMask, layer.maskEnabled);
}

export function sampleDocColor(
  doc: Doc,
  frame: number,
  composed: Uint8ClampedArray,
  activeLayer: Layer,
  x: number,
  y: number,
  source: 'composed' | 'layer',
): RGBA | null {
  if (source === 'layer') {
    if (activeLayer.kind === 'reference' && activeLayer.ref) {
      return sampleReferencePixel(activeLayer.ref, x, y);
    }
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return null;
    const cel = getLayerCel(activeLayer, frame);
    if (!cel) return null;
    const i = (y * doc.w + x) * 4;
    if (cel[i + 3] === 0) return null;
    return [cel[i], cel[i + 1], cel[i + 2], cel[i + 3]];
  }

  if (x >= 0 && y >= 0 && x < doc.w && y < doc.h) {
    const ci = (y * doc.w + x) * 4;
    if (composed[ci + 3] > 0) {
      for (let idx = doc.layers.length - 1; idx >= 0; idx--) {
        const l = doc.layers[idx];
        if (!l.visible) continue;
        if (l.kind === 'reference' && l.ref) {
          const refPx = sampleReferencePixel(l.ref, x, y);
          if (refPx) return refPx;
        } else {
          const cel = getLayerCel(l, frame);
          if (cel && cel[ci + 3] > 0) break;
        }
      }
      return [composed[ci], composed[ci + 1], composed[ci + 2], composed[ci + 3]];
    }
  }
  for (let idx = doc.layers.length - 1; idx >= 0; idx--) {
    const l = doc.layers[idx];
    if (!l.visible || l.kind !== 'reference' || !l.ref) continue;
    const refPx = sampleReferencePixel(l.ref, x, y);
    if (refPx) return refPx;
  }
  return null;
}

export function composeRect(doc: Doc, frame: number, target: Uint8ClampedArray, rect: Rect): void {
  const isSpatial = (t: Modifier['type']) => t === 'outline' || t === 'shadow' || t === 'lighting';
  const hasExpanding =
    doc.modifiers.some((m) => m.enabled && isSpatial(m.type)) ||
    doc.layers.some((l) => l.visible && l.kind === 'pixel' && l.modifiers.some((m) => m.enabled && isSpatial(m.type)));

  if (hasExpanding || doc.modifiers.some((m) => m.enabled)) {
    const full = compose(doc, frame);
    target.set(full);
    return;
  }

  const pal = getActivePalette(doc)?.colors.map((e) => e.rgba);
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(doc.w, rect.x + rect.w);
  const y1 = Math.min(doc.h, rect.y + rect.h);
  const clamped: Rect = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  if (clamped.w === 0 || clamped.h === 0) return;

  for (let y = y0; y < y1; y++) {
    target.fill(0, (y * doc.w + x0) * 4, (y * doc.w + x1) * 4);
  }
  let clipBase: Uint8ClampedArray | null = null;
  for (const l of doc.layers) {
    if (!isLayerVisibleInDoc(doc, l) || l.kind === 'reference') continue;
    const cel = getLayerCel(l, frame);
    if (!cel) continue;
    let modPx = applyModifiers(cel, doc.w, doc.h, l.modifiers, null, pal);
    modPx = applyLayerMaskAlpha(modPx, l.layerMask, l.maskEnabled);
    if (l.clipped) {
      if (!clipBase) continue;
      modPx = applyClippingAlpha(modPx, clipBase);
    } else {
      clipBase = modPx;
    }
    compositeLayerRect(target, modPx, doc.w, doc.h, clamped, effectiveLayerOpacity(doc, l), l.blend);
  }
}

/** Fit an imported RGBA image onto a canvas-sized cel using crisp nearest-neighbor scaling (centered). */
export function fitImageToCanvas(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  const out = blankCel(dstW, dstH);
  if (srcW < 1 || srcH < 1) return out;
  const scale = Math.min(1, dstW / srcW, dstH / srcH);
  const tw = Math.max(1, Math.min(dstW, Math.round(srcW * scale)));
  const th = Math.max(1, Math.min(dstH, Math.round(srcH * scale)));
  const ox = Math.floor((dstW - tw) / 2);
  const oy = Math.floor((dstH - th) / 2);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / tw));
      const si = (sy * srcW + sx) * 4;
      const di = ((oy + y) * dstW + (ox + x)) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

export function newModifier(type: Modifier['type']): Modifier {
  if (type === 'color') {
    const m: ColorMod = { id: uid(), type, enabled: true, hue: 0, sat: 0, light: 0, opacity: 100 };
    return m;
  }
  if (type === 'shadow') {
    const m: ShadowMod = { id: uid(), type, enabled: true, offsetX: 1, offsetY: 1, color: [0, 0, 0, 160] };
    return m;
  }
  if (type === 'palette-map') {
    const m: PaletteMapMod = { id: uid(), type, enabled: true, dither: false };
    return m;
  }
  if (type === 'dither') {
    const m: DitherMod = { id: uid(), type, enabled: true, pattern: 'bayer4', levels: 4, strength: 65 };
    return m;
  }
  if (type === 'lighting') {
    const m: LightingMod = {
      id: uid(),
      type,
      enabled: true,
      angle: 315,
      elevation: 45,
      intensity: 70,
      ambient: 35,
      bevel: 3,
      color: [255, 244, 214, 255],
    };
    return m;
  }
  if (type === 'tone') {
    const m: ToneMod = {
      id: uid(),
      type,
      enabled: true,
      shadows: -15,
      highlights: 20,
      contrast: 10,
      shadowTint: [30, 48, 96, 80],
      highlightTint: [255, 240, 190, 80],
    };
    return m;
  }
  const m: OutlineMod = {
    id: uid(),
    type,
    enabled: true,
    mode: 'outer',
    color: [255, 255, 255, 255],
    width: 1,
    connectivity: 4,
    onlyOutsideBounds: false,
  };
  return m;
}
