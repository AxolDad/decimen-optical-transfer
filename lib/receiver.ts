// OpticalReceiver — the embeddable receive engine (Phase 4), DOM-free except
// for the caller-supplied <video> element it reads frames from.
//
// Pipeline (unchanged from the pages era, now instance-scoped):
//   camera | video file | MediaStream → rVFC → VideoFrame/canvas capture →
//   zxing workers (acquire/locked ROI cells) → fountain decoder → envelope →
//   [sealed? wait for key → unseal] → file bytes + metadata.
//
// Sealed streams separate COLLECTION from DECRYPTION: onLocked fires when a
// complete, FNV-verified ciphertext is held; unlock(key) can happen before,
// during, or long after — a wrong key fails GCM auth cleanly.

import { unseal, isSealed } from "../shared/crypto";
import { FLAG_DEFLATE, inflate, parseEnvelope } from "../shared/envelope";
import { LTDecoder } from "../shared/fountain";
import { fnv1a, parseFrame, sameStream, type FrameHeader } from "../shared/protocol";
import { bboxOfCorners, roiFromCorners, type Pt, type Roi } from "../receive/roi";

const OVERHEAD_EST = 1.18; // measured 1.11–1.28; progress/goodput estimate only
const MISS_LIMIT = 12;
const MAX_CELLS = 4;
const SWEEP_MS = 1000;

const ACQUIRE_OPTS = {
  formats: ["QRCode"] as string[],
  maxNumberOfSymbols: MAX_CELLS,
  tryHarder: true,
  tryRotate: false,
  tryInvert: false,
  tryDownscale: true,
};

export interface ReceivedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
  wireLength: number; // bytes that crossed the light channel
  deflated: boolean;
  sealed: boolean;
  seconds: number; // first frame → collection complete
}

export interface ReceiverStats {
  captureFps: number;
  decodeFps: number;
  decodeMs: number;
  cells: number;
  roi: string;
  usingVideoFrame: boolean;
  framesNew: number;
  framesDup: number;
  k: number;
  blockLen: number;
  totalLen: number;
  goodputKBs: number;
  elapsed: number;
}

export interface ReceiverOptions {
  video: HTMLVideoElement;
  /** Omit to open the camera; pass a MediaStream or a recorded video File. */
  source?: MediaStream | File;
  captureWidth?: number;
  captureFps?: number;
  workers?: number | "auto";
  /** Pre-supplied key for sealed streams (hex-64 or passphrase). */
  key?: string;
  onProgress?(fraction: number): void;
  /** Complete + verified, but sealed — call unlock(key). */
  onLocked?(wireLength: number): void;
  onComplete?(file: ReceivedFile): void;
  onError?(message: string): void;
  onStats?(stats: ReceiverStats): void;
}

interface Cell {
  id: number;
  roi: Roi;
  cx: number;
  cy: number;
  miss: number;
}

export class OpticalReceiver {
  private readonly opts: ReceiverOptions;
  private readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private fileUrl: string | null = null;
  private decoder: LTDecoder | null = null;
  private streamHeader: FrameHeader | null = null;
  private startTs = 0;
  private gen = 0;
  private stopped = false;
  private collected = false;
  private statsTimer = 0;
  private key: string | undefined;
  private lockedWire: Uint8Array | null = null;
  private lockedSeconds = 0;

  private cells: Cell[] = [];
  private nextCellId = 1;
  private rotor = 0;
  private lastSweep = 0;
  private useVideoFrame = typeof VideoFrame === "function";
  private vfUnsupported = 0;
  private emaDecMs = 0;
  private focusFrozen = false;

  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private readonly crops = new Map<number, { ox: number; oy: number; cellId: number }>();
  private captureTimes: number[] = [];
  private decodeTimes: number[] = [];
  private pendingJobs: (Cell | null)[] = [];
  private grab: HTMLCanvasElement | null = null;
  private frameId = 0;

