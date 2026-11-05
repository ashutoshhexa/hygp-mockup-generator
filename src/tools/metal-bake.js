'use strict';

/**
 * Hardware "metal plates": polish the buckles once per finish with an image model, then
 * reuse them for every listing (the hardware never changes, only the pattern does).
 *
 *   node --max-old-space-size=8000 src/tools/metal-bake.js prepare <template-id>
 *     -> poc/metal-bake/<id>/in/<finish>/<area>.png   crops of our render (no engraving)
 *        poc/metal-bake/<id>/reference-<finish>.png   the look to match
 *        poc/metal-bake/<id>/PROMPTS.md               what to ask the image model
 *   (edit each crop with the model, save the result as poc/metal-bake/<id>/out/<finish>/<area>.png)
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { fromRoot } = require('../paths');
const { renderFrame, readTemplate } = require('./../mockup/node-io');

// hardware areas in output px [x, y, w, h]; neighbouring areas may overlap
const AREAS = {
  'creatsy-stack': {
    'top-loop': [870, 380, 460, 520],
    'top-buckle': [1650, 450, 1020, 520],
    'middle-loop': [400, 800, 300, 580],
    'middle-buckle': [1000, 880, 1400, 520],
    'bottom-buckle': [330, 1290, 1370, 590],
    // fill-ins where hardware runs past the crops above (overlap them for a soft join)
    'middle-dring': [1880, 900, 680, 580],
    'top-loop-base': [800, 700, 460, 400],
  },
};
const REF_BOXES = { gold: [150, 775, 190, 120], rosegold: [418, 775, 192, 120], silver: [686, 775, 192, 120] };
const FINISH_WORDS = { gold: 'polished yellow gold', rosegold: 'polished rose gold', silver: 'polished silver (chrome-like stainless steel)' };

async function prepare(id) {
  const template = readTemplate(id);
  delete template.layered.metalPlates; // start from the fitted metal, not an earlier bake
  const areas = AREAS[id];
  if (!areas) throw new Error(`no hardware areas defined for ${id}`);
  const dir = fromRoot('poc', 'metal-bake', id);
  const decision = JSON.parse(fs.readFileSync(fromRoot('decisions', 'christmas-gingerbread.json'), 'utf8'));
  const ref = fromRoot('poc', 'templates', '03-infographic.jpg');
  for (const fin of Object.keys(REF_BOXES)) {
    const all = { top: fin, middle: fin, bottom: fin };
    const png = await renderFrame({ template, patternFile: decision.patternFile, finishBySlot: all, collarBySlot: {} });
    fs.mkdirSync(path.join(dir, 'in', fin), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out', fin), { recursive: true });
    for (const [name, [x, y, w, h]] of Object.entries(areas)) {
      await sharp(png).extract({ left: x, top: y, width: w, height: h }).png().toFile(path.join(dir, 'in', fin, `${name}.png`));
    }
    const [rx, ry, rw, rh] = REF_BOXES[fin];
    await sharp(ref).extract({ left: rx, top: ry, width: rw, height: rh }).resize({ width: rw * 4, kernel: 'lanczos3' }).png().toFile(path.join(dir, `reference-${fin}.png`));
    console.log(`${fin}: ${Object.keys(areas).length} crops`);
  }
  const prompt = (fin) => [
    `Attach: in/${fin}/<area>.png (image to edit) and reference-${fin}.png (look to match).`,
    '',
    '```',
    `Edit the first image. Re-render ONLY the metal hardware (buckle, D-ring, slide loop) as ${FINISH_WORDS[fin]}`,
    'with the same finish quality as the buckle in the second image: crisp bevelled edges, bright highlight lines',
    'along every chamfer, darker reflection bands, a smooth polished gradient across flat faces, clean and premium.',
    'Keep the colour/tint of the metal as it is in the first image.',
    'Do NOT change the shape, outline, size, position or perspective of any metal part.',
    'Do NOT change the fabric, its pattern, the stitching or the background. Do not add any text, logo or engraving.',
    'Same framing and same pixel size as the first image.',
    '```',
  ].join('\n');
  const md = [
    `# Metal bake: ${id}`,
    '',
    'For each finish and each area: give the model the crop and the reference, use the prompt, and save the',
    `result with the SAME file name under \`out/<finish>/\` (e.g. \`out/gold/top-buckle.png\`).`,
    'Any size is fine; it is scaled back and aligned. Re-run an area if the shape changed or the fabric got repainted.',
    '',
    `Areas: ${Object.keys(areas).join(', ')}`,
    '',
    ...Object.keys(REF_BOXES).flatMap((f) => [`## ${f}`, '', prompt(f), '']),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'PROMPTS.md'), md);
  console.log(`pack ready: ${dir}`);
}

/* ---- pad: the image tool only outputs fixed ratios, so give it a crop already at one ---- */

