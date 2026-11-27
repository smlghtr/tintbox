import type { MapToolId, ToolId } from '../state/ui';

export interface ShortcutEntry {
  keys: string;
  label: string;
  group: 'Tools' | 'View' | 'Selection & Edit' | 'Layers' | 'Animation' | 'Document';
}

export const TOOL_KEYS: Record<string, ToolId> = {
  b: 'pencil',
  d: 'dither',
  k: 'gradient',
  e: 'eraser',
  l: 'line',
  c: 'curve',
  p: 'curve',
  u: 'rect',
  o: 'ellipse',
  g: 'fill',
  i: 'picker',
  m: 'select-rect',
  q: 'select-lasso',
  w: 'select-wand',
  v: 'move',
  h: 'hand',
};

export const SHORTCUT_LIST: ShortcutEntry[] = [
  { keys: 'B', label: 'Pencil (0.2–32px)', group: 'Tools' },
  { keys: 'D', label: 'Dither brush', group: 'Tools' },
  { keys: 'K', label: 'Dither gradient (direct canvas & mask)', group: 'Tools' },
  { keys: 'E', label: 'Eraser (0.2–32px)', group: 'Tools' },
  { keys: 'L', label: 'Line (Shift: 15° snap)', group: 'Tools' },
  { keys: 'C / P', label: 'Pen / Bezier path (drag handles, Alt break, Enter apply)', group: 'Tools' },
  { keys: 'U', label: 'Live shapes (Square/Oval/Star/Cube/Iso)', group: 'Tools' },
  { keys: 'O', label: 'Live ellipse / oval', group: 'Tools' },
  { keys: 'G', label: 'Bucket fill', group: 'Tools' },
  { keys: 'I / Alt+Click', label: 'Color picker / Eyedropper (live loupe)', group: 'Tools' },
  { keys: 'M / Q / W', label: 'Rect / Lasso / Magic wand select', group: 'Tools' },
  { keys: 'V / Ctrl+T', label: 'Move / Direct-canvas Resize & Free Warp', group: 'Tools' },
  { keys: 'H', label: 'Hand (free pasteboard pan)', group: 'Tools' },
  { keys: '[ / ]', label: 'Brush size - / + (down to 0.2px)', group: 'Tools' },
  { keys: 'X', label: 'Swap primary / secondary color', group: 'Tools' },
  { keys: 'Space (hold)', label: 'Temporary pan', group: 'View' },
  { keys: '+ / - (or Ctrl +/-)', label: 'Zoom in / out', group: 'View' },
  { keys: '1 / 0', label: 'Zoom 100% / Fit to viewport', group: 'View' },
  { keys: '#', label: 'Toggle pixel grid (zoom >= 8x)', group: 'View' },
  { keys: 'T', label: 'Toggle repeat tile mode', group: 'View' },
  { keys: 'Ctrl+Z', label: 'Undo canvas edit (ignores palette tweaks)', group: 'Selection & Edit' },
  { keys: 'Ctrl+Shift+Z / Ctrl+Y', label: 'Redo canvas edit', group: 'Selection & Edit' },
  { keys: 'Ctrl+G / Ctrl+Shift+G', label: 'Group / Ungroup layers', group: 'Selection & Edit' },
  { keys: 'F2', label: 'Rename active layer', group: 'Layers' },
  { keys: 'Ctrl+J', label: 'Duplicate layer', group: 'Layers' },
  { keys: 'Ctrl+Alt+N', label: 'New layer', group: 'Layers' },
  { keys: 'Ctrl+Alt+E', label: 'Merge down', group: 'Layers' },
  { keys: 'Ctrl+Shift+E', label: 'Flatten visible', group: 'Layers' },
  { keys: 'Ctrl+] / Ctrl+[', label: 'Move layer up / down', group: 'Layers' },
  { keys: 'Ctrl+Shift+] / [', label: 'Layer to front / back', group: 'Layers' },
  { keys: 'Alt+] / Alt+[', label: 'Select layer above / below', group: 'Layers' },
  { keys: 'Right-click layer', label: 'Layer actions menu', group: 'Layers' },
  { keys: 'Ctrl+Click Layer', label: 'Select non-transparent layer pixels', group: 'Selection & Edit' },
  { keys: 'Ctrl+A / D / I', label: 'Select all / Deselect / Invert', group: 'Selection & Edit' },
  { keys: 'Ctrl+C / X / V', label: 'Copy / Cut / Paste (floating)', group: 'Selection & Edit' },
  { keys: 'Delete / Backspace', label: 'Clear selection / Delete vector point', group: 'Selection & Edit' },
  { keys: 'Enter / Esc', label: 'Commit / Cancel paste or shape', group: 'Selection & Edit' },
  { keys: ', / .', label: 'Previous / Next frame', group: 'Animation' },
  { keys: 'N', label: 'Toggle onion skin', group: 'Animation' },
  { keys: 'Space (timeline focused)', label: 'Play / Stop animation', group: 'Animation' },
  { keys: 'Ctrl+N / Alt+N', label: 'New document', group: 'Document' },
  { keys: 'Ctrl+S', label: 'Save project (.tintbox)', group: 'Document' },
  { keys: 'Ctrl+O', label: 'Open project (.tintbox / .aseprite / .psd / .gif)', group: 'Document' },
  { keys: 'Ctrl+E', label: 'Export (PNG / BMP / PSD / GIF / JS / Sheet / Zip)', group: 'Document' },
  { keys: 'Ctrl+,', label: 'Preferences (Theme, UI Scale, Canvas, History)', group: 'Document' },
  { keys: 'Alt+K', label: 'Create selection slice', group: 'Selection & Edit' },
  { keys: 'Alt+O / Alt+S', label: 'Auto organize tiles / Auto slice islands', group: 'Selection & Edit' },
  { keys: 'Alt+A / Alt+T', label: 'Slice & Animate / Create map tileset', group: 'Selection & Edit' },
  { keys: 'Alt+[ / Alt+] (Map)', label: 'Rotate tile brush CCW / CW', group: 'View' },
  { keys: 'Alt+H / Alt+V (Map)', label: 'Flip tile brush H / V', group: 'View' },
  { keys: '?', label: 'Keyboard shortcuts', group: 'Document' },
];

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, select, textarea, [contenteditable]'));
}

