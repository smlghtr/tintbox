import {
  DEFAULT_APP_PREFS,
  type AccentPresetId,
  type AppPreferences,
  type AppThemeId,
  type CheckerStyle,
  type UiDensity,
  type UiPrefs,
} from '../state/ui';

export const PREFS_KEY = 'tintbox.ui.prefs.v1';

const VALID_THEMES = new Set<AppThemeId>(['system', 'workbench', 'charcoal', 'obsidian', 'paper']);
const VALID_ACCENTS = new Set<AccentPresetId>(['theme', 'lime', 'cyan', 'amber', 'coral', 'violet']);
const VALID_DENSITIES = new Set<UiDensity>(['compact', 'standard', 'comfortable']);
const VALID_CHECKERS = new Set<CheckerStyle>(['dark', 'medium', 'light', 'contrast']);
const VALID_SCALES = new Set([85, 90, 100, 110, 125]);
const VALID_GRID_ZOOM = new Set([4, 8, 12]);
const VALID_CANVAS_SIZES = new Set([16, 32, 64, 128, 256]);
const VALID_UNDO_STEPS = new Set([50, 100, 200, 500]);
const VALID_HIST_MB = new Set([64, 128, 256, 512]);
const VALID_AUTOSAVE = new Set([0, 5, 10, 30, 60]);
const VALID_EXP_FMT = new Set(['png', 'gif', 'sheet', 'psd', 'bmp']);
const VALID_EXP_SCALE = new Set([1, 2, 4, 8]);
const VALID_FPS = new Set([4, 8, 12, 24]);

export function sanitizeAppPreferences(raw: unknown): Partial<AppPreferences> {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: Partial<AppPreferences> = {};
  if (typeof o.theme === 'string' && VALID_THEMES.has(o.theme as AppThemeId)) out.theme = o.theme as AppThemeId;
  if (typeof o.accent === 'string' && VALID_ACCENTS.has(o.accent as AccentPresetId)) out.accent = o.accent as AccentPresetId;
  if (typeof o.uiScale === 'number' && VALID_SCALES.has(o.uiScale)) out.uiScale = o.uiScale as AppPreferences['uiScale'];
  if (typeof o.density === 'string' && VALID_DENSITIES.has(o.density as UiDensity)) out.density = o.density as UiDensity;
  if (o.checkerSize === 8 || o.checkerSize === 16 || o.checkerSize === 24) out.checkerSize = o.checkerSize;
  if (typeof o.checkerStyle === 'string' && VALID_CHECKERS.has(o.checkerStyle as CheckerStyle)) out.checkerStyle = o.checkerStyle as CheckerStyle;
  if (typeof o.gridDefault === 'boolean') out.gridDefault = o.gridDefault;
  if (typeof o.gridMinZoom === 'number' && VALID_GRID_ZOOM.has(o.gridMinZoom)) out.gridMinZoom = o.gridMinZoom as AppPreferences['gridMinZoom'];
  if (typeof o.gridOpacity === 'number' && Number.isFinite(o.gridOpacity)) {
    out.gridOpacity = Math.max(5, Math.min(40, Math.round(o.gridOpacity)));
  }
  if (o.gridColor === 'auto' || o.gridColor === 'white' || o.gridColor === 'accent') out.gridColor = o.gridColor;
  if (typeof o.showSlices === 'boolean') out.showSlices = o.showSlices;
  if (typeof o.defaultCanvasSize === 'number' && VALID_CANVAS_SIZES.has(o.defaultCanvasSize)) {
    out.defaultCanvasSize = o.defaultCanvasSize as AppPreferences['defaultCanvasSize'];
  }
  if (typeof o.pixelPerfectDefault === 'boolean') out.pixelPerfectDefault = o.pixelPerfectDefault;
  if (o.brushOutline === 'pixel' || o.brushOutline === 'crosshair') out.brushOutline = o.brushOutline;
  if (o.wheelZoomStep === 1 || o.wheelZoomStep === 2) out.wheelZoomStep = o.wheelZoomStep;
  if (typeof o.zoomToCursor === 'boolean') out.zoomToCursor = o.zoomToCursor;
  if (o.grabSampleDefault === 'composed' || o.grabSampleDefault === 'layer') out.grabSampleDefault = o.grabSampleDefault;
  if (typeof o.moveWrapDefault === 'boolean') out.moveWrapDefault = o.moveWrapDefault;
  if (typeof o.animateMarchingAnts === 'boolean') out.animateMarchingAnts = o.animateMarchingAnts;
  if (typeof o.maxUndoSteps === 'number' && VALID_UNDO_STEPS.has(o.maxUndoSteps)) {
    out.maxUndoSteps = o.maxUndoSteps as AppPreferences['maxUndoSteps'];
  }
  if (typeof o.maxHistoryMb === 'number' && VALID_HIST_MB.has(o.maxHistoryMb)) {
    out.maxHistoryMb = o.maxHistoryMb as AppPreferences['maxHistoryMb'];
  }
  if (typeof o.autosaveSeconds === 'number' && VALID_AUTOSAVE.has(o.autosaveSeconds)) {
    out.autosaveSeconds = o.autosaveSeconds as AppPreferences['autosaveSeconds'];
  }
  if (typeof o.confirmUnsavedClose === 'boolean') out.confirmUnsavedClose = o.confirmUnsavedClose;
  if (typeof o.defaultExportFormat === 'string' && VALID_EXP_FMT.has(o.defaultExportFormat)) {
    out.defaultExportFormat = o.defaultExportFormat as AppPreferences['defaultExportFormat'];
  }
  if (typeof o.defaultExportScale === 'number' && VALID_EXP_SCALE.has(o.defaultExportScale)) {
    out.defaultExportScale = o.defaultExportScale as AppPreferences['defaultExportScale'];
  }
  if (typeof o.defaultFps === 'number' && VALID_FPS.has(o.defaultFps)) {
    out.defaultFps = o.defaultFps as AppPreferences['defaultFps'];
  }
  return out;
}

