# Al-Fātiḥah — rebuild plan (v2)

Written 2026-10-12, after v1.8.3. The owner wants a new version with more animation and higher quality:

- more motion in the writing itself
- a camera that travels more
- transitions between the āyāt
- particles and light

v1 stays live at jameel7007.github.io/fatihah-manuscript until v2 replaces it.

## What v1 taught us

| Lesson | What v2 does differently |
|---|---|
| v1 was built desktop-first and patched for phones afterwards; most of its late bugs were phone bugs (jumps, freezes, toolbar reframing, a squeezed ending). | **Phone-first.** Every shot is framed for a 390 × 660 portrait screen first, then widened for desktop. A phone is the review device at every milestone. |
| Pure scroll-scrubbing makes every visual exactly as smooth as the reader's thumb. A fast flick raced through whole states. | **Scroll picks the scene; time plays it.** Scroll selects a chapter (and stays scrubbable inside long ones), but authored animations — the pen, the transitions, the light — play at their own eased pace once triggered, and finish gracefully if the reader moves on. Nothing ever jumps. |
| Assets and shaders that arrived mid-scroll froze the frame (compiles, uploads). | **A chapter starts only when it is ready.** Each chapter declares its assets; they are downloaded, built and pipeline-compiled (against the real render target) before the chapter can begin. A short, designed intro covers the first load. |
| Quality changed mid-session (tier demotion, DPR changes, resizes) and showed. | **One render profile per device, chosen at boot,** with fixed budgets. Phones never resize on toolbar slides (canvas = 100svh). |
| Instrumentation arrived late. | **Trace and phone harness from day one** (`?trace=1`, scripted phone session, `?hud=1` fps readout). |

## What carries over from v1 (proven, do not redo)

- **The text**: `build/verify-text.mjs` (pinned Tanzil Uthmani, Ḥafṣ ʿan ʿĀṣim, Basmalah = āyah 1, byte-identical check) and `build/shape-text.mjs` → `public/text/composition.json/.svg` (the 7-line centred block, Amiri Quran via HarfBuzz). The scripture never changes; only how it is revealed.
- **The ink**: `build/build-ink-atlas.mjs` → MTSDF atlas, stroke-order progression atlas, per-glyph write windows (`ink-mtsdf.png`, `ink-prog.png`, `ink-instances.json`). This is what makes a pen animation possible: every texel knows when the pen reaches it.
- **The gold**: `build/build-glyph-mesh.mjs` + `build/outline-lib.mjs` → `glyphs.bin` / `glyphs-t3.bin` (bevelled relief meshes sharing the ink outlines), and the approved v1.6.6 material (clean satin gold, roughness 0.52, metalness 0.72, no burnish, anisotropy 0).
- **The world**: the universe sky (`src/look/sky.ts`), the parchment surface field and unroll (`src/field/*`), AgX grade (`src/look/grade.ts`).
- **The words**: Yusuf Ali translation, captions, About text (`src/director/story.ts`, `index.html`).
- **The rules**: never the word "drag" for the scripture; credits "Thomas Mooney (@Jameel7007)".

## The four new things

