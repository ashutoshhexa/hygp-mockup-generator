'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { parseArgs } = require('util');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { fromRoot } = require('./paths');

for (const file of ['.env', '.env.local']) {
  const envFile = fromRoot(file);
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
}

const catalog = require('./catalog');
const { suggestNames } = require('./name-ideas-ollama');
const { randomPhone } = require('./engraving');
const { PHONE_FONT } = require('./fonts');
const { FINISHES, planFrame } = require('./mockup/plan');
const { readJson, readTemplate, renderFrame, WEBP_MAX_BYTES } = require('./mockup/node-io');

const EXPORTS = [
  ['Hero.webp', 'single-collar', 'decision'],
  ['listing-1.webp', 'single-collar-three-quarter', 'decision'],
  ['listing-2.webp', 'single-collar-flat', 'decision'],
  ['listing-3.webp', 'single-collar-diagonal', 'decision'],
  ['listing-4.webp', 'infographic-hd', 'photo'],
  ['listing-5.webp', 'single-collar-how-to-measure', 'photo'],
];

const USAGE = `Usage:
  npm run batch:single-collar -- --pattern <product-id-or-local-image> [--manifest <file>] [--out <folder>]
  npm run batch:single-collar -- --make-manifest <file>
  npm run batch:single-collar -- --all [--manifest <file>] [--part N/M] [--workers N] [--out <folder>]

Part numbers are 1-based. Use the same manifest and part count across devices.
Output defaults to out/single-collar-batch. Existing images within 50 KB are skipped.`;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, label) {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) throw new Error(`${label} must be a positive integer.`);
  return n;
}

function writeAtomic(file, data, { exclusive = false } = {}) {
  const tmp = `${file}.${randomUUID()}.part`;
  try {
    fs.writeFileSync(tmp, data);
    if (exclusive) fs.linkSync(tmp, file);
    else fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

async function scanCatalog() {
  const collections = await catalog.listCollections();
  if (!collections.length) throw new Error('The storefront returned no collections.');
  const patterns = new Map();
  for (const { id, title } of collections) {
    const products = await catalog.listPatterns(id, { allPages: true });
    for (const product of products) {
      if (!patterns.has(product.id)) patterns.set(product.id, { ...product, collection: title, collections: [] });
      patterns.get(product.id).collections.push({ id, title });
    }
    console.log(`Catalog: ${title} (${products.length} printable patterns)`);
  }
  if (!patterns.size) throw new Error('The storefront returned no printable patterns.');
  return { version: 1, patterns: [...patterns.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })) };
}

function readManifest(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.patterns) || !data.patterns.length) throw new Error(`Invalid catalog manifest: ${file}`);
  const ids = new Set();
  for (const p of data.patterns) {
    const fileId = /^cache\/patterns\/(\d+)(?:\.s[\d.]+\.x-?[\d.]+\.y-?[\d.]+)?\.png$/.exec(p?.file)?.[1];
    if (!fileId || p.id !== fileId || ids.has(p.id) || !p.label) throw new Error(`Invalid or duplicate pattern in ${file}.`);
    ids.add(p.id);
  }
  return data;
}

