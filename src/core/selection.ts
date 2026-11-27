import type { Pt, Rect, SelectionMode } from './types';

export interface SelectionMask {
  w: number;
  h: number;
  bits: Uint8Array;
}

export interface EdgeSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ExtractedBuffer {
  rect: Rect;
  pixels: Uint8ClampedArray;
  maskBits: Uint8Array;
}

export function createMask(w: number, h: number): SelectionMask {
  return { w, h, bits: new Uint8Array(Math.ceil((w * h) / 8)) };
}

export function cloneMask(m: SelectionMask): SelectionMask {
  return { w: m.w, h: m.h, bits: m.bits.slice() };
}

export function maskEqual(a: SelectionMask | null, b: SelectionMask | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.w !== b.w || a.h !== b.h || a.bits.length !== b.bits.length) return false;
  for (let i = 0; i < a.bits.length; i++) if (a.bits[i] !== b.bits[i]) return false;
  return true;
}

export function getMaskBit(m: SelectionMask, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return false;
  const idx = y * m.w + x;
  return ((m.bits[idx >> 3] >> (idx & 7)) & 1) === 1;
}

export function setMaskBit(m: SelectionMask, x: number, y: number, val: boolean): void {
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return;
  const idx = y * m.w + x;
  const byteIdx = idx >> 3;
  const bit = 1 << (idx & 7);
  if (val) m.bits[byteIdx] |= bit;
  else m.bits[byteIdx] &= ~bit;
}

export function isEmptyMask(m: SelectionMask): boolean {
  for (let i = 0; i < m.bits.length; i++) if (m.bits[i] !== 0) return false;
  return true;
}

export function countSelected(m: SelectionMask): number {
  let total = 0;
  for (let i = 0; i < m.bits.length; i++) {
    let b = m.bits[i];
    while (b) {
      b &= b - 1;
      total++;
    }
  }
  return total;
}

export function selectAll(w: number, h: number): SelectionMask {
  const m = createMask(w, h);
  const total = w * h;
  const fullBytes = total >> 3;
  m.bits.fill(0xff, 0, fullBytes);
  const rem = total & 7;
  if (rem > 0) m.bits[fullBytes] = (1 << rem) - 1;
  return m;
}

/** Build a SelectionMask matching all non-transparent pixels (alpha > 0) of a cel (Ctrl+Click layer). */
export function layerAlphaMask(cel: Uint8ClampedArray, w: number, h: number): SelectionMask {
  const m = createMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cel[(y * w + x) * 4 + 3] > 0) setMaskBit(m, x, y, true);
    }
  }
  return m;
}

export function invertMask(m: SelectionMask): SelectionMask {
  const out = createMask(m.w, m.h);
  const total = m.w * m.h;
  const fullBytes = total >> 3;
  for (let i = 0; i < fullBytes; i++) out.bits[i] = ~m.bits[i] & 0xff;
  const rem = total & 7;
  if (rem > 0) out.bits[fullBytes] = ~m.bits[fullBytes] & ((1 << rem) - 1);
  return out;
}

export function combineMasks(
  base: SelectionMask | null,
  next: SelectionMask,
  mode: SelectionMode,
): SelectionMask {
  if (mode === 'replace' || !base) return cloneMask(next);
  const out = createMask(next.w, next.h);
  const len = Math.min(base.bits.length, next.bits.length);
  for (let i = 0; i < len; i++) {
    if (mode === 'add') out.bits[i] = base.bits[i] | next.bits[i];
    else if (mode === 'subtract') out.bits[i] = base.bits[i] & ~next.bits[i];
    else out.bits[i] = base.bits[i] & next.bits[i];
  }
  return out;
}

export function rectMask(w: number, h: number, a: Pt, b: Pt): SelectionMask {
  const m = createMask(w, h);
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(w - 1, Math.max(a.x, b.x));
  const y1 = Math.min(h - 1, Math.max(a.y, b.y));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) setMaskBit(m, x, y, true);
  }
  return m;
}

