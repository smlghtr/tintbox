import { createFrame, createPalette, uid, validateDimensions } from './doc';
import { ValidationError } from './errors';
import { defaultPaletteColors } from './palette';
import {
  createDefaultTileMap,
  createDefaultTileSet,
  createMapLayer,
  hashRgba,
  TILE_CATEGORIES,
  unpackMapCell,
  validateMapDim,
  validateTileDim,
} from './tiles';
import type {
  AnimDirection,
  Animation,
  BlendMode,
  Doc,
  Frame,
  Layer,
  LayerGroup,
  Modifier,
  Palette,
  RGBA,
  SelectionMaskData,
  SelectionSlice,
  TileCategory,
  TileDef,
  TileMap,
  TileMapLayer,
  TileSet,
  TileSource,
} from './types';

export const PROJECT_VERSION = 2;

export interface SerializedMask {
  w: number;
  h: number;
  bits: number[];
}

export interface SerializedModifier {
  id: string;
  type: Modifier['type'];
  enabled: boolean;
  hue?: number;
  sat?: number;
  light?: number;
  opacity?: number;
  mode?: 'outer' | 'inner';
  color?: RGBA;
  width?: number;
  connectivity?: 4 | 8;
  onlyOutsideBounds?: boolean;
  offsetX?: number;
  offsetY?: number;
  dither?: boolean;
  pattern?: 'bayer2' | 'bayer4' | 'checker';
  levels?: number;
  strength?: number;
  angle?: number;
  elevation?: number;
  intensity?: number;
  ambient?: number;
  bevel?: number;
  shadows?: number;
  highlights?: number;
  contrast?: number;
  shadowTint?: RGBA;
  highlightTint?: RGBA;
  mask?: SerializedMask;
  effectMask?: number[];
}

export interface SerializedRefMeta {
  w: number;
  h: number;
  x: number;
  y: number;
  scale: number;
  smooth: boolean;
  flipX: boolean;
  flipY: boolean;
  pngPath: string;
}

export interface SerializedLayer {
  id: string;
  name: string;
  kind: 'pixel' | 'reference';
  visible: boolean;
  locked: boolean;
  alphaLock: boolean;
  clipped?: boolean;
  groupId?: string;
  layerMask?: number[];
  maskEnabled?: boolean;
  opacity: number;
  blend: BlendMode;
  celPaths: string[];
  modifiers: SerializedModifier[];
  ref?: SerializedRefMeta;
}

export interface SerializedTile {
  id: string;
  name: string;
  category: TileCategory;
  hash: string;
  linked: boolean;
  source?: TileSource;
  pngPath: string;
}

export interface SerializedTileSet {
  tileW: number;
  tileH: number;
  tiles: SerializedTile[];
}

export interface SerializedProject {
  version: number;
  w: number;
  h: number;
  fps: number;
  frames: Frame[];
  animations: Animation[];
  palettes: Palette[];
  activePaletteId: string;
  modifiers: SerializedModifier[];
  layers: SerializedLayer[];
  groups?: LayerGroup[];
  slices?: SelectionSlice[];
  tileset: SerializedTileSet;
  tilemap: TileMap;
}

const VALID_BLENDS = new Set<BlendMode>(['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten', 'difference']);
const VALID_DIRS = new Set<AnimDirection>(['forward', 'reverse', 'pingpong']);
const VALID_TILE_CATS = new Set<TileCategory>(TILE_CATEGORIES);

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function clampByte(n: unknown, fallback = 0): number {
  const num = Number(n);
  return Number.isFinite(num) ? Math.max(0, Math.min(255, Math.round(num))) : fallback;
}

function parseRgba(v: unknown, fallback: RGBA): RGBA {
  if (!Array.isArray(v) || v.length < 4) return [...fallback] as RGBA;
  return [clampByte(v[0]), clampByte(v[1]), clampByte(v[2]), clampByte(v[3], 255)];
}

function serializeMask(m: SelectionMaskData | undefined): SerializedMask | undefined {
  if (!m) return undefined;
  return { w: m.w, h: m.h, bits: Array.from(m.bits) };
}

