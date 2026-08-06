// TRANSCODE SURVIVAL TEST — does an "Encrypt for YouTube" clip still decode
// after a video platform re-encodes it?
//
// This is the experiment the YouTube feature rests on. Everything else in the
// repo is verified against pristine frames; a real platform re-encodes to its
// own codec and bitrate ladder, smearing exactly the sharp black/white edges
// QR decoding depends on.
//
// What it does:
//   1. exports a sealed clip through the real OpticalSender (YouTube preset)
//   2. re-encodes it with ffmpeg across YouTube's delivery codecs (AV1 and
//      VP9 as of 2026) at each rung of a resolution/bitrate ladder
//   3. feeds each re-encoded file back through the real OpticalReceiver
//   4. reports which rungs still reconstruct the file byte-exact
//
// The answer we want is not pass/fail but the SAFE FLOOR: the shallowest rung
// that every delivered codec still survives, since a viewer does not choose
// which rendition they get. That is the honest guidance to hand a user
// ("download at 480p or better").
//
// The ladder deliberately runs PAST the bar it has to clear (see GATE). The
// first valid run cleared every rung down to 480p, which established a lower
// bound and nothing else: a ladder that never breaks doesn't tell you your
// margin, only that you didn't push hard enough. The low rungs exist to find
// the rung that actually breaks, and failing one of those is information, not
// a regression — only falling short of GATE fails the test.
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

// Rungs in VP9 bitrates (kbps-ish strings ffmpeg understands). A viewer gets
// ONE of these, so the clip has to survive whichever one they're served.
// 360p and below are margin probes, not requirements — see GATE.
const LADDER = [
  { name: "2160p", height: 2160, vp9: 20000 },
  { name: "1440p", height: 1440, vp9: 9000 },
  { name: "1080p", height: 1080, vp9: 4500 },
  { name: "720p", height: 720, vp9: 2500 },
  { name: "480p", height: 480, vp9: 1200 },
  { name: "360p", height: 360, vp9: 750 },
  { name: "240p", height: 240, vp9: 400 },
  { name: "144p", height: 144, vp9: 200 },
];

// The rung the feature must reach for this test to pass. Set to the depth
// already demonstrated, so the test is a regression gate on proven ground
// rather than an aspiration. Rungs below it are probed to locate the real
// breaking point; failing those is a measurement, not a failure.
const GATE = "480p";

// As of 2026 YouTube delivers AV1 as its primary codec (VP9 remains the
// fallback and is still produced for 4K), so a test that only exercised VP9
// would be measuring a rendition many viewers never receive. AV1 also runs
// ~20% BELOW VP9 for equivalent perceptual quality — fewer bits spent on
// exactly the sharp black/white edges QR decoding depends on — so it is
// plausibly the harsher case and must be covered.
//
// `scale` converts the VP9 rung bitrate to each codec's equivalent.
const FAMILIES = [
  {
    key: "AV1",
    scale: 0.8,
    representative: true,
    note: "YouTube's primary delivery codec",
    candidates: [
      { codec: "libsvtav1", ext: "mp4", extra: ["-preset", "8"] },
      { codec: "libaom-av1", ext: "mp4", extra: ["-cpu-used", "8", "-row-mt", "1"] },
    ],
  },
  {
    key: "VP9",
    scale: 1.0,
    representative: true,
    note: "fallback rendition, still produced for 4K",
    candidates: [
      { codec: "libvpx-vp9", ext: "webm", extra: ["-row-mt", "1", "-deadline", "good", "-cpu-used", "2"] },
    ],
  },
  {
    key: "H.264",
    scale: 1.6, // needs more bits for the same quality
    representative: false,
    note: "NOT what YouTube delivers at these resolutions — indicative only",
    candidates: [{ codec: "libx264", ext: "mp4", extra: ["-preset", "medium", "-profile:v", "high"] }],
  },
];

const ff = (args) =>
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "buffer",
    maxBuffer: 1 << 30,
  });

