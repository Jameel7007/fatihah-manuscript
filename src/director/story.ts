// The page layer of words — DOM over the canvas, never in it. A title and scroll cue at the
// opening, a quiet stage caption as each state begins, the translation of each āyah as the
// scribe writes it (once — not again at the rise), and a closing card at the held ending. Everything is a pure function of the
// same p the canvas uses; nothing here touches the render, so reference frames are unaffected
// (capture mode hides the whole layer). Translation: Marmaduke Pickthall, 1930 (public domain).

import './story.css';

/** §10 per-āyah write windows (p) — baked from the frozen composition. */
const WRITE: ReadonlyArray<readonly [number, number]> = [
  [0.32, 0.352], [0.356, 0.389], [0.393, 0.42], [0.424, 0.451], [0.455, 0.488], [0.492, 0.522], [0.526, 0.58],
];
export const AYAT: ReadonlyArray<{ n: string; en: string }> = [
  { n: '١', en: 'In the name of Allah, the Beneficent, the Merciful.' },
  { n: '٢', en: 'Praise be to Allah, Lord of the Worlds,' },
  { n: '٣', en: 'the Beneficent, the Merciful,' },
  { n: '٤', en: 'Master of the Day of Judgment.' },
  { n: '٥', en: 'Thee alone we worship; Thee alone we ask for help.' },
  { n: '٦', en: 'Show us the straight path,' },
  { n: '٧', en: 'the path of those whom Thou hast favoured; not of those who earn Thine anger, nor of those who go astray.' },
];
/** Stage captions: shown from each start until the next, in the state's own words. */
const CAPTIONS: ReadonlyArray<readonly [number, string]> = [
  [0.0, ''],
  [0.06, 'The scroll opens'],
  [0.32, 'A scribe writes the seven āyāt'],
  [0.575, 'The page is read'],
  [0.64, 'The ink begins to rise'],
  [0.722, 'The words stand up in gold'],
  [0.84, 'Al-Fātiḥah, standing in the light'],
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
  private turnBtn: HTMLButtonElement;
  private turnHint: HTMLElement;
  onTurn: ((on: boolean) => void) | null = null;

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
    this.turnBtn = $('#story-turn');
    this.turnHint = $('#story-turn-hint');
    this.turnBtn.addEventListener('click', () => this.onTurn?.(this.turnBtn.getAttribute('aria-pressed') !== 'true'));
    $('#story-again').addEventListener('click', () => window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  }

  /** Reflect the explore state on the closing card. */
  setTurning(on: boolean): void {
    this.turnBtn.setAttribute('aria-pressed', String(on));
    this.turnBtn.textContent = on ? 'Let it rest' : 'Turn it in your hands';
    this.turnHint.hidden = !on;
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

    // closing card at the held ending
    this.show(this.closing, smooth(0.975, 0.995, p));
  }
}
