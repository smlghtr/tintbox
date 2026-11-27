import { bresenham, brushOffsets, pixelCurve, pixelEllipse, pixelLine, pixelRect } from './raster';
import type { BezierAnchor, Pt } from './types';

export type ShapePreset = 'square' | 'oval' | 'star' | 'cube' | 'isometric';

export const SHAPE_PRESETS: { id: ShapePreset; label: string }[] = [
  { id: 'square', label: 'Square' },
  { id: 'oval', label: 'Oval' },
  { id: 'star', label: 'Star' },
  { id: 'cube', label: 'Cube' },
  { id: 'isometric', label: 'Iso' },
];

export interface VectorPathOpts {
  closed: boolean;
  smooth: boolean;
  width: number;
}

export interface LiveShapeOpts {
  preset: ShapePreset;
  filled?: boolean;
  constrain?: boolean;
  fromCenter?: boolean;
  starPoints?: number;
  starInnerRatio?: number;
}

function dedupePts(pts: Pt[]): Pt[] {
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const p of pts) {
    const k = `${p.x},${p.y}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

function dilateStroke(pts: Pt[], width: number): Pt[] {
  const w = Math.max(1, Math.min(8, Math.round(width)));
  if (w === 1) return dedupePts(pts);
  const kernel = brushOffsets(w, 'round');
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const p of pts) {
    for (const o of kernel) {
      const x = p.x + o.x;
      const y = p.y + o.y;
      const k = `${x},${y}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ x, y });
      }
    }
  }
  return out;
}

/** Rasterize an editable multi-point vector path (polyline or smooth quadratic curve) to crisp pixels. */
export function rasterizeVectorPath(points: Pt[], opts: VectorPathOpts): Pt[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return dilateStroke([points[0]], opts.width);

  const raw: Pt[] = [];
  if (!opts.smooth || n === 2) {
    for (let i = 0; i < n - 1; i++) {
      raw.push(...pixelLine(points[i], points[i + 1]));
    }
    if (opts.closed && n > 2) {
      raw.push(...pixelLine(points[n - 1], points[0]));
    }
    return dilateStroke(raw, opts.width);
  }

  // Smooth quadratic spline passing through consecutive segment midpoints
  const mid = (a: Pt, b: Pt): Pt => ({ x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) });
  if (opts.closed) {
    for (let i = 0; i < n; i++) {
      const prev = points[(i - 1 + n) % n];
      const curr = points[i];
      const next = points[(i + 1) % n];
      raw.push(...pixelCurve(mid(prev, curr), curr, mid(curr, next)));
    }
  } else {
    raw.push(...pixelLine(points[0], mid(points[0], points[1])));
    for (let i = 1; i < n - 1; i++) {
      raw.push(...pixelCurve(mid(points[i - 1], points[i]), points[i], mid(points[i], points[i + 1])));
    }
    raw.push(...pixelLine(mid(points[n - 2], points[n - 1]), points[n - 1]));
  }
  return dilateStroke(raw, opts.width);
}

/** Rasterize a single cubic Bezier segment p0 -> c1 -> c2 -> p3 into a gap-free 1px integer path. */
export function rasterizeCubicBezier(p0: Pt, c1: Pt, c2: Pt, p3: Pt): Pt[] {
  const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const poly = Math.hypot(c1.x - p0.x, c1.y - p0.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(p3.x - c2.x, p3.y - c2.y);
  const steps = Math.max(4, Math.ceil(Math.max(chord, poly) * 2));
  const samples: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = Math.round(u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x);
    const y = Math.round(u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y);
    if (samples.length === 0 || samples[samples.length - 1].x !== x || samples[samples.length - 1].y !== y) {
      samples.push({ x, y });
    }
  }
  const connected: Pt[] = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    connected.push(...bresenham(samples[i - 1], samples[i]).slice(1));
  }
  return connected;
}

