import { getMaskBit, maskBounds, type SelectionMask } from './selection';
import type { BrushShape, Pt, RGBA } from './types';

export function bresenham(a: Pt, b: Pt): Pt[] {
  const pts: Pt[] = [];
  let { x, y } = a;
  const dx = Math.abs(b.x - x);
  const dy = -Math.abs(b.y - y);
  const sx = x < b.x ? 1 : -1;
  const sy = y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push({ x, y });
    if (x === b.x && y === b.y) return pts;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Drops the corner pixel of every L-shaped step so lines stay 1px wide. */
export function pixelPerfect(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const diagonal = Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1;
    const corner = (a.x === b.x || a.y === b.y) && (c.x === b.x || c.y === b.y);
    if (diagonal && corner) continue;
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function dedupe(pts: Pt[]): Pt[] {
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
}

export function pixelLine(a: Pt, b: Pt): Pt[] {
  return pixelPerfect(bresenham(a, b));
}

/** Snap endpoint `b` relative to `a` to nearest 15-degree angle increment. */
export function snapLineAngle(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return b;
  const step = Math.PI / 12;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: a.x + Math.round(Math.cos(angle) * len),
    y: a.y + Math.round(Math.sin(angle) * len),
  };
}

/** Quadratic bezier rasterized to a pixel-perfect 1px path. */
export function pixelCurve(p0: Pt, c: Pt, p2: Pt): Pt[] {
  const len = Math.hypot(c.x - p0.x, c.y - p0.y) + Math.hypot(p2.x - c.x, p2.y - c.y);
  const n = Math.max(2, Math.ceil(len * 2));
  const samples: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    samples.push({
      x: Math.round(u * u * p0.x + 2 * u * t * c.x + t * t * p2.x),
      y: Math.round(u * u * p0.y + 2 * u * t * c.y + t * t * p2.y),
    });
  }
  const path = dedupe(samples);
  const full: Pt[] = [path[0]];
  for (let i = 1; i < path.length; i++) full.push(...bresenham(path[i - 1], path[i]));
  return pixelPerfect(dedupe(full));
}

export function brushOffsets(size: number, shape: BrushShape): Pt[] {
  const s = Math.max(1, Math.min(32, Math.round(size)));
  if (s === 1) return [{ x: 0, y: 0 }];
  const lo = -Math.floor((s - 1) / 2);
  const hi = lo + s - 1;
  const cx = (lo + hi) / 2;
  const cy = (lo + hi) / 2;
  const r = s >= 3 ? s / 2 - 0.15 : s / 2;
  const r2 = r * r;
  const pts: Pt[] = [];
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) {
      if (shape === 'square' || (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) {
        pts.push({ x, y });
      }
    }
  }
  return pts;
}

/**
 * Tracks a freehand 1px stroke across multiple pointermove events so L-corners
 * are stripped even when dragging 1 pixel at a time.
 */
export class StrokeTracker {
  private path: Pt[] = [];
  private readonly perfect: boolean;

  constructor(start: Pt, perfect: boolean) {
    this.perfect = perfect;
    this.path.push(start);
  }

  step(next: Pt): { add: Pt[]; remove: Pt[] } {
    const last = this.path[this.path.length - 1];
    if (last.x === next.x && last.y === next.y) return { add: [], remove: [] };

    const seg = bresenham(last, next);
    const add: Pt[] = [];
    const remove: Pt[] = [];

    for (let i = 1; i < seg.length; i++) {
      const c = seg[i];
      if (this.perfect && this.path.length >= 2) {
        const a = this.path[this.path.length - 2];
        const b = this.path[this.path.length - 1];
        const diagonal = Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1;
        const corner = (a.x === b.x || a.y === b.y) && (c.x === b.x || c.y === b.y);
        if (diagonal && corner) {
          this.path.pop();
          remove.push(b);
        }
      }
      this.path.push(c);
      add.push(c);
    }

    return { add, remove };
  }
}

export interface StampOpts {
  size?: number;
  shape?: BrushShape;
  mask?: SelectionMask | null;
  alphaLock?: boolean;
  wrapX?: boolean;
  wrapY?: boolean;
}

