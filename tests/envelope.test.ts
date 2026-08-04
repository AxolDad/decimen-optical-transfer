import { describe, expect, it } from "vitest";
import { FLAG_DEFLATE, deflate, inflate, packEnvelope, parseEnvelope } from "../shared/envelope";
import { sameStream, type FrameHeader } from "../shared/protocol";

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 5) & 0xff);

describe("envelope", () => {
  it("round-trips metadata and data", () => {
    const meta = { name: "Ünïcode – файл 名前.tar.gz", mime: "application/gzip", size: 12345 };
    const data = bytes(999);
    const env = packEnvelope(meta, data, 0);
    const parsed = parseEnvelope(env)!;
    expect(parsed).not.toBeNull();
    expect(parsed.flags).toBe(0);
    expect(parsed.meta).toEqual(meta);
    expect(Buffer.from(parsed.data).equals(Buffer.from(data))).toBe(true);
  });

  it("carries flags and handles empty files", () => {
    const env = packEnvelope({ name: "empty.bin", mime: "application/octet-stream", size: 0 }, new Uint8Array(0), FLAG_DEFLATE);
    const parsed = parseEnvelope(env)!;
    expect(parsed.flags).toBe(FLAG_DEFLATE);
    expect(parsed.data.length).toBe(0);
  });

  it("rejects malformed envelopes", () => {
    expect(parseEnvelope(new Uint8Array(0))).toBeNull();
    expect(parseEnvelope(new Uint8Array([0, 5, 0]))).toBeNull(); // metaLen past end
    const env = packEnvelope({ name: "a", mime: "b", size: 1 }, bytes(1), 0);
    env[3] = 0x7b; // corrupt JSON start stays '{' — corrupt deeper instead
    const bad = packEnvelope({ name: "a", mime: "b", size: 1 }, bytes(1), 0).slice();
    bad[4] = 0x00; // breaks JSON parse
    expect(parseEnvelope(bad)).toBeNull();
    // meta JSON valid but wrong shape
    const metaBytes = new TextEncoder().encode(JSON.stringify({ nope: true }));
    const shaped = new Uint8Array(3 + metaBytes.length);
    shaped[0] = 0;
    shaped[1] = metaBytes.length & 0xff;
    shaped[2] = metaBytes.length >> 8;
    shaped.set(metaBytes, 3);
    expect(parseEnvelope(shaped)).toBeNull();
  });

  it("deflate/inflate round-trips and actually compresses", async () => {
    const compressible = new TextEncoder().encode("the payload travels as light. ".repeat(4000));
    const squeezed = await deflate(compressible);
    expect(squeezed).not.toBeNull();
    expect(squeezed!.length).toBeLessThan(compressible.length / 4);
    const back = await inflate(squeezed!);
    expect(Buffer.from(back).equals(Buffer.from(compressible))).toBe(true);
  });

  it("refuses a decompression bomb instead of exhausting memory", async () => {
    // 8 MB of zeros compresses to a few KB — the shape of a hostile stream
    // that declares a small size and expands without bound.
    const bomb = await deflate(new Uint8Array(8 * 1024 * 1024));
    expect(bomb).not.toBeNull();
    expect(bomb!.length).toBeLessThan(64 * 1024);
    await expect(inflate(bomb!, 1024)).rejects.toThrow(/limit/);
    // the same data inflates fine when the cap actually allows it
    const ok = await inflate(bomb!, 8 * 1024 * 1024);
    expect(ok.length).toBe(8 * 1024 * 1024);
  });

  it("allows output exactly at the cap", async () => {
    const data = bytes(5000);
    const squeezed = (await deflate(data))!;
    const out = await inflate(squeezed, data.length);
    expect(out.length).toBe(data.length);
  });
});

describe("sameStream", () => {
  const h: FrameHeader = {
    sessionId: 7,
    seq: 0,
    k: 100,
    blockLen: 480,
    totalLen: 48_000,
    payloadFnv: 0xabcdef01,
  };
  it("ignores seq but catches any identity change", () => {
    expect(sameStream(h, { ...h, seq: 999 })).toBe(true);
    expect(sameStream(h, { ...h, sessionId: 8 })).toBe(false);
    expect(sameStream(h, { ...h, k: 101 })).toBe(false);
    expect(sameStream(h, { ...h, blockLen: 481 })).toBe(false);
    expect(sameStream(h, { ...h, totalLen: 48_001 })).toBe(false);
    // the session-id collision case: same id, different payload
    expect(sameStream(h, { ...h, payloadFnv: 0xabcdef02 })).toBe(false);
  });
});