export type LayerKeyAction =
  | 'rename' | 'new' | 'duplicate' | 'merge-down' | 'flatten'
  | 'up' | 'down' | 'top' | 'bottom' | 'select-up' | 'select-down';

export interface KeyActions {
  setTool: (t: ToolId) => void;
  setMapTool: (t: MapToolId) => void;
  isMapMode: () => boolean;
  swapColors: () => void;
  stepBrush: (d: number) => void;
  stepZoom: (d: number) => void;
  zoom100: () => void;
  zoomFit: () => void;
  toggleGrid: () => void;
  toggleTileMode: () => void;
  toggleOnion: () => void;
  prevFrame: () => void;
  nextFrame: () => void;
  togglePlay: () => void;
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
  deselect: () => void;
  invertSelection: () => void;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  deleteSelection: () => void;
  commit: () => void;
  cancel: () => void;
  nudge: (dx: number, dy: number) => void;
  openNewDialog: () => void;
  openExportDialog: () => void;
  saveProject: () => void;
  openProject: () => void;
  openShortcutsDialog: () => void;
  openPreferencesDialog?: () => void;
  createSlice?: () => void;
  autoOrganizeTiles?: () => void;
  autoSlice?: () => void;
  sliceAndAnimate?: () => void;
  createMapTileset?: () => void;
  rotateMapTile?: (d: 1 | -1) => void;
  flipMapTileH?: () => void;
  flipMapTileV?: () => void;
  startFreeTransform?: () => void;
  groupLayers?: () => void;
  layerAction?: (a: LayerKeyAction) => void;
  ungroupLayers?: () => void;
  setSpacePan: (down: boolean) => void;
  isTimelineFocused: () => boolean;
  canNudge: () => boolean;
}

