// EXPERIMENT — kaleidoscope symbology (see docs/KALEIDOSCOPE.md).
//
// Data rendered as a spinning polar mandala instead of a QR code: concentric
// rings of colored wedges, 3 bits per wedge (8-color palette). The fountain
// layer, protocol header, and envelope are reused UNCHANGED — this file only
// defines how frame bytes become colored cells and back.
//
// Frame anatomy (rings, innermost → outermost):
//   ring 0            sync ring    — fixed pattern + one marker wedge; the
//                                    whole frame rotates by `seq % sectors`
//                                    slots, and the marker's position is how
//                                    a decoder recovers that phase with no
//                                    other context (the spin IS the sync).
//   rings 1..n-2      data rings   — 3 bits per wedge
//   ring n-1          calibration  — all 8 palette colors cycling; a decoder
//                                    samples it per frame to build its color
//                                    classifier (screen/camera agnostic).
// Every ring i is additionally offset by SPIRAL·i slots (constant), which
// turns straight spokes into spirals — pure aesthetics, zero cost, since the
// decoder applies the same rule.
//
// Frame bytes = [20 B protocol header][block][u32 FNV over the preceding],
// exactly filling the data cells. QR gave us per-frame integrity for free;
// here the trailing FNV supplies it: a corrupt frame is discarded whole and
// the fountain absorbs the erasure (same model as QR ECC-L + disposal).

// Saturated RGB-cube corners (black excluded — it's the background) plus
// orange: minimum pairwise distance 127, verified by the test suite. Muted
// "tasteful" palettes fail exactly where it hurts — yellow/orange collapsed
// to d≈76 under noise — so the kaleidoscope stays neon.
export const BITS_PER_CELL = 3;
export const PALETTE: [number, number, number][] = [
  [255, 255, 255], // 0 white
  [255, 0, 0], // 1 red
  [255, 255, 0], // 2 yellow
  [0, 255, 0], // 3 green (sync marker)
  [0, 255, 255], // 4 cyan
  [0, 0, 255], // 5 blue
  [255, 0, 255], // 6 magenta
  [255, 128, 0], // 7 orange
];
export const MARKER = 3; // sync-ring marker color index
export const SYNC_A = 0; // sync-ring alternating colors
export const SYNC_B = 5;
export const SPIRAL = 3; // extra slots of rotation per ring (constant)

export interface KaleidoGeometry {
  rings: number; // total rings including sync + calibration
  sectors: number;
}

export const dataRings = (g: KaleidoGeometry) => g.rings - 2;
export const dataCells = (g: KaleidoGeometry) => dataRings(g) * g.sectors;

/** Whole frame bytes that fit the data rings (header + block + fnv). */
export const capacityBytes = (g: KaleidoGeometry) =>
  Math.floor((dataCells(g) * BITS_PER_CELL) / 8);

/** Which angular slot ring `ring`'s pattern-sector `j` lands in, given the
 * frame's global phase (seq % sectors). Same rule for every ring. */
export const slotOf = (g: KaleidoGeometry, ring: number, j: number, phase: number) =>
  (j + phase + ring * SPIRAL) % g.sectors;

/** Inverse of slotOf: which pattern-sector sits at angular slot `k`. */
export const sectorAt = (g: KaleidoGeometry, ring: number, k: number, phase: number) =>
  (((k - phase - ring * SPIRAL) % g.sectors) + g.sectors) % g.sectors;

/** Sync-ring pattern before rotation: marker at 0, then alternating pair. */
export const syncColor = (j: number) => (j === 0 ? MARKER : j % 2 ? SYNC_A : SYNC_B);

/** Recover the global phase from the sync ring's sampled color indices
 * (indexed by angular slot). Returns -1 if there is no unambiguous marker. */
export function findPhase(slotColors: number[]): number {
  let at = -1;
  for (let k = 0; k < slotColors.length; k++) {
    if (slotColors[k] === MARKER) {
      if (at !== -1) return -1; // two markers → don't trust the frame
      at = k;
    }
  }
  return at; // marker sits at slot (0 + phase) → phase = its slot
}

/** Pack bytes into per-cell palette indices, MSB-first, zero-padded. */
export function bytesToCells(bytes: Uint8Array, g: KaleidoGeometry): Uint8Array {
  const cells = new Uint8Array(dataCells(g));
  for (let c = 0; c < cells.length; c++) {
    const bit = c * BITS_PER_CELL;
    const byte = bit >> 3;
    const shift = bit & 7;
    // read 3 bits possibly spanning a byte boundary
    const hi = bytes[byte] ?? 0;
    const lo = bytes[byte + 1] ?? 0;
    cells[c] = (((hi << 8) | lo) >> (13 - shift)) & 0b111;
  }
  return cells;
}

export function cellsToBytes(cells: Uint8Array, g: KaleidoGeometry): Uint8Array {
  const bytes = new Uint8Array(capacityBytes(g));
  for (let c = 0; c < cells.length; c++) {
    const bit = c * BITS_PER_CELL;
    const byte = bit >> 3;
    const shift = bit & 7;
    const v = (cells[c]! & 0b111) << (13 - shift);
    if (byte < bytes.length) bytes[byte] = bytes[byte]! | (v >> 8);
    if ((v & 0xff) !== 0 && byte + 1 < bytes.length) {
      bytes[byte + 1] = bytes[byte + 1]! | (v & 0xff);
    }
  }
  return bytes;
}

/** Nearest palette entry by squared RGB distance. */
export function classify(r: number, gr: number, b: number, centroids: number[][]): number {
  let best = 0;
  let bestD = Infinity;
  for (let p = 0; p < centroids.length; p++) {
    const c = centroids[p]!;
    const d = (r - c[0]!) ** 2 + (gr - c[1]!) ** 2 + (b - c[2]!) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
