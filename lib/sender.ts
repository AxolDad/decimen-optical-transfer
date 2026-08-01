// OpticalSender — the embeddable send engine (Phase 4). Renders an endless
// fountain-coded QR stream onto a caller-supplied canvas; optionally seals
// the payload (Phase 3B) so the stream is publishable ciphertext; can export
// a finite recording of itself as a video file for hosting anywhere.

import { seal } from "../shared/crypto";
import { FLAG_DEFLATE, deflate, packEnvelope, type FileMeta } from "../shared/envelope";
import { HEADER_LEN, fnv1a, type FrameHeader } from "../shared/protocol";
import { estimateRefresh, vsyncPacing } from "../send/pacing";

const GEN_WORKERS = 2;
const QUEUE_DEPTH = 4;
const BATCH_PER_WORKER = 2;

export interface SenderPayload {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

export interface SenderInfo {
  fps: number;
  ticks: number;
  refreshHz: number;
  version: number;
  k: number;
  codes: number;
  frameBytes: number;
  ecc: string;
  fileSize: number;
  wireSize: number; // envelope (or sealed wire) length actually streamed
  deflatedPct: number | null; // null = compression didn't pay
  sealed: boolean;
  estSeconds: number;
  rawKBs: number;
}

export interface SenderOptions {
  canvas: HTMLCanvasElement;
  payload: SenderPayload;
  targetFps?: number; // default 30
  frameBytes?: number; // default 1465 (QR v27)
  codes?: 1 | 2 | 4; // default 1
  ecc?: "L" | "M" | "Q" | "H"; // default L
  displayPx?: number; // CSS budget, default 900
  /** Seal the stream: 64-hex raw key or a passphrase (Phase 3B). */
  encryptKey?: string;
  /** Try raw-deflate and keep it when smaller. Default true. */
  compress?: boolean;
  onReady?(info: SenderInfo): void;
  onError?(message: string): void;
  onStarve?(starved: number, flips: number): void;
}

// One refresh-rate measurement per page, shared by every sender instance.
let refreshPromise: Promise<number> | null = null;
function measureRefresh(): Promise<number> {
  refreshPromise ??= new Promise<number>((res) => {
    const ts: number[] = [];
    const cb = (t: number) => {
      ts.push(t);
      if (ts.length < 24) requestAnimationFrame(cb);
      else res(estimateRefresh(ts));
    };
    requestAnimationFrame(cb);
  });
  return refreshPromise;
}

export class OpticalSender {
  private readonly opts: SenderOptions;
  private workers: Worker[] = [];
  private stopped = false;
  private info: SenderInfo | null = null;
  private fps = 30;
  private codes: 1 | 2 | 4 = 1;
  private k = 0;

  constructor(opts: SenderOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const o = this.opts;
    const targetFps = o.targetFps ?? 30;
    const frameBytes = o.frameBytes ?? 1465;
    const codes = (o.codes ?? 1) as 1 | 2 | 4;
    const ecc = o.ecc ?? "L";
    const displayPx = o.displayPx ?? 900;
    this.codes = codes;

    // envelope → optional deflate → optional seal = the wire the fountain carries
    const meta: FileMeta = { name: o.payload.name, mime: o.payload.mime, size: o.payload.bytes.length };
    let data = o.payload.bytes;
    let flags = 0;
    if (o.compress !== false) {
      const squeezed = await deflate(data);
      if (squeezed && squeezed.length < data.length * 0.97) {
        data = squeezed;
        flags = FLAG_DEFLATE;
      }
    }
    let wire = packEnvelope(meta, data, flags);
    const sealed = o.encryptKey !== undefined && o.encryptKey !== "";
    if (sealed) wire = await seal(wire, o.encryptKey!);

    const refresh = await measureRefresh();
    if (this.stopped) return;
    const { ticks, fps } = vsyncPacing(refresh, targetFps);
    this.fps = fps;

    const blockLen = frameBytes - HEADER_LEN;
    const k = Math.max(1, Math.ceil(wire.length / blockLen));
    this.k = k;
    if (blockLen < 1 || blockLen > 0xffff || k > 0xffff) {
      o.onError?.(`payload needs ${k} blocks of ${blockLen} B — outside the header's u16 fields`);
      return;
    }
    const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
    const header: FrameHeader = {
      sessionId,
      seq: 0,
      k,
      blockLen,
      totalLen: wire.length,
      payloadFnv: fnv1a(wire),
    };

    const canvas = o.canvas;
    const staging = document.createElement("canvas");
    const queue: ImageData[] = [];
    let tileW = 0;
    let tileH = 0;
    let nextSeq = 0;
    const pending: number[] = [];
    let starved = 0;
    let flips = 0;

    const sizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
      const scale = Math.max(1, Math.floor((cssBudget * dpr) / Math.max(tileW, tileH)));
      staging.width = tileW;
      staging.height = tileH;
      canvas.width = tileW * scale;
      canvas.height = tileH * scale;
      canvas.style.width = `${(tileW * scale) / dpr}px`;
      canvas.style.height = `${(tileH * scale) / dpr}px`;
    };

