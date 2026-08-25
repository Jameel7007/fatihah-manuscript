// Text asset pipeline, stage 1 (§3/§17/§18) — CLASSICAL JUSTIFIED LAYOUT (v1.4.1):
// shape the pinned canonical Uthmani text with Amiri Quran via HarfBuzz into FROZEN
// composition VARIANTS, following classical manuscript convention:
//   · line 1: the Basmalah alone, SAME em as the body, right-aligned, filled to the full
//     column width by a single kashida elongation of the sīn joint in بسم (the one
//     uncapped elongation in the piece)
//   · body: āyāt 2–7 flow CONTINUOUSLY with inline āyah markers; lines are broken by a
//     minimum-unevenness DP against the column, then BLOCK-JUSTIFIED edge-to-edge purely
//     by kashida (U+0640 runs) at calligraphically permitted joints
//   · balanced elongation: any single kashida ≤ 1.5 em; slack spreads across 2–3 joints
//     per line (sīn/shīn teeth first, then before-final joints, then the flat bases of
//     ص ض ك); never letter-spacing, never word-gap inflation
//   · no orphan close: the final line carries ≥ 3 words and ends on the āyah-7 marker;
//     if it cannot fill within the elongation caps it stays short and is completed by
//     2–3 small gold rosette fillers; a single word is never stretched across a line
//   · variants: the 8-line block at the preferred em, and — when it fits inside the
//     legal em band under the same rules — the classical Ottoman 7-line block
//   · kashida is a PRESENTATION step applied after text verification; the canonical
//     pinned text is never modified, and stripping U+0640 from the presentation recovers
//     it byte-identically (build/verify-text.mjs checks exactly that, per variant)
//
// Run: npm run build:text  (node build/shape-text.mjs)

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blob as HBBlob, Face, Font, Buffer as HBBuffer, shape } from 'harfbuzzjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// §3 layout constants (world units, sheet long side = 1.0)
const COLUMN_RIGHT = 0.275;
const COLUMN_WIDTH = 0.55;
const EM_DEFAULT = 0.058;
const EM_BAND = [0.052, 0.06];
const PITCH = 0.0875;
const BASELINE0_8 = 0.196; // first baseline when the block has 8 lines; recentered otherwise
const MARK_DELAY_DP = 0.003;
const TATWEEL = 'ـ'; // U+0640

// em-relative metrics (values at em 0.058 match the v1.4 absolutes)
const MARKER_EM = 0.631; // inline āyah marker slot: gap + ∅ + gap
const MARKER_Y_EM = 0.181; // ring center above baseline (half x-height)
const RING_R_EM = 0.1086; // ∅ 0.0126 at em 0.058
const RING_STROKE_EM = 0.0276;
const ROSETTE_R_EM = 0.1;

// balanced-elongation rules (§3 v1.4.1)
const KASHIDA_CAP_EM = 1.5; // hard cap per joint (basmalah sīn excepted)
const SPREAD_EM = 0.9; // above this much slack per joint, prefer opening another joint
const MAX_JOINTS = 3;
const MIN_LAST_WORDS = 3;

const canon = JSON.parse(readFileSync(join(root, 'build/canonical-fatihah.json'), 'utf8'));
if (!Array.isArray(canon.ayahs) || canon.ayahs.length < 7) throw new Error('run build/verify-text.mjs first');

const fontData = readFileSync(join(root, 'assets/fonts/AmiriQuran-Regular.ttf'));
const face = new Face(new HBBlob(fontData));
const font = new Font(face);
const upem = face.upem;
font.setScale(upem, upem);

// Font-unit bookkeeping: shaped widths are em-INDEPENDENT (upem scale); only the column
// target depends on em: targetU(em) = COLUMN_WIDTH / em · upem. Marker slots and kashida
// caps are em-proportional in world, hence CONSTANT in font units.
const markerU = MARKER_EM * upem;
const capU = KASHIDA_CAP_EM * upem;
const spreadU = SPREAD_EM * upem;
const targetUof = (em) => (COLUMN_WIDTH / em) * upem;

