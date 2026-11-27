/**
 * Near-zero-latency binary client for Tintbox Pad (Android companion drawing tablet).
 *
 * 12-byte little-endian binary packet layout (shared verbatim with Android Kotlin client):
 *   byte  0     : msgType  (1=DOWN, 2=MOVE, 3=UP, 4=HOVER, 5=CANCEL, 6=CMD, 7=PING, 8=PONG, 9=FRAME_SYNC)
 *   byte  1     : flags    (bit0=stylus, bit1=eraser/barrel, bit2=secondary, bit3=coalesced)
 *   bytes 2..3  : xNorm    (uint16 LE, 0..65535 -> 0..1 across canvas width; or cmdId for CMD)
 *   bytes 4..5  : yNorm    (uint16 LE, 0..65535 -> 0..1 across canvas height; or arg for CMD)
 *   bytes 6..7  : pressure (uint16 LE, 0..65535 -> 0..1)
 *   bytes 8..11 : seq      (uint32 LE, timestamp ms or sequence id)
 *
 * Frame sync packet (Tintbox -> Android, msgType = 9):
 *   byte  0     : 9 (FrameSync)
 *   byte  1     : encoding (0=raw RGBA, 1=RLE RGBA [count(u8), R, G, B, A])
 *   bytes 2..3  : width  (uint16 LE)
 *   bytes 4..5  : height (uint16 LE)
 *   bytes 6..   : pixel payload
 *
 * Bluetooth SPP framing wraps each 12-byte pointer packet with 2-byte sync header `[0xAA, 0x55]`.
 */

export const PAD_PACKET_BYTES = 12;
export const BT_FRAME_HEADER_0 = 0xaa;
export const BT_FRAME_HEADER_1 = 0x55;
export const BT_SPP_SERVICE_UUID = '00001101-0000-1000-8000-00805f9b34fb';

export const enum PadMsgType {
  Down = 1,
  Move = 2,
  Up = 3,
  Hover = 4,
  Cancel = 5,
  Cmd = 6,
  Ping = 7,
  Pong = 8,
  FrameSync = 9,
}

export const enum PadFlag {
  Stylus = 1 << 0,
  Eraser = 1 << 1,
  Secondary = 1 << 2,
  Coalesced = 1 << 3,
}

export const enum PadCmdId {
  Undo = 1,
  Redo = 2,
  ToolPen = 3,
  ToolEraser = 4,
  ToolPicker = 5,
  SwapColors = 6,
  BrushDec = 7,
  BrushInc = 8,
  ToolFill = 9,
  ToolLine = 10,
  ToggleGrid = 11,
  ToggleSymX = 12,
  ToggleOnion = 13,
  PrevFrame = 14,
  NextFrame = 15,
  SelectPaletteIndex = 16,
}

export interface PadPacket {
  type: PadMsgType;
  flags: number;
  xNorm: number;
  yNorm: number;
  cmdId: number;
  cmdArg: number;
  pressure: number;
  seq: number;
}

export interface PadDocSync {
  w: number;
  h: number;
  tool: string;
  primaryHex: string;
  brushSize?: number;
  frame?: number;
  frameCount?: number;
  palette?: string[];
}

export type PadConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type PadTransportKind = 'none' | 'ws' | 'bt-serial';

export interface PadClientStatus {
  status: PadConnectionStatus;
  transport: PadTransportKind;
  url: string;
  padsOnline: number;
  rttMs: number | null;
  error: string | null;
}

