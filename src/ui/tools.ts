import { renderDitherGradient, renderMaskGradient, stampDitherBrush } from '../core/dither';
import { getLayerCelIndex } from '../core/doc';
import {
  StrokeTracker,
  bresenham,
  floodFill,
  moveCelPixels,
  pixelLine,
  snapLineAngle,
  stampBrush,
  stampMaskBrush,
} from '../core/raster';
import { resampleRgba } from '../core/scale';
import {
  clearSelection,
  combineMasks,
  extractSelection,
  lassoMask,
  magicWandMask,
  rectMask,
  stampBuffer,
  type SelectionMask,
} from '../core/selection';
import { autoSmoothBezierAnchors, rasterizeBezierPath, rasterizeShapePreset } from '../core/shapes';
import { mirrorPoints } from '../core/symmetry';
import { wrapPoints } from '../core/tiles';
import type { BezierAnchor, Pt, RGBA, Rect, SelectionMode, TileMode } from '../core/types';
import { clampPan, type Viewport } from '../core/viewport';
import { defaultWarpParams, warpCelPixels, type WarpParams } from '../core/warp';
import { appendPaletteColorsCommand, referencePropCommand } from '../state/commands';
import type { ToolId } from '../state/ui';
import type { AppController } from './controller';

const CLEAR: RGBA = [0, 0, 0, 0];

function wrapFlags(mode: TileMode): { wrapX: boolean; wrapY: boolean } {
  return {
    wrapX: mode === 'x' || mode === 'xy',
    wrapY: mode === 'y' || mode === 'xy',
  };
}

export interface ToolEvent {
  docPt: Pt;
  screenX: number;
  screenY: number;
  shift: boolean;
  alt: boolean;
  button: number;
}

export interface ToolPreview {
  pts: Pt[];
  color: RGBA;
  size: number;
}

export interface Tool {
  readonly id: ToolId;
  readonly name: string;
  readonly key: string;
  readonly hint: string;
  readonly cursor: string;
  down(e: ToolEvent): void;
  move(e: ToolEvent): void;
  up(e: ToolEvent): void;
  cancel(): void;
  commit?(): void;
  deleteLastVertex?(): boolean;
  smoothPath?(tension: number): void;
  sharpPath?(): void;
  getPreview?(): ToolPreview | null;
  overlay?(ctx: CanvasRenderingContext2D, vp: Viewport): void;
}

export interface ToolHost {
  ctrl: AppController;
  requestRender: () => void;
  getStageSize: () => { w: number; h: number };
}

function selectionMode(e: ToolEvent): SelectionMode {
  if (e.shift && e.alt) return 'intersect';
  if (e.shift) return 'add';
  if (e.alt) return 'subtract';
  return 'replace';
}

function restorePixels(dst: Uint8ClampedArray, src: Uint8ClampedArray, w: number, h: number, pts: Pt[]): void {
  for (const p of pts) {
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) continue;
    const i = (p.y * w + p.x) * 4;
    dst[i] = src[i];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i + 2];
    dst[i + 3] = src[i + 3];
  }
}

function dirtyBoundsOf(pts: Pt[], pad: number, w: number, h: number): Rect {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const x1 = Math.min(w - 1, maxX + pad);
  const y1 = Math.min(h - 1, maxY + pad);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0 + 1), h: Math.max(0, y1 - y0 + 1) };
}

function makeBrushTool(host: ToolHost, id: 'pencil' | 'eraser'): Tool {
  const { ctrl } = host;
  let active: {
    before: Uint8ClampedArray;
    maskBefore: Uint8Array | null;
    maskVal: number;
    tracker: StrokeTracker;
    color: RGBA;
    size: number;
  } | null = null;

  const paintPts = (pts: Pt[], removed: Pt[]) => {
    if (!active) return;
    const s = ctrl.state;
    const { wrapX, wrapY } = wrapFlags(s.tileMode);
    if (active.maskBefore) {
      const maskTarget = ctrl.getActiveMaskBuffer();
      if (!maskTarget) return;
      const mirroredRemove = wrapPoints(mirrorPoints(removed, s.symmetry), s.doc.w, s.doc.h, s.tileMode);
      for (const p of mirroredRemove) {
        if (p.x >= 0 && p.y >= 0 && p.x < s.doc.w && p.y < s.doc.h) {
          maskTarget.buf[p.y * s.doc.w + p.x] = active.maskBefore[p.y * s.doc.w + p.x];
        }
      }
      stampMaskBrush(maskTarget.buf, s.doc.w, s.doc.h, mirrorPoints(pts, s.symmetry), active.maskVal, {
        size: active.size,
        shape: s.brushShape,
        mask: s.selection,
        wrapX,
        wrapY,
      });
      ctrl.markDirty(s.activeFrame);
      host.requestRender();
      return;
    }

    const layer = ctrl.getActiveLayer();
    const cel = ctrl.getActiveCel();
    const mirroredRemove = wrapPoints(mirrorPoints(removed, s.symmetry), s.doc.w, s.doc.h, s.tileMode);
    if (mirroredRemove.length > 0) restorePixels(cel, active.before, s.doc.w, s.doc.h, mirroredRemove);
    const mirroredAdd = mirrorPoints(pts, s.symmetry);
    stampBrush(cel, s.doc.w, s.doc.h, mirroredAdd, active.color, {
      size: active.size,
      shape: s.brushShape,
      mask: s.selection,
      alphaLock: layer.alphaLock,
      wrapX,
      wrapY,
    });
    if ((s.doc.w > 256 || s.doc.h > 256) && s.tileMode === 'none') {
      const rect = dirtyBoundsOf([...mirroredAdd, ...mirroredRemove], Math.ceil(active.size) + 1, s.doc.w, s.doc.h);
      ctrl.recomposeDirtyRect(s.activeFrame, rect);
    } else {
      ctrl.markDirty(s.activeFrame);
    }
    host.requestRender();
  };

  return {
    id,
    name: id === 'pencil' ? 'Pencil' : 'Eraser',
    key: id === 'pencil' ? 'B' : 'E',
    hint: id === 'pencil' ? 'Drag to draw (0.2–32px) · Alt+click pick color · [ ] size · Space pan' : 'Drag to erase · Alt+click pick color · [ ] size',
    cursor: 'crosshair',
    down(e) {
      const s = ctrl.state;
      const maskTarget = ctrl.getActiveMaskBuffer();
      if (maskTarget) {
        const rawColor = e.button === 2 ? s.secondaryColor : s.primaryColor;
        const lum = Math.round(0.299 * rawColor[0] + 0.587 * rawColor[1] + 0.114 * rawColor[2]);
        const maskVal = id === 'eraser' ? 0 : e.button === 2 ? 0 : lum;
        active = {
          before: new Uint8ClampedArray(0),
          maskBefore: maskTarget.buf.slice(),
          maskVal,
          tracker: new StrokeTracker(e.docPt, s.pixelPerfect && s.brushSize <= 1),
          color: rawColor,
          size: s.brushSize,
        };
        ctrl.store.setState({ strokeActive: true });
        paintPts([e.docPt], []);
        return;
      }
      const layer = ctrl.ensureEditableLayer();
      if (!layer) return;
      const cel = ctrl.getActiveCel();
      const rawColor = e.button === 2 ? s.secondaryColor : s.primaryColor;
      const color = id === 'eraser' ? CLEAR : ctrl.resolveDrawColor(rawColor);
      const usePerfect = s.pixelPerfect && s.brushSize <= 1;
      active = {
        before: cel.slice(),
        maskBefore: null,
        maskVal: 255,
        tracker: new StrokeTracker(e.docPt, usePerfect),
        color,
        size: s.brushSize,
      };
      ctrl.store.setState({ strokeActive: true });
      paintPts([e.docPt], []);
    },
    move(e) {
      if (!active) return;
      const { add, remove } = active.tracker.step(e.docPt);
      if (add.length === 0 && remove.length === 0) return;
      paintPts(add, remove);
    },
    up() {
      if (!active) return;
      const cur = active;
      active = null;
      ctrl.store.setState({ strokeActive: false });
      if (cur.maskBefore) {
        ctrl.commitMaskChange(cur.maskBefore, id === 'pencil' ? 'Paint mask' : 'Erase mask');
      } else {
        ctrl.commitCelChange(cur.before, id === 'pencil' ? 'Pencil stroke' : 'Eraser stroke');
      }
      host.requestRender();
    },
    cancel() {
      if (!active) return;
      if (active.maskBefore) {
        const maskTarget = ctrl.getActiveMaskBuffer();
        if (maskTarget) maskTarget.buf.set(active.maskBefore);
      } else {
        ctrl.getActiveCel().set(active.before);
      }
      active = null;
      ctrl.store.setState({ strokeActive: false });
      ctrl.markDirty(ctrl.state.activeFrame);
      host.requestRender();
    },
  };
}

