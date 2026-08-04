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
frames; a video platform re-encodes to its own codec and bitrate ladder,
smearing precisely the sharp edges QR decoding needs. The test exports a
sealed clip through the real sender, re-encodes it with ffmpeg at each rung of
a YouTube-like VP9 ladder (2160p→480p), decodes each one back through the real
receiver, and reports **the lowest rung that still reconstructs the file
byte-exact** — which is the actual guidance to give a user. Until this has
been run, the feature's robustness is a reasoned hypothesis, not a
measurement, and the UI says so.

## Running

Not part of CI (they need a browser download + a preview server). Locally:

```bash
npm run build:lib
cp tests/e2e/harness.html dist-lib/
npx vite preview --outDir dist-lib --port 4174 &   # https, self-signed cert
npm i -D playwright-core                            # if not present
node tests/e2e/lib.e2e.mjs
node tests/e2e/transcode.e2e.mjs   # needs ffmpeg; takes a few minutes
```

Env overrides: `E2E_ORIGIN` (default `https://localhost:4174`), `CHROMIUM`
(path to a Chromium binary; defaults to the Playwright cache location),
`FFMPEG` (defaults to Playwright's bundled
`/opt/pw-browsers/ffmpeg-*/ffmpeg-linux`), `DIST_LIB` (default `dist-lib` —
the transcoded clips are written there so the harness page can fetch them).

The transcode test exits non-zero if **no** rung survives, so it can gate the
YouTube feature in CI once a runner has ffmpeg.
