'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { fromRoot } = require('../paths');
const { renderLayered } = require('../mockup/core');
const { loadRgba, readTemplate } = require('../mockup/node-io');

const palette = {
  ink: '#195b46', muted: '#3e594e', cream: '#fcf6ed', coral: '#ff7148',
  marigold: '#ffb000', sage: '#e5eee7', blush: '#ffe1d3', butter: '#ffedb9',
};

function typeset(font, text, x, y, size, color = palette.ink) {
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

function layDownShadows(art, below, size, shift) {
  // Remove the studio sweep and carry the upper collar's shadow onto the card.
  const left = -shift.x;
  for (let y = 790; y < 1200; y++) {
    const row = y * below.width * 4;
    const ground = (below.data[row + left * 4] + below.data[row + (left + size - 1) * 4]) / 2;
    const taper = Math.min(1, (y - 790) / 30, (1200 - y) / 30);
    for (let x = 0; x < size; x++) {
      const shade = 1 - Math.max(0, ground - below.data[row + (left + x) * 4] - 2) / ground * taper;
      const dst = ((y + shift.y) * size + x) * 4;
      for (let k = 0; k < 3; k++) art[dst + k] *= shade;
    }
  }
}

async function copyRoseGoldShades(source, dir, size, shift) {
  const { alpha } = source.layered.stack.find((op) => op.slot === 'top' && op.role === 'metal');
  const { x, y, w, h } = alpha;
  const options = [];
  let defaultPlate;
  for (const option of source.layered.metalPlateOptions.rosegold) {
    const file = `${dir}/${path.basename(option.file)}`;
    const input = await sharp(fromRoot(option.file))
      .extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
      .composite([{ input, left: x + shift.x, top: y + shift.y }])
      .png().toFile(fromRoot(file));
    options.push({ label: option.label, file });
    if (option.file === source.layered.metalPlates.rosegold) defaultPlate = file;
  }
  return {
    metalPlates: { rosegold: defaultPlate },
    metalPlateOptions: { rosegold: options },
  };
}

async function writeOpenCollarCard({ id, name, size, art, shift, collar, includeRoseGoldShades = false }) {
  const source = readTemplate('single-collar-flat-pair');
  const sourceBelow = await loadRgba(fromRoot(source.layered.below));
  layDownShadows(art, sourceBelow, size, shift);
  const dir = `poc/templates/${id}`;
  const position = (op) => {
    const layer = { ...op };
    for (const key of ['alpha', 'mask', 'gray', 'uv']) {
      const ref = op[key];
      if (ref) layer[key] = { ...ref, x: ref.x + shift.x, y: ref.y + shift.y };
    }
    if (layer.slot) layer.slot = 'collar';
    return layer;
  };
  const { bin, binBytes, stack, overlay, engravings, finishes, finishRamps, finishRampsSource,
    threadColor, threadTint, threadOpacity, threadSoften } = source.layered;
  const top = (op) => op.slot === 'top';
  const template = {
    id, name, base: `${dir}/photo.png`,
    width: size, height: size, renderScale: 1, patternScale: 1, replaceBackground: false,
    source: { template: source.id, slot: 'top' },
    slots: { collar: { label: 'Collar', role: 'center', collar } },
    layered: {
      below: `${dir}/below.png`, bin, binBytes, finishes, finishRamps, finishRampsSource,
      threadColor, threadTint, threadOpacity, threadSoften,
      stack: stack.filter(top).map(position),
      overlay: overlay.filter((op) => (op.mask || op.alpha).y < 1200).map(position),
      engravings: engravings.filter(top).map(position),
    },
    layers: [],
  };
  const layerData = fs.readFileSync(fromRoot(bin));
  const reference = { ...template, layered: { ...template.layered, finishRamps: null, threadColor: [255, 255, 255] } };
  const photo = renderLayered({ template: reference, below: { data: art }, layerData });
  const raw = { width: size, height: size, channels: 4 };
  fs.mkdirSync(fromRoot(dir), { recursive: true });
  if (includeRoseGoldShades) Object.assign(template.layered, await copyRoseGoldShades(source, dir, size, shift));
  await Promise.all([
    sharp(art, { raw }).removeAlpha().png().toFile(fromRoot(template.layered.below)),
    sharp(photo.data, { raw }).removeAlpha().png().toFile(fromRoot(template.base)),
  ]);
  fs.writeFileSync(fromRoot('templates', `${id}.json`), JSON.stringify(template, null, 1) + '\n');
}

module.exports = { palette, typeset, writeOpenCollarCard };
