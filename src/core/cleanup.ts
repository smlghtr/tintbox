import { luminance } from './color';
import { getMaskBit, type SelectionMask } from './selection';
import type { Pt } from './types';

export interface OrphanOpts {
  connectivity?: 4 | 8;
  minClusterSize?: 1 | 2 | 3;
  mask?: SelectionMask | null;
}

export interface RemoveOrphanOpts extends OrphanOpts {
  action?: 'merge' | 'delete';
}

export interface RemoveOrphanResult {
  data: Uint8ClampedArray;
  orphans: Pt[];
  count: number;
}

const DX4 = [1, -1, 0, 0];
const DY4 = [0, 0, 1, -1];
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

interface Cluster {
  pixels: number[];
  color32: number;
}

function scanOrphanClusters(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  opts: OrphanOpts,
): Cluster[] {
  const conn = opts.connectivity ?? 4;
  const maxSize = opts.minClusterSize ?? 1;
  const mask = opts.mask ?? null;
  const dxs = conn === 8 ? DX8 : DX4;
  const dys = conn === 8 ? DY8 : DY4;
  const nDir = dxs.length;

  const total = w * h;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const clusters: Cluster[] = [];

  const aligned = data.byteOffset % 4 === 0;
  const u32 = aligned ? new Uint32Array(data.buffer, data.byteOffset, total) : null;
  const pixelAt = (p: number): number => {
    if (u32) return u32[p];
    const i = p * 4;
    return (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
  };
  const alphaAt = (p: number): number => data[p * 4 + 3];

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const start = row + x;
      if (visited[start]) continue;
      if (alphaAt(start) === 0) {
        visited[start] = 1;
        continue;
      }
      if (mask && !getMaskBit(mask, x, y)) continue;

      const target = pixelAt(start);
      // Fast check for minClusterSize === 1: if any same-color neighbor exists, we still flood to mark component?
      // Better: quick 1-hop check — if maxSize === 1 and any neighbor has same color, neither is a size-1 orphan!
      if (maxSize === 1) {
        let hasSame = false;
        for (let d = 0; d < nDir; d++) {
          const nx = x + dxs[d];
          const ny = y + dys[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const np = ny * w + nx;
          if (alphaAt(np) > 0 && pixelAt(np) === target) {
            hasSame = true;
            break;
          }
        }
        visited[start] = 1;
        if (!hasSame) clusters.push({ pixels: [start], color32: target });
        continue;
      }

      // BFS for connected same-color component (sizes <= maxSize)
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % w;
        const cy = (cur - cx) / w;
        for (let d = 0; d < nDir; d++) {
          const nx = cx + dxs[d];
          const ny = cy + dys[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const np = ny * w + nx;
          if (visited[np] || alphaAt(np) === 0 || pixelAt(np) !== target) continue;
          visited[np] = 1;
          queue[tail++] = np;
        }
      }

      if (tail <= maxSize) {
        const pixels: number[] = [];
        for (let k = 0; k < tail; k++) pixels.push(queue[k]);
        clusters.push({ pixels, color32: target });
      }
    }
  }

  return clusters;
}

export function findOrphans(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  opts: OrphanOpts = {},
): Pt[] {
  const clusters = scanOrphanClusters(data, w, h, opts);
  const pts: Pt[] = [];
  for (const cl of clusters) {
    for (const p of cl.pixels) {
      const x = p % w;
      pts.push({ x, y: (p - x) / w });
    }
  }
  return pts;
}

export function removeOrphans(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  opts: RemoveOrphanOpts = {},
): RemoveOrphanResult {
  const conn = opts.connectivity ?? 4;
  const action = opts.action ?? 'merge';
  const dxs = conn === 8 ? DX8 : DX4;
  const dys = conn === 8 ? DY8 : DY4;

  const clusters = scanOrphanClusters(data, w, h, opts);
  const out = data.slice();
  const orphans: Pt[] = [];
  if (clusters.length === 0) return { data: out, orphans, count: 0 };

  // Mark pixels belonging to any orphan cluster so merge targets non-orphan neighbors first
  const isOrphan = new Uint8Array(w * h);
  for (const cl of clusters) {
    for (const p of cl.pixels) {
      isOrphan[p] = 1;
      const x = p % w;
      orphans.push({ x, y: (p - x) / w });
    }
  }

  for (const cl of clusters) {
    if (action === 'delete') {
      for (const p of cl.pixels) {
        const i = p * 4;
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 0;
      }
      continue;
    }

    // Merge into most frequent opaque neighbor color (ties break by lowest luminance difference)
    const p0 = cl.pixels[0] * 4;
    const origLum = luminance(data[p0], data[p0 + 1], data[p0 + 2]);
    const counts = new Map<string, { r: number; g: number; b: number; a: number; count: number; lumDiff: number }>();

    const inCluster = new Set(cl.pixels);
    for (const p of cl.pixels) {
      const x = p % w;
      const y = (p - x) / w;
      for (let d = 0; d < dxs.length; d++) {
        const nx = x + dxs[d];
        const ny = y + dys[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const np = ny * w + nx;
        if (inCluster.has(np) || isOrphan[np]) continue;
        const ni = np * 4;
        if (data[ni + 3] === 0) continue;
        const key = `${data[ni]},${data[ni + 1]},${data[ni + 2]},${data[ni + 3]}`;
        const existing = counts.get(key);
        if (existing) {
          existing.count++;
        } else {
          counts.set(key, {
            r: data[ni],
            g: data[ni + 1],
            b: data[ni + 2],
            a: data[ni + 3],
            count: 1,
            lumDiff: Math.abs(luminance(data[ni], data[ni + 1], data[ni + 2]) - origLum),
          });
        }
      }
    }

    let best: { r: number; g: number; b: number; a: number; count: number; lumDiff: number } | null = null;
    for (const cand of counts.values()) {
      if (
        !best ||
        cand.count > best.count ||
        (cand.count === best.count && cand.lumDiff < best.lumDiff)
      ) {
        best = cand;
      }
    }

    for (const p of cl.pixels) {
      const i = p * 4;
      if (best) {
        out[i] = best.r;
        out[i + 1] = best.g;
        out[i + 2] = best.b;
        out[i + 3] = best.a;
      } else {
        // Completely isolated floating pixel surrounded only by transparency -> delete so operation stays idempotent
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 0;
      }
    }
  }

  return { data: out, orphans, count: orphans.length };
}
