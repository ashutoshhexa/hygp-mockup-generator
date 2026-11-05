'use strict';

/**
 * Snap strap edges to the webbing boundary measured in the template photo.
 *
 *   node src/tools/snap-straps.js <templateId> [--layers a,b] [--step 30] [--dry]
 *
 * For each strap, rungs are resampled every --step px along the strap. Each rung
 * endpoint is searched along the rung direction (±14px) for:
 *   1. a smooth -> woven transition (studio background against webbing), or
 *   2. a dark seam (where one collar meets the next, or the webbing meets metal).
 * Endpoints with no clear edge keep their hand-placed position. Results are
 * median-smoothed along the strap so one noisy measurement can't make a notch.
 */
const fs = require('fs');
const sharp = require('sharp');
const { fromRoot } = require('../paths');
const { densifyRungs } = require('../mockup/core');

const args = process.argv.slice(2);
const id = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const only = opt('--layers', null);
const STEP = Number(opt('--step', 30));
const SEARCH = Number(opt('--search', 16));
const dry = args.includes('--dry');

function compact(v) {
  return JSON.stringify(v, null, 2).replace(/\[\s+([-\d.e]+(?:,\s+[-\d.e]+)*)\s+\]/g, (m, i) => `[${i.split(/,\s+/).join(', ')}]`);
}

async function main() {
  const file = fromRoot('templates', `${id}.json`);
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { data, info } = await sharp(fromRoot(t.base)).resize(t.width, t.height, { fit: 'fill' })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const L = (x, y) => {
    const xi = Math.max(0, Math.min(W - 1, Math.round(x))), yi = Math.max(0, Math.min(H - 1, Math.round(y)));
    return data[yi * W + xi];
  };
  const lap = (x, y) => Math.abs(4 * L(x, y) - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1));
  // texture energy in a thin window laid ALONG the strap (vx,vy), so an edge stays sharp across it
  const tex = (x, y, vx, vy) => {
    let s = 0, n = 0;
    for (let a = -3; a <= 3; a++) for (let b = -1; b <= 1; b++) {
      s += lap(x + vx * a - vy * b, y + vy * a + vx * b);
      n++;
    }
    return s / n;
  };

  // walk from inside (p) toward outside along unit (ux,uy); return outermost edge distance
  function findEdge(px, py, ux, uy) {
    const prof = [];
    const vx = -uy, vy = ux;
    for (let k = -SEARCH; k <= SEARCH; k++) {
      const x = px + ux * k, y = py + uy * k;
      prof.push({ k, l: L(x, y), t: tex(x, y, vx, vy) });
    }
    // 1. smooth outside: find the first k (from outside in) where the next 4 outward samples are smooth
    for (let i = prof.length - 1; i >= 4; i--) {
      const outside = prof.slice(i, Math.min(prof.length, i + 4));
      if (outside.length < 3) continue;
      const smooth = outside.every((p) => p.t < 2.2);
      const inside = prof.slice(Math.max(0, i - 3), i);
      const woven = inside.length === 3 && inside.every((p) => p.t > 3.5);
      if (smooth && woven) return { k: prof[i].k - 0.5, how: 'bg' };
    }
    // 2. dark seam: darkest sample clearly below its neighbourhood
    const med = prof.map((p) => p.l).sort((a, b) => a - b)[Math.floor(prof.length / 2)];
    let best = null;
    for (const p of prof) if (p.l < med * 0.82 && (!best || p.l < best.l)) best = p;
    if (best && Math.abs(best.k) <= SEARCH - 1) return { k: best.k, how: 'seam' };
    return null;
  }

  const median = (arr, i, r = 2) => {
    const w = arr.slice(Math.max(0, i - r), i + r + 1).filter((v) => v != null).sort((a, b) => a - b);
    return w.length ? w[Math.floor(w.length / 2)] : null;
  };

  const report = [];
  for (const layer of t.layers) {
    if (layer.type !== 'strap' || !layer.rungs || layer.rungs.length < 2) continue;
    if (only && !only.split(',').includes(layer.id)) continue;
    if (layer.snap === false) continue;
    const dense = densifyRungs(layer.rungs, 2);
    // resample every STEP px along the midline, always keeping both ends
    const picks = [dense[0]];
    let acc = 0;
    for (let i = 1; i < dense.length; i++) {
      const a = dense[i - 1], b = dense[i];
      acc += Math.hypot((b.tx + b.bx - a.tx - a.bx) / 2, (b.ty + b.by - a.ty - a.by) / 2);
      if (acc >= STEP && i < dense.length - 1) { picks.push(b); acc = 0; }
    }
    picks.push(dense[dense.length - 1]);

    const topK = [], botK = [];
    for (const r of picks) {
      const len = Math.hypot(r.bx - r.tx, r.by - r.ty) || 1;
      const ux = (r.bx - r.tx) / len, uy = (r.by - r.ty) / len;
      const top = findEdge(r.tx, r.ty, -ux, -uy);
      const bot = findEdge(r.bx, r.by, ux, uy);
      topK.push(top ? top.k : null);
      botK.push(bot ? bot.k : null);
    }
    // median (kills outliers) then a 3-tap average (kills steps) so edges stay smooth curves
    const smooth = (arr) => {
      const med = arr.map((_, i) => median(arr, i, 2));
      return med.map((v, i) => {
        const w = [med[i - 1], v, med[i + 1]].filter((x) => x != null);
        return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
      });
    };
    const topS = smooth(topK), botS = smooth(botK);
    const rungs = picks.map((r, i) => {
      const len = Math.hypot(r.bx - r.tx, r.by - r.ty) || 1;
      const ux = (r.bx - r.tx) / len, uy = (r.by - r.ty) / len;
      const kt = topS[i] ?? 0, kb = botS[i] ?? 0;
      return [r.tx - ux * kt, r.ty - uy * kt, r.bx + ux * kb, r.by + uy * kb].map((v) => Math.round(v * 2) / 2);
    });
    const moved = rungs.map((r, i) => Math.max(
      Math.hypot(r[0] - picks[i].tx, r[1] - picks[i].ty), Math.hypot(r[2] - picks[i].bx, r[3] - picks[i].by)));
    report.push(`${layer.id.padEnd(18)} ${String(rungs.length).padStart(3)} rungs, max move ${Math.max(...moved).toFixed(1)}px, ` +
      `found top ${topK.filter((k) => k != null).length}/${picks.length} bottom ${botK.filter((k) => k != null).length}/${picks.length}`);
    layer.rungs = rungs;
  }
  console.log(report.join('\n'));
  if (!dry) {
    fs.writeFileSync(file, compact(t) + '\n');
    console.log(`saved ${file}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
