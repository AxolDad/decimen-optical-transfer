// Vsync-integer pacing — pure and unit-tested.
//
// Wall-clock pacing at 24 fps on a 60 Hz display alternates 2-vsync and
// 3-vsync holds (33 ms / 50 ms); the short holds are the ones a camera
// straddles. Holding every frame for exactly N refresh cycles is strictly
// better for the capture side, so the sender asks for a target fps and gets
// the nearest vsync-integer rate — never fewer than 2 cycles per frame (a
// 1-cycle hold guarantees straddled captures; see README).

export interface Pacing {
  ticks: number; // rAF callbacks per displayed frame
  fps: number; // the actual resulting frame rate
}

export function vsyncPacing(refreshHz: number, targetFps: number, minTicks = 2): Pacing {
  const hz = Math.min(480, Math.max(20, refreshHz || 60));
  const ticks = Math.max(minTicks, Math.round(hz / Math.max(1, targetFps)));
  return { ticks, fps: hz / ticks };
}

const COMMON_RATES = [60, 75, 90, 120, 144, 165, 240];

/** Estimate the display refresh rate from a run of rAF timestamps. */
export function estimateRefresh(timestamps: number[]): number {
  const deltas: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const d = timestamps[i]! - timestamps[i - 1]!;
    if (d >= 3 && d <= 50) deltas.push(d); // drop jank/throttle outliers
  }
  if (deltas.length < 8) return 60; // not enough clean samples — assume 60
  deltas.sort((a, b) => a - b);
  const med = deltas[deltas.length >> 1]!;
  const hz = 1000 / med;
  for (const c of COMMON_RATES) if (Math.abs(hz - c) / c < 0.06) return c;
  return Math.round(hz);
}
