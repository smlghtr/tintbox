import { describe, expect, it } from 'vitest';
import {
  ZOOM_STEPS,
  centerViewport,
  clampPan,
  fitZoom,
  resizeViewport,
  screenToDoc,
  stepZoom,
  zoomAtScreenPoint,
} from './viewport';

describe('viewport and integer zoom', () => {
  it('never produces fractional zoom values', () => {
    for (const z of ZOOM_STEPS) expect(Number.isInteger(z)).toBe(true);
    expect(stepZoom(1, -1)).toBe(1);
    expect(stepZoom(64, 1)).toBe(64);
    expect(stepZoom(3, 1)).toBe(4);
    expect(stepZoom(8, -1)).toBe(6);
  });

  it('fitZoom picks largest step that fits with 16px padding', () => {
    expect(fitZoom(600, 600, 64, 64, 16)).toBe(8);
    expect(fitZoom(100, 100, 64, 64, 16)).toBe(1);
  });

  it('anchors zoom on cursor at canvas corner with +-0 px error', () => {
    const vp0 = centerViewport(800, 600, 64, 64, 3);
    const cornerScreenX = vp0.panX + 63 * vp0.zoom + 1;
    const cornerScreenY = vp0.panY + 63 * vp0.zoom + 1;
    expect(screenToDoc(vp0, cornerScreenX, cornerScreenY)).toEqual({ x: 63, y: 63 });

    const vp1 = zoomAtScreenPoint(vp0, 4, cornerScreenX, cornerScreenY, 800, 600, 64, 64);
    expect(screenToDoc(vp1, cornerScreenX, cornerScreenY)).toEqual({ x: 63, y: 63 });

    const vp2 = zoomAtScreenPoint(vp1, 16, cornerScreenX, cornerScreenY, 800, 600, 64, 64);
    expect(screenToDoc(vp2, cornerScreenX, cornerScreenY)).toEqual({ x: 63, y: 63 });
  });

  it('clamps pan so at least 32px of canvas remains visible', () => {
    const vp = clampPan({ zoom: 4, panX: -9999, panY: 9999 }, 400, 300, 64, 64, 32);
    expect(vp.panX + 64 * 4).toBeGreaterThanOrEqual(32);
    expect(vp.panY).toBeLessThanOrEqual(300 - 32);
  });

  it('keeps center doc point fixed when window resizes', () => {
    const vp0 = centerViewport(800, 600, 64, 64, 4);
    const beforeCenter = screenToDoc(vp0, 400, 300);
    const vp1 = resizeViewport(vp0, 800, 600, 1000, 700, 64, 64);
    const afterCenter = screenToDoc(vp1, 500, 350);
    expect(afterCenter).toEqual(beforeCenter);
  });
});
