# Al-Fātiḥah 3D Manuscript · Next steps and prompts

Written 2026-09-13 · repo `~/Code/fatihah-manuscript` · main = origin/main at `d1fc20c` · v1.6.7 · M0–M6 signed off, M7/M8 open.
Ledger: <https://claude.ai/code/artifact/9af3f15c-105e-4238-94e4-2b40e1891354> · Spec: <https://claude.ai/code/artifact/1fe75f9f-9779-4526-b424-bac53ba1143f>

Standing rules for every prompt: preserve the ʿUthmānic text (Ḥafṣ ʿan ʿĀṣim, Basmalah = āyah 1; change layout, never text). Visual approval never waives technical gates. Never invent hashes, accept multiple hash variants, or bless references without reproduced cold-load evidence and explicit authorization. Keep spec, Δ history, ledger and pending manifest in sync with any behaviour change. Report unverified results honestly. Do not close gates.

---

## 1. Device runs (owner, on the devices)

Start the LAN preview on the M2 Pro first:

```bash
cd ~/Code/fatihah-manuscript && node qa/review/receiver.mjs & FATIHAH_LAN=1 npx vite preview --port 4522
```

- [ ] **M1 Air idle hold** · open `https://192.168.68.114:4522/?hold=60&save=1&tier=1`, accept the self-signed cert, leave the window in front for 65 s.
- [ ] **iPhone 15 playback** · `https://192.168.68.114:4522/?perf=30&save=1` (expect T2).
- [ ] **iPhone 12 playback** · same URL (expect T3).
- [ ] **10 Mbps cold load** · Chrome DevTools throttling on the Air, note `[boot] poster → live` timing from the console.

Prompt afterwards:

> The M1 Air and iPhone runs are done. Read the new reports in qa/review (v167-hold-*.png and v166-perf-*.png JSON), verify each is a valid foreground sample, record them in build/v167-review-2026-09-13-fable.json and docs/status.html, republish the ledger artifact, and tell me whether the idle 2× pass held 60 fps on the Air and whether the governor stepped. Do not change the canvas.

## 2. WebGPU repeatability and cross-browser (AI, on the M2 Pro)

- [ ] Safari WebGPU 72-capture cold-load sequence with `&repeat=N` and `&post=NAME`.
- [ ] Stall-injection test of the per-load-state hypothesis.
- [ ] Brave and Safari WebGL2 fallback pass.
- [ ] Fronted Safari playback run (`?perf=30&save=1`, Safari kept in front).

Prompt:

> Continue the WebGPU repeatability work. Run the Safari WebGPU cold-load capture sequence at the reference p values using the &repeat and &post rig, then the stall-injection experiment for the per-load-state hypothesis. Then do the Brave and Safari WebGL2 pass. Tell me before each step that needs a browser window kept in front. Record everything in the evidence index and ledger. Do not bless or change any reference hash; report what you found and what would be needed to re-bless.

## 3. Aesthetics, Tier A: page layer over the canvas (no hash change)

Decide first: English translation (Saheeh International / Abdel Haleem / none).

- [ ] Title card at the opening, fades on first scroll.
- [ ] Scroll cue, disappears on first scroll.
- [ ] Per-āyah translation appears as the ink is written, then fades.
- [ ] Closing card when the text has risen: āyah count, reading, still moment.
- [ ] Typography and colour matched to the gold; respects reduced motion; screen-reader announcements kept consistent.

Prompt:

> Add the Tier A page layer we discussed: title card, scroll cue, per-āyah translation using [TRANSLATION], and a closing card. HTML/CSS over the canvas only; the canvas render and all reference hashes must stay byte-identical (prove it with a p=0 and p=1 T1 capture before and after). Show me screenshots at the opening, mid-ink, and ending on desktop and 390×844 before committing. Update spec Δ history, ledger and README. Keep the accessibility runner green.

## 4. Aesthetics, Tier B: canvas changes (invalidates references, restarts visual approval)

Pick at most two. Gold material stays as approved (roughness 0.52 / metalness 0.72, no burnish, anisotropy 0).

- [ ] Aged parchment: fibre, warmth, deckled edge.
- [ ] Softer, sparser sky in place of the uniform dot field.
- [ ] Warmer, slowly drifting key light.
- [ ] Opening pose closer, with a hint of the first line.
- [ ] Held ending dwell.

Prompt:

> I want Tier B changes [LIST]. Do not touch the gold material. Before committing anything, produce before/after captures at the seven state boundaries on T1 1440×900 and a 390×844 phone strip, and explain each change and its performance cost. State clearly which reference hashes this invalidates and add them to the pending manifest as unblessed. Wait for my approval before committing.

## 5. Human checks (owner)

- [ ] Muṣḥaf comparison of all seven āyāt against a printed Ḥafṣ copy by a reader.
- [ ] Real VoiceOver (iPhone) or TalkBack session, plus a touch-only scroll session.
- [ ] Hosting decision (GitHub Pages default).

Prompt after the checks:

> The muṣḥaf comparison and the screen-reader session are done: [findings]. Record them in the ledger as human-verified evidence with the date and who checked. If any text issue was found, treat it as a blocker and fix layout only, never the text.

## 6. Re-bless, close out, release (AI, after 2 and any Tier B)

- [ ] Re-bless the reference table from reproduced cold-load captures, all 27 entries preserved.
- [ ] M7 and M8 sign-off entries in the ledger with linked evidence.
- [ ] Release build, deploy, and the release checklist walked in full.

Prompt:

> Repeatability is settled and I authorize re-blessing the references from reproduced cold-load evidence. Re-capture, preserve all 27 historical entries, update the manifest and spec, then walk docs/release-checklist.md end to end, build for production, and deploy to [HOST]. Tell me exactly what M7 and M8 evidence is present and what, if anything, remains open before I sign them off.
