// EXPERIMENT — kaleidoscope loopback: fountain → mandala pixels → decode.
// Everything below the symbology (envelope, protocol header, LT fountain) is
// the production code, unchanged; only the pixels differ from the QR path.

import { packEnvelope } from "../shared/envelope";
import { LTDecoder, LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, parseFrame, splitmix32 } from "../shared/protocol";
import { photograph } from "./camera";
import { findMarkerAngle, locate, polarToImage, sampleAt } from "./locate";
import { registerOfflineWorker } from "../shared/pwa";
import {
  MARKER,
  PALETTE,
  SPIRAL,
  bytesToCells,
  capacityBytes,
  cellsToBytes,
  classify,
  dataRings,
  sectorAt,
  slotOf,
  syncColor,
  type KaleidoGeometry,
} from "./symbol";

const FNV_TRAILER = 4;

const runBtn = document.getElementById("run") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const canvas = document.getElementById("wheel") as HTMLCanvasElement;
const camStage = document.getElementById("cam-stage")!;
const camCanvas = document.getElementById("cam") as HTMLCanvasElement;
const camCtx = camCanvas.getContext("2d", { willReadFrequently: true })!;
const cfg = (id: string) => (document.getElementById(id) as HTMLSelectElement).value;

let running = false;
let timer = 0;

runBtn.onclick = () => {
  if (running) {
    stop("stopped");
  } else {
    void run();
  }
};

function stop(msg: string) {
  running = false;
  clearInterval(timer);
  runBtn.textContent = "Run loopback";
  statusEl.textContent = msg;
}

