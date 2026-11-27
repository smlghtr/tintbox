import { compositeLayer } from './blend';
import { compose, uid } from './doc';
import { ValidationError } from './errors';
import type {
  Doc,
  Pt,
  Rect,
  TileCategory,
  TileDef,
  TileMap,
  TileMapLayer,
  TileMode,
  TileSet,
} from './types';

export const TILE_SIZE_PRESETS = [8, 16, 24, 32, 48, 64] as const;
export const TILE_CATEGORIES: TileCategory[] = ['ground', 'wall', 'prop', 'hazard', 'custom'];
export const MAX_TILE_DIM = 256;
export const MAX_MAP_DIM = 256;

export const TILE_ID_MASK = 0x00ffffff;
export const TILE_FLIP_H = 0x01000000;
export const TILE_FLIP_V = 0x02000000;
export const TILE_ROT_SHIFT = 26;

export type TileRotation = 0 | 1 | 2 | 3;

export interface MapCellTransform {
  tileId: number;
  rot: TileRotation;
  flipH: boolean;
  flipV: boolean;
}

/** Pack tile ID + 90-deg rotation (0..3) + H/V flip flags into a single 30-bit integer (backward-compatible with plain IDs). */
export function packMapCell(tileId: number, rot: TileRotation = 0, flipH = false, flipV = false): number {
  const id = Math.max(0, Math.round(tileId)) & TILE_ID_MASK;
  if (id === 0) return 0;
  let v = id;
  if (flipH) v |= TILE_FLIP_H;
  if (flipV) v |= TILE_FLIP_V;
  v |= (rot & 3) << TILE_ROT_SHIFT;
  return v;
}

export function unpackMapCell(cell: number): MapCellTransform {
  const raw = Math.max(0, Math.trunc(cell || 0));
  const tileId = raw & TILE_ID_MASK;
  if (tileId === 0) return { tileId: 0, rot: 0, flipH: false, flipV: false };
  return {
    tileId,
    rot: ((raw >>> TILE_ROT_SHIFT) & 3) as TileRotation,
    flipH: (raw & TILE_FLIP_H) !== 0,
    flipV: (raw & TILE_FLIP_V) !== 0,
  };
}

/** Rotate (clockwise 90° * rot) and flip (H, then V) a tile RGBA buffer into a same-size output buffer. */
export function transformTilePixels(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  rot: TileRotation,
  flipH: boolean,
  flipV: boolean,
): Uint8ClampedArray {
  if (rot === 0 && !flipH && !flipV) return src;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      let x = flipH ? w - 1 - dx : dx;
      let y = flipV ? h - 1 - dy : dy;
      let sx = x;
      let sy = y;
      if (rot === 1) {
        // 90° CW: (sx, sy) -> (h-1-sy, sx) => inverse: sx = y, sy = h - 1 - x
        sx = Math.floor((y * w) / h);
        sy = Math.floor(((w - 1 - x) * h) / w);
      } else if (rot === 2) {
        sx = w - 1 - x;
        sy = h - 1 - y;
      } else if (rot === 3) {
        // 270° CW (90° CCW)
        sx = Math.floor(((h - 1 - y) * w) / h);
        sy = Math.floor((x * h) / w);
      }
      sx = Math.max(0, Math.min(w - 1, sx));
      sy = Math.max(0, Math.min(h - 1, sy));
      const si = (sy * w + sx) * 4;
      const di = (dy * w + dx) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

export function wrapCoord(v: number, size: number): number {
  return ((v % size) + size) % size;
}

/** Wrap or clip a single point according to Repeat Tile Mode. */
export function wrapPoint(pt: Pt, w: number, h: number, mode: TileMode): Pt | null {
  let x = pt.x;
  let y = pt.y;
  if (mode === 'x' || mode === 'xy') {
    x = wrapCoord(x, w);
  } else if (x < 0 || x >= w) {
    return null;
  }
  if (mode === 'y' || mode === 'xy') {
    y = wrapCoord(y, h);
  } else if (y < 0 || y >= h) {
    return null;
  }
  return { x, y };
}

/** Wrap or clip a list of points according to Repeat Tile Mode. */
export function wrapPoints(pts: Pt[], w: number, h: number, mode: TileMode): Pt[] {
  if (mode === 'none') return pts;
  const out: Pt[] = [];
  for (const p of pts) {
    const wp = wrapPoint(p, w, h, mode);
    if (wp) out.push(wp);
  }
  return out;
}

/** Deterministic 64-bit (dual FNV-1a) hex hash of RGBA bytes for tile deduplication. */
export function hashRgba(bytes: Uint8ClampedArray): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 ^= b;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= b ^ (i & 0xff);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function bytesEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function validateTileDim(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_TILE_DIM || h > MAX_TILE_DIM) {
    throw new ValidationError(`Tile size ${w}x${h} out of range (1..${MAX_TILE_DIM}).`);
  }
}

