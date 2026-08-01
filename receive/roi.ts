// ROI tracking math — pure and unit-tested. Once a code is decoded, the
// next frames are cropped to its neighborhood: measured ~3× faster decode
// than full-frame, and the capture copy shrinks by the same factor.
//
// Constraints baked in:
// - coordinates and sizes stay EVEN, so the rect is valid for chroma-
//   subsampled VideoFrame.copyTo (NV12/I420 need 2-pixel alignment);
// - width/height quantize UP to /32 so the grab canvas and ImageData pools
//   aren't re-allocated on every one-pixel hand tremor;
// - the margin is generous (default 25% of the code's larger side) so the
//   code stays inside the crop across frame-to-frame movement.

export interface Pt {
  x: number;
  y: number;
}

export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bbox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Axis-aligned bounds of a decoded symbol's corners — the symbol's TRUE
 * center and size. Cell identity must be matched on this, never on the crop
 * rect: crops clamp at frame edges, which squeezes neighboring crops'
 * centers together (a near-fullscreen 2×2 grid merged its rows that way). */
export function bboxOfCorners(corners: Pt[]): Bbox | null {
  if (corners.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 8 || h < 8) return null; // degenerate position — don't trust it
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h };
}

export function roiFromCorners(
  corners: Pt[],
  vw: number,
  vh: number,
  marginFrac = 0.25,
  quant = 32,
): Roi | null {
  const b = bboxOfCorners(corners);
  if (!b) return null;
  const m = marginFrac * Math.max(b.w, b.h);
  let w = Math.ceil((b.w + 2 * m) / quant) * quant;
  let h = Math.ceil((b.h + 2 * m) / quant) * quant;
  w = Math.min(w, vw & ~1);
  h = Math.min(h, vh & ~1);
  let x = Math.round(b.cx - w / 2);
  let y = Math.round(b.cy - h / 2);
  x = Math.max(0, Math.min(x, vw - w)) & ~1;
  y = Math.max(0, Math.min(y, vh - h)) & ~1;
  return { x, y, w, h };
}

/** True when a crop no longer saves anything over the full frame. */
export function coversFrame(roi: Roi, vw: number, vh: number): boolean {
  return roi.w >= (vw & ~1) && roi.h >= (vh & ~1);
}