function makeGradientTool(host: ToolHost): Tool {
  const { ctrl } = host;
  let live: {
    a: Pt;
    b: Pt;
    beforeCel: Uint8ClampedArray | null;
    beforeMask: Uint8Array | null;
  } | null = null;
  let dragEnd: 'a' | 'b' | null = null;

  const applyLive = () => {
    if (!live) return;
    const s = ctrl.state;
    if (live.beforeMask) {
      const target = ctrl.getActiveMaskBuffer();
      if (!target) return;
      target.buf.set(live.beforeMask);
      renderMaskGradient(target.buf, s.doc.w, s.doc.h, live.a, live.b, {
        shape: s.gradientShape,
        pattern: s.gradientPattern,
        dither: true,
        fromVal: 255,
        toVal: 0,
        mask: s.selection,
      });
      ctrl.markDirty(s.activeFrame);
      host.requestRender();
      return;
    }
    if (!live.beforeCel) return;
    const layer = ctrl.getActiveLayer();
    const cel = ctrl.getActiveCel();
    cel.set(live.beforeCel);
    renderDitherGradient(cel, s.doc.w, s.doc.h, live.a, live.b, {
      shape: s.gradientShape,
      pattern: s.gradientPattern,
      from: ctrl.resolveDrawColor(s.primaryColor),
      to: ctrl.resolveDrawColor(s.secondaryColor),
      stops: s.gradientMultiStop && s.gradientStops.length >= 2 ? s.gradientStops : undefined,
      toTransparent: s.gradientToTransparent,
      mask: s.selection,
      alphaLock: layer.alphaLock,
    });
    ctrl.markDirty(s.activeFrame);
    host.requestRender();
  };

  const commitLive = () => {
    if (!live) return;
    const cur = live;
    live = null;
    dragEnd = null;
    ctrl.store.setState({ strokeActive: false, gradientActive: false });
    if (cur.beforeMask) {
      ctrl.commitMaskChange(cur.beforeMask, 'Mask gradient');
    } else if (cur.beforeCel) {
      ctrl.commitCelChange(cur.beforeCel, 'Dither gradient');
    }
    host.requestRender();
  };

  const hitPt = (pt: Pt, sx: number, sy: number) => {
    const vp = ctrl.state.viewport;
    const hx = vp.panX + (pt.x + 0.5) * vp.zoom;
    const hy = vp.panY + (pt.y + 0.5) * vp.zoom;
    return Math.hypot(sx - hx, sy - hy) <= 10;
  };

  return {
    id: 'gradient',
    name: 'Dither gradient',
    key: 'K',
    hint: 'Drag directly on canvas for dither gradient · Adjust handles · Works on masks · Enter apply',
    cursor: 'crosshair',
    down(e) {
      if (live) {
        if (hitPt(live.a, e.screenX, e.screenY)) {
          dragEnd = 'a';
          ctrl.store.setState({ strokeActive: true });
          return;
        }
        if (hitPt(live.b, e.screenX, e.screenY)) {
          dragEnd = 'b';
          ctrl.store.setState({ strokeActive: true });
          return;
        }
        commitLive();
      }
      const maskTarget = ctrl.getActiveMaskBuffer();
      if (maskTarget) {
        live = { a: e.docPt, b: e.docPt, beforeCel: null, beforeMask: maskTarget.buf.slice() };
      } else {
        const layer = ctrl.ensureEditableLayer();
        if (!layer) return;
        live = { a: e.docPt, b: e.docPt, beforeCel: ctrl.getActiveCel().slice(), beforeMask: null };
      }
      dragEnd = 'b';
      ctrl.store.setState({ strokeActive: true, gradientActive: true });
      applyLive();
    },
    move(e) {
      if (!live || !dragEnd) return;
      const pt = e.shift ? snapLineAngle(dragEnd === 'b' ? live.a : live.b, e.docPt) : e.docPt;
      if (dragEnd === 'a') live.a = pt;
      else live.b = pt;
      applyLive();
    },
    up() {
      if (!live) return;
      dragEnd = null;
      ctrl.store.setState({ strokeActive: false });
      applyLive();
    },
    commit: commitLive,
    cancel() {
      if (!live) return;
      if (live.beforeMask) {
        const target = ctrl.getActiveMaskBuffer();
        if (target) target.buf.set(live.beforeMask);
      } else if (live.beforeCel) {
        ctrl.getActiveCel().set(live.beforeCel);
      }
      live = null;
      dragEnd = null;
      ctrl.store.setState({ strokeActive: false, gradientActive: false });
      ctrl.markDirty(ctrl.state.activeFrame);
      host.requestRender();
    },
    overlay(ctx, vp) {
      if (!live) return;
      const ax = vp.panX + (live.a.x + 0.5) * vp.zoom;
      const ay = vp.panY + (live.a.y + 0.5) * vp.zoom;
      const bx = vp.panX + (live.b.x + 0.5) * vp.zoom;
      const by = vp.panY + (live.b.y + 0.5) * vp.zoom;
      ctx.save();
      ctx.strokeStyle = '#14130f';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.strokeStyle = '#c6f432';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      for (const [hx, hy, fill] of [
        [ax, ay, '#ffffff'],
        [bx, by, '#c6f432'],
      ] as const) {
        ctx.fillStyle = fill;
        ctx.strokeStyle = '#14130f';
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    },
  };
}

function makeDitherTool(host: ToolHost): Tool {
  const { ctrl } = host;
  let active: {
    before: Uint8ClampedArray;
    tracker: StrokeTracker;
    primary: RGBA;
    secondary: RGBA;
    size: number;
  } | null = null;

  const paintPts = (pts: Pt[]) => {
    if (!active) return;
    const s = ctrl.state;
    const layer = ctrl.getActiveLayer();
    const cel = ctrl.getActiveCel();
    const mirrored = mirrorPoints(pts, s.symmetry);
    const { wrapX, wrapY } = wrapFlags(s.tileMode);
    stampDitherBrush(cel, s.doc.w, s.doc.h, mirrored, active.primary, {
      size: active.size,
      shape: s.brushShape,
      pattern: s.ditherPattern,
      density: s.ditherDensity,
      dual: s.ditherDual,
      secondary: active.secondary,
      mask: s.selection,
      alphaLock: layer.alphaLock,
      wrapX,
      wrapY,
    });
    ctrl.markDirty(s.activeFrame);
    host.requestRender();
  };

  return {
    id: 'dither',
    name: 'Dither brush',
    key: 'D',
    hint: 'Drag to paint pattern dither · [ ] size · Alt grab · Dual color in bar',
    cursor: 'crosshair',
    down(e) {
      if (!ctrl.ensureEditableLayer()) return;
      const s = ctrl.state;
      const cel = ctrl.getActiveCel();
      const useSecondary = e.button === 2;
      active = {
        before: cel.slice(),
        tracker: new StrokeTracker(e.docPt, false),
        primary: ctrl.resolveDrawColor(useSecondary ? s.secondaryColor : s.primaryColor),
        secondary: ctrl.resolveDrawColor(useSecondary ? s.primaryColor : s.secondaryColor),
        size: s.brushSize,
      };
      ctrl.store.setState({ strokeActive: true });
      paintPts([e.docPt]);
    },
    move(e) {
      if (!active) return;
      const { add } = active.tracker.step(e.docPt);
      if (add.length > 0) paintPts(add);
    },
    up() {
      if (!active) return;
      const before = active.before;
      active = null;
      ctrl.store.setState({ strokeActive: false });
      ctrl.commitCelChange(before, 'Dither stroke');
      host.requestRender();
    },
    cancel() {
      if (!active) return;
      ctrl.getActiveCel().set(active.before);
      active = null;
      ctrl.store.setState({ strokeActive: false });
      ctrl.markDirty(ctrl.state.activeFrame);
      host.requestRender();
    },
  };
}

function makeShapeTool(host: ToolHost, id: 'line' | 'rect' | 'ellipse'): Tool {
  const { ctrl } = host;
  let live: { a: Pt; b: Pt; shift: boolean; alt: boolean } | null = null;
  let dragHandle: 'a' | 'b' | null = null;

  const computePts = (d: { a: Pt; b: Pt; shift: boolean; alt: boolean }): Pt[] => {
    const s = ctrl.state;
    let raw: Pt[];
    if (id === 'line') {
      const end = d.shift ? snapLineAngle(d.a, d.b) : d.b;
      raw = pixelLine(d.a, end);
    } else {
      raw = rasterizeShapePreset(d.a, d.b, {
        preset: s.shapePreset,
        filled: s.shapeFilled,
        constrain: d.shift,
        fromCenter: d.alt,
        starPoints: s.shapeStarPoints,
      });
    }
    return wrapPoints(mirrorPoints(raw, s.symmetry), s.doc.w, s.doc.h, s.tileMode);
  };

  const commitLive = () => {
    if (!live) return;
    const d = live;
    live = null;
    dragHandle = null;
    ctrl.store.setState({ strokeActive: false, shapeLiveActive: false });
    const s = ctrl.state;
    const layer = ctrl.getActiveLayer();
    if (layer.kind === 'reference' || layer.locked) return;
    const cel = ctrl.getActiveCel();
    const before = cel.slice();
    stampBrush(cel, s.doc.w, s.doc.h, computePts(d), ctrl.resolveDrawColor(s.primaryColor), {
      size: 1,
      shape: 'square',
      mask: s.selection,
      alphaLock: layer.alphaLock,
    });
    const label = id === 'line' ? 'Line' : `Shape (${s.shapePreset})`;
    ctrl.commitCelChange(before, label);
    host.requestRender();
  };

  const hitHandle = (pt: Pt, screenX: number, screenY: number): boolean => {
    const vp = ctrl.state.viewport;
    const hx = vp.panX + (pt.x + 0.5) * vp.zoom;
    const hy = vp.panY + (pt.y + 0.5) * vp.zoom;
    return Math.hypot(screenX - hx, screenY - hy) <= 9;
  };

  return {
    id,
    name: id === 'line' ? 'Line' : id === 'rect' ? 'Live shapes' : 'Ellipse',
    key: id === 'line' ? 'L' : id === 'rect' ? 'U' : 'O',
    hint:
      id === 'line'
        ? 'Drag line · Shift snap 15° · Alt grab · Esc cancel'
        : 'Drag live shape · Adjust handles or preset · Enter apply · Esc cancel',
    cursor: 'crosshair',
    down(e) {
      if (!ctrl.ensureEditableLayer()) return;
      if (id !== 'line' && live) {
        if (hitHandle(live.a, e.screenX, e.screenY)) {
          dragHandle = 'a';
          ctrl.store.setState({ strokeActive: true });
          return;
        }
        if (hitHandle(live.b, e.screenX, e.screenY)) {
          dragHandle = 'b';
          ctrl.store.setState({ strokeActive: true });
          return;
        }
        commitLive();
      }
      live = { a: e.docPt, b: e.docPt, shift: e.shift, alt: e.alt };
      dragHandle = 'b';
      ctrl.store.setState({ strokeActive: true, shapeLiveActive: id !== 'line' });
      host.requestRender();
    },
    move(e) {
      if (!live || !dragHandle) return;
      if (dragHandle === 'a') live.a = e.docPt;
      else live.b = e.docPt;
      live.shift = e.shift;
      live.alt = e.alt;
      host.requestRender();
    },
    up() {
      if (!live) return;
      dragHandle = null;
      ctrl.store.setState({ strokeActive: false });
      if (id === 'line') {
        commitLive();
      } else {
        ctrl.store.setState({ shapeLiveActive: true });
        host.requestRender();
      }
    },
    commit: commitLive,
    cancel() {
      live = null;
      dragHandle = null;
      ctrl.store.setState({ strokeActive: false, shapeLiveActive: false });
      host.requestRender();
    },
    getPreview() {
      if (!live) return null;
      return { pts: computePts(live), color: ctrl.resolveDrawColor(ctrl.state.primaryColor), size: 1 };
    },
    overlay(ctx, vp) {
      if (!live || id === 'line') return;
      ctx.save();
      // Dashed screen-space bounding box so uncommitted live shapes read clearly as UI chrome
      const minX = Math.min(live.a.x, live.b.x);
      const maxX = Math.max(live.a.x, live.b.x) + 1;
      const minY = Math.min(live.a.y, live.b.y);
      const maxY = Math.max(live.a.y, live.b.y) + 1;
      const bx = Math.round(vp.panX + minX * vp.zoom) + 0.5;
      const by = Math.round(vp.panY + minY * vp.zoom) + 0.5;
      const bw = Math.max(1, Math.round((maxX - minX) * vp.zoom));
      const bh = Math.max(1, Math.round((maxY - minY) * vp.zoom));
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(20, 19, 15, 0.85)';
      ctx.setLineDash([]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.strokeStyle = '#c6f432';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]);

      // Hollow corner handles (10x10 ring with dark core) so they never look like stray 1x1 painted pixels
      const drawKnob = (pt: Pt) => {
        const cx = Math.round(vp.panX + (pt.x + 0.5) * vp.zoom);
        const cy = Math.round(vp.panY + (pt.y + 0.5) * vp.zoom);
        ctx.fillStyle = '#14130f';
        ctx.fillRect(cx - 5, cy - 5, 10, 10);
        ctx.strokeStyle = '#e8e4d8';
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - 4, cy - 4, 8, 8);
        ctx.fillStyle = '#c6f432';
        ctx.fillRect(cx - 1, cy - 1, 2, 2);
      };
      drawKnob(live.a);
      drawKnob(live.b);
      ctx.restore();
    },
  };
}