function deserializeMask(raw: unknown): SelectionMaskData | undefined {
  if (!isObj(raw)) return undefined;
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || !Array.isArray(raw.bits)) return undefined;
  return { w, h, bits: new Uint8Array(raw.bits.map((b) => clampByte(b))) };
}

export function serializeModifier(m: Modifier): SerializedModifier {
  const base = {
    id: m.id,
    type: m.type,
    enabled: m.enabled,
    mask: serializeMask(m.mask),
    effectMask: m.effectMask ? Array.from(m.effectMask) : undefined,
  };
  if (m.type === 'color') return { ...base, hue: m.hue, sat: m.sat, light: m.light, opacity: m.opacity };
  if (m.type === 'outline') {
    return {
      ...base,
      mode: m.mode,
      color: [...m.color] as RGBA,
      width: m.width ?? 1,
      connectivity: m.connectivity ?? 4,
      onlyOutsideBounds: Boolean(m.onlyOutsideBounds),
    };
  }
  if (m.type === 'shadow') return { ...base, offsetX: m.offsetX, offsetY: m.offsetY, color: [...m.color] as RGBA };
  if (m.type === 'palette-map') return { ...base, dither: Boolean(m.dither) };
  if (m.type === 'dither') return { ...base, pattern: m.pattern, levels: m.levels, strength: m.strength };
  if (m.type === 'lighting') {
    return {
      ...base,
      angle: m.angle,
      elevation: m.elevation,
      intensity: m.intensity,
      ambient: m.ambient,
      bevel: m.bevel,
      color: [...m.color] as RGBA,
    };
  }
  return {
    ...base,
    shadows: m.shadows,
    highlights: m.highlights,
    contrast: m.contrast,
    shadowTint: [...m.shadowTint] as RGBA,
    highlightTint: [...m.highlightTint] as RGBA,
  };
}

export function deserializeModifier(raw: unknown): Modifier {
  if (!isObj(raw)) throw new ValidationError('Invalid modifier entry in project file.');
  const id = typeof raw.id === 'string' && raw.id ? raw.id : uid();
  const enabled = raw.enabled !== false;
  const mask = deserializeMask(raw.mask);
  const effectMask = Array.isArray(raw.effectMask) ? new Uint8Array(raw.effectMask.map((b) => clampByte(b))) : undefined;

  if (raw.type === 'color') {
    return {
      id,
      type: 'color',
      enabled,
      hue: Number(raw.hue) || 0,
      sat: Number(raw.sat) || 0,
      light: Number(raw.light) || 0,
      opacity: Number.isFinite(Number(raw.opacity)) ? Math.max(0, Math.min(100, Number(raw.opacity))) : 100,
      mask,
      effectMask,
    };
  }
  if (raw.type === 'shadow') {
    return {
      id,
      type: 'shadow',
      enabled,
      offsetX: Math.round(Number(raw.offsetX) || 0),
      offsetY: Math.round(Number(raw.offsetY) || 0),
      color: parseRgba(raw.color, [0, 0, 0, 160]),
      mask,
      effectMask,
    };
  }
  if (raw.type === 'palette-map') {
    return { id, type: 'palette-map', enabled, dither: Boolean(raw.dither), mask, effectMask };
  }
  if (raw.type === 'dither') {
    const pat = raw.pattern === 'bayer2' || raw.pattern === 'checker' ? raw.pattern : 'bayer4';
    return {
      id,
      type: 'dither',
      enabled,
      pattern: pat,
      levels: Math.max(2, Math.min(8, Math.round(Number(raw.levels) || 4))),
      strength: Math.max(0, Math.min(100, Math.round(Number(raw.strength ?? 65)))),
      mask,
      effectMask,
    };
  }
  if (raw.type === 'lighting') {
    return {
      id,
      type: 'lighting',
      enabled,
      angle: ((Math.round(Number(raw.angle ?? 315)) % 360) + 360) % 360,
      elevation: Math.max(5, Math.min(89, Math.round(Number(raw.elevation ?? 45)))),
      intensity: Math.max(0, Math.min(200, Math.round(Number(raw.intensity ?? 70)))),
      ambient: Math.max(0, Math.min(100, Math.round(Number(raw.ambient ?? 35)))),
      bevel: Math.max(1, Math.min(8, Math.round(Number(raw.bevel ?? 3)))),
      color: parseRgba(raw.color, [255, 244, 214, 255]),
      mask,
      effectMask,
    };
  }
  if (raw.type === 'tone') {
    return {
      id,
      type: 'tone',
      enabled,
      shadows: Math.max(-100, Math.min(100, Math.round(Number(raw.shadows ?? -15)))),
      highlights: Math.max(-100, Math.min(100, Math.round(Number(raw.highlights ?? 20)))),
      contrast: Math.max(-100, Math.min(100, Math.round(Number(raw.contrast ?? 10)))),
      shadowTint: parseRgba(raw.shadowTint, [30, 48, 96, 80]),
      highlightTint: parseRgba(raw.highlightTint, [255, 240, 190, 80]),
      mask,
      effectMask,
    };
  }
  if (raw.type === 'outline') {
    const rawW = Number(raw.width);
    const width = Number.isFinite(rawW) && rawW > 0 ? Math.max(0.2, Math.min(4, Math.round(rawW * 5) / 5)) : 1;
    return {
      id,
      type: 'outline',
      enabled,
      mode: raw.mode === 'inner' ? 'inner' : 'outer',
      color: parseRgba(raw.color, [255, 255, 255, 255]),
      width,
      connectivity: raw.connectivity === 8 ? 8 : 4,
      onlyOutsideBounds: Boolean(raw.onlyOutsideBounds),
      mask,
      effectMask,
    };
  }
  throw new ValidationError(`Unknown modifier type "${String(raw.type)}".`);
}