/** Shape a text run; glyph positions accumulate from pen 0 (font units). */
function shapeRun(text) {
  const buf = new HBBuffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  shape(font, buf);
  const glyphs = buf.getGlyphInfosAndPositions();
  let pen = 0;
  const out = [];
  for (const g of glyphs) {
    out.push({ gid: g.codepoint, cluster: g.cluster, x: pen + (g.xOffset ?? 0), y: g.yOffset ?? 0, adv: g.xAdvance ?? 0 });
    pen += g.xAdvance ?? 0;
  }
  buf.destroy?.();
  return { glyphs: out, width: pen };
}

const tatweelAdv = shapeRun('بـب').width - shapeRun('بب').width;
if (tatweelAdv <= 0) throw new Error('tatweel advance measured non-positive');
const capCount = Math.max(1, Math.floor(capU / tatweelAdv));

// ---- kashida joints ---------------------------------------------------------------------
const MARKS = /[ً-ٰٟۖ-ۭؐ-ؚ࣓-ࣿ]/;
const FWD_JOIN = new Set([...'بتثجحخسشصضطظعغفقكلمنهيئىـ']);
const SIN_SHIN = new Set([...'سش']); // teeth — first choice
const FLAT_BASE = new Set([...'صضك']); // flat bases — third choice
const NO_JOIN_AFTER_LAM = new Set([...'اأإآٱ']);

/** Candidate kashida joints of a segment text: {insertAt, priority, word}.
 *  Priorities: sīn/shīn teeth 3 · before-final joint 2.5 · flat base of ص ض ك 2 · other 1. */
function findJoints(text, { sinOnlyFirstWord = false } = {}) {
  const words = [];
  {
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i === text.length || text[i] === ' ') {
        if (i > start) words.push({ start, end: i });
        start = i + 1;
      }
    }
  }
  const joints = [];
  const MARKS_G = new RegExp(MARKS.source, 'g');
  for (let w = 0; w < words.length; w++) {
    const { start, end } = words[w];
    const wordText = text.slice(start, end);
    // never stretch inside the Allah ligature — test the BARE letters (diacritics sit
    // between ل ل ه in the vocalized text, so a plain substring test misses it)
    if (wordText.replace(MARKS_G, '').replaceAll(TATWEEL, '').includes('لله')) continue;
    const bases = [];
    for (let i = start; i < end; i++) {
      const ch = text[i];
      if (!MARKS.test(ch) && ch !== TATWEEL) bases.push(i);
    }
    for (let b = 0; b + 1 < bases.length; b++) {
      const iA = bases[b];
      const iB = bases[b + 1];
      const a = text[iA];
      const c = text[iB];
      if (!FWD_JOIN.has(a)) continue;
      if (a === 'ل' && NO_JOIN_AFTER_LAM.has(c)) continue; // lam-alif ligature
      if (sinOnlyFirstWord && (w !== 0 || !SIN_SHIN.has(a))) continue;
      const beforeFinal = b + 1 === bases.length - 1;
      const priority = SIN_SHIN.has(a) ? 3 : beforeFinal ? 2.5 : FLAT_BASE.has(a) ? 2 : 1;
      joints.push({ insertAt: iB, priority, word: w });
    }
  }
  return joints.sort((a, b) => b.priority - a.priority || b.insertAt - a.insertAt);
}

/** Insert kashida runs into a segment: alloc = [{insertAt, count}]. */
function withKashida(text, alloc) {
  let out = text;
  for (const { insertAt, count } of [...alloc].sort((a, b) => b.insertAt - a.insertAt)) {
    if (count > 0) out = out.slice(0, insertAt) + TATWEEL.repeat(count) + out.slice(insertAt);
  }
  return out;
}

