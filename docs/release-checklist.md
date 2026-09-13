# Completion path

Goal set 2026-09-07: finish M7 and M8 without changing the canonical scripture or silently closing gates.
Current visual direction: v1.6.6, explicitly visually approved 2026-09-09. M0–M6 stay signed off;
M7 and M8 technical gates remain open.

September 12 local finishing pass: visual approval reaffirmed; no further look changes.
Reduced-motion keyboard, target-size, focus and announcement fixes are implemented. Production build,
22 automated tests, 66 DOM/keyboard checks, 17 fallback checks and the 7.092 MB Brotli payload check pass.
Evidence and honest limitations: `build/v166-release-local-2026-09-12.json`.
The saved final 60-second local production smoke stayed T1 (rAF p95 9.3 ms, max 17.6 ms,
no >250 ms stalls), at 850×1454 backing pixels / DPR 2 and moving SS 1→1.5. It is not
an isolated benchmark, named-device pass or GPU/frame-work certification.

1. **Resolve the capture blocker.** Step 1 is not fixed. Keep the original and diagnostic results;
   establish a demonstrated cause/fix and run repeated complete cold-page matrices. No pixel rounding,
   multiple accepted hash variants, HMR frames, or invented hashes.
   September 11: removing both authored relief derivative terms did not fix repeatability;
   experiment removed. Capture now fails explicitly if required ink/glyph loading fails.
   Depth-bias removal also failed and was reverted. Use `/qa/repeat.html?sequence=1&saveDiff=1`
   with the capture sink running to preserve mismatched baseline/repeat PNGs and diagnostic masks.
   Earlier saved-image sequence differs in six poses; raw PNG hashes independently verified.
   Expanded CPU-upload trace subsequently completed 72 cold captures with two differing poses
   despite equal shader and CPU-upload hashes in all 36 pairs. GPU-written data and pipeline/draw
   state remain outside this trace; do not conclude a driver fault. Evidence indexed in the investigation.
2. **Finish M7 performance and loading evidence.** The reporting harness retains all stalls and
   pre-demotion samples; DPR can only stay level or decrease on demotion. The monitor uses an actual
   trailing three-second history. Fourteen tests cover reporting and monitor behavior. Reports include
   separate CPU update/render-submission timing, excluding GPU completion. Runtime fallback now uses
   the 60/60/30 fps playback targets, fixing the synthetic perfect-60-Hz false demotion. Independent
   12/14/27 ms frame-work budgets still need profiling and named-device certification.
   `?perf=30&save=1` measures two cycles (60 s) after assets load. Record actual canvas size, browser,
   OS/device, initial/final tier and SS, per-tier pacing, and foreground validity. rAF pacing is not
   GPU timing. The local M2 Pro is not the specified M1 Air. Required: M1 Air, iPhone 15 Safari T2,
   iPhone 12 Safari T3, 10 Mbps cold poster→live ≤2.2 s, and the §19 thermal/memory/compile checklist.
   The local dev/preview server is not evidence of compressed production delivery or phone WebGPU support.
3. **Visual approval received 2026-09-09.** User: “it's signed off continue.” Current gold and
   scroll presentation approved, reaffirmed September 12. Individual device, flick/storm, content and technical gates remain
   separately verifiable; this does not authorize blessing unreproducible hashes or closing M7.
4. **Regenerate and re-bless only after approval and reproducibility.** Complete 74-frame matrix
   across both backends, two or more fresh loads per frame; update references/poster as authorized.
   Preserve historical evidence. Keep spec, ledger and manifest synchronized.
5. **Finish M8.** Chrome, Edge, Safari and Firefox-WebGL2 checks; renderer-failure static plates;
   reduced-motion/accessibility verification; authoritative SVG checksum and scholarly review of
   the rendered Arabic against a printed muṣḥaf. Confirm hosting/delivery target before publishing.
   Seven-plate fallback implemented September 9: 252,382 B; two cold WebGL2 sources per plate;
   17 local Chrome checks pass. `/qa/fallback.html` reruns desktop/phone-sized navigation and
   startup/capture failure checks. This is not physical touch or cross-browser certification.
   September 12: production fallback checks rerun successfully with saved evidence. The new
   `/qa/accessibility.html?autorun=1&save=1` exercises every reduced-motion pose, keyboard focus,
   modifier/editing guards, 44px targets and quiet announcements at 1440×900, 390×844 and 320×320.
   Its 66 passing local checks do not replace axe or a real screen-reader/touch audit.
6. **Final user sign-off and release.** Do not call the project complete until required evidence
   and approvals are present. Published spec/ledger artifact copies were republished from the repo files on 2026-09-12 (evening); keep them in sync with every further docs change.

September 12 (evening) fresh-eyes review: the approved gold is confirmed unchanged across the
transition on both aspects; only `index.html` changed (page ground #01030D, title without “— dev”,
description, theme-color, favicon) — the canvas and every capture hash are untouched. Decisions
pending from the reviewer: a portrait poster variant (the landscape poster centre-crops on phones and
pops at the crossfade), HUD visibility by default, and whether the /qa pages ship in the bundle.
Engineering: measure the p = 1 idle 2× hold on the M1 Air — boundary-only demotion cannot rescue it.
Evidence: `qa/review/fable-review-2026-09-12-*.png`, `build/v166-review-2026-09-12-fable.json`.

September 13: the reviewer's decisions applied (v1.6.7) — /qa pages out of the bundle (dev/preview
only), HUD hidden by default (`?hud=1`), portrait poster via `<picture>`, and a supersample
governor that sheds the idle 2× pass on overrun without a tier or state change (`?hold=N&save=1`
reports pacing + cap history). Still yours: the M1 Air hold run, named devices, real screen reader,
cross-browser, muṣḥaf review. Evidence: `build/v167-review-2026-09-13-fable.json`.

Useful local commands:

```sh
npm run build
node build/verify-text.mjs
node --test qa/perf.test.mjs qa/tiers.test.mjs qa/assets.test.mjs qa/gpuTrace.test.mjs
node qa/payload.mjs
npm run preview -- --host 127.0.0.1 --port 4521 --strictPort
# In another terminal, enable local evidence saving:
node qa/review/receiver.mjs
```

Known remaining risks: intermittent WebGPU output; native-device performance under spatial SS;
independent CPU/GPU work-budget verification beyond the corrected pacing fallback;
real cold compressed delivery; device memory/thermal behavior; fallback cross-browser/touch QA
and cross-browser/content approval. Meshopt packing remains optional while measured payload fits.
