// decimen-optical-transfer — embeddable library entry (Phase 4).
//
// import { OpticalSender, OpticalReceiver } from "decimen-optical-transfer";
// or via the IIFE build: window.DecimenOptical.*
//
// Importing this module also registers the <optical-sender> and
// <optical-receiver> custom elements (idempotent), so a single script tag
// is a complete integration.

export { OpticalSender } from "./sender";
export type { SenderInfo, SenderOptions, SenderPayload } from "./sender";
export { OpticalReceiver } from "./receiver";
export type { ReceivedFile, ReceiverOptions, ReceiverStats } from "./receiver";
export { OpticalSenderElement, OpticalReceiverElement, defineElements } from "./components";

// low-level building blocks, for anyone composing their own transport
export { LTDecoder, LTEncoder } from "../shared/fountain";
export { HEADER_LEN, fnv1a, packFrame, parseFrame, sameStream } from "../shared/protocol";
export type { FrameHeader } from "../shared/protocol";
export { FLAG_DEFLATE, deflate, inflate, packEnvelope, parseEnvelope } from "../shared/envelope";
export type { FileMeta } from "../shared/envelope";
export { FLAG_SEALED, isSealed, randomKeyHex, seal, unseal } from "../shared/crypto";

import { defineElements } from "./components";
if (typeof window !== "undefined" && typeof customElements !== "undefined") {
  defineElements();
}
