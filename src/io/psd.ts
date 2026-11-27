import { blankCel, compose, createDoc, getLayerCel, MAX_DIM, uid } from '../core/doc';
import { ValidationError } from '../core/errors';
import type { BlendMode, Doc, Layer } from '../core/types';
import { MAX_IMPORT_BYTES } from './image';

const BLEND_TO_PSD: Record<BlendMode, string> = {
  normal: 'norm',
  multiply: 'mul ',
  screen: 'scrn',
  overlay: 'over',
  add: 'lddg',
  darken: 'dark',
  lighten: 'lite',
  difference: 'diff',
};

const PSD_TO_BLEND: Record<string, BlendMode> = {
  norm: 'normal',
  'mul ': 'multiply',
  scrn: 'screen',
  over: 'overlay',
  lddg: 'add',
  'add ': 'add',
  dark: 'darken',
  lite: 'lighten',
  diff: 'difference',
};

export function isPsdBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 26 &&
    bytes[0] === 0x38 && // '8'
    bytes[1] === 0x42 && // 'B'
    bytes[2] === 0x50 && // 'P'
    bytes[3] === 0x53 // 'S'
  );
}

/** PackBits RLE encoder for a single scanline. */
export function encodePackBitsRow(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = row.length;
  let i = 0;
  while (i < n) {
    // Check for run of >= 3 identical bytes
    let runEnd = i + 1;
    while (runEnd < n && runEnd - i < 128 && row[runEnd] === row[i]) {
      runEnd++;
    }
    const runLen = runEnd - i;
    if (runLen >= 3) {
      out.push((257 - runLen) & 0xff, row[i]);
      i = runEnd;
      continue;
    }
    // Literal run until next run of >= 3 or max 128
    const litStart = i;
    i++;
    while (i < n && i - litStart < 128) {
      if (i + 2 < n && row[i] === row[i + 1] && row[i] === row[i + 2]) break;
      i++;
    }
    const litLen = i - litStart;
    out.push(litLen - 1);
    for (let k = litStart; k < i; k++) out.push(row[k]);
  }
  return new Uint8Array(out);
}

/** PackBits RLE decoder for a single scanline. */
export function decodePackBitsRow(
  src: Uint8Array,
  offset: number,
  byteCount: number,
  expectedLen: number,
): Uint8Array {
  const out = new Uint8Array(expectedLen);
  let sp = offset;
  const end = Math.min(src.length, offset + byteCount);
  let dp = 0;

  while (sp < end && dp < expectedLen) {
    const header = src[sp++];
    if (header <= 127) {
      const count = header + 1;
      for (let k = 0; k < count && sp < end && dp < expectedLen; k++) {
        out[dp++] = src[sp++];
      }
    } else if (header >= 129) {
      const count = 257 - header;
      if (sp >= end) break;
      const val = src[sp++];
      for (let k = 0; k < count && dp < expectedLen; k++) {
        out[dp++] = val;
      }
    }
    // header === 128 is a no-op per PackBits spec
  }
  return out;
}

class BinWriter {
  private chunks: Uint8Array[] = [];
  private len = 0;

  get byteLength(): number {
    return this.len;
  }

  writeBytes(b: Uint8Array): void {
    this.chunks.push(b);
    this.len += b.byteLength;
  }

  writeAscii(s: string): void {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f;
    this.writeBytes(b);
  }

  writeU8(v: number): void {
    this.writeBytes(new Uint8Array([v & 0xff]));
  }

  writeU16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, false);
    this.writeBytes(b);
  }

  writeI16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, v, false);
    this.writeBytes(b);
  }

  writeU32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, false);
    this.writeBytes(b);
  }

  writeI32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v | 0, false);
    this.writeBytes(b);
  }

  writeZeros(n: number): void {
    if (n > 0) this.writeBytes(new Uint8Array(n));
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }
}

