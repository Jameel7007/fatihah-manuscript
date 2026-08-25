// Text asset pipeline, stage 1 (§3/§17/§18) — CLASSICAL JUSTIFIED LAYOUT (v1.4):
// shape the pinned canonical Uthmani text with Amiri Quran via HarfBuzz into the FROZEN
// composition, following classical manuscript convention:
//   · line 1: the Basmalah alone, SAME em as the body, right-aligned, filled to the full
//     column width by a single kashida elongation of the sīn joint in بسم
//   · body: āyāt 2–7 flow CONTINUOUSLY with inline āyah markers; lines are greedily broken
//     to natural width ≤ column, then BLOCK-JUSTIFIED edge-to-edge purely by kashida
//     (U+0640 runs) at calligraphically permitted joints — one or two long elongations per
//     line, never letter-spacing or word-gap inflation; a short final line stays
//     right-aligned unjustified (classical closing line)
//   · kashida is a PRESENTATION step applied after text verification; the canonical pinned
//     text is never modified, and stripping U+0640 from the presentation recovers it
//     byte-identically (build/verify-text.mjs checks exactly that)
//
// Run: npm run build:text  (node build/shape-text.mjs)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blob as HBBlob, Face, Font, Buffer as HBBuffer, shape } from 'harfbuzzjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// §3 layout constants (world units, sheet long side = 1.0)
const COLUMN_RIGHT = 0.275;
const COLUMN_WIDTH = 0.55;
const EM = 0.058; // full em everywhere — re-breaking replaced the em-shrink fit rule
const PITCH = 0.0875;
const BASELINE0_8 = 0.196; // first baseline when the block has 8 lines; recentered otherwise
const MARK_DELAY_DP = 0.003;
const MARKER_W = 0.0366; // inline āyah marker slot: 0.012 gap + ∅0.0126 + 0.012 gap
const MIN_LAST_LINE = 0.4; // shorter final lines stay unjustified (classical)
const TATWEEL = 'ـ'; // U+0640

const canon = JSON.parse(readFileSync(join(root, 'build/canonical-fatihah.json'), 'utf8'));
if (!Array.isArray(canon.ayahs) || canon.ayahs.length < 7) throw new Error('run build/verify-text.mjs first');

const fontData = readFileSync(join(root, 'assets/fonts/AmiriQuran-Regular.ttf'));
const face = new Face(new HBBlob(fontData));
const font = new Font(face);
const upem = face.upem;
font.setScale(upem, upem);

const W2U = (w) => (w / EM) * upem; // world → font units
const U2W = (u) => (u / upem) * EM;

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

// ---- kashida joints ---------------------------------------------------------------------
const MARKS = /[ً-ٰٟۖ-ۭؐ-ؚ࣓-ࣿ]/;
const FWD_JOIN = new Set([...'بتثجحخسشصضطظعغفقكلمنهيئىـ']);
const SEEN_CLASS = new Set([...'سشصض']);
const NO_JOIN_AFTER_LAM = new Set([...'اأإآٱ']);

/** Candidate kashida joints of a segment text: {insertAt, priority, word}. */
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
  for (let w = 0; w < words.length; w++) {
    const { start, end } = words[w];
    const wordText = text.slice(start, end);
    if (wordText.includes('لله')) continue; // never stretch inside the Allah ligature
    // base letters with their indices
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
      if (sinOnlyFirstWord && (w !== 0 || !SEEN_CLASS.has(a))) continue;
      const priority = SEEN_CLASS.has(a) ? 3 : b + 1 === bases.length - 1 ? 2 : 1;
      joints.push({ insertAt: iB, priority, word: w });
    }
  }
  return joints.sort((a, b) => b.priority - a.priority || b.insertAt - a.insertAt);
}

/** Insert kashida runs into a segment: alloc = [{insertAt, count}], descending insertAt. */
function withKashida(text, alloc) {
  let out = text;
  for (const { insertAt, count } of [...alloc].sort((a, b) => b.insertAt - a.insertAt)) {
    out = out.slice(0, insertAt) + TATWEEL.repeat(count) + out.slice(insertAt);
  }
  return out;
}

/** Justify a line's SEGMENT TEXTS to a total of targetSegsU font units by kashida at ≤2
 *  joints (markers are excluded from the budget by the caller). Iterates real reshapes —
 *  Amiri's contextual kashida forms make the advance non-linear in the run length. */