/** Every codec family this ffmpeg build can actually produce. */
function availableFamilies() {
  const out = execFileSync(FFMPEG, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  const found = [];
  for (const fam of FAMILIES) {
    const hit = fam.candidates.find((c) => out.includes(c.codec));
    if (hit) found.push({ ...fam, ...hit });
  }
  return found;
}

const results = [];

// Contiguous from the top: if 480p fails, a lucky 360p pass underneath it is
// noise, not a floor anyone can be promised. Returns the LADDER index of the
// deepest rung reached without a break, or -1 for "nothing survives".
function floorIndexOf(key) {
  let i = -1;
  while (i + 1 < LADDER.length) {
    const r = results.find((x) => x.family === key && x.name === LADDER[i + 1].name);
    if (!r?.ok) break;
    i++;
  }
  return i;
}

async function main() {
  if (!existsSync(FFMPEG)) throw new Error(`ffmpeg not found at ${FFMPEG} (set FFMPEG=)`);
  mkdirSync(WORK, { recursive: true });
  const families = availableFamilies();
  if (families.length === 0) throw new Error("no usable video encoder in this ffmpeg build");
  const version = execFileSync(FFMPEG, ["-version"], { encoding: "utf8" }).split("\n")[0];
  console.log(`ffmpeg: ${FFMPEG}\n  ${version}`);
  console.log(`codecs: ${families.map((f) => `${f.key} (${f.codec})`).join(", ")}`);
  if (!families.some((f) => f.representative)) {
    console.log(
      "\n  ⚠ WARNING: this ffmpeg has neither AV1 nor VP9. YouTube delivers those,\n" +
        "    so the result below does NOT tell you whether the feature survives\n" +
        "    YouTube. Install a full ffmpeg (9.0 'Lei', 2026-08-04) and re-run.",
    );
  }
  console.log();

  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.goto(`${ORIGIN}/harness.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

  // The payload has to be big enough that the RESULT MEANS SOMETHING. A tiny
  // file yields k≈2 source blocks, so the receiver needs ~2 good codes out of
  // the whole video and passes even if the codec destroys 80% of frames —
  // measuring nothing. (The first version of this test did exactly that and
  // "passed" every rung in 0.6s per decode.)
  //
  // Sizing for k≈60: the fountain's design margin is the 2.4× overhead, i.e.
  // it should survive losing ~58% of codes and fail past that. Any k has that
  // same fractional tolerance, but small k is dominated by luck — only a large
  // k makes the observed loss fraction concentrate enough to be evidence.
  // Incompressible bytes keep the wire size predictable (deflate is skipped
  // when it doesn't pay, so what we generate is what gets transmitted).
  const PAYLOAD_BYTES = 28_000;
  const PAYLOAD_SEED = 1234567;
  const MIN_K = 40; // below this the test proves nothing — fail loudly instead

  // ---- 1. export a sealed clip through the real sender, YouTube preset ----
  console.log(`exporting a sealed clip (YouTube preset, ${PAYLOAD_BYTES} B payload)…`);
  const exported = await page.evaluate(async ({ size, seed }) => {
    const lib = window.DecimenLib;
    // Deterministic pseudo-random bytes: incompressible, so the wire length
    // (and therefore k) is predictable, and reproducible for verification.
    //
    // splitmix32, the same construction shared/protocol.ts uses. A plain LCG
    // is wrong here: `s * 1103515245` in JS is float64, and once s approaches
    // 2^31 that product passes 2^53, so the low bits round away and the
    // generator degenerates into structure that deflate happily eats. The
    // first attempt did exactly that — 28 KB compressed to 13 KB. Math.imul
    // keeps every step in exact 32-bit integers.
    const makePayload = () => {
      const out = new Uint8Array(size);
      let s = seed | 0;
      for (let i = 0; i < size; i++) {
        s = (s + 0x9e3779b9) | 0;
        let t = s ^ (s >>> 16);
        t = Math.imul(t, 0x21f0aaad);
        t ^= t >>> 15;
        t = Math.imul(t, 0x735a2d97);
        t ^= t >>> 15;
        out[i] = (t >>> 0) & 0xff;
      }
      return out;
    };
    const key = lib.randomKeyHex();
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    let info = null;
    const sender = new lib.OpticalSender({
      canvas,
      payload: { bytes: makePayload(), name: "sealed-note.bin", mime: "application/octet-stream" },
      // the "Encrypt for YouTube" recipe, mirrored from send/main.ts
      targetFps: 8, frameBytes: 500, codes: 1, ecc: "Q", displayPx: 1200, encryptKey: key,
      onReady: (i) => (info = i),
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
    return { key, plan, k: info?.k ?? 0, wire: info?.wireSize ?? 0, b64: btoa(bin), mime: blob.type };
  }, { size: PAYLOAD_BYTES, seed: PAYLOAD_SEED });

  const master = join(WORK, "master.webm");
  const masterBytes = Buffer.from(exported.b64, "base64");
  writeFileSync(master, masterBytes);
  const codesInClip = Math.round(exported.plan.seconds * 8);
  console.log(
    `  ${(masterBytes.length / 1024 / 1024).toFixed(1)} MB, ${exported.plan.seconds}s, ` +
      `${exported.plan.framesPerCode} video frames per code`,
  );
  console.log(
    `  k=${exported.k} source blocks from a ${exported.wire} B wire — the receiver needs\n` +
      `  ~${exported.k} good codes out of the ~${codesInClip} in the clip, so it tolerates losing\n` +
      `  roughly ${Math.round((1 - exported.k / codesInClip) * 100)}% of them before failing.`,
  );
  if (exported.wire < PAYLOAD_BYTES * 0.9) {
    throw new Error(
      `the payload compressed (${PAYLOAD_BYTES} B -> ${exported.wire} B on the wire). It is ` +
        `supposed to be incompressible; a generator producing structure makes k smaller and ` +
        `the test weaker than intended.`,
    );
  }
  if (exported.k < MIN_K) {
    throw new Error(
      `k=${exported.k} is too small (need >= ${MIN_K}). At this size the fountain wins on ` +
        `luck and the ladder result would be meaningless — raise PAYLOAD_BYTES.`,
    );
  }
  // Printed so the saved master.webm is actually usable: upload it to YouTube,
  // download the renditions back, and decode them with this key for the real
  // end-to-end answer this synthetic ladder only approximates. It protects
  // nothing but deterministic test bytes.
  console.log(`  test key (for a manual upload round-trip): ${exported.key}\n`);

  // ---- 2 & 3. transcode each rung of each codec, then decode it back ----
  const gateRung = LADDER.findIndex((l) => l.name === GATE);
  for (const fam of families) {
   console.log(`--- ${fam.key} (${fam.codec}) — ${fam.note} ---`);
   for (const [rungIdx, rung] of LADDER.entries()) {
    const kbps = Math.round(rung.vp9 * fam.scale);
    const tag = `${fam.key}-${rung.name}`;
    const out = join(WORK, `rung-${tag}.${fam.ext}`);
    process.stdout.write(`  ${rung.name} @ ${kbps}k${rungIdx > gateRung ? " (probe)" : ""}: transcoding… `);
    try {
      ff([
        "-i", master,
        "-c:v", fam.codec,
        "-b:v", `${kbps}k`,
        "-vf", `scale=-2:${rung.height}`,
        "-pix_fmt", "yuv420p", // what every platform delivers
        "-r", "30",
        ...fam.extra,
        out,
      ]);
    } catch (err) {
      console.log(`FFMPEG FAILED — ${err.message.split("\n")[0]}`);
      results.push({ family: fam.key, ...rung, kbps, ok: false, note: "transcode failed" });
      continue;
    }
    process.stdout.write("decoding… ");
    const url = `/transcode-test/rung-${tag}.${fam.ext}`;
    const res = await page.evaluate(
      async ({ url, key, size, seed, needK }) => {
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
            onComplete: (f) => {
              // regenerate the expected bytes (same splitmix32 as the sender
              // side) and compare in-page, so a multi-KB payload never
              // crosses the CDP bridge
              let s = seed | 0;
              let exact = f.bytes.length === size;
              for (let i = 0; exact && i < size; i++) {
                s = (s + 0x9e3779b9) | 0;
                let t = s ^ (s >>> 16);
                t = Math.imul(t, 0x21f0aaad);
                t ^= t >>> 15;
                t = Math.imul(t, 0x735a2d97);
                t ^= t >>> 15;
                if (f.bytes[i] !== ((t >>> 0) & 0xff)) exact = false;
              }
              resolve({ ok: true, exact });
            },
            onError: (m) => resolve({ ok: false, exact: false, err: m }),
          });
          rx.start();
          setTimeout(() => resolve({ ok: false, exact: false, err: "hard timeout" }), 300_000);
        });
        video.remove();
        return { ...out, peakFrames, needK, seconds: (performance.now() - started) / 1000 };
      },
      { url, key: exported.key, size: PAYLOAD_BYTES, seed: PAYLOAD_SEED, needK: exported.k },
    );
    const ok = res.ok && res.exact;
    console.log(
      ok
        ? `DECODED ✓ (${res.seconds.toFixed(1)}s, byte-exact)`
        : `failed — ${res.err ?? "content mismatch"} (collected ${res.peakFrames}/${res.needK} frames)`,
    );
    results.push({ family: fam.key, ...rung, kbps, ok, peakFrames: res.peakFrames, note: res.err ?? "" });
   }
   console.log();
  }

  await browser.close();

  // ---- 4. the verdict ----
  console.log("=== transcode survival ===");
  for (const fam of families) {
    const idx = floorIndexOf(fam.key);
    const floor = idx === -1 ? null : LADDER[idx];
    console.log(
      `  ${fam.key.padEnd(6)} ${
        floor === null
          ? "NOTHING SURVIVES"
          : `survives down to ${floor.name} (${Math.round(floor.vp9 * fam.scale)}k)`
      }${fam.representative ? "" : "   [not a YouTube codec — indicative only]"}`,
    );
    for (const r of results.filter((r) => r.family === fam.key)) {
      console.log(`         ${r.name.padEnd(7)} ${String(r.kbps + "k").padEnd(7)} ${r.ok ? "ok" : `fail${r.note ? ` — ${r.note}` : ""}`}`);
    }
  }

  // The honest bar: it has to survive EVERY codec YouTube actually delivers,
  // because a viewer doesn't choose which rendition they're served. So the
  // guidance is the safe floor — the shallowest depth every real codec
  // reached, not the deepest one some codec happened to manage.
  console.log();
  const reps = families.filter((f) => f.representative);
  let exitCode = 1;
  if (reps.length === 0) {
    console.log(
      "VERDICT: inconclusive — this ffmpeg could not produce AV1 or VP9, the\n" +
        "codecs YouTube delivers. Install a full ffmpeg and re-run.",
    );
  } else {
    const floors = reps.map((f) => ({ key: f.key, idx: floorIndexOf(f.key) }));
    const worst = Math.min(...floors.map((f) => f.idx));
    const dead = floors.filter((f) => f.idx === -1).map((f) => f.key);
    if (dead.length > 0) {
      console.log(
        `VERDICT: FAILS. Nothing survived ${dead.join(" and ")}, which YouTube delivers — so a\n` +
          "viewer served that rendition cannot recover the file at any resolution.\n" +
          "The preset needs bigger modules, more redundancy, or both.",
      );
    } else if (worst < gateRung) {
      const weakest = floors.find((f) => f.idx === worst);
      console.log(
        `VERDICT: FAILS the ${GATE} bar. The safe floor is ${LADDER[worst].name} — ${weakest.key} is the\n` +
          `codec that gives out first — but YouTube serves ${GATE} routinely, so a viewer can\n` +
          "be handed a rendition this clip cannot survive. The preset needs bigger\n" +
          "modules, more redundancy, or both.",
      );
    } else {
      const floor = LADDER[worst];
      const broke = LADDER[worst + 1];
      console.log(
        `VERDICT: survives every codec YouTube delivers, down to ${floor.name}.\n` +
          `Guidance to users: download at ${floor.name} or better.`,
      );
      console.log(
        broke
          ? `Margin: ${worst - gateRung} rung(s) of headroom past the ${GATE} bar; the shallowest rung\n` +
            `that actually breaks is ${broke.name}.`
          : `Margin: unknown — the clip survived every rung tested, down to the bottom of\n` +
            `the ladder (${LADDER[LADDER.length - 1].name}). Extend LADDER to find the real floor.`,
      );
      exitCode = 0;
    }
  }
  console.log(
    "\nCaveat: YouTube uses per-title encoding, and bitrates at one resolution\n" +
      "vary by >400% depending on content. A synthetic flashing-QR clip is\n" +
      "nothing like natural video, so its real assigned bitrate could sit well\n" +
      "outside this ladder. Only an actual upload settles it.",
  );
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