/** Justify a line's SEGMENT TEXTS to targetSegsU font units (markers excluded by caller).
 *  Balanced elongation: slack spread over up to MAX_JOINTS joints in distinct words,
 *  ≤ KASHIDA_CAP_EM each; iterates real reshapes — Amiri's contextual kashida forms make
 *  the advance non-linear in the run length. The basmalah is the single-sīn exception. */
function justifyLine(segments, targetSegsU, { sinOnlyFirstWord = false } = {}) {
  const naturalSegsU = segments.reduce((a, s2) => a + s2.width, 0);
  const needed = targetSegsU - naturalSegsU;
  const noop = { texts: segments.map((s2) => s2.text), alloc: [] };
  if (needed < tatweelAdv / 2) return noop;
  const all = [];
  segments.forEach((s2, si) => {
    for (const j of findJoints(s2.text, { sinOnlyFirstWord: sinOnlyFirstWord && si === 0 })) all.push({ ...j, si });
  });
  if (all.length === 0) return noop;

  let picks;
  if (sinOnlyFirstWord) {
    picks = [{ joint: all[0], count: Math.max(1, Math.round(needed / tatweelAdv)), cap: Infinity }];
  } else {
    const nJ = Math.max(
      Math.ceil(needed / capU), // respect the per-joint cap
      needed > 2 * spreadU ? 3 : needed > spreadU ? 2 : 1, // aesthetic spread
    );
    const n = Math.min(MAX_JOINTS, all.length, Math.max(1, nJ));
    picks = [];
    const remaining = [...all];
    while (picks.length < n && remaining.length) {
      // prefer joints in words not yet elongated, then priority (list is priority-sorted)
      const usedWords = new Set(picks.map((p) => `${p.joint.si}:${p.joint.word}`));
      const idx = remaining.findIndex((j) => !usedWords.has(`${j.si}:${j.word}`));
      const j = remaining.splice(idx >= 0 ? idx : 0, 1)[0];
      picks.push({ joint: j, count: 0, cap: capCount });
    }
    const even = Math.max(1, Math.round(needed / picks.length / tatweelAdv));
    for (const p of picks) p.count = Math.min(p.cap, even);
  }

  const texts = () =>
    segments.map((s2, si) =>
      withKashida(s2.text, picks.filter((p) => p.joint.si === si).map((p) => ({ insertAt: p.joint.insertAt, count: p.count }))),
    );
  const measure = (ts) => ts.reduce((acc, t) => acc + shapeRun(t).width, 0);
  let best = texts();
  let bestErr = Math.abs(measure(best) - targetSegsU);
  let bestPicks = picks.map((p) => ({ ...p }));
  for (let it = 0; it < 24; it++) {
    const err = measure(texts()) - targetSegsU;
    if (Math.abs(err) <= tatweelAdv / 3) break;
    if (err > 0) {
      // too wide — shorten the longest run (lowest priority on ties)
      const cand = picks.filter((p) => p.count > 0).sort((a, b) => b.count - a.count || a.joint.priority - b.joint.priority)[0];
      if (!cand) break;
      cand.count--;
    } else {
      // too narrow — lengthen the shortest run with headroom (highest priority on ties)
      const cand = picks.filter((p) => p.count < p.cap).sort((a, b) => a.count - b.count || b.joint.priority - a.joint.priority)[0];
      if (!cand) break; // capacity saturated
      cand.count++;
    }
    const t = texts();
    const e = Math.abs(measure(t) - targetSegsU);
    if (e < bestErr) {
      best = t;
      bestErr = e;
      bestPicks = picks.map((p) => ({ ...p }));
    }
  }
  return { texts: best, alloc: bestPicks.filter((p) => p.count > 0).map((p) => ({ si: p.joint.si, word: p.joint.word, count: p.count, em: +((p.count * tatweelAdv) / upem).toFixed(2) })) };
}

