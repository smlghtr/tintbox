import { composeTileMapRgba, mapFloodFill, mapRectCells, packMapCell, resolveTilePixels, transformTilePixels, unpackMapCell } from '../core/tiles';
import type { Pt } from '../core/types';
import { exportTileMapJson, exportTilesetAtlasPngBytes, triggerDownload } from '../io/export-pack';
import {
  addMapLayerCommand,
  removeMapLayerCommand,
  resizeTileMapCommand,
  setMapLayerDataCommand,
  toggleMapLayerVisibleCommand,
} from '../state/commands';
import type { MapToolId } from '../state/ui';
import type { AppController } from './controller';
import { h, wireToolbarFocusgroup } from './dom';
import { icon } from './icons';

export interface MapStageApi {
  el: HTMLElement;
  destroy: () => void;
}

const MAP_TOOLS: { id: MapToolId; label: string }[] = [
  { id: 'brush', label: 'Brush' },
  { id: 'rect', label: 'Rect' },
  { id: 'fill', label: 'Fill' },
  { id: 'eraser', label: 'Eraser' },
  { id: 'pick', label: 'Pick' },
];

export function createMapStage(ctrl: AppController): MapStageApi {
  let zoom = ctrl.state.mapZoom;
  let hoverCell: Pt | null = null;
  let dragBefore: number[] | null = null;
  let rectStart: Pt | null = null;
  let rectEnd: Pt | null = null;
  let panDrag: { startX: number; startY: number; scrollLeft: number; scrollTop: number } | null = null;

  const setMapZoom = (next: number) => {
    const clamped = Math.max(1, Math.min(8, Math.round(next)));
    if (clamped === zoom) return;
    zoom = clamped;
    ctrl.store.setState({ mapZoom: zoom });
    draw();
  };

  const toolBtns = MAP_TOOLS.map((t) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(ctrl.state.mapTool === t.id),
        onClick: () => ctrl.store.setState({ mapTool: t.id }),
      },
      t.label,
    ),
  );

  const mapWIn = h('input', {
    id: 'map-w',
    class: 'num',
    type: 'number',
    min: 1,
    max: 256,
    value: ctrl.state.doc.tilemap.width,
    'aria-label': 'Map width in tiles',
  });
  const mapHIn = h('input', {
    id: 'map-h',
    class: 'num',
    type: 'number',
    min: 1,
    max: 256,
    value: ctrl.state.doc.tilemap.height,
    'aria-label': 'Map height in tiles',
  });

  const applyMapResize = () => {
    const nw = Math.max(1, Math.min(256, Math.round(Number(mapWIn.value) || 16)));
    const nh = Math.max(1, Math.min(256, Math.round(Number(mapHIn.value) || 12)));
    const tm = ctrl.state.doc.tilemap;
    if (nw !== tm.width || nh !== tm.height) {
      ctrl.execute(resizeTileMapCommand(nw, nh));
    }
  };
  mapWIn.addEventListener('change', applyMapResize);
  mapHIn.addEventListener('change', applyMapResize);

  const layerSel = h('select', {
    id: 'map-layer-sel',
    'aria-label': 'Active map layer',
    onChange: () => ctrl.store.setState({ activeMapLayerId: layerSel.value }),
  });

  const layerVisBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': 'Toggle map layer visibility',
      title: 'Toggle map layer visibility',
      onClick: () => {
        const ml = ctrl.getActiveMapLayer();
        if (ml) ctrl.execute(toggleMapLayerVisibleCommand(ml.id));
      },
    },
    icon('eye', 14),
  );

  const addLayerBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': 'Add map layer',
      title: 'Add map layer',
      onClick: () => {
        ctrl.execute(addMapLayerCommand());
        const layers = ctrl.state.doc.tilemap.layers;
        ctrl.store.setState({ activeMapLayerId: layers[layers.length - 1].id });
      },
    },
    icon('plus', 14),
  );

  const delLayerBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn tiny',
      'aria-label': 'Delete map layer',
      title: 'Delete map layer',
      onClick: () => {
        const ml = ctrl.getActiveMapLayer();
        if (!ml || ctrl.state.doc.tilemap.layers.length <= 1) return;
        ctrl.execute(removeMapLayerCommand(ml.id));
        ctrl.store.setState({ activeMapLayerId: ctrl.state.doc.tilemap.layers[0].id });
      },
    },
    icon('trash', 14),
  );

  const zoomLabel = h('span', { class: 'mono' }, `${zoom}×`);
  const rotLabel = h('span', { class: 'mono hint' }, '0°');
  const flipHBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Flip tile brush horizontally',
    'aria-pressed': String(ctrl.state.mapTileFlipH),
    title: 'Flip tile horizontal (Alt+H)',
    onClick: () => ctrl.flipMapTileH(),
  }, icon('flipH', 14));
  const flipVBtn = h('button', {
    type: 'button',
    class: 'icon-btn tiny',
    'aria-label': 'Flip tile brush vertically',
    'aria-pressed': String(ctrl.state.mapTileFlipV),
    title: 'Flip tile vertical (Alt+V)',
    onClick: () => ctrl.flipMapTileV(),
  }, icon('flipV', 14));
  const packedActiveTile = (): number => {
    const s = ctrl.state;
    if (s.activeTileIndex <= 0) return 0;
    return packMapCell(s.activeTileIndex, s.mapTileRot, s.mapTileFlipH, s.mapTileFlipV);
  };
  const extSel = h(
    'select',
    {
      id: 'map-atlas-ext',
      'aria-label': 'Atlas extrusion pixels',
      title: 'Tile edge extrusion (prevents WebGL bleed)',
      onChange: () => ctrl.store.setState({ atlasExtrusion: Number(extSel.value) as 0 | 1 | 2 }),
    },
    h('option', { value: '0' }, 'Ext 0px'),
    h('option', { value: '1', selected: true }, 'Ext 1px'),
    h('option', { value: '2' }, 'Ext 2px'),
  );

  const toolbar = h(
    'div',
    { class: 'map-toolbar', role: 'toolbar', 'aria-label': 'Map editor tools' },
    h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Map tool' }, ...toolBtns),
    h('span', { class: 'sep', role: 'separator', 'aria-orientation': 'vertical' }),
    h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Tile transform' },
      h('button', { type: 'button', title: 'Rotate tile 90° CCW (Alt+[)', 'aria-label': 'Rotate tile CCW', onClick: () => ctrl.rotateMapTile(-1) }, '↺'),
      rotLabel,
      h('button', { type: 'button', title: 'Rotate tile 90° CW (Alt+])', 'aria-label': 'Rotate tile CW', onClick: () => ctrl.rotateMapTile(1) }, '↻'),
      flipHBtn,
      flipVBtn,
    ),
    h('span', { class: 'sep', role: 'separator', 'aria-orientation': 'vertical' }),
    h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Map layers' }, layerSel, layerVisBtn, addLayerBtn, delLayerBtn),
    h('span', { class: 'sep', role: 'separator', 'aria-orientation': 'vertical' }),
    h('div', { class: 'map-dim-group' }, h('span', { class: 'hint' }, 'Grid'), mapWIn, h('span', { class: 'hint' }, '×'), mapHIn),
    h('div', { class: 'btn-group' },
      h('button', { type: 'button', 'aria-label': 'Zoom map out', onClick: () => setMapZoom(zoom - 1) }, '-'),
      zoomLabel,
      h('button', { type: 'button', 'aria-label': 'Zoom map in', onClick: () => setMapZoom(zoom + 1) }, '+'),
    ),
    h('span', { class: 'spacer' }),
    extSel,
    h('button', {
      type: 'button',
      title: 'Export tileset PNG atlas with extrusion',
      onClick: () => {
        const { png, atlas } = exportTilesetAtlasPngBytes(ctrl.state.doc, ctrl.state.atlasExtrusion);
        triggerDownload(png, 'image/png', `tintbox_atlas_ext${atlas.extrusion}.png`);
        ctrl.showToast(`Exported tileset atlas (${atlas.w}×${atlas.h}, ext ${atlas.extrusion}px).`, 'info');
      },
    }, icon('download', 14), ' Atlas'),
    h('button', {
      type: 'button',
      title: 'Export map JSON',
      onClick: () => {
        const json = exportTileMapJson(ctrl.state.doc);
        triggerDownload(json, 'application/json', 'tintbox_map.json');
        ctrl.showToast('Exported tilemap JSON.', 'info');
      },
    }, 'JSON'),
  );

  const mapCanvas = h('canvas', {
    class: 'map-canvas',
    role: 'img',
    'aria-label': 'Tile map canvas',
  });
  const ctx = mapCanvas.getContext('2d');

  const overlayCanvas = h('canvas', { class: 'map-overlay', 'aria-hidden': 'true' });
  const octx = overlayCanvas.getContext('2d');

  const canvasBox = h('div', { class: 'map-canvas-box' }, mapCanvas, overlayCanvas);
  const viewport = h('div', { class: 'map-viewport' }, canvasBox);
  wireToolbarFocusgroup(toolbar);

  viewport.addEventListener(
    'wheel',
    (e) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      setMapZoom(zoom + (e.deltaY < 0 ? 1 : -1));
    },
    { passive: false },
  );
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      viewport.setPointerCapture(e.pointerId);
      panDrag = { startX: e.clientX, startY: e.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
    }
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!panDrag) return;
    viewport.scrollLeft = panDrag.scrollLeft - (e.clientX - panDrag.startX);
    viewport.scrollTop = panDrag.scrollTop - (e.clientY - panDrag.startY);
  });
  viewport.addEventListener('pointerup', () => { panDrag = null; });
  viewport.addEventListener('pointercancel', () => { panDrag = null; });

  const el = h('section', { class: 'map-stage', 'aria-label': 'Tile Map Editor', hidden: true }, toolbar, viewport);

  const cellFromEvent = (e: PointerEvent): Pt | null => {
    const r = mapCanvas.getBoundingClientRect();
    const { tileW, tileH } = ctrl.state.doc.tileset;
    const { width, height } = ctrl.state.doc.tilemap;
    const tx = Math.floor((e.clientX - r.left) / (tileW * zoom));
    const ty = Math.floor((e.clientY - r.top) / (tileH * zoom));
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return null;
    return { x: tx, y: ty };
  };

  const paintCellLive = (cell: Pt, tileId: number) => {
    const ml = ctrl.getActiveMapLayer();
    const tm = ctrl.state.doc.tilemap;
    const idx = cell.y * tm.width + cell.x;
    if (ml.data[idx] === tileId) return;
    ml.data[idx] = tileId;
    draw();
  };

  canvasBox.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const cell = cellFromEvent(e);
    if (!cell) return;
    const s = ctrl.state;
    const ml = ctrl.getActiveMapLayer();
    if (!ml) return;

    if (s.mapTool === 'pick') {
      const pickedCell = ml.data[cell.y * s.doc.tilemap.width + cell.x] ?? 0;
      const u = unpackMapCell(pickedCell);
      if (u.tileId > 0) {
        ctrl.store.setState({
          activeTileIndex: u.tileId,
          mapTileRot: u.rot,
          mapTileFlipH: u.flipH,
          mapTileFlipV: u.flipV,
          mapTool: 'brush',
        });
        ctrl.showToast(`Picked tile #${u.tileId}${u.rot ? ` (${u.rot * 90}°)` : ''}.`, 'info');
      } else {
        ctrl.showToast('Cell is empty.', 'info');
      }
      return;
    }

    if (s.mapTool === 'fill') {
      const cellVal = packedActiveTile();
      if (cellVal <= 0) {
        ctrl.showToast('Add or select a tile in the Tiles panel first.', 'info');
        return;
      }
      const before = ml.data.slice();
      const after = mapFloodFill(before, s.doc.tilemap.width, s.doc.tilemap.height, cell.x, cell.y, cellVal);
      if (after.some((v, i) => v !== before[i])) {
        ctrl.execute(setMapLayerDataCommand(ml.id, before, after, 'Map flood fill'));
      }
      return;
    }

    if (s.mapTool === 'rect') {
      if (s.activeTileIndex <= 0) {
        ctrl.showToast('Add or select a tile in the Tiles panel first.', 'info');
        return;
      }
      canvasBox.setPointerCapture(e.pointerId);
      rectStart = cell;
      rectEnd = cell;
      drawOverlay();
      return;
    }

    // Brush or Eraser
    const cellVal = s.mapTool === 'eraser' ? 0 : packedActiveTile();
    if (s.mapTool === 'brush' && cellVal <= 0) {
      ctrl.showToast('Add or select a tile in the Tiles panel first.', 'info');
      return;
    }
    canvasBox.setPointerCapture(e.pointerId);
    dragBefore = ml.data.slice();
    paintCellLive(cell, cellVal);
  });

  canvasBox.addEventListener('pointermove', (e) => {
    const cell = cellFromEvent(e);
    const prev = hoverCell;
    hoverCell = cell;
    if (prev?.x !== cell?.x || prev?.y !== cell?.y) {
      ctrl.store.setState({ mapHoverCell: cell });
    }
    if (rectStart && cell) {
      rectEnd = cell;
      drawOverlay();
      return;
    }
    if (dragBefore && cell) {
      const s = ctrl.state;
      const cellVal = s.mapTool === 'eraser' ? 0 : packedActiveTile();
      paintCellLive(cell, cellVal);
    }
    drawOverlay();
  });

  const finishDrag = () => {
    const s = ctrl.state;
    const ml = ctrl.getActiveMapLayer();
    if (rectStart && rectEnd && ml) {
      const before = ml.data.slice();
      const after = before.slice();
      const cells = mapRectCells(rectStart, rectEnd, s.doc.tilemap.width, s.doc.tilemap.height);
      const cellVal = packedActiveTile();
      for (const c of cells) after[c.y * s.doc.tilemap.width + c.x] = cellVal;
      rectStart = null;
      rectEnd = null;
      if (after.some((v, i) => v !== before[i])) {
        ctrl.execute(setMapLayerDataCommand(ml.id, before, after, 'Map rect fill'));
      }
      drawOverlay();
      return;
    }
    if (dragBefore && ml) {
      const before = dragBefore;
      const after = ml.data.slice();
      dragBefore = null;
      if (after.some((v, i) => v !== before[i])) {
        ml.data = before.slice();
        ctrl.execute(
          setMapLayerDataCommand(ml.id, before, after, s.mapTool === 'eraser' ? 'Erase map tiles' : 'Paint map tiles'),
        );
      }
    }
  };

  canvasBox.addEventListener('pointerup', finishDrag);
  canvasBox.addEventListener('pointercancel', finishDrag);
  canvasBox.addEventListener('pointerleave', () => {
    hoverCell = null;
    ctrl.store.setState({ mapHoverCell: null });
    drawOverlay();
  });

  function drawOverlay(): void {
    if (!octx) return;
    const s = ctrl.state;
    const { tileW, tileH } = s.doc.tileset;
    const { width, height } = s.doc.tilemap;
    const cw = width * tileW * zoom;
    const ch = height * tileH * zoom;
    if (overlayCanvas.width !== cw || overlayCanvas.height !== ch) {
      overlayCanvas.width = cw;
      overlayCanvas.height = ch;
    }
    octx.clearRect(0, 0, cw, ch);

    // Snap-to-grid tile lines
    octx.save();
    octx.strokeStyle = 'rgba(232, 228, 216, 0.16)';
    octx.lineWidth = 1;
    octx.beginPath();
    for (let x = 0; x <= width; x++) {
      const px = x * tileW * zoom + 0.5;
      octx.moveTo(px, 0);
      octx.lineTo(px, ch);
    }
    for (let y = 0; y <= height; y++) {
      const py = y * tileH * zoom + 0.5;
      octx.moveTo(0, py);
      octx.lineTo(cw, py);
    }
    octx.stroke();

    // Hover tile ghost preview + highlight
    if (hoverCell) {
      if (s.mapTool === 'brush' && s.activeTileIndex > 0 && s.activeTileIndex <= s.doc.tileset.tiles.length && typeof ImageData !== 'undefined') {
        const tile = s.doc.tileset.tiles[s.activeTileIndex - 1];
        const rawPx = resolveTilePixels(s.doc, tile);
        const px = transformTilePixels(rawPx, tileW, tileH, s.mapTileRot, s.mapTileFlipH, s.mapTileFlipV);
        const tmp = document.createElement('canvas');
        tmp.width = tileW;
        tmp.height = tileH;
        const tctx = tmp.getContext('2d');
        if (tctx) {
          const copy = new Uint8ClampedArray(px.length);
          copy.set(px);
          tctx.putImageData(new ImageData(copy, tileW, tileH), 0, 0);
          octx.save();
          octx.imageSmoothingEnabled = false;
          octx.globalAlpha = 0.5;
          octx.drawImage(tmp, hoverCell.x * tileW * zoom, hoverCell.y * tileH * zoom, tileW * zoom, tileH * zoom);
          octx.restore();
        }
      }
      octx.strokeStyle = '#c6f432';
      octx.strokeRect(
        hoverCell.x * tileW * zoom + 0.5,
        hoverCell.y * tileH * zoom + 0.5,
        tileW * zoom - 1,
        tileH * zoom - 1,
      );
    }

    // Rect drag preview
    if (rectStart && rectEnd) {
      const x0 = Math.min(rectStart.x, rectEnd.x);
      const y0 = Math.min(rectStart.y, rectEnd.y);
      const rw = Math.abs(rectEnd.x - rectStart.x) + 1;
      const rh = Math.abs(rectEnd.y - rectStart.y) + 1;
      octx.strokeStyle = '#c6f432';
      octx.setLineDash([4, 3]);
      octx.strokeRect(x0 * tileW * zoom + 0.5, y0 * tileH * zoom + 0.5, rw * tileW * zoom - 1, rh * tileH * zoom - 1);
    }
    octx.restore();
  }

  function draw(): void {
    const s = ctrl.state;
    el.hidden = s.viewMode !== 'map';
    if (s.viewMode !== 'map') return;

    MAP_TOOLS.forEach((t, idx) => toolBtns[idx].setAttribute('aria-pressed', String(s.mapTool === t.id)));
    const tm = s.doc.tilemap;
    mapWIn.value = String(tm.width);
    mapHIn.value = String(tm.height);
    zoomLabel.textContent = `${zoom}×`;
    rotLabel.textContent = `${s.mapTileRot * 90}°`;
    flipHBtn.setAttribute('aria-pressed', String(s.mapTileFlipH));
    flipVBtn.setAttribute('aria-pressed', String(s.mapTileFlipV));
    extSel.value = String(s.atlasExtrusion);

    const activeMl = ctrl.getActiveMapLayer();
    layerSel.replaceChildren(
      ...tm.layers.map((l) => h('option', { value: l.id, selected: l.id === activeMl?.id }, l.name)),
    );
    if (activeMl) layerSel.value = activeMl.id;
    layerVisBtn.replaceChildren(icon(activeMl?.visible === false ? 'eyeOff' : 'eye', 14));
    delLayerBtn.disabled = tm.layers.length <= 1;

    const composed = composeTileMapRgba(s.doc);
    if (mapCanvas.width !== composed.w || mapCanvas.height !== composed.h) {
      mapCanvas.width = composed.w;
      mapCanvas.height = composed.h;
    }
    if (ctx && typeof ImageData !== 'undefined') {
      const copy = new Uint8ClampedArray(composed.data.length);
      copy.set(composed.data);
      ctx.putImageData(new ImageData(copy, composed.w, composed.h), 0, 0);
    }
    const cssW = composed.w * zoom;
    const cssH = composed.h * zoom;
    canvasBox.style.width = `${cssW}px`;
    canvasBox.style.height = `${cssH}px`;
    mapCanvas.style.width = `${cssW}px`;
    mapCanvas.style.height = `${cssH}px`;
    overlayCanvas.style.width = `${cssW}px`;
    overlayCanvas.style.height = `${cssH}px`;
    drawOverlay();
  }

  draw();
  const unsub = ctrl.store.subscribe(
    (s) => [s.docRev, s.viewMode, s.mapTool, s.activeMapLayerId, s.activeTileIndex, s.atlasExtrusion, s.mapTileRot, s.mapTileFlipH, s.mapTileFlipV] as const,
    draw,
    (a, b) => a.every((v, i) => Object.is(v, b[i])),
  );

  return {
    el,
    destroy() {
      unsub();
    },
  };
}
