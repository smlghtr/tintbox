import { countPaletteUsage } from '../core/animation';
import { nearestPaletteColor } from '../core/color';
import { cloneModifier, newModifier } from '../core/doc';
import { applyModifiers } from '../core/modifiers';
import { hexToRgba, makeRamp, makeTriadRamp, rgbaEqual, rgbaToHex } from '../core/palette';
import { cloneMask } from '../core/selection';
import { resolveTilePixels, TILE_CATEGORIES, TILE_SIZE_PRESETS } from '../core/tiles';
import type { BlendMode, ColorMod, DitherMod, Layer, LayerGroup, LightingMod, Modifier, OutlineMod, PaletteMapMod, RGBA, ShadowMod, TileCategory, ToneMod } from '../core/types';
import { exportTileMapJson, exportTilesetAtlasPngBytes, triggerDownload } from '../io/export-pack';
import { exportPaletteFile, importPaletteFile } from '../io/palette-io';
import {
  addLayerCommand,
  addModifierCommand,
  addPaletteCommand,
  appendPaletteColorsCommand,
  bakeModifierCommand,
  duplicateLayerCommand,
  duplicateModifierCommand,
  groupPropCommand,
  layerPropCommand,
  referencePropCommand,
  removeLayerCommand,
  removeModifierCommand,
  removePaletteCommand,
  removeSwatchCommand,
  removeTileCommand,
  renamePaletteCommand,
  reorderModifierCommand,
  reorderSwatchCommand,
  setActivePaletteCommand,
  setTileSizeCommand,
  soloLayerVisibilityCommand,
  toggleAllLayerModifiersCommand,
  toggleSwatchLockCommand,
  updateModifierCommand,
  updateTileMetaCommand,
} from '../state/commands';
import type { AppController } from './controller';
import type { ExtractSourcePreset } from './dialogs';
import { h, sliderField } from './dom';
import { icon } from './icons';

const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten', 'difference'];

const MOD_LABELS: Record<Modifier['type'], string> = {
  color: 'Color HSL',
  outline: 'Outline',
  shadow: 'Drop shadow',
  'palette-map': 'Palette map',
  dither: 'Dither',
  lighting: 'Lighting',
  tone: 'Shadow & Highlight',
};

function collapsiblePanel(
  ctrl: AppController,
  id: string,
  title: string,
  body: HTMLElement,
): HTMLElement {
  const chev = h('span', { class: 'chev' });
  const toggleBtn = h('button', {
    type: 'button',
    class: 'panel-toggle',
    'aria-controls': `panel-body-${id}`,
    onClick: () => ctrl.togglePanelCollapsed(id),
  }, chev, title);

  body.id = `panel-body-${id}`;
  const sec = h('section', { class: 'panel' }, h('h2', {}, toggleBtn), body);

  const sync = () => {
    const collapsed = Boolean(ctrl.state.collapsed[id]);
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    body.hidden = collapsed;
    chev.replaceChildren(icon(collapsed ? 'chevRight' : 'chevDown', 14));
  };
  sync();
  ctrl.store.subscribe((s) => Boolean(s.collapsed[id]), sync);
  return sec;
}

function drawThumbnail(canvas: HTMLCanvasElement, layer: Layer, w: number, hVal: number, frame: number, palette?: RGBA[]): void {
  if (layer.kind === 'reference' && layer.ref) {
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 32, 32);
    if (typeof Image !== 'undefined') {
      const img = new Image();
      img.onload = () => {
        ctx.imageSmoothingEnabled = layer.ref?.smooth ?? false;
        ctx.drawImage(img, 0, 0, 32, 32);
      };
      img.src = layer.ref.dataUrl;
    }
    return;
  }
  canvas.width = w;
  canvas.height = hVal;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ImageData === 'undefined') return;
  const cel = layer.cels[frame] ?? layer.cels[0];
  if (!cel) return;
  const px = applyModifiers(cel, w, hVal, layer.modifiers, null, palette);
  const copy = new Uint8ClampedArray(px.length);
  copy.set(px);
  ctx.putImageData(new ImageData(copy, w, hVal), 0, 0);
}

