import { DITHER_PATTERNS, type DitherGradientStop, type DitherPattern } from '../core/dither';
import { getActivePalette, newModifier } from '../core/doc';
import { hexToRgba, rgbaToHex } from '../core/palette';
import { SHAPE_PRESETS } from '../core/shapes';
import type { SymmetryMode } from '../core/types';
import { WARP_PRESETS, type WarpPreset } from '../core/warp';
import { addModifierCommand } from '../state/commands';
import type { ToolId } from '../state/ui';
import { AppController } from './controller';
import { createDialogs } from './dialogs';
import { h, sliderField, wireToolbarFocusgroup } from './dom';
import { icon, type IconName } from './icons';
import { bindKeymap } from './keymap';
import { createMapStage } from './map-stage';
import { createAppMenubar } from './menubar';
import { createPadDialog } from './pad-dialog';
import { createSidePanels } from './panels';
import { PadClient, PadCmdId, PadMsgType } from '../io/pad-client';
import { createStage } from './stage';
import { createTimeline } from './timeline';

interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> };
}

const TOOL_ORDER: { id: ToolId; icon: IconName }[] = [
  { id: 'pencil', icon: 'pencil' },
  { id: 'dither', icon: 'dither' },
  { id: 'gradient', icon: 'gradient' },
  { id: 'eraser', icon: 'eraser' },
  { id: 'line', icon: 'line' },
  { id: 'curve', icon: 'curve' },
  { id: 'rect', icon: 'rect' },
  { id: 'ellipse', icon: 'ellipse' },
  { id: 'fill', icon: 'fill' },
  { id: 'picker', icon: 'picker' },
  { id: 'select-rect', icon: 'select-rect' },
  { id: 'select-lasso', icon: 'select-lasso' },
  { id: 'select-wand', icon: 'select-wand' },
  { id: 'move', icon: 'move' },
  { id: 'hand', icon: 'hand' },
];

export interface MountedApp {
  ctrl: AppController;
  destroy: () => void;
}

