import { getMaskBit, type SelectionMask } from './selection';
import type { RGBA } from './types';

export type JuicePreset =
  | 'squash-bounce'
  | 'tree-sway'
  | 'jelly-wobble'
  | 'hit-flash'
  | 'float-bob'
  | 'spin-pulse'
  | 'custom';

export interface JuicePresetMeta {
  id: JuicePreset;
  label: string;
}

export const JUICE_PRESETS: JuicePresetMeta[] = [
  { id: 'squash-bounce', label: 'Squash Bounce' },
  { id: 'tree-sway', label: 'Tree Sway' },
  { id: 'jelly-wobble', label: 'Jelly Wobble' },
  { id: 'hit-flash', label: 'Hit Flash' },
  { id: 'float-bob', label: 'Float Bob' },
  { id: 'spin-pulse', label: 'Spin Pulse' },
  { id: 'custom', label: 'Custom' },
];

export interface JuiceParams {
  preset: JuicePreset;
  /** Number of animation frames to generate (2..32). */
  frames: number;
  /** Playback speed in frames per second (2..24). */
  fps: number;
  /** Normalized pivot X (0 = left, 0.5 = center, 1 = right). */
  pivotX: number;
  /** Normalized pivot Y (0 = top, 0.5 = center, 1 = bottom). */
  pivotY: number;
  /** Horizontal scale oscillation amplitude (0..80%). */
  scaleX: number;
  /** Vertical scale oscillation amplitude (0..80%). */
  scaleY: number;
  /** Max horizontal skew in degrees (-45..45). */
  skew: number;
  /** Max rotation tilt in degrees (-45..45). */
  rotate: number;
  /** Vertical jump/bob travel in pixels (0..24). */
  jumpY: number;
  /** Horizontal wave deformation amplitude in pixels (0..8). */
  waveAmp: number;
  /** Wave cycles across sprite height (1..4). */
  waveFreq: number;
  /** Deterministic shake amplitude in pixels (0..8). */
  shake: number;
  /** Exponential damping (0 = endless loop, 100 = strong one-shot settle). */
  damping: number;
  /** Oscillation cycles across the clip (1..4). */
  speed: number;
  /** Peak flash color mix (0..100%). */
  flashStrength: number;
  flashColor: RGBA;
  /** True = nearest-neighbor crisp pixels; false = smooth bilinear HD mode. */
  pixelArt: boolean;
  /** Optional 1px crisp outer outline applied after transform. */
  outline: boolean;
  outlineColor: RGBA;
}

const WHITE: RGBA = [255, 255, 255, 255];
const DARK_OUTLINE: RGBA = [20, 19, 15, 255];

