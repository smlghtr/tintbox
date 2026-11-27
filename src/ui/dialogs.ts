import { MAX_DIM } from '../core/doc';
import { defaultJuiceParams, evalJuiceFrame, JUICE_PRESETS, type JuiceParams, type JuicePreset } from '../core/juice';
import { hexToRgba, rgbaToHex } from '../core/palette';
import { extractPalette, type PaletteSort, type QuantizeMethod } from '../core/quantize';
import { RESAMPLE_ALGORITHMS, type ResampleAlgorithm } from '../core/scale';
import type { Anchor9, RGBA } from '../core/types';
import { defaultWarpParams, WARP_PRESETS, warpCelPixels, type WarpParams, type WarpPreset } from '../core/warp';
import type { AutosaveDraft } from '../io/autosave';
import {
  exportBmpBytes,
  exportGifBytes,
  exportJsCode,
  exportPngSequenceZip,
  exportPsdBytes,
  exportSinglePngBytes,
  exportSpritesheetBundle,
  resolveExportFrames,
  triggerDownload,
  type ExportFormat,
} from '../io/export-pack';
import { decodeImageBlob, type DecodedImage } from '../io/image';
import type { JsExportMode } from '../io/js-export';
import { bytesToDataUrl, encodePngRgba } from '../io/png';
import {
  addPaletteCommand,
  appendPaletteColorsCommand,
  replacePaletteColorsCommand,
} from '../state/commands';
import type { AppController } from './controller';
import { h, sliderField } from './dom';
import { icon } from './icons';
import { SHORTCUT_LIST } from './keymap';
import { createPreferencesDialog, type PrefsTabId } from './preferences-dialog';