export function encodePadPacket(pkt: {
  type: PadMsgType;
  flags?: number;
  xNorm?: number;
  yNorm?: number;
  cmdId?: number;
  cmdArg?: number;
  pressure?: number;
  seq?: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(PAD_PACKET_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, pkt.type & 0xff);
  v.setUint8(1, (pkt.flags ?? 0) & 0xff);
  const xVal =
    pkt.type === PadMsgType.Cmd
      ? Math.max(0, Math.min(65535, Math.round(pkt.cmdId ?? 0)))
      : Math.max(0, Math.min(65535, Math.round((pkt.xNorm ?? 0) * 65535)));
  const yVal =
    pkt.type === PadMsgType.Cmd
      ? Math.max(0, Math.min(65535, Math.round(pkt.cmdArg ?? 0)))
      : Math.max(0, Math.min(65535, Math.round((pkt.yNorm ?? 0) * 65535)));
  const pVal = Math.max(0, Math.min(65535, Math.round((pkt.pressure ?? 1) * 65535)));
  v.setUint16(2, xVal, true);
  v.setUint16(4, yVal, true);
  v.setUint16(6, pVal, true);
  v.setUint32(8, (pkt.seq ?? 0) >>> 0, true);
  return buf;
}

export function decodePadPacket(buf: ArrayBuffer | Uint8Array): PadPacket | null {
  const view =
    buf instanceof Uint8Array
      ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      : new DataView(buf);
  if (view.byteLength < PAD_PACKET_BYTES) return null;
  const type = view.getUint8(0) as PadMsgType;
  const flags = view.getUint8(1);
  const rawX = view.getUint16(2, true);
  const rawY = view.getUint16(4, true);
  const rawP = view.getUint16(6, true);
  const seq = view.getUint32(8, true);
  return {
    type,
    flags,
    xNorm: rawX / 65535,
    yNorm: rawY / 65535,
    cmdId: rawX,
    cmdArg: rawY,
    pressure: rawP / 65535,
    seq,
  };
}

/**
 * Encode composited RGBA pixels into a compact binary FrameSync packet (RLE-compressed if smaller).
 * Automatically nearest-neighbor downscales canvases larger than `maxDim` (default 256) to keep
 * frame transfer sub-millisecond.
 */
export function encodeFrameSyncPacket(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  maxDim = 256,
): Uint8Array<ArrayBuffer> {
  let outW = Math.max(1, w);
  let outH = Math.max(1, h);
  let src: Uint8ClampedArray | Uint8Array = rgba;

  if (outW > maxDim || outH > maxDim) {
    const scale = maxDim / Math.max(outW, outH);
    const dw = Math.max(1, Math.round(outW * scale));
    const dh = Math.max(1, Math.round(outH * scale));
    const down = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(outH - 1, Math.floor((y * outH) / dh));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(outW - 1, Math.floor((x * outW) / dw));
        const si = (sy * outW + sx) * 4;
        const di = (y * dw + x) * 4;
        down[di] = rgba[si];
        down[di + 1] = rgba[si + 1];
        down[di + 2] = rgba[si + 2];
        down[di + 3] = rgba[si + 3];
      }
    }
    src = down;
    outW = dw;
    outH = dh;
  }

  const pixelCount = outW * outH;
  const rawBytes = pixelCount * 4;

  // Try fast RGBA RLE: [count(1..255), R, G, B, A]
  const rleCap = rawBytes;
  const rle = new Uint8Array(6 + rleCap);
  rle[0] = PadMsgType.FrameSync;
  rle[1] = 1; // RLE
  rle[2] = outW & 0xff;
  rle[3] = (outW >>> 8) & 0xff;
  rle[4] = outH & 0xff;
  rle[5] = (outH >>> 8) & 0xff;

  let wp = 6;
  let i = 0;
  let overflow = false;
  while (i < pixelCount) {
    const off = i * 4;
    const r = src[off];
    const g = src[off + 1];
    const b = src[off + 2];
    const a = src[off + 3];
    let run = 1;
    while (run < 255 && i + run < pixelCount) {
      const no = (i + run) * 4;
      if (src[no] !== r || src[no + 1] !== g || src[no + 2] !== b || src[no + 3] !== a) break;
      run++;
    }
    if (wp + 5 > rle.length) {
      overflow = true;
      break;
    }
    rle[wp++] = run;
    rle[wp++] = r;
    rle[wp++] = g;
    rle[wp++] = b;
    rle[wp++] = a;
    i += run;
  }

  if (!overflow && wp < 6 + rawBytes) {
    return rle.subarray(0, wp);
  }

  // Fallback to raw RGBA
  const raw = new Uint8Array(6 + rawBytes);
  raw[0] = PadMsgType.FrameSync;
  raw[1] = 0; // raw
  raw[2] = outW & 0xff;
  raw[3] = (outW >>> 8) & 0xff;
  raw[4] = outH & 0xff;
  raw[5] = (outH >>> 8) & 0xff;
  raw.set(src.subarray(0, rawBytes), 6);
  return raw;
}