export function setPixel(data: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  data.set(c, (y * w + x) * 4);
}

export function getPixel(data: Uint8ClampedArray, w: number, x: number, y: number): RGBA {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

export function stampBrush(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  pts: Pt[],
  color: RGBA,
  opts: StampOpts = {},
): void {
  const rawSize = opts.size ?? 1;
  const subAlpha = rawSize > 0 && rawSize < 1 ? Math.max(0.2, rawSize) : 1;
  const offsets = brushOffsets(rawSize < 1 ? 1 : rawSize, opts.shape ?? 'square');
  const mask = opts.mask ?? null;
  const alphaLock = opts.alphaLock ?? false;
  const wrapX = opts.wrapX ?? false;
  const wrapY = opts.wrapY ?? false;

  for (const p of pts) {
    for (const o of offsets) {
      let x = p.x + o.x;
      let y = p.y + o.y;
      if (wrapX) x = ((x % w) + w) % w;
      else if (x < 0 || x >= w) continue;
      if (wrapY) y = ((y % h) + h) % h;
      else if (y < 0 || y >= h) continue;
      if (mask && !getMaskBit(mask, x, y)) continue;
      const i = (y * w + x) * 4;
      if (alphaLock && data[i + 3] === 0) continue;

      if (subAlpha < 1) {
        if (color[3] === 0) {
          // Fine sub-pixel eraser reduces alpha smoothly instead of hard cutout
          if (!alphaLock) {
            const nextA = Math.max(0, Math.round(data[i + 3] * (1 - subAlpha)));
            data[i + 3] = nextA;
            if (nextA === 0) {
              data[i] = 0;
              data[i + 1] = 0;
              data[i + 2] = 0;
            }
          }
        } else {
          // Fine sub-pixel micro-dot blends over existing pixel with scaled alpha
          const sa = (color[3] / 255) * subAlpha;
          const da = data[i + 3] / 255;
          const oa = sa + da * (1 - sa);
          if (oa > 0) {
            data[i] = Math.round((color[0] * sa + data[i] * da * (1 - sa)) / oa);
            data[i + 1] = Math.round((color[1] * sa + data[i + 1] * da * (1 - sa)) / oa);
            data[i + 2] = Math.round((color[2] * sa + data[i + 2] * da * (1 - sa)) / oa);
            data[i + 3] = alphaLock ? data[i + 3] : Math.round(oa * 255);
          }
        }
        continue;
      }

      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = alphaLock ? data[i + 3] : color[3];
    }
  }
}

/** Paint a grayscale value (0 = conceal, 255 = reveal) into a 1-byte-per-pixel Layer Mask or Effect Mask. */
export function stampMaskBrush(
  maskBuf: Uint8Array,
  w: number,
  h: number,
  pts: Pt[],
  value: number,
  opts: Omit<StampOpts, 'alphaLock'> = {},
): void {
  const rawSize = opts.size ?? 1;
  const subStrength = rawSize > 0 && rawSize < 1 ? Math.max(0.2, rawSize) : 1;
  const offsets = brushOffsets(rawSize < 1 ? 1 : rawSize, opts.shape ?? 'square');
  const sel = opts.mask ?? null;
  const wrapX = opts.wrapX ?? false;
  const wrapY = opts.wrapY ?? false;
  const target = Math.max(0, Math.min(255, Math.round(value)));

  for (const p of pts) {
    for (const o of offsets) {
      let x = p.x + o.x;
      let y = p.y + o.y;
      if (wrapX) x = ((x % w) + w) % w;
      else if (x < 0 || x >= w) continue;
      if (wrapY) y = ((y % h) + h) % h;
      else if (y < 0 || y >= h) continue;
      if (sel && !getMaskBit(sel, x, y)) continue;
      const idx = y * w + x;
      maskBuf[idx] =
        subStrength < 1
          ? Math.round(maskBuf[idx] * (1 - subStrength) + target * subStrength)
          : target;
    }
  }
}

function shapeBounds(a: Pt, b: Pt, constrainSquare: boolean, fromCenter: boolean): { x0: number; y0: number; x1: number; y1: number } {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (constrainSquare) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  if (fromCenter) {
    const ax = a.x - dx;
    const ay = a.y - dy;
    const bx = a.x + dx;
    const by = a.y + dy;
    return {
      x0: Math.min(ax, bx),
      y0: Math.min(ay, by),
      x1: Math.max(ax, bx),
      y1: Math.max(ay, by),
    };
  }
  const bx = a.x + dx;
  const by = a.y + dy;
  return {
    x0: Math.min(a.x, bx),
    y0: Math.min(a.y, by),
    x1: Math.max(a.x, bx),
    y1: Math.max(a.y, by),
  };
}

export function pixelRect(
  a: Pt,
  b: Pt,
  opts: { filled?: boolean; square?: boolean; fromCenter?: boolean } = {},
): Pt[] {
  const { x0, y0, x1, y1 } = shapeBounds(a, b, Boolean(opts.square), Boolean(opts.fromCenter));
  const pts: Pt[] = [];
  if (opts.filled) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) pts.push({ x, y });
    }
    return pts;
  }
  for (let x = x0; x <= x1; x++) {
    pts.push({ x, y: y0 });
    if (y1 !== y0) pts.push({ x, y: y1 });
  }
  for (let y = y0 + 1; y < y1; y++) {
    pts.push({ x: x0, y });
    if (x1 !== x0) pts.push({ x: x1, y });
  }
  return pts;
}

