// The page layer of words — DOM over the canvas, never in it. A title and scroll cue at the
// opening, a quiet stage caption as each state begins, the translation of each āyah as the
// scribe writes it (once — not again at the rise), and a closing card at the held ending. Everything is a pure function of the
// same p the canvas uses; nothing here touches the render, so reference frames are unaffected
// (capture mode hides the whole layer). Translation: Abdullah Yusuf Ali, 1934 — his capitalisation and punctuation kept as printed.

import './story.css';

/** §10 per-āyah write windows (p) — baked from the frozen composition. */
const WRITE: ReadonlyArray<readonly [number, number]> = [
  [0.32, 0.352], [0.356, 0.389], [0.393, 0.42], [0.424, 0.451], [0.455, 0.488], [0.492, 0.522], [0.526, 0.58],
];
export const AYAT: ReadonlyArray<{ n: string; en: string }> = [
  { n: '١', en: 'In the name of Allah, Most Gracious, Most Merciful.' },
  { n: '٢', en: 'Praise be to Allah, the Cherisher and Sustainer of the Worlds;' },
  { n: '٣', en: 'Most Gracious, Most Merciful;' },
  { n: '٤', en: 'Master of the Day of Judgment.' },
  { n: '٥', en: 'Thee do we worship, and Thine aid we seek.' },
  { n: '٦', en: 'Show us the straight way,' },
  { n: '٧', en: 'The way of those on whom Thou hast bestowed Thy Grace, those whose (portion) is not wrath, and who go not astray.' },
];
/** Stage captions: shown from each start until the next, in the state's own words. */
const CAPTIONS: ReadonlyArray<readonly [number, string]> = [
  [0.0, ''],
  [0.06, 'The scroll opens'],
  [0.32, 'A scribe writes the seven āyāt'],
  [0.575, 'The page is read'],
  [0.64, 'The ink begins to rise'],
  [0.722, 'The words stand up in gold'],
  [0.84, 'Al-Fātiḥah'],
];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export class Story {
  private title: HTMLElement;
  private cue: HTMLElement;
  private caption: HTMLElement;
  private ayah: HTMLElement;
  private ayahNum: HTMLElement;
  private ayahText: HTMLElement;
  private closing: HTMLElement;
  private aboutBtn: HTMLButtonElement;
  private about: HTMLElement;
  private lastCaption = '';
  private lastAyah = -1;
  private everScrolled = false;
  private turnHint: HTMLElement;
  private turnedOnce = false;
  private transBtn: HTMLButtonElement;
  private translation: HTMLElement;
  private translationOpen = false;

  constructor(root: HTMLElement) {
    const $ = <T extends HTMLElement>(sel: string) => { const el = root.querySelector<T>(sel); if (!el) throw new Error(`story: missing ${sel}`); return el; };
    this.title = $('#story-title');
    this.cue = $('#story-cue');
    this.caption = $('#story-caption');
    this.ayah = $('#story-ayah');
    this.ayahNum = $('#story-ayah-num');
    this.ayahText = $('#story-ayah-text');
    this.closing = $('#story-closing');
    this.aboutBtn = $('#story-about-btn');
    this.about = $('#story-about');
    this.aboutBtn.addEventListener('click', () => this.toggleAbout());
    $('#story-about-close').addEventListener('click', () => this.toggleAbout(false));
    this.about.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.toggleAbout(false); });
    this.about.addEventListener('click', (e) => { if (e.target === this.about) this.toggleAbout(false); });
    this.translation = $('#story-translation');
    this.transBtn = $('#story-translate');
    const list = this.translation.querySelector('ul');
    if (list) for (const a of AYAT) { const li = document.createElement('li'); const n = document.createElement('span'); n.className = 'n'; n.lang = 'ar'; n.textContent = a.n; const t = document.createElement('span'); t.textContent = a.en; li.append(n, t); list.append(li); }
    this.transBtn.addEventListener('click', () => this.setTranslation(!this.translationOpen));
    this.turnHint = $('#story-turn-hint');
    $('#story-again').addEventListener('click', () => window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  }

  /** The full translation at the ending — a toggle on the closing card. */
  setTranslation(open: boolean): void {
    this.translationOpen = open;
    this.translation.hidden = !open;
    this.transBtn.setAttribute('aria-pressed', String(open));
    this.transBtn.textContent = open ? 'Hide translation' : 'Show translation';
  }

  /** The quiet cue that the block can be turned: shown while explore is armed, gone after the first turn. */
  setTurning(on: boolean): void {
    this.turnHint.hidden = !on || this.turnedOnce;
  }
  /** The reader has turned it once — the cue has done its work. */
  turned(): void {
    this.turnedOnce = true;
    this.turnHint.hidden = true;
  }

  toggleAbout(open: boolean = this.about.hidden === true): void {
    this.about.hidden = !open;
    this.aboutBtn.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('about-open', open);
    if (open) this.about.querySelector<HTMLElement>('#story-about-close')?.focus();
    else this.aboutBtn.focus();
  }

  private show(el: HTMLElement, alpha: number): void {
    const a = +alpha.toFixed(3);
    el.style.opacity = String(a);
    const hidden = a < 0.02;
    if ((el.getAttribute('aria-hidden') === 'true') !== hidden) el.setAttribute('aria-hidden', String(hidden));
    el.classList.toggle('is-off', hidden);
  }

  /** Called every frame with the live p (0–1). */
  update(p: number): void {
    if (p > 0.004) this.everScrolled = true;
    // title + cue: present at the opening, gone once the seal breaks
    const titleA = 1 - smooth(0.012, 0.05, p);
    this.show(this.title, titleA);
    this.show(this.cue, this.everScrolled ? Math.min(titleA, 1 - smooth(0.004, 0.02, p)) : 1);

    // stage caption
    let cap = '';
    for (const [start, text] of CAPTIONS) if (p >= start) cap = text;
    if (p >= 0.985) cap = '';
    if (cap !== this.lastCaption) { this.caption.textContent = cap; this.lastCaption = cap; }
    let capStart = 0;
    for (const [start] of CAPTIONS) if (p >= start) capStart = start;
    this.show(this.caption, cap ? smooth(capStart, capStart + 0.012, p) : 0);

    // translation of the āyah being written (window start → next start) — once; the rise repeats
    // the same order a few seconds later and a second pass read as a repeat (owner, 2026-09-19)
    let idx = -1;
    let a = 0;
    for (let i = 0; i < WRITE.length; i++) {
      const [s] = WRITE[i]!;
      const next = i + 1 < WRITE.length ? WRITE[i + 1]![0] : 0.6;
      if (p >= s - 0.006 && p < next) { idx = i; a = smooth(s - 0.006, s + 0.008, p) * (1 - smooth(next - 0.01, next, p)); }
    }
    if (idx !== this.lastAyah && idx >= 0) {
      const ay = AYAT[idx]!;
      this.ayahNum.textContent = ay.n;
      this.ayahText.textContent = ay.en;
      this.lastAyah = idx;
    }
    this.show(this.ayah, idx >= 0 ? a : 0);

    // closing card at the held ending; the full translation only while it is open there
    const closingA = smooth(0.975, 0.995, p);
    this.show(this.closing, closingA);
    if (closingA < 0.02 && this.translationOpen) this.setTranslation(false);
  }
}
