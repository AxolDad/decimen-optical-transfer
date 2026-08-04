// TRANSCODE SURVIVAL TEST — does an "Encrypt for YouTube" clip still decode
// after a video platform re-encodes it?
//
// This is the experiment the YouTube feature rests on, and until it runs the
// feature's robustness is a hypothesis, not a measurement. Everything else
// in the repo is verified against pristine frames; a real platform re-encodes
// to its own codec and bitrate ladder, smearing exactly the sharp black/white
// edges QR decoding depends on.
//
// What it does:
//   1. exports a sealed clip through the real OpticalSender (YouTube preset)
//   2. re-encodes it with ffmpeg at each rung of a YouTube-like ladder
//   3. feeds each re-encoded file back through the real OpticalReceiver
//   4. reports which rungs still reconstruct the file byte-exact
//
// The answer we want is not just pass/fail but the LOWEST rung that survives
// — that is the honest guidance to give a user ("keep it at 1080p or above").
//
// Run:
//   npm run build:lib
//   cp tests/e2e/harness.html dist-lib/
//   npx vite preview --outDir dist-lib --port 4174 &
//   node tests/e2e/transcode.e2e.mjs
//
// Env: E2E_ORIGIN (default https://localhost:4174), CHROMIUM, FFMPEG,
//      DIST_LIB (default ./dist-lib — transcoded files are served from here).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ORIGIN = process.env.E2E_ORIGIN ?? "https://localhost:4174";
const EXE = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";
const FFMPEG = process.env.FFMPEG ?? "/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux";
const DIST = process.env.DIST_LIB ?? "dist-lib";
const WORK = join(DIST, "transcode-test");

// YouTube's published VP9 ladder, roughly. Each rung is what a viewer might
// actually download — the clip has to survive the one they get.
const LADDER = [
  { name: "2160p", height: 2160, bitrate: "20M" },
  { name: "1440p", height: 1440, bitrate: "9M" },
  { name: "1080p", height: 1080, bitrate: "4500k" },
  { name: "720p", height: 720, bitrate: "2500k" },
  { name: "480p", height: 480, bitrate: "1200k" },
];

const ff = (args) =>
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "buffer",
    maxBuffer: 1 << 30,
  });

/** Pick a VP9 encoder if this ffmpeg has one, else fall back to H.264. */
function pickEncoder() {
  const out = execFileSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (out.includes("libvpx-vp9")) return { codec: "libvpx-vp9", ext: "webm" };
  if (out.includes("libx264")) return { codec: "libx264", ext: "mp4" };
  if (out.includes("libvpx")) return { codec: "libvpx", ext: "webm" };
  throw new Error("no usable video encoder in this ffmpeg build");
}

const results = [];

