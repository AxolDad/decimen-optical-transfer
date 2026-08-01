import { describe, expect, it } from "vitest";
import { FLAG_SEALED, isSealed, randomKeyHex, seal, unseal } from "../shared/crypto";
import { FLAG_DEFLATE, packEnvelope, parseEnvelope } from "../shared/envelope";

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 41 + 11) & 0xff);

describe("sealed streams", () => {
  it("round-trips with a raw hex key", async () => {
    const key = randomKeyHex();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const envelope = packEnvelope({ name: "secret.pdf", mime: "application/pdf", size: 4096 }, bytes(4096), 0);
    const wire = await seal(envelope, key);
    expect(isSealed(wire)).toBe(true);
    expect(wire[0]! & FLAG_SEALED).toBe(FLAG_SEALED);
    const opened = await unseal(wire, key);
    expect(Buffer.from(opened).equals(Buffer.from(envelope))).toBe(true);
    // and the inner envelope still parses
    expect(parseEnvelope(opened)!.meta.name).toBe("secret.pdf");
  });

  it("round-trips with a passphrase (PBKDF2 path)", async () => {
    const envelope = packEnvelope({ name: "n", mime: "m", size: 64 }, bytes(64), FLAG_DEFLATE);
    const wire = await seal(envelope, "correct horse battery staple");
    const opened = await unseal(wire, "correct horse battery staple");
    expect(Buffer.from(opened).equals(Buffer.from(envelope))).toBe(true);
  });

  it("rejects a wrong key cleanly, never yields garbage", async () => {
    const envelope = packEnvelope({ name: "n", mime: "m", size: 64 }, bytes(64), 0);
    const wire = await seal(envelope, "right passphrase");
    await expect(unseal(wire, "wrong passphrase")).rejects.toThrow(/wrong key/);
    const hexWire = await seal(envelope, randomKeyHex());
    await expect(unseal(hexWire, randomKeyHex())).rejects.toThrow(/wrong key/);
  });

  it("rejects tampered ciphertext (GCM integrity)", async () => {
    const wire = await seal(packEnvelope({ name: "n", mime: "m", size: 64 }, bytes(64), 0), "k".repeat(20));
    const tampered = wire.slice();
    tampered[tampered.length - 5]! ^= 0x01;
    await expect(unseal(tampered, "k".repeat(20))).rejects.toThrow(/wrong key/);
  });

  it("no plaintext (incl. filename) survives in the wire bytes", async () => {
    const name = "TOPSECRET-project-plan.docx";
    const envelope = packEnvelope({ name, mime: "application/msword", size: 512 }, bytes(512), 0);
    const wire = await seal(envelope, randomKeyHex());
    const hay = Buffer.from(wire).toString("latin1");
    expect(hay.includes(name)).toBe(false);
    expect(hay.includes("TOPSECRET")).toBe(false);
  });

  it("leaves unsealed envelopes distinguishable", () => {
    const plain = packEnvelope({ name: "n", mime: "m", size: 8 }, bytes(8), 0);
    expect(isSealed(plain)).toBe(false);
    const deflated = packEnvelope({ name: "n", mime: "m", size: 8 }, bytes(8), FLAG_DEFLATE);
    expect(isSealed(deflated)).toBe(false);
  });

  it("fresh salt and iv per seal — identical input, different wire", async () => {
    const envelope = packEnvelope({ name: "n", mime: "m", size: 64 }, bytes(64), 0);
    const a = await seal(envelope, "same passphrase");
    const b = await seal(envelope, "same passphrase");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
