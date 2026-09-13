# Al-Fātiḥah 3D Manuscript

September 12 release hardening: keep the approved v1.6.6 look. Reduced-motion controls now have
44px targets, visible keyboard focus, correct focus movement and quiet state announcements.
Local production accessibility checks pass in desktop, phone-sized and compact viewports.
Current release evidence: `build/v166-release-local-2026-09-12.json`; remaining gates:
`docs/release-checklist.md`. M7/M8 stay open; no new reference hashes are blessed.

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
| **Specification** (the contract; numeric; revision history Δ at the end) | [`docs/spec.html`](docs/spec.html) — published: <https://claude.ai/code/artifact/1fe75f9f-9779-4526-b424-bac53ba1143f> |
| **Build ledger** (milestones, decision log, QA ledger, what awaits review) | [`docs/status.html`](docs/status.html) — published: <https://claude.ai/code/artifact/9af3f15c-105e-4238-94e4-2b40e1891354> |
| Blessed regression frames (SHA-256, per milestone) + pending candidates | [`qa/references/manifest.json`](qa/references/manifest.json) |
| Review frames sent during sign-off rounds | `qa/review/` |
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
| `?hold=N` | pin p = 1 for N s and report luminance drift (`window.__hold`) |
| `?reduced=1` | reduced-motion mode (held compositions, pager) |
| `/qa/accessibility.html?autorun=1&save=1` | local DOM/keyboard checks at 1440×900, 390×844 and 320×320; saves evidence to the QA sink; not screen-reader/device certification |
| `/qa/fallback.html?autorun=1&save=1` | static-folio/startup and capture-failure checks, with optional saved evidence |
| `?calibrate=bg&target=RRGGBB` / `?calibrate=key` | solve the sky floor / key intensity through the live AgX chain |
| `?scene=ramp` `?scene=proof&layout=7` `?scene=inkrt&p=P` `?scene=reveal` | instruments: AgX ramp, text proof, raw ink RT, stroke-order reveal |
| `/qa/matrix.html?backend=webgpu[&only=T1]` | self-driving regression matrix; check with `node qa/matrix.mjs webgpu [T1]` |
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
