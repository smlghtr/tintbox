import { describe, expect, it } from 'vitest';
import { createDoc } from '../core/doc';
import { defaultJuiceParams, generateJuiceFrames } from '../core/juice';
import { bakeJuiceAnimationCommand } from './commands';
import { History, type CommandContext } from './history';

describe('bakeJuiceAnimationCommand (state/commands.ts)', () => {
  it('bakes frames, creates animation tag, and undo/redo round-trips byte-identically', () => {
    const doc = createDoc(16, 16);
    const layer = doc.layers[0];
    // Paint a 4x4 block in frame 0
    for (let y = 6; y < 10; y++) {
      for (let x = 6; x < 10; x++) {
        const i = (y * 16 + x) * 4;
        layer.cels[0][i] = 198;
        layer.cels[0][i + 1] = 244;
        layer.cels[0][i + 2] = 50;
        layer.cels[0][i + 3] = 255;
      }
    }
    const initialCel0 = layer.cels[0].slice();
    const initialFrames = doc.frames.length;

    let activeFrame = 0;
    const ctx: CommandContext = {
      doc,
      getActiveLayerId: () => layer.id,
      setActiveLayerId: () => {},
      getActiveFrame: () => activeFrame,
      setActiveFrame: (f) => { activeFrame = f; },
      getSelection: () => null,
      setSelection: () => {},
      markDirty: () => {},
    };
    const history = new History();
    const params = { ...defaultJuiceParams('squash-bounce'), frames: 6, fps: 12 };
    const frames = generateJuiceFrames(layer.cels[0], 16, 16, params);

    history.execute(bakeJuiceAnimationCommand(layer.id, 0, frames, 83, 'Juice: Squash Bounce'), ctx);
    expect(doc.frames.length).toBe(6);
    expect(layer.cels.length).toBe(6);
    expect(doc.animations.length).toBe(1);
    expect(doc.animations[0].name).toBe('Juice: Squash Bounce');
    expect(doc.animations[0].from).toBe(0);
    expect(doc.animations[0].to).toBe(5);
    expect(doc.frames[2].duration).toBe(83);
    expect(layer.cels[2]).toEqual(frames[2]);

    // Undo restores exact initial document state
    history.undo(ctx);
    expect(doc.frames.length).toBe(initialFrames);
    expect(layer.cels.length).toBe(initialFrames);
    expect(doc.animations.length).toBe(0);
    expect(layer.cels[0]).toEqual(initialCel0);

    // Redo restores baked animation identically
    history.redo(ctx);
    expect(doc.frames.length).toBe(6);
    expect(doc.animations.length).toBe(1);
    expect(layer.cels[2]).toEqual(frames[2]);
  });
});