/** Integer midpoint bounding-box ellipse (Zingl-Bresenham), exact symmetry and zero gaps. */
export function pixelEllipse(
  a: Pt,
  b: Pt,
  opts: { filled?: boolean; circle?: boolean; fromCenter?: boolean } = {},
): Pt[] {
  const bounds = shapeBounds(a, b, Boolean(opts.circle), Boolean(opts.fromCenter));
  let x0 = bounds.x0;
  let y0 = bounds.y0;
  let x1 = bounds.x1;
  let y1 = bounds.y1;

  const seen = new Set<string>();
  const pts: Pt[] = [];
  const put = (x: number, y: number) => {
    const k = `${x},${y}`;
    if (!seen.has(k)) {
      seen.add(k);
      pts.push({ x, y });
    }
  };
  const hspan = (lx: number, rx: number, y: number) => {
    for (let x = lx; x <= rx; x++) put(x, y);
  };

  let width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  let b1 = height & 1;
  let dx = 4 * (1 - width) * height * height;
  let dy = 4 * (b1 + 1) * width * width;
  let err = dx + dy + b1 * width * width;

  y0 += Math.floor((height + 1) / 2);
  y1 = y0 - b1;
  const a2 = 8 * width * width;
  const b2 = 8 * height * height;

  do {
    if (opts.filled) {
      hspan(x0, x1, y0);
      hspan(x0, x1, y1);
    } else {
      put(x1, y0);
      put(x0, y0);
      put(x0, y1);
      put(x1, y1);
    }
    const e2 = 2 * err;
    if (e2 <= dy) {
      y0++;
      y1--;
      dy += a2;
      err += dy;
    }
    if (e2 >= dx || 2 * err > dy) {
      x0++;
      x1--;
      dx += b2;
      err += dx;
    }
  } while (x0 <= x1);

  while (y0 - y1 <= height) {
    put(x0 - 1, y0);
    put(x1 + 1, y0++);
    put(x0 - 1, y1);
    put(x1 + 1, y1--);
  }

  return pts;
}

export interface FloodFillOpts {
  contiguous?: boolean;
  tolerance?: number;
  sample?: Uint8ClampedArray;
  mask?: SelectionMask | null;
  alphaLock?: boolean;
  wrapX?: boolean;
  wrapY?: boolean;
}

function rgbaWithin(
  buf: Uint8ClampedArray,
  idx: number,
  tr: number,
  tg: number,
  tb: number,
  ta: number,
  tol: number,
): boolean {
  if (tol <= 0) {
    return buf[idx] === tr && buf[idx + 1] === tg && buf[idx + 2] === tb && buf[idx + 3] === ta;
  }
  return (
    Math.abs(buf[idx] - tr) <= tol &&
    Math.abs(buf[idx + 1] - tg) <= tol &&
    Math.abs(buf[idx + 2] - tb) <= tol &&
    Math.abs(buf[idx + 3] - ta) <= tol
  );
}

