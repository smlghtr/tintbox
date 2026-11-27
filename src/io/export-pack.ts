import { strToU8, zipSync } from 'fflate';
import { GIFEncoder, nearestColorIndex, quantize } from 'gifenc';
import { compose } from '../core/doc';
import { ValidationError } from '../core/errors';
import { resampleRgba, type ResampleAlgorithm } from '../core/scale';
import { buildTileMapExportJson, buildTilesetAtlas, extractRectPixels, type TilesetAtlasResult } from '../core/tiles';
import type { Animation, Doc } from '../core/types';
import { encodeBmp } from './bmp';
import { exportSpriteJs, type JsExportMode } from './js-export';
import { encodePngRgba } from './png';
import { encodePsd } from './psd';

export type ExportFormat = 'png' | 'gif' | 'sheet' | 'sequence' | 'bmp' | 'psd' | 'js';

export interface ExportOptions {
  scale: number;
  algorithm: ResampleAlgorithm;
  includeHidden: boolean;
  padding: number;
  loop: boolean;
  jsMode?: JsExportMode;
  jsVarName?: string;
}

export interface SpritesheetBundle {
  png: Uint8Array;
  json: string;
  w: number;
  h: number;
  frameCount: number;
}

export interface AtlasFrameEntry {
  frame: { x: number; y: number; w: number; h: number };
  duration: number;
}

export interface SpritesheetAtlas {
  meta: {
    app: 'tintbox';
    scale: number;
    padding: number;
    size: { w: number; h: number };
    frameSize: { w: number; h: number };
  };
  frames: Record<string, AtlasFrameEntry>;
  animations: Record<string, { from: number; to: number; direction: Animation['direction']; loop: boolean }>;
}

export function clampScale(scale: number): number {
  const n = Math.round(scale);
  if (!Number.isFinite(n) || n < 1 || n > 16) {
    throw new ValidationError('Export scale must be an integer between 1 and 16.');
  }
  return n;
}

export function clampPadding(padding: number): number {
  const n = Math.round(padding);
  if (!Number.isFinite(n) || n < 0 || n > 64) {
    throw new ValidationError('Spritesheet padding must be between 0 and 64 px.');
  }
  return n;
}

/** Upscale RGBA buffer using selected resampling/upscaler algorithm. */
export function scaleRgbaNearest(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  scale: number,
  algorithm: ResampleAlgorithm = 'nearest',
): { data: Uint8ClampedArray; w: number; h: number } {
  const s = clampScale(scale);
  if (s === 1) return { data: src, w, h };
  const outW = w * s;
  const outH = h * s;
  return { data: resampleRgba(src, w, h, outW, outH, algorithm), w: outW, h: outH };
}

/** Resolve ordered frame indices for export, expanding ping-pong if an animation is selected. */
export function resolveExportFrames(
  doc: Doc,
  scope: 'active' | 'all' | string,
  activeFrame: number,
): { frames: number[]; loop: boolean; anims: Animation[] } {
  const max = Math.max(0, doc.frames.length - 1);
  if (scope === 'active') {
    const f = Math.max(0, Math.min(max, activeFrame));
    return { frames: [f], loop: true, anims: [] };
  }
  if (scope === 'all') {
    return {
      frames: Array.from({ length: doc.frames.length }, (_, i) => i),
      loop: true,
      anims: doc.animations,
    };
  }
  const anim = doc.animations.find((a) => a.id === scope);
  if (!anim) {
    return {
      frames: Array.from({ length: doc.frames.length }, (_, i) => i),
      loop: true,
      anims: doc.animations,
    };
  }
  const from = Math.max(0, Math.min(max, anim.from));
  const to = Math.max(from, Math.min(max, anim.to));
  const seq: number[] = [];
  if (anim.direction === 'reverse') {
    for (let i = to; i >= from; i--) seq.push(i);
  } else if (anim.direction === 'pingpong') {
    for (let i = from; i <= to; i++) seq.push(i);
    for (let i = to - 1; i > from; i--) seq.push(i);
  } else {
    for (let i = from; i <= to; i++) seq.push(i);
  }
  return { frames: seq.length > 0 ? seq : [0], loop: anim.loop, anims: [anim] };
}

