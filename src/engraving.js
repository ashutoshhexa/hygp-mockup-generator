'use strict';

/**
 * Buckle engraving SVG.
 * Layout follows B2B-portal-lambda/src/order/utils/engraving-svg.util.ts
 * (buckle size viewBox; line 1 = 52% of the height alone, 44% + 26% with two lines,
 * 32% + 20% + 20% with three; 88% max width, 86% max block height), so a name, phone and
 * optional third line ("Call My Mom!") land on the buckle the way production draws them. Two differences:
 *   - text is drawn as glyph outlines from the storefront font file (fontkit),
 *     so the browser preview and the export are the same and need no font loading;
 *   - widths are measured from the real glyphs instead of estimated, so wide fonts
 *     (Rubik, Unbounded) shrink to fit instead of running off the face.
 * The image model never draws the letters.
 */
const { loadFont, PHONE_FONT } = require('./fonts');

const BUCKLE_DIMENSIONS = {
  XS: { widthMm: 14.0, heightMm: 11.0, viewBoxW: 2800, viewBoxH: 2200 },
  SM: { widthMm: 16.0, heightMm: 13.0, viewBoxW: 3200, viewBoxH: 2600 },
  MN: { widthMm: 16.0, heightMm: 13.0, viewBoxW: 3200, viewBoxH: 2600 },
  MW: { widthMm: 19.0, heightMm: 16.0, viewBoxW: 3800, viewBoxH: 3200 },
  LG: { widthMm: 19.0, heightMm: 16.0, viewBoxW: 3800, viewBoxH: 3200 },
  XL: { widthMm: 20.0, heightMm: 21.0, viewBoxW: 4000, viewBoxH: 4200 },
  XXL: { widthMm: 20.0, heightMm: 21.0, viewBoxW: 4000, viewBoxH: 4200 },
};

/** 10 US digits -> 419-555-0148; anything else is engraved as typed. */
function formatUsPhone(text) {
  const raw = String(text || '').trim();
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : raw;
}

/** A fictional-looking number in the client's format: 419-555-XXXX. */
function randomPhone() {
  return `419-555-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
}

// ink box of a laid-out line, in font units
function inkBox(run) {
  const b = run.bbox;
  if (!b || !isFinite(b.minX) || b.maxX <= b.minX) return { minX: 0, maxX: run.advanceWidth, minY: 0, maxY: 0 };
  return b;
}

/**
 * lines: [{ text, font }] where font is a fontkit font. Returns an SVG string of paths.
 */
function engravingSvg(lines, sizeName = 'MN') {
  const rawLines = lines.map((l) => ({ ...l, text: String(l.text || '').trim() })).filter((l) => l.text);
  if (!rawLines.length) return null;
  const dim = BUCKLE_DIMENSIONS[sizeName] || BUCKLE_DIMENSIONS.MN;
  const W = dim.viewBoxW, H = dim.viewBoxH;
  const maxW = Math.round(W * 0.88);
  const numLines = rawLines.length;
  // production line sizes (engraving-svg.util.ts): [first line, other lines] by line count
  const [k1, k2] = numLines === 1 ? [0.52, 0] : numLines === 2 ? [0.44, 0.26] : numLines === 3 ? [0.32, 0.2] : [0.25, 0.17];
  const baseFs1 = Math.round(H * k1);
  const baseFs2 = Math.round(H * k2);

  const laid = rawLines.map((l, idx) => {
    const run = l.font.layout(l.text);
    const box = inkBox(run);
    const upm = l.font.unitsPerEm;
    let fs = idx === 0 ? baseFs1 : baseFs2;
    const inkW = ((box.maxX - box.minX) / upm) * fs;
    if (inkW > maxW) fs = Math.max(Math.floor((fs * maxW) / inkW), 14);
    return { ...l, run, box, upm, fs };
  });

  // production line box: line height = font size, gap = 12% of the second line's size
  const gap0 = numLines > 1 ? Math.round(baseFs2 * 0.12) : 0;
  let total = laid.reduce((s, l) => s + l.fs, 0) + (numLines - 1) * gap0;
  const maxH = Math.round(H * 0.86);
  let gap = gap0;
  if (total > maxH) {
    const k = maxH / total;
    laid.forEach((l) => { l.fs = Math.max(Math.round(l.fs * k), 14); });
    gap = Math.round(gap0 * k);
    total = laid.reduce((s, l) => s + l.fs, 0) + (numLines - 1) * gap;
  }

  let y = (H - total) / 2;
  const paths = laid.map((l) => {
    const s = l.fs / l.upm;
    const cy = y + l.fs / 2;
    y += l.fs + gap;
    // centre the ink box on the line's centre (fonts disagree on cap heights)
    const ox = W / 2 - ((l.box.minX + l.box.maxX) / 2) * s;
    const oy = cy + ((l.box.minY + l.box.maxY) / 2) * s;
    let pen = 0;
    const parts = [];
    l.run.glyphs.forEach((g, i) => {
      const p = l.run.positions[i];
      const gx = ox + (pen + p.xOffset) * s, gy = oy - p.yOffset * s;
      parts.push(g.path.scale(s, -s).translate(gx, gy).toSVG());
      pen += p.xAdvance;
    });
    return `  <path d="${parts.join(' ')}"/>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <g fill="#000" fill-rule="nonzero">
${paths.join('\n')}
  </g>
</svg>`;
}

/**
 * Name on line 1 in the chosen font, phone on line 2 and the optional line 3 (e.g. "Call My Mom!")
 * in the phone lettering (default: Roboto Condensed Bold). Empty lines are left out, as in production.
 */
async function generateEngravingSvg({ name, phone, line3, font, phoneFont, sizeName = 'MN' }) {
  const [nameFont, numFont] = await Promise.all([loadFont(font), loadFont(phoneFont || PHONE_FONT)]);
  return engravingSvg([
    { text: name, font: nameFont },
    { text: formatUsPhone(phone), font: numFont },
    { text: line3, font: numFont },
  ], sizeName);
}

/** Black-on-transparent PNG, drawn large; the renderer mipmaps it down onto the buckle. */
async function rasterizeEngraving({ name, phone, line3, font, phoneFont, width = 1400 }) {
  const { Resvg } = require('@resvg/resvg-js');
  const svg = await generateEngravingSvg({ name, phone, line3, font, phoneFont });
  if (!svg) return null;
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } });
  return Buffer.from(resvg.render().asPng());
}

module.exports = { generateEngravingSvg, rasterizeEngraving, engravingSvg, formatUsPhone, randomPhone, BUCKLE_DIMENSIONS };
