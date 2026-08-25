// Writing schedule — the §17 pacing, shared by the ?scene=reveal check and (M3) the ink
// reveal itself, which maps writing units → Δp inside each āyah's §10 window proportionally.
// Tuned 2026-08-25 per review: ~1.8× slower per word than the first cut, inter-word pauses
// longer than intra-word steps, marks landing later after their base group.

export const WRITING = {
  /** one base glyph's reveal length, in writing units */
  glyphUnit: 1.0,
  /** kashida elongation glyphs (v1.4 justification) — a continuous pen sweep, not
   *  discrete letters: each tatweel glyph costs a fraction of a base glyph so a long
   *  elongation reads as one deliberate stroke of proportional length */
  kashidaUnit: 0.35,
  /** marks are quicker strokes */
  markUnit: 0.65,
  /** pause after a word's base group before its marks begin */
  markLag: 1.2,
  /** breath between words — deliberately longer than any intra-word step */
  wordGap: 2.2,
  /** demo pacing for ?scene=reveal (units/s). M3 ignores this and maps units → Δp.
   *  Lines 1–2 of the v1.4 justified flow span ≈ 99.3 units → ≈ 29 s per loop
   *  (same per-word feel as the approved 2.0×-slower cut; these lines carry more words). */
  unitsPerSecond: 3.45,
  /** how long a glyph reads as wet after its reveal completes, in units */
  wetUnits: 3.0,
};

export interface ScheduleItem {
  /** stable key: the glyph's global order index from the frozen composition */
  order: number;
  /** reveal start, in writing units */
  start: number;
  /** reveal duration, in writing units */
  dur: number;
}

interface GlyphIn {
  order: number;
  word: number;
  kind: string;
  /** line index — word indices restart per line, so words are keyed (line, word) */
  line: number;
  /** presentation-only tatweel glyph from the justification stage */
  kashida?: boolean;
}

/** Build per-glyph start/duration in writing units from frozen-composition glyphs. */
export function buildSchedule(glyphs: GlyphIn[]): { items: Map<number, ScheduleItem>; span: number } {
  const sorted = [...glyphs].sort((a, b) => a.order - b.order);
  const items = new Map<number, ScheduleItem>();
  let cursor = 0;
  let prevWordKey = '';
  let baseGroupEnd = 0;
  let markCursor = 0;
  let wordEnd = 0;

  for (const g of sorted) {
    const wordKey = `${g.line}:${g.word}`;
    if (wordKey !== prevWordKey) {
      cursor = prevWordKey === '' ? 0 : wordEnd + WRITING.wordGap;
      prevWordKey = wordKey;
      baseGroupEnd = cursor;
      markCursor = -1;
      wordEnd = cursor;
    }
    if (g.kind === 'base') {
      const unit = g.kashida ? WRITING.kashidaUnit : WRITING.glyphUnit;
      items.set(g.order, { order: g.order, start: cursor, dur: unit });
      cursor += unit;
      baseGroupEnd = cursor;
      wordEnd = Math.max(wordEnd, cursor);
    } else {
      if (markCursor < 0) markCursor = baseGroupEnd + WRITING.markLag;
      items.set(g.order, { order: g.order, start: markCursor, dur: WRITING.markUnit });
      markCursor += WRITING.markUnit;
      wordEnd = Math.max(wordEnd, markCursor);
    }
  }
  return { items, span: wordEnd };
}
