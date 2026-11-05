'use strict';

/**
 * Fit hardware finish ramps for a layered (PSD) template to a reference photo.
 *
 *   node --max-old-space-size=8000 src/tools/fit-finishes.js <template-id> [--ref poc/templates/03-infographic.jpg]
 *
 * The reference shows one buckle per finish on a plain light background (boxes below).
 * For each finish the buckle's pixels are sorted dark -> light. The template's own metal is
 * rendered with the PSD's neutral fill and shading, and its brightness distribution is
 * matched to the reference's (histogram matching): a shaded-brightness -> colour ramp.
 * core.js applies the ramp after the overlay shading, so the PSD keeps the shape of the
 * reflections and the reference sets their colours and contrast.
 * Writes template.layered.finishRamps (64 RGB stops per finish).
 */
const fs = require('fs');
const sharp = require('sharp');
const core = require('../mockup/core');
const { fromRoot } = require('../paths');
const { readTemplate, loadRgba } = require('../mockup/node-io');

// buckle boxes in the 1024px infographic: [x, y, w, h]
const REF_BOXES = { gold: [150, 775, 190, 120], rosegold: [418, 775, 192, 120], silver: [686, 775, 192, 120] };
// the flat buckle face (what people look at) in the infographic
const REF_FACES = { gold: [220, 800, 65, 50], rosegold: [488, 800, 65, 50], silver: [756, 800, 65, 50] };
// the flat buckle faces in the template (output px), clear of the engraving-free edges
const TEMPLATE_FACES = { 'creatsy-stack': [[1960, 560, 230, 300], [1300, 1000, 340, 300], [680, 1400, 240, 320]] };
const STOPS = 64;

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

async function crop(file, [x, y, w, h]) {
  const { data } = await sharp(file).extract({ left: x, top: y, width: w, height: h }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w, h, data };
}

// pixels clearly different from the border colour, eroded 1px (drops anti-aliased edges)
function metalMask({ w, h, data }, thresh = 12) {
  const border = [];
  for (let i = 0; i < w; i++) border.push(i, (h - 1) * w + i);
  const bg = [0, 1, 2].map((c) => border.map((p) => data[p * 3 + c]).sort((a, b) => a - b)[border.length >> 1]);
  const m = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(data[p * 3 + c] - bg[c]));
    m[p] = d > thresh ? 1 : 0;
  }
  return m;
}

function erode(m, w, h) {
  const e = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    e[p] = m[p] & m[p - 1] & m[p + 1] & m[p - w] & m[p + w];
  }
  return e;
}

