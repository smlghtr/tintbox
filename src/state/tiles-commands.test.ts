import { describe, expect, it } from 'vitest';
import { createDoc } from '../core/doc';
import { setPixel } from '../core/raster';
import { captureTileFromDoc } from '../core/tiles';
import {
  addMapLayerCommand,
  addTileCommand,
  removeMapLayerCommand,
  removeTileCommand,
  resizeTileMapCommand,
  setLayerFrameCountCommand,
  setMapLayerDataCommand,
  setTileSizeCommand,
  toggleMapLayerVisibleCommand,
  updateTileMetaCommand,
} from './commands';
import { History, type CommandContext } from './history';

function makeCtx(doc = createDoc(32, 32)): { ctx: CommandContext; history: History } {
  let activeLayerId = doc.layers[0].id;
  let activeFrame = 0;
  const ctx: CommandContext = {
    doc,
    getSelection: () => null,
    setSelection: () => {},
    getActiveLayerId: () => activeLayerId,
    setActiveLayerId: (id) => { activeLayerId = id; },
    getActiveFrame: () => activeFrame,
    setActiveFrame: (f) => { activeFrame = f; },
    markDirty: () => {},
  };
  return { ctx, history: new History() };
}

describe('P5 tile & map commands (undo/redo)', () => {
  it('undoes and redoes tile size, capture, unlink, delete (remapping map indices), and map ops cleanly', () => {
    const doc = createDoc(32, 32);
    const { ctx, history } = makeCtx(doc);

    history.execute(setTileSizeCommand(8, 8), ctx);
    expect(doc.tileset.tileW).toBe(8);

    setPixel(doc.layers[0].cels[0], 32, 32, 0, 0, [255, 0, 0, 255]);
    setPixel(doc.layers[0].cels[0], 32, 32, 8, 0, [0, 255, 0, 255]);
    const t1 = captureTileFromDoc(doc, 0, 0, 0, 'ground', 'Red').tile;
    const t2 = captureTileFromDoc(doc, 8, 0, 0, 'wall', 'Green').tile;
    history.execute(addTileCommand(t1), ctx);
    history.execute(addTileCommand(t2), ctx);
    expect(doc.tileset.tiles).toHaveLength(2);

    // Unlink t1 and rename
    history.execute(updateTileMetaCommand(t1.id, { name: 'Brick', category: 'wall', linked: false }), ctx);
    expect(doc.tileset.tiles[0].name).toBe('Brick');
    expect(doc.tileset.tiles[0].linked).toBe(false);
    history.undo(ctx);
    expect(doc.tileset.tiles[0].name).toBe('Red');
    expect(doc.tileset.tiles[0].linked).toBe(true);
    history.redo(ctx);

    // Paint map cells with tile 1 and tile 2
    const ml0 = doc.tilemap.layers[0];
    const before = ml0.data.slice();
    const after = before.slice();
    after[0] = 1;
    after[1] = 2;
    history.execute(setMapLayerDataCommand(ml0.id, before, after, 'Paint tiles'), ctx);
    expect(ml0.data[0]).toBe(1);
    expect(ml0.data[1]).toBe(2);

    // Removing tile 1 clears cell 0 -> 0 and shifts cell 1 (tile 2) -> 1; undo restores exact indices
    history.execute(removeTileCommand(t1.id), ctx);
    expect(doc.tileset.tiles).toHaveLength(1);
    expect(ml0.data[0]).toBe(0);
    expect(ml0.data[1]).toBe(1);
    history.undo(ctx);
    expect(doc.tileset.tiles).toHaveLength(2);
    expect(doc.tilemap.layers[0].data[0]).toBe(1);
    expect(doc.tilemap.layers[0].data[1]).toBe(2);

    // Add, toggle visibility, remove map layer & resize map
    history.execute(addMapLayerCommand('Props'), ctx);
    expect(doc.tilemap.layers).toHaveLength(2);
    const propId = doc.tilemap.layers[1].id;
    history.execute(toggleMapLayerVisibleCommand(propId), ctx);
    expect(doc.tilemap.layers[1].visible).toBe(false);
    history.execute(removeMapLayerCommand(propId), ctx);
    expect(doc.tilemap.layers).toHaveLength(1);
    history.undo(ctx);
    expect(doc.tilemap.layers).toHaveLength(2);

    history.execute(resizeTileMapCommand(10, 8), ctx);
    expect(doc.tilemap.width).toBe(10);
    expect(doc.tilemap.height).toBe(8);
    expect(doc.tilemap.layers[0].data).toHaveLength(80);
    history.undo(ctx);
    expect(doc.tilemap.width).toBe(16);
    expect(doc.tilemap.height).toBe(12);
  });

  it('P6 setLayerFrameCountCommand changes cel count undoably preserving trimmed pixels on undo', () => {
    const doc = createDoc(8, 8);
    const { ctx, history } = makeCtx(doc);
    const l0 = doc.layers[0];
    history.execute(setLayerFrameCountCommand(l0.id, 3), ctx);
    expect(l0.cels).toHaveLength(3);
    setPixel(l0.cels[2], 8, 8, 1, 1, [255, 0, 0, 255]);

    history.execute(setLayerFrameCountCommand(l0.id, 1), ctx);
    expect(l0.cels).toHaveLength(1);
    history.undo(ctx);
    expect(l0.cels).toHaveLength(3);
    expect(l0.cels[2][(1 * 8 + 1) * 4]).toBe(255);
  });
});
