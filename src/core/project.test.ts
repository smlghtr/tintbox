import { describe, expect, it } from 'vitest';
import v0Fixture from '../../test/fixtures/project-v0.json';
import v1Fixture from '../../test/fixtures/project-v1.json';
import { compose, createDoc, newModifier } from './doc';
import { applyModifiers } from './modifiers';
import { assembleDocFromManifest, buildProjectManifest, migrateProject, PROJECT_VERSION } from './project';
import { setPixel } from './raster';
import type { PaletteMapMod, ShadowMod } from './types';

describe('P4 modifiers: Drop shadow & Palette map', () => {
  it('drop shadow draws offset silhouette strictly behind original pixels without mutating source', () => {
    const w = 5, h = 5;
    const src = new Uint8ClampedArray(w * h * 4);
    setPixel(src, w, h, 1, 1, [255, 0, 0, 255]);
    const copy = src.slice();

    const sh = newModifier('shadow') as ShadowMod;
    sh.offsetX = 1;
    sh.offsetY = 2;
    sh.color = [0, 0, 0, 180];

    const out = applyModifiers(src, w, h, [sh]);
    expect(src).toEqual(copy);
    // Original pixel intact
    expect(out[(1 * w + 1) * 4]).toBe(255);
    expect(out[(1 * w + 1) * 4 + 3]).toBe(255);
    // Shadow pixel at (2, 3)
    expect(out[(3 * w + 2) * 4]).toBe(0);
    expect(out[(3 * w + 2) * 4 + 3]).toBe(180);
  });

  it('palette map modifier remaps pixels non-destructively to active document palette', () => {
    const doc = createDoc(4, 4);
    setPixel(doc.layers[0].cels[0], 4, 4, 0, 0, [195, 240, 55, 255]);
    const orig = doc.layers[0].cels[0].slice();
    const pm = newModifier('palette-map') as PaletteMapMod;
    doc.layers[0].modifiers.push(pm);

    const composed = compose(doc, 0);
    expect(doc.layers[0].cels[0]).toEqual(orig);
    // Snapped to Workbench 16 lime [198, 244, 50, 255]
    expect([composed[0], composed[1], composed[2], composed[3]]).toEqual([198, 244, 50, 255]);
  });
});

describe('project schema & migrations (fixtures)', () => {
  it('migrates v0 fixture cleanly to current version', () => {
    const m = migrateProject(v0Fixture);
    expect(m.version).toBe(PROJECT_VERSION);
    expect(m.w).toBe(16);
    expect(m.frames).toHaveLength(2);
    expect(m.frames[0].duration).toBe(100);
    expect(m.palettes).toHaveLength(1);
    expect(m.layers[0].celPaths).toEqual(['cels/l1_0.png', 'cels/l1_1.png']);
  });

  it('validates v1 fixture and migrates cleanly to v2 with default tileset and tilemap', () => {
    const m = migrateProject(v1Fixture);
    expect(m.version).toBe(PROJECT_VERSION);
    expect(m.tileset.tileW).toBe(16);
    expect(m.tilemap.width).toBe(16);
    expect(m.animations[0].name).toBe('Idle');
    expect(m.modifiers[0].type).toBe('shadow');
    expect(m.layers[0].modifiers[0].type).toBe('palette-map');

    const cels = new Map<string, Uint8ClampedArray>();
    const cel0 = new Uint8ClampedArray(8 * 8 * 4);
    setPixel(cel0, 8, 8, 2, 2, [198, 244, 50, 255]);
    cels.set('cels/l-1_0.png', cel0);
    cels.set('cels/l-1_1.png', new Uint8ClampedArray(8 * 8 * 4));

    const doc = assembleDocFromManifest(m, cels, new Map());
    expect(doc.layers[0].cels[0][(2 * 8 + 2) * 4]).toBe(198);
    expect(buildProjectManifest(doc).version).toBe(PROJECT_VERSION);
  });

  it('rejects corrupt or future-version project payloads cleanly', () => {
    expect(() => migrateProject(null)).toThrow();
    expect(() => migrateProject({ version: 99, w: 8, h: 8 })).toThrow(/newer/i);
    expect(() => migrateProject({ version: 1, w: 9999, h: 8, frames: [{ id: 'a', duration: 100 }], layers: [] })).toThrow();
    expect(() => migrateProject({ version: 1, w: 8, h: 8, frames: [], layers: [] })).toThrow();
  });
});
