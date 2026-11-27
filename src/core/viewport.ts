import type { Pt } from './types';

export const ZOOM_STEPS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64] as const;

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

export function nearestZoomStep(z: number): number {
  let best: number = ZOOM_STEPS[0];
  let bestDist = Math.abs(z - best);
  for (const step of ZOOM_STEPS) {
    const d = Math.abs(z - step);
    if (d < bestDist) {
      best = step;
      bestDist = d;
    }
  }
  return best;
}

export function stepZoom(current: number, delta: number): number {
  const cur = nearestZoomStep(current);
  const idx = ZOOM_STEPS.indexOf(cur as (typeof ZOOM_STEPS)[number]);
  const nextIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + Math.sign(delta)));
  return ZOOM_STEPS[nextIdx];
}

export function fitZoom(vpW: number, vpH: number, docW: number, docH: number, padding = 16): number {
  const availW = Math.max(1, vpW - padding * 2);
  const availH = Math.max(1, vpH - padding * 2);
  let chosen: number = ZOOM_STEPS[0];
  for (const step of ZOOM_STEPS) {
    if (docW * step <= availW && docH * step <= availH) chosen = step;
    else break;
  }
  return chosen;
}

export function centerViewport(vpW: number, vpH: number, docW: number, docH: number, zoom: number): Viewport {
  const z = nearestZoomStep(zoom);
  return {
    zoom: z,
    panX: Math.round((vpW - docW * z) / 2),
    panY: Math.round((vpH - docH * z) / 2),
  };
}

export function clampPan(
  vp: Viewport,
  vpW: number,
  vpH: number,
  docW: number,
  docH: number,
  minVisible = 32,
  freePasteboard = false,
): Viewport {
  const cw = docW * vp.zoom;
  const ch = docH * vp.zoom;
  if (freePasteboard) {
    const padX = Math.max(vpW * 2, cw * 3, 1600);
    const padY = Math.max(vpH * 2, ch * 3, 1600);
    return {
      zoom: vp.zoom,
      panX: Math.round(Math.max(-cw - padX, Math.min(vpW + padX, vp.panX))),
      panY: Math.round(Math.max(-ch - padY, Math.min(vpH + padY, vp.panY))),
    };
  }
  const visW = Math.min(minVisible, cw);
  const visH = Math.min(minVisible, ch);
  const minX = visW - cw;
  const maxX = vpW - visW;
  const minY = visH - ch;
  const maxY = vpH - visH;
  return {
    zoom: vp.zoom,
    panX: Math.round(Math.max(minX, Math.min(maxX, vp.panX))),
    panY: Math.round(Math.max(minY, Math.min(maxY, vp.panY))),
  };
}

export function screenToDoc(vp: Viewport, sx: number, sy: number): Pt {
  return {
    x: Math.floor((sx - vp.panX) / vp.zoom),
    y: Math.floor((sy - vp.panY) / vp.zoom),
  };
}

export function docToScreen(vp: Viewport, dx: number, dy: number): Pt {
  return {
    x: vp.panX + dx * vp.zoom,
    y: vp.panY + dy * vp.zoom,
  };
}

function anchorAxis(sx: number, oldPan: number, oldZoom: number, nextZoom: number): number {
  const docCoord = (sx - oldPan) / oldZoom;
  const px = Math.floor(docCoord);
  const raw = Math.round(sx - docCoord * nextZoom);
  const lo = Math.floor(sx - (px + 1) * nextZoom) + 1;
  const hi = Math.floor(sx - px * nextZoom);
  return Math.max(lo, Math.min(hi, raw));
}

export function zoomAtScreenPoint(
  vp: Viewport,
  nextZoom: number,
  sx: number,
  sy: number,
  vpW: number,
  vpH: number,
  docW: number,
  docH: number,
  freePasteboard = false,
): Viewport {
  const z = nearestZoomStep(nextZoom);
  const next: Viewport = {
    zoom: z,
    panX: anchorAxis(sx, vp.panX, vp.zoom, z),
    panY: anchorAxis(sy, vp.panY, vp.zoom, z),
  };
  return clampPan(next, vpW, vpH, docW, docH, 32, freePasteboard);
}

export function resizeViewport(
  vp: Viewport,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
  docW: number,
  docH: number,
  freePasteboard = false,
): Viewport {
  const next: Viewport = {
    zoom: vp.zoom,
    panX: Math.round(vp.panX + (newW - oldW) / 2),
    panY: Math.round(vp.panY + (newH - oldH) / 2),
  };
  return clampPan(next, newW, newH, docW, docH, 32, freePasteboard);
}
