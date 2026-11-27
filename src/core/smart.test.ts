import { describe, expect, it } from 'vitest';
import { createDoc } from './doc';
import { setPixel } from './raster';
import {
  autoOrganizeTiles,
  buildAnimatedDocFromRegions,
  detectPixelIslands,
  scanOccupiedGridCells,
} from './smart';
import {
  composeTileMapRgba,
  packMapCell,
  transformTilePixels,
  unpackMapCell,
} from './tiles';

describe('smart batch commands (core/smart.ts)', () => {
  it('detectPixelIslands finds 8-connected sprite islands in reading order and snaps to grid', () => {
    const w = 32;
    const h = 32;
    const px = new Uint8ClampedArray(w * h * 4);
    // Island 1 at (2, 2)..(4, 4)
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) setPixel(px, w, h, x, y, [255, 0, 0, 255]);
    // Island 2 at (20, 3)..(22, 5)
    for (let y = 3; y <= 5; y++) for (let x = 20; x <= 22; x++) setPixel(px, w, h, x, y, [0, 255, 0, 255]);
    // Island 3 at (4, 20)..(6, 22)
    for (let y = 20; y <= 22; y++) for (let x = 4; x <= 6; x++) setPixel(px, w, h, x, y, [0, 0, 255, 255]);

    const raw = detectPixelIslands(px, w, h);
    expect(raw).toEqual([
      { x: 2, y: 2, w: 3, h: 3 },
      { x: 20, y: 3, w: 3, h: 3 },
      { x: 4, y: 20, w: 3, h: 3 },
    ]);

    const snapped = detectPixelIslands(px, w, h, { snapGrid: { w: 16, h: 16 } });
    expect(snapped).toEqual([
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 16, y: 0, w: 16, h: 16 },
      { x: 0, y: 16, w: 16, h: 16 },
    ]);
  });

  it('autoOrganizeTiles repacks scattered islands into grid slots cleanly', () => {
    const w = 32;
    const h = 32;
    const px = new Uint8ClampedArray(w * h * 4);
    setPixel(px, w, h, 28, 28, [255, 10, 10, 255]);
    setPixel(px, w, h, 20, 2, [10, 255, 10, 255]);

    const res = autoOrganizeTiles(px, w, h, 16, 16);
    expect(res.placed).toBe(2);
    // First island (top-right at y=2) lands centered in slot (0,0) -> (7,7)
    expect(res.data[(7 * w + 7) * 4 + 1]).toBe(255);
    // Second island (bottom-right at y=28) lands centered in slot (16,0) -> (23,7)
    expect(res.data[(7 * w + 23) * 4]).toBe(255);
  });

  it('scanOccupiedGridCells deduplicates identical grid cells', () => {
    const w = 32;
    const h = 16;
    const px = new Uint8ClampedArray(w * h * 4);
    // Identical dot in cell (0,0) and cell (16,0)
    setPixel(px, w, h, 1, 1, [200, 100, 50, 255]);
    setPixel(px, w, h, 17, 1, [200, 100, 50, 255]);
    const cells = scanOccupiedGridCells(px, w, h, 16, 16);
    expect(cells).toHaveLength(1);
    expect(cells[0].x).toBe(0);
  });

  it('buildAnimatedDocFromRegions creates multi-frame doc sized to largest slice', () => {
    const doc = createDoc(32, 32);
    const cel = doc.layers[0].cels[0];
    setPixel(cel, 32, 32, 2, 2, [255, 0, 0, 255]);
    setPixel(cel, 32, 32, 18, 2, [0, 255, 0, 255]);
    const anim = buildAnimatedDocFromRegions(doc, cel, [
      { x: 0, y: 0, w: 8, h: 8 },
      { x: 16, y: 0, w: 12, h: 10 },
    ]);
    expect(anim.w).toBe(12);
    expect(anim.h).toBe(10);
    expect(anim.frames).toHaveLength(2);
    expect(anim.animations[0].name).toBe('Sliced');
    expect(anim.layers[0].cels).toHaveLength(2);
  });
});

describe('map tile cell transforms (core/tiles.ts)', () => {
  it('packMapCell / unpackMapCell round-trips tileId, rotation, and flipH/flipV', () => {
    expect(unpackMapCell(0)).toEqual({ tileId: 0, rot: 0, flipH: false, flipV: false });
    expect(unpackMapCell(5)).toEqual({ tileId: 5, rot: 0, flipH: false, flipV: false });
    const packed = packMapCell(7, 3, true, true);
    expect(unpackMapCell(packed)).toEqual({ tileId: 7, rot: 3, flipH: true, flipV: true });
  });

  it('transformTilePixels rotates 90° CW and flips accurately in composeTileMapRgba', () => {
    // 2x2 tile with red at top-left (0,0)
    const tilePx = new Uint8ClampedArray(2 * 2 * 4);
    setPixel(tilePx, 2, 2, 0, 0, [255, 0, 0, 255]);

    const rot90 = transformTilePixels(tilePx, 2, 2, 1, false, false);
    // 90° CW moves (0,0) -> (1,0)
    expect(rot90[(0 * 2 + 1) * 4]).toBe(255);
    expect(rot90[0]).toBe(0);

    const flippedH = transformTilePixels(tilePx, 2, 2, 0, true, false);
    expect(flippedH[(0 * 2 + 1) * 4]).toBe(255);

    const doc = createDoc(4, 4);
    doc.tileset = {
      tileW: 2,
      tileH: 2,
      tiles: [{ id: 't1', name: 'T1', category: 'ground', pixels: tilePx, hash: 'h', linked: false }],
    };
    doc.tilemap = {
      width: 2,
      height: 1,
      layers: [{ id: 'ml1', name: 'Ground', visible: true, data: [packMapCell(1, 0, false, false), packMapCell(1, 2, false, false)] }],
    };
    const composed = composeTileMapRgba(doc);
    // Cell 0 (0°): red at (0,0); Cell 1 (180°): red at (3,1)
    expect(composed.data[(0 * 4 + 0) * 4]).toBe(255);
    expect(composed.data[(1 * 4 + 3) * 4]).toBe(255);
  });
});
