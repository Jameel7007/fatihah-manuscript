# Mobile smoothness overhaul — plan (2026-10-04)

Owner report after v1.8.0, on a real phone: "it completely spazzes out on mobile, while loading, and goes
crazy" · earlier: "still a little choppy at points" · "at the end the bottom of the Arabic is cut off a bit".

## What was measured

A scripted phone session (`?trace=1`, 393×660 at 3×, CPU ×4, 4 Mbit/s, a swipe during the poster, then
human-paced swipes through the piece with the Safari toolbar sliding 660 ↔ 740 px) recorded every frame.
Headless runs on the Mac GPU, so it shows logic and main-thread problems, not phone GPU load.

| Finding | Evidence |
|---|---|
| The picture **races** when the canvas appears: p jumps 0 → 0.19 in ~150 ms to catch the reader's scroll | trace 3049–3199 ms, Δp up to 0.036 per frame |
| It **races again** when the gold arrives and the limit lifts (0.635 → 0.78 in a few frames) | trace 18.9–19.1 s |
| **Freezes** when the ink and the gold attach: shaders compile on the next frame | 217 ms at attachInk, 183 + 100 ms at attachRelief (CPU ×4) |
| The gold mesh, its shadow and its contact pass are hidden until p 0.69 / 0.70 / 0.722, so they **compile the first time the reader reaches the rise** — mid-transition | `relief.mesh.visible = p >= 0.69`, `castShadow = p >= RISE_START`, `contact.run` from 0.7 |
| Every Safari **toolbar slide resizes** the canvas (786×1320 ↔ 786×1480) and **reframes** the camera | 3 resizes in the session; resize → aspect → extent-fit dolly |
| Almost every modern iPhone is detected as **T2** (desktop-class PCSS 16+25 taps, 1024 shadow, 13-tap contact, dust, residual sim) | `detectTier`: iPhone 12 = 390×844×3² = 2.96 M px ≥ 2.4 M → T2 |
| **Pointer parallax follows the finger**: every touch moves the camera gimbal toward the touch point | `pointermove` → `rig.setPointer` for all pointer types |

## The overhaul

1. **Calm motion.** p never moves faster than a speed limit (phones 0.3 p/s, desktop 0.8 p/s) — a hard
   flick or a lifted asset limit becomes a glide, not a race. At the moment the canvas appears, p snaps to
   the reader's position under the poster crossfade instead of racing to it.
2. **No compile on screen.** The ink sheet, the gold mesh and the new sheet are compiled off-scene
   (`compileAsync` with the live scene's lights) *before* they are swapped in. Then a warm-up renders the
   rise and the ending once, invisibly, inside a normal frame — so the gold's shadow and contact pipelines
   compile while the reader is waiting behind the limit, never at the rise. The gold limit lifts only after
   the warm-up.
3. **A stable viewport on phones.** The canvas is sized to the small viewport (`100svh`) and is never
   resized by the toolbar; the scroll→p denominator uses the large viewport (`100lvh`), so p does not jump
   when the toolbar slides. Rotation still resizes.
4. **A phone render profile.** Phones run the T3 pipeline (5-tap PCF shadow, 256² contact, no dust, no
   residual sim, phone mesh) at a DPR cap of 1.75 — gold, scripture, camera and every composition unchanged.
   `?tier=2` still forces the heavier profile for comparison.
5. **Touch never steers the camera.** Pointer parallax only for mouse and pen.
6. **The ending fits above the closing card** on short phone screens (measured at 393×600/660/760).
7. **Instrumented.** `?trace=1` per-frame trace for the harness; `?hud=1` on the phone shows fps so the
   owner can screenshot what their device does.

Out of scope: the desktop look and feel (approved), the reference frames (capture paths untouched), the
scripture. Verification: the same scripted session must show no Δp > 0.012 per frame, no canvas resize
from the toolbar, and no long frame at attach or at the rise; the reference gate 74/74; then the owner on
the phone.

## Done — v1.8.1 (2026-10-04)

All seven items shipped. Same scripted session, before → after:

| | Before | After |
|---|---|---|
| Largest per-frame step in p (excluding the snap under the crossfade) | 0.050 | 0.010 |
| Shader compiles during scrolling | ink swap, gold swap, gold at the rise | none |
| Long frames (> 45 ms) while the reader is scrolling | several | none (remaining ones are behind the poster or while waiting for an asset) |
| Ending at 393×600 | last line under the closing card | clear of the card and the About button |

Traces: `qa/review/v181-2026-10-04-trace-{before,after}.json`. Toolbar behaviour cannot be reproduced in headless
Chromium (it resizes the whole viewport), so the svh/lvh viewport is verified by construction and on the owner's
phone. Next: the owner's phone, with `?hud=1` if anything still stutters.
