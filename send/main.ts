// Sender: turn a file into an endless fountain-coded QR stream.
//
// Tuning notes from the experiments this PoC is distilled from:
// - Frame payload sets the QR version; denser wins on goodput as long as the
//   receiver can still decode it. 1465 bytes ≈ V27 is a safe middle ground
//   for arbitrary monitors; 2953 (V40) is the ceiling and works phone-to-
//   phone at close range.
// - The mask pattern is pinned (any declared mask is valid to a decoder);
//   this skips the spec's 8-way mask evaluation and speeds generation ~4×.
// - Displays need each frame shown for ≥2 refresh cycles or captures catch
//   the transition — pacing is vsync-integer (see pacing.ts), so the target
//   fps maps to the nearest exact division of the measured refresh rate.
// - Error correction stays at L by default: the fountain layer already
//   handles erasures, and a frame is either decoded whole or discarded.
//
// Phase 2 shape: QR generation runs in a small worker pool producing whole
// display tiles (1, 2, or 4 codes per frame — each code an independent
// fountain frame, so the grid needs no protocol changes). The main thread
// only flips pre-rendered tiles on vsync-counted rAF ticks.

import { FLAG_DEFLATE, deflate, packEnvelope, type FileMeta } from "../shared/envelope";
import { HEADER_LEN, fnv1a, type FrameHeader } from "../shared/protocol";
import { estimateRefresh, vsyncPacing } from "./pacing";

const GEN_WORKERS = 2;
const QUEUE_DEPTH = 4; // pre-rendered tiles to keep on hand
const BATCH_PER_WORKER = 2; // outstanding gen requests per worker

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const specs = document.getElementById("specs")!;
const cfgPreset = document.getElementById("cfg-preset") as HTMLSelectElement;
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const cfgPayload = document.getElementById("cfg-payload") as HTMLSelectElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgGrid = document.getElementById("cfg-grid") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;

// preset → [target fps, bytes/frame, codes/frame]
const PRESETS: Record<string, [number, number, number]> = {
  steady: [20, 1465, 1],
  balanced: [30, 1465, 1],
  dense: [30, 2953, 1],
  grid: [30, 1465, 4],
  ludicrous: [60, 1465, 4],
};

const payloadCache = new Map<string, Uint8Array>();
let customFile: { meta: FileMeta; bytes: Uint8Array } | null = null;
const CUSTOM = "__custom__";
let generation = 0; // bumped on every restart; stale loops and workers die
let genWorkers: Worker[] = [];

async function useFile(f: File) {
  customFile = {
    meta: { name: f.name, mime: f.type || "application/octet-stream", size: f.size },
    bytes: new Uint8Array(await f.arrayBuffer()),
  };
  let opt = cfgPayload.querySelector<HTMLOptionElement>(`option[value="${CUSTOM}"]`);
  if (!opt) {
    opt = document.createElement("option");
    opt.value = CUSTOM;
    cfgPayload.append(opt);
  }
  opt.textContent = `${f.name} (${Math.round(f.size / 1024)} KB)`;
  cfgPayload.value = CUSTOM;
  void startStream();
}

// Measure the display's refresh rate once, in the background, at load.
const refreshPromise = new Promise<number>((res) => {
  const ts: number[] = [];
  const cb = (t: number) => {
    ts.push(t);
    if (ts.length < 24) requestAnimationFrame(cb);
    else res(estimateRefresh(ts));
  };
  requestAnimationFrame(cb);
});

async function loadPayload(url: string): Promise<Uint8Array | null> {
  const hit = payloadCache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  payloadCache.set(url, bytes);
  return bytes;
}

async function main() {
  cfgFile.addEventListener("change", () => {
    const f = cfgFile.files?.[0];
    if (f) void useFile(f);
  });
  // drop a file anywhere on the page to send it
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void useFile(f);
  });
  cfgPreset.addEventListener("change", () => {
    const p = PRESETS[cfgPreset.value];
    if (p) {
      cfgFps.value = String(p[0]);
      cfgBytes.value = String(p[1]);
      cfgGrid.value = String(p[2]);
    }
    void startStream();
  });
  for (const el of [cfgPayload, cfgFps, cfgBytes, cfgEcc, cfgGrid, cfgSize]) {
    el.addEventListener("change", () => {
      // manual tweaks leave preset land
      const p = PRESETS[cfgPreset.value];
      if (
        p &&
        (cfgFps.value !== String(p[0]) ||
          cfgBytes.value !== String(p[1]) ||
          cfgGrid.value !== String(p[2]))
      ) {
        cfgPreset.value = "";
      }
      void startStream();
    });
  }
  await startStream();
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine without it */
  }
}

