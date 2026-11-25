'use strict';

/**
 * Give a single-collar template the same rose gold shades, thread and square framing as the
 * /listing template (creatsy-stack), so the page's "Rose gold shade" picker and square
 * download work on it exactly as on /listing.
 *
 *   node --max-old-space-size=8000 src/tools/rosegold-shades.js <template-id> [...]
 *
 * Run src/tools/fit-finishes.js on the template first (its metal colours come from there).
 *
 * 1. Rose gold plates. /listing swaps between baked rose gold plates (layered.metalPlateOptions
 *    .rosegold: "Blush (original)", "Rose", "Copper Rose", "Warm Copper", "Deep Copper"). The
 *    template's own fitted rose gold metal (rendered with no engraving) becomes its "Blush
 *    (original)" plate. Each other shade is made from it with the colour change measured
 *    pixel by pixel between /listing's own "Blush (original)" plate and that shade's plate
 *    (mean Lab per lightness), so every shade moves the same way it does on /listing.
 *    The default is /listing's default shade.
 * 2. Thread colour, tint, opacity and softening: /listing's values.
 * 3. squareCrop (the square download's framing): the product's extent in the photo, as the
 *    three original single-collar views have it.
 * Writes poc/templates/<id>/metal-rosegold*.png and templates/<id>.json.
 */
const fs = require('fs');
const sharp = require('sharp');
const { fromRoot } = require('../paths');
const { renderFrame, readTemplate } = require('../mockup/node-io');

const REF = 'creatsy-stack';
const THREAD_KEYS = ['threadColor', 'threadTint', 'threadOpacity', 'threadSoften'];

