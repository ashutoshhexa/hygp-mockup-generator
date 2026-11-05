'use strict';

const fs = require('fs');

/**
 * The only thing a model is allowed to return for a listing.
 * It does not describe how to draw a collar. Pattern artwork is chosen
 * by the caller and sent to the GLB renderer, never to an image model.
 *
 * This proof reads a handwritten decision. A later model call must return
 * the same `listing` object, and may add `backgroundFile` pointing at an
 * empty scene (no product). It must not return product pixels.
 */
const { fontNames } = require('./fonts');

const FINISHES = ['gold', 'rosegold', 'silver'];

const ALLOWED_LISTING_KEYS = new Set([
  'centerColor',
  'collars',
  'backgroundPrompt',
  'backgroundFile',
  'backgroundPreset',
]);

function decideListing(decisionFile) {
  const raw = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
  if (!raw.patternFile && !raw.patternId) {
    throw new Error('Decision file needs patternFile or patternId for the renderer.');
  }
  const listing = raw.listing;
  if (!listing || typeof listing !== 'object') {
    throw new Error('Decision file needs a listing object.');
  }

  for (const key of Object.keys(listing)) {
    if (!ALLOWED_LISTING_KEYS.has(key)) {
      throw new Error(`Listing field "${key}" is not part of the model contract.`);
    }
  }

  if (!FINISHES.includes(listing.centerColor)) {
    throw new Error(`centerColor must be one of ${FINISHES.join(', ')}.`);
  }
  if (!Array.isArray(listing.collars) || listing.collars.length !== 3) {
    throw new Error('A listing needs exactly three collars (left, center, right).');
  }
  listing.collars.forEach((collar, index) => {
    if (!collar.name || !collar.phone) {
      throw new Error(`Collar ${index + 1} needs a name and a phone.`);
    }
    // storefront buckle fonts (src/fonts.js); skipped only before the list was ever fetched
    const fonts = fontNames();
    for (const key of ['font', 'phoneFont']) {
      if (key === 'phoneFont' && !collar.phoneFont) continue;
      if (fonts.length && !fonts.includes(collar[key])) {
        throw new Error(`Collar ${index + 1} ${key} "${collar[key]}" is not a buckle engraving font (${fonts.join(', ')}).`);
      }
    }
  });
  if (!listing.backgroundPrompt || !String(listing.backgroundPrompt).trim()) {
    throw new Error('backgroundPrompt is required. It must describe an empty scene.');
  }
  const prompt = listing.backgroundPrompt.toLowerCase();
  if (/\bcollar\b|\bleash\b|\bbuckle\b|\bdog\b/.test(prompt) && !/\bno collar\b/.test(prompt)) {
    throw new Error('backgroundPrompt must describe an empty scene, not a product.');
  }

  return {
    patternFile: raw.patternFile || null,
    patternId: raw.patternId || null,
    patternLabel: raw.patternLabel || raw.patternId || raw.patternFile,
    listing,
  };
}

function sideFinishes(centerColor, sideOrder) {
  const rest = sideOrder.filter((finish) => finish !== centerColor);
  if (rest.length !== 2) {
    throw new Error(`Cannot place side finishes around "${centerColor}".`);
  }
  return { left: rest[0], center: centerColor, right: rest[1], leash: centerColor };
}

module.exports = { decideListing, sideFinishes, FINISHES };