  constructor(opts: ReceiverOptions) {
    this.opts = opts;
    this.video = opts.video;
    this.key = opts.key;
  }

  async start(): Promise<void> {
    const src = this.opts.source;
    if (src instanceof File) {
      this.fileUrl = URL.createObjectURL(src);
      this.video.src = this.fileUrl;
      this.video.loop = true;
      this.video.muted = true;
    } else if (src) {
      this.video.srcObject = src;
    } else {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "camera needs a secure context — serve this page over https (or pass a video file)",
        );
      }
      const width = this.opts.captureWidth ?? 1280;
      const fps = this.opts.captureFps ?? 60;
      const base: MediaTrackConstraints = {
        facingMode: "environment",
        width: { ideal: width },
        height: { ideal: Math.round((width * 3) / 4) },
      };
      try {
        // iOS delivers 30 for {ideal: 60}; demand exact first, then fall back
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { exact: fps } },
        });
      } catch {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { ideal: fps } },
        });
      }
      this.video.srcObject = this.stream;
    }
    this.video.playsInline = true;
    await this.video.play().catch(() => undefined);

    const wanted = this.opts.workers ?? "auto";
    const workerCount =
      wanted === "auto" ? Math.min(Math.max(1, (navigator.hardwareConcurrency || 4) - 1), 4) : wanted;
    for (let i = 0; i < workerCount; i++) this.spawnWorker(i);
    this.gen++;
    this.scheduleFrame(this.gen);
    this.statsTimer = window.setInterval(() => this.emitStats(), 500);
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    clearInterval(this.statsTimer);
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.fileUrl) {
      URL.revokeObjectURL(this.fileUrl);
      this.fileUrl = null;
    }
  }

  setKey(key: string): void {
    this.key = key;
    if (this.lockedWire) void this.unlock();
  }

  /** Open a collected sealed stream. No-op until onLocked has fired. */
  async unlock(key?: string): Promise<void> {
    if (key !== undefined) this.key = key;
    if (!this.lockedWire || this.key === undefined || this.key === "") return;
    let envelope: Uint8Array;
    try {
      envelope = await unseal(this.lockedWire, this.key);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }
    await this.deliver(envelope, this.lockedWire.length, true, this.lockedSeconds);
  }

  camera(): MediaStream | null {
    return this.stream;
  }

  // ---- internals ----------------------------------------------------------

  private spawnWorker(slot: number) {
    const w = new Worker(new URL("../receive/worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent) => {
      const { id, results, ms, unsupported } = e.data as {
        id: number;
        results: { bytes: Uint8Array; corners: Pt[] | null }[];
        ms: number;
        unsupported?: boolean;
      };
      if (id === -1) return; // warm-up
      this.busy[slot] = false;
      const crop = this.crops.get(id);
      this.crops.delete(id);
      if (unsupported) {
        if (++this.vfUnsupported > 5) this.useVideoFrame = false;
        this.drainPending();
        return;
      }
      if (ms > 0) this.emaDecMs = this.emaDecMs === 0 ? ms : this.emaDecMs * 0.9 + ms * 0.1;
      if (results.length > 0) {
        for (const r of results) {
          if (r.corners && crop) {
            this.absorbPosition(r.corners.map((c) => ({ x: c.x + crop.ox, y: c.y + crop.oy })));
          }
          this.onDecoded(r.bytes);
        }
      } else if (crop && crop.cellId !== 0) {
        const cell = this.cells.find((c) => c.id === crop.cellId);
        if (cell && ++cell.miss >= MISS_LIMIT) {
          this.cells = this.cells.filter((c) => c !== cell);
          if (this.cells.length === 0) void this.unfreezeFocus();
        }
      }
      this.drainPending();
    };
    const revive = () => {
      w.terminate();
      if (!this.stopped) this.spawnWorker(slot);
    };
    w.onerror = revive;
    w.onmessageerror = revive;
    this.workers[slot] = w;
    this.busy[slot] = false;
  }

  private absorbPosition(abs: Pt[]) {
    const b = bboxOfCorners(abs);
    const next = roiFromCorners(abs, this.video.videoWidth, this.video.videoHeight);
    if (!b || !next) return;
    let best: Cell | null = null;
    let bestDist = Infinity;
    for (const cell of this.cells) {
      const d = Math.hypot(cell.cx - b.cx, cell.cy - b.cy);
      if (d < bestDist) {
        bestDist = d;
        best = cell;
      }
    }
    // identity by SYMBOL center — crop centers clamp at frame edges and lie
    if (best && bestDist < 0.6 * Math.max(b.w, b.h)) {
      best.roi = next;
      best.cx = b.cx;
      best.cy = b.cy;
      best.miss = 0;
      return;
    }
    if (this.cells.length < MAX_CELLS) {
      if (this.cells.length === 0) void this.freezeFocus();
      this.cells.push({ id: this.nextCellId++, roi: next, cx: b.cx, cy: b.cy, miss: 0 });
    }
  }

  private async freezeFocus() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track?.getCapabilities || this.focusFrozen) return;
    try {
      const caps = track.getCapabilities() as { focusMode?: string[] };
      const cur = (track.getSettings() as MediaTrackSettings & { focusDistance?: number })
        .focusDistance;
      if (!caps.focusMode?.includes("manual") || cur === undefined) return;
      await track.applyConstraints({
        advanced: [
          { focusMode: "manual", focusDistance: cur } as unknown as MediaTrackConstraintSet,
        ],
      });
      this.focusFrozen = true;
    } catch {
      /* best-effort */
    }
  }

  private async unfreezeFocus() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || !this.focusFrozen) return;
    this.focusFrozen = false;
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: "continuous" } as unknown as MediaTrackConstraintSet],
      });
    } catch {
      /* fine */
    }
  }

  private scheduleFrame(gen: number) {
    if (this.stopped || this.collected || gen !== this.gen) return;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const next = () => {
      if (this.stopped || this.collected || gen !== this.gen) return;
      this.captureFrame();
      this.scheduleFrame(gen);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
    else requestAnimationFrame(next);
  }

  private drainPending() {
    while (this.pendingJobs.length > 0) {
      const job = this.pendingJobs[0]!;
      if (!this.dispatchJob(job)) return;
      this.pendingJobs.shift();
      if (job === null) this.lastSweep = performance.now();
    }
  }

  private captureFrame() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;
    this.captureTimes.push(performance.now());
    if (this.cells.length === 0) {
      this.pendingJobs = [];
      this.dispatchJob(null);
      return;
    }
    const wanted: (Cell | null)[] = [];
    if (performance.now() - this.lastSweep > SWEEP_MS) wanted.push(null);
    for (let i = 0; i < this.cells.length; i++) {
      wanted.push(this.cells[(i + this.rotor) % this.cells.length]!);
    }
    this.rotor++;
    this.pendingJobs = wanted;
    this.drainPending();
  }

  private dispatchJob(cell: Cell | null): boolean {
    // A worker reply queued before haltCapture() can land after the pool is
    // gone; never dispatch once collected/stopped.
    if (this.collected || this.stopped || this.workers.length === 0) return false;
    const slot = this.busy.indexOf(false);
    if (slot === -1 || !this.workers[slot]) return false;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const r = cell?.roi;
    const opts = r ? undefined : ACQUIRE_OPTS;
    const id = this.frameId++;
    this.crops.set(id, { ox: r?.x ?? 0, oy: r?.y ?? 0, cellId: cell?.id ?? 0 });
    this.busy[slot] = true;
    if (this.useVideoFrame) {
      try {
        const vf = new VideoFrame(this.video);
        this.workers[slot]!.postMessage(
          { id, frame: vf, rect: r ? { x: r.x, y: r.y, width: r.w, height: r.h } : undefined, opts },
          [vf as unknown as Transferable],
        );
        return true;
      } catch {
        this.useVideoFrame = false;
      }
    }
    this.grab ??= document.createElement("canvas");
    const cw = r?.w ?? vw;
    const ch = r?.h ?? vh;
    if (this.grab.width !== cw || this.grab.height !== ch) {
      this.grab.width = cw;
      this.grab.height = ch;
    }
    const ctx = this.grab.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(this.video, r?.x ?? 0, r?.y ?? 0, cw, ch, 0, 0, cw, ch);
    const img = ctx.getImageData(0, 0, cw, ch);
    this.workers[slot]!.postMessage({ id, buf: img.data.buffer, w: cw, h: ch, opts }, [
      img.data.buffer,
    ]);
    return true;
  }

  private onDecoded(bytes: Uint8Array) {
    this.decodeTimes.push(performance.now());
    const parsed = parseFrame(bytes);
    if (!parsed || this.collected) return;
    const { header, block } = parsed;
    if (!this.decoder || !this.streamHeader || !sameStream(this.streamHeader, header)) {
      this.decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
      this.streamHeader = header;
      this.startTs = performance.now();
    }
    this.decoder.addFrame(header.seq, block);
    this.opts.onProgress?.(
      Math.min(0.99, this.decoder.framesNew / (this.decoder.k * OVERHEAD_EST)),
    );
    if (this.decoder.isComplete) {
      const wire = this.decoder.assemble()!;
      const seconds = (performance.now() - this.startTs) / 1000;
      this.collected = true;
      this.haltCapture();
      if (fnv1a(wire) !== header.payloadFnv) {
        this.opts.onError?.("transfer hash mismatch");
        return;
      }
      this.opts.onProgress?.(1);
      if (isSealed(wire)) {
        this.lockedWire = wire;
        this.lockedSeconds = seconds;
        this.opts.onLocked?.(wire.length);
        if (this.key) void this.unlock();
      } else {
        void this.deliver(wire, wire.length, false, seconds);
      }
    }
  }

  private haltCapture() {
    this.gen++;
    clearInterval(this.statsTimer);
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.fileUrl) this.video.pause();
  }

  private async deliver(envelope: Uint8Array, wireLength: number, sealed: boolean, seconds: number) {
    const parsed = parseEnvelope(envelope);
    if (!parsed) {
      this.opts.onError?.("received, but the envelope is malformed");
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = parsed.flags & FLAG_DEFLATE ? await inflate(parsed.data) : parsed.data;
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }
    if (bytes.length !== parsed.meta.size) {
      this.opts.onError?.("size mismatch after decompression");
      return;
    }
    this.lockedWire = null;
    this.opts.onComplete?.({
      name: parsed.meta.name,
      mime: parsed.meta.mime,
      bytes,
      wireLength,
      deflated: (parsed.flags & FLAG_DEFLATE) !== 0,
      sealed,
      seconds,
    });
  }

  private emitStats() {
    if (!this.opts.onStats || this.collected) return;
    const now = performance.now();
    const prune = (a: number[]) => {
      while (a.length > 0 && a[0]! < now - 2000) a.shift();
    };
    prune(this.captureTimes);
    prune(this.decodeTimes);
    const first = this.cells[0];
    const d = this.decoder;
    const elapsed = d ? (now - this.startTs) / 1000 : 0;
    this.opts.onStats({
      captureFps: this.captureTimes.length / 2,
      decodeFps: this.decodeTimes.length / 2,
      decodeMs: this.emaDecMs,
      cells: this.cells.length,
      roi: first ? `${this.cells.length}× ${first.roi.w}×${first.roi.h}` : "full",
      usingVideoFrame: this.useVideoFrame,
      framesNew: d?.framesNew ?? 0,
      framesDup: d?.framesDup ?? 0,
      k: d?.k ?? 0,
      blockLen: d?.blockLen ?? 0,
      totalLen: d?.totalLen ?? 0,
      goodputKBs: d ? (d.framesNew * d.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed) : 0,
      elapsed,
    });
  }
}
