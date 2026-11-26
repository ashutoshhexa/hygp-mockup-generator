'use strict';

// Rebuild the Details & finishes artwork from the layered open collar and the finish reference.
const sharp = require('sharp');
const { fromRoot } = require('../paths');
const { loadFont } = require('../fonts');
const { readTemplate } = require('../mockup/node-io');
const { palette, linenArtwork, typeset, writeOpenCollarCard } = require('./open-collar-card');

const ID = 'infographic-hd';
const SIZE = 2700;
const { ink: INK, muted: MUTED, coral: CORAL, marigold: MARIGOLD, sage: SAGE } = palette;
const SWATCH_CENTERS = [547, 1350, 2153];
const SWATCH_CROPS = [140, 408, 675];
const COLLAR_SHIFT = { x: -140, y: 270 };

function artwork(serif, sans) {
  const title = (text, x, y, size) => typeset(serif, text, x, y, size);
  const label = (text, x, y, size, color) => typeset(sans, text, x, y, size, color);
  const note = (heading, detail, x, y, w, tint = SAGE) => `
    <rect x="${x - w / 2}" y="${y}" width="${w}" height="224" rx="38" fill="${tint}"/>
    ${title(heading, x, y + 94, 66)}
    ${label(detail, x, y + 164, 50, MUTED)}`;
  const guide = (path, x, y) => `<path d="${path}" fill="none" stroke="#73998a" stroke-width="5"/>
    <circle cx="${x}" cy="${y}" r="10" fill="${INK}"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    ${title('Quality is in the details.', 1350, 326, 176)}
    <path d="M1180 407H1520" stroke="${CORAL}" stroke-width="12" stroke-linecap="round"/>
    ${guide('M485 774V851Q485 892 444 913L217 1030', 217, 1030)}
    ${guide('M1350 774V1050', 1350, 1050)}
    ${guide('M2215 774V833Q2215 883 2168 900L1831 1025', 1831, 1025)}
    ${note('Deep engraving', 'Premium buckle detail', 485, 550, 680, '#ffe1d3')}
    ${note('Premium woven webbing', 'Smooth & durable', 1350, 550, 825)}
    ${note('Adjustable fit', 'Easy sizing', 2215, 550, 680, '#ffedb9')}
    ${guide('M740 1542V1515Q740 1473 701 1453L489 1355', 489, 1355)}
    ${guide('M1960 1542V1520Q1960 1479 1920 1461L1644 1355', 1644, 1355)}
    ${note('Strong metal hardware', 'Built to last', 740, 1542, 765, '#ffe1d3')}
    <rect x="1540" y="1542" width="840" height="224" rx="38" fill="${SAGE}"/>
    ${title('Recycled webbing material', 1960, 1676, 62)}
    <path d="M160 1916H670M2030 1916H2540" stroke="${MARIGOLD}" stroke-width="7" stroke-linecap="round"/>
    ${title('Three hardware finishes', 1350, 1943, 102)}
    ${SWATCH_CENTERS.map((x, i) => `
      <rect x="${x - 343}" y="2040" width="686" height="486" rx="44" fill="#f2f1ed" stroke="#e5d8c6" stroke-width="3"/>
      ${label(['Gold', 'Rose Gold', 'Silver'][i], x, 2465, 61)}
    `).join('')}
  </svg>`);
}

async function buckleSwatches(file) {
  const width = 210, height = 122;
  return Promise.all(SWATCH_CROPS.map(async (left, index) => {
    const pixels = await sharp(file).extract({ left, top: 773, width, height }).removeAlpha().raw().toBuffer();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const keep = Math.min(1, x / 8, y / 8, (width - 1 - x) / 8, (height - 1 - y) / 8);
      const dst = (y * width + x) * 3;
      for (let k = 0; k < 3; k++) pixels[dst + k] = 255 - Math.max(0, 248 - pixels[dst + k]) * keep * (255 / 248);
    }
    const outputWidth = 540;
    const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .resize(outputWidth).sharpen({ sigma: 0.9 }).png().toBuffer();
    return { input, left: SWATCH_CENTERS[index] - outputWidth / 2, top: 2064, blend: 'multiply' };
  }));
}

async function main() {
  const [serif, sans, swatches] = await Promise.all([
    loadFont('DM Serif'), loadFont('Roboto'), buckleSwatches(fromRoot(readTemplate('infographic').base)),
  ]);
  const art = await linenArtwork(SIZE, artwork(serif, sans), swatches);
  await writeOpenCollarCard({ id: ID, name: 'Quality is in the details', size: SIZE, art, shift: COLLAR_SHIFT, collar: 1 });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
