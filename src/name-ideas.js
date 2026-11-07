'use strict';

/**
 * Dog-name ideas for the buckles, matched to the pattern on the collars.
 *
 * With ANTHROPIC_API_KEY set, Claude looks at the pattern thumbnails (store previews) and the
 * pattern and collection names, and returns short, engraving-friendly names. Without a key, or
 * if the call fails, names come from a themed list picked by keywords in the pattern name, so
 * the button always does something useful.
 */
const { z } = require('zod');

// Haiku: fast and cheap for a short list (no server-side fallback on Haiku; the themed list covers failures)
const MODEL = 'claude-haiku-5-5';
const COUNT = 8;
const MAX_LEN = 10; // longer names get small on the buckle

const IdeasSchema = z.object({
  theme: z.string().describe('A few words naming the mood the names were picked for'),
  names: z.array(z.string()).describe(`${COUNT} dog names`),
});

const SYSTEM = `You suggest pet names for Etsy listing photos of personalised dog collars. The names are laser engraved on the buckle, so the shopper should see a name and think it fits the collar's pattern.

Rules for every name:
- one word, ${MAX_LEN} letters or fewer, easy to read at a glance
- sounds like a real dog's name, warm and playful, fine for all ages
- inspired by the pattern's motifs, colours or season (a Christmas dinosaur pattern might give Rexy, Jingle, Comet), mixed with a few classic dog names that suit the mood
- no trademarked or well-known character names, brands, or celebrities
- no repeats, and none of the names the user says to avoid`;

let client = null;
function claude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk').default;
    client = new Anthropic({ timeout: 30000, maxRetries: 1 });
  }
  return client;
}

const cache = new Map();

/**
 * patterns: [{ label, thumb, collection }] (one per distinct pattern in use)
 * avoid: names already shown or used, so "More ideas" gives new ones
 */
async function suggestNames(patterns, { avoid = [], fresh = false } = {}) {
  const key = JSON.stringify([patterns.map((p) => p.label), fresh ? avoid : []]);
  if (!fresh && cache.has(key)) return cache.get(key);
  let result = null;
  const api = claude();
  if (api) {
    try { result = await askClaude(api, patterns, avoid); } catch (err) { console.warn('Name ideas: AI call failed, using the themed list.', err.message); }
  }
  if (!result) result = themedNames(patterns, avoid);
  if (cache.size > 200) cache.clear();
  cache.set(key, result);
  return result;
}

async function askClaude(api, patterns, avoid) {
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
  const images = [];
  for (const p of patterns) {
    if (p.thumb && /^https:\/\/cdn\.shopify\.com\//.test(p.thumb)) {
      images.push({ type: 'image', source: { type: 'url', url: p.thumb } });
    } else if (p.thumbFile) {
      // a thumbnail we make ourselves (legacy patterns): send the pixels
      try {
        const file = await require('./catalog').ensurePatternFile(p.thumbFile);
        if (file) images.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: require('fs').readFileSync(file).toString('base64') } });
      } catch (err) { console.warn('Name ideas: no thumbnail for', p.label, err.message); }
    }
  }
  // legacy names are only numbers: tell the model to go by the picture, not the label
  const described = patterns.map((p) => (p.thumbFile
    ? '- a legacy pattern (its name is just a catalogue number; judge it by the picture)'
    : `- "${p.label}"${p.collection ? ` (collection: ${p.collection})` : ''}`)).join('\n');
  const text = `Collar pattern${patterns.length > 1 ? 's' : ''} in the photo${images.length ? ' (thumbnails above)' : ''}:\n${described}\n\n`
    + `Suggest ${COUNT} names.${avoid.length ? ` Avoid: ${avoid.join(', ')}.` : ''}`;
  const res = await api.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(IdeasSchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: [...images, { type: 'text', text }] }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
  const names = clean(res.parsed_output.names, avoid);
  if (names.length < 3) return null;
  return { names: names.slice(0, COUNT), theme: res.parsed_output.theme, source: 'ai' };
}