async function singlePattern(input, manifest) {
  if (!/^\d+$/.test(input)) {
    const file = path.resolve(input);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Pattern file not found: ${file}`);
    return { id: `local-${digest(fs.readFileSync(file)).slice(0, 12)}`, label: path.parse(file).name, file };
  }
  if (!manifest) {
    const file = catalog.framedFile(`cache/patterns/${input}.png`);
    const known = catalog.describePattern(file);
    if (known) return { id: input, file, ...known };
  }
  const { patterns } = manifest || await scanCatalog();
  const match = patterns.find((p) => p.id === input);
  if (!match) throw new Error(`Pattern ${input} was not found in the catalog.`);
  return match;
}

function plannedFrames() {
  return EXPORTS.map(([file, id, background]) => {
    const template = readTemplate(id);
    if (Object.values(template.slots).filter((slot) => slot.collar != null).length !== 1) {
      throw new Error(`Template ${id} must have exactly one collar slot.`);
    }
    return { file, template, frame: { id, label: template.name, template: id, background } };
  });
}

function completed(file) {
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size;
  return size > 0 && size <= WEBP_MAX_BYTES;
}

async function engravingFor(pattern, dir, lettering) {
  const checkpoint = path.join(dir, 'design.json');
  if (!fs.existsSync(checkpoint)) {
    const { names, source } = await suggestNames([pattern], { fresh: true });
    if (!names[0]) throw new Error('Name ideas did not return a first suggestion.');
    const design = { patternId: pattern.id, patternLabel: pattern.label, nameSource: source,
      engraving: { name: names[0], phone: randomPhone(), font: lettering, phoneFont: PHONE_FONT } };
    try {
      writeAtomic(checkpoint, JSON.stringify(design, null, 2) + '\n', { exclusive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const { engraving, nameSource } = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
  console.log(`[${pattern.id}] ${pattern.label} · ${engraving.name} (${nameSource})`);
  return engraving;
}

async function renderPattern(pattern, out, frames, lettering) {
  const slug = pattern.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
  const dir = path.join(out, slug ? `${pattern.id}-${slug}` : pattern.id);
  const files = FINISHES.flatMap((color) => frames.map((view) => ({
    ...view, color, target: path.join(dir, color, view.file),
  })));
  const missing = files.filter(({ target }) => !completed(target));
  if (!missing.length) {
    console.log(`[${pattern.id}] ${pattern.label} · already complete`);
    return;
  }
  const patternFile = await catalog.ensurePatternFile(pattern.file, pattern.url) || pattern.file;
  fs.mkdirSync(dir, { recursive: true });
  const engraving = await engravingFor(pattern, dir, lettering);
  // Details & finishes uses slot 1. The other five views use slot 0.
  const collars = [engraving, engraving];
  for (const { color, target, template, frame } of missing) {
    const decision = { patternFile, listing: { centerColor: color, collars } };
    const plan = planFrame(frame, template, decision);
    const webp = await renderFrame({ ...plan, template, patternFile, format: 'webp' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeAtomic(target, webp);
  }
  console.log(`[${pattern.id}] wrote ${missing.length} WebP files to ${dir}`);
}

async function runPatterns(patterns, out) {
  const frames = plannedFrames();
  const lettering = readJson('decisions/christmas-gingerbread.json').listing.collars[0].font;
  let failures = 0;
  for (const pattern of patterns) {
    try {
      await renderPattern(pattern, out, frames, lettering);
    } catch (error) {
      failures++;
      console.error(`[${pattern.id}] ${pattern.label}: ${error.message}`);
    }
  }
  return failures;
}

function runWorker(patterns, out) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { patterns, out } });
    let failures;
    worker.on('message', (result) => { failures = result; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code || failures == null) reject(new Error(`Batch worker exited with status ${code}.`));
      else resolve(failures);
    });
  });
}

async function main() {
  const { values: args } = parseArgs({ options: {
    all: { type: 'boolean' },
    pattern: { type: 'string' },
    'make-manifest': { type: 'string' },
    manifest: { type: 'string' },
    part: { type: 'string' },
    workers: { type: 'string', default: '1' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (args.help || !process.argv.slice(2).length) {
    console.log(USAGE);
    return;
  }
  if ([args.all, args.pattern, args['make-manifest']].filter(Boolean).length !== 1) {
    throw new Error('Choose one of --pattern, --all, or --make-manifest. Run with --help for examples.');
  }
  if (args['make-manifest']) {
    const file = path.resolve(args['make-manifest']);
    const manifest = await scanCatalog();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Saved ${manifest.patterns.length} unique patterns to ${file}`);
    return;
  }
  const [partText, totalText, extra] = (args.part || '1/1').split('/');
  const part = positiveInteger(partText, 'Part number');
  const total = positiveInteger(totalText, 'Part count');
  if (extra !== undefined || part > total || (args.part && !args.all)) throw new Error('Use --part N/M with --all, where 1 <= N <= M.');
  const workers = positiveInteger(args.workers, 'Worker count');
  const manifest = args.manifest ? readManifest(args.manifest) : null;
  const patterns = args.all
    ? (manifest || await scanCatalog()).patterns.filter((p) => parseInt(digest(p.id).slice(0, 8), 16) % total === part - 1)
    : [await singlePattern(args.pattern, manifest)];
  const out = path.resolve(args.out || fromRoot('out', 'single-collar-batch'));
  const count = Math.min(workers, patterns.length);
  console.log(`Part ${part}/${total}: ${patterns.length} patterns, ${count} worker(s), up to ${patterns.length * 18} WebP files.`);
  if (!count) return;
  const groups = Array.from({ length: count }, () => []);
  patterns.forEach((p, i) => groups[i % count].push(p));
  const failures = count === 1
    ? await runPatterns(patterns, out)
    : (await Promise.all(groups.map((group) => runWorker(group, out)))).reduce((sum, fail) => sum + fail, 0);
  console.log(`Finished: ${patterns.length - failures} complete, ${failures} failed.`);
  if (failures) process.exitCode = 1;
}

const task = isMainThread ? main() : runPatterns(workerData.patterns, workerData.out).then((result) => parentPort.postMessage(result));
task.catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
