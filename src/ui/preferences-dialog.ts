import { triggerDownload } from '../io/export-pack';
import type { AccentPresetId, AppPreferences, AppThemeId, CheckerStyle, UiDensity } from '../state/ui';
import type { AppController } from './controller';
import { h } from './dom';
import { icon } from './icons';

export interface PreferencesDialogApi {
  el: HTMLDialogElement;
  open: (initialTab?: PrefsTabId) => void;
}

export type PrefsTabId = 'appearance' | 'canvas' | 'tools' | 'performance' | 'export';

const TABS: { id: PrefsTabId; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'canvas', label: 'Canvas & Guides' },
  { id: 'tools', label: 'Tools & Input' },
  { id: 'performance', label: 'Performance' },
  { id: 'export', label: 'Export & Defaults' },
];

const THEMES: { id: AppThemeId; label: string; desc: string; swatch: [string, string, string] }[] = [
  { id: 'workbench', label: 'Workbench Dark', desc: 'Warm dark studio (default)', swatch: ['#14130f', '#1b1a15', '#c6f432'] },
  { id: 'charcoal', label: 'Studio Charcoal', desc: 'Neutral dark (Photoshop style)', swatch: ['#1e1e1e', '#2b2b2b', '#38a8ff'] },
  { id: 'obsidian', label: 'Obsidian Contrast', desc: 'High-contrast OLED black', swatch: ['#09090b', '#141418', '#f5b82e'] },
  { id: 'paper', label: 'Paper Light', desc: 'Daylight studio light theme', swatch: ['#f2f0ea', '#ffffff', '#1a6b4a'] },
  { id: 'system', label: 'System (Auto)', desc: 'Follow OS light / dark preference', swatch: ['#14130f', '#f2f0ea', '#c6f432'] },
];

const ACCENTS: { id: AccentPresetId; label: string; color: string }[] = [
  { id: 'theme', label: 'Theme default', color: 'conic-gradient(#c6f432, #38a8ff, #f5b82e, #1a6b4a, #c6f432)' },
  { id: 'lime', label: 'Lime', color: '#c6f432' },
  { id: 'cyan', label: 'Cyan', color: '#38a8ff' },
  { id: 'amber', label: 'Amber', color: '#f5b82e' },
  { id: 'coral', label: 'Coral', color: '#ff6b4a' },
  { id: 'violet', label: 'Violet', color: '#a78bfa' },
];

function openModal(dlg: HTMLDialogElement): void {
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
}

function closeModal(dlg: HTMLDialogElement): void {
  if (typeof dlg.close === 'function') {
    if (dlg.open) dlg.close();
  } else {
    dlg.removeAttribute('open');
    dlg.dispatchEvent(new Event('close'));
  }
}

