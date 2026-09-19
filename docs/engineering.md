# Al-Fātiḥah 3D Manuscript — engineering handbook

The visitor-facing overview is the repository [README](../README.md). This file is the working notes: release
history by date, URL switches, the capture rig, device runs, the headless procedure and the asset pipeline.

September 19 (v1.6.8): the reference gate is tolerance-based for both backends — `node qa/verify-references.mjs --verify`
drives a headless Chromium through the 74-frame matrix against blessed PNGs (`qa/references/frames/`,
manifest `blessed_2026_09_19`; bit-exact passes, else changed ≤ 1 %, median ΔE76 ≤ 1.0, worst 5×5 block ≤ 4.0).
M7/M8 are closed on the owner's authorization with the unmeasured items recorded as waived in the ledger.

September 12 release hardening: keep the approved v1.6.6 look. Reduced-motion controls now have
44px targets, visible keyboard focus, correct focus movement and quiet state announcements.
Local production accessibility checks pass in desktop, phone-sized and compact viewports.
Current release evidence: `build/v166-release-local-2026-09-12.json`; remaining gates:
`docs/release-checklist.md`. M7/M8 stay open; no new reference hashes are blessed.

September 13 (v1.6.7): decisions applied — QA runner pages live in `qa/pages/` and are served at
`/qa/*.html` by the dev and preview servers only (never in `dist/`); the developer HUD is hidden unless
`?hud=1` (or a QA mode); a portrait poster (`public/poster-portrait.jpg`, `<picture>`) opens phones on the
same composition as the first live frame; a supersample governor sheds the idle 2× pass automatically
when frames overrun (`?hold=N&save=1` reports rAF pacing and the cap history). Run the hold on the M1 Air
in a foreground window. Evidence: `build/v167-review-2026-09-13-fable.json`.

September 12 evening review: the approved gold checked frame by frame on desktop and phone
aspects and left unchanged; `index.html` gains the #01030D page ground (was the pre-v1.6 warm void),
a release title, description, theme-color and favicon. Open decisions (portrait poster, HUD, /qa in
the bundle) and the idle-2× hold measurement are in the ledger and checklist; evidence in
`build/v166-review-2026-09-12-fable.json`.

September 11 follow-up: expanded GPU-input trace completed 72 cold captures. Two poses differed
despite matching traced shaders and CPU uploads; GPU-state/driver cause is not established.
Build, 22 tests and 7.092 MB Brotli payload check pass. Step 1 remains open; approved gold unchanged.
Results and saved image pairs: `build/v166-step1-investigation.json`.

Historical QA (2026-09-07): corrected 60-second hold passes at 1.52% drift. The earlier full matrices
gave WebGL2 37/37 repeat-identical and WebGPU 34/37; longer diagnostic sequences confirmed broader
intermittent WebGPU differences. **Step 1 is still open.** See `build/v166-qa-review.json` and
`build/v166-step1-investigation.json`. No hashes are blessed.

M7 reporting now retains slow frames and pre-demotion samples, reports each tier separately, and
invalidates hidden-tab evidence. A demotion never raises DPR. Run the fourteen harness/monitor tests
with `node --test qa/perf.test.mjs qa/tiers.test.mjs`. The release path is in `docs/release-checklist.md`.

Current visual direction: **v1.6.6, visually signed off 2026-09-09**. Clean satin gold removes burnish/wear variation,
uses uniform roughness 0.52 / metalness 0.72, disables anisotropy, and eases to a softer quadratic
shading bevel during gilding. Geometry and canonical text are unchanged. The user explicitly said
“it's signed off continue”: visual approval is recorded, not technical gate closure. Full regression,
physical-device evidence and scholarly/content approval remain pending; no reference is blessed.

Previous candidate v1.6.5: finer T1/T2 geometry (535,935 triangles,
6.75-fu grid, 0.15-fu chord tolerance) and magnitude-preserving crown normals smooth the relief.
The v1.6.4 opaque satin gold and existing supersampling remain. Build, canonical-text verification,
mesh audit and payload check pass (6.866 MB brotli aggregate). Earlier frame results below are
historical; capture stability, full matrix and physical-device checks remain open. Nothing is blessed.

