// Browser end-to-end tests for the built library (Phases 3B + 4).
//
// These exercise the real DOM/worker/WebCrypto pipeline that the node/jsdom
// unit suite can't: seal → grid QR → canvas MediaStream → capture → fountain
// → locked → unlock, and the publish-anywhere path (record a clip, decode
// the recording from scratch). They are NOT part of `npm test` (they need a
// browser + a preview server); run them with:
//
//   npm run build:lib
//   cp tests/e2e/harness.html dist-lib/
//   npx vite preview --outDir dist-lib --port 4174 &   # https, self-signed
//   node tests/e2e/lib.e2e.mjs
//
// Requires playwright-core and a Chromium at $CHROMIUM (defaults to the
// Playwright cache path). Exits non-zero on any failure.

import { chromium } from "playwright-core";

const ORIGIN = process.env.E2E_ORIGIN ?? "https://localhost:4174";
const EXE = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  page error:", e.message));

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(`${ORIGIN}/harness.html`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

const sampleText = (n) =>
  Array.from({ length: n }, (_, i) => `line ${i} :: ${(i * 2654435761) >>> 0}`).join("\n");

// 1) Sealed live stream: seal → MediaStream → receive → wrong key → unlock.
{
  const text = sampleText(4000);
  const out = await page.evaluate(async (text) => {
    const lib = window.DecimenLib;
    const key = lib.randomKeyHex();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const sender = new lib.OpticalSender({
      canvas,
      payload: { bytes: new TextEncoder().encode(text), name: "classified.txt", mime: "text/plain" },
      targetFps: 30, codes: 4, encryptKey: key,
    });
    await sender.start();
    await new Promise((r) => setTimeout(r, 400));
    const stream = canvas.captureStream(30);
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    document.body.append(video);
    let sawLocked = false, wrongKeyErr = null;
    const res = await new Promise((resolve) => {
      const rx = new lib.OpticalReceiver({
        video, source: stream, workers: 4,
        onLocked: async () => { sawLocked = true; try { await rx.unlock(lib.randomKeyHex()); } catch {} },
        onError: (m) => { if (sawLocked && !wrongKeyErr) { wrongKeyErr = m; rx.unlock(key); } },
        onComplete: (f) => resolve({ ok: true, name: f.name, sealed: f.sealed, text: new TextDecoder().decode(f.bytes) }),
      });
      rx.start();
      setTimeout(() => resolve({ ok: false, err: "timeout" }), 45000);
    });
    sender.stop();
    return { ...res, sawLocked, wrongKeyErr };
  }, text);
  check("sealed stream locks before unlock", out.sawLocked);
  check("wrong key rejected cleanly", /wrong key/.test(out.wrongKeyErr ?? ""), out.wrongKeyErr);
  check("correct key delivers byte-exact sealed file",
    out.ok && out.name === "classified.txt" && out.sealed === true && out.text === text);
}

// 2) Publish-anywhere: export a self-contained clip, decode the recording.
{
  const text = sampleText(800);
  const out = await page.evaluate(async (text) => {
    const lib = window.DecimenLib;
    const key = lib.randomKeyHex();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const sender = new lib.OpticalSender({
      canvas,
      payload: { bytes: new TextEncoder().encode(text), name: "sealed-note.txt", mime: "text/plain" },
      targetFps: 30, codes: 1, encryptKey: key,
    });
    await sender.start();
    await new Promise((r) => setTimeout(r, 300));
    const blob = await sender.exportVideo(1.6);
    sender.stop();
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    document.body.append(video);
    const res = await new Promise((resolve) => {
      const rx = new lib.OpticalReceiver({
        video, source: new File([blob], "clip.webm", { type: blob.type }), workers: 4, key,
        onComplete: (f) => resolve({ ok: true, name: f.name, sealed: f.sealed, text: new TextDecoder().decode(f.bytes) }),
        onError: (m) => resolve({ ok: false, err: m }),
      });
      rx.start();
      setTimeout(() => resolve({ ok: false, err: "timeout" }), 60000);
    });
    return { ...res, mime: blob.type, size: blob.size };
  }, text);
  check("exported clip decodes from scratch, byte-exact",
    out.ok && out.name === "sealed-note.txt" && out.sealed === true && out.text === text,
    out.ok ? `${out.mime} ${(out.size / 1024) | 0} KB` : out.err);
}

// 3) Plaintext file (no key) still works via the same lib path.
{
  const text = sampleText(1500);
  const out = await page.evaluate(async (text) => {
    const lib = window.DecimenLib;
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const sender = new lib.OpticalSender({
      canvas, payload: { bytes: new TextEncoder().encode(text), name: "plain.txt", mime: "text/plain" },
      targetFps: 30, codes: 2,
    });
    await sender.start();
    await new Promise((r) => setTimeout(r, 300));
    const stream = canvas.captureStream(30);
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    document.body.append(video);
    const res = await new Promise((resolve) => {
      const rx = new lib.OpticalReceiver({
        video, source: stream, workers: 4,
        onComplete: (f) => resolve({ ok: true, name: f.name, sealed: f.sealed, deflated: f.deflated, text: new TextDecoder().decode(f.bytes) }),
        onError: (m) => resolve({ ok: false, err: m }),
      });
      rx.start();
      setTimeout(() => resolve({ ok: false, err: "timeout" }), 45000);
    });
    sender.stop();
    return res;
  }, text);
  check("plaintext transfer delivers, unsealed, deflated",
    out.ok && out.name === "plain.txt" && out.sealed === false && out.deflated === true && out.text === text);
}

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
