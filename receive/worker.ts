// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

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
// Callers can override per message (the /bench/ page A/Bs this).
const FAST: ReaderOptions = {
  formats: ["QRCode"],
  maxNumberOfSymbols: 1,
  tryHarder: false,
  tryRotate: false,
  tryInvert: false,
  tryDownscale: false,
};

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h, opts } = e.data as {
    id: number;
    buf: ArrayBuffer;
    w: number;
    h: number;
    opts?: ReaderOptions;
  };
  try {
    const img = new ImageData(new Uint8ClampedArray(buf), w, h);
    const results = await readBarcodes(img, opts ?? FAST);
    const r = results.find((x) => x.isValid && x.bytes.length > 0);
    ctx.postMessage({ id, bytes: r ? r.bytes : null });
  } catch {
    ctx.postMessage({ id, bytes: null });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));