export function buildProjectManifest(doc: Doc): SerializedProject {
  return {
    version: PROJECT_VERSION,
    w: doc.w,
    h: doc.h,
    fps: doc.fps,
    frames: doc.frames.map((f) => ({ id: f.id, duration: f.duration })),
    animations: doc.animations.map((a) => ({ ...a })),
    palettes: doc.palettes.map((p) => ({
      id: p.id,
      name: p.name,
      colors: p.colors.map((c) => ({ rgba: [...c.rgba] as RGBA, locked: Boolean(c.locked) })),
    })),
    activePaletteId: doc.activePaletteId,
    modifiers: doc.modifiers.map(serializeModifier),
    groups: doc.groups ? doc.groups.map((g) => ({ ...g })) : undefined,
    slices: doc.slices ? doc.slices.map((sl) => ({ ...sl, rect: { ...sl.rect } })) : undefined,
    layers: doc.layers.map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      visible: l.visible,
      locked: l.locked,
      alphaLock: l.alphaLock,
      clipped: Boolean(l.clipped),
      groupId: l.groupId,
      layerMask: l.layerMask ? Array.from(l.layerMask) : undefined,
      maskEnabled: l.maskEnabled,
      opacity: l.opacity,
      blend: l.blend,
      celPaths: l.kind === 'pixel' ? l.cels.map((_, idx) => `cels/${l.id}_${idx}.png`) : [],
      modifiers: l.modifiers.map(serializeModifier),
      ref: l.ref
        ? {
            w: l.ref.w,
            h: l.ref.h,
            x: l.ref.x,
            y: l.ref.y,
            scale: l.ref.scale,
            smooth: l.ref.smooth,
            flipX: l.ref.flipX,
            flipY: l.ref.flipY,
            pngPath: `refs/${l.id}.png`,
          }
        : undefined,
    })),
    tileset: {
      tileW: doc.tileset.tileW,
      tileH: doc.tileset.tileH,
      tiles: doc.tileset.tiles.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        hash: t.hash,
        linked: t.linked,
        source: t.source ? { ...t.source } : undefined,
        pngPath: `tiles/${t.id}.png`,
      })),
    },
    tilemap: {
      width: doc.tilemap.width,
      height: doc.tilemap.height,
      layers: doc.tilemap.layers.map((ml) => ({
        id: ml.id,
        name: ml.name,
        visible: ml.visible,
        data: ml.data.slice(),
      })),
    },
  };
}

