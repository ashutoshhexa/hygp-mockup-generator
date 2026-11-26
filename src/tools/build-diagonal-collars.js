'use strict';

// Build the diagonal view from the two open collars in the imported PSD (7) template.
// Usage: node src/tools/build-diagonal-collars.js
const fs = require('fs');
const sharp = require('sharp');
const { fromRoot } = require('../paths');
const { render } = require('../mockup/core');
const { loadRgba, readTemplate } = require('../mockup/node-io');

async function main() {
  const source = readTemplate('single-collar-flat-pair');
  const id = 'single-collar-diagonal';
  const directory = `poc/templates/${id}`;
  const width = 3000, height = 2000;
  const placement = (slot, crop, scale, referencePositions) => {
    const matte = source.layered.stack.find((op) => op.role === 'fabric' && op.slot === slot).alpha;
    return {
      matte, crop, scale, origin: [matte.x, matte.y + matte.h / 2],
      positions: referencePositions.map(([x, y]) => [Math.round(x * width / 1366), Math.round(y * height / 911)]),
    };
  };
  const repeat = {
    sourceSize: [source.width, source.height],
    angle: 30,
    ground: 248,
    tiles: [
      placement('top', [230, 780, 2575, 425], 0.85, [
        [-358, -292], [93, -330], [-690, -229], [587, 253], [1021, 220], [-22, 707], [596, 772], [1155, 829],
      ]),
      placement('middle', [230, 1230, 2575, 475], 0.89, [[738, -215], [-358, 207], [231, 308]]),
    ],
  };
  const sameCollar = (op) => ({ ...op, slot: 'collar' });
  const template = {
    id, name: 'Single-collar page, Diagonal repeat',
    source: { template: source.id },
    base: `${directory}/photo.png`,
    width, height, renderScale: 1, patternScale: source.patternScale,
    bgBlur: source.bgBlur, bgLift: source.bgLift,
    slots: { collar: { label: 'Collar', role: 'center', collar: 0 } },
    layered: {
      ...source.layered,
      stack: source.layered.stack.map(sameCollar),
      engravings: source.layered.engravings.map(sameCollar),
      repeat,
    },
    layers: [],
    squareCrop: { beltX: [500, 2500], productY: [0, 2000], margin: 0 },
  };

  const below = await loadRgba(fromRoot(template.layered.below));
  const layerData = fs.readFileSync(fromRoot(template.layered.bin));
  const reference = { ...template, layered: { ...template.layered, finishRamps: null, threadColor: [255, 255, 255] } };
  const photo = render({ template: reference, below, layerData });
  fs.mkdirSync(fromRoot(directory), { recursive: true });
  await sharp(photo.data, { raw: { width, height, channels: 4 } }).removeAlpha().png().toFile(fromRoot(template.base));
  fs.writeFileSync(fromRoot('templates', `${id}.json`), JSON.stringify(template, null, 1) + '\n');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
