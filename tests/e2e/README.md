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

## Running

Not part of CI (they need a browser download + a preview server). Locally:

```bash
npm run build:lib
cp tests/e2e/harness.html dist-lib/
npx vite preview --outDir dist-lib --port 4174 &   # https, self-signed cert
npm i -D playwright-core                            # if not present
node tests/e2e/lib.e2e.mjs
```

Env overrides: `E2E_ORIGIN` (default `https://localhost:4174`), `CHROMIUM`
(path to a Chromium binary; defaults to the Playwright cache location).
