/*
 * Mockup core. Pure pixel math, no DOM, no Node APIs.
 * Runs in the browser (live editor) and in Node (batch export).
 *
 * A template is a fixed photo plus hand-authored geometry:
 *   strap     - a mesh of "rungs" (top edge point, bottom edge point). The real
 *               pattern PNG is mapped along it: pattern x runs along the strap,
 *               pattern y runs across it. Pattern pixels are multiplied by the
 *               photo's own shading, so folds, weave and stitching stay real.
 *   hardware  - polygons (even-odd, so rings can have holes). Photo pixels are
 *               re-toned into gold / rose gold / silver with a metal ramp.
 *   engraving - a 4-corner quad on a buckle face. The engraving image is
 *               perspective-warped into it and etched into the metal.
 *   keep      - polygons copied from the photo untouched (used when the
 *               background is replaced).
 * Nothing here draws a product. It only re-colours the photo's own pixels.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MockupCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FINISH_RAMPS = {
    // [luminance stop, r, g, b]
    gold: [[0, 52, 34, 8], [0.35, 150, 112, 38], [0.7, 226, 190, 105], [0.9, 250, 232, 160], [1, 255, 250, 225]],
    rosegold: [[0, 60, 32, 28], [0.35, 160, 100, 86], [0.7, 228, 168, 146], [0.9, 248, 214, 198], [1, 255, 244, 238]],
    silver: [[0, 22, 23, 26], [0.35, 110, 112, 118], [0.7, 200, 202, 207], [0.9, 236, 237, 240], [1, 255, 255, 255]],
    black: [[0, 8, 8, 9], [0.5, 40, 40, 44], [0.85, 110, 110, 118], [1, 190, 190, 196]],
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  /* ---------------- geometry helpers ---------------- */

  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }

  // Densify rungs with Catmull-Rom on both edges. Returns [{tx,ty,bx,by}]
  function densifyRungs(rungs, step) {
    const n = rungs.length;
    if (n < 2) return [];
    const get = (i) => rungs[clamp(i, 0, n - 1)];
    const out = [];
    for (let i = 0; i < n - 1; i++) {
      const a = get(i - 1), b = get(i), c = get(i + 1), d = get(i + 2);
      const len = Math.max(
        Math.hypot(c[0] - b[0], c[1] - b[1]),
        Math.hypot(c[2] - b[2], c[3] - b[3]),
      );
      const k = Math.max(1, Math.ceil(len / step));
      for (let j = 0; j < k; j++) {
        const t = j / k;
        out.push({
          tx: catmull(a[0], b[0], c[0], d[0], t),
          ty: catmull(a[1], b[1], c[1], d[1], t),
          bx: catmull(a[2], b[2], c[2], d[2], t),
          by: catmull(a[3], b[3], c[3], d[3], t),
        });
      }
    }
    const last = rungs[n - 1];
    out.push({ tx: last[0], ty: last[1], bx: last[2], by: last[3] });
    return out;
  }

  /* ---------------- buffers ---------------- */

  function makeImage(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  function sampleBilinear(img, x, y, wrapX, out) {
    const w = img.width, h = img.height, d = img.data;
    x -= 0.5; y -= 0.5;
    let x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    let x1 = x0 + 1, y1 = y0 + 1;
    if (wrapX) {
      x0 = ((x0 % w) + w) % w; x1 = ((x1 % w) + w) % w;
    } else {
      x0 = clamp(x0, 0, w - 1); x1 = clamp(x1, 0, w - 1);
    }
    y0 = clamp(y0, 0, h - 1); y1 = clamp(y1, 0, h - 1);
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    for (let c = 0; c < 4; c++) {
      const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * fx;
      const bot = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * fx;
      out[c] = top + (bot - top) * fy;
    }
    return out;
  }

  /* ---------------- rasterisers ---------------- */

  // Even-odd polygon coverage with 4x4 supersampling. Returns {x0,y0,w,h,cov:Float32Array}
  function polygonCoverage(rings, W, H) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const edges = [];
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        edges.push([a[0], a[1], b[0], b[1]]);
        minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0]);
        minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1]);
      }
    }
    if (!edges.length) return null;
    const x0 = clamp(Math.floor(minX) - 1, 0, W), x1 = clamp(Math.ceil(maxX) + 1, 0, W);
    const y0 = clamp(Math.floor(minY) - 1, 0, H), y1 = clamp(Math.ceil(maxY) + 1, 0, H);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const cov = new Float32Array(w * h);
    const SS = 4;
    const xs = [];
    for (let py = y0; py < y1; py++) {
      for (let sy = 0; sy < SS; sy++) {
        const y = py + (sy + 0.5) / SS;
        xs.length = 0;
        for (const e of edges) {
          const [ax, ay, bx, by] = e;
          if ((ay <= y && by > y) || (by <= y && ay > y)) {
            xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
          }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        const row = (py - y0) * w;
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const sa = clamp(xs[k], x0, x1), sb = clamp(xs[k + 1], x0, x1);
          if (sb <= sa) continue;
          const ia = Math.floor(sa), ib = Math.floor(sb);
          const add = 1 / SS;
          if (ia === ib) {
            if (ia < x1) cov[row + ia - x0] += (sb - sa) * add;
            continue;
          }
          cov[row + ia - x0] += (ia + 1 - sa) * add;
          for (let px = ia + 1; px < ib; px++) cov[row + px - x0] += add;
          if (ib < x1) cov[row + ib - x0] += (sb - ib) * add;
        }
      }
    }
    for (let i = 0; i < cov.length; i++) if (cov[i] > 1) cov[i] = 1;
    return { x0, y0, w, h, cov };
  }

  // Rasterise one triangle with per-vertex attributes [u, vpx, w, arc px]
  function rasterTri(buf, W, H, ax, ay, bx, by, cx, cy, A, B, C) {
    const minX = clamp(Math.floor(Math.min(ax, bx, cx)), buf.x0, buf.x0 + buf.w - 1);
    const maxX = clamp(Math.ceil(Math.max(ax, bx, cx)), buf.x0, buf.x0 + buf.w - 1);
    const minY = clamp(Math.floor(Math.min(ay, by, cy)), buf.y0, buf.y0 + buf.h - 1);
    const maxY = clamp(Math.ceil(Math.max(ay, by, cy)), buf.y0, buf.y0 + buf.h - 1);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-6) return;
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
        let w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
        let w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const u = w0 * A[0] + w1 * B[0] + w2 * C[0];
        const vpx = w0 * A[1] + w1 * B[1] + w2 * C[1];
        const wid = w0 * A[2] + w1 * B[2] + w2 * C[2];
        const arc = w0 * A[3] + w1 * B[3] + w2 * C[3];
        // edge anti-alias from distance to either strap edge
        const alpha = clamp(Math.min(vpx, wid - vpx) + 0.5, 0, 1);
        const i = (y - buf.y0) * buf.w + (x - buf.x0);
        if (alpha > buf.a[i]) {
          buf.a[i] = alpha;
          buf.u[i] = u;
          buf.v[i] = clamp(vpx / wid, 0, 1);
          // distance (px) to the nearest strap edge or strap end, used by the background key
          buf.d[i] = Math.max(0, buf.sides ? Math.min(vpx, wid - vpx, arc, buf.len - arc) : Math.min(arc, buf.len - arc));
        }
      }
    }
  }

  function strapBuffer(strap, s, W, H, patW, patH, patternScale, overscan, keySides) {
    // overscan: push both edges outward (px at template scale) so no white webbing
    // edge survives; the background key and layer order trim the excess
    const o = (overscan || 0) * s;
    const rungs = strap.rungs.map((r) => {
      const tx = r[0] * s, ty = r[1] * s, bx = r[2] * s, by = r[3] * s;
      const len = Math.hypot(bx - tx, by - ty) || 1;
      const ux = (bx - tx) / len, uy = (by - ty) / len;
      return [tx - ux * o, ty - uy * o, bx + ux * o, by + uy * o];
    });
    const pts = densifyRungs(rungs, 3);
    if (pts.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.tx, p.bx); maxX = Math.max(maxX, p.tx, p.bx);
      minY = Math.min(minY, p.ty, p.by); maxY = Math.max(maxY, p.ty, p.by);
    }
    const x0 = clamp(Math.floor(minX) - 3, 0, W - 1), y0 = clamp(Math.floor(minY) - 3, 0, H - 1);
    const bw = clamp(Math.ceil(maxX) + 3, 0, W - 1) - x0 + 1, bh = clamp(Math.ceil(maxY) + 3, 0, H - 1) - y0 + 1;
    if (bw <= 0 || bh <= 0) return null;
    const n = bw * bh;
    const buf = { x0, y0, w: bw, h: bh, a: new Float32Array(n), u: new Float32Array(n), v: new Float32Array(n), d: new Float32Array(n), len: 0, sides: !!keySides };
    // u in pattern pixels, advanced by midline distance scaled to strap width
    const k = patH / (patternScale || 1);
    let u = (strap.offset || 0) * patW;
    const us = [u];
    const arcs = [0];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      const mx0 = (p.tx + p.bx) / 2, my0 = (p.ty + p.by) / 2;
      const mx1 = (q.tx + q.bx) / 2, my1 = (q.ty + q.by) / 2;
      const w0 = Math.hypot(p.bx - p.tx, p.by - p.ty), w1 = Math.hypot(q.bx - q.tx, q.by - q.ty);
      const wAvg = Math.max(1, (w0 + w1) / 2) * (strap.foreshorten || 1);
      const step = Math.hypot(mx1 - mx0, my1 - my0);
      u += (step / wAvg) * k;
      us.push(u);
      arcs.push(arcs[arcs.length - 1] + step);
    }
    buf.len = arcs[arcs.length - 1];
    const PAD = 1.0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const wp = Math.max(1, Math.hypot(p.bx - p.tx, p.by - p.ty));
      const wq = Math.max(1, Math.hypot(q.bx - q.tx, q.by - q.ty));
      // expand 1px outward on both edges for AA
      const ex = (x0, y0, x1, y1, w) => [x0 + ((x0 - x1) / w) * PAD, y0 + ((y0 - y1) / w) * PAD];
      const [ptx, pty] = ex(p.tx, p.ty, p.bx, p.by, wp);
      const [pbx, pby] = ex(p.bx, p.by, p.tx, p.ty, wp);
      const [qtx, qty] = ex(q.tx, q.ty, q.bx, q.by, wq);
      const [qbx, qby] = ex(q.bx, q.by, q.tx, q.ty, wq);
      const PT = [us[i], -PAD, wp, arcs[i]], PB = [us[i], wp + PAD, wp, arcs[i]];
      const QT = [us[i + 1], -PAD, wq, arcs[i + 1]], QB = [us[i + 1], wq + PAD, wq, arcs[i + 1]];
      rasterTri(buf, W, H, ptx, pty, qtx, qty, qbx, qby, PT, QT, QB);
      rasterTri(buf, W, H, ptx, pty, qbx, qby, pbx, pby, PT, QB, PB);
    }
    return buf;
  }

  /* ---------------- background key ---------------- */

  function boxBlur(src, W, H, r) {
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    const n = 2 * r + 1;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, W - 1)];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = acc / n;
        acc += src[row + Math.min(W - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, H - 1) * W + x];
      for (let y = 0; y < H; y++) {
        out[y * W + x] = acc / n;
        acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
      }
    }
    return out;
  }

  // Local high-pass energy of the photo. Woven webbing is textured; studio background is not.
  function textureMap(base, s) {
    const W = base.width, H = base.height, d = base.data;
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    const r = Math.max(1, Math.round(2 * s));
    const mean = boxBlur(L, W, H, r);
    for (let i = 0; i < L.length; i++) { const h = L[i] - mean[i]; L[i] = h * h; }
    const e = boxBlur(L, W, H, r);
    for (let i = 0; i < e.length; i++) e[i] = Math.sqrt(e[i]);
    return e;
  }

  // Dilate a coverage map by r px (square max filter). Keeps the original as .inner
  function growCoverage(cov, r, W, H) {
    if (r <= 0) return { ...cov, inner: cov.cov };
    const x0 = Math.max(0, cov.x0 - r), y0 = Math.max(0, cov.y0 - r);
    const x1 = Math.min(W, cov.x0 + cov.w + r), y1 = Math.min(H, cov.y0 + cov.h + r);
    const w = x1 - x0, h = y1 - y0;
    const inner = new Float32Array(w * h);
    for (let yy = 0; yy < cov.h; yy++) for (let xx = 0; xx < cov.w; xx++) {
      inner[(yy + cov.y0 - y0) * w + xx + cov.x0 - x0] = cov.cov[yy * cov.w + xx];
    }
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (inner[y * w + k] > m) m = inner[y * w + k];
      tmp[y * w + x] = m;
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
    return { x0, y0, w, h, cov: out, inner };
  }

  /* ---------------- colour ---------------- */

  function ramp(stops, t, out) {
    t = clamp(t, 0, 1);
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const a = stops[i - 1], b = stops[i];
        const f = (t - a[0]) / (b[0] - a[0] || 1);
        out[0] = a[1] + (b[1] - a[1]) * f;
        out[1] = a[2] + (b[2] - a[2]) * f;
        out[2] = a[3] + (b[3] - a[3]) * f;
        return out;
      }
    }
    const l = stops[stops.length - 1];
    out[0] = l[1]; out[1] = l[2]; out[2] = l[3];
    return out;
  }

  // Homography: unit square -> quad (TL,TR,BR,BL). Returns inverse mapper.
  function quadInverse(q) {
    const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3];
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    let g = 0, h = 0;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) > 1e-9) {
      g = (sx * dy2 - dx2 * sy) / den;
      h = (dx1 * sy - sx * dy1) / den;
    }
    const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
    const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
    // forward: x = (a u + b v + c)/(g u + h v + 1)
    // inverse via adjugate
    const A = e - f * h, B = c * h - b, C = b * f - c * e;
    const D = f * g - d, E = a - c * g, F = c * d - a * f;
    const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
    return (x, y) => {
      const z = G * x + H * y + I;
      return [(A * x + B * y + C) / z, (D * x + E * y + F) / z];
    };
  }

  /* ---------------- debug texture ---------------- */

  function uvChecker(w, h) {
    const img = makeImage(w, h);
    const cell = h / 4;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        const odd = (cx + cy) % 2;
        let r = odd ? 235 : 60, g = odd ? 120 : 160, b = odd ? 90 : 230;
        // top band marks pattern "up"
        if (y < h * 0.12) { r = 255; g = 220; b = 40; }
        // arrow along +u in each cell
        const lx = (x % cell) / cell, ly = (y % cell) / cell;
        if (Math.abs(ly - 0.5) < 0.06 && lx > 0.2 && lx < 0.75) { r = g = b = 255; }
        if (lx >= 0.6 && lx < 0.85 && Math.abs(ly - 0.5) < (0.85 - lx) * 0.9) { r = g = b = 255; }
        const i = (y * w + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    return img;
  }

  /* ---------------- main render ---------------- */

  /**
   * opts:
   *  template   - template JSON
   *  base       - {width,height,data} photo, already sized to output
   *  pattern    - {width,height,data} default pattern
 *  patternBySlot - { slotId: {width,height,data} } optional per-slot pattern
   *  finishBySlot  - { slotId: 'gold'|'rosegold'|'silver' }
   *  engravingBySlot - { slotId: {width,height,data} } (dark text, alpha)
   *  background - {width,height,data} sized to output, or null to keep photo
   *  mode       - 'final' | 'uv' | 'mask'
   *  patternScale - pattern height as a fraction of strap width (1 = full height)
   */
  function render(opts) {
    const { template, base } = opts;
    const W = base.width, H = base.height;
    const s = W / template.width;
    const mode = opts.mode || 'final';
    const checker = mode === 'uv' ? uvChecker(512, 128) : null;
    // one pattern per slot is allowed (e.g. three different collars); falls back to the listing pattern
    const patternFor = (slot) => checker || (opts.patternBySlot && opts.patternBySlot[slot]) || opts.pattern;
    const out = makeImage(W, H);
    const od = out.data, bd = base.data;
    const whiteRef = template.whiteRef || 235;
    const bgRef = template.bgRef || 245;
    const patternScale = opts.patternScale || template.patternScale || 1;
    const tmp = [0, 0, 0, 0];
    const rgb = [0, 0, 0];

    // 1. ground: photo, or new background carrying the photo's shadows
    if (opts.background && template.replaceBackground !== false) {
      // plate treatment so a photographed surface sits behind a studio-lit product:
      // soften (depth of field) and lift toward white (high-key studio look)
      const blurPx = Math.round((opts.bgBlur != null ? opts.bgBlur : template.bgBlur || 0) * s);
      const lift = opts.bgLift != null ? opts.bgLift : template.bgLift || 0;
      let bg = opts.background.data;
      if (blurPx > 0) {
        const soft = new Uint8ClampedArray(bg.length);
        const ch = new Float32Array(W * H);
        for (let c = 0; c < 3; c++) {
          for (let i = 0; i < W * H; i++) ch[i] = bg[i * 4 + c];
          // two box passes approximate a gaussian
          const once = boxBlur(ch, W, H, blurPx);
          const twice = boxBlur(once, W, H, blurPx);
          for (let i = 0; i < W * H; i++) soft[i * 4 + c] = twice[i];
        }
        bg = soft;
      }
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        const L = lum(bd[j], bd[j + 1], bd[j + 2]);
        const sh = Math.pow(clamp(L / bgRef, 0, 1), template.shadowGamma || 1.15);
        const r = bg[j] + (255 - bg[j]) * lift, g = bg[j + 1] + (255 - bg[j + 1]) * lift, bl = bg[j + 2] + (255 - bg[j + 2]) * lift;
        od[j] = r * sh; od[j + 1] = g * sh; od[j + 2] = bl * sh; od[j + 3] = 255;
      }
    } else {
      od.set(bd);
    }

    // Optional: near strap edges/ends, drop print that lands on smooth background
    const key = template.bgKey || null;
    let tex = null;
    const keyBand = key ? (key.band || 6) * s : 0;

    // strap paint per pixel, so metal can reclaim pattern that landed on smooth metal
    const strapA = new Float32Array(W * H);
    // satKey: only near-neutral photo pixels can be webbing/metal (keeps fur, grass etc. untouched)
    const satKey = template.satKey || null;
    const neutral = (j) => {
      const r = bd[j], g = bd[j + 1], b = bd[j + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 1) return 0;
      const sat = (mx - mn) / mx;
      return clamp((satKey.max - sat) / (satKey.soft || 0.06), 0, 1);
    };
    const getTex = () => (tex || (tex = textureMap(base, s)));
    const edge = template.metalEdge || null; // { grow, smooth, woven }

    const MASK_COLORS = { strap: [255, 80, 60], hardware: [40, 140, 255], keep: [80, 200, 90], engraving: [250, 200, 0] };

    const blend = (j, r, g, b, a) => {
      od[j] = od[j] + (r - od[j]) * a;
      od[j + 1] = od[j + 1] + (g - od[j + 1]) * a;
      od[j + 2] = od[j + 2] + (b - od[j + 2]) * a;
    };

    for (const layer of template.layers || []) {
      if (layer.hidden) continue;

      if (layer.type === 'strap') {
        if (!layer.rungs || layer.rungs.length < 2) continue;
        const pattern = patternFor(layer.slot);
        if (!pattern) continue;
        const overscan = layer.overscan != null ? layer.overscan : template.strapOverscan || 0;
        const keySides = !!(template.bgKey && template.bgKey.sides);
        const buf = strapBuffer(layer, s, W, H, pattern.width, pattern.height, patternScale, overscan, keySides);
        if (!buf) continue;
        const flip = !!layer.flip;
        const gain = layer.shade == null ? 1 : layer.shade;
        const wref = layer.whiteRef || whiteRef;
        for (let bi = 0; bi < buf.a.length; bi++) {
          let a = buf.a[bi];
          if (a <= 0) continue;
          const i = (buf.y0 + ((bi / buf.w) | 0)) * W + buf.x0 + (bi % buf.w);
          const j = i * 4;
          if (key && !layer.noKey && buf.d[bi] < keyBand) {
            if (!tex) tex = textureMap(base, s);
            const keep = clamp((tex[i] - (key.lo || 0.55)) / ((key.hi || 0.95) - (key.lo || 0.55)), 0, 1);
            const inner = clamp(buf.d[bi] / keyBand, 0, 1);
            a *= keep + (1 - keep) * inner * inner;
            if (a <= 0.01) continue;
          }
          if (satKey && !layer.noSat) { a *= neutral(j); if (a <= 0.01) continue; }
          if (mode === 'mask') {
            const c = MASK_COLORS.strap;
            blend(j, c[0], c[1], c[2], a * 0.6);
            continue;
          }
          const v = flip ? 1 - buf.v[bi] : buf.v[bi];
          const uu = flip ? -buf.u[bi] : buf.u[bi];
          sampleBilinear(pattern, uu, v * (pattern.height - 1) + 0.5, true, tmp);
          const L = lum(bd[j], bd[j + 1], bd[j + 2]);
          const shade = Math.pow(L / wref, gain);
          const lo = Math.min(shade, 1);
          const hi = Math.max(shade - 1, 0) * 0.9;
          const r = tmp[0] * lo + (255 - tmp[0] * lo) * hi;
          const g = tmp[1] * lo + (255 - tmp[1] * lo) * hi;
          const b = tmp[2] * lo + (255 - tmp[2] * lo) * hi;
          blend(j, r, g, b, a);
          if (a > strapA[i]) strapA[i] = a;
        }
        continue;
      }

      if (layer.type === 'hardware' || layer.type === 'keep') {
        const rings = (layer.rings || []).map((ring) => ring.map((p) => [p[0] * s, p[1] * s]));
        const cov0 = polygonCoverage(rings, W, H);
        if (!cov0) continue;
        // metalEdge: grow the outline a few px; in the grown band only smooth pixels that a
        // strap painted become metal again. Inside the outline, woven pixels keep the strap.
        const useEdge = edge && layer.type === 'hardware' && mode !== 'mask' && layer.edge !== false;
        const cov = useEdge ? growCoverage(cov0, Math.round((layer.edgeGrow || edge.grow || 5) * s), W, H) : cov0;
        if (useEdge) getTex();
        const finish = layer.type === 'hardware'
          ? (opts.finishBySlot && opts.finishBySlot[layer.slot]) || 'silver'
          : null;
        const stops = finish ? FINISH_RAMPS[finish] : null;
        const native = finish && template.nativeFinish === finish;
        const tone = template.metalTone || { black: 30, white: 250 };
        // flatten: wipe whatever is engraved/printed on the photo's plate, keep soft light
        let flatMean = -1;
        if (layer.flatten && mode !== 'mask') {
          let sum = 0, n = 0;
          for (let yy = 0; yy < cov.h; yy++) for (let xx = 0; xx < cov.w; xx++) {
            if (cov.cov[yy * cov.w + xx] < 0.99) continue;
            const j = ((yy + cov.y0) * W + xx + cov.x0) * 4;
            sum += lum(bd[j], bd[j + 1], bd[j + 2]); n++;
          }
          flatMean = n ? sum / n : -1;
        }
        for (let yy = 0; yy < cov.h; yy++) {
          for (let xx = 0; xx < cov.w; xx++) {
            let a = cov.cov[yy * cov.w + xx];
            if (a <= 0) continue;
            const x = xx + cov.x0, y = yy + cov.y0;
            const i = y * W + x;
            const j = i * 4;
            if (useEdge) {
              const inside = cov.inner[yy * cov.w + xx];
              const sp = strapA[i];
              const t = tex[i];
              if (inside <= 0) {
                // band: reclaim only strap-painted, smooth (metal-like) pixels
                if (sp <= 0) continue;
                a = sp * clamp(((edge.smooth || 2) + 1 - t) / 1.5, 0, 1);
                if (a <= 0.01) continue;
              } else {
                a = inside;
              }
            }
            if (satKey && layer.type === 'hardware' && !layer.noSat) { a *= neutral(j); if (a <= 0.01) continue; }
            if (mode === 'mask') {
              const c = MASK_COLORS[layer.type];
              blend(j, c[0], c[1], c[2], a * 0.6);
              continue;
            }
            let L = lum(bd[j], bd[j + 1], bd[j + 2]);
            if (flatMean >= 0) {
              const ny = yy / Math.max(1, cov.h - 1);
              L = flatMean * (1.12 - 0.24 * ny) + (L - flatMean) * 0.12;
            } else if (!stops || native) {
              blend(j, bd[j], bd[j + 1], bd[j + 2], a);
              continue;
            }
            const st = stops || FINISH_RAMPS[finish || 'silver'];
            ramp(st, (L - tone.black) / (tone.white - tone.black), rgb);
            blend(j, rgb[0], rgb[1], rgb[2], a);
          }
        }
        continue;
      }

      if (layer.type === 'engraving') {
        const eng = opts.engravingBySlot && opts.engravingBySlot[layer.slot];
        const quad = layer.quad.map((p) => [p[0] * s, p[1] * s]);
        if (mode === 'mask') {
          const cov = polygonCoverage([quad], W, H);
          if (!cov) continue;
          const c = MASK_COLORS.engraving;
          for (let yy = 0; yy < cov.h; yy++) for (let xx = 0; xx < cov.w; xx++) {
            const a = cov.cov[yy * cov.w + xx];
            if (a > 0) blend(((yy + cov.y0) * W + xx + cov.x0) * 4, c[0], c[1], c[2], a * 0.45);
          }
          continue;
        }
        if (!eng) continue;
        const inv = quadInverse(quad);
        const depth = layer.depth == null ? 0.82 : layer.depth;
        let minX = W, minY = H, maxX = 0, maxY = 0;
        for (const p of quad) {
          minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
          minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        }
        minX = clamp(Math.floor(minX), 0, W - 1); maxX = clamp(Math.ceil(maxX), 0, W - 1);
        minY = clamp(Math.floor(minY), 0, H - 1); maxY = clamp(Math.ceil(maxY), 0, H - 1);
        const sampleA = (x, y) => {
          const [u, v] = inv(x, y);
          if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
          sampleBilinear(eng, u * eng.width, v * eng.height, false, tmp);
          return tmp[3] / 255;
        };
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            // 2x2 supersample for clean letter edges
            let a = 0;
            a += sampleA(x + 0.25, y + 0.25);
            a += sampleA(x + 0.75, y + 0.25);
            a += sampleA(x + 0.25, y + 0.75);
            a += sampleA(x + 0.75, y + 0.75);
            a /= 4;
            // bevel: light catch on the lower lip of each cut
            const lip = sampleA(x + 0.5, y - 0.6) - a;
            const j = (y * W + x) * 4;
            if (a > 0) {
              const k = 1 - a * depth;
              od[j] *= k; od[j + 1] *= k; od[j + 2] *= k;
            }
            if (lip > 0) blend(j, 255, 255, 255, lip * 0.18);
          }
        }
        continue;
      }
    }
    return out;
  }

  /* ---------------- layered (PSD) templates ---------------- */

  // Box-filtered half-size chain, so a big pattern tile shown small doesn't shimmer.
  function mipChain(img) {
    const levels = [img];
    let cur = img;
    while (cur.width > 8 && cur.height > 8) {
      const w = cur.width >> 1, h = cur.height >> 1;
      const nxt = makeImage(w, h), s = cur.data, d = nxt.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * 2 * cur.width + x * 2) * 4, j = i + cur.width * 4, o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) d[o + c] = (s[i + c] + s[i + 4 + c] + s[j + c] + s[j + 4 + c]) / 4;
      }
      levels.push(nxt);
      cur = nxt;
    }
    return levels;
  }

  function sampleWrap(img, x, y, out) {
    const w = img.width, h = img.height, d = img.data;
    x -= 0.5; y -= 0.5;
    const fx0 = Math.floor(x), fy0 = Math.floor(y);
    const fx = x - fx0, fy = y - fy0;
    const x0 = ((fx0 % w) + w) % w, x1 = (x0 + 1) % w, y0 = ((fy0 % h) + h) % h, y1 = (y0 + 1) % h;
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    for (let c = 0; c < 4; c++) {
      const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * fx;
      const bot = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * fx;
      out[c] = top + (bot - top) * fy;
    }
    return out;
  }

  const BLEND = {
    // Photoshop's formulas (a = backdrop, b = layer), 0..1
    'soft light': (a, b) => (b <= 0.5 ? 2 * a * b + a * a * (1 - 2 * b) : 2 * a * (1 - b) + Math.sqrt(a) * (2 * b - 1)),
    multiply: (a, b) => a * b,
    screen: (a, b) => 1 - (1 - a) * (1 - b),
    'linear burn': (a, b) => Math.max(0, a + b - 1),
    'color burn': (a, b) => (a >= 1 ? 1 : b <= 0 ? 0 : Math.max(0, 1 - (1 - a) / b)),
    normal: (a, b) => b,
  };

  const PART_COLORS = { bottom: [235, 70, 60], front: [235, 70, 60], middle: [40, 170, 90], top: [50, 110, 240] };

  /**
   * Replays a PSD's layer stack (see src/tools/import-psd.js):
   * below -> collar fills / warped pattern pieces / metal / thread -> overlay shading -> engraving.
   * opts.below: baked background (RGBA), opts.layerData: Uint8Array of layers.bin
   */
  function renderLayered(opts) {
    const { template } = opts;
    const Lt = template.layered;
    const W = template.width, H = template.height;
    const mode = opts.mode || 'final';
    const bin = opts.layerData;
    const below = opts.below;
    if (!bin || !below) throw new Error('layered template needs layers.bin and below.png');
    const out = makeImage(W, H);
    const od = out.data, bd = below.data;
    const tmp = [0, 0, 0, 0];

    // 1. ground: the baked background, or a new plate carrying the baked shadows
    if (opts.background && mode !== 'mask') {
      const blurPx = Math.round(opts.bgBlur != null ? opts.bgBlur : template.bgBlur || 0);
      const lift = opts.bgLift != null ? opts.bgLift : template.bgLift || 0;
      let bg = opts.background.data;
      if (blurPx > 0) {
        const soft = new Uint8ClampedArray(bg.length);
        const ch = new Float32Array(W * H);
        for (let c = 0; c < 3; c++) {
          for (let i = 0; i < W * H; i++) ch[i] = bg[i * 4 + c];
          const twice = boxBlur(boxBlur(ch, W, H, blurPx), W, H, blurPx);
          for (let i = 0; i < W * H; i++) soft[i * 4 + c] = twice[i];
        }
        bg = soft;
      }
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        for (let c = 0; c < 3; c++) od[j + c] = (bg[j + c] + (255 - bg[j + c]) * lift) * (bd[j + c] / 255);
        od[j + 3] = 255;
      }
    } else {
      od.set(bd);
    }

    const all = [...Lt.stack, ...Lt.overlay, ...Lt.engravings];
    const boxes = all.map((o) => o.alpha || o.mask).filter(Boolean);
    const rx0 = Math.min(...boxes.map((b) => b.x)), ry0 = Math.min(...boxes.map((b) => b.y));
    const rx1 = Math.max(...boxes.map((b) => b.x + b.w)), ry1 = Math.max(...boxes.map((b) => b.y + b.h));
    const RW = rx1 - rx0, RH = ry1 - ry0;
    const R = new Float32Array(RW * RH), G = new Float32Array(RW * RH), B = new Float32Array(RW * RH);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const j = ((y + ry0) * W + x + rx0) * 4, k = y * RW + x;
      R[k] = od[j] / 255; G[k] = od[j + 1] / 255; B[k] = od[j + 2] / 255;
    }

    const u8 = (ref) => new Uint8Array(bin.buffer, bin.byteOffset + ref.offset, ref.w * ref.h);
    const u16 = (ref) => {
      const n = ref.w * ref.h * 2, at = bin.byteOffset + ref.offset;
      if (at % 2 === 0) return new Uint16Array(bin.buffer, at, n);
      return new Uint16Array(bin.slice(ref.offset, ref.offset + n * 2).buffer);
    };
    // walk every pixel of a box; f(k = region index, i = box index)
    const each = (ref, f) => {
      for (let y = 0; y < ref.h; y++) {
        const ky = (y + ref.y - ry0) * RW + ref.x - rx0, iy = y * ref.w;
        for (let x = 0; x < ref.w; x++) f(ky + x, iy + x);
      }
    };
    const checker = mode === 'uv' ? uvChecker(512, 128) : null;
    const mips = new Map();
    const mipFor = (img) => { if (!mips.has(img)) mips.set(img, mipChain(img)); return mips.get(img); };
    const patternFor = (slot) => checker || (opts.patternBySlot && opts.patternBySlot[slot]) || opts.pattern;
    const patternScale = opts.patternScale || template.patternScale || 1;
    const edges = [];

    // 2. collar stack, normal blending in PSD order
    for (const op of Lt.stack) {
      const A = u8(op.alpha), opac = op.opacity == null ? 1 : op.opacity;
      if (mode === 'mask') edges.push(op);
      if (op.type === 'fill') {
        let col = op.color;
        if (op.role === 'metal') {
          const fin = (opts.finishBySlot && opts.finishBySlot[op.slot]) || 'silver';
          col = (Lt.finishes && Lt.finishes[fin]) || col;
        }
        if (mode === 'mask') col = op.role === 'metal' ? [250, 200, 30] : op.role === 'thread' ? [230, 60, 230] : [255, 255, 255];
        const cr = col[0] / 255, cg = col[1] / 255, cb = col[2] / 255;
        each(op.alpha, (k, i) => {
          const a = (A[i] / 255) * opac;
          if (a <= 0) return;
          R[k] += (cr - R[k]) * a; G[k] += (cg - G[k]) * a; B[k] += (cb - B[k]) * a;
        });
        continue;
      }
      if (op.type === 'pattern') {
        const UV = u16(op.uv), n = op.uv.w * op.uv.h;
        const [cw, chh] = op.content;
        if (mode === 'mask') {
          const pc = PART_COLORS[op.slot] || [200, 200, 200];
          const side = /side 2/.test(op.name) ? 0.62 : 1;
          const cr = (pc[0] * side) / 255, cg = (pc[1] * side) / 255, cb = (pc[2] * side) / 255;
          each(op.alpha, (k, i) => {
            const a = (A[i] / 255) * opac;
            if (a > 0) { R[k] += (cr - R[k]) * a; G[k] += (cg - G[k]) * a; B[k] += (cb - B[k]) * a; }
          });
          continue;
        }
        const pat = patternFor(op.slot);
        if (!pat) continue;
        // tile: pattern height spans the webbing width (x patternScale), repeats along the strip
        const tile = chh * patternScale;
        // pick a mip level from how many output px one content unit covers here
        let acc = 0, cnt = 0;
        for (let y = 0; y < op.uv.h - 1; y += 7) for (let x = 0; x < op.uv.w; x += 7) {
          const i = y * op.uv.w + x;
          if (A[i] < 250 || A[i + op.uv.w] < 250) continue;
          acc += Math.abs(UV[n + i + op.uv.w] - UV[n + i]) / op.uv.sv + Math.abs(UV[i + op.uv.w] - UV[i]) / op.uv.su;
          cnt++;
        }
        const unitsPerPx = cnt ? acc / cnt : 1;
        const chain = mipFor(pat);
        const texPerPx = (unitsPerPx * pat.height) / tile;
        const lvl = Math.max(0, Math.min(chain.length - 1, Math.floor(Math.log2(Math.max(1, texPerPx)))));
        const img = chain[lvl];
        const ku = img.height / tile;
        each(op.alpha, (k, i) => {
          const a = (A[i] / 255) * opac;
          if (a <= 0) return;
          const u = UV[i] / op.uv.su, v = UV[n + i] / op.uv.sv;
          sampleWrap(img, u * ku, v * ku, tmp);
          R[k] += (tmp[0] / 255 - R[k]) * a; G[k] += (tmp[1] / 255 - G[k]) * a; B[k] += (tmp[2] / 255 - B[k]) * a;
        });
      }
    }

    // 3. overlay shading (Levels, soft light / multiply / screen, Hue/Sat)
    if (mode !== 'mask') {
      for (const op of Lt.overlay) {
        if (op.type === 'levels') {
          const M = u8(op.mask);
          const ib = op.inBlack / 255, iw = op.inWhite / 255, ob = op.outBlack / 255, ow = op.outWhite / 255, gi = 1 / (op.gamma || 1);
          const lv = (c) => ob + (ow - ob) * Math.pow(clamp((c - ib) / (iw - ib), 0, 1), gi);
          each(op.mask, (k, i) => {
            const m = M[i] / 255;
            if (m <= 0) return;
            R[k] += (lv(R[k]) - R[k]) * m; G[k] += (lv(G[k]) - G[k]) * m; B[k] += (lv(B[k]) - B[k]) * m;
          });
        } else if (op.type === 'blend') {
          const A = u8(op.alpha), Gy = u8(op.gray), fn = BLEND[op.mode] || BLEND.normal, opac = op.opacity;
          each(op.alpha, (k, i) => {
            const a = (A[i] / 255) * opac;
            if (a <= 0) return;
            const b = Gy[i] / 255;
            R[k] += (fn(R[k], b) - R[k]) * a; G[k] += (fn(G[k], b) - G[k]) * a; B[k] += (fn(B[k], b) - B[k]) * a;
          });
        } else if (op.type === 'hue') {
          const M = u8(op.mask), sat = (op.saturation || 0) / 100;
          if (!sat) continue;
          each(op.mask, (k, i) => {
            const m = M[i] / 255;
            if (m <= 0) return;
            const mx = Math.max(R[k], G[k], B[k]), mn = Math.min(R[k], G[k], B[k]), l = (mx + mn) / 2;
            const f = sat > 0 ? 1 + sat : 1 + sat;
            R[k] += (clamp(l + (R[k] - l) * f, 0, 1) - R[k]) * m;
            G[k] += (clamp(l + (G[k] - l) * f, 0, 1) - G[k]) * m;
            B[k] += (clamp(l + (B[k] - l) * f, 0, 1) - B[k]) * m;
          });
        }
      }
    }

    // 4. engraving: the text image is fitted into the PSD's warped slot and multiplied in
    for (const op of Lt.engravings) {
      if (mode === 'mask') {
        const A = u8(op.alpha);
        each(op.alpha, (k, i) => {
          const a = (A[i] / 255) * 0.35;
          if (a > 0) { R[k] += (1 - R[k]) * a; G[k] += (0.85 - G[k]) * a; B[k] += (0 - B[k]) * a; }
        });
        continue;
      }
      const eng = opts.engravingBySlot && opts.engravingBySlot[op.slot];
      if (!eng) continue;
      const A = u8(op.alpha), UV = u16(op.uv), n = op.uv.w * op.uv.h;
      const [cw, chh] = op.content;
      const fit = Math.min((cw * 0.94) / eng.width, (chh * 0.94) / eng.height);
      const ox = (cw - eng.width * fit) / 2, oy = (chh - eng.height * fit) / 2;
      // mip level for the engraving bitmap
      let acc = 0, cnt = 0;
      for (let y = 0; y < op.uv.h - 1; y += 5) for (let x = 0; x < op.uv.w; x += 5) {
        const i = y * op.uv.w + x;
        if (!A[i] || !A[i + op.uv.w]) continue;
        acc += Math.abs(UV[n + i + op.uv.w] - UV[n + i]) / op.uv.sv; cnt++;
      }
      const texPerPx = cnt ? acc / cnt / fit : 1;
      const chain = mipFor(eng);
      const lvl = Math.max(0, Math.min(chain.length - 1, Math.floor(Math.log2(Math.max(1, texPerPx)))));
      const img = chain[lvl], sc = img.width / eng.width;
      const depth = template.engraveDepth || 0.78;
      each(op.alpha, (k, i) => {
        if (!A[i]) return;
        const ex = ((UV[i] / op.uv.su - ox) / fit) * sc, ey = ((UV[n + i] / op.uv.sv - oy) / fit) * sc;
        if (ex < 0 || ey < 0 || ex >= img.width || ey >= img.height) return;
        sampleBilinear(img, ex, ey, false, tmp);
        const a = (tmp[3] / 255) * (A[i] / 255);
        if (a <= 0) return;
        const f = 1 - a * depth;
        R[k] *= f; G[k] *= f; B[k] *= f;
      });
    }

    // mask view: outline every part so the division is easy to check
    if (mode === 'mask') {
      for (const op of edges) {
        const A = u8(op.alpha), w = op.alpha.w, h = op.alpha.h;
        each(op.alpha, (k, i) => {
          if (A[i] < 128) return;
          const x = i % w, y = (i / w) | 0;
          const out = (xx, yy) => xx < 0 || yy < 0 || xx >= w || yy >= h || A[yy * w + xx] < 128;
          if (out(x - 1, y) || out(x + 1, y) || out(x, y - 1) || out(x, y + 1)) { R[k] = 0.08; G[k] = 0.08; B[k] = 0.1; }
        });
      }
    }

    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const j = ((y + ry0) * W + x + rx0) * 4, k = y * RW + x;
      od[j] = R[k] * 255; od[j + 1] = G[k] * 255; od[j + 2] = B[k] * 255;
    }
    return out;
  }

  const renderAny = (opts) => (opts.template && opts.template.layered ? renderLayered(opts) : render(opts));

  return { render: renderAny, renderLayered, uvChecker, FINISH_RAMPS, densifyRungs, quadInverse };
});
