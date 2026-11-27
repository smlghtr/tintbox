export type RGBA = [number, number, number, number];
export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface BezierAnchor {
  x: number;
  y: number;
  inHandle?: Pt;
  outHandle?: Pt;
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'darken' | 'lighten' | 'difference';
export type LayerKind = 'pixel' | 'reference';
export type Anchor9 = 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br';
export type SymmetryMode = 'none' | 'x' | 'y' | 'xy';
export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect';
export type BrushShape = 'square' | 'round';
export type AnimDirection = 'forward' | 'reverse' | 'pingpong';
export type TileMode = 'none' | 'x' | 'y' | 'xy';
export type TileCategory = 'ground' | 'wall' | 'prop' | 'hazard' | 'custom';

export interface TileSource {
  x: number;
  y: number;
  frame: number;
}

export interface TileDef {
  id: string;
  name: string;
  category: TileCategory;
  pixels: Uint8ClampedArray;
  hash: string;
  linked: boolean;
  source?: TileSource;
}

export interface TileSet {
  tileW: number;
  tileH: number;
  tiles: TileDef[];
}

export interface TileMapLayer {
  id: string;
  name: string;
  visible: boolean;
  data: number[];
}

export interface TileMap {
  width: number;
  height: number;
  layers: TileMapLayer[];
}

export interface SelectionMaskData {
  w: number;
  h: number;
  bits: Uint8Array;
}

export interface PaletteEntry {
  rgba: RGBA;
  locked: boolean;
}

export interface Palette {
  id: string;
  name: string;
  colors: PaletteEntry[];
}

export interface ReferenceImage {
  dataUrl: string;
  w: number;
  h: number;
  x: number;
  y: number;
  scale: number;
  smooth: boolean;
  flipX: boolean;
  flipY: boolean;
  pixels: Uint8ClampedArray;
}

export interface Frame {
  id: string;
  duration: number;
}

export interface Animation {
  id: string;
  name: string;
  from: number;
  to: number;
  direction: AnimDirection;
  loop: boolean;
}

export interface Symmetry {
  mode: SymmetryMode;
  x: number;
  y: number;
  locked?: boolean;
}

export interface LayerGroup {
  id: string;
  name: string;
  visible: boolean;
  collapsed: boolean;
  opacity: number;
}

export interface SelectionSlice {
  id: string;
  name: string;
  layerId: string;
  rect: Rect;
  color?: string;
}

export interface PixelDiff {
  x: number;
  y: number;
  w: number;
  h: number;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

export interface ColorMod {
  id: string;
  type: 'color';
  enabled: boolean;
  hue: number;
  sat: number;
  light: number;
  opacity: number;
  mask?: SelectionMaskData;
  effectMask?: Uint8Array;
}

export interface OutlineMod {
  id: string;
  type: 'outline';
  enabled: boolean;
  mode: 'outer' | 'inner';
  color: RGBA;
  width?: number;
  connectivity?: 4 | 8;
  onlyOutsideBounds?: boolean;
  mask?: SelectionMaskData;
  effectMask?: Uint8Array;
}

export interface ShadowMod {
  id: string;
  type: 'shadow';
  enabled: boolean;
  offsetX: number;
  offsetY: number;
  color: RGBA;
  mask?: SelectionMaskData;
  effectMask?: Uint8Array;
}

export interface PaletteMapMod {
  id: string;
  type: 'palette-map';
  enabled: boolean;
  dither: boolean;
  mask?: SelectionMaskData;
  effectMask?: Uint8Array;
}

export interface DitherMod {
  id: string;
  type: 'dither';
  enabled: boolean;
  pattern: 'bayer2' | 'bayer4' | 'checker';
  levels: number;
  strength: number;
  mask?: SelectionMaskData;
  effectMask?: Uint8Array;
}

export interface LightingMod {
  id: string;
  type: 'lighting';
  enabled: boolean;
  angle: number;
  elevation: number;
  intensity: number;
  ambient: number;
  bevel: number;
  color: RGBA;
  mask?: SelectionMaskData;
  effectMask?: Uint8Array;
}

export interface ToneMod {
  id: string;
  type: 'tone';
  enabled: boolean;
  shadows: number;
  highlights: number;
  contrast: number;
  shadowTint: RGBA;
  highlightTint: RGBA;
  mask?: SelectionMaskData;
  effectMask?: Uint8Array;
}

export type Modifier = ColorMod | OutlineMod | ShadowMod | PaletteMapMod | DitherMod | LightingMod | ToneMod;

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  alphaLock: boolean;
  clipped?: boolean;
  groupId?: string;
  layerMask?: Uint8Array;
  maskEnabled?: boolean;
  opacity: number;
  blend: BlendMode;
  cels: Uint8ClampedArray[];
  modifiers: Modifier[];
  ref?: ReferenceImage;
}

export interface Doc {
  version: number;
  w: number;
  h: number;
  frames: Frame[];
  fps: number;
  animations: Animation[];
  layers: Layer[];
  groups?: LayerGroup[];
  slices?: SelectionSlice[];
  modifiers: Modifier[];
  palettes: Palette[];
  activePaletteId: string;
  tileset: TileSet;
  tilemap: TileMap;
}