export function bindKeymap(win: Window, actions: KeyActions): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    if (document.querySelector('dialog[open]')) return;

    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (e.key === 'F2') { e.preventDefault(); actions.layerAction?.('rename'); return; }

    if (mod || e.altKey) {
      const code = e.code;
      const la = actions.layerAction;
      if (la && code === 'BracketRight' && mod && e.shiftKey) { e.preventDefault(); la('top'); return; }
      if (la && code === 'BracketLeft' && mod && e.shiftKey) { e.preventDefault(); la('bottom'); return; }
      if (la && code === 'BracketRight' && mod) { e.preventDefault(); la('up'); return; }
      if (la && code === 'BracketLeft' && mod) { e.preventDefault(); la('down'); return; }
      if (la && !actions.isMapMode() && code === 'BracketRight' && e.altKey && !mod) { e.preventDefault(); la('select-up'); return; }
      if (la && !actions.isMapMode() && code === 'BracketLeft' && e.altKey && !mod) { e.preventDefault(); la('select-down'); return; }
      if (la && mod && e.altKey && k === 'e') { e.preventDefault(); la('merge-down'); return; }
      if (la && mod && e.altKey && k === 'n') { e.preventDefault(); la('new'); return; }
      if (la && mod && e.shiftKey && k === 'e') { e.preventDefault(); la('flatten'); return; }
      if (la && mod && !e.shiftKey && !e.altKey && k === 'j') { e.preventDefault(); la('duplicate'); return; }
    }

    if (mod) {
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); actions.undo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); actions.redo(); return; }
      if (k === 'a') { e.preventDefault(); actions.selectAll(); return; }
      if (k === 'd') { e.preventDefault(); actions.deselect(); return; }
      if (k === 'i') { e.preventDefault(); actions.invertSelection(); return; }
      if (k === 'c') { e.preventDefault(); actions.copy(); return; }
      if (k === 'x') { e.preventDefault(); actions.cut(); return; }
      if (k === 'v') { e.preventDefault(); actions.paste(); return; }
      if (k === 'n') { e.preventDefault(); actions.openNewDialog(); return; }
      if (k === 's') { e.preventDefault(); actions.saveProject(); return; }
      if (k === 'o') { e.preventDefault(); actions.openProject(); return; }
      if (k === 'e') { e.preventDefault(); actions.openExportDialog(); return; }
      if (e.key === ',') { e.preventDefault(); actions.openPreferencesDialog?.(); return; }
      if (k === 't') { e.preventDefault(); actions.startFreeTransform?.(); return; }
      if (k === 'g' && !e.shiftKey) { e.preventDefault(); actions.groupLayers?.(); return; }
      if (k === 'g' && e.shiftKey) { e.preventDefault(); actions.ungroupLayers?.(); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); actions.stepZoom(1); return; }
      if (e.key === '-') { e.preventDefault(); actions.stepZoom(-1); return; }
      return;
    }

    if (e.altKey && k === 'n') {
      e.preventDefault();
      actions.openNewDialog();
      return;
    }
    if (e.altKey && !mod) {
      if (actions.isMapMode()) {
        if (e.code === 'BracketLeft') { e.preventDefault(); actions.rotateMapTile?.(-1); return; }
        if (e.code === 'BracketRight') { e.preventDefault(); actions.rotateMapTile?.(1); return; }
        if (k === 'h') { e.preventDefault(); actions.flipMapTileH?.(); return; }
        if (k === 'v') { e.preventDefault(); actions.flipMapTileV?.(); return; }
      } else {
        if (k === 'k') { e.preventDefault(); actions.createSlice?.(); return; }
        if (k === 'o') { e.preventDefault(); actions.autoOrganizeTiles?.(); return; }
        if (k === 's') { e.preventDefault(); actions.autoSlice?.(); return; }
        if (k === 'a') { e.preventDefault(); actions.sliceAndAnimate?.(); return; }
        if (k === 't') { e.preventDefault(); actions.createMapTileset?.(); return; }
      }
      return;
    }

    if (e.key === ' ') {
      if (actions.isTimelineFocused()) {
        if (!e.repeat) {
          e.preventDefault();
          actions.togglePlay();
        }
      } else {
        e.preventDefault();
        actions.setSpacePan(true);
      }
      return;
    }

    if (e.key === '?') { e.preventDefault(); actions.openShortcutsDialog(); return; }
    if (e.key === '#') { e.preventDefault(); actions.toggleGrid(); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); actions.stepZoom(1); return; }
    if (e.key === '-') { e.preventDefault(); actions.stepZoom(-1); return; }
    if (e.key === '1') { e.preventDefault(); actions.zoom100(); return; }
    if (e.key === '0') { e.preventDefault(); actions.zoomFit(); return; }
    if (e.key === '[') { e.preventDefault(); actions.stepBrush(-1); return; }
    if (e.key === ']') { e.preventDefault(); actions.stepBrush(1); return; }
    if (e.key === ',') { e.preventDefault(); actions.prevFrame(); return; }
    if (e.key === '.') { e.preventDefault(); actions.nextFrame(); return; }
    if (e.key === 'Enter') { actions.commit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); actions.cancel(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); actions.deleteSelection(); return; }
    if (k === 'x') { e.preventDefault(); actions.swapColors(); return; }
    if (k === 'n') { e.preventDefault(); actions.toggleOnion(); return; }
    if (k === 't') { e.preventDefault(); actions.toggleTileMode(); return; }

    if (actions.isMapMode()) {
      const mapMap: Record<string, MapToolId> = { b: 'brush', u: 'rect', g: 'fill', e: 'eraser', i: 'pick' };
      const mt = mapMap[k];
      if (mt) {
        e.preventDefault();
        actions.setMapTool(mt);
      }
      return;
    }

    if (actions.canNudge()) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); actions.nudge(-1, 0); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); actions.nudge(1, 0); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); actions.nudge(0, -1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); actions.nudge(0, 1); return; }
    }

    const tool = TOOL_KEYS[k];
    if (tool) {
      e.preventDefault();
      actions.setTool(tool);
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') actions.setSpacePan(false);
  };

  const onBlur = () => actions.setSpacePan(false);

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', onBlur);
  return () => {
    win.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('keyup', onKeyUp);
    win.removeEventListener('blur', onBlur);
  };
}
