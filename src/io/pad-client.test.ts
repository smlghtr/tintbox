// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  BT_FRAME_HEADER_0,
  BT_FRAME_HEADER_1,
  PAD_PACKET_BYTES,
  PadCmdId,
  PadFlag,
  PadMsgType,
  decodeFrameSyncPacket,
  decodePadPacket,
  encodeFrameSyncPacket,
  encodePadPacket,
  extractFramedBtPackets,
} from './pad-client';
import { AppController } from '../ui/controller';
import { createStage } from '../ui/stage';

describe('Tintbox Pad binary protocol & canvas injection', () => {
  it('encodes and decodes 12-byte pointer and command packets accurately', () => {
    const raw = encodePadPacket({
      type: PadMsgType.Move,
      flags: PadFlag.Stylus | PadFlag.Eraser,
      xNorm: 0.5,
      yNorm: 0.25,
      pressure: 0.75,
      seq: 4242,
    });
    expect(raw.byteLength).toBe(PAD_PACKET_BYTES);
    const dec = decodePadPacket(raw)!;
    expect(dec.type).toBe(PadMsgType.Move);
    expect(dec.flags).toBe(PadFlag.Stylus | PadFlag.Eraser);
    expect(dec.xNorm).toBeCloseTo(0.5, 4);
    expect(dec.yNorm).toBeCloseTo(0.25, 4);
    expect(dec.pressure).toBeCloseTo(0.75, 4);
    expect(dec.seq).toBe(4242);

    const cmdBuf = encodePadPacket({ type: PadMsgType.Cmd, cmdId: PadCmdId.Undo, seq: 9 });
    const cmd = decodePadPacket(cmdBuf)!;
    expect(cmd.type).toBe(PadMsgType.Cmd);
    expect(cmd.cmdId).toBe(PadCmdId.Undo);
    expect(cmd.seq).toBe(9);
  });

  it('extracts framed Bluetooth SPP packets across split chunks and leading noise', () => {
    const p1 = new Uint8Array(encodePadPacket({ type: PadMsgType.Down, xNorm: 0.1, yNorm: 0.2, seq: 1 }));
    const p2 = new Uint8Array(encodePadPacket({ type: PadMsgType.Up, xNorm: 0.9, yNorm: 0.8, seq: 2 }));
    const frame1 = new Uint8Array([0x00, 0xff, BT_FRAME_HEADER_0, BT_FRAME_HEADER_1, ...p1]);
    const frame2 = new Uint8Array([BT_FRAME_HEADER_0, BT_FRAME_HEADER_1, ...p2]);

    // Split mid-second frame
    const chunkA = new Uint8Array([...frame1, ...frame2.subarray(0, 6)]);
    const chunkB = frame2.subarray(6);

    const r1 = extractFramedBtPackets(chunkA);
    expect(r1.packets).toHaveLength(1);
    expect(r1.packets[0].type).toBe(PadMsgType.Down);
    expect(r1.packets[0].seq).toBe(1);
    expect(r1.remainder.length).toBe(6);

    const merged = new Uint8Array(r1.remainder.length + chunkB.length);
    merged.set(r1.remainder, 0);
    merged.set(chunkB, r1.remainder.length);
    const r2 = extractFramedBtPackets(merged);
    expect(r2.packets).toHaveLength(1);
    expect(r2.packets[0].type).toBe(PadMsgType.Up);
    expect(r2.packets[0].seq).toBe(2);
    expect(r2.remainder.length).toBe(0);
  });

  it('injects pointer strokes directly onto stage and honors stylus eraser flag', () => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value: () => null,
      configurable: true,
    });
    const ctrl = new AppController();
    const stage = createStage(ctrl);
    ctrl.setTool('pencil');

    // Draw stroke across center
    stage.injectPadPacket(decodePadPacket(encodePadPacket({ type: PadMsgType.Down, flags: PadFlag.Stylus, xNorm: 0.5, yNorm: 0.5, seq: 1 }))!);
    stage.injectPadPacket(decodePadPacket(encodePadPacket({ type: PadMsgType.Up, flags: PadFlag.Stylus, xNorm: 0.5, yNorm: 0.5, seq: 2 }))!);

    const px = Math.floor(0.5 * ctrl.state.doc.w);
    const py = Math.floor(0.5 * ctrl.state.doc.h);
    const idx = (py * ctrl.state.doc.w + px) * 4;
    expect(ctrl.getActiveCel()[idx + 3]).toBeGreaterThan(0);

    // Stylus barrel / tail eraser flag erases without switching active tool
    stage.injectPadPacket(decodePadPacket(encodePadPacket({ type: PadMsgType.Down, flags: PadFlag.Stylus | PadFlag.Eraser, xNorm: 0.5, yNorm: 0.5, seq: 3 }))!);
    stage.injectPadPacket(decodePadPacket(encodePadPacket({ type: PadMsgType.Up, flags: PadFlag.Stylus | PadFlag.Eraser, xNorm: 0.5, yNorm: 0.5, seq: 4 }))!);

    expect(ctrl.getActiveCel()[idx + 3]).toBe(0);
    expect(ctrl.state.tool).toBe('pencil');
    stage.destroy();
  });

  it('RLE-encodes and decodes live FrameSync packets and preserves CMD args', () => {
    const w = 16;
    const h = 16;
    const rgba = new Uint8ClampedArray(w * h * 4);
    rgba[0] = 198; rgba[1] = 244; rgba[2] = 50; rgba[3] = 255;
    rgba[(w * h - 1) * 4] = 255; rgba[(w * h - 1) * 4 + 3] = 255;

    const encoded = encodeFrameSyncPacket(rgba, w, h);
    expect(encoded[0]).toBe(PadMsgType.FrameSync);
    expect(encoded[1]).toBe(1); // RLE compressed
    expect(encoded.length).toBeLessThan(rgba.length);

    const decoded = decodeFrameSyncPacket(encoded)!;
    expect(decoded.w).toBe(w);
    expect(decoded.h).toBe(h);
    expect(decoded.rgba[0]).toBe(198);
    expect(decoded.rgba[1]).toBe(244);
    expect(decoded.rgba[2]).toBe(50);
    expect(decoded.rgba[(w * h - 1) * 4]).toBe(255);

    const palCmd = decodePadPacket(
      encodePadPacket({ type: PadMsgType.Cmd, cmdId: PadCmdId.SelectPaletteIndex, cmdArg: 7, seq: 11 }),
    )!;
    expect(palCmd.cmdId).toBe(PadCmdId.SelectPaletteIndex);
    expect(palCmd.cmdArg).toBe(7);
  });
});
