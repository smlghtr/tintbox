import type { BlendMode, Rect } from './types';

function blendChannel(dc: number, sc: number, mode: BlendMode): number {
  switch (mode) {
    case 'normal':
      return sc;
    case 'multiply':
      return dc * sc;
    case 'screen':
      return dc + sc - dc * sc;
    case 'overlay':
      return dc < 0.5 ? 2 * dc * sc : 1 - 2 * (1 - dc) * (1 - sc);
    case 'add':
      return Math.min(1, dc + sc);
    case 'darken':
      return Math.min(dc, sc);
    case 'lighten':
      return Math.max(dc, sc);
    case 'difference':
      return Math.abs(dc - sc);
  }
}

/** Photoshop-style clipping mask: restricts `src` pixels to the alpha silhouette of `base`. */
export function applyClippingAlpha(src: Uint8ClampedArray, base: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const ba = base[i + 3];
    const sa = src[i + 3];
    if (ba === 0 || sa === 0) continue;
    out[i] = src[i];
    out[i + 1] = src[i + 1];
    out[i + 2] = src[i + 2];
    out[i + 3] = ba === 255 ? sa : Math.round((sa * ba) / 255);
  }
  return out;
}

function blendPixelAt(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  i: number,
  opacityScale: number,
  mode: BlendMode,
): void {
  const srcA = src[i + 3];
  if (srcA === 0) return;
  if (mode === 'normal' && srcA === 255 && opacityScale === 1) {
    dst[i] = src[i];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i + 2];
    dst[i + 3] = 255;
    return;
  }

  const sa = (srcA / 255) * opacityScale;
  const dstA = dst[i + 3];
  if (dstA === 0) {
    dst[i] = src[i];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i + 2];
    dst[i + 3] = Math.round(sa * 255);
    return;
  }

  const da = dstA / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;

  if (mode === 'normal') {
    const invSa = 1 - sa;
    dst[i] = (src[i] * sa + dst[i] * da * invSa) / oa;
    dst[i + 1] = (src[i + 1] * sa + dst[i + 1] * da * invSa) / oa;
    dst[i + 2] = (src[i + 2] * sa + dst[i + 2] * da * invSa) / oa;
    dst[i + 3] = oa * 255;
    return;
  }

  const invDa = 1 - da;
  const invSa = 1 - sa;
  const sada = sa * da;
  for (let c = 0; c < 3; c++) {
    const sc = src[i + c] / 255;
    const dc = dst[i + c] / 255;
    const b = blendChannel(dc, sc, mode);
    const outPre = invDa * sa * sc + invSa * da * dc + sada * b;
    dst[i + c] = Math.round((outPre / oa) * 255);
  }
  dst[i + 3] = Math.round(oa * 255);
}

export function compositeLayer(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  w: number,
  h: number,
  opacity: number,
  mode: BlendMode,
): void {
  const op = Math.max(0, Math.min(100, opacity)) / 100;
  if (op <= 0) return;
  const len = w * h * 4;

  // Fast hot path for normal mode at full opacity (the common case)
  if (mode === 'normal' && op === 1) {
    for (let i = 0; i < len; i += 4) {
      const srcA = src[i + 3];
      if (srcA === 0) continue;
      if (srcA === 255 || dst[i + 3] === 0) {
        dst[i] = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        dst[i + 3] = srcA;
      } else {
        const sa = srcA / 255;
        const da = dst[i + 3] / 255;
        const invSa = 1 - sa;
        const oa = sa + da * invSa;
        dst[i] = (src[i] * sa + dst[i] * da * invSa) / oa;
        dst[i + 1] = (src[i + 1] * sa + dst[i + 1] * da * invSa) / oa;
        dst[i + 2] = (src[i + 2] * sa + dst[i + 2] * da * invSa) / oa;
        dst[i + 3] = oa * 255;
      }
    }
    return;
  }

  for (let i = 0; i < len; i += 4) {
    if (src[i + 3] === 0) continue;
    blendPixelAt(dst, src, i, op, mode);
  }
}

export function compositeLayerRect(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  w: number,
  h: number,
  rect: Rect,
  opacity: number,
  mode: BlendMode,
): void {
  const op = Math.max(0, Math.min(100, opacity)) / 100;
  if (op <= 0) return;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(w, rect.x + rect.w);
  const y1 = Math.min(h, rect.y + rect.h);
  for (let y = y0; y < y1; y++) {
    let i = (y * w + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      if (src[i + 3] === 0) continue;
      blendPixelAt(dst, src, i, op, mode);
    }
  }
}
