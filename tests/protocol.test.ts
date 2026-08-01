import { describe, expect, it } from "vitest";
import { HEADER_LEN, fnv1a, packFrame, parseFrame, splitmix32 } from "../shared/protocol";
import type { FrameHeader } from "../shared/protocol";

const HEADER: FrameHeader = {
  sessionId: 0xbeef,
  seq: 123456,
  k: 1451,
  blockLen: 1445,
  totalLen: 2 * 1024 * 1024,
  payloadFnv: 0xdeadbeef,
};

function makeBlock(len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i * 13 + 7) & 0xff;
  return b;
}

describe("packFrame / parseFrame", () => {
  it("round-trips every header field and the payload", () => {
    const block = makeBlock(HEADER.blockLen);
    const bytes = packFrame(HEADER, block);
    expect(bytes.length).toBe(HEADER_LEN + block.length);
    const parsed = parseFrame(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.header).toEqual(HEADER);
    expect(Buffer.from(parsed!.block).equals(Buffer.from(block))).toBe(true);
  });

  it("round-trips boundary field values", () => {
    const h: FrameHeader = {
      sessionId: 0xffff,
      seq: 0xffffffff,
      k: 0xffff,
      blockLen: 8,
      totalLen: 0xffffffff,
      payloadFnv: 0xffffffff,
    };
    const parsed = parseFrame(packFrame(h, makeBlock(8)));
    expect(parsed!.header).toEqual(h);
  });

  it("parses frames sitting at a nonzero byteOffset in a larger buffer", () => {
    // QR decoders often hand back subarray views; the DataView math must
    // respect byteOffset or every field silently misparses.
    const frame = packFrame(HEADER, makeBlock(HEADER.blockLen));
    const padded = new Uint8Array(frame.length + 7);
    padded.set(frame, 3);
    const view = padded.subarray(3, 3 + frame.length);
    const parsed = parseFrame(view);
    expect(parsed).not.toBeNull();
    expect(parsed!.header).toEqual(HEADER);
  });

  it("rejects malformed input instead of throwing", () => {
    const good = packFrame(HEADER, makeBlock(HEADER.blockLen));
    expect(parseFrame(new Uint8Array(0))).toBeNull();
    expect(parseFrame(good.subarray(0, HEADER_LEN))).toBeNull(); // header only
    expect(parseFrame(good.subarray(0, good.length - 1))).toBeNull(); // truncated
    const badMagic = good.slice();
    badMagic[0] = 0x00;
    expect(parseFrame(badMagic)).toBeNull();
    const badMagic2 = good.slice();
    badMagic2[1] = 0xff;
    expect(parseFrame(badMagic2)).toBeNull();
    const v1Frame = good.slice();
    v1Frame[1] = 0x0c; // protocol v1 (raw payload, no envelope) — not ours
    expect(parseFrame(v1Frame)).toBeNull();
    const zeroK = good.slice();
    zeroK[8] = 0;
    zeroK[9] = 0;
    expect(parseFrame(zeroK)).toBeNull();
    const extra = new Uint8Array(good.length + 1);
    extra.set(good);
    expect(parseFrame(extra)).toBeNull(); // length must match blockLen exactly
  });
});

describe("fnv1a goldens", () => {
  it("matches pinned vectors (incl. the published FNV-1a test vector)", () => {
    expect(fnv1a(new Uint8Array(0))).toBe(0x811c9dc5);
    expect(fnv1a(new Uint8Array([0]))).toBe(0x050c5d1f);
    expect(fnv1a(new TextEncoder().encode("hello"))).toBe(0x4f9f2cab);
    const pat = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) pat[i] = (i * 31) & 0xff;
    expect(fnv1a(pat)).toBe(0x600aa9c5);
  });
});

describe("splitmix32 goldens", () => {
  it("matches pinned sequences", () => {
    const r0 = splitmix32(0);
    expect([r0(), r0(), r0(), r0()]).toEqual([1684164658, 3653269916, 2939563536, 2141751570]);
    const rdb = splitmix32(0xdeadbeef | 0);
    expect([rdb(), rdb(), rdb(), rdb()]).toEqual([46217145, 304148291, 1711218402, 2692075039]);
  });

  it("returns unsigned 32-bit values", () => {
    const r = splitmix32(0x12345678);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
