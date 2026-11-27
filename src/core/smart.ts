import { createDoc, createFrame, uid, MAX_DIM } from './doc';
import { bytesEqual, extractRectPixels, hashRgba } from './tiles';
import type { Doc, Layer, Rect, RGBA } from './types';

export interface IslandOpts {
  connectivity?: 4 | 8;
  minPixels?: number;
  snapGrid?: { w: number; h: number } | null;
}

const N4: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
];

/**
 * Connected-component island detector over non-transparent pixels (`alpha > 0`).
 * Returns bounding boxes sorted reading-order (row band top-to-bottom, then left-to-right).
 */
export function detectPixelIslands(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: IslandOpts = {},
): Rect[] {
  const conn = opts.connectivity ?? 8;
  const minPixels = Math.max(1, opts.minPixels ?? 1);
  const dirs = conn === 4 ? N4 : N8;
  const visited = new Uint8Array(w * h);
  const raw: Rect[] = [];
  const queue = new Int32Array(w * h);

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const start = sy * w + sx;
      if (visited[start] || rgba[start * 4 + 3] === 0) continue;
      visited[start] = 1;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      let count = 0;

      while (head < tail) {
        const idx = queue[head++];
        const cx = idx % w;
        const cy = (idx - cx) / w;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let d = 0; d < dirs.length; d++) {
          const nx = cx + dirs[d][0];
          const ny = cy + dirs[d][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (visited[nIdx] || rgba[nIdx * 4 + 3] === 0) continue;
          visited[nIdx] = 1;
          queue[tail++] = nIdx;
        }
      }

      if (count >= minPixels) {
        raw.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
      }
    }
  }

  let rects = raw;
  if (opts.snapGrid && opts.snapGrid.w > 0 && opts.snapGrid.h > 0) {
    const gw = opts.snapGrid.w;
    const gh = opts.snapGrid.h;
    const snapped = raw.map((r) => {
      const x0 = Math.floor(r.x / gw) * gw;
      const y0 = Math.floor(r.y / gh) * gh;
      const x1 = Math.min(w, Math.ceil((r.x + r.w) / gw) * gw);
      const y1 = Math.min(h, Math.ceil((r.y + r.h) / gh) * gh);
      return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
    });
    // Merge overlapping snapped rects cleanly so shared grid cells don't duplicate slices
    rects = mergeOverlappingRects(snapped);
  }

  // Sort reading-order: group by row band (overlap in Y) then left-to-right
  const band = opts.snapGrid?.h ?? Math.max(4, Math.round(rects.reduce((s, r) => s + r.h, 0) / Math.max(1, rects.length)));
  rects.sort((a, b) => {
    const rowA = Math.floor(a.y / band);
    const rowB = Math.floor(b.y / band);
    if (rowA !== rowB) return rowA - rowB;
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });
  return rects;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function mergeOverlappingRects(input: Rect[]): Rect[] {
  const out = input.map((r) => ({ ...r }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (rectsOverlap(out[i], out[j])) {
          const x0 = Math.min(out[i].x, out[j].x);
          const y0 = Math.min(out[i].y, out[j].y);
          const x1 = Math.max(out[i].x + out[i].w, out[j].x + out[j].w);
          const y1 = Math.max(out[i].y + out[i].h, out[j].y + out[j].h);
          out[i] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          out.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return out;
}

export interface OrganizeResult {
  data: Uint8ClampedArray;
  islands: Rect[];
  placed: number;
}

/**
 * Auto-organize tiles (`Alt+O`): detects pixel islands on a cel and repacks them cleanly into
 * `tileW x tileH` grid slots left-to-right, top-to-bottom.
 */
export function autoOrganizeTiles(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  tileW: number,
  tileH: number,
): OrganizeResult {
  const islands = detectPixelIslands(src, w, h, { connectivity: 8 });
  const out = new Uint8ClampedArray(w * h * 4);
  if (islands.length === 0) return { data: out, islands, placed: 0 };

  const cols = Math.max(1, Math.floor(w / tileW));
  const rows = Math.max(1, Math.floor(h / tileH));
  const maxSlots = cols * rows;
  let placed = 0;

  for (let i = 0; i < islands.length && i < maxSlots; i++) {
    const r = islands[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const slotX = col * tileW;
    const slotY = row * tileH;
    // Center island inside slot if smaller than slot, else top-left align clipped to slot
    const offX = r.w <= tileW ? Math.floor((tileW - r.w) / 2) : 0;
    const offY = r.h <= tileH ? Math.floor((tileH - r.h) / 2) : 0;
    const copyW = Math.min(r.w, tileW);
    const copyH = Math.min(r.h, tileH);

    for (let py = 0; py < copyH; py++) {
      for (let px = 0; px < copyW; px++) {
        const si = ((r.y + py) * w + (r.x + px)) * 4;
        if (src[si + 3] === 0) continue;
        const dx = slotX + offX + px;
        const dy = slotY + offY + py;
        if (dx < 0 || dy < 0 || dx >= w || dy >= h) continue;
        const di = (dy * w + dx) * 4;
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = src[si + 3];
      }
    }
    placed++;
  }

  return { data: out, islands, placed };
}

export interface ScannedTileCell {
  x: number;
  y: number;
  pixels: Uint8ClampedArray;
  hash: string;
}

/**
 * Create map tileset (`Alt+T`): scans every occupied `tileW x tileH` grid cell in an RGBA buffer
 * and returns deduplicated non-empty tiles in reading order.
 */
export function scanOccupiedGridCells(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  tileW: number,
  tileH: number,
): ScannedTileCell[] {
  const out: ScannedTileCell[] = [];
  const byHash = new Map<string, Uint8ClampedArray[]>();

  for (let y = 0; y + tileH <= h; y += tileH) {
    for (let x = 0; x + tileW <= w; x += tileW) {
      const pixels = extractRectPixels(rgba, w, h, { x, y, w: tileW, h: tileH });
      let hasOpaque = false;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 0) {
          hasOpaque = true;
          break;
        }
      }
      if (!hasOpaque) continue;
      const hash = hashRgba(pixels);
      const bucket = byHash.get(hash);
      if (bucket && bucket.some((existing) => bytesEqual(existing, pixels))) continue;
      if (bucket) bucket.push(pixels);
      else byHash.set(hash, [pixels]);
      out.push({ x, y, pixels, hash });
    }
  }
  return out;
}

/**
 * Slice and Animate (`Alt+A`): converts a list of regions on a source pixel buffer into a new
 * animated Doc sized to the largest region, with one frame per region (centered).
 */
export function buildAnimatedDocFromRegions(
  srcDoc: Doc,
  srcPixels: Uint8ClampedArray,
  regions: Rect[],
  layerName = 'Animated',
): Doc {
  const valid = regions.filter((r) => r.w > 0 && r.h > 0);
  if (valid.length === 0) return createDoc(srcDoc.w, srcDoc.h);

  const outW = Math.max(1, Math.min(MAX_DIM, Math.max(...valid.map((r) => r.w))));
  const outH = Math.max(1, Math.min(MAX_DIM, Math.max(...valid.map((r) => r.h))));
  const doc = createDoc(outW, outH);
  doc.fps = srcDoc.fps;
  doc.palettes = srcDoc.palettes.map((p) => ({
    id: p.id,
    name: p.name,
    colors: p.colors.map((c) => ({ rgba: [...c.rgba] as RGBA, locked: c.locked })),
  }));
  doc.activePaletteId = srcDoc.activePaletteId;

  const baseDuration = Math.max(10, Math.round(1000 / Math.max(1, srcDoc.fps)));
  doc.frames = valid.map(() => createFrame(baseDuration));

  const layer: Layer = doc.layers[0];
  layer.name = layerName;
  layer.cels = valid.map((r) => {
    const cel = new Uint8ClampedArray(outW * outH * 4);
    const ox = Math.floor((outW - r.w) / 2);
    const oy = Math.floor((outH - r.h) / 2);
    for (let py = 0; py < r.h; py++) {
      const sy = r.y + py;
      const dy = oy + py;
      if (sy < 0 || sy >= srcDoc.h || dy < 0 || dy >= outH) continue;
      for (let px = 0; px < r.w; px++) {
        const sx = r.x + px;
        const dx = ox + px;
        if (sx < 0 || sx >= srcDoc.w || dx < 0 || dx >= outW) continue;
        const si = (sy * srcDoc.w + sx) * 4;
        const di = (dy * outW + dx) * 4;
        cel[di] = srcPixels[si];
        cel[di + 1] = srcPixels[si + 1];
        cel[di + 2] = srcPixels[si + 2];
        cel[di + 3] = srcPixels[si + 3];
      }
    }
    return cel;
  });

  doc.animations = [
    {
      id: uid(),
      name: 'Sliced',
      from: 0,
      to: valid.length - 1,
      direction: 'forward',
      loop: true,
    },
  ];
  return doc;
}