/** Migrate v0 (legacy P0 format) -> v1. */
function migrateV0ToV1(raw: Record<string, unknown>): Record<string, unknown> {
  const fps = Math.max(1, Math.min(60, Math.round(Number(raw.fps) || 8)));
  const frameCount = Math.max(1, Math.round(Number(raw.frames) || 1));
  const defaultDur = Math.round(1000 / fps);
  const frames: Frame[] = Array.from({ length: frameCount }, () => createFrame(defaultDur));
  const pal = createPalette('Workbench 16', defaultPaletteColors());
  const rawLayers = Array.isArray(raw.layers) ? raw.layers : [];
  const layers = rawLayers.map((item, idx) => {
    const l = isObj(item) ? item : {};
    const id = typeof l.id === 'string' && l.id ? l.id : uid();
    return {
      id,
      name: typeof l.name === 'string' && l.name ? l.name : `Layer ${idx + 1}`,
      kind: 'pixel',
      visible: l.visible !== false,
      locked: Boolean(l.locked),
      alphaLock: Boolean(l.alphaLock),
      opacity: Number.isFinite(Number(l.opacity)) ? Number(l.opacity) : 100,
      blend: typeof l.blend === 'string' ? l.blend : 'normal',
      celPaths: Array.isArray(l.celPaths)
        ? l.celPaths
        : Array.from({ length: frameCount }, (_, f) => `cels/${id}_${f}.png`),
      modifiers: Array.isArray(l.modifiers) ? l.modifiers : [],
    };
  });
  return {
    ...raw,
    version: 1,
    fps,
    frames,
    animations: [],
    palettes: [pal],
    activePaletteId: pal.id,
    layers,
  };
}

