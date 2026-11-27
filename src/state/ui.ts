import type { OnionSettings } from '../core/animation';
import type { DitherGradientStop, DitherPattern, GradientShape } from '../core/dither';
import { createDoc } from '../core/doc';
import { hexToRgba, type RampOpts } from '../core/palette';
import type { SelectionMask } from '../core/selection';
import type { ShapePreset } from '../core/shapes';
import { defaultSymmetry } from '../core/symmetry';
import type { TileRotation } from '../core/tiles';
import type { AnimDirection, BrushShape, Doc, Pt, RGBA, Rect, Symmetry, TileCategory, TileMode } from '../core/types';
import { centerViewport, type Viewport } from '../core/viewport';
import type { WarpPreset } from '../core/warp';

export type ToolId =
  | 'pencil'
  | 'dither'
  | 'gradient'
  | 'eraser'
  | 'line'
  | 'curve'
  | 'rect'
  | 'ellipse'
  | 'fill'
  | 'picker'
  | 'select-rect'
  | 'select-lasso'
  | 'select-wand'
  | 'move'
  | 'hand';

export interface FloatingLayer {
  rect: Rect;
  pixels: Uint8ClampedArray;
  maskBits: Uint8Array;
  offsetX: number;
  offsetY: number;
}

export interface ClipboardBuffer {
  rect: Rect;
  pixels: Uint8ClampedArray;
  maskBits: Uint8Array;
}

