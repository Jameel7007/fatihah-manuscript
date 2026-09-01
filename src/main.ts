import { Color, PerspectiveCamera, REVISION } from 'three/webgpu';
import { createRenderer } from './core/renderer';
import { DPR_CAP, DUST_SCALE, detectTier, TierMonitor } from './core/tiers';
import { CameraRig } from './director/camera';
import { blobTilt, contactRamp, embossFactor, envYawDeg, FACE_CENTER_REST, faceFactor, facePitch, fillFactor, geoDepth, inkGhost, keyConeDeg, keyFactor, parchmentKeyMask, poseTransform, recede, rimFactor, RISE_START, stateLabel } from './director/drivers';
import { IdleController, type IdleState } from './director/idle';
import { ReducedMotion } from './director/reduced';
import { Vector3 } from 'three/webgpu';
import { ScrollDriver, SCROLL_DENSITY_TOTAL } from './director/scroll';
import { evalDeform } from './field/deform';
import { Field } from './field/field';
import { Residual } from './field/residual';
import { buildSilhouette } from './field/silhouette';
import { buildRamp, buildStage, KEY_INTENSITY, type DebugMode } from './look/stage';
import { createGrade } from './look/grade';
import { captureFrame, samplePixel, type CaptureFrame } from './qa/capture';
import { flickProfile, runProbes, runStorm, sampleResidualEnergy, type ProbeReport } from './qa/probes';
import { WRITING, buildSchedule } from './director/writing';
import { loadInk } from './ink/atlas';
import { loadGlyphBin } from './relief/mesh';

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
const isCapture = captureP !== null || probeP !== null || sceneMode === 'ramp' || sceneMode === 'inkrt' || calibrate !== null;
const capW = Number(q.get('w') ?? 1440);
const capH = Number(q.get('h') ?? 900);
// frames rendered before the capture readback (&warm=N). LEARNED at M6: three frames raced
// the WebGPU backend's async pipeline compiles — R-1.00 hashed three different ways across
// cold loads until the warm-up covered them; 15 frames settle every state (M6, 2026-09-01).
const captureWarm = Math.max(1, Number(q.get('warm') ?? 15));

const canvas = document.querySelector<HTMLCanvasElement>('#gl');
const hud = document.querySelector<HTMLDivElement>('#hud');
const bar = document.querySelector<HTMLDivElement>('#bar');
const capEl = document.querySelector<HTMLDivElement>('#cap');
const spacer = document.querySelector<HTMLDivElement>('#spacer');
if (!canvas || !hud || !bar || !capEl || !spacer) throw new Error('missing DOM scaffolding');

const coarse = matchMedia('(pointer: coarse)').matches;
const flatPage = isCapture || sceneMode === 'proof' || sceneMode === 'reveal';
spacer.style.height = flatPage ? '0' : `${Math.round((coarse ? 6.5 : 8) * 100 * SCROLL_DENSITY_TOTAL) + 100}vh`;
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
} else if (sceneMode === 'inkrt') {
  await runInkRT();
} else if (sceneMode === 'reveal') {
  await runReveal();
} else if (sceneMode === 'proof') {
  await runProof();
} else if (calibrate !== null) {
  await runCalibrate(calibrate);
} else {
  await runMain();
}

// --- flat ink-RT view (?scene=inkrt&p=P) — the M3 ink layer rendered 1:1 in sheet uv,
// no pose, no lighting, no grade: R = coverage, G = wetness. QA instrument for the wet
// trail, reveal edges, and (M4/M5) the puff/emboss channels. Captures like any scene. ---