function encodeChannelRle(rgba: Uint8ClampedArray, w: number, h: number, chanOffset: number): Uint8Array {
  const rowBuf = new Uint8Array(w);
  const encodedRows: Uint8Array[] = [];
  let payloadLen = 0;
  for (let y = 0; y < h; y++) {
    let si = y * w * 4 + chanOffset;
    for (let x = 0; x < w; x++) {
      rowBuf[x] = rgba[si];
      si += 4;
    }
    const enc = encodePackBitsRow(rowBuf);
    encodedRows.push(enc);
    payloadLen += enc.byteLength;
  }
  const wtr = new BinWriter();
  wtr.writeU16(1); // PackBits RLE
  for (const r of encodedRows) wtr.writeU16(r.byteLength);
  for (const r of encodedRows) wtr.writeBytes(r);
  void payloadLen;
  return wtr.toUint8Array();
}

function encodePascalNamePadded4(name: string): Uint8Array {
  const clean = name.slice(0, 255);
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    bytes.push(code >= 32 && code <= 126 ? code : 0x3f);
  }
  const rawLen = 1 + bytes.length;
  const pad = (4 - (rawLen % 4)) % 4;
  const out = new Uint8Array(rawLen + pad);
  out[0] = bytes.length;
  for (let i = 0; i < bytes.length; i++) out[1 + i] = bytes[i];
  return out;
}

/**
 * Encode a Tintbox Doc frame into a standard Adobe Photoshop `.psd` (v1, 8-bit RGBA).
 * Preserves pixel layers, names, opacity, visibility, clipping, blend modes, and merged composite preview.
 */
export function encodePsd(doc: Doc, frame = 0): Uint8Array {
  const { w, h } = doc;
  const pixelLayers = doc.layers.filter((l) => l.kind === 'pixel');
  const merged = compose(doc, frame, { includeHidden: false });

  const out = new BinWriter();

  // 1. File Header Section (26 bytes)
  out.writeAscii('8BPS');
  out.writeU16(1); // Version 1 (PSD)
  out.writeZeros(6); // Reserved
  out.writeU16(4); // Channels: RGBA
  out.writeU32(h);
  out.writeU32(w);
  out.writeU16(8); // 8 bits per channel
  out.writeU16(3); // Color mode: RGB

  // 2. Color Mode Data Section (empty)
  out.writeU32(0);

  // 3. Image Resources Section (empty)
  out.writeU32(0);

  // 4. Layer and Mask Information Section
  const layerInfo = new BinWriter();
  const count = pixelLayers.length;
  layerInfo.writeI16(-count); // Negative count => merged alpha channel holds transparency

  const allLayerChannelBlobs: Uint8Array[][] = [];
  const channelOrder: { id: number; offset: number }[] = [
    { id: -1, offset: 3 }, // Alpha
    { id: 0, offset: 0 }, // R
    { id: 1, offset: 1 }, // G
    { id: 2, offset: 2 }, // B
  ];

  // Build layer records (bottom-to-top matches doc.layers order)
  for (const layer of pixelLayers) {
    const cel = getLayerCel(layer, frame) ?? blankCel(w, h);
    const blobs = channelOrder.map((ch) => encodeChannelRle(cel, w, h, ch.offset));
    allLayerChannelBlobs.push(blobs);

    layerInfo.writeI32(0); // top
    layerInfo.writeI32(0); // left
    layerInfo.writeI32(h); // bottom
    layerInfo.writeI32(w); // right
    layerInfo.writeU16(4); // 4 channels (A, R, G, B)
    for (let ci = 0; ci < 4; ci++) {
      layerInfo.writeI16(channelOrder[ci].id);
      layerInfo.writeU32(blobs[ci].byteLength);
    }

    layerInfo.writeAscii('8BIM');
    layerInfo.writeAscii(BLEND_TO_PSD[layer.blend] ?? 'norm');
    layerInfo.writeU8(Math.max(0, Math.min(255, Math.round(layer.opacity * 255))));
    layerInfo.writeU8(layer.clipped ? 1 : 0);
    layerInfo.writeU8(layer.visible ? 0 : 0x02); // bit 1 = hidden
    layerInfo.writeU8(0); // filler

    const nameBytes = encodePascalNamePadded4(layer.name);
    const extraLen = 4 + 4 + nameBytes.byteLength;
    layerInfo.writeU32(extraLen);
    layerInfo.writeU32(0); // Layer mask data len
    layerInfo.writeU32(0); // Layer blending ranges len
    layerInfo.writeBytes(nameBytes);
  }

  // Channel image data for each layer
  for (const blobs of allLayerChannelBlobs) {
    for (const blob of blobs) {
      layerInfo.writeBytes(blob);
    }
  }

  // Pad Layer Info to even byte length
  if (layerInfo.byteLength % 2 !== 0) layerInfo.writeU8(0);
  const layerInfoBytes = layerInfo.toUint8Array();

  const layerMaskSectionLen = 4 + layerInfoBytes.byteLength + 4; // layerInfoLen + layerInfo + globalMaskLen(0)
  out.writeU32(layerMaskSectionLen);
  out.writeU32(layerInfoBytes.byteLength);
  out.writeBytes(layerInfoBytes);
  out.writeU32(0); // Global layer mask info len = 0

  // 5. Image Data Section (merged composite RGBA, PackBits RLE planar R, G, B, A)
  const mergedRows: Uint8Array[] = [];
  const rowTmp = new Uint8Array(w);
  for (const chanOffset of [0, 1, 2, 3]) {
    for (let y = 0; y < h; y++) {
      let si = y * w * 4 + chanOffset;
      for (let x = 0; x < w; x++) {
        rowTmp[x] = merged[si];
        si += 4;
      }
      mergedRows.push(encodePackBitsRow(rowTmp));
    }
  }
  out.writeU16(1); // Compression = PackBits RLE
  for (const r of mergedRows) out.writeU16(r.byteLength);
  for (const r of mergedRows) out.writeBytes(r);

  return out.toUint8Array();
}

