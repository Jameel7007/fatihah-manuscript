// §13 reduced motion — defined, not vestigial. Under prefers-reduced-motion the journey
// becomes SEVEN HELD COMPOSITIONS: scroll (or arrow keys / the pager dots that appear only
// in this mode) steps between state-center poses with a 300 ms opacity dissolve and camera
// CUTS, not moves. The residual sim, idle micro-motion, parallax, dust and env drift are off
// (the caller zeroes them); ink appears pre-dried; the rise presents at its completed pose.
//
// The dissolve is a DOM overlay: the outgoing frame is copied off the canvas once per state
// change and faded out over the new state — no double rendering, no extra pass.

export const REDUCED_CENTERS: readonly number[] = [0.0, 0.21, 0.45, 0.6, 0.685, 0.884, 1.0];
const LABELS = ['rolled', 'unrolling', 'ink', 'presenting', 'relief', 'risen', 'facing'];
const DISSOLVE_MS = 300;

export class ReducedMotion {
  index = 0;
  private overlay: HTMLCanvasElement;
  private dots: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private onChange: (p: number) => void;
  private fadeT0 = -1;

  constructor(canvas: HTMLCanvasElement, onChange: (p: number) => void) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.overlay = document.createElement('canvas');
    this.overlay.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;opacity:0;z-index:5';
    this.overlay.setAttribute('aria-hidden', 'true');
    (document.querySelector('main') ?? document.body).appendChild(this.overlay);
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Manuscript states');
    this.dots = document.createElement('div');
    this.dots.setAttribute('role', 'tablist');
    this.dots.setAttribute('aria-label', 'Manuscript states');
    this.dots.style.cssText =
      'position:fixed;right:18px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:10px;z-index:6';
    nav.appendChild(this.dots);
    REDUCED_CENTERS.forEach((_, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', `State ${i + 1}: ${LABELS[i]}`);
      b.style.cssText =
        'width:12px;height:12px;border-radius:50%;border:1px solid #8F7440;background:transparent;padding:0;cursor:pointer';
      b.addEventListener('click', () => this.goUser(i));
      this.dots.appendChild(b);
    });
    document.body.appendChild(nav);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        this.goUser(this.index + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        this.goUser(this.index - 1);
      }
    });
    this.paintDots();
  }

  /** Map a raw scroll fraction to the nearest held state (equal bands). */
  fromScroll(s: number): void {
    const i = Math.min(REDUCED_CENTERS.length - 1, Math.max(0, Math.round(s * (REDUCED_CENTERS.length - 1))));
    if (i !== this.index) this.go(i);
  }

  /** Keys / pager dots move the SCROLL to the state's band center — scroll stays the single
   *  source of truth, so the per-frame fromScroll() agrees instead of fighting the jump. */
  private goUser(i: number): void {
    const next = Math.min(REDUCED_CENTERS.length - 1, Math.max(0, i));
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max > 0) window.scrollTo({ top: (next / (REDUCED_CENTERS.length - 1)) * max, behavior: 'auto' });
    this.go(next);
  }

  go(i: number): void {
    const next = Math.min(REDUCED_CENTERS.length - 1, Math.max(0, i));
    if (next === this.index) return;
    // freeze the outgoing frame into the overlay, then dissolve it over the new state
    try {
      this.overlay.width = this.canvas.width;
      this.overlay.height = this.canvas.height;
      const ctx = this.overlay.getContext('2d');
      ctx?.drawImage(this.canvas, 0, 0);
      this.overlay.style.opacity = '1';
      this.fadeT0 = performance.now();
    } catch {
      this.fadeT0 = -1;
    }
    this.index = next;
    this.paintDots();
    this.onChange(REDUCED_CENTERS[next] ?? 0);
  }

  get p(): number {
    return REDUCED_CENTERS[this.index] ?? 0;
  }

  /** Call every frame — advances the dissolve. */
  tick(now: number): void {
    if (this.fadeT0 < 0) return;
    const k = Math.min(1, (now - this.fadeT0) / DISSOLVE_MS);
    this.overlay.style.opacity = String(1 - k);
    if (k >= 1) this.fadeT0 = -1;
  }

  private paintDots(): void {
    Array.from(this.dots.children).forEach((c, i) => {
      const b = c as HTMLButtonElement;
      b.style.background = i === this.index ? '#C9A45B' : 'transparent';
      b.setAttribute('aria-selected', i === this.index ? 'true' : 'false');
      b.tabIndex = i === this.index ? 0 : -1;
    });
  }
}
