import type { PixelDiff } from './types';

export function computeDiff(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  w: number,
  h: number,
): PixelDiff | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    const rowOff = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x * 4;
      if (
        before[i] !== after[i] ||
        before[i + 1] !== after[i + 1] ||
        before[i + 2] !== after[i + 2] ||
        before[i + 3] !== after[i + 3]
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX) return null;

  const rw = maxX - minX + 1;
  const rh = maxY - minY + 1;
  const bPatch = new Uint8ClampedArray(rw * rh * 4);
  const aPatch = new Uint8ClampedArray(rw * rh * 4);

  for (let row = 0; row < rh; row++) {
    const srcStart = ((minY + row) * w + minX) * 4;
    const srcEnd = srcStart + rw * 4;
    const dstStart = row * rw * 4;
    bPatch.set(before.subarray(srcStart, srcEnd), dstStart);
    aPatch.set(after.subarray(srcStart, srcEnd), dstStart);
  }

  return { x: minX, y: minY, w: rw, h: rh, before: bPatch, after: aPatch };
}

export function applyDiff(
  cel: Uint8ClampedArray,
  w: number,
  diff: PixelDiff,
  side: 'before' | 'after',
): void {
  const patch = side === 'before' ? diff.before : diff.after;
  const rowBytes = diff.w * 4;
  for (let row = 0; row < diff.h; row++) {
    const srcStart = row * rowBytes;
    const dstStart = ((diff.y + row) * w + diff.x) * 4;
    cel.set(patch.subarray(srcStart, srcStart + rowBytes), dstStart);
  }
}

export function diffByteSize(diff: PixelDiff): number {
  return diff.before.byteLength + diff.after.byteLength;
}
