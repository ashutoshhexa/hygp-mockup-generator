'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const { SCREENSHOT_ROOT, fromRoot } = require('./paths');

function screenshotRequire(name) {
  return require(path.join(SCREENSHOT_ROOT, 'node_modules', name));
}

function findChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
      : null,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function servePattern(patternFile) {
  const body = fs.readFileSync(patternFile);
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/pattern.png') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'image/png');
    res.setHeader('access-control-allow-origin', '*');
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        patternUrl: `http://127.0.0.1:${port}/pattern.png`,
      });
    });
    server.on('error', reject);
  });
}

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-webgl',
  '--disable-extensions',
];

async function renderProducts({ patternFile, finishMap, finishKeys, leashFinish, layout }) {
  const { startRenderApp } = require(path.join(SCREENSHOT_ROOT, 'screenshot-app', 'render-app.js'));
  const { resolveModel } = require(path.join(SCREENSHOT_ROOT, 'service', 'models.js'));
  const { ensureLocal } = require(path.join(SCREENSHOT_ROOT, 'service', 'model-cache.js'));
  const puppeteer = screenshotRequire('puppeteer');

  const outDir = fromRoot('poc', 'out', 'renders');
  fs.mkdirSync(outDir, { recursive: true });

  const patternServer = await servePattern(patternFile);
  const { server: appServer, port } = await startRenderApp(0);
  const chrome = findChromeExecutable();
  if (chrome) console.log(`Browser: ${chrome}`);
  else console.log('Browser: puppeteer default');

  const browser = await puppeteer.launch({
    headless: true,
    ...(chrome ? { executablePath: chrome } : {}),
    args: BROWSER_ARGS,
    protocolTimeout: 180000,
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(`http://127.0.0.1:${port}/app/batch.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForFunction(() => window.__BATCH_READY__ === true, { timeout: 30000 });

    const jobs = [
      {
        key: 'collar',
        productType: 'dog collar',
        profile: 'dogcollar',
        finishKeys: finishKeys,
      },
      {
        key: 'leash',
        productType: 'dog leash',
        profile: 'leash',
        finishKeys: [leashFinish],
      },
    ];

    const written = {};
    for (const job of jobs) {
      const resolved = await resolveModel({
        productType: job.productType,
        size: layout.render.productSize,
        hardwareKind: layout.render.hardwareKind,
      });
      if (resolved.note) console.log(`Model note (${job.key}): ${resolved.note}`);
      const modelRel = await ensureLocal(resolved.source);
      const loadRes = await page.evaluate(async (params) => window.loadModel(params), {
        productProfile: job.profile,
        modelUrl: `/models/${modelRel}`,
        size: layout.render.productSize,
        hardwareKind: layout.render.hardwareKind,
        patternImage: patternServer.patternUrl,
      });
      if (!loadRes || !loadRes.ok) {
        throw new Error(`Load ${job.key} failed: ${(loadRes && loadRes.error) || 'unknown'}`);
      }

      for (const finishKey of job.finishKeys) {
        const finish = finishMap[finishKey];
        if (!finish) throw new Error(`Unknown finish "${finishKey}".`);
        const capture = await page.evaluate(async (variant) => window.captureVariant(variant), {
          hardwareKind: layout.render.hardwareKind,
          metalHexCode: finish.metalHexCode,
          plasticHexCode: finish.plasticHexCode,
          box: layout.render.box,
          padding: layout.render.padding,
          background: '#000000',
        });
        if (!capture || !capture.ok || !capture.transparentDataUrl) {
          throw new Error(`Capture ${job.key} ${finishKey} failed: ${(capture && capture.error) || 'empty'}`);
        }
        const png = Buffer.from(
          capture.transparentDataUrl.replace(/^data:image\/png;base64,/, ''),
          'base64',
        );
        const dest = path.join(outDir, `${job.key}-${finishKey}.png`);
        fs.writeFileSync(dest, png);
        written[`${job.key}-${finishKey}`] = dest;
        console.log(`Rendered ${job.key} ${finishKey} (${png.length} bytes)`);
      }
    }
    return written;
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => appServer.close(resolve));
    await new Promise((resolve) => patternServer.server.close(resolve));
  }
}

module.exports = { renderProducts };
