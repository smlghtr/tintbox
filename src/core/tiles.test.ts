import { describe, expect, it } from 'vitest';
import { createDoc } from './doc';
import { floodFill, setPixel, stampBrush } from './raster';
import {
  buildTileMapExportJson,
  buildTilesetAtlas,
  captureTileFromDoc,
  composeTileMapRgba,
  createMapLayer,
  hashRgba,
  mapFloodFill,
  mapRectCells,
  resizeTileMapData,
  resolveTilePixels,
  wrapPoint,
  wrapPoints,
  type TileMapExportJson,
} from './tiles';

describe('P5 F-TILEMODE wrapping', () => {
  it('wraps points across X, Y, or both edges and clips non-wrapping axes', () => {
    expect(wrapPoint({ x: -1, y: 2 }, 8, 8, 'x')).toEqual({ x: 7, y: 2 });
    expect(wrapPoint({ x: 8, y: -1 }, 8, 8, 'x')).toBeNull();
    expect(wrapPoint({ x: 2, y: -1 }, 8, 8, 'y')).toEqual({ x: 2, y: 7 });
    expect(wrapPoint({ x: 9, y: -2 }, 8, 8, 'xy')).toEqual({ x: 1, y: 6 });
    expect(wrapPoints([{ x: -1, y: 0 }, { x: 8, y: 8 }], 8, 8, 'xy')).toEqual([
      { x: 7, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it('wraps brush strokes and flood fill seamlessly across edges when enabled', () => {
    const w = 8;
    const h = 8;
    const cel = new Uint8ClampedArray(w * h * 4);
    stampBrush(cel, w, h, [{ x: 0, y: 0 }], [255, 0, 0, 255], {
      size: 3,
      shape: 'square',
      wrapX: true,
      wrapY: true,
    });
    // 3x3 centered at (0,0) must wrap to (7,7), (7,0), (0,7)
    expect(cel[(7 * w + 7) * 4]).toBe(255);
    expect(cel[(0 * w + 7) * 4]).toBe(255);
    expect(cel[(7 * w + 0) * 4]).toBe(255);

    // Flood fill wrapping across X boundary
    const cel2 = new Uint8ClampedArray(w * h * 4);
    // Draw vertical wall at x = 4 splitting left (0..3) and right (5..7)
    for (let y = 0; y < h; y++) setPixel(cel2, w, h, 4, y, [0, 0, 0, 255]);
    floodFill(cel2, w, h, 0, 0, [0, 255, 0, 255], { wrapX: true, wrapY: false });
    // Because wrapX is true, x=0 connects to x=7 and fills both sides of the wall!
    expect(cel2[(0 * w + 7) * 4 + 1]).toBe(255);
    expect(cel2[(0 * w + 4) * 4 + 1]).toBe(0);
  });
});

describe('P5 Tile Builder, deduplication & linked live sync', () => {
  it('captures tiles, deduplicates identical pixel buffers, and live-updates linked tiles on map', () => {
    const doc = createDoc(32, 32);
    doc.tileset.tileW = 8;
    doc.tileset.tileH = 8;

    // Paint distinct tile at (0,0)
    setPixel(doc.layers[0].cels[0], 32, 32, 1, 1, [198, 244, 50, 255]);
    const cap1 = captureTileFromDoc(doc, 0, 0, 0, 'ground', 'Grass');
    expect(cap1.duplicateIndex).toBeNull();
    doc.tileset.tiles.push(cap1.tile);

    // Capturing an identical region at (8,0) with same pixel triggers duplicate warning
    setPixel(doc.layers[0].cels[0], 32, 32, 9, 1, [198, 244, 50, 255]);
    const capDup = captureTileFromDoc(doc, 8, 0, 0, 'ground', 'GrassCopy');
    expect(capDup.duplicateIndex).toBe(0);
    expect(hashRgba(capDup.tile.pixels)).toBe(cap1.tile.hash);

    // Paint tile #1 onto map cell (0,0)
    doc.tilemap.width = 2;
    doc.tilemap.height = 2;
    doc.tilemap.layers = [createMapLayer('Ground', 2, 2)];
    doc.tilemap.layers[0].data[0] = 1;

    // AC: Edit source pixel at (2,2) on canvas -> linked tile & composed map update immediately!
    setPixel(doc.layers[0].cels[0], 32, 32, 2, 2, [255, 40, 80, 255]);
    const resolved = resolveTilePixels(doc, doc.tileset.tiles[0]);
    expect(Array.from(resolved.subarray((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4))).toEqual([255, 40, 80, 255]);

    const mapImg = composeTileMapRgba(doc);
    expect(mapImg.w).toBe(16);
    expect(mapImg.h).toBe(16);
    expect(Array.from(mapImg.data.subarray((2 * 16 + 2) * 4, (2 * 16 + 2) * 4 + 4))).toEqual([255, 40, 80, 255]);

    // Unlinking freezes snapshot
    doc.tileset.tiles[0].linked = false;
    setPixel(doc.layers[0].cels[0], 32, 32, 2, 2, [0, 0, 0, 255]);
    const unlinked = resolveTilePixels(doc, doc.tileset.tiles[0]);
    expect(unlinked[(2 * 8 + 2) * 4]).toBe(0); // original snapshot before (2,2) was painted
  });
});

describe('P5 Map Editor & Atlas Extrusion Export', () => {
  it('supports rect, flood fill, resize, and exports exact JSON + non-overlapping extruded atlas', () => {
    const doc = createDoc(16, 16);
    doc.tileset.tileW = 4;
    doc.tileset.tileH = 4;

    // Create 2 distinct 4x4 tiles with distinct border colors to verify extrusion zero bleed
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        setPixel(doc.layers[0].cels[0], 16, 16, x, y, [200, 10, 10, 255]);
        setPixel(doc.layers[0].cels[0], 16, 16, 4 + x, y, [10, 200, 10, 255]);
      }
    }
    doc.tileset.tiles.push(captureTileFromDoc(doc, 0, 0, 0, 'ground', 'Red').tile);
    doc.tileset.tiles.push(captureTileFromDoc(doc, 4, 0, 0, 'wall', 'Green').tile);

    // Map ops: rect + flood fill + resize
    const rectPts = mapRectCells({ x: 1, y: 1 }, { x: 2, y: 2 }, 4, 4);
    expect(rectPts).toHaveLength(4);

    let grid = new Array<number>(16).fill(0);
    for (const p of rectPts) grid[p.y * 4 + p.x] = 2;
    grid = mapFloodFill(grid, 4, 4, 0, 0, 1);
    expect(grid[0]).toBe(1);
    expect(grid[1 * 4 + 1]).toBe(2);

    const resized = resizeTileMapData(grid, 4, 4, 5, 3);
    expect(resized).toHaveLength(15);
    expect(resized[0]).toBe(1);
    expect(resized[4]).toBe(0);

    doc.tilemap.width = 4;
    doc.tilemap.height = 4;
    doc.tilemap.layers = [{ id: 'l1', name: 'Ground', visible: true, data: grid }];

    const jsonStr = buildTileMapExportJson(doc);
    const parsed = JSON.parse(jsonStr) as TileMapExportJson;
    expect(parsed.tileSize).toBe(4);
    expect(parsed.width).toBe(4);
    expect(parsed.height).toBe(4);
    expect(parsed.layers).toEqual([{ name: 'Ground', visible: true, data: grid }]);

    // Atlas with 2px extrusion: 2 tiles -> cols=2, rows=1, cellSize = 4 + 4 = 8 => 16x8
    const atlas = buildTilesetAtlas(doc, 2);
    expect(atlas.w).toBe(16);
    expect(atlas.h).toBe(8);
    expect(atlas.tiles).toHaveLength(2);
    // Tile 1 inner rect is (2,2,4,4), Tile 2 inner rect is (10,2,4,4) -> zero overlap!
    expect(atlas.tiles[0]).toMatchObject({ x: 2, y: 2, w: 4, h: 4 });
    expect(atlas.tiles[1]).toMatchObject({ x: 10, y: 2, w: 4, h: 4 });
    // Extruded border of tile 1 at (0,0) and (7,7) is red; tile 2 border at (8,0) is green (zero bleed!)
    expect(Array.from(atlas.data.subarray(0, 4))).toEqual([200, 10, 10, 255]);
    expect(Array.from(atlas.data.subarray((7 * 16 + 7) * 4, (7 * 16 + 7) * 4 + 4))).toEqual([200, 10, 10, 255]);
    expect(Array.from(atlas.data.subarray(8 * 4, 8 * 4 + 4))).toEqual([10, 200, 10, 255]);
  });
});
