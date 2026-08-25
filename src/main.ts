import { Color, PerspectiveCamera, REVISION } from 'three/webgpu';
import { createRenderer } from './core/renderer';
import { DPR_CAP, detectTier } from './core/tiers';
import { CameraRig } from './director/camera';
import { poseTransform, stateLabel } from './director/drivers';
import { ScrollDriver } from './director/scroll';
import { evalDeform } from './field/deform';
import { Field } from './field/field';
import { Residual } from './field/residual';
import { buildSilhouette } from './field/silhouette';
import { buildRamp, buildStage, type DebugMode } from './look/stage';
import { captureFrame, samplePixel, type CaptureFrame } from './qa/capture';
import { flickProfile, runProbes, runStorm, sampleResidualEnergy, type ProbeReport } from './qa/probes';

interface CaptureResult {
  hash: string;
  p: number;
  tier: number;
  backend: string;
  dataUrl: string;
  ramp?: Array<{ input: number; out: [number, number, number, number] }>;
  rampOk?: boolean;
}

declare global {
  interface Window {
    __capture?: CaptureResult;
    __captureError?: string;
    __probe?: ProbeReport;
    __storm?: unknown;
    __flick?: { peak: number; settled: boolean; nan: boolean; samples: Array<[number, number]> };
  }
}

const q = new URLSearchParams(location.search);
const captureP = q.get('capture');
const probeP = q.get('probe');
const stormS = q.get('storm');
const flickOn = q.get('flick') !== null;
const calibrate = q.get('calibrate'); // 'bg' | 'key' — M2 calibration harnesses
const sceneMode = q.get('scene') ?? 'main';
const debugMode = (calibrate === 'key' ? 'graycard' : (q.get('debug') ?? 'none')) as DebugMode;
const tier = detectTier(q.get('tier'));
const isCapture = captureP !== null || probeP !== null || sceneMode === 'ramp' || calibrate !== null;
const capW = Number(q.get('w') ?? 1440);
const capH = Number(q.get('h') ?? 900);

const canvas = document.querySelector<HTMLCanvasElement>('#gl');
const hud = document.querySelector<HTMLDivElement>('#hud');
const bar = document.querySelector<HTMLDivElement>('#bar');
const capEl = document.querySelector<HTMLDivElement>('#cap');
const spacer = document.querySelector<HTMLDivElement>('#spacer');
if (!canvas || !hud || !bar || !capEl || !spacer) throw new Error('missing DOM scaffolding');

const coarse = matchMedia('(pointer: coarse)').matches;
spacer.style.height = isCapture ? '0' : `${(coarse ? 6.5 : 8) * 100 + 100}vh`;
if (isCapture) document.body.classList.add('capture');

const boot = await createRenderer(canvas, {
  forceWebGL: q.get('backend') === 'webgl2',
  dprCap: isCapture ? 1 : DPR_CAP[tier],
});
const { renderer, backend } = boot;
console.info(
  `[fatihah] three r${REVISION} · ${backend} · T${tier} · dpr ${renderer.getPixelRatio()} · ${sceneMode}${isCapture ? ' · capture' : ''}${debugMode !== 'none' ? ` · debug=${debugMode}` : ''}`,
);

function fitViewport(): { w: number; h: number } {
  const w = isCapture ? capW : window.innerWidth;
  const h = isCapture ? capH : window.innerHeight;
  renderer.setSize(w, h);
  return { w, h };
}

if (sceneMode === 'ramp') {
  await runRamp();
} else if (calibrate !== null) {
  await runCalibrate(calibrate);
} else {
  await runMain();
}

// --- M2 calibration harnesses (?calibrate=bg | key) -------------------------------------
// Empirical end-to-end solves against the LIVE pipeline (render → readback), so the baked
// constants stay correct whatever the tone/grade chain contains. Results are printed and
// baked by hand into look/stage.ts (BG_LINEAR, KEY_INTENSITY).