async function startStream() {
  const gen = ++generation;
  for (const w of genWorkers) w.terminate();
  genWorkers = [];

  // Resolve the source file (a dropped/picked file, or a demo image), then
  // build the v2 envelope the fountain will carry: metadata + (optionally
  // deflated) bytes. Compression is kept only when it actually pays.
  let meta: FileMeta;
  let fileBytes: Uint8Array;
  if (cfgPayload.value === CUSTOM && customFile) {
    meta = customFile.meta;
    fileBytes = customFile.bytes;
  } else {
    const url = cfgPayload.value === CUSTOM ? "../success.png" : cfgPayload.value;
    const fetched = await loadPayload(url);
    if (!fetched) {
      specs.textContent = `✗ couldn't load ${url}`;
      return;
    }
    fileBytes = fetched;
    meta = { name: url.split("/").pop() ?? "payload.bin", mime: "image/png", size: fetched.length };
  }
  let data = fileBytes;
  let flags = 0;
  const squeezed = await deflate(fileBytes);
  if (squeezed && squeezed.length < fileBytes.length * 0.97) {
    data = squeezed;
    flags = FLAG_DEFLATE;
  }
  const payload = packEnvelope(meta, data, flags);
  const refresh = await refreshPromise;
  if (gen !== generation) return; // superseded while waiting

  const targetFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const codes = Number(cfgGrid.value) as 1 | 2 | 4;
  const displayPx = Number(cfgSize.value);
  const { ticks, fps } = vsyncPacing(refresh, targetFps);

  const blockLen = frameBytes - HEADER_LEN;
  const k = Math.max(1, Math.ceil(payload.length / blockLen));
  if (blockLen < 1 || blockLen > 0xffff || k > 0xffff) {
    specs.textContent = `✗ payload needs ${k} blocks of ${blockLen} B — outside the header's u16 fields`;
    return;
  }
  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
  };

  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  let tileW = 0;
  let tileH = 0;
  let scale = 1;
  let nextSeq = 0;
  const pending: number[] = []; // outstanding gen requests, per worker
  let starved = 0;
  let flips = 0;
  let specsBase = "";

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / Math.max(tileW, tileH)));
    staging.width = tileW;
    staging.height = tileH;
    canvas.width = tileW * scale;
    canvas.height = tileH * scale;
    canvas.style.width = `${(tileW * scale) / dpr}px`;
    canvas.style.height = `${(tileH * scale) / dpr}px`;
  };

  const dispatch = () => {
    if (gen !== generation) return;
    // top the queue up, always handing work to the least-loaded worker
    for (;;) {
      const inFlight = pending.reduce((a, b) => a + b, 0);
      if (queue.length + inFlight >= QUEUE_DEPTH) return;
      let wi = 0;
      for (let i = 1; i < pending.length; i++) if (pending[i]! < pending[wi]!) wi = i;
      if ((pending[wi] ?? Infinity) >= BATCH_PER_WORKER) return; // pool saturated
      const seqs: number[] = [];
      for (let j = 0; j < codes; j++) seqs.push(nextSeq++);
      genWorkers[wi]!.postMessage({ type: "gen", seqs });
      pending[wi] = pending[wi]! + 1;
    }
  };

  let ready = false;
  for (let i = 0; i < GEN_WORKERS; i++) {
    const wi = i;
    const w = new Worker(new URL("./genworker.ts", import.meta.url), { type: "module" });
    pending.push(0);
    w.onmessage = (e: MessageEvent) => {
      if (gen !== generation) return;
      const msg = e.data as
        | { type: "ready"; version: number; w: number; h: number }
        | { type: "tile"; buf: ArrayBuffer; w: number; h: number; seqs: number[] }
        | { type: "error"; message: string };
      if (msg.type === "error") {
        // e.g. frame bytes over capacity for the chosen ECC level
        specs.textContent = `✗ ${msg.message}`;
        return;
      }
      if (msg.type === "ready") {
        if (!ready) {
          ready = true;
          tileW = msg.w;
          tileH = msg.h;
          sizeCanvas();
          const raw = (codes * blockLen * fps) / 1024;
          const est = Math.ceil((payload.length * 1.18) / (codes * blockLen * fps));
          const squeezeNote =
            flags & FLAG_DEFLATE
              ? ` (deflated to ${Math.round((100 * data.length) / meta.size)}%)`
              : "";
          specsBase =
            `${meta.name} · ${Math.round(meta.size / 1024)} KB${squeezeNote} · ` +
            `${fps.toFixed(fps % 1 ? 1 : 0)} fps (${ticks}v @ ${refresh} Hz) · ` +
            `${codes}× ${frameBytes} B · V${msg.version} · ECC ${ecc} · ` +
            `K=${k} · raw ${raw.toFixed(0)} KB/s · ≈${est}s`;
          specs.textContent = specsBase;
        }
        dispatch();
        return;
      }
      pending[wi] = pending[wi]! - 1;
      queue.push(new ImageData(new Uint8ClampedArray(msg.buf), msg.w, msg.h));
      dispatch();
    };
    w.onerror = () => {
      if (gen === generation) specs.textContent = "✗ QR generation worker crashed";
    };
    w.postMessage({ type: "init", payload, blockLen, ecc, codes, header });
    genWorkers.push(w);
  }

  // Flip loop: hold each tile for exactly `ticks` rAF callbacks. If the
  // queue is dry at a due flip, keep showing the last tile and flip as soon
  // as one lands — starvation is counted and surfaced, not hidden.
  let sinceFlip = 0;
  const tick = () => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    sinceFlip++;
    if (sinceFlip < ticks || !ready) return;
    const img = queue.shift();
    if (!img) {
      if (sinceFlip === ticks) starved++;
      return;
    }
    sinceFlip = 0;
    staging.getContext("2d")!.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    flips++;
    dispatch();
  };
  requestAnimationFrame(tick);

  const statsTimer = window.setInterval(() => {
    if (gen !== generation) {
      clearInterval(statsTimer);
      return;
    }
    if (specsBase && starved > 0) {
      specs.textContent = `${specsBase} · ⚠ ${starved} starved flips / ${flips}`;
    }
  }, 2000);
}

void main();
