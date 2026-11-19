'use strict';

/**
 * Photoshop smart-object geometry, reproduced.
 *
 * A placed layer maps its content (width x height px) to the document in two steps:
 *   1. warp      - a grid of cubic Bezier patches ("custom" / split warp). The mesh has
 *                  3*nx+1 columns and 3*ny+1 rows of control points in content space.
 *                  quiltSliceX / quiltSliceY give the content-space edges of each patch
 *                  (a plain custom warp is one 4x4 patch over the bounds).
 *   2. transform - the 4 corners (TL, TR, BR, BL) the content bounds land on, i.e. a
 *                  perspective (homography) map from the bounds rectangle to that quad.
 * forward(u, v) gives the document position of content pixel (u, v).
 *
 * Which content rectangle the transform corners frame is not the same in every PSD, nor for
 * every layer of one PSD: 'mesh' = the warp's control-point box (all of the Creatsy stack),
 * 'bounds' = the content bounds, 'union' = both, 'surface' = the warped surface's own box.
 * import-psd.js tries each per layer and keeps the one that matches Photoshop's composite.
 */
const FRAMES = ['mesh', 'bounds', 'union', 'surface'];

function homography(src, dst) {
  // solve the 8 unknowns mapping 4 src points to 4 dst points
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return (x, y) => {
    const z = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z];
  };
}

const bern = (t) => {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
};

function sliceAt(edges, x) {
  let i = 0;
  while (i < edges.length - 2 && x > edges[i + 1]) i++;
  const a = edges[i], b = edges[i + 1];
  return [i, (x - a) / (b - a || 1)];
}

function placedMapper(placed, frame = process.env.WARP_FRAME || 'mesh') {
  const W = placed.width, H = placed.height;
  const w = placed.warp || {};
  const bounds = w.bounds
    ? [w.bounds.left.value, w.bounds.top.value, w.bounds.right.value, w.bounds.bottom.value]
    : [0, 0, W, H];
  const [bl, bt, br, bb] = bounds;
  const t = placed.transform;
  // the transform corners frame the WARPED content: map the mesh's bounding box, not the bounds
  let fl = bl, ft = bt, fr = br, fb = bb;
  let warp = (u, v) => [u, v];
  const env = w.customEnvelopeWarp;
  if (w.style === 'custom' && env && env.meshPoints) {
    const cols = w.deformNumCols || 4, rows = w.deformNumRows || 4;
    const nx = (cols - 1) / 3, ny = (rows - 1) / 3;
    const uniform = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
    // the outer slice edges are stored padded by 0.6px; the content still spans the bounds
    const xs = env.quiltSliceX ? env.quiltSliceX.slice() : uniform(bl, br, nx);
    const ys = env.quiltSliceY ? env.quiltSliceY.slice() : uniform(bt, bb, ny);
    xs[0] = bl; xs[xs.length - 1] = br; ys[0] = bt; ys[ys.length - 1] = bb;
    const P = env.meshPoints;
    warp = (u, v) => {
      const [i, s] = sliceAt(xs, u);
      const [j, r] = sliceAt(ys, v);
      const bu = bern(s), bv = bern(r);
      let x = 0, y = 0;
      for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
        const p = P[(3 * j + b) * cols + 3 * i + a];
        const k = bu[a] * bv[b];
        x += k * p.x; y += k * p.y;
      }
      return [x, y];
    };
    if (frame === 'mesh') {
      fl = Math.min(...P.map((p) => p.x)); fr = Math.max(...P.map((p) => p.x));
      ft = Math.min(...P.map((p) => p.y)); fb = Math.max(...P.map((p) => p.y));
    } else if (frame === 'union') {
      fl = Math.min(bl, ...P.map((p) => p.x)); fr = Math.max(br, ...P.map((p) => p.x));
      ft = Math.min(bt, ...P.map((p) => p.y)); fb = Math.max(bb, ...P.map((p) => p.y));
    } else if (frame === 'surface') {
      // bounding box of the warped surface itself (control points can lie outside it)
      fl = fr = ft = fb = NaN;
      const N = 400;
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        if (j !== 0 && j !== N && i !== 0 && i !== N && (i + j) % 7) continue;
        const [x, y] = warp(bl + ((br - bl) * i) / N, bt + ((bb - bt) * j) / N);
        if (!(x >= fl)) fl = Math.min(x, isNaN(fl) ? x : fl);
        fl = isNaN(fl) ? x : Math.min(fl, x); fr = isNaN(fr) ? x : Math.max(fr, x);
        ft = isNaN(ft) ? y : Math.min(ft, y); fb = isNaN(fb) ? y : Math.max(fb, y);
      }
    }
  }
  const toDoc = homography([[fl, ft], [fr, ft], [fr, fb], [fl, fb]], [[t[0], t[1]], [t[2], t[3]], [t[4], t[5]], [t[6], t[7]]]);
  // affine form of toDoc at the frame corners: x' = a*x + b*y + c, y' = d*x + e*y + f
  const p0 = toDoc(fl, ft), p1 = toDoc(fr, ft), p3 = toDoc(fl, fb);
  const a = (p1[0] - p0[0]) / (fr - fl), d = (p1[1] - p0[1]) / (fr - fl);
  const b = (p3[0] - p0[0]) / (fb - ft), e = (p3[1] - p0[1]) / (fb - ft);
  const affine = [a, b, p0[0] - a * fl - b * ft, d, e, p0[1] - d * fl - e * ft];
  const withAffine = (m) => ({ width: W, height: H, warp, affine: m, forward: (u, v) => { const [x, y] = warp(u, v); return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]; } });
  return { width: W, height: H, warp, affine, withAffine, forward: (u, v) => { const [x, y] = warp(u, v); return toDoc(x, y); } };
}

/**
 * Inverse map by forward tessellation: every output pixel covered by the warped
 * content gets the content (u, v) it shows. Output space = (doc - origin) * scale.
 * Returns {u: Float32Array, v: Float32Array, hit: Uint8Array} sized W x H.
 * vPad (content px) continues the warp past both long edges of the strip (the Bezier patches
 * extrapolate smoothly), giving v < 0 or v > height there; 0 keeps to the content.
 */
function rasterizeUV(mapper, W, H, origin, scale, step = 4, vPad = 0) {
  const u = new Float32Array(W * H), v = new Float32Array(W * H), hit = new Uint8Array(W * H);
  const nu = Math.ceil(mapper.width / step), nv = Math.ceil((mapper.height + 2 * vPad) / Math.min(step, mapper.height / 24));
  const pts = [];
  for (let j = 0; j <= nv; j++) {
    const row = [];
    for (let i = 0; i <= nu; i++) {
      const cu = (mapper.width * i) / nu, cv = -vPad + ((mapper.height + 2 * vPad) * j) / nv;
      const [x, y] = mapper.forward(cu, cv);
      row.push([(x - origin[0]) * scale, (y - origin[1]) * scale, cu, cv]);
    }
    pts.push(row);
  }
  const tri = (A, B, C) => {
    const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    if (minX > maxX || minY > maxY) return;
    const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (Math.abs(area) < 1e-9) return;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) / area;
      const w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const i = y * W + x;
      u[i] = w0 * A[2] + w1 * B[2] + w2 * C[2];
      v[i] = w0 * A[3] + w1 * B[3] + w2 * C[3];
      hit[i] = 1;
    }
  };
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = pts[j][i], b = pts[j][i + 1], c = pts[j + 1][i + 1], d = pts[j + 1][i];
    tri(a, b, c); tri(a, c, d);
  }
  return { u, v, hit };
}

module.exports = { homography, placedMapper, rasterizeUV, FRAMES };
