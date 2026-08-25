// Scroll → uP smoothing — §13: critically damped spring k = 110 s⁻², c = 21 s⁻¹,
// velocity LPF τ = 140 ms. Reduced motion hardens to a τ = 60 ms first-order lag.

export class ScrollDriver {
  p = 0;
  target = 0;
  /** Low-passed dp/dt — feeds the residual sim (M1+). */
  vLpf = 0;
  /** Capture mode pins p directly and zeroes all dynamics. */
  forced: number | null = null;

  private v = 0;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  update(dtRaw: number): void {
    if (this.forced !== null) {
      this.p = this.forced;
      this.target = this.forced;
      this.v = 0;
      this.vLpf = 0;
      return;
    }
    const max = document.documentElement.scrollHeight - window.innerHeight;
    this.target = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;

    const dt = Math.min(dtRaw, 1 / 30);
    if (dt <= 0) return;

    if (this.reduced) {
      const k = 1 - Math.exp(-dt / 0.06);
      const prev = this.p;
      this.p += (this.target - this.p) * k;
      this.v = (this.p - prev) / dt;
    } else {
      const a = 110 * (this.target - this.p) - 21 * this.v;
      this.v += a * dt;
      this.p += this.v * dt;
    }
    this.p = Math.min(1, Math.max(0, this.p));
    this.vLpf += (this.v - this.vLpf) * (1 - Math.exp(-dt / 0.14));
  }
}