/** Auto-compute smooth symmetric cubic Bezier handles from anchor positions using Catmull-Rom tension (0..100). */
export function autoSmoothBezierAnchors(anchors: BezierAnchor[], closed: boolean, tension = 50): BezierAnchor[] {
  const n = anchors.length;
  const k = Math.max(0, Math.min(100, tension)) / 100 * 0.35;
  return anchors.map((a, i) => {
    if (k <= 0.001 || n < 2) return { x: a.x, y: a.y };
    const prev = i > 0 ? anchors[i - 1] : closed ? anchors[n - 1] : a;
    const next = i + 1 < n ? anchors[i + 1] : closed ? anchors[0] : a;
    const dx = (next.x - prev.x) * k;
    const dy = (next.y - prev.y) * k;
    return {
      x: a.x,
      y: a.y,
      inHandle: i > 0 || closed ? { x: Math.round(a.x - dx), y: Math.round(a.y - dy) } : undefined,
      outHandle: i + 1 < n || closed ? { x: Math.round(a.x + dx), y: Math.round(a.y + dy) } : undefined,
    };
  });
}

export interface BezierPathOpts {
  closed: boolean;
  filled?: boolean;
  width: number;
}

/** Rasterize a full Photoshop-style cubic Bezier pen path (stroke + optional closed fill). */
export function rasterizeBezierPath(anchors: BezierAnchor[], opts: BezierPathOpts): Pt[] {
  const n = anchors.length;
  if (n === 0) return [];
  if (n === 1) return dilateStroke([{ x: anchors[0].x, y: anchors[0].y }], opts.width);

  const outline: Pt[] = [];
  const segCount = opts.closed && n > 2 ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % n];
    const c1 = a.outHandle ?? { x: a.x, y: a.y };
    const c2 = b.inHandle ?? { x: b.x, y: b.y };
    const seg =
      !a.outHandle && !b.inHandle
        ? pixelLine({ x: a.x, y: a.y }, { x: b.x, y: b.y })
        : rasterizeCubicBezier({ x: a.x, y: a.y }, c1, c2, { x: b.x, y: b.y });
    outline.push(...seg);
  }

  const stroked = dilateStroke(outline, opts.width);
  if (opts.closed && opts.filled && n >= 3) {
    return dedupePts([...fillPolygon(outline), ...stroked]);
  }
  return stroked;
}

function resolveBounds(
  a: Pt,
  b: Pt,
  constrain: boolean,
  fromCenter: boolean,
): { x0: number; y0: number; x1: number; y1: number } {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (constrain) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  if (fromCenter) {
    return {
      x0: Math.min(a.x - dx, a.x + dx),
      y0: Math.min(a.y - dy, a.y + dy),
      x1: Math.max(a.x - dx, a.x + dx),
      y1: Math.max(a.y - dy, a.y + dy),
    };
  }
  const bx = a.x + dx;
  const by = a.y + dy;
  return {
    x0: Math.min(a.x, bx),
    y0: Math.min(a.y, by),
    x1: Math.max(a.x, bx),
    y1: Math.max(a.y, by),
  };
}