export function validateMapDim(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_MAP_DIM || h > MAX_MAP_DIM) {
    throw new ValidationError(`Map size ${w}x${h} out of range (1..${MAX_MAP_DIM}).`);
  }
}

export function createDefaultTileSet(tileW = 16, tileH = 16): TileSet {
  validateTileDim(tileW, tileH);
  return { tileW, tileH, tiles: [] };
}

export function createMapLayer(name: string, width: number, height: number): TileMapLayer {
  validateMapDim(width, height);
  return {
    id: uid(),
    name,
    visible: true,
    data: new Array<number>(width * height).fill(0),
  };
}

export function createDefaultTileMap(width = 16, height = 12): TileMap {
  validateMapDim(width, height);
  return {
    width,
    height,
    layers: [createMapLayer('Ground', width, height)],
  };
}

export function cloneTileDef(t: TileDef, freshId = false): TileDef {
  return {
    id: freshId ? uid() : t.id,
    name: t.name,
    category: t.category,
    pixels: t.pixels.slice(),
    hash: t.hash,
    linked: t.linked,
    source: t.source ? { ...t.source } : undefined,
  };
}

export function cloneMapLayer(l: TileMapLayer, freshId = false): TileMapLayer {
  return {
    id: freshId ? uid() : l.id,
    name: l.name,
    visible: l.visible,
    data: l.data.slice(),
  };
}

/** Extract a rectangular region of RGBA pixels; pixels outside source bounds stay transparent. */
export function extractRectPixels(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  rect: Rect,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= srcH) continue;
    for (let x = 0; x < rect.w; x++) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= srcW) continue;
      const si = (sy * srcW + sx) * 4;
      const di = (y * rect.w + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

/**
 * Resolve the current RGBA pixels of a tile.
 * When `tile.linked` is true and `tile.source` is set, reads live from the composed source frame so
 * canvas edits immediately update the tile, map view, and exported atlas.
 */
export function resolveTilePixels(
  doc: Doc,
  tile: TileDef,
  frameCache?: Map<number, Uint8ClampedArray>,
): Uint8ClampedArray {
  const { tileW, tileH } = doc.tileset;
  if (tile.linked && tile.source) {
    const frame = Math.max(0, Math.min(doc.frames.length - 1, tile.source.frame));
    let composed = frameCache?.get(frame);
    if (!composed) {
      composed = compose(doc, frame);
      frameCache?.set(frame, composed);
    }
    return extractRectPixels(composed, doc.w, doc.h, {
      x: tile.source.x,
      y: tile.source.y,
      w: tileW,
      h: tileH,
    });
  }
  if (tile.pixels.length === tileW * tileH * 4) return tile.pixels;
  return extractRectPixels(tile.pixels, tileW, tileH, { x: 0, y: 0, w: tileW, h: tileH });
}

/** Check whether a candidate tile pixel buffer matches an existing tile in the tileset (deduplication). */
export function findDuplicateTile(
  doc: Doc,
  pixels: Uint8ClampedArray,
  frameCache?: Map<number, Uint8ClampedArray>,
): { index: number; tile: TileDef } | null {
  const targetHash = hashRgba(pixels);
  const cache = frameCache ?? new Map<number, Uint8ClampedArray>();
  for (let i = 0; i < doc.tileset.tiles.length; i++) {
    const t = doc.tileset.tiles[i];
    const resolved = resolveTilePixels(doc, t, cache);
    if (hashRgba(resolved) === targetHash && bytesEqual(resolved, pixels)) {
      return { index: i, tile: t };
    }
  }
  return null;
}

/** Capture a tile from the composed frame at `(x, y)` using `doc.tileset.tileW x tileH`. */
export function captureTileFromDoc(
  doc: Doc,
  x: number,
  y: number,
  frame: number,
  category: TileCategory = 'ground',
  name?: string,
): { tile: TileDef; duplicateIndex: number | null } {
  const { tileW, tileH } = doc.tileset;
  const composed = compose(doc, frame);
  const pixels = extractRectPixels(composed, doc.w, doc.h, { x, y, w: tileW, h: tileH });
  const cache = new Map<number, Uint8ClampedArray>([[frame, composed]]);
  const dup = findDuplicateTile(doc, pixels, cache);
  const idx = doc.tileset.tiles.length + 1;
  const tile: TileDef = {
    id: uid(),
    name: name?.trim() || `Tile ${idx}`,
    category,
    pixels,
    hash: hashRgba(pixels),
    linked: true,
    source: { x, y, frame },
  };
  return { tile, duplicateIndex: dup ? dup.index : null };
}

/** Compute all tile coordinates inside rectangle `[a..b]` clamped to map bounds. */
export function mapRectCells(a: Pt, b: Pt, width: number, height: number): Pt[] {
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(width - 1, Math.max(a.x, b.x));
  const y1 = Math.min(height - 1, Math.max(a.y, b.y));
  const pts: Pt[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) pts.push({ x, y });
  }
  return pts;
}

