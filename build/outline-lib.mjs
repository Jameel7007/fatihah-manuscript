// Shared outline machinery — extracted VERBATIM from build-ink-atlas.mjs (M4) so the
// flat-ink SDF and the §6 bevel extrusion consume the identical flattened polylines
// (§14/§17 alignment guarantee, made structural). Any change here invalidates BOTH the
// ink atlases and glyphs.bin — rebuild and re-verify checksums together.

/** Parse a font path string (M/L/Q/C/Z) into contours of L/Q edges; C flattened to 16 lines. */
export function parsePath(d) {
  const nums = [];
  const cmds = [];
  const re = /([MLQCZ])|(-?\d*\.?\d+(?:e-?\d+)?)/gi;
  let m;
  while ((m = re.exec(d))) {
    if (m[1]) cmds.push({ c: m[1].toUpperCase(), i: nums.length });
    else nums.push(parseFloat(m[2]));
  }
  const contours = [];
  let cur = null;
  let pen = [0, 0];
  let start = [0, 0];
  for (let k = 0; k < cmds.length; k++) {
    const { c, i } = cmds[k];
    const argOf = (j) => [nums[i + j], nums[i + j + 1]];
    if (c === 'M') {
      if (cur && cur.length) contours.push(cur);
      cur = [];
      pen = argOf(0);
      start = pen;
    } else if (c === 'L') {
      const p1 = argOf(0);
      cur.push({ t: 'L', p: [pen, p1] });
      pen = p1;
    } else if (c === 'Q') {
      const pc = argOf(0);
      const p1 = argOf(2);
      cur.push({ t: 'Q', p: [pen, pc, p1] });
      pen = p1;
    } else if (c === 'C') {
      const c1 = argOf(0);
      const c2 = argOf(2);
      const p1 = argOf(4);
      let prev = pen;
      for (let s = 1; s <= 16; s++) {
        const t = s / 16;
        const u = 1 - t;
        const x = u * u * u * pen[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0];
        const y = u * u * u * pen[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1];
        cur.push({ t: 'L', p: [prev, [x, y]] });
        prev = [x, y];
      }
      pen = p1;
    } else if (c === 'Z') {
      if (cur && (pen[0] !== start[0] || pen[1] !== start[1])) cur.push({ t: 'L', p: [pen, start] });
      pen = start;
    }
  }
  if (cur && cur.length) contours.push(cur);
  return contours.filter((ct) => ct.length > 0);
}

export const evalEdge = (e, t) => {
  if (e.t === 'L') {
    const [a, b] = e.p;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  const [a, c, b] = e.p;
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
};

export const derivEdge = (e, t) => {
  if (e.t === 'L') {
    const [a, b] = e.p;
    return [b[0] - a[0], b[1] - a[1]];
  }
  const [a, c, b] = e.p;
  return [2 * ((1 - t) * (c[0] - a[0]) + t * (b[0] - c[0])), 2 * ((1 - t) * (c[1] - a[1]) + t * (b[1] - c[1]))];
};

/** Nearest param on an edge to point q (clamped to [0,1]). */
export function nearestT(e, q) {
  if (e.t === 'L') {
    const [a, b] = e.p;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy || 1e-12;
    return Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
  }
  // quadratic: coarse scan + Newton on d²(t)
  let bt = 0;
  let bd = Infinity;
  for (let s = 0; s <= 16; s++) {
    const t = s / 16;
    const p = evalEdge(e, t);
    const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    if (d < bd) {
      bd = d;
      bt = t;
    }
  }
  for (let it = 0; it < 4; it++) {
    const p = evalEdge(e, bt);
    const dp = derivEdge(e, bt);
    const rx = p[0] - q[0];
    const ry = p[1] - q[1];
    const [a, c, b] = e.p;
    const ddx = 2 * (b[0] - 2 * c[0] + a[0]);
    const ddy = 2 * (b[1] - 2 * c[1] + a[1]);
    const f = rx * dp[0] + ry * dp[1];
    const fp = dp[0] * dp[0] + dp[1] * dp[1] + rx * ddx + ry * ddy;
    if (Math.abs(fp) < 1e-12) break;
    bt = Math.max(0, Math.min(1, bt - f / fp));
  }
  return bt;
}

/** Signed (by edge orientation) true + pseudo distance of q to edge. */
export function edgeDistance(e, q) {
  const t = nearestT(e, q);
  const p = evalEdge(e, t);
  const rx = q[0] - p[0];
  const ry = q[1] - p[1];
  const trueD = Math.hypot(rx, ry);
  const dp = derivEdge(e, t < 1e-6 ? 0 : t > 1 - 1e-6 ? 1 : t);
  const dl = Math.hypot(dp[0], dp[1]) || 1e-12;
  const cross = (dp[0] * ry - dp[1] * rx) / dl;
  const sign = cross >= 0 ? 1 : -1;
  let pseudo = trueD;
  if (t < 1e-6 || t > 1 - 1e-6) {
    // endpoint: rank by the perpendicular distance to the tangent extension (msdfgen)
    pseudo = Math.abs(cross);
  }
  const ortho = Math.abs(cross) / Math.max(trueD, 1e-9); // 1 = perpendicular hit
  return { trueD, pseudo: pseudo * sign, ortho, t };
}

/** Nonzero winding number at q (jittered off exact degeneracies by the caller). */
export function winding(contours, q) {
  let w = 0;
  const px = q[0];
  const py = q[1];
  for (const ct of contours) {
    for (const e of ct) {
      if (e.t === 'L') {
        const [a, b] = e.p;
        const y0 = a[1];
        const y1 = b[1];
        if (y0 === y1) continue;
        if ((py >= Math.min(y0, y1)) && (py < Math.max(y0, y1))) {
          const t = (py - y0) / (y1 - y0);
          const x = a[0] + (b[0] - a[0]) * t;
          if (x > px) w += y1 > y0 ? 1 : -1;
        }
      } else {
        const [a, c, b] = e.p;
        const A = a[1] - 2 * c[1] + b[1];
        const B = 2 * (c[1] - a[1]);
        const C = a[1] - py;
        const roots = [];
        if (Math.abs(A) < 1e-12) {
          if (Math.abs(B) > 1e-12) roots.push(-C / B);
        } else {
          const disc = B * B - 4 * A * C;
          if (disc >= 0) {
            const sq = Math.sqrt(disc);
            roots.push((-B + sq) / (2 * A), (-B - sq) / (2 * A));
          }
        }
        for (const t of roots) {
          if (t < 0 || t >= 1) continue;
          const x = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0];
          const dy = derivEdge(e, t)[1];
          if (Math.abs(dy) < 1e-12) continue;
          if (x > px) w += dy > 0 ? 1 : -1;
        }
      }
    }
  }
  return w;
}