export function createSidePanels(
  ctrl: AppController,
  requestRender: () => void,
  onOpenExtract: (preset?: ExtractSourcePreset) => void,
  onCloseDrawer?: () => void,
): HTMLElement {
  // ---- 1. Palette panel (F-PALETTE) ----
  let selectedSwatchIdx = -1;
  let dragSwatchFrom = -1;

  const palSelect = h('select', {
    id: 'palette-select',
    'aria-label': 'Active palette',
    onChange: () => ctrl.execute(setActivePaletteCommand(palSelect.value)),
  });

  const palRenameWrap = h('div', { class: 'pal-head-row' });
  const delPalBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Delete palette',
    title: 'Delete palette',
    onClick: () => {
      if (ctrl.state.doc.palettes.length <= 1) return;
      ctrl.execute(removePaletteCommand(ctrl.getActivePalette().id));
    },
  }, icon('trash', 14));

  const renamePalBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Rename palette',
    title: 'Rename palette',
    onClick: () => {
      const pal = ctrl.getActivePalette();
      const input = h('input', {
        type: 'text',
        class: 'rename-input',
        value: pal.name,
        'aria-label': 'Palette name',
      });
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const trimmed = input.value.trim();
        if (trimmed && trimmed !== pal.name) ctrl.execute(renamePaletteCommand(pal.id, trimmed));
        else drawPalette();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') { done = true; drawPalette(); }
      });
      palSelect.replaceWith(input);
      input.focus();
      input.select();
    },
  }, icon('pencil', 14));

  const newPalBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'New palette',
    title: 'New palette',
    onClick: () => {
      const n = ctrl.state.doc.palettes.length + 1;
      ctrl.execute(addPaletteCommand(`Palette ${n}`, [ctrl.state.primaryColor]));
    },
  }, icon('plus', 14));

  const swatchGrid = h('div', { class: 'swatch-grid', role: 'group', 'aria-label': 'Palette swatches' });

  const lockSwatchBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Toggle swatch lock',
    title: 'Lock / unlock selected swatch',
    onClick: () => {
      const pal = ctrl.getActivePalette();
      if (selectedSwatchIdx < 0 || selectedSwatchIdx >= pal.colors.length) return;
      ctrl.execute(toggleSwatchLockCommand(pal.id, selectedSwatchIdx));
    },
  }, icon('lock', 14));

  const delSwatchBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Remove selected swatch',
    title: 'Remove selected swatch',
    onClick: () => {
      const pal = ctrl.getActivePalette();
      if (selectedSwatchIdx < 0 || selectedSwatchIdx >= pal.colors.length) return;
      if (pal.colors[selectedSwatchIdx].locked) {
        ctrl.showToast('Swatch is locked.', 'error');
        return;
      }
      ctrl.execute(removeSwatchCommand(pal.id, selectedSwatchIdx));
      selectedSwatchIdx = Math.min(selectedSwatchIdx, ctrl.getActivePalette().colors.length - 1);
    },
  }, icon('trash', 14));

  const restrictBtn = h('button', {
    type: 'button',
    'aria-pressed': String(ctrl.state.restrictToPalette),
    title: 'Snap drawing colors to nearest palette entry (OKLab)',
    onClick: () => ctrl.toggleRestrictToPalette(),
  }, 'Restrict');

  const palImportInput = h('input', {
    type: 'file',
    accept: '.gpl,.hex,.pal,.png',
    class: 'visually-hidden',
    onChange: async () => {
      const file = palImportInput.files?.[0];
      palImportInput.value = '';
      if (!file) return;
      try {
        const res = await importPaletteFile(file);
        ctrl.execute(addPaletteCommand(res.name, res.colors));
        ctrl.showToast(`Imported ${res.colors.length} colors (${res.name}).`, 'info');
      } catch (err) {
        ctrl.showToast(err instanceof Error ? err.message : 'Palette import failed.', 'error');
      }
    },
  });

  const exportFormatSel = h('select', {
    'aria-label': 'Export palette format',
    class: 'compact-select',
    onChange: () => {
      const fmt = exportFormatSel.value as '' | 'gpl' | 'hex' | 'png';
      exportFormatSel.value = '';
      if (!fmt) return;
      exportPaletteFile(ctrl.getActivePalette(), fmt);
    },
  },
    h('option', { value: '' }, 'Export…'),
    h('option', { value: 'gpl' }, 'GIMP .gpl'),
    h('option', { value: 'hex' }, 'Hex .hex'),
    h('option', { value: 'png' }, 'Strip .png'),
  );

  const drawPalette = () => {
    const s = ctrl.state;
    const pal = ctrl.getActivePalette();
    if (!palRenameWrap.contains(palSelect)) {
      palRenameWrap.replaceChildren(palSelect, renamePalBtn, newPalBtn, delPalBtn);
    }
    palSelect.replaceChildren(
      ...s.doc.palettes.map((p) => h('option', { value: p.id, selected: p.id === pal.id }, `${p.name} (${p.colors.length})`)),
    );
    palSelect.value = pal.id;
    delPalBtn.disabled = s.doc.palettes.length <= 1;
    restrictBtn.setAttribute('aria-pressed', String(s.restrictToPalette));

    // Match selected index to primary color if unset
    if (selectedSwatchIdx < 0 || selectedSwatchIdx >= pal.colors.length) {
      selectedSwatchIdx = pal.colors.findIndex((e) => rgbaEqual(e.rgba, s.primaryColor));
    }
    const selEntry = selectedSwatchIdx >= 0 ? pal.colors[selectedSwatchIdx] : null;
    lockSwatchBtn.disabled = !selEntry;
    lockSwatchBtn.setAttribute('aria-pressed', String(Boolean(selEntry?.locked)));
    delSwatchBtn.disabled = !selEntry || Boolean(selEntry.locked);

    if (pal.colors.length === 0) {
      swatchGrid.replaceChildren(h('p', { class: 'empty' }, 'No swatches. Click + to add color.'));
      return;
    }

    const composed = ctrl.getComposed(s.activeFrame);
    const usageCounts = countPaletteUsage(composed, pal.colors.map((e) => e.rgba));
    const fmtCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

    swatchGrid.replaceChildren(
      ...pal.colors.map((entry, idx) => {
        const hex = rgbaToHex(entry.rgba);
        const isPrimary = rgbaEqual(entry.rgba, s.primaryColor);
        const count = usageCounts[idx] ?? 0;
        const btn = h(
          'button',
          {
            type: 'button',
            class: `swatch-cell${idx === selectedSwatchIdx ? ' selected' : ''}`,
            style: `background:${hex}`,
            draggable: true,
            title: `${hex}${count > 0 ? ` · ${count} px` : ''}${entry.locked ? ' (locked)' : ''} · Click primary · Right/Alt secondary`,
            'aria-label': `Swatch ${hex}${count > 0 ? `, ${count} pixels` : ''}${entry.locked ? ', locked' : ''}`,
            'aria-pressed': String(isPrimary),
            onClick: (e: MouseEvent) => {
              selectedSwatchIdx = idx;
              if (e.altKey) ctrl.store.setState({ secondaryColor: [...entry.rgba] });
              else ctrl.store.setState({ primaryColor: [...entry.rgba] });
              drawPalette();
            },
            onContextmenu: (e: MouseEvent) => {
              e.preventDefault();
              selectedSwatchIdx = idx;
              ctrl.store.setState({ secondaryColor: [...entry.rgba] });
              drawPalette();
            },
            onDragstart: () => { dragSwatchFrom = idx; },
            onDragover: (e: DragEvent) => { e.preventDefault(); },
            onDrop: (e: DragEvent) => {
              e.preventDefault();
              if (dragSwatchFrom >= 0 && dragSwatchFrom !== idx) {
                ctrl.execute(reorderSwatchCommand(pal.id, dragSwatchFrom, idx));
                selectedSwatchIdx = idx;
              }
              dragSwatchFrom = -1;
            },
          },
          count > 0 ? h('span', { class: 'swatch-count mono', 'aria-hidden': 'true' }, fmtCount(count)) : null,
          entry.locked ? h('span', { class: 'swatch-lock-dot', 'aria-hidden': 'true' }) : null,
        );
        return btn;
      }),
    );
  };

  palRenameWrap.append(palSelect, renamePalBtn, newPalBtn, delPalBtn);
  const paletteBody = h(
    'div',
    {},
    palRenameWrap,
    swatchGrid,
    h('div', { class: 'action-bar' },
      h('button', {
        type: 'button',
        class: 'icon-btn tiny',
        'aria-label': 'Add current color to palette',
        title: 'Add current primary color',
        onClick: () => ctrl.execute(appendPaletteColorsCommand(ctrl.getActivePalette().id, [ctrl.state.primaryColor], 'Add color to palette')),
      }, icon('plus', 14)),
      lockSwatchBtn,
      delSwatchBtn,
      restrictBtn,
      h('button', { type: 'button', title: 'Generate 4 / 8 / 16 color palette from image or reference', onClick: () => onOpenExtract() }, icon('sparkles', 14), ' 4/8/16'),
    ),
    h('div', { class: 'action-bar pal-io-row' },
      h('button', { type: 'button', title: 'Import .gpl, .hex, .pal, or .png', onClick: () => palImportInput.click() }, icon('upload', 14), ' Import'),
      palImportInput,
      exportFormatSel,
    ),
  );
  drawPalette();
  ctrl.store.subscribe(
    (s) => [s.docRev, s.activeFrame, s.primaryColor, s.secondaryColor, s.restrictToPalette] as const,
    drawPalette,
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  // ---- 2. Layers panel (P1 + F-REF) ----
  const layersList = h('div', {
    class: 'layer-list',
    role: 'list',
    'aria-label': 'Layers',
    onDragover: (e: DragEvent) => {
      if (dragIds.length === 0 || e.target !== e.currentTarget) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      layersList.classList.add('drop-end');
    },
    onDragleave: (e: DragEvent) => {
      if (e.target === e.currentTarget) layersList.classList.remove('drop-end');
    },
    onDrop: (e: DragEvent) => {
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      finishLayerDrop({ kind: 'end' });
    },
  });
  let dragIds: string[] = [];
  let dragGroupId: string | null = null;
  const clearDropMarks = () => {
    layersList.classList.remove('drop-end');
    layersList.querySelectorAll('.drop-above, .drop-below, .drop-into').forEach((el) => el.classList.remove('drop-above', 'drop-below', 'drop-into'));
  };
  const startLayerDrag = (e: DragEvent, ids: string[], groupId: string | null) => {
    dragIds = ids;
    dragGroupId = groupId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', ids.join(','));
    }
  };
  const endLayerDrag = () => {
    dragIds = [];
    dragGroupId = null;
    clearDropMarks();
  };
  const dropAfter = (e: DragEvent): boolean => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < r.top + r.height / 2; // list is shown top = highest index, so upper half = after
  };
  const groupDropPosition = (e: DragEvent): 'above' | 'into' | 'below' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (dragGroupId) return e.clientY < r.top + r.height / 2 ? 'above' : 'below';
    // Top 25% of a group header pulls layers out above the group; lower 75% drops into the group
    return r.height > 0 && e.clientY < r.top + r.height * 0.25 ? 'above' : 'into';
  };
  const layerDragOver = (e: DragEvent, kind: 'layer' | 'group', targetId?: string) => {
    if (dragIds.length === 0) return;
    if (kind === 'layer' && targetId && dragIds.includes(targetId)) return;
    if (kind === 'group' && targetId && targetId === dragGroupId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    const el = e.currentTarget as HTMLElement;
    if (kind === 'group') {
      const pos = groupDropPosition(e);
      el.classList.add(pos === 'into' ? 'drop-into' : pos === 'above' ? 'drop-above' : 'drop-below');
    } else {
      el.classList.add(dropAfter(e) ? 'drop-above' : 'drop-below');
    }
  };
  const finishLayerDrop = (target: Parameters<typeof ctrl.dropLayers>[1]) => {
    const ids = dragIds;
    const grp = dragGroupId;
    endLayerDrag();
    if (ids.length > 0) ctrl.dropLayers(ids, target, grp);
  };

  let opacityBefore: number | null = null;
  const opacityCtrl = sliderField({
    id: 'layer-opacity',
    label: 'Opacity',
    min: 0,
    max: 100,
    value: ctrl.getActiveLayer().opacity,
    onInput: (v) => {
      const l = ctrl.getActiveLayer();
      if (opacityBefore === null) opacityBefore = l.opacity;
      l.opacity = v;
      ctrl.markDirty();
      requestRender();
    },
    onCommit: (v) => {
      const l = ctrl.getActiveLayer();
      const prev = opacityBefore ?? l.opacity;
      opacityBefore = null;
      if (prev === v) return;
      l.opacity = prev;
      ctrl.execute(layerPropCommand(l.id, { opacity: v }, `Layer opacity ${v}%`));
    },
  });

  const blendSelect = h(
    'select',
    {
      id: 'layer-blend',
      'aria-label': 'Blend mode',
      onChange: () => {
        const l = ctrl.getActiveLayer();
        const next = blendSelect.value as BlendMode;
        if (next !== l.blend) {
          ctrl.execute(layerPropCommand(l.id, { blend: next }, `Layer blend ${next}`));
        }
      },
    },
    ...BLEND_MODES.map((m) => h('option', { value: m }, m[0].toUpperCase() + m.slice(1))),
  );
  const blendRow = h('div', { class: 'row' }, h('label', { for: 'layer-blend' }, 'Blend'), blendSelect);

  // Reference layer transform controls (shown only when active layer is kind === 'reference')
  const refControls = h('div', { class: 'ref-controls', hidden: true });
  let refScaleBefore: number | null = null;
  const refScaleCtrl = sliderField({
    id: 'ref-scale',
    label: 'Scale %',
    min: 10,
    max: 400,
    value: 100,
    onInput: (v) => {
      const l = ctrl.getActiveLayer();
      if (!l.ref) return;
      if (refScaleBefore === null) refScaleBefore = l.ref.scale;
      l.ref.scale = v / 100;
      ctrl.markDirty();
      requestRender();
    },
    onCommit: (v) => {
      const l = ctrl.getActiveLayer();
      if (!l.ref) return;
      const prev = refScaleBefore ?? l.ref.scale;
      refScaleBefore = null;
      const next = v / 100;
      if (prev === next) return;
      l.ref.scale = prev;
      ctrl.execute(referencePropCommand(l.id, { scale: next }, 'Scale reference image'));
    },
  });
  const refXInput = h('input', {
    id: 'ref-x', class: 'num', type: 'number', value: 0, 'aria-label': 'Reference X',
    onChange: () => {
      const l = ctrl.getActiveLayer();
      if (l.ref) ctrl.execute(referencePropCommand(l.id, { x: Math.round(Number(refXInput.value)) }, 'Move reference X'));
    },
  });
  const refYInput = h('input', {
    id: 'ref-y', class: 'num', type: 'number', value: 0, 'aria-label': 'Reference Y',
    onChange: () => {
      const l = ctrl.getActiveLayer();
      if (l.ref) ctrl.execute(referencePropCommand(l.id, { y: Math.round(Number(refYInput.value)) }, 'Move reference Y'));
    },
  });
  const refSmoothBtn = h('button', {
    type: 'button',
    'aria-pressed': 'false',
    onClick: () => {
      const l = ctrl.getActiveLayer();
      if (l.ref) ctrl.execute(referencePropCommand(l.id, { smooth: !l.ref.smooth }, 'Toggle reference smoothing'));
    },
  }, 'Smooth');
  const refFlipXBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Flip reference horizontally',
    title: 'Flip horizontal',
    'aria-pressed': 'false',
    onClick: () => {
      const l = ctrl.getActiveLayer();
      if (l.ref) ctrl.execute(referencePropCommand(l.id, { flipX: !l.ref.flipX }, 'Flip reference X'));
    },
  }, icon('flipH', 14));
  const refFlipYBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Flip reference vertically',
    title: 'Flip vertical',
    'aria-pressed': 'false',
    onClick: () => {
      const l = ctrl.getActiveLayer();
      if (l.ref) ctrl.execute(referencePropCommand(l.id, { flipY: !l.ref.flipY }, 'Flip reference Y'));
    },
  }, icon('flipV', 14));

  const refExtractBtn = h('button', {
    type: 'button',
    title: 'Extract 4 / 8 / 16 color palette from this reference image',
    onClick: () => {
      const l = ctrl.getActiveLayer();
      if (l.ref) {
        onOpenExtract({
          pixels: l.ref.pixels,
          w: l.ref.w,
          h: l.ref.h,
          dataUrl: l.ref.dataUrl,
          name: l.name,
        });
      }
    },
  }, icon('sparkles', 14), ' Extract 4/8/16');

  const refSideBtn = h('button', {
    type: 'button',
    title: 'Place reference image side-by-side next to canvas on floating pasteboard',
    onClick: () => ctrl.placeReferenceSideBySide(ctrl.state.activeLayerId),
  }, 'Side-by-side');

  refControls.append(
    h('div', { class: 'row' }, h('label', { for: 'ref-x' }, 'Pos X/Y'), refXInput, refYInput),
    refScaleCtrl.el,
    h('div', { class: 'action-bar' }, refSmoothBtn, refFlipXBtn, refFlipYBtn, refSideBtn, refExtractBtn),
  );

  const imgLayerFileInput = h('input', {
    type: 'file',
    accept: 'image/*',
    class: 'visually-hidden',
    onChange: () => {
      const f = imgLayerFileInput.files?.[0];
      imgLayerFileInput.value = '';
      if (f) void ctrl.importImageAsPixelLayer(f, f.name.replace(/\.[^.]+$/, '') || 'Image');
    },
  });

  const refFileInput = h('input', {
    type: 'file',
    accept: 'image/*',
    class: 'visually-hidden',
    onChange: () => {
      const f = refFileInput.files?.[0];
      refFileInput.value = '';
      if (f) void ctrl.importReferenceBlob(f, f.name.replace(/\.[^.]+$/, '') || 'Reference');
    },
  });

  const deleteLayerBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Delete layer',
      title: 'Delete layer',
      onClick: () => {
        if (ctrl.state.doc.layers.length <= 1) return;
        ctrl.execute(removeLayerCommand(ctrl.state.activeLayerId));
      },
    },
    icon('trash'),
  );

  const drawMaskThumb = (canvas: HTMLCanvasElement, mask: Uint8Array, w: number, hVal: number) => {
    canvas.width = 22;
    canvas.height = 22;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 22, 22);
    if (typeof ImageData === 'undefined') return;
    const img = ctx.createImageData(22, 22);
    for (let y = 0; y < 22; y++) {
      const sy = Math.min(hVal - 1, Math.floor((y * hVal) / 22));
      for (let x = 0; x < 22; x++) {
        const sx = Math.min(w - 1, Math.floor((x * w) / 22));
        const v = mask[sy * w + sx] ?? 255;
        const i = (y * 22 + x) * 4;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  const maskBar = h('div', { class: 'mask-bar', hidden: true });

  let layerMenu: HTMLElement | null = null;
  const closeLayerMenu = () => {
    layerMenu?.remove();
    layerMenu = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  };
  const onOutside = (e: Event) => {
    if (layerMenu && !layerMenu.contains(e.target as Node)) closeLayerMenu();
  };
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeLayerMenu();
  };
  const mountContextMenu = (x: number, y: number, label: string, children: HTMLElement[]) => {
    closeLayerMenu();
    layerMenu = h('div', { class: 'ctx-menu', role: 'menu', 'aria-label': label }, ...children);
    document.body.append(layerMenu);
    const r = layerMenu.getBoundingClientRect();
    layerMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    layerMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
    layerMenu.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
  };
  const menuItem = (label: string, key: string, run: () => void, disabled = false) =>
    h('button', { type: 'button', role: 'menuitem', class: 'ctx-item', disabled, onClick: () => { closeLayerMenu(); run(); } },
      h('span', {}, label), h('span', { class: 'mono hint' }, key));
  const menuSep = () => h('hr', { class: 'ctx-sep' });

  const openLayerMenu = (x: number, y: number) => {
    const l = ctrl.getActiveLayer();
    const idx = ctrl.state.doc.layers.indexOf(l);
    const last = ctrl.state.doc.layers.length - 1;
    const below = idx > 0 ? ctrl.state.doc.layers[idx - 1] : null;
    mountContextMenu(x, y, 'Layer actions', [
      menuItem('Rename', 'F2', () => ctrl.startRenameLayer(l.id)),
      menuItem('Duplicate', 'Ctrl+J', () => ctrl.duplicateActiveLayer()),
      menuItem('Delete', '', () => ctrl.deleteActiveLayer(), last === 0),
      menuSep(),
      menuItem(l.visible ? 'Hide' : 'Show', '', () => ctrl.toggleActiveLayerFlag('visible')),
      menuItem('Show only this layer', 'Alt+Click eye', () => ctrl.soloActiveLayer()),
      menuItem(l.locked ? 'Unlock' : 'Lock', '', () => ctrl.toggleActiveLayerFlag('locked')),
      menuItem(l.alphaLock ? 'Unlock transparency' : 'Lock transparency', '', () => ctrl.toggleActiveLayerFlag('alphaLock'), l.kind === 'reference'),
      menuSep(),
      menuItem(l.clipped ? 'Release clipping mask' : 'Create clipping mask', '', () => ctrl.toggleActiveLayerFlag('clipped'), l.kind !== 'pixel' || (idx === 0 && !l.clipped)),
      menuItem('Add layer mask', '', () => ctrl.addLayerMask(true), l.kind === 'reference' || Boolean(l.layerMask)),
      menuItem('Select layer pixels', 'Ctrl+Click', () => ctrl.selectLayerTransparency(l.id)),
      menuItem('Remove from group', '', () => ctrl.removeActiveFromGroup(), !l.groupId),
      menuSep(),
      menuItem('Bring to front', 'Ctrl+Shift+]', () => ctrl.moveActiveLayer('top'), idx === last),
      menuItem('Move up', 'Ctrl+]', () => ctrl.moveActiveLayer('up'), idx === last),
      menuItem('Move down', 'Ctrl+[', () => ctrl.moveActiveLayer('down'), idx === 0),
      menuItem('Send to back', 'Ctrl+Shift+[', () => ctrl.moveActiveLayer('bottom'), idx === 0),
      menuSep(),
      menuItem('Merge down', 'Ctrl+Alt+E', () => ctrl.mergeDownActive(), idx === 0 || l.kind === 'reference' || below?.kind === 'reference'),
      menuItem('Flatten visible', 'Ctrl+Shift+E', () => ctrl.flattenVisible()),
    ]);
  };

  const openGroupMenu = (grp: LayerGroup, x: number, y: number) => {
    mountContextMenu(x, y, 'Group actions', [
      menuItem('Rename group', '', () => ctrl.startRenameGroup(grp.id)),
      menuItem('Select group pixels', 'Ctrl+Click', () => ctrl.selectGroupTransparency(grp.id)),
      menuItem(grp.visible ? 'Hide group' : 'Show group', '', () =>
        ctrl.execute(groupPropCommand(grp.id, { visible: !grp.visible }, grp.visible ? 'Hide group' : 'Show group'))),
      menuItem(grp.collapsed ? 'Expand group' : 'Collapse group', '', () =>
        ctrl.execute(groupPropCommand(grp.id, { collapsed: !grp.collapsed }, grp.collapsed ? 'Expand group' : 'Collapse group'))),
      menuSep(),
      menuItem('Ungroup layers', 'Ctrl+Shift+G', () => {
        ctrl.selectGroupLayers(grp.id);
        ctrl.ungroupActiveGroup();
      }),
    ]);
  };

  const openMoreLayerMenu = (anchor: HTMLElement) => {
    const l = ctrl.getActiveLayer();
    const idx = ctrl.state.doc.layers.indexOf(l);
    const last = ctrl.state.doc.layers.length - 1;
    const below = idx > 0 ? ctrl.state.doc.layers[idx - 1] : null;
    const r = anchor.getBoundingClientRect();
    mountContextMenu(r.left, r.top - 240, 'More layer actions', [
      menuItem('Import image as pixel layer…', '', () => imgLayerFileInput.click()),
      menuItem('Import reference image…', '', () => refFileInput.click()),
      menuSep(),
      menuItem('Remove from group', '', () => ctrl.removeActiveFromGroup(), !l.groupId),
      menuItem('Ungroup layers', 'Ctrl+Shift+G', () => ctrl.ungroupActiveGroup(), !l.groupId),
      menuSep(),
      menuItem('Bring to front', 'Ctrl+Shift+]', () => ctrl.moveActiveLayer('top'), idx === last),
      menuItem('Move up', 'Ctrl+]', () => ctrl.moveActiveLayer('up'), idx === last),
      menuItem('Move down', 'Ctrl+[', () => ctrl.moveActiveLayer('down'), idx === 0),
      menuItem('Send to back', 'Ctrl+Shift+[', () => ctrl.moveActiveLayer('bottom'), idx === 0),
      menuSep(),
      menuItem('Merge down', 'Ctrl+Alt+E', () => ctrl.mergeDownActive(), idx === 0 || l.kind === 'reference' || below?.kind === 'reference'),
      menuItem('Flatten visible', 'Ctrl+Shift+E', () => ctrl.flattenVisible()),
    ]);
  };

  const openFxMenu = (scope: 'layer' | 'doc', layerId: string | null, m: Modifier, x: number, y: number) => {
    mountContextMenu(x, y, `${MOD_LABELS[m.type]} effect actions`, [
      menuItem('Edit in Modifiers', '', () => ctrl.focusModifier(scope, layerId, m.id)),
      menuItem(m.enabled ? 'Hide effect' : 'Show effect', '', () =>
        ctrl.execute(updateModifierCommand(scope, layerId, cloneModifier(m), { ...cloneModifier(m), enabled: !m.enabled }, `Toggle ${m.type}`))),
      menuItem('Duplicate effect', '', () => ctrl.execute(duplicateModifierCommand(scope, layerId, m.id))),
      menuItem('Apply to pixels (bake)', '', () => {
        ctrl.execute(bakeModifierCommand(scope, layerId, m.id));
        ctrl.showToast(`Baked ${m.type} modifier to pixels.`, 'info');
      }),
      menuSep(),
      menuItem('Remove effect', '', () => ctrl.execute(removeModifierCommand(scope, layerId, m.id))),
    ]);
  };

  const renderFxTree = (
    scope: 'layer' | 'doc',
    layerId: string | null,
    mods: Modifier[],
    title: string,
    inGroup: boolean,
  ): HTMLElement => {
    const anyEnabled = mods.some((m) => m.enabled);
    const items = mods.map((m) => {
      const isFocused = ctrl.state.focusedModId === m.id;
      const fxEye = h('button', {
        type: 'button',
        class: 'icon-btn tiny',
        'aria-label': `Toggle ${MOD_LABELS[m.type]} effect`,
        'aria-pressed': String(m.enabled),
        title: m.enabled ? 'Hide effect · Alt+click solo' : 'Show effect · Alt+click solo',
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          if (e.altKey) {
            ctrl.setSoloModifier({ scope, layerId, modId: m.id });
            window.addEventListener('pointerup', () => ctrl.setSoloModifier(null), { once: true });
            return;
          }
          ctrl.execute(
            updateModifierCommand(
              scope,
              layerId,
              cloneModifier(m),
              { ...cloneModifier(m), enabled: !m.enabled },
              `Toggle ${m.type}`,
            ),
          );
        },
      }, icon(m.enabled ? 'eye' : 'eyeOff', 12));

      const fxName = h('button', {
        type: 'button',
        class: 'layer-fx-name',
        title: `Edit ${MOD_LABELS[m.type]} in Modifiers panel`,
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          ctrl.focusModifier(scope, layerId, m.id);
        },
      }, m.effectMask || m.mask ? `${MOD_LABELS[m.type]} · mask` : MOD_LABELS[m.type]);

      const fxDel = h('button', {
        type: 'button',
        class: 'icon-btn tiny',
        'aria-label': `Remove ${MOD_LABELS[m.type]} effect`,
        title: 'Remove effect',
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          ctrl.execute(removeModifierCommand(scope, layerId, m.id));
        },
      }, icon('x', 12));

      return h('div', {
        class: `layer-fx-item${m.enabled ? '' : ' fx-disabled'}${isFocused ? ' fx-focused' : ''}`,
        role: 'listitem',
        onContextmenu: (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          openFxMenu(scope, layerId, m, e.clientX, e.clientY);
        },
      }, fxEye, fxName, fxDel);
    });

    const headChildren: (HTMLElement | string)[] = [
      h('span', { class: 'layer-fx-branch mono', 'aria-hidden': 'true' }, '└'),
      h('span', { class: 'layer-fx-heading' }, title),
    ];
    if (scope === 'layer' && layerId) {
      headChildren.push(
        h('button', {
          type: 'button',
          class: 'icon-btn tiny',
          'aria-label': anyEnabled ? 'Hide all layer effects' : 'Show all layer effects',
          'aria-pressed': String(anyEnabled),
          title: anyEnabled ? 'Hide all effects on this layer' : 'Show all effects on this layer',
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            ctrl.execute(toggleAllLayerModifiersCommand(layerId, !anyEnabled));
          },
        }, icon(anyEnabled ? 'eye' : 'eyeOff', 12)),
      );
    }

    return h(
      'div',
      {
        class: `layer-fx-tree${inGroup ? ' in-group' : ''}${scope === 'doc' ? ' doc-fx-tree' : ''}`,
        role: 'group',
        'aria-label': title,
      },
      h('div', { class: 'layer-fx-head' }, ...headChildren),
      ...items,
    );
  };

  const drawLayers = () => {
    const s = ctrl.state;
    const active = ctrl.getActiveLayer();
    const isRef = active.kind === 'reference' && Boolean(active.ref);

    opacityCtrl.setValue(active.opacity);
    blendSelect.value = active.blend;
    blendRow.hidden = isRef;
    refControls.hidden = !isRef;
    if (isRef && active.ref) {
      refXInput.value = String(Math.round(active.ref.x));
      refYInput.value = String(Math.round(active.ref.y));
      refScaleCtrl.setValue(Math.round(active.ref.scale * 100));
      refSmoothBtn.setAttribute('aria-pressed', String(active.ref.smooth));
      refFlipXBtn.setAttribute('aria-pressed', String(active.ref.flipX));
      refFlipYBtn.setAttribute('aria-pressed', String(active.ref.flipY));
    }

    // Layer mask contextual bar when active layer has a Photoshop layer mask
    if (!isRef && active.layerMask) {
      maskBar.hidden = false;
      maskBar.replaceChildren(
        h('span', { class: 'hint' }, 'Mask'),
        h('button', {
          type: 'button',
          class: 'tiny-btn',
          'aria-pressed': String(s.editTarget === 'mask'),
          onClick: () => ctrl.setEditTarget(s.editTarget === 'mask' ? 'pixels' : 'mask'),
        }, s.editTarget === 'mask' ? 'Editing' : 'Paint'),
        h('button', { type: 'button', class: 'tiny-btn', onClick: () => ctrl.invertLayerMask() }, 'Invert'),
        h('button', {
          type: 'button',
          class: 'tiny-btn',
          'aria-pressed': String(active.maskEnabled !== false),
          onClick: () => ctrl.toggleLayerMaskEnabled(),
        }, active.maskEnabled === false ? 'Off' : 'On'),
        h('button', { type: 'button', class: 'tiny-btn', onClick: () => ctrl.applyLayerMask() }, 'Apply'),
        h('button', { type: 'button', class: 'tiny-btn', onClick: () => ctrl.removeLayerMask() }, 'Delete'),
      );
    } else {
      maskBar.hidden = true;
    }

    deleteLayerBtn.disabled = s.doc.layers.length <= 1;

    const palColors = ctrl.getActivePalette().colors.map((c) => c.rgba);
    const renderedGroups = new Set<string>();
    const rows: HTMLElement[] = [];

    if (s.doc.modifiers.length > 0) {
      rows.push(renderFxTree('doc', null, s.doc.modifiers, 'Animation Effects', false));
    }

    for (const l of [...s.doc.layers].reverse()) {
      const grp = l.groupId ? s.doc.groups?.find((g) => g.id === l.groupId) : undefined;
      if (grp && !renderedGroups.has(grp.id)) {
        renderedGroups.add(grp.id);
        const members = s.doc.layers.filter((x) => x.groupId === grp.id);
        const allSel = members.every((x) => s.selectedLayerIds.includes(x.id));
        const groupSelect = (e: MouseEvent) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            ctrl.selectGroupTransparency(grp.id, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');
            return;
          }
          ctrl.selectGroupLayers(grp.id, e.shiftKey);
        };
        let groupNameEl: HTMLElement;
        if (s.renamingLayerId === grp.id) {
          const inp = h('input', { type: 'text', class: 'rename-input', value: grp.name, 'aria-label': `Rename ${grp.name}`, maxlength: 64 });
          let done = false;
          const finish = (save: boolean) => {
            if (done) return;
            done = true;
            const trimmed = inp.value.trim();
            ctrl.store.setState({ renamingLayerId: null });
            if (save && trimmed && trimmed !== grp.name) ctrl.execute(groupPropCommand(grp.id, { name: trimmed }, 'Rename group'));
          };
          inp.addEventListener('blur', () => finish(true));
          inp.addEventListener('keydown', (ke) => {
            ke.stopPropagation();
            if (ke.key === 'Enter') finish(true);
            else if (ke.key === 'Escape') finish(false);
          });
          requestAnimationFrame(() => { inp.focus(); inp.select(); });
          groupNameEl = inp;
        } else {
          groupNameEl = h('button', {
            type: 'button',
            class: 'layer-group-name',
            title: 'Click select group · Shift+Click multi-select · Ctrl+Click select group pixels · Double-click rename',
            onClick: (e: MouseEvent) => { e.stopPropagation(); groupSelect(e); },
            onDblclick: () => ctrl.startRenameGroup(grp.id),
          }, grp.name);
        }
        rows.push(
          h(
            'div',
            {
              class: `layer-group-row${allSel ? ' group-selected' : ''}`,
              role: 'listitem',
              draggable: true,
              'data-drop': 'group',
              onClick: (e: MouseEvent) => {
                const target = e.target as HTMLElement | null;
                if (target?.closest('.icon-btn, input')) return;
                groupSelect(e);
              },
              onContextmenu: (e: MouseEvent) => {
                e.preventDefault();
                if ((e.ctrlKey || e.metaKey) && e.button === 0) {
                  ctrl.selectGroupTransparency(grp.id, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');
                  return;
                }
                ctrl.selectGroupLayers(grp.id);
                openGroupMenu(grp, e.clientX, e.clientY);
              },
              onDragstart: (e: DragEvent) => startLayerDrag(e, members.map((x) => x.id), grp.id),
              onDragend: endLayerDrag,
              onDragover: (e: DragEvent) => layerDragOver(e, 'group', grp.id),
              onDragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-into', 'drop-above', 'drop-below'),
              onDrop: (e: DragEvent) => {
                e.preventDefault();
                finishLayerDrop({ kind: 'group', id: grp.id, position: groupDropPosition(e) });
              },
            },
            h('button', {
              type: 'button',
              class: 'icon-btn tiny',
              'aria-label': grp.collapsed ? `Expand ${grp.name}` : `Collapse ${grp.name}`,
              'aria-expanded': String(!grp.collapsed),
              onClick: (e: MouseEvent) => {
                e.stopPropagation();
                ctrl.execute(groupPropCommand(grp.id, { collapsed: !grp.collapsed }, grp.collapsed ? 'Expand group' : 'Collapse group'));
              },
            }, icon(grp.collapsed ? 'chevRight' : 'chevDown', 12)),
            h('button', {
              type: 'button',
              class: 'layer-group-thumb-btn',
              'aria-label': `${grp.name} folder (Ctrl+Click to select group pixels)`,
              title: 'Click select group · Ctrl+Click select group pixels',
              onClick: (e: MouseEvent) => { e.stopPropagation(); groupSelect(e); },
            }, icon('folder', 14)),
            groupNameEl,
            h('button', {
              type: 'button',
              class: 'icon-btn tiny',
              'aria-label': `Toggle ${grp.name} visibility`,
              'aria-pressed': String(grp.visible),
              onClick: (e: MouseEvent) => {
                e.stopPropagation();
                ctrl.execute(groupPropCommand(grp.id, { visible: !grp.visible }, grp.visible ? 'Hide group' : 'Show group'));
              },
            }, icon(grp.visible ? 'eye' : 'eyeOff', 14)),
            h('button', {
              type: 'button',
              class: 'icon-btn tiny',
              'aria-label': `Ungroup ${grp.name}`,
              title: 'Ungroup layers (Ctrl+Shift+G)',
              onClick: (e: MouseEvent) => {
                e.stopPropagation();
                ctrl.store.setState({ activeLayerId: l.id });
                ctrl.ungroupActiveGroup();
              },
            }, icon('ungroup', 14)),
          ),
        );
      }
      if (grp?.collapsed) continue;

      const realIdx = s.doc.layers.indexOf(l);
      const isCurrent = l.id === s.activeLayerId;
      const isMulti = s.selectedLayerIds.includes(l.id);
      const thumb = h('canvas', { class: 'layer-thumb', 'aria-hidden': 'true' });
      drawThumbnail(thumb, l, s.doc.w, s.doc.h, s.activeFrame, palColors);

      const handleLayerSelect = (e: MouseEvent) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const mode = e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';
          ctrl.selectLayerTransparency(l.id, mode);
          return;
        }
        if (e.shiftKey) {
          const curSel = new Set(ctrl.state.selectedLayerIds);
          if (curSel.has(l.id) && curSel.size > 1) curSel.delete(l.id);
          else curSel.add(l.id);
          ctrl.store.setState({ activeLayerId: l.id, selectedLayerIds: Array.from(curSel), editTarget: 'pixels' });
          return;
        }
        const cur = ctrl.state;
        if (cur.activeLayerId === l.id && cur.selectedLayerIds.length === 1 && cur.editTarget === 'pixels') return;
        ctrl.store.setState({ activeLayerId: l.id, selectedLayerIds: [l.id], editTarget: 'pixels' });
      };

      const thumbBtn = h(
        'button',
        {
          type: 'button',
          class: `layer-thumb-btn${isCurrent && s.editTarget === 'pixels' ? ' target-active' : ''}`,
          title: 'Click to edit pixels · Ctrl+Click to select layer pixels',
          'aria-label': `${l.name} preview (Ctrl+Click to select pixels)`,
          onClick: (e: MouseEvent) => { e.stopPropagation(); handleLayerSelect(e); },
        },
        thumb,
      );

      let maskBtnEl: HTMLElement | null = null;
      if (l.layerMask) {
        const mCanvas = h('canvas', { class: 'layer-mask-thumb', 'aria-hidden': 'true' });
        drawMaskThumb(mCanvas, l.layerMask, s.doc.w, s.doc.h);
        maskBtnEl = h(
          'button',
          {
            type: 'button',
            class: `layer-mask-btn${isCurrent && s.editTarget === 'mask' ? ' target-active' : ''}${l.maskEnabled === false ? ' mask-disabled' : ''}`,
            title: 'Click to paint layer mask · Alt+Click disable/enable',
            'aria-label': `Edit ${l.name} layer mask`,
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              ctrl.store.setState({ activeLayerId: l.id, selectedLayerIds: [l.id] });
              if (e.altKey) {
                ctrl.toggleLayerMaskEnabled();
              } else {
                ctrl.setEditTarget('mask');
              }
            },
          },
          mCanvas,
        );
      }

      const nameBtn = h(
        'button',
        {
          type: 'button',
          class: 'layer-name',
          title: 'Click select · Shift+click multi-select · Ctrl+click select pixels · Double-click rename',
          onClick: (e: MouseEvent) => { e.stopPropagation(); handleLayerSelect(e); },
          onDblclick: () => ctrl.startRenameLayer(l.id),
        },
        l.name,
      );

      let nameEl: HTMLElement = nameBtn;
      if (s.renamingLayerId === l.id) {
        const input = h('input', { type: 'text', class: 'rename-input', value: l.name, 'aria-label': `Rename ${l.name}`, maxlength: 64 });
        let done = false;
        const finish = (save: boolean) => {
          if (done) return;
          done = true;
          const trimmed = input.value.trim();
          ctrl.store.setState({ renamingLayerId: null });
          if (save && trimmed && trimmed !== l.name) ctrl.execute(layerPropCommand(l.id, { name: trimmed }, 'Rename layer'));
        };
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('dblclick', (e) => e.stopPropagation());
        requestAnimationFrame(() => { input.focus(); input.select(); });
        nameEl = input;
      }

      const canClip = l.kind === 'pixel' && realIdx > 0;
      const hasFx = l.modifiers.length > 0;
      const fxOpen = hasFx && !s.fxCollapsed[l.id];
      rows.push(
        h(
          'div',
          {
            class: `layer${l.clipped ? ' layer-clipped' : ''}${grp ? ' in-group' : ''}${isMulti && !isCurrent ? ' multi-sel' : ''}`,
            role: 'listitem',
            draggable: true,
            'aria-current': isCurrent ? 'true' : 'false',
            onClick: (e: MouseEvent) => {
              const target = e.target as HTMLElement | null;
              if (target?.closest('.icon-btn, .layer-fx-toggle, .layer-mask-btn, input')) return;
              handleLayerSelect(e);
            },
            onContextmenu: (e: MouseEvent) => {
              e.preventDefault();
              if ((e.ctrlKey || e.metaKey) && e.button === 0) {
                ctrl.selectLayerTransparency(l.id, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');
                return;
              }
              ctrl.store.setState({ activeLayerId: l.id, selectedLayerIds: [l.id], editTarget: 'pixels' });
              openLayerMenu(e.clientX, e.clientY);
            },
            onDragstart: (e: DragEvent) =>
              startLayerDrag(e, s.selectedLayerIds.length > 1 && s.selectedLayerIds.includes(l.id) ? s.doc.layers.filter((x) => s.selectedLayerIds.includes(x.id)).map((x) => x.id) : [l.id], null),
            onDragend: endLayerDrag,
            onDragover: (e: DragEvent) => layerDragOver(e, 'layer', l.id),
            onDragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-above', 'drop-below'),
            onDrop: (e: DragEvent) => {
              e.preventDefault();
              finishLayerDrop({ kind: 'layer', id: l.id, after: dropAfter(e) });
            },
          },
          l.clipped ? h('span', { class: 'clip-arrow mono', title: 'Clipped to layer below', 'aria-hidden': 'true' }, '↳') : null,
          thumbBtn,
          maskBtnEl,
          nameEl,
          hasFx
            ? h('button', {
                type: 'button',
                class: 'layer-fx-toggle mono',
                'aria-label': fxOpen ? `Collapse ${l.name} effects` : `Expand ${l.name} effects`,
                'aria-expanded': String(fxOpen),
                title: `${l.modifiers.length} effect${l.modifiers.length === 1 ? '' : 's'} — click to collapse/expand`,
                onClick: (e: MouseEvent) => {
                  e.stopPropagation();
                  ctrl.toggleFxCollapsed(l.id);
                },
              }, `fx`)
            : null,
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn tiny',
              'aria-label': `Toggle ${l.name} visibility (Alt+click solo)`,
              title: l.visible ? 'Hide layer · Alt+click solo' : 'Show layer · Alt+click solo',
              'aria-pressed': String(l.visible),
              onClick: (e: MouseEvent) => {
                if (e.altKey) {
                  ctrl.execute(soloLayerVisibilityCommand(l.id));
                } else {
                  ctrl.execute(layerPropCommand(l.id, { visible: !l.visible }, l.visible ? 'Hide layer' : 'Show layer'));
                }
              },
            },
            icon(l.visible ? 'eye' : 'eyeOff', 14),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn tiny',
              'aria-label': `Toggle ${l.name} lock`,
              title: l.locked ? 'Unlock layer' : 'Lock layer',
              'aria-pressed': String(l.locked),
              onClick: () => ctrl.execute(layerPropCommand(l.id, { locked: !l.locked }, l.locked ? 'Unlock layer' : 'Lock layer')),
            },
            icon(l.locked ? 'lock' : 'unlock', 14),
          ),
          l.kind === 'reference'
            ? h('span', { class: 'ref-badge mono', title: 'Reference layer (not exported)' }, 'REF')
            : h(
                'button',
                {
                  type: 'button',
                  class: 'icon-btn tiny',
                  'aria-label': `Toggle ${l.name} clipping mask`,
                  title: l.clipped ? 'Release clipping mask' : 'Clip to layer below (Photoshop mask)',
                  'aria-pressed': String(Boolean(l.clipped)),
                  disabled: !canClip && !l.clipped,
                  onClick: () => ctrl.execute(layerPropCommand(l.id, { clipped: !l.clipped }, l.clipped ? 'Release clipping mask' : 'Create clipping mask')),
                },
                icon('mask', 14),
              ),
          l.kind === 'reference'
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  class: 'icon-btn tiny',
                  'aria-label': `Toggle ${l.name} alpha lock`,
                  title: l.alphaLock ? 'Disable alpha lock' : 'Enable alpha lock',
                  'aria-pressed': String(l.alphaLock),
                  onClick: () => ctrl.execute(layerPropCommand(l.id, { alphaLock: !l.alphaLock }, 'Toggle alpha lock')),
                },
                icon('alpha', 14),
              ),
        ),
      );
      if (fxOpen) {
        rows.push(renderFxTree('layer', l.id, l.modifiers, 'Effects', Boolean(grp)));
      }
    }

    layersList.replaceChildren(...rows);
  };

  const layersBody = h(
    'div',
    {},
    blendRow,
    opacityCtrl.el,
    refControls,
    maskBar,
    layersList,
    h(
      'div',
      { class: 'layer-footer', role: 'toolbar', 'aria-label': 'Layer actions' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Add layer', title: 'New pixel layer (Ctrl+Alt+N)', onClick: () => ctrl.execute(addLayerCommand()) }, icon('plus')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Group layers', title: 'Group selected layers (Ctrl+G)', onClick: () => ctrl.groupSelectedLayers() }, icon('folder')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Add layer mask', title: 'Add Photoshop layer mask (uses selection if active)', onClick: () => ctrl.addLayerMask(true) }, icon('layerMask')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Duplicate layer', title: 'Duplicate layer (Ctrl+J)', onClick: () => ctrl.execute(duplicateLayerCommand(ctrl.state.activeLayerId)) }, icon('copy')),
      refFileInput,
      imgLayerFileInput,
      h('span', { class: 'spacer' }),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        'aria-label': 'More layer actions',
        'aria-haspopup': 'menu',
        title: 'More layer actions (merge, flatten, import, order)',
        onClick: (e: MouseEvent) => openMoreLayerMenu(e.currentTarget as HTMLElement),
      }, icon('more')),
      deleteLayerBtn,
    ),
  );

  drawLayers();
  ctrl.store.subscribe(
    (s) => [s.docRev, s.activeLayerId, s.activeFrame, s.selectedLayerIds, s.editTarget, s.renamingLayerId, s.fxCollapsed, s.focusedModId] as const,
    drawLayers,
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  // ---- 3. Modifiers panel (P3 extensions: reorder, duplicate, solo, mask, outline width/conn, bake) ----
  const modsList = h('div', {});
  let dragModFrom = -1;
  const scopeBtns = (['layer', 'doc'] as const).map((sc) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(ctrl.state.modScope === sc),
        onClick: () => ctrl.store.setState({ modScope: sc }),
      },
      sc === 'layer' ? 'Layer' : 'Whole animation',
    ),
  );

  const modCard = (m: Modifier, idx: number, total: number, scope: 'layer' | 'doc', layerId: string | null): HTMLElement => {
    const body: HTMLElement[] = [];

    const bindModSlider = (key: 'hue' | 'sat' | 'light' | 'opacity', label: string, min: number, max: number) => {
      const cm = m as ColorMod;
      let beforeSnap: ColorMod | null = null;
      return sliderField({
        id: `mod-${m.id}-${key}`,
        label,
        min,
        max,
        value: cm[key],
        onInput: (v) => {
          if (!beforeSnap) beforeSnap = cloneModifier(cm, false) as ColorMod;
          cm[key] = v;
          ctrl.markDirty();
          requestRender();
        },
        onCommit: (v) => {
          const prev = beforeSnap ?? (cloneModifier(cm, false) as ColorMod);
          beforeSnap = null;
          if (prev[key] === v) return;
          const next = cloneModifier(prev, false) as ColorMod;
          next[key] = v;
          cm[key] = prev[key];
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, `Modifier ${label.toLowerCase()}`));
        },
      }).el;
    };

    if (m.type === 'color') {
      body.push(
        bindModSlider('hue', 'Hue', -180, 180),
        bindModSlider('sat', 'Sat', -100, 100),
        bindModSlider('light', 'Light', -100, 100),
        bindModSlider('opacity', 'Opacity', 0, 100),
      );
    } else if (m.type === 'shadow') {
      const sm = m as ShadowMod;
      const bindOffset = (key: 'offsetX' | 'offsetY', label: string) => {
        let beforeSnap: ShadowMod | null = null;
        return sliderField({
          id: `mod-${m.id}-${key}`,
          label,
          min: -16,
          max: 16,
          value: sm[key],
          onInput: (v) => {
            if (!beforeSnap) beforeSnap = cloneModifier(sm, false) as ShadowMod;
            sm[key] = v;
            ctrl.markDirty();
            requestRender();
          },
          onCommit: (v) => {
            const prev = beforeSnap ?? (cloneModifier(sm, false) as ShadowMod);
            beforeSnap = null;
            if (prev[key] === v) return;
            const next = cloneModifier(prev, false) as ShadowMod;
            next[key] = v;
            sm[key] = prev[key];
            ctrl.execute(updateModifierCommand(scope, layerId, prev, next, `Shadow ${label}`));
          },
        }).el;
      };
      let colBefore: ShadowMod | null = null;
      const colInput = h('input', {
        id: `mod-${m.id}-color`,
        type: 'color',
        value: rgbaToHex(sm.color),
        'aria-label': 'Drop shadow color',
        onInput: () => {
          if (!colBefore) colBefore = cloneModifier(sm, false) as ShadowMod;
          const rgb = hexToRgba(colInput.value);
          sm.color = [rgb[0], rgb[1], rgb[2], sm.color[3]];
          ctrl.markDirty();
          requestRender();
        },
        onChange: () => {
          const prev = colBefore ?? (cloneModifier(sm, false) as ShadowMod);
          colBefore = null;
          const rgb = hexToRgba(colInput.value);
          const next = cloneModifier(prev, false) as ShadowMod;
          next.color = [rgb[0], rgb[1], rgb[2], prev.color[3]];
          sm.color = [...prev.color] as RGBA;
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Shadow color'));
        },
      });
      let alphaBefore: ShadowMod | null = null;
      const alphaSlider = sliderField({
        id: `mod-${m.id}-alpha`,
        label: 'Alpha',
        min: 0,
        max: 255,
        value: sm.color[3],
        onInput: (v) => {
          if (!alphaBefore) alphaBefore = cloneModifier(sm, false) as ShadowMod;
          sm.color = [sm.color[0], sm.color[1], sm.color[2], v];
          ctrl.markDirty();
          requestRender();
        },
        onCommit: (v) => {
          const prev = alphaBefore ?? (cloneModifier(sm, false) as ShadowMod);
          alphaBefore = null;
          if (prev.color[3] === v) return;
          const next = cloneModifier(prev, false) as ShadowMod;
          next.color = [prev.color[0], prev.color[1], prev.color[2], v];
          sm.color = [...prev.color] as RGBA;
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Shadow alpha'));
        },
      }).el;
      body.push(
        bindOffset('offsetX', 'Offset X'),
        bindOffset('offsetY', 'Offset Y'),
        h('div', { class: 'row' }, h('label', { for: `mod-${m.id}-color` }, 'Color'), colInput),
        alphaSlider,
      );
    } else if (m.type === 'palette-map') {
      const pm = m as PaletteMapMod;
      const ditherBox = h('input', {
        id: `mod-${m.id}-dither`,
        type: 'checkbox',
        checked: Boolean(pm.dither),
        onChange: () => {
          const prev = cloneModifier(pm, false);
          const next = cloneModifier(pm, false) as PaletteMapMod;
          next.dither = ditherBox.checked;
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Palette map dither'));
        },
      });
      body.push(
        h('label', { class: 'check-row hint', for: `mod-${m.id}-dither` }, ditherBox, 'Bayer 4×4 dither'),
        h('p', { class: 'hint' }, 'Maps pixels to active palette (OKLab).'),
      );
    } else if (m.type === 'dither') {
      const dm = m as DitherMod;
      const patSel = h(
        'select',
        {
          id: `mod-${m.id}-pat`,
          onChange: () => {
            const prev = cloneModifier(dm, false);
            const next = cloneModifier(dm, false) as DitherMod;
            next.pattern = patSel.value as DitherMod['pattern'];
            ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Dither pattern'));
          },
        },
        h('option', { value: 'bayer4', selected: dm.pattern === 'bayer4' }, 'Bayer 4×4'),
        h('option', { value: 'bayer2', selected: dm.pattern === 'bayer2' }, 'Bayer 2×2'),
        h('option', { value: 'checker', selected: dm.pattern === 'checker' }, 'Checker'),
      );
      const bindDitherSlider = (key: 'levels' | 'strength', label: string, min: number, max: number) => {
        let beforeSnap: DitherMod | null = null;
        return sliderField({
          id: `mod-${m.id}-${key}`,
          label,
          min,
          max,
          value: dm[key],
          onInput: (v) => {
            if (!beforeSnap) beforeSnap = cloneModifier(dm, false) as DitherMod;
            dm[key] = v;
            ctrl.markDirty();
            requestRender();
          },
          onCommit: (v) => {
            const prev = beforeSnap ?? (cloneModifier(dm, false) as DitherMod);
            beforeSnap = null;
            if (prev[key] === v) return;
            const next = cloneModifier(prev, false) as DitherMod;
            next[key] = v;
            dm[key] = prev[key];
            ctrl.execute(updateModifierCommand(scope, layerId, prev, next, `Dither ${label.toLowerCase()}`));
          },
        }).el;
      };
      body.push(
        h('div', { class: 'row' }, h('label', { for: `mod-${m.id}-pat` }, 'Matrix'), patSel),
        bindDitherSlider('levels', 'Levels', 2, 8),
        bindDitherSlider('strength', 'Strength', 0, 100),
      );
    } else if (m.type === 'lighting') {
      const lm = m as LightingMod;
      const bindLightSlider = (
        key: 'angle' | 'elevation' | 'intensity' | 'ambient' | 'bevel',
        label: string,
        min: number,
        max: number,
      ) => {
        let beforeSnap: LightingMod | null = null;
        return sliderField({
          id: `mod-${m.id}-${key}`,
          label,
          min,
          max,
          value: lm[key],
          onInput: (v) => {
            if (!beforeSnap) beforeSnap = cloneModifier(lm, false) as LightingMod;
            lm[key] = v;
            ctrl.markDirty();
            requestRender();
          },
          onCommit: (v) => {
            const prev = beforeSnap ?? (cloneModifier(lm, false) as LightingMod);
            beforeSnap = null;
            if (prev[key] === v) return;
            const next = cloneModifier(prev, false) as LightingMod;
            next[key] = v;
            lm[key] = prev[key];
            ctrl.execute(updateModifierCommand(scope, layerId, prev, next, `Light ${label.toLowerCase()}`));
          },
        });
      };

      const angleCtrl = bindLightSlider('angle', 'Angle°', 0, 360);
      const elevCtrl = bindLightSlider('elevation', 'Elev°', 5, 89);

      // Interactive 2D circular Light Source Pad (drag to aim light angle + elevation live)
      const padSize = 72;
      const padDot = h('span', { class: 'light-pad-dot' });
      const pad = h('div', {
        class: 'light-pad',
        role: 'slider',
        tabindex: 0,
        'aria-label': 'Light source direction pad',
        title: 'Drag to aim light angle & elevation',
      }, padDot);

      const syncPadDot = () => {
        const r = padSize / 2 - 5;
        const rad = (lm.angle * Math.PI) / 180;
        const dist = (1 - (lm.elevation - 5) / 84) * r;
        const px = padSize / 2 + Math.cos(rad) * dist;
        const py = padSize / 2 + Math.sin(rad) * dist;
        padDot.style.left = `${px}px`;
        padDot.style.top = `${py}px`;
      };
      syncPadDot();

      let padBefore: LightingMod | null = null;
      const updateFromPad = (e: PointerEvent) => {
        const rect = pad.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        const maxR = Math.max(1, rect.width / 2 - 4);
        const normR = Math.min(1, Math.hypot(dx, dy) / maxR);
        const deg = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360);
        const elev = Math.max(5, Math.min(89, Math.round(5 + (1 - normR) * 84)));
        lm.angle = deg;
        lm.elevation = elev;
        angleCtrl.setValue(deg);
        elevCtrl.setValue(elev);
        syncPadDot();
        ctrl.markDirty();
        requestRender();
      };
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pad.setPointerCapture(e.pointerId);
        padBefore = cloneModifier(lm, false) as LightingMod;
        updateFromPad(e);
      });
      pad.addEventListener('pointermove', (e) => {
        if (!padBefore) return;
        updateFromPad(e);
      });
      const endPad = () => {
        if (!padBefore) return;
        const prev = padBefore;
        padBefore = null;
        const next = cloneModifier(lm, false) as LightingMod;
        lm.angle = prev.angle;
        lm.elevation = prev.elevation;
        if (prev.angle !== next.angle || prev.elevation !== next.elevation) {
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Aim light source'));
        }
      };
      pad.addEventListener('pointerup', endPad);
      pad.addEventListener('pointercancel', endPad);

      let colBefore: LightingMod | null = null;
      const colIn = h('input', {
        id: `mod-${m.id}-lcol`,
        type: 'color',
        value: rgbaToHex(lm.color),
        'aria-label': 'Light color',
        onInput: () => {
          if (!colBefore) colBefore = cloneModifier(lm, false) as LightingMod;
          lm.color = hexToRgba(colIn.value);
          ctrl.markDirty();
          requestRender();
        },
        onChange: () => {
          const prev = colBefore ?? (cloneModifier(lm, false) as LightingMod);
          colBefore = null;
          const next = cloneModifier(prev, false) as LightingMod;
          next.color = hexToRgba(colIn.value);
          lm.color = [...prev.color] as RGBA;
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Light color'));
        },
      });

      body.push(
        h('div', { class: 'light-pad-row' },
          pad,
          h('div', { class: 'light-pad-meta' },
            h('span', { class: 'hint' }, 'Drag pad to aim light'),
            h('div', { class: 'row' }, h('label', { for: `mod-${m.id}-lcol` }, 'Color'), colIn),
          ),
        ),
        angleCtrl.el,
        elevCtrl.el,
        bindLightSlider('intensity', 'Power', 0, 200).el,
        bindLightSlider('ambient', 'Ambient', 0, 100).el,
        bindLightSlider('bevel', 'Bevel', 1, 8).el,
      );
    } else if (m.type === 'tone') {
      const tm = m as ToneMod;
      const bindToneSlider = (key: 'shadows' | 'highlights' | 'contrast', label: string) => {
        let beforeSnap: ToneMod | null = null;
        return sliderField({
          id: `mod-${m.id}-${key}`,
          label,
          min: -100,
          max: 100,
          value: tm[key],
          onInput: (v) => {
            if (!beforeSnap) beforeSnap = cloneModifier(tm, false) as ToneMod;
            tm[key] = v;
            ctrl.markDirty();
            requestRender();
          },
          onCommit: (v) => {
            const prev = beforeSnap ?? (cloneModifier(tm, false) as ToneMod);
            beforeSnap = null;
            if (prev[key] === v) return;
            const next = cloneModifier(prev, false) as ToneMod;
            next[key] = v;
            tm[key] = prev[key];
            ctrl.execute(updateModifierCommand(scope, layerId, prev, next, `Tone ${label.toLowerCase()}`));
          },
        }).el;
      };
      const bindTint = (key: 'shadowTint' | 'highlightTint', label: string) => {
        let beforeTint: ToneMod | null = null;
        const inp = h('input', {
          id: `mod-${m.id}-${key}`,
          type: 'color',
          value: rgbaToHex(tm[key]),
          'aria-label': label,
          onInput: () => {
            if (!beforeTint) beforeTint = cloneModifier(tm, false) as ToneMod;
            tm[key] = hexToRgba(inp.value);
            ctrl.markDirty();
            requestRender();
          },
          onChange: () => {
            const prev = beforeTint ?? (cloneModifier(tm, false) as ToneMod);
            beforeTint = null;
            const next = cloneModifier(prev, false) as ToneMod;
            next[key] = hexToRgba(inp.value);
            tm[key] = [...prev[key]] as RGBA;
            ctrl.execute(updateModifierCommand(scope, layerId, prev, next, label));
          },
        });
        return h('div', { class: 'row' }, h('label', { for: `mod-${m.id}-${key}` }, label), inp);
      };
      body.push(
        bindToneSlider('shadows', 'Shadows'),
        bindToneSlider('highlights', 'Highlights'),
        bindToneSlider('contrast', 'Contrast'),
        bindTint('shadowTint', 'Shad tint'),
        bindTint('highlightTint', 'High tint'),
      );
    } else {
      const om = m as OutlineMod;
      const modeSel = h(
        'select',
        {
          id: `mod-${m.id}-mode`,
          onChange: () => {
            const prev = cloneModifier(om, false);
            const next = cloneModifier(om, false) as OutlineMod;
            next.mode = modeSel.value as 'outer' | 'inner';
            ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Outline mode'));
          },
        },
        h('option', { value: 'outer', selected: om.mode === 'outer' }, 'Outer'),
        h('option', { value: 'inner', selected: om.mode === 'inner' }, 'Inner'),
      );
      let colorBefore: OutlineMod | null = null;
      const colInput = h('input', {
        id: `mod-${m.id}-color`,
        type: 'color',
        value: rgbaToHex(om.color),
        'aria-label': 'Outline color',
        onInput: () => {
          if (!colorBefore) colorBefore = cloneModifier(om, false) as OutlineMod;
          om.color = hexToRgba(colInput.value);
          ctrl.markDirty();
          requestRender();
        },
        onChange: () => {
          const prev = colorBefore ?? (cloneModifier(om, false) as OutlineMod);
          colorBefore = null;
          const next = cloneModifier(prev, false) as OutlineMod;
          next.color = hexToRgba(colInput.value);
          om.color = prev.color;
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Outline color'));
        },
      });
      const widthBtns = ([0.2, 0.5, 1, 2, 3, 4] as const).map((w) =>
        h('button', {
          type: 'button',
          class: 'tiny-btn',
          'aria-pressed': String(Math.abs((om.width ?? 1) - w) < 0.05),
          onClick: () => {
            const prev = cloneModifier(om, false);
            const next = cloneModifier(om, false) as OutlineMod;
            next.width = w;
            ctrl.execute(updateModifierCommand(scope, layerId, prev, next, `Outline width ${w}`));
          },
        }, String(w)),
      );
      const connBtns = ([4, 8] as const).map((c) =>
        h('button', {
          type: 'button',
          class: 'tiny-btn',
          'aria-pressed': String((om.connectivity ?? 4) === c),
          onClick: () => {
            const prev = cloneModifier(om, false);
            const next = cloneModifier(om, false) as OutlineMod;
            next.connectivity = c;
            ctrl.execute(updateModifierCommand(scope, layerId, prev, next, `Outline ${c}-way`));
          },
        }, `${c}-way`),
      );
      const edgeBox = h('input', {
        id: `mod-${m.id}-bounds`,
        type: 'checkbox',
        checked: Boolean(om.onlyOutsideBounds),
        onChange: () => {
          const prev = cloneModifier(om, false);
          const next = cloneModifier(om, false) as OutlineMod;
          next.onlyOutsideBounds = edgeBox.checked;
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Outline canvas bounds'));
        },
      });
      body.push(
        h('div', { class: 'row' }, h('label', { for: `mod-${m.id}-mode` }, 'Mode'), modeSel),
        h('div', { class: 'row' }, h('label', { for: `mod-${m.id}-color` }, 'Color'), colInput),
        h('div', { class: 'row' }, h('label', {}, 'Width'), h('div', { class: 'btn-group' }, ...widthBtns)),
        h('div', { class: 'row' }, h('label', {}, 'Conn'), h('div', { class: 'btn-group' }, ...connBtns)),
        h('label', { class: 'check-row hint', for: `mod-${m.id}-bounds` }, edgeBox, 'Only outside bounds'),
      );
    }

    // Eye button: click toggles enabled; Alt+hold solos this modifier non-destructively
    const clearSolo = () => {
      if (ctrl.state.soloModifier?.modId === m.id) ctrl.setSoloModifier(null);
    };
    const eyeBtn = h('button', {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': `Toggle ${m.type} modifier (Alt+hold to solo)`,
      'aria-pressed': String(m.enabled),
      title: 'Click toggle · Alt+hold solo preview',
      onPointerdown: (e: PointerEvent) => {
        if (e.altKey) {
          e.preventDefault();
          ctrl.setSoloModifier({ scope, layerId, modId: m.id });
        }
      },
      onPointerup: clearSolo,
      onPointercancel: clearSolo,
      onPointerleave: clearSolo,
      onClick: (e: MouseEvent) => {
        if (e.altKey) return;
        const prev = cloneModifier(m, false);
        const next = cloneModifier(m, false);
        next.enabled = !m.enabled;
        ctrl.execute(updateModifierCommand(scope, layerId, prev, next, `${next.enabled ? 'Enable' : 'Disable'} ${m.type} modifier`));
      },
    }, icon(m.enabled ? 'eye' : 'eyeOff', 14));

    const maskBtn = h('button', {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': m.mask ? 'Clear modifier selection mask' : 'Bind modifier to current selection',
      'aria-pressed': String(Boolean(m.mask)),
      title: m.mask ? 'Clear selection mask' : 'Apply to current selection slice',
      onClick: () => {
        const prev = cloneModifier(m, false);
        const next = cloneModifier(m, false);
        if (m.mask) {
          next.mask = undefined;
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Clear modifier mask'));
        } else if (ctrl.state.selection) {
          next.mask = cloneMask(ctrl.state.selection);
          ctrl.execute(updateModifierCommand(scope, layerId, prev, next, 'Mask modifier to selection'));
        } else {
          ctrl.showToast('Make a selection first to mask this modifier.', 'info');
        }
      },
    }, icon('mask', 14));

    const isEditingEffectMask = ctrl.state.editTarget === 'mod-mask' && ctrl.state.activeModMaskId === m.id;
    const effectMaskBtn = h('button', {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': `Paint ${m.type} effect mask`,
      'aria-pressed': String(isEditingEffectMask || Boolean(m.effectMask)),
      title: isEditingEffectMask
        ? 'Stop painting effect mask (Right-click to clear)'
        : m.effectMask
          ? 'Paint/edit effect mask on canvas (Right-click to clear)'
          : 'Create paintable Photoshop effect mask',
      onClick: () => {
        if (isEditingEffectMask) ctrl.setEditTarget('pixels');
        else ctrl.startEditModifierMask(scope, layerId, m.id);
      },
      onContextmenu: (e: MouseEvent) => {
        if (!m.effectMask) return;
        e.preventDefault();
        ctrl.clearModifierEffectMask(scope, layerId, m.id);
      },
    }, icon('layerMask', 14));

    const bake = () => {
      ctrl.execute(bakeModifierCommand(scope, layerId, m.id));
      ctrl.showToast(`Baked ${m.type} modifier to pixels.`, 'info');
    };

    // Only the card header is draggable so range sliders in the card body never trigger card drag!
    const isFocused = ctrl.state.focusedModId === m.id;
    const card = h(
      'div',
      {
        class: `mod${isFocused ? ' mod-focused' : ''}`,
        'data-mod-id': m.id,
        onDragover: (e: DragEvent) => { e.preventDefault(); },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          if (dragModFrom >= 0 && dragModFrom !== idx) {
            ctrl.execute(reorderModifierCommand(scope, layerId, dragModFrom, idx));
          }
          dragModFrom = -1;
        },
      },
      h(
        'header',
        {
          class: 'mod-head',
          draggable: true,
          onDragstart: () => { dragModFrom = idx; },
          title: 'Drag header to reorder · Right-click to bake to pixels',
          onContextmenu: (e: MouseEvent) => {
            e.preventDefault();
            bake();
          },
        },
        eyeBtn,
        h('span', { class: 'mod-title' }, m.effectMask || m.mask ? `${m.type} · mask` : m.type),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn tiny',
            'aria-label': `Remove ${m.type} modifier`,
            title: 'Remove modifier',
            onClick: () => ctrl.execute(removeModifierCommand(scope, layerId, m.id)),
          },
          icon('x', 14),
        ),
      ),
      h(
        'div',
        { class: 'mod-actions', role: 'toolbar', 'aria-label': `${m.type} modifier actions` },
        effectMaskBtn,
        maskBtn,
        h('button', {
          type: 'button', class: 'icon-btn tiny', 'aria-label': 'Move modifier up', title: 'Move up', disabled: idx === 0,
          onClick: () => ctrl.execute(reorderModifierCommand(scope, layerId, idx, idx - 1)),
        }, icon('up', 14)),
        h('button', {
          type: 'button', class: 'icon-btn tiny', 'aria-label': 'Move modifier down', title: 'Move down', disabled: idx >= total - 1,
          onClick: () => ctrl.execute(reorderModifierCommand(scope, layerId, idx, idx + 1)),
        }, icon('down', 14)),
        h('button', {
          type: 'button', class: 'icon-btn tiny', 'aria-label': 'Duplicate modifier', title: 'Duplicate modifier',
          onClick: () => ctrl.execute(duplicateModifierCommand(scope, layerId, m.id)),
        }, icon('copy', 14)),
        h('button', {
          type: 'button', class: 'icon-btn tiny', 'aria-label': 'Apply modifier to pixels', title: 'Apply to pixels (bake)',
          onClick: bake,
        }, icon('check', 14)),
      ),
      ...body,
    );
    return card;
  };

  const drawMods = () => {
    const s = ctrl.state;
    scopeBtns[0].setAttribute('aria-pressed', String(s.modScope === 'layer'));
    scopeBtns[1].setAttribute('aria-pressed', String(s.modScope === 'doc'));
    const layer = ctrl.getActiveLayer();
    const list = s.modScope === 'doc' ? s.doc.modifiers : layer.modifiers;
    const layerId = s.modScope === 'doc' ? null : layer.id;
    modsList.replaceChildren(
      list.length ? '' : h('p', { class: 'empty' }, 'No modifiers. Source pixels stay untouched.'),
      ...list.map((m, idx) => modCard(m, idx, list.length, s.modScope, layerId)),
    );
  };

  const modsBody = h(
    'div',
    {},
    h('div', { class: 'row seg-row' }, ...scopeBtns),
    modsList,
    h(
      'div',
      { class: 'action-bar mod-add-row' },
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            const s = ctrl.state;
            ctrl.execute(addModifierCommand(s.modScope, s.modScope === 'doc' ? null : s.activeLayerId, newModifier('color')));
          },
        },
        '+ Color',
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            const s = ctrl.state;
            ctrl.execute(addModifierCommand(s.modScope, s.modScope === 'doc' ? null : s.activeLayerId, newModifier('outline')));
          },
        },
        '+ Outline',
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            const s = ctrl.state;
            ctrl.execute(addModifierCommand(s.modScope, s.modScope === 'doc' ? null : s.activeLayerId, newModifier('shadow')));
          },
        },
        '+ Shadow',
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            const s = ctrl.state;
            ctrl.execute(addModifierCommand(s.modScope, s.modScope === 'doc' ? null : s.activeLayerId, newModifier('palette-map')));
          },
        },
        '+ Palette',
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            const s = ctrl.state;
            ctrl.execute(addModifierCommand(s.modScope, s.modScope === 'doc' ? null : s.activeLayerId, newModifier('dither')));
          },
        },
        '+ Dither',
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            const s = ctrl.state;
            ctrl.execute(addModifierCommand(s.modScope, s.modScope === 'doc' ? null : s.activeLayerId, newModifier('lighting')));
          },
        },
        '+ Light',
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            const s = ctrl.state;
            ctrl.execute(addModifierCommand(s.modScope, s.modScope === 'doc' ? null : s.activeLayerId, newModifier('tone')));
          },
        },
        '+ Tone',
      ),
    ),
  );

  drawMods();
  ctrl.store.subscribe(
    (s) => [s.docRev, s.activeLayerId, s.modScope, s.focusedModId] as const,
    () => {
      drawMods();
      const fid = ctrl.state.focusedModId;
      if (fid) {
        const cardEl = modsList.querySelector<HTMLElement>(`.mod[data-mod-id="${fid}"]`);
        cardEl?.scrollIntoView?.({ block: 'nearest' });
      }
    },
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  // ---- 4. Hue-shift ramp panel (F-RAMP P2 extensions) ----
  const rampEl = h('div', { class: 'ramp', role: 'group', 'aria-label': 'Hue-shift color ramp' });
  const rampModeBtns = (['step', 'triad'] as const).map((m) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(ctrl.state.rampMode === m),
      onClick: () => ctrl.store.setState({ rampMode: m }),
    }, m === 'step' ? 'Step' : 'Dark / Base / Light'),
  );

  const baseInput = h('input', {
    id: 'ramp-base',
    type: 'color',
    value: rgbaToHex(ctrl.state.rampBase),
    'aria-label': 'Ramp base color',
    onInput: () => {
      const base = hexToRgba(baseInput.value);
      ctrl.store.setState({ rampBase: base, primaryColor: base });
    },
  });
  const darkInput = h('input', {
    id: 'ramp-dark',
    type: 'color',
    value: rgbaToHex(ctrl.state.rampDark),
    'aria-label': 'Ramp dark color',
    onInput: () => ctrl.store.setState({ rampDark: hexToRgba(darkInput.value) }),
  });
  const lightInput = h('input', {
    id: 'ramp-light',
    type: 'color',
    value: rgbaToHex(ctrl.state.rampLight),
    'aria-label': 'Ramp light color',
    onInput: () => ctrl.store.setState({ rampLight: hexToRgba(lightInput.value) }),
  });

  const rampSteps = sliderField({
    id: 'ramp-steps', label: 'Steps', min: 3, max: 9, value: ctrl.state.ramp.steps,
    onInput: (v) => ctrl.store.setState({ ramp: { ...ctrl.state.ramp, steps: v } }),
  });
  const rampHue = sliderField({
    id: 'ramp-hue', label: 'Hue', min: -40, max: 40, value: ctrl.state.ramp.hueShift,
    onInput: (v) => ctrl.store.setState({ ramp: { ...ctrl.state.ramp, hueShift: v } }),
  });
  const rampSat = sliderField({
    id: 'ramp-sat', label: 'Sat', min: -30, max: 30, value: ctrl.state.ramp.satShift,
    onInput: (v) => ctrl.store.setState({ ramp: { ...ctrl.state.ramp, satShift: v } }),
  });
  const rampLight = sliderField({
    id: 'ramp-light-step', label: 'Light', min: 4, max: 30, value: ctrl.state.ramp.lightStep,
    onInput: (v) => ctrl.store.setState({ ramp: { ...ctrl.state.ramp, lightStep: v } }),
  });
  const rampMult = sliderField({
    id: 'ramp-mult', label: 'Mult %', min: 50, max: 200, value: ctrl.state.rampMult,
    onInput: (v) => ctrl.store.setState({ rampMult: v }),
  });

  const stepFields = h('div', {}, rampHue.el, rampSat.el, rampLight.el);
  const triadFields = h(
    'div',
    {},
    h('div', { class: 'row' },
      h('label', { for: 'ramp-dark' }, 'Dark'), darkInput,
      h('label', { for: 'ramp-light' }, 'Light'), lightInput,
    ),
    rampMult.el,
  );

  const lockRampBtn = h('button', {
    type: 'button',
    'aria-pressed': String(ctrl.state.rampLockToPalette),
    title: 'Snap ramp colors to active palette (OKLab)',
    onClick: () => ctrl.store.setState({ rampLockToPalette: !ctrl.state.rampLockToPalette }),
  }, 'Lock to palette');

  const computeCurrentRamp = () => {
    const s = ctrl.state;
    const raw =
      s.rampMode === 'triad'
        ? makeTriadRamp(s.rampDark, s.rampBase, s.rampLight, s.ramp.steps, s.rampMult)
        : makeRamp(s.rampBase, s.ramp);
    if (!s.rampLockToPalette) return raw;
    const pal = ctrl.getActivePalette().colors.map((c) => c.rgba);
    if (pal.length === 0) return raw;
    return raw.map((c) => nearestPaletteColor(c, pal));
  };

  const sendRampBtn = h('button', {
    type: 'button',
    title: 'Append ramp colors to active palette',
    onClick: () => {
      const ramp = computeCurrentRamp();
      ctrl.execute(appendPaletteColorsCommand(ctrl.getActivePalette().id, ramp, 'Send ramp to palette'));
      ctrl.showToast(`Sent ${ramp.length} ramp colors to palette.`, 'info');
    },
  }, 'Send to palette');

  const drawRamp = () => {
    const s = ctrl.state;
    rampModeBtns[0].setAttribute('aria-pressed', String(s.rampMode === 'step'));
    rampModeBtns[1].setAttribute('aria-pressed', String(s.rampMode === 'triad'));
    stepFields.hidden = s.rampMode !== 'step';
    triadFields.hidden = s.rampMode !== 'triad';
    lockRampBtn.setAttribute('aria-pressed', String(s.rampLockToPalette));

    const ramp = computeCurrentRamp();
    rampEl.replaceChildren(
      ...ramp.map((c) => {
        const hex = rgbaToHex(c);
        return h('button', {
          type: 'button',
          style: `background:${hex}`,
          title: `Primary ${hex} (Right-click secondary)`,
          'aria-label': `Color ${hex}`,
          'aria-pressed': String(rgbaEqual(c, s.primaryColor)),
          onClick: () => ctrl.store.setState({ primaryColor: c }),
          onContextmenu: (e: MouseEvent) => {
            e.preventDefault();
            ctrl.store.setState({ secondaryColor: c });
          },
        });
      }),
    );
  };

  const rampBody = h(
    'div',
    {},
    h('div', { class: 'row seg-row' }, ...rampModeBtns),
    h('div', { class: 'row' }, h('label', { for: 'ramp-base' }, 'Base'), baseInput),
    rampSteps.el,
    stepFields,
    triadFields,
    rampEl,
    h('div', { class: 'action-bar ramp-actions' }, lockRampBtn, sendRampBtn),
  );
  drawRamp();
  ctrl.store.subscribe(
    (s) => [s.ramp, s.rampBase, s.rampDark, s.rampLight, s.rampMult, s.rampMode, s.rampLockToPalette, s.primaryColor, s.docRev] as const,
    drawRamp,
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  // ---- 5. Tiles panel (P5 Tile Builder & Map quick actions) ----
  const tileWIn = h('input', {
    id: 'tile-w',
    class: 'num',
    type: 'number',
    min: 1,
    max: 256,
    value: ctrl.state.doc.tileset.tileW,
    'aria-label': 'Tile width',
  });
  const tileHIn = h('input', {
    id: 'tile-h',
    class: 'num',
    type: 'number',
    min: 1,
    max: 256,
    value: ctrl.state.doc.tileset.tileH,
    'aria-label': 'Tile height',
  });
  const applyTileSize = () => {
    const nw = Math.max(1, Math.min(256, Math.round(Number(tileWIn.value) || 16)));
    const nh = Math.max(1, Math.min(256, Math.round(Number(tileHIn.value) || 16)));
    const ts = ctrl.state.doc.tileset;
    if (nw !== ts.tileW || nh !== ts.tileH) {
      ctrl.execute(setTileSizeCommand(nw, nh));
      ctrl.store.setState({ activeTileIndex: 0 });
    }
  };
  tileWIn.addEventListener('change', applyTileSize);
  tileHIn.addEventListener('change', applyTileSize);

  const tilePresetRow = h(
    'div',
    { class: 'preset-row', role: 'group', 'aria-label': 'Tile size presets' },
    ...TILE_SIZE_PRESETS.map((sz) =>
      h('button', {
        type: 'button',
        class: 'tiny-btn',
        onClick: () => {
          tileWIn.value = String(sz);
          tileHIn.value = String(sz);
          applyTileSize();
        },
      }, String(sz)),
    ),
  );

  const captureCatSel = h(
    'select',
    {
      id: 'tile-cap-cat',
      'aria-label': 'New tile category',
      onChange: () => ctrl.store.setState({ captureCategory: captureCatSel.value as TileCategory }),
    },
    ...TILE_CATEGORIES.map((c) => h('option', { value: c, selected: c === ctrl.state.captureCategory }, c)),
  );

  const filterCatSel = h(
    'select',
    {
      id: 'tile-filter-cat',
      'aria-label': 'Filter tiles by category',
      onChange: () => ctrl.store.setState({ tileCategoryFilter: filterCatSel.value as TileCategory | 'all' }),
    },
    h('option', { value: 'all', selected: true }, 'All categories'),
    ...TILE_CATEGORIES.map((c) => h('option', { value: c }, c)),
  );

  const tileGrid = h('div', { class: 'tile-grid', role: 'list', 'aria-label': 'Tileset' });

  const drawTiles = () => {
    const s = ctrl.state;
    const { tileW, tileH, tiles } = s.doc.tileset;
    tileWIn.value = String(tileW);
    tileHIn.value = String(tileH);
    captureCatSel.value = s.captureCategory;
    filterCatSel.value = s.tileCategoryFilter;

    const frameCache = new Map<number, Uint8ClampedArray>();
    const filtered = tiles
      .map((tile, idx) => ({ tile, oneBased: idx + 1 }))
      .filter(({ tile }) => s.tileCategoryFilter === 'all' || tile.category === s.tileCategoryFilter);

    if (filtered.length === 0) {
      tileGrid.replaceChildren(
        h('p', { class: 'empty' }, tiles.length === 0 ? 'Select a rect (or origin) and click + Add tile.' : 'No tiles in this category.'),
      );
      return;
    }

    tileGrid.replaceChildren(
      ...filtered.map(({ tile, oneBased }) => {
        const thumb = h('canvas', { class: 'tile-thumb', width: tileW, height: tileH, 'aria-hidden': 'true' });
        const tctx = thumb.getContext('2d');
        if (tctx && typeof ImageData !== 'undefined') {
          const px = resolveTilePixels(s.doc, tile, frameCache);
          const copy = new Uint8ClampedArray(px.length);
          copy.set(px);
          tctx.putImageData(new ImageData(copy, tileW, tileH), 0, 0);
        }
        const selected = s.activeTileIndex === oneBased;
        return h(
          'div',
          {
            class: 'tile-card',
            role: 'listitem',
            'aria-current': selected ? 'true' : 'false',
          },
          h(
            'button',
            {
              type: 'button',
              class: 'tile-select-btn',
              title: `#${oneBased} ${tile.name} (${tile.category})${tile.linked ? ' · linked' : ''}`,
              onClick: () => ctrl.store.setState({ activeTileIndex: oneBased }),
            },
            thumb,
            h('span', { class: 'mono tile-idx' }, `#${oneBased}`),
          ),
          h(
            'div',
            { class: 'tile-card-actions' },
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn tiny',
                'aria-label': tile.linked ? 'Unlink tile from source' : 'Link tile to source',
                'aria-pressed': String(tile.linked),
                title: tile.linked ? 'Linked to canvas source (click to freeze)' : 'Static snapshot (click to link)',
                disabled: !tile.source,
                onClick: () => ctrl.execute(updateTileMetaCommand(tile.id, { linked: !tile.linked }, tile.linked ? 'Unlink tile' : 'Link tile')),
              },
              icon(tile.linked ? 'link' : 'unlink', 12),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn tiny',
                'aria-label': `Delete ${tile.name}`,
                title: 'Delete tile',
                onClick: () => {
                  ctrl.execute(removeTileCommand(tile.id));
                  if (ctrl.state.activeTileIndex > ctrl.state.doc.tileset.tiles.length) {
                    ctrl.store.setState({ activeTileIndex: ctrl.state.doc.tileset.tiles.length });
                  }
                },
              },
              icon('x', 12),
            ),
          ),
        );
      }),
    );
  };

  const tileGridBtn = h('button', {
    type: 'button',
    'aria-pressed': String(ctrl.state.tileGridOverlay),
    title: 'Show tile-sized capture grid on Sprite canvas',
    onClick: () => ctrl.toggleTileGridOverlay(),
  }, 'Grid');

  const tilesBody = h(
    'div',
    {},
    tilePresetRow,
    h('div', { class: 'row' }, h('label', { for: 'tile-w' }, 'Size'), tileWIn, h('span', { class: 'hint' }, '×'), tileHIn, tileGridBtn),
    h('div', { class: 'row' },
      captureCatSel,
      h('button', {
        type: 'button',
        class: 'primary',
        title: 'Capture tile from selection bounds (or top-left)',
        onClick: () => ctrl.captureTileFromSelection(),
      }, '+ Add tile'),
    ),
    h('div', { class: 'row' }, filterCatSel),
    tileGrid,
    h('div', { class: 'action-bar tile-footer' },
      h('button', {
        type: 'button',
        title: 'Switch to Map editor',
        onClick: () => ctrl.setViewMode(ctrl.state.viewMode === 'map' ? 'sprite' : 'map'),
      }, icon('map', 14), ' Map'),
      h('button', {
        type: 'button',
        title: 'Export tileset PNG atlas',
        onClick: () => {
          const { png, atlas } = exportTilesetAtlasPngBytes(ctrl.state.doc, ctrl.state.atlasExtrusion);
          triggerDownload(png, 'image/png', `tintbox_atlas_ext${atlas.extrusion}.png`);
          ctrl.showToast(`Exported atlas (${atlas.w}×${atlas.h}).`, 'info');
        },
      }, 'Atlas'),
      h('button', {
        type: 'button',
        title: 'Export tilemap JSON',
        onClick: () => {
          triggerDownload(exportTileMapJson(ctrl.state.doc), 'application/json', 'tintbox_map.json');
          ctrl.showToast('Exported tilemap JSON.', 'info');
        },
      }, 'JSON'),
    ),
  );
  drawTiles();
  ctrl.store.subscribe(
    (s) => [s.docRev, s.activeTileIndex, s.tileCategoryFilter, s.captureCategory, s.tileGridOverlay] as const,
    () => {
      tileGridBtn.setAttribute('aria-pressed', String(ctrl.state.tileGridOverlay));
      drawTiles();
    },
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  // ---- 0. Independent Navigator panel (Sync on/off + live animation/reference preview) ----
  const navCanvas = h('canvas', {
    class: 'nav-canvas',
    width: 192,
    height: 112,
    role: 'img',
    'aria-label': 'Canvas navigator preview (drag to pan, double-click fit)',
    title: 'Drag to pan canvas · Double-click fit to viewport',
  });
  const navCtx = navCanvas.getContext('2d');
  let navPanDrag = false;
  let navTimer = 0;

  const navSyncBtn = h('button', {
    type: 'button',
    class: 'tiny-btn',
    'aria-pressed': String(ctrl.state.navSync),
    title: 'Sync with main canvas (turn off for independent animation or reference preview)',
    onClick: () => {
      const next = !ctrl.state.navSync;
      ctrl.store.setState({ navSync: next, navPlaying: next ? false : ctrl.state.navPlaying, navFrame: ctrl.state.activeFrame });
    },
  }, 'Sync');

  const navPlayBtn = h('button', {
    type: 'button',
    class: 'tiny-btn',
    'aria-pressed': 'false',
    title: 'Play / stop independent animation preview in Navigator',
    onClick: () => {
      const next = !ctrl.state.navPlaying;
      ctrl.store.setState({ navPlaying: next, navSync: next ? false : ctrl.state.navSync });
    },
  }, 'Play');

  const navFrameLabel = h('span', { class: 'mono hint' }, '1/1');
  const navSourceSel = h('select', {
    class: 'compact-select nav-src-sel',
    'aria-label': 'Navigator independent source',
    onChange: () => ctrl.store.setState({ navRefLayerId: navSourceSel.value || null, navPlaying: false }),
  });

  const navIndepBar = h('div', { class: 'row nav-indep-bar', hidden: true }, navPlayBtn, navFrameLabel, navSourceSel);

  let navGeom = { ox: 0, oy: 0, scale: 1, w: 64, h: 64 };
  const drawNavigator = () => {
    const s = ctrl.state;
    navSyncBtn.setAttribute('aria-pressed', String(s.navSync));
    navSyncBtn.textContent = s.navSync ? 'Sync: ON' : 'Sync: OFF';
    navIndepBar.hidden = s.navSync;
    navPlayBtn.setAttribute('aria-pressed', String(s.navPlaying));
    navPlayBtn.textContent = s.navPlaying ? 'Stop' : 'Play';

    const refLayers = s.doc.layers.filter((l) => l.kind === 'reference' && l.ref);
    navSourceSel.replaceChildren(
      h('option', { value: '', selected: !s.navRefLayerId }, 'Animation'),
      ...refLayers.map((rl) => h('option', { value: rl.id, selected: s.navRefLayerId === rl.id }, `Ref: ${rl.name}`)),
    );

    const frameIdx = s.navSync
      ? s.activeFrame
      : Math.max(0, Math.min(s.doc.frames.length - 1, s.navFrame));
    navFrameLabel.textContent = `${frameIdx + 1}/${s.doc.frames.length}`;

    if (s.collapsed.navigator || !navCtx) return;

    const cw = navCanvas.width;
    const ch = navCanvas.height;
    navCtx.clearRect(0, 0, cw, ch);

    const refLayer = !s.navSync && s.navRefLayerId ? refLayers.find((r) => r.id === s.navRefLayerId) : null;
    if (refLayer?.ref && typeof ImageData !== 'undefined') {
      const r = refLayer.ref;
      const scale = Math.min((cw - 8) / Math.max(1, r.w), (ch - 8) / Math.max(1, r.h));
      const dw = Math.max(1, Math.round(r.w * scale));
      const dh = Math.max(1, Math.round(r.h * scale));
      const ox = Math.floor((cw - dw) / 2);
      const oy = Math.floor((ch - dh) / 2);
      const tmp = document.createElement('canvas');
      tmp.width = r.w;
      tmp.height = r.h;
      const tctx = tmp.getContext('2d');
      if (tctx) {
        const copy = new Uint8ClampedArray(r.pixels.length);
        copy.set(r.pixels);
        tctx.putImageData(new ImageData(copy, r.w, r.h), 0, 0);
        navCtx.imageSmoothingEnabled = r.smooth;
        navCtx.drawImage(tmp, ox, oy, dw, dh);
      }
      navGeom = { ox, oy, scale, w: r.w, h: r.h };
      return;
    }

    const px = ctrl.getComposed(frameIdx);
    const dwDoc = s.doc.w;
    const dhDoc = s.doc.h;
    const scale = Math.min((cw - 8) / Math.max(1, dwDoc), (ch - 8) / Math.max(1, dhDoc));
    const dw = Math.max(1, Math.round(dwDoc * scale));
    const dh = Math.max(1, Math.round(dhDoc * scale));
    const ox = Math.floor((cw - dw) / 2);
    const oy = Math.floor((ch - dh) / 2);
    navGeom = { ox, oy, scale, w: dwDoc, h: dhDoc };

    // Subtle canvas backdrop
    navCtx.fillStyle = '#2a2820';
    navCtx.fillRect(ox, oy, dw, dh);

    if (typeof ImageData !== 'undefined') {
      const tmp = document.createElement('canvas');
      tmp.width = dwDoc;
      tmp.height = dhDoc;
      const tctx = tmp.getContext('2d');
      if (tctx) {
        const copy = new Uint8ClampedArray(px.length);
        copy.set(px);
        tctx.putImageData(new ImageData(copy, dwDoc, dhDoc), 0, 0);
        navCtx.imageSmoothingEnabled = false;
        navCtx.drawImage(tmp, ox, oy, dw, dh);
      }
    }

    // Viewport rectangle in sync mode
    if (s.navSync) {
      const stageEl = document.getElementById('stage');
      const sw = stageEl?.clientWidth || 640;
      const sh = stageEl?.clientHeight || 480;
      const vp = s.viewport;
      const vx0 = (-vp.panX) / vp.zoom;
      const vy0 = (-vp.panY) / vp.zoom;
      const vw = sw / vp.zoom;
      const vh = sh / vp.zoom;
      navCtx.save();
      navCtx.strokeStyle = '#c6f432';
      navCtx.lineWidth = 1.5;
      navCtx.strokeRect(
        Math.round(ox + vx0 * scale) + 0.5,
        Math.round(oy + vy0 * scale) + 0.5,
        Math.max(4, Math.round(vw * scale)),
        Math.max(4, Math.round(vh * scale)),
      );
      navCtx.restore();
    }
  };

  const panFromNav = (e: PointerEvent) => {
    if (!ctrl.state.navSync) return;
    const rect = navCanvas.getBoundingClientRect();
    const lx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * navCanvas.width;
    const ly = ((e.clientY - rect.top) / Math.max(1, rect.height)) * navCanvas.height;
    const docX = (lx - navGeom.ox) / Math.max(0.001, navGeom.scale);
    const docY = (ly - navGeom.oy) / Math.max(0.001, navGeom.scale);
    const stageEl = document.getElementById('stage');
    const sw = stageEl?.clientWidth || 640;
    const sh = stageEl?.clientHeight || 480;
    const vp = ctrl.state.viewport;
    ctrl.setPan(Math.round(sw / 2 - docX * vp.zoom), Math.round(sh / 2 - docY * vp.zoom));
  };

  navCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !ctrl.state.navSync) return;
    navPanDrag = true;
    navCanvas.setPointerCapture(e.pointerId);
    panFromNav(e);
  });
  navCanvas.addEventListener('pointermove', (e) => {
    if (navPanDrag) panFromNav(e);
  });
  navCanvas.addEventListener('pointerup', () => { navPanDrag = false; });
  navCanvas.addEventListener('pointercancel', () => { navPanDrag = false; });
  navCanvas.addEventListener('dblclick', () => ctrl.zoomFit());

  const syncNavTimer = () => {
    if (navTimer) {
      window.clearInterval(navTimer);
      navTimer = 0;
    }
    const s = ctrl.state;
    if (!s.navPlaying || s.navSync || s.doc.frames.length <= 1) return;
    const ms = Math.max(40, Math.round(1000 / Math.max(1, s.doc.fps)));
    navTimer = window.setInterval(() => {
      const cur = ctrl.state;
      if (!cur.navPlaying || cur.navSync || cur.doc.frames.length <= 1) {
        window.clearInterval(navTimer);
        navTimer = 0;
        return;
      }
      ctrl.store.setState({ navFrame: (cur.navFrame + 1) % cur.doc.frames.length });
    }, ms);
  };

  const navBody = h(
    'div',
    {},
    h('div', { class: 'row nav-top-row' },
      navSyncBtn,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'tiny-btn', title: 'Fit canvas to viewport (0)', onClick: () => ctrl.zoomFit() }, 'Fit'),
      h('button', { type: 'button', class: 'tiny-btn', title: 'Zoom 100% (1)', onClick: () => ctrl.zoom100() }, '1:1'),
    ),
    navIndepBar,
    h('div', { class: 'nav-canvas-wrap' }, navCanvas),
  );
  drawNavigator();
  ctrl.store.subscribe(
    (s) => [s.docRev, s.activeFrame, s.viewport, s.navSync, s.navPlaying, s.navFrame, s.navRefLayerId, Boolean(s.collapsed.navigator)] as const,
    () => {
      syncNavTimer();
      drawNavigator();
    },
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  // ---- Selection Slices panel (Alt+K / Alt+S / Alt+A / ZIP) ----
  const slicesList = h('div', { class: 'slices-list', role: 'list', 'aria-label': 'Selection slices' });
  const drawSlices = () => {
    const s = ctrl.state;
    const list = s.doc.slices ?? [];
    if (list.length === 0) {
      slicesList.replaceChildren(h('p', { class: 'empty' }, 'No slices yet. Make a selection and press Alt+K, or run Auto Slice (Alt+S).'));
      return;
    }
    const activeLayer = ctrl.getActiveLayer();
    const targetMod = activeLayer.modifiers.find((m) => m.id === s.focusedModId) ?? activeLayer.modifiers[0] ?? null;

    slicesList.replaceChildren(
      ...list.map((sl) => {
        const isCurrent = s.activeSliceId === sl.id;
        const nameBtn = h('button', {
          type: 'button',
          class: 'slice-name',
          title: 'Click to load selection · Double-click to rename',
          onClick: (e: MouseEvent) => ctrl.selectSlice(sl.id, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace'),
          onDblclick: () => {
            const inp = h('input', { type: 'text', class: 'rename-input', value: sl.name, 'aria-label': `Rename slice ${sl.name}`, maxlength: 48 });
            let done = false;
            const finish = (save: boolean) => {
              if (done) return;
              done = true;
              const trimmed = inp.value.trim();
              if (save && trimmed && trimmed !== sl.name) ctrl.renameSlice(sl.id, trimmed);
              else drawSlices();
            };
            inp.addEventListener('blur', () => finish(true));
            inp.addEventListener('keydown', (ke) => {
              ke.stopPropagation();
              if (ke.key === 'Enter') finish(true);
              else if (ke.key === 'Escape') finish(false);
            });
            nameBtn.replaceWith(inp);
            inp.focus();
            inp.select();
          },
        }, sl.name);

        return h(
          'div',
          { class: 'slice-row', role: 'listitem', 'aria-current': isCurrent ? 'true' : 'false' },
          nameBtn,
          h('span', { class: 'mono hint' }, `${sl.rect.w}×${sl.rect.h}`),
          h('button', {
            type: 'button',
            class: 'icon-btn tiny',
            disabled: !targetMod,
            'aria-label': `Bind active modifier to ${sl.name}`,
            title: targetMod ? `Bind ${MOD_LABELS[targetMod.type]} modifier to "${sl.name}"` : 'Add a modifier to active layer first to bind',
            onClick: () => {
              if (targetMod) ctrl.bindModifierToSlice('layer', activeLayer.id, targetMod.id, sl.id);
            },
          }, icon('mask', 12)),
          h('button', {
            type: 'button',
            class: 'icon-btn tiny',
            'aria-label': `Delete slice ${sl.name}`,
            title: 'Delete slice',
            onClick: () => ctrl.removeSlice(sl.id),
          }, icon('x', 12)),
        );
      }),
    );
  };

  const slicesBody = h(
    'div',
    {},
    h('div', { class: 'action-bar slices-bar' },
      h('button', { type: 'button', class: 'tiny-btn primary', title: 'Create slice from current selection (Alt+K)', onClick: () => ctrl.createSliceFromSelection() }, '+ Slice'),
      h('button', { type: 'button', class: 'tiny-btn', title: 'Detect pixel islands into grid slices (Alt+S)', onClick: () => ctrl.autoSliceAction() }, 'Auto'),
      h('button', { type: 'button', class: 'tiny-btn', title: 'Convert slices / islands into new animated tab (Alt+A)', onClick: () => ctrl.sliceAndAnimateAction() }, '→ Anim'),
      h('button', { type: 'button', class: 'tiny-btn', title: 'Batch export all slices as PNGs in a ZIP', onClick: () => ctrl.exportAllSlicesZip(ctrl.state.appPrefs.defaultExportScale) }, 'ZIP'),
    ),
    slicesList,
  );
  drawSlices();
  ctrl.store.subscribe(
    (s) => [s.docRev, s.activeLayerId, s.activeSliceId, s.focusedModId] as const,
    drawSlices,
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  // ---- 6. History panel (P3 + P6 active/undone divider) ----
  const historyList = h('div', { class: 'history-list', role: 'list', 'aria-label': 'Edit history' });
  const drawHistory = () => {
    const entries = ctrl.history.getEntries();
    const nodes: HTMLElement[] = [];
    let dividerPlaced = false;
    for (const entry of entries) {
      if (entry.undone && !dividerPlaced) {
        dividerPlaced = true;
        nodes.push(h('div', { class: 'history-divider mono', role: 'separator' }, 'Undone'));
      }
      nodes.push(
        h(
          'button',
          {
            type: 'button',
            role: 'listitem',
            class: `history-item${entry.undone ? ' undone' : ''}`,
            'aria-current': entry.current ? 'true' : 'false',
            onClick: () => ctrl.jumpHistory(entry.index),
          },
          h('span', { class: 'mono history-idx' }, String(entry.index)),
          h('span', { class: 'history-lbl' }, entry.label),
          entry.current ? h('span', { class: 'mono history-now' }, 'now') : null,
        ),
      );
    }
    historyList.replaceChildren(...nodes);
  };
  drawHistory();
  ctrl.store.subscribe((s) => s.historyRev, drawHistory);

  const mobileHead = h(
    'div',
    { class: 'side-mobile-head' },
    h('span', { class: 'mono' }, 'INSPECTOR'),
    h('button', {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': 'Close inspector panels',
      onClick: () => onCloseDrawer?.(),
    }, icon('x', 14)),
  );

  const navSec = collapsiblePanel(ctrl, 'navigator', 'Navigator', navBody);
  const palSec = collapsiblePanel(ctrl, 'palette', 'Palette', paletteBody);
  const laySec = collapsiblePanel(ctrl, 'layers', 'Layers', layersBody);
  const sliceSec = collapsiblePanel(ctrl, 'slices', 'Selection Slices', slicesBody);
  const modSec = collapsiblePanel(ctrl, 'mods', 'Modifiers', modsBody);
  const tileSec = collapsiblePanel(ctrl, 'tiles', 'Tiles', tilesBody);
  const rampSec = collapsiblePanel(ctrl, 'ramp', 'Hue-shift ramp', rampBody);
  const histSec = collapsiblePanel(ctrl, 'history', 'History', historyList);

  const syncPanelVis = () => {
    const pv = ctrl.state.panelVisible;
    navSec.hidden = pv.navigator === false;
    palSec.hidden = pv.palette === false;
    laySec.hidden = pv.layers === false;
    sliceSec.hidden = pv.slices === false;
    modSec.hidden = pv.modifiers === false;
    tileSec.hidden = pv.tiles === false;
    histSec.hidden = pv.history === false;
  };
  syncPanelVis();
  ctrl.store.subscribe((s) => s.panelVisible, syncPanelVis);
  ctrl.store.subscribe((s) => [s.editTarget, s.activeModMaskId] as const, drawMods, (a, b) => a[0] === b[0] && a[1] === b[1]);

  return h(
    'aside',
    { class: 'side', id: 'side-panels', 'aria-label': 'Inspector panels' },
    mobileHead,
    navSec,
    palSec,
    laySec,
    sliceSec,
    modSec,
    tileSec,
    rampSec,
    histSec,
  );
}
