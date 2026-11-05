# hygp-mockup generator

Generates Etsy listing images for Here You Go Pup: hero, color set, and dog shot.
Each image starts from a fixed template photo, and code applies the real pattern, hardware finish and engraving.

**The model never draws product pixels.** Its only job is to return the decision JSON (names, phones, fonts,
center finish, background), and, optionally, an empty background image with no product in it.

## Run

```
npm run studio      # http://127.0.0.1:4173  - live preview + template editor
npm run mockup      # CLI: renders decisions/christmas-gingerbread.json into out/listings/<pattern>/
node src/run.js --decision decisions/preview.json --mode uv   # print-direction check
```

## The three listing images (`frames.json`)

1. **Main photo**: `templates/creatsy-stack.json`, 3 collars imported from the layered Creatsy PSD, on the chosen
   background (the older hand-traced `studio-stack.json` with the leash is still available).
2. **Details & finishes**: `templates/infographic.json`. The collar gets the pattern and center finish. The three
   buckles at the bottom are already gold, rose gold and silver, so they're left alone.
3. **On a dog**: `templates/dog-park.json` for now. It will be replaced by a generated dog wearing a plain white collar (below).

Per-collar patterns: set `collarPatterns: [left, middle, right]` on a decision (or use "Different per collar" in
the UI). Empty entries fall back to `patternFile`. The leash uses the middle collar's pattern.

## Generating backgrounds and dog photos

```
set XAI_API_KEY=...
set XAI_IMAGE_MODEL=<image model id>
npm run plates:bg       # empty scenes -> poc/backgrounds/ (they show up in the UI's background picker)
npm run plates:dogs     # dogs in a plain WHITE collar + leash -> poc/dogs/ (review, then trace one as a template)
node src/generate-plates.js --kind dogs --dry-run   # print the prompts without calling the API
```

Prompts are in `poc/prompts/plates.json`. Dogs wear a **white** collar on purpose: white webbing and silver
metal are what code can recolor cleanly, the same as the studio photo.

## How a frame is made

A template (`templates/*.json`) is a photo plus geometry drawn once in the editor:

| Layer       | What code does                                                                                        |
|-------------|-------------------------------------------------------------------------------------------------------|
| `strap`     | Maps the pattern PNG along the webbing using "rungs" (edge-to-edge point pairs), then multiplies it by the photo's shading. The print can't rotate. |
| `hardware`  | Re-tones the photo's metal into gold / rose gold / silver using a luminance ramp. Holes are allowed.     |
| `engraving` | Warps the engraving raster (same fit math as production) onto the buckle face and etches it in.       |
| `keep`      | Copies photo pixels untouched (used when the background is swapped).                                   |

Background swap: the new plate is multiplied by the photo's own shadows, so the contact shadows stay.

`frames.json` lists the three listing frames and which template and background each one uses.
`src/mockup/plan.js` applies the color rule: the model's pick goes on the center collar and the leash, and the
other two finishes fill the side slots in a fixed order.

## Files

- `src/mockup/core.js`: the renderer. Pure pixel math, shared by the browser and Node.
- `src/mockup/node-io.js`: Node I/O (sharp, resvg engraving), used by the CLI and the export endpoint.
- `src/ui/`: Listing Studio (listing preview + template editor, with rendering in a Web Worker).
- `legacy/`: the earlier GLB-render-and-paste attempt. Kept for reference only.

## Adding a template

1. Put the photo in `poc/templates/`. Use white or light webbing and plain metal, and the highest resolution you have.
2. Copy an existing `templates/*.json`, then set `base`, `width`, `height` and `slots`, and empty the `layers`.
3. In the editor, add straps (top edge first), metal outlines, and an engraving quad per buckle.
   Check the result with **Print direction** and **Masks**.
4. Reference the template from `frames.json`.

## Importing a layered PSD (preferred)

When a mockup comes as a layered PSD (Creatsy-style: `Color: collar N`, `Design: fabric ... /collar N` smart
objects, `Color: buckles /collar N`, an `Overlay layers` group and `Design: buckle (engraved)` slots), nothing has
to be traced:

```
node --max-old-space-size=12000 src/tools/import-psd.js "poc/templates/<file>.psd" <templateId> [--crop x,y,w,h] [--width 3000]
```

- Everything below the collars (background, scene shadows, drop shadow) is baked into `below.png`.
- Every mask, shading layer and warp is written to `poc/templates/<id>/layers.bin`. Each fabric smart object's
  Photoshop warp (split Bezier mesh + transform, `src/tools/psd-warp.js`) becomes a per-pixel UV map. It was checked
  against Photoshop's own render of each layer: 0.991 to 1.000 overlap inside the visible masks.
- At render time `core.js` replays the stack: collar fills, the pattern through each warp, metal fill in the chosen
  finish, stitching, then Levels / soft light / multiply / screen / Hue-Sat exactly as in the PSD, then the engraving
  through the PSD's engraving slot. With a blank white pattern it reproduces Photoshop's composite to within
  0.4 levels on average outside the fabric.
- The watermark layer is left out. **Show the parts** in the preview shows how the PSD divides each collar.
- Collar slots: PSD collar 1/2/3 = top/middle/bottom = the UI's left/middle/right. The middle one gets the best-seller finish.