const RATIOS = [[1, 1], [4, 3], [3, 4], [16, 9], [9, 16]];
const PAD_COLOR = '#d9d9d9';

function padFor(w, h) {
  // the supported ratio closest to w:h, reached by padding only
  let best = null;
  for (const [a, b] of RATIOS) {
    const r = a / b;
    const pw = Math.max(w, Math.round(h * r)), ph = Math.max(h, Math.round(w / r));
    const W = r >= w / h ? Math.round(h * r) : w, H = r >= w / h ? h : Math.round(w / r);
    const waste = (W * H) / (w * h);
    if (!best || waste < best.waste) best = { ratio: `${a}:${b}`, W, H, waste, pw, ph };
  }
  const left = Math.floor((best.W - w) / 2), top = Math.floor((best.H - h) / 2);
  return { ratio: best.ratio, W: best.W, H: best.H, left, top };
}

async function pad(id) {
  const dir = fromRoot('poc', 'metal-bake', id);
  const jobs = [];
  for (const fin of Object.keys(REF_BOXES)) {
    fs.mkdirSync(path.join(dir, 'padded', fin), { recursive: true });
    for (const [name, [, , w, h]] of Object.entries(AREAS[id])) {
      const p = padFor(w, h);
      await sharp(path.join(dir, 'in', fin, `${name}.png`))
        .extend({ left: p.left, right: p.W - w - p.left, top: p.top, bottom: p.H - h - p.top, background: PAD_COLOR })
        .png().toFile(path.join(dir, 'padded', fin, `${name}.png`));
      jobs.push({ finish: fin, area: name, ratio: p.ratio, input: `poc/metal-bake/${id}/padded/${fin}/${name}.png`, reference: `poc/metal-bake/${id}/reference-${fin}.png`, prompt: gen(fin) });
    }
  }
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(jobs, null, 2));
  console.log(`${jobs.length} padded crops + jobs.json`);
}

const gen = (fin) => 'Reproduce the FIRST reference image exactly - identical framing, camera, composition, every object in the same position and the same size, '
  + 'the same grey bands at the edges, the same fabric with the same pattern placement and the same stitching. '
  + `The ONLY change: the metal hardware (side-release buckle, D-ring, slide loops) gets a premium ${FINISH_WORDS[fin]} finish like the buckle in the SECOND reference image: `
  + 'crisp bevelled edges, bright highlight lines along each chamfer, subtle darker reflection bands, smooth polished gradient on flat faces. '
  + 'Keep the metal colour as in the first image. Do not change the shape, outline, thickness or design of any metal part. No text, no engraving, no logo, no zoom, no crop.';

/* ---- assemble: align each result, keep only the PSD's metal, one full-frame plate per finish ---- */

const lumAt = (buf, W, x, y) => { const j = (y * W + x) * 3; return 0.2126 * buf[j] + 0.7152 * buf[j + 1] + 0.0722 * buf[j + 2]; };

