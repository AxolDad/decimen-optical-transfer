// EXPERIMENT — kaleidoscope loopback: fountain → mandala pixels → decode.
// Everything below the symbology (envelope, protocol header, LT fountain) is
// the production code, unchanged; only the pixels differ from the QR path.

import { packEnvelope } from "../shared/envelope";
import { LTDecoder, LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, parseFrame, splitmix32 } from "../shared/protocol";
import {
  PALETTE,
  bytesToCells,
  capacityBytes,
  cellsToBytes,
  classify,
  dataRings,
  findPhase,
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

  const sampleRing = (img: ImageData, ring: number, k: number): [number, number, number] => {
    const a = (k + 0.5) * slotSpan - Math.PI / 2;
    const r = rIn + (ring + 0.5) * ringW;
    const x = Math.round(cx + r * Math.cos(a));
    const y = Math.round(cx + r * Math.sin(a));
    let rr = 0;
    let gg = 0;
    let bb = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const o = ((y + dy) * size + x + dx) * 4;
        rr += img.data[o]!;
        gg += img.data[o + 1]!;
        bb += img.data[o + 2]!;
      }
    }
    const n = () => (noise > 0 ? (Math.random() * 2 - 1) * noise : 0);
    return [rr / 9 + n(), gg / 9 + n(), bb / 9 + n()];
  };

  const decodeFrame = (): "ok" | "corrupt" | "dup" => {
    const img = ctx.getImageData(0, 0, size, size);
    // 1) phase from the sync ring (static palette is enough: its three
    //    colors are far apart even under heavy noise)
    const syncSeen: number[] = [];
    for (let k = 0; k < S; k++) {
      const [r, gr, b] = sampleRing(img, 0, k);
      syncSeen.push(classify(r, gr, b, PALETTE as unknown as number[][]));
    }
    const phase = findPhase(syncSeen);
    if (phase < 0) return "corrupt";
    // 2) per-frame classifier centroids from the calibration ring
    const sums: number[][] = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
    for (let k = 0; k < S; k++) {
      const j = sectorAt(g, g.rings - 1, k, phase);
      const s = sums[j % 8]!;
      const [r, gr, b] = sampleRing(img, g.rings - 1, k);
      s[0]! += r;
      s[1]! += gr;
      s[2]! += b;
      s[3]! += 1;
    }
    const centroids = sums.map((s) => [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!]);
    // 3) data cells
    const cells = new Uint8Array(dataRings(g) * S);
    for (let ring = 1; ring < g.rings - 1; ring++) {
      for (let k = 0; k < S; k++) {
        const j = sectorAt(g, ring, k, phase);
        const [r, gr, b] = sampleRing(img, ring, k);
        cells[(ring - 1) * S + j] = classify(r, gr, b, centroids);
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

  let seq = 0;
  let ok = 0;
  let corrupt = 0;
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
    const res = decodeFrame();
    decodeMs += performance.now() - t;
    if (res === "ok") ok++;
    else if (res === "corrupt") corrupt++;
    seq++;
    const elapsed = (performance.now() - t0) / 1000;
    statusEl.textContent =
      `${decoder.framesNew}/${Math.ceil(encoder.k * 1.18)} frames · ${ok} ok · ${corrupt} corrupt · ` +
      `render ${(renderMs / seq).toFixed(1)} ms · decode ${(decodeMs / seq).toFixed(1)} ms · ` +
      `raw ${rawKBs.toFixed(0)} KB/s`;
    if (decoder.isComplete) {
      const out = decoder.assemble()!;
      const verified = fnv1a(out) === header.payloadFnv;
      const goodput = payloadLen / 1024 / elapsed;
      logEl.textContent =
        `${size}px ${g.rings}r×${S}s (${cap} B/frame, block ${blockLen}) @ ${fps} fps noise±${noise} → ` +
        `${(payloadLen / 1024).toFixed(0)} KB in ${elapsed.toFixed(1)} s · ${goodput.toFixed(1)} KB/s · ` +
        `${corrupt} corrupt frames · hash ${verified ? "verified ✓" : "MISMATCH ✗"}\n${logEl.textContent}`;
      stop(`done — ${verified ? "verified ✓" : "MISMATCH ✗"}`);
    }
  }, 1000 / fps);
}
