// Text asset pipeline, stage 1 (§3/§17/§18): shape the Uthmani text of Al-Fātiḥah with
// Amiri Quran via HarfBuzz into the FROZEN composition — one SVG (checksummed; the artwork
// the whole pipeline treats as authoritative) plus composition.json (per-glyph paths,
// transforms, extents, word/kind classification, and the §17 writing schedule) and
// build/stroke-order.json (the per-glyph override table; skeleton-derived priors are
// applied at atlas build, M3, and are marked pending here).
//
// The text itself is the fixed constraint: Ḥafṣ ʿan ʿĀṣim, Basmalah counted as āyah 1,
// āyah 7 broken after the first عَلَيْهِمْ. Never re-shaped downstream — consumers verify the
// checksum and read this output only.
//
// Run: npm run build:text

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blob as HBBlob, Face, Font, Buffer as HBBuffer, shape } from 'harfbuzzjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// §3 layout constants (world units, sheet long side = 1.0)
const COLUMN_RIGHT = 0.275;
const COLUMN_WIDTH = 0.55;
const EM_BODY = 0.058;
const EM_RANGE = [0.052, 0.06];
const BASMALAH_SCALE = 0.82;
const BASELINE0 = 0.196;
const LINE_PITCH = 0.0875;
const MARK_DELAY_DP = 0.003; // §17 diacritic delay after the word's base group

// Uthmani text — the eight §3 lines (āyah 7 split at its classic break)
const LINES = [
  { ayah: 1, basmalah: true, text: 'بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ' },
  { ayah: 2, text: 'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَـٰلَمِينَ' },
  { ayah: 3, text: 'ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ' },
  { ayah: 4, text: 'مَـٰلِكِ يَوْمِ ٱلدِّينِ' },
  { ayah: 5, text: 'إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ' },
  { ayah: 6, text: 'ٱهْدِنَا ٱلصِّرَٰطَ ٱلْمُسْتَقِيمَ' },
  { ayah: 7, part: 1, text: 'صِرَٰطَ ٱلَّذِينَ أَنْعَمْتَ عَلَيْهِمْ' },
  { ayah: 7, part: 2, text: 'غَيْرِ ٱلْمَغْضُوبِ عَلَيْهِمْ وَلَا ٱلضَّآلِّينَ' },
];

const fontData = readFileSync(join(root, 'assets/fonts/AmiriQuran-Regular.ttf'));
const face = new Face(new HBBlob(fontData));
const font = new Font(face);
const upem = face.upem;
font.setScale(upem, upem);

/** Shape one line; positions accumulated in font units from pen 0. */
function shapeLine(text) {
  const buf = new HBBuffer();
  buf.addText(text);
  buf.guessSegmentProperties(); // detects Arabic + RTL; explicit setters corrupt the state
  shape(font, buf);
  const glyphs = buf.getGlyphInfosAndPositions();
  let pen = 0;
  const out = [];
  for (const g of glyphs) {
    out.push({
      gid: g.codepoint,
      cluster: g.cluster,
      x: pen + (g.xOffset ?? 0),
      y: g.yOffset ?? 0,
      adv: g.xAdvance ?? 0,
    });
    pen += g.xAdvance ?? 0;
  }
  buf.destroy?.();
  return { glyphs: out, width: pen };
}

/** word index per source char offset (split on spaces). */
function wordIndexTable(text) {
  const table = new Array(text.length).fill(0);
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') {
      table[i] = -1;
      w++;
    } else table[i] = w;
  }
  return { table, count: w + 1 };
}

// pass 1: shape all lines, find the width scale (§3 rule: fit longest line into 0.55)
const shaped = LINES.map((l) => ({ line: l, ...shapeLine(l.text) }));
let em = EM_BODY;
const widest = Math.max(...shaped.map((s) => (s.width / upem) * (s.line.basmalah ? EM_BODY * BASMALAH_SCALE : EM_BODY)));
if (widest > COLUMN_WIDTH) {
  em = Math.max(EM_RANGE[0], (EM_BODY * COLUMN_WIDTH) / widest);
  if ((em * widest) / EM_BODY > COLUMN_WIDTH + 1e-6) {
    console.warn(`!! even at em ${em} the longest line exceeds ${COLUMN_WIDTH} — §3 says re-break, review needed`);
  }
  console.log(`fit rule engaged: em ${EM_BODY} → ${em.toFixed(4)} (longest line ${widest.toFixed(3)})`);
}

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

