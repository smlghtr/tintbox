import type { AnimDirection, Animation, Doc, RGBA } from './types';

export interface PlaybackRange {
  from: number;
  to: number;
  direction: AnimDirection;
  loop: boolean;
}

export function resolvePlaybackRange(
  doc: Doc,
  animationId: string | null,
  fallbackDirection: AnimDirection = 'forward',
  fallbackLoop = true,
): PlaybackRange {
  const maxIdx = Math.max(0, doc.frames.length - 1);
  if (animationId) {
    const anim = doc.animations.find((a) => a.id === animationId);
    if (anim) {
      const from = Math.max(0, Math.min(maxIdx, anim.from));
      const to = Math.max(from, Math.min(maxIdx, anim.to));
      return { from, to, direction: anim.direction, loop: anim.loop };
    }
  }
  return { from: 0, to: maxIdx, direction: fallbackDirection, loop: fallbackLoop };
}

export function buildPlaybackSequence(from: number, to: number, direction: AnimDirection): number[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const fwd: number[] = [];
  for (let i = lo; i <= hi; i++) fwd.push(i);
  if (direction === 'forward' || fwd.length <= 1) return fwd;
  if (direction === 'reverse') return fwd.reverse();
  // pingpong: 0, 1, 2, 1 (no duplicate endpoint hold)
  const back = fwd.slice(1, -1).reverse();
  return [...fwd, ...back];
}

export function stepPlayback(
  seq: number[],
  seqIdx: number,
  loop: boolean,
): { nextSeqIdx: number; frame: number; stopped: boolean } {
  if (seq.length === 0) return { nextSeqIdx: 0, frame: 0, stopped: true };
  const next = seqIdx + 1;
  if (next < seq.length) return { nextSeqIdx: next, frame: seq[next], stopped: false };
  if (loop) return { nextSeqIdx: 0, frame: seq[0], stopped: false };
  const last = seq.length - 1;
  return { nextSeqIdx: last, frame: seq[last], stopped: true };
}

export function frameDurationMs(doc: Doc, frameIndex: number): number {
  const f = doc.frames[frameIndex];
  if (f && f.duration > 0) return f.duration;
  return Math.max(16, Math.round(1000 / Math.max(1, doc.fps)));
}

export interface OnionSettings {
  enabled: boolean;
  before: number;
  after: number;
  mode: 'tinted' | 'original';
  source: 'composed' | 'active';
  wrap: boolean;
}

export interface OnionEntry {
  frame: number;
  kind: 'prev' | 'next';
  step: number;
  opacity: number;
}

export function computeOnionFrames(
  currentFrame: number,
  totalFrames: number,
  range: { from: number; to: number },
  opts: Pick<OnionSettings, 'before' | 'after' | 'wrap'>,
): OnionEntry[] {
  if (totalFrames <= 1) return [];
  const lo = Math.max(0, Math.min(totalFrames - 1, range.from));
  const hi = Math.max(lo, Math.min(totalFrames - 1, range.to));
  const span = hi - lo + 1;
  if (span <= 1) return [];

  const before = Math.max(0, Math.min(5, Math.round(opts.before)));
  const after = Math.max(0, Math.min(5, Math.round(opts.after)));
  const entries: OnionEntry[] = [];

  const resolve = (delta: number): number | null => {
    const raw = currentFrame + delta;
    if (opts.wrap) {
      const wrapped = lo + ((((raw - lo) % span) + span) % span);
      return wrapped === currentFrame ? null : wrapped;
    }
    if (raw < lo || raw > hi || raw === currentFrame) return null;
    return raw;
  };

  // Farthest first so closer onion frames draw cleanly on top
  for (let d = before; d >= 1; d--) {
    const f = resolve(-d);
    if (f !== null) {
      entries.push({ frame: f, kind: 'prev', step: d, opacity: (0.5 * (before - d + 1)) / before });
    }
  }
  for (let d = after; d >= 1; d--) {
    const f = resolve(d);
    if (f !== null) {
      entries.push({ frame: f, kind: 'next', step: d, opacity: (0.5 * (after - d + 1)) / after });
    }
  }
  return entries;
}

export const ONION_PREV_TINT: RGBA = [74, 168, 255, 255]; // --onion-prev #4aa8ff
export const ONION_NEXT_TINT: RGBA = [255, 138, 61, 255]; // --onion-next #ff8a3d

/** Returns a tinted or opacity-scaled copy of `src` for onion-skin display (pure, never mutates `src`). */
export function buildOnionBuffer(
  src: Uint8ClampedArray,
  mode: 'tinted' | 'original',
  tint: RGBA,
  opacity: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const op = Math.max(0, Math.min(1, opacity));
  const tr = tint[0];
  const tg = tint[1];
  const tb = tint[2];

  if (mode === 'tinted') {
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3];
      if (a === 0) continue;
      out[i] = tr;
      out[i + 1] = tg;
      out[i + 2] = tb;
      out[i + 3] = Math.round(a * op);
    }
  } else {
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3];
      if (a === 0) continue;
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
      out[i + 3] = Math.round(a * op);
    }
  }
  return out;
}

/** Counts how many opaque pixels in `rgba` match each swatch in `palette`. */
export function countPaletteUsage(rgba: Uint8ClampedArray, palette: RGBA[]): number[] {
  const counts = new Array<number>(palette.length).fill(0);
  if (palette.length === 0) return counts;
  const map = new Map<number, number[]>();
  for (let idx = 0; idx < palette.length; idx++) {
    const c = palette[idx];
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    const list = map.get(key);
    if (list) list.push(idx);
    else map.set(key, [idx]);
  }
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    const indices = map.get(key);
    if (indices) {
      for (const idx of indices) counts[idx]++;
    }
  }
  return counts;
}

export function clampAnimationsToFrameCount(anims: Animation[], frameCount: number): Animation[] {
  const maxIdx = Math.max(0, frameCount - 1);
  return anims.map((a) => {
    const from = Math.max(0, Math.min(maxIdx, a.from));
    const to = Math.max(from, Math.min(maxIdx, a.to));
    return { ...a, from, to };
  });
}
