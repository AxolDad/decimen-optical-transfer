// Sender page — a thin UI shell over lib/sender (see docs/IMPROVEMENT-PLAN.md).
// All streaming machinery (envelope, optional seal, generation workers,
// vsync pacing, grids) lives in the library; this file is settings, drag &
// drop, the key display, and the export button.

import QRCode from "qrcode";
import { OpticalSender, type SenderPayload } from "../lib/sender";
import { randomKeyHex } from "../shared/crypto";

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const specs = document.getElementById("specs")!;
const keyRow = document.getElementById("key-row")!;
const keyText = document.getElementById("key-text")!;
const keyQr = document.getElementById("key-qr") as HTMLCanvasElement;
const exportBtn = document.getElementById("export") as HTMLButtonElement;
const exportOut = document.getElementById("export-out")!;
const cfgPreset = document.getElementById("cfg-preset") as HTMLSelectElement;
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const cfgPayload = document.getElementById("cfg-payload") as HTMLSelectElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgGrid = document.getElementById("cfg-grid") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;
const cfgSeal = document.getElementById("cfg-seal") as HTMLSelectElement;
const cfgPass = document.getElementById("cfg-pass") as HTMLInputElement;

// preset → [target fps, bytes/frame, codes/frame]
const PRESETS: Record<string, [number, number, number]> = {
  steady: [20, 1465, 1],
  balanced: [30, 1465, 1],
  dense: [30, 2953, 1],
  grid: [30, 1465, 4],
  ludicrous: [60, 1465, 4],
};

const payloadCache = new Map<string, Uint8Array>();
let customFile: SenderPayload | null = null;
const CUSTOM = "__custom__";
let sender: OpticalSender | null = null;
let generation = 0;

async function loadPayload(url: string): Promise<Uint8Array | null> {
  const hit = payloadCache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  payloadCache.set(url, bytes);
  return bytes;
}

async function useFile(f: File) {
  customFile = {
    bytes: new Uint8Array(await f.arrayBuffer()),
    name: f.name,
    mime: f.type || "application/octet-stream",
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

async function startStream() {
  const gen = ++generation;
  sender?.stop();
  keyRow.style.display = "none";
  exportOut.textContent = "";

  let payload: SenderPayload;
  if (cfgPayload.value === CUSTOM && customFile) {
    payload = customFile;
  } else {
    const url = cfgPayload.value === CUSTOM ? "../success.png" : cfgPayload.value;
    const bytes = await loadPayload(url);
    if (!bytes) {
      specs.textContent = `✗ couldn't load ${url}`;
      return;
    }
    payload = { bytes, name: url.split("/").pop() ?? "payload.bin", mime: "image/png" };
  }
  if (gen !== generation) return;

  // sealed mode: an explicit passphrase, or a fresh random key to hand over
  let key: string | undefined;
  if (cfgSeal.value === "sealed") {
    key = cfgPass.value.trim() || randomKeyHex();
    keyRow.style.display = "flex";
    keyText.textContent = cfgPass.value.trim()
      ? "sealed with your passphrase"
      : `key (share out of band): ${key}`;
    void QRCode.toCanvas(keyQr, key, { margin: 1, scale: 3 });
    keyQr.style.display = cfgPass.value.trim() ? "none" : "block";
  }

  sender = new OpticalSender({
    canvas,
    payload,
    targetFps: Number(cfgFps.value),
    frameBytes: Number(cfgBytes.value),
    codes: Number(cfgGrid.value) as 1 | 2 | 4,
    ecc: cfgEcc.value as "L" | "M" | "Q" | "H",
    displayPx: Number(cfgSize.value),
    encryptKey: key,
    onReady: (info) => {
      if (gen !== generation) return;
      const squeeze = info.deflatedPct !== null ? ` (deflated to ${info.deflatedPct}%)` : "";
      specs.textContent =
        `${payload.name} · ${Math.round(info.fileSize / 1024)} KB${squeeze}${info.sealed ? " · 🔒 sealed" : ""} · ` +
        `${info.fps.toFixed(info.fps % 1 ? 1 : 0)} fps (${info.ticks}v @ ${info.refreshHz} Hz) · ` +
        `${info.codes}× ${info.frameBytes} B · V${info.version} · ECC ${info.ecc} · ` +
        `K=${info.k} · raw ${info.rawKBs.toFixed(0)} KB/s · ≈${info.estSeconds}s`;
      exportBtn.textContent = `Export video (~${sender!.exportSeconds()}s)`;
      exportBtn.style.display = "inline-block";
    },
    onError: (message) => {
      if (gen === generation) specs.textContent = `✗ ${message}`;
    },
    onStarve: (starved, flips) => {
      if (gen === generation && specs.textContent && !specs.textContent.includes("✗")) {
        specs.textContent = specs.textContent.replace(/ · ⚠.*$/, "") + ` · ⚠ ${starved} starved / ${flips}`;
      }
    },
  });
  await sender.start();
}

async function exportVideo() {
  if (!sender) return;
  exportBtn.disabled = true;
  const secs = sender.exportSeconds();
  exportOut.textContent = `recording ~${secs}s of stream…`;
  try {
    const blob = await sender.exportVideo();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "decimen-stream.webm";
    a.textContent = `Download recording (${(blob.size / 1024 / 1024).toFixed(1)} MB)`;
    a.className = "download";
    exportOut.textContent = "";
    exportOut.append(a);
  } catch (err) {
    exportOut.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
  }
  exportBtn.disabled = false;
}

function main() {
  cfgFile.addEventListener("change", () => {
    const f = cfgFile.files?.[0];
    if (f) void useFile(f);
  });
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
  for (const el of [cfgPayload, cfgFps, cfgBytes, cfgEcc, cfgGrid, cfgSize, cfgSeal, cfgPass]) {
    el.addEventListener("change", () => {
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
  exportBtn.addEventListener("click", () => void exportVideo());
  void startStream();
  void (async () => {
    try {
      await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
        .wakeLock?.request("screen");
    } catch {
      /* fine without it */
    }
  })();
}

main();
