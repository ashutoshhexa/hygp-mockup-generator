'use strict';

/**
 * Vercel build: assembles public/ (everything the browser downloads) from the repo.
 *   public/ui, public/mockup      the page and the renderer (runs in the visitor's browser)
 *   public/files/poc/...          only the main photo's template files
 *   public/bg/<preset>.png        every background preset painted at 3000x2250
 * The API (lettering, store patterns, state) is the serverless function in api/index.js.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { paintPreset, listPresets } = require('../src/background');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public');

function copy(from, to) {
  fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to));
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });

  for (const name of fs.readdirSync(path.join(ROOT, 'src', 'ui'))) {
    if (/^(listing\.(html|js|css)|render-client\.js|worker\.js)$/.test(name)) copy(`src/ui/${name}`, `ui/${name}`);
  }
  for (const name of ['core.js', 'plan.js']) copy(`src/mockup/${name}`, `mockup/${name}`);

  // the templates behind /listing (creatsy-stack) and each /single-collar* page (same name)
  const readTpl = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', `${id}.json`), 'utf8'));
  const hero = readTpl('creatsy-stack');
  const files = new Set([hero, ...['single-collar', 'single-collar-side', 'single-collar-three-quarter', 'single-collar-back', 'single-collar-angled', 'single-collar-low-side', 'single-collar-stack', 'single-collar-buckle-front', 'single-collar-pair-stacked', 'single-collar-pair-angled', 'single-collar-flat'].map(readTpl)].flatMap((t) => [t.base, t.layered.below, t.layered.bin, ...(t.layered.shade ? [t.layered.shade] : []),
    ...Object.values(t.layered.metalPlates || {}), ...Object.values(t.layered.metalPlateOptions || {}).flat().map((o) => o.file)]));
  for (const f of files) copy(f, `files/${f}`);

  const t0 = Date.now();
  fs.mkdirSync(path.join(OUT, 'bg'), { recursive: true });
  // JPEG q94 4:4:4: ~1 MB instead of ~6 MB per plate (they are soft gradients plus fine grain)
  for (const p of listPresets()) {
    const png = await paintPreset(p.id, hero.width, hero.height);
    fs.writeFileSync(path.join(OUT, 'bg', `${p.id}.jpg`), await sharp(png).jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer());
  }
  // lifestyle scenes (/single-collar* pages): full size + picker thumbnail, as the Studio serves them
  const { listLifestyle, lifestyleJpeg } = require('../src/lifestyle');
  const scenes = listLifestyle().filter((s) => s.source);
  fs.mkdirSync(path.join(OUT, 'files', 'lifestyle'), { recursive: true });
  for (const s of scenes) for (const f of [s.file, s.thumb]) fs.writeFileSync(path.join(OUT, 'files', f), await lifestyleJpeg(f));
  console.log(`public/ ready: ${scenes.length} lifestyle scenes`);
  console.log(`public/ ready: ${files.size} template files, ${listPresets().length} backgrounds (${Date.now() - t0} ms)`);
})().catch((err) => { console.error(err); process.exit(1); });
