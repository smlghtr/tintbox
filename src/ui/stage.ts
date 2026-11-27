import {
  ONION_NEXT_TINT,
  ONION_PREV_TINT,
  buildOnionBuffer,
  computeOnionFrames,
  resolvePlaybackRange,
} from '../core/animation';
import { compositeLayer } from '../core/blend';
import { blankCel, composeLayerOnly } from '../core/doc';
import { rgbaToHex } from '../core/palette';
import { brushOffsets, getPixel, setPixel } from '../core/raster';
import { maskEdges, stampBuffer } from '../core/selection';
import type { Layer, Pt, ReferenceImage } from '../core/types';
import { clampPan, nearestZoomStep, resizeViewport, screenToDoc, ZOOM_STEPS, zoomAtScreenPoint } from '../core/viewport';
import { PadFlag, PadMsgType, type PadPacket } from '../io/pad-client';
import type { ToolId } from '../state/ui';
import type { AppController } from './controller';
import { h } from './dom';
import { createTools, type Tool, type ToolEvent } from './tools';

const ALT_GRAB_TOOLS = new Set<ToolId>(['pencil', 'dither', 'gradient', 'eraser', 'line', 'curve', 'rect', 'ellipse', 'fill', 'move', 'hand']);

export interface StageApi {
  el: HTMLElement;
  tools: Record<ToolId, Tool>;
  requestRender: () => void;
  setSpacePan: (down: boolean) => void;
  cancelActiveTool: () => void;
  commitActiveTool: () => void;
  deleteLastVectorVertex: () => boolean;
  smoothVectorPath: (tension: number) => void;
  sharpVectorPath: () => void;
  injectPadPacket: (pkt: PadPacket) => void;
  setFrameSink: (sink: ((rgba: Uint8ClampedArray, w: number, h: number) => void) | null) => void;
  destroy: () => void;
}