/** Integer scanline fill for an arbitrary closed polygon (even-odd rule). */
function fillPolygon(verts: Pt[]): Pt[] {
  if (verts.length < 3) return [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const pts: Pt[] = [];
  const n = verts.length;
  for (let y = minY; y <= maxY; y++) {
    const scanY = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const vi = verts[i];
      const vj = verts[j];
      if ((vi.y <= scanY && vj.y > scanY) || (vj.y <= scanY && vi.y > scanY)) {
        const t = (scanY - vi.y) / (vj.y - vi.y);
        xs.push(vi.x + t * (vj.x - vi.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const lx = Math.ceil(xs[k] - 0.5);
      const rx = Math.floor(xs[k + 1] + 0.5);
      for (let x = lx; x <= rx; x++) pts.push({ x, y });
    }
  }
  return pts;
}

function outlinePolygon(verts: Pt[]): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < verts.length; i++) {
    pts.push(...bresenham(verts[i], verts[(i + 1) % verts.length]));
  }
  return pts;
}

/** Exact 2:1 pixel-art isometric diamond: 2 horizontal pixels per 1 vertical step. */
function isometricDiamond(x0: number, y0: number, x1: number, y1: number, filled: boolean): Pt[] {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const steps = Math.max(1, Math.min(Math.floor(w / 4), Math.floor(h / 2)));
  const cx = Math.floor((x0 + x1) / 2);
  const topY = Math.floor((y0 + y1) / 2) - steps;
  const pts: Pt[] = [];

  for (let row = 0; row < steps; row++) {
    const lx = cx - 2 * row - 1;
    const rx = cx + 2 * row + 2;
    const yTop = topY + row;
    const yBot = topY + 2 * steps - 1 - row;
    if (filled) {
      for (let x = lx; x <= rx; x++) {
        pts.push({ x, y: yTop });
        pts.push({ x, y: yBot });
      }
    } else {
      pts.push({ x: lx, y: yTop }, { x: lx + 1, y: yTop }, { x: rx - 1, y: yTop }, { x: rx, y: yTop });
      pts.push({ x: lx, y: yBot }, { x: lx + 1, y: yBot }, { x: rx - 1, y: yBot }, { x: rx, y: yBot });
    }
  }
  return dedupePts(pts);
}

/** Pixel-art 3-face isometric/axonometric cube (hexagon silhouette + internal 3-edge Y junction). */
function pixelCube(x0: number, y0: number, x1: number, y1: number, filled: boolean): Pt[] {
  const w = Math.max(2, x1 - x0);
  const h = Math.max(4, y1 - y0);
  const cx = Math.round((x0 + x1) / 2);
  const topY = y0;
  const botY = y0 + h;
  const q1 = y0 + Math.round(h * 0.25);
  const q3 = y0 + Math.round(h * 0.75);
  const cy = y0 + Math.round(h * 0.5);
  const leftX = x0;
  const rightX = x0 + w;

  const hull: Pt[] = [
    { x: cx, y: topY },
    { x: rightX, y: q1 },
    { x: rightX, y: q3 },
    { x: cx, y: botY },
    { x: leftX, y: q3 },
    { x: leftX, y: q1 },
  ];

  const center: Pt = { x: cx, y: cy };
  if (filled) {
    return dedupePts([...fillPolygon(hull), ...outlinePolygon(hull)]);
  }
  return dedupePts([
    ...outlinePolygon(hull),
    ...bresenham(center, { x: leftX, y: q1 }),
    ...bresenham(center, { x: rightX, y: q1 }),
    ...bresenham(center, { x: cx, y: botY }),
  ]);
}

function pixelStar(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  points: number,
  innerRatio: number,
  filled: boolean,
): Pt[] {
  const n = Math.max(4, Math.min(12, Math.round(points)));
  const ratio = Math.max(0.2, Math.min(0.8, innerRatio));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.max(1, (x1 - x0) / 2);
  const ry = Math.max(1, (y1 - y0) / 2);
  const verts: Pt[] = [];
  for (let i = 0; i < n * 2; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / n;
    const scale = i % 2 === 0 ? 1 : ratio;
    verts.push({
      x: Math.round(cx + Math.cos(angle) * rx * scale),
      y: Math.round(cy + Math.sin(angle) * ry * scale),
    });
  }
  return dedupePts(filled ? [...fillPolygon(verts), ...outlinePolygon(verts)] : outlinePolygon(verts));
}

/** Rasterize any live shape preset (square, oval, star, cube, isometric) to crisp integer pixels. */
export function rasterizeShapePreset(a: Pt, b: Pt, opts: LiveShapeOpts): Pt[] {
  const filled = Boolean(opts.filled);
  const constrain = Boolean(opts.constrain);
  const fromCenter = Boolean(opts.fromCenter);

  if (opts.preset === 'square') {
    return pixelRect(a, b, { filled, square: constrain, fromCenter });
  }
  if (opts.preset === 'oval') {
    return pixelEllipse(a, b, { filled, circle: constrain, fromCenter });
  }
  const { x0, y0, x1, y1 } = resolveBounds(a, b, constrain, fromCenter);
  if (opts.preset === 'star') {
    return pixelStar(x0, y0, x1, y1, opts.starPoints ?? 5, opts.starInnerRatio ?? 0.45, filled);
  }
  if (opts.preset === 'cube') {
    return pixelCube(x0, y0, x1, y1, filled);
  }
  return isometricDiamond(x0, y0, x1, y1, filled);
}