async function runCalibrate(mode: string): Promise<void> {
  const sil = buildSilhouette();
  const field = new Field(sil);
  const { scene, sheetRoot, key } = buildStage(field, sil, debugMode);
  const size = fitViewport();

  const cam = new PerspectiveCamera((2 * Math.atan(12 / 40) * 180) / Math.PI, size.w / size.h, 0.05, 4);
  cam.position.set(0, 0.9, 0.02);
  cam.lookAt(0, 0, 0.02);

  const d = evalDeform(0.5);
  field.setDeform(d, false);

  const renderOnce = async (): Promise<[number, number, number]> => {
    await new Promise<void>((resolve) => {
      let n = 0;
      renderer.setAnimationLoop(() => {
        field.run(renderer);
        renderer.render(scene, cam);
        if (++n >= 2) {
          renderer.setAnimationLoop(null);
          resolve();
        }
      });
    });
    const frame = await captureFrame(canvas as HTMLCanvasElement);
    const px = samplePixel(frame, frame.width / 2, frame.height / 2);
    return [px[0], px[1], px[2]];
  };

  if (mode === 'bg') {
    sheetRoot.visible = false;
    const target = [13, 9, 6]; // #0D0906
    const bg = scene.background as Color;
    // Damped 3×3 Newton with numerical Jacobian — AgX's inset matrix mixes channels near
    // black, so per-channel iteration cannot converge. 4 renders per iteration.
    const lin = [0.002, 0.001, 0.0006];
    const evalAt = async (v: number[]): Promise<[number, number, number]> => {
      bg.setRGB(Math.max(0, v[0] ?? 0), Math.max(0, v[1] ?? 0), Math.max(0, v[2] ?? 0));
      return renderOnce();
    };
    let got = await evalAt(lin);
    for (let it = 0; it < 8; it++) {
      const err = [0, 1, 2].map((c) => (target[c] ?? 0) - (got[c] ?? 0));
      if (err.every((e) => Math.abs(e) <= 0.5)) break;
      const J: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let c = 0; c < 3; c++) {
        const h = Math.max(1e-5, (lin[c] ?? 0) * 0.25);
        const v = [...lin];
        v[c] = (v[c] ?? 0) + h;
        const g2 = await evalAt(v);
        for (let r = 0; r < 3; r++) (J[r] as number[])[c] = ((g2[r] ?? 0) - (got[r] ?? 0)) / h;
      }
      const dx = solve3(J, err);
      for (let c = 0; c < 3; c++) {
        const step = Math.max(-2 * (lin[c] ?? 1e-4), Math.min(2 * (lin[c] ?? 1e-4), (dx[c] ?? 0) * 0.8));
        lin[c] = Math.max(1e-6, (lin[c] ?? 0) + step);
      }
      got = await evalAt(lin);
    }
    const out = { mode, linear: lin.map((x) => +x.toExponential(4)), displayed: got, target };
    (window as unknown as { __calib?: unknown }).__calib = out;
    capEl!.textContent = `CALIB bg → linear (${lin.map((x) => x.toExponential(3)).join(', ')}) displays rgb(${got.join(',')}) target rgb(${target.join(',')})`;
    console.info('[calibrate]', out);
    return;
  }

  // mode === 'key': 18% gray card under key alone → displayed 128/255 (AgX of 0.18)
  scene.traverse((o) => {
    const l = o as { isLight?: boolean; intensity?: number };
    if (l.isLight && o !== key) l.intensity = 0;
  });
  let lo = 1;
  let hi = 60;
  let got: [number, number, number] = [0, 0, 0];
  for (let it = 0; it < 14; it++) {
    key.intensity = (lo + hi) / 2;
    got = await renderOnce();
    const lum = got[0]; // neutral card, neutral-ish key channel R is the anchor
    if (Math.abs(lum - 128) <= 0.5) break;
    if (lum > 128) hi = key.intensity;
    else lo = key.intensity;
  }
  const out = { mode, keyIntensity: +key.intensity.toFixed(3), displayed: got };
  (window as unknown as { __calib?: unknown }).__calib = out;
  capEl!.textContent = `CALIB key → intensity ${key.intensity.toFixed(3)} displays rgb(${got.join(',')}) target R≈128`;
  console.info('[calibrate]', out);
}