/** 4-connected flood fill on a tilemap layer integer grid. */
export function mapFloodFill(
  data: number[],
  width: number,
  height: number,
  startX: number,
  startY: number,
  tileId: number,
): number[] {
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return data.slice();
  const target = data[startY * width + startX];
  if (target === tileId) return data.slice();
  const out = data.slice();
  const stack: number[] = [startX, startY];
  while (stack.length > 0) {
    const y = stack.pop() ?? 0;
    const x = stack.pop() ?? 0;
    const idx = y * width + x;
    if (out[idx] !== target) continue;
    out[idx] = tileId;
    if (x > 0 && out[idx - 1] === target) stack.push(x - 1, y);
    if (x + 1 < width && out[idx + 1] === target) stack.push(x + 1, y);
    if (y > 0 && out[idx - width] === target) stack.push(x, y - 1);
    if (y + 1 < height && out[idx + width] === target) stack.push(x, y + 1);
  }
  return out;
}

/** Resize a map layer's data array, preserving top-left overlapping cells and filling new cells with 0. */
export function resizeTileMapData(
  oldData: number[],
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): number[] {
  validateMapDim(newW, newH);
  const out = new Array<number>(newW * newH).fill(0);
  const copyW = Math.min(oldW, newW);
  const copyH = Math.min(oldH, newH);
  for (let y = 0; y < copyH; y++) {
    for (let x = 0; x < copyW; x++) {
      out[y * newW + x] = oldData[y * oldW + x] ?? 0;
    }
  }
  return out;
}

/** Composite all visible tilemap layers into a single RGBA buffer, resolving linked tiles live. */
export function composeTileMapRgba(doc: Doc): { data: Uint8ClampedArray; w: number; h: number } {
  const { tileW, tileH, tiles } = doc.tileset;
  const { width, height, layers } = doc.tilemap;
  const outW = width * tileW;
  const outH = height * tileH;
  const out = new Uint8ClampedArray(outW * outH * 4);
  if (tiles.length === 0) return { data: out, w: outW, h: outH };

  const frameCache = new Map<number, Uint8ClampedArray>();
  const resolvedTiles = tiles.map((t) => resolveTilePixels(doc, t, frameCache));

  const xformCache = new Map<number, Uint8ClampedArray>();
  const getCellPx = (cell: number): Uint8ClampedArray | null => {
    const { tileId, rot, flipH, flipV } = unpackMapCell(cell);
    if (tileId <= 0 || tileId > resolvedTiles.length) return null;
    if (rot === 0 && !flipH && !flipV) return resolvedTiles[tileId - 1];
    let cached = xformCache.get(cell);
    if (!cached) {
      cached = transformTilePixels(resolvedTiles[tileId - 1], tileW, tileH, rot, flipH, flipV);
      xformCache.set(cell, cached);
    }
    return cached;
  };

  const layerBuf = new Uint8ClampedArray(outW * outH * 4);
  for (const layer of layers) {
    if (!layer.visible) continue;
    layerBuf.fill(0);
    for (let ty = 0; ty < height; ty++) {
      for (let tx = 0; tx < width; tx++) {
        const cell = layer.data[ty * width + tx] ?? 0;
        const tilePx = getCellPx(cell);
        if (!tilePx) continue;
        const dstX = tx * tileW;
        const dstY = ty * tileH;
        for (let py = 0; py < tileH; py++) {
          const srcOff = py * tileW * 4;
          const dstOff = ((dstY + py) * outW + dstX) * 4;
          layerBuf.set(tilePx.subarray(srcOff, srcOff + tileW * 4), dstOff);
        }
      }
    }
    compositeLayer(out, layerBuf, outW, outH, 100, 'normal');
  }
  return { data: out, w: outW, h: outH };
}

