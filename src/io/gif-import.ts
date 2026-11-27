import { createDoc, createFrame, createPalette, MAX_DIM } from '../core/doc';
import { ValidationError } from '../core/errors';
import type { Doc, RGBA } from '../core/types';

export function isGifBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 14) return false;
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  return sig === 'GIF87a' || sig === 'GIF89a';
}

function lzwDecode(minCodeSize: number, data: Uint8Array, expectedPixels: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const maxTable = 4096;

  const prefix = new Int32Array(maxTable);
  const suffix = new Uint8Array(maxTable);
  const stack = new Uint8Array(maxTable);
  const out = new Uint8Array(expectedPixels);
  let outPos = 0;

  let bitBuf = 0;
  let bitCount = 0;
  let bytePos = 0;

  const readCode = (): number => {
    while (bitCount < codeSize && bytePos < data.length) {
      bitBuf |= data[bytePos++] << bitCount;
      bitCount += 8;
    }
    if (bitCount < codeSize) return eoiCode;
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  let prevCode = -1;
  let firstChar = 0;

  while (outPos < expectedPixels) {
    const code = readCode();
    if (code === eoiCode) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
      prevCode = -1;
      continue;
    }

    let inCode = code;
    let stackPos = 0;
    if (code >= nextCode) {
      if (prevCode < 0) break;
      stack[stackPos++] = firstChar;
      inCode = prevCode;
    }
    while (inCode >= clearCode && stackPos < maxTable) {
      stack[stackPos++] = suffix[inCode];
      inCode = prefix[inCode];
    }
    firstChar = inCode & 0xff;
    stack[stackPos++] = firstChar;

    while (stackPos > 0 && outPos < expectedPixels) {
      out[outPos++] = stack[--stackPos];
    }

    if (prevCode >= 0 && nextCode < maxTable) {
      prefix[nextCode] = prevCode;
      suffix[nextCode] = firstChar;
      nextCode++;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prevCode = code;
  }

  return out;
}

function readSubBlocks(bytes: Uint8Array, start: number): { data: Uint8Array; next: number } {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let pos = start;
  while (pos < bytes.length) {
    const len = bytes[pos++];
    if (len === 0) break;
    const end = Math.min(bytes.length, pos + len);
    chunks.push(bytes.subarray(pos, end));
    total += end - pos;
    pos = end;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { data: out, next: pos };
}

function deinterlaceRow(i: number, h: number): number {
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 },
  ];
  let rem = i;
  for (const p of passes) {
    const count = p.start < h ? Math.floor((h - 1 - p.start) / p.step) + 1 : 0;
    if (rem < count) return p.start + rem * p.step;
    rem -= count;
  }
  return i;
}

/**
 * Decode a static or animated GIF (GIF87a / GIF89a) into a multi-frame Tintbox Doc,
 * preserving frame timing, transparency, disposal methods, and color table palette.
 */
