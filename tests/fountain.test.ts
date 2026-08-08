// The fountain only works if sender and receiver build BIT-IDENTICAL soliton
// distributions and frame index sets — across JS engines (V8 vs
// JavaScriptCore) and across refactors. The golden vectors here pin the
// current outputs exactly; any engine or code change that shifts a single
// bit fails loudly instead of silently desynchronizing streams in the field.

import { describe, expect, it } from "vitest";
import { LTDecoder, LTEncoder, dlog, frameIndices, solitonCdf } from "../shared/fountain";
import { fnv1a, splitmix32 } from "../shared/protocol";

function deterministicBytes(n: number, seed: number): Uint8Array {
  const rnd = splitmix32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rnd() & 0xff;
  return out;
}

/** Round-trip a payload through encoder → (lossy channel) → decoder. */
function roundTrip(payloadLen: number, blockLen: number, loss: number, sessionId: number) {
  const payload = deterministicBytes(payloadLen, sessionId * 7 + 1);
  const enc = new LTEncoder(payload, blockLen, sessionId);
  const dec = new LTDecoder(enc.k, blockLen, sessionId, payloadLen);
  let seq = 0;
  let received = 0;
  while (!dec.isComplete) {
    if (seq > enc.k * 20 + 100) throw new Error(`no convergence after ${seq} frames`);
    const frame = enc.encode(seq);
    // deterministic pseudo-random loss so the test never flakes
    if (((Math.imul(seq, 2654435761) >>> 16) % 1000) / 1000 >= loss) {
      dec.addFrame(seq, frame);
      received++;
    }
    seq++;
  }
  const out = dec.assemble();
  expect(out).not.toBeNull();
  expect(out!.length).toBe(payload.length);
  expect(Buffer.from(out!).equals(Buffer.from(payload))).toBe(true);
  return { k: enc.k, received, overhead: received / enc.k };
}

describe("determinism goldens (cross-engine canary)", () => {
  it("dlog matches pinned IEEE-754-exact values", () => {
    expect(dlog(1)).toBe(0);
    expect(dlog(2)).toBe(0.6931471805599453);
    expect(dlog(0.75)).toBe(-0.2876820724517809);
    expect(dlog(1.5)).toBe(0.4054651081081644);
    expect(dlog(10)).toBe(2.3025850929940455);
    expect(dlog(726)).toBe(6.587550014824796);
    expect(dlog(2902)).toBe(7.973155433444133);
    expect(dlog(131070)).toBe(11.78348681061359);
  });

  it("dlog stays within 1e-12 relative of Math.log across the used range", () => {
    for (let k = 2; k <= 1 << 17; k = Math.ceil(k * 1.7)) {
      for (const x of [k / 0.5, k * 0.31, Math.sqrt(k)]) {
        const rel = Math.abs(dlog(x) - Math.log(x)) / Math.max(1e-300, Math.abs(Math.log(x)));
        expect(rel).toBeLessThan(1e-12);
      }
    }
  });

  it("solitonCdf matches pinned vectors", () => {
    expect([...solitonCdf(1)]).toEqual([1]);
    expect([...solitonCdf(10)]).toEqual([
      0.14790585169041506, 0.5546469438390564, 0.7025527955294715, 0.7826684651951129,
      0.8344355132867582, 0.8714119762093621, 0.8995845193884888, 0.9220345147343553,
      0.9405227461956571, 1,
    ]);
    // larger k pinned by spot values + FNV over the raw float64 bytes
    // (typed arrays are little-endian on every platform we run on)
    const cdf100 = solitonCdf(100);
    expect(cdf100[0]).toBe(0.0480695617459692);
    expect(cdf100[1]).toBe(0.44989465834094394);
    expect(cdf100[50]).toBe(0.9926671715308469);
    expect(fnv1a(new Uint8Array(cdf100.buffer))).toBe(0xa9c02340);
    const cdf1451 = solitonCdf(1451);
    expect(cdf1451[0]).toBe(0.018340328770940766);
    expect(cdf1451[1]).toBe(0.45136037839072324);
    expect(cdf1451[725]).toBe(0.9994161847310812);
    expect(fnv1a(new Uint8Array(cdf1451.buffer))).toBe(0x22fd9ffc);
    const cdf65535 = solitonCdf(65535);
    expect(cdf65535[0]).toBe(0.004369584591314389);
    expect(cdf65535[1]).toBe(0.47962832844877945);
    expect(cdf65535[32767]).toBe(0.9999855629287365);
    expect(fnv1a(new Uint8Array(cdf65535.buffer))).toBe(0x4836788b);
  });

  it("frameIndices matches pinned vectors", () => {
    const cdf = solitonCdf(1451);
    const idx = (seq: number) => frameIndices(1451, cdf, 0x0bee, seq);
    const fnvOf = (a: number[]) => fnv1a(new Uint8Array(Uint32Array.from(a).buffer));
    expect(idx(2)).toEqual([714, 951, 1197]);
    expect(idx(4)).toEqual([32, 105]);
    expect(idx(5)).toEqual([764]);
    expect(idx(6)).toEqual([677, 376]);
    expect(idx(7)).toEqual([517, 1282]);
    const s0 = idx(0);
    expect(s0.length).toBe(146);
    expect(fnvOf(s0)).toBe(0x1749cbb2);
    const s1 = idx(1);
    expect(s1.length).toBe(16);
    expect(fnvOf(s1)).toBe(0x479c1479);
    const s3 = idx(3);
    expect(s3.length).toBe(48);
    expect(fnvOf(s3)).toBe(0x70522041);
    expect(frameIndices(1, solitonCdf(1), 1, 0)).toEqual([0]);
    expect(frameIndices(2, solitonCdf(2), 0xffff, 5)).toEqual([1, 0]);
  });

  it("frameIndices never repeats or exceeds bounds", () => {
    const k = 337;
    const cdf = solitonCdf(k);
    for (let seq = 0; seq < 500; seq++) {
      const idx = frameIndices(k, cdf, 0x1234, seq);
      expect(idx.length).toBeGreaterThan(0);
      expect(idx.length).toBeLessThanOrEqual(k);
      const set = new Set(idx);
      expect(set.size).toBe(idx.length);
      for (const b of idx) {
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(k);
      }
    }
  });
});

