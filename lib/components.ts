// <optical-sender> / <optical-receiver> — zero-framework embedding (Phase 4).
// Thin wrappers over OpticalSender/OpticalReceiver: one element, a method
// call or two, CustomEvents out. See README "Embedding".

import { OpticalReceiver, type ReceivedFile, type ReceiverStats } from "./receiver";
import { OpticalSender, type ExportOptions, type SenderInfo, type SenderPayload } from "./sender";
import { randomKeyHex } from "../shared/crypto";

const num = (el: HTMLElement, name: string) => {
  const v = el.getAttribute(name);
  return v === null ? undefined : Number(v);
};

export class OpticalSenderElement extends HTMLElement {
  private canvas = document.createElement("canvas");
  private sender: OpticalSender | null = null;
  /** The key in use when sealing (auto-generated for encrypt="random"). */
  key: string | undefined;

  connectedCallback() {
    this.canvas.style.maxWidth = "100%";
    if (!this.canvas.parentNode) this.append(this.canvas);
  }

  /** Stream a file (or raw named bytes). Restarts any running stream. */
  async send(payload: File | SenderPayload): Promise<void> {
    this.sender?.stop();
    const p: SenderPayload =
      payload instanceof File
        ? {
            bytes: new Uint8Array(await payload.arrayBuffer()),
            name: payload.name,
            mime: payload.type || "application/octet-stream",
          }
        : payload;
    const encrypt = this.getAttribute("encrypt");
    this.key = encrypt === null || encrypt === "" ? undefined : encrypt === "random" ? randomKeyHex() : encrypt;
    this.sender = new OpticalSender({
      canvas: this.canvas,
      payload: p,
      targetFps: num(this, "fps"),
      frameBytes: num(this, "frame-bytes"),
      codes: num(this, "codes") as 1 | 2 | 4 | undefined,
      ecc: (this.getAttribute("ecc") as "L" | "M" | "Q" | "H") ?? undefined,
      displayPx: num(this, "display-px"),
      encryptKey: this.key,
      onReady: (info: SenderInfo) => this.dispatchEvent(new CustomEvent("ready", { detail: { ...info, key: this.key } })),
      onError: (message: string) => this.dispatchEvent(new CustomEvent("error", { detail: message })),
    });
    await this.sender.start();
  }

  exportVideo(opts?: ExportOptions): Promise<Blob> {
    if (!this.sender) return Promise.reject(new Error("send() first"));
    return this.sender.exportVideo(opts);
  }

  stop() {
    this.sender?.stop();
    this.sender = null;
  }

  disconnectedCallback() {
    this.stop();
  }
}

export class OpticalReceiverElement extends HTMLElement {
  private video = document.createElement("video");
  private receiver: OpticalReceiver | null = null;

  connectedCallback() {
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.style.maxWidth = "100%";
    if (this.getAttribute("preview") === "off") this.video.style.display = "none";
    if (!this.video.parentNode) this.append(this.video);
    if (this.hasAttribute("autostart")) void this.start();
  }

  /** Start receiving — from the camera, or a MediaStream / recorded File. */
  async start(source?: MediaStream | File): Promise<void> {
    this.receiver?.stop();
    this.receiver = new OpticalReceiver({
      video: this.video,
      source,
      captureWidth: num(this, "capture-width"),
      captureFps: num(this, "capture-fps"),
      key: this.getAttribute("key") ?? undefined,
      onProgress: (fraction) => this.dispatchEvent(new CustomEvent("progress", { detail: fraction })),
      onLocked: (wireLength) => this.dispatchEvent(new CustomEvent("locked", { detail: wireLength })),
      onComplete: (file: ReceivedFile) => this.dispatchEvent(new CustomEvent("complete", { detail: file })),
      onError: (message) => this.dispatchEvent(new CustomEvent("error", { detail: message })),
      onStats: (stats: ReceiverStats) => this.dispatchEvent(new CustomEvent("stats", { detail: stats })),
    });
    await this.receiver.start();
  }

  unlock(key: string): Promise<void> {
    return this.receiver?.unlock(key) ?? Promise.reject(new Error("start() first"));
  }

  stop() {
    this.receiver?.stop();
    this.receiver = null;
  }

  disconnectedCallback() {
    this.stop();
  }
}

export function defineElements(): void {
  if (!customElements.get("optical-sender")) {
    customElements.define("optical-sender", OpticalSenderElement);
  }
  if (!customElements.get("optical-receiver")) {
    customElements.define("optical-receiver", OpticalReceiverElement);
  }
}
