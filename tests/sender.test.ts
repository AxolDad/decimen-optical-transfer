import { describe, expect, it } from "vitest";
import { estimateRefresh, vsyncPacing } from "../send/pacing";
import { GAP, MARGIN, gridLayout } from "../send/layout";
import { exportPlan } from "../lib/sender";

describe("vsyncPacing", () => {
  it("maps targets to exact refresh divisions", () => {
    expect(vsyncPacing(60, 30)).toEqual({ ticks: 2, fps: 30 });
    expect(vsyncPacing(60, 20)).toEqual({ ticks: 3, fps: 20 });
    expect(vsyncPacing(60, 15)).toEqual({ ticks: 4, fps: 15 });
    expect(vsyncPacing(120, 60)).toEqual({ ticks: 2, fps: 60 });
    expect(vsyncPacing(120, 30)).toEqual({ ticks: 4, fps: 30 });
    expect(vsyncPacing(120, 24)).toEqual({ ticks: 5, fps: 24 }); // exact on 120!
    expect(vsyncPacing(90, 30)).toEqual({ ticks: 3, fps: 30 });
  });

  it("never allows fewer than 2 refresh cycles per frame", () => {
    // 60 requested on a 60 Hz display would be 1-cycle holds — clamp to 2
    expect(vsyncPacing(60, 60)).toEqual({ ticks: 2, fps: 30 });
    expect(vsyncPacing(60, 120)).toEqual({ ticks: 2, fps: 30 });
  });

  it("rounds 24 fps on 60 Hz to a clean division instead of 2/3 jitter", () => {
    const p = vsyncPacing(60, 24);
    expect(p.ticks).toBe(3);
    expect(p.fps).toBe(20);
  });

  it("survives nonsense refresh values", () => {
    expect(vsyncPacing(0, 30).fps).toBeGreaterThan(0);
    expect(vsyncPacing(NaN, 30).fps).toBeGreaterThan(0);
    expect(vsyncPacing(10_000, 30).ticks).toBeGreaterThanOrEqual(2);
  });
});

describe("estimateRefresh", () => {
  const ramp = (n: number, step: number, jitter = 0) => {
    const out: number[] = [0];
    for (let i = 1; i < n; i++) out.push(out[i - 1]! + step + (i % 3 === 0 ? jitter : -jitter / 2));
    return out;
  };

  it("detects 60 and 120 Hz from clean timestamps", () => {
    expect(estimateRefresh(ramp(24, 1000 / 60))).toBe(60);
    expect(estimateRefresh(ramp(24, 1000 / 120))).toBe(120);
    expect(estimateRefresh(ramp(24, 1000 / 90))).toBe(90);
  });

  it("snaps near-miss cadences to common rates and survives jank", () => {
    expect(estimateRefresh(ramp(24, 16.9, 0.4))).toBe(60);
    const janky = ramp(24, 1000 / 60);
    janky[10] = janky[9]! + 200; // one 200 ms stall
    for (let i = 11; i < janky.length; i++) janky[i] = janky[i - 1]! + 1000 / 60;
    expect(estimateRefresh(janky)).toBe(60);
  });

  it("falls back to 60 without enough clean samples", () => {
    expect(estimateRefresh([])).toBe(60);
    expect(estimateRefresh([0, 300, 700, 1200])).toBe(60); // all throttled
  });
});

describe("exportPlan", () => {
  it("sizes a default recording at K×1.5, one video frame per code by default", () => {
    // 100 codes, single code/frame, 30 code/s → ceil(150/30)+1 = 6s
    const p = exportPlan(100, 1, 30);
    expect(p).toMatchObject({ overhead: 1.5, videoFps: 30, targetHeight: 0, seconds: 6 });
    expect(p.framesPerCode).toBe(1);
  });

  it("holds each code across several frames at a slow code rate", () => {
    // the YouTube recipe: 8 codes/s recorded at 30 fps → ~4 frames per code
    const p = exportPlan(600, 1, 8, { overhead: 2.4, targetHeight: 2160, videoFps: 30 });
    expect(p.framesPerCode).toBe(4); // round(30/8)
    expect(p.targetHeight).toBe(2160);
    expect(p.overhead).toBe(2.4);
    // ceil(600×2.4 / 1 / 8) + 1 = ceil(180)+1 = 181s
    expect(p.seconds).toBe(181);
  });

  it("divides duration across a grid's codes-per-frame", () => {
    // 4 codes/frame halves the frames needed vs a single code
    const one = exportPlan(400, 1, 30, { overhead: 2 });
    const grid = exportPlan(400, 4, 30, { overhead: 2 });
    expect(grid.seconds).toBeLessThan(one.seconds);
    expect(grid.seconds).toBe(Math.ceil((400 * 2) / 4 / 30) + 1);
  });

  it("never reports fewer than one frame per code", () => {
    // code rate above video fps still can't sub-divide a frame
    expect(exportPlan(10, 1, 60, { videoFps: 30 }).framesPerCode).toBe(1);
  });
});

describe("gridLayout", () => {
  it("lays out 1 / 2 / 4 codes with full quiet zones", () => {
    const one = gridLayout(125, 1); // v27
    expect(one).toMatchObject({ cols: 1, rows: 1, w: 133, h: 133 });
    expect(one.offsets).toEqual([{ x: MARGIN, y: MARGIN }]);

    const two = gridLayout(125, 2);
    expect(two).toMatchObject({ cols: 2, rows: 1, w: 2 * MARGIN + 250 + GAP, h: 133 });
    expect(two.offsets).toEqual([
      { x: 4, y: 4 },
      { x: 4 + 125 + GAP, y: 4 },
    ]);

    const four = gridLayout(125, 4);
    expect(four.w).toBe(266);
    expect(four.h).toBe(266);
    expect(four.offsets).toHaveLength(4);
    expect(four.offsets[3]).toEqual({ x: 4 + 133, y: 4 + 133 });
  });

  it("keeps at least 4 modules of quiet zone between any two codes", () => {
    const g = gridLayout(77, 4); // v15
    const right0 = g.offsets[0]!.x + 77;
    expect(g.offsets[1]!.x - right0).toBeGreaterThanOrEqual(8);
    const bottom0 = g.offsets[0]!.y + 77;
    expect(g.offsets[2]!.y - bottom0).toBeGreaterThanOrEqual(8);
  });
});
