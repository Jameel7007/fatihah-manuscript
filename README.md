# Al-Fātiḥah 3D Manuscript

An aged parchment bearing Surah Al-Fātiḥah, floating in a dark environment, transformed by
scroll: rolled → unrolling → ink written → presenting → relief → rising → facing.

Three.js `WebGPURenderer` + TSL node materials, WebGL2 fallback compiled from the same node
graph. Every animation is a pure function of one smoothed scroll uniform `p ∈ [0, 1]` —
scrubbing is deterministic by design.

## Specification

The complete numeric design + engineering spec (v1.1, pre-M0 revision pass) lives at [`docs/spec.html`](docs/spec.html)
(open it in a browser), also published as a private artifact:
<https://claude.ai/code/artifact/1fe75f9f-9779-4526-b424-bac53ba1143f>

The spec is the contract. Key commitments:

- Analytic curl field is the parchment pose; XPBD contributes a residual inertia layer only
  (decays to zero, off in regression capture) — determinism over free simulation.
- Ink is an MTSDF atlas revealed along a stroke-order field; wetness is closed-form in `p`.
- Ink → gold: glyph geometry enters at emboss height with an ink-colored material (no alpha
  fade), then transmutes to aged gold during the staggered per-āyah rise.
- AgX tone mapping, linear pipeline, no bloom pass.
- Contact shadows: PCSS + orthographic height-field blob pass.
- Budgets: ≤ 8.5 MB payload; 60 fps desktop & iPhone 15, 30 fps iPhone 12; three quality tiers.

## Fixed constraints

- Uthmani text, Ḥafṣ ʿan ʿĀṣim, Basmalah counted as āyah 1.
- The supplied calligraphic SVG geometry is **authoritative**: checksum-gated in the asset
  pipeline; never redrawn, reflowed, re-spaced, re-kerned, or detached. Diacritics belong to
  their base forms in every state. If a layout doesn't fit, the layout changes — never the text.

## Build plan

Milestones M0–M8 with definitions of done and visual regression frames are in spec §20.
Module layout (once code lands): `/core`, `/field`, `/ink`, `/glyphs`, `/look`, `/director`,
`/build`, `/qa`.
