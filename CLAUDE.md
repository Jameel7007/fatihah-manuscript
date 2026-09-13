# Al-Fātiḥah 3D Manuscript — working rules

Read first, in this order: `docs/next-steps.md` (what is next, with prompts), `README.md`, `docs/status.html`
(ledger), `docs/spec.html` (contract, Δ history at the end), `docs/release-checklist.md`.

## Non-negotiable
- Scripture: ʿUthmānic text, Ḥafṣ ʿan ʿĀṣim, Basmalah = āyah 1. Change layout, never text.
- Visual approval never waives technical gates. M0–M6 signed off; M7/M8 OPEN until repeatability and
  device evidence exist. Do not close gates.
- Reference hashes (`qa/references/manifest.json`): never invent, never round pixels, never accept multiple
  variants, never bless without reproduced cold-load evidence AND explicit owner authorization. All 27
  historical entries are preserved.
- The approved v1.6.6 look (clean satin gold: roughness 0.52 / metalness 0.72, no burnish, anisotropy 0) is
  not changed without the owner asking. Explain and show before/after before any significant visual change.
- Keep `docs/spec.html` Δ history, `docs/status.html`, README and the pending manifest in sync with behaviour
  changes; republish the two artifacts after editing them (read the live artifact first).
- Report unverified results honestly; hidden/occluded browser runs are invalid samples.

## How to run
- `npm run dev` (4520) / `npx vite preview --port 4521`; QA pages at `/qa/*.html` (dev and preview only).
- QA sink: `node qa/review/receiver.mjs` on :4599, proxied at `/qa-save`; restart it if posts 502.
- Device runs over the LAN: `FATIHAH_LAN=1 npx vite preview --port 4522` (HTTPS, cert in `~/.fatihah-tls`).
- Rig: `?capture=P&tier=N&w=W&h=H[&post=NAME][&repeat=N]`, `?perf=30&save=1`, `?hold=60&save=1`, `?hud=1`.
- Tests: `node --test qa/perf.test.mjs qa/tiers.test.mjs`.
- Hidden browser panes throttle rAF to ~1 fps and freeze after 5 min; captures and perf/hold runs need a
  fresh, visible, fronted window.