describe("encode → decode round trip", () => {
  it("survives 0% / 30% / 50% loss bit-exact", () => {
    for (const loss of [0, 0.3, 0.5]) {
      const { overhead } = roundTrip(100 * 1024, 1445, loss, 0x0bee);
      expect(overhead).toBeGreaterThanOrEqual(1);
      expect(overhead).toBeLessThan(1.6); // deterministic seeds; generous band
    }
  });

  it("handles 1 MB at v40-sized blocks with loss", () => {
    const { k, overhead } = roundTrip(1024 * 1024, 2933, 0.3, 0x7a7a);
    expect(k).toBe(Math.ceil((1024 * 1024) / 2933));
    expect(overhead).toBeLessThan(1.6);
  });

  it("handles tiny payloads and k=1", () => {
    roundTrip(1, 1445, 0, 3); // single byte, single block
    roundTrip(10, 3, 0.3, 4); // blockLen not a multiple of 4, partial last block
    roundTrip(1445, 1445, 0, 5); // payload exactly one block
    roundTrip(1446, 1445, 0, 6); // one byte spills into a second block
  });

  it("assemble() trims zero-padding of the final partial block", () => {
    const payload = deterministicBytes(1000, 42);
    const enc = new LTEncoder(payload, 300, 9);
    expect(enc.k).toBe(4);
    const dec = new LTDecoder(4, 300, 9, 1000);
    for (let seq = 0; !dec.isComplete; seq++) dec.addFrame(seq, enc.encode(seq));
    const out = dec.assemble()!;
    expect(out.length).toBe(1000);
    expect(Buffer.from(out).equals(Buffer.from(payload))).toBe(true);
  });
});

describe("decoder bookkeeping", () => {
  it("counts duplicates separately and ignores them", () => {
    const payload = deterministicBytes(10_000, 8);
    const enc = new LTEncoder(payload, 500, 11);
    const dec = new LTDecoder(enc.k, 500, 11, payload.length);
    dec.addFrame(0, enc.encode(0));
    dec.addFrame(0, enc.encode(0));
    expect(dec.framesNew).toBe(1);
    expect(dec.framesDup).toBe(1);
  });

  it("assemble() is null until complete, stable after", () => {
    const payload = deterministicBytes(10_000, 8);
    const enc = new LTEncoder(payload, 500, 12);
    const dec = new LTDecoder(enc.k, 500, 12, payload.length);
    expect(dec.assemble()).toBeNull();
    let seq = 0;
    while (!dec.isComplete) dec.addFrame(seq, enc.encode(seq++));
    const first = dec.assemble()!;
    dec.addFrame(seq, enc.encode(seq)); // late frame after completion
    expect(dec.isComplete).toBe(true);
    expect(Buffer.from(dec.assemble()!).equals(Buffer.from(first))).toBe(true);
  });
});

describe("protocol size caps", () => {
  it("rejects block counts past the u16 header field with a clear error", () => {
    expect(() => new LTEncoder(new Uint8Array(70_000), 1, 1)).toThrow(/u16/);
  });

  it("rejects out-of-range block lengths", () => {
    expect(() => new LTEncoder(new Uint8Array(10), 0, 1)).toThrow(/block length/);
    expect(() => new LTEncoder(new Uint8Array(10), 0x10000, 1)).toThrow(/block length/);
  });

  it("accepts the documented maximum geometry", () => {
    // k = 65535 exactly, at a small block size to keep the test fast
    const enc = new LTEncoder(new Uint8Array(65_535 * 8), 8, 2);
    expect(enc.k).toBe(65_535);
    expect(enc.encode(0).length).toBe(8);
  });
});