export function decodeAnimatedGif(bytes: Uint8Array): Doc {
  if (!isGifBytes(bytes)) {
    throw new ValidationError('Invalid GIF file (missing GIF87a/GIF89a header).');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) {
    throw new ValidationError(`GIF dimensions ${width}x${height} exceed ${MAX_DIM}px limit.`);
  }

  const packed = bytes[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = hasGct ? 1 << ((packed & 0x07) + 1) : 0;

  let pos = 13;
  let gct: RGBA[] = [];
  if (hasGct && pos + gctSize * 3 <= bytes.length) {
    gct = [];
    for (let i = 0; i < gctSize; i++) {
      gct.push([bytes[pos++], bytes[pos++], bytes[pos++], 255]);
    }
  }

  const canvas = new Uint8ClampedArray(width * height * 4);
  const cels: Uint8ClampedArray[] = [];
  const durations: number[] = [];

  let disposal = 0;
  let hasTrans = false;
  let transIdx = 0;
  let delayMs = 100;

  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) break; // Trailer
    if (block === 0x21) {
      // Extension
      if (pos >= bytes.length) break;
      const label = bytes[pos++];
      if (label === 0xf9 && pos + 6 <= bytes.length) {
        const blockSize = bytes[pos++];
        if (blockSize === 4) {
          const gcePacked = bytes[pos++];
          disposal = (gcePacked >> 2) & 0x07;
          hasTrans = (gcePacked & 0x01) !== 0;
          const delayCs = view.getUint16(pos, true);
          pos += 2;
          transIdx = bytes[pos++];
          delayMs = delayCs > 0 ? delayCs * 10 : 100;
          if (bytes[pos] === 0) pos++;
        } else {
          pos += blockSize;
          pos = readSubBlocks(bytes, pos).next;
        }
      } else {
        pos = readSubBlocks(bytes, pos).next;
      }
      continue;
    }

    if (block === 0x2c) {
      if (pos + 9 > bytes.length) break;
      const left = view.getUint16(pos, true);
      const top = view.getUint16(pos + 2, true);
      const iw = view.getUint16(pos + 4, true);
      const ih = view.getUint16(pos + 6, true);
      const imgPacked = bytes[pos + 8];
      pos += 9;

      const hasLct = (imgPacked & 0x80) !== 0;
      const interlaced = (imgPacked & 0x40) !== 0;
      const lctSize = hasLct ? 1 << ((imgPacked & 0x07) + 1) : 0;
      let table = gct;
      if (hasLct && pos + lctSize * 3 <= bytes.length) {
        table = [];
        for (let i = 0; i < lctSize; i++) {
          table.push([bytes[pos++], bytes[pos++], bytes[pos++], 255]);
        }
      }

      if (pos >= bytes.length) break;
      const minCodeSize = bytes[pos++];
      const { data: lzwBytes, next } = readSubBlocks(bytes, pos);
      pos = next;

      const prevCanvas = disposal === 3 ? canvas.slice() : null;
      const indices = lzwDecode(minCodeSize, lzwBytes, iw * ih);

      for (let row = 0; row < ih; row++) {
        const dy = top + (interlaced ? deinterlaceRow(row, ih) : row);
        if (dy < 0 || dy >= height) continue;
        for (let col = 0; col < iw; col++) {
          const dx = left + col;
          if (dx < 0 || dx >= width) continue;
          const idx = indices[row * iw + col];
          if (hasTrans && idx === transIdx) continue;
          const rgba = table[idx];
          if (!rgba) continue;
          const di = (dy * width + dx) * 4;
          canvas[di] = rgba[0];
          canvas[di + 1] = rgba[1];
          canvas[di + 2] = rgba[2];
          canvas[di + 3] = 255;
        }
      }

      cels.push(canvas.slice());
      durations.push(Math.max(10, delayMs));

      // Apply disposal for next frame
      if (disposal === 2) {
        for (let row = 0; row < ih; row++) {
          const dy = top + row;
          if (dy < 0 || dy >= height) continue;
          for (let col = 0; col < iw; col++) {
            const dx = left + col;
            if (dx < 0 || dx >= width) continue;
            const di = (dy * width + dx) * 4;
            canvas[di] = 0;
            canvas[di + 1] = 0;
            canvas[di + 2] = 0;
            canvas[di + 3] = 0;
          }
        }
      } else if (disposal === 3 && prevCanvas) {
        canvas.set(prevCanvas);
      }

      // Reset GCE defaults for next frame
      disposal = 0;
      hasTrans = false;
      transIdx = 0;
      delayMs = 100;
      continue;
    }

    // Unknown byte: advance safely
    break;
  }

  if (cels.length === 0) {
    throw new ValidationError('GIF contained no decodable image frames.');
  }

  const doc = createDoc(width, height);
  doc.frames = durations.map((d) => createFrame(d));
  doc.fps = Math.max(1, Math.min(60, Math.round(1000 / (durations[0] || 100))));
  doc.layers[0].name = 'GIF Layer';
  doc.layers[0].cels = cels;

  if (gct.length > 0) {
    const uniq: RGBA[] = [];
    const seen = new Set<string>();
    for (const c of gct) {
      const k = `${c[0]},${c[1]},${c[2]}`;
      if (!seen.has(k) && uniq.length < 64) {
        seen.add(k);
        uniq.push([...c] as RGBA);
      }
    }
    if (uniq.length > 0) {
      const p = createPalette('GIF Palette', uniq);
      doc.palettes = [p];
      doc.activePaletteId = p.id;
    }
  }

  return doc;
}