async function main() {
  if (!existsSync(FFMPEG)) throw new Error(`ffmpeg not found at ${FFMPEG} (set FFMPEG=)`);
  mkdirSync(WORK, { recursive: true });
  const enc = pickEncoder();
  console.log(`ffmpeg: ${FFMPEG}\nencoder: ${enc.codec} (.${enc.ext})\n`);

  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.goto(`${ORIGIN}/harness.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

  // A small payload keeps the clip short; the geometry (module size, code
  // rate, redundancy) is what the test is actually about, not the duration.
  const text = Array.from({ length: 150 }, (_, i) => `line ${i} :: ${(i * 2654435761) >>> 0}`).join("\n");

  // ---- 1. export a sealed clip through the real sender, YouTube preset ----
  console.log("exporting a sealed clip (YouTube preset)…");
  const exported = await page.evaluate(async (text) => {
    const lib = window.DecimenLib;
    const key = lib.randomKeyHex();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const sender = new lib.OpticalSender({
      canvas,
      payload: { bytes: new TextEncoder().encode(text), name: "sealed-note.txt", mime: "text/plain" },
      // the "Encrypt for YouTube" recipe, mirrored from send/main.ts
      targetFps: 8, frameBytes: 500, codes: 1, ecc: "Q", displayPx: 1200, encryptKey: key,
    });
    await sender.start();
    await new Promise((r) => setTimeout(r, 400));
    const plan = sender.exportPlan({ overhead: 2.4, targetHeight: 2160, videoFps: 30 });
    const blob = await sender.exportVideo({
      overhead: 2.4, targetHeight: 2160, videoFps: 30, bitsPerSecond: 16_000_000,
    });
    sender.stop();
    // base64 over the CDP bridge — a multi-MB clip as a JSON number array
    // would be an order of magnitude larger and can stall the transport.
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000; // chunked: fromCharCode(...wholeClip) blows the stack
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return { key, plan, b64: btoa(bin), mime: blob.type };
  }, text);

  const master = join(WORK, "master.webm");
  const masterBytes = Buffer.from(exported.b64, "base64");
  writeFileSync(master, masterBytes);
  console.log(
    `  ${(masterBytes.length / 1024 / 1024).toFixed(1)} MB, ${exported.plan.seconds}s, ` +
      `${exported.plan.framesPerCode} video frames per code\n`,
  );

  // ---- 2 & 3. transcode each rung, then decode it back ----
  for (const rung of LADDER) {
    const out = join(WORK, `rung-${rung.name}.${enc.ext}`);
    process.stdout.write(`${rung.name} @ ${rung.bitrate}: transcoding… `);
    try {
      ff([
        "-i", master,
        "-c:v", enc.codec,
        "-b:v", rung.bitrate,
        "-vf", `scale=-2:${rung.height}`,
        "-pix_fmt", "yuv420p", // what every platform delivers
        "-r", "30",
        ...(enc.codec === "libvpx-vp9" ? ["-row-mt", "1", "-deadline", "good", "-cpu-used", "2"] : []),
        ...(enc.codec === "libx264" ? ["-preset", "medium", "-profile:v", "high"] : []),
        out,
      ]);
    } catch (err) {
      console.log(`FFMPEG FAILED — ${err.message.split("\n")[0]}`);
      results.push({ ...rung, ok: false, note: "transcode failed" });
      continue;
    }
    process.stdout.write("decoding… ");
    const url = `/transcode-test/rung-${rung.name}.${enc.ext}`;
    const res = await page.evaluate(
      async ({ url, key, want }) => {
        const lib = window.DecimenLib;
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], "clip", { type: blob.type });
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        document.body.append(video);
        let peakFrames = 0;
        const started = performance.now();
        const out = await new Promise((resolve) => {
          const rx = new lib.OpticalReceiver({
            video, source: file, workers: 4, key,
            // generous: a lossy clip may need several passes before the
            // stall watchdog (no NEW frames) correctly gives up
            fileStallMs: 20_000,
            onStats: (s) => { peakFrames = Math.max(peakFrames, s.framesNew); },
            onComplete: (f) => resolve({ ok: true, text: new TextDecoder().decode(f.bytes) }),
            onError: (m) => resolve({ ok: false, err: m }),
          });
          rx.start();
          setTimeout(() => resolve({ ok: false, err: "hard timeout" }), 180_000);
        });
        video.remove();
        return { ...out, peakFrames, seconds: (performance.now() - started) / 1000, exact: out.text === want };
      },
      { url, key: exported.key, want: text },
    );
    const ok = res.ok && res.exact;
    console.log(
      ok
        ? `DECODED ✓ (${res.seconds.toFixed(1)}s, byte-exact)`
        : `failed — ${res.err ?? "content mismatch"} (peak ${res.peakFrames} frames)`,
    );
    results.push({ ...rung, ok, peakFrames: res.peakFrames, note: res.err ?? "" });
  }

  await browser.close();

  // ---- 4. the verdict ----
  console.log("\n=== transcode survival ===");
  for (const r of results) {
    console.log(`  ${r.name.padEnd(7)} ${r.bitrate.padEnd(7)} ${r.ok ? "SURVIVES" : "fails"}${r.note ? ` (${r.note})` : ""}`);
  }
  const survivors = results.filter((r) => r.ok);
  if (survivors.length === 0) {
    console.log("\nNo rung survived. The YouTube preset does NOT currently work end to end.");
  } else {
    const lowest = survivors[survivors.length - 1];
    console.log(`\nLowest surviving rung: ${lowest.name}. Tell users to download at ${lowest.name} or better.`);
  }
  process.exit(survivors.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
