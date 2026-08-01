// Grid layout — pure and unit-tested.
//
// A display frame can carry 1, 2 (side by side), or 4 (2×2) QR codes; each
// code is an independent self-describing fountain frame with its own seq, so
// the PROTOCOL needs no changes at all — the grid only multiplies how many
// frames each refresh carries. Every code keeps its spec-required 4-module
// quiet zone: 4 around the tile edge, 4+4 between neighbors.

export const MARGIN = 4; // quiet-zone modules at the tile edge
export const GAP = 8; // modules between adjacent codes (4 + 4 quiet zones)

export interface GridLayout {
  cols: number;
  rows: number;
  w: number; // tile width in modules
  h: number; // tile height in modules
  offsets: { x: number; y: number }[]; // top-left module of each code
}

export function gridLayout(moduleCount: number, codes: 1 | 2 | 4): GridLayout {
  const cols = codes === 1 ? 1 : 2;
  const rows = codes === 4 ? 2 : 1;
  const w = 2 * MARGIN + cols * moduleCount + (cols - 1) * GAP;
  const h = 2 * MARGIN + rows * moduleCount + (rows - 1) * GAP;
  const offsets: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      offsets.push({ x: MARGIN + c * (moduleCount + GAP), y: MARGIN + r * (moduleCount + GAP) });
    }
  }
  return { cols, rows, w, h, offsets };
}
