// M7 diagnostic only: rAF pacing is not GPU execution time or device certification.
export interface PerfState { p: number; tier: number; ss: number; dpr: number; width: number; height: number }
type Sample = [elapsedMs: number, intervalMs: number, p: number, tier: number, ss: number];
const summary = (values: number[]) => {
  const sorted = [...values].sort((a,b)=>a-b);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length-1, Math.floor(sorted.length*fraction))] ?? 0;
  return { frames: values.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) ?? 0, stallsOver250ms: values.filter(x=>x>250).length };
};

export class PerfAudit {
  private start: number | null = null;
  private last: number | null = null;
  private previous: PerfState | null = null;
  private samples: Sample[] = [];
  private cpuSamples: Array<[elapsedMs: number, cpuMs: number, p: number, tier: number, ss: number]> = [];
  private configurations: Array<{elapsedMs: number; state: PerfState}> = [];
  private hidden = false;
  done = false;
  readonly durationMs: number;
  constructor(seconds: number) { this.durationMs = seconds * 1000; }

  markHidden(): void { if (this.start !== null && !this.done) this.hidden = true; }

  tick(now: number, state: PerfState, visible: boolean, cpuUpdateSubmitMs?: number) {
    if (this.done) return null;
    if (!visible) this.hidden = true;
    if (this.start === null) this.start = now;
    const elapsedMs = now-this.start;
    // CPU work belongs to the CURRENT frame, unlike the preceding rAF interval.
    // Missing/invalid timings are unavailable, never invented zero-cost samples.
    if (cpuUpdateSubmitMs !== undefined && Number.isFinite(cpuUpdateSubmitMs) && cpuUpdateSubmitMs >= 0) {
      this.cpuSamples.push([elapsedMs,cpuUpdateSubmitMs,state.p,state.tier,state.ss]);
    }
    // The elapsed interval belongs to the PREVIOUS rendered state. Keep all positive
    // intervals, including stalls; demotions never clear the history or restart time.
    if (this.last !== null && this.previous && now > this.last) {
      this.samples.push([elapsedMs, now-this.last, this.previous.p, this.previous.tier, this.previous.ss]);
    }
    const old = this.configurations.at(-1)?.state;
    if (!old || old.tier!==state.tier || old.dpr!==state.dpr || old.width!==state.width || old.height!==state.height) {
      this.configurations.push({elapsedMs,state:{...state}});
    }
    this.last = now; this.previous = {...state};
    if (elapsedMs < this.durationMs) return null;
    this.done = true;
    const byTier = Object.fromEntries([...new Set(this.samples.map(s=>s[3]))].map(tier => [tier,summary(this.samples.filter(s=>s[3]===tier).map(s=>s[1]))]));
    return {
      metric: 'requestAnimationFrame intervals in milliseconds; not GPU timings',
      durationSeconds: elapsedMs/1000,
      ...summary(this.samples.map(s=>s[1])),
      initialTier: this.configurations[0]?.state.tier,
      finalTier: state.tier,
      nominalTierMaintained: this.configurations.every(c=>c.state.tier===this.configurations[0]?.state.tier),
      foregroundThroughout: !this.hidden,
      usableForegroundSample: !this.hidden && this.samples.length>30,
      configurations: this.configurations,
      byTier,
      cpuUpdateSubmit: {
        metric: 'CPU wall time from animation callback entry through scene update and render submission; excludes GPU completion, browser presentation, audit and later HUD work',
        summary: this.cpuSamples.length ? summary(this.cpuSamples.map(s=>s[1])) : null,
        byTier: Object.fromEntries([...new Set(this.cpuSamples.map(s=>s[3]))].map(tier => [tier,summary(this.cpuSamples.filter(s=>s[3]===tier).map(s=>s[1]))])),
        sampleColumns: ['elapsedMs','cpuMs','p','tier','ss'],
        samples: this.cpuSamples,
      },
      sampleColumns: ['elapsedMs','intervalMs','p','tier','ss'],
      samples: this.samples,
    };
  }
}
