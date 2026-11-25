'use strict';

/**
 * Turn a layered mockup PSD (Creatsy-style) into a "layered" template.
 *
 *   node src/tools/import-psd.js <file.psd> <templateId> [--crop x,y,w,h] [--width 3000] [--name "..."]
 *
 * Engraving: each buckle's slot comes from the PSD's "Design: buckle (engraved)" layer, unless
 * templates/engraving-surfaces.json draws that buckle's plate (see the file). Either way the
 * slot is kept on the buckle metal, and an import that would put text sideways, upside down
 * or mirrored stops with an error (src/tools/engraving-axes.js).
 * --engrave-shift dx,dy moves the engraving slots (output px) when the PSD's hidden
 * "Design: buckle (engraved)" layer was never lined up with the buckle face.
 *
 * Single-collar PSDs (base layer "Color: fabric" or "Color: collar", "Color: buckles", no "/collar N") become
 * one slot, "collar" (collar 0, centre role), instead of the three-collar stack.
 *
 * Nothing is traced by hand. The PSD already holds, per collar:
 *   Color: collar N            - the webbing silhouette (clip base / fills)
 *   Design: fabric ... /collar N - smart objects with Photoshop warps (where the print goes)
 *   Color: buckles /collar N   - metal mask (re-coloured for gold / rose gold / silver)
 *   Color: seam thread         - stitching mask
 *   Overlay layers             - Levels, soft light / multiply / screen shading, Hue/Sat
 *   Design: buckle (engraved)  - warped engraving slot per buckle (multiply)
 * The importer bakes everything below the collars into below.png, and writes every
 * mask, shading layer and warp (as a per-pixel content-UV map) into layers.bin.
 * core.js replays the same stack at render time with the real pattern and finishes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { readPsd, initializeCanvas } = require('ag-psd');
const { fromRoot } = require('../paths');
const { placedMapper, rasterizeUV, FRAMES, homography } = require('./psd-warp');
const { axesFromMapper, axesProblems } = require('./engraving-axes');

initializeCanvas(() => { throw new Error('canvas not needed'); }, (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));

const args = process.argv.slice(2);
const psdFile = args[0];
const id = args[1];
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
if (!psdFile || !id) {
  console.error('usage: node src/tools/import-psd.js <file.psd> <templateId> [--crop x,y,w,h] [--width 3000]');
  process.exit(1);
}

// PSD collar number -> template slot. The UI's Left / Middle / Right collars read top to bottom
// here; the middle collar sits in the centre of the frame, so it carries the best-seller finish.
const SLOTS = {
  1: { slot: 'top', label: 'Top collar', role: 'left', collar: 0 },
  2: { slot: 'middle', label: 'Middle collar', role: 'center', collar: 1 },
  3: { slot: 'bottom', label: 'Bottom collar', role: 'right', collar: 2 },
};
const SINGLE = { slot: 'collar', label: 'Collar', role: 'center', collar: 0 };

// hand-drawn engraving plates for this template, by slot (templates/engraving-surfaces.json)
const surfacesFile = fromRoot('templates', 'engraving-surfaces.json');
const engravingPlates = (fs.existsSync(surfacesFile) && JSON.parse(fs.readFileSync(surfacesFile, 'utf8'))[id]) || {};

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

/* ---------- area resampling (exact box filter, so masks stay clean) ---------- */
function resampleAxis(src, sw, sh, dw, horizontal) {
  // resample along one axis; returns Float32Array
  const n = horizontal ? sw : sh, m = horizontal ? sh : sw;
  const out = new Float32Array(horizontal ? dw * sh : sw * dw);
  const scale = n / dw;
  const spans = [];
  for (let o = 0; o < dw; o++) {
    const a = o * scale, b = (o + 1) * scale;
    const w = [];
    for (let k = Math.floor(a); k < Math.min(n, Math.ceil(b)); k++) {
      const wt = Math.min(b, k + 1) - Math.max(a, k);
      if (wt > 0) w.push([k, wt / scale]);
    }
    spans.push(w);
  }
  for (let j = 0; j < m; j++) {
    for (let o = 0; o < dw; o++) {
      let acc = 0;
      for (const [k, wt] of spans[o]) acc += wt * src[horizontal ? j * sw + k : k * sw + j];
      out[horizontal ? j * dw + o : o * sw + j] = acc;
    }
  }
  return out;
}
const resample = (src, sw, sh, dw, dh) => resampleAxis(resampleAxis(src, sw, sh, dw, true), dw, sh, dh, false);