// ---- tokenize the canonical text into words + inline markers ---------------------------
const tokens = [];
for (let ay = 1; ay <= 7; ay++) {
  const words = canon.ayahs[ay - 1].split(' ').filter(Boolean);
  for (const w of words) tokens.push({ type: 'word', text: w });
  tokens.push({ type: 'marker', ayah: ay });
}
const basmalahTokens = [];
while (tokens.length && !(tokens[0].type === 'marker')) basmalahTokens.push(tokens.shift());
const basmalahMarker = tokens.shift(); // marker for āyah 1 ends line 1

// glue each āyah's marker to its final word — a marker must never start a line
const groups = [];
for (let i = 0; i < tokens.length; i++) {
  const t = tokens[i];
  if (t.type === 'word' && tokens[i + 1]?.type === 'marker') {
    groups.push([t, tokens[++i]]);
  } else groups.push([t]);
}
const G = groups.length;

/** Exact measure of a token line (segments split at markers shape independently —
 *  Arabic never joins across a space or a marker). Memoized on the group range. */
const natCache = new Map();
function lineNatural(i, j) {
  const key = `${i}:${j}`;
  if (natCache.has(key)) return natCache.get(key);
  const toks = groups.slice(i, j).flat();
  const segments = [];
  let cur = [];
  let markers = 0;
  let words = 0;
  for (const t of toks) {
    if (t.type === 'marker') {
      if (cur.length) segments.push(cur.join(' '));
      cur = [];
      markers++;
    } else {
      cur.push(t.text);
      words++;
    }
  }
  if (cur.length) segments.push(cur.join(' '));
  const segs = segments.map((text) => ({ text, width: shapeRun(text).width }));
  const width = segs.reduce((a, s2) => a + s2.width, 0) + markers * markerU;
  const joints = segments.reduce((a, t) => a + findJoints(t).length, 0);
  const out = { segs, markers, width, words, joints };
  natCache.set(key, out);
  return out;
}

// ---- minimum-unevenness line breaking (DP over exactly nBody lines) ---------------------
// modes: 'A' = the final line must FILL within the elongation caps (true rectangle);
//        'B' = the final line may stay short (≥ MIN_LAST_WORDS) and takes rosette fillers.
function breakBody(nBody, em, mode) {
  const targetU = targetUof(em);
  const lineCost = (i, j, isLast) => {
    const nat = lineNatural(i, j);
    const s = targetU - nat.width;
    if (s < -tatweelAdv / 2) return null; // overfull — kashida cannot compress
    const capacity = Math.min(MAX_JOINTS, nat.joints) * capU;
    if (isLast) {
      if (nat.words < MIN_LAST_WORDS) return null; // no orphan close
      if (mode === 'A') {
        if (s > tatweelAdv / 2 && (nat.words < 2 || s > capacity)) return null;
        return (s / upem) ** 2;
      }
      return 4 + 0.25 * (s / upem) ** 2; // rosette close — prefer fuller
    }
    if (s > tatweelAdv / 2 && (nat.words < 2 || s > capacity)) return null; // never stretch a single word
    return (s / upem) ** 2;
  };
  const INF = Infinity;
  const dp = Array.from({ length: nBody + 1 }, () => new Array(G + 1).fill(INF));
  const at = Array.from({ length: nBody + 1 }, () => new Array(G + 1).fill(-1));
  dp[0][0] = 0;
  for (let k = 1; k <= nBody; k++) {
    for (let j = 1; j <= G; j++) {
      for (let i = k - 1; i < j; i++) {
        if (dp[k - 1][i] === INF) continue;
        const isLast = k === nBody && j === G;
        if (k === nBody && j !== G) continue;
        const c = lineCost(i, j, isLast);
        if (c === null) continue;
        const v = dp[k - 1][i] + c;
        if (v < dp[k][j]) {
          dp[k][j] = v;
          at[k][j] = i;
        }
      }
    }
  }
  if (dp[nBody][G] === INF) return null;
  const breaks = [];
  let j = G;
  for (let k = nBody; k >= 1; k--) {
    const i = at[k][j];
    breaks.unshift([i, j]);
    j = i;
  }
  return { breaks, cost: dp[nBody][G] };
}

