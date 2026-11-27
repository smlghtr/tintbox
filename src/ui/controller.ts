import type { OnionSettings } from '../core/animation';
import { findOrphans, removeOrphans } from '../core/cleanup';
import { nearestPaletteColor } from '../core/color';
import { computeDiff } from '../core/diff';
import { cloneModifier, compose, composeLayerOnly, composeRect, createDoc, fitImageToCanvas, getActivePalette, getLayerCel, getLayerCelIndex, MAX_DIM, sampleDocColor, uid } from '../core/doc';
import { LayerLockedError } from '../core/errors';
import { remapToPalette } from '../core/quantize';
import { flipCelPixels, moveCelPixels, rotateCelPixels90 } from '../core/raster';
import type { ResampleAlgorithm } from '../core/scale';
import {
  clearSelection,
  cloneMask,
  combineMasks,
  extractSelection,
  getMaskBit,
  invertMask,
  isEmptyMask,
  layerAlphaMask,
  maskBounds,
  maskEqual,
  rectMask,
  selectAll,
  stampBuffer,
  type SelectionMask,
} from '../core/selection';
import { autoOrganizeTiles, buildAnimatedDocFromRegions, detectPixelIslands, scanOccupiedGridCells } from '../core/smart';
import { defaultSymmetry } from '../core/symmetry';
import { captureTileFromDoc, type TileRotation } from '../core/tiles';
import type { Anchor9, Doc, Layer, Modifier, Palette, PixelDiff, Pt, Rect, ReferenceImage, RGBA, SelectionMode, SelectionSlice, Symmetry, TileDef, TileMapLayer, TileMode } from '../core/types';
import { centerViewport, clampPan, fitZoom, screenToDoc, stepZoom, zoomAtScreenPoint, type Viewport } from '../core/viewport';
import { generateJuiceFrames, JUICE_PRESETS, type JuiceParams } from '../core/juice';
import { warpCelPixels, type WarpParams } from '../core/warp';
import { decodeAseprite, isAsepriteBytes } from '../io/aseprite';
import { clearAutosaveDraft, loadAutosaveDraft, saveAutosaveDraft, type AutosaveDraft } from '../io/autosave';
import { applyAppPreferencesToDom, loadUiPrefs, PREFS_KEY, sanitizeAppPreferences, saveUiPrefs } from '../io/export';
import { exportSlicesZipBytes, triggerDownload } from '../io/export-pack';
import { decodeAnimatedGif, isGifBytes } from '../io/gif-import';
import { decodeImageBlob, REF_SIZE_WARN_BYTES } from '../io/image';
import {
  deserializeTintboxArchive,
  pickTintboxFile,
  saveTintboxFile,
  serializeTintboxArchive,
} from '../io/project-io';
import { decodePsd, isPsdBytes } from '../io/psd';
import {
  addImagePixelLayerCommand,
  addLayerCommand,
  addSliceCommand,
  addSlicesBatchCommand,
  bakeJuiceAnimationCommand,
  duplicateLayerCommand,
  flattenVisibleCommand,
  layerPropCommand,
  moveLayersCommand,
  mergeDownCommand,
  removeLayerCommand,
  removeSliceCommand,
  renameSliceCommand,
  reorderLayerCommand,
  replaceTilesetCommand,
  soloLayerVisibilityCommand,
  addReferenceLayerCommand,
  addTileCommand,
  applyLayerMaskCommand,
  groupLayersCommand,
  multiFramePixelPatchCommand,
  multiLayerPatchCommand,
  pixelPatchCommand,
  referencePropCommand,
  resizeCanvasCommand,
  scaleCanvasCommand,
  selectionCommand,
  setLayerMaskCommand,
  setModifierEffectMaskCommand,
  ungroupLayersCommand,
  updateModifierCommand,
  type LayerCelPatch,
  type LayerRefPatch,
} from '../state/commands';
import { History, type Command, type CommandContext } from '../state/history';
import { createStore, type Store } from '../state/store';
import { createInitialState, DEFAULT_APP_PREFS, type AppPreferences, type AppState, type OrphanPanelOpts, type SoloModifier, type ToolId } from '../state/ui';

interface TabSession {
  id: string;
  name: string;
  doc: Doc;
  history: History;
  settingsHistory: History;
  frameCache: Map<number, { rev: number; data: Uint8ClampedArray }>;
  docRev: number;
  savedRev: number;
  lastAutosavedRev: number;
  frameRevs: number[];
  activeLayerId: string;
  activeFrame: number;
  activeAnimationId: string | null;
  selection: SelectionMask | null;
  viewport: Viewport;
  symmetry: Symmetry;
  viewMode: 'sprite' | 'map';
  activeTileIndex: number;
  activeMapLayerId: string;
}

export class AppController {
  readonly store: Store<AppState>;
  private tabs: TabSession[] = [];
  private activeTabId = 'tab-1';
  private tabSeq = 1;
  private toastSeq = 0;
  private toastTimer = 0;
  private autosaveTimer = 0;
  private projectName = 'project.tintbox';
  private stageSize = { w: 640, h: 480 };
  private beforeToolChange: (() => void) | null = null;

  setBeforeToolChange(fn: (() => void) | null): void {
    this.beforeToolChange = fn;
  }

  constructor() {
    const prefs = loadUiPrefs();
    const doc = createDoc(64, 64);
    const initial = createInitialState(doc, prefs);
    doc.fps = initial.appPrefs.defaultFps;
    const maxBytes = initial.appPrefs.maxHistoryMb * 1024 * 1024;
    const firstTab: TabSession = {
      id: 'tab-1',
      name: 'Untitled 1',
      doc,
      history: new History(initial.appPrefs.maxUndoSteps, maxBytes),
      settingsHistory: new History(50),
      frameCache: new Map(),
      docRev: initial.docRev,
      savedRev: initial.savedRev,
      lastAutosavedRev: initial.docRev,
      frameRevs: initial.frameRevs.slice(),
      activeLayerId: initial.activeLayerId,
      activeFrame: initial.activeFrame,
      activeAnimationId: null,
      selection: null,
      viewport: initial.viewport,
      symmetry: initial.symmetry,
      viewMode: 'sprite',
      activeTileIndex: 0,
      activeMapLayerId: initial.activeMapLayerId,
    };
    this.tabs = [firstTab];
    this.activeTabId = firstTab.id;
    this.store = createStore(initial);
    applyAppPreferencesToDom(initial.appPrefs);
  }

  private getActiveTab(): TabSession {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? this.tabs[0];
  }

  get history(): History {
    return this.getActiveTab().history;
  }

  get settingsHistory(): History {
    return this.getActiveTab().settingsHistory;
  }

  private get frameCache(): Map<number, { rev: number; data: Uint8ClampedArray }> {
    return this.getActiveTab().frameCache;
  }

  private get lastAutosavedRev(): number {
    return this.getActiveTab().lastAutosavedRev;
  }

  private set lastAutosavedRev(v: number) {
    this.getActiveTab().lastAutosavedRev = v;
  }

  private syncActiveTabFromStore(): void {
    const tab = this.getActiveTab();
    const s = this.state;
    tab.doc = s.doc;
    tab.docRev = s.docRev;
    tab.savedRev = s.savedRev;
    tab.frameRevs = s.frameRevs.slice();
    tab.activeLayerId = s.activeLayerId;
    tab.activeFrame = s.activeFrame;
    tab.activeAnimationId = s.activeAnimationId;
    tab.selection = s.selection;
    tab.viewport = s.viewport;
    tab.symmetry = s.symmetry;
    tab.viewMode = s.viewMode;
    tab.activeTileIndex = s.activeTileIndex;
    tab.activeMapLayerId = s.activeMapLayerId;
  }

  private publishTabs(): void {
    this.syncActiveTabFromStore();
    this.store.setState({
      tabs: this.tabs.map((t) => ({ id: t.id, name: t.name, dirty: t.docRev !== t.savedRev })),
      activeTabId: this.activeTabId,
    });
  }

  private createTabSession(doc: Doc, name: string, markClean: boolean): TabSession {
    const id = `tab-${++this.tabSeq}`;
    const z = fitZoom(this.stageSize.w, this.stageSize.h, doc.w, doc.h, 16);
    const rev = 1;
    const ap = this.state?.appPrefs ?? DEFAULT_APP_PREFS;
    return {
      id,
      name,
      doc,
      history: new History(ap.maxUndoSteps, ap.maxHistoryMb * 1024 * 1024),
      settingsHistory: new History(50),
      frameCache: new Map(),
      docRev: rev,
      savedRev: markClean ? rev : 0,
      lastAutosavedRev: rev,
      frameRevs: Array.from({ length: doc.frames.length }, () => 1),
      activeLayerId: doc.layers[0].id,
      activeFrame: 0,
      activeAnimationId: null,
      selection: null,
      viewport: centerViewport(this.stageSize.w, this.stageSize.h, doc.w, doc.h, z),
      symmetry: defaultSymmetry(doc.w, doc.h),
      viewMode: 'sprite',
      activeTileIndex: doc.tileset.tiles.length > 0 ? 1 : 0,
      activeMapLayerId: doc.tilemap.layers[0]?.id ?? '',
    };
  }

  private activateTab(tab: TabSession): void {
    this.activeTabId = tab.id;
    this.store.setState({
      doc: tab.doc,
      docRev: tab.docRev,
      savedRev: tab.savedRev,
      frameRevs: tab.frameRevs.slice(),
      activeLayerId: tab.activeLayerId,
      activeFrame: tab.activeFrame,
      activeAnimationId: tab.activeAnimationId,
      selection: tab.selection,
      floating: null,
      orphanOpen: false,
      orphanPreview: [],
      soloModifier: null,
      symmetry: tab.symmetry,
      viewport: tab.viewport,
      historyRev: this.state.historyRev + 1,
      playing: false,
      viewMode: tab.viewMode,
      activeTileIndex: tab.activeTileIndex,
      activeMapLayerId: tab.activeMapLayerId,
      tabs: this.tabs.map((t) => ({ id: t.id, name: t.name, dirty: t.docRev !== t.savedRev })),
      activeTabId: tab.id,
    });
  }