function justifyLine(segments, targetSegsU, { sinOnlyFirstWord = false } = {}) {
  const naturalSegsU = segments.reduce((a, s2) => a + s2.width, 0);
  const needed = targetSegsU - naturalSegsU;
  if (needed < tatweelAdv / 2) return segments.map((s2) => s2.text);
  const all = [];
  segments.forEach((s2, si) => {
    for (const j of findJoints(s2.text, { sinOnlyFirstWord: sinOnlyFirstWord && si === 0 })) all.push({ ...j, si });
  });
  if (all.length === 0) return segments.map((s2) => s2.text);
  const CAP = sinOnlyFirstWord ? Infinity : Math.max(8, Math.round(W2U(0.16) / tatweelAdv)); // ≤ ~0.16 world per joint
  const picks = [];
  const k1 = Math.max(1, Math.round(needed / tatweelAdv));
  if (k1 <= CAP || all.length === 1) picks.push({ joint: all[0], count: k1 });
  else {
    const second = all.find((j) => j.si !== all[0].si || j.word !== all[0].word) ?? all[1] ?? all[0];
    const kA = Math.min(CAP, Math.ceil(k1 * 0.6));
    picks.push({ joint: all[0], count: kA }, { joint: second, count: Math.max(1, k1 - kA) });
  }
  const texts = () =>
    segments.map((s2, si) =>
      withKashida(s2.text, picks.filter((p) => p.joint.si === si).map((p) => ({ insertAt: p.joint.insertAt, count: p.count }))),
    );
  const measure = (ts) => ts.reduce((acc, t) => acc + shapeRun(t).width, 0);
  let best = texts();
  let bestErr = Math.abs(measure(best) - targetSegsU);
  for (let it = 0; it < 12; it++) {
    const err = measure(texts()) - targetSegsU;
    if (Math.abs(err) <= tatweelAdv / 3) break;
    picks[0].count = Math.max(0, picks[0].count - Math.sign(err)); // 0 = drop the elongation
    const t = texts();
    const e = Math.abs(measure(t) - targetSegsU);
    if (e < bestErr) {
      best = t;
      bestErr = e;
    } else break;
  }
  return best;
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

// ---- greedy line breaking of the body flow ---------------------------------------------
const targetU = W2U(COLUMN_WIDTH);
const markerU = W2U(MARKER_W);

/** measure a token line: segments split at markers, shaped separately (no joins across spaces) */
function lineNatural(toks) {
  const segments = [];
  let cur = [];
  let markers = 0;
  for (const t of toks) {
    if (t.type === 'marker') {
      if (cur.length) segments.push(cur.join(' '));
      cur = [];
      markers++;
    } else cur.push(t.text);
  }
  if (cur.length) segments.push(cur.join(' '));
  const segs = segments.map((text) => ({ text, width: shapeRun(text).width }));
  const width = segs.reduce((a, s) => a + s.width, 0) + markers * markerU;
  return { segs, markers, width };
}

// glue each āyah's marker to its final word — a marker must never start a line
const groups = [];
for (let i = 0; i < tokens.length; i++) {
  const t = tokens[i];
  if (t.type === 'word' && tokens[i + 1]?.type === 'marker') {
    groups.push([t, tokens[++i]]);
  } else groups.push([t]);
}
const bodyLines = [];
{
  let cur = [];
  for (const grp of groups) {
    const trial = [...cur, ...grp];
    if (lineNatural(trial).width > targetU && cur.length) {
      bodyLines.push(cur);
      cur = [...grp];
    } else cur = trial;
  }
  if (cur.length) bodyLines.push(cur);
}

// ---- layout + justification + glyph placement ------------------------------------------
const lineDefs = [{ toks: [...basmalahTokens, basmalahMarker], basmalah: true }, ...bodyLines.map((toks) => ({ toks, basmalah: false }))];
const nLines = lineDefs.length;
const baseline0 = BASELINE0_8 + ((8 - nLines) * PITCH) / 2;

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

const s = EM / upem;
const outLines = [];
let globalOrder = 0;

for (let li = 0; li < lineDefs.length; li++) {
  const { toks, basmalah } = lineDefs[li];
  const baseline = baseline0 + li * PITCH;
  const nat = lineNatural(toks);
  const isLast = li === lineDefs.length - 1;
  const justify = basmalah || !isLast || U2W(nat.width) >= MIN_LAST_LINE;
  // segment-text budget = column width minus the inline marker slots
  const segTexts = justify
    ? justifyLine(nat.segs, targetU - nat.markers * markerU, { sinOnlyFirstWord: basmalah })
    : nat.segs.map((s2) => s2.text);
  const segShaped = segTexts.map((t) => ({ text: t, run: shapeRun(t) }));
  const lineWidthU = segShaped.reduce((a, s2) => a + s2.run.width, 0) + nat.markers * markerU;

  // place segments right → left (RTL flow): first segment at the RIGHT edge
  const rightEdgeU = W2U(COLUMN_RIGHT);
  const startU = rightEdgeU - lineWidthU; // left edge of the whole line
  // walk tokens to interleave segment order and markers (RTL: rightmost first)
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
      if (!seg) continue;
      const segLeftU = cursorRight - seg.run.width;
      // word table for this segment
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
          x: U2W(segLeftU + g.x) ,
          y: baseline - g.y * s,
          scale: s,
          ext: { x: ext.xBearing * s, y: -ext.yBearing * s, w: ext.width * s, h: -ext.height * s },
          penX: U2W(segLeftU + g.x),
        });
      }
      cursorRight = segLeftU;
      wordBase += grp.words;
    } else {
      const cx = U2W(cursorRight - markerU / 2);
      markers.push({ x: cx, y: baseline - 0.0105, ayah: grp.ayah });
      cursorRight -= markerU;
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
    em: EM,
    widthWorld: U2W(lineWidthU),
    justified: justify,
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

// ---- outputs ----------------------------------------------------------------------------
mkdirSync(join(root, 'public/text'), { recursive: true });
const K = 1000;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-0.39 * K} 0 ${0.78 * K} ${1 * K}">\n`;
svg += `<rect x="${-0.39 * K}" y="0" width="${0.78 * K}" height="${K}" fill="#E6D5AF"/>\n`;
for (const l of outLines) {
  for (const g of l.glyphs) {
    svg += `<path transform="translate(${(g.x * K).toFixed(3)} ${(g.y * K).toFixed(3)}) scale(${(g.scale * K).toFixed(6)} ${(-g.scale * K).toFixed(6)})" d="${g.path}" fill="#2A211B"/>\n`;
  }
  for (const m of l.markers) {
    svg += `<circle cx="${(m.x * K).toFixed(2)}" cy="${(m.y * K).toFixed(2)}" r="${0.0063 * K}" fill="none" stroke="#8F7440" stroke-width="${0.0016 * K}"/>\n`;
  }
}
svg += `</svg>\n`;

