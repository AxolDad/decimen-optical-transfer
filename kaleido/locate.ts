// EXPERIMENT — geometry recovery for the kaleidoscope symbology.
//
// This is the piece that stands between the loopback demo and a camera. The
// loopback decoder samples the exact pixel coordinates it drew to, because it
// rendered the frame itself. A camera has no such luxury: the mandala arrives
// somewhere in the frame, at some scale, tilted, and rotated arbitrarily.
//
// A polar symbol is unusually cheap to find, and that is the design's real
// advantage over QR here:
//
//   * A circle under perspective projects to an ELLIPSE. Fitting an ellipse
//     from image moments is a closed-form pass over the pixels — no corner
//     detection, no RANSAC, no iterative pose solve. QR needs corner-precision
//     homography from three finder patterns, which is most of what libcimbar
//     spends its complexity on.
//   * Rotation does not have to be recovered geometrically at all. The sync
//     ring's marker wedge gives it directly, and because every slot index is
//     read through `sectorAt(..., phase)`, an arbitrary rotation of the
//     sampling frame is absorbed for free.
//
// What still has to be right is the SUB-SLOT part of that rotation: sampling
// on integer slot boundaries misaligned by half a wedge reads the gaps between
// wedges rather than the wedges. So the marker's angular centroid is measured
// at high resolution and supplies both the fractional offset and the integer
// phase in one shot.

export interface Ellipse {
  cx: number;
  cy: number;
  /** unit vector along the major axis */
  ux: number;
  uy: number;
  /** outer semi-axis lengths along u and its +90° rotation */
  su: number;
  sv: number;
  /** fraction of the image that was symbol, a crude confidence signal */
  fill: number;
}

/** Background is near-black; anything with a lit channel is symbol. */
const ON = 60;

/**
 * Find the mandala in an arbitrary image by moments.
 *
 * Returns null when there is nothing plausibly symbol-shaped — too few lit
 * pixels, or a degenerate covariance (a line rather than a blob).
 */
export function locate(data: Uint8ClampedArray, w: number, h: number): Ellipse | null {
  // 1) centroid over lit pixels
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o]! < ON && data[o + 1]! < ON && data[o + 2]! < ON) continue;
      n++;
      sx += x;
      sy += y;
    }
  }
  if (n < 500) return null;
  const cx = sx / n;
  const cy = sy / n;

  // 2) central second moments -> covariance -> principal axes
  let m20 = 0;
  let m11 = 0;
  let m02 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o]! < ON && data[o + 1]! < ON && data[o + 2]! < ON) continue;
      const dx = x - cx;
      const dy = y - cy;
      m20 += dx * dx;
      m11 += dx * dy;
      m02 += dy * dy;
    }
  }
  m20 /= n;
  m11 /= n;
  m02 /= n;

  // larger eigenvalue's eigenvector, closed form for a symmetric 2x2
  const tr = m20 + m02;
  const det = m20 * m02 - m11 * m11;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  if (!(l1 > 0)) return null;
  let ux: number;
  let uy: number;
  if (Math.abs(m11) > 1e-9) {
    ux = l1 - m02;
    uy = m11;
  } else {
    // already axis-aligned
    ux = m20 >= m02 ? 1 : 0;
    uy = m20 >= m02 ? 0 : 1;
  }
  const un = Math.hypot(ux, uy) || 1;
  ux /= un;
  uy /= un;

  // 3) outer rim along each axis.
  //
  // NOT a percentile of the projected extent, which is the trap: for a disc
  // only ~0.3% of pixels lie beyond 0.98R, so even a 99.5th percentile lands
  // around 0.978R. Measured here that was an 11 px error against a 13 px ring
  // width — every sample fell almost a whole ring inward and the classifier
  // read averages of neighbouring wedges.
  //
  // Instead, scan the histogram DOWN from the outermost bin and stop once a
  // meaningful number of pixels has accumulated. That finds the actual edge
  // rather than a quantile of the interior, while still ignoring a handful of
  // stray bright pixels. Bins are scaled to the observed extent, so they are
  // sub-pixel regardless of image size.
  let maxU = 0;
  let maxV = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o]! < ON && data[o + 1]! < ON && data[o + 2]! < ON) continue;
      const dx = x - cx;
      const dy = y - cy;
      const pu = Math.abs(dx * ux + dy * uy);
      const pv = Math.abs(-dx * uy + dy * ux);
      if (pu > maxU) maxU = pu;
      if (pv > maxV) maxV = pv;
    }
  }
  if (maxU <= 4 || maxV <= 4) return null;

  const BINS = 1024;
  const hu = new Int32Array(BINS);
  const hv = new Int32Array(BINS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o]! < ON && data[o + 1]! < ON && data[o + 2]! < ON) continue;
      const dx = x - cx;
      const dy = y - cy;
      const pu = Math.abs(dx * ux + dy * uy);
      const pv = Math.abs(-dx * uy + dy * ux);
      hu[Math.min(BINS - 1, ((pu / maxU) * BINS) | 0)]!++;
      hv[Math.min(BINS - 1, ((pv / maxV) * BINS) | 0)]!++;
    }
  }
  const rim = (hist: Int32Array, maxP: number) => {
    const need = Math.max(8, n * 0.00003);
    let acc = 0;
    for (let i = BINS - 1; i >= 0; i--) {
      acc += hist[i]!;
      if (acc >= need) return ((i + 1) / BINS) * maxP;
    }
    return maxP;
  };
  const su = rim(hu, maxU);
  const sv = rim(hv, maxV);
  if (su <= 4 || sv <= 4) return null;

  return { cx, cy, ux, uy, su, sv, fill: n / (w * h) };
}