An aged parchment bearing Sūrat al-Fātiḥah, floating in a deep-blue universe, transformed by
scroll: rolled → unrolling → ink written → presenting → relief → rising → facing. At the end the
seven āyāt stand in gilded relief, alone against the stars.

Three.js r185 `WebGPURenderer` + TSL node materials, WebGL2 fallback compiled from the same node
graph. Every animation is a pure function of one smoothed scroll uniform `p ∈ [0, 1]` — scrubbing
is deterministic by design, and every reference frame is a SHA-256 of the raw pixels.

## Where everything lives

| What | Where |
|---|---|
| **Next steps and ready-to-paste prompts** | [`docs/next-steps.md`](docs/next-steps.md) |
| **Specification** (the contract; numeric; revision history Δ at the end) | [`docs/spec.html`](docs/spec.html) — published: <https://claude.ai/code/artifact/1fe75f9f-9779-4526-b424-bac53ba1143f> |
| **Build ledger** (milestones, decision log, QA ledger, what awaits review) | [`docs/status.html`](docs/status.html) — published: <https://claude.ai/code/artifact/9af3f15c-105e-4238-94e4-2b40e1891354> |
| Blessed regression frames (SHA-256, per milestone) + pending candidates | [`qa/references/manifest.json`](qa/references/manifest.json) |
| Review frames sent during sign-off rounds | `qa/review/` |
| **Reference gate** (bless / verify the 74-frame matrix headlessly, tolerance vs blessed PNGs) | [`qa/verify-references.mjs`](qa/verify-references.mjs) — `node qa/verify-references.mjs --verify [--backend webgpu\|webgl2]`; references in `qa/references/frames/`, manifest `blessed_2026_09_19` |
| Frame difference metrics (changed pixels, ΔE76 percentiles, worst 3×3/5×5 block) | [`qa/frame-compare.mjs`](qa/frame-compare.mjs) — `node qa/frame-compare.mjs A.png B.png` or `--pairs` over `qa/review/v166-diff-*` |
| Step 1 (capture repeatability) investigation record | [`build/v166-step1-investigation.json`](build/v166-step1-investigation.json), pair metrics `build/step1-pair-metrics-2026-09-19.jsonl` |
| Text proofs (4000 px, both layout variants) | `qa/proofs/` |
| Canonical text (Tanzil Uthmani, Ḥafṣ ʿan ʿĀṣim) and its verification | `build/canonical-fatihah.json`, `build/text-verification.json` |
| Frozen composition (7-line, the piece) + the 8-line reference | `public/text/composition*.json/.svg` |
| Ink atlases (MTSDF + stroke-order progression), instances | `public/text/ink-*.png`, `public/text/ink-instances.json` |
| Glyph relief meshes (FGLY v2; T1/T2 + reduced T3) + audits | `public/text/glyphs*.bin`, `build/glyph-mesh-audit*.json` |
| Payload / matrix / silhouette reports | `build/*.json` |

Status at a glance: M0–M6 are closed and signed off. v1.6.6 is visually approved (September 9,
reaffirmed September 12). M7/M8 remain open: intermittent WebGPU capture differences, named-device
performance/loading, cross-browser/accessibility and scholarly/content review still need evidence.
Seven-plate renderer-failure fallback is implemented. Historical candidates below are not current
references; no new hashes are blessed. Details and dates: the ledger.

## Page layer and explore mode

`src/director/story.ts` is the DOM layer of words (title, cue, captions, translation, closing card, About); it reads
the same `p` as the canvas and is hidden in capture mode. `src/director/explore.ts` turns the standing gold at the
ending: armed from the closing card only, it drives `uTurnYaw` / `uTurnPitch` on the glyph material (a rigid motion
after the facing pivot); every QA mode leaves both at zero. Layout collisions are checked headless with
`Page.captureScreenshot` clips (see the 2026-09-19 evidence index).

## Running it

```bash
npm install
npm run dev -- --port 4521 --strictPort
```