/** Validate and migrate any raw parsed project.json into a clean current-version SerializedProject. */
export function migrateProject(raw: unknown): SerializedProject {
  if (!isObj(raw)) throw new ValidationError('Project manifest is not a valid JSON object.');
  const version = raw.version === undefined ? 0 : Number(raw.version);
  if (!Number.isInteger(version) || version < 0) {
    throw new ValidationError(`Invalid project version: ${String(raw.version)}.`);
  }
  if (version > PROJECT_VERSION) {
    throw new ValidationError(`Project version ${version} is newer than supported version ${PROJECT_VERSION}.`);
  }

  let cur: Record<string, unknown> = raw;
  if (version === 0) cur = migrateV0ToV1(cur);

  const w = Number(cur.w);
  const h = Number(cur.h);
  validateDimensions(w, h);

  const fps = Math.max(1, Math.min(60, Math.round(Number(cur.fps) || 8)));
  if (!Array.isArray(cur.frames) || cur.frames.length === 0) {
    throw new ValidationError('Project must contain at least one frame.');
  }
  const frames: Frame[] = cur.frames.map((f) => {
    if (!isObj(f)) throw new ValidationError('Invalid frame entry.');
    return {
      id: typeof f.id === 'string' && f.id ? f.id : uid(),
      duration: Math.max(16, Math.min(10000, Math.round(Number(f.duration) || Math.round(1000 / fps)))),
    };
  });

  const animations: Animation[] = (Array.isArray(cur.animations) ? cur.animations : [])
    .filter(isObj)
    .map((a) => {
      const from = Math.max(0, Math.min(frames.length - 1, Math.round(Number(a.from) || 0)));
      const to = Math.max(from, Math.min(frames.length - 1, Math.round(Number(a.to) || from)));
      const dir = VALID_DIRS.has(a.direction as AnimDirection) ? (a.direction as AnimDirection) : 'forward';
      return {
        id: typeof a.id === 'string' && a.id ? a.id : uid(),
        name: typeof a.name === 'string' && a.name ? a.name : 'Animation',
        from,
        to,
        direction: dir,
        loop: a.loop !== false,
      };
    });

  const rawPalettes = Array.isArray(cur.palettes) ? cur.palettes.filter(isObj) : [];
  const palettes: Palette[] =
    rawPalettes.length > 0
      ? rawPalettes.map((p, idx) => ({
          id: typeof p.id === 'string' && p.id ? p.id : uid(),
          name: typeof p.name === 'string' && p.name ? p.name : `Palette ${idx + 1}`,
          colors: (Array.isArray(p.colors) ? p.colors : [])
            .filter(isObj)
            .map((c) => ({ rgba: parseRgba(c.rgba, [0, 0, 0, 255]), locked: Boolean(c.locked) })),
        }))
      : [createPalette('Workbench 16', defaultPaletteColors())];

  const activePaletteId =
    typeof cur.activePaletteId === 'string' && palettes.some((p) => p.id === cur.activePaletteId)
      ? cur.activePaletteId
      : palettes[0].id;

  const modifiers = (Array.isArray(cur.modifiers) ? cur.modifiers : []).map(deserializeModifier);

  if (!Array.isArray(cur.layers) || cur.layers.length === 0) {
    throw new ValidationError('Project must contain at least one layer.');
  }
  const layers: SerializedLayer[] = cur.layers.map((item, idx) => {
    if (!isObj(item)) throw new ValidationError(`Invalid layer at index ${idx}.`);
    const kind = item.kind === 'reference' ? 'reference' : 'pixel';
    const blend = VALID_BLENDS.has(item.blend as BlendMode) ? (item.blend as BlendMode) : 'normal';
    const celPaths = Array.isArray(item.celPaths) ? item.celPaths.map(String) : [];
    let ref: SerializedRefMeta | undefined;
    if (kind === 'reference' && isObj(item.ref)) {
      const rw = Math.round(Number(item.ref.w) || 0);
      const rh = Math.round(Number(item.ref.h) || 0);
      if (rw < 1 || rh < 1 || rw > 4096 || rh > 4096) {
        throw new ValidationError(`Reference layer dimensions ${rw}x${rh} out of range (1..4096).`);
      }
      ref = {
        w: rw,
        h: rh,
        x: Number(item.ref.x) || 0,
        y: Number(item.ref.y) || 0,
        scale: Math.max(0.01, Number(item.ref.scale) || 1),
        smooth: Boolean(item.ref.smooth),
        flipX: Boolean(item.ref.flipX),
        flipY: Boolean(item.ref.flipY),
        pngPath: typeof item.ref.pngPath === 'string' ? item.ref.pngPath : `refs/${String(item.id)}.png`,
      };
    }
    return {
      id: typeof item.id === 'string' && item.id ? item.id : uid(),
      name: typeof item.name === 'string' && item.name ? item.name : `Layer ${idx + 1}`,
      kind,
      visible: item.visible !== false,
      locked: Boolean(item.locked),
      alphaLock: Boolean(item.alphaLock),
      clipped: Boolean(item.clipped),
      groupId: typeof item.groupId === 'string' && item.groupId ? item.groupId : undefined,
      layerMask: Array.isArray(item.layerMask) ? item.layerMask.map((b) => clampByte(b, 255)) : undefined,
      maskEnabled: item.maskEnabled === undefined ? undefined : Boolean(item.maskEnabled),
      opacity: Number.isFinite(Number(item.opacity)) ? Math.max(0, Math.min(100, Number(item.opacity))) : 100,
      blend,
      celPaths,
      modifiers: (Array.isArray(item.modifiers) ? item.modifiers : []).map(deserializeModifier).map(serializeModifier),
      ref,
    };
  });

  // v1 -> v2 tileset & tilemap parsing with safe defaults
  const defSet = createDefaultTileSet(16, 16);
  let tileset: SerializedTileSet = { tileW: defSet.tileW, tileH: defSet.tileH, tiles: [] };
  if (isObj(cur.tileset)) {
    const tw = Math.round(Number(cur.tileset.tileW) || 16);
    const th = Math.round(Number(cur.tileset.tileH) || 16);
    validateTileDim(tw, th);
    const rawTiles = Array.isArray(cur.tileset.tiles) ? cur.tileset.tiles.filter(isObj) : [];
    tileset = {
      tileW: tw,
      tileH: th,
      tiles: rawTiles.map((t, idx) => {
        const id = typeof t.id === 'string' && t.id ? t.id : uid();
        const cat = VALID_TILE_CATS.has(t.category as TileCategory) ? (t.category as TileCategory) : 'custom';
        let source: TileSource | undefined;
        if (isObj(t.source)) {
          source = {
            x: Math.round(Number(t.source.x) || 0),
            y: Math.round(Number(t.source.y) || 0),
            frame: Math.max(0, Math.min(frames.length - 1, Math.round(Number(t.source.frame) || 0))),
          };
        }
        return {
          id,
          name: typeof t.name === 'string' && t.name ? t.name : `Tile ${idx + 1}`,
          category: cat,
          hash: typeof t.hash === 'string' ? t.hash : '',
          linked: Boolean(t.linked && source),
          source,
          pngPath: typeof t.pngPath === 'string' && t.pngPath ? t.pngPath : `tiles/${id}.png`,
        };
      }),
    };
  }

  let tilemap: TileMap = createDefaultTileMap(16, 12);
  if (isObj(cur.tilemap)) {
    const mw = Math.round(Number(cur.tilemap.width) || 16);
    const mh = Math.round(Number(cur.tilemap.height) || 12);
    validateMapDim(mw, mh);
    const rawMapLayers = Array.isArray(cur.tilemap.layers) ? cur.tilemap.layers.filter(isObj) : [];
    const mapLayers: TileMapLayer[] =
      rawMapLayers.length > 0
        ? rawMapLayers.map((ml, idx) => {
            const rawData = Array.isArray(ml.data) ? ml.data : [];
            const data = new Array<number>(mw * mh).fill(0);
            for (let i = 0; i < Math.min(data.length, rawData.length); i++) {
              const v = Math.round(Number(rawData[i]) || 0);
              const { tileId } = unpackMapCell(v);
              data[i] = tileId >= 0 && tileId <= tileset.tiles.length ? v : 0;
            }
            return {
              id: typeof ml.id === 'string' && ml.id ? ml.id : uid(),
              name: typeof ml.name === 'string' && ml.name ? ml.name : `Map Layer ${idx + 1}`,
              visible: ml.visible !== false,
              data,
            };
          })
        : [createMapLayer('Ground', mw, mh)];
    tilemap = { width: mw, height: mh, layers: mapLayers };
  }

  const groups: LayerGroup[] | undefined = Array.isArray(cur.groups)
    ? cur.groups.filter(isObj).map((g, idx) => ({
        id: typeof g.id === 'string' && g.id ? g.id : uid(),
        name: typeof g.name === 'string' && g.name ? g.name : `Group ${idx + 1}`,
        visible: g.visible !== false,
        collapsed: Boolean(g.collapsed),
        opacity: Number.isFinite(Number(g.opacity)) ? Math.max(0, Math.min(100, Number(g.opacity))) : 100,
      }))
    : undefined;

  const slices: SelectionSlice[] | undefined = Array.isArray(cur.slices)
    ? cur.slices
        .filter(isObj)
        .filter((sl) => isObj(sl.rect))
        .map((sl, idx) => {
          const r = sl.rect as Record<string, unknown>;
          const rx = Math.max(0, Math.min(w - 1, Math.round(Number(r.x) || 0)));
          const ry = Math.max(0, Math.min(h - 1, Math.round(Number(r.y) || 0)));
          const rw = Math.max(1, Math.min(w - rx, Math.round(Number(r.w) || 1)));
          const rh = Math.max(1, Math.min(h - ry, Math.round(Number(r.h) || 1)));
          return {
            id: typeof sl.id === 'string' && sl.id ? sl.id : uid(),
            name: typeof sl.name === 'string' && sl.name ? sl.name : `Slice ${idx + 1}`,
            layerId: typeof sl.layerId === 'string' ? sl.layerId : layers[0]?.id ?? '',
            rect: { x: rx, y: ry, w: rw, h: rh },
            color: typeof sl.color === 'string' ? sl.color : undefined,
          };
        })
    : undefined;

  return {
    version: PROJECT_VERSION,
    w,
    h,
    fps,
    frames,
    animations,
    palettes,
    activePaletteId,
    modifiers: modifiers.map(serializeModifier),
    groups,
    slices,
    layers,
    tileset,
    tilemap,
  };
}

