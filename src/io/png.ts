import { unzlibSync, zlibSync } from 'fflate';
import { ValidationError } from '../core/errors';

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// Precompute IEEE 802.3 CRC32 table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeU32BE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function readU32BE(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeU32BE(chunk, 0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  writeU32BE(chunk, 8 + data.length, crc32(chunk, 4, 8 + data.length));
  return chunk;
}

/** Lossless 8-bit straight-alpha RGBA PNG encoder (bit-exact across browsers and Node). */
export function encodePngRgba(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const rowBytes = w * 4;
  const raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter None
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  const compressed = zlibSync(raw, { level: 6 });

  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, w);
  writeU32BE(ihdr, 4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const c1 = makeChunk('IHDR', ihdr);
  const c2 = makeChunk('IDAT', compressed);
  const c3 = makeChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(PNG_SIG.length + c1.length + c2.length + c3.length);
  let pos = 0;
  out.set(PNG_SIG, pos); pos += PNG_SIG.length;
  out.set(c1, pos); pos += c1.length;
  out.set(c2, pos); pos += c2.length;
  out.set(c3, pos);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Lossless 8-bit RGBA/RGB PNG decoder (supports all 5 PNG scanline filters). */
export function decodePngRgba(bytes: Uint8Array): { w: number; h: number; data: Uint8ClampedArray } {
  if (bytes.length < 33) throw new ValidationError('Invalid PNG: file too small.');
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new ValidationError('Invalid PNG signature.');
  }

  let pos = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts: Uint8Array[] = [];

  while (pos + 12 <= bytes.length) {
    const len = readU32BE(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) throw new ValidationError('Truncated PNG chunk.');

    if (type === 'IHDR') {
      w = readU32BE(bytes, dataStart);
      h = readU32BE(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      if (w < 1 || h < 1 || w > 4096 || h > 4096) throw new ValidationError(`PNG dimensions ${w}x${h} out of bounds.`);
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new ValidationError(`Unsupported PNG format (depth=${bitDepth}, colorType=${colorType}).`);
      }
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }

  if (w === 0 || h === 0 || idatParts.length === 0) throw new ValidationError('Incomplete PNG image.');

  const totalIdat = idatParts.reduce((s, p) => s + p.length, 0);
  const packed = new Uint8Array(totalIdat);
  let off = 0;
  for (const part of idatParts) {
    packed.set(part, off);
    off += part.length;
  }

  const raw = unzlibSync(packed);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) throw new ValidationError('Corrupt PNG scanline data.');

  const recon = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const srcOff = y * (stride + 1) + 1;
    const dstOff = y * stride;
    for (let x = 0; x < stride; x++) {
      const xByte = raw[srcOff + x];
      const a = x >= bpp ? recon[dstOff + x - bpp] : 0;
      const b = y > 0 ? recon[dstOff - stride + x] : 0;
      const c = x >= bpp && y > 0 ? recon[dstOff - stride + x - bpp] : 0;
      let val = xByte;
      if (filter === 1) val = (xByte + a) & 0xff;
      else if (filter === 2) val = (xByte + b) & 0xff;
      else if (filter === 3) val = (xByte + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (xByte + paeth(a, b, c)) & 0xff;
      recon[dstOff + x] = val;
    }
  }

  if (colorType === 6) {
    return { w, h, data: new Uint8ClampedArray(recon.buffer, recon.byteOffset, w * h * 4) };
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[p * 4] = recon[p * 3];
    rgba[p * 4 + 1] = recon[p * 3 + 1];
    rgba[p * 4 + 2] = recon[p * 3 + 2];
    rgba[p * 4 + 3] = 255;
  }
  return { w, h, data: rgba };
}

export function bytesToDataUrl(pngBytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < pngBytes.length; i += chunk) {
    bin += String.fromCharCode(...pngBytes.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(bin)}`;
}
