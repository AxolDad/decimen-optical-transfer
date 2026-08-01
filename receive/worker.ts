// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.
//
// Two input paths:
// - { frame, rect? }: a transferred VideoFrame; the ROI crop happens HERE via
//   copyTo(rect), so the main thread never touches pixels. Camera frames are
//   usually NV12/I420 — the Y plane is exactly the luma QR decoding needs.
// - { buf, w, h }: RGBA pixels already cropped by the main thread (canvas
//   fallback path, and the /bench/ page).

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes, type ReaderOptions } from "zxing-wasm/reader";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

// zxing's defaults (tryHarder/tryRotate/tryInvert/tryDownscale all ON) burn
// ~37% of every missed frame at 1280×960. Our sender emits upright, dark-on-
// light, high-contrast codes, so the fallbacks buy nothing: QR finder-pattern
// detection already handles ANY rotation with tryRotate off (verified for
// 0/90/180/270° in the bench suite), and inverted codes can't occur.
// The main thread overrides this during acquisition (tryHarder+tryDownscale
// back on) and the /bench/ page overrides it to A/B.
const FAST: ReaderOptions = {
  formats: ["QRCode"],
  maxNumberOfSymbols: 1,
  tryHarder: false,
  tryRotate: false,
  tryInvert: false,
  tryDownscale: false,
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Extract decodable RGBA from a VideoFrame, cropped to `rect` if given.
 * Returns null for pixel formats we don't handle (main thread falls back). */
async function videoFrameToImageData(vf: VideoFrame, rect?: Rect): Promise<ImageData | null> {
  const fmt = String(vf.format ?? "");
  if (!fmt) return null;
  const w = (rect?.width ?? vf.visibleRect?.width ?? vf.codedWidth) | 0;
  const h = (rect?.height ?? vf.visibleRect?.height ?? vf.codedHeight) | 0;
  if (!w || !h) return null;
  const buf = new Uint8Array(vf.allocationSize({ rect }));
  const layout = await vf.copyTo(buf, { rect });
  const out = new ImageData(w, h);
  if (fmt.startsWith("I4") || fmt.startsWith("NV")) {
    // Planar/semi-planar YUV: plane 0 is luma — all a QR needs.
    const y = layout[0]!;
    const px = new Uint32Array(out.data.buffer);
    for (let r = 0; r < h; r++) {
      let src = y.offset + r * y.stride;
      let dst = r * w;
      for (let c = 0; c < w; c++) {
        const v = buf[src++]!;
        px[dst++] = 0xff000000 | (v << 16) | (v << 8) | v;
      }
    }
    return out;
  }
  if (fmt.includes("RGB") || fmt.includes("BGR")) {
    // Packed 4-byte RGB variants. R/B order doesn't matter for luma of a
    // black-and-white code; X alpha is forced opaque below.
    const p = layout[0]!;
    for (let r = 0; r < h; r++) {
      out.data.set(buf.subarray(p.offset + r * p.stride, p.offset + r * p.stride + w * 4), r * w * 4);
    }
    for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
    return out;
  }
  return null;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent) => {
  const data = e.data as {
    id: number;
    opts?: ReaderOptions;
    buf?: ArrayBuffer;
    w?: number;
    h?: number;
    frame?: VideoFrame;
    rect?: Rect;
  };
  const { id, opts } = data;
  let img: ImageData | null = null;
  let unsupported = false;
  try {
    if (data.frame) {
      img = await videoFrameToImageData(data.frame, data.rect);
      unsupported = img === null;
    } else if (data.buf && data.w && data.h) {
      img = new ImageData(new Uint8ClampedArray(data.buf), data.w, data.h);
    }
  } catch {
    img = null;
  } finally {
    data.frame?.close();
  }
  if (!img) {
    ctx.postMessage({ id, bytes: null, corners: null, ms: 0, unsupported });
    return;
  }
  const t0 = performance.now();
  try {
    const results = await readBarcodes(img, opts ?? FAST);
    const ms = performance.now() - t0;
    const r = results.find((x) => x.isValid && x.bytes.length > 0);
    const p = r?.position;
    const corners = p
      ? [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map((q) => ({ x: q.x, y: q.y }))
      : null;
    ctx.postMessage({ id, bytes: r ? r.bytes : null, corners, ms });
  } catch {
    ctx.postMessage({ id, bytes: null, corners: null, ms: performance.now() - t0 });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));