function gradients(buf, W, H, x0, y0, w, h) {
  const o = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const X = x + x0, Y = y + y0;
    if (X < 1 || Y < 1 || X >= W - 1 || Y >= H - 1) continue;
    o[y * w + x] = Math.abs(lumAt(buf, W, X + 1, Y) - lumAt(buf, W, X - 1, Y)) + Math.abs(lumAt(buf, W, X, Y + 1) - lumAt(buf, W, X, Y - 1));
  }
  return o;
}

function metalCoverage(template, bin, [X, Y, w, h]) {
  const m = new Float32Array(w * h);
  for (const o of template.layered.stack) {
    const a = o.alpha, metal = o.role === 'metal';
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const gx = x + a.x - X, gy = y + a.y - Y;
      if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
      const v = (bin[a.offset + y * a.w + x] / 255) * (o.opacity == null ? 1 : o.opacity), p = gy * w + gx;
      m[p] = metal ? m[p] + (1 - m[p]) * v : m[p] * (1 - v);
    }
  }
  return m;
}

// The model over-polishes some finishes (silver highlights blow out to pure white). For these,
// the bright half of the plate's tones is matched to the reference buckle's; shadows stay.
const TONE_TO_REFERENCE = { silver: true };

async function toneHighlights(rgba, fin) {
  const L = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const [x, y, w, h] = REF_BOXES[fin];
  const { data: r } = await sharp(fromRoot('poc', 'templates', '03-infographic.jpg')).extract({ left: x, top: y, width: w, height: h }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ref = [];
  for (let i = 0; i < r.length; i += 3) {
    if (Math.max(Math.abs(r[i] - 253), Math.abs(r[i + 1] - 253), Math.abs(r[i + 2] - 253)) > 6) ref.push(L(r[i], r[i + 1], r[i + 2]));
  }
  ref.sort((a, b) => a - b);
  const ours = [];
  for (let q = 0; q < rgba.length; q += 4) if (rgba[q + 3] === 255) ours.push(L(rgba[q], rgba[q + 1], rgba[q + 2]));
  ours.sort((a, b) => a - b);
  const cdf = (l) => { let lo = 0, hi = ours.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ours[mid] <= l) lo = mid + 1; else hi = mid; } return lo / ours.length; };
  const qref = (p) => ref[Math.min(ref.length - 1, Math.floor(p * (ref.length - 1)))];
  // 256-entry curve: below the median unchanged, above it the reference's quantiles
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const l = i / 255, p = cdf(l);
    const t = Math.min(1, Math.max(0, (p - 0.4) / 0.2)), wgt = t * t * (3 - 2 * t);
    curve[i] = l + (qref(p) - l) * wgt;
  }
  let bright0 = 0, bright1 = 0, n = 0;
  for (let q = 0; q < rgba.length; q += 4) {
    if (!rgba[q + 3]) continue;
    const l = L(rgba[q], rgba[q + 1], rgba[q + 2]);
    const nl = curve[Math.round(l * 255)];
    const k = l > 0.001 ? nl / l : 1;
    for (let c = 0; c < 3; c++) rgba[q + c] = Math.max(0, Math.min(255, Math.round(rgba[q + c] * k)));
    if (rgba[q + 3] === 255) { n++; if (l > 0.95) bright0++; if (nl > 0.95) bright1++; }
  }
  return `${fin}: highlights toned to reference, near-white share ${(100 * bright0 / n).toFixed(1)}% -> ${(100 * bright1 / n).toFixed(1)}% (reference ${(100 * ref.filter((v) => v > 0.95).length / ref.length).toFixed(1)}%)`;
}