/** Fast non-recursive scanline flood fill (typed stack) honoring mask, alphaLock, tolerance, and sample source. */
export function floodFill(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  startX: number,
  startY: number,
  c: RGBA,
  opts: FloodFillOpts = {},
): void {
  const wrapX = opts.wrapX ?? false;
  const wrapY = opts.wrapY ?? false;
  if (wrapX) startX = ((startX % w) + w) % w;
  if (wrapY) startY = ((startY % h) + h) % h;
  if (startX < 0 || startY < 0 || startX >= w || startY >= h) return;
  const mask = opts.mask ?? null;
  if (mask && !getMaskBit(mask, startX, startY)) return;

  const sample = opts.sample ?? data;
  const tol = opts.tolerance ?? 0;
  const alphaLock = opts.alphaLock ?? false;
  const contiguous = opts.contiguous ?? true;

  const si = (startY * w + startX) * 4;
  const tr = sample[si];
  const tg = sample[si + 1];
  const tb = sample[si + 2];
  const ta = sample[si + 3];

  if (sample === data && tol === 0 && tr === c[0] && tg === c[1] && tb === c[2] && ta === c[3]) return;

  const writePixel = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (alphaLock && data[i + 3] === 0) return;
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = alphaLock ? data[i + 3] : c[3];
  };

  if (!contiguous) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask && !getMaskBit(mask, x, y)) continue;
        if (rgbaWithin(sample, (y * w + x) * 4, tr, tg, tb, ta, tol)) writePixel(x, y);
      }
    }
    return;
  }

  // Ultra-fast path: exact match, sample === data, no mask, no alphaLock, no wrap
  if (!wrapX && !wrapY && tol === 0 && !mask && !alphaLock && sample === data && data.byteOffset % 4 === 0) {
    const d32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
    const target32 = d32[startY * w + startX];
    const tmp = new Uint8ClampedArray(c);
    const fill32 = new Uint32Array(tmp.buffer)[0];
    if (target32 === fill32) return;

    const stack: number[] = [startX, startY];
    while (stack.length > 0) {
      const y = stack.pop() ?? 0;
      const x = stack.pop() ?? 0;
      const row = y * w;
      if (d32[row + x] !== target32) continue;

      let lx = x;
      while (lx > 0 && d32[row + lx - 1] === target32) lx--;
      let rx = x;
      while (rx + 1 < w && d32[row + rx + 1] === target32) rx++;

      d32.fill(fill32, row + lx, row + rx + 1);

      if (y > 0) {
        const upRow = row - w;
        let span = false;
        for (let cx = lx; cx <= rx; cx++) {
          if (d32[upRow + cx] === target32) {
            if (!span) {
              stack.push(cx, y - 1);
              span = true;
            }
          } else {
            span = false;
          }
        }
      }
      if (y + 1 < h) {
        const dnRow = row + w;
        let span = false;
        for (let cx = lx; cx <= rx; cx++) {
          if (d32[dnRow + cx] === target32) {
            if (!span) {
              stack.push(cx, y + 1);
              span = true;
            }
          } else {
            span = false;
          }
        }
      }
    }
    return;
  }

  const visited = new Uint8Array(w * h);
  const stack: number[] = [startX, startY];

  const canFill = (x: number, y: number): boolean => {
    const p = y * w + x;
    if (visited[p]) return false;
    if (mask && !getMaskBit(mask, x, y)) return false;
    return rgbaWithin(sample, p * 4, tr, tg, tb, ta, tol);
  };

  while (stack.length > 0) {
    const y = stack.pop() ?? 0;
    const x = stack.pop() ?? 0;
    if (!canFill(x, y)) continue;

    let lx = x;
    while (lx > 0 && canFill(lx - 1, y)) lx--;
    let rx = x;
    while (rx + 1 < w && canFill(rx + 1, y)) rx++;

    let upSpan = false;
    let dnSpan = false;
    for (let cx = lx; cx <= rx; cx++) {
      visited[y * w + cx] = 1;
      writePixel(cx, y);

      const upY = y > 0 ? y - 1 : wrapY ? h - 1 : -1;
      if (upY >= 0) {
        const hit = canFill(cx, upY);
        if (hit && !upSpan) {
          stack.push(cx, upY);
          upSpan = true;
        } else if (!hit) {
          upSpan = false;
        }
      }
      const dnY = y + 1 < h ? y + 1 : wrapY ? 0 : -1;
      if (dnY >= 0) {
        const hit = canFill(cx, dnY);
        if (hit && !dnSpan) {
          stack.push(cx, dnY);
          dnSpan = true;
        } else if (!hit) {
          dnSpan = false;
        }
      }
    }
    if (wrapX) {
      if (lx === 0 && canFill(w - 1, y)) stack.push(w - 1, y);
      if (rx === w - 1 && canFill(0, y)) stack.push(0, y);
    }
  }
}