### 1. Motion in the writing
- **A visible qalam.** A reed pen (small modelled nib, or a point of warm light at the nib) rides the stroke-order field along each word, right to left, lifting between words and dipping between āyāt. Its path comes from the existing progression atlas, so it is always exactly on the letters.
- **Living ink.** A wet bead at the pen tip, the wet sheen trailing and drying (v1's 0.045 trail), small bleed blooms where the pen pauses, diacritics flicked in after each word.
- **The rosette markers bloom** petal by petal at the end of each āyah.
- **Pace**: each āyah writes over an authored duration (≈ 3–6 s), triggered by scroll; scrolling faster plays it faster up to a limit, never skips it.

### 2. A camera that travels
A shot list instead of one curve:
1. **Opening** — a slow push in on the rolled parchment in the dark, a pass along the roll's edge as it opens.
2. **Writing** — the camera follows the pen: a close, low oblique shot that tracks along each line right to left, with a gentle pull-back at each line break.
3. **Between āyāt** — a breath: the camera lifts to show the page so far, then settles on the next line.
4. **The rise** — an orbit low across the page as the letters lift, catching their sides in the light.
5. **The ending** — a slow arc to face the standing gold, then the reader's turn (explore) as in v1.
Each shot is authored for portrait first; desktop gets the same moves with wider framing.

### 3. Transitions between the āyāt
Each āyah is a small chapter: the pen finishes, the rosette blooms, a soft light passes along the line just written, the translation appears on its own beat, and the camera breathes to the next line. Seven beats, one rhythm — the piece reads as a recitation, verse by verse.

### 4. Particles and light
- **Gold dust** in the key light, drifting slowly (GPU particles: compute on WebGPU, instanced fallback on WebGL2).
- **Ink motes** lifting from the page where the pen writes; **gold sparks** rising from the letters as they turn to gold.
- **Light shafts** through the dust (cheap screen-space radial light, not volumetrics), a candle-warm key that breathes, and a **specular sweep** — a band of light that travels along the bevels at each āyah's gilding.
- Budgets per device profile; particles are the first thing a phone profile scales down.

## Architecture
- Vite + TypeScript strict, three.js r185+ WebGPU/TSL with the WebGL2 fallback (as v1).
- `Timeline`: chapters with enter/exit, each a set of tweens over authored durations; scroll maps to chapter + (where allowed) progress within it. Deterministic for a given (chapter, time), so frames remain testable.
- `AssetGate`: per-chapter asset list → download → build → pre-compile → ready.
- `Profile`: phone / laptop / desktop budgets decided once at boot (DPR cap, shadow filter, particle counts, post effects).
- `PageLayer`: DOM words designed per breakpoint (portrait phone first), driven by the timeline.
- QA from milestone R0: `?trace=1`, the scripted phone session, `?hud=1`, review frames per chapter at fixed times.

## Milestones (each ends with the owner on a real phone)
| | Scope | Owner review |
|---|---|---|
| R0 | New repo, reuse the asset pipeline, profile + timeline + asset gate skeleton, the dark world and the parchment on a phone at 60 fps | phone: smooth, no jumps, loads cleanly |
| R1 | The opening: camera push-in and unroll with dust in the light | the first 10 seconds |
| R2 | The writing: qalam, living ink, follow camera, rosettes | one āyah end-to-end, then all seven |
| R3 | Āyah transitions: light pass, translation beats, camera breaths | the rhythm of the seven |
| R4 | The rise: orbit, gold sparks, specular sweep | the transmutation |
| R5 | The ending and explore, page layer, About | the finish |
| R6 | Fallbacks, reduced motion, accessibility, performance pass, deploy (replaces v1) | sign-off |

## Prompt for the new session

> Build v2 of the Al-Fātiḥah manuscript as a new project in `~/Code/fatihah-v2` (new public repo `Jameel7007/fatihah-v2`, GitHub Pages deploy on push to main). Read `~/Code/fatihah-manuscript/docs/rebuild-plan.md` first and follow it; v1 (`~/Code/fatihah-manuscript`) stays live and untouched.
>
> Goals, in the owner's words: more motion in the writing itself, a camera that travels more, transitions between the āyāt, particles and light — with higher quality and smooth on a phone.
>
> Non-negotiables: the scripture is ʿUthmānic text, Ḥafṣ ʿan ʿĀṣim, Basmalah = āyah 1, verified byte-identical by v1's `verify-text.mjs` — change how it is revealed, never the text. Reuse v1's text, ink-atlas and glyph-mesh build pipeline and its approved gold material rather than rewriting them. Never use the word "drag" for the scripture. Credits: "Thomas Mooney (@Jameel7007)".
>
> Approach: phone-first (design and test every shot at 390 × 660 portrait); scroll selects chapters and authored animations play at their own pace so nothing ever jumps; a chapter starts only when its assets are downloaded, built and pre-compiled; one render profile per device chosen at boot; trace + scripted phone harness from the first milestone.
>
> Work milestone by milestone (R0 → R6 in the plan). Start with R0 only, and stop at the end of each milestone with screenshots or a short screen recording for the owner to check on their phone before continuing. Keep a short plain-language status page (spec + ledger) in `docs/` as v1 did.
