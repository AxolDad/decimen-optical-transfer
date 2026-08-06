# Kaleidoscope symbology — exploration notes

**Status: decodes through a simulated camera, square on** (`/kaleido/`), not yet a
production transport — a tilted view still fails. See the camera-path section below.
The question explored: can the stream be *beautiful* — "a whole abstract kaleidoscope
of color" at 30 fps toward 4K — instead of a flickering QR code, without giving up the
architecture that makes this project work?

Short answer: yes in principle, and the experiment proves the layering claim — the
fountain code, protocol header, and file envelope run **unchanged** underneath a
completely different symbology. Pixels are just the last mile. The camera-side decode
is the real (unbuilt) hard part, same as it was for the parent experiment's color work.

## What the experiment is

Data frames render as a spinning polar mandala: concentric rings of colored wedges on
a dark field, 3 bits per wedge from an 8-color palette.

| ring | role |
|---|---|
| innermost | **sync ring** — fixed pattern with one marker wedge; the whole frame rotates by `seq mod sectors` slots each frame, and finding the marker recovers that phase. The spin isn't decoration — **the rotation is the synchronization**. |
| middle rings | **data** — 3 bits/wedge |
| outermost | **calibration ring** — all 8 palette colors, every frame; the decoder rebuilds its color classifier from it per frame, which is what would absorb screen gamut / white balance / exposure differences on a real camera |

Every ring is additionally offset by a constant 3 slots per ring, which bends the
spokes into spirals as it spins — free aesthetics, zero decode cost.

Frame bytes are `[20 B protocol header][fountain block][u32 FNV]`. QR gave per-frame
integrity for free; here the FNV trailer supplies it: corrupt frames are discarded
whole and the fountain absorbs the erasure — the exact model the QR path already uses
(ECC-L + disposal).

## Measured (loopback, headless Chromium, **software rasterizer** — see caveat)

| config | B/frame | result |
|---|---|---|
| 1080px, 26 rings × 64 sectors | 576 | 128 KB in 9.1 s, **14.0 KB/s**, 0 corrupt, verified ✓ |
| same, sample noise ±35/channel | 576 | identical — **0 corrupt frames**, verified ✓ |
| 1536px, 34 × 96 | 1152 | 14.0 KB/s (fps-bound, see below), 0 corrupt ✓ |
| 2160px, 34 × 128 | 1536 | 512 KB verified ✓, 11.3 KB/s (fps-bound), 0 corrupt even at ±20 noise |

Per-stage cost (same environment): render 3.8 / 12.5 / 20.8 ms and decode 21.1 /
44.6 / 77.2 ms at 1080 / 1536 / 2160 px. **Caveat:** this container rasterizes canvas
on the CPU (SwiftShader). On real GPUs rendering is a few ms even at 2160, and the
decode cost is dominated by `getImageData` readback + main-thread sampling — both
fixable the same way the QR receiver was fixed (worker offload, band-limited reads).
The bigger configs ran below 30 fps *here*; the geometry itself is not the limit.

Palette lesson, courtesy of the test suite: the first "tasteful" muted palette failed
its own margin test — yellow↔orange sat at distance ~76, and classification needs
≥90-ish to survive noise. Saturated RGB-corner colors (min pairwise distance 127)
sailed through ±35/channel noise with zero corrupt frames. **The kaleidoscope stays
neon because the math says so.**

## What 4K30 could carry (the honest ceiling math)

Cells available in a 2160px annulus (r ∈ [0.16, 0.48]·size) at camera-plausible wedge
sizes, at 3 bits/cell, minus 24 B/frame overhead:

| wedge size (outer ring) | geometry ≈ | B/frame | × 30 fps |
|---|---|---|---|
| ~51 px arc (this experiment) | 34 × 128 | 1 536 | 45 KB/s |
| ~25 px arc | 68 × 256 | ~6 200 | ~185 KB/s |
| ~17 px arc (libcimbar-ish density) | 100 × 384 | ~14 000 | ~420 KB/s |

For scale: the QR path's 2×2 grid preset is 169 KB/s raw today, camera-proven
end-to-end. The kaleidoscope only *wins* at the denser rows — which are exactly the
rows where the unsolved camera problems live.

## Camera path — measured, not assumed

`kaleido/locate.ts` + `kaleido/camera.ts` close the loop that used to be open. The
decoder no longer samples the coordinates it drew to: it finds the mandala by image
moments, fits an ellipse, takes the outer rim from the projected-extent histogram, and
recovers rotation from the sync marker's angular centroid. `camera.ts` then degrades a
frame the way a phone does — perspective placement, 4:2:0 chroma subsampling, optical
blur, sensor noise — before the decoder sees it.

| condition | result |
|---|---|
| pristine pixels, locator path | 128 KB verified ✓, 0 corrupt |
| simulated phone, **square on** (rotation, blur, 4:2:0) | **128 KB verified ✓**, 76 corrupt of ~1050, fountain absorbed them |
| 4:2:0 chroma on vs off, square on | 6/6 vs 6/6 — **no measurable difference** |
| tilt: far edge 3% shorter | 2/6 frames |
| tilt: beyond that | 0/6 |

Two findings worth stating plainly.

**Chroma subsampling is not the blocker.** It was the gap flagged as structural rather
than solvable, because the QR path is luma-only and immune. At 26×64 wedges it costs
nothing measurable. That does not clear it at higher densities — it is exactly the
constraint that will bind when wedges shrink toward the ceiling table above — but the
current geometry is nowhere near it.

**Perspective is the blocker, and it bites immediately.** Moments fit an *affine*
model, which handles rotation, scale and translation exactly and cheaply. A true
homography maps concentric circles to *non-concentric* ellipses, so the assumption that
one ellipse plus a radius fraction locates every ring fails as soon as the view is off
square. A barely perceptible tilt is enough.

The fix is a proper conic fit (5-parameter ellipse) on two known rings, solving for the
homography from the concentric-circle constraint, rather than a single moment-derived
ellipse. That is real work, and it is the honest form of the "geometry recovery" gap
this document already listed first.

## Remaining gaps

1. **Perspective / homography.** As above. The one thing standing between the current
   state and a handheld phone.
2. **Rolling shutter × rotation.** The design rotates in whole-sector jumps rather than
   continuously, so mid-exposure smear should resemble the QR path's frame-transition
   problem rather than being worse. Unverified.
3. **Display/camera colour transfer.** Gamut, white balance, auto-exposure clipping the
   white wedges. The per-frame calibration ring exists for this and reconstructed the
   palette exactly under simulation, but a sunlit phone screen is a different question.
4. **In-frame FEC.** One misread wedge still kills a whole frame via FNV discard. The
   simulated camera produced 76 such frames in a successful run; a real one will produce
   more, and Reed-Solomon inside the frame would make those degrade gracefully instead
   of binarily.
5. **Chroma at density.** Not binding now; will bind as wedges shrink.

## Verdict & next steps

The architecture holds: symbology is a plug-in, and a data stream can genuinely be an
art object. As a *transport*, QR + grids remains far ahead on robustness per unit of
engineering. Worth doing next, in order: (a) worker-offloaded decode + band reads so
2160@30 holds on real hardware; (b) an RS-coded frame variant; (c) a single
camera-in-the-loop spike — phone filming the mandala at 1080p — to measure real
symbol error rates before any further density work. If (c) survives, this graduates
from side quest to Phase 5.