export interface ToastMessage {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

export interface OrphanPanelOpts {
  connectivity: 4 | 8;
  minClusterSize: 1 | 2 | 3;
  action: 'merge' | 'delete';
  scope: 'cel' | 'layer-frames';
}

export interface SoloModifier {
  scope: 'layer' | 'doc';
  layerId: string | null;
  modId: string;
}

export type AppThemeId = 'system' | 'workbench' | 'charcoal' | 'obsidian' | 'paper';
export type AccentPresetId = 'theme' | 'lime' | 'cyan' | 'amber' | 'coral' | 'violet';
export type UiDensity = 'compact' | 'standard' | 'comfortable';
export type CheckerStyle = 'dark' | 'medium' | 'light' | 'contrast';

export interface AppPreferences {
  // Appearance
  theme: AppThemeId;
  accent: AccentPresetId;
  uiScale: 85 | 90 | 100 | 110 | 125;
  density: UiDensity;
  // Canvas & Guides
  checkerSize: 8 | 16 | 24;
  checkerStyle: CheckerStyle;
  gridDefault: boolean;
  gridMinZoom: 4 | 8 | 12;
  gridOpacity: number;
  gridColor: 'auto' | 'white' | 'accent';
  showSlices: boolean;
  defaultCanvasSize: 16 | 32 | 64 | 128 | 256;
  // Tools & Input
  pixelPerfectDefault: boolean;
  brushOutline: 'pixel' | 'crosshair';
  wheelZoomStep: 1 | 2;
  zoomToCursor: boolean;
  grabSampleDefault: 'composed' | 'layer';
  moveWrapDefault: boolean;
  animateMarchingAnts: boolean;
  // Performance & History
  maxUndoSteps: 50 | 100 | 200 | 500;
  maxHistoryMb: 64 | 128 | 256 | 512;
  autosaveSeconds: 0 | 5 | 10 | 30 | 60;
  confirmUnsavedClose: boolean;
  // Export & Animation
  defaultExportFormat: 'png' | 'gif' | 'sheet' | 'psd' | 'bmp';
  defaultExportScale: 1 | 2 | 4 | 8;
  defaultFps: 4 | 8 | 12 | 24;
}

export const DEFAULT_APP_PREFS: AppPreferences = {
  theme: 'workbench',
  accent: 'theme',
  uiScale: 100,
  density: 'standard',
  checkerSize: 16,
  checkerStyle: 'dark',
  gridDefault: false,
  gridMinZoom: 8,
  gridOpacity: 12,
  gridColor: 'auto',
  showSlices: true,
  defaultCanvasSize: 64,
  pixelPerfectDefault: true,
  brushOutline: 'pixel',
  wheelZoomStep: 1,
  zoomToCursor: true,
  grabSampleDefault: 'composed',
  moveWrapDefault: false,
  animateMarchingAnts: true,
  maxUndoSteps: 200,
  maxHistoryMb: 128,
  autosaveSeconds: 10,
  confirmUnsavedClose: true,
  defaultExportFormat: 'png',
  defaultExportScale: 1,
  defaultFps: 8,
};

export interface UiPrefs {
  grid: boolean;
  collapsed: Record<string, boolean>;
  timelineOpen: boolean;
  restrictToPalette?: boolean;
  onion?: Partial<OnionSettings>;
  sideWidth?: number;
  timelineHeight?: number;
  app?: Partial<AppPreferences>;
}

export type MapToolId = 'brush' | 'rect' | 'fill' | 'eraser' | 'pick';

export interface TabSummary {
  id: string;
  name: string;
  dirty: boolean;
}

export interface AppState {
  tabs: TabSummary[];
  activeTabId: string;
  doc: Doc;
  docRev: number;
  savedRev: number;
  frameRevs: number[];
  activeLayerId: string;
  activeFrame: number;
  activeAnimationId: string | null;
  playDirection: AnimDirection;
  playLoop: boolean;
  onion: OnionSettings;
  tool: ToolId;
  primaryColor: RGBA;
  secondaryColor: RGBA;
  brushSize: number;
  brushShape: BrushShape;
  pixelPerfect: boolean;
  shapeFilled: boolean;
  fillContiguous: boolean;
  fillSampleAll: boolean;
  fillTolerance: number;
  moveWrap: boolean;
  restrictToPalette: boolean;
  grabSampleSource: 'composed' | 'layer';
  grabShiftAdds: boolean;
  grabLoupe: { docPt: Pt; screenX: number; screenY: number; color: RGBA | null } | null;
  viewport: Viewport;
  grid: boolean;
  symmetry: Symmetry;
  selection: SelectionMask | null;
  floating: FloatingLayer | null;
  clipboard: ClipboardBuffer | null;
  modScope: 'layer' | 'doc';
  soloModifier: SoloModifier | null;
  playing: boolean;
  strokeActive: boolean;
  hover: Pt | null;
  hoverHex: string | null;
  historyRev: number;
  toast: ToastMessage | null;
  announcement: string;
  mergeWarned: boolean;
  collapsed: Record<string, boolean>;
  timelineOpen: boolean;
  ramp: RampOpts;
  rampBase: RGBA;
  rampMode: 'step' | 'triad';
  rampDark: RGBA;
  rampLight: RGBA;
  rampMult: number;
  rampLockToPalette: boolean;
  orphanOpen: boolean;
  orphanOpts: OrphanPanelOpts;
  orphanPreview: Pt[];
  viewMode: 'sprite' | 'map';
  tileMode: TileMode;
  lastTileAxis: 'x' | 'y' | 'xy';
  tileCategoryFilter: TileCategory | 'all';
  captureCategory: TileCategory;
  activeTileIndex: number;
  mapTool: MapToolId;
  activeMapLayerId: string;
  atlasExtrusion: 0 | 1 | 2;
  ditherPattern: DitherPattern;
  ditherDensity: number;
  ditherDual: boolean;
  vectorSmooth: boolean;
  vectorClosed: boolean;
  vectorFilled: boolean;
  vectorTension: number;
  vectorWidth: number;
  vectorActive: boolean;
  shapePreset: ShapePreset;
  shapeStarPoints: number;
  shapeLiveActive: boolean;
  tileGridOverlay: boolean;
  mapZoom: number;
  mapHoverCell: Pt | null;
  sideWidth: number;
  timelineHeight: number;
  freeCanvas: boolean;
  showCanvasScrollbars: boolean;
  selectedLayerIds: string[];
  renamingLayerId: string | null;
  fxCollapsed: Record<string, boolean>;
  focusedModId: string | null;
  activeSliceId: string | null;
  mapTileRot: TileRotation;
  mapTileFlipH: boolean;
  mapTileFlipV: boolean;
  navSync: boolean;
  navPlaying: boolean;
  navFrame: number;
  navRefLayerId: string | null;
  appPrefs: AppPreferences;
  editTarget: 'pixels' | 'mask' | 'mod-mask';
  activeModMaskId: string | null;
  activeModMaskScope: 'layer' | 'doc';
  gradientShape: GradientShape;
  gradientPattern: DitherPattern;
  gradientToTransparent: boolean;
  gradientMultiStop: boolean;
  gradientStops: DitherGradientStop[];
  gradientActive: boolean;
  moveMode: 'move' | 'resize' | 'warp';
  transformActive: boolean;
  warpPreset: WarpPreset;
  warpStrength: number;
  warpSecondary: number;
  panelVisible: Record<string, boolean>;
}

export function createInitialState(doc = createDoc(64, 64), prefs?: Partial<UiPrefs>): AppState {
  const appPrefs: AppPreferences = { ...DEFAULT_APP_PREFS, ...(prefs?.app ?? {}) };
  return {
    tabs: [{ id: 'tab-1', name: 'Untitled 1', dirty: false }],
    activeTabId: 'tab-1',
    doc,
    docRev: 1,
    savedRev: 1,
    frameRevs: Array.from({ length: doc.frames.length }, () => 1),
    activeLayerId: doc.layers[0].id,
    activeFrame: 0,
    activeAnimationId: null,
    playDirection: 'forward',
    playLoop: true,
    onion: {
      enabled: prefs?.onion?.enabled ?? false,
      before: prefs?.onion?.before ?? 1,
      after: prefs?.onion?.after ?? 1,
      mode: prefs?.onion?.mode ?? 'tinted',
      source: prefs?.onion?.source ?? 'composed',
      wrap: prefs?.onion?.wrap ?? false,
    },
    tool: 'pencil',
    primaryColor: hexToRgba('#c6f432'),
    secondaryColor: hexToRgba('#14130f'),
    brushSize: 1,
    brushShape: 'square',
    pixelPerfect: appPrefs.pixelPerfectDefault,
    shapeFilled: false,
    fillContiguous: true,
    fillSampleAll: false,
    fillTolerance: 0,
    moveWrap: appPrefs.moveWrapDefault,
    restrictToPalette: prefs?.restrictToPalette ?? false,
    grabSampleSource: appPrefs.grabSampleDefault,
    grabShiftAdds: true,
    grabLoupe: null,
    viewport: centerViewport(640, 480, doc.w, doc.h, 8),
    grid: prefs?.grid ?? appPrefs.gridDefault,
    symmetry: defaultSymmetry(doc.w, doc.h),
    selection: null,
    floating: null,
    clipboard: null,
    modScope: 'layer',
    soloModifier: null,
    playing: false,
    strokeActive: false,
    hover: null,
    hoverHex: null,
    historyRev: 0,
    toast: null,
    announcement: '',
    mergeWarned: false,
    collapsed: prefs?.collapsed ?? { navigator: true, slices: true, mods: true, tiles: true, ramp: true, history: true },
    timelineOpen: prefs?.timelineOpen ?? false,
    ramp: { steps: 5, hueShift: 12, satShift: 6, lightStep: 14 },
    rampBase: hexToRgba('#3fa66b'),
    rampMode: 'step',
    rampDark: hexToRgba('#1d4d4f'),
    rampLight: hexToRgba('#c6f432'),
    rampMult: 100,
    rampLockToPalette: false,
    orphanOpen: false,
    orphanOpts: { connectivity: 4, minClusterSize: 1, action: 'merge', scope: 'cel' },
    orphanPreview: [],
    viewMode: 'sprite',
    tileMode: 'none',
    lastTileAxis: 'xy',
    tileCategoryFilter: 'all',
    captureCategory: 'ground',
    activeTileIndex: 0,
    mapTool: 'brush',
    activeMapLayerId: doc.tilemap.layers[0]?.id ?? '',
    atlasExtrusion: 1,
    ditherPattern: 'checker',
    ditherDensity: 50,
    ditherDual: false,
    vectorSmooth: true,
    vectorClosed: false,
    vectorFilled: false,
    vectorTension: 50,
    vectorWidth: 1,
    vectorActive: false,
    shapePreset: 'square',
    shapeStarPoints: 5,
    shapeLiveActive: false,
    tileGridOverlay: false,
    mapZoom: 2,
    mapHoverCell: null,
    sideWidth: prefs?.sideWidth ?? 288,
    timelineHeight: prefs?.timelineHeight ?? 156,
    freeCanvas: true,
    showCanvasScrollbars: true,
    selectedLayerIds: [doc.layers[0].id],
    renamingLayerId: null,
    fxCollapsed: {},
    focusedModId: null,
    activeSliceId: null,
    mapTileRot: 0,
    mapTileFlipH: false,
    mapTileFlipV: false,
    navSync: true,
    navPlaying: false,
    navFrame: 0,
    navRefLayerId: null,
    appPrefs,
    editTarget: 'pixels',
    activeModMaskId: null,
    activeModMaskScope: 'layer',
    gradientShape: 'linear',
    gradientPattern: 'bayer4',
    gradientToTransparent: false,
    gradientMultiStop: false,
    gradientStops: [
      { color: hexToRgba('#14130f'), weight: 30 },
      { color: hexToRgba('#3fa66b'), weight: 40 },
      { color: hexToRgba('#c6f432'), weight: 30 },
    ],
    gradientActive: false,
    moveMode: 'move',
    transformActive: false,
    warpPreset: 'quad',
    warpStrength: 35,
    warpSecondary: 20,
    panelVisible: {
      palette: true,
      layers: true,
      modifiers: true,
      tiles: true,
      history: true,
    },
  };
}