// ---- variant search ---------------------------------------------------------------------
const emGrid = [];
for (let e = EM_BAND[1]; e >= EM_BAND[0] - 1e-9; e -= 0.0005) emGrid.push(+e.toFixed(4));

function solveVariant(nLines) {
  const nBody = nLines - 1;
  if (nLines === 8) {
    // preferred em first, then downward through the band (user lever order), then upward
    const order = [
      EM_DEFAULT,
      ...emGrid.filter((e) => e < EM_DEFAULT).sort((a, b) => b - a),
      ...emGrid.filter((e) => e > EM_DEFAULT).sort((a, b) => a - b),
    ];
    for (const em of order) {
      const r = breakBody(nBody, em, 'A');
      if (r) return { em, mode: 'A', ...r };
    }
    const rB = breakBody(nBody, EM_DEFAULT, 'B');
    if (rB) return { em: EM_DEFAULT, mode: 'B', ...rB };
    return null;
  }
  // 7-line: the largest hand in the band that closes as a true rectangle; rosette close
  // is accepted only if no em fills, still within the caps
  for (const em of emGrid) {
    const r = breakBody(nBody, em, 'A');
    if (r) return { em, mode: 'A', ...r };
  }
  for (const em of emGrid) {
    const r = breakBody(nBody, em, 'B');
    if (r) return { em, mode: 'B', ...r };
  }
  return null;
}

// ---- layout + justification + glyph placement -------------------------------------------
const pathCache = new Map();
const glyphPath = (gid) => {
  if (!pathCache.has(gid)) pathCache.set(gid, font.glyphToPath(gid));
  return pathCache.get(gid);
};
const extCache = new Map();
const glyphExt = (gid) => {
  if (!extCache.has(gid)) extCache.set(gid, font.glyphExtents(gid) ?? { xBearing: 0, yBearing: 0, width: 0, height: 0 });
  return extCache.get(gid);
};

