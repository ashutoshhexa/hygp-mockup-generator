'use strict';

// Rebuild the single-collar size guide from the supplied size chart and fitting steps.
const sharp = require('sharp');
const { loadFont } = require('../fonts');
const { palette, typeset, writeOpenCollarCard } = require('./open-collar-card');

const SIZE = 3000;
const ID = 'single-collar-how-to-measure';
const MEASUREMENT_OFFSET = 735;
const { ink, muted, cream, coral, marigold, sage, butter } = palette;
const SIZES = [
  { heading: ['Extra Small'], width: '5/8″', length: '9–11″' },
  { heading: ['Small'], width: '3/4″', length: '11–13″' },
  { heading: ['Medium', 'Narrow'], width: '3/4″', length: '13–16″' },
  { heading: ['Medium', 'Wide'], width: '1″', length: '13–16″' },
  { heading: ['Large'], width: '1″', length: '16–22″' },
  { heading: ['XLarge'], width: '1.25″', length: '18–26″' },
  { heading: ['XXLarge'], width: '1.25″', length: '24–32″' },
];

function measurementIcons() {
  const dogHead = `<path fill="${ink}" stroke="none" d="M106 229c18-35 29-66 36-104 6-33 16-58 27-73l4-39c1-9 12-12 17-4l17 27c19 2 29 12 36 26l19 7c7 2 9 7 7 12l-5 15c-4 8-14 11-26 11h-12c-8 25-11 51-8 77l8 50c-36 15-88 14-120-5z"/>`;
  const neckTape = `<path d="M145 93l84 32-8 20-84-32z" fill="${butter}"/>
    <path d="M153 99l-4 9m16-4-5 12m17-7-3 9m15-4-4 11m17-6-4 9m15-4-5 12" stroke-width="3"/>`;
  return [
    `${dogHead}${neckTape}<path d="M142 112q-25 15-27 42t-30 45l13 14q31-15 37-48t21-48" fill="${butter}"/>
      <path d="M113 172l10 5m-17 8 11 5m-22 5 10 7" stroke-width="3"/>`,
    `${dogHead}${neckTape}<path d="M20 110h35l28-9 72 24q11 5 7 14-3 7-13 5l-48-13 57 23q10 4 7 12-3 8-12 6l-67-20 19 13q8 6 3 13-5 7-14 2l-36-18H20" fill="#fffaf3"/>
      <path d="M99 131l-16-5m17 28-17-6" stroke-width="3"/>`,
    `<path d="M34 97v52c0 34 34 57 79 57h106v17h24v-54c0-11-9-20-20-20h-74c26-10 43-30 43-52" fill="${butter}"/>
      <ellipse cx="113" cy="97" rx="79" ry="52" fill="#fffaf3"/>
      <ellipse cx="113" cy="97" rx="54" ry="34"/><ellipse cx="113" cy="97" rx="15" ry="10" fill="${ink}"/>
      <path d="M65 172v18m24-12v22m24-18v23m24-18v18m24-30v30m24-18v18m24-30v30"/>`,
  ];
}

function artwork(serif, sans) {
  const title = (text, x, y, size) => typeset(serif, text, x, y, size);
  const text = (line, x, y, size = 62, color = muted) => typeset(sans, line, x, y, size, color);
  const steps = [
    ['Wrap a soft tape around', 'the base of your dog’s neck.'],
    ['Leave room for two fingers', 'between the neck and collar.'],
    ['Use the size chart above', 'to choose the right fit.'],
  ];
  const diagram = measurementIcons().map((icon, i) => {
    const x = 600 + i * 900;
    return `<circle cx="${x}" cy="1691" r="167" fill="#fffaf3"/>
      <g transform="translate(${x - 143} 1566)" fill="none" stroke="${ink}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round">${icon}</g>
      ${text(String(i + 1), x, 1923, 58, ink)}
      ${text(steps[i][0], x, 2010)}
      ${text(steps[i][1], x, 2084)}`;
  }).join('');
  const tableX = 125, tableW = 2750, labelW = 307;
  const cellW = (tableW - labelW) / SIZES.length;
  const columns = SIZES.map((size, i) => {
    const left = tableX + labelW + i * cellW;
    const x = left + cellW / 2;
    const y = size.heading.length === 1 ? 2450 : 2419;
    return `<path d="M${left} 2328V2850" stroke="#c6d8cb" stroke-width="3"/>
      ${size.heading.map((line, row) => text(line, x, y + row * 59, 55, ink)).join('')}
      ${text(size.width, x, 2610, 66, ink)}
      ${text(size.length, x, 2793, 66, ink)}`;
  }).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <rect width="${SIZE}" height="${SIZE}" fill="${cream}"/>
    <g transform="translate(0 -2070)">
      ${title('Collar size chart', 1500, 2260, 105)}
      <path d="M125 2227h590m1570 0h590" stroke="${marigold}" stroke-width="8" stroke-linecap="round"/>
      <rect x="${tableX}" y="2328" width="${tableW}" height="522" rx="38" fill="#fffaf3"/>
      <path d="M163 2328h2674q38 0 38 38v135H125v-135q0-38 38-38z" fill="${sage}"/>
      <path d="M125 2501h2750m-2750 175h2750" stroke="#c6d8cb" stroke-width="4"/>
      ${text('Size', 277, 2450, 60, ink)}
      ${text('Width', 277, 2610, 60, ink)}
      ${text('Length', 277, 2793, 60, ink)}
      ${columns}
      <rect x="${tableX}" y="2328" width="${tableW}" height="522" rx="38" fill="none" stroke="#b4cabb" stroke-width="4"/>
    </g>
    <g transform="translate(0 ${MEASUREMENT_OFFSET})">
      ${title('How to measure', 1500, 233, 185)}
      <path d="M1330 300h340" stroke="${coral}" stroke-width="13" stroke-linecap="round"/>
      <rect x="125" y="374" width="2750" height="863" rx="55" fill="#fffaf3" stroke="#ebdbca" stroke-width="4"/>
      ${title('Measure a collar that fits', 1500, 512, 102)}
      ${text('1. Remove the collar', 615, 646, 63, ink)}
      ${text('2. Lay it flat', 1500, 646, 63, ink)}
      ${text('3. Measure as shown', 2385, 646, 63, ink)}
      <path d="M284 722v58m0-29h2182m0-29v58" fill="none" stroke="${ink}" stroke-width="10" stroke-linecap="round"/>
      <rect x="382" y="1120" width="2236" height="72" rx="36" fill="${butter}"/>
      ${text('Include only one buckle half. The halves overlap when clipped together.', 1500, 1171, 54, ink)}
      <rect x="125" y="1300" width="2750" height="848" rx="55" fill="${sage}"/>
      ${title('Or measure your dog’s neck', 1500, 1445, 102)}
      ${diagram}
      <path d="M1020 1691h55m-21-20 21 20-21 20m866-20h55m-21-20 21 20-21 20"
        fill="none" stroke="${ink}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </svg>`);
}

async function main() {
  const [serif, sans] = await Promise.all([loadFont('DM Serif'), loadFont('Roboto')]);
  const art = await sharp(artwork(serif, sans)).ensureAlpha().raw().toBuffer();
  await writeOpenCollarCard({ id: ID, name: 'How to measure', size: SIZE, art, shift: { x: 0, y: 12 + MEASUREMENT_OFFSET }, collar: 0 });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