async function main() {
  log('reading', psdFile);
  const psd = readPsd(fs.readFileSync(psdFile), { useImageData: true, skipThumbnail: true });
  const [CX, CY, CW, CH] = (opt('--crop', '') ? opt('--crop').split(',').map(Number) : [918, 396, 4400, 3300]);
  const OW = Number(opt('--width', 3000));
  const OH = Math.round((OW * CH) / CW);
  const s = OW / CW;
  log(`doc ${psd.width}x${psd.height}, crop ${CX},${CY} ${CW}x${CH} -> ${OW}x${OH}`);

  // flatten the tree, keeping parents for visibility checks
  const all = [];
  (function walk(list, parents) {
    for (const l of list || []) {
      all.push({ l, parents });
      if (l.children) walk(l.children, parents.concat(l));
    }
  })(psd.children, []);
  const visible = (e) => !e.l.hidden && e.parents.every((p) => !p.hidden);
  const find = (re) => all.filter((e) => re.test(e.l.name || ''));

  /* ---------- full-res crop helpers ---------- */
  // alpha of a layer at full res inside the crop: image alpha x layer mask
  function alphaFull(l, { image = true } = {}) {
    const a = new Float32Array(CW * CH);
    const img = l.imageData;
    if (image && img) {
      for (let y = Math.max(0, l.top - CY); y < Math.min(CH, l.bottom - CY); y++) {
        for (let x = Math.max(0, l.left - CX); x < Math.min(CW, l.right - CX); x++) {
          a[y * CW + x] = img.data[((y + CY - l.top) * img.width + (x + CX - l.left)) * 4 + 3] / 255;
        }
      }
    } else a.fill(1);
    const m = l.mask;
    if (m && !m.disabled && m.imageData) {
      const def = (m.defaultColor || 0) / 255;
      const mi = m.imageData;
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
        const dx = x + CX - m.left, dy = y + CY - m.top;
        const v = dx >= 0 && dy >= 0 && dx < mi.width && dy < mi.height ? mi.data[(dy * mi.width + dx) * 4] / 255 : def;
        a[y * CW + x] *= v;
      }
    }
    return a;
  }
  // gray (R channel) of a raster layer at full res, premultiplied by alpha
  function grayFull(l, a) {
    const g = new Float32Array(CW * CH);
    const img = l.imageData;
    for (let y = Math.max(0, l.top - CY); y < Math.min(CH, l.bottom - CY); y++) {
      for (let x = Math.max(0, l.left - CX); x < Math.min(CW, l.right - CX); x++) {
        const i = y * CW + x;
        g[i] = (img.data[((y + CY - l.top) * img.width + (x + CX - l.left)) * 4] / 255) * a[i];
      }
    }
    return g;
  }
  const down = (f) => resample(f, CW, CH, OW, OH);

  /* ---------- binary store ---------- */
  const chunks = [];
  let offset = 0;
  const seen = new Map();
  function bbox(a, thr = 1 / 512) {
    let x0 = OW, y0 = OH, x1 = -1, y1 = -1;
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
      if (a[y * OW + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  function put(bytes, align = 2) {
    const pad = (align - (offset % align)) % align;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    const at = offset;
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    offset += bytes.byteLength;
    return at;
  }
  // store an output-res float plane (0..1) cropped to box as u8
  function putU8(plane, box) {
    const b = new Uint8Array(box.w * box.h);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
      b[y * box.w + x] = Math.round(Math.max(0, Math.min(1, plane[(y + box.y) * OW + x + box.x])) * 255);
    }
    const key = crypto.createHash('sha1').update(b).digest('hex') + JSON.stringify(box);
    if (seen.has(key)) return seen.get(key);
    const ref = { ...box, type: 'u8', offset: put(b, 1) };
    seen.set(key, ref);
    return ref;
  }
  // content UV, packed as two u16 planes. v may run past the strip (see edgeFill): then it is
  // stored shifted by v0 and the renderer subtracts it again
  function putUV(uv, box, cw, chh) {
    let vmin = 0, vmax = chh;
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
      const i = (y + box.y) * OW + x + box.x;
      if (uv.hit[i]) { vmin = Math.min(vmin, uv.v[i]); vmax = Math.max(vmax, uv.v[i]); }
    }
    const v0 = Math.ceil(-vmin);
    const su = Math.floor(65535 / cw), sv = Math.floor(65535 / (Math.ceil(vmax) + v0));
    const n = box.w * box.h;
    const b = new Uint16Array(n * 2);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
      const i = (y + box.y) * OW + x + box.x, k = y * box.w + x;
      b[k] = Math.round(Math.max(0, Math.min(cw, uv.u[i])) * su);
      b[n + k] = Math.round(Math.max(0, Math.min(vmax + v0, uv.v[i] + v0)) * sv);
    }
    return { ...box, type: 'uv16', su, sv, ...(v0 ? { v0 } : {}), offset: put(b, 2) };
  }
  // give every covered pixel a UV, even where the tessellation just missed it
  function fillUV(uv, alpha) {
    const need = (i) => alpha[i] > 0 && !uv.hit[i];
    for (let pass = 0; pass < 8; pass++) {
      let left = 0;
      const nu = uv.u.slice(), nv = uv.v.slice(), nh = uv.hit.slice();
      for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
        const i = y * OW + x;
        if (!need(i)) continue;
        let su = 0, sv = 0, c = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) continue;
          const j = yy * OW + xx;
          if (uv.hit[j]) { su += uv.u[j]; sv += uv.v[j]; c++; }
        }
        if (c) { nu[i] = su / c; nv[i] = sv / c; nh[i] = 1; } else left++;
      }
      uv.u = nu; uv.v = nv; uv.hit = nh;
      if (!left) break;
    }
  }

  /* ---------- frame choice for warped pieces (see section 2) ---------- */
  const coverage = (r, a, box) => {
    let need = 0, got = 0;
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
      const i = y * OW + x;
      need += a[i]; if (r.hit[i]) got += a[i];
    }
    return got / (need || 1);
  };
  // a smart object's own pixels (its embedded .psb), as darkness 0..1
  const contentMemo = new Map();
  function linkedContent(id) {
    if (contentMemo.has(id)) return contentMemo.get(id);
    let out = null;
    const f = (psd.linkedFiles || []).find((x) => x.id === id);
    if (f && f.data) {
      try {
        const q = readPsd(Buffer.from(f.data), { useImageData: true, skipThumbnail: true });
        const img = (q.children || []).map((c) => c.imageData).find(Boolean) || q.imageData;
        if (img) {
          const d = img.data, dark = new Float32Array(img.width * img.height);
          for (let i = 0; i < dark.length; i++) {
            const j = i * 4;
            dark[i] = (d[j + 3] / 255) * (1 - (0.3 * d[j] + 0.59 * d[j + 1] + 0.11 * d[j + 2]) / 255);
          }
          out = { w: img.width, h: img.height, dark };
        }
      } catch (err) { log('  embedded content unreadable:', err.message); }
    }
    contentMemo.set(id, out);
    return out;
  }
  // Photoshop's composite at output size, as darkness
  let compDark = null;
  async function compositeDark() {
    if (compDark) return compDark;
    const c = psd.imageData;
    const g = await sharp(Buffer.from(c.data.buffer, c.data.byteOffset, c.data.byteLength), { raw: { width: c.width, height: c.height, channels: 4 } })
      .extract({ left: CX, top: CY, width: CW, height: CH }).resize(OW, OH, { kernel: 'lanczos3' }).removeAlpha().greyscale().raw().toBuffer();
    compDark = new Float32Array(OW * OH);
    for (let i = 0; i < compDark.length; i++) compDark[i] = 1 - g[i] / 255;
    return compDark;
  }
  // box blur (radius r, clamped at the edges)
  function boxBlur2(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let acc = 0, c = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { acc += src[y * w + k]; c++; }
      tmp[y * w + x] = acc / c;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let acc = 0, c = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { acc += tmp[k * w + x]; c++; }
      out[y * w + x] = acc / c;
    }
    return out;
  }
  // normalised correlation, over the piece, of our drawing and Photoshop's. High-passed, so
  // lighting and shading do not count, only the print's own lines.
  async function matchComposite(r, a, box, content) {
    const ref = await compositeDark();
    const ours = new Float32Array(box.w * box.h), theirs = new Float32Array(box.w * box.h);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
      const i = (y + box.y) * OW + x + box.x, k = y * box.w + x;
      theirs[k] = ref[i];
      if (!r.hit[i]) continue;
      const u = Math.min(content.w - 1, Math.max(0, Math.floor(r.u[i]))), v = Math.min(content.h - 1, Math.max(0, Math.floor(r.v[i])));
      ours[k] = content.dark[v * content.w + u];
    }
    const bo = boxBlur2(ours, box.w, box.h, 6), bt = boxBlur2(theirs, box.w, box.h, 6);
    let ab = 0, aa = 0, bb = 0;
    for (let k = 0; k < ours.length; k++) {
      const wgt = a[(((k / box.w) | 0) + box.y) * OW + (k % box.w) + box.x];
      const A = ours[k] - bo[k], B = theirs[k] - bt[k];
      ab += wgt * A * B; aa += wgt * A * A; bb += wgt * B * B;
    }
    return ab / Math.sqrt(aa * bb + 1e-12);
  }
  // Fabric the warped content does not reach (a Puppet Warp smart filter, which is not
  // reproduced, can move a piece by a fraction of the strap): continue the same warp past the
  // strip's long edges, so the print carries on with the piece's own geometry instead of the
  // edge row being smeared across the gap.
  function edgeFill(uv, mapper, a, box) {
    const ext = rasterizeUV(mapper, OW, OH, [CX, CY], s, 3, mapper.height * 0.6);
    let filled = 0;
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
      const i = y * OW + x;
      if (a[i] > 0 && !uv.hit[i] && ext.hit[i]) { uv.u[i] = ext.u[i]; uv.v[i] = ext.v[i]; uv.hit[i] = 1; filled++; }
    }
    if (filled) log(`  continued the warp over ${filled} px past the strip's edges`);
  }

  /* ---------- 1. below: background group + drop shadow, baked at output res ---------- */
  const objectGroup = all.find((e) => e.l.name === 'Object' && e.l.children);
  const single = !all.some((e) => /collar \d/.test(e.l.name || ''));
  const baseRe = single ? /^Color: (fabric|collar)$/ : /^Color: collar \d/;
  const baseEntry = all.find((e) => baseRe.test(e.l.name) && !e.l.clipping && visible(e));
  log(single ? 'single-collar PSD' : 'multi-collar PSD');
  if (!objectGroup || !baseEntry) throw new Error('Not a recognised collar mockup (no Object group / collar base).');
  const below = new Float32Array(OW * OH * 3);
  const bgFill = all.find((e) => e.l.name === 'Color: background');
  const bgc = bgFill && bgFill.l.vectorFill && bgFill.l.vectorFill.color ? bgFill.l.vectorFill.color : { r: 255, g: 255, b: 255 };
  for (let i = 0; i < OW * OH; i++) { below[i * 3] = bgc.r / 255; below[i * 3 + 1] = bgc.g / 255; below[i * 3 + 2] = bgc.b / 255; }

  const blendFns = {
    'soft light': (a, b) => (b <= 0.5 ? 2 * a * b + a * a * (1 - 2 * b) : 2 * a * (1 - b) + Math.sqrt(a) * (2 * b - 1)),
    multiply: (a, b) => a * b,
    screen: (a, b) => 1 - (1 - a) * (1 - b),
    'linear burn': (a, b) => Math.max(0, a + b - 1),
    'color burn': (a, b) => (a >= 1 ? 1 : b <= 0 ? 0 : Math.max(0, 1 - (1 - a) / b)),
    normal: (a, b) => b,
  };
  // Photoshop's "special 8" modes apply FILL opacity inside the blend: the layer colour is
  // pulled toward the mode's neutral colour (white for the burns) before blending.
  const SPECIAL_FILL = { 'linear burn': 1, 'color burn': 1 };
  function applyRasterBlend(target, l, a, g, opacity) {
    const fn = blendFns[l.blendMode];
    if (!fn) throw new Error(`blend mode ${l.blendMode} not supported (${l.name})`);
    const fill = l.fillOpacity == null ? 1 : l.fillOpacity;
    const special = l.blendMode in SPECIAL_FILL && fill < 1;
    const op = special ? (l.opacity == null ? 1 : l.opacity) : opacity;
    for (let i = 0; i < OW * OH; i++) {
      const al = a[i] * op;
      if (al <= 0) continue;
      let b = g[i] / a[i];
      if (special) b = SPECIAL_FILL[l.blendMode] + (b - SPECIAL_FILL[l.blendMode]) * fill;
      for (let c = 0; c < 3; c++) {
        const base = target[i * 3 + c];
        target[i * 3 + c] = base + (fn(base, b) - base) * al;
      }
    }
  }
  const bakeStart = all.indexOf(bgFill) + 1;
  const firstClip = all.indexOf(baseEntry);
  const skipped = [];
  for (let k = bakeStart; k < firstClip; k++) {
    const e = all[k], l = e.l;
    if (l.children || !visible(e)) continue;
    if (l.adjustment) {
      // Levels 1 on white / Hue-Sat +5 on grey: identity on this neutral backdrop
      skipped.push(`${l.name} (${l.adjustment.type}, neutral on white backdrop)`);
      continue;
    }
    if (!l.imageData) continue;
    const opacity = (l.opacity == null ? 1 : l.opacity) * (l.fillOpacity == null ? 1 : l.fillOpacity);
    const af = alphaFull(l);
    const g = down(grayFull(l, af));
    const a = down(af);
    applyRasterBlend(below, l, a, g, opacity);
    log('baked', l.name, l.blendMode, opacity.toFixed(3));
  }

  /* ---------- 2. collar stack ---------- */
  const baseAlphaFull = alphaFull(baseEntry.l);
  const layers = [];
  const engravings = [];
  const overlay = [];
  const slotOf = (name) => { if (single) return SINGLE; const m = /collar (\d)/.exec(name); return m ? SLOTS[Number(m[1])] : null; };
  const objectEnd = (() => { let k = firstClip; while (k < all.length && all[k].parents.includes(objectGroup.l)) k++; return k; })();
  const overlayGroup = all.find((e) => /^Overlay layers/.test(e.l.name) && e.l.children);

  for (let k = firstClip; k < objectEnd; k++) {
    const e = all[k], l = e.l, name = l.name || '';
    if (l.children) continue;
    if (overlayGroup && e.parents.includes(overlayGroup.l)) {
      if (!visible(e)) continue;
      if (l.adjustment) {
        const am = down(alphaFull(l, { image: false }));
        const box = bbox(am);
        if (!box) continue;
        if (l.adjustment.type === 'levels') {
          const c = l.adjustment.rgb || (l.adjustment.channels && l.adjustment.channels[0]);
          overlay.push({ type: 'levels', name, inBlack: c.shadowInput, inWhite: c.highlightInput, outBlack: c.shadowOutput, outWhite: c.highlightOutput, gamma: c.midtoneInput || 1, mask: putU8(am, box) });
        } else if (l.adjustment.type === 'hue/saturation') {
          overlay.push({ type: 'hue', name, saturation: l.adjustment.master.saturation, lightness: l.adjustment.master.lightness, mask: putU8(am, box) });
        } else skipped.push(`${name} (${l.adjustment.type})`);
        continue;
      }
      if (!l.imageData) continue;
      const af = alphaFull(l);
      const a = down(af), g = down(grayFull(l, af));
      for (let i = 0; i < g.length; i++) g[i] = a[i] > 0 ? g[i] / a[i] : 0;
      const box = bbox(a);
      overlay.push({ type: 'blend', name, mode: l.blendMode, opacity: (l.opacity == null ? 1 : l.opacity) * (l.fillOpacity == null ? 1 : l.fillOpacity), alpha: putU8(a, box), gray: putU8(g, box) });
      log('overlay', name, l.blendMode);
      continue;
    }
    const engr = /^Design: buckle \(engraved\)/.test(name);
    if (!visible(e) && !engr) continue;
    const slot = slotOf(name);

    if (engr && engravingPlates[slot.slot] && engravingPlates[slot.slot].engrave === false) {
      log(`engraving left off for ${slot.slot} (engraving-surfaces.json)`);
      continue;
    }
    if (engr) {
      // The engraving sits on this collar's buckle: its metal (clipped to the collar base).
      const metal = new Float32Array(OW * OH);
      for (const m of all) {
        if (!/^Color: buckles/.test(m.l.name || '') || !visible(m) || slotOf(m.l.name) !== slot) continue;
        const ma = down(alphaFull(m.l));
        for (let i = 0; i < ma.length; i++) metal[i] = Math.max(metal[i], ma[i]);
      }
      const base = down(baseAlphaFull);
      for (let i = 0; i < metal.length; i++) metal[i] *= base[i];
      const onMetal = (uv) => { let hit = 0, on = 0; for (let i = 0; i < uv.hit.length; i++) if (uv.hit[i]) { hit++; on += metal[i]; } return hit ? on / hit : 0; };

      // A plate drawn in templates/engraving-surfaces.json wins over the PSD's layer: for a
      // buckle whose engraving layer was never lined up with the plate.
      const plate = engravingPlates[slot.slot] && engravingPlates[slot.slot].plate;
      let mapper, uv;
      if (plate) {
        const pm = placedMapper(l.placedLayer);
        const p = plate.flat();
        const doc = [0, 2, 4, 6].map((k) => [CX + p[k] / s, CY + p[k + 1] / s]);
        // the slot's content takes the plate's own proportions (as seen), so the text keeps its
        // shape on a narrow plate; its area stays the PSD layer's, for the same sharpness
        const len = (a, b) => Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1]);
        const aspect = (len(0, 2) + len(6, 4)) / (len(0, 6) + len(2, 4));
        const ch = Math.round(Math.sqrt((pm.width * pm.height) / aspect)), cw = Math.round(ch * aspect);
        const toDoc = homography([[0, 0], [cw, 0], [cw, ch], [0, ch]], doc);
        mapper = { width: cw, height: ch, forward: toDoc };
        uv = rasterizeUV(mapper, OW, OH, [CX, CY], s, 2);
        log(`  engraving plate for ${slot.slot} (engraving-surfaces.json): on the buckle ${(onMetal(uv) * 100).toFixed(0)}%`);
      } else {
        // Which frame the transform corners refer to differs per layer (see psd-warp.js), as for
        // the fabric pieces. The layer is hidden, so there is no composite to match: the frame
        // that puts the slot on this collar's buckle wins (ties keep the first, 'mesh').
        let best = null;
        for (const frame of FRAMES) {
          const m = placedMapper(l.placedLayer, frame);
          const r = rasterizeUV(m, OW, OH, [CX, CY], s, 2);
          const score = onMetal(r);
          log(`  engraving frame ${frame}: on the buckle ${(score * 100).toFixed(0)}%`);
          if (!best || score > best.score + 1e-3) best = { mapper: m, uv: r, score };
        }
        ({ mapper, uv } = best);
      }
      // the text must read the right way round on the plate, whichever way the slot was made
      const ax = axesFromMapper(mapper.forward, mapper.width, mapper.height);
      const bad = axesProblems(ax);
      log(`  engraving reads at ${ax.reading.toFixed(0)} deg, lines step at ${ax.lines.toFixed(0)} deg${ax.mirrored ? ', mirrored' : ''}`);
      if (bad.length) {
        throw new Error(`${name}: the engraving would come out ${bad.join(', ')}. Draw this buckle's plate in templates/engraving-surfaces.json (${id} / ${slot.slot}), corners in reading order.`);
      }
      // laser marking only lands on metal: where the slot runs past the buckle, nothing is drawn
      const a = new Float32Array(OW * OH);
      for (let i = 0; i < a.length; i++) a[i] = uv.hit[i] * metal[i];
      const box = bbox(a);
      const [sx, sy] = opt('--engrave-shift', '0,0').split(',').map(Number);
      const shift = (ref) => ({ ...ref, x: ref.x + sx, y: ref.y + sy });
      engravings.push({ type: 'engrave', name, slot: slot.slot, mode: l.blendMode, content: [mapper.width, mapper.height], alpha: shift(putU8(a, box)), uv: shift(putUV(uv, box, mapper.width, mapper.height)) });
      log('engraving slot', name);
      continue;
    }

    // separators and other empty layers have no pixels at all
    if (!l.placedLayer && (l.right - l.left <= 0 || l.bottom - l.top <= 0)) continue;
    let af = alphaFull(l);
    if (l !== baseEntry.l) for (let i = 0; i < af.length; i++) af[i] *= baseAlphaFull[i];
    const a = down(af);
    af = null;
    const box = bbox(a);
    if (!box) continue;
    const opacity = (l.opacity == null ? 1 : l.opacity) * (l.fillOpacity == null ? 1 : l.fillOpacity);
    if (l.placedLayer) {
      // The frame the transform corners refer to differs per layer (see psd-warp.js). A wrong
      // one leaves bands of the strap without print and stretches the rest (which then also
      // renders blurry). Each candidate is drawn with the PSD's own content and compared with
      // Photoshop's composite; without that content, the best-covering frame wins.
      const content = linkedContent(l.placedLayer.id);
      let best = null;
      for (const frame of process.env.WARP_FRAME ? [process.env.WARP_FRAME] : FRAMES) {
        const m = placedMapper(l.placedLayer, frame);
        const r = rasterizeUV(m, OW, OH, [CX, CY], s, 3);
        const cover = coverage(r, a, box), match = content ? await matchComposite(r, a, box, content) : 0;
        const score = content ? match + 0.05 * cover : cover;
        log(`  frame ${frame}: matches Photoshop ${match.toFixed(3)}, covers ${(cover * 100).toFixed(1)}%`);
        if (!best || score > best.score + 1e-4) best = { frame, mapper: m, uv: r, cover, score };
      }
      const { mapper, uv } = best;
      log(`  -> ${best.frame}`);
      if (best.cover < 0.999) edgeFill(uv, mapper, a, box);
      fillUV(uv, a);
      layers.push({ type: 'pattern', name, slot: slot.slot, opacity, content: [mapper.width, mapper.height], alpha: putU8(a, box), uv: putUV(uv, box, mapper.width, mapper.height) });
      log('fabric piece', name, `${box.w}x${box.h}`);
      continue;
    }
    const c = l.vectorFill && l.vectorFill.color ? l.vectorFill.color : { r: 255, g: 255, b: 255 };
    const role = /buckles/.test(name) ? 'metal' : /seam thread/.test(name) ? 'thread' : 'fabric';
    layers.push({ type: 'fill', name, role, slot: slot ? slot.slot : null, opacity, color: [c.r, c.g, c.b].map(Math.round), alpha: putU8(a, box) });
    log('fill', role, name);
  }
  for (let k = objectEnd; k < all.length; k++) {
    const e = all[k];
    if (!e.l.children && visible(e) && e.l.imageData) skipped.push(`${e.l.name} (above the product, left out)`);
  }

  /* ---------- write assets ---------- */
  const dir = fromRoot('poc', 'templates', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'layers.bin'), Buffer.concat(chunks));
  const belowU8 = Buffer.alloc(OW * OH * 3);
  for (let i = 0; i < belowU8.length; i++) belowU8[i] = Math.round(Math.max(0, Math.min(1, below[i])) * 255);
  await sharp(belowU8, { raw: { width: OW, height: OH, channels: 3 } }).png().toFile(path.join(dir, 'below.png'));
  // reference photo = Photoshop's own composite, same crop (the watermark sits outside the crop)
  const comp = psd.imageData;
  await sharp(Buffer.from(comp.data.buffer, comp.data.byteOffset, comp.data.byteLength), { raw: { width: comp.width, height: comp.height, channels: 4 } })
    .extract({ left: CX, top: CY, width: CW, height: CH }).resize(OW, OH, { kernel: 'lanczos3' }).removeAlpha().png().toFile(path.join(dir, 'photo.png'));

  const slots = {};
  for (const v of single ? [SINGLE] : Object.values(SLOTS)) slots[v.slot] = { label: v.label, role: v.role, collar: v.collar };
  const template = {
    id,
    name: opt('--name', single ? `${id} (PSD, 1 collar)` : 'Studio stack (Creatsy PSD, 3 collars)'),
    base: `poc/templates/${id}/photo.png`,
    width: OW,
    height: OH,
    renderScale: 1,
    patternScale: 1,
    // new background plates: soften + lift toward studio white, then the baked shadows multiply in
    bgBlur: 6,
    bgLift: 0.2,
    source: { psd: path.relative(fromRoot(), psdFile).replace(/\\/g, '/'), crop: [CX, CY, CW, CH], ...(opt('--engrave-shift') ? { engraveShift: opt('--engrave-shift').split(',').map(Number) } : {}), ...(Object.keys(engravingPlates).length ? { engravingPlates: 'templates/engraving-surfaces.json' } : {}) },
    slots,
    layered: {
      below: `poc/templates/${id}/below.png`,
      bin: `poc/templates/${id}/layers.bin`,
      binBytes: offset,
      // metal fill colours per finish (Photoshop: "Color: buckles" fill, shaded by the overlay stack)
      finishes: { silver: [255, 255, 255], gold: [236, 196, 120], rosegold: [238, 178, 160] },
      stack: layers,
      overlay,
      engravings,
    },
    layers: [],
  };
  // keep hand-tuned / fitted settings across re-imports (see src/tools/fit-finishes.js)
  const outFile = fromRoot('templates', `${id}.json`);
  if (fs.existsSync(outFile)) {
    const prevTemplate = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const prev = prevTemplate.layered || {};
    for (const k of ['finishRamps', 'finishRampsSource', 'threadColor', 'threadTint', 'threadOpacity', 'threadSoften']) if (prev[k]) template.layered[k] = prev[k];
    if (prevTemplate.squareCrop) template.squareCrop = prevTemplate.squareCrop;
  }
  fs.writeFileSync(outFile, JSON.stringify(template, null, 1) + '\n');
  log(`wrote templates/${id}.json, ${dir} (layers.bin ${(offset / 1e6).toFixed(1)} MB)`);
  if (skipped.length) log('left out:\n  ' + skipped.join('\n  '));
}

main().catch((err) => { console.error(err); process.exit(1); });