export function createPreferencesDialog(ctrl: AppController): PreferencesDialogApi {
  let activeTab: PrefsTabId = 'appearance';

  const tabBtns: HTMLButtonElement[] = [];
  const tabPanels: HTMLElement[] = [];

  const selectTab = (id: PrefsTabId, focusTab = false) => {
    activeTab = id;
    TABS.forEach((t, idx) => {
      const sel = t.id === id;
      const btn = tabBtns[idx];
      const panel = tabPanels[idx];
      if (btn) {
        btn.setAttribute('aria-selected', String(sel));
        btn.tabIndex = sel ? 0 : -1;
        btn.toggleAttribute('focusgroupstart', sel);
        if (sel && focusTab) btn.focus();
      }
      if (panel) {
        panel.hidden = !sel;
      }
    });
  };

  const tablist = h('div', {
    class: 'prefs-tablist',
    role: 'tablist',
    focusgroup: 'tablist nomemory',
    'aria-label': 'Preference categories',
  });

  TABS.forEach((t, idx) => {
    const btn = h('button', {
      type: 'button',
      id: `prefs-tab-${t.id}`,
      role: 'tab',
      class: 'prefs-tab',
      'aria-selected': String(t.id === activeTab),
      tabIndex: t.id === activeTab ? 0 : -1,
      onClick: () => selectTab(t.id, false),
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          selectTab(TABS[(idx + 1) % TABS.length].id, true);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          selectTab(TABS[(idx - 1 + TABS.length) % TABS.length].id, true);
        } else if (e.key === 'Home') {
          e.preventDefault();
          selectTab(TABS[0].id, true);
        } else if (e.key === 'End') {
          e.preventDefault();
          selectTab(TABS[TABS.length - 1].id, true);
        }
      },
    }, t.label);
    if (t.id === activeTab) btn.setAttribute('focusgroupstart', '');
    tabBtns.push(btn);
    tablist.append(btn);
  });

  const segButtons = <T extends string | number>(
    ariaLabel: string,
    options: { value: T; label: string }[],
    getVal: () => T,
    onPick: (v: T) => void,
  ): { el: HTMLElement; sync: () => void } => {
    const btns = options.map((opt) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(getVal() === opt.value),
        onClick: () => onPick(opt.value),
      }, opt.label),
    );
    return {
      el: h('div', { class: 'btn-group prefs-seg', role: 'group', 'aria-label': ariaLabel }, ...btns),
      sync: () => {
        const cur = getVal();
        options.forEach((opt, i) => btns[i].setAttribute('aria-pressed', String(cur === opt.value)));
      },
    };
  };

  const syncers: (() => void)[] = [];

  // ---- 1. Appearance tab ----
  const themeCards = THEMES.map((th) => {
    const card = h(
      'button',
      {
        type: 'button',
        class: 'theme-card',
        'aria-pressed': String(ctrl.state.appPrefs.theme === th.id),
        onClick: () => ctrl.updateAppPrefs({ theme: th.id }),
      },
      h('span', { class: 'theme-swatches', 'aria-hidden': 'true' },
        h('span', { style: `background:${th.swatch[0]}` }),
        h('span', { style: `background:${th.swatch[1]}` }),
        h('span', { style: `background:${th.swatch[2]}` }),
      ),
      h('span', { class: 'theme-meta' },
        h('strong', {}, th.label),
        h('span', { class: 'hint' }, th.desc),
      ),
    );
    syncers.push(() => card.setAttribute('aria-pressed', String(ctrl.state.appPrefs.theme === th.id)));
    return card;
  });

  const accentBtns = ACCENTS.map((ac) => {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'accent-chip',
        'aria-pressed': String(ctrl.state.appPrefs.accent === ac.id),
        title: ac.label,
        onClick: () => ctrl.updateAppPrefs({ accent: ac.id }),
      },
      h('span', { class: 'accent-dot', style: `background:${ac.color}`, 'aria-hidden': 'true' }),
      ac.label,
    );
    syncers.push(() => b.setAttribute('aria-pressed', String(ctrl.state.appPrefs.accent === ac.id)));
    return b;
  });

  const scaleSeg = segButtons<AppPreferences['uiScale']>(
    'UI scale',
    [
      { value: 85, label: '85%' },
      { value: 90, label: '90%' },
      { value: 100, label: '100%' },
      { value: 110, label: '110%' },
      { value: 125, label: '125%' },
    ],
    () => ctrl.state.appPrefs.uiScale,
    (v) => ctrl.updateAppPrefs({ uiScale: v }),
  );
  syncers.push(scaleSeg.sync);

  const densitySeg = segButtons<UiDensity>(
    'UI density',
    [
      { value: 'compact', label: 'Compact' },
      { value: 'standard', label: 'Standard' },
      { value: 'comfortable', label: 'Comfortable' },
    ],
    () => ctrl.state.appPrefs.density,
    (v) => ctrl.updateAppPrefs({ density: v }),
  );
  syncers.push(densitySeg.sync);

  const appearancePane = h('div', { class: 'prefs-pane' },
    h('div', { class: 'prefs-group' },
      h('h2', {}, 'App Theme'),
      h('div', { class: 'theme-grid' }, ...themeCards),
    ),
    h('div', { class: 'prefs-group' },
      h('h2', {}, 'Accent Color'),
      h('div', { class: 'accent-row' }, ...accentBtns),
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'UI Scale'), h('p', { class: 'hint' }, 'Scales workspace chrome without blurring pixel canvas.')),
      scaleSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Control Density'), h('p', { class: 'hint' }, 'Adjusts spacing in toolbars and inspector panels.')),
      densitySeg.el,
    ),
  );

  // ---- 2. Canvas & Guides tab ----
  const checkerSizeSeg = segButtons<AppPreferences['checkerSize']>(
    'Checkerboard tile size',
    [{ value: 8, label: 'Small (8px)' }, { value: 16, label: 'Medium (16px)' }, { value: 24, label: 'Large (24px)' }],
    () => ctrl.state.appPrefs.checkerSize,
    (v) => ctrl.updateAppPrefs({ checkerSize: v }),
  );
  syncers.push(checkerSizeSeg.sync);

  const checkerStyleSeg = segButtons<CheckerStyle>(
    'Checkerboard contrast',
    [
      { value: 'dark', label: 'Dark' },
      { value: 'medium', label: 'Medium' },
      { value: 'light', label: 'Light' },
      { value: 'contrast', label: 'High Contrast' },
    ],
    () => ctrl.state.appPrefs.checkerStyle,
    (v) => ctrl.updateAppPrefs({ checkerStyle: v }),
  );
  syncers.push(checkerStyleSeg.sync);

  const gridMinZoomSeg = segButtons<AppPreferences['gridMinZoom']>(
    'Grid minimum zoom',
    [{ value: 4, label: '4×' }, { value: 8, label: '8×' }, { value: 12, label: '12×' }],
    () => ctrl.state.appPrefs.gridMinZoom,
    (v) => ctrl.updateAppPrefs({ gridMinZoom: v }),
  );
  syncers.push(gridMinZoomSeg.sync);

  const gridColorSeg = segButtons<AppPreferences['gridColor']>(
    'Grid line color',
    [{ value: 'auto', label: 'Auto' }, { value: 'white', label: 'White' }, { value: 'accent', label: 'Accent' }],
    () => ctrl.state.appPrefs.gridColor,
    (v) => ctrl.updateAppPrefs({ gridColor: v }),
  );
  syncers.push(gridColorSeg.sync);

  const gridOpacityIn = h('input', {
    id: 'pref-grid-opacity',
    type: 'range',
    min: 5,
    max: 40,
    value: ctrl.state.appPrefs.gridOpacity,
    'aria-label': 'Pixel grid opacity',
    onInput: () => ctrl.updateAppPrefs({ gridOpacity: Number(gridOpacityIn.value) }),
  });
  const gridOpacityOut = h('output', { class: 'mono' }, `${ctrl.state.appPrefs.gridOpacity}%`);
  syncers.push(() => {
    gridOpacityIn.value = String(ctrl.state.appPrefs.gridOpacity);
    gridOpacityOut.textContent = `${ctrl.state.appPrefs.gridOpacity}%`;
  });

  const gridDefaultBox = h('input', {
    id: 'pref-grid-default',
    type: 'checkbox',
    checked: ctrl.state.appPrefs.gridDefault,
    onChange: () => ctrl.updateAppPrefs({ gridDefault: gridDefaultBox.checked }),
  });
  const showSlicesBox = h('input', {
    id: 'pref-show-slices',
    type: 'checkbox',
    checked: ctrl.state.appPrefs.showSlices,
    onChange: () => ctrl.updateAppPrefs({ showSlices: showSlicesBox.checked }),
  });
  syncers.push(() => {
    gridDefaultBox.checked = ctrl.state.appPrefs.gridDefault;
    showSlicesBox.checked = ctrl.state.appPrefs.showSlices;
  });

  const defCanvasSeg = segButtons<AppPreferences['defaultCanvasSize']>(
    'Default new canvas size',
    [16, 32, 64, 128, 256].map((v) => ({ value: v as AppPreferences['defaultCanvasSize'], label: `${v}` })),
    () => ctrl.state.appPrefs.defaultCanvasSize,
    (v) => ctrl.updateAppPrefs({ defaultCanvasSize: v }),
  );
  syncers.push(defCanvasSeg.sync);

  const canvasPane = h('div', { class: 'prefs-pane' },
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Transparency Grid Size')),
      checkerSizeSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Transparency Grid Style')),
      checkerStyleSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Pixel Grid Min Zoom')),
      gridMinZoomSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Pixel Grid Color')),
      gridColorSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('label', { for: 'pref-grid-opacity' }, h('strong', {}, 'Pixel Grid Opacity')),
      h('div', { class: 'prefs-range-wrap' }, gridOpacityIn, gridOpacityOut),
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Default New Canvas')),
      defCanvasSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-checks' },
      h('label', { class: 'check-row', for: 'pref-grid-default' }, gridDefaultBox, 'Enable pixel grid on new sessions'),
      h('label', { class: 'check-row', for: 'pref-show-slices' }, showSlicesBox, 'Show Selection Slice overlays on canvas'),
    ),
  );

  // ---- 3. Tools & Input tab ----
  const brushOutlineSeg = segButtons<AppPreferences['brushOutline']>(
    'Brush cursor outline',
    [{ value: 'pixel', label: 'Pixel snapped' }, { value: 'crosshair', label: 'Crosshair only' }],
    () => ctrl.state.appPrefs.brushOutline,
    (v) => ctrl.updateAppPrefs({ brushOutline: v }),
  );
  syncers.push(brushOutlineSeg.sync);

  const wheelStepSeg = segButtons<AppPreferences['wheelZoomStep']>(
    'Mouse wheel zoom step',
    [{ value: 1, label: '1 step (precise)' }, { value: 2, label: '2 steps (fast)' }],
    () => ctrl.state.appPrefs.wheelZoomStep,
    (v) => ctrl.updateAppPrefs({ wheelZoomStep: v }),
  );
  syncers.push(wheelStepSeg.sync);

  const grabSrcSeg = segButtons<AppPreferences['grabSampleDefault']>(
    'Eyedropper sample source',
    [{ value: 'composed', label: 'All layers (composed)' }, { value: 'layer', label: 'Active layer' }],
    () => ctrl.state.appPrefs.grabSampleDefault,
    (v) => ctrl.updateAppPrefs({ grabSampleDefault: v }),
  );
  syncers.push(grabSrcSeg.sync);

  const ppBox = h('input', {
    id: 'pref-pp',
    type: 'checkbox',
    checked: ctrl.state.appPrefs.pixelPerfectDefault,
    onChange: () => ctrl.updateAppPrefs({ pixelPerfectDefault: ppBox.checked }),
  });
  const zoomCursorBox = h('input', {
    id: 'pref-zoom-cursor',
    type: 'checkbox',
    checked: ctrl.state.appPrefs.zoomToCursor,
    onChange: () => ctrl.updateAppPrefs({ zoomToCursor: zoomCursorBox.checked }),
  });
  const wrapBox = h('input', {
    id: 'pref-move-wrap',
    type: 'checkbox',
    checked: ctrl.state.appPrefs.moveWrapDefault,
    onChange: () => ctrl.updateAppPrefs({ moveWrapDefault: wrapBox.checked }),
  });
  const antsBox = h('input', {
    id: 'pref-ants',
    type: 'checkbox',
    checked: ctrl.state.appPrefs.animateMarchingAnts,
    onChange: () => ctrl.updateAppPrefs({ animateMarchingAnts: antsBox.checked }),
  });
  syncers.push(() => {
    ppBox.checked = ctrl.state.appPrefs.pixelPerfectDefault;
    zoomCursorBox.checked = ctrl.state.appPrefs.zoomToCursor;
    wrapBox.checked = ctrl.state.appPrefs.moveWrapDefault;
    antsBox.checked = ctrl.state.appPrefs.animateMarchingAnts;
  });

  const toolsPane = h('div', { class: 'prefs-pane' },
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Brush Cursor')),
      brushOutlineSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Wheel Zoom Speed')),
      wheelStepSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Color Grabber Sample')),
      grabSrcSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-checks' },
      h('label', { class: 'check-row', for: 'pref-pp' }, ppBox, 'Pixel-perfect 1px strokes by default'),
      h('label', { class: 'check-row', for: 'pref-zoom-cursor' }, zoomCursorBox, 'Zoom toward cursor position'),
      h('label', { class: 'check-row', for: 'pref-move-wrap' }, wrapBox, 'Wrap pixels at canvas edges with Move tool'),
      h('label', { class: 'check-row', for: 'pref-ants' }, antsBox, 'Animate selection marching ants'),
    ),
  );

  // ---- 4. Performance & History tab ----
  const undoSeg = segButtons<AppPreferences['maxUndoSteps']>(
    'Max undo history steps',
    [50, 100, 200, 500].map((v) => ({ value: v as AppPreferences['maxUndoSteps'], label: String(v) })),
    () => ctrl.state.appPrefs.maxUndoSteps,
    (v) => ctrl.updateAppPrefs({ maxUndoSteps: v }),
  );
  syncers.push(undoSeg.sync);

  const memSeg = segButtons<AppPreferences['maxHistoryMb']>(
    'Max history memory',
    [64, 128, 256, 512].map((v) => ({ value: v as AppPreferences['maxHistoryMb'], label: `${v} MB` })),
    () => ctrl.state.appPrefs.maxHistoryMb,
    (v) => ctrl.updateAppPrefs({ maxHistoryMb: v }),
  );
  syncers.push(memSeg.sync);

  const autosaveSeg = segButtons<AppPreferences['autosaveSeconds']>(
    'Autosave interval',
    [
      { value: 0, label: 'Off' },
      { value: 5, label: '5s' },
      { value: 10, label: '10s' },
      { value: 30, label: '30s' },
      { value: 60, label: '60s' },
    ],
    () => ctrl.state.appPrefs.autosaveSeconds,
    (v) => ctrl.updateAppPrefs({ autosaveSeconds: v }),
  );
  syncers.push(autosaveSeg.sync);

  const confirmCloseBox = h('input', {
    id: 'pref-confirm-close',
    type: 'checkbox',
    checked: ctrl.state.appPrefs.confirmUnsavedClose,
    onChange: () => ctrl.updateAppPrefs({ confirmUnsavedClose: confirmCloseBox.checked }),
  });
  syncers.push(() => { confirmCloseBox.checked = ctrl.state.appPrefs.confirmUnsavedClose; });

  const perfPane = h('div', { class: 'prefs-pane' },
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Undo History States'), h('p', { class: 'hint' }, 'Applied live across all open canvas tabs.')),
      undoSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'History Memory Budget'), h('p', { class: 'hint' }, 'Evicts oldest sparse diffs once cap is hit.')),
      memSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'IndexedDB Autosave'), h('p', { class: 'hint' }, 'Recovers unsaved work automatically after reload.')),
      autosaveSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-checks' },
      h('label', { class: 'check-row', for: 'pref-confirm-close' }, confirmCloseBox, 'Warn before closing browser tab with unsaved changes'),
    ),
  );

  // ---- 5. Export & Defaults tab ----
  const expFmtSeg = segButtons<AppPreferences['defaultExportFormat']>(
    'Default export format',
    [
      { value: 'png', label: 'PNG' },
      { value: 'gif', label: 'GIF' },
      { value: 'sheet', label: 'Sheet' },
      { value: 'psd', label: 'PSD' },
      { value: 'bmp', label: 'BMP' },
    ],
    () => ctrl.state.appPrefs.defaultExportFormat,
    (v) => ctrl.updateAppPrefs({ defaultExportFormat: v }),
  );
  syncers.push(expFmtSeg.sync);

  const expScaleSeg = segButtons<AppPreferences['defaultExportScale']>(
    'Default export scale',
    [1, 2, 4, 8].map((v) => ({ value: v as AppPreferences['defaultExportScale'], label: `${v}×` })),
    () => ctrl.state.appPrefs.defaultExportScale,
    (v) => ctrl.updateAppPrefs({ defaultExportScale: v }),
  );
  syncers.push(expScaleSeg.sync);

  const fpsSeg = segButtons<AppPreferences['defaultFps']>(
    'Default animation FPS',
    [4, 8, 12, 24].map((v) => ({ value: v as AppPreferences['defaultFps'], label: `${v} FPS` })),
    () => ctrl.state.appPrefs.defaultFps,
    (v) => ctrl.updateAppPrefs({ defaultFps: v }),
  );
  syncers.push(fpsSeg.sync);

  const prefsImportInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    class: 'visually-hidden',
    onChange: async () => {
      const f = prefsImportInput.files?.[0];
      prefsImportInput.value = '';
      if (f) ctrl.importAppPrefsJson(await f.text());
    },
  });

  const exportPane = h('div', { class: 'prefs-pane' },
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Default Export Format')),
      expFmtSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Default Export Scale')),
      expScaleSeg.el,
    ),
    h('div', { class: 'prefs-group prefs-row-line' },
      h('div', {}, h('strong', {}, 'Default Timeline FPS')),
      fpsSeg.el,
    ),
    h('div', { class: 'prefs-group' },
      h('h2', {}, 'Preferences Backup'),
      h('div', { class: 'action-bar' },
        h('button', {
          type: 'button',
          onClick: () => {
            triggerDownload(ctrl.exportAppPrefsJson(), 'application/json', 'tintbox-preferences.json');
            ctrl.showToast('Exported preferences JSON.', 'info');
          },
        }, icon('download', 14), ' Export JSON'),
        h('button', { type: 'button', onClick: () => prefsImportInput.click() }, icon('upload', 14), ' Import JSON'),
        prefsImportInput,
      ),
    ),
  );

  const paneMap: Record<PrefsTabId, HTMLElement> = {
    appearance: appearancePane,
    canvas: canvasPane,
    tools: toolsPane,
    performance: perfPane,
    export: exportPane,
  };

  const panelsHost = h('div', { class: 'prefs-panels' });
  TABS.forEach((t) => {
    const panel = h('div', {
      role: 'tabpanel',
      'aria-labelledby': `prefs-tab-${t.id}`,
      hidden: t.id !== activeTab,
    }, paneMap[t.id]);
    tabPanels.push(panel);
    panelsHost.append(panel);
  });

  const dlg = h(
    'dialog',
    { class: 'modal modal-prefs', 'aria-labelledby': 'dlg-prefs-title' },
    h('div', { class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-prefs-title' }, 'Preferences'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close preferences', onClick: () => closeModal(dlg) }, icon('x')),
      ),
      tablist,
      h('div', { class: 'modal-body prefs-body' }, panelsHost),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', onClick: () => ctrl.resetAppPrefs() }, 'Reset to defaults'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'primary', onClick: () => closeModal(dlg) }, 'Done'),
      ),
    ),
  );

  const syncAll = () => {
    for (const fn of syncers) fn();
  };
  ctrl.store.subscribe((s) => s.appPrefs, syncAll);

  return {
    el: dlg,
    open(initialTab?: PrefsTabId) {
      if (initialTab) selectTab(initialTab, false);
      syncAll();
      openModal(dlg);
    },
  };
}