export function defaultJuiceParams(preset: JuicePreset = 'squash-bounce'): JuiceParams {
  const base: JuiceParams = {
    preset,
    frames: 8,
    fps: 10,
    pivotX: 0.5,
    pivotY: 1,
    scaleX: 0,
    scaleY: 0,
    skew: 0,
    rotate: 0,
    jumpY: 0,
    waveAmp: 0,
    waveFreq: 1.5,
    shake: 0,
    damping: 0,
    speed: 1,
    flashStrength: 0,
    flashColor: [...WHITE],
    pixelArt: true,
    outline: false,
    outlineColor: [...DARK_OUTLINE],
  };

  switch (preset) {
    case 'squash-bounce':
      return { ...base, frames: 8, fps: 12, pivotY: 1, scaleX: 20, scaleY: 22, jumpY: 6, damping: 0, speed: 1 };
    case 'tree-sway':
      return { ...base, frames: 8, fps: 8, pivotY: 1, skew: 10, waveAmp: 2.5, waveFreq: 1.2, damping: 0, speed: 1 };
    case 'jelly-wobble':
      return { ...base, frames: 10, fps: 12, pivotY: 0.5, scaleX: 26, scaleY: 24, skew: 8, damping: 45, speed: 2 };
    case 'hit-flash':
      return {
        ...base,
        frames: 6,
        fps: 14,
        pivotY: 0.5,
        scaleX: 18,
        scaleY: 16,
        shake: 3,
        damping: 70,
        speed: 2,
        flashStrength: 90,
      };
    case 'float-bob':
      return { ...base, frames: 8, fps: 8, pivotY: 0.5, jumpY: 4, rotate: 5, damping: 0, speed: 1 };
    case 'spin-pulse':
      return { ...base, frames: 8, fps: 10, pivotY: 0.5, scaleX: 14, scaleY: 14, rotate: 16, damping: 0, speed: 1 };
    case 'custom':
      return { ...base, frames: 8, fps: 10, pivotY: 0.5, scaleX: 15, scaleY: 15, speed: 1 };
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function sampleNearest(src: Uint8ClampedArray, w: number, h: number, sx: number, sy: number): RGBA {
  const ix = Math.round(sx);
  const iy = Math.round(sy);
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return [0, 0, 0, 0];
  const i = (iy * w + ix) * 4;
  return [src[i], src[i + 1], src[i + 2], src[i + 3]];
}

function sampleBilinear(src: Uint8ClampedArray, w: number, h: number, sx: number, sy: number): RGBA {
  if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) return [0, 0, 0, 0];
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  const get = (x: number, y: number): RGBA => {
    if (x < 0 || y < 0 || x >= w || y >= h) return [0, 0, 0, 0];
    const i = (y * w + x) * 4;
    return [src[i], src[i + 1], src[i + 2], src[i + 3]];
  };
  const c00 = get(x0, y0);
  const c10 = get(x0 + 1, y0);
  const c01 = get(x0, y0 + 1);
  const c11 = get(x0 + 1, y0 + 1);
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const a = c00[3] * w00 + c10[3] * w10 + c01[3] * w01 + c11[3] * w11;
  if (a < 1) return [0, 0, 0, 0];
  // Premultiplied interpolation avoids dark fringes around transparent edges
  const r = (c00[0] * c00[3] * w00 + c10[0] * c10[3] * w10 + c01[0] * c01[3] * w01 + c11[0] * c11[3] * w11) / a;
  const g = (c00[1] * c00[3] * w00 + c10[1] * c10[3] * w10 + c01[1] * c01[3] * w01 + c11[1] * c11[3] * w11) / a;
  const b = (c00[2] * c00[3] * w00 + c10[2] * c10[3] * w10 + c01[2] * c01[3] * w01 + c11[2] * c11[3] * w11) / a;
  return [Math.round(clamp(r, 0, 255)), Math.round(clamp(g, 0, 255)), Math.round(clamp(b, 0, 255)), Math.round(clamp(a, 0, 255))];
}

function applyOuterOutline1px(src: Uint8ClampedArray, w: number, h: number, color: RGBA): Uint8ClampedArray {
  const out = src.slice();
  const [cr, cg, cb, ca] = color;
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (src[i + 3] > 0) continue;
      const touches =
        (x > 0 && src[i - 1] > 0) ||
        (x + 1 < w && src[i + 7] > 0) ||
        (y > 0 && src[i - stride + 3] > 0) ||
        (y + 1 < h && src[i + stride + 3] > 0);
      if (touches) {
        out[i] = cr;
        out[i + 1] = cg;
        out[i + 2] = cb;
        out[i + 3] = ca;
      }
    }
  }
  return out;
}

