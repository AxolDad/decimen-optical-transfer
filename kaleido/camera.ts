// EXPERIMENT — a synthetic camera, so "can a phone decode this?" can be
// answered with a measurement instead of a hope.
//
// Loopback reads the pixels it drew. A phone does four things to them before
// the decoder ever sees them, and each is a separate way to fail:
//
//   1. PERSPECTIVE. Nobody holds a phone perfectly square to a screen. The
//      circle becomes an ellipse, off-centre, at unknown scale and rotation.
//   2. CHROMA SUBSAMPLING. Phone pipelines deliver 4:2:0 — colour resolution
//      is HALF the luma resolution in each axis. This is the one the design
//      notes flag as structural rather than solvable, because the QR path is
//      immune to it (luma only) and a colour symbology is not.
//   3. OPTICAL BLUR. Defocus and motion, applied after subsampling the same
//      way a real sensor stack does.
//   4. SENSOR NOISE. Per-channel, at sample time.
//
// Everything here degrades the image. Nothing here helps the decoder.

export interface CameraOpts {
  /** output frame size in px */
  out: number;
  /** 0 = square on, 1 = a hard oblique angle */
  tilt: number;
  /** whole-frame rotation in radians */
  rotate: number;
  /** symbol's share of the frame's smaller dimension, 0..1 */
  fill: number;
  /** apply 4:2:0 chroma subsampling */
  chroma420: boolean;
  /** box blur radius in px, 0 = none */
  blur: number;
  /** per-channel uniform noise amplitude */
  noise: number;
}

/** Invert a 3x3 given row-major, returning row-major. */
function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [
    number, number, number, number, number, number, number, number, number,
  ];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const s = 1 / det;
  return [
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

/** Homography taking the unit square to an arbitrary quad (closed form). */
function squareToQuad(q: number[]): number[] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q as [
    number, number, number, number, number, number, number, number,
  ];
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  }
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ];
}

/**
 * Photograph `src` (a square symbol canvas) into an `out`×`out` frame.
 * Returns freshly allocated ImageData; `src` is not modified.
 */
export function photograph(src: ImageData, o: CameraOpts): ImageData {
  const W = o.out;
  const dst = new ImageData(W, W);
  const D = dst.data;

  // Destination quad: a square, shrunk to `fill`, rotated, then foreshortened
  // on one edge by `tilt` to stand in for an off-axis viewpoint.
  const half = (W * o.fill) / 2;
  const cxo = W / 2;
  const cyo = W / 2;
  const k = 1 - 0.55 * o.tilt; // far edge shrinks
  const corners: [number, number][] = [
    [-half, -half * k],
    [half, -half * k],
    [half, half],
    [-half, half],
  ];
  const ca = Math.cos(o.rotate);
  const sa = Math.sin(o.rotate);
  const quad: number[] = [];
  for (const [x, y] of corners) {
    // tilt also pushes the top edge inward horizontally
    const xx = x * (1 - 0.25 * o.tilt * (y < 0 ? 1 : 0));
    quad.push(cxo + xx * ca - y * sa, cyo + xx * sa + y * ca);
  }

  const Hm = squareToQuad(quad);
  const Hi = inv3(Hm);
  const S = src.data;
  const sw = src.width;
  const sh = src.height;

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const w = Hi[6]! * x + Hi[7]! * y + Hi[8]!;
      if (Math.abs(w) < 1e-12) continue;
      const u = (Hi[0]! * x + Hi[1]! * y + Hi[2]!) / w;
      const v = (Hi[3]! * x + Hi[4]! * y + Hi[5]!) / w;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      // bilinear, because a camera does not sample on the source grid
      const fx = u * (sw - 1);
      const fy = v * (sh - 1);
      const x0 = fx | 0;
      const y0 = fy | 0;
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const o00 = (y0 * sw + x0) * 4;
      const o10 = (y0 * sw + x1) * 4;
      const o01 = (y1 * sw + x0) * 4;
      const o11 = (y1 * sw + x1) * 4;
      const d = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = S[o00 + c]! * (1 - tx) + S[o10 + c]! * tx;
        const b = S[o01 + c]! * (1 - tx) + S[o11 + c]! * tx;
        D[d + c] = a * (1 - ty) + b * ty;
      }
      D[d + 3] = 255;
    }
  }

  if (o.chroma420) subsample420(D, W, W);
  if (o.blur > 0) boxBlur(D, W, W, o.blur);
  if (o.noise > 0) addNoise(D, o.noise);
  return dst;
}

/**
 * 4:2:0 — full-resolution luma, quarter-resolution chroma. Averages Cb/Cr
 * over each 2x2 block and writes it back to all four pixels, which is exactly
 * what makes fine colour detail unrecoverable regardless of decoder effort.
 */
export function subsample420(d: Uint8ClampedArray, w: number, h: number): void {
  const Y = new Float32Array(w * h);
  const Cb = new Float32Array(w * h);
  const Cr = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = d[p]!;
    const g = d[p + 1]!;
    const b = d[p + 2]!;
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      let sb = 0;
      let sr = 0;
      let n = 0;
      for (let dy = 0; dy < 2 && y + dy < h; dy++) {
        for (let dx = 0; dx < 2 && x + dx < w; dx++) {
          const i = (y + dy) * w + x + dx;
          sb += Cb[i]!;
          sr += Cr[i]!;
          n++;
        }
      }
      const mb = sb / n;
      const mr = sr / n;
      for (let dy = 0; dy < 2 && y + dy < h; dy++) {
        for (let dx = 0; dx < 2 && x + dx < w; dx++) {
          const i = (y + dy) * w + x + dx;
          Cb[i] = mb;
          Cr[i] = mr;
        }
      }
    }
  }
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const yy = Y[i]!;
    const cb = Cb[i]!;
    const cr = Cr[i]!;
    d[p] = yy + 1.402 * cr;
    d[p + 1] = yy - 0.344136 * cb - 0.714136 * cr;
    d[p + 2] = yy + 1.772 * cb;
  }
}

export function boxBlur(d: Uint8ClampedArray, w: number, h: number, rad: number): void {
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const o = (yy * w + xx) * 4;
          r += src[o]!;
          g += src[o + 1]!;
          b += src[o + 2]!;
          n++;
        }
      }
      const p = (y * w + x) * 4;
      d[p] = r / n;
      d[p + 1] = g / n;
      d[p + 2] = b / n;
    }
  }
}

export function addNoise(d: Uint8ClampedArray, amp: number): void {
  for (let p = 0; p < d.length; p += 4) {
    d[p] = d[p]! + (Math.random() * 2 - 1) * amp;
    d[p + 1] = d[p + 1]! + (Math.random() * 2 - 1) * amp;
    d[p + 2] = d[p + 2]! + (Math.random() * 2 - 1) * amp;
  }
}
