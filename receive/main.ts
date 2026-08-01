// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
//
// Field lessons baked in:
// - iOS treats `frameRate: {ideal: 60}` as a suggestion and delivers 30.
//   Demand `exact` first (it works at 1280-wide), fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.
//
// Decode pipeline (Phase 1):
// - Acquisition: full frames, permissive reader options (tryHarder +
//   tryDownscale) until the first code decodes.
// - Locked: frames are cropped to the last hit's neighborhood (measured ~3×
//   faster decode) with the fast reader options; N consecutive misses fall
//   back to acquisition. Where the platform allows, autofocus is frozen on
//   lock — AF hunting is the #1 throughput killer.
// - Pixels travel as transferred VideoFrames cropped inside the worker
//   (zero main-thread readback) when the browser supports it; otherwise a
//   canvas crops on the main thread. Both feed the same worker decode.

import { LTDecoder } from "../shared/fountain";
import { fnv1a, parseFrame } from "../shared/protocol";
import { roiFromCorners, type Pt, type Roi } from "./roi";

// Expected frames ≈ K × this (robust-soliton ε). Measured in the test suite:
// 1.11–1.28 depending on K (small K trends worse); 1.18 is a mid estimate
// used only for the progress bar and the goodput readout.
const OVERHEAD_EST = 1.18;
const MISS_LIMIT = 12; // consecutive misses before giving up a locked ROI

// Acquisition wants to FIND a code (unknown scale, maybe blurry): let zxing
// try harder and try downscaled passes. Rotation/inversion stay off — QR
// finder patterns are orientation-free and the sender never inverts.
const ACQUIRE_OPTS = {
  formats: ["QRCode"] as string[],
  maxNumberOfSymbols: 1,
  tryHarder: true,
  tryRotate: false,
  tryInvert: false,
  tryDownscale: true,
};

const startBtn = document.getElementById("start") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const result = document.getElementById("result")!;
const settings = document.getElementById("settings") as HTMLDetailsElement;
const metricsEl = document.getElementById("metrics")!;
const metric = (id: string) => document.getElementById(id)!;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;
let statsTimer = 0;
let wakeLock: { release(): Promise<void> } | null = null;

// ROI / capture-path state
let roi: Roi | null = null; // null = full-frame acquisition
let missStreak = 0;
let useVideoFrame = typeof VideoFrame === "function";
let vfUnsupported = 0; // frames whose pixel format the worker couldn't read
let lastRoiHitId = -1; // ignore position updates from older frames
let emaDecMs = 0;
let focusFrozen = false;

const workers: Worker[] = [];
const busy: boolean[] = [];
const crops = new Map<number, { ox: number; oy: number }>();
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

