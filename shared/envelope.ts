// Payload envelope (protocol v2): what the fountain actually carries.
//
//   [u8 flags][u16 metaLen LE][meta JSON utf-8][file bytes]
//
// The envelope rides INSIDE the fountain payload, so the filename/MIME get
// the same erasure protection as the data and need no special frames. The
// transfer hash (header.payloadFnv) covers the envelope bytes as sent — so
// a receiver can verify a complete collection before it can even read the
// metadata. flags bit 0 marks the file bytes as raw-deflate compressed
// (meta.size always holds the ORIGINAL size); bit 1 is reserved for the
// sealed-stream encryption of Phase 3B.

export const FLAG_DEFLATE = 0b0000_0001;

export interface FileMeta {
  name: string;
  mime: string;
  size: number; // original (uncompressed) byte length
}

export function packEnvelope(meta: FileMeta, data: Uint8Array, flags: number): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  if (metaBytes.length > 0xffff) throw new Error("metadata too large for u16 length");
  const out = new Uint8Array(3 + metaBytes.length + data.length);
  out[0] = flags & 0xff;
  out[1] = metaBytes.length & 0xff;
  out[2] = metaBytes.length >> 8;
  out.set(metaBytes, 3);
  out.set(data, 3 + metaBytes.length);
  return out;
}

export function parseEnvelope(
  bytes: Uint8Array,
): { flags: number; meta: FileMeta; data: Uint8Array } | null {
  if (bytes.length < 3) return null;
  const flags = bytes[0]!;
  const metaLen = bytes[1]! | (bytes[2]! << 8);
  if (bytes.length < 3 + metaLen) return null;
  let meta: FileMeta;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(3, 3 + metaLen)));
    const m = parsed as Partial<FileMeta>;
    if (typeof m.name !== "string" || typeof m.mime !== "string" || typeof m.size !== "number") {
      return null;
    }
    meta = { name: m.name, mime: m.mime, size: m.size };
  } catch {
    return null;
  }
  return { flags, meta, data: bytes.subarray(3 + metaLen) };
}

/** Raw-deflate via CompressionStream. Returns null where unsupported. */
export async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== "function") return null;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("this browser can't decompress (DecompressionStream missing)");
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
