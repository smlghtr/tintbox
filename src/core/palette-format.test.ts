import { describe, expect, it } from 'vitest';
import {
  buildPaletteStripRgba,
  extractUniqueColorsFromRgba,
  parseGpl,
  parseHexPalette,
  parseJascPal,
  serializeGpl,
  serializeHexPalette,
} from './palette-format';
import type { RGBA } from './types';

describe('palette import/export formats', () => {
  const sample: RGBA[] = [
    [20, 19, 15, 255],
    [198, 244, 50, 255],
    [255, 107, 74, 255],
  ];

  it('round-trips GIMP .gpl', () => {
    const text = serializeGpl('Workbench', sample);
    const parsed = parseGpl(text);
    expect(parsed.name).toBe('Workbench');
    expect(parsed.colors).toEqual(sample);
  });

  it('round-trips .hex', () => {
    const text = serializeHexPalette(sample);
    expect(parseHexPalette(text)).toEqual(sample);
  });

  it('parses JASC .pal', () => {
    const palText = 'JASC-PAL\n0100\n2\n20 19 15\n198 244 50\n';
    expect(parseJascPal(palText)).toEqual(sample.slice(0, 2));
    expect(() => parseJascPal('BAD HEADER\n0100\n1\n0 0 0')).toThrow();
  });

  it('round-trips PNG strip RGBA buffer', () => {
    const strip = buildPaletteStripRgba(sample, 4);
    expect(strip.w).toBe(12);
    expect(strip.h).toBe(4);
    expect(extractUniqueColorsFromRgba(strip.data, strip.w, strip.h)).toEqual(sample);
  });
});