export function decodeFrameSyncPacket(
  buf: Uint8Array,
): { w: number; h: number; rgba: Uint8ClampedArray } | null {
  if (buf.length < 6 || buf[0] !== PadMsgType.FrameSync) return null;
  const enc = buf[1];
  const w = buf[2] | (buf[3] << 8);
  const h = buf[4] | (buf[5] << 8);
  if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  if (enc === 0) {
    if (buf.length < 6 + out.length) return null;
    out.set(buf.subarray(6, 6 + out.length));
    return { w, h, rgba: out };
  }
  if (enc === 1) {
    let rp = 6;
    let px = 0;
    const total = w * h;
    while (rp + 4 < buf.length && px < total) {
      const count = buf[rp++];
      const r = buf[rp++];
      const g = buf[rp++];
      const b = buf[rp++];
      const a = buf[rp++];
      const end = Math.min(total, px + count);
      for (; px < end; px++) {
        const o = px * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
      }
    }
    return { w, h, rgba: out };
  }
  return null;
}

/** Extract complete `[0xAA, 0x55, ...12 bytes]` Bluetooth SPP framed packets from a byte stream buffer. */
export function extractFramedBtPackets(
  stream: Uint8Array,
): { packets: PadPacket[]; remainder: Uint8Array } {
  const packets: PadPacket[] = [];
  let i = 0;
  const frameLen = 2 + PAD_PACKET_BYTES;
  while (i + frameLen <= stream.length) {
    if (stream[i] === BT_FRAME_HEADER_0 && stream[i + 1] === BT_FRAME_HEADER_1) {
      const pkt = decodePadPacket(stream.subarray(i + 2, i + frameLen));
      if (pkt) packets.push(pkt);
      i += frameLen;
    } else {
      i++;
    }
  }
  const tailStart = i;
  return { packets, remainder: stream.slice(tailStart) };
}

interface SerialPortLike {
  open(opts: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable?: ReadableStream<Uint8Array> | null;
  writable?: WritableStream<Uint8Array> | null;
}

interface SerialRequestPortOpts {
  filters?: Array<{ bluetoothServiceClassId?: string; usbVendorId?: number }>;
  allowedBluetoothServiceClassIds?: string[];
}

interface NavigatorWithSerial {
  serial?: {
    requestPort(opts?: SerialRequestPortOpts): Promise<SerialPortLike>;
  };
}

export function supportsBluetoothSerial(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as unknown as NavigatorWithSerial).serial);
}

export class PadClient {
  private ws: WebSocket | null = null;
  private serialPort: SerialPortLike | null = null;
  private serialReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private serialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pingTimer = 0;
  private lastPingSentAt = 0;
  private lastPingSeq = 0;
  private lastFrameSentAt = 0;
  private pendingFrameTimer = 0;
  private pendingFrame: { rgba: Uint8ClampedArray; w: number; h: number } | null = null;
  private lastDocSync: PadDocSync | null = null;

  private state: PadClientStatus = {
    status: 'disconnected',
    transport: 'none',
    url: 'ws://127.0.0.1:8765',
    padsOnline: 0,
    rttMs: null,
    error: null,
  };
  private onPacket: (pkt: PadPacket) => void;
  private onStatus: (st: PadClientStatus) => void;

  constructor(onPacket: (pkt: PadPacket) => void, onStatus: (st: PadClientStatus) => void) {
    this.onPacket = onPacket;
    this.onStatus = onStatus;
  }

  get status(): PadClientStatus {
    return { ...this.state };
  }

  get isStreamingActive(): boolean {
    return this.state.status === 'connected' && this.state.padsOnline > 0;
  }

  private emit(patch: Partial<PadClientStatus>): void {
    const prevOnline = this.state.padsOnline;
    this.state = { ...this.state, ...patch };
    this.onStatus(this.status);
    // When a pad joins, immediately push latest doc metadata + pending canvas frame
    if (this.state.status === 'connected' && this.state.padsOnline > 0 && prevOnline === 0) {
      if (this.lastDocSync) this.sendDocSync(this.lastDocSync);
      if (this.pendingFrame) {
        const f = this.pendingFrame;
        this.flushFrameNow(f.rgba, f.w, f.h);
      }
    }
  }