function composeVariant(solution, nLines) {
  const { em, mode, breaks } = solution;
  const s = em / upem;
  const U2Wv = (u) => u * s;
  const targetU = targetUof(em);
  const markerW = MARKER_EM * em;
  const baseline0 = BASELINE0_8 + ((8 - nLines) * PITCH) / 2;

  const lineDefs = [
    { toks: [...basmalahTokens, basmalahMarker], basmalah: true },
    ...breaks.map(([i, j]) => ({ toks: groups.slice(i, j).flat(), basmalah: false, range: [i, j] })),
  ];
  const outLines = [];
  let globalOrder = 0;

  for (let li = 0; li < lineDefs.length; li++) {
    const { toks, basmalah, range } = lineDefs[li];
    const baseline = baseline0 + li * PITCH;
    const isLast = li === lineDefs.length - 1;
    // natural measure (basmalah is not in the DP cache)
    let nat;
    if (basmalah) {
      const segText = basmalahTokens.map((t) => t.text).join(' ');
      const run = shapeRun(segText);
      nat = { segs: [{ text: segText, width: run.width }], markers: 1, width: run.width + markerU, words: basmalahTokens.length, joints: 1 };
    } else nat = lineNatural(range[0], range[1]);

    const rosetteClose = isLast && !basmalah && mode === 'B';
    const justify = !rosetteClose && targetU - nat.width > tatweelAdv / 2;
    const jres = justify
      ? justifyLine(nat.segs, targetU - nat.markers * markerU, { sinOnlyFirstWord: basmalah })
      : { texts: nat.segs.map((s2) => s2.text), alloc: [] };
    const segTexts = jres.texts;
    const segShaped = segTexts.map((t) => ({ text: t, run: shapeRun(t) }));
    const lineWidthU = segShaped.reduce((a, s2) => a + s2.run.width, 0) + nat.markers * markerU;

    // place segments right → left (RTL flow): first segment at the RIGHT edge
    const rightEdgeU = COLUMN_RIGHT / s; // font units at this em
    const markers = [];
    const glyphItems = [];
    let cursorRight = rightEdgeU;
    let segIdx = 0;
    let wordBase = 0;
    const tokenGroups = [];
    {
      let curWords = 0;
      for (const t of toks) {
        if (t.type === 'marker') {
          tokenGroups.push({ type: 'seg', idx: segIdx++, words: curWords });
          tokenGroups.push({ type: 'marker', ayah: t.ayah });
          curWords = 0;
        } else curWords++;
      }
      if (curWords) tokenGroups.push({ type: 'seg', idx: segIdx++, words: curWords });
    }
    for (const grp of tokenGroups) {
      if (grp.type === 'seg') {
        const seg = segShaped[grp.idx];
        if (!seg || !seg.text.length) continue;
        const segLeftU = cursorRight - seg.run.width;
        const wt = new Array(seg.text.length).fill(0);
        {
          let w = 0;
          for (let i = 0; i < seg.text.length; i++) {
            if (seg.text[i] === ' ') {
              wt[i] = -1;
              w++;
            } else wt[i] = w;
          }
        }
        for (const g of seg.run.glyphs) {
          const path = glyphPath(g.gid);
          if (path === '') continue;
          const ext = glyphExt(g.gid);
          const srcChar = seg.text[g.cluster] ?? '';
          glyphItems.push({
            gid: g.gid,
            word: wordBase + (wt[g.cluster] ?? 0),
            kind: g.adv === 0 ? 'mark' : 'base', // tatweel strokes are bases — part of the pen line
            kashida: srcChar === TATWEEL,
            x: U2Wv(segLeftU + g.x),
            y: baseline - g.y * s,
            scale: s,
            ext: { x: ext.xBearing * s, y: -ext.yBearing * s, w: ext.width * s, h: -ext.height * s },
            penX: U2Wv(segLeftU + g.x),
          });
        }
        cursorRight = segLeftU;
        wordBase += grp.words;
      } else {
        const cx = U2Wv(cursorRight) - markerW / 2;
        markers.push({ x: cx, y: baseline - MARKER_Y_EM * em, ayah: grp.ayah });
        cursorRight -= markerW / s;
      }
    }

    // rosette fillers complete a short closing line (classical, see §3)
    let fillers;
    if (rosetteClose) {
      const gapW = U2Wv(targetU - lineWidthU);
      if (gapW > markerW) {
        const n = gapW > 3 * markerW ? 3 : 2;
        const left = COLUMN_RIGHT - COLUMN_WIDTH;
        fillers = Array.from({ length: n }, (_, i) => ({
          x: left + ((i + 0.5) / n) * gapW,
          y: baseline - MARKER_Y_EM * em,
          r: ROSETTE_R_EM * em,
          kind: 'rosette',
        }));
      }
    }

    // §17 writing order: per word RTL (descending pen-x), bases then marks
    const wordCount = wordBase;
    for (let w = 0; w < wordCount; w++) {
      const bases = glyphItems.filter((g) => g.word === w && g.kind === 'base').sort((a, b) => b.penX - a.penX);
      const marks = glyphItems.filter((g) => g.word === w && g.kind === 'mark').sort((a, b) => b.penX - a.penX || a.y - b.y);
      for (const g of bases) {
        g.order = globalOrder++;
        g.delay = 0;
      }
      for (const g of marks) {
        g.order = globalOrder++;
        g.delay = MARK_DELAY_DP;
      }
    }

    outLines.push({
      line: li,
      basmalah,
      ayahs: [...new Set(markers.map((m) => m.ayah))],
      baseline,
      em,
      widthWorld: U2Wv(lineWidthU),
      justified: justify || (!rosetteClose && Math.abs(targetU - lineWidthU) <= tatweelAdv / 2),
      kashidaAlloc: jres.alloc.length ? jres.alloc : undefined,
      fillers,
      presentation: segTexts,
      markers,
      glyphs: glyphItems.map((g) => ({
        gid: g.gid,
        word: g.word,
        kind: g.kind,
        kashida: g.kashida || undefined,
        order: g.order,
        delay: g.delay,
        x: +g.x.toFixed(6),
        y: +g.y.toFixed(6),
        scale: +g.scale.toFixed(8),
        ext: g.ext,
        path: glyphPath(g.gid),
      })),
    });
  }
  return { em, mode, lines: outLines };
}