export interface TilesetAtlasEntry {
  id: string;
  index: number;
  name: string;
  category: TileCategory;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TilesetAtlasResult {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  extrusion: 0 | 1 | 2;
  tiles: TilesetAtlasEntry[];
}

/**
 * Pack the tileset into a PNG-ready RGBA atlas with optional 1–2px edge extrusion.
 * Guarantees zero overlap and zero bleed at nearest sampling.
 */
export function buildTilesetAtlas(doc: Doc, extrusion: 0 | 1 | 2 = 0): TilesetAtlasResult {
  const { tileW, tileH, tiles } = doc.tileset;
  const ext = extrusion === 1 || extrusion === 2 ? extrusion : 0;
  const count = tiles.length;
  if (count === 0) {
    return {
      data: new Uint8ClampedArray(tileW * tileH * 4),
      w: tileW,
      h: tileH,
      cols: 1,
      rows: 1,
      tileW,
      tileH,
      extrusion: ext,
      tiles: [],
    };
  }

  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = tileW + ext * 2;
  const cellH = tileH + ext * 2;
  const outW = cols * cellW;
  const outH = rows * cellH;
  const data = new Uint8ClampedArray(outW * outH * 4);
  const frameCache = new Map<number, Uint8ClampedArray>();
  const entries: TilesetAtlasEntry[] = [];

  const copyPx = (src: Uint8ClampedArray, sx: number, sy: number, dx: number, dy: number) => {
    const si = (sy * tileW + sx) * 4;
    const di = (dy * outW + dx) * 4;
    data[di] = src[si];
    data[di + 1] = src[si + 1];
    data[di + 2] = src[si + 2];
    data[di + 3] = src[si + 3];
  };

  tiles.forEach((tile, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const cellX = col * cellW;
    const cellY = row * cellH;
    const innerX = cellX + ext;
    const innerY = cellY + ext;
    const px = resolveTilePixels(doc, tile, frameCache);

    // Inner tile pixels (exact)
    for (let y = 0; y < tileH; y++) {
      const srcOff = y * tileW * 4;
      const dstOff = ((innerY + y) * outW + innerX) * 4;
      data.set(px.subarray(srcOff, srcOff + tileW * 4), dstOff);
    }

    // Optional 1-2px extrusion: clamp edge pixels outward into cell border (never overlaps neighbor cells)
    if (ext > 0) {
      for (let dy = -ext; dy < tileH + ext; dy++) {
        const sy = Math.max(0, Math.min(tileH - 1, dy));
        for (let dx = -ext; dx < tileW + ext; dx++) {
          if (dx >= 0 && dx < tileW && dy >= 0 && dy < tileH) continue;
          const sx = Math.max(0, Math.min(tileW - 1, dx));
          copyPx(px, sx, sy, innerX + dx, innerY + dy);
        }
      }
    }

    entries.push({
      id: tile.id,
      index: idx + 1,
      name: tile.name,
      category: tile.category,
      x: innerX,
      y: innerY,
      w: tileW,
      h: tileH,
    });
  });

  return { data, w: outW, h: outH, cols, rows, tileW, tileH, extrusion: ext, tiles: entries };
}

export interface TileMapExportJson {
  tileSize: number | { w: number; h: number };
  tileWidth: number;
  tileHeight: number;
  width: number;
  height: number;
  layers: { name: string; visible: boolean; data: number[] }[];
}

/** Export map JSON matching spec `{tileSize, width, height, layers:[{name, data:int[]}]}`. */
export function buildTileMapExportJson(doc: Doc): string {
  const { tileW, tileH } = doc.tileset;
  const payload: TileMapExportJson = {
    tileSize: tileW === tileH ? tileW : { w: tileW, h: tileH },
    tileWidth: tileW,
    tileHeight: tileH,
    width: doc.tilemap.width,
    height: doc.tilemap.height,
    layers: doc.tilemap.layers.map((l) => ({
      name: l.name,
      visible: l.visible,
      data: l.data.slice(),
    })),
  };
  return JSON.stringify(payload, null, 2);
}
