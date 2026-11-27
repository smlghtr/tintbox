import { ValidationError } from './errors';
import { hexToRgba, rgbaToHex } from './palette';
import type { RGBA } from './types';

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function parseGpl(text: string): { name: string; colors: RGBA[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let name = 'Imported GPL';
  const colors: RGBA[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line === 'GIMP Palette' || line.startsWith('Columns:')) continue;
    if (line.startsWith('Name:')) {
      const n = line.slice(5).trim();
      if (n) name = n;
      continue;
    }
    const m = /^(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (m) {
      colors.push([clampByte(Number(m[1])), clampByte(Number(m[2])), clampByte(Number(m[3])), 255]);
    }
  }
  if (colors.length === 0) throw new ValidationError('No valid colors found in .gpl palette.');
  return { name, colors };
}

export function serializeGpl(name: string, colors: RGBA[]): string {
  const header = ['GIMP Palette', `Name: ${name || 'Tintbox'}`, 'Columns: 8', '#'];
  const rows = colors.map((c) => {
    const r = String(c[0]).padStart(3, ' ');
    const g = String(c[1]).padStart(3, ' ');
    const b = String(c[2]).padStart(3, ' ');
    return `${r} ${g} ${b}\t${rgbaToHex(c)}`;
  });
  return [...header, ...rows, ''].join('\n');
}

export function parseHexPalette(text: string): RGBA[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const colors: RGBA[] = [];
  for (const raw of lines) {
    const line = raw.trim().replace(/^#/, '');
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    if (/^[0-9a-fA-F]{6}$/.test(line)) {
      colors.push(hexToRgba(line));
    } else if (/^[0-9a-fA-F]{8}$/.test(line)) {
      const base = hexToRgba(line.slice(0, 6));
      base[3] = parseInt(line.slice(6, 8), 16);
      colors.push(base);
    }
  }
  if (colors.length === 0) throw new ValidationError('No valid hex colors found in .hex palette.');
  return colors;
}

export function serializeHexPalette(colors: RGBA[]): string {
  return colors.map((c) => rgbaToHex(c).slice(1)).join('\n') + '\n';
}

export function parseJascPal(text: string): RGBA[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 4 || lines[0] !== 'JASC-PAL') {
    throw new ValidationError('Invalid JASC .pal header (expected "JASC-PAL").');
  }
  const count = Number(lines[2]);
  if (!Number.isInteger(count) || count <= 0) {
    throw new ValidationError('Invalid color count in .pal file.');
  }
  const colors: RGBA[] = [];
  for (let i = 3; i < lines.length && colors.length < count; i++) {
    const m = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(lines[i]);
    if (m) {
      colors.push([clampByte(Number(m[1])), clampByte(Number(m[2])), clampByte(Number(m[3])), 255]);
    }
  }
  if (colors.length === 0) throw new ValidationError('No colors parsed from .pal file.');
  return colors;
}

export function extractUniqueColorsFromRgba(data: Uint8ClampedArray, w: number, h: number, limit = 256): RGBA[] {
  const seen = new Set<number>();
  const colors: RGBA[] = [];
  const total = w * h;
  for (let p = 0; p < total; p++) {
    const i = p * 4;
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (!seen.has(key)) {
      seen.add(key);
      colors.push([data[i], data[i + 1], data[i + 2], 255]);
      if (colors.length >= limit) break;
    }
  }
  if (colors.length === 0) throw new ValidationError('No opaque colors found in PNG strip.');
  return colors;
}

export function buildPaletteStripRgba(colors: RGBA[], swatchSize = 8): { data: Uint8ClampedArray; w: number; h: number } {
  const n = Math.max(1, colors.length);
  const w = n * swatchSize;
  const h = swatchSize;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let idx = 0; idx < colors.length; idx++) {
    const c = colors[idx];
    for (let y = 0; y < swatchSize; y++) {
      for (let x = 0; x < swatchSize; x++) {
        const i = (y * w + idx * swatchSize + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = c[3];
      }
    }
  }
  return { data, w, h };
}