// ---- outputs ----------------------------------------------------------------------------
const rosettePath = (cx, cy, r, K) => {
  // 8-petal gold rosette: round-capped petal strokes + center dot
  let p = `<g stroke="#8F7440" stroke-width="${(r * 0.34 * K).toFixed(2)}" stroke-linecap="round">`;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * r * 0.42;
    const y1 = cy + Math.sin(a) * r * 0.42;
    const x2 = cx + Math.cos(a) * r;
    const y2 = cy + Math.sin(a) * r;
    p += `<line x1="${(x1 * K).toFixed(2)}" y1="${(y1 * K).toFixed(2)}" x2="${(x2 * K).toFixed(2)}" y2="${(y2 * K).toFixed(2)}"/>`;
  }
  p += `</g><circle cx="${(cx * K).toFixed(2)}" cy="${(cy * K).toFixed(2)}" r="${(r * 0.24 * K).toFixed(2)}" fill="#8F7440"/>`;
  return p;
};

function writeVariant(tag, composed) {
  const K = 1000;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-0.39 * K} 0 ${0.78 * K} ${1 * K}">\n`;
  svg += `<rect x="${-0.39 * K}" y="0" width="${0.78 * K}" height="${K}" fill="#E6D5AF"/>\n`;
  for (const l of composed.lines) {
    for (const g of l.glyphs) {
      svg += `<path transform="translate(${(g.x * K).toFixed(3)} ${(g.y * K).toFixed(3)}) scale(${(g.scale * K).toFixed(6)} ${(-g.scale * K).toFixed(6)})" d="${g.path}" fill="#2A211B"/>\n`;
    }
    for (const m of l.markers) {
      svg += `<circle cx="${(m.x * K).toFixed(2)}" cy="${(m.y * K).toFixed(2)}" r="${(RING_R_EM * composed.em * K).toFixed(2)}" fill="none" stroke="#8F7440" stroke-width="${(RING_STROKE_EM * composed.em * K).toFixed(2)}"/>\n`;
    }
    for (const f of l.fillers ?? []) svg += rosettePath(f.x, f.y, f.r, K) + '\n';
  }
  svg += `</svg>\n`;

  const svgHash = createHash('sha256').update(svg).digest('hex');
  const fontHash = createHash('sha256').update(fontData).digest('hex');
  const nGlyphs = composed.lines.reduce((n, l) => n + l.glyphs.length, 0);

  writeFileSync(join(root, `public/text/composition-${tag}.svg`), svg);
  writeFileSync(
    join(root, `public/text/composition-${tag}.json`),
    JSON.stringify(
      {
        source: 'Amiri Quran (SIL OFL 1.1) shaped via HarfBuzz — FROZEN; consumers verify checksums',
        layout: `classical justified (v1.4.1) · ${composed.lines.length}-line block · em ${composed.em} · close: ${composed.mode === 'A' ? 'justified (true rectangle)' : 'short + rosette fillers'}`,
        variant: tag,
        checksums: { svg: svgHash, font: fontHash },
        em: composed.em,
        lines: composed.lines,
      },
      null,
      1,
    ),
  );
  writeFileSync(
    join(root, `build/stroke-order-${tag}.json`),
    JSON.stringify(
      {
        note: '§17 per-glyph override table. Writing order = shaped glyph sequence per word (RTL), marks +Δp 0.003; kashida strokes are base strokes of their word. Skeleton priors are applied at atlas build (M3).',
        variant: tag,
        checksums: { svg: svgHash, font: fontHash },
        markDelayDp: MARK_DELAY_DP,
        lines: composed.lines.map((l) => ({
          line: l.line,
          ayahs: l.ayahs,
          glyphs: l.glyphs.map((g) => ({ order: g.order, gid: g.gid, word: g.word, kind: g.kind, kashida: g.kashida ?? false, delay: g.delay, skeletonPriors: 'pending-atlas (M3)', handOverride: null })),
        })),
      },
      null,
      1,
    ),
  );
  return { svgHash, fontHash, nGlyphs };
}