// --- main scene -------------------------------------------------------------------------

async function runMain(): Promise<void> {
  const sil = buildSilhouette();
  const residual = new Residual();
  const field = new Field(sil);
  const { scene, sheetRoot } = buildStage(field, sil, debugMode);
  const rig = new CameraRig();
  const scroll = new ScrollDriver();
  const size = fitViewport();
  rig.camera.aspect = size.w / size.h;

  window.addEventListener('resize', () => {
    if (isCapture) return;
    const s = fitViewport();
    rig.camera.aspect = s.w / s.h;
    rig.camera.updateProjectionMatrix();
  });

  const applyFrame = (p: number, dt: number, simEnabled: boolean): void => {
    const d = evalDeform(p);
    if (simEnabled) {
      residual.setInputs(dt, scroll.vLpf, d.wTop, d.wBot);
      residual.step(renderer);
      field.bindResidual(residual.freshRT().texture);
    }
    field.setDeform(d, simEnabled);
    field.run(renderer);
    // Pose tilt pivots about the moving top curl line, not the origin — with the rolled
    // mass far from origin (v1.3 start pose), an origin pivot would swing the composition.
    const tr = poseTransform(p, d.zTopCurl);
    sheetRoot.rotation.x = tr.rotX;
    sheetRoot.position.set(0, tr.offY, tr.offZ);
  };

  // ---- capture / probe mode (deterministic, sim off) ----
  if (isCapture) {
    const pStr = captureP ?? q.get('p') ?? '0';
    const p = Math.min(1, Math.max(0, Number(pStr === '1' && probeP ? (q.get('p') ?? '0') : pStr)));
    scroll.forced = p;
    scroll.update(1 / 60);
    rig.snap(p);
    (window as unknown as { __cam?: unknown }).__cam = {
      pos: rig.camera.position.toArray().map((x) => +x.toFixed(4)),
      fov: +rig.camera.fov.toFixed(2),
      aspect: +rig.camera.aspect.toFixed(4),
    };
    try {
      // Render through the same loop machinery as live mode; the loop keeps running while
      // async readbacks are in flight — WebGL fence-based readbacks need a pumping queue.
      await new Promise<void>((resolve, reject) => {
        let n = 0;
        let started = false;
        let finished = false;
        renderer.setAnimationLoop(() => {
          applyFrame(p, 1 / 60, false);
          renderer.render(scene, rig.camera);
          n++;
          if (n >= 3 && !started) {
            started = true;
            void (async () => {
              try {
                if (probeP !== null) {
                  const report = await runProbes(renderer, field.posRT, field.nrmRT, evalDeform(p), sil, backend);
                  window.__probe = report;
                  capEl!.textContent =
                    `PROBE p=${p.toFixed(3)} ${report.ok ? 'OK' : 'FAIL'}\n` +
                    `max pos err ${report.maxPosErr.toExponential(2)} (tol 1.5e-3)\n` +
                    `max normal err ${report.maxNormErrDeg.toFixed(2)}° (tol 2°)\n` +
                    `derived: topTip ${report.derived.topTipLift.toFixed(4)} · botTip ${report.derived.botTipLift.toFixed(4)} · botApex ${report.derived.botApex.toFixed(4)}`;
                  console.info('[probe]', report);
                } else {
                  const frame = await captureFrame(canvas as HTMLCanvasElement);
                  window.__capture = { hash: frame.hash, p, tier, backend, dataUrl: frame.dataUrl };
                  capEl!.textContent = `R-p${p.toFixed(3)}-T${tier}-${backend}\n${frame.hash}`;
                  console.info(`[capture] p=${p} T${tier} ${backend} sha256=${frame.hash}`);
                }
                finished = true;
              } catch (err) {
                renderer.setAnimationLoop(null);
                reject(err as Error);
              }
            })();
          }
          if (finished) {
            renderer.setAnimationLoop(null);
            resolve();
          }
        });
      });
    } catch (err) {
      window.__captureError = String(err);
      capEl!.textContent = `capture failed: ${String(err)}`;
      throw err;
    }
    return;
  }

  // ---- live loop ----
  let last = performance.now();
  let flickT0: number | null = flickOn ? -1 : null;
  const flickSamples: Array<[number, number]> = [];
  let flickNaN = false;
  const sparkline = makeSparkline();

  renderer.setAnimationLoop((now: number) => {
    const dt = Math.max(0, (now - last) / 1000);
    last = now;

    if (flickT0 !== null) {
      if (flickT0 < 0) flickT0 = now;
      const t = (now - flickT0) / 1000;
      const target = flickProfile(t);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (target !== null) window.scrollTo(0, target * max);
      else if (t > 8) finishFlick();
    }

    scroll.update(dt);
    applyFrame(scroll.p, dt, true);
    rig.update(scroll.p, dt);
    renderer.render(scene, rig.camera);
    hud!.textContent = `${stateLabel(scroll.p)} · p ${scroll.p.toFixed(3)}`;
    bar!.style.height = `${scroll.p * 100}%`;
  });

  // periodic residual energy sampling for the flick trace
  setInterval(() => {
    if (flickT0 === null || flickT0 < 0) return;
    void sampleResidualEnergy(renderer, residual.freshRT()).then(({ maxRn, nan }) => {
      if (flickT0 === null || flickT0 < 0) return;
      const t = (performance.now() - flickT0) / 1000;
      flickSamples.push([t, maxRn]);
      if (nan) flickNaN = true;
      sparkline.draw(flickSamples);
    });
  }, 150);

  function finishFlick(): void {
    const peak = Math.max(...flickSamples.map((s) => s[1]), 0);
    const tail = flickSamples.filter((s) => s[0] > 5.0);
    const settled = tail.length > 0 && tail.every((s) => s[1] < 1e-4);
    window.__flick = { peak, settled, nan: flickNaN, samples: flickSamples };
    capEl!.style.display = 'block';
    capEl!.textContent = `R-FLICK done · peak |r_n| ${peak.toExponential(2)} (clamp 2.7e-3) · settled ${settled} · NaN ${flickNaN}`;
    console.info('[flick]', window.__flick);
    flickT0 = null;
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'q' || e.key === 'Q') {
      flickSamples.length = 0;
      flickT0 = -1;
    }
  });

  if (stormS !== null) {
    const secs = Math.max(3, Math.min(60, Number(stormS) || 15));
    runStorm(
      secs,
      () => scroll.p,
      async () => {
        const px = (await renderer.readRenderTargetPixelsAsync(field.posRT, 96, 128, 1, 1)) as Float32Array;
        return Number.isNaN(px[0] ?? 0) || Number.isNaN(px[1] ?? 0);
      },
      (r) => {
        window.__storm = r;
        capEl!.style.display = 'block';
        capEl!.textContent = `STORM ${r.ok ? 'OK' : 'FAIL'} · ${r.seconds}s · frames ${r.frames} · NaN ${r.nanHits} · pOut ${r.pOutOfRange} · errors ${r.errors}`;
        console.info('[storm]', r);
      },
    );
  }

  function makeSparkline(): { draw: (s: Array<[number, number]>) => void } {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 64;
    c.style.cssText = 'position:fixed;right:12px;bottom:12px;background:#0B0906;border:1px solid #2C2517;display:none';
    document.body.appendChild(c);
    const ctx = c.getContext('2d');
    return {
      draw(samples: Array<[number, number]>): void {
        if (!ctx) return;
        c.style.display = 'block';
        ctx.fillStyle = '#0B0906';
        ctx.fillRect(0, 0, 320, 64);
        ctx.strokeStyle = '#C9A45B';
        ctx.beginPath();
        for (const [t, e] of samples) {
          const x = (t / 8) * 320;
          const y = 60 - Math.min(1, e / 0.0027) * 56;
          if (x === (samples[0]?.[0] ?? 0) / 8 * 320) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      },
    };
  }
}

