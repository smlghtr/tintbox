import { ValidationError } from '../core/errors';
import {
  buildPaletteStripRgba,
  extractUniqueColorsFromRgba,
  parseGpl,
  parseHexPalette,
  parseJascPal,
  serializeGpl,
  serializeHexPalette,
} from '../core/palette-format';
import type { Palette, RGBA } from '../core/types';
import { decodeImageBlob } from './image';

export async function importPaletteFile(file: File): Promise<{ name: string; colors: RGBA[] }> {
  const lower = file.name.toLowerCase();
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'Imported';

  if (lower.endsWith('.png')) {
    const img = await decodeImageBlob(file);
    return { name: baseName, colors: extractUniqueColorsFromRgba(img.pixels, img.w, img.h) };
  }

  const text = await file.text();
  if (lower.endsWith('.gpl')) return parseGpl(text);
  if (lower.endsWith('.hex')) return { name: baseName, colors: parseHexPalette(text) };
  if (lower.endsWith('.pal')) return { name: baseName, colors: parseJascPal(text) };

  throw new ValidationError('Unsupported palette format. Use .gpl, .hex, .pal, or .png.');
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportPaletteFile(palette: Palette, format: 'gpl' | 'hex' | 'png'): void {
  const colors = palette.colors.map((c) => c.rgba);
  const safeName = (palette.name || 'palette').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();

  if (format === 'gpl') {
    const text = serializeGpl(palette.name, colors);
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${safeName}.gpl`);
    return;
  }
  if (format === 'hex') {
    const text = serializeHexPalette(colors);
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${safeName}.hex`);
    return;
  }

  const strip = buildPaletteStripRgba(colors, 16);
  const c = document.createElement('canvas');
  c.width = strip.w;
  c.height = strip.h;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const copy = new Uint8ClampedArray(strip.data.length);
  copy.set(strip.data);
  ctx.putImageData(new ImageData(copy, strip.w, strip.h), 0, 0);
  c.toBlob((blob) => {
    if (blob) downloadBlob(blob, `${safeName}.png`);
  }, 'image/png');
}
