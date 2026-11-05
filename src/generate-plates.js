'use strict';

/**
 * Generates the only images a model is allowed to make: empty background plates,
 * and dog photos wearing a plain WHITE collar and leash (traced once as templates,
 * then recoloured in code like the studio photo).
 *
 *   set XAI_API_KEY=...        set XAI_IMAGE_MODEL=<image model id from your xAI console>
 *   node src/generate-plates.js --kind backgrounds [--count 12]
 *   node src/generate-plates.js --kind dogs [--count 5] [--dry-run]
 *
 * Uses the xAI OpenAI-compatible endpoint (override with IMAGE_API_URL).
 * Backgrounds land in poc/backgrounds/ (the studio lists them automatically).
 * Dogs land in poc/dogs/ for review before one is turned into a template.
 */
const fs = require('fs');
const path = require('path');
const { fromRoot } = require('./paths');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

async function generate(prompt) {
  const url = process.env.IMAGE_API_URL || 'https://api.x.ai/v1/images/generations';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.XAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.XAI_IMAGE_MODEL, prompt, n: 1, response_format: 'b64_json' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Image API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const item = body.data && body.data[0];
  if (item && item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item && item.url) return Buffer.from(await (await fetch(item.url)).arrayBuffer());
  throw new Error('Image API returned no image.');
}

async function main() {
  const kind = arg('--kind', 'backgrounds');
  const spec = JSON.parse(fs.readFileSync(fromRoot('poc', 'prompts', 'plates.json'), 'utf8'))[kind];
  if (!spec) throw new Error('--kind must be backgrounds or dogs');
  const count = Math.min(Number(arg('--count', spec.scenes.length)), spec.scenes.length);
  const dry = process.argv.includes('--dry-run');
  if (!dry && (!process.env.XAI_API_KEY || !process.env.XAI_IMAGE_MODEL)) {
    throw new Error('Set XAI_API_KEY and XAI_IMAGE_MODEL first (or pass --dry-run to print the prompts).');
  }
  const outDir = fromRoot('poc', kind === 'dogs' ? 'dogs' : 'backgrounds');
  fs.mkdirSync(outDir, { recursive: true });

  for (const scene of spec.scenes.slice(0, count)) {
    const prompt = `${scene}. ${spec.rule}`;
    const file = path.join(outDir, `${kind === 'dogs' ? 'dog' : 'bg'}-${slug(scene)}.png`);
    if (dry) { console.log(`\n${path.basename(file)}\n  ${prompt}`); continue; }
    if (fs.existsSync(file)) { console.log(`skip (exists) ${path.basename(file)}`); continue; }
    try {
      fs.writeFileSync(file, await generate(prompt));
      console.log(`saved ${file}`);
    } catch (err) {
      console.error(`failed ${path.basename(file)}: ${err.message}`);
    }
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
