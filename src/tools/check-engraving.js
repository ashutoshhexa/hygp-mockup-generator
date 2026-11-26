'use strict';

/**
 * Check the engraving on every buckle of the single-collar views, with real lettering.
 *
 *   node src/tools/check-engraving.js [templateId ...]      (default: templates/single-collar*.json)
 *
 * For each engraving slot it reports, from the template's own data:
 *   - the direction the name reads in and the direction the lines step in (engraving-axes.js),
 *     and fails on text that would read sideways, upside down or mirrored
 *   - how much of the slot lies on that collar's buckle metal (anything off it would float)
 * Then it renders every view the way the page does (plan.planFrame -> node-io.renderFrame, the
 * same core and lettering as the browser) with "Frosty" / 419-555-0173 on every collar and once
 * more with a long name, and writes a sheet of every engraved buckle, both renders side by side:
 *   out/engraving-check/sheet.png
 * Exit code 1 when any slot fails.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { fromRoot } = require('../paths');
const plan = require('../mockup/plan');
const { renderFrame, readTemplate } = require('../mockup/node-io');
const { repeatTransform } = require('../mockup/core');
const { axesFromUV, axesProblems } = require('./engraving-axes');

const NAMES = [{ name: 'Frosty', phone: '419-555-0173' }, { name: 'Maximilian Barkington', phone: '419-555-0173' }];
const FONTS = ['Pacifico', 'DM Serif', 'Roboto'];
const OUT = fromRoot('out', 'engraving-check');

function slotData(template, bin) {
  const u8 = (r) => new Uint8Array(bin.buffer, bin.byteOffset + r.offset, r.w * r.h);
  const u16 = (r) => new Uint16Array(bin.buffer.slice(bin.byteOffset + r.offset, bin.byteOffset + r.offset + r.w * r.h * 4));
  const metalAt = (slot) => {
    const parts = template.layered.stack.filter((l) => l.role === 'metal' && l.slot === slot).map((l) => ({ ref: l.alpha, a: u8(l.alpha) }));
    return (x, y) => {
      let m = 0;
      for (const { ref, a } of parts) {
        const lx = x - ref.x, ly = y - ref.y;
        if (lx >= 0 && ly >= 0 && lx < ref.w && ly < ref.h) m = Math.max(m, a[ly * ref.w + lx] / 255);
      }
      return m;
    };
  };
  return template.layered.engravings.map((op) => {
    const A = u8(op.alpha), U = u16(op.uv), n = op.uv.w * op.uv.h, metal = metalAt(op.slot);
    const pts = [];
    let sum = 0, on = 0;
    for (let y = 0; y < op.uv.h; y += 2) for (let x = 0; x < op.uv.w; x += 2) {
      const i = y * op.uv.w + x, ax = op.alpha.x + x, ay = op.alpha.y + y;
      const ai = (ay - op.alpha.y) * op.alpha.w + (ax - op.alpha.x);
      const a = A[ai] / 255;
      if (!a) continue;
      pts.push({ x: op.uv.x + x, y: op.uv.y + y, u: U[i] / op.uv.su, v: U[n + i] / op.uv.sv });
      sum += a; on += Math.min(a, metal(ax, ay));
    }
    const ax = axesFromUV(pts);
    const repeat = template.layered.repeat;
    if (repeat) {
      const turn = (angle) => Math.atan2(Math.sin(angle * Math.PI / 180), Math.cos(angle * Math.PI / 180)) * 180 / Math.PI;
      ax.reading = turn(ax.reading + repeat.angle);
      ax.lines = turn(ax.lines + repeat.angle);
    }
    return { slot: op.slot, box: op.alpha, axes: ax, problems: axesProblems(ax), onMetal: sum ? on / sum : 0 };
  });
}

function visibleBox(template, box) {
  const repeat = template.layered.repeat;
  if (!repeat) return box;
  const tile = repeat.tiles.find(({ crop: [x, y, w, h] }) => box.x >= x && box.x + box.w <= x + w && box.y >= y && box.y + box.h <= y + h);
  const { width, height } = template;
  const boxes = tile.positions.map((position) => {
    const { forward } = repeatTransform({ ...tile, angle: repeat.angle }, position);
    const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]]
      .map(([x, y]) => forward(x, y));
    const xs = corners.map(([x]) => x), ys = corners.map(([, y]) => y);
    const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
    return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
  });
  const distance = ({ x, y }) => Math.hypot(x - width / 2, y - height / 2);
  return boxes.filter(({ x, y, w, h }) => x >= 0 && y >= 0 && x + w <= width && y + h <= height)
    .sort((a, b) => distance(a) - distance(b))[0];
}

async function renderWith(templateId, template, names) {
  const decision = JSON.parse(fs.readFileSync(fromRoot('decisions', 'christmas-gingerbread.json'), 'utf8'));
  decision.listing.collars = [0, 1, 2].map((i) => ({ ...names, font: FONTS[i] }));
  const frame = { id: templateId, label: templateId, template: templateId, background: 'decision' };
  const p = plan.planFrame(frame, template, decision, null);
  return sharp(await renderFrame({ ...p, template, patternFile: decision.patternFile, background: null })).raw().toBuffer({ resolveWithObject: true });
}

async function main() {
  const ids = process.argv.slice(2).length ? process.argv.slice(2)
    : fs.readdirSync(fromRoot('templates')).filter((f) => /^single-collar.*\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')).sort();
  fs.mkdirSync(OUT, { recursive: true });
  const surfaces = JSON.parse(fs.readFileSync(fromRoot('templates', 'engraving-surfaces.json'), 'utf8'));
  const rows = [];
  let failed = 0;
  for (const id of ids) {
    const template = readTemplate(id);
    const bin = fs.readFileSync(fromRoot(template.layered.bin));
    const slots = slotData(template, bin);
    if (!slots.length) {
      const off = (surfaces[id] && Object.entries(surfaces[id]).filter(([, v]) => v.engrave === false).map(([k]) => k)) || [];
      console.log(`${id.padEnd(30)} no engraving slot (${off.length ? 'left off in engraving-surfaces.json' : 'the PSD has no engraving layer for this buckle'})`);
      continue;
    }
    const renders = [];
    for (const names of NAMES) renders.push(await renderWith(id, template, names));
    for (const s of slots) {
      const ok = !s.problems.length && s.onMetal > 0.98;
      if (!ok) failed++;
      console.log(`${id.padEnd(30)} ${s.slot.padEnd(7)} reads ${s.axes.reading.toFixed(0).padStart(4)} deg, lines ${s.axes.lines.toFixed(0).padStart(4)} deg, ` +
        `on metal ${(s.onMetal * 100).toFixed(0).padStart(3)}%  ${ok ? 'ok' : 'FAIL ' + [...s.problems, s.onMetal <= 0.98 ? 'off the buckle' : ''].filter(Boolean).join(', ')}`);
      // crop around the slot, padded, the same box in both renders
      const box = visibleBox(template, s.box);
      if (!box) continue;
      const pad = Math.max(60, Math.round(Math.max(box.w, box.h) * 0.35));
      const W = renders[0].info.width, H = renders[0].info.height;
      const left = Math.max(0, box.x - pad), top = Math.max(0, box.y - pad);
      const width = Math.min(W - left, box.w + 2 * pad), height = Math.min(H - top, box.h + 2 * pad);
      const crops = await Promise.all(renders.map((r) => sharp(r.data, { raw: r.info }).extract({ left, top, width, height }).resize(300, 300, { fit: 'contain', background: '#fff' }).png().toBuffer()));
      rows.push({ label: `${id.replace('single-collar', 'view').replace(/^view$/, 'view-default')} / ${s.slot}  reads ${s.axes.reading.toFixed(0)}°  metal ${(s.onMetal * 100).toFixed(0)}%  ${ok ? 'OK' : 'FAIL'}`, crops });
    }
  }
  // sheet: one row per engraved buckle, Frosty | long name
  const rowH = 330, W = 620;
  const comp = [];
  rows.forEach((r, i) => {
    const y = i * rowH;
    comp.push({ input: Buffer.from(`<svg width="${W}" height="26"><rect width="${W}" height="26" fill="#222"/><text x="6" y="18" fill="#fff" font-family="sans-serif" font-size="14">${r.label}</text></svg>`), left: 0, top: y });
    r.crops.forEach((c, k) => comp.push({ input: c, left: k * 310 + 5, top: y + 28 }));
  });
  if (rows.length) {
    await sharp({ create: { width: W, height: rows.length * rowH, channels: 3, background: '#ddd' } }).composite(comp).png().toFile(path.join(OUT, 'sheet.png'));
    console.log(`\n${rows.length} engraved buckles, ${failed} failing. Sheet: ${path.relative(fromRoot(), path.join(OUT, 'sheet.png'))}`);
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exit(1); });