export function lassoMask(w: number, h: number, poly: Pt[]): SelectionMask {
  const m = createMask(w, h);
  if (poly.length < 3) {
    for (const p of poly) setMaskBit(m, p.x, p.y, true);
    return m;
  }
  let minY = h;
  let maxY = -1;
  for (const p of poly) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  minY = Math.max(0, minY);
  maxY = Math.min(h - 1, maxY);
  const xs: number[] = [];

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      const ay = a.y + 0.5;
      const by = b.y + 0.5;
      if ((ay <= py && by > py) || (by <= py && ay > py)) {
        const t = (py - ay) / (by - ay);
        xs.push(a.x + 0.5 + t * (b.x - a.x));
      }
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.floor(xs[k]));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) setMaskBit(m, x, y, true);
    }
  }
  return m;
}

function rgbaMatch(
  data: Uint8ClampedArray,
  idx: number,
  tr: number,
  tg: number,
  tb: number,
  ta: number,
  tol: number,
): boolean {
  if (tol <= 0) {
    return data[idx] === tr && data[idx + 1] === tg && data[idx + 2] === tb && data[idx + 3] === ta;
  }
  return (
    Math.abs(data[idx] - tr) <= tol &&
    Math.abs(data[idx + 1] - tg) <= tol &&
    Math.abs(data[idx + 2] - tb) <= tol &&
    Math.abs(data[idx + 3] - ta) <= tol
  );
}

export function magicWandMask(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  startX: number,
  startY: number,
  opts: { contiguous: boolean; tolerance?: number },
): SelectionMask {
  const m = createMask(w, h);
  if (startX < 0 || startY < 0 || startX >= w || startY >= h) return m;
  const tol = opts.tolerance ?? 0;
  const si = (startY * w + startX) * 4;
  const tr = data[si];
  const tg = data[si + 1];
  const tb = data[si + 2];
  const ta = data[si + 3];

  if (!opts.contiguous) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (rgbaMatch(data, (y * w + x) * 4, tr, tg, tb, ta, tol)) setMaskBit(m, x, y, true);
      }
    }
    return m;
  }

  const stack = new Int32Array(w * h * 2);
  let top = 0;
  stack[top++] = startX;
  stack[top++] = startY;

  while (top > 0) {
    const y = stack[--top];
    let x = stack[--top];
    if (getMaskBit(m, x, y) || !rgbaMatch(data, (y * w + x) * 4, tr, tg, tb, ta, tol)) continue;

    let lx = x;
    while (lx > 0 && !getMaskBit(m, lx - 1, y) && rgbaMatch(data, (y * w + (lx - 1)) * 4, tr, tg, tb, ta, tol)) {
      lx--;
    }
    let rx = x;
    while (rx + 1 < w && !getMaskBit(m, rx + 1, y) && rgbaMatch(data, (y * w + (rx + 1)) * 4, tr, tg, tb, ta, tol)) {
      rx++;
    }

    let upSpan = false;
    let dnSpan = false;
    for (let cx = lx; cx <= rx; cx++) {
      setMaskBit(m, cx, y, true);
      if (y > 0) {
        const hit = !getMaskBit(m, cx, y - 1) && rgbaMatch(data, ((y - 1) * w + cx) * 4, tr, tg, tb, ta, tol);
        if (hit && !upSpan) {
          stack[top++] = cx;
          stack[top++] = y - 1;
          upSpan = true;
        } else if (!hit) {
          upSpan = false;
        }
      }
      if (y + 1 < h) {
        const hit = !getMaskBit(m, cx, y + 1) && rgbaMatch(data, ((y + 1) * w + cx) * 4, tr, tg, tb, ta, tol);
        if (hit && !dnSpan) {
          stack[top++] = cx;
          stack[top++] = y + 1;
          dnSpan = true;
        } else if (!hit) {
          dnSpan = false;
        }
      }
    }
  }
  return m;
}

