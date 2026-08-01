import { describe, expect, it } from "vitest";
import { coversFrame, roiFromCorners } from "../receive/roi";

const square = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

describe("roiFromCorners", () => {
  it("contains the code plus margin, quantized and even", () => {
    const roi = roiFromCorners(square(400, 300, 200), 1280, 960)!;
    expect(roi).not.toBeNull();
    // margin: 25% of 200 = 50 per side → ≥300 wide, quantized up to /32
    expect(roi.w).toBeGreaterThanOrEqual(300);
    expect(roi.h).toBeGreaterThanOrEqual(300);
    expect(roi.w % 32).toBe(0);
    expect(roi.h % 32).toBe(0);
    expect(roi.x % 2).toBe(0);
    expect(roi.y % 2).toBe(0);
    // code fully inside the crop
    expect(roi.x).toBeLessThanOrEqual(400);
    expect(roi.y).toBeLessThanOrEqual(300);
    expect(roi.x + roi.w).toBeGreaterThanOrEqual(600);
    expect(roi.y + roi.h).toBeGreaterThanOrEqual(500);
  });

  it("clamps to the frame when the code sits at an edge", () => {
    const roi = roiFromCorners(square(0, 0, 200), 1280, 960)!;
    expect(roi.x).toBe(0);
    expect(roi.y).toBe(0);
    expect(roi.x + roi.w).toBeLessThanOrEqual(1280);
    expect(roi.y + roi.h).toBeLessThanOrEqual(960);

    const br = roiFromCorners(square(1080, 760, 200), 1280, 960)!;
    expect(br.x + br.w).toBeLessThanOrEqual(1280);
    expect(br.y + br.h).toBeLessThanOrEqual(960);
    expect(br.x).toBeGreaterThanOrEqual(0);
    expect(br.y).toBeGreaterThanOrEqual(0);
  });

  it("degrades to (at most) the full frame for a huge code", () => {
    const roi = roiFromCorners(square(10, 10, 940), 1280, 960)!;
    expect(roi.w).toBeLessThanOrEqual(1280);
    expect(roi.h).toBeLessThanOrEqual(960);
    expect(coversFrame({ ...roi, w: 1280, h: 960 }, 1280, 960)).toBe(true);
  });

  it("keeps rect valid for odd frame dimensions", () => {
    const roi = roiFromCorners(square(100, 100, 200), 1281, 959)!;
    expect(roi.x % 2).toBe(0);
    expect(roi.y % 2).toBe(0);
    expect(roi.w % 2).toBe(0);
    expect(roi.h % 2).toBe(0);
    expect(roi.x + roi.w).toBeLessThanOrEqual(1281);
    expect(roi.y + roi.h).toBeLessThanOrEqual(959);
  });

  it("rejects degenerate or non-finite positions", () => {
    expect(roiFromCorners([], 1280, 960)).toBeNull();
    expect(roiFromCorners(square(50, 50, 2), 1280, 960)).toBeNull(); // tiny bbox
    expect(roiFromCorners([{ x: NaN, y: 10 }, ...square(0, 0, 100)], 1280, 960)).toBeNull();
    expect(roiFromCorners([{ x: Infinity, y: 10 }], 1280, 960)).toBeNull();
  });

  it("tracks a moving code (successive updates stay centered)", () => {
    let c = square(200, 200, 240);
    for (let step = 0; step < 20; step++) {
      const roi = roiFromCorners(c, 1280, 960)!;
      // every corner inside the roi
      for (const p of c) {
        expect(p.x).toBeGreaterThanOrEqual(roi.x);
        expect(p.x).toBeLessThanOrEqual(roi.x + roi.w);
        expect(p.y).toBeGreaterThanOrEqual(roi.y);
        expect(p.y).toBeLessThanOrEqual(roi.y + roi.h);
      }
      c = c.map((p) => ({ x: p.x + 17, y: p.y + 9 })); // hand drift per frame
    }
  });
});
