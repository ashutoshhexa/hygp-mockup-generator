'use strict';

/**
 * CLI: render the three listing images for one decision.
 *   node src/run.js                          (decisions/christmas-gingerbread.json)
 *   node src/run.js --decision decisions/x.json [--scale 2] [--mode uv|mask|final]
 * Output: out/listings/<pattern>/01-hero.png, 02-colors.png, 03-dog.png
 */
const fs = require('fs');
const path = require('path');

const { fromRoot } = require('./paths');
const { decideListing } = require('./decide');
const { renderListing } = require('./mockup/node-io');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function slug(text) {
  return String(text || 'listing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'listing';
}

async function main() {
  const decisionPath = path.resolve(argValue('--decision') || fromRoot('decisions', 'christmas-gingerbread.json'));
  decideListing(decisionPath); // validates the model contract
  const decision = JSON.parse(fs.readFileSync(decisionPath, 'utf8'));
  const mode = argValue('--mode') || 'final';
  const exportScale = Number(argValue('--scale')) || 2;

  const t0 = Date.now();
  const results = await renderListing(decision, { exportScale, mode });
  const dir = fromRoot('out', 'listings', slug(decision.patternLabel || path.basename(decision.patternFile)) + (mode === 'final' ? '' : `-${mode}`));
  fs.mkdirSync(dir, { recursive: true });
  for (const r of results) {
    const file = path.join(dir, r.frame.file);
    fs.writeFileSync(file, r.png);
    const finishes = Object.entries(r.plan.finishBySlot).map(([s, f]) => `${s}=${f}`).join(' ');
    console.log(`${r.frame.label.padEnd(11)} ${file}  [${finishes}]`);
  }
  fs.writeFileSync(path.join(dir, 'decision.json'), JSON.stringify(decision, null, 2));
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
