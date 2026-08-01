// Sealed streams (Phase 3B): AES-256-GCM layered ABOVE the fountain code.
//
// The plaintext is a complete Phase 3 envelope (name/MIME/size + bytes,
// possibly deflated — compress-then-encrypt; ciphertext doesn't compress).
// The sealed wire format the fountain carries is:
//
//   [u8 flags with FLAG_SEALED][16 B salt][12 B iv][ciphertext + GCM tag]
//
// Layering is the crux: frame headers and the fountain math stay public, so
// ANYONE can collect and even verify a complete stream (the transfer FNV
// covers these wire bytes) — but every content byte, including the
// filename, is ciphertext. A recorded stream can be published anywhere;
// only the key holder can open it. GCM's tag gives cryptographic integrity
// and (within the key-sharing group) authenticity: a wrong key fails
// authentication cleanly instead of yielding garbage.
//
// Keys: either a raw 256-bit key as 64 hex chars (prefer this for anything
// published — ciphertext on the open internet is exposed to offline
// guessing forever), or a passphrase via PBKDF2-SHA-256 with 600k
// iterations and the per-transfer random salt.

export const FLAG_SEALED = 0b0000_0010; // envelope/wire flags bit 1

const SALT_LEN = 16;
const IV_LEN = 12;
export const PBKDF2_ITERATIONS = 600_000;

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function randomKeyHex(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function keyFromInput(input: string, salt: Uint8Array): Promise<CryptoKey> {
  if (HEX64.test(input)) {
    return crypto.subtle.importKey("raw", hexToBytes(input) as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal a plaintext envelope. `keyInput` is 64-hex (raw key) or a passphrase. */
export async function seal(envelope: Uint8Array, keyInput: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await keyFromInput(keyInput, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, envelope as BufferSource),
  );
  const wire = new Uint8Array(1 + SALT_LEN + IV_LEN + ct.length);
  wire[0] = FLAG_SEALED;
  wire.set(salt, 1);
  wire.set(iv, 1 + SALT_LEN);
  wire.set(ct, 1 + SALT_LEN + IV_LEN);
  return wire;
}

export function isSealed(wire: Uint8Array): boolean {
  return wire.length > 1 + SALT_LEN + IV_LEN && (wire[0]! & FLAG_SEALED) !== 0;
}

/** Open a sealed wire. Throws on a wrong key (GCM authentication failure). */
export async function unseal(wire: Uint8Array, keyInput: string): Promise<Uint8Array> {
  if (!isSealed(wire)) throw new Error("not a sealed stream");
  const salt = wire.subarray(1, 1 + SALT_LEN);
  const iv = wire.subarray(1 + SALT_LEN, 1 + SALT_LEN + IV_LEN);
  const ct = wire.subarray(1 + SALT_LEN + IV_LEN);
  const key = await keyFromInput(keyInput, salt);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource),
    );
  } catch {
    throw new Error("wrong key — the stream did not authenticate");
  }
}
