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

/** Ceiling for a single inflate when the caller names no other limit. */
export const DEFAULT_MAX_INFLATE = 256 * 1024 * 1024;

/** Raw-inflate, aborting past `maxBytes`.
 *
 * Frames come off a channel anyone can broadcast into, and deflate reaches
 * ~1000:1, so a few KB of hostile stream can name a small `meta.size` and
 * still expand to gigabytes. Buffering the whole stream and checking the
 * size afterwards is too late — the tab is already dead. So this reads
 * incrementally and gives up the moment the cap is passed. */
export async function inflate(
  data: Uint8Array,
  maxBytes = DEFAULT_MAX_INFLATE,
): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("this browser can't decompress (DecompressionStream missing)");
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  ) as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const res = await reader.read();
    if (res.done) break;
    const chunk = res.value;
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`decompressed data passed the ${maxBytes}-byte limit — refusing to continue`);
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
