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
still produced for 4K) — at each rung from 2160p down to 144p, decodes each
one back through the real receiver, and reports the **safe floor**: the
shallowest rung that *every* delivered codec survives. A viewer doesn't choose
their rendition, so that floor — not the best-case codec — is the guidance to
give them.

AV1 matters and is easy to overlook: it runs ~20% *below* VP9 for equivalent
perceptual quality, meaning fewer bits spent on exactly the edges the decoder
needs, so it is plausibly the harsher case. An ffmpeg without AV1 or VP9 (such
as Playwright's minimal bundled build) reports **inconclusive** rather than a
falsely reassuring pass.

## Measured result

First valid run (GitHub Actions, ffmpeg 6.1.1 with libsvtav1 / libvpx-vp9 /
libx264). A 28 KB incompressible sealed payload became **k=59** source blocks
in a 20 s 4K clip carrying ~160 codes — so the receiver could lose ~63% of
them and still finish, which is what makes the result evidence rather than
luck:

| codec | 2160p | 1440p | 1080p | 720p | 480p |
|---|---|---|---|---|---|
| **AV1** — primary | ✓ | ✓ | ✓ | ✓ | ✓ |
| **VP9** — fallback | ✓ | ✓ | ✓ | ✓ | ✓ |
| H.264 — indicative only | ✓ | ✓ | ✓ | ✓ | ✓ |

Every rung reconstructed the file **byte-exact**, ~12.8 s per decode. Safe
floor: **480p** — so the guidance is "download at 480p or better".

Two things that result does *not* say. It simulates the codecs YouTube
delivers; it is not a YouTube round-trip. And nothing in the ladder broke, so
it is a lower bound on robustness rather than a margin — which is why the
ladder now probes 360p/240p/144p as well, and why the pass/fail gate (`GATE`
in the test) sits at 480p instead of "every rung must survive". A failed probe
rung below the gate is a measurement, not a regression.

### Why the guards are there

It took three runs to get one number, and neither failure announced itself in
the pass/fail line:

1. **Run 1 "passed" everything — and measured nothing.** The payload was
   repetitive text that deflated to under 1 KB, giving **k=2**: the receiver
   needed 2 good codes out of ~160, so it would have passed while the codec
   destroyed 98% of the clip. The only visible symptom was that each decode
   took 0.6 s instead of ~13 s.
2. **Run 2 tripped the new `MIN_K` guard at k=28** — and the guard was right.
   The "incompressible" payload generator was an LCG, and `s * 1103515245` in
   JS is float64: once `s` nears 2^31 the product passes 2^53, the low bits
   round away, and the generator degenerates into structure deflate eats.
   Replaced with splitmix32 (`Math.imul`, the same construction
   `shared/protocol.ts` uses for exactly this reason).

Hence the two guards that now run before the ladder: the payload must not
compress, and `k` must clear `MIN_K`. The test also prints its difficulty in
plain language ("needs ~59 good codes out of ~160, tolerates losing ~63%")
before any transcoding, because that sentence — not the row of green ticks —
is what tells you whether the run was worth anything.

## Running

Not part of the default CI (they need a browser download + a preview server).
Locally:

```bash
npm run build:lib
cp tests/e2e/harness.html dist-lib/
npx vite preview --outDir dist-lib --port 4174 &   # https, self-signed cert
npm i -D playwright-core                            # if not present
node tests/e2e/lib.e2e.mjs
FFMPEG=/usr/bin/ffmpeg node tests/e2e/transcode.e2e.mjs   # ~25 min, 24 rungs
```

Use a **full** ffmpeg build for the transcode test — current stable is 9.0
"Lei" (2026-08-04). Playwright's bundled ffmpeg is minimal and will likely
lack AV1/VP9, which makes the result inconclusive.

Env overrides: `E2E_ORIGIN` (default `https://localhost:4174`), `CHROMIUM`
(path to a Chromium binary; defaults to the Playwright cache location),
`FFMPEG` (defaults to Playwright's bundled
`/opt/pw-browsers/ffmpeg-*/ffmpeg-linux`), `DIST_LIB` (default `dist-lib` —
the transcoded clips are written there so the harness page can fetch them).

The transcode test exits non-zero unless every codec YouTube delivers reaches
the `GATE` rung, so it gates the feature. It runs automatically on pushes to
the working branch via `.github/workflows/transcode.yml`, which mirrors the
full log into the run summary (readable from a phone) and uploads the
pre-transcode `master.webm` as an artifact — that clip, plus the key printed
in the log, is everything needed for a real upload round-trip.

## Caveat on fidelity

YouTube uses per-title encoding: bitrates at a single resolution vary by more
than 400% depending on content, and the ladder was tuned for natural video, not
a synthetic flashing-QR clip. This test approximates the channel well enough to
falsify the feature — if it fails here it will fail there — but a pass is not
proof. Only an actual upload settles it.
