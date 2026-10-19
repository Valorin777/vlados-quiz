import { describe, expect, it } from 'vitest';
import { neckY, tubeGeo, tubeLevel, tubeMarks } from './tubeGeo';

describe('TV timer tube geometry', () => {
  it('puts the scale on even steps with the limit on top', () => {
    expect(tubeMarks(60).major).toEqual([0, 15, 30, 45, 60]);
    expect(tubeMarks(45).major).toEqual([0, 15, 30, 45]);
    expect(tubeMarks(30).major).toEqual([0, 10, 20, 30]);
    expect(tubeMarks(20).major).toEqual([0, 5, 10, 15, 20]);
    expect(tubeMarks(90).major).toEqual([0, 30, 60, 90]);
    expect(tubeMarks(35).major).toEqual([0, 10, 20, 30, 35]);
    expect(tubeMarks(60).minor).toContain(5);
    for (const t of [5, 10, 15, 20, 25, 30, 40, 45, 60, 90, 120, 37]) {
      const m = tubeMarks(t);
      expect(m.major[0]).toBe(0);
      expect(m.major[m.major.length - 1]).toBe(t);
      expect(m.major.length).toBeGreaterThanOrEqual(2);
      expect(m.major.length).toBeLessThanOrEqual(7);
      for (const v of m.minor) expect(m.major).not.toContain(v);
    }
  });

  it('keeps the mercury inside the glass for every level and height', () => {
    for (const H of [300, 420, 500, 560]) {
      const g = tubeGeo(H, 60);
      // the whole thermometer fits its box
      expect(g.top).toBeGreaterThanOrEqual(0);
      expect(g.by + g.R).toBeLessThanOrEqual(H);
      // the mercury bulb is concentric with the glass bulb, inside the bore with a margin
      expect(g.rb).toBeLessThan(g.R - g.gt);
      // the column runs in the bore
      expect(g.cw).toBeLessThan(g.tw - g.gt);
      // full: the column's round top stays under the bore's round top
      expect(g.yFull).toBeGreaterThan(g.top + g.gt);
      // zero: the meniscus is above the neck, i.e. still in the straight tube, over the bulb
      expect(g.y0).toBeLessThan(neckY(g));
      expect(g.y0).toBeLessThan(g.by - g.rb);
      for (let k = 0; k <= 1; k += 0.05) {
        const y = tubeLevel(g, k);
        expect(y).toBeGreaterThanOrEqual(g.yFull - 1e-9);
        expect(y).toBeLessThanOrEqual(g.y0 + 1e-9);
      }
    }
  });

  it('puts every tick exactly where the meniscus is at that time', () => {
    const g = tubeGeo(500, 45);
    for (const m of g.marks) expect(m.y).toBeCloseTo(tubeLevel(g, m.v / 45), 6);
    expect(g.marks.find((m) => m.v === 0)?.y).toBeCloseTo(g.y0, 6);
    expect(g.marks.find((m) => m.v === 45)?.y).toBeCloseTo(g.yFull, 6);
  });

  it('draws the glass bulb around the mercury bulb centre', () => {
    const g = tubeGeo(500, 60);
    // the bulb arc's radius and the bulb centre implied by the path's end points
    const arc = /A(\d+(?:\.\d+)?) \1 0 1 1 ([\d.]+) ([\d.]+)/.exec(g.outer);
    expect(arc).not.toBeNull();
    const [, r, x, y] = arc as RegExpExecArray;
    expect(Number(r)).toBe(g.R);
    expect(Math.hypot(Number(x) - g.cx, Number(y) - g.by)).toBeCloseTo(g.R, 1);
  });
});