/** Solve 3×3 J·x = b (Gaussian elimination with partial pivoting). */
function solve3(J: number[][], b: number[]): number[] {
  const a = J.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r]?.[col] ?? 0) > Math.abs(a[piv]?.[col] ?? 0)) piv = r;
    }
    if (piv !== col) {
      const t = a[col];
      a[col] = a[piv] as number[];
      a[piv] = t as number[];
    }
    const p = a[col]?.[col] ?? 1e-9;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = (a[r]?.[col] ?? 0) / (Math.abs(p) < 1e-9 ? 1e-9 : p);
      for (let c = col; c < 4; c++) (a[r] as number[])[c] = (a[r]?.[c] ?? 0) - f * (a[col]?.[c] ?? 0);
    }
  }
  return [0, 1, 2].map((i) => {
    const p = a[i]?.[i] ?? 1e-9;
    return (a[i]?.[3] ?? 0) / (Math.abs(p) < 1e-9 ? 1e-9 : p);
  });
}

// --- AgX ramp verification (?scene=ramp) — unchanged from M0 ----------------------------

async function runRamp(): Promise<void> {
  const ramp = buildRamp();
  const size = fitViewport();
  ramp.camera.aspect = size.w / size.h;
  ramp.camera.updateProjectionMatrix();
  for (const s of ramp.swatches) s.ndc.copy(s.mesh.position).project(ramp.camera);

  await new Promise<void>((resolve) => {
    let n = 0;
    renderer.setAnimationLoop(() => {
      renderer.render(ramp.scene, ramp.camera);
      if (++n >= 3) {
        renderer.setAnimationLoop(null);
        resolve();
      }
    });
  });
  const frame: CaptureFrame = await captureFrame(canvas as HTMLCanvasElement);

  const rows: Array<{ input: number; out: [number, number, number, number] }> = [];
  for (const s of ramp.swatches) {
    const x = (s.ndc.x * 0.5 + 0.5) * frame.width;
    const y = (-s.ndc.y * 0.5 + 0.5) * frame.height;
    rows.push({ input: s.input, out: samplePixel(frame, x, y) });
  }

  let ok = true;
  const problems: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const [R, G, B] = r.out;
    if (Math.abs(R - G) > 2 || Math.abs(G - B) > 2) {
      ok = false;
      problems.push(`swatch ${i} not neutral: ${R},${G},${B}`);
    }
    const prev = rows[i - 1];
    if (prev && R < prev.out[0] - 1) {
      ok = false;
      problems.push(`swatch ${i} not monotonic: ${R} < ${prev.out[0]}`);
    }
  }
  if ((rows[0]?.out[0] ?? 255) > 8) {
    ok = false;
    problems.push(`floor too high: ${rows[0]?.out[0]}`);
  }
  if ((rows[rows.length - 1]?.out[0] ?? 0) < 250) {
    ok = false;
    problems.push(`top not reaching white: ${rows[rows.length - 1]?.out[0]}`);
  }

  const mid = rows[6];
  capEl!.textContent = `AgX ramp ${ok ? 'OK' : 'FAIL'} · 0.18 → ${mid ? mid.out[0] : '?'}/255\n${rows
    .map((r) => `lin ${r.input.toExponential(2)} → srgb ${r.out[0]}`)
    .join('\n')}\n${problems.join('\n')}`;
  console.info(`[ramp] ${ok ? 'OK' : 'FAIL'}`);
  window.__capture = { hash: frame.hash, p: -1, tier, backend, dataUrl: frame.dataUrl, ramp: rows, rampOk: ok };
}
