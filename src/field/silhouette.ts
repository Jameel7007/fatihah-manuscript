// Flat silhouette — §5. Deterministic build-time perimeter profile: rounded rectangle with
// per-corner radii, 24-point Catmull-Rom offset profile (12 salient + 12 zero midpoints),
// two-octave value noise, chip + notch. The result is baked as per-vertex (u, v) params:
// boundary rings evaluate the field slightly inside the nominal rectangle, so the outline is
// geometric — shadows, translucency, and the ribbon stay consistent.

export const GRID_W = 192; // vertices across u
export const GRID_H = 256; // vertices along v

const SHEET_W = 0.78;
const SHEET_H = 1.0;

// Salient offset points (t along perimeter, clockwise from top-left corner; §5 table).
const SALIENT: ReadonlyArray<readonly [number, number]> = [
  [0.045, -0.0028],
  [0.19, 0.0032],
  [0.3, -0.0041],
  [0.415, 0.002],
  [0.48, -0.0022],
  [0.7, 0.0026],
  [0.8, -0.0036],
  [0.9, 0.0018],
];
const CHIP = { t: 0.13, depth: 0.0055, width: 0.021 / (2 * (SHEET_W + SHEET_H)) };
const NOTCH = { t: 0.61, depth: 0.008, width: 0.034 / (2 * (SHEET_W + SHEET_H)) };

/** Deterministic value noise on t ∈ [0,1), periodic. */
function valueNoise(t: number, freq: number, seed: number): number {
  const x = t * freq;
  const i = Math.floor(x);
  const f = x - i;
  const hash = (n: number): number => {
    const s = Math.sin((((n % freq) + freq) % freq) * 127.1 + seed * 311.7) * 43758.5453;
    return 2 * (s - Math.floor(s)) - 1;
  };
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

/** Closed centripetal-ish Catmull-Rom over 24 points (uniform here — offsets are small). */
function crOffset(t: number): number {
  const pts: Array<[number, number]> = [];
  for (const [st, sv] of SALIENT) pts.push([st, sv]);
  for (let i = 0; i < SALIENT.length; i++) {
    const a = SALIENT[i];
    const b = SALIENT[(i + 1) % SALIENT.length];
    if (!a || !b) continue;
    const mid = (a[0] + (b[0] < a[0] ? b[0] + 1 : b[0])) / 2;
    pts.push([mid % 1, 0]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    const pk = pts[k];
    if (pk && pk[0] <= t) i = k;
  }
  const get = (k: number): [number, number] => {
    const q = pts[((k % n) + n) % n];
    return q ? [q[0], q[1]] : [0, 0];
  };
  const p0 = get(i - 1);
  const p1 = get(i);
  const p2 = get(i + 1);
  const p3 = get(i + 2);
  const span = (p2[0] - p1[0] + 1) % 1 || 1e-6;
  const lt = Math.max(0, Math.min(1, ((t - p1[0] + 1) % 1) / span));
  const t2 = lt * lt;
  const t3 = t2 * lt;
  // uniform Catmull-Rom on values
  return (
    0.5 *
    (2 * p1[1] +
      (-p0[1] + p2[1]) * lt +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
  );
}

function flaw(t: number, f: { t: number; depth: number; width: number }): number {
  const d = Math.abs(t - f.t);
  if (d > f.width) return 0;
  const x = d / f.width;
  return -f.depth * (1 - x * x) * (1 - x * x); // soft-walled wedge
}

/** Inward offset (world units, positive = inward) at perimeter parameter t. */
export function perimeterInset(t: number): number {
  let off = -crOffset(t); // table offsets: negative = inward → inset positive
  off -= valueNoise(t, Math.round(1 / 0.018), 7) * 0.0016;
  off -= valueNoise(t, Math.round(1 / 0.006), 13) * 0.0007;
  off -= flaw(t, CHIP);
  off -= flaw(t, NOTCH);
  return Math.max(0, off); // never outset past the nominal rectangle
}

export interface SilhouetteData {
  /** RG param pairs per texel: the (u ∈ [−0.5, 0.5], v ∈ [0, 1]) the field evaluates. */
  params: Float32Array;
  /** boundary ring texel indices (x, y), ordered clockwise from top-left — ribbon source. */
  ring: Array<[number, number]>;
}

/** Per-corner radii §2: TL 0.016 (with nick via noise), TR 0.010, BR 0.008, BL 0.019. */
function cornerInset(u: number, v: number): number {
  const corners: Array<[number, number, number]> = [
    [-0.5, 0, 0.016],
    [0.5, 0, 0.01],
    [0.5, 1, 0.008],
    [-0.5, 1, 0.019],
  ];
  let inset = 0;
  for (const [cu, cv, r] of corners) {
    const dx = Math.abs(u - cu) * SHEET_W;
    const dy = Math.abs(v - cv) * SHEET_H;
    if (dx < r && dy < r) {
      const q = Math.sqrt((r - dx) ** 2 + (r - dy) ** 2) - r;
      if (q > 0) inset = Math.max(inset, q);
    }
  }
  return inset;
}

export function buildSilhouette(): SilhouetteData {
  const params = new Float32Array(GRID_W * GRID_H * 2);
  const ring: Array<[number, number]> = [];

  // ring order: top row →, right col ↓, bottom row ←, left col ↑ (clockwise, matches t)
  for (let i = 0; i < GRID_W; i++) ring.push([i, 0]);
  for (let j = 1; j < GRID_H; j++) ring.push([GRID_W - 1, j]);
  for (let i = GRID_W - 2; i >= 0; i--) ring.push([i, GRID_H - 1]);
  for (let j = GRID_H - 2; j >= 1; j--) ring.push([0, j]);

  const FALLOFF = [1, 0.5, 0.2]; // rings 0/1/2 share the inset with falloff

  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      let u = i / (GRID_W - 1) - 0.5;
      let v = j / (GRID_H - 1);
      const db = Math.min(i, j, GRID_W - 1 - i, GRID_H - 1 - j);
      if (db < FALLOFF.length) {
        // nearest boundary: [distance in texels, inward dir, perimeter arc position]
        const dirs: Array<[number, [number, number], number]> = [
          [j, [0, 1], (i / (GRID_W - 1)) * SHEET_W],
          [GRID_W - 1 - i, [-1, 0], SHEET_W + (j / (GRID_H - 1)) * SHEET_H],
          [GRID_H - 1 - j, [0, -1], SHEET_W + SHEET_H + (1 - i / (GRID_W - 1)) * SHEET_W],
          [i, [1, 0], 2 * SHEET_W + SHEET_H + (1 - j / (GRID_H - 1)) * SHEET_H],
        ];
        dirs.sort((a, b) => a[0] - b[0]);
        const nearest = dirs[0];
        if (nearest) {
          const PER = 2 * (SHEET_W + SHEET_H);
          const t = nearest[2] / PER;
          const inset = (perimeterInset(t) + cornerInset(u, v)) * (FALLOFF[db] ?? 0);
          u += (nearest[1][0] * inset) / SHEET_W;
          v += (nearest[1][1] * inset) / SHEET_H;
        }
      }
      params[(j * GRID_W + i) * 2] = u;
      params[(j * GRID_W + i) * 2 + 1] = v;
    }
  }
  return { params, ring };
}