function run() {
  running = true;
  runBtn.textContent = "Stop";
  const size = Number(cfg("cfg-size"));
  const g: KaleidoGeometry = { rings: Number(cfg("cfg-rings")), sectors: Number(cfg("cfg-sectors")) };
  const fps = Number(cfg("cfg-fps"));
  const noise = Number(cfg("cfg-noise"));
  const payloadLen = Number(cfg("cfg-payload"));

  const cap = capacityBytes(g);
  const blockLen = cap - HEADER_LEN - FNV_TRAILER;
  if (blockLen < 16) {
    stop("✗ geometry too small for a frame");
    return;
  }

  // full production stack under the new pixels
  const rnd = splitmix32(99);
  const file = new Uint8Array(payloadLen);
  for (let i = 0; i < payloadLen; i++) file[i] = rnd() & 0xff;
  const envelope = packEnvelope(
    { name: "kaleido.bin", mime: "application/octet-stream", size: payloadLen },
    file,
    0,
  );
  const sessionId = 0x5eed;
  const encoder = new LTEncoder(envelope, blockLen, sessionId);
  const decoder = new LTDecoder(encoder.k, blockLen, sessionId, envelope.length);
  const header = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: envelope.length,
    payloadFnv: fnv1a(envelope),
  };

  canvas.width = size;
  canvas.height = size;
  canvas.style.width = `${Math.min(560, size)}px`;
  canvas.style.height = canvas.style.width;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const cx = size / 2;
  const rOut = 0.48 * size;
  const rIn = 0.16 * size;
  const ringW = (rOut - rIn) / g.rings;
  const S = g.sectors;
  const slotSpan = (2 * Math.PI) / S;

  const colorOfRingSlot = (ring: number, k: number, phase: number, cells: Uint8Array): number => {
    const j = sectorAt(g, ring, k, phase);
    if (ring === 0) return syncColor(j);
    if (ring === g.rings - 1) return j % 8;
    return cells[(ring - 1) * S + j]!;
  };

  const render = (seq: number, cells: Uint8Array) => {
    const phase = seq % S;
    ctx.fillStyle = "#0a0906";
    ctx.fillRect(0, 0, size, size);
    for (let p = 0; p < PALETTE.length; p++) {
      const [r, gr, b] = PALETTE[p]!;
      ctx.fillStyle = `rgb(${r},${gr},${b})`;
      ctx.beginPath();
      for (let ring = 0; ring < g.rings; ring++) {
        const r0 = rIn + ring * ringW + ringW * 0.08;
        const r1 = rIn + (ring + 1) * ringW - ringW * 0.08;
        for (let j = 0; j < S; j++) {
          if (colorOfRingSlot(ring, slotOf(g, ring, j, phase), phase, cells) !== p) continue;
          const k = slotOf(g, ring, j, phase);
          const a0 = k * slotSpan + slotSpan * 0.06 - Math.PI / 2;
          const a1 = (k + 1) * slotSpan - slotSpan * 0.06 - Math.PI / 2;
          ctx.moveTo(cx + r1 * Math.cos(a0), cx + r1 * Math.sin(a0));
          ctx.arc(cx, cx, r1, a0, a1);
          ctx.lineTo(cx + r0 * Math.cos(a1), cx + r0 * Math.sin(a1));
          ctx.arc(cx, cx, r0, a1, a0, true);
          ctx.closePath();
        }
      }
      ctx.fill();
    }
  };

  // Normalised radius of a ring's centre. The denominator is the outermost
  // LIT radius, not rOut: wedges are drawn with an 8% radial inset, so the
  // last lit pixel sits short of the nominal rim and that is what the locator
  // actually measures. Dividing by rOut instead would bias every sample
  // inward by a fraction of a ring.
  const rLit = rOut - ringW * 0.08;
  const rhoOf = (ring: number) => (rIn + (ring + 0.5) * ringW) / rLit;

  /**
   * Decode from an image that may be anywhere, any size, tilted and rotated.
   * Nothing here knows where the symbol was drawn — that is the entire point.
   */
  const decodeFrame = (data: Uint8ClampedArray, w: number, h: number):
    | "ok" | "corrupt" | "dup" | "lost" => {
    // 1) find the mandala: moments give centre and principal axes, a high
    //    percentile of the projected extent gives the outer rim.
    const e = locate(data, w, h);
    if (!e) return "lost";

    const ringWpx = (e.su * (1 - rIn / rLit)) / g.rings;
    const rad = Math.max(1, Math.floor(ringWpx * 0.22));
    const smp = (x: number, y: number) => sampleAt(data, w, h, x, y, rad);

    // 2) the marker's angular centroid, measured to a fraction of a slot.
    //    Integer-slot alignment is not enough: half a wedge out and every
    //    sample lands in the gaps between wedges.
    const isMarker = (rgb: [number, number, number]) =>
      classify(rgb[0], rgb[1], rgb[2], PALETTE as unknown as number[][]) === MARKER;
    const th0 = findMarkerAngle(e, rhoOf(0), S, smp, isMarker);
    if (th0 === null) return "corrupt";

    // 3) anchor the slot grid on the marker. Slot k' is counted from it, so
    //    the unknown camera rotation AND the frame's own phase both cancel:
    //    sector = (k' - ring*SPIRAL) mod S, with no phase term at all.
    const angle = (kp: number) => th0 + kp * slotSpan;
    const secOf = (ring: number, kp: number) => (((kp - ring * SPIRAL) % S) + S) % S;
    const at = (ring: number, kp: number) => {
      const [x, y] = polarToImage(e, rhoOf(ring), angle(kp));
      return smp(x, y);
    };

    // 4) per-frame classifier from the calibration ring
    const sums: number[][] = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
    for (let kp = 0; kp < S; kp++) {
      const s = sums[secOf(g.rings - 1, kp) % 8]!;
      const [r, gr, b] = at(g.rings - 1, kp);
      s[0]! += r;
      s[1]! += gr;
      s[2]! += b;
      s[3]! += 1;
    }
    const centroids = sums.map((s) => [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!]);

    // 5) data cells
    const cells = new Uint8Array(dataRings(g) * S);
    for (let ring = 1; ring < g.rings - 1; ring++) {
      for (let kp = 0; kp < S; kp++) {
        const [r, gr, b] = at(ring, kp);
        cells[(ring - 1) * S + secOf(ring, kp)] = classify(r, gr, b, centroids);
      }
    }
    const bytes = cellsToBytes(cells, g);
    const frameLen = HEADER_LEN + blockLen;
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    if (dv.getUint32(frameLen, true) !== fnv1a(bytes.subarray(0, frameLen))) return "corrupt";
    const parsed = parseFrame(bytes.subarray(0, frameLen));
    if (!parsed) return "corrupt";
    const before = decoder.framesNew;
    decoder.addFrame(parsed.header.seq, parsed.block);
    return decoder.framesNew > before ? "ok" : "dup";
  };

  // Camera presets. "off" still runs the full locator against the pristine
  // canvas — the decoder never gets to assume it knows where the symbol is.
  const CAMS: Record<string, { out: number; tilt: number; rotate: number; fill: number; blur: number } | null> = {
    off: null,
    square: { out: 720, tilt: 0.05, rotate: 0.35, fill: 0.86, blur: 1 },
    tilted: { out: 720, tilt: 0.35, rotate: 1.1, fill: 0.72, blur: 1 },
    harsh: { out: 540, tilt: 0.55, rotate: 2.4, fill: 0.6, blur: 2 },
  };
  const cam = CAMS[cfg("cfg-cam")] ?? null;
  camStage.style.display = cam ? "block" : "none";
  if (cam) {
    camCanvas.width = cam.out;
    camCanvas.height = cam.out;
    camCanvas.style.width = `${Math.min(420, cam.out)}px`;
    camCanvas.style.height = camCanvas.style.width;
  }

  let seq = 0;
  let ok = 0;
  let corrupt = 0;
  let lost = 0;
  let renderMs = 0;
  let decodeMs = 0;
  const t0 = performance.now();
  const rawKBs = (cap * fps) / 1024;
  statusEl.textContent = "running…";

  timer = window.setInterval(() => {
    if (!running) return;
    const frameBytes = packFrame({ ...header, seq }, encoder.encode(seq));
    const withTrailer = new Uint8Array(cap);
    withTrailer.set(frameBytes);
    new DataView(withTrailer.buffer).setUint32(frameBytes.length, fnv1a(frameBytes), true);
    const cells = bytesToCells(withTrailer, g);
    let t = performance.now();
    render(seq, cells);
    renderMs += performance.now() - t;

    t = performance.now();
    let img = ctx.getImageData(0, 0, size, size);
    if (cam) {
      img = photograph(img, { ...cam, chroma420: true, noise });
      camCtx.putImageData(img, 0, 0);
    } else if (noise > 0) {
      // keep the old knob meaningful when no camera is simulated
      for (let p = 0; p < img.data.length; p += 4) {
        for (let c = 0; c < 3; c++) {
          img.data[p + c] = img.data[p + c]! + (Math.random() * 2 - 1) * noise;
        }
      }
    }
    const res = decodeFrame(img.data, img.width, img.height);
    decodeMs += performance.now() - t;
    if (res === "ok") ok++;
    else if (res === "corrupt") corrupt++;
    else if (res === "lost") lost++;
    seq++;
    const elapsed = (performance.now() - t0) / 1000;
    statusEl.textContent =
      `${decoder.framesNew}/${Math.ceil(encoder.k * 1.18)} frames · ${ok} ok · ${corrupt} corrupt · ` +
      `${lost} not found · render ${(renderMs / seq).toFixed(1)} ms · ` +
      `decode ${(decodeMs / seq).toFixed(1)} ms · raw ${rawKBs.toFixed(0)} KB/s`;
    if (decoder.isComplete) {
      const out = decoder.assemble()!;
      const verified = fnv1a(out) === header.payloadFnv;
      const goodput = payloadLen / 1024 / elapsed;
      logEl.textContent =
        `${size}px ${g.rings}r×${S}s (${cap} B/frame, block ${blockLen}) @ ${fps} fps ` +
        `noise±${noise} cam:${cfg("cfg-cam")} → ` +
        `${(payloadLen / 1024).toFixed(0)} KB in ${elapsed.toFixed(1)} s · ${goodput.toFixed(1)} KB/s · ` +
        `${corrupt} corrupt · ${lost} not found · hash ${verified ? "verified ✓" : "MISMATCH ✗"}\n${logEl.textContent}`;
      stop(`done — ${verified ? "verified ✓" : "MISMATCH ✗"}`);
    }
  }, 1000 / fps);
}

registerOfflineWorker("../");
