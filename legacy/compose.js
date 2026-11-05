'use strict';

const fs = require('fs');

const { fromRoot } = require('./paths');
const { resolveBackground } = require('./background');
const { applyRotation } = require('./orient');
const { rasterizeEngraving } = require('./engraving');

function sharp() {
  return require('sharp');
}

function slotBox(slot, width, height) {
  return {
    x: Math.round(slot.x * width),
    y: Math.round(slot.y * height),
    w: Math.max(1, Math.round(slot.w * width)),
    h: Math.max(1, Math.round(slot.h * height)),
    rotate: slot.rotate,
    fit: slot.fit,
  };
}

async function trimTransparent(pngBuffer) {
  try {
    return await sharp()(pngBuffer).trim().png().toBuffer();
  } catch {
    return pngBuffer;
  }
}

async function placeProduct(pngBuffer, slot) {
  const trimmed = await trimTransparent(pngBuffer);
  const turned = await applyRotation(trimmed, slot.rotate);
  const fitted = await sharp()(turned)
    .resize(slot.w, slot.h, {
      fit: slot.fit || 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const meta = await sharp()(fitted).metadata();
  const left = slot.x + Math.round((slot.w - meta.width) / 2);
  const top = slot.y + Math.round((slot.h - meta.height) / 2);
  return {
    layer: { input: fitted, left, top },
    box: { x: left, y: top, w: meta.width, h: meta.height },
  };
}

async function engravingLayer(collar, window, productBox) {
  const png = await trimTransparent(rasterizeEngraving({
    name: collar.name,
    phone: collar.phone,
    font: collar.font,
  }));
  const box = {
    x: productBox.x + Math.round(window.nx * productBox.w),
    y: productBox.y + Math.round(window.ny * productBox.h),
    w: Math.max(1, Math.round(window.nw * productBox.w)),
    h: Math.max(1, Math.round(window.nh * productBox.h)),
    fit: 'contain',
    rotate: 0,
  };
  const placed = await placeProduct(png, box);
  return placed.layer;
}

async function composeListing({ layout, listing, assignment, renders, dogPlate }) {
  const s = sharp();
  const outDir = fromRoot('poc', 'out', 'listing');
  fs.mkdirSync(outDir, { recursive: true });

  const hero = await composeProductFrame({
    frame: layout.hero,
    width: layout.canvas.hero.width,
    height: layout.canvas.hero.height,
    ground: await resolveBackground(
      listing,
      layout.canvas.hero.width,
      layout.canvas.hero.height,
    ),
    listing,
    assignment,
    renders,
  });
  const colors = await composeProductFrame({
    frame: layout.colors,
    width: layout.canvas.colors.width,
    height: layout.canvas.colors.height,
    ground: await s({
      create: {
        width: layout.canvas.colors.width,
        height: layout.canvas.colors.height,
        channels: 3,
        background: layout.colorsGround,
      },
    }).png().toBuffer(),
    listing,
    assignment,
    renders,
  });

  const heroPath = fromRoot('poc', 'out', 'listing', '01-hero.png');
  const colorsPath = fromRoot('poc', 'out', 'listing', '02-colors.png');
  const dogPath = fromRoot('poc', 'out', 'listing', '03-dog.png');
  fs.writeFileSync(heroPath, hero);
  fs.writeFileSync(colorsPath, colors);

  const plateMeta = await s(dogPlate).metadata();
  const dogWidth = layout.dog.outputWidth;
  const dogHeight = Math.round(dogWidth * (plateMeta.height / plateMeta.width));
  const plate = await s(dogPlate)
    .resize(dogWidth, dogHeight, { fit: 'fill' })
    .png()
    .toBuffer();
  const dog = await composeDog({
    plate,
    width: dogWidth,
    height: dogHeight,
    frame: layout.dog,
    listing,
    assignment,
    renders,
  });
  fs.writeFileSync(dogPath, dog);

  return { heroPath, colorsPath, dogPath };
}

async function composeProductFrame({ frame, width, height, ground, listing, assignment, renders }) {
  const leftBox = slotBox(frame.slots.left, width, height);
  const centerBox = slotBox(frame.slots.center, width, height);
  const rightBox = slotBox(frame.slots.right, width, height);
  const leashBox = slotBox(frame.slots.leash, width, height);

  const leash = await placeProduct(fs.readFileSync(renders[`leash-${assignment.leash}`]), leashBox);
  const left = await placeProduct(fs.readFileSync(renders[`collar-${assignment.left}`]), leftBox);
  const right = await placeProduct(fs.readFileSync(renders[`collar-${assignment.right}`]), rightBox);
  const center = await placeProduct(fs.readFileSync(renders[`collar-${assignment.center}`]), centerBox);
  const layers = [
    leash.layer,
    left.layer,
    right.layer,
    center.layer,
    await engravingLayer(listing.collars[0], frame.engraving, left.box),
    await engravingLayer(listing.collars[2], frame.engraving, right.box),
    await engravingLayer(listing.collars[1], frame.engraving, center.box),
  ];

  return sharp()(ground).composite(layers).png().toBuffer();
}

async function composeDog({ plate, width, height, frame, listing, assignment, renders }) {
  const collarBox = slotBox(frame.slots.collar, width, height);
  const leashBox = slotBox(frame.slots.leash, width, height);
  const leash = await placeProduct(fs.readFileSync(renders[`leash-${assignment.leash}`]), leashBox);
  const collar = await placeProduct(fs.readFileSync(renders[`collar-${assignment.center}`]), collarBox);
  const layers = [
    leash.layer,
    collar.layer,
    await engravingLayer(listing.collars[1], frame.engraving, collar.box),
  ];
  return sharp()(plate).composite(layers).png().toBuffer();
}

module.exports = { composeListing };