// best integer shift of `shape` onto `target` (both w x h)
function align(shape, target, w, h, R = 15) {
  let best = [0, 0], score = -1;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    let s = 0;
    for (let y = 0; y < h; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < w; x++) {
        const sx = x - dx;
        if (sx >= 0 && sx < w && shape[sy * w + sx] && target[y * w + x]) s++;
      }
    }
    if (s > score) { score = s; best = [dx, dy]; }
  }
  const [dx, dy] = best, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x - dx, sy = y - dy;
    if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[y * w + x] = shape[sy * w + sx];
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const id = args[0];
  if (!id) throw new Error('usage: fit-finishes.js <template-id> [--ref file]');
  const ri = args.indexOf('--ref');
  const refFile = fromRoot(ri >= 0 ? args[ri + 1] : 'poc/templates/03-infographic.jpg');

  // 1. reference: gold separates cleanly from the white background, silver's highlights do
  //    not, so the gold buckle's outline is shifted onto the other two (same buckle shape)
  const crops = {};
  for (const [n, box] of Object.entries(REF_BOXES)) crops[n] = await crop(refFile, box);
  const shapes = {};
  for (const n of Object.keys(crops)) {
    const { w, h } = crops[n];
    const own = metalMask(crops[n]);
    if (n === 'gold') shapes[n] = own;
    else {
      const g = crops.gold;
      // pad/crop the gold mask to this box size before aligning
      const gm = new Uint8Array(w * h), src = metalMask(g);
      for (let y = 0; y < Math.min(h, g.h); y++) for (let x = 0; x < Math.min(w, g.w); x++) gm[y * w + x] = src[y * g.w + x];
      shapes[n] = align(gm, own, w, h);
    }
  }
  const refSorted = {};
  for (const [n, c] of Object.entries(crops)) {
    const m = erode(shapes[n], c.w, c.h);
    const px = [];
    for (let p = 0; p < c.w * c.h; p++) if (m[p]) px.push([c.data[p * 3], c.data[p * 3 + 1], c.data[p * 3 + 2]]);
    px.sort((a, b) => lum(...a) - lum(...b));
    refSorted[n] = px;
    const q = (f) => lum(...px[Math.floor(f * (px.length - 1))]).toFixed(2);
    console.log(`${n}: ${px.length} px, brightness p5 ${q(0.05)} p50 ${q(0.5)} p95 ${q(0.95)}`);
  }

  // 2. the template's shaded neutral metal
  const template = readTemplate(id);
  const probeTpl = JSON.parse(JSON.stringify(template));
  delete probeTpl.layered.finishRamps;
  const below = await loadRgba(fromRoot(template.layered.below), template.width, template.height);
  const layerData = new Uint8Array(fs.readFileSync(fromRoot(template.layered.bin)));
  const probe = {};
  const neutral = core.renderLayered({ template: probeTpl, below, layerData, mode: 'final', metalProbe: probe });
  // neutral shaded brightness on the template's buckle faces
  const faceL = [];
  for (const [x, y, w, h] of TEMPLATE_FACES[id] || []) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const j = (yy * template.width + xx) * 4, d = neutral.data;
      faceL.push(lum(d[j], d[j + 1], d[j + 2]));
    }
  }
  const ours = Float32Array.from(probe.lum).sort();
  const cdf = (l) => {
    let lo = 0, hi = ours.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ours[mid] <= l) lo = mid + 1; else hi = mid; }
    return lo / ours.length;
  };
  const oq = (f) => ours[Math.floor(f * (ours.length - 1))].toFixed(2);
  console.log(`template metal: ${ours.length} px, brightness p5 ${oq(0.05)} p50 ${oq(0.5)} p95 ${oq(0.95)}`);

  // 3. ramp: our brightness -> percentile -> mean reference colour around that percentile
  const finishRamps = {};
  for (const [n, px] of Object.entries(refSorted)) {
    const ramp = [];
    for (let s = 0; s < STOPS; s++) {
      const p = Math.min(0.995, Math.max(0.005, cdf(s / (STOPS - 1))));
      const a = Math.max(0, Math.floor((p - 0.03) * px.length)), b = Math.min(px.length, Math.ceil((p + 0.03) * px.length));
      const sum = [0, 0, 0];
      for (let i = a; i < b; i++) for (let c = 0; c < 3; c++) sum[c] += px[i][c];
      ramp.push(sum.map((v) => v / (b - a)));
    }
    finishRamps[n] = ramp;
  }

  // 4. face calibration: the global match puts the template's big flat face in the
  //    reference's pale highlight range. Pull the ramp stops the faces use (smooth weights)
  //    until the template's mean face colour equals the reference face colour.
  if (faceL.length) {
    const hist = new Float32Array(STOPS);
    for (const l of faceL) hist[Math.round(l * (STOPS - 1))]++;
    const wts = new Float32Array(STOPS);
    for (let s = 0; s < STOPS; s++) for (let t = 0; t < STOPS; t++) wts[s] += hist[t] * Math.exp(-((s - t) ** 2) / (2 * 3 * 3));
    const wmax = Math.max(...wts);
    for (let s = 0; s < STOPS; s++) wts[s] /= wmax;
    const at = (ramp, l) => {
      const t = l * (STOPS - 1), i0 = Math.min(STOPS - 2, Math.floor(t)), f = t - i0;
      return [0, 1, 2].map((c) => ramp[i0][c] + (ramp[i0 + 1][c] - ramp[i0][c]) * f);
    };
    for (const [n, box] of Object.entries(REF_FACES)) {
      const c = await crop(refFile, box);
      const target = [0, 1, 2].map((ch) => { let s = 0; for (let p = 0; p < c.w * c.h; p++) s += c.data[p * 3 + ch]; return s / (c.w * c.h); });
      const ramp = finishRamps[n];
      let mean;
      for (let it = 0; it < 12; it++) {
        mean = [0, 0, 0];
        for (const l of faceL) { const v = at(ramp, l); for (let ch = 0; ch < 3; ch++) mean[ch] += v[ch] / faceL.length; }
        for (let s = 0; s < STOPS; s++) for (let ch = 0; ch < 3; ch++) {
          const g = target[ch] / Math.max(1, mean[ch]);
          ramp[s][ch] = Math.min(255, ramp[s][ch] * (1 + (g - 1) * wts[s]));
        }
      }
      console.log(`${n} face: reference [${target.map(Math.round)}], template [${mean.map(Math.round)}]`);
    }
  }
  for (const n of Object.keys(finishRamps)) finishRamps[n] = finishRamps[n].map((c) => c.map(Math.round));

  const file = fromRoot('templates', `${id}.json`);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.layered.finishRamps = finishRamps;
  json.layered.finishRampsSource = { ref: refFile.replace(fromRoot() + require('path').sep, '').replace(/\\/g, '/'), boxes: REF_BOXES };
  fs.writeFileSync(file, JSON.stringify(json, null, 1) + '\n');
  console.log(`wrote finishRamps to templates/${id}.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