  newTab(w = 64, h = 64, name?: string): string {
    this.beforeToolChange?.();
    if (this.state.floating) this.commitFloating();
    this.syncActiveTabFromStore();
    const doc = createDoc(w, h);
    const label = name?.trim() || `Untitled ${this.tabSeq + 1}`;
    const tab = this.createTabSession(doc, label, true);
    this.tabs.push(tab);
    this.activateTab(tab);
    this.showToast(`Opened new tab "${tab.name}" (${w}×${h}).`, 'info');
    return tab.id;
  }

  switchTab(tabId: string): boolean {
    if (tabId === this.activeTabId) return false;
    const target = this.tabs.find((t) => t.id === tabId);
    if (!target) return false;
    this.beforeToolChange?.();
    if (this.state.floating) this.commitFloating();
    this.syncActiveTabFromStore();
    this.activateTab(target);
    return true;
  }

  closeTab(tabId: string): boolean {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return false;
    if (this.tabs.length === 1) {
      const fresh = this.createTabSession(createDoc(64, 64), `Untitled ${this.tabSeq + 1}`, true);
      this.tabs = [fresh];
      this.activateTab(fresh);
      return true;
    }
    if (tabId === this.activeTabId) {
      this.beforeToolChange?.();
      if (this.state.floating) this.commitFloating();
    } else {
      this.syncActiveTabFromStore();
    }
    this.tabs.splice(idx, 1);
    if (tabId === this.activeTabId) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activateTab(next);
    } else {
      this.publishTabs();
    }
    return true;
  }

  renameTab(tabId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || tab.name === trimmed) return;
    tab.name = trimmed;
    this.publishTabs();
  }

  get state(): AppState {
    return this.store.getState();
  }

  setStageSize(w: number, h: number): void {
    this.stageSize = { w: Math.max(1, w), h: Math.max(1, h) };
  }

  getActiveLayer(): Layer {
    const s = this.state;
    return s.doc.layers.find((l) => l.id === s.activeLayerId) ?? s.doc.layers[0];
  }

  getActiveCel(): Uint8ClampedArray {
    const s = this.state;
    const layer = this.getActiveLayer();
    return getLayerCel(layer, s.activeFrame) ?? layer.cels[0];
  }

  getActivePalette(): Palette {
    return getActivePalette(this.state.doc);
  }

  resolveDrawColor(color: RGBA): RGBA {
    if (!this.state.restrictToPalette || color[3] === 0) return color;
    const pal = this.getActivePalette().colors.map((c) => c.rgba);
    if (pal.length === 0) return color;
    return nearestPaletteColor(color, pal);
  }

  ensureEditableLayer(): Layer | null {
    const l = this.getActiveLayer();
    if (l.kind === 'reference') {
      this.showToast('Reference layer is not drawable.', 'error');
      return null;
    }
    if (l.locked) {
      this.showToast(new LayerLockedError().message, 'error');
      return null;
    }
    return l;
  }

  sampleColorAt(docPt: Pt): RGBA | null {
    const s = this.state;
    const composed = this.getComposed(s.activeFrame);
    return sampleDocColor(
      s.doc,
      s.activeFrame,
      composed,
      this.getActiveLayer(),
      docPt.x,
      docPt.y,
      s.grabSampleSource,
    );
  }

  commandContext(): CommandContext {
    return {
      doc: this.state.doc,
      getSelection: () => this.state.selection,
      setSelection: (m) => this.store.setState({ selection: m }),
      getActiveLayerId: () => this.state.activeLayerId,
      setActiveLayerId: (id) => this.store.setState({ activeLayerId: id }),
      getActiveFrame: () => this.state.activeFrame,
      setActiveFrame: (frame) => this.store.setState({ activeFrame: frame }),
      markDirty: (frame) => this.markDirty(frame),
    };
  }

  markDirty(frame?: number): void {
    const s = this.state;
    const nextRevs = Array.from({ length: s.doc.frames.length }, (_, i) => {
      const cur = s.frameRevs[i] ?? 0;
      return frame === undefined || frame === i ? cur + 1 : cur;
    });
    if (frame === undefined) this.frameCache.clear();
    else this.frameCache.delete(frame);
    this.store.setState({ docRev: s.docRev + 1, frameRevs: nextRevs });
    this.publishTabs();
    if (s.orphanOpen) this.refreshOrphanPreview();
  }

  getComposed(frame: number): Uint8ClampedArray {
    const s = this.state;
    if (s.soloModifier) {
      return compose(s.doc, frame, { solo: s.soloModifier });
    }
    const rev = s.frameRevs[frame] ?? 0;
    const cached = this.frameCache.get(frame);
    if (cached && cached.rev === rev && cached.data.length === s.doc.w * s.doc.h * 4) {
      return cached.data;
    }
    const data = compose(s.doc, frame);
    this.frameCache.set(frame, { rev, data });
    return data;
  }

  recomposeDirtyRect(frame: number, rect: Rect): Uint8ClampedArray {
    const s = this.state;
    if (s.soloModifier) return this.getComposed(frame);
    const cached = this.frameCache.get(frame);
    if (cached && cached.data.length === s.doc.w * s.doc.h * 4) {
      composeRect(s.doc, frame, cached.data, rect);
      return cached.data;
    }
    return this.getComposed(frame);
  }

  execute(cmd: Command): void {
    try {
      const targetHistory = cmd.scope === 'settings' ? this.settingsHistory : this.history;
      targetHistory.execute(cmd, this.commandContext());
      this.store.setState({ historyRev: this.state.historyRev + 1 });
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Action failed.', 'error');
    }
  }

  undoSettings(): boolean {
    const cmd = this.settingsHistory.undo(this.commandContext(), this.state.strokeActive);
    if (!cmd) return false;
    this.store.setState({
      historyRev: this.state.historyRev + 1,
      announcement: `Undid setting: ${cmd.label}`,
    });
    return true;
  }

  redoSettings(): boolean {
    const cmd = this.settingsHistory.redo(this.commandContext(), this.state.strokeActive);
    if (!cmd) return false;
    this.store.setState({
      historyRev: this.state.historyRev + 1,
      announcement: `Redid setting: ${cmd.label}`,
    });
    return true;
  }

  undo(): boolean {
    const cmd = this.history.undo(this.commandContext(), this.state.strokeActive);
    if (!cmd) return false;
    this.store.setState({
      historyRev: this.state.historyRev + 1,
      announcement: `Undid: ${cmd.label}`,
    });
    return true;
  }

  redo(): boolean {
    const cmd = this.history.redo(this.commandContext(), this.state.strokeActive);
    if (!cmd) return false;
    this.store.setState({
      historyRev: this.state.historyRev + 1,
      announcement: `Redid: ${cmd.label}`,
    });
    return true;
  }

  jumpHistory(targetIndex: number): boolean {
    if (!this.history.jumpTo(targetIndex, this.commandContext(), this.state.strokeActive)) return false;
    this.store.setState({
      historyRev: this.state.historyRev + 1,
      announcement: `Jumped to history step ${targetIndex}`,
    });
    return true;
  }

  setSoloModifier(solo: SoloModifier | null): void {
    this.store.setState({ soloModifier: solo });
  }

  toggleOnion(): void {
    const next = { ...this.state.onion, enabled: !this.state.onion.enabled };
    this.store.setState({ onion: next, announcement: next.enabled ? 'Onion skin on' : 'Onion skin off' });
    this.persistPrefs();
  }

  updateOnion(patch: Partial<OnionSettings>): void {
    const next = { ...this.state.onion, ...patch };
    this.store.setState({ onion: next });
    this.persistPrefs();
  }

  commitCelChange(before: Uint8ClampedArray, label: string): boolean {
    const s = this.state;
    const layer = this.getActiveLayer();
    if (layer.kind === 'reference') return false;
    const celIdx = getLayerCelIndex(layer, s.activeFrame);
    const after = layer.cels[celIdx];
    const diff = computeDiff(before, after, s.doc.w, s.doc.h);
    if (!diff) return false;
    after.set(before);
    this.execute(pixelPatchCommand(layer.id, celIdx, diff, label));
    return true;
  }

  setSelectionWithUndo(next: SelectionMask | null, label = 'Selection'): void {
    const clean = next && isEmptyMask(next) ? null : next;
    if (maskEqual(this.state.selection, clean)) return;
    this.execute(selectionCommand(this.state.selection, clean, label));
    if (this.state.orphanOpen) this.refreshOrphanPreview();
  }

  setTool(tool: ToolId): void {
    if (this.state.tool !== tool) {
      this.beforeToolChange?.();
    }
    if (this.state.floating && tool !== 'move') this.commitFloating();
    const patch: Partial<AppState> = { tool, grabLoupe: null };
    if (tool === 'ellipse') patch.shapePreset = 'oval';
    else if (tool === 'rect' && this.state.shapePreset === 'oval') patch.shapePreset = 'square';
    this.store.setState(patch);
  }

  swapColors(): void {
    const s = this.state;
    this.store.setState({ primaryColor: s.secondaryColor, secondaryColor: s.primaryColor });
  }

  stepBrushSize(delta: number): void {
    const subSteps = [0.2, 0.4, 0.6, 0.8, 1];
    const cur = this.state.brushSize;
    if (cur < 1 || (cur === 1 && delta < 0)) {
      const idx = subSteps.findIndex((v) => Math.abs(v - cur) < 0.05);
      const safeIdx = idx >= 0 ? idx : subSteps.length - 1;
      const nextIdx = Math.max(0, Math.min(subSteps.length - 1, safeIdx + Math.sign(delta)));
      this.store.setState({ brushSize: subSteps[nextIdx] });
      return;
    }
    const next = Math.max(1, Math.min(32, Math.round(cur + delta)));
    this.store.setState({ brushSize: next });
  }

  zoomStep(delta: number, screenX?: number, screenY?: number): void {
    const s = this.state;
    const nextZoom = stepZoom(s.viewport.zoom, delta);
    const sx = screenX ?? this.stageSize.w / 2;
    const sy = screenY ?? this.stageSize.h / 2;
    const vp = zoomAtScreenPoint(s.viewport, nextZoom, sx, sy, this.stageSize.w, this.stageSize.h, s.doc.w, s.doc.h, s.freeCanvas);
    this.store.setState({ viewport: vp });
  }

  setZoomValue(nextZoom: number): void {
    const s = this.state;
    const vp = zoomAtScreenPoint(
      s.viewport,
      nextZoom,
      this.stageSize.w / 2,
      this.stageSize.h / 2,
      this.stageSize.w,
      this.stageSize.h,
      s.doc.w,
      s.doc.h,
      s.freeCanvas,
    );
    this.store.setState({ viewport: vp });
  }

  setPan(panX: number, panY: number): void {
    const s = this.state;
    const vp = clampPan(
      { zoom: s.viewport.zoom, panX, panY },
      this.stageSize.w,
      this.stageSize.h,
      s.doc.w,
      s.doc.h,
      32,
      s.freeCanvas,
    );
    this.store.setState({ viewport: vp });
  }

  zoom100(): void {
    const s = this.state;
    const vp = zoomAtScreenPoint(
      s.viewport,
      1,
      this.stageSize.w / 2,
      this.stageSize.h / 2,
      this.stageSize.w,
      this.stageSize.h,
      s.doc.w,
      s.doc.h,
      s.freeCanvas,
    );
    this.store.setState({ viewport: vp });
  }

  zoomFit(): void {
    const s = this.state;
    const z = fitZoom(this.stageSize.w, this.stageSize.h, s.doc.w, s.doc.h, 16);
    const vp = centerViewport(this.stageSize.w, this.stageSize.h, s.doc.w, s.doc.h, z);
    this.store.setState({ viewport: vp });
  }

  toggleSymmetryLock(): void {
    const s = this.state;
    const locked = !Boolean(s.symmetry.locked);
    this.store.setState({
      symmetry: { ...s.symmetry, locked },
      announcement: locked ? 'Symmetry line locked' : 'Symmetry line unlocked',
    });
  }

  toggleFreeCanvas(): void {
    const next = !this.state.freeCanvas;
    this.store.setState({ freeCanvas: next });
    this.showToast(next ? 'Free floating pasteboard enabled.' : 'Canvas pan locked to bounds.', 'info');
  }

  selectLayerTransparency(layerId: string, mode: SelectionMode = 'replace'): void {
    const s = this.state;
    const layer = s.doc.layers.find((l) => l.id === layerId);
    if (!layer || layer.kind === 'reference') return;
    const px = composeLayerOnly(s.doc, layer, s.activeFrame);
    const alphaMask = layerAlphaMask(px, s.doc.w, s.doc.h);
    if (layer.layerMask && layer.maskEnabled !== false) {
      for (let i = 0; i < layer.layerMask.length; i++) {
        if (layer.layerMask[i] === 0) alphaMask.bits[i >> 3] &= ~(1 << (i & 7));
      }
    }
    if (isEmptyMask(alphaMask) && mode === 'replace') {
      this.showToast(`"${layer.name}" has no painted pixels on this frame.`, 'info');
      return;
    }
    const merged = combineMasks(s.selection, alphaMask, mode);
    this.setSelectionWithUndo(merged, `Select ${layer.name} pixels`);
    this.showToast(`Selected pixels of "${layer.name}".`, 'info');
  }

  placeReferenceSideBySide(layerId: string): void {
    const s = this.state;
    const layer = s.doc.layers.find((l) => l.id === layerId);
    if (!layer?.ref) return;
    const nextX = s.doc.w + Math.max(4, Math.round(s.doc.w * 0.12));
    const nextY = 0;
    this.execute(referencePropCommand(layerId, { x: nextX, y: nextY }, 'Place reference side-by-side'));
    const totalW = nextX + Math.ceil(layer.ref.w * layer.ref.scale);
    const totalH = Math.max(s.doc.h, Math.ceil(layer.ref.h * layer.ref.scale));
    const z = fitZoom(this.stageSize.w, this.stageSize.h, totalW, totalH, 24);
    const vp = centerViewport(this.stageSize.w, this.stageSize.h, totalW, totalH, z);
    this.store.setState({ viewport: vp, freeCanvas: true });
    this.showToast('Placed reference side-by-side on floating pasteboard.', 'info');
  }

  setEditTarget(target: 'pixels' | 'mask' | 'mod-mask', modId?: string, modScope: 'layer' | 'doc' = 'layer'): void {
    this.store.setState({
      editTarget: target,
      activeModMaskId: target === 'mod-mask' ? (modId ?? null) : null,
      activeModMaskScope: modScope,
    });
  }

  getActiveMaskBuffer(): { buf: Uint8Array; kind: 'layer' | 'mod'; mod?: Modifier } | null {
    const s = this.state;
    if (s.editTarget === 'mask') {
      const l = this.getActiveLayer();
      if (l.layerMask && l.layerMask.length === s.doc.w * s.doc.h) {
        return { buf: l.layerMask, kind: 'layer' };
      }
      return null;
    }
    if (s.editTarget === 'mod-mask' && s.activeModMaskId) {
      const list = s.activeModMaskScope === 'doc' ? s.doc.modifiers : this.getActiveLayer().modifiers;
      const mod = list.find((m) => m.id === s.activeModMaskId);
      if (mod?.effectMask && mod.effectMask.length === s.doc.w * s.doc.h) {
        return { buf: mod.effectMask, kind: 'mod', mod };
      }
    }
    return null;
  }

  commitMaskChange(before: Uint8Array, label: string): boolean {
    const s = this.state;
    const active = this.getActiveMaskBuffer();
    if (!active) return false;
    let changed = false;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== active.buf[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    const after = active.buf.slice();
    active.buf.set(before);
    if (active.kind === 'layer') {
      this.execute(setLayerMaskCommand(this.getActiveLayer().id, after, label));
    } else if (active.mod) {
      this.execute(
        setModifierEffectMaskCommand(
          s.activeModMaskScope,
          s.activeModMaskScope === 'doc' ? null : this.getActiveLayer().id,
          active.mod.id,
          after,
          label,
        ),
      );
    }
    return true;
  }

  addLayerMask(fromSelection = true): void {
    const l = this.getActiveLayer();
    if (l.kind === 'reference') {
      this.showToast('Cannot add layer mask to a reference layer.', 'error');
      return;
    }
    const { doc, selection } = this.state;
    const mask = new Uint8Array(doc.w * doc.h);
    if (fromSelection && selection) {
      for (let y = 0; y < doc.h; y++) {
        for (let x = 0; x < doc.w; x++) {
          mask[y * doc.w + x] = getMaskBit(selection, x, y) ? 255 : 0;
        }
      }
    } else {
      mask.fill(255);
    }
    this.execute(setLayerMaskCommand(l.id, mask, 'Add layer mask', true));
    this.setEditTarget('mask');
    this.showToast('Added layer mask (white reveals, black/eraser conceals).', 'info');
  }

  removeLayerMask(): void {
    const l = this.getActiveLayer();
    if (!l.layerMask) return;
    this.execute(setLayerMaskCommand(l.id, undefined, 'Delete layer mask', undefined));
    if (this.state.editTarget === 'mask') this.setEditTarget('pixels');
  }

  invertLayerMask(): void {
    const l = this.getActiveLayer();
    if (!l.layerMask) return;
    const next = l.layerMask.slice();
    for (let i = 0; i < next.length; i++) next[i] = 255 - next[i];
    this.execute(setLayerMaskCommand(l.id, next, 'Invert layer mask'));
  }

  toggleLayerMaskEnabled(): void {
    const l = this.getActiveLayer();
    if (!l.layerMask) return;
    const nextEnabled = l.maskEnabled === false;
    this.execute(setLayerMaskCommand(l.id, l.layerMask, nextEnabled ? 'Enable layer mask' : 'Disable layer mask', nextEnabled));
  }

  applyLayerMask(): void {
    const l = this.getActiveLayer();
    if (!l.layerMask) return;
    this.execute(applyLayerMaskCommand(l.id));
    if (this.state.editTarget === 'mask') this.setEditTarget('pixels');
    this.showToast('Applied layer mask to pixels.', 'info');
  }

  startEditModifierMask(scope: 'layer' | 'doc', layerId: string | null, modId: string): void {
    const s = this.state;
    const list = scope === 'doc' ? s.doc.modifiers : s.doc.layers.find((l) => l.id === layerId)?.modifiers;
    const m = list?.find((x) => x.id === modId);
    if (!m) return;
    if (!m.effectMask || m.effectMask.length !== s.doc.w * s.doc.h) {
      const fresh = new Uint8Array(s.doc.w * s.doc.h);
      if (s.selection) {
        for (let y = 0; y < s.doc.h; y++) {
          for (let x = 0; x < s.doc.w; x++) {
            fresh[y * s.doc.w + x] = getMaskBit(s.selection, x, y) ? 255 : 0;
          }
        }
      } else {
        fresh.fill(255);
      }
      this.execute(setModifierEffectMaskCommand(scope, layerId, modId, fresh, `Create ${m.type} effect mask`));
    }
    this.setEditTarget('mod-mask', modId, scope);
    this.showToast(`Editing ${m.type} effect mask — paint white/black or drag Gradient on canvas.`, 'info');
  }

  clearModifierEffectMask(scope: 'layer' | 'doc', layerId: string | null, modId: string): void {
    this.execute(setModifierEffectMaskCommand(scope, layerId, modId, undefined, 'Clear effect mask'));
    if (this.state.editTarget === 'mod-mask' && this.state.activeModMaskId === modId) {
      this.setEditTarget('pixels');
    }
  }

  startRenameGroup(groupId: string): void {
    this.store.setState({ renamingLayerId: groupId });
  }

  selectGroupLayers(groupId: string, additive = false): void {
    const s = this.state;
    const members = s.doc.layers.filter((l) => l.groupId === groupId);
    if (members.length === 0) return;
    const ids = members.map((l) => l.id);
    const top = members[members.length - 1];
    if (additive) {
      const curSel = new Set(s.selectedLayerIds);
      const allIn = ids.every((id) => curSel.has(id));
      if (allIn && curSel.size > ids.length) {
        for (const id of ids) curSel.delete(id);
      } else {
        for (const id of ids) curSel.add(id);
      }
      this.store.setState({ activeLayerId: top.id, selectedLayerIds: Array.from(curSel), editTarget: 'pixels' });
      return;
    }
    if (s.activeLayerId === top.id && s.selectedLayerIds.length === ids.length && ids.every((id) => s.selectedLayerIds.includes(id)) && s.editTarget === 'pixels') return;
    this.store.setState({ activeLayerId: top.id, selectedLayerIds: ids, editTarget: 'pixels' });
  }

  selectGroupTransparency(groupId: string, mode: SelectionMode = 'replace'): void {
    const s = this.state;
    const grp = s.doc.groups?.find((g) => g.id === groupId);
    if (!grp) return;
    const members = s.doc.layers.filter((l) => l.groupId === groupId && l.kind === 'pixel');
    const candidates = members.some((l) => l.visible) ? members.filter((l) => l.visible) : members;
    let union: ReturnType<typeof layerAlphaMask> | null = null;
    for (const l of candidates) {
      const px = composeLayerOnly(s.doc, l, s.activeFrame);
      const m = layerAlphaMask(px, s.doc.w, s.doc.h);
      if (l.layerMask && l.maskEnabled !== false) {
        for (let i = 0; i < l.layerMask.length; i++) {
          if (l.layerMask[i] === 0) m.bits[i >> 3] &= ~(1 << (i & 7));
        }
      }
      union = union ? combineMasks(union, m, 'add') : m;
    }
    if (!union || (isEmptyMask(union) && mode === 'replace')) {
      this.showToast(`Group "${grp.name}" has no painted pixels on this frame.`, 'info');
      return;
    }
    const merged = combineMasks(s.selection, union, mode);
    this.setSelectionWithUndo(merged, `Select ${grp.name} pixels`);
    this.showToast(`Selected pixels of group "${grp.name}".`, 'info');
  }

  getSelectedEditableLayers(): Layer[] {
    const s = this.state;
    const idSet = new Set(s.selectedLayerIds.length > 0 ? s.selectedLayerIds : [s.activeLayerId]);
    return s.doc.layers.filter((l) => idSet.has(l.id) && !l.locked);
  }

  commitMultiLayerChange(
    beforeCels: { layerId: string; frame: number; before: Uint8ClampedArray }[],
    refPatches: LayerRefPatch[],
    label: string,
  ): boolean {
    const s = this.state;
    const celPatches: LayerCelPatch[] = [];
    for (const entry of beforeCels) {
      const layer = s.doc.layers.find((l) => l.id === entry.layerId);
      const cel = layer?.cels[entry.frame];
      if (!cel) continue;
      const diff = computeDiff(entry.before, cel, s.doc.w, s.doc.h);
      if (!diff) continue;
      cel.set(entry.before);
      celPatches.push({ layerId: entry.layerId, frame: entry.frame, diff });
    }
    const changedRefs = refPatches.filter((r) => r.beforeX !== r.afterX || r.beforeY !== r.afterY);
    for (const r of changedRefs) {
      const layer = s.doc.layers.find((l) => l.id === r.layerId);
      if (layer?.ref) {
        layer.ref.x = r.beforeX;
        layer.ref.y = r.beforeY;
      }
    }
    if (celPatches.length === 0 && changedRefs.length === 0) return false;
    this.execute(multiLayerPatchCommand(celPatches, changedRefs, label));
    return true;
  }

  focusModifier(scope: 'layer' | 'doc', layerId: string | null, modId: string): void {
    const s = this.state;
    const nextCollapsed = { ...s.collapsed, mods: false };
    const patch: Partial<AppState> = {
      modScope: scope,
      collapsed: nextCollapsed,
      focusedModId: modId,
    };
    if (scope === 'layer' && layerId) {
      patch.activeLayerId = layerId;
      if (!s.selectedLayerIds.includes(layerId)) patch.selectedLayerIds = [layerId];
    }
    this.store.setState(patch);
    this.persistPrefs();
  }

  toggleFxCollapsed(layerId: string): void {
    const cur = this.state.fxCollapsed;
    this.store.setState({ fxCollapsed: { ...cur, [layerId]: !cur[layerId] } });
  }

  /** Photoshop-style drop: onto a layer row (above/below), onto a group header (above/into/below), or bottom of list (ungroup). */
  dropLayers(
    ids: string[],
    target: { kind: 'layer'; id: string; after: boolean } | { kind: 'group'; id: string; position: 'into' | 'above' | 'below' } | { kind: 'end' },
    draggedGroup: string | null,
  ): void {
    const layers = this.state.doc.layers;
    const moving = new Set(ids);
    const rest = layers.filter((l) => !moving.has(l.id));
    const range = (gid: string) => {
      const idx = rest.flatMap((l, i) => (l.groupId === gid ? [i] : []));
      return idx.length ? { lo: Math.min(...idx), hi: Math.max(...idx) } : null;
    };
    let at = 0;
    let groupId: string | undefined = draggedGroup ?? undefined;
    if (target.kind === 'group') {
      if (target.id === draggedGroup) return;
      const r = range(target.id);
      if (draggedGroup) {
        if (!r) return;
        at = target.position === 'below' ? r.lo : r.hi + 1;
        groupId = draggedGroup;
      } else if (target.position === 'above') {
        if (r) {
          at = r.hi + 1;
        } else {
          const origIdx = layers.flatMap((l, i) => (l.groupId === target.id ? [i] : []));
          const first = origIdx.length ? Math.min(...origIdx) : layers.length;
          at = layers.slice(0, first).filter((l) => !moving.has(l.id)).length;
        }
        groupId = undefined;
      } else {
        if (!r) return;
        at = r.hi + 1;
        groupId = target.id;
      }
    } else if (target.kind === 'layer') {
      const t = rest.find((l) => l.id === target.id);
      if (!t) return;
      const ti = rest.indexOf(t);
      if (draggedGroup && t.groupId && t.groupId !== draggedGroup) {
        const r = range(t.groupId);
        if (!r) return;
        at = target.after ? r.hi + 1 : r.lo;
      } else {
        at = target.after ? ti + 1 : ti;
        groupId = draggedGroup ?? t.groupId;
      }
    } else if (!draggedGroup) {
      groupId = undefined;
    }
    const nextOrder = [...rest.slice(0, at), ...layers.filter((l) => moving.has(l.id)), ...rest.slice(at)];
    const sameOrder = nextOrder.every((l, i) => l === layers[i]);
    const sameGroup = layers.filter((l) => moving.has(l.id)).every((l) => l.groupId === groupId);
    if (sameOrder && sameGroup) return;
    const movingWasGrouped = layers.some((l) => moving.has(l.id) && Boolean(l.groupId));
    const label = !draggedGroup && groupId ? 'Move layer into group' : !draggedGroup && movingWasGrouped && !groupId ? 'Remove layer from group' : 'Move layers';
    this.execute(moveLayersCommand(ids, at, groupId, label));
  }

  removeActiveFromGroup(): void {
    const l = this.getActiveLayer();
    if (!l.groupId) {
      this.showToast('Active layer is not in a group.', 'info');
      return;
    }
    const layers = this.state.doc.layers;
    const rest = layers.filter((x) => x.id !== l.id);
    const hi = Math.max(...rest.flatMap((x, i) => (x.groupId === l.groupId ? [i] : [])), -1);
    this.execute(moveLayersCommand([l.id], hi + 1, undefined, 'Remove layer from group'));
  }

  startRenameLayer(id: string = this.state.activeLayerId): void {
    this.store.setState({ activeLayerId: id, selectedLayerIds: [id], renamingLayerId: id });
  }

  newLayer(): void {
    this.execute(addLayerCommand());
  }

  duplicateActiveLayer(): void {
    this.execute(duplicateLayerCommand(this.state.activeLayerId));
  }

  deleteActiveLayer(): void {
    if (this.state.doc.layers.length <= 1) {
      this.showToast('Cannot delete the last layer.', 'error');
      return;
    }
    this.execute(removeLayerCommand(this.state.activeLayerId));
  }

  mergeDownActive(): void {
    const s = this.state;
    const idx = s.doc.layers.findIndex((l) => l.id === s.activeLayerId);
    if (idx <= 0) return;
    const upper = s.doc.layers[idx];
    const lower = s.doc.layers[idx - 1];
    if (upper.kind === 'reference' || lower.kind === 'reference') return;
    if (!s.mergeWarned && (upper.modifiers.length > 0 || lower.modifiers.length > 0)) {
      this.store.setState({ mergeWarned: true });
      this.showToast('Merge down bakes modifiers of both layers into pixels.', 'info');
    }
    this.execute(mergeDownCommand(idx));
  }

  flattenVisible(): void {
    this.execute(flattenVisibleCommand());
  }

  moveActiveLayer(to: 'up' | 'down' | 'top' | 'bottom'): void {
    const layers = this.state.doc.layers;
    const idx = layers.findIndex((l) => l.id === this.state.activeLayerId);
    const last = layers.length - 1;
    const target = to === 'up' ? idx + 1 : to === 'down' ? idx - 1 : to === 'top' ? last : 0;
    if (idx < 0 || target < 0 || target > last || target === idx) return;
    this.execute(reorderLayerCommand(idx, target));
  }

  selectAdjacentLayer(dir: 1 | -1): void {
    const layers = this.state.doc.layers;
    const idx = layers.findIndex((l) => l.id === this.state.activeLayerId);
    const next = layers[idx + dir];
    if (next) this.store.setState({ activeLayerId: next.id, selectedLayerIds: [next.id], editTarget: 'pixels' });
  }

  toggleActiveLayerFlag(flag: 'visible' | 'locked' | 'alphaLock' | 'clipped'): void {
    const l = this.getActiveLayer();
    if (flag === 'clipped' && l.kind !== 'pixel') return;
    if (flag === 'alphaLock' && l.kind === 'reference') return;
    const next = !(flag === 'clipped' ? Boolean(l.clipped) : l[flag]);
    const labels = {
      visible: next ? 'Show layer' : 'Hide layer',
      locked: next ? 'Lock layer' : 'Unlock layer',
      alphaLock: 'Toggle alpha lock',
      clipped: next ? 'Create clipping mask' : 'Release clipping mask',
    };
    this.execute(layerPropCommand(l.id, { [flag]: next }, labels[flag]));
  }

  soloActiveLayer(): void {
    this.execute(soloLayerVisibilityCommand(this.state.activeLayerId));
  }

  groupSelectedLayers(): void {
    const s = this.state;
    const ids = s.selectedLayerIds.length > 0 ? s.selectedLayerIds : [s.activeLayerId];
    const valid = ids.filter((id) => s.doc.layers.some((l) => l.id === id));
    if (valid.length === 0) return;
    this.execute(groupLayersCommand(valid));
    this.showToast(`Grouped ${valid.length} layer${valid.length === 1 ? '' : 's'}.`, 'info');
  }

  ungroupActiveGroup(): void {
    const l = this.getActiveLayer();
    if (!l.groupId) {
      this.showToast('Active layer is not in a group.', 'info');
      return;
    }
    this.execute(ungroupLayersCommand(l.groupId));
    this.showToast('Ungrouped layers.', 'info');
  }

  applyTemplate(w: number, h: number, name: string): void {
    this.newTab(w, h, name);
  }

  togglePanelVisible(id: string): void {
    const cur = this.state.panelVisible[id] !== false;
    this.store.setState({ panelVisible: { ...this.state.panelVisible, [id]: !cur } });
  }

  toggleGrid(): void {
    this.store.setState({ grid: !this.state.grid });
    this.persistPrefs();
  }

  toggleTileMode(): void {
    const s = this.state;
    const next: TileMode = s.tileMode === 'none' ? s.lastTileAxis : 'none';
    this.store.setState({
      tileMode: next,
      announcement: next === 'none' ? 'Repeat tile mode off' : `Repeat tile mode ${next.toUpperCase()}`,
    });
  }

  setTileMode(mode: TileMode): void {
    this.store.setState({
      tileMode: mode,
      ...(mode !== 'none' ? { lastTileAxis: mode } : {}),
    });
  }

  setViewMode(mode: 'sprite' | 'map'): void {
    const s = this.state;
    if (s.viewMode === mode) return;
    if (mode === 'map' && s.floating) this.commitFloating();
    this.store.setState({ viewMode: mode, playing: mode === 'map' ? false : s.playing });
  }

  getActiveMapLayer(): TileMapLayer {
    const s = this.state;
    return s.doc.tilemap.layers.find((l) => l.id === s.activeMapLayerId) ?? s.doc.tilemap.layers[0];
  }

  captureTileFromSelection(): boolean {
    const s = this.state;
    const bounds = s.selection ? maskBounds(s.selection) : null;
    const x = bounds ? bounds.x : 0;
    const y = bounds ? bounds.y : 0;
    const { tile, duplicateIndex } = captureTileFromDoc(
      s.doc,
      x,
      y,
      s.activeFrame,
      s.captureCategory,
    );
    if (duplicateIndex !== null) {
      this.store.setState({ activeTileIndex: duplicateIndex + 1 });
      this.showToast(`Duplicate tile already exists (#${duplicateIndex + 1}).`, 'error');
      return false;
    }
    this.execute(addTileCommand(tile));
    this.store.setState({ activeTileIndex: this.state.doc.tileset.tiles.length });
    this.showToast(`Added ${tile.name} (${s.doc.tileset.tileW}×${s.doc.tileset.tileH}, linked).`, 'info');
    return true;
  }

  toggleRestrictToPalette(): void {
    this.store.setState({ restrictToPalette: !this.state.restrictToPalette });
    this.persistPrefs();
  }

  togglePanelCollapsed(id: string): void {
    const next = { ...this.state.collapsed, [id]: !this.state.collapsed[id] };
    this.store.setState({ collapsed: next });
    this.persistPrefs();
  }

  toggleTimeline(): void {
    this.store.setState({ timelineOpen: !this.state.timelineOpen });
    this.persistPrefs();
  }

  persistPrefs(): void {
    const s = this.state;
    saveUiPrefs({
      grid: s.grid,
      collapsed: s.collapsed,
      timelineOpen: s.timelineOpen,
      restrictToPalette: s.restrictToPalette,
      onion: s.onion,
      sideWidth: s.sideWidth,
      timelineHeight: s.timelineHeight,
      app: s.appPrefs,
    });
  }

  updateAppPrefs(patch: Partial<AppPreferences>): void {
    const prev = this.state.appPrefs;
    const next: AppPreferences = { ...prev, ...patch };
    const statePatch: Partial<AppState> = { appPrefs: next };
    if (patch.pixelPerfectDefault !== undefined) statePatch.pixelPerfect = next.pixelPerfectDefault;
    if (patch.moveWrapDefault !== undefined) statePatch.moveWrap = next.moveWrapDefault;
    if (patch.grabSampleDefault !== undefined) statePatch.grabSampleSource = next.grabSampleDefault;
    this.store.setState(statePatch);
    applyAppPreferencesToDom(next);

    if (patch.maxUndoSteps !== undefined || patch.maxHistoryMb !== undefined) {
      const maxBytes = next.maxHistoryMb * 1024 * 1024;
      for (const tab of this.tabs) tab.history.setLimits(next.maxUndoSteps, maxBytes);
    }
    if (patch.autosaveSeconds !== undefined && this.autosaveTimer) {
      this.restartAutosaveTimer();
    }
    this.persistPrefs();
  }

  resetAppPrefs(): void {
    this.updateAppPrefs({ ...DEFAULT_APP_PREFS });
    this.showToast('Preferences reset to defaults.', 'info');
  }

  exportAppPrefsJson(): string {
    return JSON.stringify({ app: 'tintbox', prefsVersion: 1, preferences: this.state.appPrefs }, null, 2);
  }

  importAppPrefsJson(jsonText: string): boolean {
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const raw = parsed && typeof parsed === 'object' && 'preferences' in parsed ? parsed.preferences : parsed;
      const clean = sanitizeAppPreferences(raw);
      if (Object.keys(clean).length === 0) {
        this.showToast('No valid preferences found in file.', 'error');
        return false;
      }
      this.updateAppPrefs(clean);
      this.showToast('Imported preferences.', 'info');
      return true;
    } catch {
      this.showToast('Invalid preferences JSON file.', 'error');
      return false;
    }
  }

  bindCrossTabPrefsSync(): () => void {
    if (typeof window === 'undefined') return () => {};
    const onStorage = (e: StorageEvent) => {
      if (e.key !== PREFS_KEY) return;
      const loaded = loadUiPrefs();
      if (!loaded.app) return;
      const next: AppPreferences = { ...DEFAULT_APP_PREFS, ...loaded.app };
      this.store.setState({ appPrefs: next });
      applyAppPreferencesToDom(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }

  // ---- Selection Slices (Alt+K) ----

  createSliceFromSelection(name?: string): SelectionSlice | null {
    const s = this.state;
    const bounds = s.selection ? maskBounds(s.selection) : { x: 0, y: 0, w: s.doc.w, h: s.doc.h };
    if (!bounds) return null;
    const count = (s.doc.slices?.length ?? 0) + 1;
    const slice: SelectionSlice = {
      id: uid(),
      name: name?.trim() || `Slice ${count}`,
      layerId: s.activeLayerId,
      rect: { ...bounds },
    };
    this.execute(addSliceCommand(slice));
    const nextCollapsed = { ...this.state.collapsed, slices: false };
    this.store.setState({ activeSliceId: slice.id, collapsed: nextCollapsed });
    this.showToast(`Created slice "${slice.name}" (${bounds.w}×${bounds.h}).`, 'info');
    return slice;
  }

  selectSlice(sliceId: string, mode: SelectionMode = 'replace'): void {
    const s = this.state;
    const sl = s.doc.slices?.find((x) => x.id === sliceId);
    if (!sl) return;
    const mask = rectMask(
      s.doc.w,
      s.doc.h,
      { x: sl.rect.x, y: sl.rect.y },
      { x: sl.rect.x + sl.rect.w - 1, y: sl.rect.y + sl.rect.h - 1 },
    );
    const merged = combineMasks(s.selection, mask, mode);
    this.setSelectionWithUndo(merged, `Select slice "${sl.name}"`);
    this.store.setState({ activeSliceId: sl.id });
  }

  removeSlice(sliceId: string): void {
    this.execute(removeSliceCommand(sliceId));
    if (this.state.activeSliceId === sliceId) this.store.setState({ activeSliceId: null });
  }

  renameSlice(sliceId: string, name: string): void {
    if (!name.trim()) return;
    this.execute(renameSliceCommand(sliceId, name));
  }

  bindModifierToSlice(scope: 'layer' | 'doc', layerId: string | null, modId: string, sliceId: string): void {
    const s = this.state;
    const sl = s.doc.slices?.find((x) => x.id === sliceId);
    if (!sl) return;
    const list = scope === 'doc' ? s.doc.modifiers : s.doc.layers.find((l) => l.id === layerId)?.modifiers;
    const mod = list?.find((m) => m.id === modId);
    if (!mod) return;
    const mask = rectMask(
      s.doc.w,
      s.doc.h,
      { x: sl.rect.x, y: sl.rect.y },
      { x: sl.rect.x + sl.rect.w - 1, y: sl.rect.y + sl.rect.h - 1 },
    );
    const before = cloneModifier(mod);
    const after = cloneModifier(mod);
    after.mask = { w: mask.w, h: mask.h, bits: mask.bits.slice() };
    this.execute(updateModifierCommand(scope, layerId, before, after, `Bind ${mod.type} to slice "${sl.name}"`));
    this.showToast(`Bound ${mod.type} to slice "${sl.name}".`, 'info');
  }

  exportAllSlicesZip(scale = 1): boolean {
    const s = this.state;
    const slices = s.doc.slices ?? [];
    if (slices.length === 0) {
      this.showToast('No selection slices to export. Press Alt+K to create one.', 'info');
      return false;
    }
    try {
      const zip = exportSlicesZipBytes(s.doc, s.activeFrame, { scale });
      triggerDownload(zip, 'application/zip', `tintbox_slices_${scale}x.zip`);
      this.showToast(`Exported ${slices.length} slice${slices.length === 1 ? '' : 's'} as ZIP.`, 'info');
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Slice export failed.', 'error');
      return false;
    }
  }

  // ---- Batch Smart Commands (Alt+O / Alt+S / Alt+A / Alt+T) ----

  autoOrganizeTilesAction(): boolean {
    const layer = this.ensureEditableLayer();
    if (!layer) return false;
    const s = this.state;
    const cel = this.getActiveCel();
    const before = cel.slice();
    const { tileW, tileH } = s.doc.tileset;
    const res = autoOrganizeTiles(before, s.doc.w, s.doc.h, tileW, tileH);
    if (res.placed === 0) {
      this.showToast('No pixel islands found on active layer.', 'info');
      return false;
    }
    cel.set(res.data);
    this.commitCelChange(before, `Auto organize ${res.placed} tiles`);
    this.showToast(`Organized ${res.placed} island${res.placed === 1 ? '' : 's'} into ${tileW}×${tileH} grid.`, 'info');
    return true;
  }

  autoSliceAction(): number {
    const layer = this.getActiveLayer();
    const s = this.state;
    const src = layer.kind === 'pixel' ? composeLayerOnly(s.doc, layer, s.activeFrame) : this.getComposed(s.activeFrame);
    const { tileW, tileH } = s.doc.tileset;
    const rects = detectPixelIslands(src, s.doc.w, s.doc.h, {
      connectivity: 8,
      snapGrid: { w: tileW, h: tileH },
    });
    if (rects.length === 0) {
      this.showToast('No pixel islands detected to slice.', 'info');
      return 0;
    }
    const baseIdx = s.doc.slices?.length ?? 0;
    const slices: SelectionSlice[] = rects.map((r, i) => ({
      id: uid(),
      name: `Slice ${baseIdx + i + 1}`,
      layerId: layer.id,
      rect: r,
    }));
    this.execute(addSlicesBatchCommand(slices, `Auto slice (${slices.length})`));
    this.store.setState({ collapsed: { ...this.state.collapsed, slices: false }, activeSliceId: slices[0].id });
    this.showToast(`Created ${slices.length} grid-aligned slice${slices.length === 1 ? '' : 's'}.`, 'info');
    return slices.length;
  }

  sliceAndAnimateAction(): boolean {
    const s = this.state;
    const layer = this.getActiveLayer();
    const src = layer.kind === 'pixel' ? composeLayerOnly(s.doc, layer, s.activeFrame) : this.getComposed(s.activeFrame);
    const layerSlices = (s.doc.slices ?? []).filter((sl) => sl.layerId === layer.id);
    const allSlices = layerSlices.length > 0 ? layerSlices : (s.doc.slices ?? []);
    const regions = allSlices.length > 0
      ? allSlices.map((sl) => sl.rect)
      : detectPixelIslands(src, s.doc.w, s.doc.h, { connectivity: 8 });
    if (regions.length === 0) {
      this.showToast('Draw pixel islands or create slices before running Slice & Animate.', 'info');
      return false;
    }
    const animDoc = buildAnimatedDocFromRegions(s.doc, src, regions, `${layer.name} Anim`);
    this.beforeToolChange?.();
    if (this.state.floating) this.commitFloating();
    this.syncActiveTabFromStore();
    const tab = this.createTabSession(animDoc, `${layer.name} (${regions.length}f)`, false);
    this.tabs.push(tab);
    this.activateTab(tab);
    if (!this.state.timelineOpen) this.store.setState({ timelineOpen: true });
    this.showToast(`Created ${regions.length}-frame animation tab (${animDoc.w}×${animDoc.h}).`, 'info');
    return true;
  }

  createMapTilesetAction(): number {
    const s = this.state;
    const composed = this.getComposed(s.activeFrame);
    const { tileW, tileH } = s.doc.tileset;
    const scanned = scanOccupiedGridCells(composed, s.doc.w, s.doc.h, tileW, tileH);
    if (scanned.length === 0) {
      this.showToast(`No non-empty ${tileW}×${tileH} cells found on canvas.`, 'info');
      return 0;
    }
    const tiles: TileDef[] = scanned.map((c, idx) => ({
      id: uid(),
      name: `Tile ${idx + 1}`,
      category: s.captureCategory,
      pixels: c.pixels,
      hash: c.hash,
      linked: true,
      source: { x: c.x, y: c.y, frame: s.activeFrame },
    }));
    this.execute(replaceTilesetCommand(tiles, `Create map tileset (${tiles.length})`));
    this.store.setState({
      activeTileIndex: 1,
      collapsed: { ...this.state.collapsed, tiles: false },
    });
    this.showToast(`Created tileset with ${tiles.length} unique ${tileW}×${tileH} tile${tiles.length === 1 ? '' : 's'}.`, 'info');
    return tiles.length;
  }

  // ---- Map Builder Tile Transforms (Alt+[ / Alt+] / Alt+H / Alt+V) ----

  rotateMapTile(delta: 1 | -1): void {
    const next = ((this.state.mapTileRot + delta + 4) % 4) as TileRotation;
    this.store.setState({ mapTileRot: next });
  }

  flipMapTileH(): void {
    this.store.setState({ mapTileFlipH: !this.state.mapTileFlipH });
  }

  flipMapTileV(): void {
    this.store.setState({ mapTileFlipV: !this.state.mapTileFlipV });
  }

  resetMapTileTransform(): void {
    this.store.setState({ mapTileRot: 0, mapTileFlipH: false, mapTileFlipV: false });
  }

  setPanelSizes(patch: { sideWidth?: number; timelineHeight?: number }): void {
    const next: Partial<AppState> = {};
    if (patch.sideWidth !== undefined) next.sideWidth = Math.max(220, Math.min(480, Math.round(patch.sideWidth)));
    if (patch.timelineHeight !== undefined) next.timelineHeight = Math.max(96, Math.min(360, Math.round(patch.timelineHeight)));
    this.store.setState(next);
    this.persistPrefs();
  }

  toggleTileGridOverlay(): void {
    this.store.setState({ tileGridOverlay: !this.state.tileGridOverlay });
  }

  clearActiveRegion(): void {
    if (this.state.floating) {
      this.cancelFloating();
      return;
    }
    const layer = this.ensureEditableLayer();
    if (!layer) return;
    const s = this.state;
    const cel = this.getActiveCel();
    const before = cel.slice();
    clearSelection(cel, s.doc.w, s.doc.h, s.selection, layer.alphaLock);
    this.commitCelChange(before, s.selection ? 'Clear selection' : 'Clear layer cel');
  }

  transformActiveRegion(kind: 'flip-h' | 'flip-v' | 'rot-cw' | 'rot-ccw'): void {
    const s = this.state;
    const targets = this.getSelectedEditableLayers().filter((l) => l.kind === 'pixel');
    if (targets.length === 0) {
      this.ensureEditableLayer();
      return;
    }
    const labels: Record<typeof kind, string> = {
      'flip-h': 'Flip horizontal',
      'flip-v': 'Flip vertical',
      'rot-cw': 'Rotate 90° CW',
      'rot-ccw': 'Rotate 90° CCW',
    };
    const beforeCels: { layerId: string; frame: number; before: Uint8ClampedArray }[] = [];
    for (const layer of targets) {
      const fIdx = getLayerCelIndex(layer, s.activeFrame);
      const cel = layer.cels[fIdx];
      if (!cel) continue;
      beforeCels.push({ layerId: layer.id, frame: fIdx, before: cel.slice() });
      const next =
        kind === 'flip-h'
          ? flipCelPixels(cel, s.doc.w, s.doc.h, 'h', s.selection)
          : kind === 'flip-v'
            ? flipCelPixels(cel, s.doc.w, s.doc.h, 'v', s.selection)
            : rotateCelPixels90(cel, s.doc.w, s.doc.h, kind === 'rot-cw' ? 'cw' : 'ccw', s.selection);
      cel.set(next);
    }
    this.commitMultiLayerChange(beforeCels, [], labels[kind]);
  }

  applyWarp(params: WarpParams): boolean {
    const layer = this.ensureEditableLayer();
    if (!layer) return false;
    const s = this.state;
    const cel = this.getActiveCel();
    const before = cel.slice();
    const warped = warpCelPixels(cel, s.doc.w, s.doc.h, params, s.selection);
    if (layer.alphaLock) {
      for (let i = 0; i < cel.length; i += 4) {
        if (before[i + 3] === 0) {
          warped[i] = 0;
          warped[i + 1] = 0;
          warped[i + 2] = 0;
          warped[i + 3] = 0;
        }
      }
    }
    cel.set(warped);
    const changed = this.commitCelChange(before, `Warp (${params.preset})`);
    if (changed) this.showToast(`Applied ${params.preset} warp.`, 'info');
    return changed;
  }

  bakeJuiceAnimation(params: JuiceParams): boolean {
    const layer = this.ensureEditableLayer();
    if (!layer) return false;
    const s = this.state;
    const src = this.getActiveCel().slice();
    const generated = generateJuiceFrames(src, s.doc.w, s.doc.h, params, s.selection);
    const frameMs = Math.round(1000 / Math.max(1, params.fps));
    const presetMeta = JUICE_PRESETS.find((p) => p.id === params.preset);
    const animName = `Juice: ${presetMeta?.label ?? params.preset}`;
    this.execute(bakeJuiceAnimationCommand(layer.id, s.activeFrame, generated, frameMs, animName));
    this.store.setState({ timelineOpen: true });
    this.showToast(`Baked ${generated.length} Juice FX frames (${params.fps} fps).`, 'info');
    return true;
  }

  async importImageAsPixelLayer(blob: Blob, name = 'Imported image'): Promise<void> {
    try {
      const img = await decodeImageBlob(blob);
      const { doc } = this.state;
      const fitted = fitImageToCanvas(img.pixels, img.w, img.h, doc.w, doc.h);
      this.execute(addImagePixelLayerCommand(name, fitted));
      this.showToast(`Imported "${name}" as pixel layer (${img.w}×${img.h}).`, 'info');
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Failed to import image layer.', 'error');
    }
  }

  async openImageAsCanvas(blob: Blob, name = 'Image'): Promise<void> {
    try {
      const img = await decodeImageBlob(blob);
      const w = Math.max(1, Math.min(MAX_DIM, img.w));
      const hVal = Math.max(1, Math.min(MAX_DIM, img.h));
      const doc = createDoc(w, hVal);
      const fitted = fitImageToCanvas(img.pixels, img.w, img.h, w, hVal);
      doc.layers[0].name = name;
      doc.layers[0].cels[0].set(fitted);
      this.replaceDoc(doc, `Opened "${name}" as ${w}×${hVal} canvas.`, false);
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Failed to open image.', 'error');
    }
  }

  async importReferenceBlob(blob: Blob, name = 'Reference'): Promise<void> {
    try {
      const img = await decodeImageBlob(blob);
      const { doc } = this.state;
      const scale = Math.min(doc.w / img.w, doc.h / img.h);
      const x = Math.round((doc.w - img.w * scale) / 2);
      const y = Math.round((doc.h - img.h * scale) / 2);
      const ref: ReferenceImage = {
        dataUrl: img.dataUrl,
        w: img.w,
        h: img.h,
        x,
        y,
        scale: Number(scale.toFixed(3)),
        smooth: false,
        flipX: false,
        flipY: false,
        pixels: img.pixels,
      };
      this.execute(addReferenceLayerCommand(name, ref));

      const totalRefBytes = this.state.doc.layers.reduce((sum, l) => sum + (l.ref ? l.ref.dataUrl.length : 0), 0);
      if (totalRefBytes > REF_SIZE_WARN_BYTES) {
        this.showToast('Reference images exceed 20 MB. Consider downscaling to keep saves small.', 'error');
      } else {
        this.showToast(`Added reference image (${img.w}×${img.h}).`, 'info');
      }
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Failed to import reference image.', 'error');
    }
  }

  recolorCanvasToPalette(colors: RGBA[], dither: boolean): void {
    const layer = this.ensureEditableLayer();
    if (!layer || colors.length === 0) return;
    const s = this.state;
    const cel = this.getActiveCel();
    const before = cel.slice();
    const next = remapToPalette(cel, s.doc.w, s.doc.h, colors, {
      dither,
      mask: s.selection,
      alphaLock: layer.alphaLock,
    });
    cel.set(next);
    if (this.commitCelChange(before, 'Recolor to palette')) {
      this.showToast('Recolored canvas to palette.', 'info');
    } else {
      this.showToast('Canvas already matches palette.', 'info');
    }
  }

  openOrphanCleaner(): void {
    if (this.getActiveLayer().kind === 'reference') {
      this.showToast('Select a pixel layer to clean orphan pixels.', 'error');
      return;
    }
    this.store.setState({ orphanOpen: true });
    this.refreshOrphanPreview();
  }

  closeOrphanCleaner(): void {
    if (!this.state.orphanOpen) return;
    this.store.setState({ orphanOpen: false, orphanPreview: [] });
  }

  updateOrphanOpts(patch: Partial<OrphanPanelOpts>): void {
    this.store.setState({ orphanOpts: { ...this.state.orphanOpts, ...patch } });
    this.refreshOrphanPreview();
  }

  refreshOrphanPreview(): void {
    const s = this.state;
    const layer = this.getActiveLayer();
    if (layer.kind === 'reference') {
      this.store.setState({ orphanPreview: [] });
      return;
    }
    const cel = layer.cels[s.activeFrame];
    if (!cel) {
      this.store.setState({ orphanPreview: [] });
      return;
    }
    const pts = findOrphans(cel, s.doc.w, s.doc.h, {
      connectivity: s.orphanOpts.connectivity,
      minClusterSize: s.orphanOpts.minClusterSize,
      mask: s.selection,
    });
    this.store.setState({ orphanPreview: pts });
  }

  applyOrphanCleanup(): void {
    const layer = this.ensureEditableLayer();
    if (!layer) return;
    const s = this.state;
    const { connectivity, minClusterSize, action, scope } = s.orphanOpts;
    const frames = scope === 'layer-frames' ? Array.from({ length: s.doc.frames.length }, (_, i) => i) : [s.activeFrame];
    const patches: { frame: number; diff: PixelDiff }[] = [];
    let totalCleaned = 0;

    for (const f of frames) {
      const before = layer.cels[f];
      if (!before) continue;
      const res = removeOrphans(before, s.doc.w, s.doc.h, {
        connectivity,
        minClusterSize,
        action,
        mask: s.selection,
      });
      if (res.count === 0) continue;
      const diff = computeDiff(before, res.data, s.doc.w, s.doc.h);
      if (diff) {
        patches.push({ frame: f, diff });
        totalCleaned += res.count;
      }
    }

    if (patches.length === 0) {
      this.showToast('0 orphans found.', 'info');
      this.closeOrphanCleaner();
      return;
    }

    if (patches.length === 1) {
      this.execute(pixelPatchCommand(layer.id, patches[0].frame, patches[0].diff, 'Clean orphan pixels'));
    } else {
      this.execute(multiFramePixelPatchCommand(layer.id, patches, 'Clean orphan pixels'));
    }
    this.closeOrphanCleaner();
    this.showToast(`${totalCleaned} orphan${totalCleaned === 1 ? '' : 's'} cleaned.`, 'info');
  }

  selectAllAction(): void {
    const s = this.state;
    this.setSelectionWithUndo(selectAll(s.doc.w, s.doc.h), 'Select all');
  }

  deselectAction(): void {
    if (this.state.floating) this.cancelFloating();
    this.setSelectionWithUndo(null, 'Deselect');
  }

  invertSelectionAction(): void {
    const s = this.state;
    const next = s.selection ? invertMask(s.selection) : selectAll(s.doc.w, s.doc.h);
    this.setSelectionWithUndo(next, 'Invert selection');
  }

  copySelection(): void {
    const layer = this.getActiveLayer();
    if (layer.kind === 'reference') {
      this.showToast('Cannot copy pixels from a reference layer.', 'error');
      return;
    }
    const s = this.state;
    const ext = extractSelection(this.getActiveCel(), s.doc.w, s.doc.h, s.selection);
    if (!ext) {
      this.showToast('Nothing to copy.', 'info');
      return;
    }
    this.store.setState({ clipboard: ext });
    this.showToast('Copied selection.', 'info');
  }

  cutSelection(): void {
    const layer = this.ensureEditableLayer();
    if (!layer) return;
    const s = this.state;
    const cel = this.getActiveCel();
    const ext = extractSelection(cel, s.doc.w, s.doc.h, s.selection);
    if (!ext) return;
    this.store.setState({ clipboard: ext });
    const before = cel.slice();
    clearSelection(cel, s.doc.w, s.doc.h, s.selection, layer.alphaLock);
    this.commitCelChange(before, 'Cut selection');
  }

  pasteClipboard(): void {
    const layer = this.ensureEditableLayer();
    if (!layer) return;
    const s = this.state;
    if (!s.clipboard) {
      this.showToast('Clipboard is empty.', 'info');
      return;
    }
    if (s.floating) this.commitFloating();
    const center = screenToDoc(s.viewport, this.stageSize.w / 2, this.stageSize.h / 2);
    const offsetX = Math.round(center.x - s.clipboard.rect.w / 2);
    const offsetY = Math.round(center.y - s.clipboard.rect.h / 2);
    this.store.setState({
      floating: {
        rect: { ...s.clipboard.rect },
        pixels: s.clipboard.pixels.slice(),
        maskBits: s.clipboard.maskBits.slice(),
        offsetX,
        offsetY,
      },
      tool: 'move',
      announcement: 'Pasted floating layer. Press Enter to commit or Escape to cancel.',
    });
  }

  commitFloating(): boolean {
    const s = this.state;
    if (!s.floating) return false;
    const layer = this.ensureEditableLayer();
    if (!layer) return false;
    const cel = this.getActiveCel();
    const before = cel.slice();
    stampBuffer(cel, s.doc.w, s.doc.h, s.floating.pixels, s.floating.rect, s.floating.offsetX, s.floating.offsetY, {
      maskBits: s.floating.maskBits,
      alphaLock: layer.alphaLock,
    });
    this.store.setState({ floating: null });
    this.commitCelChange(before, 'Paste');
    return true;
  }

  cancelFloating(): void {
    if (!this.state.floating) return;
    this.store.setState({ floating: null, announcement: 'Paste canceled' });
  }

  nudge(dx: number, dy: number): void {
    const s = this.state;
    if (s.floating) {
      this.store.setState({
        floating: {
          ...s.floating,
          offsetX: s.floating.offsetX + dx,
          offsetY: s.floating.offsetY + dy,
        },
      });
      return;
    }
    const targets = this.getSelectedEditableLayers();
    if (targets.length === 0) {
      this.ensureEditableLayer();
      return;
    }
    const beforeCels: { layerId: string; frame: number; before: Uint8ClampedArray }[] = [];
    const refPatches: LayerRefPatch[] = [];
    for (const layer of targets) {
      if (layer.kind === 'reference' && layer.ref) {
        refPatches.push({
          layerId: layer.id,
          beforeX: layer.ref.x,
          beforeY: layer.ref.y,
          afterX: layer.ref.x + dx,
          afterY: layer.ref.y + dy,
        });
        layer.ref.x += dx;
        layer.ref.y += dy;
      } else if (layer.kind === 'pixel') {
        const fIdx = getLayerCelIndex(layer, s.activeFrame);
        const cel = layer.cels[fIdx];
        if (!cel) continue;
        beforeCels.push({ layerId: layer.id, frame: fIdx, before: cel.slice() });
        const moved = moveCelPixels(cel, s.doc.w, s.doc.h, dx, dy, {
          mask: s.selection,
          wrap: s.moveWrap,
        });
        cel.set(moved);
      }
    }
    this.commitMultiLayerChange(beforeCels, refPatches, targets.length > 1 ? `Nudge ${targets.length} layers` : 'Nudge');
  }

  isDirty(): boolean {
    return this.state.docRev !== this.state.savedRev;
  }

  private replaceDoc(doc: Doc, message: string, markClean = true): void {
    this.history.clear();
    this.frameCache.clear();
    const z = fitZoom(this.stageSize.w, this.stageSize.h, doc.w, doc.h, 16);
    const nextRev = this.state.docRev + 1;
    const savedRev = markClean ? nextRev : this.state.savedRev;
    this.lastAutosavedRev = nextRev;
      this.store.setState({
      doc,
      docRev: nextRev,
      savedRev,
      frameRevs: Array.from({ length: doc.frames.length }, () => 1),
      activeLayerId: doc.layers[0].id,
      activeFrame: 0,
      activeAnimationId: null,
      selection: null,
      floating: null,
      orphanOpen: false,
      orphanPreview: [],
      soloModifier: null,
      symmetry: defaultSymmetry(doc.w, doc.h),
      viewport: centerViewport(this.stageSize.w, this.stageSize.h, doc.w, doc.h, z),
      historyRev: this.state.historyRev + 1,
      playing: false,
      viewMode: 'sprite',
      activeTileIndex: doc.tileset.tiles.length > 0 ? 1 : 0,
      activeMapLayerId: doc.tilemap.layers[0]?.id ?? '',
    });
    this.publishTabs();
    this.showToast(message, 'info');
  }

  newDocument(w: number, h: number): void {
    try {
      const doc = createDoc(w, h);
      this.replaceDoc(doc, `Created ${w}x${h} canvas.`, true);
      void clearAutosaveDraft();
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Invalid canvas size.', 'error');
    }
  }

  async saveProject(): Promise<boolean> {
    try {
      const tab = this.getActiveTab();
      const suggested = tab.name.endsWith('.tintbox') ? tab.name : `${tab.name.replace(/\.[^.]+$/, '')}.tintbox`;
      const saved = await saveTintboxFile(this.state.doc, suggested || this.projectName);
      if (!saved) return false;
      this.lastAutosavedRev = this.state.docRev;
      this.store.setState({ savedRev: this.state.docRev });
      this.publishTabs();
      void clearAutosaveDraft();
      this.showToast('Saved project (.tintbox).', 'info');
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Save failed.', 'error');
      return false;
    }
  }

  async openProject(): Promise<boolean> {
    try {
      const picked = await pickTintboxFile();
      if (!picked) return false;
      return this.loadProjectBytes(picked.bytes, {
        name: picked.name.replace(/\.(tintbox|psd|aseprite|ase|gif)$/i, ''),
        inNewTab: this.isDirty(),
      });
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Open failed.', 'error');
      return false;
    }
  }

  loadProjectBytes(
    bytes: Uint8Array,
    opts: { markClean?: boolean; message?: string; name?: string; inNewTab?: boolean } = {},
  ): boolean {
    try {
      const isAse = isAsepriteBytes(bytes);
      const isGif = !isAse && isGifBytes(bytes);
      const isPsd = !isAse && !isGif && isPsdBytes(bytes);
      const doc = isAse
        ? decodeAseprite(bytes)
        : isGif
          ? decodeAnimatedGif(bytes)
          : isPsd
            ? decodePsd(bytes)
            : deserializeTintboxArchive(bytes);
      const markClean = opts.markClean ?? true;
      const defaultMsg = isAse
        ? `Opened Aseprite (${doc.w}×${doc.h}, ${doc.layers.length} layers, ${doc.frames.length}f).`
        : isGif
          ? `Opened GIF (${doc.w}×${doc.h}, ${doc.frames.length} frame${doc.frames.length === 1 ? '' : 's'}).`
          : isPsd
            ? `Opened Photoshop PSD (${doc.w}×${doc.h}, ${doc.layers.length} layers).`
            : `Opened ${doc.w}×${doc.h} project.`;

      if (opts.inNewTab) {
        this.beforeToolChange?.();
        if (this.state.floating) this.commitFloating();
        this.syncActiveTabFromStore();
        const fallbackPrefix = isAse ? 'Aseprite' : isGif ? 'GIF' : isPsd ? 'PSD' : 'Project';
        const label = opts.name?.trim() || `${fallbackPrefix} ${this.tabSeq + 1}`;
        const tab = this.createTabSession(doc, label, markClean);
        this.tabs.push(tab);
        this.activateTab(tab);
        this.showToast(opts.message ?? defaultMsg, 'info');
      } else {
        if (opts.name?.trim()) this.getActiveTab().name = opts.name.trim();
        this.replaceDoc(doc, opts.message ?? defaultMsg, markClean);
      }
      if (doc.frames.length > 1 && !this.state.timelineOpen) {
        this.store.setState({ timelineOpen: true });
      }
      if (markClean) void clearAutosaveDraft();
      return true;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Could not open project file.', 'error');
      return false;
    }
  }

  private restartAutosaveTimer(): void {
    if (typeof window === 'undefined') return;
    if (this.autosaveTimer) {
      window.clearInterval(this.autosaveTimer);
      this.autosaveTimer = 0;
    }
    const sec = this.state.appPrefs.autosaveSeconds;
    if (sec <= 0) return;
    this.autosaveTimer = window.setInterval(() => {
      if (!this.isDirty()) return;
      if (this.state.docRev === this.lastAutosavedRev) return;
      try {
        const bytes = serializeTintboxArchive(this.state.doc);
        this.lastAutosavedRev = this.state.docRev;
        void saveAutosaveDraft(bytes);
      } catch {
        // Autosave errors must never interrupt editing.
      }
    }, sec * 1000);
  }

  startAutosave(): () => void {
    if (typeof window === 'undefined') return () => {};
    this.restartAutosaveTimer();
    return () => {
      if (this.autosaveTimer) {
        window.clearInterval(this.autosaveTimer);
        this.autosaveTimer = 0;
      }
    };
  }

  checkAutosaveDraft(): Promise<AutosaveDraft | null> {
    return loadAutosaveDraft();
  }

  recoverAutosave(draft: AutosaveDraft): boolean {
    return this.loadProjectBytes(draft.bytes, { markClean: false, message: 'Recovered autosaved draft.' });
  }

  discardAutosave(): Promise<void> {
    return clearAutosaveDraft();
  }

  resizeCanvas(newW: number, newH: number, anchor: Anchor9): void {
    try {
      this.execute(resizeCanvasCommand(newW, newH, anchor));
      const s = this.state;
      this.store.setState({ symmetry: defaultSymmetry(s.doc.w, s.doc.h) });
      this.zoomFit();
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Resize failed.', 'error');
    }
  }

  scaleCanvas(newW: number, newH: number, algorithm: ResampleAlgorithm = 'nearest'): void {
    try {
      this.execute(scaleCanvasCommand(newW, newH, algorithm));
      const s = this.state;
      this.store.setState({ symmetry: defaultSymmetry(s.doc.w, s.doc.h) });
      this.zoomFit();
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : 'Scale failed.', 'error');
    }
  }

  showToast(text: string, kind: 'info' | 'error' = 'info'): void {
    const id = ++this.toastSeq;
    this.store.setState({ toast: { id, text, kind }, announcement: text });
    if (typeof window !== 'undefined') {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => {
        if (this.state.toast?.id === id) this.store.setState({ toast: null });
      }, kind === 'error' ? 4500 : 2800);
    }
  }

  cloneSelection(): SelectionMask | null {
    return this.state.selection ? cloneMask(this.state.selection) : null;
  }
}