async function runInkRT(): Promise<void> {
  const { buildFiberTexture } = await import('./look/textures');
  const { InkPass } = await import('./ink/inkPass');
  const { Scene, Mesh, PlaneGeometry, MeshBasicNodeMaterial, OrthographicCamera } = await import('three/webgpu');
  const { texture, uv, vec2, vec4, float } = await import('three/tsl');
  const pack = await loadInk();
  const pass = new InkPass(pack, buildFiberTexture(renderer));
  const p = Math.min(1, Math.max(0, Number(q.get('p') ?? '0.45')));

  const size = fitViewport();
  const scene = new Scene();
  const mat = new MeshBasicNodeMaterial();
  // RAW channels — the boot renderer carries AgX (the ?scene=ramp contract), and AgX's
  // inset matrix bleeds R into G, which reads as phantom wetness in this instrument.
  // material.toneMapped=false is IGNORED on this path in three r185 — switch the
  // renderer itself off (restored irrelevant: this scene owns the renderer till reload)
  const { NoToneMapping } = await import('three/webgpu');
  renderer.toneMapping = NoToneMapping;
  mat.toneMapped = false;
  // display comp-top at screen-top (quad uv v=0 is at the bottom)
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const suv: any = vec2((uv() as any).x, float(1).sub((uv() as any).y));
  const t: any = texture(pass.texture, suv);
  mat.colorNode = vec4(t.r, t.g, float(0.06), 1);
  const quad = new Mesh(new PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  scene.add(quad);
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  void size;

  await new Promise<void>((resolve) => {
    let n = 0;
    renderer.setAnimationLoop(() => {
      pass.run(renderer, p);
      renderer.render(scene, cam);
      if (++n >= 3) {
        renderer.setAnimationLoop(null);
        resolve();
      }
    });
  });
  if (isCapture || q.get('save') !== null) {
    const frame = await captureFrame(canvas as HTMLCanvasElement);
    window.__capture = { hash: frame.hash, p, tier, backend, dataUrl: frame.dataUrl };
    capEl!.textContent = `inkrt p=${p} ${frame.hash.slice(0, 16)}`;
  }
  hud!.textContent = `ink RT · p ${p.toFixed(3)} · R=cov G=wet`;
}

// --- text proof (?scene=proof) — frozen composition large, dark on white, with āyah
// numerals; &export=1 additionally posts a 4000-px-wide PNG to the qa-save sink -----------

async function runProof(): Promise<void> {
  interface PGlyph {
    x: number;
    y: number;
    scale: number;
    path: string;
  }
  interface PLine {
    ayahs: number[];
    em: number;
    glyphs: PGlyph[];
    markers: Array<{ x: number; y: number; ayah: number }>;
    fillers?: Array<{ x: number; y: number; r: number }>;
  }
  const layoutQ = q.get('layout'); // 7 | 8 | (absent = active composition)
  const compFile = layoutQ === '7' ? 'composition-7line.json' : layoutQ === '8' ? 'composition-8line.json' : 'composition.json';
  const comp = (await (await fetch(`/text/${compFile}`)).json()) as {
    layout: string;
    checksums: { svg: string };
    em: number;
    marker?: { path: string; upem?: number };
    lines: PLine[];
  };
  const compAny = comp;
  const parchment = q.get('bg') === 'parchment';
  (canvas as HTMLCanvasElement).style.display = 'none';
  document.body.style.overflow = 'auto';

  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const arNum = (n: number): string => String(n).split('').map((d) => AR_DIGITS[+d] ?? d).join('');

  // §7-recipe parchment ground, ported to 2D for the judgment proof: value-noise fbm —
  // fiber grain (340, 280) + undulation (36, 30) + macro discoloration 3.1 + blotch 7.0 +
  // the two §15 stains, over the base #E6D5AF. Computed once at 2000 px and rescaled.
  let parchCache: HTMLCanvasElement | null = null;
  const parchmentCanvas = (): HTMLCanvasElement => {
    if (parchCache) return parchCache;
    const NW = 2000;
    const NH = Math.round(NW / 0.78);
    const cv = document.createElement('canvas');
    cv.width = NW;
    cv.height = NH;
    const c2 = cv.getContext('2d')!;
    const img = c2.createImageData(NW, NH);
    const hash = (xi: number, yi: number): number => {
      let h = (Math.imul(xi, 374761393) + Math.imul(yi, 668265263)) ^ 0x5bf03635;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const sm = (t: number): number => t * t * (3 - 2 * t);
    const vnoise = (x: number, y: number): number => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = sm(x - xi);
      const fy = sm(y - yi);
      const a = hash(xi, yi);
      const b = hash(xi + 1, yi);
      const c = hash(xi, yi + 1);
      const d = hash(xi + 1, yi + 1);
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
    const fbm4 = (x: number, y: number): number => {
      let v = 0;
      let amp = 0.5;
      let fx = x;
      let fy = y;
      for (let o = 0; o < 4; o++) {
        v += amp * vnoise(fx, fy);
        fx = fx * 2.03 + 11.31;
        fy = fy * 2.03 + 7.77;
        amp *= 0.5;
      }
      return v;
    };
    const data = img.data;
    for (let py = 0; py < NH; py++) {
      const v = py / NH;
      for (let px = 0; px < NW; px++) {
        const u = px / NW;
        const grain = fbm4(u * 340, v * 280);
        const undul = fbm4(u * 36 + 7.7, v * 30 + 7.7);
        const macro = fbm4(u * 3.1, v * 3.1);
        const blotch = fbm4(u * 7 + 11.7, v * 7 + 11.7);
        const h = grain * 0.6 + undul * 0.32;
        let tone = 1 + (macro - 0.5) * 0.13 + (blotch - 0.5) * 0.07 - (h - 0.5) * 0.09;
        // §15 stains (lower-left quadrant), soft warm-brown multiply
        const d1 = Math.hypot(u - 0.26, v - 0.71);
        const d2 = Math.hypot(u - 0.37, v - 0.79);
        const st = Math.max(Math.max(0, 1 - d1 / 0.062), 0.8 * Math.max(0, 1 - d2 / 0.09));
        // aged edges
        const e = Math.min(u, 1 - u, v, 1 - v);
        tone *= 1 - 0.1 * (1 - Math.min(1, e / 0.045));
        const i = (py * NW + px) * 4;
        data[i] = 230 * tone * (1 - 0.14 * st);
        data[i + 1] = 213 * tone * (1 - 0.2 * st);
        data[i + 2] = 175 * tone * (1 - 0.28 * st);
        data[i + 3] = 255;
      }
    }
    c2.putImageData(img, 0, 0);
    parchCache = cv;
    return cv;
  };

  const draw = (cv: HTMLCanvasElement | OffscreenCanvas, widthPx: number): void => {
    const S = widthPx / 0.78;
    const H = Math.round(S * 1.0);
    cv.width = widthPx;
    cv.height = H;
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
    if (parchment) {
      ctx.drawImage(parchmentCanvas(), 0, 0, widthPx, H);
    } else {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, widthPx, H);
    }
    const X = (wx: number): number => (wx + 0.39) * S;
    const Y = (wy: number): number => wy * S;
    const em = comp.em;
    for (const l of comp.lines) {
      ctx.fillStyle = parchment ? '#2A211B' : '#14100C';
      for (const g of l.glyphs) {
        ctx.save();
        ctx.translate(X(g.x), Y(g.y));
        ctx.scale(g.scale * S, -g.scale * S);
        ctx.fill(new Path2D(g.path));
        ctx.restore();
      }
      for (const mk of l.markers ?? []) {
        ctx.fillStyle = '#8A6D3F';
        if (compAny.marker?.path) {
          // v1.5 drawn rosette — same placement convention as the glyphs (y-up outline)
          const ms = em / (compAny.marker?.upem ?? 1000);
          ctx.save();
          ctx.translate(X(mk.x), Y(mk.y));
          ctx.scale(ms * S, -ms * S);
          ctx.fill(new Path2D(compAny.marker.path), 'nonzero');
          ctx.restore();
        } else {
          ctx.strokeStyle = '#8A6D3F';
          ctx.lineWidth = 0.0276 * em * S;
          ctx.beginPath();
          ctx.arc(X(mk.x), Y(mk.y), 0.1086 * em * S, 0, Math.PI * 2);
          ctx.stroke();
          ctx.font = `${0.1466 * em * S}px "Amiri Quran", "Noto Naskh Arabic", serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(arNum(mk.ayah), X(mk.x), Y(mk.y) + 0.0138 * em * S);
        }
      }
      for (const f of l.fillers ?? []) {
        // gold rosette filler: 8 round-capped petals + center dot
        ctx.strokeStyle = '#8A6D3F';
        ctx.fillStyle = '#8A6D3F';
        ctx.lineWidth = f.r * 0.34 * S;
        ctx.lineCap = 'round';
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          ctx.beginPath();
          ctx.moveTo(X(f.x) + Math.cos(a) * f.r * 0.42 * S, Y(f.y) + Math.sin(a) * f.r * 0.42 * S);
          ctx.lineTo(X(f.x) + Math.cos(a) * f.r * S, Y(f.y) + Math.sin(a) * f.r * S);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(X(f.x), Y(f.y), f.r * 0.24 * S, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  const view = document.createElement('canvas');
  const W = Math.max(360, Math.min(window.innerWidth - 32, 1100));
  view.style.cssText = 'display:block;margin:24px auto;border:1px solid #999;max-width:calc(100vw - 32px)';
  draw(view, W * Math.min(devicePixelRatio, 2));
  view.style.width = `${W}px`;
  document.body.style.background = '#666';
  document.body.appendChild(view);
  hud!.textContent = `text proof — ${comp.layout} · svg ${comp.checksums.svg.slice(0, 12)}${parchment ? ' · parchment ground' : ''}`;

  if (q.get('export') !== null) {
    const hi = document.createElement('canvas');
    draw(hi, 4000);
    const name = `fatihah-proof-${layoutQ ?? 'active'}line${parchment ? '-parchment' : ''}-4000`;
    const blob = await new Promise<Blob | null>((res) => hi.toBlob(res, 'image/png'));
    if (blob) {
      const r = await fetch(`/qa-save?name=${name}`, { method: 'POST', body: blob });
      console.info(`[proof] 4000px export posted: ${r.ok}, ${blob.size} bytes → ${name}`);
      (window as unknown as { __proofExport?: unknown }).__proofExport = { ok: r.ok, bytes: blob.size, name };
    }
  }
}

// --- §17 stroke-order reveal check (?scene=reveal) — M2 DoD item -------------------------
// Animates the writing schedule from the frozen composition over lines 1–2 (nine words:
// loop letters, lām/alif stems, heavy diacritics) on a 2D canvas: bases per word RTL, then
// the word's marks after the Δp delay; within-glyph reveal is an RTL wipe (the true
// skeleton-geodesic w direction arrives with the atlas, M3). Reviewer approves by eye.

async function runReveal(): Promise<void> {
  interface GlyphRec {
    word: number;
    kind: string;
    kashida?: boolean;
    order: number;
    delay: number;
    x: number;
    y: number;
    scale: number;
    ext: { x: number; y: number; w: number; h: number };
    path: string;
  }
  const comp = (await (await fetch('/text/composition.json')).json()) as {
    checksums: { svg: string };
    em: number;
    lines: Array<{ baseline: number; glyphs: GlyphRec[]; markers: Array<{ x: number; y: number }> }>;
  };
  const lines = comp.lines.slice(0, 2);
  const glyphs = lines.flatMap((l, li) => l.glyphs.map((g) => ({ ...g, line: li })));
  // §17 pacing — shared with M3's ink reveal (director/writing.ts)
  const { items: sched, span } = buildSchedule(glyphs);

  // world window around lines 1–2, derived from the frozen composition (baseline0 and
  // pitch are measured values now — never hardcode them here)
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  if (!firstLine || !lastLine) throw new Error('composition has no lines');
  const wx0 = -0.33;
  const wx1 = 0.33;
  const wy0 = firstLine.baseline - 1.35 * comp.em; // mark towers reach ~1.25 em
  const wy1 = lastLine.baseline + 0.8 * comp.em; // descenders ~0.75 em

  const c2 = document.createElement('canvas');
  const W = Math.max(360, Math.min(window.innerWidth - 32, 1280));
  const H = Math.round((W * (wy1 - wy0)) / (wx1 - wx0));
  c2.width = W * devicePixelRatio;
  c2.height = H * devicePixelRatio;
  c2.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:${W}px;height:${H}px;background:#E6D5AF;border:1px solid #2C2517`;
  document.body.appendChild(c2);
  (canvas as HTMLCanvasElement).style.display = 'none';
  const ctx = c2.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const S = W / (wx1 - wx0);
  const X = (x: number): number => (x - wx0) * S;
  const Y = (y: number): number => (y - wy0) * S;

  const paths = new Map<GlyphRec, Path2D>();
  for (const g of glyphs) paths.set(g, new Path2D(g.path));

  const DURATION = span / WRITING.unitsPerSecond; // pacing-derived loop length
  const fixedT = q.get('rt'); // freeze the reveal at a given second (static, screenshotable)
  const draw = (t: number): void => {
    ctx.clearRect(0, 0, W, H);
    const loopT = fixedT !== null ? Number(fixedT) : (t / 1000) % (DURATION + 2.5);
    const wp = loopT * WRITING.unitsPerSecond;
    for (const g of glyphs) {
      const s = sched.get(g.order);
      if (!s) continue;
      const f = Math.max(0, Math.min(1, (wp - s.start) / s.dur)); // within-glyph progress
      if (f <= 0) continue;
      const wet = wp - (s.start + s.dur) < WRITING.wetUnits;
      ctx.save();
      // RTL wipe: clip from the glyph bbox's right edge leftward
      const bx = X(g.x + g.ext.x);
      const by = Y(g.y + g.ext.y);
      const bw = g.ext.w * S;
      const bh = g.ext.h * S;
      ctx.beginPath();
      ctx.rect(bx + bw * (1 - f) - 1, by - 2, bw * f + 3, bh + 4);
      ctx.clip();
      ctx.translate(X(g.x), Y(g.y));
      ctx.scale(g.scale * S, -g.scale * S);
      ctx.fillStyle = wet ? '#17110D' : '#2A211B';
      ctx.fill(paths.get(g) as Path2D);
      ctx.restore();
    }
    for (const l of lines) {
      if (wp < span - 0.5) continue;
      for (const mk of l.markers ?? []) {
        ctx.strokeStyle = '#8F7440';
        ctx.lineWidth = 0.0016 * S;
        ctx.beginPath();
        ctx.arc(X(mk.x), Y(mk.y), 0.0063 * S, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (fixedT === null) requestAnimationFrame(draw);
  };
  if (fixedT !== null) draw(0); // direct draw — rAF may never fire in throttled panes
  else requestAnimationFrame(draw);
  hud!.textContent = `stroke-order reveal — lines 1–2 (9 words) · svg ${comp.checksums.svg.slice(0, 12)}`;
  console.info('[reveal] schedule loaded', { glyphs: glyphs.length, spanUnits: +span.toFixed(1), seconds: +DURATION.toFixed(1) });
}

// --- M2 calibration harnesses (?calibrate=bg | key) -------------------------------------
// Empirical end-to-end solves against the LIVE pipeline (render → readback), so the baked
// constants stay correct whatever the tone/grade chain contains. Results are printed and
// baked by hand into look/stage.ts (BG_LINEAR, KEY_INTENSITY).

async function runCalibrate(mode: string): Promise<void> {
  const sil = buildSilhouette();
  const field = new Field(sil);
  const { scene, sheetRoot, key, setBackground, sky } = buildStage(renderer, field, sil, debugMode);
  if (calibrate === 'key') scene.environmentIntensity = 0; // card under key alone
  sky.uDetail.value = 0; // floor alone — the lobe/nebula/stars ride on top of the solved value
  const size = fitViewport();

  const cam = new PerspectiveCamera((2 * Math.atan(12 / 40) * 180) / Math.PI, size.w / size.h, 0.05, 8);
  cam.position.set(0, 0.9, 0.02);
  cam.lookAt(0, 0, 0.02);

  const d = evalDeform(0.5);
  field.setDeform(d, false);

  // Calibrations run through the FULL grade chain — the solves invert whatever it holds.
  const grade = createGrade(renderer, scene, cam);
  grade.setAspect(size.w / size.h);

  const renderOnce = async (): Promise<[number, number, number]> => {
    await new Promise<void>((resolve) => {
      let n = 0;
      renderer.setAnimationLoop(() => {
        field.run(renderer);
        grade.render();
        if (++n >= 1) {
          renderer.setAnimationLoop(null);
          resolve();
        }
      });
    });
    const frame = await captureFrame(canvas as HTMLCanvasElement);
    // 3×3 average around center — cancels the zero-mean grain/dither
    const acc = [0, 0, 0];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = samplePixel(frame, frame.width / 2 + dx, frame.height / 2 + dy);
        acc[0] = (acc[0] ?? 0) + (px[0] ?? 0);
        acc[1] = (acc[1] ?? 0) + (px[1] ?? 0);
        acc[2] = (acc[2] ?? 0) + (px[2] ?? 0);
      }
    }
    return [(acc[0] ?? 0) / 9, (acc[1] ?? 0) / 9, (acc[2] ?? 0) / 9];
  };

  if (mode === 'bg') {
    sheetRoot.visible = false;
    // target display hex (&target=RRGGBB; default the §11 v1.6 floor #040617)
    const hex = (q.get('target') ?? '040617').replace('#', '');
    const target = [0, 1, 2].map((c) => parseInt(hex.slice(c * 2, c * 2 + 2), 16));
    // Damped 3×3 Newton with numerical Jacobian — AgX's inset matrix mixes channels near
    // black, so per-channel iteration cannot converge. Seed ≈ 2.5× the naive sRGB decode
    // (AgX's toe crushes near-black — the M2 warm solve landed 2–3× naive).
    const lin = target.map((t) => {
      const s = t / 255;
      return 2.5 * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    });
    const evalAt = async (v: number[]): Promise<[number, number, number]> => {
      setBackground(Math.max(0, v[0] ?? 0), Math.max(0, v[1] ?? 0), Math.max(0, v[2] ?? 0));
      return renderOnce();
    };
    let got = await evalAt(lin);
    let J: number[][] | null = null;
    for (let it = 0; it < 12; it++) {
      const err = [0, 1, 2].map((c) => (target[c] ?? 0) - (got[c] ?? 0));
      if (err.every((e) => Math.abs(e) <= 0.75)) break;
      // (Re)build the Jacobian every 4th iteration with probe steps large enough to move
      // the 8-bit readback by whole counts — tiny probes quantize to zero rows and the
      // solve goes singular. Levenberg damping tames the rest.
      if (it % 4 === 0 || J === null) {
        J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let c = 0; c < 3; c++) {
          const h = Math.max(5e-4, (lin[c] ?? 0) * 0.5);
          const v = [...lin];
          v[c] = (v[c] ?? 0) + h;
          const g2 = await evalAt(v);
          for (let r = 0; r < 3; r++) (J[r] as number[])[c] = ((g2[r] ?? 0) - (got[r] ?? 0)) / h;
        }
        const lam = 0.25 * (Math.abs(J[0]?.[0] ?? 0) + Math.abs(J[1]?.[1] ?? 0) + Math.abs(J[2]?.[2] ?? 0)) / 3 + 1e-3;
        for (let c = 0; c < 3; c++) (J[c] as number[])[c] = (J[c]?.[c] ?? 0) + lam;
      }
      const dx = solve3(J, err);
      for (let c = 0; c < 3; c++) {
        const cap = 0.6 * Math.max(lin[c] ?? 0, 5e-4);
        const step = Math.max(-cap, Math.min(cap, (dx[c] ?? 0) * 0.7));
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
  // M3 ink — awaited before the stage builds so capture frames are complete
  const ink = q.get('noink') !== null ? undefined : await loadInk().catch((err: unknown) => {
    console.error('[ink] atlas load failed — rendering without the ink layer', err);
    return undefined;
  });
  // M4 §14 glyph relief mesh (&nogeo: emboss-only — the silhouette-DoD A/B switch)
  const glyphBin = q.get('nogeo') !== null || !ink ? undefined : await loadGlyphBin('/text/glyphs.bin').catch((err: unknown) => {
    console.error('[relief] glyphs.bin load failed — rendering without the glyph mesh', err);
    return undefined;
  });
  const { scene, sheetRoot, key, rim, uEmboss, inkPass, relief, contact, uContact, uGhost, uRecede, uKeyMask, fill, dust, sky } = buildStage(renderer, field, sil, debugMode, ink, glyphBin);
  const fillBase = fill.intensity;
  const keyBaseX = key.position.x;
  // §13 reduced motion (prefers-reduced-motion, or ?reduced=1 for QA): held compositions
  const reducedMotion = q.get('reduced') !== null || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (q.get('noshadow') !== null) key.castShadow = false; // QA: isolate the key's shadow
  const noBlob = q.get('noblob') !== null; // QA: R-1.00-noblob (§8 — PCSS carries S7 alone)
  const rig = new CameraRig();
  const scroll = new ScrollDriver();
  const size = fitViewport();
  rig.camera.aspect = size.w / size.h;
  const grade = createGrade(renderer, scene, rig.camera);
  grade.setAspect(size.w / size.h);

  // §15/§18 designed first frame: the poster (inline LQIP → poster.jpg) holds the screen while
  // every pipeline pre-compiles behind it; the canvas crossfades in over 420 ms only after
  // three real frames have presented. Capture mode bypasses the poster entirely.
  const poster = document.querySelector<HTMLDivElement>('#poster');
  const bootT0 = performance.now();
  if (!isCapture) {
    try {
      await renderer.compileAsync(scene, rig.camera);
    } catch (err) {
      console.warn('[boot] compileAsync unavailable — pipelines compile on first frames', err);
    }
  }
  let presented = 0;
  let posterGone = isCapture;
  const revealCanvas = (now: number): void => {
    if (posterGone) return;
    presented++;
    if (presented < 3) return;
    posterGone = true;
    (canvas as HTMLCanvasElement).style.transition = 'opacity 420ms ease-out';
    (canvas as HTMLCanvasElement).style.opacity = '1';
    if (poster) {
      poster.style.transition = 'opacity 420ms ease-out';
      poster.style.opacity = '0';
      setTimeout(() => poster.remove(), 500);
    }
    const t = (now - bootT0) / 1000;
    (window as unknown as { __boot?: unknown }).__boot = { posterToLive_s: +t.toFixed(2), tier };
    console.info(`[boot] poster → live in ${t.toFixed(2)}s (T${tier})`);
  };
  if (isCapture) {
    (canvas as HTMLCanvasElement).style.opacity = '1';
    poster?.remove();
  }

  // §19 runtime tier monitor: demotion at state boundaries, thermal guard; off in capture
  const tierMon = new TierMonitor(tier);
  let lastState = stateLabel(0);
  // ?perf=N — scrub p 0 → 1 → 0 over N seconds repeatedly and report the frame-time histogram
  const perfS = q.get('perf') !== null ? Number(q.get('perf') ?? '30') : 0;
  const perfTimes: number[] = [];
  let perfT0 = -1;

  window.addEventListener('resize', () => {
    if (isCapture) return;
    const s = fitViewport();
    rig.camera.aspect = s.w / s.h;
    rig.camera.updateProjectionMatrix();
    grade.setAspect(s.w / s.h);
  });

  const IDLE_ZERO: IdleState = { ramp: 0, breath: 0, keyMod: 1, yawDeg: 0, drift: [0, 0, 0] };
  const applyFrame = (p: number, dt: number, simEnabled: boolean, idle: IdleState = IDLE_ZERO, inkP: number = p): void => {
    inkPass?.run(renderer, inkP);
    // §11 sky: one pixel's angle (vfov / drawing-buffer height) keeps the stars ~1 px at any
    // resolution and tier — the same value in capture (DPR 1) as the reference frames expect
    sky.uPxRad.value = ((rig.camera.fov * Math.PI) / 180) / Math.max(1, (canvas as HTMLCanvasElement).height);
    uEmboss.value = embossFactor(p); // §14 relief window (E2 in, E7 fade at the handoff)
    if (relief) {
      // §14 handoff: mesh visible from the window open; depth floored at 0.00045 (z-guard)
      relief.mesh.visible = p >= 0.69;
      relief.uGeoDepth.value = geoDepth(p);
      relief.uP.value = p; // per-cluster rise + transmutation clocks (§10/§14)
      relief.mesh.castShadow = p >= RISE_START; // risen letters cast PCSS (unbiased pipeline)
      relief.uPitch.value = facePitch(p); // §5 S7: pitch to 12° off frontal (E6)
      relief.uLift.value = faceFactor(p); // §5 S7: carry the block center to the rest pose
    }
    uGhost.value = inkGhost(p); // §14 flat-ink ghost 1 → 0.08 over [0.78, 0.84]
    uContact.value = noBlob ? 0 : contactRamp(p) * blobTilt(p); // §8 blob ramp 0.72 → 0.80, faded cos²θ in S7
    const rc = recede(p); // §5 S7: parchment recedes (−0.02 y, −0.10 z at rest)
    (uRecede.value as Vector3).set(rc[0], rc[1], rc[2]);
    uKeyMask.value = parchmentKeyMask(p); // §10 S7 parchment key mask → 0.55
    fill.intensity = fillBase * fillFactor(p); // §10 S7 fill 0.13 → 0.20
    key.angle = (keyConeDeg(p) * Math.PI) / 180; // §8 S7 cone trim 26° → 18°
    {
      // §8 S7: the key (and rim) aim at the standing assembly as it lifts — the trimmed cone
      // must keep the whole text lit while the shadow frustum tightens on it
      const e = faceFactor(p);
      key.target.position.set(0, 0.04 + (FACE_CENTER_REST[1] - 0.04) * e, 0.2 + (FACE_CENTER_REST[2] - 0.2) * e);
      rim.target.position.set(0, FACE_CENTER_REST[1] * e, FACE_CENTER_REST[2] * e);
    }
    key.intensity = KEY_INTENSITY * keyFactor(p) * idle.keyMod; // §10 S3 dim → presenting rise (+§15 idle ±1.5%)
    rim.intensity = KEY_INTENSITY * 0.3 * rimFactor(p); // §10 rim ramp
    field.setBreath(idle.breath); // §15 idle breath (0 outside the armed idle / capture)
    const d = evalDeform(p);
    if (simEnabled) {
      residual.setInputs(dt, scroll.vLpf, d.wTop, d.wBot);
      residual.step(renderer);
      field.bindResidual(residual.freshRT().texture);
    }
    field.setDeform(d, simEnabled);
    field.run(renderer);
    if (relief && contact && !noBlob && p >= 0.7) contact.run(renderer, p); // §8 height-field blob (rise + facing)
    // Pose tilt pivots about the moving top curl line, not the origin — with the rolled
    // mass far from origin (v1.3 start pose), an origin pivot would swing the composition.
    const tr = poseTransform(p, d.zTopCurl);
    sheetRoot.rotation.x = tr.rotX;
    sheetRoot.position.set(0, tr.offY, tr.offZ);
    scene.environmentRotation.y = ((envYawDeg(p) + idle.yawDeg) * Math.PI) / 180;
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
      // M5 DoD "1 draw call": the renderer's per-frame draw count is published after the
      // capture frame (window.__draws) — the merged glyph mesh must add exactly one
      drawsNote: 'see window.__draws after capture',
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
          grade.render(); // grain seed stays 0 in capture — deterministic
          n++;
          if (n >= captureWarm && !started) {
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
                  {
                    const info = (renderer as unknown as { info: { render: { drawCalls?: number; calls?: number; triangles?: number } } }).info.render;
                    (window as unknown as { __draws?: unknown }).__draws = { drawCalls: info.drawCalls ?? info.calls, triangles: info.triangles };
                  }
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

  // §15 idle micro-motion + §9 pointer parallax + dust — all off in reduced motion
  const idle = new IdleController(!reducedMotion);
  rig.parallaxEnabled = !reducedMotion;
  let lastPointer = -1e9;
  let pointerNX = 0;
  window.addEventListener('pointermove', (e) => {
    lastPointer = performance.now();
    pointerNX = (e.clientX / window.innerWidth - 0.5) * 2;
    rig.setPointer(pointerNX, -(e.clientY / window.innerHeight - 0.5) * 2);
  });
  // §13 reduced motion: seven held compositions, camera cuts, 300 ms dissolves, pager dots
  const reduced = reducedMotion
    ? new ReducedMotion(canvas as HTMLCanvasElement, (pState) => {
        scroll.forced = pState;
        rig.snap(pState);
      })
    : null;
  if (reduced) {
    scroll.forced = reduced.p;
    rig.snap(reduced.p);
  }
  // ?hold=N — the p = 1 held-ending audit: pin p = 1, let the idle arm, sample mean canvas
  // luminance once per second for N s, report the flux drift (§20 M6: ≤ 2% over 60 s)
  const holdS = q.get('hold') !== null ? Number(q.get('hold') ?? '60') : 0;
  const holdSamples: number[] = [];
  let holdNext = 0;
  const holdCanvas = document.createElement('canvas');
  holdCanvas.width = 96;
  holdCanvas.height = 60;
  if (holdS > 0) {
    scroll.forced = 1;
    rig.snap(1);
    rig.parallaxEnabled = false;
  }

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

    if (reduced) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      reduced.fromScroll(max > 0 ? window.scrollY / max : 0);
      reduced.tick(now);
    }
    if (perfS > 0) {
      // synthetic scrub: p sweeps 0 → 1 → 0 over perfS seconds (worst pass set every cycle)
      if (perfT0 < 0) perfT0 = now;
      const t = (now - perfT0) / 1000;
      const cyc = (t % perfS) / perfS;
      scroll.forced = cyc < 0.5 ? cyc * 2 : 2 - cyc * 2;
      if (dt > 0 && dt < 0.25) perfTimes.push(dt * 1000);
      if (t >= perfS * 2 && perfTimes.length > 30) {
        const srt = [...perfTimes].sort((a, b) => a - b);
        const pct = (f: number): number => srt[Math.min(srt.length - 1, Math.floor(srt.length * f))] ?? 0;
        (window as unknown as { __perf?: unknown }).__perf = { frames: srt.length, p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2), tier: tierMon.tier, dprCap: tierMon.dprCap };
        capEl!.style.display = 'block';
        capEl!.textContent = `PERF T${tierMon.tier} · ${srt.length} frames · p50 ${pct(0.5).toFixed(1)} ms · p95 ${pct(0.95).toFixed(1)} ms (budget ${tier === 1 ? 12 : tier === 2 ? 14 : 27})`;
        perfTimes.length = 0;
        perfT0 = now;
      }
    }
    scroll.update(dt);
    const moving = Math.abs(scroll.vLpf) > 2e-3 || now - lastPointer < 300;
    const idleState = idle.update(dt, moving && holdS === 0);
    rig.drift = idleState.drift;
    // key light sway ±0.004 world with the pointer (§12), off in reduced motion
    key.position.x = keyBaseX + (reducedMotion ? 0 : 0.004 * pointerNX);
    // reduced motion: ink pre-dried (the trail is evaluated 0.05 ahead), sim off
    applyFrame(scroll.p, dt, !reducedMotion, idleState, reduced ? Math.min(0.64, scroll.p + 0.05) : scroll.p);
    rig.update(scroll.p, dt);
    dust.update(dt, reducedMotion ? 0 : faceFactor(scroll.p) * DUST_SCALE[tierMon.tier]); // §15 dust fades in with the facing state; §19 per-tier population
    grade.setGrainSeed(Math.floor(now / 125)); // 8 Hz grain phase (§16)
    grade.render();
    revealCanvas(now);
    // §19 tier monitor — changes apply only at state-boundary crossings
    {
      const st = stateLabel(scroll.p);
      const atBoundary = st !== lastState;
      lastState = st;
      const change = tierMon.update(dt, atBoundary);
      if (change) {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, change.dprCap));
        fitViewport();
        console.info(`[tier] ${change.reason} → T${change.tier} (dpr cap ${change.dprCap.toFixed(2)})`);
      }
    }
    hud!.textContent = `${stateLabel(scroll.p)} · p ${scroll.p.toFixed(3)}${idleState.ramp > 0 ? ' · idle' : ''}${reduced ? ' · reduced motion' : ''}${tierMon.tier !== tier ? ` · demoted T${tierMon.tier}` : ''}`;
    bar!.style.height = `${scroll.p * 100}%`;

    if (holdS > 0 && now >= holdNext) {
      holdNext = now + 1000;
      const ctx = holdCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvas as HTMLCanvasElement, 0, 0, holdCanvas.width, holdCanvas.height);
        const d = ctx.getImageData(0, 0, holdCanvas.width, holdCanvas.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0);
        holdSamples.push(sum / (d.length / 4));
      }
      if (holdSamples.length >= holdS) {
        const mean = holdSamples.reduce((a, b) => a + b, 0) / holdSamples.length;
        const drift = (Math.max(...holdSamples) - Math.min(...holdSamples)) / (mean || 1);
        (window as unknown as { __hold?: unknown }).__hold = { seconds: holdSamples.length, mean: +mean.toFixed(3), drift: +drift.toFixed(4), samples: holdSamples.map((v) => +v.toFixed(2)) };
        capEl!.style.display = 'block';
        capEl!.textContent = `HOLD p=1 · ${holdSamples.length}s · mean luma ${mean.toFixed(2)} · flux drift ${(drift * 100).toFixed(2)}% (limit 2%)`;
        holdNext = Infinity;
      }
    }
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