startBtn.onclick = () => void start();

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    // On insecure origins the API doesn't exist AT ALL — this is the plain-
    // http-over-LAN case. localhost is exempt; other hosts need https.
    stats.textContent =
      "✗ camera needs a secure context — this page must be served over " +
      "https to use the camera from another device (npm run dev:https).";
    return;
  }
  const captureWidth = Number((document.getElementById("cfg-width") as HTMLSelectElement).value);
  const captureFps = Number((document.getElementById("cfg-capfps") as HTMLSelectElement).value);
  const workerSetting = (document.getElementById("cfg-workers") as HTMLSelectElement).value;
  const workerCount =
    workerSetting === "auto"
      ? Math.min(Math.max(1, (navigator.hardwareConcurrency || 4) - 1), 4)
      : Number(workerSetting);
  settings.style.display = "none";
  startBtn.style.display = "none";
  preview.style.display = "block";
  metricsEl.style.display = "grid";
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    stats.textContent = `✗ camera: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  stats.textContent = `camera ${stream.getVideoTracks()[0]?.getSettings().width}×${stream.getVideoTracks()[0]?.getSettings().height}@${stream.getVideoTracks()[0]?.getSettings().frameRate} · ${workerCount} workers — searching for a stream…`;

  for (let i = 0; i < workerCount; i++) spawnWorker(i);

  captureGen++;
  scheduleFrame(captureGen);
  statsTimer = window.setInterval(updateStats, 500);
  try {
    wakeLock =
      ((await (
        navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } }
      ).wakeLock?.request("screen")) as { release(): Promise<void> } | undefined) ?? null;
  } catch {
    /* fine */
  }
}

function spawnWorker(slot: number) {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent) => {
    const { id, bytes, corners, ms, unsupported } = e.data as {
      id: number;
      bytes: Uint8Array | null;
      corners: Pt[] | null;
      ms: number;
      unsupported?: boolean;
    };
    if (id === -1) return; // warm-up
    busy[slot] = false;
    const crop = crops.get(id);
    crops.delete(id);
    if (unsupported) {
      // This browser hands out VideoFrames whose pixel format the worker
      // can't read — switch to the canvas path for good after a few.
      if (++vfUnsupported > 5) useVideoFrame = false;
      return;
    }
    if (ms > 0) emaDecMs = emaDecMs === 0 ? ms : emaDecMs * 0.9 + ms * 0.1;
    if (bytes) {
      missStreak = 0;
      if (corners && crop && id > lastRoiHitId) {
        lastRoiHitId = id;
        const abs = corners.map((c) => ({ x: c.x + crop.ox, y: c.y + crop.oy }));
        const next = roiFromCorners(abs, video.videoWidth, video.videoHeight);
        if (next) {
          if (!roi) void freezeFocus();
          roi = next;
        }
      }
      onDecoded(bytes);
    } else if (roi && ++missStreak >= MISS_LIMIT) {
      // Lost the code (moved out of crop, refocus, sender restarted its
      // layout) — back to full-frame acquisition.
      roi = null;
      missStreak = 0;
      void unfreezeFocus();
    }
  };
  // A crashed worker must not eat its slot forever — that would silently
  // halve decode throughput. Replace it and free the slot; the frame it was
  // holding is just another erasure the fountain absorbs.
  const revive = () => {
    w.terminate();
    if (!done) spawnWorker(slot);
  };
  w.onerror = revive;
  w.onmessageerror = revive;
  workers[slot] = w;
  busy[slot] = false;
}

// Autofocus hunting is the #1 throughput killer. Where the platform exposes
// manual focus (Chromium/Android), freeze it at the distance that just
// produced a decode; restore continuous AF if we lose the code again.
// iOS Safari exposes none of this — the README's "prop the phone" advice
// remains the mitigation there.
interface FocusCapabilities {
  focusMode?: string[];
  focusDistance?: { min?: number; max?: number };
}

async function freezeFocus() {
  const track = stream?.getVideoTracks()[0];
  if (!track?.getCapabilities || focusFrozen) return;
  try {
    const caps = track.getCapabilities() as FocusCapabilities;
    const cur = (track.getSettings() as MediaTrackSettings & { focusDistance?: number })
      .focusDistance;
    if (!caps.focusMode?.includes("manual") || cur === undefined) return;
    await track.applyConstraints({
      advanced: [{ focusMode: "manual", focusDistance: cur } as unknown as MediaTrackConstraintSet],
    });
    focusFrozen = true;
  } catch {
    /* capability probing is best-effort */
  }
}

async function unfreezeFocus() {
  const track = stream?.getVideoTracks()[0];
  if (!track || !focusFrozen) return;
  focusFrozen = false;
  try {
    await track.applyConstraints({
      advanced: [{ focusMode: "continuous" } as unknown as MediaTrackConstraintSet],
    });
  } catch {
    /* fine */
  }
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  const slot = busy.indexOf(false);
  if (slot === -1) return; // all workers busy — drop the frame, no harm done
  const r = roi;
  const opts = r ? undefined : ACQUIRE_OPTS; // locked → worker's fast defaults
  const id = frameId++;
  crops.set(id, { ox: r?.x ?? 0, oy: r?.y ?? 0 });
  busy[slot] = true;
  if (useVideoFrame) {
    try {
      const vf = new VideoFrame(video);
      workers[slot]!.postMessage(
        {
          id,
          frame: vf,
          rect: r ? { x: r.x, y: r.y, width: r.w, height: r.h } : undefined,
          opts,
        },
        [vf as unknown as Transferable],
      );
      return;
    } catch {
      useVideoFrame = false; // constructor unsupported here — canvas from now on
    }
  }
  const cw = r?.w ?? vw;
  const ch = r?.h ?? vh;
  if (grab.width !== cw || grab.height !== ch) {
    grab.width = cw;
    grab.height = ch;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, r?.x ?? 0, r?.y ?? 0, cw, ch, 0, 0, cw, ch);
  const img = ctx.getImageData(0, 0, cw, ch);
  workers[slot]!.postMessage({ id, buf: img.data.buffer, w: cw, h: ch, opts }, [img.data.buffer]);
}

function onDecoded(bytes: Uint8Array) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  if (!decoder || sessionId !== header.sessionId) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
  }
  decoder.addFrame(header.seq, block);
  const progress = Math.min(0.99, decoder.framesNew / (decoder.k * OVERHEAD_EST));
  bar.style.width = `${(progress * 100).toFixed(1)}%`;

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    finish(payload, ok, seconds, header.totalLen);
  }
}

function finish(payload: Uint8Array, hashOk: boolean, seconds: number, totalLen: number) {
  done = true;
  captureGen++;
  clearInterval(statsTimer);
  for (const w of workers) w.terminate();
  workers.length = 0;
  stream?.getTracks().forEach((t) => t.stop());
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  preview.style.display = "none";
  bar.style.width = "100%";
  const kb = Math.round(totalLen / 1024);
  const rate = (totalLen / 1024 / seconds).toFixed(1);
  stats.textContent = `${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · hash ${hashOk ? "verified ✓" : "MISMATCH ✗"}`;
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Transfer Complete!";
  const img = document.createElement("img");
  img.className = "received";
  const url = URL.createObjectURL(new Blob([payload as BlobPart], { type: "image/png" }));
  img.onload = () => URL.revokeObjectURL(url);
  img.src = url;
  result.append(heading, img);
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - 2000) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  metric("m-cap").textContent = (captureTimes.length / 2).toFixed(0);
  metric("m-dec").textContent = (decodeTimes.length / 2).toFixed(1);
  metric("m-decms").textContent = emaDecMs > 0 ? `${emaDecMs.toFixed(1)} ms` : "—";
  metric("m-roi").textContent = roi
    ? `${roi.w}×${roi.h}${useVideoFrame ? "" : " (canvas)"}`
    : `full${useVideoFrame ? "" : " (canvas)"}`;
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  const kbs = (decoder.framesNew * decoder.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed);
  metric("m-rate").textContent = `${kbs.toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
}