export function moveCelPixels(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  dx: number,
  dy: number,
  opts: { mask?: SelectionMask | null; wrap?: boolean } = {},
): Uint8ClampedArray {
  const out = opts.mask ? src.slice() : new Uint8ClampedArray(w * h * 4);
  const mask = opts.mask ?? null;
  const wrap = Boolean(opts.wrap);

  if (mask) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!getMaskBit(mask, x, y)) continue;
        const i = (y * w + x) * 4;
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 0;
      }
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask && !getMaskBit(mask, x, y)) continue;
      let nx = x + dx;
      let ny = y + dy;
      if (wrap) {
        nx = ((nx % w) + w) % w;
        ny = ((ny % h) + h) % h;
      } else if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
        continue;
      }
      const si = (y * w + x) * 4;
      const di = (ny * w + nx) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }

  return out;
}

/** Flip selection bounding box (or full cel) horizontally or vertically. */
export function flipCelPixels(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  axis: 'h' | 'v',
  mask?: SelectionMask | null,
): Uint8ClampedArray {
  const bounds = mask ? maskBounds(mask) : { x: 0, y: 0, w, h };
  if (!bounds) return src.slice();
  const out = mask ? src.slice() : new Uint8ClampedArray(w * h * 4);
  if (mask) {
    for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
        if (!getMaskBit(mask, x, y)) continue;
        const i = (y * w + x) * 4;
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
      }
    }
  }
  for (let dy = 0; dy < bounds.h; dy++) {
    const sy = bounds.y + dy;
    const ny = axis === 'v' ? bounds.y + (bounds.h - 1 - dy) : sy;
    for (let dx = 0; dx < bounds.w; dx++) {
      const sx = bounds.x + dx;
      if (mask && !getMaskBit(mask, sx, sy)) continue;
      const nx = axis === 'h' ? bounds.x + (bounds.w - 1 - dx) : sx;
      const si = (sy * w + sx) * 4;
      const di = (ny * w + nx) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

/** Rotate selection bounding box (or full cel) 90 degrees CW or CCW around its center. */
export function rotateCelPixels90(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  dir: 'cw' | 'ccw',
  mask?: SelectionMask | null,
): Uint8ClampedArray {
  const bounds = mask ? maskBounds(mask) : { x: 0, y: 0, w, h };
  if (!bounds) return src.slice();
  const out = mask ? src.slice() : new Uint8ClampedArray(w * h * 4);
  if (mask) {
    for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
        if (!getMaskBit(mask, x, y)) continue;
        const i = (y * w + x) * 4;
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
      }
    }
  }
  const cx = bounds.x + (bounds.w - 1) / 2;
  const cy = bounds.y + (bounds.h - 1) / 2;
  for (let sy = bounds.y; sy < bounds.y + bounds.h; sy++) {
    for (let sx = bounds.x; sx < bounds.x + bounds.w; sx++) {
      if (mask && !getMaskBit(mask, sx, sy)) continue;
      const rx = sx - cx;
      const ry = sy - cy;
      const nx = Math.round(cx + (dir === 'cw' ? -ry : ry));
      const ny = Math.round(cy + (dir === 'cw' ? rx : -rx));
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const si = (sy * w + sx) * 4;
      const di = (ny * w + nx) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}