mkdirSync(join(root, 'public/text'), { recursive: true });

const results = {};
for (const nLines of [8, 7]) {
  const tag = `${nLines}line`;
  const sol = solveVariant(nLines);
  if (!sol) {
    // report WHY at the friendliest em (band floor gives the most room for 7 lines)
    const em = nLines === 7 ? EM_BAND[0] : EM_DEFAULT;
    const targetU = targetUof(em);
    const total = lineNatural(0, G).width;
    console.log(`\n${tag}: NOT FEASIBLE in the em band under the elongation caps.`);
    console.log(
      ` at em ${em}: body natural ${((total / upem) * em).toFixed(3)} world vs capacity ${(nLines - 1)} lines × ${COLUMN_WIDTH} = ${((nLines - 1) * COLUMN_WIDTH).toFixed(3)}; per-line slack would need ${(((nLines - 1) * targetU - total) / (nLines - 1) / upem).toFixed(2)} em vs cap ${Math.min(MAX_JOINTS, 3) * KASHIDA_CAP_EM} em`,
    );
    results[tag] = null;
    continue;
  }
  const composed = composeVariant(sol, nLines);
  const meta = writeVariant(tag, composed);
  results[tag] = { composed, meta };
  console.log(`\n${tag}: em ${composed.em} · close ${composed.mode === 'A' ? 'justified — true rectangle' : 'short + rosettes'} · ${meta.nGlyphs} glyphs`);
  console.log(` svg sha256 ${meta.svgHash}`);
  for (const l of composed.lines) {
    const kash = l.glyphs.filter((g) => g.kashida).length;
    const allocStr = l.kashidaAlloc ? ` · kashida ${l.kashidaAlloc.map((a) => `${a.em}em`).join('+')}` : '';
    const fillStr = l.fillers ? ` · ${l.fillers.length} rosettes` : '';
    console.log(
      `  line ${l.line}${l.basmalah ? ' (basmalah)' : ''}: width ${l.widthWorld.toFixed(3)}${l.justified ? ' justified' : ' ragged'} · āyāt [${l.ayahs.join(',')}] · ${l.glyphs.length}g/${kash}k${allocStr}${fillStr}`,
    );
  }
}

// active composition = the 8-line block until the user chooses (consumed by the app)
if (results['8line']) {
  copyFileSync(join(root, 'public/text/composition-8line.json'), join(root, 'public/text/composition.json'));
  copyFileSync(join(root, 'public/text/composition-8line.svg'), join(root, 'public/text/composition.svg'));
  copyFileSync(join(root, 'build/stroke-order-8line.json'), join(root, 'build/stroke-order.json'));
  console.log('\nactive composition = 8line (pending layout choice)');
}
const fontHash = createHash('sha256').update(fontData).digest('hex');
console.log(`font sha256 ${fontHash}`);
