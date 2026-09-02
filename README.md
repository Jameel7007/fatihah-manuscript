# Al-Fātiḥah 3D Manuscript

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
| Glyph relief mesh (FGLY v2) + build audit | `public/text/glyphs.bin`, `build/glyph-mesh-audit.json` |
| Payload / matrix / silhouette reports | `build/*.json` |

Status at a glance: M0–M6 closed and signed off; M7 (performance & payload) in progress with the
regression matrix complete; the v1.6 universe ground and the v1.6.1 text pass (smooth kashida,
floating block, per-pixel bevel shading, idle supersampling) are built and awaiting sign-off, after
which the whole reference set is re-blessed. Details and dates: the ledger.

## Running it

```bash
npm install
npm run dev -- --port 4521 --strictPort
```

Open <http://localhost:4521>. The scroll is the only control; stop moving for ~4 s and the beauty
pass supersamples at 2× (desktop tiers). `.claude/launch.json` registers the same server for
Claude Code's preview pane.

The QA save sink (review frames and matrix results post to it): `node qa/review/receiver.mjs`.

### URL switches (QA)

| Switch | Effect |
|---|---|
| `?capture=P&tier=N&w=W&h=H` | deterministic frame at scroll `P`, tier `N`, canvas `W×H` at DPR 1; `window.__capture` holds the SHA-256 (`&warm=N` warm-up frames, default 15) |
| `&backend=webgl2` | WebGL2 fallback |
| `&ss=1.5` / `&ss=2` | pin the beauty-pass supersample factor |
| `&noblob` `&noshadow` `&nogeo` `&noink` | isolate the contact blob, the key's shadow, the relief mesh, the ink |
| `&gb=1…6` | grade-chain bypass diagnostics |
| `?perf=N` | scrub p 0→1→0 over N s and report p50/p95/p99 frame times (`window.__perf`) |
| `?hold=N` | pin p = 1 for N s and report luminance drift (`window.__hold`) |
| `?reduced=1` | reduced-motion mode (held compositions, pager) |
| `?calibrate=bg&target=RRGGBB` / `?calibrate=key` | solve the sky floor / key intensity through the live AgX chain |
| `?scene=ramp` `?scene=proof&layout=7` `?scene=inkrt&p=P` `?scene=reveal` | instruments: AgX ramp, text proof, raw ink RT, stroke-order reveal |
| `/qa/matrix.html?backend=webgpu[&only=T1]` | self-driving regression matrix; check with `node qa/matrix.mjs webgpu [T1]` |

## Build pipeline (text → atlases → mesh)

```bash
node build/shape-text.mjs        # composition from the canonical text (harfbuzz, Amiri Quran)
node build/build-ink-atlas.mjs   # MTSDF + stroke-order atlases, write windows
node build/build-glyph-mesh.mjs  # §6 bevel relief mesh (FGLY v2), silhouette audit
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