export function loadUiPrefs(): Partial<UiPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const obj = parsed as Record<string, unknown>;
    const prefs: Partial<UiPrefs> = {};
    if (typeof obj.grid === 'boolean') prefs.grid = obj.grid;
    if (typeof obj.timelineOpen === 'boolean') prefs.timelineOpen = obj.timelineOpen;
    if (typeof obj.restrictToPalette === 'boolean') prefs.restrictToPalette = obj.restrictToPalette;
    if (typeof obj.sideWidth === 'number' && obj.sideWidth >= 220 && obj.sideWidth <= 480) {
      prefs.sideWidth = Math.round(obj.sideWidth);
    }
    if (typeof obj.timelineHeight === 'number' && obj.timelineHeight >= 96 && obj.timelineHeight <= 360) {
      prefs.timelineHeight = Math.round(obj.timelineHeight);
    }
    if (obj.onion && typeof obj.onion === 'object') {
      const on = obj.onion as Record<string, unknown>;
      prefs.onion = {
        enabled: typeof on.enabled === 'boolean' ? on.enabled : undefined,
        before: typeof on.before === 'number' ? on.before : undefined,
        after: typeof on.after === 'number' ? on.after : undefined,
        mode: on.mode === 'tinted' || on.mode === 'original' ? on.mode : undefined,
        source: on.source === 'composed' || on.source === 'active' ? on.source : undefined,
        wrap: typeof on.wrap === 'boolean' ? on.wrap : undefined,
      };
    }
    if (obj.collapsed && typeof obj.collapsed === 'object') {
      const col: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(obj.collapsed as Record<string, unknown>)) {
        if (typeof v === 'boolean') col[k] = v;
      }
      prefs.collapsed = col;
    }
    if (obj.app && typeof obj.app === 'object') {
      prefs.app = sanitizeAppPreferences(obj.app);
    }
    return prefs;
  } catch {
    return {};
  }
}

export function saveUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be unavailable in private contexts; ignore cleanly.
  }
}

/**
 * Apply theme, color-scheme meta, accent, UI scale, density, and checkerboard tokens live to the DOM.
 * Follows the modern `<meta name="color-scheme">` + CSS `:has()` pattern so native scrollbars and
 * form controls stay in sync with the chosen theme.
 */
export function applyAppPreferencesToDom(prefs: AppPreferences = DEFAULT_APP_PREFS): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.dataset.theme = prefs.theme;
  html.dataset.accent = prefs.accent;
  html.dataset.density = prefs.density;
  html.dataset.checker = prefs.checkerStyle;
  html.style.setProperty('--ui-scale', String(prefs.uiScale / 100));
  html.style.setProperty('--checker-size', `${prefs.checkerSize}px`);

  let meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (!meta && document.head) {
    meta = document.createElement('meta');
    meta.name = 'color-scheme';
    document.head.append(meta);
  }
  if (meta) {
    meta.content = prefs.theme === 'system' ? 'light dark' : prefs.theme === 'paper' ? 'light' : 'dark';
  }
}
