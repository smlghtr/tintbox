import { describe, expect, it } from 'vitest';
import { defaultSymmetry, mirrorPoint, mirrorPoints } from './symmetry';

describe('symmetry', () => {
  it('mirrors even width exactly with no 1px offset', () => {
    const sym = { ...defaultSymmetry(4, 4), mode: 'x' as const };
    expect(mirrorPoint({ x: 0, y: 1 }, sym)).toEqual([{ x: 0, y: 1 }, { x: 3, y: 1 }]);
    expect(mirrorPoint({ x: 1, y: 1 }, sym)).toEqual([{ x: 1, y: 1 }, { x: 2, y: 1 }]);
  });

  it('mirrors odd width exactly around center pixel', () => {
    const sym = { ...defaultSymmetry(5, 5), mode: 'x' as const };
    expect(mirrorPoint({ x: 0, y: 2 }, sym)).toEqual([{ x: 0, y: 2 }, { x: 4, y: 2 }]);
    expect(mirrorPoint({ x: 2, y: 2 }, sym)).toEqual([{ x: 2, y: 2 }]);
  });

  it('mirrors xy into 4 unique quadrants', () => {
    const sym = { ...defaultSymmetry(6, 6), mode: 'xy' as const };
    const pts = mirrorPoints([{ x: 1, y: 1 }], sym);
    expect(pts).toHaveLength(4);
    expect(pts).toContainEqual({ x: 1, y: 1 });
    expect(pts).toContainEqual({ x: 4, y: 1 });
    expect(pts).toContainEqual({ x: 1, y: 4 });
    expect(pts).toContainEqual({ x: 4, y: 4 });
  });
});
