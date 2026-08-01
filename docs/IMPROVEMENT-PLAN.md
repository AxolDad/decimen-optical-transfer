# Review & Improvement Plan

**Goals:** raise throughput (frame rate × data per frame), support arbitrary files, make
the whole thing embeddable in any website as a reusable component, and add a sealed mode:
end-to-end-encrypted streams that can be recorded and published anywhere (even YouTube)
yet opened only by whoever holds the key.

**TL;DR of the plan**

| Phase | Theme | Headline outcome |
|---|---|---|
| 0 | Tests + bench harness + CI | Every later change is measurable and safe |
| 1 | Receiver decode speed | Decode keeps up with capture; denser frames become viable (2×) |
| 2 | Sender density + pacing | Multi-code grid + vsync pacing (3–5× raw channel rate) |
| 3 | Arbitrary files, protocol v2 | Drag-drop any file; name/type preserved; optional compression |
| 3B | Sealed streams + broadcast mode | AES-GCM-encrypted streams; record once, host anywhere (even YouTube) — only key holders can open it |
| 4 | Embeddable library + hosted demo | `npm install` / `<script>` embed on any site; live Pages demo; offline air-gap kit |
| 5 | Color channel (stretch) | RGB multiplexing toward 3× on top of Phase 2 |

Realistic end state after Phases 1–2 on current-gen hardware: **~100–150 KB/s propped**
(vs ~25–30 KB/s at today's defaults) — consistent with the 128–186 KB/s the README reports
for the parent experiment with the same tricks.

**Status:** Phase 0 and the quick wins are implemented (tests + `/bench/` loopback page +
CI/Pages workflow; tuned reader options, worker crash recovery, teardown paths, size-cap
guards, 30 fps default). Findings #1, #2, #6, #7, #10 from the review table are fixed.

Phase 1 is implemented: ROI tracking with acquire/locked reader modes (`receive/roi.ts`,
unit-tested), zero-readback VideoFrame capture path with in-worker Y-plane extraction and
automatic canvas fallback, adaptive worker pool (auto = cores−1, cap 4), decode-ms/ROI
metrics, and focus freeze-on-lock where the platform supports it (finding #3 fixed).
Verified end-to-end headless: synthetic I420 camera frames → rVFC → workers → ROI lock →
fountain completion, hash verified. The on-phone acceptance check (decode fps ≥ capture
fps at 1280-wide) still needs real hardware.

---

## Part 1 — Code review

### What is already excellent (keep all of it)

- **The architecture is right.** Fountain coding (LT + robust soliton) is the correct answer
  to a one-way erasure channel, and making every frame self-describing (20-byte header, no
  handshake, session-id reset) is what makes the whole system feel magical: lock-on
  mid-stream, restart-safe, rate-mismatch-proof.
- **`dlog()` in `fountain.ts`** — deterministic `Math.log` replacement built from
  exactly-specified IEEE-754 ops so V8 and JavaScriptCore build bit-identical soliton CDFs.
  This is the kind of bug that costs a week; it's already solved and documented.
- **Generation counters** on both sender (`generation`) and receiver (`captureGen`) correctly
  kill zombie `requestVideoFrameCallback` / stream loops across restarts.
- **Pinned QR mask pattern** (`maskPattern: 4`): measured in this review at **3.4 ms vs
  10.6 ms per v27 frame** (3.1×; 4.6× at v40) — the README's "~4× faster generation" claim
  verifies.
- **Progress UX honesty**: tracking frames-collected instead of blocks-solved (LT peeling
  back-loads its cascade) is a real field lesson, correctly implemented.
- The iOS `frameRate: {exact: 60}` trick, the ECC-L rationale, and the https/getUserMedia
  explanation are all accurate and well documented.
- Clean strict TypeScript (`strict` + `noUncheckedIndexedAccess`), zero runtime deps beyond
  `qrcode` + `zxing-wasm`, builds green (`tsc && vite build`, 813 ms).

### Findings (correctness / robustness)

| # | Severity | Finding |
|---|---|---|
| 1 | **Medium** | **A crashed decode worker permanently eats a slot.** `receive/main.ts` sets `busy[slot] = true` before `postMessage` and only clears it in `onmessage`. There is no `onerror`/`onmessageerror` handler, so one worker crash silently halves (or worse) decode throughput for the rest of the session. Fix: handle `onerror`, clear the slot, respawn the worker. |
| 2 | **Medium (perf)** | **zxing-wasm reader options are left at defaults**, and the defaults are expensive: `tryHarder`, `tryRotate`, `tryInvert`, `tryDownscale` all default **on**. Screen-displayed codes are upright, non-inverted, high-contrast. Measured on 1280×960 frames: misses (the common case at capture fps) cost 12.8–13.3 ms at defaults vs 8.0–8.5 ms tuned (**~37% faster**). |
| 3 | **Medium (perf)** | **Full-frame RGBA readback on the main thread per capture.** `getImageData(0,0,1280,960)` copies ~4.7 MB per frame; at 60 fps that is ~280 MB/s of main-thread memory traffic plus a full-frame decode. The decode itself only needs the code's bounding box (see Phase 1: ROI tracking, measured 3× faster) and the readback can move off the main thread via `VideoFrame` transfer. |
| 4 | Low (now) → blocker (Phase 2) | **QR generation runs on the main thread** via a perpetual `setTimeout(0)` pump (~250 wake-ups/s even when the queue is full). At 24 fps × 3.4 ms it's fine (~8% of one core). At Phase 2 rates (e.g. 4 codes × 60 fps = 816 ms of generation per second) it cannot stay on the main thread. |
| 5 | Low | **Wall-clock 24 fps pacing on a 60 Hz display is vsync-uneven**: frames alternate 2-vsync and 3-vsync holds (33 ms / 50 ms). The short holds are the ones the camera tends to straddle. Vsync-integer pacing (every frame exactly N rAF ticks) is strictly better: 30 fps@60 Hz, 40/60 fps@120 Hz. |
| 6 | Low | **No teardown path**: workers are never `terminate()`d, `setInterval(updateStats)` is never cleared, the result blob URL is never revoked, wake locks are never released. Harmless in a throwaway page; must be fixed for the Phase 4 library (`dispose()`). |
| 7 | Low | `OVERHEAD_EST = 1.18` in `receive/main.ts` vs "~K·1.15" in the README. Measured in this review: 1.11–1.28 depending on K (small K is worse). Cosmetic, but worth aligning docs + code with measurements. |
| 8 | Edge | **Session-id collision**: 16-bit random per sender start. Two restarts colliding (1/65535) leaves the receiver fused to a stale decoder that can never complete (blocks from two different files). Cheap fix in protocol v2: fold a few more entropy bits in, or reset the decoder when `k`/`totalLen`/`payloadFnv` mismatch under the same session id. |
| 9 | Feature gap | **Protocol carries no filename/MIME/flags** — the receiver hardcodes `type: "image/png"` and renders an `<img>`. Fine for the PoC's baked-in images; blocks arbitrary file transfer (Phase 3). |
| 10 | Note | Header limits: `k` is u16 and `blockLen` u16 → max payload ≈ 65 535 × 2 933 B ≈ **192 MB**. Not worth changing (at optical rates >20 MB is impractical anyway), but should be documented and enforced with a clear error. |
| 11 | Gap | **No tests, no CI.** The riskiest code (soliton CDF, `dlog`, peeling decoder, header pack/parse) is pure, deterministic, and trivially unit-testable — it just isn't yet. |

### Measured baseline (this container's CPU; ratios are what matter)

Fountain layer (`shared/fountain.ts`, real encoder/decoder, 30% simulated frame loss):

| payload | blockLen | K | overhead (frames/K) | encode | decode |
|---|---|---|---|---|---|
| 512 KB | 1445 | 363 | 1.20–1.28 | 14–28 µs/frame | 20–22 µs/frame |
| 2 MB | 1445 | 1452 | 1.17 | 17 µs | 25 µs |
| 2 MB | 2933 | 716 | 1.17 | 30 µs | 38 µs |
| 20 MB | 2933 | 7151 | 1.11 | 41 µs | 62 µs |

→ **The fountain layer is free.** It scales to 20 MB+ payloads without breaking a sweat and
round-trips bit-exact under loss. All throughput work belongs in the QR pipeline.

QR pipeline (node-qrcode + zxing-wasm 2.2.4, synthetic clean frames):

| operation | time |
|---|---|
| generate v27 (1465 B), pinned mask | 3.4 ms |
| generate v40 (2953 B), pinned mask | 3.5 ms |
| decode hit, 1280×960 full frame, default opts | 12.6 ms |
| decode hit, 1280×960 full frame, tuned opts | 11.0 ms |
| decode **miss**, 1280×960, default opts | 12.8–13.3 ms |
| decode **miss**, 1280×960, tuned opts | 8.0–8.5 ms |
| decode hit, **439×439 ROI crop**, tuned opts | **4.3 ms** (≈3× vs full frame) |

→ **Decode is the bottleneck, and ROI + option tuning is the biggest single lever.**
A phone CPU is 2–4× slower than this container, which is exactly why today's receiver
(full-frame, default options, 2 workers) tops out well below 60 decodes/s.

---

## Part 2 — Where the throughput goes

Goodput ≈ `txFps × codesPerFrame × (frameBytes − 20) ÷ fountainOverhead`, capped by what the
receiver actually decodes. Ceilings at overhead 1.17:

| configuration | raw channel | goodput ceiling |
|---|---|---|
| **today**: 1 × v27 (1465 B) @ 24 fps | 34.7 KB/s | **~30 KB/s** |
| 1 × v40 (2953 B) @ 24 fps | 70.4 KB/s | ~60 KB/s |
| 1 × v40 @ 30 fps | 88 KB/s | ~75 KB/s |
| 2×2 grid of v27 @ 30 fps | 173 KB/s | ~148 KB/s |
| 2×2 grid of v27 @ 60 fps (120 Hz display) | 347 KB/s | ~296 KB/s (decode-bound) |
| + RGB color channel ×3 (Phase 5) | ~1 MB/s | research territory |

Three consequences drive the plan's ordering:

1. **The receiver must get faster first.** Denser frames (v40) and grids are pointless if the
   phone can't decode them at rate. Phase 1's ROI + capture-path work turns the measured
   13 ms/frame into ~3–5 ms/frame, which is what makes every sender-side lever real.
2. **The sender's ceiling is layout, not compute.** One QR is capped at 2 953 B (v40-L) by
   the QR spec. The only ways past it: more codes per frame (Phase 2 grid — protocol already
   supports it, since every code is an independent self-describing frame) and more bits per
   module (Phase 5 color).
3. **The fountain layer needs nothing.** Measured µs/frame and 1.11–1.17 overhead at scale.

---

## Part 3 — The plan

### Phase 0 — Measurement rig + safety net (prerequisite for honest tuning)

1. **Vitest unit tests** for the pure core:
   - encode→decode round-trip at multiple payload sizes / block lengths / loss rates
     (bit-exact, overhead within expected band);
   - golden vectors for `dlog`, `solitonCdf`, `frameSeed`, `frameIndices` (pinned expected
     outputs = cross-engine determinism canary);
   - `packFrame`/`parseFrame` round-trip + malformed-input fuzz (truncated, bad magic,
     length mismatch).
2. **Loopback bench page** (`/bench/`): sender pipeline renders frames to a canvas,
   receiver pipeline reads them back through the real worker/zxing path — no camera — with
   knobs for synthetic degradation (downscale, blur, loss %). Reports decodes/s and
   goodput. This is the A/B rig for every Phase 1–2 change; run it on real phones via the
   dev server.
3. **CI (GitHub Actions)**: typecheck + tests + build on push/PR; deploy `dist/` to GitHub
   Pages on main (this also produces the hosted demo needed in Phase 4).
4. **Land the small fixes from the review**: worker `onerror` respawn (#1), teardown paths
   (#6), overhead-constant alignment (#7), documented size cap (#10).

*Acceptance:* CI green; bench page produces stable numbers for today's defaults on a phone
and a laptop, recorded in the README as the baseline.

### Phase 1 — Receiver: make decode ≥ capture (unlocks everything else)

1. **Tuned zxing options after lock**: `tryHarder/tryRotate/tryInvert/tryDownscale: false`
   once a session is locked; re-enable the permissive set only for acquisition (no stream
   yet / N consecutive misses). Measured: ~37% off every miss, ~13% off hits, for free.
2. **ROI tracking**: zxing results include the symbol's corner `position`. Cache it, crop
   subsequent captures to that box + ~20% margin, decode the crop (measured **3×**). Full-
   frame re-acquisition after N misses or when position drifts to the crop edge. This also
   slashes the per-frame copy (a 500×500 crop is 1/5 the pixels of 1280×960).
3. **Modern capture path, feature-detected**: `rVFC → new VideoFrame(video)` → transfer to
   worker → `copyTo()` (luma-only where the format allows) → decode, keeping today's
   `drawImage + getImageData` as the universal fallback. Gets the 4.7 MB/frame readback off
   the main thread and drops RGBA→luma conversion cost.
4. **Adaptive worker pool**: default `min(hardwareConcurrency − 1, 4)` instead of 2; slot
   accounting fixed per review finding #1; per-worker decode-time stats surfaced in the
   metrics grid.
5. **Camera ergonomics where the platform allows**: after first lock, try
   `applyConstraints` focus/exposure lock (Chromium/Android); on iOS keep the existing
   "prop the phone" guidance. Autofocus hunting is already called out as the #1 killer —
   locking focus once locked-on is the software-side mitigation.

*Acceptance (bench page + field):* decode fps ≥ capture fps on a mid-range phone at 1280-wide
capture with the code filling ≥⅓ of frame height; v40 @ 24 fps (60 KB/s ceiling) completes a
512 KB transfer close-range in ~10 s reliably.

### Phase 2 — Sender: density and pacing (raise the ceiling 3–5×)

1. **Vsync-integer pacing**: replace wall-clock `nextAt` with "hold each frame exactly N rAF
   ticks", measure the display's refresh rate at startup (rAF cadence over ~1 s), and offer
   rates accordingly (60 Hz → 20/30; 120 Hz → 40/60). Kills the uneven 2/3-vsync cadence of
   24 fps@60 Hz (review #5) and makes 120 Hz displays (ProMotion phones/MacBooks) first-class.
2. **QR generation in a worker pool** feeding a deeper frame ring buffer (review #4):
   at 3.4 ms/code, grid mode needs ~2–3 cores of generation headroom; `OffscreenCanvas` or
   transferred `ImageData` both work. Main thread only flips pre-rendered frames.
3. **Multi-code grid (the big one)**: render 2×1 / 2×2 codes per displayed frame, each code
   its own fountain frame with consecutive `seq` — **zero protocol changes required**; the
   receiver already treats every decoded symbol independently. Receiver side: during
   acquisition decode full frame with `maxNumberOfSymbols: 4`; once locked, decode each
   code's ROI as an independent worker job (the grid parallelizes perfectly across the
   Phase 1 worker pool). 2×2 v27 @ 30 fps = 148 KB/s goodput ceiling.
4. **Density presets** instead of raw dropdowns: conservative (1×v27@20), balanced
   (1×v40@30), aggressive (2×2 v27@30), ludicrous (2×2@60, 120 Hz) — plus the existing
   advanced controls. Presets make the bench comparisons and user guidance tractable.

*Acceptance:* 2 MB transferred phone-propped in ≤ 20 s (≥100 KB/s goodput) on current-gen
hardware; bench page shows the grid path decode-bound, not sender-bound.

### Phase 3 — Arbitrary files + protocol v2 (the "transfer files" goal)

1. **Payload envelope** (fountain-protected end-to-end, no special frames):
   `[u8 flags][u16 metaLen][meta JSON: {name, mime, size}][file bytes]`, FNV computed over
   the envelope. Metadata rides inside the fountain payload, so it needs no new frame types
   and arrives with the same erasure protection as the data.
2. **Header v2 (21 bytes)**: bump magic (`0xD1 0x0D`), add a version/flags byte
   (bit 0: envelope present, bit 1: deflate, bit 2: encrypted — see Phase 3B). Also fold
   `k`/`totalLen` into the stale-session guard (review #8). No back-compat constraints —
   this is still a PoC.
3. **Optional DEFLATE** via `CompressionStream('deflate-raw')` (evergreen browsers since
   ~2023, feature-detected, flag bit): free multi-× win for text/CSV/JSON/office docs; PNGs
   and zips pass through unchanged.
4. **Sender UX**: drag-drop / file picker (keep the demo images as samples); show file name,
   size, and estimated transfer time for the chosen preset; warn past ~20 MB (rate math), hard
   cap at the header's ~192 MB.
5. **Receiver UX**: filename + MIME from the envelope; `<a download>` with the right name;
   inline preview for images/text; completion beep/vibration (`navigator.vibrate`) since the
   user is staring at the *sender's* screen during a transfer.

*Acceptance:* any file round-trips with name/type intact, hash-verified; a compressible file
measurably beats its raw transfer time; nothing regresses for the demo images.

### Phase 3B — Sealed streams + broadcast mode (encrypt the light, publish anywhere)

The optical channel is a broadcast: anyone with line of sight — or a copy of a screen
recording — receives everything. This phase makes that a *feature*: encrypt the payload end
to end so the stream itself can be public (screen-recorded, re-hosted, even uploaded to
YouTube) while remaining opaque to everyone but the key holder. The receiver holds the key;
the channel holds only ciphertext.

1. **End-to-end encryption above the fountain layer.** Encrypt the Phase 3 envelope
   (filename + MIME + bytes, after optional compression — compress-then-encrypt, ciphertext
   doesn't compress) with **AES-256-GCM via WebCrypto**, then fountain-code the ciphertext.
   This layering is the crux: frame headers (`seq`, `k`, `blockLen`, session) stay plaintext
   so *collection* works without the key — the fountain math needs no secrets — while every
   content byte, including the filename, is ciphertext. Wire layout under flag bit 2:
   `[salt 16 B][iv 12 B][ciphertext + GCM tag]`. One fresh key/salt/IV per transfer; GCM's
   auth tag supplies cryptographic integrity and (within the key-sharing group) authenticity.
2. **Keys on the receiver side.** A key field in the receiver app, accepted three ways:
   a passphrase (PBKDF2-SHA-256, ~600k iterations, per-transfer random salt), a raw 256-bit
   key (hex/base64), or — fitting for this project — **scanning a key QR** the sender
   generates for an in-person, out-of-band handoff. The sender can mint a random key and
   display it once; the stream published later is useless without it.
3. **Collect now, unlock later.** Keep the FNV check over the *ciphertext*: the receiver can
   verify a complete, intact collection with no key at all and report "stream received —
   locked". The key can be entered before, during, or long after collection; a wrong key
   fails GCM authentication and reports cleanly ("wrong key"), never garbage output.
4. **Sender: export-as-video.** A finite recording must carry enough distinct frames:
   ≥ K × ~1.3 to absorb codec-mangled frames. Add an export mode that computes the required
   duration for the chosen preset and renders it frame-exact via WebCodecs `VideoEncoder`
   (faster than realtime, no dropped frames), with `canvas.captureStream` + MediaRecorder as
   the fallback. Output: a WebM/MP4 you can post anywhere — the video *is* the ciphertext
   container.
5. **Receiver: decode from a video, not just a camera.** Drag an .mp4/.webm into the
   receiver (or point it at a playing video element) and run the exact same rVFC → worker →
   fountain pipeline against file playback instead of `getUserMedia`. Pristine-pixel input
   decodes far better than a camera ever will; it also gives Phase 0 a perfect regression
   fixture.
6. **Survive re-encoding.** YouTube-class transcodes smear sharp black/white edges (ringing,
   blocking, chroma subsampling). Countermeasures, all bench-measurable via item 5:
   fewer/larger modules (lower QR versions), 1080p-integer module scaling, each QR frame held
   ≥ 2 video frames, and — notably — **raise in-frame ECC to M or Q here**: the README's
   ECC-L rationale is correct for the erasure-dominant camera channel but inverts on a
   corruption-prone codec channel.
7. **Honest security notes in the README.** Encryption hides content, not existence — a QR
   video is conspicuously a data stream. Authenticity extends only to whoever holds the key
   (no signatures in scope). And ciphertext posted publicly is exposed to offline guessing
   *forever*: for anything published, prefer generated random keys over passphrases.

*Acceptance:* a file exported as video, uploaded to YouTube, re-downloaded at 1080p, and fed
to the receiver round-trips bit-exact with the right key; a wrong key is cleanly rejected;
no plaintext (including filename) appears anywhere in the published stream.

### Phase 4 — Embeddable library + hosted demo (the "embed it on a website" goal)

1. **Repackage as a library with a demo, instead of pages with inline logic**:
   - `src/core/` — protocol + fountain (zero DOM, already true today);
   - `src/sender/` — `createOpticalSender(canvas, data: Blob | Uint8Array, opts) →
     { start, stop, setPreset, stats, dispose }`;
   - `src/receiver/` — `createOpticalReceiver(opts: { video?, stream?, onProgress,
     onComplete, onStats }) → { start, stop, dispose }` (accepts a caller-provided
     `MediaStream` so host apps control camera UX/permissions);
   - the existing `/send/` and `/receive/` pages become thin consumers of the library —
     they remain the reference UI and the dev/test surface.
2. **Web Components for zero-framework embedding**: `<optical-sender>` / `<optical-receiver>`
   custom elements wrapping the same API, so embedding is one script tag + one element.
3. **Distribution**: ESM build (library consumers, tree-shakeable) + IIFE single-file build
   for CDN `<script>` use; worker + WASM asset strategy documented for both (bundler path
   via `new URL(..., import.meta.url)` — already the pattern used today — plus an
   everything-inlined variant for copy-paste embeds). npm publish with types.
4. **Embedding realities, documented**: iframe embeds need `allow="camera"`; strict-CSP
   hosts need `wasm-unsafe-eval` for zxing; receiver bundle carries the ~940 KB (403 KB
   gzipped) WASM — lazy-load it on receiver start; sender side is tiny (~30 KB) and has no
   WASM. Everything is client-side — file bytes never touch a server — which is the pitch
   for embedding it in the first place.
5. **Hosted demo on GitHub Pages** (from Phase 0's CI): a real certificate finally kills the
   self-signed-cert tap-through, so "try it" becomes: open URL on laptop, open URL on phone,
   point. (Trade-off to document: both devices need internet to *load* the page; the payload
   still travels only as light. Air-gapped use gets the kit below.)
6. **Air-gap kit**: a single self-contained HTML file (sender + receiver, worker and WASM
   inlined as data URIs, zero external requests) downloadable from the demo site. Carry it
   onto the isolated machine once, serve it from `localhost` (any one-liner static server —
   camera requires a secure context and `localhost` qualifies, so it works fully offline),
   and the device never needs a network again. This makes the "air-gapped transmission
   system" reading of the project a first-class, documented deployment mode rather than an
   accident of the dev server.

*Acceptance:* a fresh Vite app and a plain HTML page can each integrate send+receive in
≤ ~10 lines; demo live on Pages; README gains API docs and an embed recipe.

### Phase 5 (stretch) — More bits per module

- **RGB channel multiplexing**: three QR bit-planes in R/G/B per displayed frame (the parent
  experiment's "error-corrected color channel"). Needs per-channel calibration (white
  balance, Bayer cross-talk) — plan a calibration header/border and per-channel thresholds,
  plus light FEC across channels. Theoretical 3× on top of Phase 2; treat as a research
  spike with an explicit go/no-go: measure per-channel error rates on ≥2 real phones first.
  A 2-level grayscale intermediate (2 bits/module, 2×) is the lower-risk fallback.
- **Reverse optical channel** (receiver flashes a coarse state code the sender's webcam
  reads): enables "stop when done" automation and adaptive density without touching the
  no-network property. Optional, clearly separable.
- **Beyond-QR symbology** (libcimbar-style): noted as the far horizon; not proposed —
  it forfeits the ubiquity of QR decoders that makes this project approachable.

Rejected along the way: native `BarcodeDetector` (Safari has never shipped it — WebKit
bug 281848, as the README notes — and Chromium's returns `rawValue` as a *string*, which is
not binary-safe for arbitrary bytes); WebRTC/network fallbacks (defeats the entire point).

---

## Suggested order & effort

| Step | Effort | Payoff |
|---|---|---|
| Phase 0 | ~1–2 days | Measurement + regression safety for everything after |
| Phase 1 | ~2–3 days | 2× real-world today, enables v40/grid; biggest risk retired early |
| Phase 2 | ~3–4 days | 3–5× ceiling; hits the ~100–150 KB/s target |
| Phase 3 | ~2 days | Product-shaped: real files, compression, real UX |
| Phase 3B | ~2–3 days | Sealed streams: E2E encryption, video export, decode-from-video, publish-anywhere |
| Phase 4 | ~2–3 days | npm + CDN embeddable, hosted demo, air-gap kit |
| Phase 5 | spike first | Only after 1–2 land; go/no-go on measured channel separation |

Quick wins that could land immediately, independent of the phases: tuned zxing options
(#2, measured ~37% on misses), worker crash recovery (#1), vsync-clean 30 fps default
pending a bench check (#5), teardown/constant cleanups (#6, #7).

---

*Benchmarks in this document were run with the repo's own `shared/fountain.ts`, node-qrcode
1.5.4, and zxing-wasm 2.2.4 (Node 22, this review's container). Absolute times will differ
on phones; the ratios are the point. The loopback bench page in Phase 0 makes these numbers
reproducible on real target hardware.*