class BinReader {
  readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  ensure(n: number): void {
    if (n < 0 || this.pos + n > this.bytes.byteLength) {
      throw new ValidationError('Truncated or corrupt PSD file.');
    }
  }

  skip(n: number): void {
    this.ensure(n);
    this.pos += n;
  }

  readU8(): number {
    this.ensure(1);
    return this.bytes[this.pos++];
  }

  readU16(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return v;
  }

  readI16(): number {
    this.ensure(2);
    const v = this.view.getInt16(this.pos, false);
    this.pos += 2;
    return v;
  }

  readU32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  readI32(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return v;
  }

  readAscii(n: number): string {
    this.ensure(n);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.pos + i]);
    this.pos += n;
    return s;
  }
}

interface ParsedLayerRecord {
  top: number;
  left: number;
  bottom: number;
  right: number;
  channels: { id: number; length: number }[];
  blend: BlendMode;
  opacity: number;
  clipped: boolean;
  visible: boolean;
  name: string;
}

function decodeChannelPlane(
  reader: BinReader,
  w: number,
  h: number,
  byteLen: number,
): Uint8Array {
  const start = reader.pos;
  const end = start + byteLen;
  reader.ensure(byteLen);
  const out = new Uint8Array(w * h);
  if (w <= 0 || h <= 0 || byteLen < 2) {
    reader.pos = end;
    return out;
  }
  const compression = reader.readU16();
  if (compression === 0) {
    const count = Math.min(w * h, end - reader.pos);
    out.set(reader.bytes.subarray(reader.pos, reader.pos + count), 0);
  } else if (compression === 1) {
    const rowLens: number[] = [];
    for (let y = 0; y < h; y++) rowLens.push(reader.readU16());
    for (let y = 0; y < h; y++) {
      const rlen = rowLens[y];
      const row = decodePackBitsRow(reader.bytes, reader.pos, rlen, w);
      out.set(row, y * w);
      reader.pos = Math.min(end, reader.pos + rlen);
    }
  } else {
    throw new ValidationError(`Unsupported PSD channel compression (${compression}).`);
  }
  reader.pos = end;
  return out;
}

