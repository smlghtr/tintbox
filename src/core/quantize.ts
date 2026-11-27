import { isNearExtreme, luminance, oklabDistSq, oklabToRgb, rgbToOklab, type OKLab } from './color';
import { rgbToHsl } from './palette';
import { getMaskBit, type SelectionMask } from './selection';
import type { RGBA } from './types';

export type QuantizeMethod = 'median-cut' | 'kmeans-oklab' | 'most-frequent';
export type PaletteSort = 'luminance' | 'hue';

export interface ExtractOpts {
  count: number;
  method?: QuantizeMethod;
  ignoreTransparent?: boolean;
  ignoreNearExtremes?: boolean;
  sortBy?: PaletteSort;
  maxSide?: number;
}

export interface ExtractResult {
  colors: RGBA[];
  coverages: number[];
  uniqueCount: number;
}

interface ColorEntry {
  r: number;
  g: number;
  b: number;
  weight: number;
  lab: OKLab;
}

const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

function downscaleNearest(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  maxSide: number,
): { data: Uint8ClampedArray; w: number; h: number } {
  const longest = Math.max(w, h);
  if (longest <= maxSide) return { data: rgba, w, h };
  const scale = maxSide / longest;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw));
      const si = (sy * w + sx) * 4;
      const di = (y * nw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { data: out, w: nw, h: nh };
}

function collectHistogram(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  ignoreTransparent: boolean,
  ignoreNearExtremes: boolean,
): { entries: ColorEntry[]; totalWeight: number } {
  const counts = new Map<number, number>();
  let totalWeight = 0;
  const total = w * h;
  for (let p = 0; p < total; p++) {
    const i = p * 4;
    if (ignoreTransparent && rgba[i + 3] === 0) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    if (ignoreNearExtremes && isNearExtreme(r, g, b)) continue;
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    totalWeight++;
  }
  const entries: ColorEntry[] = [];
  for (const [key, weight] of counts.entries()) {
    const r = (key >> 16) & 255;
    const g = (key >> 8) & 255;
    const b = key & 255;
    entries.push({ r, g, b, weight, lab: rgbToOklab(r, g, b) });
  }
  // Deterministic canonical order by RGB key
  entries.sort((a, b) => ((a.r << 16) | (a.g << 8) | a.b) - ((b.r << 16) | (b.g << 8) | b.b));
  return { entries, totalWeight };
}

function medianCut(entries: ColorEntry[], target: number): RGBA[] {
  interface Box {
    items: ColorEntry[];
    weight: number;
    range: number;
    channel: 0 | 1 | 2;
  }

  const makeBox = (items: ColorEntry[]): Box => {
    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    let weight = 0;
    for (const e of items) {
      if (e.r < minR) minR = e.r;
      if (e.r > maxR) maxR = e.r;
      if (e.g < minG) minG = e.g;
      if (e.g > maxG) maxG = e.g;
      if (e.b < minB) minB = e.b;
      if (e.b > maxB) maxB = e.b;
      weight += e.weight;
    }
    const rR = maxR - minR;
    const rG = maxG - minG;
    const rB = maxB - minB;
    let channel: 0 | 1 | 2 = 0;
    let range = rR;
    if (rG > range) { range = rG; channel = 1; }
    if (rB > range) { range = rB; channel = 2; }
    return { items, weight, range, channel };
  };

  const boxes: Box[] = [makeBox(entries)];

  while (boxes.length < target) {
    // Pick splittable box with largest (range * log2(weight+1)) deterministically
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.items.length < 2) continue;
      const score = b.range * Math.log2(b.weight + 2);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;

    const box = boxes[bestIdx];
    const ch = box.channel;
    const sorted = box.items.slice().sort((a, b) => {
      const va = ch === 0 ? a.r : ch === 1 ? a.g : a.b;
      const vb = ch === 0 ? b.r : ch === 1 ? b.g : b.b;
      return va - vb;
    });

    const half = box.weight / 2;
    let acc = 0;
    let split = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += sorted[i].weight;
      split = i + 1;
      if (acc >= half) break;
    }

    const left = makeBox(sorted.slice(0, split));
    const right = makeBox(sorted.slice(split));
    boxes.splice(bestIdx, 1, left, right);
  }

  return boxes.map((box) => {
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (const e of box.items) {
      sr += e.r * e.weight;
      sg += e.g * e.weight;
      sb += e.b * e.weight;
      sw += e.weight;
    }
    return [Math.round(sr / sw), Math.round(sg / sw), Math.round(sb / sw), 255];
  });
}

