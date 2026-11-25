'use strict';

/**
 * Dog-name ideas for the buckles, matched to the pattern on the collars (Gemini).
 *
 * With GEMINI_API_KEY (or GOOGLE_API_KEY) set, Gemini uses the pattern and collection
 * names (text only — no image round-trip) and returns short, engraving-friendly names.
 * Without a key, or if the call fails, names come from the same themed list as
 * name-ideas.js, so the button always does something useful.
 */
const { z } = require('zod');
const { themedNames } = require('./name-ideas');

// Flash-Lite: lowest latency; thinking is off. Override with GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
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
- no repeats, and none of the names the user says to avoid
Reply with JSON only.`;

let client = null;
function gemini() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ;
  if (!apiKey) return null;
  if (!client) {
    const { GoogleGenAI } = require('@google/genai');
    // systemInstruction needs v1beta (v1 returns INVALID_ARGUMENT)
    client = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
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
  const api = gemini();
  if (api) {
    try { result = await askGemini(api, patterns, avoid); } catch (err) { console.warn('Name ideas: Gemini call failed, using the themed list.', err.message); }
  }
  if (!result) result = themedNames(patterns, avoid);
  if (cache.size > 200) cache.clear();
  cache.set(key, result);
  return result;
}

async function askGemini(api, patterns, avoid) {
  // Text only: pattern labels are enough, and skipping image fetch/vision cuts most of the wait.
  const described = patterns.map((p) => (p.thumbFile
    ? `- legacy pattern "${p.label}" (catalogue number only; invent warm classic dog names)`
    : `- "${p.label}"${p.collection ? ` (collection: ${p.collection})` : ''}`)).join('\n');
  const text = `${SYSTEM}\n\nCollar pattern${patterns.length > 1 ? 's' : ''}:\n${described}\n\n`
    + `Suggest ${COUNT} names.${avoid.length ? ` Avoid: ${avoid.join(', ')}.` : ''}`;

  // Zod's JSON Schema includes $schema / additionalProperties that Gemini rejects
  const { $schema, additionalProperties, ...jsonSchema } = z.toJSONSchema(IdeasSchema);
  const t0 = Date.now();
  const res = await api.models.generateContent({
    model: MODEL,
    contents: text,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: jsonSchema,
      temperature: 0.9,
      maxOutputTokens: 256,
    },
  });
  const raw = res.text;
  console.log(`Name ideas (Gemini ${MODEL}) ${Date.now() - t0}ms:`, raw);
  if (!raw) return null;
  let parsed;
  try { parsed = IdeasSchema.parse(JSON.parse(raw)); } catch (err) {
    console.warn('Name ideas (Gemini) parse failed:', err.message);
    return null;
  }
  const names = clean(parsed.names, avoid);
  if (names.length < 3) return null;
  return { names: names.slice(0, COUNT), theme: parsed.theme, source: 'ai' };
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

module.exports = { suggestNames };
