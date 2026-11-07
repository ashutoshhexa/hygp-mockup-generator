'use strict';

/**
 * Re-tints a baked metal plate (poc/templates/<id>/metal-<finish>.png) toward the colour
 * of the real buckle, keeping the plate's own lightness (so every reflection, edge and
 * shadow stays where Grok/the PSD put it). Only the colour (Lab a*, b*) moves.
 *
 *   node src/tools/tone-plate.js <template-id> <target> [strength 0..1] [deepen 0..0.25] [chroma x]
 *   e.g. node src/tools/tone-plate.js creatsy-stack rosegold-rich 1 0.04
 *
 * TARGETS hold the measured colour of the real buckle per lightness band (Lab, D65),
 * from the client's reference photos of real silver / gold / rose gold buckles
 * (rose gold face, engraving excluded; two photos agreed within 1 unit).
 */
const fs = require('fs');
const sharp = require('sharp');
const { fromRoot } = require('../paths');

const TARGETS = {
  // [L, a*, b*]
  rosegold: [[30, 8, 13], [45, 10, 16], [60, 11, 18], [88, 11, 18], [96, 6, 12], [100, 2.5, 6]],
  // richer, pinker copper (client: "too pale"), after the rose gold buckle in
  // poc/templates/03-infographic.jpg: its body sits at L 73-80 with chroma 21-23 and its mid tones
  // reach a* ~17, b* ~23; our plate's face was at L ~88, so it is also deepened (4th argument)
  'rosegold-rich': [[20, 16, 20], [35, 17, 23.5], [55, 17, 23.5], [70, 16, 23], [85, 14, 22], [93, 10, 17], [100, 4, 8]],
};

// optional 4th argument: deepen the body (L scaled toward 0 by up to this fraction for L 40-92,
// fading to none at the specular highlights and the darkest shadows)
function deepen(L, amount) {
  if (!amount) return L;
  const w = L < 40 ? L / 40 : L > 92 ? Math.max(0, (100 - L) / 8) : 1;
  return L * (1 - amount * w);
}

const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fi = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);

function toLab(r, g, b) {
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function toRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fi(fx) * 0.95047, Y = fi(fy), Z = fi(fz) * 1.08883;
  const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return [R, G, B].map((c) => Math.max(0, Math.min(255, Math.round(255 * gam(Math.max(0, Math.min(1, c)))))));
}

function targetAt(stops, L) {
  if (L <= stops[0][0]) return [stops[0][1], stops[0][2]];
  for (let i = 1; i < stops.length; i++) {
    if (L <= stops[i][0]) {
      const [l0, a0, b0] = stops[i - 1], [l1, a1, b1] = stops[i], t = (L - l0) / (l1 - l0);
      return [a0 + (a1 - a0) * t, b0 + (b1 - b0) * t];
    }
  }
  const s = stops[stops.length - 1];
  return [s[1], s[2]];
}

async function main() {
  const [id, target, strengthArg, deepenArg, chromaArg] = process.argv.slice(2);
  const stops = TARGETS[target];
  if (!id || !stops) throw new Error(`usage: tone-plate.js <template-id> <${Object.keys(TARGETS).join('|')}> [strength] [deepen 0..0.25] [chroma x]`);
  const strength = strengthArg == null ? 1 : Number(strengthArg);
  const deep = Number(deepenArg) || 0;
  const chroma = Number(chromaArg) || 1; // scales the target colour (1.3 = 30% more saturated)
  const fin = target.replace(/-.*$/, ''); // rosegold-rich tones the rosegold plate
  // the plate the template uses (its name changes when it is re-toned, so browsers that
  // cached the old one for a year fetch the new file)
  const tpl = JSON.parse(fs.readFileSync(fromRoot('templates', `${id}.json`), 'utf8'));
  const rel = tpl.layered && tpl.layered.metalPlates && tpl.layered.metalPlates[fin];
  if (!rel) throw new Error(`templates/${id}.json has no layered.metalPlates.${fin}`);
  const file = fromRoot(rel);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // the plate's own mean colour per lightness (1-unit bins), so local variation is kept
  const sum = Array.from({ length: 101 }, () => [0, 0, 0]);
  const labs = new Float32Array((data.length / 4) * 3);
  for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
    if (!data[p + 3]) continue;
    const [L, a, b] = toLab(data[p], data[p + 1], data[p + 2]);
    labs[q] = L; labs[q + 1] = a; labs[q + 2] = b;
    const s = sum[Math.round(L)]; s[0]++; s[1] += a; s[2] += b;
  }
  const mean = sum.map((s) => (s[0] ? [s[1] / s[0], s[2] / s[0]] : null));

  let before = [0, 0, 0], after = [0, 0, 0];
  for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
    if (!data[p + 3]) continue;
    const L = labs[q], a = labs[q + 1], b = labs[q + 2];
    const m = mean[Math.round(L)];
    const [ta, tb] = targetAt(stops, L).map((v) => v * chroma);
    // shift the band's mean onto the target; keep 70% of each pixel's own deviation
    const na = a + (ta + (a - m[0]) * 0.7 - a) * strength;
    const nb = b + (tb + (b - m[1]) * 0.7 - b) * strength;
    const [r, g, bb] = toRgb(deepen(L, deep), na, nb);
    data[p] = r; data[p + 1] = g; data[p + 2] = bb;
    before[0]++; before[1] += a; before[2] += b;
    after[1] += na; after[2] += nb;
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(file + '.tmp');
  fs.renameSync(file + '.tmp', file);
  const n = before[0];
  console.log(`${fin}: mean a*,b* ${(before[1] / n).toFixed(1)},${(before[2] / n).toFixed(1)} -> ${(after[1] / n).toFixed(1)},${(after[2] / n).toFixed(1)} (${n} px)`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
