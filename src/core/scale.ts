export type ResampleAlgorithm =
  | 'nearest'
  | 'epx2x'
  | 'scale3x'
  | 'hq2x'
  | 'epx4x'
  | 'bilinear'
  | 'bicubic'
  | 'lanczos';

export const RESAMPLE_ALGORITHMS: { id: ResampleAlgorithm; label: string; desc: string }[] = [
  { id: 'nearest', label: 'Nearest Neighbor', desc: 'Hard crisp pixel edges (default)' },
  { id: 'epx2x', label: 'Scale2x (EPX)', desc: 'Pixel-art edge-smoothing 2× upscaler' },
  { id: 'scale3x', label: 'Scale3x (AdvMAME)', desc: 'Pixel-art edge-smoothing 3× upscaler' },
  { id: 'hq2x', label: 'HQ2x (Edge-aware)', desc: 'Perceptual edge-preserving 2× upscaler' },
  { id: 'epx4x', label: 'Scale4x (EPX²)', desc: 'Crisp 4× pixel-art upscaler' },
  { id: 'bilinear', label: 'Bilinear', desc: 'Smooth linear interpolation' },
  { id: 'bicubic', label: 'Bicubic (Catmull-Rom)', desc: 'Sharp cubic resampling' },
  { id: 'lanczos', label: 'Lanczos-3', desc: 'High-detail windowed sinc resampling' },
];

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

function pxEq(src: Uint8ClampedArray, a: number, b: number): boolean {
  return (
    src[a] === src[b] &&
    src[a + 1] === src[b + 1] &&
    src[a + 2] === src[b + 2] &&
    src[a + 3] === src[b + 3]
  );
}

function pxDiffThreshold(src: Uint8ClampedArray, a: number, b: number): boolean {
  if (Math.abs(src[a + 3] - src[b + 3]) > 24) return true;
  const dr = src[a] - src[b];
  const dg = src[a + 1] - src[b + 1];
  const db = src[a + 2] - src[b + 2];
  // YUV-weighted perceptual distance
  const dy = Math.abs(0.299 * dr + 0.587 * dg + 0.114 * db);
  const du = Math.abs(-0.169 * dr - 0.331 * dg + 0.5 * db);
  const dv = Math.abs(0.5 * dr - 0.419 * dg - 0.081 * db);
  return dy > 48 || du > 7 || dv > 6;
}

function copyPx(dst: Uint8ClampedArray, di: number, src: Uint8ClampedArray, si: number): void {
  dst[di] = src[si];
  dst[di + 1] = src[si + 1];
  dst[di + 2] = src[si + 2];
  dst[di + 3] = src[si + 3];
}

function blendPx(dst: Uint8ClampedArray, di: number, src: Uint8ClampedArray, a: number, b: number, wa: number): void {
  const wb = 1 - wa;
  dst[di] = clampByte(src[a] * wa + src[b] * wb);
  dst[di + 1] = clampByte(src[a + 1] * wa + src[b + 1] * wb);
  dst[di + 2] = clampByte(src[a + 2] * wa + src[b + 2] * wb);
  dst[di + 3] = clampByte(src[a + 3] * wa + src[b + 3] * wb);
}

/** Exact EPX / Scale2x pixel-art upscaler (2x width, 2x height). */
export function upscaleEpx2x(src: Uint8ClampedArray, w: number, h: number): { data: Uint8ClampedArray; w: number; h: number } {
  const ow = w * 2;
  const oh = h * 2;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const idx = (x: number, y: number) => (Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = idx(x, y);
      const a = idx(x, y - 1);
      const b = idx(x + 1, y);
      const c = idx(x - 1, y);
      const d = idx(x, y + 1);

      let p1 = p;
      let p2 = p;
      let p3 = p;
      let p4 = p;
      if (!pxEq(src, c, b) && !pxEq(src, a, d)) {
        if (pxEq(src, c, a)) p1 = a;
        if (pxEq(src, a, b)) p2 = b;
        if (pxEq(src, d, c)) p3 = c;
        if (pxEq(src, b, d)) p4 = d;
      }
      copyPx(out, ((y * 2) * ow + x * 2) * 4, src, p1);
      copyPx(out, ((y * 2) * ow + x * 2 + 1) * 4, src, p2);
      copyPx(out, ((y * 2 + 1) * ow + x * 2) * 4, src, p3);
      copyPx(out, ((y * 2 + 1) * ow + x * 2 + 1) * 4, src, p4);
    }
  }
  return { data: out, w: ow, h: oh };
}

