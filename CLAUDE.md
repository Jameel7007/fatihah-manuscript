# Al-Fātiḥah 3D Manuscript — working rules

Read first, in this order: `docs/next-steps.md` (what is next, with prompts), `docs/engineering.md` (handbook),
`docs/status.html` (ledger), `docs/spec.html` (contract, Δ history at the end), `docs/release-checklist.md`.
`README.md` is the visitor-facing GitHub page — keep it plain-language.

## Non-negotiable
- Scripture: ʿUthmānic text, Ḥafṣ ʿan ʿĀṣim, Basmalah = āyah 1. Change layout, never text.
- Visual approval never waives technical gates. M0–M8 closed (M7/M8 on 2026-09-19 owner authorization; unmeasured
  items are recorded as waived in the ledger and listed in docs/next-steps.md — never describe them as measured).
- Reference gate (owner-authorized 2026-09-19): `node qa/verify-references.mjs --verify` — PNG references in
  `qa/references/frames/`, manifest `blessed_2026_09_19`; bit-exact passes, else tolerance (changed ≤ 1 %,
  median ΔE76 ≤ 1.0, worst 5×5 block ≤ 4.0). Re-bless (`--bless`) only after a visually approved canvas change
  and with the owner's say-so. Never invent a hash or hand-edit references; the 27 historical entries stay.
- The approved v1.6.6 look (clean satin gold: roughness 0.52 / metalness 0.72, no burnish, anisotropy 0) is
  not changed without the owner asking. Explain and show before/after before any significant visual change.
- Keep `docs/spec.html` Δ history, `docs/status.html`, README and the pending manifest in sync with behaviour
  changes; republish the two artifacts after editing them (read the live artifact first).
- Report unverified results honestly; hidden/occluded browser runs are invalid samples.

## How to run
- `npm run dev` (4520) / `npx vite preview --port 4521`; QA pages at `/qa/*.html` (dev and preview only).
- Deploy: push to main → `.github/workflows/pages.yml` → https://jameel7007.github.io/fatihah-manuscript/ (base path via `FATIHAH_BASE`; runtime URLs through `assetUrl()`). The page layer of words is `src/director/story.ts` (DOM only, hidden in capture); explore mode is `src/director/explore.ts` (turn uniforms stay 0 in every QA mode).
- QA sink: `node qa/review/receiver.mjs` on :4599, proxied at `/qa-save`; restart it if posts 502.
- Device runs over the LAN: `FATIHAH_LAN=1 npx vite preview --port 4522` (HTTPS, cert in `~/.fatihah-tls`).
- Rig: `?capture=P&tier=N&w=W&h=H[&post=NAME][&repeat=N]`, `?perf=30&save=1`, `?hold=60&save=1`, `?hud=1`.
- Tests: `node --test qa/perf.test.mjs qa/tiers.test.mjs`.
- Repeatability/perf sequences: run headless (`Brave --headless=new --enable-unsafe-webgpu --use-angle=metal --remote-debugging-port=N`, driven over DevTools `Runtime.evaluate`; see README) — visible windows on the working Mac get occluded or closed. Safari only runs visibly.
- Hidden browser panes throttle rAF to ~1 fps and freeze after 5 min; captures and perf/hold runs need a
  fresh, visible, fronted window.
