// Receiver page — a thin UI shell over lib/receiver (see the plan doc).
// The capture/decode/fountain machinery lives in the library; this file is
// buttons, metrics, the sealed-stream unlock flow, and the download UI.

import { OpticalReceiver, type ReceivedFile } from "../lib/receiver";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const videoFileIn = document.getElementById("cfg-video") as HTMLInputElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const result = document.getElementById("result")!;
const settings = document.getElementById("settings") as HTMLDetailsElement;
const metricsEl = document.getElementById("metrics")!;
const lockedEl = document.getElementById("locked")!;
const keyIn = document.getElementById("key") as HTMLInputElement;
const unlockBtn = document.getElementById("unlock") as HTMLButtonElement;
const metric = (id: string) => document.getElementById(id)!;

let receiver: OpticalReceiver | null = null;
let wakeLock: { release(): Promise<void> } | null = null;

startBtn.onclick = () => void start();
videoFileIn.onchange = () => {
  const f = videoFileIn.files?.[0];
  if (f) void start(f);
};
unlockBtn.onclick = () => {
  unlockBtn.disabled = true;
  stats.textContent = "unlocking…";
  void receiver?.unlock(keyIn.value.trim()).finally(() => (unlockBtn.disabled = false));
};

async function start(file?: File) {
  const captureWidth = Number((document.getElementById("cfg-width") as HTMLSelectElement).value);
  const captureFps = Number((document.getElementById("cfg-capfps") as HTMLSelectElement).value);
  const workerSetting = (document.getElementById("cfg-workers") as HTMLSelectElement).value;
  settings.style.display = "none";
  startBtn.style.display = "none";
  videoFileIn.parentElement!.style.display = "none";
  preview.style.display = "block";
  metricsEl.style.display = "grid";

  receiver = new OpticalReceiver({
    video,
    source: file,
    captureWidth,
    captureFps,
    workers: workerSetting === "auto" ? "auto" : Number(workerSetting),
    onProgress: (f) => {
      progressEl.style.display = "block";
      bar.style.width = `${(f * 100).toFixed(1)}%`;
    },
    onLocked: (wireLength) => {
      preview.style.display = "none";
      stats.textContent = `sealed stream received — ${Math.round(wireLength / 1024)} KB of verified ciphertext 🔒`;
      lockedEl.style.display = "flex";
      keyIn.focus();
    },
    onComplete: (f) => showFile(f),
    onError: (message) => {
      stats.textContent = `✗ ${message}`;
    },
    onStats: (s) => {
      metric("m-cap").textContent = s.captureFps.toFixed(0);
      metric("m-dec").textContent = s.decodeFps.toFixed(1);
      metric("m-decms").textContent = s.decodeMs > 0 ? `${s.decodeMs.toFixed(1)} ms` : "—";
      metric("m-roi").textContent = `${s.roi}${s.usingVideoFrame ? "" : " (canvas)"}`;
      if (s.k === 0) return;
      metric("m-rate").textContent = `${s.goodputKBs.toFixed(1)} KB/s`;
      metric("m-time").textContent = `${s.elapsed.toFixed(0)} s`;
      metric("m-frames").textContent = `${s.framesNew}/${s.framesDup}`;
      metric("m-k").textContent = String(s.k);
      metric("m-block").textContent = `${s.blockLen} B`;
      metric("m-payload").textContent = `${Math.round(s.totalLen / 1024)} KB`;
    },
  });
  try {
    await receiver.start();
  } catch (err) {
    stats.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  stats.textContent = file
    ? `decoding ${file.name}…`
    : "camera running — searching for a stream…";
  try {
    wakeLock =
      ((await (
        navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } }
      ).wakeLock?.request("screen")) as { release(): Promise<void> } | undefined) ?? null;
  } catch {
    /* fine */
  }
}

function showFile(f: ReceivedFile) {
  lockedEl.style.display = "none";
  preview.style.display = "none";
  bar.style.width = "100%";
  void wakeLock?.release().catch(() => undefined);
  const rate = (f.wireLength / 1024 / f.seconds).toFixed(1);
  stats.textContent =
    `${Math.round(f.wireLength / 1024)} KB over the air in ${f.seconds.toFixed(1)} s · ` +
    `${rate} KB/s · hash verified ✓${f.sealed ? " · unsealed 🔓" : ""}`;
  result.textContent = "";
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Transfer Complete!";
  const info = document.createElement("div");
  info.className = "hint";
  info.textContent =
    `${f.name} · ${Math.round(f.bytes.length / 1024)} KB` +
    (f.deflated ? ` (sent as ${Math.round(f.wireLength / 1024)} KB deflated)` : "");
  const url = URL.createObjectURL(
    new Blob([f.bytes as BlobPart], { type: f.mime || "application/octet-stream" }),
  );
  const dl = document.createElement("a");
  dl.href = url;
  dl.download = f.name;
  dl.textContent = `Download ${f.name}`;
  dl.className = "download";
  result.append(heading, info, dl);
  if (f.mime.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "received";
    img.src = url;
    result.append(img);
  }
  (navigator as Navigator & { vibrate?: (p: number[]) => void }).vibrate?.([100, 60, 100]);
}