export function maskBounds(m: SelectionMask): Rect | null {
  let minX = m.w;
  let minY = m.h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (getMaskBit(m, x, y)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function maskEdges(m: SelectionMask): EdgeSegment[] {
  const segs: EdgeSegment[] = [];
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!getMaskBit(m, x, y)) continue;
      if (!getMaskBit(m, x, y - 1)) segs.push({ x1: x, y1: y, x2: x + 1, y2: y });
      if (!getMaskBit(m, x, y + 1)) segs.push({ x1: x, y1: y + 1, x2: x + 1, y2: y + 1 });
      if (!getMaskBit(m, x - 1, y)) segs.push({ x1: x, y1: y, x2: x, y2: y + 1 });
      if (!getMaskBit(m, x + 1, y)) segs.push({ x1: x + 1, y1: y, x2: x + 1, y2: y + 1 });
    }
  }
  return segs;
}

export function extractSelection(
  cel: Uint8ClampedArray,
  w: number,
  h: number,
  mask: SelectionMask | null,
): ExtractedBuffer | null {
  const rect = mask ? maskBounds(mask) : { x: 0, y: 0, w, h };
  if (!rect) return null;
  const pixels = new Uint8ClampedArray(rect.w * rect.h * 4);
  const subMask = createMask(rect.w, rect.h);
  for (let ry = 0; ry < rect.h; ry++) {
    for (let rx = 0; rx < rect.w; rx++) {
      const sx = rect.x + rx;
      const sy = rect.y + ry;
      if (mask && !getMaskBit(mask, sx, sy)) continue;
      setMaskBit(subMask, rx, ry, true);
      const si = (sy * w + sx) * 4;
      const di = (ry * rect.w + rx) * 4;
      pixels[di] = cel[si];
      pixels[di + 1] = cel[si + 1];
      pixels[di + 2] = cel[si + 2];
      pixels[di + 3] = cel[si + 3];
    }
  }
  return { rect, pixels, maskBits: subMask.bits };
}

export function clearSelection(
  cel: Uint8ClampedArray,
  w: number,
  h: number,
  mask: SelectionMask | null,
  alphaLock = false,
): void {
  if (alphaLock) return;
  if (!mask) {
    cel.fill(0);
    return;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!getMaskBit(mask, x, y)) continue;
      const i = (y * w + x) * 4;
      cel[i] = 0;
      cel[i + 1] = 0;
      cel[i + 2] = 0;
      cel[i + 3] = 0;
    }
  }
}

export function stampBuffer(
  cel: Uint8ClampedArray,
  w: number,
  h: number,
  pixels: Uint8ClampedArray,
  rect: Rect,
  dstX: number,
  dstY: number,
  opts?: { maskBits?: Uint8Array; alphaLock?: boolean; selection?: SelectionMask | null },
): void {
  const subMask = opts?.maskBits ? { w: rect.w, h: rect.h, bits: opts.maskBits } : null;
  const sel = opts?.selection ?? null;
  const alphaLock = opts?.alphaLock ?? false;

  for (let ry = 0; ry < rect.h; ry++) {
    const ty = dstY + ry;
    if (ty < 0 || ty >= h) continue;
    for (let rx = 0; rx < rect.w; rx++) {
      const tx = dstX + rx;
      if (tx < 0 || tx >= w) continue;
      if (subMask && !getMaskBit(subMask, rx, ry)) continue;
      if (sel && !getMaskBit(sel, tx, ty)) continue;
      const si = (ry * rect.w + rx) * 4;
      if (pixels[si + 3] === 0) continue;
      const di = (ty * w + tx) * 4;
      if (alphaLock && cel[di + 3] === 0) continue;
      cel[di] = pixels[si];
      cel[di + 1] = pixels[si + 1];
      cel[di + 2] = pixels[si + 2];
      cel[di + 3] = alphaLock ? cel[di + 3] : pixels[si + 3];
    }
  }
}