/** Deterministic farthest-point seeded K-means in OKLab (max 12 iterations). */
function kmeansOklab(entries: ColorEntry[], target: number): RGBA[] {
  // Deterministic initial centroids: highest-weight color, then deterministic farthest-point in OKLab
  let first = entries[0];
  for (const e of entries) if (e.weight > first.weight) first = e;
  const centroids: OKLab[] = [{ ...first.lab }];
  const minDist = new Float64Array(entries.length).fill(Infinity);

  while (centroids.length < target) {
    const last = centroids[centroids.length - 1];
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < entries.length; i++) {
      const d = oklabDistSq(entries[i].lab, last);
      if (d < minDist[i]) minDist[i] = d;
      const score = minDist[i] * Math.sqrt(entries[i].weight);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    centroids.push({ ...entries[bestIdx].lab });
  }

  const assign = new Int32Array(entries.length);
  const sumL = new Float64Array(target);
  const sumA = new Float64Array(target);
  const sumB = new Float64Array(target);
  const sumW = new Float64Array(target);

  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    sumL.fill(0);
    sumA.fill(0);
    sumB.fill(0);
    sumW.fill(0);

    for (let i = 0; i < entries.length; i++) {
      const lab = entries[i].lab;
      let bestK = 0;
      let bestD = Infinity;
      for (let k = 0; k < target; k++) {
        const d = oklabDistSq(lab, centroids[k]);
        if (d < bestD) {
          bestD = d;
          bestK = k;
        }
      }
      if (assign[i] !== bestK) {
        assign[i] = bestK;
        changed = true;
      }
      const w = entries[i].weight;
      sumL[bestK] += lab.L * w;
      sumA[bestK] += lab.a * w;
      sumB[bestK] += lab.b * w;
      sumW[bestK] += w;
    }

    for (let k = 0; k < target; k++) {
      if (sumW[k] > 0) {
        centroids[k] = {
          L: sumL[k] / sumW[k],
          a: sumA[k] / sumW[k],
          b: sumB[k] / sumW[k],
        };
      }
    }
    if (!changed) break;
  }

  // Deduplicate quantized RGBs if two centroids collapsed to same 8-bit color
  const out: RGBA[] = [];
  const used = new Set<number>();
  for (const c of centroids) {
    const [r, g, b] = oklabToRgb(c.L, c.a, c.b);
    const key = (r << 16) | (g << 8) | b;
    if (!used.has(key)) {
      used.add(key);
      out.push([r, g, b, 255]);
    }
  }
  // Top up deterministically from distinct histogram entries if collapse occurred
  if (out.length < target) {
    const byWeight = entries.slice().sort((a, b) => b.weight - a.weight);
    for (const e of byWeight) {
      const key = (e.r << 16) | (e.g << 8) | e.b;
      if (!used.has(key)) {
        used.add(key);
        out.push([e.r, e.g, e.b, 255]);
        if (out.length >= target) break;
      }
    }
  }
  return out;
}

function mostFrequent(entries: ColorEntry[], target: number): RGBA[] {
  return entries
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, target)
    .map((e) => [e.r, e.g, e.b, 255]);
}