function decodeMergedImageData(
  reader: BinReader,
  w: number,
  h: number,
  channels: number,
  colorMode: number,
): Uint8ClampedArray {
  const out = blankCel(w, h);
  if (reader.pos + 2 > reader.bytes.byteLength) return out;

  const compression = reader.readU16();
  const planes: Uint8Array[] = [];
  const planeCount = Math.min(channels, 4);

  if (compression === 0) {
    for (let c = 0; c < planeCount; c++) {
      const plane = new Uint8Array(w * h);
      const avail = Math.min(w * h, reader.bytes.byteLength - reader.pos);
      plane.set(reader.bytes.subarray(reader.pos, reader.pos + avail), 0);
      reader.pos += avail;
      planes.push(plane);
    }
  } else if (compression === 1) {
    const totalRows = channels * h;
    const rowLens: number[] = [];
    for (let i = 0; i < totalRows; i++) rowLens.push(reader.readU16());
    for (let c = 0; c < channels; c++) {
      const plane = c < planeCount ? new Uint8Array(w * h) : null;
      for (let y = 0; y < h; y++) {
        const rlen = rowLens[c * h + y];
        if (plane) {
          const row = decodePackBitsRow(reader.bytes, reader.pos, rlen, w);
          plane.set(row, y * w);
        }
        reader.pos = Math.min(reader.bytes.byteLength, reader.pos + rlen);
      }
      if (plane) planes.push(plane);
    }
  } else {
    throw new ValidationError(`Unsupported PSD image compression (${compression}).`);
  }

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (colorMode === 1) {
      const v = planes[0]?.[i] ?? 0;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = planes[1] ? planes[1][i] : 255;
    } else {
      out[o] = planes[0]?.[i] ?? 0;
      out[o + 1] = planes[1]?.[i] ?? 0;
      out[o + 2] = planes[2]?.[i] ?? 0;
      out[o + 3] = planes[3] ? planes[3][i] : 255;
    }
  }
  return out;
}