/** Export a single frame as lossless straight-alpha PNG bytes. Modifiers always baked; overlays/refs excluded. */
export function exportSinglePngBytes(
  doc: Doc,
  frame: number,
  opts: Partial<Pick<ExportOptions, 'scale' | 'algorithm' | 'includeHidden'>> = {},
): Uint8Array {
  const scale = clampScale(opts.scale ?? 1);
  const composed = compose(doc, frame, { includeHidden: Boolean(opts.includeHidden) });
  const scaled = scaleRgbaNearest(composed, doc.w, doc.h, scale, opts.algorithm ?? 'nearest');
  return encodePngRgba(scaled.data, scaled.w, scaled.h);
}

/** Export a single frame as uncompressed 32-bit BGRA BMP bytes. */
export function exportBmpBytes(
  doc: Doc,
  frame: number,
  opts: Partial<Pick<ExportOptions, 'scale' | 'algorithm' | 'includeHidden'>> = {},
): Uint8Array {
  const scale = clampScale(opts.scale ?? 1);
  const composed = compose(doc, frame, { includeHidden: Boolean(opts.includeHidden) });
  const scaled = scaleRgbaNearest(composed, doc.w, doc.h, scale, opts.algorithm ?? 'nearest');
  return encodeBmp(scaled.data, scaled.w, scaled.h);
}

/** Export the layered document frame as an Adobe Photoshop `.psd` file. */
export function exportPsdBytes(doc: Doc, frame: number): Uint8Array {
  return encodePsd(doc, frame);
}

/** Export sprite frame(s) as standalone JavaScript ES module source code. */
export function exportJsCode(
  doc: Doc,
  frames: number[],
  opts: Partial<Pick<ExportOptions, 'scale' | 'algorithm' | 'includeHidden' | 'jsMode' | 'jsVarName'>> = {},
): string {
  return exportSpriteJs(doc, frames, {
    scale: clampScale(opts.scale ?? 1),
    algorithm: opts.algorithm ?? 'nearest',
    includeHidden: Boolean(opts.includeHidden),
    mode: opts.jsMode ?? 'canvas2d',
    varName: opts.jsVarName ?? 'sprite',
  });
}

/**
 * Export animated GIF via gifenc:
 * - Honors exact per-frame durations from doc.frames[f].duration (ms -> GIF centiseconds).
 * - Global palette only (local palettes off), single transparent index (0) when any alpha < 128, dither off.
 */