const svgHash = createHash('sha256').update(svg).digest('hex');
const fontHash = createHash('sha256').update(fontData).digest('hex');

writeFileSync(join(root, 'public/text/composition.svg'), svg);
writeFileSync(
  join(root, 'public/text/composition.json'),
  JSON.stringify(
    {
      source: 'Amiri Quran (SIL OFL 1.1) shaped via HarfBuzz — FROZEN; consumers verify checksums',
      layout: 'classical justified (v1.4): basmalah sīn-kashida line + continuous body flow, kashida block justification',
      checksums: { svg: svgHash, font: fontHash },
      em: EM,
      lines: outLines,
    },
    null,
    1,
  ),
);
writeFileSync(
  join(root, 'build/stroke-order.json'),
  JSON.stringify(
    {
      note: '§17 per-glyph override table. Writing order = shaped glyph sequence per word (RTL), marks +Δp 0.003; kashida strokes are base strokes of their word. Skeleton priors are applied at atlas build (M3).',
      checksums: { svg: svgHash, font: fontHash },
      markDelayDp: MARK_DELAY_DP,
      lines: outLines.map((l) => ({
        line: l.line,
        ayahs: l.ayahs,
        glyphs: l.glyphs.map((g) => ({ order: g.order, gid: g.gid, word: g.word, kind: g.kind, kashida: g.kashida ?? false, delay: g.delay, skeletonPriors: 'pending-atlas (M3)', handOverride: null })),
      })),
    },
    null,
    1,
  ),
);

console.log(`frozen composition (v1.4 justified): ${outLines.length} lines, ${outLines.reduce((n, l) => n + l.glyphs.length, 0)} glyphs, em ${EM}`);
console.log(`svg sha256  ${svgHash}`);
console.log(`font sha256 ${fontHash}`);
for (const l of outLines) {
  const kash = l.glyphs.filter((g) => g.kashida).length;
  console.log(
    ` line ${l.line}${l.basmalah ? ' (basmalah)' : ''}: width ${l.widthWorld.toFixed(3)}${l.justified ? ' (justified)' : ' (ragged, closing)'} · āyāt [${l.ayahs.join(',')}] · ${l.glyphs.length} glyphs · ${kash} kashida`,
  );
}
