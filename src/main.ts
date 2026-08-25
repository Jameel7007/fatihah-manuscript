import { REVISION } from 'three/webgpu';
import { createRenderer } from './core/renderer';
import { DPR_CAP, detectTier } from './core/tiers';
import { CameraRig } from './director/camera';
import { poseTiltDeg, stateLabel } from './director/drivers';
import { ScrollDriver } from './director/scroll';
import { buildRamp, buildStage } from './look/stage';
import { captureFrame, samplePixel, type CaptureFrame } from './qa/capture';

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
  }
}

const q = new URLSearchParams(location.search);
const captureP = q.get('capture'); // "1" or a p value → capture mode
const sceneMode = q.get('scene') ?? 'main';
const tier = detectTier(q.get('tier'));
const isCapture = captureP !== null || sceneMode === 'ramp';
const capW = Number(q.get('w') ?? 1440);
const capH = Number(q.get('h') ?? 900);

const canvas = document.querySelector<HTMLCanvasElement>('#gl');
const hud = document.querySelector<HTMLDivElement>('#hud');
const bar = document.querySelector<HTMLDivElement>('#bar');
const capEl = document.querySelector<HTMLDivElement>('#cap');
const spacer = document.querySelector<HTMLDivElement>('#spacer');
if (!canvas || !hud || !bar || !capEl || !spacer) throw new Error('missing DOM scaffolding');

// §11/§12 — scrollable length 8×vh desktop, 6.5×vh mobile (spacer adds the viewport itself).
const coarse = matchMedia('(pointer: coarse)').matches;
spacer.style.height = isCapture ? '0' : `${(coarse ? 6.5 : 8) * 100 + 100}vh`;
if (isCapture) document.body.classList.add('capture');

const boot = await createRenderer(canvas, {
  forceWebGL: q.get('backend') === 'webgl2',
  dprCap: isCapture ? 1 : DPR_CAP[tier],
});
const { renderer, backend } = boot;
console.info(`[fatihah] three r${REVISION} · ${backend} · T${tier} · dpr ${renderer.getPixelRatio()} · ${sceneMode}${isCapture ? ' · capture' : ''}`);

function fitViewport(): { w: number; h: number } {
  const w = isCapture ? capW : window.innerWidth;
  const h = isCapture ? capH : window.innerHeight;
  renderer.setSize(w, h);
  return { w, h };
}

if (sceneMode === 'ramp') {
  await runRamp();
} else {
  await runMain();
}

// --- main scene -------------------------------------------------------------------------

async function runMain(): Promise<void> {
  const { scene, sheetRoot } = buildStage();
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

  const applyDrivers = (p: number): void => {
    sheetRoot.rotation.x = (poseTiltDeg(p) * Math.PI) / 180;
  };

  if (isCapture) {
    const p = Math.min(1, Math.max(0, Number(captureP === '1' ? (q.get('p') ?? '0') : captureP)));
    scroll.forced = p;
    scroll.update(1 / 60);
    applyDrivers(p);
    rig.snap(p);
    try {
      for (let i = 0; i < 3; i++) await renderer.renderAsync(scene, rig.camera);
      const frame = await captureFrame(canvas as HTMLCanvasElement);
      const result: CaptureResult = { hash: frame.hash, p, tier, backend, dataUrl: frame.dataUrl };
      window.__capture = result;
      capEl!.textContent = `R-p${p.toFixed(3)}-T${tier}-${backend}\n${frame.hash}`;
      console.info(`[capture] p=${p} T${tier} ${backend} sha256=${frame.hash}`);
    } catch (err) {
      window.__captureError = String(err);
      capEl!.textContent = `capture failed: ${String(err)}`;
      throw err;
    }
    return;
  }

  let last = performance.now();
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.max(0, (now - last) / 1000);
    last = now;
    scroll.update(dt);
    applyDrivers(scroll.p);
    rig.update(scroll.p, dt);
    renderer.render(scene, rig.camera);
    hud!.textContent = `${stateLabel(scroll.p)} · p ${scroll.p.toFixed(3)}`;
    bar!.style.height = `${scroll.p * 100}%`;
  });
}

// --- AgX ramp verification (?scene=ramp) ------------------------------------------------
// Renders 13 neutral swatches (linear 0.18·2^k, k −6…+6) through the full AgX/sRGB output
// and probes them: monotonic non-decreasing, neutral within 2/255, floor ≈ 0, top ≥ 250.

async function runRamp(): Promise<void> {
  const ramp = buildRamp();
  const size = fitViewport();
  ramp.camera.aspect = size.w / size.h;
  ramp.camera.updateProjectionMatrix();
  for (const s of ramp.swatches) s.ndc.copy(s.mesh.position).project(ramp.camera);

  for (let i = 0; i < 3; i++) await renderer.renderAsync(ramp.scene, ramp.camera);
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
  const lowest = rows[0]?.out[0] ?? 255;
  const highest = rows[rows.length - 1]?.out[0] ?? 0;
  if (lowest > 8) {
    ok = false;
    problems.push(`floor too high: ${lowest}`);
  }
  if (highest < 250) {
    ok = false;
    problems.push(`top not reaching white: ${highest}`);
  }

  const table = rows
    .map((r) => `lin ${r.input.toExponential(2)} → srgb ${r.out[0]}`)
    .join('\n');
  const mid = rows[6]; // k = 0 → linear 0.18
  capEl!.textContent = `AgX ramp ${ok ? 'OK' : 'FAIL'} · 0.18 → ${mid ? mid.out[0] : '?'}/255\n${table}\n${problems.join('\n')}`;
  console.info(`[ramp] ${ok ? 'OK' : 'FAIL'}\n${table}`);
  window.__capture = { hash: frame.hash, p: -1, tier, backend, dataUrl: frame.dataUrl, ramp: rows, rampOk: ok };
}