async function assemble(id) {
  const template = readTemplate(id);
  const bin = fs.readFileSync(fromRoot(template.layered.bin));
  const dir = fromRoot('poc', 'metal-bake', id);
  const W = template.width, H = template.height;
  const plates = {};
  const report = [];
  for (const fin of Object.keys(REF_BOXES)) {
    const acc = new Float32Array(W * H * 3), wsum = new Float32Array(W * H);
    let used = 0;
    for (const [name, box] of Object.entries(AREAS[id])) {
      const file = ['png', 'jpg'].map((e) => path.join(dir, 'out', fin, `${name}.${e}`)).find((f) => fs.existsSync(f));
      if (!file) { report.push(`${fin}/${name}: missing`); continue; }
      const [X, Y, w, h] = box;
      const p = padFor(w, h);
      const ours = await sharp(path.join(dir, 'in', fin, `${name}.png`)).removeAlpha().raw().toBuffer();
      const g = await sharp(file).resize(p.W, p.H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
      // integer shift that best lines up the edges (search +-12 px)
      const go = gradients(ours, w, h, 0, 0, w, h);
      let best = null;
      for (let dy = -12; dy <= 12; dy++) {
        const gg = gradients(g, p.W, p.H, p.left - 12, p.top + dy, w + 24, h);
        for (let dx = -12; dx <= 12; dx++) {
          let s = 0, na = 0, nb = 0;
          for (let y = 14; y < h - 14; y += 2) for (let x = 14; x < w - 14; x += 2) {
            const a = go[y * w + x], b = gg[y * (w + 24) + x + 12 + dx];
            s += a * b; na += a * a; nb += b * b;
          }
          const ncc = s / Math.sqrt(na * nb || 1);
          if (!best || ncc > best.ncc) best = { ncc, dx, dy };
        }
      }
      // reject results whose edges do not line up with ours
      const ok = best.ncc >= 0.5 && Math.abs(best.dx) < 12 && Math.abs(best.dy) < 12;
      report.push(`${fin}/${name}: shift ${best.dx},${best.dy}  edge match ${best.ncc.toFixed(2)}  ${ok ? 'OK' : 'REJECTED'}`);
      if (!ok) continue;
      used++;
      const m = metalCoverage(template, bin, box);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const a = m[y * w + x];
        if (a <= 0.01) continue;
        // overlapping areas: favour the crop whose border is further away
        const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
        const wt = Math.min(1, (edge + 1) / 24);
        const gx = x + p.left + best.dx, gy = y + p.top + best.dy;
        if (gx < 0 || gy < 0 || gx >= p.W || gy >= p.H) continue;
        const q = (Y + y) * W + X + x, j = (gy * p.W + gx) * 3;
        for (let c = 0; c < 3; c++) acc[q * 3 + c] += g[j + c] * wt;
        wsum[q] += wt;
      }
    }
    if (!used) continue;
    const rgba = Buffer.alloc(W * H * 4);
    for (let q = 0; q < W * H; q++) {
      if (!wsum[q]) continue;
      for (let c = 0; c < 3; c++) rgba[q * 4 + c] = Math.round(acc[q * 3 + c] / wsum[q]);
      rgba[q * 4 + 3] = Math.round(255 * Math.min(1, wsum[q]));
    }
    if (TONE_TO_REFERENCE[fin]) report.push(await toneHighlights(rgba, fin));
    const rel = `poc/templates/${id}/metal-${fin}.png`;
    await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toFile(fromRoot(rel));
    plates[fin] = rel;
  }
  console.log(report.join('\n'));
  const file = fromRoot('templates', `${id}.json`);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.layered.metalPlates = plates;
  fs.writeFileSync(file, JSON.stringify(json, null, 1) + '\n');
  console.log(`metal plates: ${Object.keys(plates).join(', ') || 'none'}`);
}

async function main() {
  const [cmd, id] = process.argv.slice(2);
  if (cmd === 'prepare' && id) return prepare(id);
  if (cmd === 'pad' && id) return pad(id);
  if (cmd === 'assemble' && id) return assemble(id);
  throw new Error('usage: metal-bake.js prepare|pad|assemble <template-id>');
}

main().catch((err) => { console.error(err); process.exit(1); });
