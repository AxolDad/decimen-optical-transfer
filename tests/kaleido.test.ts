import { describe, expect, it } from "vitest";
import {
  MARKER,
  PALETTE,
  bytesToCells,
  capacityBytes,
  cellsToBytes,
  classify,
  dataCells,
  findPhase,
  sectorAt,
  slotOf,
  syncColor,
  type KaleidoGeometry,
} from "../kaleido/symbol";

const G: KaleidoGeometry = { rings: 26, sectors: 64 };

describe("kaleido symbol packing", () => {
  it("computes capacity from data rings only", () => {
    expect(dataCells(G)).toBe(24 * 64);
    expect(capacityBytes(G)).toBe(Math.floor((24 * 64 * 3) / 8));
  });

  it("bytes → cells → bytes is exact", () => {
    const bytes = new Uint8Array(capacityBytes(G));
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 89 + 3) & 0xff;
    const cells = bytesToCells(bytes, G);
    expect(cells.length).toBe(dataCells(G));
    for (const c of cells) expect(c).toBeLessThan(8);
    const back = cellsToBytes(cells, G);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
  });

  it("slotOf and sectorAt are inverses for every ring and phase", () => {
    for (const ring of [0, 1, 12, G.rings - 1]) {
      for (const phase of [0, 1, 31, 63]) {
        for (let j = 0; j < G.sectors; j++) {
          const k = slotOf(G, ring, j, phase);
          expect(sectorAt(G, ring, k, phase)).toBe(j);
        }
      }
    }
  });

  it("recovers the phase from the sync ring at every rotation", () => {
    for (let phase = 0; phase < G.sectors; phase++) {
      const slots = new Array<number>(G.sectors).fill(-1);
      for (let j = 0; j < G.sectors; j++) {
        slots[slotOf(G, 0, j, phase)] = syncColor(j);
      }
      expect(findPhase(slots)).toBe(phase);
    }
  });

  it("rejects ambiguous sync rings", () => {
    const slots = new Array<number>(G.sectors).fill(0);
    expect(findPhase(slots)).toBe(-1); // no marker
    slots[3] = MARKER;
    slots[40] = MARKER;
    expect(findPhase(slots)).toBe(-1); // two markers
  });

  it("palette colors are mutually far apart and classify exactly", () => {
    const centroids = PALETTE as unknown as number[][];
    for (let a = 0; a < 8; a++) {
      for (let b = a + 1; b < 8; b++) {
        const [r1, g1, b1] = PALETTE[a]!;
        const [r2, g2, b2] = PALETTE[b]!;
        const d = Math.hypot(r1 - r2, g1 - g2, b1 - b2);
        expect(d).toBeGreaterThan(90); // classification margin
      }
      const [r, g, b] = PALETTE[a]!;
      expect(classify(r, g, b, centroids)).toBe(a);
      // survives ±35 noise on every channel
      expect(classify(r + 35, g - 35, b + 35, centroids)).toBe(a);
    }
  });
});