export function exportGifBytes(
  doc: Doc,
  frames: number[],
  opts: Partial<Pick<ExportOptions, 'scale' | 'algorithm' | 'includeHidden' | 'loop'>> = {},
): Uint8Array {
  if (frames.length === 0) throw new ValidationError('No frames selected for GIF export.');
  const scale = clampScale(opts.scale ?? 1);
  const algorithm = opts.algorithm ?? 'nearest';
  const includeHidden = Boolean(opts.includeHidden);
  const repeat = opts.loop === false ? -1 : 0;

  const rendered: { data: Uint8ClampedArray; duration: number }[] = [];
  let outW = doc.w * scale;
  let outH = doc.h * scale;
  let hasTransparent = false;
  const uniqueColors = new Map<number, [number, number, number]>();

  for (const f of frames) {
    const composed = compose(doc, f, { includeHidden });
    const scaled = scaleRgbaNearest(composed, doc.w, doc.h, scale, algorithm);
    outW = scaled.w;
    outH = scaled.h;
    const d = scaled.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) {
        hasTransparent = true;
      } else {
        const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        if (!uniqueColors.has(key)) {
          uniqueColors.set(key, [d[i], d[i + 1], d[i + 2]]);
        }
      }
    }
    const duration = Math.max(20, doc.frames[f]?.duration ?? 100);
    rendered.push({ data: d, duration });
  }

  const maxOpaque = hasTransparent ? 255 : 256;
  const palette: number[][] = [];
  const exactMap = new Map<number, number>();
  const transparentIndex = 0;

  if (hasTransparent) {
    palette.push([0, 0, 0]);
  }

  if (uniqueColors.size <= maxOpaque) {
    for (const [key, rgb] of uniqueColors) {
      exactMap.set(key, palette.length);
      palette.push(rgb);
    }
  } else {
    // Collect opaque RGBA pixels across all frames for global quantization (dither off)
    let opaqueCount = 0;
    for (const r of rendered) {
      const d = r.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] >= 128) opaqueCount++;
      }
    }
    const packed = new Uint8Array(opaqueCount * 4);
    let ptr = 0;
    for (const r of rendered) {
      const d = r.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] >= 128) {
          packed[ptr++] = d[i];
          packed[ptr++] = d[i + 1];
          packed[ptr++] = d[i + 2];
          packed[ptr++] = 255;
        }
      }
    }
    const quantized = quantize(packed, maxOpaque, { format: 'rgb565' });
    for (const rgb of quantized) {
      palette.push([rgb[0], rgb[1], rgb[2]]);
    }
  }

  while (palette.length < 2) {
    palette.push([0, 0, 0]);
  }

  const opaquePalette = hasTransparent ? palette.slice(1) : palette;
  const pixelCount = outW * outH;
  const gif = GIFEncoder();

  rendered.forEach((frameData, idx) => {
    const indexed = new Uint8Array(pixelCount);
    const d = frameData.data;
    const tmp = [0, 0, 0];
    for (let p = 0; p < pixelCount; p++) {
      const o = p * 4;
      if (d[o + 3] < 128) {
        indexed[p] = transparentIndex;
      } else {
        const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
        const exact = exactMap.get(key);
        if (exact !== undefined) {
          indexed[p] = exact;
        } else {
          tmp[0] = d[o];
          tmp[1] = d[o + 1];
          tmp[2] = d[o + 2];
          const nearest = nearestColorIndex(opaquePalette, tmp);
          indexed[p] = hasTransparent ? nearest + 1 : nearest;
        }
      }
    }

    gif.writeFrame(indexed, outW, outH, {
      palette: idx === 0 ? palette : undefined,
      delay: frameData.duration,
      transparent: hasTransparent,
      transparentIndex,
      repeat,
      dispose: hasTransparent ? 2 : 0,
    });
  });

  gif.finish();
  return gif.bytes();
}

/** Export horizontal spritesheet PNG + JSON atlas with configurable inter-frame padding. */
export function exportSpritesheetBundle(
  doc: Doc,
  frames: number[],
  opts: Partial<Pick<ExportOptions, 'scale' | 'algorithm' | 'includeHidden' | 'padding'>> = {},
): SpritesheetBundle {
  if (frames.length === 0) throw new ValidationError('No frames selected for spritesheet export.');
  const scale = clampScale(opts.scale ?? 1);
  const algorithm = opts.algorithm ?? 'nearest';
  const padding = clampPadding(opts.padding ?? 0);
  const includeHidden = Boolean(opts.includeHidden);

  const fw = doc.w * scale;
  const fh = doc.h * scale;
  const totalW = frames.length * fw + Math.max(0, frames.length - 1) * padding;
  const totalH = fh;
  const sheet = new Uint8ClampedArray(totalW * totalH * 4);
  const atlasFrames: Record<string, AtlasFrameEntry> = {};

  frames.forEach((f, idx) => {
    const composed = compose(doc, f, { includeHidden });
    const scaled = scaleRgbaNearest(composed, doc.w, doc.h, scale, algorithm);
    const ox = idx * (fw + padding);
    for (let y = 0; y < fh; y++) {
      const srcOff = y * fw * 4;
      const dstOff = (y * totalW + ox) * 4;
      sheet.set(scaled.data.subarray(srcOff, srcOff + fw * 4), dstOff);
    }
    const key = `frame_${String(idx + 1).padStart(3, '0')}.png`;
    atlasFrames[key] = {
      frame: { x: ox, y: 0, w: fw, h: fh },
      duration: doc.frames[f]?.duration ?? 100,
    };
  });

  const animations: SpritesheetAtlas['animations'] = {};
  for (const a of doc.animations) {
    animations[a.name] = { from: a.from, to: a.to, direction: a.direction, loop: a.loop };
  }

  const atlas: SpritesheetAtlas = {
    meta: {
      app: 'tintbox',
      scale,
      padding,
      size: { w: totalW, h: totalH },
      frameSize: { w: fw, h: fh },
    },
    frames: atlasFrames,
    animations,
  };

  return {
    png: encodePngRgba(sheet, totalW, totalH),
    json: JSON.stringify(atlas, null, 2),
    w: totalW,
    h: totalH,
    frameCount: frames.length,
  };
}

