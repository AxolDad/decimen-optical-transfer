# Decimen Optical Transfer: fountain-coded QR file transfer

Send a file between two devices using nothing but a **screen and a camera**.
One page displays the file as an endless stream of animated QR codes; another
device points its camera at it and reconstructs the file. **No network path
between the devices, no app, no pairing, no permissions beyond the camera.**
The payload travels as light.

> **YouTube as a dead drop.** Encrypt a file, post it anywhere as a stream of
> animated light, and only the key holder can ever open it — no network, no
> account, no trace of what it is. See
> [Sealed streams](#sealed-streams-optical-broadcast).

This is a minimal proof of concept extracted from a larger
experiment that reached **128 KB/s phone-to-phone** with denser frames,
multi-code grids, and an error-corrected color channel. This PoC keeps only
the essential trick and transmits a 512 KB image (or a 2 MB one, selectable
in the sender's settings) at a comfortable rate.

<p align="center">
  <img src="docs/receiving.jpg" width="420"
       alt="Phone receiving a 2 MB image over light: 129.2 KB/s goodput, decoding the sender's animated QR code" />
</p>
<p align="center"><em>Mid-transfer: a phone pulling a 2 MB image out of the air at 129 KB/s.</em></p>

## Try it

```bash
npm install
npm run dev
```

- On the **sending** device (a laptop is ideal): open
  `https://localhost:5173/send/` and it starts streaming immediately. Max
  screen brightness helps.
- On the **receiving** device (a phone): open the `Network` URL Vite prints
  (`https://<lan-ip>:5173/receive/`), accept the certificate warning once,
  tap **Start camera**, and point it at the code.
- A few seconds later: *Transfer Complete!* and the received image, verified
  by hash.

**Why the dev server is https-only:** the receiver uses `getUserMedia`, and
browsers remove that API entirely on insecure origins: a phone reaching
your dev server over plain http has no camera, full stop (`localhost` is
exempt, but your phone isn't localhost). That's a web platform rule, not a
choice. The dev server therefore ships with a self-signed certificate
(`@vitejs/plugin-basic-ssl`); the browser will warn on first visit. Tap
"Show Details" then "visit this website" (iOS) or "Advanced" then "Proceed"
(Android/desktop), and the page is still a secure context, so the camera
works. The odd-looking `lvh.me` hosts Vite prints are a public convenience
domain that resolves to 127.0.0.1 (same machine, nothing extra running).

Hold the phone steady, or better, prop it against something. Camera
autofocus hunting from hand tremor is the #1 throughput killer.

## How it works

**The one-way channel problem.** A screen-to-camera link has no back-channel:
the receiver can't ask for retransmission, and it will inevitably miss frames
(blur, refresh straddling, autofocus). Looping the frames and hoping is
miserable: miss one frame and you wait a full cycle for it to come around.

**Fountain codes fix this completely.** The sender never sends the file's
blocks directly. Each frame is the XOR of a pseudorandom *subset* of blocks;
the subset is derived deterministically from the frame's sequence number,
with subset sizes drawn from a robust-soliton distribution ([Luby transform
coding](https://en.wikipedia.org/wiki/Luby_transform_code)). The receiver
collects **any** ~K·1.2 distinct frames (measured 1.11–1.28; small K trends
worse), in any order, and peels the file out of them. Dropped frames cost a little time, never correctness. Sender
and receiver frame rates don't need to match at all.

**Every frame is self-describing.** A 20-byte header carries the session id,
sequence number, block count/size, file length, and a hash. There is no
handshake: the receiver locks onto a stream mid-flight, and restarting the
sender (new session id) automatically resets the receiver.

**Decoding.** Safari has never shipped `BarcodeDetector` (WebKit bug 281848),
so decoding is [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) compiled
to WASM, running in workers fed by `requestVideoFrameCallback`. Busy workers
mean dropped frames, which the fountain happily absorbs.

## Hard-won details baked into this PoC

- **JS engines disagree about `Math.log`** (it's implementation-approximated).
  Sender and receiver must build bit-identical soliton distributions, so
  `fountain.ts` includes a deterministic log built from exactly-specified
  IEEE-754 ops. V8 vs JavaScriptCore desync is a silent, total failure mode.
- **iOS lies about camera frame rate.** `frameRate: {ideal: 60}` silently
  delivers 30; you must demand `{exact: 60}` (works at 1280-wide capture)
  and fall back. Always read back `getSettings()`.
- **`requestVideoFrameCallback` chains outlive their stream** and resume on
  the next one; without a generation counter, every stop/start leaks a
  zombie capture loop.
- **Progress bars must track frames collected, not blocks solved.** LT
  peeling back-loads its solve cascade: block-count progress looks stalled
  for most of the transfer, then teleports to 100%.
- **QR error correction is set to the minimum (L).** In-frame ECC and the
  fountain layer solve different problems (corruption vs erasure), but at
  these frame sizes level L plus frame disposal is the better trade. (The
  exception is the transcode channel — see sealed streams below, where
  corruption dominates and ECC Q wins.)

## Tuning

Both pages have a collapsed **Settings** panel. On the sender: payload size
(512 KB or 2 MB), tx fps, bytes per frame, error-correction level, and
display size. Changing anything restarts the stream, and the receiver resets
automatically off the new session id. On the receiver: capture width,
capture fps, and decode worker count (default "auto" = CPU cores − 1, capped
at 4), applied when the camera starts.

The receiver decodes in two modes: full-frame **acquisition** until the first
code lands, then **locked** — frames are cropped to the code's last position
(the "roi crop" metric; ~3× faster decode) and, where the browser supports
it, pixels travel as transferred `VideoFrame`s with the luma plane extracted
inside the worker, so the main thread never copies a frame. A run of misses
falls back to acquisition automatically. On platforms that expose manual
focus (Chromium/Android), autofocus is frozen once locked — hunting AF is
the #1 throughput killer.

| setting | default | notes |
|---|---|---|
| preset | balanced | steady / balanced / dense / grid / ludicrous — one knob that sets fps, density, and grid together |
| target fps | 30 | frames are held for a whole number of refresh cycles (min 2), so the *actual* fps — shown in the status line — is the nearest exact division of your display's measured refresh rate; a 120 Hz display unlocks 60 |
| bytes / frame | 1465 (QR v27) | denser is faster if the receiver still decodes it; 2953 (v40) works phone-to-phone at close range |
| codes / frame | 1 | 2 or 4 codes per displayed frame multiply the channel (each is an independent fountain frame — no protocol change), but shrink the modules: get closer, prop the phone, use a big display |

The parent experiment's measured ceiling with this exact architecture plus
denser frames, a 120 fps ProMotion sender, and stacked codes: ~128 KB/s
handheld, ~186 KB/s propped.

## Embedding it on your own site

The engine ships as a library (`lib/`) with the `/send/` and `/receive/`
pages as its reference UI. Two ways to embed:

**Web Components** (no build step):

```html
<optical-sender id="tx" fps="30" codes="4"></optical-sender>
<optical-receiver id="rx" autostart></optical-receiver>
<script type="module">
  import "decimen-optical-transfer"; // registers the elements
  document.querySelector("#tx").send(myFile);            // a File or {bytes,name,mime}
  document.querySelector("#rx").addEventListener("complete", (e) => {
    const { name, mime, bytes } = e.detail;              // reconstructed file
    // save it, preview it, hand it to your app…
  });
</script>
```

**The API directly** (bundler / framework):

```ts
import { OpticalSender, OpticalReceiver } from "decimen-optical-transfer";

const sender = new OpticalSender({ canvas, payload: { bytes, name, mime },
  codes: 4, encryptKey: "optional passphrase or 64-hex key" });
await sender.start();

const receiver = new OpticalReceiver({ video,      // your <video> element
  onComplete: (file) => { /* file.bytes, file.name, file.mime */ } });
await receiver.start();                              // opens the camera
// receiver.start(aFile) instead decodes a recorded video, no camera
```

Everything is client-side — file bytes never touch a server, which is the
whole point of embedding it. `onComplete` hands your app the raw bytes and
metadata, so a wrapper (or a future desktop app) can write them straight to
disk instead of offering a download.

**Sealed streams** (`encryptKey` set): the payload is AES-256-GCM ciphertext
end to end (see [Sealed streams](#sealed-streams-optical-broadcast) below).
`sender.exportVideo()` records a self-contained clip you can host anywhere —
the recording *is* the ciphertext container.

**Embedding realities**, all documented so they don't surprise you:

- Camera access needs a **secure context**; an `<iframe>` needs
  `allow="camera"`.
- The receiver loads a ~940 KB (403 KB gzipped) zxing **WASM** decoder,
  lazily on start; strict-CSP hosts need `wasm-unsafe-eval`. The sender side
  pulls in no WASM.
- `npm run build:lib` emits an **ESM** build (`dist-lib/decimen-optical.js`,
  ~11 KB gzipped + the worker chunks) for bundler/npm consumers and an
  **IIFE** (`window.DecimenOptical`) for `<script>` use. The decode worker
  and WASM are separate chunks the ESM resolves via `import.meta.url`.

## Air-gap kit (fully offline)

Because everything is local, the built demo *is* an offline transfer tool:
copy the `dist/` folder onto the isolated machine once (USB stick, one-time
QR bootstrap, however you like), serve it from `localhost` with any static
server, and it never needs a network again — `localhost` is a secure
context, so the camera works. The payload only ever travels as light; now
the app doesn't travel over a network either. Combined with a sealed stream,
you can move an encrypted file onto or off of an air-gapped box with nothing
but two screens and a camera.

## Sealed streams (optical broadcast)

An optical channel is a broadcast: anyone with line of sight — or a copy of
a screen recording — receives every frame. Sealed mode turns that into a
feature. With a key set, the sender encrypts the payload (name, type, and
bytes) with **AES-256-GCM** *above* the fountain layer, so:

- frame headers stay public and **anyone can collect** a complete stream —
  the receiver even verifies it by hash and reports "received, locked" — but
  every content byte, including the filename, is ciphertext;
- the key is entered on the receiver as a passphrase (PBKDF2-SHA-256,
  600k iterations) or a raw 256-bit key, **before, during, or long after**
  collection;
- a wrong key fails GCM authentication cleanly ("wrong key"), never garbage;
- `exportVideo()` writes the stream to a WebM you can upload anywhere — post
  it publicly and only the key holder can ever open it.

### Does it survive being a video?

That last bullet is only worth anything if the clip still decodes after a
platform re-encodes it, so the **Encrypt for YouTube** button applies a
transcode-hardened recipe: big modules, each code held across several video
frames, in-frame ECC raised to Q, 2.4× fountain redundancy, rendered at 4K.
The codec's damage then lands on frames the fountain can spare rather than on
the file.

Measured (`tests/e2e/transcode.e2e.mjs`, run in CI): a sealed 28 KB payload
exported that way becomes 59 source blocks carried by ~160 codes, and after
re-encoding through simulated **AV1**, **VP9** and H.264 bitrate ladders it
decodes **byte-exact at every rung from 2160p down to 480p**. So the guidance
is: download at 480p or better.

The honest limit on that number: it simulates the codecs YouTube delivers, it
is not a round-trip through YouTube. Real per-title encoding varies bitrate by
over 400% at a single resolution, which a fixed ladder cannot reproduce.

Two honest caveats, also in the code comments: encryption hides content, not
*existence* (a QR video is obviously a data stream), and ciphertext posted
publicly is exposed to offline guessing forever — so for anything published,
prefer a generated random key over a human passphrase.

## Development

```bash
npm test          # unit tests: fountain, protocol, envelope, crypto, geometry
npm run build     # typecheck + production build (the demo pages)
npm run build:lib # the embeddable library: ESM + IIFE + .d.ts types
```

Browser end-to-end tests (sealed transfer, video export/decode) live in
`tests/e2e/` and run against the built library through headless Chromium —
see `tests/e2e/README.md`. They're separate from `npm test` because they
need a browser and a preview server. `transcode.e2e.mjs` additionally needs a
full ffmpeg: it re-encodes an exported clip through AV1/VP9/H.264 bitrate
ladders and reports the shallowest rendition that still decodes byte-exact —
which is where the "download at 480p or better" guidance above comes from.

The determinism goldens in `tests/` pin exact `dlog`/soliton/frame-index
outputs — if a refactor or a JS engine shifts a single bit, they fail loudly
instead of letting sender and receiver silently desynchronize.

`/bench/` is a camera-free loopback: the real encode → QR → zxing-worker →
fountain pipeline against synthetic frames, with knobs for module size,
frame size, blur, loss, worker count, and reader options. Open it on the
actual receiving device to measure that device's decode ceiling and to A/B
tuning changes. (See `docs/IMPROVEMENT-PLAN.md` for the roadmap this
supports.)

`/kaleido/` is an experiment that renders the same fountain stream as a
spinning 8-color mandala instead of QR codes — rotation as sync, a
per-frame color-calibration ring, loopback decoder and all. Notes and
measurements in `docs/KALEIDOSCOPE.md`.

## Similar projects

The concept here was arrived at independently. It turns out
several people have had similar ideas, and their takes are all
worth a look:

- [mohankumarelec/airgapped-qr-code-transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer):
  browser-based QR file transfer with compression and sequential chunking.
  Discovered after publicly demoing this project; convergent evolution in
  action.
- [divan/txqr](https://github.com/divan/txqr) (2018): animated QR plus
  fountain codes in Go, with two excellent write-ups on why fountain coding
  beats sequential looping.
- [sz3/libcimbar](https://github.com/sz3/libcimbar): goes past QR entirely
  with a custom high-density color code purpose-built for this channel.

Built with [node-qrcode](https://github.com/soldair/node-qrcode) and
[zxing-wasm](https://github.com/Sec-ant/zxing-wasm).

## License

MIT