function clean(list, avoid) {
  const seen = new Set(avoid.map((n) => n.toLowerCase()));
  const out = [];
  for (const raw of list || []) {
    const n = String(raw).trim().replace(/[^A-Za-z'-]/g, '');
    if (!n || n.length > MAX_LEN || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n[0].toUpperCase() + n.slice(1));
  }
  return out;
}

/* ---------------- no-key fallback: themed lists picked by keywords ---------------- */
const THEMES = [
  { theme: 'Christmas', words: /xmas|christmas|santa|elf|reindeer|holly|candy ?cane|gingerbread|ornament|nutcracker|poinsettia|mistletoe|jingle|noel/i,
    names: ['Jingle', 'Holly', 'Comet', 'Tinsel', 'Cocoa', 'Ginger', 'Noel', 'Blitzen', 'Twinkle', 'Cookie', 'Ivy', 'Pudding', 'Frosty', 'Merry', 'Nutmeg', 'Clove'] },
  { theme: 'Winter', words: /snow|winter|frost|ice|penguin|polar|mitten|sweater|plaid|flannel|fir|spruce|pine/i,
    names: ['Juniper', 'Aspen', 'Willow', 'Flurry', 'Maple', 'Cedar', 'Pepper', 'Mocha', 'Blizzard', 'Snowy', 'Bear', 'Fern', 'Hazel', 'Koda'] },
  { theme: 'Halloween', words: /hallow|spooky|ghost|pumpkin|skull|goth|witch|bat|spider|candy corn|boo\b/i,
    names: ['Pumpkin', 'Spooky', 'Raven', 'Salem', 'Midnight', 'Boo', 'Shadow', 'Ghost', 'Hocus', 'Jinx', 'Onyx', 'Binx'] },
  { theme: 'Summer & beach', words: /summer|beach|flip|flop|shell|ocean|sea|wave|surf|tropic|palm|pineapple|flamingo|fish|lure|sail|anchor|sun\b|watermelon|lemon/i,
    names: ['Sunny', 'Coral', 'Marina', 'Skipper', 'Mango', 'Kai', 'Splash', 'Pebble', 'Sandy', 'Captain', 'Peaches', 'Bodhi', 'Luna', 'Reef'] },
  { theme: 'Spring & flowers', words: /flower|floral|daisy|rose|tulip|bloom|garden|spring|bee|butterfl|easter|bunny|blossom/i,
    names: ['Daisy', 'Poppy', 'Clover', 'Rosie', 'Petal', 'Sage', 'Honey', 'Lily', 'Bloom', 'Willow', 'Pip', 'Iris'] },
  { theme: 'Dinosaurs', words: /dino|rex|jurassic|raptor/i,
    names: ['Rexy', 'Dino', 'Chomp', 'Ziggy', 'Rocky', 'Spike', 'Tank', 'Rex', 'Bronto', 'Mo'] },
  { theme: 'Love', words: /heart|love|valentine|cupid|kiss/i,
    names: ['Cupid', 'Sweetie', 'Valentino', 'Romeo', 'Ruby', 'Lovey', 'Bijou', 'Candy', 'Darling', 'Juliet'] },
  { theme: 'Autumn', words: /fall|autumn|leaf|leaves|harvest|thanksgiving|acorn|apple/i,
    names: ['Maple', 'Hazel', 'Acorn', 'Cider', 'Rusty', 'Ginger', 'Biscuit', 'Chestnut', 'Pecan', 'Autumn'] },
];
const CLASSIC = ['Biscuit', 'Milo', 'Luna', 'Bella', 'Charlie', 'Teddy', 'Rosie', 'Cooper', 'Daisy', 'Buddy', 'Lola', 'Finn', 'Maple', 'Ollie', 'Penny', 'Bear'];

function themedNames(patterns, avoid) {
  const text = patterns.map((p) => `${p.label} ${p.collection || ''}`).join(' ');
  const hits = THEMES.filter((t) => t.words.test(text));
  const pool = [...new Set([...hits.flatMap((t) => t.names), ...CLASSIC])];
  const shuffled = pool.map((n) => [Math.random(), n]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  // themed names first, a few classics after
  const themed = shuffled.filter((n) => hits.some((t) => t.names.includes(n)));
  const rest = shuffled.filter((n) => !themed.includes(n));
  const names = clean([...themed, ...rest], avoid).slice(0, COUNT);
  return { names, theme: hits.length ? hits.map((t) => t.theme).join(' + ') : 'Classic dog names', source: 'list' };
}

module.exports = { suggestNames, themedNames };