// pass 2: place lines, classify, schedule
const outLines = [];
let globalOrder = 0;
for (let li = 0; li < shaped.length; li++) {
  const { line, glyphs, width } = shaped[li];
  const emLine = line.basmalah ? em * BASMALAH_SCALE : em;
  const s = emLine / upem; // font units → world
  const baseline = BASELINE0 + li * LINE_PITCH;
  const wWorld = width * s;
  const startX = line.basmalah ? -wWorld / 2 : COLUMN_RIGHT - wWorld;
  const { table: wordTable, count: wordCount } = wordIndexTable(line.text);

  const items = glyphs
    .map((g) => {
      const path = glyphPath(g.gid);
      const ext = glyphExt(g.gid);
      return {
        gid: g.gid,
        word: wordTable[g.cluster] ?? 0,
        // zero-advance glyphs after shaping are attached marks (harakat, dots, shadda…)
        kind: g.adv === 0 && path !== '' ? 'mark' : 'base',
        x: startX + g.x * s,
        y: baseline - g.y * s,
        scale: s,
        path,
        ext: { x: ext.xBearing * s, y: -ext.yBearing * s, w: ext.width * s, h: -ext.height * s },
        penX: startX + g.x * s,
      };
    })
    .filter((g) => g.path !== '');

  // §17 writing order: per word (RTL = descending pen-x), bases in pen order, then the
  // word's marks (RTL then top-down), delayed MARK_DELAY_DP after the base group
  const schedule = [];
  for (let w = 0; w < wordCount; w++) {
    const bases = items
      .filter((g) => g.word === w && g.kind === 'base')
      .sort((a, b) => b.penX - a.penX);
    const marks = items
      .filter((g) => g.word === w && g.kind === 'mark')
      .sort((a, b) => b.penX - a.penX || a.y - b.y);
    for (const g of bases) schedule.push({ item: g, order: globalOrder++, delay: 0 });
    for (const g of marks) schedule.push({ item: g, order: globalOrder++, delay: MARK_DELAY_DP });
  }
  for (const s2 of schedule) {
    s2.item.order = s2.order;
    s2.item.delay = s2.delay;
  }

  // āyah marker anchor (§3): 0.012 after (left of) the final glyph, half x-height up
  const leftEdge = Math.min(...items.map((g) => g.x + g.ext.x));
  const marker =
    line.part === 1 ? null : { x: leftEdge - 0.012, y: baseline - 0.0105, ayah: line.ayah };

  outLines.push({
    ayah: line.ayah,
    part: line.part ?? 1,
    basmalah: !!line.basmalah,
    baseline,
    em: emLine,
    widthWorld: wWorld,
    marker,
    glyphs: items.map((g) => ({
      gid: g.gid,
      word: g.word,
      kind: g.kind,
      order: g.order,
      delay: g.delay,
      x: +g.x.toFixed(6),
      y: +g.y.toFixed(6),
      scale: +g.scale.toFixed(8),
      ext: g.ext,
      path: g.path,
    })),
  });
}

// ---- outputs ----------------------------------------------------------------------------
mkdirSync(join(root, 'public/text'), { recursive: true });

// frozen SVG (world coords ×1000 for sane numbers; y down)
const K = 1000;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-0.39 * K} 0 ${0.78 * K} ${1 * K}">\n`;
svg += `<rect x="${-0.39 * K}" y="0" width="${0.78 * K}" height="${K}" fill="#E6D5AF"/>\n`;
for (const l of outLines) {
  for (const g of l.glyphs) {
    svg += `<path transform="translate(${(g.x * K).toFixed(3)} ${(g.y * K).toFixed(3)}) scale(${(g.scale * K).toFixed(6)} ${(-g.scale * K).toFixed(6)})" d="${g.path}" fill="#2A211B"/>\n`;
  }
  if (l.marker) {
    svg += `<circle cx="${(l.marker.x * K).toFixed(2)}" cy="${(l.marker.y * K).toFixed(2)}" r="${0.0063 * K}" fill="none" stroke="#8F7440" stroke-width="${0.0016 * K}"/>\n`;
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
      checksums: { svg: svgHash, font: fontHash },
      em,
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
      note: '§17 per-glyph override table. Writing order = shaped glyph sequence per word (RTL), marks delayed Δp 0.003 after their word. Skeleton-derived priors (vertical-stem top-down, CCW loop entry, within-glyph w direction) are applied at atlas build (M3) — entries here are the schedule + hand-override slots.',
      checksums: { svg: svgHash, font: fontHash },
      markDelayDp: MARK_DELAY_DP,
      lines: outLines.map((l) => ({
        ayah: l.ayah,
        part: l.part,
        glyphs: l.glyphs.map((g) => ({
          order: g.order,
          gid: g.gid,
          word: g.word,
          kind: g.kind,
          delay: g.delay,
          skeletonPriors: 'pending-atlas (M3)',
          handOverride: null,
        })),
      })),
    },
    null,
    1,
  ),
);

const glyphCount = outLines.reduce((n, l) => n + l.glyphs.length, 0);
console.log(`frozen composition: ${outLines.length} lines, ${glyphCount} glyphs, em ${em.toFixed(4)}`);
console.log(`svg sha256  ${svgHash}`);
console.log(`font sha256 ${fontHash}`);
for (const l of outLines) {
  console.log(
    ` āyah ${l.ayah}${l.part > 1 ? 'b' : ''}: width ${l.widthWorld.toFixed(3)} · ${l.glyphs.length} glyphs (${l.glyphs.filter((g) => g.kind === 'mark').length} marks)`,
  );
}
