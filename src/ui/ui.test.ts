// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { computeDiff } from '../core/diff';
import { setPixel } from '../core/raster';
import { defaultWarpParams } from '../core/warp';
import { serializeTintboxArchive } from '../io/project-io';
import { encodePsd } from '../io/psd';
import { addFrameCommand, addLayerCommand, addPaletteCommand, layerPropCommand, pixelPatchCommand, setLayerFrameCountCommand } from '../state/commands';
import { mountApp, type MountedApp } from './app';

let app: MountedApp | null = null;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => null,
    configurable: true,
  });
});

afterEach(() => {
  app?.destroy();
  app = null;
  document.body.innerHTML = '';
});

describe('UI smoke tests (real core, no mocks)', () => {
  it('mounts workbench shell, switches tools via click and keyboard', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);

    expect(root.querySelector('.shell')).not.toBeNull();
    expect(root.querySelector('canvas.doc-canvas')?.getAttribute('role')).toBe('img');

    const eraserBtn = root.querySelector('button[aria-label="Eraser (E)"]') as HTMLButtonElement;
    expect(eraserBtn).not.toBeNull();
    eraserBtn.click();
    expect(app.ctrl.state.tool).toBe('eraser');
    expect(eraserBtn.getAttribute('aria-pressed')).toBe('true');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u' }));
    expect(app.ctrl.state.tool).toBe('rect');

    // Ignores shortcuts when typing in an input
    const fps = root.querySelector('#timeline-fps') as HTMLInputElement;
    fps.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    expect(app.ctrl.state.tool).toBe('rect');
  });

  it('handles Ctrl+Z / Ctrl+Shift+Z undo/redo shortcuts and updates button tooltips', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    const l0 = ctrl.state.doc.layers[0];
    const before = l0.cels[0].slice();
    const after = before.slice();
    setPixel(after, 64, 64, 2, 2, [255, 0, 0, 255]);
    const diff = computeDiff(before, after, 64, 64)!;
    ctrl.execute(pixelPatchCommand(l0.id, 0, diff, 'Pencil stroke'));

    const undoBtn = root.querySelector('button[aria-label="Undo"]') as HTMLButtonElement;
    expect(undoBtn.getAttribute('aria-disabled')).toBe('false');
    expect(undoBtn.title).toContain('Undo: Pencil stroke');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(l0.cels[0][(2 * 64 + 2) * 4 + 3]).toBe(0);
    expect(undoBtn.getAttribute('aria-disabled')).toBe('true');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }));
    expect(l0.cels[0][(2 * 64 + 2) * 4]).toBe(255);
  });

  it('refuses editing on locked layer with toast and supports layer/selection workflows', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    ctrl.execute(addLayerCommand('FG'));
    ctrl.execute(layerPropCommand(ctrl.state.activeLayerId, { locked: true }, 'Lock'));
    expect(ctrl.ensureEditableLayer()).toBeNull();
    expect(root.querySelector('.toast-error')?.textContent).toBe('Layer locked');

    // Selection + copy + paste + commit
    ctrl.execute(layerPropCommand(ctrl.state.activeLayerId, { locked: false }, 'Unlock'));
    const cel = ctrl.getActiveCel();
    const before = cel.slice();
    setPixel(cel, 64, 64, 0, 0, [10, 20, 30, 255]);
    ctrl.commitCelChange(before, 'Dot');
    ctrl.selectAllAction();
    ctrl.copySelection();
    ctrl.pasteClipboard();
    expect(ctrl.state.floating).not.toBeNull();
    expect(ctrl.commitFloating()).toBe(true);
    expect(ctrl.state.floating).toBeNull();
  });

  it('zoom shortcuts keep integer zoom steps and toggle grid', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
    expect(ctrl.state.viewport.zoom).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
    expect(ctrl.state.viewport.zoom).toBe(2);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '#' }));
    expect(ctrl.state.grid).toBe(true);
  });

  it('P2: palette restrict snaps drawing colors, orphan panel cleans lone pixel undoably, reference layer blocks drawing', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    // Restrict-to-palette snaps arbitrary color to nearest palette entry
    ctrl.toggleRestrictToPalette();
    const resolved = ctrl.resolveDrawColor([200, 240, 55, 255]);
    const palColors = ctrl.getActivePalette().colors.map((c) => c.rgba);
    expect(palColors.some((c) => c[0] === resolved[0] && c[1] === resolved[1] && c[2] === resolved[2])).toBe(true);

    // Orphan cleaner finds lone pixel, applies in 1 undo step, and undoes cleanly
    const cel = ctrl.getActiveCel();
    const before = cel.slice();
    setPixel(cel, 64, 64, 10, 10, [255, 0, 0, 255]);
    ctrl.commitCelChange(before, 'Dot');
    ctrl.openOrphanCleaner();
    expect(ctrl.state.orphanPreview).toHaveLength(1);
    expect(root.querySelector('.orphan-count')?.textContent).toBe('1 orphan found');
    ctrl.applyOrphanCleanup();
    expect(ctrl.getActiveCel()[(10 * 64 + 10) * 4 + 3]).toBe(0);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getActiveCel()[(10 * 64 + 10) * 4]).toBe(255);
  });

  it('P3: onion shortcut N never alters exported pixels, history panel jumps, named animations & palette badges work', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    // Draw on frame 0 and verify palette usage count badge appears
    const cel0 = ctrl.getActiveCel();
    const before = cel0.slice();
    setPixel(cel0, 64, 64, 1, 1, ctrl.getActivePalette().colors[6].rgba);
    ctrl.commitCelChange(before, 'Dot');
    expect(root.querySelector('.swatch-count')?.textContent).toBe('1');

    // Add frame 1, toggle onion skin with N, verify export bytes identical with onion on vs off
    const exportOff = ctrl.getComposed(0).slice();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
    expect(ctrl.state.onion.enabled).toBe(true);
    expect(ctrl.getComposed(0)).toEqual(exportOff);

    // History panel jump-to-0 reverts canvas cleanly
    const histBtns = root.querySelectorAll('.history-item');
    expect(histBtns.length).toBeGreaterThanOrEqual(2);
    (histBtns[0] as HTMLButtonElement).click();
    expect(ctrl.getActiveCel()[(1 * 64 + 1) * 4 + 3]).toBe(0);
  });

  it('P4: dirty indicator, Shadow & Palette-map modifiers, Export dialog (Ctrl+E), and corrupt open safety', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    // Fresh doc starts clean
    expect(ctrl.isDirty()).toBe(false);
    expect((root.querySelector('.dirty-dot') as HTMLElement).hidden).toBe(true);

    // Paint pixel -> doc becomes dirty
    const cel = ctrl.getActiveCel();
    const before = cel.slice();
    setPixel(cel, 64, 64, 4, 4, [240, 12, 180, 255]);
    ctrl.commitCelChange(before, 'Dot');
    expect(ctrl.isDirty()).toBe(true);
    expect((root.querySelector('.dirty-dot') as HTMLElement).hidden).toBe(false);

    // Add Shadow + Palette map modifiers via UI buttons
    const addBtns = Array.from(root.querySelectorAll('.mod-add-row button')) as HTMLButtonElement[];
    const shadowBtn = addBtns.find((b) => b.textContent?.includes('Shadow'));
    const palBtn = addBtns.find((b) => b.textContent?.includes('Palette'));
    expect(shadowBtn).toBeDefined();
    expect(palBtn).toBeDefined();
    shadowBtn?.click();
    palBtn?.click();
    expect(ctrl.getActiveLayer().modifiers.map((m) => m.type)).toEqual(['shadow', 'palette-map']);
    // Composed frame has shadow at (5,5) while source cel at (5,5) remains transparent
    const composed = ctrl.getComposed(0);
    expect(composed[(5 * 64 + 5) * 4 + 3]).toBeGreaterThan(0);
    expect(ctrl.getActiveCel()[(5 * 64 + 5) * 4 + 3]).toBe(0);

    // Ctrl+E opens Export dialog and updates live readout
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true }));
    const summary = root.querySelector('.export-summary') as HTMLElement;
    expect(summary.textContent).toContain('64×64 px');

    // Opening corrupt bytes leaves current doc untouched and shows error toast
    const okBad = ctrl.loadProjectBytes(new Uint8Array([9, 9, 9]));
    expect(okBad).toBe(false);
    expect(ctrl.getActiveCel()[(4 * 64 + 4) * 4]).toBe(240);
    expect(root.querySelector('.toast-error')).not.toBeNull();

    // Valid .tintbox round-trip restores doc and clears dirty state
    const savedBytes = serializeTintboxArchive(ctrl.state.doc);
    const okGood = ctrl.loadProjectBytes(savedBytes);
    expect(okGood).toBe(true);
    expect(ctrl.isDirty()).toBe(false);
    expect(ctrl.getActiveLayer().modifiers.map((m) => m.type)).toEqual(['shadow', 'palette-map']);
  });

  it('P5: T toggles Repeat Tile Mode, Tile Builder captures with dedupe, Map mode renders & links live', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    // Shortcut T toggles Repeat Tile Mode
    expect(ctrl.state.tileMode).toBe('none');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
    expect(ctrl.state.tileMode).toBe('xy');
    expect(root.querySelector('button[aria-label="Toggle repeat tile mode"]')?.getAttribute('aria-pressed')).toBe('true');

    // Paint pixel inside top-left 16x16 tile and capture
    const cel = ctrl.getActiveCel();
    const before = cel.slice();
    setPixel(cel, 64, 64, 2, 2, [198, 244, 50, 255]);
    ctrl.commitCelChange(before, 'Tile dot');
    expect(ctrl.captureTileFromSelection()).toBe(true);
    expect(ctrl.state.doc.tileset.tiles).toHaveLength(1);
    expect(root.querySelectorAll('.tile-card')).toHaveLength(1);

    // Capturing the exact same tile again warns and refuses duplicate
    expect(ctrl.captureTileFromSelection()).toBe(false);
    expect(ctrl.state.doc.tileset.tiles).toHaveLength(1);
    expect(root.querySelector('.toast-error')?.textContent).toContain('Duplicate tile');

    // Switch to Map mode -> map-stage visible, sprite stage hidden
    ctrl.setViewMode('map');
    expect((root.querySelector('.map-stage') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('#stage') as HTMLElement).hidden).toBe(true);

    // Save & reload `.tintbox` preserves tileset and tilemap
    const saved = serializeTintboxArchive(ctrl.state.doc);
    expect(ctrl.loadProjectBytes(saved)).toBe(true);
    expect(ctrl.state.doc.tileset.tiles).toHaveLength(1);
    expect(ctrl.state.doc.tileset.tiles[0].linked).toBe(true);
  });

  it('P6: D selects Dither brush, U exposes Star/Cube/Iso presets, C exposes Vector controls, and per-layer frame counts persist', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    // Shortcut D activates Dither brush + renders pattern selector
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    expect(ctrl.state.tool).toBe('dither');
    expect(root.querySelector('select[aria-label="Dither pattern"]')).not.toBeNull();

    // Shortcut U shows live shape preset buttons (Square/Oval/Star/Cube/Iso)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u' }));
    const presetBtns = Array.from(root.querySelectorAll('div[aria-label="Shape preset"] button')).map((b) => b.textContent);
    expect(presetBtns).toEqual(['Square', 'Oval', 'Star', 'Cube', 'Iso']);

    // Shortcut C activates Live Vector Path with Smooth/Closed/Width options
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
    expect(root.querySelector('input[aria-label="Vector stroke width"]')).not.toBeNull();

    // Per-layer frame counts: 4-frame doc with a 2-cel looping layer persists through .tintbox
    ctrl.execute(addFrameCommand(0, false));
    ctrl.execute(addFrameCommand(1, false));
    ctrl.execute(addFrameCommand(2, false));
    ctrl.execute(addLayerCommand('LoopGlow'));
    const glowId = ctrl.state.activeLayerId;
    ctrl.execute(setLayerFrameCountCommand(glowId, 2));
    expect(ctrl.state.doc.frames).toHaveLength(4);
    expect(ctrl.getActiveLayer().cels).toHaveLength(2);
    expect(root.querySelectorAll('.cel-cell.loop-cel').length).toBe(2);

    const bytes = serializeTintboxArchive(ctrl.state.doc);
    expect(ctrl.loadProjectBytes(bytes)).toBe(true);
    expect(ctrl.state.doc.frames).toHaveLength(4);
    expect(ctrl.state.doc.layers[1].cels).toHaveLength(2);
  });

  it('Polish & Photoshop layer fixes: direct color picker, Delete clears selection, Map isolates tools, Clipping mask & transforms work', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    // 1. Direct primary color picker in left tool rail updates primaryColor
    const priInput = root.querySelector('input.swatch-primary') as HTMLInputElement;
    expect(priInput).not.toBeNull();
    priInput.value = '#ff0044';
    priInput.dispatchEvent(new Event('input'));
    expect(ctrl.state.primaryColor).toEqual([255, 0, 68, 255]);

    // 2. Delete key clears selection undoably
    const cel = ctrl.getActiveCel();
    const before = cel.slice();
    setPixel(cel, 64, 64, 3, 3, [255, 0, 0, 255]);
    ctrl.commitCelChange(before, 'Dot');
    ctrl.selectAllAction();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(ctrl.getActiveCel()[(3 * 64 + 3) * 4 + 3]).toBe(0);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getActiveCel()[(3 * 64 + 3) * 4]).toBe(255);

    // 3. Bucket fill tolerance slider exists in optionsBar
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
    expect(root.querySelector('#opt-fill-tol')).not.toBeNull();

    // 4. Flip H transform flips pixel undoably
    ctrl.deselectAction();
    ctrl.transformActiveRegion('flip-h');
    expect(ctrl.getActiveCel()[(3 * 64 + 60) * 4]).toBe(255);
    expect(ctrl.getActiveCel()[(3 * 64 + 3) * 4 + 3]).toBe(0);

    // 5. Map mode hides Sprite tool rail & Timeline and routes B/U/G/E/I to Map tools
    ctrl.setViewMode('map');
    expect((root.querySelector('.tools') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('.time') as HTMLElement).hidden).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
    expect(ctrl.state.mapTool).toBe('fill');

    // 6. Clipping mask toggle on upper layer works undoably
    ctrl.setViewMode('sprite');
    ctrl.execute(addLayerCommand('Clipped'));
    const clipBtn = root.querySelector('button[aria-label="Toggle Clipped clipping mask"]') as HTMLButtonElement;
    expect(clipBtn).not.toBeNull();
    clipBtn.click();
    expect(ctrl.getActiveLayer().clipped).toBe(true);
  });

  it('Pro wave: multi-tab isolation, Warp undo, Upscaler scale, Pen/Bezier P shortcut, PSD load, Dither/Light/Tone modifiers, JS/BMP export UI', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    // 1. Multi-tab Photoshop isolation (independent docs + undo histories)
    const tab1Id = ctrl.state.activeTabId;
    const cel1 = ctrl.getActiveCel();
    const b1 = cel1.slice();
    setPixel(cel1, 64, 64, 5, 5, [255, 10, 10, 255]);
    ctrl.commitCelChange(b1, 'Tab1 dot');
    expect(root.querySelectorAll('.doc-tab')).toHaveLength(1);

    const addTabBtn = root.querySelector('button[aria-label="New canvas tab"]') as HTMLButtonElement;
    expect(addTabBtn).not.toBeNull();
    addTabBtn.click();
    expect(root.querySelectorAll('.doc-tab')).toHaveLength(2);
    expect(ctrl.state.activeTabId).not.toBe(tab1Id);
    expect(ctrl.getActiveCel()[(5 * 64 + 5) * 4 + 3]).toBe(0);
    expect(ctrl.history.canUndo).toBe(false);

    ctrl.switchTab(tab1Id);
    expect(ctrl.getActiveCel()[(5 * 64 + 5) * 4]).toBe(255);
    expect(ctrl.history.canUndo).toBe(true);

    // 2. Warp apply + undo
    const wp = defaultWarpParams();
    wp.preset = 'arc';
    wp.strength = 60;
    expect(ctrl.applyWarp(wp)).toBe(true);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getActiveCel()[(5 * 64 + 5) * 4]).toBe(255);

    // 3. Upscaler scale (epx2x) + undo
    ctrl.scaleCanvas(128, 128, 'epx2x');
    expect(ctrl.state.doc.w).toBe(128);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.state.doc.w).toBe(64);

    // 4. Pen / Bezier shortcut P + Curvature slider + Fill toggle
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
    expect(ctrl.state.tool).toBe('curve');
    expect(root.querySelector('#opt-curve-tension')).not.toBeNull();

    // 5. Dither, Lighting (2D light pad), and Tone modifiers in UI
    const addDither = Array.from(root.querySelectorAll('.mod-add-row button')).find((b) => b.textContent === '+ Dither') as HTMLButtonElement;
    const addLight = Array.from(root.querySelectorAll('.mod-add-row button')).find((b) => b.textContent === '+ Light') as HTMLButtonElement;
    const addTone = Array.from(root.querySelectorAll('.mod-add-row button')).find((b) => b.textContent === '+ Tone') as HTMLButtonElement;
    expect(addDither).toBeDefined();
    expect(addLight).toBeDefined();
    expect(addTone).toBeDefined();
    addDither.click();
    addLight.click();
    addTone.click();
    expect(root.querySelector('.light-pad')).not.toBeNull();
    expect(ctrl.getActiveLayer().modifiers.map((m) => m.type)).toEqual(['dither', 'lighting', 'tone']);

    // 6. PSD load round-trip directly through controller.loadProjectBytes
    ctrl.execute(addLayerCommand('TopLayer'));
    const psdBytes = encodePsd(ctrl.state.doc, 0);
    expect(ctrl.loadProjectBytes(psdBytes, { inNewTab: true, name: 'LoadedPSD' })).toBe(true);
    expect(root.querySelectorAll('.doc-tab')).toHaveLength(3);
    expect(ctrl.state.doc.layers.length).toBe(2);
    expect(ctrl.state.doc.layers[1].name).toBe('TopLayer');

    // 7. Export dialog exposes BMP, PSD, JS, Upscaler, and live JS preview
    const expSel = root.querySelector('#exp-format') as HTMLSelectElement;
    const expValues = Array.from(expSel.options).map((o) => o.value);
    expect(expValues).toEqual(expect.arrayContaining(['png', 'bmp', 'psd', 'gif', 'sheet', 'sequence', 'js']));
    expect(root.querySelector('#exp-algo')).not.toBeNull();
    expSel.value = 'js';
    expSel.dispatchEvent(new Event('change'));
    const jsPreview = root.querySelector('#exp-js-preview') as HTMLTextAreaElement;
    expect(jsPreview.value).toContain('export const sprite');
  });

  it('Photoshop Essentials wave (15 items): 10-menu bar, scoped undo, lock symmetry, groups, layer/effect masks, Ctrl+Click select, gradient, direct transform, 0.2px brush, scroll/zoom bars, slider drag fix', () => {
    const root = document.createElement('div');
    document.body.append(root);
    app = mountApp(root);
    const { ctrl } = app;

    // 1. Photoshop 11-menu top bar (File, Edit, View, Selection, Tools, Window, Effect, Assets, Template, Settings)
    const menuLabels = Array.from(root.querySelectorAll('.app-menubar .menubar-trigger')).map((b) => b.textContent);
    expect(menuLabels).toEqual(['File', 'Edit', 'Layer', 'View', 'Selection', 'Tools', 'Window', 'Effect', 'Assets', 'Template', 'Settings']);

    // 2. Scoped Undo/Redo: palette change does NOT hijack canvas Ctrl+Z
    const cel = ctrl.getActiveCel();
    const b0 = cel.slice();
    setPixel(cel, 64, 64, 4, 4, [255, 0, 0, 255]);
    ctrl.commitCelChange(b0, 'Canvas dot');
    ctrl.execute(addPaletteCommand('MyPal', [[10, 20, 30, 255]]));
    expect(ctrl.state.doc.palettes).toHaveLength(2);
    expect(ctrl.undo()).toBe(true); // undoes Canvas dot, keeps MyPal!
    expect(ctrl.getActiveCel()[(4 * 64 + 4) * 4 + 3]).toBe(0);
    expect(ctrl.state.doc.palettes).toHaveLength(2);
    expect(ctrl.undoSettings()).toBe(true); // dedicated settings undo reverts palette
    expect(ctrl.state.doc.palettes).toHaveLength(1);

    // 3. Lock symmetrical line
    expect(ctrl.state.symmetry.locked).toBe(false);
    const lockSymBtn = root.querySelector('button[aria-label="Lock symmetry line"]') as HTMLButtonElement;
    lockSymBtn.click();
    expect(ctrl.state.symmetry.locked).toBe(true);

    // 4. Layer Group & Ungroup (Ctrl+G / Ctrl+Shift+G)
    ctrl.execute(addLayerCommand('L2'));
    ctrl.store.setState({ selectedLayerIds: ctrl.state.doc.layers.map((l) => l.id) });
    ctrl.groupSelectedLayers();
    expect(ctrl.state.doc.groups).toHaveLength(1);
    expect(root.querySelector('.layer-group-row')).not.toBeNull();
    ctrl.ungroupActiveGroup();
    expect(ctrl.state.doc.groups).toHaveLength(0);

    // 5. Ctrl+Click layer preview selects non-transparent layer pixels
    const c2 = ctrl.getActiveCel();
    const b2 = c2.slice();
    setPixel(c2, 64, 64, 8, 8, [0, 255, 0, 255]);
    ctrl.commitCelChange(b2, 'Green dot');
    const thumbBtn = root.querySelector('.layer-thumb-btn') as HTMLButtonElement;
    thumbBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(ctrl.state.selection).not.toBeNull();

    // 6. Layer Mask + Effect Mask + slider drag isolation (draggable=false on .mod card body)
    ctrl.addLayerMask(false);
    expect(ctrl.getActiveLayer().layerMask).toBeDefined();
    expect(root.querySelector('.layer-mask-btn')).not.toBeNull();
    expect(root.querySelector('.mask-edit-badge')).not.toBeNull();

    const addDither = Array.from(root.querySelectorAll('.mod-add-row button')).find((b) => b.textContent === '+ Dither') as HTMLButtonElement;
    addDither.click();
    const modCardEl = root.querySelector('.mod') as HTMLElement;
    expect(modCardEl.draggable).toBe(false);
    const modRange = modCardEl.querySelector('input[type="range"]') as HTMLInputElement;
    expect(modRange.draggable).toBe(false);
    const paintEffBtn = root.querySelector('button[aria-label="Paint dither effect mask"]') as HTMLButtonElement;
    paintEffBtn.click();
    expect(ctrl.state.editTarget).toBe('mod-mask');

    // 7. Dither Gradient tool (K) & Direct-canvas Move/Resize/Warp (Ctrl+T) & 0.2px brush & Canvas scroll/zoom bars
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    expect(ctrl.state.tool).toBe('gradient');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
    expect(ctrl.state.tool).toBe('move');
    expect(ctrl.state.moveMode).toBe('resize');
    ctrl.store.setState({ moveMode: 'warp' });
    expect(root.querySelector('select[aria-label="Direct warp preset"]')).not.toBeNull();

    ctrl.setTool('pencil');
    ctrl.stepBrushSize(-1);
    expect(ctrl.state.brushSize).toBe(0.8);
    expect(root.querySelector('.stage-zoom-range')).not.toBeNull();
    expect(root.querySelector('.stage-scroll-h')).not.toBeNull();
    expect(root.querySelector('.stage-scroll-v')).not.toBeNull();
  });

  describe('Photoshop-style layer controls', () => {
    const mount = () => {
      const root = document.createElement('div');
      document.body.append(root);
      app = mountApp(root);
      return root;
    };
    const key = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));

    it('double-click on a layer name opens the rename input and Enter commits one undoable step', () => {
      const root = mount();
      const nameBtn = root.querySelector('.layer .layer-name') as HTMLButtonElement;
      nameBtn.click();
      (root.querySelector('.layer .layer-name') as HTMLButtonElement).click();
      (root.querySelector('.layer .layer-name') as HTMLButtonElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const input = root.querySelector('.layer input.rename-input') as HTMLInputElement;
      expect(input).not.toBeNull();
      input.value = 'Outline';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(app!.ctrl.getActiveLayer().name).toBe('Outline');
      app!.ctrl.undo();
      expect(app!.ctrl.getActiveLayer().name).not.toBe('Outline');
    });

    it('F2 starts rename of the active layer', () => {
      const root = mount();
      key({ key: 'F2' });
      expect(app!.ctrl.state.renamingLayerId).toBe(app!.ctrl.state.activeLayerId);
      expect(root.querySelector('.layer input.rename-input')).not.toBeNull();
    });

    it('Ctrl+J duplicates, Ctrl+] / Ctrl+[ reorder, Alt+[ selects below', () => {
      mount();
      const { ctrl } = app!;
      const firstId = ctrl.state.activeLayerId;
      key({ key: 'j', ctrlKey: true });
      expect(ctrl.state.doc.layers).toHaveLength(2);
      const dupId = ctrl.state.activeLayerId;
      expect(dupId).not.toBe(firstId);
      key({ key: '[', code: 'BracketLeft', ctrlKey: true });
      expect(ctrl.state.doc.layers[0].id).toBe(dupId);
      key({ key: ']', code: 'BracketRight', ctrlKey: true });
      expect(ctrl.state.doc.layers[1].id).toBe(dupId);
      key({ key: '[', code: 'BracketLeft', altKey: true });
      expect(ctrl.state.activeLayerId).toBe(firstId);
    });

    it('right-click opens layer menu; Escape closes it', () => {
      const root = mount();
      (root.querySelector('.layer') as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(document.querySelector('.ctx-menu [role="menuitem"]')).not.toBeNull();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(document.querySelector('.ctx-menu')).toBeNull();
    });

    it('delete is blocked on the last layer', () => {
      mount();
      app!.ctrl.deleteActiveLayer();
      expect(app!.ctrl.state.doc.layers).toHaveLength(1);
    });

    it('Ctrl+Click on group folder selects combined visible pixels of all group members', () => {
      const root = mount();
      const { ctrl } = app!;
      const l1 = ctrl.state.doc.layers[0];
      setPixel(l1.cels[0], 64, 64, 1, 1, [255, 0, 0, 255]);
      ctrl.execute(addLayerCommand('L2'));
      const l2 = ctrl.getActiveLayer();
      setPixel(l2.cels[0], 64, 64, 5, 5, [0, 255, 0, 255]);
      ctrl.store.setState({ selectedLayerIds: [l1.id, l2.id] });
      ctrl.groupSelectedLayers();

      const folderBtn = root.querySelector('.layer-group-thumb-btn') as HTMLButtonElement;
      expect(folderBtn).not.toBeNull();
      folderBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      const sel = ctrl.state.selection;
      expect(sel).not.toBeNull();
      // Both (1,1) from l1 and (5,5) from l2 should be selected
      const bit = (x: number, y: number) => ((sel!.bits[(y * 64 + x) >> 3] >> ((y * 64 + x) & 7)) & 1) === 1;
      expect(bit(1, 1)).toBe(true);
      expect(bit(5, 5)).toBe(true);
      expect(bit(2, 2)).toBe(false);
    });

    it('grouping non-adjacent layers makes them contiguous and drag/drop adds & removes group members undoably', () => {
      mount();
      const { ctrl } = app!;
      const l1 = ctrl.state.doc.layers[0];
      ctrl.execute(addLayerCommand('L2'));
      const l2 = ctrl.getActiveLayer();
      ctrl.execute(addLayerCommand('L3'));
      const l3 = ctrl.getActiveLayer();

      // Group l1 and l3 (non-adjacent) -> moves l1 next to l3
      ctrl.store.setState({ selectedLayerIds: [l1.id, l3.id] });
      ctrl.groupSelectedLayers();
      const gid = l3.groupId!;
      expect(gid).toBeDefined();
      expect(ctrl.state.doc.layers.map((l) => l.id)).toEqual([l2.id, l1.id, l3.id]);

      // Drag l2 INTO the group
      ctrl.dropLayers([l2.id], { kind: 'group', id: gid, position: 'into' }, null);
      expect(l2.groupId).toBe(gid);
      expect(ctrl.state.doc.layers.map((l) => l.id)).toEqual([l1.id, l3.id, l2.id]);

      // Drag l2 OUT above the group header (even though all layers are in the group!)
      ctrl.dropLayers([l2.id], { kind: 'group', id: gid, position: 'above' }, null);
      expect(l2.groupId).toBeUndefined();
      expect(ctrl.state.doc.layers.map((l) => l.id)).toEqual([l1.id, l3.id, l2.id]);

      // Undo puts l2 back in the group
      ctrl.undo();
      expect(l2.groupId).toBe(gid);

      // Drag l1 out to bottom of list -> ungrouped
      ctrl.dropLayers([l1.id], { kind: 'end' }, null);
      expect(l1.groupId).toBeUndefined();
      expect(ctrl.state.doc.layers[0].id).toBe(l1.id);
    });

    it('UI polish (#8-#11): clean first-load defaults, 2-row mod header, single eyedropper, Esc closes onion settings', () => {
      const root = mount();
      const { ctrl } = app!;

      // #9: Only Palette and Layers expanded on first load; timeline collapsed
      expect(ctrl.state.collapsed.mods).toBe(true);
      expect(ctrl.state.collapsed.tiles).toBe(true);
      expect(ctrl.state.collapsed.ramp).toBe(true);
      expect(ctrl.state.collapsed.history).toBe(true);
      expect(ctrl.state.collapsed.palette).toBeFalsy();
      expect(ctrl.state.collapsed.layers).toBeFalsy();
      expect(ctrl.state.timelineOpen).toBe(false);

      // #10: No duplicate zoom readout in header; single eyedropper in left rail; clean layer footer with More menu
      expect(root.querySelector('header.top .zoom-readout')).toBeNull();
      expect(root.querySelectorAll('.tools button[aria-label*="eyedropper" i], .tools button[aria-label*="grabber" i]')).toHaveLength(1);
      const moreBtn = root.querySelector('.layer-footer button[aria-label="More layer actions"]') as HTMLButtonElement;
      expect(moreBtn).not.toBeNull();
      moreBtn.click();
      expect(document.querySelector('.ctx-menu[aria-label="More layer actions"]')).not.toBeNull();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(document.querySelector('.ctx-menu')).toBeNull();

      // #8: Modifier card separates header name from action buttons row
      const addColor = Array.from(root.querySelectorAll('.mod-add-row button')).find((b) => b.textContent === '+ Color') as HTMLButtonElement;
      addColor.click();
      expect(root.querySelector('.mod header.mod-head .mod-title')?.textContent).toBe('color');
      expect(root.querySelectorAll('.mod .mod-actions button').length).toBe(6);

      // #11: Onion skin settings popover opens and closes on Escape
      const onionOpts = root.querySelector('button[aria-label="Onion skin settings"]') as HTMLButtonElement;
      const onionBar = root.querySelector('.onion-bar') as HTMLElement;
      expect(onionBar.hidden).toBe(true);
      onionOpts.click();
      expect(onionBar.hidden).toBe(false);
      key({ key: 'Escape' });
      expect(onionBar.hidden).toBe(true);
    });

    it('moving/nudging a selected group moves ALL layers inside the group together in 1 undo step', () => {
      const root = mount();
      const { ctrl } = app!;
      const l1 = ctrl.state.doc.layers[0];
      setPixel(l1.cels[0], 64, 64, 4, 4, [255, 0, 0, 255]);
      ctrl.execute(addLayerCommand('L2'));
      const l2 = ctrl.getActiveLayer();
      setPixel(l2.cels[0], 64, 64, 10, 10, [0, 255, 0, 255]);
      ctrl.store.setState({ selectedLayerIds: [l1.id, l2.id] });
      ctrl.groupSelectedLayers();

      // Click group row to select whole group, then nudge right by 3px
      (root.querySelector('.layer-group-row') as HTMLElement).click();
      expect(ctrl.state.selectedLayerIds).toEqual([l1.id, l2.id]);
      ctrl.nudge(3, 2);
      expect(l1.cels[0][(6 * 64 + 7) * 4]).toBe(255);
      expect(l1.cels[0][(4 * 64 + 4) * 4 + 3]).toBe(0);
      expect(l2.cels[0][(12 * 64 + 13) * 4 + 1]).toBe(255);
      expect(l2.cels[0][(10 * 64 + 10) * 4 + 3]).toBe(0);

      // Single Undo restores BOTH layers in the group
      expect(ctrl.undo()).toBe(true);
      expect(l1.cels[0][(4 * 64 + 4) * 4]).toBe(255);
      expect(l2.cels[0][(10 * 64 + 10) * 4 + 1]).toBe(255);
    });

    it('Ctrl+Click on the group row background selects combined pixels of all group layers', () => {
      const root = mount();
      const { ctrl } = app!;
      const l1 = ctrl.state.doc.layers[0];
      setPixel(l1.cels[0], 64, 64, 2, 2, [255, 0, 0, 255]);
      ctrl.execute(addLayerCommand('L2'));
      const l2 = ctrl.getActiveLayer();
      setPixel(l2.cels[0], 64, 64, 9, 9, [0, 0, 255, 255]);
      ctrl.store.setState({ selectedLayerIds: [l1.id, l2.id] });
      ctrl.groupSelectedLayers();

      const groupRow = root.querySelector('.layer-group-row') as HTMLElement;
      groupRow.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      const sel = ctrl.state.selection;
      expect(sel).not.toBeNull();
      const bit = (x: number, y: number) => ((sel!.bits[(y * 64 + x) >> 3] >> ((y * 64 + x) & 7)) & 1) === 1;
      expect(bit(2, 2)).toBe(true);
      expect(bit(9, 9)).toBe(true);
    });

    it('added effects appear right below the selected layer in Layers panel (Photoshop-style fx tree)', () => {
      const root = mount();
      const { ctrl } = app!;
      const addOutline = Array.from(root.querySelectorAll('.mod-add-row button')).find((b) => b.textContent === '+ Outline') as HTMLButtonElement;
      addOutline.click();

      // Effect tree appears right below the layer row inside .layer-list
      const fxTree = root.querySelector('.layer-list .layer-fx-tree');
      expect(fxTree).not.toBeNull();
      expect(fxTree?.querySelector('.layer-fx-name')?.textContent).toBe('Outline');

      // Clicking the effect row expands Modifiers panel and focuses the card
      expect(ctrl.state.collapsed.mods).toBe(true);
      (fxTree?.querySelector('.layer-fx-name') as HTMLButtonElement).click();
      expect(ctrl.state.collapsed.mods).toBe(false);
      expect(root.querySelector('.mod.mod-focused')).not.toBeNull();

      // Master Effects eye toggles all layer effects off and back on
      const masterEye = fxTree?.querySelector('.layer-fx-head button') as HTMLButtonElement;
      masterEye.click();
      expect(ctrl.getActiveLayer().modifiers[0].enabled).toBe(false);
      ctrl.undo();
      expect(ctrl.getActiveLayer().modifiers[0].enabled).toBe(true);

      // fx pill collapses/expands the tree
      const fxPill = root.querySelector('.layer .layer-fx-toggle') as HTMLButtonElement;
      fxPill.click();
      expect(root.querySelector('.layer-list .layer-fx-tree')).toBeNull();
      fxPill.click();
      expect(root.querySelector('.layer-list .layer-fx-tree')).not.toBeNull();
    });

    it('Manabit features & Preferences dialog: Smart Commands, Slices, Navigator, Map transforms, Themes & UI scale', () => {
      const root = mount();
      const { ctrl } = app!;

      // 1. Preferences dialog (Ctrl+,): theme, accent, UI scale, history limit, tabs
      key({ key: ',', ctrlKey: true });
      const prefsDlg = root.querySelector('dialog.modal-prefs') as HTMLDialogElement;
      expect(prefsDlg).not.toBeNull();
      expect(prefsDlg.hasAttribute('open')).toBe(true);

      // Switch to Paper Light theme and 110% UI scale -> reflected live on <html>
      const paperBtn = Array.from(prefsDlg.querySelectorAll('.theme-card')).find((b) => b.textContent?.includes('Paper Light')) as HTMLButtonElement;
      paperBtn.click();
      expect(document.documentElement.dataset.theme).toBe('paper');
      expect(document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content).toBe('light');

      ctrl.updateAppPrefs({ uiScale: 110, maxUndoSteps: 500 });
      expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.1');
      expect(ctrl.history.maxSteps).toBe(500);

      // Reset prefs restores Workbench Dark + 100% scale
      ctrl.resetAppPrefs();
      expect(ctrl.state.appPrefs.theme).toBe('workbench');
      expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1');
      (prefsDlg.querySelector('button[aria-label="Close preferences"]') as HTMLButtonElement).click();

      // 2. Selection Slices (Alt+K) + Auto Slice (Alt+S) + Slice & Animate (Alt+A)
      const cel = ctrl.getActiveCel();
      setPixel(cel, 64, 64, 2, 2, [255, 0, 0, 255]);
      setPixel(cel, 64, 64, 20, 2, [0, 255, 0, 255]);
      expect(ctrl.autoSliceAction()).toBe(2);
      expect(ctrl.state.doc.slices).toHaveLength(2);
      expect(root.querySelectorAll('.slice-row')).toHaveLength(2);

      // Slice & Animate opens a new 2-frame animation tab leaving source untouched
      expect(ctrl.sliceAndAnimateAction()).toBe(true);
      expect(ctrl.state.tabs).toHaveLength(2);
      expect(ctrl.state.doc.frames).toHaveLength(2);
      expect(ctrl.state.timelineOpen).toBe(true);

      // 3. Independent Navigator sync toggle
      const navSyncBtn = root.querySelector('.nav-top-row button') as HTMLButtonElement;
      expect(ctrl.state.navSync).toBe(true);
      navSyncBtn.click();
      expect(ctrl.state.navSync).toBe(false);

      // 4. Map Builder tile transform shortcuts (Alt+] rotate, Alt+H flip)
      ctrl.setViewMode('map');
      key({ key: ']', code: 'BracketRight', altKey: true });
      expect(ctrl.state.mapTileRot).toBe(1);
      key({ key: 'h', altKey: true });
      expect(ctrl.state.mapTileFlipH).toBe(true);

      // 5. Android Drawing Pad pill opens connection dialog
      const padBtn = root.querySelector('button.pad-pill') as HTMLButtonElement;
      expect(padBtn).not.toBeNull();
      padBtn.click();
      const padTitle = root.querySelector('#dlg-pad-title');
      expect(padTitle?.textContent).toContain('Android Drawing Pad');
    });
  });
});