Open <http://localhost:4521>. The scroll is the only control. As the text becomes 3D, the beauty pass
ramps to 1.5× on T1 and 1.25× on T2; stop moving for ~4 s and T1 eases to 2×. T3 remains at 1× to
protect its 30 fps budget. `.claude/launch.json` registers the same server for
Claude Code's preview pane.

The QA save sink (review frames and matrix results post to it): `node qa/review/receiver.mjs`.

### Device runs over the LAN (M7 named devices)

```bash
node qa/review/receiver.mjs                       # the sink: every saved report lands in qa/review/
FATIHAH_LAN=1 npm run preview -- --port 4522 --strictPort   # HTTPS on every interface (self-signed cert in ~/.fatihah-tls)
```

On the device open `https://<this Mac's LAN IP>:4522/`, accept the certificate warning once (WebGPU needs a
secure context off localhost), then:

| Run | URL | Reads |
|---|---|---|
| idle hold, 60 s | `/?hold=60&save=1` (add `&tier=1` on the M1 Air) | flux drift, rAF pacing vs budget, supersample factor, governor cap + steps |
| playback, 2 × 30 s scrub | `/?perf=30&save=1` | rAF p50/p95/p99/max per tier, demotions, CPU submit time |
| cold load at 10 Mbps | `/` with the browser's network throttle set to 10 Mbps, cache disabled | the console line `[boot] poster → live in N s` (limit 2.2 s) |

Keep the window in the foreground for the whole run — a hidden or occluded tab stops rendering and the
report says so. Generate the cert once with
`openssl req -x509 -newkey rsa:2048 -nodes -keyout ~/.fatihah-tls/key.pem -out ~/.fatihah-tls/cert.pem -days 30 -subj "/CN=fatihah-lan" -addext "subjectAltName=IP:<LAN IP>,DNS:localhost"`.

### Headless repeatability runs (no visible window needed)

Visible browser windows throttle or freeze when occluded and get closed while the Mac is in use. Brave/Chrome
`--headless=new` renders WebGPU over ANGLE Metal at full speed and is driven over the DevTools protocol:

```bash
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --headless=new --no-first-run --enable-unsafe-webgpu --enable-features=WebGPU --use-angle=metal --ignore-gpu-blocklist --window-size=1512,900 --user-data-dir=/tmp/fatihah-hl --remote-debugging-port=9333 "http://localhost:4521/qa/repeat.html?sequence=1&saveDiff=1"
```

Poll `http://localhost:9333/json` for the tab and evaluate `window.__repeatResult` (or `window.__capture`) over the
tab's `webSocketDebuggerUrl` with `Runtime.evaluate`. Reports land in `qa/review/` through the sink as usual.
Headless hashes are their own environment (they do not match the pane's or Safari's) — compare within one environment.
Safari has no headless mode; its runs still need a visible, fronted window.

### URL switches (QA)