/** Exact AdvMAME Scale3x pixel-art upscaler (3x width, 3x height). */
export function upscaleScale3x(src: Uint8ClampedArray, w: number, h: number): { data: Uint8ClampedArray; w: number; h: number } {
  const ow = w * 3;
  const oh = h * 3;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const idx = (x: number, y: number) => (Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const A = idx(x - 1, y - 1);
      const B = idx(x, y - 1);
      const C = idx(x + 1, y - 1);
      const D = idx(x - 1, y);
      const E = idx(x, y);
      const F = idx(x + 1, y);
      const G = idx(x - 1, y + 1);
      const H = idx(x, y + 1);
      const I = idx(x + 1, y + 1);

      const e = [E, E, E, E, E, E, E, E, E];
      if (!pxEq(src, B, H) && !pxEq(src, D, F)) {
        if (pxEq(src, D, B)) e[0] = D;
        if ((pxEq(src, D, B) && !pxEq(src, E, C)) || (pxEq(src, B, F) && !pxEq(src, E, A))) e[1] = B;
        if (pxEq(src, B, F)) e[2] = F;
        if ((pxEq(src, D, B) && !pxEq(src, E, G)) || (pxEq(src, D, H) && !pxEq(src, E, A))) e[3] = D;
        if ((pxEq(src, B, F) && !pxEq(src, E, I)) || (pxEq(src, H, F) && !pxEq(src, E, C))) e[5] = F;
        if (pxEq(src, D, H)) e[6] = D;
        if ((pxEq(src, D, H) && !pxEq(src, E, I)) || (pxEq(src, H, F) && !pxEq(src, E, G))) e[7] = H;
        if (pxEq(src, H, F)) e[8] = F;
      }
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          copyPx(out, ((y * 3 + sy) * ow + (x * 3 + sx)) * 4, src, e[sy * 3 + sx]);
        }
      }
    }
  }
  return { data: out, w: ow, h: oh };
}

/** Edge-aware HQ2x-style perceptual upscaler (2x width, 2x height). */
export function upscaleHq2x(src: Uint8ClampedArray, w: number, h: number): { data: Uint8ClampedArray; w: number; h: number } {
  const ow = w * 2;
  const oh = h * 2;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const idx = (x: number, y: number) => (Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = idx(x, y);
      const n = idx(x, y - 1);
      const s = idx(x, y + 1);
      const ww = idx(x - 1, y);
      const e = idx(x + 1, y);

      const writeQuad = (qx: number, qy: number, hN: number, vN: number) => {
        const di = ((y * 2 + qy) * ow + x * 2 + qx) * 4;
        const hClose = !pxDiffThreshold(src, hN, vN);
        const oppDiff = pxDiffThreshold(src, c, hN);
        if (hClose && oppDiff) {
          blendPx(out, di, src, hN, c, 0.75);
        } else if (hClose) {
          blendPx(out, di, src, c, hN, 0.75);
        } else {
          copyPx(out, di, src, c);
        }
      };

      writeQuad(0, 0, ww, n);
      writeQuad(1, 0, e, n);
      writeQuad(0, 1, ww, s);
      writeQuad(1, 1, e, s);
    }
  }
  return { data: out, w: ow, h: oh };
}

function resampleNearest(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      copyPx(out, (y * dw + x) * 4, src, (sy * sw + sx) * 4);
    }
  }
  return out;
}

function resampleBilinear(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(sh - 1, y0 + 1));
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(sw - 1, x0 + 1));
      const tx = Math.max(0, Math.min(1, fx - x0));

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      // Premultiplied interpolation avoids dark fringes around transparent edges
      const a00 = src[i00 + 3] * w00;
      const a10 = src[i10 + 3] * w10;
      const a01 = src[i01 + 3] * w01;
      const a11 = src[i11 + 3] * w11;
      const aSum = a00 + a10 + a01 + a11;
      const di = (y * dw + x) * 4;
      if (aSum <= 0.001) continue;
      out[di] = clampByte((src[i00] * a00 + src[i10] * a10 + src[i01] * a01 + src[i11] * a11) / aSum);
      out[di + 1] = clampByte((src[i00 + 1] * a00 + src[i10 + 1] * a10 + src[i01 + 1] * a01 + src[i11 + 1] * a11) / aSum);
      out[di + 2] = clampByte((src[i00 + 2] * a00 + src[i10 + 2] * a10 + src[i01 + 2] * a01 + src[i11 + 2] * a11) / aSum);
      out[di + 3] = clampByte(aSum);
    }
  }
  return out;
}

function catmullRom(t: number): number {
  const x = Math.abs(t);
  if (x <= 1) return 1.5 * x * x * x - 2.5 * x * x + 1;
  if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
  return 0;
}