export function mountApp(root: HTMLElement): MountedApp {
  const ctrl = new AppController();
  const dialogs = createDialogs(ctrl);
  const stage = createStage(ctrl);
  const mapStage = createMapStage(ctrl);

  // ---- Android Drawing Pad (near-zero-latency binary WS / Bluetooth SPP) ----
  const padDot = h('span', { class: 'pad-dot' });
  const padLabel = h('span', {}, 'Pad');
  const padPill = h(
    'button',
    {
      type: 'button',
      class: 'pad-pill',
      title: 'Connect Android Drawing Pad (USB / Wi-Fi / Bluetooth)',
      onClick: () => padDlg.open(),
    },
    padDot,
    padLabel,
  );
  const syncDocToPad = () => {
    const s = ctrl.state;
    const pal = getActivePalette(s.doc).colors.slice(0, 16).map((c) => rgbaToHex(c.rgba));
    padClient.sendDocSync({
      w: s.doc.w,
      h: s.doc.h,
      tool: s.tool,
      primaryHex: rgbaToHex(s.primaryColor),
      brushSize: s.brushSize,
      frame: s.activeFrame,
      frameCount: s.doc.frames.length,
      palette: pal,
    });
  };
  const padClient = new PadClient(
    (pkt) => {
      if (pkt.type === PadMsgType.Cmd) {
        switch (pkt.cmdId) {
          case PadCmdId.Undo: ctrl.undo(); break;
          case PadCmdId.Redo: ctrl.redo(); break;
          case PadCmdId.ToolPen: ctrl.setTool('pencil'); break;
          case PadCmdId.ToolEraser: ctrl.setTool('eraser'); break;
          case PadCmdId.ToolPicker: ctrl.setTool('picker'); break;
          case PadCmdId.SwapColors: ctrl.swapColors(); break;
          case PadCmdId.BrushDec: ctrl.stepBrushSize(-1); break;
          case PadCmdId.BrushInc: ctrl.stepBrushSize(1); break;
          case PadCmdId.ToolFill: ctrl.setTool('fill'); break;
          case PadCmdId.ToolLine: ctrl.setTool('line'); break;
          case PadCmdId.ToggleGrid: ctrl.toggleGrid(); break;
          case PadCmdId.ToggleSymX: toggleSymAxis('x'); break;
          case PadCmdId.ToggleOnion: ctrl.toggleOnion(); break;
          case PadCmdId.PrevFrame: {
            const s = ctrl.state;
            const n = s.doc.frames.length;
            ctrl.store.setState({ activeFrame: (s.activeFrame - 1 + n) % n });
            break;
          }
          case PadCmdId.NextFrame: {
            const s = ctrl.state;
            ctrl.store.setState({ activeFrame: (s.activeFrame + 1) % s.doc.frames.length });
            break;
          }
          case PadCmdId.SelectPaletteIndex: {
            const cols = getActivePalette(ctrl.state.doc).colors;
            const entry = cols[pkt.cmdArg];
            if (entry) ctrl.store.setState({ primaryColor: [...entry.rgba] });
            break;
          }
        }
        return;
      }
      stage.injectPadPacket(pkt);
    },
    (st) => {
      padDlg.updateStatus(st);
      const online = st.status === 'connected' && st.padsOnline > 0;
      const waiting = st.status === 'connected' && st.padsOnline === 0;
      padDot.classList.toggle('online', online);
      padDot.classList.toggle('waiting', waiting);
      padLabel.textContent = online
        ? (st.rttMs !== null ? `Pad ${st.rttMs}ms` : 'Pad')
        : waiting
          ? 'Pad…'
          : 'Pad';
      if (st.status === 'connected') {
        syncDocToPad();
        if (online) {
          const s = ctrl.state;
          padClient.sendCanvasFrame(ctrl.getComposed(s.activeFrame), s.doc.w, s.doc.h);
        }
      }
    },
  );
  stage.setFrameSink((rgba, w, h) => {
    if (padClient.isStreamingActive) padClient.sendCanvasFrame(rgba, w, h);
  });
  const padDlg = createPadDialog(ctrl, padClient);
  dialogs.container.append(padDlg.el);
  const unsubPadSync = ctrl.store.subscribe(
    (s) => [s.doc.w, s.doc.h, s.tool, rgbaToHex(s.primaryColor), s.brushSize, s.activeFrame, s.doc.frames.length, s.doc.activePaletteId, s.docRev] as const,
    syncDocToPad,
    (a, b) => a.every((v, i) => v === b[i]),
  );

  // ---- Mobile / Tablet drawer toggle ----
  let drawerOpen = false;
  const setDrawer = (open: boolean) => {
    drawerOpen = open;
    side.classList.toggle('open', open);
    drawerBtn.setAttribute('aria-expanded', String(open));
  };
  const side = createSidePanels(
    ctrl,
    stage.requestRender,
    (preset) => dialogs.openExtractPalette(preset),
    () => setDrawer(false),
  );
  const drawerBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn drawer-toggle',
      'aria-label': 'Toggle inspector panels',
      'aria-expanded': 'false',
      'aria-controls': 'side-panels',
      title: 'Panels',
      onClick: () => setDrawer(!drawerOpen),
    },
    icon('panel'),
  );

  // ---- Top bar ----
  const undoBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Undo',
      'aria-disabled': 'true',
      title: 'Undo (Ctrl+Z)',
      onClick: () => {
        if (undoBtn.getAttribute('aria-disabled') === 'true') return;
        ctrl.undo();
      },
    },
    icon('undo'),
  );
  const redoBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Redo',
      'aria-disabled': 'true',
      title: 'Redo (Ctrl+Shift+Z)',
      onClick: () => {
        if (redoBtn.getAttribute('aria-disabled') === 'true') return;
        ctrl.redo();
      },
    },
    icon('redo'),
  );

  const syncHistoryBtns = () => {
    const canU = ctrl.history.canUndo;
    const canR = ctrl.history.canRedo;
    undoBtn.setAttribute('aria-disabled', String(!canU));
    redoBtn.setAttribute('aria-disabled', String(!canR));
    undoBtn.title = canU ? `Undo: ${ctrl.history.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    redoBtn.title = canR ? `Redo: ${ctrl.history.redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
  };
  syncHistoryBtns();
  ctrl.store.subscribe((s) => s.historyRev, syncHistoryBtns);

  const gridBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Toggle pixel grid',
      'aria-pressed': String(ctrl.state.grid),
      title: 'Pixel grid (#)',
      onClick: () => ctrl.toggleGrid(),
    },
    icon('grid'),
  );

  const orphanBtn = h(
    'button',
    {
      type: 'button',
      'aria-pressed': 'false',
      title: 'Clean orphan pixels (F-ORPHAN)',
      onClick: () => {
        if (ctrl.state.orphanOpen) ctrl.closeOrphanCleaner();
        else ctrl.openOrphanCleaner();
      },
    },
    icon('cleanup', 14),
    ' Orphans',
  );

  const symModeBtn = (mode: 'x' | 'y', iconName: IconName, label: string) =>
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': label,
        'aria-pressed': 'false',
        title: label,
        onClick: () => {
          const cur = ctrl.state.symmetry.mode;
          const hasX = cur === 'x' || cur === 'xy';
          const hasY = cur === 'y' || cur === 'xy';
          const nextX = mode === 'x' ? !hasX : hasX;
          const nextY = mode === 'y' ? !hasY : hasY;
          const next: SymmetryMode = nextX && nextY ? 'xy' : nextX ? 'x' : nextY ? 'y' : 'none';
          ctrl.store.setState({ symmetry: { ...ctrl.state.symmetry, mode: next } });
        },
      },
      icon(iconName),
    );
  const tileBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Toggle repeat tile mode',
      'aria-pressed': 'false',
      title: 'Repeat tile mode (T)',
      onClick: () => ctrl.toggleTileMode(),
    },
    icon('tile'),
  );

  const spriteModeBtn = h(
    'button',
    {
      type: 'button',
      'aria-pressed': 'true',
      title: 'Sprite canvas mode',
      onClick: () => ctrl.setViewMode('sprite'),
    },
    'Sprite',
  );
  const mapModeBtn = h(
    'button',
    {
      type: 'button',
      'aria-pressed': 'false',
      title: 'Tile Map editor mode',
      onClick: () => ctrl.setViewMode('map'),
    },
    icon('map', 14),
    ' Map',
  );

  const symXBtn = symModeBtn('x', 'symX', 'Mirror X symmetry');
  const symYBtn = symModeBtn('y', 'symY', 'Mirror Y symmetry');
  const symLockBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Lock symmetry line',
      'aria-pressed': 'false',
      title: 'Lock symmetrical axis line so it cannot be accidentally dragged',
      onClick: () => ctrl.toggleSymmetryLock(),
    },
    icon('lock'),
  );

  const dirtyDot = h('span', { class: 'dirty-dot', title: 'Unsaved changes', 'aria-label': 'Unsaved changes', hidden: true });

  const addModAction = (type: Parameters<typeof newModifier>[0]) => {
    const s = ctrl.state;
    const mod = newModifier(type);
    const layerId = s.modScope === 'doc' ? null : s.activeLayerId;
    ctrl.execute(addModifierCommand(s.modScope, layerId, mod));
    ctrl.focusModifier(s.modScope, layerId, mod.id);
  };

  const toggleSymAxis = (mode: 'x' | 'y') => {
    const cur = ctrl.state.symmetry.mode;
    const hasX = cur === 'x' || cur === 'xy';
    const hasY = cur === 'y' || cur === 'xy';
    const nextX = mode === 'x' ? !hasX : hasX;
    const nextY = mode === 'y' ? !hasY : hasY;
    const next: SymmetryMode = nextX && nextY ? 'xy' : nextX ? 'x' : nextY ? 'y' : 'none';
    ctrl.store.setState({ symmetry: { ...ctrl.state.symmetry, mode: next } });
  };

  const menubar = createAppMenubar([
    {
      id: 'file',
      label: 'File',
      items: [
        { label: 'New canvas…', shortcut: 'Alt+N', onSelect: () => dialogs.openNew() },
        { label: 'New tab', onSelect: () => ctrl.newTab() },
        { label: 'Open (.tintbox / .aseprite / .psd / .gif)…', shortcut: 'Ctrl+O', onSelect: () => { void ctrl.openProject(); } },
        { label: 'Save (.tintbox)', shortcut: 'Ctrl+S', onSelect: () => { void ctrl.saveProject(); } },
        { separator: true },
        { label: 'Import image / reference…', onSelect: () => dialogs.openImportImage() },
        { label: 'Export (PNG / BMP / PSD / JS / GIF)…', shortcut: 'Ctrl+E', onSelect: () => dialogs.openExport() },
        { separator: true },
        { label: 'Resize canvas bounds…', onSelect: () => dialogs.openResize() },
        { label: 'Image size & upscaler…', onSelect: () => dialogs.openScale() },
        { label: 'Close current tab', onSelect: () => ctrl.closeTab(ctrl.state.activeTabId) },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { label: 'Undo canvas', shortcut: 'Ctrl+Z', disabled: () => !ctrl.history.canUndo, onSelect: () => { ctrl.undo(); } },
        { label: 'Redo canvas', shortcut: 'Ctrl+Shift+Z', disabled: () => !ctrl.history.canRedo, onSelect: () => { ctrl.redo(); } },
        { label: 'Undo palette / settings', disabled: () => !ctrl.settingsHistory.canUndo, onSelect: () => { ctrl.undoSettings(); } },
        { separator: true },
        { label: 'Cut', shortcut: 'Ctrl+X', onSelect: () => ctrl.cutSelection() },
        { label: 'Copy', shortcut: 'Ctrl+C', onSelect: () => ctrl.copySelection() },
        { label: 'Paste floating', shortcut: 'Ctrl+V', onSelect: () => ctrl.pasteClipboard() },
        { label: 'Clear selection / cel', shortcut: 'Del', onSelect: () => ctrl.clearActiveRegion() },
        { separator: true },
        { label: 'Direct-canvas Resize', shortcut: 'Ctrl+T', onSelect: () => { ctrl.setTool('move'); ctrl.store.setState({ moveMode: 'resize' }); } },
        { label: 'Direct-canvas Free Warp', onSelect: () => { ctrl.setTool('move'); ctrl.store.setState({ moveMode: 'warp' }); } },
        { label: 'Warp modal preview…', onSelect: () => dialogs.openWarp() },
        { separator: true },
        { label: 'Flip horizontal', onSelect: () => ctrl.transformActiveRegion('flip-h') },
        { label: 'Flip vertical', onSelect: () => ctrl.transformActiveRegion('flip-v') },
        { label: 'Rotate 90° CW', onSelect: () => ctrl.transformActiveRegion('rot-cw') },
        { label: 'Rotate 90° CCW', onSelect: () => ctrl.transformActiveRegion('rot-ccw') },
        { separator: true },
        { label: 'Group selected layers', shortcut: 'Ctrl+G', onSelect: () => ctrl.groupSelectedLayers() },
        { label: 'Ungroup layer', shortcut: 'Ctrl+Shift+G', onSelect: () => ctrl.ungroupActiveGroup() },
        { label: 'Remove from group', disabled: () => !ctrl.getActiveLayer().groupId, onSelect: () => ctrl.removeActiveFromGroup() },
        { label: 'Clean orphan pixels', onSelect: () => ctrl.openOrphanCleaner() },
      ],
    },
    {
      id: 'layer',
      label: 'Layer',
      items: [
        { label: 'New layer', shortcut: 'Ctrl+Alt+N', onSelect: () => ctrl.newLayer() },
        { label: 'Duplicate layer', shortcut: 'Ctrl+J', onSelect: () => ctrl.duplicateActiveLayer() },
        { label: 'Rename layer', shortcut: 'F2', onSelect: () => ctrl.startRenameLayer() },
        { label: 'Delete layer', disabled: () => ctrl.state.doc.layers.length <= 1, onSelect: () => ctrl.deleteActiveLayer() },
        { separator: true },
        { label: 'Lock layer', checked: () => ctrl.getActiveLayer().locked, onSelect: () => ctrl.toggleActiveLayerFlag('locked') },
        { label: 'Lock transparency', checked: () => ctrl.getActiveLayer().alphaLock, onSelect: () => ctrl.toggleActiveLayerFlag('alphaLock') },
        { label: 'Clipping mask', checked: () => Boolean(ctrl.getActiveLayer().clipped), onSelect: () => ctrl.toggleActiveLayerFlag('clipped') },
        { label: 'Show only this layer', onSelect: () => ctrl.soloActiveLayer() },
        { separator: true },
        { label: 'Bring to front', shortcut: 'Ctrl+Shift+]', onSelect: () => ctrl.moveActiveLayer('top') },
        { label: 'Move up', shortcut: 'Ctrl+]', onSelect: () => ctrl.moveActiveLayer('up') },
        { label: 'Move down', shortcut: 'Ctrl+[', onSelect: () => ctrl.moveActiveLayer('down') },
        { label: 'Send to back', shortcut: 'Ctrl+Shift+[', onSelect: () => ctrl.moveActiveLayer('bottom') },
        { separator: true },
        { label: 'Group selected layers', shortcut: 'Ctrl+G', onSelect: () => ctrl.groupSelectedLayers() },
        { label: 'Ungroup layer', shortcut: 'Ctrl+Shift+G', onSelect: () => ctrl.ungroupActiveGroup() },
        { label: 'Remove from group', disabled: () => !ctrl.getActiveLayer().groupId, onSelect: () => ctrl.removeActiveFromGroup() },
        { separator: true },
        { label: 'Merge down', shortcut: 'Ctrl+Alt+E', onSelect: () => ctrl.mergeDownActive() },
        { label: 'Flatten visible', shortcut: 'Ctrl+Shift+E', onSelect: () => ctrl.flattenVisible() },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { label: 'Zoom in', shortcut: '+', onSelect: () => ctrl.zoomStep(1) },
        { label: 'Zoom out', shortcut: '-', onSelect: () => ctrl.zoomStep(-1) },
        { label: 'Zoom 100%', shortcut: '1', onSelect: () => ctrl.zoom100() },
        { label: 'Fit to viewport', shortcut: '0', onSelect: () => ctrl.zoomFit() },
        { separator: true },
        { label: 'Pixel grid', shortcut: '#', checked: () => ctrl.state.grid, onSelect: () => ctrl.toggleGrid() },
        { label: 'Repeat tile mode', shortcut: 'T', checked: () => ctrl.state.tileMode !== 'none', onSelect: () => ctrl.toggleTileMode() },
        { label: 'Mirror X symmetry', checked: () => ctrl.state.symmetry.mode === 'x' || ctrl.state.symmetry.mode === 'xy', onSelect: () => toggleSymAxis('x') },
        { label: 'Mirror Y symmetry', checked: () => ctrl.state.symmetry.mode === 'y' || ctrl.state.symmetry.mode === 'xy', onSelect: () => toggleSymAxis('y') },
        { label: 'Lock symmetrical line', checked: () => Boolean(ctrl.state.symmetry.locked), onSelect: () => ctrl.toggleSymmetryLock() },
        { separator: true },
        { label: 'Free floating pasteboard', checked: () => ctrl.state.freeCanvas, onSelect: () => ctrl.toggleFreeCanvas() },
        { label: 'Canvas scrollbars & zoom slider', checked: () => ctrl.state.showCanvasScrollbars, onSelect: () => ctrl.store.setState({ showCanvasScrollbars: !ctrl.state.showCanvasScrollbars }) },
        { separator: true },
        { label: 'Sprite canvas view', checked: () => ctrl.state.viewMode === 'sprite', onSelect: () => ctrl.setViewMode('sprite') },
        { label: 'Tile map editor view', checked: () => ctrl.state.viewMode === 'map', onSelect: () => ctrl.setViewMode('map') },
      ],
    },
    {
      id: 'selection',
      label: 'Selection',
      items: [
        { label: 'Select all', shortcut: 'Ctrl+A', onSelect: () => ctrl.selectAllAction() },
        { label: 'Deselect', shortcut: 'Ctrl+D', onSelect: () => ctrl.deselectAction() },
        { label: 'Invert selection', shortcut: 'Ctrl+I', onSelect: () => ctrl.invertSelectionAction() },
        { label: 'Select active layer pixels', shortcut: 'Ctrl+Click', onSelect: () => ctrl.selectLayerTransparency(ctrl.state.activeLayerId) },
        { separator: true },
        { label: 'Create selection slice', shortcut: 'Alt+K', onSelect: () => { ctrl.createSliceFromSelection(); } },
        { label: 'Auto slice islands', shortcut: 'Alt+S', onSelect: () => { ctrl.autoSliceAction(); } },
        { label: 'Export all slices as ZIP', disabled: () => (ctrl.state.doc.slices?.length ?? 0) === 0, onSelect: () => { ctrl.exportAllSlicesZip(ctrl.state.appPrefs.defaultExportScale); } },
        { separator: true },
        { label: 'Add layer mask (from selection)', onSelect: () => ctrl.addLayerMask(true) },
        { label: 'Invert layer mask', disabled: () => !ctrl.getActiveLayer().layerMask, onSelect: () => ctrl.invertLayerMask() },
        { label: 'Apply layer mask', disabled: () => !ctrl.getActiveLayer().layerMask, onSelect: () => ctrl.applyLayerMask() },
        { label: 'Delete layer mask', disabled: () => !ctrl.getActiveLayer().layerMask, onSelect: () => ctrl.removeLayerMask() },
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      items: [
        { label: 'Pencil (0.2–32px)', shortcut: 'B', checked: () => ctrl.state.tool === 'pencil', onSelect: () => ctrl.setTool('pencil') },
        { label: 'Dither brush', shortcut: 'D', checked: () => ctrl.state.tool === 'dither', onSelect: () => ctrl.setTool('dither') },
        { label: 'Dither gradient', shortcut: 'K', checked: () => ctrl.state.tool === 'gradient', onSelect: () => ctrl.setTool('gradient') },
        { label: 'Eraser', shortcut: 'E', checked: () => ctrl.state.tool === 'eraser', onSelect: () => ctrl.setTool('eraser') },
        { label: 'Pen / Bezier path', shortcut: 'P', checked: () => ctrl.state.tool === 'curve', onSelect: () => ctrl.setTool('curve') },
        { label: 'Line / Shapes / Ellipse', shortcut: 'L / U / O', onSelect: () => ctrl.setTool('rect') },
        { label: 'Bucket fill', shortcut: 'G', checked: () => ctrl.state.tool === 'fill', onSelect: () => ctrl.setTool('fill') },
        { label: 'Color picker (Eyedropper)', shortcut: 'I / Alt+Click', checked: () => ctrl.state.tool === 'picker', onSelect: () => ctrl.setTool('picker') },
        { separator: true },
        { label: 'Move / Resize / Warp', shortcut: 'V', checked: () => ctrl.state.tool === 'move', onSelect: () => ctrl.setTool('move') },
        { label: 'Hand (pan pasteboard)', shortcut: 'H', checked: () => ctrl.state.tool === 'hand', onSelect: () => ctrl.setTool('hand') },
        { separator: true },
        { label: 'Android Drawing Pad…', onSelect: () => padDlg.open() },
      ],
    },
    {
      id: 'window',
      label: 'Window',
      items: [
        { label: 'Navigator panel', checked: () => ctrl.state.panelVisible.navigator !== false, onSelect: () => ctrl.togglePanelVisible('navigator') },
        { label: 'Palette panel', checked: () => ctrl.state.panelVisible.palette !== false, onSelect: () => ctrl.togglePanelVisible('palette') },
        { label: 'Layers panel', checked: () => ctrl.state.panelVisible.layers !== false, onSelect: () => ctrl.togglePanelVisible('layers') },
        { label: 'Selection Slices panel', checked: () => ctrl.state.panelVisible.slices !== false, onSelect: () => ctrl.togglePanelVisible('slices') },
        { label: 'Modifiers / Effects panel', checked: () => ctrl.state.panelVisible.modifiers !== false, onSelect: () => ctrl.togglePanelVisible('modifiers') },
        { label: 'Tiles panel', checked: () => ctrl.state.panelVisible.tiles !== false, onSelect: () => ctrl.togglePanelVisible('tiles') },
        { label: 'History panel', checked: () => ctrl.state.panelVisible.history !== false, onSelect: () => ctrl.togglePanelVisible('history') },
        { separator: true },
        { label: 'Timeline bar', checked: () => ctrl.state.timelineOpen, onSelect: () => ctrl.toggleTimeline() },
        { label: 'Reset Essentials layout', onSelect: () => { ctrl.setPanelSizes({ sideWidth: 288, timelineHeight: 156 }); ctrl.store.setState({ panelVisible: { navigator: true, palette: true, layers: true, slices: true, modifiers: true, tiles: true, history: true }, collapsed: { navigator: true, slices: true, mods: true, tiles: true, ramp: true, history: true }, timelineOpen: false }); } },
      ],
    },
    {
      id: 'effect',
      label: 'Effect',
      items: [
        { label: 'Juice FX animator (procedural)…', onSelect: () => dialogs.openJuiceFx() },
        { separator: true },
        { label: 'Dither effect (maskable)', onSelect: () => addModAction('dither') },
        { label: 'Lighting source (2D pad, maskable)', onSelect: () => addModAction('lighting') },
        { label: 'Shadow & Highlight (Tone)', onSelect: () => addModAction('tone') },
        { label: 'Color HSL adjustment', onSelect: () => addModAction('color') },
        { label: 'Outline (0.2–4px)', onSelect: () => addModAction('outline') },
        { label: 'Drop shadow', onSelect: () => addModAction('shadow') },
        { label: 'Palette map (OKLab)', onSelect: () => addModAction('palette-map') },
      ],
    },
    {
      id: 'assets',
      label: 'Assets',
      items: [
        { label: 'Import image / reference…', onSelect: () => dialogs.openImportImage() },
        { label: 'Extract 4 / 8 / 16 color palette…', onSelect: () => dialogs.openExtractPalette() },
        { label: 'Place active reference side-by-side', disabled: () => ctrl.getActiveLayer().kind !== 'reference', onSelect: () => ctrl.placeReferenceSideBySide(ctrl.state.activeLayerId) },
        { separator: true },
        { label: 'Capture tile from selection', onSelect: () => { ctrl.captureTileFromSelection(); } },
        { label: 'Auto organize tiles', shortcut: 'Alt+O', onSelect: () => { ctrl.autoOrganizeTilesAction(); } },
        { label: 'Auto slice islands', shortcut: 'Alt+S', onSelect: () => { ctrl.autoSliceAction(); } },
        { label: 'Slice and Animate', shortcut: 'Alt+A', onSelect: () => { ctrl.sliceAndAnimateAction(); } },
        { label: 'Create map tileset from grid', shortcut: 'Alt+T', onSelect: () => { ctrl.createMapTilesetAction(); } },
      ],
    },
    {
      id: 'template',
      label: 'Template',
      items: [
        { label: '16×16 Micro Icon', onSelect: () => ctrl.applyTemplate(16, 16, 'Icon 16×16') },
        { label: '32×32 Character Sprite', onSelect: () => ctrl.applyTemplate(32, 32, 'Character 32×32') },
        { label: '64×64 Game Asset', onSelect: () => ctrl.applyTemplate(64, 64, 'Asset 64×64') },
        { label: '128×128 Portrait', onSelect: () => ctrl.applyTemplate(128, 128, 'Portrait 128×128') },
        { label: '256×256 Tileset Sheet', onSelect: () => ctrl.applyTemplate(256, 256, 'Tileset 256×256') },
        { label: '320×180 Pixel Scene (16:9)', onSelect: () => ctrl.applyTemplate(320, 180, 'Scene 320×180') },
      ],
    },
    {
      id: 'settings',
      label: 'Settings',
      items: [
        { label: 'Preferences…', shortcut: 'Ctrl+,', onSelect: () => dialogs.openPreferences() },
        { label: 'Appearance & Theme…', onSelect: () => dialogs.openPreferences('appearance') },
        { label: 'Canvas, Grid & Guides…', onSelect: () => dialogs.openPreferences('canvas') },
        { label: 'Performance & History…', onSelect: () => dialogs.openPreferences('performance') },
        { separator: true },
        { label: 'Pixel-perfect 1px strokes', checked: () => ctrl.state.pixelPerfect, onSelect: () => ctrl.store.setState({ pixelPerfect: !ctrl.state.pixelPerfect }) },
        { label: 'Restrict brush to palette', checked: () => ctrl.state.restrictToPalette, onSelect: () => ctrl.toggleRestrictToPalette() },
        { label: 'Free floating pasteboard', checked: () => ctrl.state.freeCanvas, onSelect: () => ctrl.toggleFreeCanvas() },
        { label: 'Lock symmetrical line', checked: () => Boolean(ctrl.state.symmetry.locked), onSelect: () => ctrl.toggleSymmetryLock() },
        { separator: true },
        { label: 'Keyboard shortcuts…', shortcut: '?', onSelect: () => dialogs.openShortcuts() },
      ],
    },
  ]);

  const topQuick = h(
    'div',
    { class: 'top-quick-controls', role: 'toolbar', focusgroup: 'toolbar wrap', 'aria-label': 'Quick view controls' },
    h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Workbench view' }, spriteModeBtn, mapModeBtn),
    h('div', { class: 'btn-group', role: 'group', 'aria-label': 'History' }, undoBtn, redoBtn),
    h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Symmetry and grid' }, gridBtn, tileBtn, symXBtn, symYBtn, symLockBtn),
    orphanBtn,
  );
  wireToolbarFocusgroup(topQuick);

  const top = h(
    'header',
    { class: 'top' },
    h('span', { class: 'brand' }, 'tint', h('b', {}, 'box'), dirtyDot),
    menubar.el,
    h('span', { class: 'spacer' }),
    topQuick,
    h('div', { class: 'btn-group top-right' },
      padPill,
      h('button', { type: 'button', title: 'Export (Ctrl+E)', onClick: () => dialogs.openExport() }, icon('download', 14), ' Export'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Preferences', title: 'Preferences (Ctrl+,)', onClick: () => dialogs.openPreferences() }, icon('sliders')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', onClick: () => dialogs.openShortcuts() }, icon('help')),
      drawerBtn,
    ),
  );

  const syncDirty = () => {
    const dirty = ctrl.isDirty();
    dirtyDot.hidden = !dirty;
    if (typeof document !== 'undefined') {
      document.title = dirty ? '• Tintbox — pixel art workbench' : 'Tintbox — pixel art workbench';
    }
  };
  syncDirty();
  ctrl.store.subscribe((s) => [s.docRev, s.savedRev] as const, syncDirty, (a, b) => a[0] === b[0] && a[1] === b[1]);

  // ---- Photoshop-style Multi-Document Tab Bar ----
  const tabList = h('div', { class: 'tab-list', role: 'tablist', 'aria-label': 'Open canvases' });
  const addTabBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny tab-add',
    'aria-label': 'New canvas tab',
    title: 'New tab',
    onClick: () => ctrl.newTab(),
  }, icon('plus', 14));
  const tabBar = h('div', { class: 'tab-bar' }, tabList, addTabBtn);

  const renderTabs = () => {
    const { tabs, activeTabId } = ctrl.state;
    const nodes = tabs.map((t) => {
      const isActive = t.id === activeTabId;
      const titleEl = h('span', { class: 'tab-title' }, t.name);
      const tabBtn = h(
        'div',
        {
          class: `doc-tab${isActive ? ' active' : ''}`,
          role: 'tab',
          tabindex: isActive ? 0 : -1,
          'aria-selected': String(isActive),
          title: 'Click to switch · Double-click to rename',
          onClick: () => ctrl.switchTab(t.id),
          onDblclick: () => {
            const inp = h('input', {
              type: 'text',
              class: 'rename-input tab-rename-in',
              value: t.name,
              'aria-label': `Rename tab ${t.name}`,
            });
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              const trimmed = inp.value.trim();
              if (trimmed) ctrl.renameTab(t.id, trimmed);
              else renderTabs();
            };
            inp.addEventListener('blur', finish);
            inp.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') finish();
              else if (e.key === 'Escape') {
                done = true;
                renderTabs();
              }
            });
            titleEl.replaceWith(inp);
            inp.focus();
            inp.select();
          },
        },
        titleEl,
        t.dirty ? h('span', { class: 'tab-dirty', title: 'Unsaved changes' }) : null,
        h('button', {
          type: 'button',
          class: 'icon-btn tiny tab-close',
          'aria-label': `Close ${t.name}`,
          title: 'Close tab',
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            ctrl.closeTab(t.id);
          },
        }, icon('x', 12)),
      );
      return tabBtn;
    });
    tabList.replaceChildren(...nodes);
  };
  renderTabs();
  ctrl.store.subscribe(
    (s) => [s.tabs, s.activeTabId] as const,
    renderTabs,
    (a, b) => a[0] === b[0] && a[1] === b[1],
  );

  // ---- Contextual Tool Options Strip ----
  const optionsBar = h('div', { class: 'options-bar', 'aria-label': 'Tool options' });

  const brushSizeField = sliderField({
    id: 'opt-brush-size',
    label: 'Size',
    min: 0.2,
    max: 32,
    step: 0.2,
    value: ctrl.state.brushSize,
    onInput: (v) => ctrl.store.setState({ brushSize: v }),
  });

  const warpStrengthField = sliderField({
    id: 'opt-warp-str',
    label: 'Strength',
    min: -100,
    max: 100,
    value: ctrl.state.warpStrength,
    onInput: (v) => ctrl.store.setState({ warpStrength: v }),
  });

  const curveTensionField = sliderField({
    id: 'opt-curve-tension',
    label: 'Curvature',
    min: 0,
    max: 100,
    value: ctrl.state.vectorTension,
    onInput: (v) => {
      ctrl.store.setState({ vectorTension: v, vectorSmooth: v > 0 });
      stage.smoothVectorPath(v);
    },
  });

  const eyeDropperCtor =
    typeof window !== 'undefined' && 'EyeDropper' in window
      ? (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper
      : undefined;

  const renderOptions = () => {
    const s = ctrl.state;
    optionsBar.replaceChildren();

    if (s.viewMode === 'map') {
      const selTile = s.activeTileIndex > 0 ? `#${s.activeTileIndex} ${s.doc.tileset.tiles[s.activeTileIndex - 1]?.name ?? ''}` : 'none';
      optionsBar.append(
        h('span', { class: 'hint' }, `Map Editor · Tile ${s.doc.tileset.tileW}×${s.doc.tileset.tileH} · Selected: ${selTile} · Linked tiles update live when edited in Sprite view`),
      );
      return;
    }

    if (s.editTarget !== 'pixels') {
      const targetLabel = s.editTarget === 'mask' ? 'EDITING LAYER MASK' : 'EDITING EFFECT MASK';
      optionsBar.append(
        h('span', { class: 'mask-edit-badge mono' }, targetLabel),
        h('button', { type: 'button', class: 'primary', onClick: () => ctrl.setEditTarget('pixels') }, 'Back to pixels'),
        h('span', { class: 'sep', role: 'separator', 'aria-orientation': 'vertical' }),
      );
    }

    if (s.tool === 'pencil' || s.tool === 'eraser') {
      brushSizeField.setValue(s.brushSize);
      const microBtns = [0.2, 0.5, 1, 2, 4].map((sz) =>
        h('button', {
          type: 'button',
          class: 'tiny-btn',
          'aria-pressed': String(Math.abs(s.brushSize - sz) < 0.05),
          onClick: () => ctrl.store.setState({ brushSize: sz }),
        }, `${sz}`),
      );
      const sqBtn = h('button', { type: 'button', 'aria-pressed': String(s.brushShape === 'square'), onClick: () => ctrl.store.setState({ brushShape: 'square' }) }, 'Square');
      const rdBtn = h('button', { type: 'button', 'aria-pressed': String(s.brushShape === 'round'), onClick: () => ctrl.store.setState({ brushShape: 'round' }) }, 'Round');
      const ppBtn = h('button', { type: 'button', 'aria-pressed': String(s.pixelPerfect), title: 'Remove L-corners at <=1px', onClick: () => ctrl.store.setState({ pixelPerfect: !s.pixelPerfect }) }, 'Pixel-perfect');
      optionsBar.append(brushSizeField.el, h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Size presets' }, ...microBtns), h('div', { class: 'btn-group' }, sqBtn, rdBtn), ppBtn);
    } else if (s.tool === 'gradient') {
      const linBtn = h('button', { type: 'button', 'aria-pressed': String(s.gradientShape === 'linear'), onClick: () => ctrl.store.setState({ gradientShape: 'linear' }) }, 'Linear');
      const radBtn = h('button', { type: 'button', 'aria-pressed': String(s.gradientShape === 'radial'), onClick: () => ctrl.store.setState({ gradientShape: 'radial' }) }, 'Radial');
      const patSel = h(
        'select',
        {
          'aria-label': 'Gradient dither pattern',
          class: 'compact-select',
          onChange: () => ctrl.store.setState({ gradientPattern: patSel.value as DitherPattern }),
        },
        ...DITHER_PATTERNS.map((p) => h('option', { value: p.id, selected: p.id === s.gradientPattern }, p.label)),
      );
      const transBtn = h('button', {
        type: 'button',
        'aria-pressed': String(s.gradientToTransparent),
        onClick: () => ctrl.store.setState({ gradientToTransparent: !s.gradientToTransparent }),
      }, 'To transparent');
      const multiBtn = h('button', {
        type: 'button',
        'aria-pressed': String(s.gradientMultiStop),
        title: 'Multi-stop weighted dither gradient (Dither Machine style)',
        onClick: () => ctrl.store.setState({ gradientMultiStop: !s.gradientMultiStop }),
      }, 'Multi-stop');
      optionsBar.append(h('div', { class: 'btn-group' }, linBtn, radBtn), patSel, transBtn, multiBtn);

      if (s.gradientMultiStop) {
        const updateStops = (next: DitherGradientStop[]) => {
          ctrl.store.setState({ gradientStops: next });
        };
        const stopBar = h('div', { class: 'grad-stop-bar', role: 'group', 'aria-label': 'Weighted gradient color stops' });
        s.gradientStops.forEach((st, idx) => {
          const colIn = h('input', {
            type: 'color',
            class: 'grad-stop-color',
            'aria-label': `Stop ${idx + 1} color`,
            value: rgbaToHex(st.color),
            onInput: () => {
              const next = s.gradientStops.map((item, j) =>
                j === idx ? { ...item, color: hexToRgba(colIn.value) } : item,
              );
              updateStops(next);
            },
          });
          const wtIn = h('input', {
            type: 'number',
            class: 'grad-stop-weight mono',
            'aria-label': `Stop ${idx + 1} weight percent`,
            min: 1,
            max: 100,
            value: Math.round(st.weight),
            onChange: () => {
              const wVal = Math.max(1, Math.min(100, Math.round(Number(wtIn.value) || 10)));
              const next = s.gradientStops.map((item, j) => (j === idx ? { ...item, weight: wVal } : item));
              updateStops(next);
            },
          });
          const chip = h('span', { class: 'grad-stop-chip' }, colIn, wtIn, h('span', { class: 'mono grad-stop-pct' }, '%'));
          if (s.gradientStops.length > 2) {
            chip.append(
              h('button', {
                type: 'button',
                class: 'tiny-btn grad-stop-rm',
                'aria-label': `Remove stop ${idx + 1}`,
                onClick: () => updateStops(s.gradientStops.filter((_, j) => j !== idx)),
              }, '×'),
            );
          }
          stopBar.append(chip);
        });
        if (s.gradientStops.length < 6) {
          stopBar.append(
            h('button', {
              type: 'button',
              class: 'tiny-btn',
              title: 'Add primary color stop',
              onClick: () => updateStops([...s.gradientStops, { color: [...s.primaryColor], weight: 25 }]),
            }, '+ Stop'),
          );
        }
        stopBar.append(
          h('button', {
            type: 'button',
            class: 'tiny-btn',
            title: 'Load up to 4 stops from active palette',
            onClick: () => {
              const pal = getActivePalette(ctrl.state.doc).colors;
              if (pal.length < 2) return;
              const pick = pal.slice(0, Math.min(4, pal.length));
              const wEach = Math.round(100 / pick.length);
              updateStops(pick.map((c) => ({ color: [c.rgba[0], c.rgba[1], c.rgba[2], c.rgba[3]], weight: wEach })));
            },
          }, 'From palette'),
        );
        optionsBar.append(stopBar);
      }

      if (s.gradientActive) {
        optionsBar.append(
          h('button', { type: 'button', class: 'primary', onClick: () => stage.commitActiveTool() }, 'Apply (Enter)'),
          h('button', { type: 'button', onClick: () => stage.cancelActiveTool() }, 'Cancel (Esc)'),
        );
      } else {
        optionsBar.append(h('span', { class: 'hint' }, 'Drag on canvas for dither gradient · Adjust handles live'));
      }
    } else if (s.tool === 'dither') {
      brushSizeField.setValue(s.brushSize);
      const patSel = h(
        'select',
        {
          'aria-label': 'Dither pattern',
          class: 'compact-select',
          onChange: () => ctrl.store.setState({ ditherPattern: patSel.value as DitherPattern }),
        },
        ...DITHER_PATTERNS.map((p) => h('option', { value: p.id, selected: p.id === s.ditherPattern }, p.label)),
      );
      const dualBtn = h('button', {
        type: 'button',
        'aria-pressed': String(s.ditherDual),
        title: 'Fill pattern gaps with secondary color',
        onClick: () => ctrl.store.setState({ ditherDual: !s.ditherDual }),
      }, 'Dual color');
      const densField = sliderField({
        id: 'opt-dither-density',
        label: 'Density',
        min: 10,
        max: 90,
        value: s.ditherDensity,
        onInput: (v) => ctrl.store.setState({ ditherDensity: v }),
      });
      optionsBar.append(brushSizeField.el, patSel, dualBtn);
      if (s.ditherPattern === 'bayer2' || s.ditherPattern === 'bayer4' || s.ditherPattern === 'bayer8' || s.ditherPattern === 'diag') {
        optionsBar.append(densField.el);
      }
    } else if (s.tool === 'curve') {
      curveTensionField.setValue(s.vectorTension);
      const smoothBtn = h('button', {
        type: 'button',
        'aria-pressed': String(s.vectorSmooth),
        title: 'Smooth all anchors with cubic Bezier handles',
        onClick: () => {
          const t = s.vectorTension > 0 ? s.vectorTension : 50;
          ctrl.store.setState({ vectorSmooth: true, vectorTension: t });
          stage.smoothVectorPath(t);
        },
      }, 'Smooth');
      const sharpBtn = h('button', {
        type: 'button',
        'aria-pressed': String(!s.vectorSmooth),
        title: 'Convert all anchors to sharp corners',
        onClick: () => {
          ctrl.store.setState({ vectorSmooth: false, vectorTension: 0 });
          stage.sharpVectorPath();
        },
      }, 'Sharp');
      const closedBtn = h('button', {
        type: 'button',
        'aria-pressed': String(s.vectorClosed),
        onClick: () => ctrl.store.setState({ vectorClosed: !s.vectorClosed, ...(s.vectorClosed ? { vectorFilled: false } : {}) }),
      }, 'Closed');
      const fillBtn = h('button', {
        type: 'button',
        'aria-pressed': String(s.vectorFilled),
        onClick: () => ctrl.store.setState({ vectorFilled: !s.vectorFilled, ...(!s.vectorFilled ? { vectorClosed: true } : {}) }),
      }, 'Fill');
      const widthIn = h('input', {
        type: 'number',
        class: 'num tiny-num',
        min: 0.2,
        max: 8,
        step: 0.2,
        value: s.vectorWidth,
        'aria-label': 'Vector stroke width',
        onChange: () => {
          const v = Number(widthIn.value);
          ctrl.store.setState({ vectorWidth: Number.isFinite(v) ? Math.max(0.2, Math.min(8, Math.round(v * 5) / 5)) : 1 });
        },
      });
      optionsBar.append(
        h('div', { class: 'btn-group' }, smoothBtn, sharpBtn),
        curveTensionField.el,
        h('div', { class: 'btn-group' }, closedBtn, fillBtn),
        h('span', { class: 'hint' }, 'Width'),
        widthIn,
      );
      if (s.vectorActive) {
        optionsBar.append(
          h('button', { type: 'button', class: 'primary', onClick: () => stage.commitActiveTool() }, 'Apply (Enter)'),
          h('button', { type: 'button', onClick: () => stage.cancelActiveTool() }, 'Cancel (Esc)'),
        );
      } else {
        optionsBar.append(h('span', { class: 'hint' }, 'Click corner · Click+drag Bezier handles · Alt break handle'));
      }
    } else if (s.tool === 'rect' || s.tool === 'ellipse') {
      const presetBtns = SHAPE_PRESETS.map((p) =>
        h('button', {
          type: 'button',
          'aria-pressed': String(s.shapePreset === p.id),
          onClick: () => ctrl.store.setState({ shapePreset: p.id }),
        }, p.label),
      );
      const outBtn = h('button', { type: 'button', 'aria-pressed': String(!s.shapeFilled), onClick: () => ctrl.store.setState({ shapeFilled: false }) }, 'Outline');
      const fillBtn = h('button', { type: 'button', 'aria-pressed': String(s.shapeFilled), onClick: () => ctrl.store.setState({ shapeFilled: true }) }, 'Filled');
      optionsBar.append(
        h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Shape preset' }, ...presetBtns),
        h('div', { class: 'btn-group' }, outBtn, fillBtn),
      );
      if (s.shapePreset === 'star') {
        const ptsIn = h('input', {
          type: 'number',
          class: 'num tiny-num',
          min: 4,
          max: 12,
          value: s.shapeStarPoints,
          'aria-label': 'Star points',
          onChange: () => ctrl.store.setState({ shapeStarPoints: Math.max(4, Math.min(12, Math.round(Number(ptsIn.value) || 5))) }),
        });
        optionsBar.append(h('span', { class: 'hint' }, 'Pts'), ptsIn);
      }
      if (s.shapeLiveActive) {
        optionsBar.append(
          h('button', { type: 'button', class: 'primary', onClick: () => stage.commitActiveTool() }, 'Apply (Enter)'),
          h('button', { type: 'button', onClick: () => stage.cancelActiveTool() }, 'Cancel (Esc)'),
        );
      }
    } else if (s.tool === 'fill' || s.tool === 'select-wand') {
      const contigBtn = h('button', { type: 'button', 'aria-pressed': String(s.fillContiguous), onClick: () => ctrl.store.setState({ fillContiguous: !s.fillContiguous }) }, s.fillContiguous ? 'Contiguous' : 'Global');
      const sampleBtn = h('button', { type: 'button', 'aria-pressed': String(s.fillSampleAll), onClick: () => ctrl.store.setState({ fillSampleAll: !s.fillSampleAll }) }, s.fillSampleAll ? 'Sample all visible' : 'Sample layer');
      const tolField = sliderField({
        id: 'opt-fill-tol',
        label: 'Tol',
        min: 0,
        max: 128,
        value: s.fillTolerance,
        onInput: (v) => ctrl.store.setState({ fillTolerance: v }),
      });
      optionsBar.append(contigBtn, sampleBtn, tolField.el);
      if (s.tool === 'select-wand' && s.selection) {
        optionsBar.append(
          h('button', { type: 'button', onClick: () => ctrl.clearActiveRegion() }, 'Clear (Del)'),
        );
      }
    } else if (s.tool === 'picker') {
      const compBtn = h('button', { type: 'button', 'aria-pressed': String(s.grabSampleSource === 'composed'), onClick: () => ctrl.store.setState({ grabSampleSource: 'composed' }) }, 'Composed');
      const layerBtn = h('button', { type: 'button', 'aria-pressed': String(s.grabSampleSource === 'layer'), onClick: () => ctrl.store.setState({ grabSampleSource: 'layer' }) }, 'Active layer');
      const shiftAddBtn = h('button', { type: 'button', 'aria-pressed': String(s.grabShiftAdds), onClick: () => ctrl.store.setState({ grabShiftAdds: !s.grabShiftAdds }) }, 'Shift+click adds to palette');
      optionsBar.append(h('div', { class: 'btn-group' }, compBtn, layerBtn), shiftAddBtn);
      if (eyeDropperCtor) {
        optionsBar.append(
          h('button', {
            type: 'button',
            title: 'Sample color from anywhere on screen',
            onClick: async () => {
              try {
                const ed = new eyeDropperCtor();
                const res = await ed.open();
                ctrl.store.setState({ primaryColor: hexToRgba(res.sRGBHex) });
              } catch {
                // User canceled EyeDropper; no error needed.
              }
            },
          }, 'Screen picker'),
        );
      }
    } else if (s.tool === 'move' || s.tool === 'select-rect' || s.tool === 'select-lasso') {
      if (s.tool === 'move') {
        const modeBtns = (['move', 'resize', 'warp'] as const).map((m) =>
          h('button', {
            type: 'button',
            'aria-pressed': String(s.moveMode === m),
            onClick: () => ctrl.store.setState({ moveMode: m }),
          }, m === 'move' ? 'Move' : m === 'resize' ? 'Resize' : 'Warp'),
        );
        optionsBar.append(h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Direct canvas transform mode' }, ...modeBtns));
        if (s.moveMode === 'move') {
          const wrapBtn = h('button', { type: 'button', 'aria-pressed': String(s.moveWrap), onClick: () => ctrl.store.setState({ moveWrap: !s.moveWrap }) }, 'Wrap');
          optionsBar.append(wrapBtn);
        } else if (s.moveMode === 'warp') {
          const wpSel = h(
            'select',
            {
              'aria-label': 'Direct warp preset',
              class: 'compact-select',
              onChange: () => ctrl.store.setState({ warpPreset: wpSel.value as WarpPreset }),
            },
            ...WARP_PRESETS.map((p) => h('option', { value: p.id, selected: p.id === s.warpPreset }, p.label)),
          );
          warpStrengthField.setValue(s.warpStrength);
          optionsBar.append(wpSel);
          if (s.warpPreset !== 'quad') optionsBar.append(warpStrengthField.el);
        }
        if (s.transformActive) {
          optionsBar.append(
            h('button', { type: 'button', class: 'primary', onClick: () => stage.commitActiveTool() }, 'Apply (Enter)'),
            h('button', { type: 'button', onClick: () => stage.cancelActiveTool() }, 'Cancel (Esc)'),
          );
        }
      }
      optionsBar.append(
        h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Transform' },
          h('button', { type: 'button', title: 'Flip horizontal', onClick: () => ctrl.transformActiveRegion('flip-h') }, icon('flipH', 14), ' Flip H'),
          h('button', { type: 'button', title: 'Flip vertical', onClick: () => ctrl.transformActiveRegion('flip-v') }, icon('flipV', 14), ' Flip V'),
          h('button', { type: 'button', title: 'Rotate 90° clockwise', onClick: () => ctrl.transformActiveRegion('rot-cw') }, 'Rot CW'),
          h('button', { type: 'button', title: 'Rotate 90° counter-clockwise', onClick: () => ctrl.transformActiveRegion('rot-ccw') }, 'Rot CCW'),
        ),
        h('button', { type: 'button', title: 'Clear selection or cel (Delete)', onClick: () => ctrl.clearActiveRegion() }, 'Clear'),
      );
      if (s.floating) {
        optionsBar.append(
          h('button', { type: 'button', class: 'primary', onClick: () => ctrl.commitFloating() }, 'Commit paste (Enter)'),
          h('button', { type: 'button', onClick: () => ctrl.cancelFloating() }, 'Cancel (Esc)'),
        );
      }
    } else {
      optionsBar.append(h('span', { class: 'hint' }, stage.tools[s.tool].hint));
    }

    if (s.tileMode !== 'none') {
      optionsBar.append(
        h('span', { class: 'sep', role: 'separator', 'aria-orientation': 'vertical' }),
        h('span', { class: 'hint' }, 'Tile wrap'),
        h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Tile wrap axes' },
          h('button', { type: 'button', 'aria-pressed': String(s.tileMode === 'x'), onClick: () => ctrl.setTileMode('x') }, 'X'),
          h('button', { type: 'button', 'aria-pressed': String(s.tileMode === 'y'), onClick: () => ctrl.setTileMode('y') }, 'Y'),
          h('button', { type: 'button', 'aria-pressed': String(s.tileMode === 'xy'), onClick: () => ctrl.setTileMode('xy') }, 'XY'),
        ),
      );
    }
  };
  renderOptions();
  ctrl.store.subscribe(
    (s) => [s.tool, s.brushSize, s.brushShape, s.pixelPerfect, s.shapeFilled, s.fillContiguous, s.fillSampleAll, s.fillTolerance, s.moveWrap, s.moveMode, s.transformActive, s.warpPreset, s.gradientShape, s.gradientPattern, s.gradientToTransparent, s.gradientMultiStop, s.gradientStops, s.gradientActive, s.editTarget, s.grabSampleSource, s.grabShiftAdds, Boolean(s.floating), Boolean(s.selection), s.tileMode, s.viewMode, s.activeTileIndex, s.docRev, s.ditherPattern, s.ditherDensity, s.ditherDual, s.vectorSmooth, s.vectorClosed, s.vectorFilled, s.vectorWidth, s.vectorActive, s.shapePreset, s.shapeStarPoints, s.shapeLiveActive] as const,
    renderOptions,
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  // ---- Floating Orphan Cleaner Panel (F-ORPHAN) ----
  const orphanPanel = h('aside', { class: 'orphan-panel', 'aria-label': 'Clean orphan pixels', hidden: true });
  const renderOrphanPanel = () => {
    const s = ctrl.state;
    orphanBtn.setAttribute('aria-pressed', String(s.orphanOpen));
    orphanPanel.hidden = !s.orphanOpen;
    if (!s.orphanOpen) return;

    const { connectivity, minClusterSize, action, scope } = s.orphanOpts;
    const count = s.orphanPreview.length;
    const countText = `${count} orphan${count === 1 ? '' : 's'} found`;

    orphanPanel.replaceChildren(
      h('header', { class: 'orphan-head' },
        h('span', { class: 'mono' }, 'CLEAN ORPHAN PIXELS'),
        h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': 'Close orphan cleaner', onClick: () => ctrl.closeOrphanCleaner() }, icon('x', 14)),
      ),
      h('div', { class: 'row' },
        h('span', { class: 'hint' }, 'Conn'),
        h('div', { class: 'btn-group' },
          h('button', { type: 'button', 'aria-pressed': String(connectivity === 4), onClick: () => ctrl.updateOrphanOpts({ connectivity: 4 }) }, '4-way'),
          h('button', { type: 'button', 'aria-pressed': String(connectivity === 8), onClick: () => ctrl.updateOrphanOpts({ connectivity: 8 }) }, '8-way'),
        ),
      ),
      h('div', { class: 'row' },
        h('span', { class: 'hint' }, 'Max size'),
        h('div', { class: 'btn-group' },
          ...([1, 2, 3] as const).map((sz) =>
            h('button', { type: 'button', 'aria-pressed': String(minClusterSize === sz), onClick: () => ctrl.updateOrphanOpts({ minClusterSize: sz }) }, String(sz)),
          ),
        ),
      ),
      h('div', { class: 'row' },
        h('span', { class: 'hint' }, 'Action'),
        h('div', { class: 'btn-group' },
          h('button', { type: 'button', 'aria-pressed': String(action === 'merge'), onClick: () => ctrl.updateOrphanOpts({ action: 'merge' }) }, 'Merge'),
          h('button', { type: 'button', 'aria-pressed': String(action === 'delete'), onClick: () => ctrl.updateOrphanOpts({ action: 'delete' }) }, 'Delete'),
        ),
      ),
      h('div', { class: 'row' },
        h('span', { class: 'hint' }, 'Scope'),
        h('div', { class: 'btn-group' },
          h('button', { type: 'button', 'aria-pressed': String(scope === 'cel'), onClick: () => ctrl.updateOrphanOpts({ scope: 'cel' }) }, s.selection ? 'Selection' : 'Active cel'),
          h('button', { type: 'button', 'aria-pressed': String(scope === 'layer-frames'), onClick: () => ctrl.updateOrphanOpts({ scope: 'layer-frames' }) }, 'All frames'),
        ),
      ),
      h('p', { class: 'mono orphan-count' }, countText),
      h('div', { class: 'action-bar orphan-foot' },
        h('button', { type: 'button', onClick: () => ctrl.closeOrphanCleaner() }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', disabled: count === 0 && scope === 'cel', onClick: () => ctrl.applyOrphanCleanup() }, 'Clean orphans'),
      ),
    );
  };
  renderOrphanPanel();
  ctrl.store.subscribe(
    (s) => [s.orphanOpen, s.orphanOpts, s.orphanPreview, s.selection] as const,
    renderOrphanPanel,
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );
  stage.el.append(orphanPanel);

  // ---- Left vertical tool rail ----
  const toolBtns = TOOL_ORDER.map(({ id, icon: ic }) => {
    const t = stage.tools[id];
    return h(
      'button',
      {
        type: 'button',
        class: 'tool-btn',
        'aria-label': `${t.name} (${t.key})`,
        'aria-pressed': String(ctrl.state.tool === id),
        title: `${t.name} (${t.key})`,
        onClick: () => ctrl.setTool(id),
      },
      icon(ic),
    );
  });

  const primarySwatch = h('input', {
    type: 'color',
    class: 'swatch-primary',
    value: rgbaToHex(ctrl.state.primaryColor),
    'aria-label': 'Primary color picker',
    title: 'Primary color (click to pick)',
    onInput: () => ctrl.store.setState({ primaryColor: hexToRgba(primarySwatch.value) }),
  });
  const secondarySwatch = h('input', {
    type: 'color',
    class: 'swatch-secondary',
    value: rgbaToHex(ctrl.state.secondaryColor),
    'aria-label': 'Secondary color picker',
    title: 'Secondary color (right-click canvas to paint)',
    onInput: () => ctrl.store.setState({ secondaryColor: hexToRgba(secondarySwatch.value) }),
  });
  const swapBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': 'Swap primary and secondary colors',
      title: 'Swap colors (X)',
      onClick: () => ctrl.swapColors(),
    },
    icon('swap', 14),
  );
  const swatchStack = h('div', { class: 'swatch-stack' }, primarySwatch, secondarySwatch, swapBtn);

  const toolsRail = h(
    'nav',
    { class: 'tools', 'aria-label': 'Drawing tools' },
    h(
      'div',
      { class: 'tool-group', role: 'toolbar', 'aria-orientation': 'vertical', focusgroup: 'toolbar wrap block', 'aria-label': 'Tools' },
      ...toolBtns,
    ),
    swatchStack,
  );
  wireToolbarFocusgroup(toolsRail.firstElementChild as HTMLElement);

  const syncSwatches = () => {
    const s = ctrl.state;
    const pHex = rgbaToHex(s.primaryColor);
    const sHex = rgbaToHex(s.secondaryColor);
    primarySwatch.value = pHex;
    secondarySwatch.value = sHex;
    primarySwatch.title = `Primary ${pHex} (click to pick)`;
    secondarySwatch.title = `Secondary ${sHex} (right-click canvas)`;
  };
  syncSwatches();
  ctrl.store.subscribe((s) => [s.primaryColor, s.secondaryColor] as const, syncSwatches, (a, b) => a[0] === b[0] && a[1] === b[1]);

  ctrl.store.subscribe((s) => s.tool, (t) => {
    TOOL_ORDER.forEach(({ id }, i) => toolBtns[i].setAttribute('aria-pressed', String(id === t)));
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'number') {
      document.activeElement.blur();
    }
  });

  // ---- Timeline footer (P3 matrix + real-clock playback + onion + animations) ----
  const timelineApi = createTimeline(ctrl, (scope) => dialogs.openExport(scope));
  const timeline = timelineApi.el;

  // ---- Status bar ----
  const stHint = h('span', { class: 'st-hint' });
  const stZoom = h('span', { class: 'mono' });
  const stCoords = h('span', { class: 'mono' });
  const stSize = h('span', { class: 'mono' });
  const stHex = h('span', { class: 'mono st-hex' });
  const statusBar = h('footer', { class: 'status-bar' }, stHint, h('span', { class: 'spacer' }), stZoom, stCoords, stSize, stHex);

  // ---- Resizable panel splitters (persisted in localStorage) ----
  const sideSplitter = h('div', { class: 'split-v', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize inspector panel', title: 'Drag to resize inspector' });
  const timeSplitter = h('div', { class: 'split-h', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize timeline', title: 'Drag to resize timeline' });

  sideSplitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sideSplitter.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = ctrl.state.sideWidth;
    const onMove = (ev: PointerEvent) => {
      ctrl.setPanelSizes({ sideWidth: startW + (startX - ev.clientX) });
    };
    const onUp = () => {
      sideSplitter.removeEventListener('pointermove', onMove);
      sideSplitter.removeEventListener('pointerup', onUp);
    };
    sideSplitter.addEventListener('pointermove', onMove);
    sideSplitter.addEventListener('pointerup', onUp);
  });

  timeSplitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    timeSplitter.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = ctrl.state.timelineHeight;
    const onMove = (ev: PointerEvent) => {
      ctrl.setPanelSizes({ timelineHeight: startH + (startY - ev.clientY) });
    };
    const onUp = () => {
      timeSplitter.removeEventListener('pointermove', onMove);
      timeSplitter.removeEventListener('pointerup', onUp);
    };
    timeSplitter.addEventListener('pointermove', onMove);
    timeSplitter.addEventListener('pointerup', onUp);
  });

  side.prepend(sideSplitter);
  timeline.prepend(timeSplitter);

  const shell = h('div', { class: 'shell' }, top, tabBar, optionsBar, toolsRail, stage.el, mapStage.el, side, timeline, statusBar);

  const syncLayoutSizes = () => {
    const s = ctrl.state;
    shell.style.setProperty('--side-w', `${s.sideWidth}px`);
    timeline.style.maxHeight = s.timelineOpen ? `${s.timelineHeight}px` : '';
  };
  syncLayoutSizes();
  ctrl.store.subscribe((s) => [s.sideWidth, s.timelineHeight, s.timelineOpen] as const, syncLayoutSizes, (a, b) => a.every((v, i) => Object.is(v, b[i])));

  const syncStatus = () => {
    const s = ctrl.state;
    const isMap = s.viewMode === 'map';
    const pct = `${s.viewport.zoom * 100}%`;
    if (isMap) {
      stHint.textContent = 'Map Editor · B brush · U rect · G fill · E eraser · I pick · Wheel zoom · Mid-drag pan';
      stZoom.textContent = `${s.mapZoom * 100}%`;
      stCoords.textContent = s.mapHoverCell ? `${s.mapHoverCell.x}, ${s.mapHoverCell.y}` : '—';
      stSize.textContent = `${s.doc.tilemap.width}×${s.doc.tilemap.height} tiles`;
      stHex.textContent = s.activeTileIndex > 0 ? `#${s.activeTileIndex}` : '—';
    } else {
      stZoom.textContent = pct;
      stHint.textContent = stage.tools[s.tool].hint;
      stCoords.textContent = s.hover ? `${s.hover.x}, ${s.hover.y}` : '—';
      stSize.textContent = `${s.doc.w}×${s.doc.h}`;
      stHex.textContent = s.hoverHex ?? '—';
    }
    gridBtn.setAttribute('aria-pressed', String(s.grid));
    tileBtn.setAttribute('aria-pressed', String(s.tileMode !== 'none'));
    spriteModeBtn.setAttribute('aria-pressed', String(!isMap));
    mapModeBtn.setAttribute('aria-pressed', String(isMap));
    stage.el.hidden = isMap;
    toolsRail.hidden = isMap;
    timeline.hidden = isMap;
    shell.classList.toggle('map-mode', isMap);
    symXBtn.setAttribute('aria-pressed', String(s.symmetry.mode === 'x' || s.symmetry.mode === 'xy'));
    symYBtn.setAttribute('aria-pressed', String(s.symmetry.mode === 'y' || s.symmetry.mode === 'xy'));
    symLockBtn.setAttribute('aria-pressed', String(Boolean(s.symmetry.locked)));
  };
  syncStatus();
  ctrl.store.subscribe(
    (s) => [s.viewport.zoom, s.tool, s.hover, s.hoverHex, s.doc.w, s.doc.h, s.grid, s.symmetry.mode, s.symmetry.locked, s.tileMode, s.viewMode, s.mapZoom, s.mapHoverCell, s.activeTileIndex, s.doc.tilemap.width, s.doc.tilemap.height] as const,
    syncStatus,
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  // ---- Toast + Centralized aria-live="polite" region ----
  const toastEl = h('div', { class: 'toast-host' });
  const liveRegion = h('p', { role: 'status', 'aria-live': 'polite', class: 'visually-hidden' });

  ctrl.store.subscribe((s) => s.toast, (toast) => {
    toastEl.replaceChildren();
    if (!toast) return;
    toastEl.append(h('div', { class: `toast toast-${toast.kind}` }, toast.text));
  });
  ctrl.store.subscribe((s) => s.announcement, (msg) => {
    liveRegion.textContent = msg;
  });

  // ---- Clipboard image paste -> Reference layer (F-REF) ----
  const onPaste = (e: ClipboardEvent) => {
    if (document.querySelector('dialog[open]')) return;
    const item = Array.from(e.clipboardData?.items ?? []).find((it) => it.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) {
      e.preventDefault();
      void ctrl.importReferenceBlob(file, 'Pasted reference');
    }
  };
  window.addEventListener('paste', onPaste);

  // ---- Keyboard map ----
  const unbindKeys = bindKeymap(window, {
    setTool: (t) => ctrl.setTool(t),
    setMapTool: (mt) => ctrl.store.setState({ mapTool: mt }),
    isMapMode: () => ctrl.state.viewMode === 'map',
    swapColors: () => ctrl.swapColors(),
    stepBrush: (d) => ctrl.stepBrushSize(d),
    stepZoom: (d) => ctrl.zoomStep(d),
    zoom100: () => ctrl.zoom100(),
    zoomFit: () => ctrl.zoomFit(),
    toggleGrid: () => ctrl.toggleGrid(),
    toggleTileMode: () => ctrl.toggleTileMode(),
    toggleOnion: () => ctrl.toggleOnion(),
    prevFrame: () => {
      const s = ctrl.state;
      const n = s.doc.frames.length;
      ctrl.store.setState({ activeFrame: (s.activeFrame - 1 + n) % n });
    },
    nextFrame: () => {
      const s = ctrl.state;
      ctrl.store.setState({ activeFrame: (s.activeFrame + 1) % s.doc.frames.length });
    },
    togglePlay: () => timelineApi.togglePlay(),
    undo: () => { ctrl.undo(); },
    redo: () => { ctrl.redo(); },
    selectAll: () => ctrl.selectAllAction(),
    deselect: () => ctrl.deselectAction(),
    invertSelection: () => ctrl.invertSelectionAction(),
    copy: () => ctrl.copySelection(),
    cut: () => ctrl.cutSelection(),
    paste: () => ctrl.pasteClipboard(),
    deleteSelection: () => {
      if (ctrl.state.viewMode === 'map') return;
      if (ctrl.state.tool === 'curve' && stage.deleteLastVectorVertex()) return;
      ctrl.clearActiveRegion();
    },
    commit: () => stage.commitActiveTool(),
    cancel: () => {
      if (timelineApi.closePopovers()) return;
      stage.cancelActiveTool();
    },
    nudge: (dx, dy) => ctrl.nudge(dx, dy),
    openNewDialog: () => dialogs.openNew(),
    openExportDialog: () => dialogs.openExport(),
    saveProject: () => { void ctrl.saveProject(); },
    openProject: () => { void ctrl.openProject(); },
    openShortcutsDialog: () => dialogs.openShortcuts(),
    openPreferencesDialog: () => dialogs.openPreferences(),
    createSlice: () => { ctrl.createSliceFromSelection(); },
    autoOrganizeTiles: () => { ctrl.autoOrganizeTilesAction(); },
    autoSlice: () => { ctrl.autoSliceAction(); },
    sliceAndAnimate: () => { ctrl.sliceAndAnimateAction(); },
    createMapTileset: () => { ctrl.createMapTilesetAction(); },
    rotateMapTile: (d) => ctrl.rotateMapTile(d),
    flipMapTileH: () => ctrl.flipMapTileH(),
    flipMapTileV: () => ctrl.flipMapTileV(),
    startFreeTransform: () => {
      ctrl.setTool('move');
      ctrl.store.setState({ moveMode: 'resize' });
    },
    groupLayers: () => ctrl.groupSelectedLayers(),
    layerAction: (act) => {
      switch (act) {
        case 'rename': ctrl.startRenameLayer(); break;
        case 'new': ctrl.newLayer(); break;
        case 'duplicate': ctrl.duplicateActiveLayer(); break;
        case 'merge-down': ctrl.mergeDownActive(); break;
        case 'flatten': ctrl.flattenVisible(); break;
        case 'up': case 'down': case 'top': case 'bottom': ctrl.moveActiveLayer(act); break;
        case 'select-up': ctrl.selectAdjacentLayer(1); break;
        case 'select-down': ctrl.selectAdjacentLayer(-1); break;
      }
    },
    ungroupLayers: () => ctrl.ungroupActiveGroup(),
    setSpacePan: (down) => stage.setSpacePan(down),
    isTimelineFocused: () => timeline.contains(document.activeElement),
    canNudge: () => ctrl.state.tool === 'move' || Boolean(ctrl.state.floating),
  });

  // ---- Unsaved changes guard + IndexedDB autosave + Cross-tab preferences sync ----
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!ctrl.state.appPrefs.confirmUnsavedClose || !ctrl.isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  const stopAutosave = ctrl.startAutosave();
  const stopPrefsSync = ctrl.bindCrossTabPrefsSync();
  let destroyed = false;
  void ctrl.checkAutosaveDraft().then((draft) => {
    if (!destroyed && draft) dialogs.openRecoverDraft(draft);
  });

  root.replaceChildren(shell, dialogs.container, toastEl, liveRegion);

  return {
    ctrl,
    destroy() {
      destroyed = true;
      padClient.disconnect();
      unsubPadSync();
      stopAutosave();
      stopPrefsSync();
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('paste', onPaste);
      unbindKeys();
      menubar.destroy();
      timelineApi.destroy();
      mapStage.destroy();
      stage.destroy();
    },
  };
}
