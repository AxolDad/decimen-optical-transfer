// QR generation worker. At 3.4 ms per code (pinned mask), grid mode at high
// fps needs more generation throughput than one main thread has spare —
// 4 codes × 60 fps ≈ 800 ms of work per second. A small pool of these
// workers renders complete display tiles (1/2/4 codes with quiet zones) and
// transfers them to the main thread, which only flips pre-rendered frames.
//
// Frame ORDER does not matter to the fountain, so tiles can be produced and
// consumed in any order — no sequencing discipline needed across workers.

import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import { gridLayout, type GridLayout } from "./layout";
import { packFrame, type FrameHeader } from "../shared/protocol";

interface InitMsg {
  type: "init";
  payload: Uint8Array;
  blockLen: number;
  ecc: "L" | "M" | "Q" | "H";
  codes: 1 | 2 | 4;
  header: FrameHeader;
}

interface GenMsg {
  type: "gen";
  seqs: number[];
}

let encoder: LTEncoder | null = null;
let header: FrameHeader | null = null;
let ecc: "L" | "M" | "Q" | "H" = "L";
let version: number | undefined;
let moduleCount = 0;
let layout: GridLayout | null = null;

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

function makeQR(seq: number) {
  const bytes = packFrame({ ...header!, seq }, encoder!.encode(seq));
  return QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
    errorCorrectionLevel: ecc,
    version,
    maskPattern: 4,
  });
}

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data as InitMsg | GenMsg;
  try {
    if (msg.type === "init") {
      encoder = new LTEncoder(msg.payload, msg.blockLen, msg.header.sessionId);
      header = msg.header;
      ecc = msg.ecc;
      const probe = makeQR(0); // locks version/moduleCount — same for every frame
      version = probe.version;
      moduleCount = probe.modules.size;
      layout = gridLayout(moduleCount, msg.codes);
      ctx.postMessage({ type: "ready", version, w: layout.w, h: layout.h });
      return;
    }
    const { w, h, offsets } = layout!;
    const img = new ImageData(w, h);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    msg.seqs.forEach((seq, i) => {
      const qr = makeQR(seq);
      const size = qr.modules.size;
      const data = qr.modules.data;
      const off = offsets[i]!;
      for (let y = 0; y < size; y++) {
        const row = (off.y + y) * w + off.x;
        const src = y * size;
        for (let x = 0; x < size; x++) {
          if (data[src + x]) px[row + x] = 0xff000000;
        }
      }
    });
    ctx.postMessage({ type: "tile", buf: img.data.buffer, w, h, seqs: msg.seqs }, [
      img.data.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