/* ---------- sRGB <-> Lab (D65) ---------- */
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fi = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
function toLab(r, g, b) {
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function toRgb(L, a, b) {
  const fy = (L + 16) / 116, X = 0.95047 * fi(fy + a / 500), Y = fi(fy), Z = 1.08883 * fi(fy - b / 200);
  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return [R, G, B].map((c) => Math.round(Math.max(0, Math.min(1, gam(Math.max(0, c)))) * 255));
}

/** Per lightness bin (0-100): mean Lab change from /listing's original plate to one shade. */
async function shadeShift(baseFile, shadeFile) {
  const [a, b] = await Promise.all([baseFile, shadeFile].map((p) => sharp(fromRoot(p)).ensureAlpha().raw().toBuffer()));
  const acc = Array.from({ length: 101 }, () => [0, 0, 0, 0]);
  for (let p = 0; p < a.length; p += 4) {
    if (a[p + 3] < 250 || b[p + 3] < 250) continue;
    const s = toLab(a[p], a[p + 1], a[p + 2]), t = toLab(b[p], b[p + 1], b[p + 2]);
    const bin = acc[Math.round(s[0])];
    bin[0]++; bin[1] += t[0] - s[0]; bin[2] += t[1] - s[1]; bin[3] += t[2] - s[2];
  }
  const shift = acc.map((v) => (v[0] >= 20 ? [v[1] / v[0], v[2] / v[0], v[3] / v[0]] : null));
  // bins with too few pixels take the nearest measured bin
  for (let i = 0; i <= 100; i++) {
    if (shift[i]) continue;
    for (let d = 1; d <= 100; d++) {
      const n = shift[i - d] || shift[i + d];
      if (n) { shift[i] = n; break; }
    }
  }
  return shift;
}

function metalCoverage(template, bin) {
  const W = template.width, H = template.height, cov = new Float32Array(W * H);
  for (const l of template.layered.stack) {
    if (l.role !== 'metal') continue;
    const r = l.alpha, a = new Uint8Array(bin.buffer, bin.byteOffset + r.offset, r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const i = (r.y + y) * W + r.x + x;
      cov[i] = Math.max(cov[i], a[y * r.w + x] / 255);
    }
  }
  return cov;
}

function productExtent(template, bin) {
  const W = template.width;
  let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
  for (const l of template.layered.stack) {
    const r = l.alpha, a = new Uint8Array(bin.buffer, bin.byteOffset + r.offset, r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      if (a[y * r.w + x] <= 128) continue;
      const X = r.x + x, Y = r.y + y;
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
  }
  return { beltX: [x0, x1 + 1], productY: [y0, y1 + 1], margin: 0.09 };
}

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length) throw new Error('usage: rosegold-shades.js <template-id> [...]');
  const ref = readTemplate(REF).layered;
  const options = ref.metalPlateOptions.rosegold;
  const base = options[0]; // "Blush (original)": the plate the other shades were toned from
  const defaultLabel = options.find((o) => o.file === ref.metalPlates.rosegold).label;
  const shifts = {};
  for (const o of options.slice(1)) shifts[o.label] = await shadeShift(base.file, o.file);

  for (const id of ids) {
    const template = readTemplate(id);
    if (!template.layered.finishRamps) throw new Error(`${id}: run src/tools/fit-finishes.js ${id} first`);
    const bin = fs.readFileSync(fromRoot(template.layered.bin));
    const W = template.width, H = template.height;
    for (const k of THREAD_KEYS) template.layered[k] = ref[k];
    delete template.layered.metalPlates; // render the fitted metal, not an earlier plate

    // 1. the template's own fitted rose gold, no engraving
    const all = Object.fromEntries(Object.keys(template.slots).map((s) => [s, 'rosegold']));
    const decision = JSON.parse(fs.readFileSync(fromRoot('decisions', 'christmas-gingerbread.json'), 'utf8'));
    const png = await renderFrame({ template, patternFile: decision.patternFile, finishBySlot: all, collarBySlot: {} });
    const rgb = await sharp(png).removeAlpha().raw().toBuffer();
    const cov = metalCoverage(template, bin);
    // plate colour = the metal's own colour; edge pixels (part metal, part fabric) take the
    // colour of the nearest solid metal so no fabric colour is baked into the plate
    const col = new Float32Array(W * H * 3), have = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (cov[i] > 0.98) { have[i] = 1; for (let c = 0; c < 3; c++) col[i * 3 + c] = rgb[i * 3 + c]; }
    for (let pass = 0; pass < 6; pass++) {
      const next = have.slice();
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (have[i] || cov[i] <= 0) continue;
        let n = 0; const s = [0, 0, 0];
        for (const j of [i - 1, i + 1, i - W, i + W]) if (have[j]) { n++; for (let c = 0; c < 3; c++) s[c] += col[j * 3 + c]; }
        if (n) { next[i] = 1; for (let c = 0; c < 3; c++) col[i * 3 + c] = s[c] / n; }
      }
      have.set(next);
    }
    const plate = Buffer.alloc(W * H * 4);
    let px = 0;
    for (let i = 0; i < W * H; i++) {
      if (cov[i] <= 0) continue;
      for (let c = 0; c < 3; c++) plate[i * 4 + c] = Math.round(have[i] ? col[i * 3 + c] : rgb[i * 3 + c]);
      plate[i * 4 + 3] = 255;
      px++;
    }

    // 2. the shades
    const dir = `poc/templates/${id}`;
    const files = {};
    const write = async (label, buf) => {
      const name = options.find((o) => o.label === label).file.split('/').pop();
      await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toFile(fromRoot(dir, name));
      files[label] = `${dir}/${name}`;
    };
    await write(base.label, plate);
    for (const [label, shift] of Object.entries(shifts)) {
      const out = Buffer.from(plate);
      for (let p = 0; p < out.length; p += 4) {
        if (!out[p + 3]) continue;
        const [L, a, b] = toLab(out[p], out[p + 1], out[p + 2]);
        const d = shift[Math.max(0, Math.min(100, Math.round(L)))];
        [out[p], out[p + 1], out[p + 2]] = toRgb(L + d[0], a + d[1], b + d[2]);
      }
      await write(label, out);
    }
    template.layered.metalPlateOptions = { rosegold: options.map((o) => ({ label: o.label, file: files[o.label] })) };
    template.layered.metalPlates = { rosegold: files[defaultLabel] };

    // 3. square download framing
    if (!template.squareCrop) template.squareCrop = productExtent(template, bin);

    const file = fromRoot('templates', `${id}.json`);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of THREAD_KEYS) json.layered[k] = template.layered[k];
    json.layered.metalPlates = template.layered.metalPlates;
    json.layered.metalPlateOptions = template.layered.metalPlateOptions;
    json.squareCrop = template.squareCrop;
    fs.writeFileSync(file, JSON.stringify(json, null, 1) + '\n');
    console.log(`${id}: ${px} metal px, shades ${options.map((o) => o.label).join(' / ')} (default ${defaultLabel}), squareCrop ${JSON.stringify(json.squareCrop)}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
