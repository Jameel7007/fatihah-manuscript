// Writing schedule — the §17 pacing, shared by the ?scene=reveal check and (M3) the ink
// reveal itself, which maps writing units → Δp inside each āyah's §10 window proportionally.
// Tuned 2026-08-25 per review: ~1.8× slower per word than the first cut, inter-word pauses
// longer than intra-word steps, marks landing later after their base group.

export const WRITING = {
  /** one base glyph's reveal length, in writing units */
  glyphUnit: 1.0,
  /** marks are quicker strokes */
  markUnit: 0.65,
  /** pause after a word's base group before its marks begin */
  markLag: 1.2,
  /** breath between words — deliberately longer than any intra-word step */
  wordGap: 2.2,
  /** demo pacing for ?scene=reveal (units/s). M3 ignores this and maps units → Δp.
   *  Lines 1–2 span ≈ 82.5 units → ≈ 24 s per loop, 2.0× the first cut. */
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
      items.set(g.order, { order: g.order, start: cursor, dur: WRITING.glyphUnit });
      cursor += WRITING.glyphUnit;
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