/**
 * Map a symbol-space polar coordinate to an image pixel.
 * `rho` is normalised so 1 is the outer rim; `theta` is radians.
 *
 * v is u rotated by a fixed +90°, so the basis is always right-handed and
 * the mapping never mirrors the symbol.
 */
export function polarToImage(e: Ellipse, rho: number, theta: number): [number, number] {
  const c = Math.cos(theta) * rho * e.su;
  const s = Math.sin(theta) * rho * e.sv;
  return [e.cx + c * e.ux - s * e.uy, e.cy + c * e.uy + s * e.ux];
}

/** Average colour in a small box, clamped to the image. */
export function sampleAt(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  rad: number,
): [number, number, number] {
  const x0 = Math.max(0, Math.round(x) - rad);
  const x1 = Math.min(w - 1, Math.round(x) + rad);
  const y0 = Math.max(0, Math.round(y) - rad);
  const y1 = Math.min(h - 1, Math.round(y) + rad);
  let r = 0;
  let g = 0;
  let b = 0;
  let c = 0;
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const o = (yy * w + xx) * 4;
      r += data[o]!;
      g += data[o + 1]!;
      b += data[o + 2]!;
      c++;
    }
  }
  if (c === 0) return [0, 0, 0];
  return [r / c, g / c, b / c];
}

/**
 * Angular centre of the sync ring's marker wedge, in radians.
 *
 * Sampled at `sectors * OVERSAMPLE` positions so the answer is good to a
 * fraction of a slot. Returns null if the marker is absent or smeared across
 * more than one plausible arc — a frame we should not trust.
 *
 * `isMarker` is supplied by the caller so this stays independent of the
 * palette and classifier.
 */
export function findMarkerAngle(
  e: Ellipse,
  rhoSync: number,
  sectors: number,
  sample: (x: number, y: number) => [number, number, number],
  isMarker: (rgb: [number, number, number]) => boolean,
  oversample = 8,
): number | null {
  const N = sectors * oversample;
  const hit: boolean[] = new Array(N);
  let count = 0;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * 2 * Math.PI;
    const [x, y] = polarToImage(e, rhoSync, th);
    hit[i] = isMarker(sample(x, y));
    if (hit[i]) count++;
  }
  // one wedge's worth of samples, give or take blur bleeding into neighbours
  if (count === 0 || count > oversample * 3) return null;

  // find the single contiguous run, treating the array as circular
  let start = -1;
  for (let i = 0; i < N; i++) {
    if (hit[i] && !hit[(i - 1 + N) % N]) {
      if (start !== -1) return null; // more than one run — ambiguous
      start = i;
    }
  }
  if (start === -1) return null;
  let len = 0;
  while (len < N && hit[(start + len) % N]) len++;
  const mid = start + (len - 1) / 2;
  return ((mid / N) * 2 * Math.PI) % (2 * Math.PI);
}
