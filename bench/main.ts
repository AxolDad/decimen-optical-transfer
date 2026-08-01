// Loopback bench: the full sender pipeline (fountain → QR → pixels) feeding
// the full receiver pipeline (zxing worker → parse → fountain decode) with
// no camera in between. Every stage is the real production code path — the
// only synthetic parts are the pixels and the loss pattern — so numbers
// measured here (on a phone via the dev server, or on a laptop) are the
// honest ceiling for that device's decode side.

import QRCode from "qrcode";
import { LTDecoder, LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, parseFrame, splitmix32 } from "../shared/protocol";

const MARGIN = 4;
const SESSION = 0xbee5;

const runBtn = document.getElementById("run") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const cfg = (id: string) => (document.getElementById(id) as HTMLSelectElement).value;

let running = false;
let workers: Worker[] = [];

runBtn.onclick = () => {
  if (running) {
    running = false;
    runBtn.textContent = "Run";
    statusEl.textContent = "stopped";
    progressEl.style.display = "none";
    stopWorkers();
  } else {
    void run();
  }
};

function stopWorkers() {
  for (const w of workers) w.terminate();
  workers = [];
}

/** Fast O(n) sliding-window box blur on the luma of an RGBA frame. */
function boxBlur(px: Uint8ClampedArray, w: number, h: number, r: number) {
  const luma = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) luma[i] = px[i * 4]!; // source is grayscale
  const tmp = new Uint8Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += luma[row + Math.min(w - 1, Math.max(0, x))]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = (sum / win) | 0;
      sum += luma[row + Math.min(w - 1, x + r + 1)]! - luma[row + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
    for (let y = 0; y < h; y++) {
      const v = (sum / win) | 0;
      const o = (y * w + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = v;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
}

async function run() {
  running = true;
  runBtn.textContent = "Stop";
  const payloadLen = Number(cfg("cfg-payload"));
  const frameBytes = Number(cfg("cfg-bytes"));
  const ecc = cfg("cfg-ecc") as "L" | "M" | "Q" | "H";
  const scale = Number(cfg("cfg-scale"));
  const frameW = Number(cfg("cfg-frame"));
  const blur = Number(cfg("cfg-blur"));
  const loss = Number(cfg("cfg-loss"));
  const workerCount = Number(cfg("cfg-workers"));
  const optsMode = cfg("cfg-opts");
  // pre-quick-win production behavior, for A/B against the tuned default
  const readerOpts =
    optsMode === "defaults" ? { formats: ["QRCode"], maxNumberOfSymbols: 1 } : undefined;

  const rnd = splitmix32(42);
  const payload = new Uint8Array(payloadLen);
  for (let i = 0; i < payloadLen; i++) payload[i] = rnd() & 0xff;
  const blockLen = frameBytes - HEADER_LEN;
  const encoder = new LTEncoder(payload, blockLen, SESSION);
  const decoder = new LTDecoder(encoder.k, blockLen, SESSION, payloadLen);
  const header = {
    sessionId: SESSION,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payloadLen,
    payloadFnv: fnv1a(payload),
  };

  statusEl.textContent = `warming ${workerCount} worker(s)…`;
  stopWorkers();
  await new Promise<void>((ready) => {
    let warm = 0;
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL("../receive/worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent) => {
        if ((e.data as { id: number }).id === -1 && ++warm === workerCount) ready();
      };
      workers.push(w);
    }
  });
  if (!running) return;

  let version: number | undefined;
  let seq = 0;
  let sent = 0;
  let lost = 0;
  let hits = 0;
  let misses = 0;
  let genMs = 0;
  let decMs = 0;
  const lose = () => {
    // deterministic loss so runs are comparable
    return ((Math.imul(seq, 2654435761) >>> 16) % 1000) / 1000 < loss;
  };

  const makeFrame = (): ImageData => {
    const t0 = performance.now();
    const bytes = packFrame({ ...header, seq }, encoder.encode(seq));
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    version ??= qr.version;
    const size = qr.modules.size;
    const data = qr.modules.data;
    const code = (size + 2 * MARGIN) * scale;
    const w = frameW === 0 ? code : frameW;
    const h = frameW === 0 ? code : frameW === 1280 ? 960 : 1080;
    const img = new ImageData(w, h);
    const px32 = new Uint32Array(img.data.buffer);
    px32.fill(0xffffffff);
    const ox = (w - code) >> 1;
    const oy = (h - code) >> 1;
    for (let y = 0; y < size; y++) {
      const src = y * size;
      for (let dy = 0; dy < scale; dy++) {
        const row = (oy + (y + MARGIN) * scale + dy) * w + ox + MARGIN * scale;
        for (let x = 0; x < size; x++) {
          if (!data[src + x]) continue;
          const o = row + x * scale;
          for (let dx = 0; dx < scale; dx++) px32[o + dx] = 0xff000000;
        }
      }
    }
    if (blur > 0) boxBlur(img.data, w, h, blur);
    genMs += performance.now() - t0;
    return img;
  };

  const t0 = performance.now();
  const sendTimes = new Map<number, number>();

  const report = () => {
    const wall = (performance.now() - t0) / 1000;
    const genShare = genMs / 1000 / wall;
    const line =
      `${(payloadLen / 1024).toFixed(0)}KB ${frameBytes}B/f ECC-${ecc} v${version} ` +
      `${scale}px/mod ${frameW === 0 ? "tight" : `${frameW}w`} blur${blur} loss${loss * 100}% ` +
      `${workerCount}w ${optsMode} → ` +
      (decoder.isComplete
        ? `${wall.toFixed(1)}s · ${(payloadLen / 1024 / wall).toFixed(1)} KB/s decode-side`
        : `INCOMPLETE after ${sent} frames`) +
      ` · dec ${(decMs / Math.max(1, hits + misses)).toFixed(1)}ms avg · ` +
      `${((hits + misses) / wall).toFixed(0)} dec/s · gen ${(genMs / Math.max(1, sent)).toFixed(1)}ms` +
      ` · hits ${hits} miss ${misses} lost ${lost} dup ${decoder.framesDup}` +
      ` · overhead ${(decoder.framesNew / encoder.k).toFixed(2)}` +
      (genShare > 0.5 ? " · ⚠ generation-bound" : "");
    logEl.textContent = `${line}\n${logEl.textContent}`;
  };

  const finishRun = (verified: boolean) => {
    running = false;
    runBtn.textContent = "Run";
    stopWorkers();
    report();
    statusEl.textContent = decoder.isComplete
      ? `done — payload ${verified ? "verified ✓" : "MISMATCH ✗"}`
      : "stopped before completion";
    progressEl.style.display = "none";
  };

  progressEl.style.display = "block";
  const bail = encoder.k * 40 + 200;

  const feed = (w: Worker) => {
    while (running && !decoder.isComplete) {
      if (seq > bail) return finishRun(false);
      if (lose()) {
        lost++;
        seq++;
        continue;
      }
      const img = makeFrame();
      sendTimes.set(sent, performance.now());
      const msg: Record<string, unknown> = { id: sent, buf: img.data.buffer, w: img.width, h: img.height };
      if (readerOpts) msg.opts = readerOpts;
      w.postMessage(msg, [img.data.buffer]);
      sent++;
      seq++;
      return;
    }
    if (!decoder.isComplete) return;
    if (workers.length > 0) {
      const out = decoder.assemble();
      const ok = out !== null && fnv1a(out) === header.payloadFnv;
      finishRun(ok);
    }
  };

  for (const w of workers) {
    w.onmessage = (e: MessageEvent) => {
      const { id, bytes } = e.data as { id: number; bytes: Uint8Array | null };
      if (id === -1) return;
      decMs += performance.now() - (sendTimes.get(id) ?? performance.now());
      sendTimes.delete(id);
      if (bytes) {
        hits++;
        const parsed = parseFrame(bytes);
        if (parsed) decoder.addFrame(parsed.header.seq, parsed.block);
      } else {
        misses++;
      }
      bar.style.width = `${Math.min(99, (decoder.framesNew / (encoder.k * 1.18)) * 100).toFixed(1)}%`;
      statusEl.textContent =
        `${decoder.framesNew}/${encoder.k} blocks-worth · ${hits} hits · ${misses} misses · ` +
        `${((hits + misses) / Math.max(0.1, (performance.now() - t0) / 1000)).toFixed(0)} dec/s`;
      feed(w);
    };
    feed(w);
  }
}