function makeCurveTool(host: ToolHost): Tool {
  const { ctrl } = host;
  let anchors: BezierAnchor[] = [];
  let drag: { idx: number; kind: 'anchor' | 'in' | 'out' | 'pull-new' } | null = null;

  const computePts = (): Pt[] => {
    if (anchors.length === 0) return [];
    const s = ctrl.state;
    const raw = rasterizeBezierPath(anchors, {
      closed: s.vectorClosed,
      filled: s.vectorFilled,
      width: s.vectorWidth < 1 ? 1 : s.vectorWidth,
    });
    return wrapPoints(mirrorPoints(raw, s.symmetry), s.doc.w, s.doc.h, s.tileMode);
  };

  const commitPath = () => {
    if (anchors.length === 0) return;
    const s = ctrl.state;
    const layer = ctrl.getActiveLayer();
    if (layer.kind === 'reference' || layer.locked) return;
    const cel = ctrl.getActiveCel();
    const before = cel.slice();
    stampBrush(cel, s.doc.w, s.doc.h, computePts(), ctrl.resolveDrawColor(s.primaryColor), {
      size: s.vectorWidth < 1 ? s.vectorWidth : 1,
      shape: 'square',
      mask: s.selection,
      alphaLock: layer.alphaLock,
    });
    anchors = [];
    drag = null;
    ctrl.store.setState({ strokeActive: false, vectorActive: false });
    ctrl.commitCelChange(before, 'Pen Bezier path');
    host.requestRender();
  };

  const toScreen = (x: number, y: number) => {
    const vp = ctrl.state.viewport;
    return { sx: vp.panX + (x + 0.5) * vp.zoom, sy: vp.panY + (y + 0.5) * vp.zoom };
  };

  const hitTest = (screenX: number, screenY: number): { idx: number; kind: 'anchor' | 'in' | 'out' } | null => {
    // Check tangent handles first so handles near anchors remain grabbable
    for (let i = anchors.length - 1; i >= 0; i--) {
      const a = anchors[i];
      if (a.outHandle) {
        const p = toScreen(a.outHandle.x, a.outHandle.y);
        if (Math.hypot(screenX - p.sx, screenY - p.sy) <= 8) return { idx: i, kind: 'out' };
      }
      if (a.inHandle) {
        const p = toScreen(a.inHandle.x, a.inHandle.y);
        if (Math.hypot(screenX - p.sx, screenY - p.sy) <= 8) return { idx: i, kind: 'in' };
      }
    }
    for (let i = anchors.length - 1; i >= 0; i--) {
      const p = toScreen(anchors[i].x, anchors[i].y);
      if (Math.hypot(screenX - p.sx, screenY - p.sy) <= 9) return { idx: i, kind: 'anchor' };
    }
    return null;
  };

  const smoothAll = (tensionPct: number) => {
    if (anchors.length < 2) return;
    anchors = autoSmoothBezierAnchors(anchors, ctrl.state.vectorClosed, Math.max(0, Math.min(100, tensionPct)));
    host.requestRender();
  };

  const sharpAll = () => {
    if (anchors.length === 0) return;
    anchors = anchors.map((a) => ({ x: a.x, y: a.y }));
    host.requestRender();
  };

  return {
    id: 'curve',
    name: 'Pen / Bezier',
    key: 'P',
    hint: 'Click corner · Click+drag Bezier handles · Alt+drag break handle · Right-click delete · Enter apply',
    cursor: 'crosshair',
    down(e) {
      if (!ctrl.ensureEditableLayer()) return;
      if (e.button === 2) {
        if (anchors.length === 0) return;
        const hit = hitTest(e.screenX, e.screenY);
        if (hit && hit.kind === 'anchor') anchors.splice(hit.idx, 1);
        else if (hit && hit.kind === 'in') delete anchors[hit.idx].inHandle;
        else if (hit && hit.kind === 'out') delete anchors[hit.idx].outHandle;
        else anchors.pop();
        drag = null;
        ctrl.store.setState({ vectorActive: anchors.length > 0 });
        host.requestRender();
        return;
      }

      const hit = hitTest(e.screenX, e.screenY);
      if (hit) {
        if (hit.kind === 'anchor' && hit.idx === 0 && anchors.length >= 3 && !ctrl.state.vectorClosed) {
          // Photoshop Pen convention: clicking first anchor closes the path
          ctrl.store.setState({ vectorClosed: true });
          drag = { idx: 0, kind: 'anchor' };
        } else {
          drag = hit;
        }
      } else {
        anchors.push({ x: e.docPt.x, y: e.docPt.y });
        drag = { idx: anchors.length - 1, kind: 'pull-new' };
        if (ctrl.state.vectorSmooth && anchors.length >= 2 && ctrl.state.vectorTension > 0) {
          const smoothed = autoSmoothBezierAnchors(anchors, ctrl.state.vectorClosed, ctrl.state.vectorTension);
          for (let i = 0; i < anchors.length - 1; i++) {
            if (!anchors[i].inHandle && !anchors[i].outHandle) {
              anchors[i].inHandle = smoothed[i].inHandle;
              anchors[i].outHandle = smoothed[i].outHandle;
            }
          }
        }
      }
      ctrl.store.setState({ strokeActive: true, vectorActive: true });
      host.requestRender();
    },
    move(e) {
      if (!drag || drag.idx < 0 || drag.idx >= anchors.length) return;
      const a = anchors[drag.idx];
      if (drag.kind === 'anchor') {
        const dx = e.docPt.x - a.x;
        const dy = e.docPt.y - a.y;
        a.x = e.docPt.x;
        a.y = e.docPt.y;
        if (a.inHandle) a.inHandle = { x: a.inHandle.x + dx, y: a.inHandle.y + dy };
        if (a.outHandle) a.outHandle = { x: a.outHandle.x + dx, y: a.outHandle.y + dy };
      } else if (drag.kind === 'pull-new') {
        const dx = e.docPt.x - a.x;
        const dy = e.docPt.y - a.y;
        if (Math.hypot(dx, dy) >= 1) {
          a.outHandle = { x: a.x + dx, y: a.y + dy };
          a.inHandle = { x: a.x - dx, y: a.y - dy };
        }
      } else if (drag.kind === 'out') {
        const dx = e.docPt.x - a.x;
        const dy = e.docPt.y - a.y;
        a.outHandle = { x: e.docPt.x, y: e.docPt.y };
        if (!e.alt) a.inHandle = { x: a.x - dx, y: a.y - dy };
      } else if (drag.kind === 'in') {
        const dx = e.docPt.x - a.x;
        const dy = e.docPt.y - a.y;
        a.inHandle = { x: e.docPt.x, y: e.docPt.y };
        if (!e.alt) a.outHandle = { x: a.x - dx, y: a.y - dy };
      }
      host.requestRender();
    },
    up() {
      drag = null;
      ctrl.store.setState({ strokeActive: false });
      host.requestRender();
    },
    commit: commitPath,
    smoothPath: smoothAll,
    sharpPath: sharpAll,
    deleteLastVertex() {
      if (anchors.length === 0) return false;
      anchors.pop();
      drag = null;
      ctrl.store.setState({ vectorActive: anchors.length > 0 });
      host.requestRender();
      return true;
    },
    cancel() {
      anchors = [];
      drag = null;
      ctrl.store.setState({ strokeActive: false, vectorActive: false });
      host.requestRender();
    },
    getPreview() {
      if (anchors.length === 0) return null;
      return { pts: computePts(), color: ctrl.resolveDrawColor(ctrl.state.primaryColor), size: 1 };
    },
    overlay(ctx, vp) {
      if (anchors.length === 0) return;
      ctx.save();
      const sPt = (x: number, y: number) => ({
        x: vp.panX + (x + 0.5) * vp.zoom,
        y: vp.panY + (y + 0.5) * vp.zoom,
      });

      // Draw cubic Bezier guide spine
      if (anchors.length > 1) {
        ctx.strokeStyle = 'rgba(198, 244, 50, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        const p0 = sPt(anchors[0].x, anchors[0].y);
        ctx.moveTo(p0.x, p0.y);
        const segCount = ctrl.state.vectorClosed && anchors.length > 2 ? anchors.length : anchors.length - 1;
        for (let i = 0; i < segCount; i++) {
          const a = anchors[i];
          const b = anchors[(i + 1) % anchors.length];
          const c1 = sPt(a.outHandle?.x ?? a.x, a.outHandle?.y ?? a.y);
          const c2 = sPt(b.inHandle?.x ?? b.x, b.inHandle?.y ?? b.y);
          const end = sPt(b.x, b.y);
          ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw tangent arms and round handle knobs
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        const ap = sPt(a.x, a.y);
        for (const kind of ['in', 'out'] as const) {
          const hnd = kind === 'in' ? a.inHandle : a.outHandle;
          if (!hnd || (hnd.x === a.x && hnd.y === a.y)) continue;
          const hp = sPt(hnd.x, hnd.y);
          ctx.strokeStyle = 'rgba(232, 228, 216, 0.7)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(ap.x, ap.y);
          ctx.lineTo(hp.x, hp.y);
          ctx.stroke();

          ctx.fillStyle = drag?.idx === i && drag.kind === kind ? '#c6f432' : '#e8e4d8';
          ctx.strokeStyle = '#14130f';
          ctx.beginPath();
          ctx.arc(hp.x, hp.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      // Draw square anchor nodes
      for (let i = 0; i < anchors.length; i++) {
        const ap = sPt(anchors[i].x, anchors[i].y);
        const cx = Math.round(ap.x);
        const cy = Math.round(ap.y);
        ctx.fillStyle = drag?.idx === i && drag.kind === 'anchor' ? '#eeece6' : i === 0 ? '#ffffff' : '#c6f432';
        ctx.strokeStyle = '#14130f';
        ctx.lineWidth = 1;
        ctx.fillRect(cx - 4, cy - 4, 8, 8);
        ctx.strokeRect(cx - 4.5, cy - 4.5, 9, 9);
      }
      ctx.restore();
    },
  };
}

function makeFillTool(host: ToolHost): Tool {
  const { ctrl } = host;
  return {
    id: 'fill',
    name: 'Bucket',
    key: 'G',
    hint: 'Click to flood fill · Alt grab · honors selection & alpha lock',
    cursor: 'crosshair',
    down(e) {
      const layer = ctrl.ensureEditableLayer();
      if (!layer) return;
      const s = ctrl.state;
      const cel = ctrl.getActiveCel();
      const before = cel.slice();
      const sample = s.fillSampleAll ? ctrl.getComposed(s.activeFrame) : cel;
      const { wrapX, wrapY } = wrapFlags(s.tileMode);
      const fillCol = ctrl.resolveDrawColor(e.button === 2 ? s.secondaryColor : s.primaryColor);
      floodFill(cel, s.doc.w, s.doc.h, e.docPt.x, e.docPt.y, fillCol, {
        contiguous: s.fillContiguous,
        tolerance: s.fillTolerance,
        sample,
        mask: s.selection,
        alphaLock: layer.alphaLock,
        wrapX,
        wrapY,
      });
      ctrl.commitCelChange(before, 'Flood fill');
      host.requestRender();
    },
    move() {},
    up() {},
    cancel() {},
  };
}

function makePickerTool(host: ToolHost): Tool {
  const { ctrl } = host;
  let dragging = false;

  const sample = (e: ToolEvent, allowShiftAdd: boolean) => {
    const color = ctrl.sampleColorAt(e.docPt);
    ctrl.store.setState({
      grabLoupe: { docPt: e.docPt, screenX: e.screenX, screenY: e.screenY, color },
      ...(color ? { primaryColor: color } : {}),
    });
    if (allowShiftAdd && e.shift && color && ctrl.state.grabShiftAdds) {
      ctrl.execute(appendPaletteColorsCommand(ctrl.getActivePalette().id, [color], 'Grab color to palette'));
      ctrl.showToast('Added grabbed color to palette.', 'info');
    }
    host.requestRender();
  };

  return {
    id: 'picker',
    name: 'Color grabber',
    key: 'I',
    hint: 'Click or scrub to grab with loupe · Shift+click add to palette',
    cursor: 'crosshair',
    down(e) {
      dragging = true;
      sample(e, true);
    },
    move(e) {
      if (dragging) sample(e, false);
    },
    up() {
      dragging = false;
      ctrl.store.setState({ grabLoupe: null });
      host.requestRender();
    },
    cancel() {
      dragging = false;
      ctrl.store.setState({ grabLoupe: null });
      host.requestRender();
    },
  };
}

function makeSelectRectTool(host: ToolHost): Tool {
  const { ctrl } = host;
  let drag: { a: Pt; b: Pt; mode: SelectionMode } | null = null;
  return {
    id: 'select-rect',
    name: 'Rect select',
    key: 'M',
    hint: 'Drag to select · Shift add · Alt subtract · Shift+Alt intersect',
    cursor: 'crosshair',
    down(e) {
      drag = { a: e.docPt, b: e.docPt, mode: selectionMode(e) };
      host.requestRender();
    },
    move(e) {
      if (!drag) return;
      drag.b = e.docPt;
      host.requestRender();
    },
    up() {
      if (!drag) return;
      const d = drag;
      drag = null;
      const s = ctrl.state;
      const next = rectMask(s.doc.w, s.doc.h, d.a, d.b);
      const merged = combineMasks(s.selection, next, d.mode);
      ctrl.setSelectionWithUndo(merged, 'Rect select');
      host.requestRender();
    },
    cancel() {
      drag = null;
      host.requestRender();
    },
    overlay(ctx, vp) {
      if (!drag) return;
      const x0 = Math.min(drag.a.x, drag.b.x);
      const y0 = Math.min(drag.a.y, drag.b.y);
      const w = Math.abs(drag.b.x - drag.a.x) + 1;
      const h = Math.abs(drag.b.y - drag.a.y) + 1;
      ctx.save();
      ctx.strokeStyle = '#c6f432';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(vp.panX + x0 * vp.zoom + 0.5, vp.panY + y0 * vp.zoom + 0.5, w * vp.zoom - 1, h * vp.zoom - 1);
      ctx.restore();
    },
  };
}

function makeSelectLassoTool(host: ToolHost): Tool {
  const { ctrl } = host;
  let drag: { pts: Pt[]; mode: SelectionMode } | null = null;
  return {
    id: 'select-lasso',
    name: 'Lasso select',
    key: 'Q',
    hint: 'Drag freehand loop · Shift add · Alt subtract · Shift+Alt intersect',
    cursor: 'crosshair',
    down(e) {
      drag = { pts: [e.docPt], mode: selectionMode(e) };
      host.requestRender();
    },
    move(e) {
      if (!drag) return;
      const last = drag.pts[drag.pts.length - 1];
      if (last.x === e.docPt.x && last.y === e.docPt.y) return;
      drag.pts.push(...bresenham(last, e.docPt).slice(1));
      host.requestRender();
    },
    up() {
      if (!drag) return;
      const d = drag;
      drag = null;
      const s = ctrl.state;
      const next = lassoMask(s.doc.w, s.doc.h, d.pts);
      const merged = combineMasks(s.selection, next, d.mode);
      ctrl.setSelectionWithUndo(merged, 'Lasso select');
      host.requestRender();
    },
    cancel() {
      drag = null;
      host.requestRender();
    },
    overlay(ctx, vp) {
      if (!drag || drag.pts.length < 2) return;
      ctx.save();
      ctx.strokeStyle = '#c6f432';
      ctx.lineWidth = 1;
      ctx.beginPath();
      drag.pts.forEach((p, idx) => {
        const sx = vp.panX + (p.x + 0.5) * vp.zoom;
        const sy = vp.panY + (p.y + 0.5) * vp.zoom;
        if (idx === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    },
  };
}

function makeSelectWandTool(host: ToolHost): Tool {
  const { ctrl } = host;
  return {
    id: 'select-wand',
    name: 'Magic wand',
    key: 'W',
    hint: 'Click region to select · Shift add · Alt subtract · Shift+Alt intersect',
    cursor: 'crosshair',
    down(e) {
      const s = ctrl.state;
      const layer = ctrl.getActiveLayer();
      const source = s.fillSampleAll || layer.kind === 'reference' ? ctrl.getComposed(s.activeFrame) : ctrl.getActiveCel();
      const next = magicWandMask(source, s.doc.w, s.doc.h, e.docPt.x, e.docPt.y, {
        contiguous: s.fillContiguous,
        tolerance: s.fillTolerance,
      });
      const merged = combineMasks(s.selection, next, selectionMode(e));
      ctrl.setSelectionWithUndo(merged, 'Magic wand');
      host.requestRender();
    },
    move() {},
    up() {},
    cancel() {},
  };
}

function makeMoveTool(host: ToolHost): Tool {
  const { ctrl } = host;
  type ResizeHandle = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l' | 'body';
  let drag:
    | { kind: 'floating'; startPt: Pt; origX: number; origY: number }
    | { kind: 'ref'; layerId: string; startPt: Pt; origX: number; origY: number }
    | {
        kind: 'layers';
        startPt: Pt;
        cels: { layerId: string; frame: number; before: Uint8ClampedArray }[];
        refs: { layerId: string; origX: number; origY: number }[];
        mask: SelectionMask | null;
        dx: number;
        dy: number;
      }
    | null = null;

  // Direct-canvas Free Resize session (supports single layer or whole selected group)
  let resizeSession: {
    entries: {
      layerId: string;
      frame: number;
      before: Uint8ClampedArray;
      baseBg: Uint8ClampedArray;
      srcPixels: Uint8ClampedArray;
      srcRect: Rect;
    }[];
    origBox: Rect;
    box: Rect;
    activeHandle: ResizeHandle | null;
    startPt: Pt;
    startBox: Rect;
  } | null = null;

  // Direct-canvas Free Warp session (no modal required)
  let warpSession: {
    before: Uint8ClampedArray;
    params: WarpParams;
    dragCorner: number;
  } | null = null;

  const findReferenceUnder = (docPt: Pt) => {
    const layers = ctrl.state.doc.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (l.kind !== 'reference' || !l.visible || l.locked || !l.ref) continue;
      const r = l.ref;
      const rw = r.w * r.scale;
      const rh = r.h * r.scale;
      if (docPt.x >= r.x && docPt.x <= r.x + rw && docPt.y >= r.y && docPt.y <= r.y + rh) {
        return l;
      }
    }
    return null;
  };

  const renderResizePreview = () => {
    if (!resizeSession) return;
    const s = ctrl.state;
    const { origBox, box } = resizeSession;
    const sx = origBox.w > 0 ? box.w / origBox.w : 1;
    const sy = origBox.h > 0 ? box.h / origBox.h : 1;
    for (const entry of resizeSession.entries) {
      const layer = s.doc.layers.find((l) => l.id === entry.layerId);
      const cel = layer?.cels[entry.frame];
      if (!cel) continue;
      cel.set(entry.baseBg);
      const dw = Math.max(1, Math.round(entry.srcRect.w * sx));
      const dh = Math.max(1, Math.round(entry.srcRect.h * sy));
      const dx = Math.round(box.x + (entry.srcRect.x - origBox.x) * sx);
      const dy = Math.round(box.y + (entry.srcRect.y - origBox.y) * sy);
      const scaled = resampleRgba(entry.srcPixels, entry.srcRect.w, entry.srcRect.h, dw, dh, 'nearest');
      stampBuffer(cel, s.doc.w, s.doc.h, scaled, { x: 0, y: 0, w: dw, h: dh }, dx, dy, {});
    }
    ctrl.markDirty(s.activeFrame);
    host.requestRender();
  };

  const renderWarpPreview = () => {
    if (!warpSession) return;
    const s = ctrl.state;
    warpSession.params.preset = s.warpPreset;
    warpSession.params.strength = s.warpStrength;
    warpSession.params.secondary = s.warpSecondary;
    const warped = warpCelPixels(warpSession.before, s.doc.w, s.doc.h, warpSession.params, s.selection);
    ctrl.getActiveCel().set(warped);
    ctrl.markDirty(s.activeFrame);
    host.requestRender();
  };

  const startResizeSession = (): boolean => {
    const s = ctrl.state;
    const targets = ctrl.getSelectedEditableLayers().filter((l) => l.kind === 'pixel');
    if (targets.length === 0) {
      ctrl.ensureEditableLayer();
      return false;
    }
    const entries: NonNullable<typeof resizeSession>['entries'] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const layer of targets) {
      const fIdx = getLayerCelIndex(layer, s.activeFrame);
      const cel = layer.cels[fIdx];
      if (!cel) continue;
      const ext = extractSelection(cel, s.doc.w, s.doc.h, s.selection);
      if (!ext) continue;
      const before = cel.slice();
      const baseBg = cel.slice();
      clearSelection(baseBg, s.doc.w, s.doc.h, s.selection, false);
      entries.push({
        layerId: layer.id,
        frame: fIdx,
        before,
        baseBg,
        srcPixels: ext.pixels,
        srcRect: { ...ext.rect },
      });
      minX = Math.min(minX, ext.rect.x);
      minY = Math.min(minY, ext.rect.y);
      maxX = Math.max(maxX, ext.rect.x + ext.rect.w);
      maxY = Math.max(maxY, ext.rect.y + ext.rect.h);
    }
    if (entries.length === 0) {
      ctrl.showToast('Selection is empty — draw something before resizing.', 'info');
      return false;
    }
    const origBox: Rect = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    resizeSession = {
      entries,
      origBox,
      box: { ...origBox },
      activeHandle: null,
      startPt: { x: 0, y: 0 },
      startBox: { ...origBox },
    };
    ctrl.store.setState({ transformActive: true });
    renderResizePreview();
    return true;
  };

  const startWarpSession = (): boolean => {
    const layer = ctrl.ensureEditableLayer();
    if (!layer) return false;
    const s = ctrl.state;
    const params = defaultWarpParams();
    params.preset = s.warpPreset;
    params.strength = s.warpStrength;
    params.secondary = s.warpSecondary;
    warpSession = {
      before: ctrl.getActiveCel().slice(),
      params,
      dragCorner: -1,
    };
    ctrl.store.setState({ transformActive: true });
    renderWarpPreview();
    return true;
  };

  const commitSessions = () => {
    if (resizeSession) {
      const entries = resizeSession.entries;
      resizeSession = null;
      ctrl.store.setState({ strokeActive: false, transformActive: false });
      ctrl.commitMultiLayerChange(
        entries.map((e) => ({ layerId: e.layerId, frame: e.frame, before: e.before })),
        [],
        entries.length > 1 ? `Resize ${entries.length} layers` : 'Direct resize',
      );
      host.requestRender();
      return;
    }
    if (warpSession) {
      const before = warpSession.before;
      const preset = warpSession.params.preset;
      warpSession = null;
      ctrl.store.setState({ strokeActive: false, transformActive: false });
      ctrl.commitCelChange(before, `Direct warp (${preset})`);
      host.requestRender();
      return;
    }
    ctrl.commitFloating();
    host.requestRender();
  };

  const cancelSessions = () => {
    if (resizeSession) {
      const s = ctrl.state;
      for (const entry of resizeSession.entries) {
        const layer = s.doc.layers.find((l) => l.id === entry.layerId);
        layer?.cels[entry.frame]?.set(entry.before);
      }
      resizeSession = null;
      ctrl.store.setState({ strokeActive: false, transformActive: false });
      ctrl.markDirty(s.activeFrame);
      host.requestRender();
      return;
    }
    if (warpSession) {
      ctrl.getActiveCel().set(warpSession.before);
      warpSession = null;
      ctrl.store.setState({ strokeActive: false, transformActive: false });
      ctrl.markDirty(ctrl.state.activeFrame);
      host.requestRender();
      return;
    }
  };

  // Keep live warp canvas in sync when user changes preset/strength sliders in optionsBar
  ctrl.store.subscribe(
    (s) => [s.moveMode, s.warpPreset, s.warpStrength, s.warpSecondary] as const,
    ([mode]) => {
      if (ctrl.state.tool !== 'move') return;
      if (mode === 'warp' && resizeSession) commitSessions();
      if (mode === 'resize' && warpSession) commitSessions();
      if (mode === 'move' && (resizeSession || warpSession)) commitSessions();
      if (mode === 'warp' && warpSession) renderWarpPreview();
      if (mode === 'warp' && !warpSession) {
        const l = ctrl.getActiveLayer();
        if (l.kind === 'pixel' && !l.locked) startWarpSession();
      }
      if (mode === 'resize' && !resizeSession) {
        const l = ctrl.getActiveLayer();
        if (l.kind === 'pixel' && !l.locked) startResizeSession();
      }
      host.requestRender();
    },
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  const resizeHandles = (b: Rect): { id: ResizeHandle; x: number; y: number }[] => [
    { id: 'tl', x: b.x, y: b.y },
    { id: 't', x: b.x + b.w / 2, y: b.y },
    { id: 'tr', x: b.x + b.w, y: b.y },
    { id: 'r', x: b.x + b.w, y: b.y + b.h / 2 },
    { id: 'br', x: b.x + b.w, y: b.y + b.h },
    { id: 'b', x: b.x + b.w / 2, y: b.y + b.h },
    { id: 'bl', x: b.x, y: b.y + b.h },
    { id: 'l', x: b.x, y: b.y + b.h / 2 },
  ];

  return {
    id: 'move',
    name: 'Move / Transform',
    key: 'V',
    hint: 'Move · Resize handles (Ctrl+T) · Direct-canvas Warp · Drag floating refs · Enter apply',
    cursor: 'move',
    down(e) {
      const s = ctrl.state;
      if (s.floating) {
        drag = { kind: 'floating', startPt: e.docPt, origX: s.floating.offsetX, origY: s.floating.offsetY };
        return;
      }

      // Direct-canvas Resize mode
      if (s.moveMode === 'resize') {
        if (!resizeSession && !startResizeSession()) return;
        if (!resizeSession) return;
        const vp = s.viewport;
        for (const hnd of resizeHandles(resizeSession.box)) {
          const hx = vp.panX + hnd.x * vp.zoom;
          const hy = vp.panY + hnd.y * vp.zoom;
          if (Math.hypot(e.screenX - hx, e.screenY - hy) <= 10) {
            resizeSession.activeHandle = hnd.id;
            resizeSession.startPt = e.docPt;
            resizeSession.startBox = { ...resizeSession.box };
            ctrl.store.setState({ strokeActive: true });
            return;
          }
        }
        resizeSession.activeHandle = 'body';
        resizeSession.startPt = e.docPt;
        resizeSession.startBox = { ...resizeSession.box };
        ctrl.store.setState({ strokeActive: true });
        return;
      }

      // Direct-canvas Warp mode
      if (s.moveMode === 'warp') {
        if (!warpSession && !startWarpSession()) return;
        if (!warpSession) return;
        const vp = s.viewport;
        let best = -1;
        let bestD = 14;
        warpSession.params.corners.forEach((c, idx) => {
          const hx = vp.panX + c.x * s.doc.w * vp.zoom;
          const hy = vp.panY + c.y * s.doc.h * vp.zoom;
          const d = Math.hypot(e.screenX - hx, e.screenY - hy);
          if (d < bestD) {
            bestD = d;
            best = idx;
          }
        });
        if (best >= 0) {
          warpSession.dragCorner = best;
          if (s.warpPreset !== 'quad') ctrl.store.setState({ warpPreset: 'quad' });
          ctrl.store.setState({ strokeActive: true });
          host.requestRender();
        }
        return;
      }

      // Allow directly grabbing any floating Reference board on the Illustrator pasteboard (only when single layer active or clicking outside canvas)
      const activeLayer = ctrl.getActiveLayer();
      const clickedRef = activeLayer.kind === 'reference' && activeLayer.ref ? activeLayer : findReferenceUnder(e.docPt);
      if (
        s.selectedLayerIds.length <= 1 &&
        clickedRef?.ref &&
        (activeLayer.kind === 'reference' || e.docPt.x < 0 || e.docPt.y < 0 || e.docPt.x >= s.doc.w || e.docPt.y >= s.doc.h)
      ) {
        if (clickedRef.locked) {
          ctrl.showToast('Layer locked', 'error');
          return;
        }
        drag = {
          kind: 'ref',
          layerId: clickedRef.id,
          startPt: e.docPt,
          origX: clickedRef.ref.x,
          origY: clickedRef.ref.y,
        };
        ctrl.store.setState({ strokeActive: true });
        return;
      }

      const targets = ctrl.getSelectedEditableLayers();
      if (targets.length === 0) {
        ctrl.ensureEditableLayer();
        return;
      }
      const cels: { layerId: string; frame: number; before: Uint8ClampedArray }[] = [];
      const refs: { layerId: string; origX: number; origY: number }[] = [];
      for (const layer of targets) {
        if (layer.kind === 'reference' && layer.ref) {
          refs.push({ layerId: layer.id, origX: layer.ref.x, origY: layer.ref.y });
        } else if (layer.kind === 'pixel') {
          const fIdx = getLayerCelIndex(layer, s.activeFrame);
          const cel = layer.cels[fIdx];
          if (cel) cels.push({ layerId: layer.id, frame: fIdx, before: cel.slice() });
        }
      }
      if (cels.length === 0 && refs.length === 0) return;
      drag = {
        kind: 'layers',
        startPt: e.docPt,
        cels,
        refs,
        mask: s.selection,
        dx: 0,
        dy: 0,
      };
      ctrl.store.setState({ strokeActive: true });
    },
    move(e) {
      if (resizeSession?.activeHandle) {
        const dx = e.docPt.x - resizeSession.startPt.x;
        const dy = e.docPt.y - resizeSession.startPt.y;
        const sb = resizeSession.startBox;
        let { x, y, w, h } = sb;
        const hnd = resizeSession.activeHandle;
        if (hnd === 'body') {
          x = sb.x + dx;
          y = sb.y + dy;
        } else {
          if (hnd.includes('l')) { x = sb.x + dx; w = Math.max(1, sb.w - dx); }
          if (hnd.includes('r')) { w = Math.max(1, sb.w + dx); }
          if (hnd.includes('t')) { y = sb.y + dy; h = Math.max(1, sb.h - dy); }
          if (hnd.includes('b')) { h = Math.max(1, sb.h + dy); }
          if (e.shift && sb.w > 0 && sb.h > 0) {
            const aspect = sb.w / sb.h;
            h = Math.max(1, Math.round(w / aspect));
          }
        }
        resizeSession.box = { x, y, w, h };
        renderResizePreview();
        return;
      }
      if (warpSession && warpSession.dragCorner >= 0) {
        const s = ctrl.state;
        const nx = Math.max(-0.5, Math.min(1.5, (e.screenX - s.viewport.panX) / Math.max(1, s.doc.w * s.viewport.zoom)));
        const ny = Math.max(-0.5, Math.min(1.5, (e.screenY - s.viewport.panY) / Math.max(1, s.doc.h * s.viewport.zoom)));
        warpSession.params.corners[warpSession.dragCorner] = { x: nx, y: ny };
        renderWarpPreview();
        return;
      }
      if (!drag) return;
      const dx = e.docPt.x - drag.startPt.x;
      const dy = e.docPt.y - drag.startPt.y;
      if (drag.kind === 'floating') {
        const fl = ctrl.state.floating;
        if (!fl) return;
        ctrl.store.setState({
          floating: { ...fl, offsetX: drag.origX + dx, offsetY: drag.origY + dy },
        });
        host.requestRender();
        return;
      }
      if (drag.kind === 'ref') {
        const refId = drag.layerId;
        const l = ctrl.state.doc.layers.find((x) => x.id === refId);
        if (!l?.ref) return;
        l.ref.x = drag.origX + dx;
        l.ref.y = drag.origY + dy;
        ctrl.markDirty();
        host.requestRender();
        return;
      }
      if (dx === drag.dx && dy === drag.dy) return;
      drag.dx = dx;
      drag.dy = dy;
      const s = ctrl.state;
      for (const entry of drag.cels) {
        const layer = s.doc.layers.find((x) => x.id === entry.layerId);
        const cel = layer?.cels[entry.frame];
        if (!cel) continue;
        const moved = moveCelPixels(entry.before, s.doc.w, s.doc.h, dx, dy, {
          mask: drag.mask,
          wrap: s.moveWrap,
        });
        cel.set(moved);
      }
      for (const entry of drag.refs) {
        const layer = s.doc.layers.find((x) => x.id === entry.layerId);
        if (layer?.ref) {
          layer.ref.x = entry.origX + dx;
          layer.ref.y = entry.origY + dy;
        }
      }
      ctrl.markDirty(drag.refs.length > 0 ? undefined : s.activeFrame);
      host.requestRender();
    },
    up() {
      if (resizeSession?.activeHandle) {
        resizeSession.activeHandle = null;
        ctrl.store.setState({ strokeActive: false });
        host.requestRender();
        return;
      }
      if (warpSession && warpSession.dragCorner >= 0) {
        warpSession.dragCorner = -1;
        ctrl.store.setState({ strokeActive: false });
        host.requestRender();
        return;
      }
      if (!drag) return;
      const cur = drag;
      drag = null;
      if (cur.kind === 'layers') {
        ctrl.store.setState({ strokeActive: false });
        const refPatches = cur.refs.map((r) => {
          const l = ctrl.state.doc.layers.find((x) => x.id === r.layerId);
          return {
            layerId: r.layerId,
            beforeX: r.origX,
            beforeY: r.origY,
            afterX: l?.ref?.x ?? r.origX,
            afterY: l?.ref?.y ?? r.origY,
          };
        });
        const total = cur.cels.length + cur.refs.length;
        ctrl.commitMultiLayerChange(cur.cels, refPatches, total > 1 ? `Move ${total} layers` : 'Move');
        host.requestRender();
      } else if (cur.kind === 'ref') {
        ctrl.store.setState({ strokeActive: false });
        const l = ctrl.state.doc.layers.find((x) => x.id === cur.layerId);
        if (l?.ref && (l.ref.x !== cur.origX || l.ref.y !== cur.origY)) {
          const nx = l.ref.x;
          const ny = l.ref.y;
          l.ref.x = cur.origX;
          l.ref.y = cur.origY;
          ctrl.execute(referencePropCommand(cur.layerId, { x: nx, y: ny }, 'Move reference image'));
        }
        host.requestRender();
      }
    },
    cancel() {
      if (resizeSession || warpSession) {
        cancelSessions();
        ctrl.store.setState({ moveMode: 'move' });
        return;
      }
      if (!drag) return;
      if (drag.kind === 'layers') {
        const s = ctrl.state;
        for (const entry of drag.cels) {
          const l = s.doc.layers.find((x) => x.id === entry.layerId);
          l?.cels[entry.frame]?.set(entry.before);
        }
        for (const entry of drag.refs) {
          const l = s.doc.layers.find((x) => x.id === entry.layerId);
          if (l?.ref) {
            l.ref.x = entry.origX;
            l.ref.y = entry.origY;
          }
        }
        ctrl.store.setState({ strokeActive: false });
        ctrl.markDirty(drag.refs.length > 0 ? undefined : s.activeFrame);
      } else if (drag.kind === 'ref') {
        const refId = drag.layerId;
        const l = ctrl.state.doc.layers.find((x) => x.id === refId);
        if (l?.ref) {
          l.ref.x = drag.origX;
          l.ref.y = drag.origY;
        }
        ctrl.store.setState({ strokeActive: false });
        ctrl.markDirty();
      } else if (ctrl.state.floating) {
        ctrl.store.setState({
          floating: { ...ctrl.state.floating, offsetX: drag.origX, offsetY: drag.origY },
        });
      }
      drag = null;
      host.requestRender();
    },
    commit: commitSessions,
    overlay(ctx, vp) {
      if (resizeSession) {
        const b = resizeSession.box;
        const rx = vp.panX + b.x * vp.zoom;
        const ry = vp.panY + b.y * vp.zoom;
        const rw = b.w * vp.zoom;
        const rh = b.h * vp.zoom;
        ctx.save();
        ctx.strokeStyle = '#c6f432';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
        ctx.setLineDash([]);
        for (const hnd of resizeHandles(b)) {
          const cx = Math.round(vp.panX + hnd.x * vp.zoom);
          const cy = Math.round(vp.panY + hnd.y * vp.zoom);
          ctx.fillStyle = resizeSession.activeHandle === hnd.id ? '#ffffff' : '#c6f432';
          ctx.strokeStyle = '#14130f';
          ctx.fillRect(cx - 4, cy - 4, 8, 8);
          ctx.strokeRect(cx - 4.5, cy - 4.5, 9, 9);
        }
        ctx.restore();
      }
      if (warpSession) {
        const { doc } = ctrl.state;
        const pts = warpSession.params.corners.map((c) => ({
          x: vp.panX + c.x * doc.w * vp.zoom,
          y: vp.panY + c.y * doc.h * vp.zoom,
        }));
        ctx.save();
        ctx.strokeStyle = '#c6f432';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.stroke();
        // Subtle 2x2 internal warp mesh lines
        ctx.strokeStyle = 'rgba(198, 244, 50, 0.4)';
        ctx.lineWidth = 1;
        const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        for (const t of [0.333, 0.667]) {
          const top = lerp(pts[0], pts[1], t);
          const bot = lerp(pts[3], pts[2], t);
          ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke();
          const left = lerp(pts[0], pts[3], t);
          const right = lerp(pts[1], pts[2], t);
          ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(right.x, right.y); ctx.stroke();
        }
        pts.forEach((p, idx) => {
          ctx.fillStyle = warpSession?.dragCorner === idx ? '#ffffff' : '#c6f432';
          ctx.strokeStyle = '#14130f';
          ctx.fillRect(Math.round(p.x) - 5, Math.round(p.y) - 5, 10, 10);
          ctx.strokeRect(Math.round(p.x) - 5.5, Math.round(p.y) - 5.5, 11, 11);
        });
        ctx.restore();
      }
    },
  };
}

function makeHandTool(host: ToolHost): Tool {
  const { ctrl } = host;
  let drag: { startX: number; startY: number; panX: number; panY: number } | null = null;
  return {
    id: 'hand',
    name: 'Hand',
    key: 'H',
    hint: 'Drag to pan free pasteboard · 0 fit · 1 100%',
    cursor: 'grab',
    down(e) {
      const vp = ctrl.state.viewport;
      drag = { startX: e.screenX, startY: e.screenY, panX: vp.panX, panY: vp.panY };
    },
    move(e) {
      if (!drag) return;
      const s = ctrl.state;
      const sz = host.getStageSize();
      const vp = clampPan(
        { zoom: s.viewport.zoom, panX: drag.panX + (e.screenX - drag.startX), panY: drag.panY + (e.screenY - drag.startY) },
        sz.w,
        sz.h,
        s.doc.w,
        s.doc.h,
        32,
        s.freeCanvas,
      );
      ctrl.store.setState({ viewport: vp });
      host.requestRender();
    },
    up() {
      drag = null;
    },
    cancel() {
      drag = null;
    },
  };
}

export function createTools(host: ToolHost): Record<ToolId, Tool> {
  return {
    pencil: makeBrushTool(host, 'pencil'),
    dither: makeDitherTool(host),
    gradient: makeGradientTool(host),
    eraser: makeBrushTool(host, 'eraser'),
    line: makeShapeTool(host, 'line'),
    curve: makeCurveTool(host),
    rect: makeShapeTool(host, 'rect'),
    ellipse: makeShapeTool(host, 'ellipse'),
    fill: makeFillTool(host),
    picker: makePickerTool(host),
    'select-rect': makeSelectRectTool(host),
    'select-lasso': makeSelectLassoTool(host),
    'select-wand': makeSelectWandTool(host),
    move: makeMoveTool(host),
    hand: makeHandTool(host),
  };
}
