import { unzlibSync } from 'fflate';
import { createDoc, createFrame, createLayer, createPalette, MAX_DIM, uid } from '../core/doc';
import { ValidationError } from '../core/errors';
import type { AnimDirection, BlendMode, Doc, Layer, RGBA } from '../core/types';

export function isAsepriteBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 128) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(4, true) === 0xa5e0;
}

const ASE_BLEND_MAP: Record<number, BlendMode> = {
  0: 'normal',
  1: 'multiply',
  2: 'screen',
  3: 'overlay',
  4: 'darken',
  5: 'lighten',
  10: 'difference',
  16: 'add',
};

interface RawCel {
  layerIndex: number;
  frameIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  celType: number;
  linkedFrame: number;
  raw: Uint8Array;
}

interface RawLayerMeta {
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  isGroup: boolean;
  isTilemap: boolean;
}

/**
 * Decode an Aseprite (`.ase` / `.aseprite`) binary file into a Tintbox Doc.
 * Preserves layers, frames, durations, tags (named animations), and palette.
 * Supports RGBA (32bpp), Grayscale (16bpp), and Indexed (8bpp) sprites.
 */
export function decodeAseprite(bytes: Uint8Array): Doc {
  if (!isAsepriteBytes(bytes)) {
    throw new ValidationError('Invalid Aseprite file (missing 0xA5E0 header magic).');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameCount = Math.max(1, view.getUint16(6, true));
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const colorDepth = view.getUint16(12, true);
  const defaultSpeed = view.getUint16(16, true) || 100;
  const transparentIdx = bytes[28];

  if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) {
    throw new ValidationError(`Aseprite dimensions ${width}x${height} exceed ${MAX_DIM}px limit.`);
  }
  if (colorDepth !== 32 && colorDepth !== 16 && colorDepth !== 8) {
    throw new ValidationError(`Unsupported Aseprite color depth: ${colorDepth}bpp.`);
  }

  const decoder = new TextDecoder('utf-8');
  const readStr = (off: number): { str: string; next: number } => {
    const len = view.getUint16(off, true);
    const slice = bytes.subarray(off + 2, off + 2 + len);
    return { str: decoder.decode(slice), next: off + 2 + len };
  };

  const palette: RGBA[] = Array.from({ length: 256 }, () => [0, 0, 0, 255] as RGBA);
  let paletteEntries = 0;
  const rawLayers: RawLayerMeta[] = [];
  const rawCels: RawCel[] = [];
  const frameDurations: number[] = [];
  const tags: { name: string; from: number; to: number; direction: AnimDirection }[] = [];

  let offset = 128;
  for (let f = 0; f < frameCount && offset + 16 <= bytes.byteLength; f++) {
    const frameBytes = view.getUint32(offset, true);
    const frameMagic = view.getUint16(offset + 4, true);
    if (frameMagic !== 0xf1fa || frameBytes < 16) {
      throw new ValidationError(`Corrupt Aseprite frame header at frame ${f + 1}.`);
    }
    const oldChunks = view.getUint16(offset + 6, true);
    const duration = view.getUint16(offset + 8, true) || defaultSpeed;
    const newChunks = view.getUint32(offset + 12, true);
    const chunkCount = newChunks !== 0 ? newChunks : oldChunks;
    frameDurations.push(Math.max(10, duration));

    let cOff = offset + 16;
    const frameEnd = Math.min(bytes.byteLength, offset + frameBytes);
    for (let c = 0; c < chunkCount && cOff + 6 <= frameEnd; c++) {
      const chunkSize = view.getUint32(cOff, true);
      const chunkType = view.getUint16(cOff + 4, true);
      if (chunkSize < 6 || cOff + chunkSize > frameEnd) break;
      const dataOff = cOff + 6;
      const dataEnd = cOff + chunkSize;

      if (chunkType === 0x2004 && f === 0 && dataOff + 18 <= dataEnd) {
        // Layer chunk
        const flags = view.getUint16(dataOff, true);
        const layerType = view.getUint16(dataOff + 2, true);
        const blendIdx = view.getUint16(dataOff + 10, true);
        const opacityByte = bytes[dataOff + 12];
        const { str } = readStr(dataOff + 16);
        rawLayers.push({
          name: str || `Layer ${rawLayers.length + 1}`,
          visible: (flags & 1) !== 0,
          locked: (flags & 2) === 0,
          opacity: Math.round((opacityByte / 255) * 100),
          blend: ASE_BLEND_MAP[blendIdx] ?? 'normal',
          isGroup: layerType === 1,
          isTilemap: layerType === 2,
        });
      } else if (chunkType === 0x2005 && dataOff + 16 <= dataEnd) {
        // Cel chunk
        const layerIndex = view.getUint16(dataOff, true);
        const cx = view.getInt16(dataOff + 2, true);
        const cy = view.getInt16(dataOff + 4, true);
        const celType = view.getUint16(dataOff + 7, true);
        if (celType === 1 && dataOff + 18 <= dataEnd) {
          const linkedFrame = view.getUint16(dataOff + 16, true);
          rawCels.push({ layerIndex, frameIndex: f, x: cx, y: cy, w: 0, h: 0, celType, linkedFrame, raw: new Uint8Array(0) });
        } else if ((celType === 0 || celType === 2) && dataOff + 20 <= dataEnd) {
          const cw = view.getUint16(dataOff + 16, true);
          const ch = view.getUint16(dataOff + 18, true);
          const payload = bytes.subarray(dataOff + 20, dataEnd);
          const raw = celType === 2 ? unzlibSync(payload) : payload;
          rawCels.push({ layerIndex, frameIndex: f, x: cx, y: cy, w: cw, h: ch, celType, linkedFrame: -1, raw });
        }
      } else if (chunkType === 0x2019 && dataOff + 20 <= dataEnd) {
        // New Palette chunk
        const newSize = view.getUint32(dataOff, true);
        const firstIdx = view.getUint32(dataOff + 4, true);
        const lastIdx = view.getUint32(dataOff + 8, true);
        paletteEntries = Math.max(paletteEntries, Math.min(256, newSize));
        let pOff = dataOff + 20;
        for (let idx = firstIdx; idx <= lastIdx && pOff + 6 <= dataEnd; idx++) {
          const entryFlags = view.getUint16(pOff, true);
          const r = bytes[pOff + 2];
          const g = bytes[pOff + 3];
          const b = bytes[pOff + 4];
          const a = bytes[pOff + 5];
          pOff += 6;
          if ((entryFlags & 1) !== 0 && pOff + 2 <= dataEnd) {
            pOff = readStr(pOff).next;
          }
          if (idx >= 0 && idx < 256) palette[idx] = [r, g, b, a];
        }
      } else if (chunkType === 0x0004 && paletteEntries === 0 && dataOff + 2 <= dataEnd) {
        // Old palette chunk (fallback)
        const packets = view.getUint16(dataOff, true);
        let pOff = dataOff + 2;
        let idx = 0;
        for (let p = 0; p < packets && pOff + 2 <= dataEnd; p++) {
          idx += bytes[pOff++];
          let count = bytes[pOff++];
          if (count === 0) count = 256;
          for (let k = 0; k < count && pOff + 3 <= dataEnd; k++, idx++) {
            const r = bytes[pOff++];
            const g = bytes[pOff++];
            const b = bytes[pOff++];
            if (idx < 256) {
              palette[idx] = [r, g, b, 255];
              paletteEntries = Math.max(paletteEntries, idx + 1);
            }
          }
        }
      } else if (chunkType === 0x2018 && dataOff + 10 <= dataEnd) {
        // Frame Tags chunk -> Named animations
        const count = view.getUint16(dataOff, true);
        let tOff = dataOff + 10;
        for (let t = 0; t < count && tOff + 17 <= dataEnd; t++) {
          const from = view.getUint16(tOff, true);
          const to = view.getUint16(tOff + 2, true);
          const dirByte = bytes[tOff + 4];
          const direction: AnimDirection = dirByte === 1 ? 'reverse' : dirByte === 2 || dirByte === 3 ? 'pingpong' : 'forward';
          const { str, next } = readStr(tOff + 17);
          tOff = next;
          tags.push({
            name: str || `Tag ${t + 1}`,
            from: Math.max(0, Math.min(frameCount - 1, from)),
            to: Math.max(0, Math.min(frameCount - 1, to)),
            direction,
          });
        }
      }

      cOff += chunkSize;
    }

    offset += frameBytes;
  }

  // Build Doc
  const doc = createDoc(width, height);
  doc.frames = frameDurations.map((d) => createFrame(d));
  doc.fps = Math.max(1, Math.min(60, Math.round(1000 / (frameDurations[0] || 100))));

  if (paletteEntries > 0) {
    const palColors = palette.slice(0, paletteEntries).filter((c) => c[3] > 0);
    if (palColors.length > 0) {
      const p = createPalette('Aseprite Palette', palColors);
      doc.palettes = [p];
      doc.activePaletteId = p.id;
    }
  }

  // Map raw layer indices -> Tintbox pixel layers (skipping group/tilemap headers)
  const layerByRawIdx = new Map<number, Layer>();
  const builtLayers: Layer[] = [];
  rawLayers.forEach((meta, idx) => {
    if (meta.isGroup || meta.isTilemap) return;
    const l = createLayer(doc, meta.name);
    l.visible = meta.visible;
    l.locked = meta.locked;
    l.opacity = meta.opacity;
    l.blend = meta.blend;
    layerByRawIdx.set(idx, l);
    builtLayers.push(l);
  });
  if (builtLayers.length === 0) {
    const fallback = createLayer(doc, 'Layer 1');
    layerByRawIdx.set(0, fallback);
    builtLayers.push(fallback);
  }
  doc.layers = builtLayers;

  const blitRawToCel = (dst: Uint8ClampedArray, cel: RawCel) => {
    const bpp = colorDepth / 8;
    for (let py = 0; py < cel.h; py++) {
      const dy = cel.y + py;
      if (dy < 0 || dy >= height) continue;
      for (let px = 0; px < cel.w; px++) {
        const dx = cel.x + px;
        if (dx < 0 || dx >= width) continue;
        const si = (py * cel.w + px) * bpp;
        const di = (dy * width + dx) * 4;
        if (colorDepth === 32) {
          dst[di] = cel.raw[si];
          dst[di + 1] = cel.raw[si + 1];
          dst[di + 2] = cel.raw[si + 2];
          dst[di + 3] = cel.raw[si + 3];
        } else if (colorDepth === 16) {
          const v = cel.raw[si];
          const a = cel.raw[si + 1];
          dst[di] = v;
          dst[di + 1] = v;
          dst[di + 2] = v;
          dst[di + 3] = a;
        } else {
          const idx = cel.raw[si];
          if (idx === transparentIdx) continue;
          const col = palette[idx] ?? [0, 0, 0, 255];
          dst[di] = col[0];
          dst[di + 1] = col[1];
          dst[di + 2] = col[2];
          dst[di + 3] = col[3];
        }
      }
    }
  };

  // First pass: direct image cels
  for (const rc of rawCels) {
    if (rc.celType === 1) continue;
    const layer = layerByRawIdx.get(rc.layerIndex);
    const dst = layer?.cels[rc.frameIndex];
    if (dst) blitRawToCel(dst, rc);
  }
  // Second pass: linked cels
  for (const rc of rawCels) {
    if (rc.celType !== 1) continue;
    const layer = layerByRawIdx.get(rc.layerIndex);
    const dst = layer?.cels[rc.frameIndex];
    const src = layer?.cels[rc.linkedFrame];
    if (dst && src) dst.set(src);
  }

  doc.animations = tags.map((t) => ({
    id: uid(),
    name: t.name,
    from: Math.min(t.from, t.to),
    to: Math.max(t.from, t.to),
    direction: t.direction,
    loop: true,
  }));

  return doc;
}
