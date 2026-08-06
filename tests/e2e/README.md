# Browser end-to-end tests

`npm test` runs the pure logic in node (fountain, protocol, envelope, crypto,
ROI/pacing/layout geometry, kaleido packing). The pieces that only exist in a
browser — camera capture, decode workers, WebCrypto, `MediaRecorder`,
canvas `captureStream` — are covered here instead, driving the **built**
library through a real Chromium.

`lib.e2e.mjs` checks:

1. **Sealed live stream** — seal a file, render the sender's canvas into a
   `MediaStream`, receive it, confirm it *locks* on a verified ciphertext, a
   **wrong key is rejected** ("wrong key — did not authenticate"), and the
   correct key delivers the file byte-exact.
2. **Publish-anywhere** — `exportVideo()` records a self-contained clip, then
   a fresh receiver decodes that **recording alone** (no live stream) and
   unseals it byte-exact. This is the "post it to YouTube" path.
3. **Plaintext** — the same library path with no key, confirming compression
   and delivery still work unsealed.

`transcode.e2e.mjs` is the one that decides whether the **"Encrypt for
YouTube"** feature actually works. Everything else here runs against pristine
frames; a video platform re-encodes to its own codecs and bitrate ladder,
smearing precisely the sharp edges QR decoding needs. The test exports a
sealed clip through the real sender, re-encodes it with ffmpeg across the
codecs YouTube delivers — **AV1** (primary as of 2026) and **VP9** (fallback,
still produced for 4K) — at each rung from 2160p down to 480p, decodes each
one back through the real receiver, and reports the **safe floor**: the
shallowest rung that *every* delivered codec survives. A viewer doesn't choose
their rendition, so that floor — not the best-case codec — is the guidance to
give them.

AV1 matters and is easy to overlook: it runs ~20% *below* VP9 for equivalent
perceptual quality, meaning fewer bits spent on exactly the edges the decoder
needs, so it is plausibly the harsher case. An ffmpeg without AV1 or VP9 (such
as Playwright's minimal bundled build) reports **inconclusive** rather than a
falsely reassuring pass.

Until this has been run, the feature's robustness is a reasoned hypothesis,
not a measurement, and the UI says so.

## Running

Not part of CI (they need a browser download + a preview server). Locally:

```bash
npm run build:lib
cp tests/e2e/harness.html dist-lib/
npx vite preview --outDir dist-lib --port 4174 &   # https, self-signed cert
npm i -D playwright-core                            # if not present
node tests/e2e/lib.e2e.mjs
FFMPEG=/usr/bin/ffmpeg node tests/e2e/transcode.e2e.mjs   # takes a few minutes
```

Use a **full** ffmpeg build for the transcode test — current stable is 9.0
"Lei" (2026-08-04). Playwright's bundled ffmpeg is minimal and will likely
lack AV1/VP9, which makes the result inconclusive.

Env overrides: `E2E_ORIGIN` (default `https://localhost:4174`), `CHROMIUM`
(path to a Chromium binary; defaults to the Playwright cache location),
`FFMPEG` (defaults to Playwright's bundled
`/opt/pw-browsers/ffmpeg-*/ffmpeg-linux`), `DIST_LIB` (default `dist-lib` —
the transcoded clips are written there so the harness page can fetch them).

The transcode test exits non-zero unless the clip survives every codec
YouTube delivers, so it can gate the feature in CI once a runner has a full
ffmpeg.

## Caveat on fidelity

YouTube uses per-title encoding: bitrates at a single resolution vary by more
than 400% depending on content, and the ladder was tuned for natural video, not
a synthetic flashing-QR clip. This test approximates the channel well enough to
falsify the feature — if it fails here it will fail there — but a pass is not
proof. Only an actual upload settles it.