const PRESETS = [16, 32, 64, 128, 256];
const ANCHORS: Anchor9[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const EXTRACT_COUNTS = [4, 8, 16];

export interface ExtractSourcePreset {
  pixels: Uint8ClampedArray;
  w: number;
  h: number;
  dataUrl: string;
  name: string;
}

export interface AppDialogs {
  openNew: () => void;
  openResize: () => void;
  openScale: () => void;
  openWarp: () => void;
  openJuiceFx: () => void;
  openShortcuts: () => void;
  openExtractPalette: (preset?: ExtractSourcePreset) => void;
  openImportImage: () => void;
  openExport: (initialScope?: string) => void;
  openRecoverDraft: (draft: AutosaveDraft) => void;
  openPreferences: (tab?: PrefsTabId) => void;
  container: HTMLElement;
}

function openModal(dlg: HTMLDialogElement): void {
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
}

function closeModal(dlg: HTMLDialogElement, value = ''): void {
  if (typeof dlg.close === 'function') {
    if (dlg.open) dlg.close(value);
  } else {
    dlg.returnValue = value;
    dlg.removeAttribute('open');
    dlg.dispatchEvent(new Event('close'));
  }
}

export function createDialogs(ctrl: AppController): AppDialogs {
  const container = h('div', { class: 'dialogs-host' });

  // ---- New Document Dialog ----
  const newW = h('input', { id: 'dlg-new-w', class: 'num', type: 'number', min: 1, max: MAX_DIM, value: 64, autofocus: true });
  const newH = h('input', { id: 'dlg-new-h', class: 'num', type: 'number', min: 1, max: MAX_DIM, value: 64 });
  const newErr = h('p', { class: 'dlg-error', id: 'dlg-new-err' });

  const newDlg = h(
    'dialog',
    { class: 'modal', 'aria-labelledby': 'dlg-new-title' },
    h(
      'form',
      { method: 'dialog', class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-new-title' }, 'New canvas'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeModal(newDlg, 'cancel') }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        h('div', { class: 'preset-row', role: 'group', 'aria-label': 'Size presets' },
          ...PRESETS.map((sz) =>
            h('button', {
              type: 'button',
              onClick: () => {
                newW.value = String(sz);
                newH.value = String(sz);
                newErr.textContent = '';
              },
            }, `${sz}×${sz}`),
          ),
        ),
        h('div', { class: 'field-grid' },
          h('label', { for: 'dlg-new-w' }, 'Width (px)'), newW,
          h('label', { for: 'dlg-new-h' }, 'Height (px)'), newH,
        ),
        h('p', { class: 'hint' }, `Range 1–${MAX_DIM} px. Background starts transparent.`),
        newErr,
      ),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', value: 'cancel', onClick: () => closeModal(newDlg, 'cancel') }, 'Cancel'),
        h('button', { type: 'submit', value: 'confirm', class: 'primary' }, 'Create canvas'),
      ),
    ),
  );

  newDlg.addEventListener('close', () => {
    const val = newDlg.returnValue;
    newDlg.returnValue = '';
    if (val !== 'confirm') return;
    const w = Math.round(Number(newW.value));
    const hVal = Math.round(Number(newH.value));
    if (!Number.isInteger(w) || !Number.isInteger(hVal) || w < 1 || hVal < 1 || w > MAX_DIM || hVal > MAX_DIM) {
      ctrl.showToast(`Canvas size must be between 1 and ${MAX_DIM} px.`, 'error');
      return;
    }
    ctrl.newDocument(w, hVal);
  });

  // ---- Resize Canvas Dialog ----
  let selectedAnchor: Anchor9 = 'mc';
  const resW = h('input', { id: 'dlg-res-w', class: 'num', type: 'number', min: 1, max: MAX_DIM, value: 64, autofocus: true });
  const resH = h('input', { id: 'dlg-res-h', class: 'num', type: 'number', min: 1, max: MAX_DIM, value: 64 });
  const anchorBtns = ANCHORS.map((a) =>
    h('button', {
      type: 'button',
      class: 'anchor-cell',
      'aria-label': `Anchor ${a}`,
      'aria-pressed': String(a === selectedAnchor),
      onClick: () => {
        selectedAnchor = a;
        anchorBtns.forEach((b, idx) => b.setAttribute('aria-pressed', String(ANCHORS[idx] === selectedAnchor)));
      },
    }),
  );

  const resizeDlg = h(
    'dialog',
    { class: 'modal', 'aria-labelledby': 'dlg-res-title' },
    h(
      'form',
      { method: 'dialog', class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-res-title' }, 'Resize canvas'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeModal(resizeDlg, 'cancel') }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        h('div', { class: 'field-grid' },
          h('label', { for: 'dlg-res-w' }, 'Width (px)'), resW,
          h('label', { for: 'dlg-res-h' }, 'Height (px)'), resH,
        ),
        h('div', { class: 'anchor-wrap' },
          h('span', { class: 'hint' }, 'Anchor'),
          h('div', { class: 'anchor-grid', role: 'group', 'aria-label': 'Resize anchor' }, ...anchorBtns),
        ),
        h('p', { class: 'hint' }, 'Crops or pads with transparency. Undoable.'),
      ),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', value: 'cancel', onClick: () => closeModal(resizeDlg, 'cancel') }, 'Cancel'),
        h('button', { type: 'submit', value: 'confirm', class: 'primary' }, 'Resize canvas'),
      ),
    ),
  );

  resizeDlg.addEventListener('close', () => {
    const val = resizeDlg.returnValue;
    resizeDlg.returnValue = '';
    if (val !== 'confirm') return;
    ctrl.resizeCanvas(Math.round(Number(resW.value)), Math.round(Number(resH.value)), selectedAnchor);
  });

  // ---- Image Size & Upscaler Dialog (Photoshop-style) ----
  let scUnit: 'px' | '%' = 'px';
  let scOrigW = 64;
  let scOrigH = 64;
  let ratio = 1;

  const scW = h('input', { id: 'dlg-sc-w', class: 'num', type: 'number', min: 1, max: MAX_DIM, value: 64, autofocus: true });
  const scH = h('input', { id: 'dlg-sc-h', class: 'num', type: 'number', min: 1, max: MAX_DIM, value: 64 });
  const scWLabel = h('label', { for: 'dlg-sc-w' }, 'Width (px)');
  const scHLabel = h('label', { for: 'dlg-sc-h' }, 'Height (px)');
  const scLock = h('input', { id: 'dlg-sc-lock', type: 'checkbox', checked: true });
  const scAlgoSel = h(
    'select',
    { id: 'dlg-sc-algo', 'aria-label': 'Resampling algorithm' },
    ...RESAMPLE_ALGORITHMS.map((a) => h('option', { value: a.id, selected: a.id === 'nearest' }, a.label)),
  );
  const scReadout = h('p', { class: 'mono scale-summary' }, '');

  const resolveScalePx = (): { w: number; h: number } => {
    const rawW = Number(scW.value) || 1;
    const rawH = Number(scH.value) || 1;
    const pw = scUnit === '%' ? Math.round((scOrigW * rawW) / 100) : Math.round(rawW);
    const ph = scUnit === '%' ? Math.round((scOrigH * rawH) / 100) : Math.round(rawH);
    return {
      w: Math.max(1, Math.min(MAX_DIM, pw)),
      h: Math.max(1, Math.min(MAX_DIM, ph)),
    };
  };

  const syncScaleReadout = () => {
    const { w, h: hv } = resolveScalePx();
    scReadout.textContent = `${scOrigW}×${scOrigH} → ${w}×${hv} px`;
  };

  const scUnitPxBtn = h('button', {
    type: 'button',
    'aria-pressed': 'true',
    onClick: () => {
      if (scUnit === 'px') return;
      const px = resolveScalePx();
      scUnit = 'px';
      scW.max = String(MAX_DIM);
      scH.max = String(MAX_DIM);
      scW.value = String(px.w);
      scH.value = String(px.h);
      scWLabel.textContent = 'Width (px)';
      scHLabel.textContent = 'Height (px)';
      scUnitPxBtn.setAttribute('aria-pressed', 'true');
      scUnitPctBtn.setAttribute('aria-pressed', 'false');
      syncScaleReadout();
    },
  }, 'px');

  const scUnitPctBtn = h('button', {
    type: 'button',
    'aria-pressed': 'false',
    onClick: () => {
      if (scUnit === '%') return;
      const px = resolveScalePx();
      scUnit = '%';
      scW.max = '1600';
      scH.max = '1600';
      scW.value = String(Math.max(1, Math.round((px.w / Math.max(1, scOrigW)) * 100)));
      scH.value = String(Math.max(1, Math.round((px.h / Math.max(1, scOrigH)) * 100)));
      scWLabel.textContent = 'Width (%)';
      scHLabel.textContent = 'Height (%)';
      scUnitPxBtn.setAttribute('aria-pressed', 'false');
      scUnitPctBtn.setAttribute('aria-pressed', 'true');
      syncScaleReadout();
    },
  }, '%');

  scW.addEventListener('input', () => {
    if (scLock.checked && Number(scW.value) > 0) {
      if (scUnit === '%') {
        scH.value = scW.value;
      } else {
        scH.value = String(Math.max(1, Math.min(MAX_DIM, Math.round(Number(scW.value) / ratio))));
      }
    }
    syncScaleReadout();
  });
  scH.addEventListener('input', () => {
    if (scLock.checked && Number(scH.value) > 0) {
      if (scUnit === '%') {
        scW.value = scH.value;
      } else {
        scW.value = String(Math.max(1, Math.min(MAX_DIM, Math.round(Number(scH.value) * ratio))));
      }
    }
    syncScaleReadout();
  });

  const applyScalePreset = (pct: number, suggestedAlgo?: ResampleAlgorithm) => {
    const targetW = Math.max(1, Math.min(MAX_DIM, Math.round((scOrigW * pct) / 100)));
    const targetH = Math.max(1, Math.min(MAX_DIM, Math.round((scOrigH * pct) / 100)));
    if (scUnit === '%') {
      scW.value = String(pct);
      scH.value = String(pct);
    } else {
      scW.value = String(targetW);
      scH.value = String(targetH);
    }
    if (suggestedAlgo) scAlgoSel.value = suggestedAlgo;
    syncScaleReadout();
  };

  const scaleDlg = h(
    'dialog',
    { class: 'modal', 'aria-labelledby': 'dlg-sc-title' },
    h(
      'form',
      { method: 'dialog', class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-sc-title' }, 'Image size & upscaler'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeModal(scaleDlg, 'cancel') }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        h('div', { class: 'row' },
          h('span', { class: 'hint' }, 'Units'),
          h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Resize units' }, scUnitPxBtn, scUnitPctBtn),
          h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Quick scale presets' },
            h('button', { type: 'button', onClick: () => applyScalePreset(50) }, '50%'),
            h('button', { type: 'button', onClick: () => applyScalePreset(200) }, '200%'),
            h('button', { type: 'button', onClick: () => applyScalePreset(300) }, '300%'),
            h('button', { type: 'button', onClick: () => applyScalePreset(400) }, '400%'),
          ),
        ),
        h('div', { class: 'field-grid' },
          scWLabel, scW,
          scHLabel, scH,
        ),
        h('label', { class: 'check-row', for: 'dlg-sc-lock' }, scLock, 'Keep aspect ratio'),
        h('div', { class: 'row' }, h('label', { for: 'dlg-sc-algo' }, 'Resample'), scAlgoSel),
        scReadout,
        h('p', { class: 'hint' }, 'Supports pixel-art upscalers (Scale2x/3x/4x, HQ2x) and smooth filters (Bicubic, Lanczos-3). Undoable.'),
      ),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', value: 'cancel', onClick: () => closeModal(scaleDlg, 'cancel') }, 'Cancel'),
        h('button', { type: 'submit', value: 'confirm', class: 'primary' }, 'Scale canvas'),
      ),
    ),
  );

  scaleDlg.addEventListener('close', () => {
    const val = scaleDlg.returnValue;
    scaleDlg.returnValue = '';
    if (val !== 'confirm') return;
    const { w, h: hv } = resolveScalePx();
    ctrl.scaleCanvas(w, hv, scAlgoSel.value as ResampleAlgorithm);
  });

  // ---- Warp Transform Dialog (Free Quad 4-corner + Arc / Bulge / Wave / Skew / Perspective) ----
  let warpParams: WarpParams = defaultWarpParams();
  let warpSrc: Uint8ClampedArray = new Uint8ClampedArray(0);
  let warpW = 64;
  let warpH = 64;
  let warpDragCorner = -1;

  const WARP_CANVAS_SIZE = 240;
  const WARP_PAD = 24;
  const warpCanvas = h('canvas', {
    class: 'warp-canvas',
    width: WARP_CANVAS_SIZE,
    height: WARP_CANVAS_SIZE,
    'aria-label': 'Interactive warp preview',
  });
  const warpCtx = warpCanvas.getContext('2d');
  const warpOff = h('canvas', { width: 64, height: 64 });
  const warpOffCtx = warpOff.getContext('2d');

  const warpBox = () => {
    const avail = WARP_CANVAS_SIZE - WARP_PAD * 2;
    const scale = Math.min(avail / Math.max(1, warpW), avail / Math.max(1, warpH));
    const dw = warpW * scale;
    const dh = warpH * scale;
    return {
      ox: (WARP_CANVAS_SIZE - dw) / 2,
      oy: (WARP_CANVAS_SIZE - dh) / 2,
      dw,
      dh,
    };
  };

  const renderWarpPreview = () => {
    if (!warpCtx || !warpOffCtx || warpSrc.length === 0) return;
    const warped = warpCelPixels(warpSrc, warpW, warpH, warpParams, ctrl.state.selection);
    if (warpOff.width !== warpW || warpOff.height !== warpH) {
      warpOff.width = warpW;
      warpOff.height = warpH;
    }
    if (typeof ImageData !== 'undefined') {
      const copy = new Uint8ClampedArray(warped.length);
      copy.set(warped);
      warpOffCtx.putImageData(new ImageData(copy, warpW, warpH), 0, 0);
    }

    warpCtx.clearRect(0, 0, WARP_CANVAS_SIZE, WARP_CANVAS_SIZE);
    const { ox, oy, dw, dh } = warpBox();
    // Draw checker inside doc box
    warpCtx.fillStyle = '#2a2820';
    warpCtx.fillRect(ox, oy, dw, dh);
    warpCtx.imageSmoothingEnabled = false;
    warpCtx.drawImage(warpOff, ox, oy, dw, dh);

    warpCtx.strokeStyle = 'rgba(232, 228, 216, 0.25)';
    warpCtx.lineWidth = 1;
    warpCtx.strokeRect(ox + 0.5, oy + 0.5, dw - 1, dh - 1);

    if (warpParams.preset === 'quad') {
      const pts = warpParams.corners.map((c) => ({ x: ox + c.x * dw, y: oy + c.y * dh }));
      warpCtx.strokeStyle = '#c6f432';
      warpCtx.lineWidth = 1;
      warpCtx.beginPath();
      warpCtx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) warpCtx.lineTo(pts[i].x, pts[i].y);
      warpCtx.closePath();
      warpCtx.stroke();

      pts.forEach((p, idx) => {
        warpCtx.fillStyle = idx === warpDragCorner ? '#ffffff' : '#c6f432';
        warpCtx.strokeStyle = '#14130f';
        warpCtx.fillRect(Math.round(p.x) - 5, Math.round(p.y) - 5, 10, 10);
        warpCtx.strokeRect(Math.round(p.x) - 5.5, Math.round(p.y) - 5.5, 11, 11);
      });
    }
  };

  const warpEventToCanvas = (e: PointerEvent) => {
    const r = warpCanvas.getBoundingClientRect();
    return {
      cx: ((e.clientX - r.left) / Math.max(1, r.width)) * WARP_CANVAS_SIZE,
      cy: ((e.clientY - r.top) / Math.max(1, r.height)) * WARP_CANVAS_SIZE,
    };
  };

  warpCanvas.addEventListener('pointerdown', (e) => {
    if (warpParams.preset !== 'quad') return;
    const { cx, cy } = warpEventToCanvas(e);
    const { ox, oy, dw, dh } = warpBox();
    let best = -1;
    let bestD = 16;
    warpParams.corners.forEach((c, idx) => {
      const d = Math.hypot(cx - (ox + c.x * dw), cy - (oy + c.y * dh));
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    });
    if (best >= 0) {
      warpDragCorner = best;
      warpCanvas.setPointerCapture(e.pointerId);
      renderWarpPreview();
    }
  });

  warpCanvas.addEventListener('pointermove', (e) => {
    if (warpDragCorner < 0 || warpParams.preset !== 'quad') return;
    const { cx, cy } = warpEventToCanvas(e);
    const { ox, oy, dw, dh } = warpBox();
    warpParams.corners[warpDragCorner] = {
      x: Math.max(-0.5, Math.min(1.5, (cx - ox) / Math.max(1, dw))),
      y: Math.max(-0.5, Math.min(1.5, (cy - oy) / Math.max(1, dh))),
    };
    renderWarpPreview();
  });

  const endWarpDrag = () => {
    if (warpDragCorner >= 0) {
      warpDragCorner = -1;
      renderWarpPreview();
    }
  };
  warpCanvas.addEventListener('pointerup', endWarpDrag);
  warpCanvas.addEventListener('pointercancel', endWarpDrag);

  const warpStrengthCtrl = sliderField({
    id: 'warp-strength',
    label: 'Strength',
    min: -100,
    max: 100,
    value: 35,
    onInput: (v) => {
      warpParams.strength = v;
      renderWarpPreview();
    },
  });

  const warpSecCtrl = sliderField({
    id: 'warp-secondary',
    label: 'Secondary',
    min: -100,
    max: 100,
    value: 0,
    onInput: (v) => {
      warpParams.secondary = v;
      renderWarpPreview();
    },
  });

  const warpPresetSel = h(
    'select',
    {
      id: 'warp-preset',
      onChange: () => {
        warpParams.preset = warpPresetSel.value as WarpPreset;
        syncWarpControls();
        renderWarpPreview();
      },
    },
    ...WARP_PRESETS.map((p) => h('option', { value: p.id }, p.label)),
  );

  const warpHint = h('p', { class: 'hint' }, '');

  const syncWarpControls = () => {
    const isQuad = warpParams.preset === 'quad';
    warpStrengthCtrl.el.hidden = isQuad;
    warpSecCtrl.el.hidden = isQuad || warpParams.preset === 'arc' || warpParams.preset === 'bulge';
    warpHint.textContent = isQuad
      ? 'Drag the 4 lime corner handles to warp freely. Undoable.'
      : 'Adjust strength to bend or distort pixels. Honors active selection.';
  };

  const warpDlg = h(
    'dialog',
    { class: 'modal', 'aria-labelledby': 'dlg-warp-title' },
    h(
      'form',
      { method: 'dialog', class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-warp-title' }, 'Warp transform'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeModal(warpDlg, 'cancel') }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        h('div', { class: 'row' },
          h('label', { for: 'warp-preset' }, 'Preset'),
          warpPresetSel,
          h('button', {
            type: 'button',
            onClick: () => {
              const keep = warpParams.preset;
              warpParams = { ...defaultWarpParams(), preset: keep };
              warpStrengthCtrl.setValue(warpParams.strength);
              warpSecCtrl.setValue(warpParams.secondary);
              renderWarpPreview();
            },
          }, 'Reset'),
        ),
        h('div', { class: 'warp-canvas-wrap' }, warpCanvas),
        warpStrengthCtrl.el,
        warpSecCtrl.el,
        warpHint,
      ),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', value: 'cancel', onClick: () => closeModal(warpDlg, 'cancel') }, 'Cancel'),
        h('button', { type: 'submit', value: 'confirm', class: 'primary' }, 'Apply warp'),
      ),
    ),
  );

  warpDlg.addEventListener('close', () => {
    const val = warpDlg.returnValue;
    warpDlg.returnValue = '';
    if (val !== 'confirm') return;
    ctrl.applyWarp({
      preset: warpParams.preset,
      strength: warpParams.strength,
      secondary: warpParams.secondary,
      corners: [
        { ...warpParams.corners[0] },
        { ...warpParams.corners[1] },
        { ...warpParams.corners[2] },
        { ...warpParams.corners[3] },
      ],
    });
  });

  // ---- Juice FX Procedural Animator Dialog ----
  let juiceParams: JuiceParams = defaultJuiceParams('squash-bounce');
  let juiceSrc: Uint8ClampedArray = new Uint8ClampedArray(0);
  let juiceW = 64;
  let juiceH = 64;
  let juiceFrame = 0;
  let juicePlaying = true;
  let juiceRaf = 0;
  let juiceLastTick = 0;
  let juiceDragPivot = false;

  const JUICE_CANVAS_SIZE = 200;
  const JUICE_PAD = 18;
  const juiceCanvas = h('canvas', {
    class: 'warp-canvas juice-canvas',
    width: JUICE_CANVAS_SIZE,
    height: JUICE_CANVAS_SIZE,
    'aria-label': 'Live Juice FX animation preview (click or drag to move pivot)',
  });
  const juiceCtx = juiceCanvas.getContext('2d');
  const juiceOff = h('canvas', { width: 64, height: 64 });
  const juiceOffCtx = juiceOff.getContext('2d');
  const juiceFrameBadge = h('span', { class: 'mono hint' }, 'F 1/8');
  const juicePlayBtn = h('button', { type: 'button', class: 'tiny-btn' }, 'Pause');
  const juiceSubmitBtn = h('button', { type: 'submit', value: 'confirm', class: 'primary' }, 'Bake 8 frames');

  const juiceBox = () => {
    const avail = JUICE_CANVAS_SIZE - JUICE_PAD * 2;
    const scale = Math.min(avail / Math.max(1, juiceW), avail / Math.max(1, juiceH));
    const dw = juiceW * scale;
    const dh = juiceH * scale;
    return {
      ox: (JUICE_CANVAS_SIZE - dw) / 2,
      oy: (JUICE_CANVAS_SIZE - dh) / 2,
      dw,
      dh,
    };
  };

  const renderJuicePreview = () => {
    if (!juiceCtx || !juiceOffCtx || juiceSrc.length === 0) return;
    const fCount = Math.max(2, Math.min(32, Math.round(juiceParams.frames)));
    const fIdx = ((juiceFrame % fCount) + fCount) % fCount;
    const frameBuf = evalJuiceFrame(juiceSrc, juiceW, juiceH, fIdx, juiceParams, ctrl.state.selection);
    if (juiceOff.width !== juiceW || juiceOff.height !== juiceH) {
      juiceOff.width = juiceW;
      juiceOff.height = juiceH;
    }
    if (typeof ImageData !== 'undefined') {
      const copy = new Uint8ClampedArray(frameBuf.length);
      copy.set(frameBuf);
      juiceOffCtx.putImageData(new ImageData(copy, juiceW, juiceH), 0, 0);
    }

    juiceCtx.clearRect(0, 0, JUICE_CANVAS_SIZE, JUICE_CANVAS_SIZE);
    const { ox, oy, dw, dh } = juiceBox();
    juiceCtx.fillStyle = '#2a2820';
    juiceCtx.fillRect(ox, oy, dw, dh);
    juiceCtx.imageSmoothingEnabled = !juiceParams.pixelArt;
    juiceCtx.drawImage(juiceOff, ox, oy, dw, dh);
    juiceCtx.strokeStyle = 'rgba(232, 228, 216, 0.25)';
    juiceCtx.lineWidth = 1;
    juiceCtx.strokeRect(ox + 0.5, oy + 0.5, dw - 1, dh - 1);

    // Draw interactive pivot crosshair
    const px = ox + juiceParams.pivotX * dw;
    const py = oy + juiceParams.pivotY * dh;
    juiceCtx.strokeStyle = '#c6f432';
    juiceCtx.lineWidth = 1.5;
    juiceCtx.beginPath();
    juiceCtx.moveTo(px - 6, py);
    juiceCtx.lineTo(px + 6, py);
    juiceCtx.moveTo(px, py - 6);
    juiceCtx.lineTo(px, py + 6);
    juiceCtx.stroke();
    juiceCtx.fillStyle = '#14130f';
    juiceCtx.fillRect(Math.round(px) - 2, Math.round(py) - 2, 4, 4);

    juiceFrameBadge.textContent = `F ${fIdx + 1}/${fCount}`;
    juiceSubmitBtn.textContent = `Bake ${fCount} frames`;
  };

  const stopJuiceLoop = () => {
    if (juiceRaf) {
      cancelAnimationFrame(juiceRaf);
      juiceRaf = 0;
    }
  };

  const tickJuiceLoop = (now: number) => {
    if (!juiceDlg.open || !juicePlaying) {
      juiceRaf = 0;
      return;
    }
    const stepMs = 1000 / Math.max(2, juiceParams.fps);
    if (now - juiceLastTick >= stepMs) {
      juiceLastTick = now;
      juiceFrame = (juiceFrame + 1) % Math.max(2, Math.round(juiceParams.frames));
      renderJuicePreview();
    }
    juiceRaf = requestAnimationFrame(tickJuiceLoop);
  };

  const startJuiceLoop = () => {
    stopJuiceLoop();
    if (!juicePlaying || typeof requestAnimationFrame === 'undefined') return;
    juiceLastTick = performance.now();
    juiceRaf = requestAnimationFrame(tickJuiceLoop);
  };

  const setJuicePivotFromPointer = (e: PointerEvent) => {
    const r = juiceCanvas.getBoundingClientRect();
    const cx = ((e.clientX - r.left) / Math.max(1, r.width)) * JUICE_CANVAS_SIZE;
    const cy = ((e.clientY - r.top) / Math.max(1, r.height)) * JUICE_CANVAS_SIZE;
    const { ox, oy, dw, dh } = juiceBox();
    juiceParams.pivotX = Math.max(0, Math.min(1, (cx - ox) / Math.max(1, dw)));
    juiceParams.pivotY = Math.max(0, Math.min(1, (cy - oy) / Math.max(1, dh)));
    renderJuicePreview();
  };

  juiceCanvas.addEventListener('pointerdown', (e) => {
    juiceDragPivot = true;
    juiceCanvas.setPointerCapture(e.pointerId);
    setJuicePivotFromPointer(e);
  });
  juiceCanvas.addEventListener('pointermove', (e) => {
    if (!juiceDragPivot) return;
    setJuicePivotFromPointer(e);
  });
  const endJuicePivotDrag = () => { juiceDragPivot = false; };
  juiceCanvas.addEventListener('pointerup', endJuicePivotDrag);
  juiceCanvas.addEventListener('pointercancel', endJuicePivotDrag);

  juicePlayBtn.addEventListener('click', () => {
    juicePlaying = !juicePlaying;
    juicePlayBtn.textContent = juicePlaying ? 'Pause' : 'Play';
    if (juicePlaying) startJuiceLoop();
    else stopJuiceLoop();
  });

  const juiceFramesCtrl = sliderField({
    id: 'juice-frames', label: 'Frames', min: 2, max: 24, value: 8,
    onInput: (v) => { juiceParams.frames = v; renderJuicePreview(); },
  });
  const juiceFpsCtrl = sliderField({
    id: 'juice-fps', label: 'FPS', min: 2, max: 24, value: 12,
    onInput: (v) => { juiceParams.fps = v; renderJuicePreview(); },
  });
  const juiceScaleXCtrl = sliderField({
    id: 'juice-sx', label: 'Scale X %', min: 0, max: 60, value: 20,
    onInput: (v) => { juiceParams.scaleX = v; renderJuicePreview(); },
  });
  const juiceScaleYCtrl = sliderField({
    id: 'juice-sy', label: 'Scale Y %', min: 0, max: 60, value: 22,
    onInput: (v) => { juiceParams.scaleY = v; renderJuicePreview(); },
  });
  const juiceSkewCtrl = sliderField({
    id: 'juice-skew', label: 'Skew deg', min: -35, max: 35, value: 0,
    onInput: (v) => { juiceParams.skew = v; renderJuicePreview(); },
  });
  const juiceRotCtrl = sliderField({
    id: 'juice-rot', label: 'Rotate deg', min: -45, max: 45, value: 0,
    onInput: (v) => { juiceParams.rotate = v; renderJuicePreview(); },
  });
  const juiceJumpCtrl = sliderField({
    id: 'juice-jump', label: 'Jump / Bob px', min: 0, max: 20, value: 6,
    onInput: (v) => { juiceParams.jumpY = v; renderJuicePreview(); },
  });
  const juiceWaveCtrl = sliderField({
    id: 'juice-wave', label: 'Wave px', min: 0, max: 8, step: 0.5, value: 0,
    onInput: (v) => { juiceParams.waveAmp = v; renderJuicePreview(); },
  });
  const juiceShakeCtrl = sliderField({
    id: 'juice-shake', label: 'Shake px', min: 0, max: 8, value: 0,
    onInput: (v) => { juiceParams.shake = v; renderJuicePreview(); },
  });
  const juiceDampCtrl = sliderField({
    id: 'juice-damp', label: 'Damping %', min: 0, max: 100, value: 0,
    onInput: (v) => { juiceParams.damping = v; renderJuicePreview(); },
  });
  const juiceSpeedCtrl = sliderField({
    id: 'juice-speed', label: 'Cycles', min: 1, max: 4, value: 1,
    onInput: (v) => { juiceParams.speed = v; renderJuicePreview(); },
  });
  const juiceFlashCtrl = sliderField({
    id: 'juice-flash', label: 'Flash %', min: 0, max: 100, value: 0,
    onInput: (v) => { juiceParams.flashStrength = v; renderJuicePreview(); },
  });

  const juiceFlashColorIn = h('input', {
    id: 'juice-flash-col',
    type: 'color',
    class: 'grad-stop-color',
    value: '#ffffff',
    onInput: () => { juiceParams.flashColor = hexToRgba(juiceFlashColorIn.value); renderJuicePreview(); },
  });
  const juicePixelArtChk = h('input', {
    id: 'juice-pixel-art',
    type: 'checkbox',
    checked: true,
    onChange: () => { juiceParams.pixelArt = juicePixelArtChk.checked; renderJuicePreview(); },
  });
  const juiceOutlineChk = h('input', {
    id: 'juice-outline',
    type: 'checkbox',
    checked: false,
    onChange: () => { juiceParams.outline = juiceOutlineChk.checked; renderJuicePreview(); },
  });
  const juiceOutlineColorIn = h('input', {
    id: 'juice-outline-col',
    type: 'color',
    class: 'grad-stop-color',
    value: '#14130f',
    onInput: () => { juiceParams.outlineColor = hexToRgba(juiceOutlineColorIn.value); renderJuicePreview(); },
  });

  const juicePresetBtns: HTMLButtonElement[] = [];
  const syncJuiceInputs = () => {
    juiceFramesCtrl.setValue(juiceParams.frames);
    juiceFpsCtrl.setValue(juiceParams.fps);
    juiceScaleXCtrl.setValue(juiceParams.scaleX);
    juiceScaleYCtrl.setValue(juiceParams.scaleY);
    juiceSkewCtrl.setValue(juiceParams.skew);
    juiceRotCtrl.setValue(juiceParams.rotate);
    juiceJumpCtrl.setValue(juiceParams.jumpY);
    juiceWaveCtrl.setValue(juiceParams.waveAmp);
    juiceShakeCtrl.setValue(juiceParams.shake);
    juiceDampCtrl.setValue(juiceParams.damping);
    juiceSpeedCtrl.setValue(juiceParams.speed);
    juiceFlashCtrl.setValue(juiceParams.flashStrength);
    juiceFlashColorIn.value = rgbaToHex(juiceParams.flashColor);
    juicePixelArtChk.checked = juiceParams.pixelArt;
    juiceOutlineChk.checked = juiceParams.outline;
    juiceOutlineColorIn.value = rgbaToHex(juiceParams.outlineColor);
    juicePresetBtns.forEach((btn, idx) => {
      btn.setAttribute('aria-pressed', String(JUICE_PRESETS[idx].id === juiceParams.preset));
    });
  };

  const applyJuicePreset = (preset: JuicePreset) => {
    juiceParams = defaultJuiceParams(preset);
    juiceFrame = 0;
    syncJuiceInputs();
    renderJuicePreview();
  };

  for (const p of JUICE_PRESETS) {
    const btn = h('button', {
      type: 'button',
      'aria-pressed': String(p.id === juiceParams.preset),
      onClick: () => applyJuicePreset(p.id),
    }, p.label);
    juicePresetBtns.push(btn);
  }

  const juiceDlg = h(
    'dialog',
    { class: 'modal modal-wide', 'aria-labelledby': 'dlg-juice-title' },
    h(
      'form',
      { method: 'dialog', class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-juice-title' }, 'Juice FX procedural animator'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeModal(juiceDlg, 'cancel') }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        h('div', { class: 'preset-row', role: 'group', 'aria-label': 'Juice FX presets' }, ...juicePresetBtns),
        h('div', { class: 'juice-grid' },
          h('div', { class: 'juice-preview-col' },
            h('div', { class: 'warp-canvas-wrap' }, juiceCanvas),
            h('div', { class: 'row' },
              juicePlayBtn,
              h('button', { type: 'button', class: 'tiny-btn', onClick: () => { juiceFrame = (juiceFrame + 1) % Math.max(2, Math.round(juiceParams.frames)); renderJuicePreview(); } }, 'Step'),
              juiceFrameBadge,
            ),
            h('div', { class: 'row' },
              h('span', { class: 'hint' }, 'Pivot:'),
              h('button', { type: 'button', class: 'tiny-btn', onClick: () => { juiceParams.pivotX = 0.5; juiceParams.pivotY = 0.5; renderJuicePreview(); } }, 'Center'),
              h('button', { type: 'button', class: 'tiny-btn', onClick: () => { juiceParams.pivotX = 0.5; juiceParams.pivotY = 1; renderJuicePreview(); } }, 'Bottom'),
              h('button', { type: 'button', class: 'tiny-btn', onClick: () => { juiceParams.pivotX = 0.5; juiceParams.pivotY = 0; renderJuicePreview(); } }, 'Top'),
            ),
            h('label', { class: 'check-row', for: 'juice-pixel-art' }, juicePixelArtChk, 'Pixel Art crisp (uncheck = HD)'),
            h('div', { class: 'row' },
              h('label', { class: 'check-row', for: 'juice-outline' }, juiceOutlineChk, '1px Outline'),
              juiceOutlineColorIn,
            ),
            h('div', { class: 'row' },
              h('label', { for: 'juice-flash-col' }, 'Flash color'),
              juiceFlashColorIn,
            ),
          ),
          h('div', { class: 'juice-controls' },
            juiceFramesCtrl.el,
            juiceFpsCtrl.el,
            juiceScaleXCtrl.el,
            juiceScaleYCtrl.el,
            juiceSkewCtrl.el,
            juiceRotCtrl.el,
            juiceJumpCtrl.el,
            juiceWaveCtrl.el,
            juiceShakeCtrl.el,
            juiceDampCtrl.el,
            juiceSpeedCtrl.el,
            juiceFlashCtrl.el,
          ),
        ),
        h('p', { class: 'hint' }, 'Drag crosshair on preview to move pivot. Baking expands frames and adds a named animation tag (single undo step).'),
      ),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', value: 'cancel', onClick: () => closeModal(juiceDlg, 'cancel') }, 'Cancel'),
        juiceSubmitBtn,
      ),
    ),
  );

  juiceDlg.addEventListener('close', () => {
    stopJuiceLoop();
    const val = juiceDlg.returnValue;
    juiceDlg.returnValue = '';
    if (val !== 'confirm') return;
    ctrl.bakeJuiceAnimation({
      ...juiceParams,
      flashColor: [...juiceParams.flashColor],
      outlineColor: [...juiceParams.outlineColor],
    });
  });

  // ---- Extract Palette from Reference Image Dialog (F-EXTRACT) ----
  let loadedImg: DecodedImage | null = null;
  let loadedName = 'Extracted';
  let extractedColors: RGBA[] = [];
  let extractCount = 8;
  let extractMethod: QuantizeMethod = 'median-cut';
  let extractSort: PaletteSort = 'luminance';

  const exPreviewImg = h('img', { class: 'extract-preview', alt: 'Reference image preview', hidden: true });
  const exInfo = h('p', { class: 'hint' }, 'Pick, drop, or paste an image (PNG, JPEG, WebP).');
  const exSwatches = h('div', { class: 'extract-swatches', role: 'list', 'aria-label': 'Extracted swatches' });
  const exErr = h('p', { class: 'dlg-error' });

  const exCustomCount = h('input', {
    id: 'ex-count-custom',
    class: 'num',
    type: 'number',
    min: 2,
    max: 64,
    value: extractCount,
    'aria-label': 'Custom color count',
  });
  const exCountBtns = EXTRACT_COUNTS.map((n) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(n === extractCount),
      onClick: () => {
        extractCount = n;
        exCustomCount.value = String(n);
        syncCountBtns();
        runExtract();
      },
    }, `${n} colors`),
  );
  const syncCountBtns = () => {
    exCountBtns.forEach((b, idx) => b.setAttribute('aria-pressed', String(EXTRACT_COUNTS[idx] === extractCount)));
  };
  exCustomCount.addEventListener('input', () => {
    const v = Math.round(Number(exCustomCount.value));
    if (v >= 2 && v <= 64) {
      extractCount = v;
      syncCountBtns();
      runExtract();
    }
  });

  const exMethodSel = h('select', {
    id: 'ex-method',
    onChange: () => {
      extractMethod = exMethodSel.value as QuantizeMethod;
      runExtract();
    },
  },
    h('option', { value: 'median-cut', selected: true }, 'Median cut'),
    h('option', { value: 'kmeans-oklab' }, 'K-means (OKLab)'),
    h('option', { value: 'most-frequent' }, 'Most frequent'),
  );

  const exSortSel = h('select', {
    id: 'ex-sort',
    onChange: () => {
      extractSort = exSortSel.value as PaletteSort;
      runExtract();
    },
  },
    h('option', { value: 'luminance', selected: true }, 'Luminance'),
    h('option', { value: 'hue' }, 'Hue'),
  );

  const exIgnoreExtremes = h('input', { id: 'ex-extremes', type: 'checkbox', onChange: () => runExtract() });
  const exDither = h('input', { id: 'ex-dither', type: 'checkbox' });

  const exReplaceBtn = h('button', {
    type: 'button',
    disabled: true,
    onClick: () => {
      if (extractedColors.length === 0) return;
      ctrl.execute(replacePaletteColorsCommand(ctrl.getActivePalette().id, extractedColors, 'Replace palette from image'));
      ctrl.showToast(`Replaced palette with ${extractedColors.length} colors.`, 'info');
      closeModal(extractDlg);
    },
  }, 'Replace palette');

  const exAppendBtn = h('button', {
    type: 'button',
    disabled: true,
    onClick: () => {
      if (extractedColors.length === 0) return;
      ctrl.execute(appendPaletteColorsCommand(ctrl.getActivePalette().id, extractedColors, 'Append palette from image'));
      ctrl.showToast(`Appended ${extractedColors.length} colors to palette.`, 'info');
      closeModal(extractDlg);
    },
  }, 'Append');

  const exNewBtn = h('button', {
    type: 'button',
    class: 'primary',
    disabled: true,
    onClick: () => {
      if (extractedColors.length === 0) return;
      ctrl.execute(addPaletteCommand(`${loadedName} (${extractedColors.length})`, extractedColors));
      ctrl.showToast(`Created palette with ${extractedColors.length} colors.`, 'info');
      closeModal(extractDlg);
    },
  }, 'New palette');

  const exRecolorBtn = h('button', {
    type: 'button',
    disabled: true,
    onClick: () => {
      if (extractedColors.length === 0) return;
      ctrl.recolorCanvasToPalette(extractedColors, exDither.checked);
      closeModal(extractDlg);
    },
  }, 'Recolor canvas');

  const runExtract = () => {
    exErr.textContent = '';
    if (!loadedImg) {
      extractedColors = [];
      exSwatches.replaceChildren();
      exReplaceBtn.disabled = true;
      exAppendBtn.disabled = true;
      exNewBtn.disabled = true;
      exRecolorBtn.disabled = true;
      return;
    }
    const res = extractPalette(loadedImg.pixels, loadedImg.w, loadedImg.h, {
      count: extractCount,
      method: extractMethod,
      ignoreTransparent: true,
      ignoreNearExtremes: exIgnoreExtremes.checked,
      sortBy: extractSort,
    });
    extractedColors = res.colors;
    const has = extractedColors.length > 0;
    exReplaceBtn.disabled = !has;
    exAppendBtn.disabled = !has;
    exNewBtn.disabled = !has;
    exRecolorBtn.disabled = !has;

    if (res.uniqueCount < extractCount) {
      exInfo.textContent = `${loadedImg.w}×${loadedImg.h} — Image only has ${res.uniqueCount} colors`;
    } else {
      exInfo.textContent = `${loadedImg.w}×${loadedImg.h} — ${res.colors.length} colors extracted`;
    }

    exSwatches.replaceChildren(
      ...res.colors.map((c, idx) => {
        const hex = rgbaToHex(c);
        const pct = `${Math.round(res.coverages[idx])}%`;
        return h('div', { class: 'ex-swatch', role: 'listitem', title: `${hex} (${pct})` },
          h('span', { class: 'ex-chip', style: `background:${hex}` }),
          h('span', { class: 'mono' }, pct),
        );
      }),
    );
  };

  const loadExtractBlob = async (blob: Blob, name = 'Image') => {
    exErr.textContent = '';
    try {
      loadedImg = await decodeImageBlob(blob);
      loadedName = name.replace(/\.[^.]+$/, '') || 'Image';
      exPreviewImg.src = loadedImg.dataUrl;
      exPreviewImg.hidden = false;
      runExtract();
    } catch (err) {
      exErr.textContent = err instanceof Error ? err.message : 'Failed to decode image.';
    }
  };

  const exFileInput = h('input', {
    id: 'ex-file',
    type: 'file',
    accept: 'image/*',
    class: 'visually-hidden',
    onChange: () => {
      const f = exFileInput.files?.[0];
      if (f) void loadExtractBlob(f, f.name);
      exFileInput.value = '';
    },
  });

  const loadExtractPreset = (src: ExtractSourcePreset) => {
    exErr.textContent = '';
    loadedImg = { w: src.w, h: src.h, pixels: src.pixels, dataUrl: src.dataUrl };
    loadedName = src.name;
    exPreviewImg.src = src.dataUrl;
    exPreviewImg.hidden = false;
    runExtract();
  };

  const loadExtractFromRef = () => {
    const active = ctrl.getActiveLayer();
    const refLayer = active.kind === 'reference' && active.ref
      ? active
      : ctrl.state.doc.layers.find((l) => l.kind === 'reference' && l.ref);
    if (!refLayer?.ref) {
      exErr.textContent = 'No reference image layer in project. Choose or drop an image first.';
      return;
    }
    loadExtractPreset({
      pixels: refLayer.ref.pixels,
      w: refLayer.ref.w,
      h: refLayer.ref.h,
      dataUrl: refLayer.ref.dataUrl,
      name: refLayer.name,
    });
  };

  const loadExtractFromCanvas = () => {
    const s = ctrl.state;
    const composed = ctrl.getComposed(s.activeFrame);
    const png = encodePngRgba(composed, s.doc.w, s.doc.h);
    loadExtractPreset({
      pixels: composed,
      w: s.doc.w,
      h: s.doc.h,
      dataUrl: bytesToDataUrl(png),
      name: 'Canvas',
    });
  };

  const exDrop = h(
    'div',
    {
      class: 'dropzone',
      onDragover: (e: DragEvent) => { e.preventDefault(); exDrop.classList.add('over'); },
      onDragleave: () => exDrop.classList.remove('over'),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        exDrop.classList.remove('over');
        const f = e.dataTransfer?.files?.[0];
        if (f) void loadExtractBlob(f, f.name);
      },
    },
    exPreviewImg,
    h('div', { class: 'action-bar' },
      h('button', { type: 'button', autofocus: true, onClick: () => exFileInput.click() }, icon('upload', 14), ' Choose image'),
      h('button', { type: 'button', onClick: loadExtractFromRef }, icon('image', 14), ' From reference'),
      h('button', { type: 'button', onClick: loadExtractFromCanvas }, 'From canvas'),
    ),
    exFileInput,
    exInfo,
  );

  const extractDlg = h(
    'dialog',
    { class: 'modal modal-wide', 'aria-labelledby': 'dlg-extract-title' },
    h(
      'div',
      { class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-extract-title' }, 'Generate palette from image'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeModal(extractDlg) }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        exDrop,
        h('div', { class: 'row' },
          h('span', { class: 'hint' }, 'Colors'),
          h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Color count presets' }, ...exCountBtns),
          h('label', { for: 'ex-count-custom', class: 'hint' }, 'Custom'),
          exCustomCount,
        ),
        h('div', { class: 'row' },
          h('label', { for: 'ex-method' }, 'Method'), exMethodSel,
          h('label', { for: 'ex-sort' }, 'Sort'), exSortSel,
        ),
        h('div', { class: 'row' },
          h('label', { class: 'check-row', for: 'ex-extremes' }, exIgnoreExtremes, 'Ignore near-white / near-black'),
          h('label', { class: 'check-row', for: 'ex-dither' }, exDither, 'Bayer dither on recolor'),
        ),
        exSwatches,
        exErr,
      ),
      h('footer', { class: 'modal-foot modal-foot-wrap' },
        h('button', { type: 'button', onClick: () => closeModal(extractDlg) }, 'Cancel'),
        exRecolorBtn,
        exAppendBtn,
        exReplaceBtn,
        exNewBtn,
      ),
    ),
  );

  extractDlg.addEventListener('paste', (e: ClipboardEvent) => {
    const item = Array.from(e.clipboardData?.items ?? []).find((it) => it.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) {
      e.preventDefault();
      void loadExtractBlob(file, 'Pasted');
    }
  });
  extractDlg.addEventListener('close', () => {
    extractDlg.returnValue = '';
  });

  // ---- Keyboard Shortcuts Dialog ----
  const groups = ['Tools', 'View', 'Selection & Edit', 'Layers', 'Animation', 'Document'] as const;
  const shortcutsDlg = h(
    'dialog',
    { class: 'modal modal-wide', 'aria-labelledby': 'dlg-keys-title' },
    h(
      'div',
      { class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-keys-title' }, 'Keyboard shortcuts'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', autofocus: true, onClick: () => closeModal(shortcutsDlg) }, icon('x')),
      ),
      h('div', { class: 'modal-body shortcuts-grid' },
        ...groups.map((grp) =>
          h('section', { class: 'shortcut-group' },
            h('h2', {}, grp),
            h('table', { class: 'shortcut-table' },
              h('caption', { class: 'visually-hidden' }, `${grp} keyboard shortcuts`),
              h('thead', {},
                h('tr', {}, h('th', { scope: 'col' }, 'Key'), h('th', { scope: 'col' }, 'Action')),
              ),
              h('tbody', {},
                ...SHORTCUT_LIST.filter((e) => e.group === grp).map((e) =>
                  h('tr', {}, h('td', { class: 'mono key-col' }, e.keys), h('td', {}, e.label)),
                ),
              ),
            ),
          ),
        ),
      ),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'primary', onClick: () => closeModal(shortcutsDlg) }, 'Close'),
      ),
    ),
  );

  shortcutsDlg.addEventListener('close', () => {
    shortcutsDlg.returnValue = '';
  });

  // ---- Export Dialog (PNG | BMP | PSD | GIF | Spritesheet | Zip | JavaScript) ----
  const EXP_SCALES = [1, 2, 4, 8];
  let expFormat: ExportFormat = 'png';
  let expScale = 1;
  let expAlgo: ResampleAlgorithm = 'nearest';
  let expJsMode: JsExportMode = 'canvas2d';

  const expFormatSel = h(
    'select',
    {
      id: 'exp-format',
      onChange: () => {
        expFormat = expFormatSel.value as ExportFormat;
        syncExportUi();
      },
    },
    h('option', { value: 'png', selected: true }, 'PNG (single frame)'),
    h('option', { value: 'bmp' }, 'BMP (32-bit BGRA)'),
    h('option', { value: 'psd' }, 'Photoshop (.psd, layered)'),
    h('option', { value: 'gif' }, 'Animated GIF'),
    h('option', { value: 'sheet' }, 'Spritesheet PNG + JSON atlas'),
    h('option', { value: 'sequence' }, 'PNG sequence (.zip)'),
    h('option', { value: 'js' }, 'JavaScript module (.js)'),
  );

  const expScopeSel = h('select', {
    id: 'exp-scope',
    onChange: () => syncExportUi(),
  });

  const expAlgoSel = h(
    'select',
    {
      id: 'exp-algo',
      'aria-label': 'Export upscaler algorithm',
      onChange: () => {
        expAlgo = expAlgoSel.value as ResampleAlgorithm;
        syncExportUi();
      },
    },
    ...RESAMPLE_ALGORITHMS.map((a) => h('option', { value: a.id, selected: a.id === 'nearest' }, a.label)),
  );
  const expAlgoRow = h('div', { class: 'row' }, h('label', { for: 'exp-algo' }, 'Upscaler'), expAlgoSel);

  const expScaleIn = h('input', {
    id: 'exp-scale',
    class: 'num',
    type: 'number',
    min: 1,
    max: 16,
    value: 1,
    'aria-label': 'Export scale multiplier',
  });

  const expScaleBtns = EXP_SCALES.map((sc) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(sc === expScale),
        onClick: () => {
          expScale = sc;
          expScaleIn.value = String(sc);
          syncExportUi();
        },
      },
      `${sc}×`,
    ),
  );
  const expScaleRow = h('div', { class: 'row' },
    h('label', { for: 'exp-scale' }, 'Scale'),
    h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Scale presets' }, ...expScaleBtns),
    expScaleIn,
  );

  expScaleIn.addEventListener('input', () => {
    const v = Math.round(Number(expScaleIn.value));
    if (v >= 1 && v <= 16) {
      expScale = v;
      syncExportUi();
    }
  });

  const expPadIn = h('input', {
    id: 'exp-pad',
    class: 'num',
    type: 'number',
    min: 0,
    max: 64,
    value: 0,
    onInput: () => syncExportUi(),
  });
  const expPadRow = h('div', { class: 'row' }, h('label', { for: 'exp-pad' }, 'Padding'), expPadIn, h('span', { class: 'hint' }, 'px between frames'));

  const expLoopBox = h('input', { id: 'exp-loop', type: 'checkbox', checked: true });
  const expLoopRow = h('label', { class: 'check-row', for: 'exp-loop' }, expLoopBox, 'Loop GIF forever');

  const expJsModeSel = h(
    'select',
    {
      id: 'exp-js-mode',
      onChange: () => {
        expJsMode = expJsModeSel.value as JsExportMode;
        syncExportUi();
      },
    },
    h('option', { value: 'canvas2d', selected: true }, 'Canvas 2D pixel renderer'),
    h('option', { value: 'dataurl' }, 'Base64 PNG Data URL'),
    h('option', { value: 'rgba' }, 'Raw RGBA Uint8ClampedArray'),
  );
  const expJsVarIn = h('input', {
    id: 'exp-js-var',
    type: 'text',
    class: 'mono',
    value: 'sprite',
    onInput: () => syncExportUi(),
  });
  const expJsPreview = h('textarea', {
    id: 'exp-js-preview',
    class: 'mono js-preview',
    readonly: true,
    rows: 6,
    'aria-label': 'Generated JavaScript code preview',
  });
  const expJsCopyBtn = h('button', {
    type: 'button',
    onClick: async () => {
      const code = buildCurrentJsCode();
      try {
        await navigator.clipboard?.writeText(code);
        ctrl.showToast('Copied JavaScript code to clipboard.', 'info');
      } catch {
        expJsPreview.select();
        ctrl.showToast('Select and copy code from the preview box.', 'info');
      }
    },
  }, icon('copy', 14), ' Copy JS');

  const expJsWrap = h('div', { class: 'js-export-wrap', hidden: true },
    h('div', { class: 'row' }, h('label', { for: 'exp-js-mode' }, 'JS output'), expJsModeSel),
    h('div', { class: 'row' }, h('label', { for: 'exp-js-var' }, 'Export name'), expJsVarIn, expJsCopyBtn),
    expJsPreview,
  );

  const expHiddenBox = h('input', { id: 'exp-hidden', type: 'checkbox', onChange: () => syncExportUi() });
  const expHiddenRow = h('label', { class: 'check-row', for: 'exp-hidden' }, expHiddenBox, 'Include hidden layers');
  const expSummary = h('p', { class: 'mono export-summary' }, '');
  const expErr = h('p', { class: 'dlg-error' });

  const buildCurrentJsCode = (): string => {
    const s = ctrl.state;
    const scope = expScopeSel.value || 'active';
    const resolved = resolveExportFrames(s.doc, scope, s.activeFrame);
    return exportJsCode(s.doc, resolved.frames, {
      scale: expScale,
      algorithm: expAlgo,
      includeHidden: expHiddenBox.checked,
      jsMode: expJsMode,
      jsVarName: expJsVarIn.value || 'sprite',
    });
  };

  const populateExportScope = () => {
    const s = ctrl.state;
    const prev = expScopeSel.value;
    const opts: HTMLElement[] = [
      h('option', { value: 'active' }, `Active frame (F${s.activeFrame + 1})`),
      h('option', { value: 'all' }, `All frames (${s.doc.frames.length})`),
      ...s.doc.animations.map((a) =>
        h('option', { value: a.id }, `Anim: ${a.name} (F${a.from + 1}–F${a.to + 1})`),
      ),
    ];
    expScopeSel.replaceChildren(...opts);
    if (prev && Array.from(expScopeSel.options).some((o) => o.value === prev)) {
      expScopeSel.value = prev;
    } else {
      expScopeSel.value = expFormat === 'png' || expFormat === 'bmp' || expFormat === 'psd' ? 'active' : 'all';
    }
  };

  const syncExportUi = () => {
    const s = ctrl.state;
    expErr.textContent = '';
    const isSingle = expFormat === 'png' || expFormat === 'bmp' || expFormat === 'psd';
    const isPsd = expFormat === 'psd';
    expScaleBtns.forEach((b, idx) => b.setAttribute('aria-pressed', String(EXP_SCALES[idx] === expScale)));
    expScaleRow.hidden = isPsd;
    expAlgoRow.hidden = isPsd;
    expHiddenRow.hidden = isPsd;
    expPadRow.hidden = expFormat !== 'sheet';
    expLoopRow.hidden = expFormat !== 'gif';
    expJsWrap.hidden = expFormat !== 'js';

    if (isSingle && expScopeSel.value !== 'active') {
      expScopeSel.value = 'active';
    } else if (!isSingle && expFormat !== 'js' && expScopeSel.value === 'active' && s.doc.frames.length > 1) {
      expScopeSel.value = 'all';
    }

    const scope = isSingle ? 'active' : expScopeSel.value || 'all';
    const resolved = resolveExportFrames(s.doc, scope, s.activeFrame);
    const pad = Math.max(0, Math.min(64, Math.round(Number(expPadIn.value) || 0)));
    const fw = s.doc.w * expScale;
    const fh = s.doc.h * expScale;

    if (expFormat === 'sheet') {
      const totalW = resolved.frames.length * fw + Math.max(0, resolved.frames.length - 1) * pad;
      expSummary.textContent = `Output: ${totalW}×${fh} px · ${resolved.frames.length} frames + JSON atlas`;
    } else if (expFormat === 'png') {
      expSummary.textContent = `Output: ${fw}×${fh} px · PNG (${expAlgo})`;
    } else if (expFormat === 'bmp') {
      expSummary.textContent = `Output: ${fw}×${fh} px · 32-bit BGRA BMP (${expAlgo})`;
    } else if (expFormat === 'psd') {
      const pCount = s.doc.layers.filter((l) => l.kind === 'pixel').length;
      expSummary.textContent = `Output: ${s.doc.w}×${s.doc.h} px · ${pCount} layers · Adobe PSD`;
    } else if (expFormat === 'gif') {
      expSummary.textContent = `Output: ${fw}×${fh} px · ${resolved.frames.length} frames · GIF`;
    } else if (expFormat === 'js') {
      expSummary.textContent = `Output: ${fw}×${fh} px · ${resolved.frames.length} frame(s) · ES Module (.js)`;
      try {
        const previewCode = buildCurrentJsCode();
        expJsPreview.value = previewCode.length > 4000 ? `${previewCode.slice(0, 4000)}\n// … (${previewCode.length} chars total)` : previewCode;
      } catch {
        expJsPreview.value = '';
      }
    } else {
      expSummary.textContent = `Output: ${fw}×${fh} px · ${resolved.frames.length} PNGs (.zip)`;
    }
  };

  const exportDlg = h(
    'dialog',
    { class: 'modal modal-wide', 'aria-labelledby': 'dlg-exp-title' },
    h(
      'form',
      { method: 'dialog', class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-exp-title' }, 'Export'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeModal(exportDlg, 'cancel') }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        h('div', { class: 'row' }, h('label', { for: 'exp-format' }, 'Format'), expFormatSel),
        h('div', { class: 'row' }, h('label', { for: 'exp-scope' }, 'Frames'), expScopeSel),
        expScaleRow,
        expAlgoRow,
        expPadRow,
        expLoopRow,
        expHiddenRow,
        expJsWrap,
        expSummary,
        h('p', { class: 'hint' }, 'Modifiers are baked for raster exports; PSD preserves editable pixel layers, opacity, clipping, and blend modes.'),
        expErr,
      ),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', value: 'cancel', onClick: () => closeModal(exportDlg, 'cancel') }, 'Cancel'),
        h('button', { type: 'submit', value: 'confirm', class: 'primary', autofocus: true }, 'Export'),
      ),
    ),
  );

  exportDlg.addEventListener('close', () => {
    const val = exportDlg.returnValue;
    exportDlg.returnValue = '';
    if (val !== 'confirm') return;
    try {
      const s = ctrl.state;
      const scale = Math.max(1, Math.min(16, Math.round(Number(expScaleIn.value) || 1)));
      const includeHidden = expHiddenBox.checked;
      const pad = Math.max(0, Math.min(64, Math.round(Number(expPadIn.value) || 0)));
      const isSingle = expFormat === 'png' || expFormat === 'bmp' || expFormat === 'psd';
      const scope = isSingle ? 'active' : expScopeSel.value || 'all';
      const resolved = resolveExportFrames(s.doc, scope, s.activeFrame);

      if (expFormat === 'png') {
        const png = exportSinglePngBytes(s.doc, resolved.frames[0], { scale, algorithm: expAlgo, includeHidden });
        triggerDownload(png, 'image/png', `tintbox_f${resolved.frames[0] + 1}_${scale}x.png`);
        ctrl.showToast(`Exported PNG (${s.doc.w * scale}×${s.doc.h * scale}).`, 'info');
      } else if (expFormat === 'bmp') {
        const bmp = exportBmpBytes(s.doc, resolved.frames[0], { scale, algorithm: expAlgo, includeHidden });
        triggerDownload(bmp, 'image/bmp', `tintbox_f${resolved.frames[0] + 1}_${scale}x.bmp`);
        ctrl.showToast(`Exported 32-bit BMP (${s.doc.w * scale}×${s.doc.h * scale}).`, 'info');
      } else if (expFormat === 'psd') {
        const psd = exportPsdBytes(s.doc, resolved.frames[0]);
        triggerDownload(psd, 'image/vnd.adobe.photoshop', `tintbox_f${resolved.frames[0] + 1}.psd`);
        ctrl.showToast(`Exported layered Photoshop PSD (${s.doc.w}×${s.doc.h}).`, 'info');
      } else if (expFormat === 'gif') {
        const gif = exportGifBytes(s.doc, resolved.frames, { scale, algorithm: expAlgo, includeHidden, loop: expLoopBox.checked });
        triggerDownload(gif, 'image/gif', `tintbox_${scale}x.gif`);
        ctrl.showToast(`Exported GIF (${resolved.frames.length} frames).`, 'info');
      } else if (expFormat === 'sheet') {
        const bundle = exportSpritesheetBundle(s.doc, resolved.frames, { scale, algorithm: expAlgo, includeHidden, padding: pad });
        triggerDownload(bundle.png, 'image/png', `tintbox_sheet_${scale}x.png`);
        triggerDownload(bundle.json, 'application/json', `tintbox_sheet_${scale}x.json`);
        ctrl.showToast(`Exported spritesheet + JSON (${bundle.w}×${bundle.h}).`, 'info');
      } else if (expFormat === 'js') {
        const code = buildCurrentJsCode();
        const safeName = (expJsVarIn.value || 'sprite').replace(/[^a-zA-Z0-9_-]/g, '_') || 'sprite';
        triggerDownload(code, 'text/javascript;charset=utf-8', `${safeName}.js`);
        ctrl.showToast(`Exported JavaScript module (${safeName}.js).`, 'info');
      } else {
        const zip = exportPngSequenceZip(s.doc, resolved.frames, { scale, algorithm: expAlgo, includeHidden });
        triggerDownload(zip, 'application/zip', `tintbox_frames_${scale}x.zip`);
        ctrl.showToast(`Exported ${resolved.frames.length} PNG frames (.zip).`, 'info');
      }
    } catch (err) {
      ctrl.showToast(err instanceof Error ? err.message : 'Export failed.', 'error');
    }
  });

  // ---- Autosave Draft Recovery Dialog (P4) ----
  let pendingDraft: AutosaveDraft | null = null;
  const recoverTimeEl = h('p', { class: 'hint' }, '');
  const recoverDlg = h(
    'dialog',
    { class: 'modal', 'aria-labelledby': 'dlg-recover-title' },
    h(
      'form',
      { method: 'dialog', class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-recover-title' }, 'Recover unsaved draft?'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeModal(recoverDlg, 'cancel') }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        h('p', {}, 'An autosaved draft was found in this browser.'),
        recoverTimeEl,
      ),
      h('footer', { class: 'modal-foot' },
        h('button', { type: 'button', value: 'discard', onClick: () => closeModal(recoverDlg, 'discard') }, 'Discard'),
        h('button', { type: 'submit', value: 'recover', class: 'primary', autofocus: true }, 'Recover draft'),
      ),
    ),
  );

  recoverDlg.addEventListener('close', () => {
    const val = recoverDlg.returnValue;
    recoverDlg.returnValue = '';
    const draft = pendingDraft;
    pendingDraft = null;
    if (val === 'recover' && draft) {
      ctrl.recoverAutosave(draft);
    } else if (val === 'discard') {
      void ctrl.discardAutosave();
    }
  });

  // ---- Unified Import Image Dialog (Reference layer / Pixel layer / New canvas / Extract 4-8-16) ----
  let impBlob: Blob | null = null;
  let impDecoded: DecodedImage | null = null;
  let impName = 'Imported';

  const impPreview = h('img', { class: 'extract-preview', alt: 'Image import preview', hidden: true });
  const impInfo = h('p', { class: 'hint' }, 'Choose, drop, or paste any PNG, JPEG, or WebP image.');
  const impErr = h('p', { class: 'dlg-error' });

  const impRefBtn = h('button', {
    type: 'button',
    class: 'primary',
    disabled: true,
    onClick: async () => {
      if (!impBlob) return;
      await ctrl.importReferenceBlob(impBlob, impName);
      closeModal(importDlg);
    },
  }, 'Add as reference layer');

  const impLayerBtn = h('button', {
    type: 'button',
    disabled: true,
    onClick: async () => {
      if (!impBlob) return;
      await ctrl.importImageAsPixelLayer(impBlob, impName);
      closeModal(importDlg);
    },
  }, 'Import as pixel layer');

  const impCanvasBtn = h('button', {
    type: 'button',
    disabled: true,
    onClick: async () => {
      if (!impBlob) return;
      await ctrl.openImageAsCanvas(impBlob, impName);
      closeModal(importDlg);
    },
  }, 'Open as canvas');

  const impExtractBtn = h('button', {
    type: 'button',
    disabled: true,
    onClick: () => {
      if (!impDecoded) return;
      const preset: ExtractSourcePreset = {
        pixels: impDecoded.pixels,
        w: impDecoded.w,
        h: impDecoded.h,
        dataUrl: impDecoded.dataUrl,
        name: impName,
      };
      closeModal(importDlg);
      loadExtractPreset(preset);
      openModal(extractDlg);
    },
  }, icon('sparkles', 14), ' Extract 4/8/16 palette');

  const loadImportFile = async (blob: Blob, name = 'Image') => {
    impErr.textContent = '';
    try {
      const dec = await decodeImageBlob(blob);
      impBlob = blob;
      impDecoded = dec;
      impName = name.replace(/\.[^.]+$/, '') || 'Image';
      impPreview.src = dec.dataUrl;
      impPreview.hidden = false;
      impInfo.textContent = `${impName} — ${dec.w}×${dec.h} px`;
      impRefBtn.disabled = false;
      impLayerBtn.disabled = false;
      impCanvasBtn.disabled = false;
      impExtractBtn.disabled = false;
    } catch (err) {
      impErr.textContent = err instanceof Error ? err.message : 'Failed to decode image.';
    }
  };

  const impFileIn = h('input', {
    id: 'imp-file',
    type: 'file',
    accept: 'image/*',
    class: 'visually-hidden',
    onChange: () => {
      const f = impFileIn.files?.[0];
      if (f) void loadImportFile(f, f.name);
      impFileIn.value = '';
    },
  });

  const impDrop = h(
    'div',
    {
      class: 'dropzone',
      onDragover: (e: DragEvent) => { e.preventDefault(); impDrop.classList.add('over'); },
      onDragleave: () => impDrop.classList.remove('over'),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        impDrop.classList.remove('over');
        const f = e.dataTransfer?.files?.[0];
        if (f) void loadImportFile(f, f.name);
      },
    },
    impPreview,
    h('button', { type: 'button', autofocus: true, onClick: () => impFileIn.click() }, icon('upload', 14), ' Choose image'),
    impFileIn,
    impInfo,
  );

  const importDlg = h(
    'dialog',
    { class: 'modal modal-wide', 'aria-labelledby': 'dlg-imp-title' },
    h(
      'div',
      { class: 'modal-form' },
      h('header', { class: 'modal-head' },
        h('h1', { id: 'dlg-imp-title' }, 'Import image'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeModal(importDlg) }, icon('x')),
      ),
      h('div', { class: 'modal-body' },
        impDrop,
        h('p', { class: 'hint' }, 'Reference layers stay crisp and are excluded from exports. Pixel layers can be painted, blended, and clipped like Photoshop.'),
        impErr,
      ),
      h('footer', { class: 'modal-foot modal-foot-wrap' },
        h('button', { type: 'button', onClick: () => closeModal(importDlg) }, 'Cancel'),
        impExtractBtn,
        impCanvasBtn,
        impLayerBtn,
        impRefBtn,
      ),
    ),
  );

  importDlg.addEventListener('paste', (e: ClipboardEvent) => {
    const item = Array.from(e.clipboardData?.items ?? []).find((it) => it.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) {
      e.preventDefault();
      void loadImportFile(file, 'Pasted');
    }
  });
  importDlg.addEventListener('close', () => {
    importDlg.returnValue = '';
  });

  const prefsDlg = createPreferencesDialog(ctrl);
  container.append(newDlg, resizeDlg, scaleDlg, warpDlg, juiceDlg, extractDlg, importDlg, shortcutsDlg, exportDlg, recoverDlg, prefsDlg.el);

  return {
    container,
    openNew() {
      const defSz = ctrl.state.appPrefs.defaultCanvasSize;
      newW.value = String(defSz);
      newH.value = String(defSz);
      newErr.textContent = '';
      openModal(newDlg);
    },
    openResize() {
      const { doc } = ctrl.state;
      resW.value = String(doc.w);
      resH.value = String(doc.h);
      openModal(resizeDlg);
    },
    openScale() {
      const { doc } = ctrl.state;
      scOrigW = doc.w;
      scOrigH = doc.h;
      ratio = doc.w / Math.max(1, doc.h);
      scUnit = 'px';
      scW.max = String(MAX_DIM);
      scH.max = String(MAX_DIM);
      scW.value = String(doc.w);
      scH.value = String(doc.h);
      scWLabel.textContent = 'Width (px)';
      scHLabel.textContent = 'Height (px)';
      scUnitPxBtn.setAttribute('aria-pressed', 'true');
      scUnitPctBtn.setAttribute('aria-pressed', 'false');
      syncScaleReadout();
      openModal(scaleDlg);
    },
    openWarp() {
      const layer = ctrl.ensureEditableLayer();
      if (!layer) return;
      const { doc } = ctrl.state;
      warpW = doc.w;
      warpH = doc.h;
      warpSrc = ctrl.getActiveCel().slice();
      warpParams = defaultWarpParams();
      warpPresetSel.value = 'quad';
      warpStrengthCtrl.setValue(warpParams.strength);
      warpSecCtrl.setValue(warpParams.secondary);
      syncWarpControls();
      openModal(warpDlg);
      renderWarpPreview();
    },
    openJuiceFx() {
      const layer = ctrl.ensureEditableLayer();
      if (!layer) return;
      const { doc } = ctrl.state;
      juiceW = doc.w;
      juiceH = doc.h;
      juiceSrc = ctrl.getActiveCel().slice();
      juiceParams = defaultJuiceParams('squash-bounce');
      juiceFrame = 0;
      juicePlaying = true;
      juicePlayBtn.textContent = 'Pause';
      syncJuiceInputs();
      openModal(juiceDlg);
      renderJuicePreview();
      startJuiceLoop();
    },
    openShortcuts() {
      openModal(shortcutsDlg);
    },
    openExtractPalette(preset?: ExtractSourcePreset) {
      exErr.textContent = '';
      if (preset) loadExtractPreset(preset);
      openModal(extractDlg);
    },
    openImportImage() {
      impErr.textContent = '';
      openModal(importDlg);
    },
    openExport(initialScope?: string) {
      populateExportScope();
      const ap = ctrl.state.appPrefs;
      if (initialScope && Array.from(expScopeSel.options).some((o) => o.value === initialScope)) {
        if (expFormat === 'png') {
          expFormat = 'sheet';
          expFormatSel.value = 'sheet';
        }
        expScopeSel.value = initialScope;
      } else {
        expFormat = ap.defaultExportFormat;
        expFormatSel.value = ap.defaultExportFormat;
        expScale = ap.defaultExportScale;
        expScaleIn.value = String(ap.defaultExportScale);
      }
      syncExportUi();
      openModal(exportDlg);
    },
    openRecoverDraft(draft: AutosaveDraft) {
      pendingDraft = draft;
      recoverTimeEl.textContent = `Saved ${new Date(draft.savedAt).toLocaleString()}.`;
      openModal(recoverDlg);
    },
    openPreferences(tab?: PrefsTabId) {
      prefsDlg.open(tab);
    },
  };
}