  connectWebSocket(baseUrl: string): void {
    this.disconnect();
    const trimmed = baseUrl.trim() || 'ws://127.0.0.1:8765';
    const wsUrl = trimmed.includes('role=')
      ? trimmed
      : `${trimmed.replace(/\/$/, '')}/?role=app`;
    this.emit({ status: 'connecting', transport: 'ws', url: trimmed, error: null, rttMs: null });
    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.emit({ status: 'connected', transport: 'ws', error: null });
        this.startPing();
      };

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          this.handleIncomingBuffer(ev.data);
        } else if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as { type?: string; pads?: number };
            if (msg.type === 'bridge' && typeof msg.pads === 'number') {
              this.emit({ padsOnline: msg.pads });
            }
          } catch {
            // ignore malformed bridge info
          }
        }
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        this.emit({ error: 'Could not reach Pad Bridge. Run `npm run pad-bridge` in tintbox.' });
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.stopPing();
        this.emit({ status: 'disconnected', transport: 'none', padsOnline: 0, rttMs: null });
      };
    } catch (err) {
      this.emit({
        status: 'disconnected',
        transport: 'none',
        error: err instanceof Error ? err.message : 'Invalid WebSocket URL.',
      });
    }
  }

  async connectBluetoothSerial(): Promise<boolean> {
    const nav = typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorWithSerial) : null;
    if (!nav?.serial) {
      this.emit({ error: 'Web Serial is only available in Chromium browsers (Chrome / Edge).' });
      return false;
    }
    this.disconnect();
    this.emit({ status: 'connecting', transport: 'bt-serial', error: null });
    try {
      let port: SerialPortLike;
      try {
        // Chromium 117+: explicitly allow Bluetooth RFCOMM SPP service so paired Android phones appear selectable
        port = await nav.serial.requestPort({
          allowedBluetoothServiceClassIds: [BT_SPP_SERVICE_UUID],
          filters: [{ bluetoothServiceClassId: BT_SPP_SERVICE_UUID }],
        });
      } catch (filterErr) {
        // If user explicitly cancelled (NotFoundError), don't re-prompt; otherwise fallback for older Chromium
        if (filterErr instanceof DOMException && filterErr.name === 'NotFoundError') {
          throw filterErr;
        }
        port = await nav.serial.requestPort();
      }
      await port.open({ baudRate: 115200 });
      this.serialPort = port;
      if (port.writable) {
        this.serialWriter = port.writable.getWriter();
      }
      this.emit({ status: 'connected', transport: 'bt-serial', padsOnline: 1, error: null });
      void this.readSerialLoop(port);
      return true;
    } catch (err) {
      this.emit({
        status: 'disconnected',
        transport: 'none',
        error:
          err instanceof Error
            ? err.message
            : 'Bluetooth serial canceled. Pair Android first & enable BT Wait mode in Tintbox Pad.',
      });
      return false;
    }
  }

  private async readSerialLoop(port: SerialPortLike): Promise<void> {
    if (!port.readable) return;
    const reader = port.readable.getReader();
    this.serialReader = reader;
    let carry: Uint8Array = new Uint8Array(0);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const merged = new Uint8Array(carry.length + value.length);
        merged.set(carry, 0);
        merged.set(value, carry.length);
        const { packets, remainder } = extractFramedBtPackets(merged);
        carry = remainder;
        for (const pkt of packets) this.dispatchPacket(pkt);
      }
    } catch {
      // Port closed
    } finally {
      reader.releaseLock();
      if (this.serialPort === port) this.disconnect();
    }
  }

  private writeSerialDownlink(kind: number, payload: Uint8Array): void {
    if (!this.serialWriter) return;
    // Framed downlink: [0xAA, 0x55, kind(u8), len(u32 LE), ...payload]
    const len = payload.length;
    const frame = new Uint8Array(7 + len);
    frame[0] = BT_FRAME_HEADER_0;
    frame[1] = BT_FRAME_HEADER_1;
    frame[2] = kind & 0xff;
    frame[3] = len & 0xff;
    frame[4] = (len >>> 8) & 0xff;
    frame[5] = (len >>> 16) & 0xff;
    frame[6] = (len >>> 24) & 0xff;
    frame.set(payload, 7);
    void this.serialWriter.write(frame).catch(() => {});
  }

  private handleIncomingBuffer(buf: ArrayBuffer): void {
    const total = buf.byteLength;
    for (let off = 0; off + PAD_PACKET_BYTES <= total; off += PAD_PACKET_BYTES) {
      const pkt = decodePadPacket(new Uint8Array(buf, off, PAD_PACKET_BYTES));
      if (pkt) this.dispatchPacket(pkt);
    }
  }

  private dispatchPacket(pkt: PadPacket): void {
    if (pkt.type === PadMsgType.Ping) {
      const pong = encodePadPacket({ type: PadMsgType.Pong, seq: pkt.seq });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(pong);
      }
      return;
    }
    if (pkt.type === PadMsgType.Pong) {
      if (pkt.seq === this.lastPingSeq && this.lastPingSentAt > 0) {
        const rtt = Math.max(0, Math.round(performance.now() - this.lastPingSentAt));
        this.emit({ rttMs: rtt });
      }
      return;
    }
    this.onPacket(pkt);
  }

  sendDocSync(info: PadDocSync): void {
    this.lastDocSync = info;
    const json = JSON.stringify({ type: 'doc', ...info });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
    } else if (this.serialWriter) {
      this.writeSerialDownlink(1, new TextEncoder().encode(json));
    }
  }

  /**
   * Stream live composited RGBA canvas to the Android pad (throttled ~45 fps with trailing flush).
   */
  sendCanvasFrame(rgba: Uint8ClampedArray, w: number, h: number): void {
    this.pendingFrame = { rgba: rgba.slice(), w, h };
    if (!this.isStreamingActive) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const minGap = this.state.transport === 'bt-serial' ? 65 : 22;
    const elapsed = now - this.lastFrameSentAt;
    if (elapsed >= minGap) {
      this.flushFrameNow(rgba, w, h);
    } else if (!this.pendingFrameTimer && typeof window !== 'undefined') {
      this.pendingFrameTimer = window.setTimeout(() => {
        this.pendingFrameTimer = 0;
        const f = this.pendingFrame;
        if (f && this.isStreamingActive) {
          this.flushFrameNow(f.rgba, f.w, f.h);
        }
      }, minGap - elapsed);
    }
  }

  private flushFrameNow(rgba: Uint8ClampedArray, w: number, h: number): void {
    this.lastFrameSentAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const encoded = encodeFrameSyncPacket(rgba, w, h, this.state.transport === 'bt-serial' ? 128 : 256);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Avoid saturating slow links if socket send buffer is backed up
      if (this.ws.bufferedAmount > 65536) return;
      this.ws.send(encoded);
    } else if (this.serialWriter) {
      this.writeSerialDownlink(2, encoded);
    }
  }

  private startPing(): void {
    this.stopPing();
    if (typeof window === 'undefined') return;
    this.pingTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state.padsOnline === 0) return;
      this.lastPingSeq = (this.lastPingSeq + 1) >>> 0;
      this.lastPingSentAt = performance.now();
      this.ws.send(encodePadPacket({ type: PadMsgType.Ping, seq: this.lastPingSeq }));
    }, 2000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = 0;
    }
    if (this.pendingFrameTimer) {
      window.clearTimeout(this.pendingFrameTimer);
      this.pendingFrameTimer = 0;
    }
  }

  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      const w = this.ws;
      this.ws = null;
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    if (this.serialWriter) {
      const wr = this.serialWriter;
      this.serialWriter = null;
      try {
        wr.releaseLock();
      } catch {
        // ignore
      }
    }
    if (this.serialReader) {
      const r = this.serialReader;
      this.serialReader = null;
      void r.cancel().catch(() => {});
    }
    if (this.serialPort) {
      const p = this.serialPort;
      this.serialPort = null;
      void p.close().catch(() => {});
    }
    if (this.state.status !== 'disconnected') {
      this.emit({ status: 'disconnected', transport: 'none', padsOnline: 0, rttMs: null, error: null });
    }
  }
}