    const dispatch = () => {
      if (this.stopped || this.workers.length === 0) return;
      for (;;) {
        const inFlight = pending.reduce((a, b) => a + b, 0);
        if (queue.length + inFlight >= QUEUE_DEPTH) return;
        let wi = 0;
        for (let i = 1; i < pending.length; i++) if (pending[i]! < pending[wi]!) wi = i;
        if ((pending[wi] ?? Infinity) >= BATCH_PER_WORKER) return;
        if (!this.workers[wi]) return;
        const seqs: number[] = [];
        for (let j = 0; j < codes; j++) seqs.push(nextSeq++);
        this.workers[wi]!.postMessage({ type: "gen", seqs });
        pending[wi] = pending[wi]! + 1;
      }
    };

    let ready = false;
    for (let i = 0; i < GEN_WORKERS; i++) {
      const wi = i;
      const w = new Worker(new URL("../send/genworker.ts", import.meta.url), { type: "module" });
      pending.push(0);
      w.onmessage = (e: MessageEvent) => {
        if (this.stopped) return;
        const msg = e.data as
          | { type: "ready"; version: number; w: number; h: number }
          | { type: "tile"; buf: ArrayBuffer; w: number; h: number; seqs: number[] }
          | { type: "error"; message: string };
        if (msg.type === "error") {
          o.onError?.(msg.message);
          return;
        }
        if (msg.type === "ready") {
          if (!ready) {
            ready = true;
            tileW = msg.w;
            tileH = msg.h;
            sizeCanvas();
            const rawKBs = (codes * blockLen * fps) / 1024;
            this.info = {
              fps,
              ticks,
              refreshHz: refresh,
              version: msg.version,
              k,
              codes,
              frameBytes,
              ecc,
              fileSize: meta.size,
              wireSize: wire.length,
              deflatedPct: flags & FLAG_DEFLATE ? Math.round((100 * data.length) / meta.size) : null,
              sealed,
              estSeconds: Math.ceil((wire.length * 1.18) / (codes * blockLen * fps)),
              rawKBs,
            };
            o.onReady?.(this.info);
          }
          dispatch();
          return;
        }
        pending[wi] = pending[wi]! - 1;
        queue.push(new ImageData(new Uint8ClampedArray(msg.buf), msg.w, msg.h));
        dispatch();
      };
      w.onerror = () => {
        if (!this.stopped) o.onError?.("QR generation worker crashed");
      };
      w.postMessage({ type: "init", payload: wire, blockLen, ecc, codes, header });
      this.workers.push(w);
    }

    let sinceFlip = 0;
    const tick = () => {
      if (this.stopped) return;
      requestAnimationFrame(tick);
      sinceFlip++;
      if (sinceFlip < ticks || !ready) return;
      const img = queue.shift();
      if (!img) {
        if (sinceFlip === ticks) {
          starved++;
          o.onStarve?.(starved, flips);
        }
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
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }

  /** Record the live stream into a standalone video (host it anywhere — the
   * video IS the ciphertext container when sealed). Captures enough frames
   * for a receiver to reconstruct from the recording alone: K × overhead. */
  async exportVideo(overhead = 1.5): Promise<Blob> {
    if (!this.info) throw new Error("start() first — export needs a running stream");
    const seconds = Math.ceil(((this.k * overhead) / this.codes / this.fps) * 10) / 10 + 1;
    const stream = this.opts.canvas.captureStream(this.fps);
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 12_000_000, // generous — sharp modules survive
    });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const done = new Promise<Blob>((resolve, reject) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType }));
      rec.onerror = () => reject(new Error("recording failed"));
    });
    rec.start(1000);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    rec.stop();
    stream.getTracks().forEach((t) => t.stop());
    return done;
  }

  /** Export duration for the current stream at `overhead`, in seconds. */
  exportSeconds(overhead = 1.5): number {
    return this.info ? Math.ceil((this.k * overhead) / this.codes / this.fps) + 1 : 0;
  }
}