function lanczos3(t: number): number {
  const x = Math.abs(t);
  if (x === 0) return 1;
  if (x >= 3) return 0;
  const px = Math.PI * x;
  return (Math.sin(px) / px) * (Math.sin(px / 3) / (px / 3));
}

function resampleKernel(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  radius: number,
  kernel: (t: number) => number,
): Uint8ClampedArray {
  // Separable 2-pass premultiplied resampling (horizontal then vertical) for speed
  const tmp = new Float32Array(dw * sh * 4);
  const scaleX = sw / dw;
  const supportX = radius * Math.max(1, scaleX);

  for (let y = 0; y < sh; y++) {
    for (let dx = 0; dx < dw; dx++) {
      const center = (dx + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.floor(center - supportX));
      const x1 = Math.min(sw - 1, Math.ceil(center + supportX));
      let r = 0, g = 0, b = 0, a = 0, wSum = 0;
      const div = Math.max(1, scaleX);
      for (let sx = x0; sx <= x1; sx++) {
        const w = kernel((sx - center) / div);
        if (w === 0) continue;
        const si = (y * sw + sx) * 4;
        const sa = src[si + 3] / 255;
        r += src[si] * sa * w;
        g += src[si + 1] * sa * w;
        b += src[si + 2] * sa * w;
        a += src[si + 3] * w;
        wSum += w;
      }
      const ti = (y * dw + dx) * 4;
      if (wSum !== 0) {
        tmp[ti] = r / wSum;
        tmp[ti + 1] = g / wSum;
        tmp[ti + 2] = b / wSum;
        tmp[ti + 3] = a / wSum;
      }
    }
  }

  const out = new Uint8ClampedArray(dw * dh * 4);
  const scaleY = sh / dh;
  const supportY = radius * Math.max(1, scaleY);
  for (let dy = 0; dy < dh; dy++) {
    const center = (dy + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.floor(center - supportY));
    const y1 = Math.min(sh - 1, Math.ceil(center + supportY));
    const div = Math.max(1, scaleY);
    for (let dx = 0; dx < dw; dx++) {
      let r = 0, g = 0, b = 0, a = 0, wSum = 0;
      for (let sy = y0; sy <= y1; sy++) {
        const w = kernel((sy - center) / div);
        if (w === 0) continue;
        const ti = (sy * dw + dx) * 4;
        r += tmp[ti] * w;
        g += tmp[ti + 1] * w;
        b += tmp[ti + 2] * w;
        a += tmp[ti + 3] * w;
        wSum += w;
      }
      const di = (dy * dw + dx) * 4;
      if (wSum === 0) continue;
      const outA = Math.max(0, Math.min(255, a / wSum));
      if (outA <= 0.5) continue;
      const invA = 255 / outA;
      out[di] = clampByte((r / wSum) * invA);
      out[di + 1] = clampByte((g / wSum) * invA);
      out[di + 2] = clampByte((b / wSum) * invA);
      out[di + 3] = clampByte(outA);
    }
  }
  return out;
}

/** Resample an RGBA buffer from (sw, sh) to (dw, dh) using the chosen algorithm. */
export function resampleRgba(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  algorithm: ResampleAlgorithm = 'nearest',
): Uint8ClampedArray {
  if (sw === dw && sh === dh && algorithm === 'nearest') return src.slice();

  if (algorithm === 'epx2x') {
    const up = upscaleEpx2x(src, sw, sh);
    return up.w === dw && up.h === dh ? up.data : resampleNearest(up.data, up.w, up.h, dw, dh);
  }
  if (algorithm === 'epx4x') {
    const u1 = upscaleEpx2x(src, sw, sh);
    const u2 = upscaleEpx2x(u1.data, u1.w, u1.h);
    return u2.w === dw && u2.h === dh ? u2.data : resampleNearest(u2.data, u2.w, u2.h, dw, dh);
  }
  if (algorithm === 'scale3x') {
    const up = upscaleScale3x(src, sw, sh);
    return up.w === dw && up.h === dh ? up.data : resampleNearest(up.data, up.w, up.h, dw, dh);
  }
  if (algorithm === 'hq2x') {
    const up = upscaleHq2x(src, sw, sh);
    return up.w === dw && up.h === dh ? up.data : resampleNearest(up.data, up.w, up.h, dw, dh);
  }
  if (algorithm === 'bilinear') return resampleBilinear(src, sw, sh, dw, dh);
  if (algorithm === 'bicubic') return resampleKernel(src, sw, sh, dw, dh, 2, catmullRom);
  if (algorithm === 'lanczos') return resampleKernel(src, sw, sh, dw, dh, 3, lanczos3);
  return resampleNearest(src, sw, sh, dw, dh);
}