| Switch | Effect |
|---|---|
| `?capture=P&tier=N&w=W&h=H` | deterministic frame at scroll `P`, tier `N`, canvas `W×H` at DPR 1; `window.__capture` holds the SHA-256 (`&warm=N` warm-up frames, default 15) |
| `&backend=webgl2` | WebGL2 fallback |
| `&ss=1.5` / `&ss=2` | pin the beauty-pass supersample factor |
| `&showss=1` | append the live supersample factor to the HUD (QA only) |
| `&noblob` `&noshadow` `&nogeo` `&noink` | isolate the contact blob, the key's shadow, the relief mesh, the ink |
| `&gb=1…6` | grade-chain bypass diagnostics |
| `?perf=N[&save=1]` | two N-second scrub cycles, then one full-history rAF-pacing report in `window.__perf`; retains stalls and demotions, flags hidden-tab samples; optional save to the local QA sink. Not GPU timing or device certification. |
| `?hold=N[&save=1]` | pin p = 1 for N s: luminance drift, rAF pacing during the hold, live supersample factor, governor cap + step history, foreground validity (`window.__hold`; `&save=1` posts it) |
| `?hud=1` | show the developer HUD (state · p · idle · demoted); hidden by default for visitors |
| `&post=NAME` (with `?capture`) | save the captured PNG through the same-origin sink as `qa/review/NAME.png` — full-speed captures in any real browser |
| `&repeat=N` (with `?capture`) | Step 1 diagnostic: N captures in one page load, `warm` frames apart; `window.__capture.hashes` |
| `&stall=MS[&stallFrames=K]` (with `?capture`) | Step 1 diagnostic: busy-wait MS ms before each of the first K frames (default 3) to perturb load-time ordering |
| `/qa/repeat.html?sequence=1[&backend=webgl2][&stall=MS][&noblob][&warm=N][&saveDiff=1]` | 36 poses × 2 cold iframe loads; saves a JSON report (and baseline/repeat/mask PNGs for differing poses) through the sink |
| `?scene=inkrt&p=P&capture=1[&rgb=1][&post=NAME]` | ink render-target view; `&rgb=1` shows the raw RGB (B = puff), `&post` saves it through the sink |
| `?reduced=1` | reduced-motion mode (held compositions, pager) |
| `/qa/accessibility.html?autorun=1&save=1` | local DOM/keyboard checks at 1440×900, 390×844 and 320×320; saves evidence to the QA sink; not screen-reader/device certification |
| `/qa/fallback.html?autorun=1&save=1` | static-folio/startup and capture-failure checks, with optional saved evidence |
| `?calibrate=bg&target=RRGGBB` / `?calibrate=key` | solve the sky floor / key intensity through the live AgX chain |
| `?scene=ramp` `?scene=proof&layout=7` `?scene=inkrt&p=P` `?scene=reveal` | instruments: AgX ramp, text proof, raw ink RT, stroke-order reveal |
| `/qa/matrix.html?backend=webgpu[&only=T1]` | self-driving regression matrix; check with `node qa/matrix.mjs webgpu [T1]` (QA pages are served from `qa/pages/` by dev/preview only) |
| `/qa/repeat.html?sequence=1` | two fresh-load 36-pose sequences; raw hash/pixel comparison, never blessing. Optional `&noenv`, `&nomsaa`, `&gpuReadback`, `&traceSources`, or `&gpuTrace` isolates inputs; these are QA diagnostics, not fixes. |

## Build pipeline (text → atlases → mesh)

```bash
node build/shape-text.mjs        # composition from the canonical text (harfbuzz, Amiri Quran)
node build/build-ink-atlas.mjs   # MTSDF + stroke-order atlases, write windows
npm run build:glyphs             # §6 T1 + T3 bevel meshes (FGLY v2), silhouette audits
node build/verify-text.mjs       # every variant recovers the pinned canonical text byte for byte
node qa/payload.mjs              # after `vite build`: per-phase raw/gzip/brotli against §18
```

## Fixed constraints

- ʿUthmānic text, Ḥafṣ ʿan ʿĀṣim, Basmalah counted as āyah 1; the shaping chain is verified
  against the pinned canonical source on every rebuild.
- The composition's outlines are authoritative: the ink atlases and the relief mesh consume the
  identical outlines (§17), so silhouettes agree by construction. Diacritics belong to their base
  forms in every state. If a layout doesn't fit, the layout changes — never the text.
- Milestones close only on the reviewer's sign-off; blessed hashes are reproduced from cold loads
  before they enter the manifest.

### Renderer-failure folio (September 9)

Seven real, unblessed prerendered JPEGs live in `public/fallback/` (252,382 B total).
`src/boot.ts` catches startup failure; `src/fallback.ts` presents the independent swipeable folio.
Use `?fallback=1` to bypass Three, `?failRenderer=1` to test startup rejection, or
`/qa/fallback.html` for local desktop/phone-sized navigation and capture-error checks.
Regenerate with `/qa/plates.html` on a settled host with `node qa/review/receiver.mjs` running,
then `node build/build-fallback-plates.mjs`. Sources require two agreeing cold raw-pixel hashes;
`build/fallback-plates.json` records provenance, not blessed references. M7/M8 remain open.

Capture investigation: `/qa/repeat.html?sequence=1&saveDiff=1` saves the actual baseline/repeat
PNGs and an orange changed-pixel mask for each mismatch (capture sink required). The report
links evidence files; masks are diagnostic only, never blessed captures. Latest findings are
indexed in `build/v166-step1-investigation.json`.
