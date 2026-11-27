import { ValidationError } from '../core/errors';
import { MAX_IMPORT_BYTES } from './image';

const MAX_BMP_DIM = 4096;

export function isBmpBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 54 && bytes[0] === 0x42 && bytes[1] === 0x4d;
}

/** Encode straight RGBA pixels into an uncompressed 32-bit BGRA bottom-up BMP file. */
export function encodeBmp(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_BMP_DIM || h > MAX_BMP_DIM) {
    throw new ValidationError(`Invalid BMP dimensions: ${w}x${h}.`);
  }
  if (rgba.length < w * h * 4) {
    throw new ValidationError('RGBA buffer too small for BMP dimensions.');
  }

  const headerSize = 14 + 40;
  const pixelBytes = w * h * 4;
  const fileSize = headerSize + pixelBytes;
  const out = new Uint8Array(fileSize);
  const view = new DataView(out.buffer);

  // BITMAPFILEHEADER (14 bytes)
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(6, 0, true);
  view.setUint32(10, headerSize, true);

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, 40, true); // biSize
  view.setInt32(18, w, true); // biWidth
  view.setInt32(22, h, true); // biHeight (>0 = bottom-up)
  view.setUint16(26, 1, true); // biPlanes
  view.setUint16(28, 32, true); // biBitCount (32-bit BGRA)
  view.setUint32(30, 0, true); // biCompression = BI_RGB
  view.setUint32(34, pixelBytes, true); // biSizeImage
  view.setInt32(38, 2835, true); // ~72 DPI
  view.setInt32(42, 2835, true);
  view.setUint32(46, 0, true);
  view.setUint32(50, 0, true);

  // Pixel data: bottom-up rows, BGRA byte order
  let dst = headerSize;
  for (let y = h - 1; y >= 0; y--) {
    let src = y * w * 4;
    for (let x = 0; x < w; x++) {
      out[dst++] = rgba[src + 2]; // B
      out[dst++] = rgba[src + 1]; // G
      out[dst++] = rgba[src]; // R
      out[dst++] = rgba[src + 3]; // A
      src += 4;
    }
  }

  return out;
}

/** Decode an uncompressed 24-bit BGR or 32-bit BGRA BMP file to straight RGBA. */
export function decodeBmp(bytes: Uint8Array): { data: Uint8ClampedArray; w: number; h: number } {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ValidationError('BMP file exceeds 50 MB limit.');
  }
  if (!isBmpBytes(bytes)) {
    throw new ValidationError('Invalid BMP file signature.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const dibSize = view.getUint32(14, true);
  if (dibSize < 40 || pixelOffset < 14 + dibSize || pixelOffset > bytes.byteLength) {
    throw new ValidationError('Unsupported or corrupt BMP header.');
  }

  const w = view.getInt32(18, true);
  const rawH = view.getInt32(22, true);
  const topDown = rawH < 0;
  const h = Math.abs(rawH);
  const planes = view.getUint16(26, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);

  if (w < 1 || h < 1 || w > MAX_BMP_DIM || h > MAX_BMP_DIM) {
    throw new ValidationError(`BMP dimensions out of bounds: ${w}x${h}.`);
  }
  if (planes !== 1) {
    throw new ValidationError('Unsupported BMP plane count.');
  }
  if (bpp !== 24 && bpp !== 32) {
    throw new ValidationError(`Unsupported BMP bit depth (${bpp}-bit). Only 24-bit and 32-bit BMP are supported.`);
  }
  if (compression !== 0 && !(compression === 3 && bpp === 32)) {
    throw new ValidationError('Compressed BMP files are not supported.');
  }

  const bytesPerPixel = bpp / 8;
  const rowStride = Math.ceil((w * bytesPerPixel) / 4) * 4;
  if (pixelOffset + rowStride * h > bytes.byteLength) {
    throw new ValidationError('Truncated BMP pixel data.');
  }

  const data = new Uint8ClampedArray(w * h * 4);
  let hasAlpha = false;

  for (let row = 0; row < h; row++) {
    const dstY = topDown ? row : h - 1 - row;
    const srcRow = pixelOffset + row * rowStride;
    let dst = dstY * w * 4;
    for (let x = 0; x < w; x++) {
      const si = srcRow + x * bytesPerPixel;
      const b = bytes[si];
      const g = bytes[si + 1];
      const r = bytes[si + 2];
      const a = bpp === 32 ? bytes[si + 3] : 255;
      if (bpp === 32 && a > 0) hasAlpha = true;
      data[dst++] = r;
      data[dst++] = g;
      data[dst++] = b;
      data[dst++] = a;
    }
  }

  // Some legacy 32-bit BMP writers leave alpha channel all-zero; treat as opaque if non-black pixels exist
  if (bpp === 32 && !hasAlpha) {
    let anyColor = false;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) {
        anyColor = true;
        break;
      }
    }
    if (anyColor) {
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
    }
  }

  return { data, w, h };
}
