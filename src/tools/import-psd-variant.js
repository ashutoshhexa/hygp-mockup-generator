'use strict';

/**
 * Run import-psd.js on a PSD whose layers don't quite follow the names it expects, without
 * changing the importer. The parsed layer tree is adjusted here, before import-psd.js sees it,
 * and the importer then runs exactly as it does for every other template.
 *
 *   node src/tools/import-psd-variant.js <file.psd> <templateId> [import-psd options] [variant options]
 *
 * Variant options:
 *   --no-memory-limit   lift ag-psd's default 2 GB cap on decoded layer pixels (a PSD with
 *                       more layer pixel data than that fails with "Exceeded memory limit")
 *   --collar-by-base    multi-collar PSDs named "Color: fabric /collar N" (instead of
 *                       "Color: collar N"): base layers are renamed, every piece is numbered
 *                       after the collar base it sits on, and engraving layers named
 *                       "Design: buckle /collar N (engraved)" get the importer's spelling
 *   --flat-pair         combine the flat mockup's top and bottom object groups, keeping
 *                       each collar's masks and removing the sample measurement artwork
 *   --drop-engraving N  leave out collar N's engraving layer ("all" for every one): for a buckle
 *                       seen end-on, where the engraved plate faces away from the camera
 *   --prune-slots       drop collar slots that ended up with no layers (a two-collar PSD
 *                       otherwise keeps an empty third slot)
 */
const fs = require('fs');
const agPsd = require('ag-psd');
const { fromRoot } = require('../paths');

const OWN = { '--no-memory-limit': 0, '--collar-by-base': 0, '--flat-pair': 0, '--prune-slots': 0, '--drop-engraving': 1 };
const own = {};
const rest = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] in OWN) { own[argv[i]] = OWN[argv[i]] ? argv[++i] : true; continue; }
  rest.push(argv[i]);
}
const id = rest[1];

const BASE = /^Color: (fabric|collar)\b/;
const NUM = /\s*\/?\s*collar (\d)\s*/;

function combineFlatPair(psd) {
  const bottom = psd.children?.find((l) => l.name === 'Object (bottom)');
  const top = psd.children?.find((l) => l.name === 'Object (top)');
  if (!bottom?.children || !top?.children) throw new Error('Expected top and bottom object groups for the flat pair.');

  const shadows = [];
  const product = [];
  const overlays = [];
  for (const [group, number] of [[bottom, 2], [top, 1]]) {
    for (const layer of group.children) {
      const name = layer.name.trim();
      if (name === 'How to Measure') continue;
      if (name === 'drop shadow') {
        shadows.push(layer);
      } else if (name.startsWith('Overlay layers')) {
        overlays.push(...layer.children);
      } else {
        if (name === 'Color: fabric') layer.name = `Color: collar ${number}`;
        if (/^(Design: fabric|Design: buckle \(engraved\)|Color: buckles|Color: seam thread)/.test(name)) {
          layer.name = `${name} /collar ${number}`;
        }
        // Both hardware fills should start from silver when fitting the finish ramps.
        if (name === 'Color: buckles') layer.vectorFill.color = { r: 255, g: 255, b: 255 };
        product.push(layer);
      }
    }
  }
  bottom.name = 'Object';
  bottom.children = [...shadows, ...product, { name: 'Overlay layers', children: overlays }];
  psd.children = psd.children.filter((l) => l !== top);
}

function adjust(psd) {
  if (own['--flat-pair']) combineFlatPair(psd);
  const all = [];
  (function walk(list) { for (const l of list || []) { all.push(l); walk(l.children); } })(psd.children);

  if (own['--collar-by-base']) {
    let current = null;
    for (const l of all) {
      if (l.children) continue;
      const name = l.name || '';
      const engraved = /^Design: buckle .*\(engraved\)/.exec(name);
      if (engraved) { const m = NUM.exec(name); if (m) l.name = `Design: buckle (engraved) /collar ${m[1]}`; continue; }
      if (BASE.test(name)) { const m = NUM.exec(name); if (m) { current = m[1]; l.name = `Color: collar ${current}`; } continue; }
      // a piece sitting on a collar base belongs to that collar, whatever number its name carries
      if (current && NUM.test(name) && /^(\(auto\) )?(Design: fabric|Color: buckles|Color: seam thread)/.test(name)) {
        l.name = name.replace(NUM, ` /collar ${current}`).trim();
      }
    }
  }

  const drop = own['--drop-engraving'];
  if (drop) {
    for (const l of all) {
      if (!/^Design: buckle .*\(engraved\)/.test(l.name || '')) continue;
      const m = NUM.exec(l.name);
      if (drop === 'all' || (m && m[1] === drop)) l.name = `dropped: ${l.name}`;
    }
  }
  return psd;
}

const readPsd = agPsd.readPsd;
let readingSource = true;
agPsd.readPsd = (buffer, options = {}) => {
  const psd = readPsd(buffer, own['--no-memory-limit'] ? { ...options, totalMemoryLimit: undefined } : options);
  if (!readingSource) return psd; // Embedded smart objects have their own unrelated layer names.
  readingSource = false;
  return adjust(psd);
};

if (own['--prune-slots']) {
  process.on('beforeExit', () => {
    const file = fromRoot('templates', `${id}.json`);
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    const used = new Set([...t.layered.stack, ...t.layered.engravings].map((l) => l.slot).filter(Boolean));
    for (const slot of Object.keys(t.slots)) if (!used.has(slot)) { delete t.slots[slot]; console.log(`pruned empty slot ${slot}`); }
    fs.writeFileSync(file, JSON.stringify(t, null, 1) + '\n');
  });
}

if (own['--flat-pair']) rest.push('--separate-collar-bases', '--neutral-reference');
process.argv = [process.argv[0], require.resolve('./import-psd'), ...rest];
require('./import-psd');