export function extractPalette(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  opts: ExtractOpts,
): ExtractResult {
  const count = Math.max(2, Math.min(64, Math.round(opts.count)));
  const method = opts.method ?? 'median-cut';
  const ignoreTransparent = opts.ignoreTransparent ?? true;
  const ignoreNearExtremes = opts.ignoreNearExtremes ?? false;
  const sortBy = opts.sortBy ?? 'luminance';
  const maxSide = opts.maxSide ?? 256;

  const scaled = downscaleNearest(rgba, w, h, maxSide);
  const { entries, totalWeight } = collectHistogram(
    scaled.data,
    scaled.w,
    scaled.h,
    ignoreTransparent,
    ignoreNearExtremes,
  );
  const uniqueCount = entries.length;
  if (uniqueCount === 0) return { colors: [], coverages: [], uniqueCount: 0 };

  let rawColors: RGBA[];
  if (uniqueCount <= count) {
    rawColors = entries.map((e) => [e.r, e.g, e.b, 255]);
  } else if (method === 'kmeans-oklab') {
    rawColors = kmeansOklab(entries, count);
  } else if (method === 'most-frequent') {
    rawColors = mostFrequent(entries, count);
  } else {
    rawColors = medianCut(entries, count);
  }

  // Ensure exact unique colors up to min(count, uniqueCount)
  const deduped: RGBA[] = [];
  const seen = new Set<number>();
  for (const c of rawColors) {
    const k = (c[0] << 16) | (c[1] << 8) | c[2];
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(c);
    }
  }
  const target = Math.min(count, uniqueCount);
  if (deduped.length < target) {
    for (const e of entries) {
      const k = (e.r << 16) | (e.g << 8) | e.b;
      if (!seen.has(k)) {
        seen.add(k);
        deduped.push([e.r, e.g, e.b, 255]);
        if (deduped.length >= target) break;
      }
    }
  }

  // Compute pixel coverage per palette color in OKLab
  const palLabs = deduped.map((c) => rgbToOklab(c[0], c[1], c[2]));
  const bucketWeight = new Float64Array(deduped.length);
  for (const e of entries) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < palLabs.length; k++) {
      const d = oklabDistSq(e.lab, palLabs[k]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    bucketWeight[best] += e.weight;
  }

  const paired = deduped.map((color, idx) => ({
    color,
    coverage: totalWeight > 0 ? (bucketWeight[idx] / totalWeight) * 100 : 0,
  }));

  if (sortBy === 'hue') {
    paired.sort((a, b) => {
      const ha = rgbToHsl(a.color[0], a.color[1], a.color[2]);
      const hb = rgbToHsl(b.color[0], b.color[1], b.color[2]);
      return ha[0] - hb[0] || ha[2] - hb[2];
    });
  } else {
    paired.sort(
      (a, b) =>
        luminance(a.color[0], a.color[1], a.color[2]) -
        luminance(b.color[0], b.color[1], b.color[2]),
    );
  }

  return {
    colors: paired.map((p) => p.color),
    coverages: paired.map((p) => p.coverage),
    uniqueCount,
  };
}

export interface RemapOpts {
  dither?: boolean;
  mask?: SelectionMask | null;
  alphaLock?: boolean;
}

export function remapToPalette(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  palette: RGBA[],
  opts: RemapOpts = {},
): Uint8ClampedArray {
  const out = data.slice();
  if (palette.length === 0) return out;
  const palLabs = palette.map((c) => rgbToOklab(c[0], c[1], c[2]));
  const mask = opts.mask ?? null;
  const dither = Boolean(opts.dither);
  const alphaLock = Boolean(opts.alphaLock);

  const cache = new Map<number, RGBA>();

  const nearest = (r: number, g: number, b: number): RGBA => {
    const k = (r << 16) | (g << 8) | b;
    const hit = cache.get(k);
    if (hit) return hit;
    const lab = rgbToOklab(r, g, b);
    let best = palette[0];
    let bestD = Infinity;
    for (let i = 0; i < palLabs.length; i++) {
      const d = oklabDistSq(lab, palLabs[i]);
      if (d < bestD) {
        bestD = d;
        best = palette[i];
      }
    }
    cache.set(k, best);
    return best;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask && !getMaskBit(mask, x, y)) continue;
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a === 0) continue;
      if (alphaLock && a === 0) continue;

      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];
      if (dither) {
        const bias = (BAYER_4X4[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 32;
        r = Math.max(0, Math.min(255, Math.round(r + bias)));
        g = Math.max(0, Math.min(255, Math.round(g + bias)));
        b = Math.max(0, Math.min(255, Math.round(b + bias)));
      }
      const match = nearest(r, g, b);
      out[i] = match[0];
      out[i + 1] = match[1];
      out[i + 2] = match[2];
      out[i + 3] = a;
    }
  }

  return out;
}