export function createStage(ctrl: AppController): StageApi {
  const checkerBox = h('div', { class: 'canvas-wrap', 'aria-hidden': 'true' });

  const refBackCanvas = h('canvas', { class: 'ref-back-canvas', 'aria-hidden': 'true' });
  const refBackCtx = refBackCanvas.getContext('2d');

  const onionCanvas = h('canvas', {
    class: 'onion-canvas',
    width: ctrl.state.doc.w,
    height: ctrl.state.doc.h,
    'aria-hidden': 'true',
  });
  const onionCtx = onionCanvas.getContext('2d');

  const docCanvas = h('canvas', {
    class: 'doc-canvas',
    width: ctrl.state.doc.w,
    height: ctrl.state.doc.h,
    role: 'img',
    'aria-label': 'Pixel canvas',
  });
  const docCtx = docCanvas.getContext('2d');

  const overlayCanvas = h('canvas', { class: 'overlay-canvas', 'aria-hidden': 'true' });
  const overlayCtx = overlayCanvas.getContext('2d');

  const stageEl = h('main', { class: 'stage', id: 'stage' }, checkerBox, refBackCanvas, onionCanvas, docCanvas, overlayCanvas);

  // ---- On-stage Canvas Scrollbars & Side Zoom Slider (#11) ----
  const hScroll = h('input', {
    type: 'range',
    class: 'stage-scroll-h',
    min: -1000,
    max: 1000,
    value: 0,
    draggable: false,
    'aria-label': 'Scroll canvas horizontally',
  });
  const vScroll = h('input', {
    type: 'range',
    class: 'stage-scroll-v',
    min: -1000,
    max: 1000,
    value: 0,
    draggable: false,
    'aria-label': 'Scroll canvas vertically',
  });
  const zoomRange = h('input', {
    type: 'range',
    class: 'stage-zoom-range',
    min: 0,
    max: ZOOM_STEPS.length - 1,
    step: 1,
    value: 5,
    draggable: false,
    'aria-label': 'Canvas zoom slider',
  });
  const zoomOutBtn = h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': 'Zoom out', title: 'Zoom out (-)', onClick: () => ctrl.zoomStep(-1) }, '−');
  const zoomInBtn = h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': 'Zoom in', title: 'Zoom in (+)', onClick: () => ctrl.zoomStep(1) }, '+');
  const zoomPctEl = h('span', { class: 'mono stage-zoom-pct' }, '800%');
  const stageZoomDock = h('div', { class: 'stage-zoom-dock', 'aria-label': 'Canvas zoom controls' }, zoomInBtn, zoomRange, zoomOutBtn, zoomPctEl);

  for (const r of [hScroll, vScroll, zoomRange]) {
    r.addEventListener('pointerdown', (e) => e.stopPropagation());
    r.addEventListener('mousedown', (e) => e.stopPropagation());
    r.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
  }

  const scrollSpan = () => {
    const s = ctrl.state;
    const cw = s.doc.w * s.viewport.zoom;
    const ch = s.doc.h * s.viewport.zoom;
    const padX = s.freeCanvas ? Math.max(stageSize.w, cw) : 64;
    const padY = s.freeCanvas ? Math.max(stageSize.h, ch) : 64;
    return {
      minX: -cw - padX,
      maxX: stageSize.w + padX,
      minY: -ch - padY,
      maxY: stageSize.h + padY,
    };
  };

  hScroll.addEventListener('input', () => {
    const sp = scrollSpan();
    const t = Number(hScroll.value) / 1000;
    const panX = sp.maxX - t * (sp.maxX - sp.minX);
    ctrl.setPan(panX, ctrl.state.viewport.panY);
  });
  vScroll.addEventListener('input', () => {
    const sp = scrollSpan();
    const t = Number(vScroll.value) / 1000;
    const panY = sp.maxY - t * (sp.maxY - sp.minY);
    ctrl.setPan(ctrl.state.viewport.panX, panY);
  });
  zoomRange.addEventListener('input', () => {
    const idx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, Math.round(Number(zoomRange.value))));
    ctrl.setZoomValue(ZOOM_STEPS[idx]);
  });

  const syncStageNav = () => {
    const s = ctrl.state;
    const show = s.showCanvasScrollbars;
    hScroll.hidden = !show;
    vScroll.hidden = !show;
    stageZoomDock.hidden = !show;
    const sp = scrollSpan();
    const tx = Math.max(0, Math.min(1, (sp.maxX - s.viewport.panX) / Math.max(1, sp.maxX - sp.minX)));
    const ty = Math.max(0, Math.min(1, (sp.maxY - s.viewport.panY) / Math.max(1, sp.maxY - sp.minY)));
    hScroll.min = '0';
    hScroll.max = '1000';
    hScroll.value = String(Math.round(tx * 1000));
    vScroll.min = '0';
    vScroll.max = '1000';
    vScroll.value = String(Math.round(ty * 1000));
    const zIdx = ZOOM_STEPS.indexOf(nearestZoomStep(s.viewport.zoom) as (typeof ZOOM_STEPS)[number]);
    zoomRange.value = String(Math.max(0, zIdx));
    zoomRange.style.setProperty('--attr-min', '0');
    zoomRange.style.setProperty('--attr-max', String(ZOOM_STEPS.length - 1));
    zoomRange.style.setProperty('--control-value', zoomRange.value);
    zoomPctEl.textContent = `${s.viewport.zoom * 100}%`;
  };

  stageEl.append(hScroll, vScroll, stageZoomDock);

  // Cache decoded HTMLImageElement per reference dataUrl for fast screen-space rendering
  const refImgCache = new Map<string, HTMLImageElement>();
  const getRefImage = (ref: ReferenceImage): HTMLImageElement | null => {
    let img = refImgCache.get(ref.dataUrl);
    if (!img && typeof Image !== 'undefined') {
      img = new Image();
      img.onload = () => requestRender();
      img.src = ref.dataUrl;
      refImgCache.set(ref.dataUrl, img);
    }
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  };

  let rafId = 0;
  let antsPhase = 0;
  let antsTimer = 0;
  let spacePan = false;
  let altGrab = false;
  let stageSize = { w: 640, h: 480 };
  let tempPan: { startX: number; startY: number; panX: number; panY: number } | null = null;
  let symDrag: 'x' | 'y' | null = null;
  let frameSink: ((rgba: Uint8ClampedArray, w: number, h: number) => void) | null = null;

  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchState: { dist: number; zoom: number; midX: number; midY: number; panX: number; panY: number } | null = null;

  const requestRender = () => {
    if (rafId) return;
    rafId = window.requestAnimationFrame(draw);
  };

  const tools = createTools({
    ctrl,
    requestRender,
    getStageSize: () => stageSize,
  });

  const activeTool = () => (altGrab ? tools.picker : tools[ctrl.state.tool]);

  const getRel = (clientX: number, clientY: number) => {
    const r = stageEl.getBoundingClientRect();
    return { sx: clientX - r.left, sy: clientY - r.top };
  };

  const hitSymmetryAxis = (sx: number, sy: number): 'x' | 'y' | null => {
    const { symmetry, viewport } = ctrl.state;
    if (symmetry.mode === 'none' || symmetry.locked) return null;
    const tol = 7;
    if ((symmetry.mode === 'x' || symmetry.mode === 'xy') && Math.abs(sx - (viewport.panX + symmetry.x * viewport.zoom)) <= tol) {
      return 'x';
    }
    if ((symmetry.mode === 'y' || symmetry.mode === 'xy') && Math.abs(sy - (viewport.panY + symmetry.y * viewport.zoom)) <= tol) {
      return 'y';
    }
    return null;
  };

  const makeToolEvent = (e: PointerEvent): ToolEvent => {
    const { sx, sy } = getRel(e.clientX, e.clientY);
    return {
      docPt: screenToDoc(ctrl.state.viewport, sx, sy),
      screenX: sx,
      screenY: sy,
      shift: e.shiftKey,
      alt: e.altKey,
      button: e.button,
    };
  };

  const updateHover = (docPt: Pt | null) => {
    const s = ctrl.state;
    let hex: string | null = null;
    if (docPt && docPt.x >= 0 && docPt.y >= 0 && docPt.x < s.doc.w && docPt.y < s.doc.h) {
      const px = ctrl.getComposed(s.activeFrame);
      const rgba = getPixel(px, s.doc.w, docPt.x, docPt.y);
      hex = rgba[3] > 0 ? rgbaToHex(rgba) : 'transparent';
    }
    if (s.hover?.x !== docPt?.x || s.hover?.y !== docPt?.y || s.hoverHex !== hex) {
      ctrl.store.setState({ hover: docPt, hoverHex: hex });
    }
  };

  // Drag-and-drop image import as Reference layer (F-REF)
  stageEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      stageEl.classList.add('drop-active');
    }
  });
  stageEl.addEventListener('dragleave', () => stageEl.classList.remove('drop-active'));
  stageEl.addEventListener('drop', (e) => {
    stageEl.classList.remove('drop-active');
    const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'Reference';
      void ctrl.importReferenceBlob(file, baseName);
    }
  });

  stageEl.addEventListener('contextmenu', (e) => {
    if (e.target === stageEl) e.preventDefault();
  });

  stageEl.addEventListener('pointerdown', (e) => {
    if (e.target !== stageEl) return;
    stageEl.setPointerCapture(e.pointerId);
    const { sx, sy } = getRel(e.clientX, e.clientY);
    activePointers.set(e.pointerId, { x: sx, y: sy });

    if (e.pointerType === 'touch' && activePointers.size === 2) {
      activeTool().cancel();
      altGrab = false;
      const [p1, p2] = Array.from(activePointers.values());
      const vp = ctrl.state.viewport;
      pinchState = {
        dist: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
        zoom: vp.zoom,
        midX: (p1.x + p2.x) / 2,
        midY: (p1.y + p2.y) / 2,
        panX: vp.panX,
        panY: vp.panY,
      };
      return;
    }

    if (e.button === 1 || (e.button === 0 && spacePan)) {
      e.preventDefault();
      const vp = ctrl.state.viewport;
      tempPan = { startX: sx, startY: sy, panX: vp.panX, panY: vp.panY };
      stageEl.style.cursor = 'grabbing';
      return;
    }

    if (e.button !== 0 && e.button !== 2) return;

    // Hold Alt with any drawing tool -> temporary color grabber (F-GRAB)
    if (e.button === 0 && e.altKey && ALT_GRAB_TOOLS.has(ctrl.state.tool)) {
      altGrab = true;
      tools.picker.down(makeToolEvent(e));
      requestRender();
      return;
    }

    const hitAxis = hitSymmetryAxis(sx, sy);
    if (hitAxis) {
      symDrag = hitAxis;
      return;
    }

    activeTool().down(makeToolEvent(e));
    requestRender();
  });

  stageEl.addEventListener('pointermove', (e) => {
    if (e.target !== stageEl && !ctrl.state.strokeActive && !tempPan && !symDrag && !altGrab && !pinchState) return;
    const { sx, sy } = getRel(e.clientX, e.clientY);
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: sx, y: sy });
    }

    if (pinchState && activePointers.size === 2) {
      const [p1, p2] = Array.from(activePointers.values());
      const dist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const nextZoom = nearestZoomStep(pinchState.zoom * (dist / pinchState.dist));
      const s = ctrl.state;
      const panned = {
        zoom: pinchState.zoom,
        panX: pinchState.panX + (midX - pinchState.midX),
        panY: pinchState.panY + (midY - pinchState.midY),
      };
      const vp = zoomAtScreenPoint(panned, nextZoom, midX, midY, stageSize.w, stageSize.h, s.doc.w, s.doc.h, s.freeCanvas);
      ctrl.store.setState({ viewport: vp });
      requestRender();
      return;
    }

    if (tempPan) {
      const s = ctrl.state;
      const vp = clampPan(
        { zoom: s.viewport.zoom, panX: tempPan.panX + (sx - tempPan.startX), panY: tempPan.panY + (sy - tempPan.startY) },
        stageSize.w,
        stageSize.h,
        s.doc.w,
        s.doc.h,
        32,
        s.freeCanvas,
      );
      ctrl.store.setState({ viewport: vp });
      requestRender();
      return;
    }

    if (symDrag) {
      const s = ctrl.state;
      if (symDrag === 'x') {
        const raw = (sx - s.viewport.panX) / s.viewport.zoom;
        const snapped = Math.max(0.5, Math.min(s.doc.w - 0.5, Math.round(raw * 2) / 2));
        ctrl.store.setState({ symmetry: { ...s.symmetry, x: snapped } });
      } else {
        const raw = (sy - s.viewport.panY) / s.viewport.zoom;
        const snapped = Math.max(0.5, Math.min(s.doc.h - 0.5, Math.round(raw * 2) / 2));
        ctrl.store.setState({ symmetry: { ...s.symmetry, y: snapped } });
      }
      requestRender();
      return;
    }

    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    const events = coalesced.length > 0 ? coalesced : [e];
    for (const ce of events) {
      const te = makeToolEvent(ce);
      updateHover(te.docPt);
      activeTool().move(te);
    }

    const hitAxis = hitSymmetryAxis(sx, sy);
    if (hitAxis) stageEl.style.cursor = hitAxis === 'x' ? 'ew-resize' : 'ns-resize';
    else if (spacePan) stageEl.style.cursor = 'grab';
    else stageEl.style.cursor = activeTool().cursor;

    requestRender();
  });

  const endPointer = (e: PointerEvent, canceled: boolean) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchState = null;

    if (tempPan) {
      tempPan = null;
      stageEl.style.cursor = spacePan ? 'grab' : activeTool().cursor;
      return;
    }
    if (symDrag) {
      symDrag = null;
      return;
    }

    if (altGrab) {
      if (canceled) tools.picker.cancel();
      else tools.picker.up(makeToolEvent(e));
      altGrab = false;
      requestRender();
      return;
    }

    if (canceled) activeTool().cancel();
    else activeTool().up(makeToolEvent(e));
    requestRender();
  };

  stageEl.addEventListener('pointerup', (e) => endPointer(e, false));
  stageEl.addEventListener('pointercancel', (e) => endPointer(e, true));
  stageEl.addEventListener('pointerleave', () => {
    if (!ctrl.state.strokeActive) {
      updateHover(null);
      requestRender();
    }
  });

  stageEl.addEventListener(
    'wheel',
    (e) => {
      if (e.target !== stageEl) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const ap = ctrl.state.appPrefs;
      const step = (e.deltaY < 0 ? 1 : -1) * ap.wheelZoomStep;
      if (ap.zoomToCursor) {
        const { sx, sy } = getRel(e.clientX, e.clientY);
        ctrl.zoomStep(step, sx, sy);
      } else {
        ctrl.zoomStep(step);
      }
      requestRender();
    },
    { passive: false },
  );

  const handleResize = () => {
    const r = stageEl.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width));
    const nh = Math.max(1, Math.round(r.height));
    if (nw === stageSize.w && nh === stageSize.h) return;
    const oldW = stageSize.w;
    const oldH = stageSize.h;
    stageSize = { w: nw, h: nh };
    ctrl.setStageSize(nw, nh);
    const s = ctrl.state;
    const vp = resizeViewport(s.viewport, oldW, oldH, nw, nh, s.doc.w, s.doc.h, s.freeCanvas);
    ctrl.store.setState({ viewport: vp });
    requestRender();
  };

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(handleResize);
    ro.observe(stageEl);
  }

  const reducedMotion =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

  antsTimer = window.setInterval(() => {
    if (!ctrl.state.selection && !ctrl.state.floating) return;
    if (!ctrl.state.appPrefs.animateMarchingAnts || reducedMotion?.matches) return;
    antsPhase = (antsPhase + 1) % 8;
    requestRender();
  }, 140);

  function drawRefLayer(ctx: CanvasRenderingContext2D, layer: Layer, panX: number, panY: number, zoom: number): void {
    if (!layer.visible || !layer.ref) return;
    const ref = layer.ref;
    const img = getRefImage(ref);
    if (!img) return;
    const sx = panX + ref.x * zoom;
    const sy = panY + ref.y * zoom;
    const sw = ref.w * ref.scale * zoom;
    const sh = ref.h * ref.scale * zoom;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity / 100));
    ctx.imageSmoothingEnabled = ref.smooth;
    ctx.translate(sx + (ref.flipX ? sw : 0), sy + (ref.flipY ? sh : 0));
    ctx.scale(ref.flipX ? -1 : 1, ref.flipY ? -1 : 1);
    ctx.drawImage(img, 0, 0, sw, sh);
    ctx.restore();
    // Crisp Illustrator-style floating reference frame when placed on pasteboard
    ctx.save();
    ctx.strokeStyle = layer.id === ctrl.state.activeLayerId ? 'rgba(198, 244, 50, 0.7)' : 'rgba(232, 228, 216, 0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
    ctx.setLineDash([]);
    ctx.fillStyle = '#1b1a15';
    ctx.fillRect(sx, sy - 16, Math.min(sw, 62), 15);
    ctx.fillStyle = '#c6f432';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText('REF', sx + 4, sy - 5);
    ctx.restore();
  }

  function drawLoupe(ctx: CanvasRenderingContext2D): void {
    const loupe = ctrl.state.grabLoupe;
    if (!loupe) return;
    const gridN = 8;
    const cell = 12; // 8 * 12 = 96px loupe
    const size = gridN * cell;
    const barH = 18;
    const totalH = size + barH;
    const pad = 16;

    let lx = Math.round(loupe.screenX + pad);
    let ly = Math.round(loupe.screenY - totalH - pad);
    if (lx + size > stageSize.w - 8) lx = Math.round(loupe.screenX - size - pad);
    if (ly < 8) ly = Math.round(loupe.screenY + pad);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1b1a15';
    ctx.fillRect(lx - 1, ly - 1, size + 2, totalH + 2);

    const half = Math.floor(gridN / 2);
    for (let gy = 0; gy < gridN; gy++) {
      for (let gx = 0; gx < gridN; gx++) {
        const px = lx + gx * cell;
        const py = ly + gy * cell;
        // Crisp 2-tone checkerboard for transparent pixels
        ctx.fillStyle = (gx + gy) % 2 === 0 ? '#2a2820' : '#34312a';
        ctx.fillRect(px, py, cell, cell);
        const sample = ctrl.sampleColorAt({ x: loupe.docPt.x + gx - half, y: loupe.docPt.y + gy - half });
        if (sample && sample[3] > 0) {
          ctx.fillStyle = `rgba(${sample[0]},${sample[1]},${sample[2]},${sample[3] / 255})`;
          ctx.fillRect(px, py, cell, cell);
        }
      }
    }

    // Center pixel highlight (never blurred)
    ctx.strokeStyle = '#c6f432';
    ctx.lineWidth = 1;
    ctx.strokeRect(lx + half * cell + 0.5, ly + half * cell + 0.5, cell - 1, cell - 1);

    // Outer frame + hex bar
    ctx.strokeStyle = '#343126';
    ctx.strokeRect(lx - 0.5, ly - 0.5, size + 1, totalH + 1);
    ctx.fillStyle = '#14130f';
    ctx.fillRect(lx, ly + size, size, barH);
    ctx.fillStyle = '#e8e4d8';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = loupe.color ? rgbaToHex(loupe.color) : 'empty';
    ctx.fillText(label, lx + size / 2, ly + size + barH / 2);
    ctx.restore();
  }

  function draw(): void {
    rafId = 0;
    const s = ctrl.state;
    const { doc, viewport: vp } = s;

    if (docCanvas.width !== doc.w || docCanvas.height !== doc.h) {
      docCanvas.width = doc.w;
      docCanvas.height = doc.h;
      onionCanvas.width = doc.w;
      onionCanvas.height = doc.h;
    }
    docCanvas.setAttribute(
      'aria-label',
      `Pixel canvas ${doc.w} by ${doc.h}, ${doc.layers.length} layers, frame ${s.activeFrame + 1} of ${doc.frames.length}`,
    );

    // Onion skin canvas (drawn under current frame, above checkerboard, ignored while playing, never exported)
    if (onionCtx && typeof ImageData !== 'undefined') {
      if (s.onion.enabled && !s.playing && doc.frames.length > 1) {
        const range = resolvePlaybackRange(doc, s.activeAnimationId, s.playDirection, s.playLoop);
        const entries = computeOnionFrames(s.activeFrame, doc.frames.length, range, s.onion);
        const out = blankCel(doc.w, doc.h);
        const activeLayer = ctrl.getActiveLayer();
        for (const e of entries) {
          const src =
            s.onion.source === 'active'
              ? composeLayerOnly(doc, activeLayer, e.frame)
              : ctrl.getComposed(e.frame);
          const tinted = buildOnionBuffer(
            src,
            s.onion.mode,
            e.kind === 'prev' ? ONION_PREV_TINT : ONION_NEXT_TINT,
            e.opacity,
          );
          compositeLayer(out, tinted, doc.w, doc.h, 100, 'normal');
        }
        const copy = new Uint8ClampedArray(out.length);
        copy.set(out);
        onionCtx.putImageData(new ImageData(copy, doc.w, doc.h), 0, 0);
      } else {
        onionCtx.clearRect(0, 0, doc.w, doc.h);
      }
    }

    const composed = ctrl.getComposed(s.activeFrame);
    const preview = activeTool().getPreview?.() ?? null;
    const display = preview || s.floating ? composed.slice() : composed;

    if (s.floating) {
      stampBuffer(display, doc.w, doc.h, s.floating.pixels, s.floating.rect, s.floating.offsetX, s.floating.offsetY, {
        maskBits: s.floating.maskBits,
      });
    }
    if (preview) {
      const col = preview.color[3] > 0 ? preview.color : ([255, 255, 255, 110] as [number, number, number, number]);
      for (const p of preview.pts) setPixel(display, doc.w, doc.h, p.x, p.y, col);
    }

    if (docCtx && typeof ImageData !== 'undefined') {
      const copy = new Uint8ClampedArray(display.length);
      copy.set(display);
      docCtx.putImageData(new ImageData(copy, doc.w, doc.h), 0, 0);
    }
    if (frameSink) {
      frameSink(display, doc.w, doc.h);
    }

    const cw = doc.w * vp.zoom;
    const ch = doc.h * vp.zoom;
    checkerBox.style.width = `${cw}px`;
    checkerBox.style.height = `${ch}px`;
    checkerBox.style.transform = `translate3d(${vp.panX}px, ${vp.panY}px, 0)`;
    docCanvas.style.width = `${cw}px`;
    docCanvas.style.height = `${ch}px`;
    docCanvas.style.transform = `translate3d(${vp.panX}px, ${vp.panY}px, 0)`;
    onionCanvas.style.width = `${cw}px`;
    onionCanvas.style.height = `${ch}px`;
    onionCanvas.style.transform = `translate3d(${vp.panX}px, ${vp.panY}px, 0)`;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(stageSize.w * dpr);
    const targetH = Math.round(stageSize.h * dpr);

    // Reference back canvas (visible ref layers below first visible pixel layer)
    if (refBackCanvas.width !== targetW || refBackCanvas.height !== targetH) {
      refBackCanvas.width = targetW;
      refBackCanvas.height = targetH;
      refBackCanvas.style.width = `${stageSize.w}px`;
      refBackCanvas.style.height = `${stageSize.h}px`;
    }
    const firstPixelIdx = doc.layers.findIndex((l) => l.visible && l.kind === 'pixel');
    if (refBackCtx) {
      refBackCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      refBackCtx.clearRect(0, 0, stageSize.w, stageSize.h);
      const splitAt = firstPixelIdx < 0 ? doc.layers.length : firstPixelIdx;
      for (let i = 0; i < splitAt; i++) {
        if (doc.layers[i].kind === 'reference') drawRefLayer(refBackCtx, doc.layers[i], vp.panX, vp.panY, vp.zoom);
      }
    }

    if (overlayCanvas.width !== targetW || overlayCanvas.height !== targetH) {
      overlayCanvas.width = targetW;
      overlayCanvas.height = targetH;
      overlayCanvas.style.width = `${stageSize.w}px`;
      overlayCanvas.style.height = `${stageSize.h}px`;
    }
    if (!overlayCtx) return;
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.clearRect(0, 0, stageSize.w, stageSize.h);

    // Repeat Tile Mode (F-TILEMODE): 3x3 tiled copies at reduced opacity outside center (never exported)
    if (s.tileMode !== 'none') {
      const dxList = s.tileMode === 'x' || s.tileMode === 'xy' ? [-1, 0, 1] : [0];
      const dyList = s.tileMode === 'y' || s.tileMode === 'xy' ? [-1, 0, 1] : [0];
      overlayCtx.save();
      overlayCtx.imageSmoothingEnabled = false;
      overlayCtx.globalAlpha = 0.42;
      for (const dy of dyList) {
        for (const dx of dxList) {
          if (dx === 0 && dy === 0) continue;
          overlayCtx.drawImage(docCanvas, vp.panX + dx * cw, vp.panY + dy * ch, cw, ch);
        }
      }
      overlayCtx.globalAlpha = 1;
      overlayCtx.strokeStyle = 'rgba(198, 244, 50, 0.55)';
      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash([4, 4]);
      overlayCtx.strokeRect(vp.panX + 0.5, vp.panY + 0.5, cw - 1, ch - 1);
      overlayCtx.restore();
    }

    // Reference layers above pixel layers
    if (firstPixelIdx >= 0) {
      for (let i = firstPixelIdx + 1; i < doc.layers.length; i++) {
        if (doc.layers[i].kind === 'reference') drawRefLayer(overlayCtx, doc.layers[i], vp.panX, vp.panY, vp.zoom);
      }
    }

    // Pixel grid (honors Preferences minZoom, opacity, and color)
    const ap = s.appPrefs;
    if (s.grid && vp.zoom >= ap.gridMinZoom) {
      overlayCtx.save();
      const alpha = Math.max(0.05, Math.min(0.4, ap.gridOpacity / 100));
      overlayCtx.strokeStyle =
        ap.gridColor === 'accent'
          ? `rgba(198, 244, 50, ${alpha})`
          : ap.gridColor === 'white'
            ? `rgba(255, 255, 255, ${alpha})`
            : `rgba(232, 228, 216, ${alpha})`;
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      const xStart = Math.max(0, Math.floor(-vp.panX / vp.zoom));
      const xEnd = Math.min(doc.w, Math.ceil((stageSize.w - vp.panX) / vp.zoom));
      const yStart = Math.max(0, Math.floor(-vp.panY / vp.zoom));
      const yEnd = Math.min(doc.h, Math.ceil((stageSize.h - vp.panY) / vp.zoom));
      for (let x = xStart; x <= xEnd; x++) {
        const sx = vp.panX + x * vp.zoom + 0.5;
        overlayCtx.moveTo(sx, vp.panY + yStart * vp.zoom);
        overlayCtx.lineTo(sx, vp.panY + yEnd * vp.zoom);
      }
      for (let y = yStart; y <= yEnd; y++) {
        const sy = vp.panY + y * vp.zoom + 0.5;
        overlayCtx.moveTo(vp.panX + xStart * vp.zoom, sy);
        overlayCtx.lineTo(vp.panX + xEnd * vp.zoom, sy);
      }
      overlayCtx.stroke();
      overlayCtx.restore();
    }

    // Optional Tile Builder alignment grid (tileW x tileH, never exported)
    if (s.tileGridOverlay && doc.tileset.tileW > 0 && doc.tileset.tileH > 0) {
      const tw = doc.tileset.tileW;
      const th = doc.tileset.tileH;
      overlayCtx.save();
      overlayCtx.strokeStyle = 'rgba(198, 244, 50, 0.28)';
      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash([3, 3]);
      overlayCtx.beginPath();
      for (let x = 0; x <= doc.w; x += tw) {
        const sx = Math.round(vp.panX + x * vp.zoom) + 0.5;
        overlayCtx.moveTo(sx, vp.panY);
        overlayCtx.lineTo(sx, vp.panY + ch);
      }
      for (let y = 0; y <= doc.h; y += th) {
        const sy = Math.round(vp.panY + y * vp.zoom) + 0.5;
        overlayCtx.moveTo(vp.panX, sy);
        overlayCtx.lineTo(vp.panX + cw, sy);
      }
      overlayCtx.stroke();
      overlayCtx.restore();
    }

    // Symmetry axis lines (solid amber-lime when locked, dashed lime when draggable)
    if (s.symmetry.mode !== 'none') {
      overlayCtx.save();
      overlayCtx.strokeStyle = s.symmetry.locked ? 'rgba(255, 138, 61, 0.85)' : '#c6f432';
      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash(s.symmetry.locked ? [] : [4, 4]);
      if (s.symmetry.mode === 'x' || s.symmetry.mode === 'xy') {
        const sx = Math.round(vp.panX + s.symmetry.x * vp.zoom) + 0.5;
        overlayCtx.beginPath();
        overlayCtx.moveTo(sx, vp.panY);
        overlayCtx.lineTo(sx, vp.panY + ch);
        overlayCtx.stroke();
      }
      if (s.symmetry.mode === 'y' || s.symmetry.mode === 'xy') {
        const sy = Math.round(vp.panY + s.symmetry.y * vp.zoom) + 0.5;
        overlayCtx.beginPath();
        overlayCtx.moveTo(vp.panX, sy);
        overlayCtx.lineTo(vp.panX + cw, sy);
        overlayCtx.stroke();
      }
      overlayCtx.restore();
    }

    // Selection marching ants
    if (s.selection) {
      const segs = maskEdges(s.selection);
      if (segs.length > 0) {
        overlayCtx.save();
        overlayCtx.lineWidth = 1;
        overlayCtx.beginPath();
        for (const seg of segs) {
          overlayCtx.moveTo(vp.panX + seg.x1 * vp.zoom + 0.5, vp.panY + seg.y1 * vp.zoom + 0.5);
          overlayCtx.lineTo(vp.panX + seg.x2 * vp.zoom + 0.5, vp.panY + seg.y2 * vp.zoom + 0.5);
        }
        overlayCtx.strokeStyle = '#14130f';
        overlayCtx.setLineDash([]);
        overlayCtx.stroke();
        overlayCtx.strokeStyle = '#e8e4d8';
        overlayCtx.setLineDash([4, 4]);
        overlayCtx.lineDashOffset = -antsPhase;
        overlayCtx.stroke();
        overlayCtx.restore();
      }
    }

    // Orphan pixel live preview (F-ORPHAN: 1px accent outline, magenta-free)
    if (s.orphanOpen && s.orphanPreview.length > 0) {
      overlayCtx.save();
      overlayCtx.strokeStyle = '#c6f432';
      overlayCtx.lineWidth = 1;
      for (const pt of s.orphanPreview) {
        overlayCtx.strokeRect(
          vp.panX + pt.x * vp.zoom + 0.5,
          vp.panY + pt.y * vp.zoom + 0.5,
          Math.max(1, vp.zoom - 1),
          Math.max(1, vp.zoom - 1),
        );
      }
      overlayCtx.restore();
    }

    // Floating paste outline
    if (s.floating) {
      overlayCtx.save();
      overlayCtx.strokeStyle = '#c6f432';
      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash([4, 3]);
      overlayCtx.lineDashOffset = -antsPhase;
      overlayCtx.strokeRect(
        vp.panX + s.floating.offsetX * vp.zoom + 0.5,
        vp.panY + s.floating.offsetY * vp.zoom + 0.5,
        s.floating.rect.w * vp.zoom - 1,
        s.floating.rect.h * vp.zoom - 1,
      );
      overlayCtx.restore();
    }

    // Selection Slice overlays (never exported)
    if (ap.showSlices && doc.slices && doc.slices.length > 0) {
      overlayCtx.save();
      overlayCtx.font = '10px "JetBrains Mono", monospace';
      overlayCtx.textBaseline = 'top';
      for (const sl of doc.slices) {
        const isActive = s.activeSliceId === sl.id;
        const sx = Math.round(vp.panX + sl.rect.x * vp.zoom) + 0.5;
        const sy = Math.round(vp.panY + sl.rect.y * vp.zoom) + 0.5;
        const sw = Math.max(1, Math.round(sl.rect.w * vp.zoom) - 1);
        const sh = Math.max(1, Math.round(sl.rect.h * vp.zoom) - 1);
        overlayCtx.strokeStyle = isActive ? '#c6f432' : 'rgba(74, 168, 255, 0.85)';
        overlayCtx.lineWidth = isActive ? 1.5 : 1;
        overlayCtx.setLineDash([4, 3]);
        overlayCtx.strokeRect(sx, sy, sw, sh);
        overlayCtx.setLineDash([]);
        const tw = Math.min(sw + 40, overlayCtx.measureText(sl.name).width + 8);
        overlayCtx.fillStyle = isActive ? '#c6f432' : 'rgba(20, 19, 15, 0.82)';
        overlayCtx.fillRect(sx, Math.max(0, sy - 14), tw, 13);
        overlayCtx.fillStyle = isActive ? '#14130f' : '#e8e4d8';
        overlayCtx.fillText(sl.name, sx + 4, Math.max(1, sy - 13));
      }
      overlayCtx.restore();
    }

    // Brush preview outline snapped to pixel grid at zoom >= 4
    if (ap.brushOutline === 'pixel' && s.hover && vp.zoom >= 4 && (s.tool === 'pencil' || s.tool === 'dither' || s.tool === 'eraser') && !spacePan && !altGrab) {
      const offs = brushOffsets(s.brushSize, s.brushShape);
      overlayCtx.save();
      overlayCtx.strokeStyle = 'rgba(232, 228, 216, 0.85)';
      overlayCtx.lineWidth = 1;
      for (const o of offs) {
        const px = s.hover.x + o.x;
        const py = s.hover.y + o.y;
        overlayCtx.strokeRect(
          vp.panX + px * vp.zoom + 0.5,
          vp.panY + py * vp.zoom + 0.5,
          vp.zoom - 1,
          vp.zoom - 1,
        );
      }
      overlayCtx.restore();
    }

    activeTool().overlay?.(overlayCtx, vp);
    drawLoupe(overlayCtx);
    syncStageNav();
  }

  const unsub = ctrl.store.subscribe(
    (s) =>
      [
        s.docRev,
        s.activeFrame,
        s.viewport,
        s.grid,
        s.symmetry,
        s.selection,
        s.floating,
        s.tool,
        s.brushSize,
        s.brushShape,
        s.grabLoupe,
        s.orphanOpen,
        s.orphanPreview,
        s.onion,
        s.playing,
        s.soloModifier,
        s.activeAnimationId,
        s.tileMode,
        s.vectorSmooth,
        s.vectorClosed,
        s.vectorFilled,
        s.vectorTension,
        s.vectorWidth,
        s.shapePreset,
        s.shapeFilled,
        s.shapeStarPoints,
        s.tileGridOverlay,
        s.editTarget,
        s.activeModMaskId,
        s.moveMode,
        s.warpPreset,
        s.warpStrength,
        s.warpSecondary,
        s.gradientShape,
        s.gradientPattern,
        s.gradientToTransparent,
        s.freeCanvas,
        s.showCanvasScrollbars,
        s.appPrefs,
        s.activeSliceId,
      ] as const,
    () => requestRender(),
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  window.requestAnimationFrame(() => {
    handleResize();
    ctrl.zoomFit();
    requestRender();
  });

  const commitActiveTool = () => {
    if (ctrl.state.floating) {
      ctrl.commitFloating();
      requestRender();
      return;
    }
    activeTool().commit?.();
  };

  // Auto-commit active live shape / vector path when switching tools so stale state never leaks
  ctrl.setBeforeToolChange(commitActiveTool);

  let padEraserOverride = false;
  let padStrokeActive = false;

  const padTool = (): Tool => (padEraserOverride ? tools.eraser : activeTool());

  const injectPadPacket = (pkt: PadPacket): void => {
    const s = ctrl.state;
    const { doc, viewport: vp } = s;
    const px = Math.min(doc.w - 1, Math.max(0, Math.floor(pkt.xNorm * doc.w)));
    const py = Math.min(doc.h - 1, Math.max(0, Math.floor(pkt.yNorm * doc.h)));
    const docPt: Pt = { x: px, y: py };
    const screenX = vp.panX + (px + 0.5) * vp.zoom;
    const screenY = vp.panY + (py + 0.5) * vp.zoom;
    const isEraser = (pkt.flags & PadFlag.Eraser) !== 0;
    const isSecondary = (pkt.flags & PadFlag.Secondary) !== 0;
    const ev: ToolEvent = {
      docPt,
      screenX,
      screenY,
      shift: false,
      alt: false,
      button: isSecondary ? 2 : 0,
    };

    if (pkt.type === PadMsgType.Hover) {
      updateHover(docPt);
      requestRender();
      return;
    }
    if (pkt.type === PadMsgType.Down) {
      padEraserOverride = isEraser;
      padStrokeActive = true;
      updateHover(docPt);
      padTool().down(ev);
      requestRender();
      return;
    }
    if (pkt.type === PadMsgType.Move) {
      updateHover(docPt);
      if (padStrokeActive) {
        padTool().move(ev);
      }
      requestRender();
      return;
    }
    if (pkt.type === PadMsgType.Up) {
      if (padStrokeActive) {
        padTool().up(ev);
        padStrokeActive = false;
        padEraserOverride = false;
        requestRender();
      }
      return;
    }
    if (pkt.type === PadMsgType.Cancel) {
      if (padStrokeActive) {
        padTool().cancel();
        padStrokeActive = false;
        padEraserOverride = false;
        requestRender();
      }
    }
  };

  return {
    el: stageEl,
    tools,
    requestRender,
    setSpacePan(down: boolean) {
      spacePan = down;
      if (!tempPan) stageEl.style.cursor = down ? 'grab' : activeTool().cursor;
    },
    cancelActiveTool() {
      if (ctrl.state.orphanOpen) {
        ctrl.closeOrphanCleaner();
        requestRender();
        return;
      }
      activeTool().cancel();
      altGrab = false;
      if (ctrl.state.floating) ctrl.cancelFloating();
      else if (ctrl.state.selection) ctrl.deselectAction();
      requestRender();
    },
    commitActiveTool,
    deleteLastVectorVertex() {
      return activeTool().deleteLastVertex?.() ?? false;
    },
    smoothVectorPath(tension: number) {
      tools.curve.smoothPath?.(tension);
    },
    sharpVectorPath() {
      tools.curve.sharpPath?.();
    },
    injectPadPacket,
    setFrameSink(sink) {
      frameSink = sink;
    },
    destroy() {
      ctrl.setBeforeToolChange(null);
      unsub();
      ro?.disconnect();
      window.clearInterval(antsTimer);
      if (rafId) window.cancelAnimationFrame(rafId);
    },
  };
}
