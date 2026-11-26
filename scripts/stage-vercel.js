'use strict';

/**
 * Copies only what the live site needs into .deploy/ (code, template json, the main photo's
 * template files, fonts and storefront lists). Deploy from there:
 *   node scripts/stage-vercel.js && cd .deploy && vercel deploy --prod
 * The repo itself holds 700 MB of working files that must not be uploaded.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.deploy');

const keepVercelLink = fs.existsSync(path.join(OUT, '.vercel')) ? fs.readFileSync(path.join(OUT, '.vercel', 'project.json')) : null;
for (const entry of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) if (entry !== '.vercel') fs.rmSync(path.join(OUT, entry), { recursive: true, force: true });

const copyDir = (rel, filter) => fs.cpSync(path.join(ROOT, rel), path.join(OUT, rel), { recursive: true, filter });
const copyFile = (rel) => { fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(OUT, rel)); };

copyDir('api');
copyDir('src');
copyDir('scripts', (f) => !f.endsWith('stage-vercel.js'));
copyDir('templates');
copyDir(path.join('cache', 'engraving-fonts'));
copyDir(path.join('cache', 'shop'));
for (const f of ['package.json', 'package-lock.json', 'vercel.json', 'frames.json', path.join('decisions', 'christmas-gingerbread.json')]) copyFile(f);

const readTpl = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', `${id}.json`), 'utf8'));
for (const f of new Set(['creatsy-stack', 'single-collar', 'single-collar-side', 'single-collar-three-quarter', 'single-collar-back', 'single-collar-angled', 'single-collar-low-side', 'single-collar-stack', 'single-collar-buckle-front', 'single-collar-pair-stacked', 'single-collar-pair-angled', 'single-collar-flat', 'single-collar-flat-pair'].map(readTpl).flatMap((t) => [t.base, t.layered.below, t.layered.bin, ...(t.layered.shade ? [t.layered.shade] : []),
  ...Object.values(t.layered.metalPlates || {}), ...Object.values(t.layered.metalPlateOptions || {}).flat().map((o) => o.file)]))) copyFile(f);

// lifestyle scenes: the build converts the images; the serverless function reads the list
const { listLifestyle, MANIFEST } = require('../src/lifestyle');
const scenes = listLifestyle();
for (const s of scenes) copyFile(s.source);
fs.writeFileSync(path.join(OUT, MANIFEST), `${JSON.stringify(scenes.map(({ id, label, file, thumb }) => ({ id, label, file, thumb })), null, 1)}
`);

if (keepVercelLink) { fs.mkdirSync(path.join(OUT, '.vercel'), { recursive: true }); fs.writeFileSync(path.join(OUT, '.vercel', 'project.json'), keepVercelLink); }
console.log('staged in .deploy/');
