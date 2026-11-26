'use strict';

// Rebuild the Details & finishes artwork from the layered open collar and the finish reference.
const fs = require('fs');
const sharp = require('sharp');
const { fromRoot } = require('../paths');
const { loadFont } = require('../fonts');
const { renderLayered } = require('../mockup/core');
const { loadRgba, readTemplate } = require('../mockup/node-io');

const ID = 'infographic-hd';
const SIZE = 2700;
const DIR = `poc/templates/${ID}`;
const INK = '#192d42';
const MUTED = '#496075';
const BACKGROUND = '#faf9f6';
const SWATCH_CENTERS = [547, 1350, 2153];
const SWATCH_CROPS = [140, 408, 675];
const COLLAR_SHIFT = { x: -140, y: 270 };

function typeset(font, text, x, y, size, color = INK) {
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  let pen = -run.advanceWidth / 2;
  const glyphs = run.glyphs.map((glyph, index) => {
    const p = run.positions[index];
    const path = `<path transform="translate(${pen + p.xOffset} ${p.yOffset})" d="${glyph.path.toSVG()}"/>`;
    pen += p.xAdvance;
    return path;
  });
  return `<g fill="${color}" transform="translate(${x} ${y}) scale(${scale} ${-scale})">${glyphs.join('')}</g>`;
}

function artwork(serif, sans) {
  const title = (text, x, y, size) => typeset(serif, text, x, y, size);
  const label = (text, x, y, size, color) => typeset(sans, text, x, y, size, color);
  const note = (heading, detail, x, y, w, tint = '#eef1f3') => `
    <rect x="${x - w / 2}" y="${y}" width="${w}" height="224" rx="38" fill="${tint}"/>
    ${title(heading, x, y + 94, 66)}
    ${label(detail, x, y + 164, 50, MUTED)}`;
  const guide = (path, x, y) => `<path d="${path}" fill="none" stroke="#8193a2" stroke-width="5"/>
    <circle cx="${x}" cy="${y}" r="9" fill="#526c80"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <rect width="${SIZE}" height="${SIZE}" fill="${BACKGROUND}"/>
    ${title('Quality is in the details.', 1350, 326, 176)}
    <path d="M1180 407H1520" stroke="#8ca0ae" stroke-width="5" stroke-linecap="round"/>
    ${guide('M485 774V851Q485 892 444 913L217 1030', 217, 1030)}
    ${guide('M1350 774V1050', 1350, 1050)}
    ${guide('M2215 774V833Q2215 883 2168 900L1831 1025', 1831, 1025)}
    ${note('Deep engraving', 'Premium buckle detail', 485, 550, 680)}
    ${note('Premium woven webbing', 'Smooth & durable', 1350, 550, 825)}
    ${note('Adjustable fit', 'Easy sizing', 2215, 550, 680)}
    ${guide('M740 1542V1515Q740 1473 701 1453L489 1355', 489, 1355)}
    ${guide('M1960 1542V1520Q1960 1479 1920 1461L1644 1355', 1644, 1355)}
    ${note('Strong metal hardware', 'Built to last', 740, 1542, 765)}
    <rect x="1560" y="1542" width="800" height="224" rx="38" fill="#edf1e9"/>
    ${title('Recycled webbing material', 1960, 1676, 62)}
    <path d="M160 1916H670M2030 1916H2540" stroke="#a8b5bf" stroke-width="3"/>
    ${title('Three hardware finishes', 1350, 1943, 102)}
    ${SWATCH_CENTERS.map((x, i) => `
      <rect x="${x - 343}" y="2040" width="686" height="486" rx="44" fill="#f2f1ed"/>
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

function positionLayer(op) {
  const layer = { ...op };
  for (const key of ['alpha', 'mask', 'gray', 'uv']) {
    const ref = op[key];
    if (ref) layer[key] = { ...ref, x: ref.x + COLLAR_SHIFT.x, y: ref.y + COLLAR_SHIFT.y };
  }
  if (layer.slot) layer.slot = 'collar';
  return layer;
}

function layDownShadows(art, below) {
  // Remove the source studio sweep locally and carry only the upper collar's shadow onto the card.
  const left = -COLLAR_SHIFT.x;
  for (let y = 790; y < 1200; y++) {
    const row = y * below.width * 4;
    const ground = (below.data[row + left * 4] + below.data[row + (left + SIZE - 1) * 4]) / 2;
    const taper = Math.min(1, (y - 790) / 30, (1200 - y) / 30);
    for (let x = 0; x < SIZE; x++) {
      const shade = 1 - Math.max(0, ground - below.data[row + (left + x) * 4] - 2) / ground * taper;
      const dst = ((y + COLLAR_SHIFT.y) * SIZE + x) * 4;
      for (let k = 0; k < 3; k++) art[dst + k] *= shade;
    }
  }
}

async function main() {
  const source = readTemplate('single-collar-flat-pair');
  const [serif, sans, swatches, sourceBelow] = await Promise.all([
    loadFont('DM Serif'), loadFont('Roboto'), buckleSwatches(fromRoot(readTemplate('infographic').base)), loadRgba(fromRoot(source.layered.below)),
  ]);
  const raw = { width: SIZE, height: SIZE, channels: 4 };
  const art = await sharp(artwork(serif, sans)).composite(swatches).ensureAlpha().raw().toBuffer();
  layDownShadows(art, sourceBelow);
  const { bin, binBytes, stack, overlay, engravings, finishes, finishRamps, finishRampsSource,
    threadColor, threadTint, threadOpacity, threadSoften } = source.layered;
  const template = {
    id: ID, name: 'Quality is in the details', base: `${DIR}/photo.png`,
    width: SIZE, height: SIZE, renderScale: 1, patternScale: 1, replaceBackground: false,
    source: { template: source.id, slot: 'top' },
    slots: { collar: { label: 'Collar', role: 'center', collar: 1 } },
    layered: {
      below: `${DIR}/below.png`, bin, binBytes, finishes, finishRamps, finishRampsSource,
      threadColor, threadTint, threadOpacity, threadSoften,
      stack: stack.filter((op) => op.slot === 'top').map(positionLayer),
      overlay: overlay.filter((op) => (op.mask || op.alpha).y < 1200).map(positionLayer),
      engravings: engravings.filter((op) => op.slot === 'top').map(positionLayer),
    },
    layers: [],
  };
  const layerData = fs.readFileSync(fromRoot(bin));
  const reference = { ...template, layered: { ...template.layered, finishRamps: null, threadColor: [255, 255, 255] } };
  const photo = renderLayered({ template: reference, below: { data: art }, layerData });
  fs.mkdirSync(fromRoot(DIR), { recursive: true });
  await Promise.all([
    sharp(art, { raw }).removeAlpha().png().toFile(fromRoot(template.layered.below)),
    sharp(photo.data, { raw }).removeAlpha().png().toFile(fromRoot(template.base)),
  ]);
  fs.writeFileSync(fromRoot('templates', `${ID}.json`), JSON.stringify(template, null, 1) + '\n');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