/** Reassemble a live Doc from a migrated manifest + decoded cel, reference, and tile pixel maps. */
export function assembleDocFromManifest(
  manifest: SerializedProject,
  celPixels: Map<string, Uint8ClampedArray>,
  refImages: Map<string, { pixels: Uint8ClampedArray; dataUrl: string }>,
  tilePixels: Map<string, Uint8ClampedArray> = new Map(),
): Doc {
  const expectedLen = manifest.w * manifest.h * 4;
  const layers: Layer[] = manifest.layers.map((sl) => {
    const mods = sl.modifiers.map(deserializeModifier);
    if (sl.kind === 'reference' && sl.ref) {
      const refData = refImages.get(sl.ref.pngPath);
      if (!refData) throw new ValidationError(`Missing reference image "${sl.ref.pngPath}" in project archive.`);
      return {
        id: sl.id,
        name: sl.name,
        kind: 'reference',
        visible: sl.visible,
        locked: sl.locked,
        alphaLock: false,
        opacity: sl.opacity,
        blend: sl.blend,
        cels: Array.from({ length: manifest.frames.length }, () => new Uint8ClampedArray(4)),
        modifiers: [],
        ref: {
          w: sl.ref.w,
          h: sl.ref.h,
          x: sl.ref.x,
          y: sl.ref.y,
          scale: sl.ref.scale,
          smooth: sl.ref.smooth,
          flipX: sl.ref.flipX,
          flipY: sl.ref.flipY,
          pixels: refData.pixels,
          dataUrl: refData.dataUrl,
        },
      };
    }

    const celCount = Math.max(1, sl.celPaths.length || manifest.frames.length);
    const cels = Array.from({ length: celCount }, (_, fIdx) => {
      const path = sl.celPaths[fIdx];
      const px = path ? celPixels.get(path) : undefined;
      if (!px) return new Uint8ClampedArray(expectedLen);
      if (px.length !== expectedLen) {
        throw new ValidationError(`Cel "${path}" dimensions do not match canvas ${manifest.w}x${manifest.h}.`);
      }
      return px;
    });

    return {
      id: sl.id,
      name: sl.name,
      kind: 'pixel',
      visible: sl.visible,
      locked: sl.locked,
      alphaLock: sl.alphaLock,
      clipped: Boolean(sl.clipped),
      groupId: sl.groupId,
      layerMask: sl.layerMask && sl.layerMask.length === manifest.w * manifest.h ? new Uint8Array(sl.layerMask) : undefined,
      maskEnabled: sl.maskEnabled,
      opacity: sl.opacity,
      blend: sl.blend,
      cels,
      modifiers: mods,
    };
  });

  const tileExpected = manifest.tileset.tileW * manifest.tileset.tileH * 4;
  const tiles: TileDef[] = manifest.tileset.tiles.map((st) => {
    const px = tilePixels.get(st.pngPath);
    const pixels = px && px.length === tileExpected ? px : new Uint8ClampedArray(tileExpected);
    return {
      id: st.id,
      name: st.name,
      category: st.category,
      pixels,
      hash: st.hash || hashRgba(pixels),
      linked: st.linked,
      source: st.source ? { ...st.source } : undefined,
    };
  });
  const tileset: TileSet = {
    tileW: manifest.tileset.tileW,
    tileH: manifest.tileset.tileH,
    tiles,
  };

  return {
    version: PROJECT_VERSION,
    w: manifest.w,
    h: manifest.h,
    fps: manifest.fps,
    frames: manifest.frames.map((f) => ({ ...f })),
    animations: manifest.animations.map((a) => ({ ...a })),
    palettes: manifest.palettes.map((p) => ({
      id: p.id,
      name: p.name,
      colors: p.colors.map((c) => ({ rgba: [...c.rgba] as RGBA, locked: c.locked })),
    })),
    activePaletteId: manifest.activePaletteId,
    modifiers: manifest.modifiers.map(deserializeModifier),
    groups: manifest.groups ? manifest.groups.map((g) => ({ ...g })) : undefined,
    slices: manifest.slices ? manifest.slices.map((sl) => ({ ...sl, rect: { ...sl.rect } })) : undefined,
    layers,
    tileset,
    tilemap: {
      width: manifest.tilemap.width,
      height: manifest.tilemap.height,
      layers: manifest.tilemap.layers.map((ml) => ({
        id: ml.id,
        name: ml.name,
        visible: ml.visible,
        data: ml.data.slice(),
      })),
    },
  };
}