/** Decode an 8-bit RGB or Grayscale Adobe Photoshop `.psd` file into a layered Tintbox Doc. */
export function decodePsd(bytes: Uint8Array): Doc {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ValidationError('PSD file exceeds 50 MB limit.');
  }
  if (!isPsdBytes(bytes)) {
    throw new ValidationError('Invalid PSD file signature (expected 8BPS).');
  }

  const reader = new BinReader(bytes);
  reader.skip(4); // '8BPS'
  const version = reader.readU16();
  if (version !== 1) {
    throw new ValidationError(`Unsupported PSD version ${version} (PSB large docs are not supported).`);
  }
  reader.skip(6); // reserved
  const channels = reader.readU16();
  const h = reader.readU32();
  const w = reader.readU32();
  const depth = reader.readU16();
  const colorMode = reader.readU16();

  if (w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) {
    throw new ValidationError(`PSD dimensions ${w}x${h} out of Tintbox range (1..${MAX_DIM}).`);
  }
  if (depth !== 8) {
    throw new ValidationError(`Unsupported PSD bit depth (${depth}-bit). Only 8-bit PSD files are supported.`);
  }
  if (colorMode !== 3 && colorMode !== 1) {
    throw new ValidationError('Only RGB and Grayscale PSD color modes are supported.');
  }
  if (channels < 1 || channels > 56) {
    throw new ValidationError('Invalid PSD channel count.');
  }

  // 2. Skip Color Mode Data
  const colorModeLen = reader.readU32();
  reader.skip(colorModeLen);

  // 3. Skip Image Resources
  const imgResLen = reader.readU32();
  reader.skip(imgResLen);

  // 4. Layer and Mask Info
  const layerMaskLen = reader.readU32();
  const layerMaskEnd = reader.pos + layerMaskLen;
  reader.ensure(layerMaskLen);

  const parsedLayers: Layer[] = [];

  if (layerMaskLen >= 6) {
    const layerInfoLen = reader.readU32();
    const layerInfoEnd = reader.pos + layerInfoLen;
    if (layerInfoLen >= 2 && layerInfoEnd <= layerMaskEnd) {
      const rawCount = reader.readI16();
      const layerCount = Math.abs(rawCount);
      if (layerCount > 256) {
        throw new ValidationError('PSD has too many layers (> 256).');
      }

      const records: ParsedLayerRecord[] = [];
      for (let i = 0; i < layerCount; i++) {
        const top = reader.readI32();
        const left = reader.readI32();
        const bottom = reader.readI32();
        const right = reader.readI32();
        const chCount = reader.readU16();
        const chList: { id: number; length: number }[] = [];
        for (let c = 0; c < chCount; c++) {
          const id = reader.readI16();
          const length = reader.readU32();
          chList.push({ id, length });
        }
        const sig = reader.readAscii(4);
        if (sig !== '8BIM') throw new ValidationError('Corrupt PSD layer blend signature.');
        const blendKey = reader.readAscii(4);
        const opacity = reader.readU8() / 255;
        const clipping = reader.readU8() !== 0;
        const flags = reader.readU8();
        reader.skip(1); // filler
        const extraLen = reader.readU32();
        const extraEnd = reader.pos + extraLen;
        reader.ensure(extraLen);

        // Layer mask data
        const maskLen = reader.readU32();
        reader.skip(maskLen);
        // Layer blending ranges
        const rangesLen = reader.readU32();
        reader.skip(rangesLen);
        // Layer Pascal name (padded to 4-byte multiple)
        const nameLen = reader.readU8();
        const name = reader.readAscii(nameLen).trim() || `Layer ${i + 1}`;
        reader.pos = extraEnd;

        records.push({
          top,
          left,
          bottom,
          right,
          channels: chList,
          blend: PSD_TO_BLEND[blendKey] ?? 'normal',
          opacity,
          clipped: clipping,
          visible: (flags & 0x02) === 0,
          name,
        });
      }

      for (const rec of records) {
        const lw = Math.max(0, rec.right - rec.left);
        const lh = Math.max(0, rec.bottom - rec.top);
        const planeMap = new Map<number, Uint8Array>();

        for (const ch of rec.channels) {
          const plane = decodeChannelPlane(reader, lw, lh, ch.length);
          planeMap.set(ch.id, plane);
        }

        const cel = blankCel(w, h);
        if (lw > 0 && lh > 0) {
          const rPlane = planeMap.get(0);
          const gPlane = colorMode === 1 ? rPlane : planeMap.get(1);
          const bPlane = colorMode === 1 ? rPlane : planeMap.get(2);
          const aPlane = planeMap.get(-1);

          const x0 = Math.max(0, rec.left);
          const y0 = Math.max(0, rec.top);
          const x1 = Math.min(w, rec.right);
          const y1 = Math.min(h, rec.bottom);

          for (let y = y0; y < y1; y++) {
            const ly = y - rec.top;
            for (let x = x0; x < x1; x++) {
              const lx = x - rec.left;
              const li = ly * lw + lx;
              const di = (y * w + x) * 4;
              cel[di] = rPlane ? rPlane[li] : 0;
              cel[di + 1] = gPlane ? gPlane[li] : 0;
              cel[di + 2] = bPlane ? bPlane[li] : 0;
              cel[di + 3] = aPlane ? aPlane[li] : 255;
            }
          }
        }

        parsedLayers.push({
          id: uid(),
          name: rec.name,
          kind: 'pixel',
          visible: rec.visible,
          locked: false,
          alphaLock: false,
          clipped: rec.clipped,
          opacity: rec.opacity,
          blend: rec.blend,
          cels: [cel],
          modifiers: [],
        });
      }
    }
  }
  reader.pos = layerMaskEnd;

  const doc = createDoc(w, h);
  if (parsedLayers.length > 0) {
    doc.layers = parsedLayers;
  } else {
    const merged = decodeMergedImageData(reader, w, h, channels, colorMode);
    doc.layers[0].name = 'Background';
    doc.layers[0].cels[0].set(merged);
  }

  return doc;
}