/** Export numbered PNG frames inside a single .zip archive. */
export function exportPngSequenceZip(
  doc: Doc,
  frames: number[],
  opts: Partial<Pick<ExportOptions, 'scale' | 'algorithm' | 'includeHidden'>> = {},
): Uint8Array {
  if (frames.length === 0) throw new ValidationError('No frames selected for PNG sequence export.');
  const scale = clampScale(opts.scale ?? 1);
  const algorithm = opts.algorithm ?? 'nearest';
  const includeHidden = Boolean(opts.includeHidden);
  const files: Record<string, Uint8Array> = {};
  frames.forEach((f, idx) => {
    const name = `frame_${String(idx + 1).padStart(3, '0')}.png`;
    files[name] = exportSinglePngBytes(doc, f, { scale, algorithm, includeHidden });
  });
  return zipSync(files, { level: 6 });
}

export function exportTilesetAtlasPngBytes(
  doc: Doc,
  extrusion: 0 | 1 | 2 = 0,
): { png: Uint8Array; atlas: TilesetAtlasResult } {
  const atlas = buildTilesetAtlas(doc, extrusion);
  return { png: encodePngRgba(atlas.data, atlas.w, atlas.h), atlas };
}

export function exportTileMapJson(doc: Doc): string {
  return buildTileMapExportJson(doc);
}

/** Batch-export every SelectionSlice in `doc.slices` as individual PNGs inside a ZIP archive. */
export function exportSlicesZipBytes(
  doc: Doc,
  frame: number,
  opts: Partial<Pick<ExportOptions, 'scale' | 'algorithm' | 'includeHidden'>> = {},
): Uint8Array {
  const slices = doc.slices ?? [];
  if (slices.length === 0) throw new ValidationError('No selection slices to export.');
  const scale = clampScale(opts.scale ?? 1);
  const algorithm = opts.algorithm ?? 'nearest';
  const includeHidden = Boolean(opts.includeHidden);
  const composed = compose(doc, frame, { includeHidden });
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();

  slices.forEach((sl, idx) => {
    const raw = extractRectPixels(composed, doc.w, doc.h, sl.rect);
    const outW = sl.rect.w * scale;
    const outH = sl.rect.h * scale;
    const scaled = scale === 1 ? raw : resampleRgba(raw, sl.rect.w, sl.rect.h, outW, outH, algorithm);
    const base = sl.name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || `slice_${idx + 1}`;
    let fileName = `${base}.png`;
    let n = 2;
    while (used.has(fileName)) {
      fileName = `${base}_${n++}.png`;
    }
    used.add(fileName);
    files[fileName] = encodePngRgba(scaled, outW, outH);
  });

  files['slices.json'] = strToU8(
    JSON.stringify(
      {
        app: 'tintbox',
        scale,
        slices: slices.map((sl) => ({ id: sl.id, name: sl.name, layerId: sl.layerId, rect: sl.rect })),
      },
      null,
      2,
    ),
  );
  return zipSync(files, { level: 6 });
}

export function triggerDownload(bytes: Uint8Array | string, mime: string, filename: string): void {
  const part: BlobPart = typeof bytes === 'string' ? bytes : new Uint8Array(bytes);
  const blob = new Blob([part], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