/** Deterministic pseudo-noise in [-1, 1] keyed by integer frame index. */
function shakeAxis(frameIdx: number, salt: number): number {
  const v = Math.sin((frameIdx + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

/**
 * Evaluate a single procedural Juice FX frame for RGBA buffer `src`.
 * Pure & deterministic: never mutates `src`.
 */
export function evalJuiceFrame(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  frameIdx: number,
  params: JuiceParams,
  mask?: SelectionMask | null,
): Uint8ClampedArray {
  const total = Math.max(2, Math.min(32, Math.round(params.frames)));
  const t = ((frameIdx % total) + total) % total / total;
  const speed = clamp(params.speed, 0.5, 4);
  const dampingNorm = clamp(params.damping, 0, 100) / 100;
  const decay = dampingNorm > 0 ? Math.exp(-dampingNorm * 3.2 * t) : 1;
  const phase = t * Math.PI * 2 * speed;
  const waveSin = Math.sin(phase) * decay;
  const waveCos = Math.cos(phase) * decay;

  // Squash & stretch: inverse phase between X and Y preserves perceived volume
  const sxFactor = Math.max(0.25, 1 + (clamp(params.scaleX, 0, 80) / 100) * waveSin);
  const syFactor = Math.max(0.25, 1 - (clamp(params.scaleY, 0, 80) / 100) * waveSin);
  const rotRad = ((clamp(params.rotate, -45, 45) * Math.PI) / 180) * waveSin;
  const skewTan = Math.tan(((clamp(params.skew, -45, 45) * Math.PI) / 180) * waveSin);

  // Jump / float arc: strictly upward (negative Y)
  const jumpAmp = clamp(params.jumpY, 0, 24);
  const jumpOffsetY =
    params.preset === 'float-bob'
      ? -Math.sin(phase) * jumpAmp * 0.5 * decay
      : -Math.abs(Math.sin(phase * 0.5)) * jumpAmp * decay;

  const shakeAmp = clamp(params.shake, 0, 8) * decay;
  const shakeX = shakeAmp > 0 ? shakeAxis(frameIdx, 1) * shakeAmp : 0;
  const shakeY = shakeAmp > 0 ? shakeAxis(frameIdx, 2) * shakeAmp : 0;

  const waveAmp = clamp(params.waveAmp, 0, 8) * decay;
  const waveFreq = clamp(params.waveFreq, 0.5, 4);

  // Flash envelope: quick impact decay when damped, smooth pulse when looping
  const flashPeak = clamp(params.flashStrength, 0, 100) / 100;
  const flashMix =
    flashPeak <= 0
      ? 0
      : dampingNorm > 0
      ? flashPeak * Math.exp(-t * 4.5) * (frameIdx === 0 ? 1 : Math.max(0, 0.5 + 0.5 * waveCos))
      : flashPeak * Math.max(0, Math.sin(phase));

  const px = clamp(params.pivotX, 0, 1) * Math.max(1, w - 1);
  const py = clamp(params.pivotY, 0, 1) * Math.max(1, h - 1);
  const cosR = Math.cos(-rotRad);
  const sinR = Math.sin(-rotRad);

  const out = mask ? src.slice() : new Uint8ClampedArray(w * h * 4);
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

  const [fr, fg, fb] = params.flashColor;
  const invH = 1 / Math.max(1, h - 1);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask && !getMaskBit(mask, x, y)) continue;

      // Undo translation (jump + shake)
      let lx = x - px - shakeX;
      let ly = y - py - jumpOffsetY - shakeY;

      // Undo horizontal wave weighted by distance from pivotY (anchors base of trees/grass)
      if (waveAmp > 0) {
        const anchorWeight = clamp(Math.abs(y - py) * invH, 0, 1);
        const waveDx = Math.sin(y * invH * Math.PI * 2 * waveFreq + phase) * waveAmp * anchorWeight;
        lx -= waveDx;
      }

      // Undo rotation
      const rx = lx * cosR - ly * sinR;
      const ry = lx * sinR + ly * cosR;

      // Undo horizontal skew + scale
      const ux = (rx - ry * skewTan) / sxFactor;
      const uy = ry / syFactor;

      const sx = ux + px;
      const sy = uy + py;

      if (mask) {
        const ix = Math.round(sx);
        const iy = Math.round(sy);
        if (ix < 0 || iy < 0 || ix >= w || iy >= h || !getMaskBit(mask, ix, iy)) continue;
      }

      const rgba = params.pixelArt ? sampleNearest(src, w, h, sx, sy) : sampleBilinear(src, w, h, sx, sy);
      if (rgba[3] === 0) continue;

      const di = (y * w + x) * 4;
      if (flashMix > 0.005) {
        out[di] = Math.round(rgba[0] + (fr - rgba[0]) * flashMix);
        out[di + 1] = Math.round(rgba[1] + (fg - rgba[1]) * flashMix);
        out[di + 2] = Math.round(rgba[2] + (fb - rgba[2]) * flashMix);
        out[di + 3] = rgba[3];
      } else {
        out[di] = rgba[0];
        out[di + 1] = rgba[1];
        out[di + 2] = rgba[2];
        out[di + 3] = rgba[3];
      }
    }
  }

  if (params.outline) {
    return applyOuterOutline1px(out, w, h, params.outlineColor);
  }
  return out;
}

/** Generate all frames of a procedural Juice FX clip. */
export function generateJuiceFrames(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  params: JuiceParams,
  mask?: SelectionMask | null,
): Uint8ClampedArray[] {
  const count = Math.max(2, Math.min(32, Math.round(params.frames)));
  const frames: Uint8ClampedArray[] = [];
  for (let f = 0; f < count; f++) {
    frames.push(evalJuiceFrame(src, w, h, f, params, mask));
  }
  return frames;
}
