'use strict';

/**
 * Dog-name ideas for the buckles, matched to the pattern on the collars (Ollama).
 *
 * Talks to a local Ollama server (default http://127.0.0.1:11434). No API key.
 * Set OLLAMA_MODEL (default llama3.2:1b) and optionally OLLAMA_HOST.
 * If Ollama is down or the call fails, names come from the same themed list as
 * name-ideas.js, so the button always does something useful.
 */
const { z } = require('zod');
const { themedNames } = require('./name-ideas');

const HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:1b';
const COUNT = 8;
const MAX_LEN = 10; // longer names get small on the buckle

const IdeasSchema = z.object({
  theme: z.string().describe('A few words naming the mood the names were picked for'),
  names: z.array(z.string()).describe(`${COUNT} dog names`),
});

const FORMAT = {
  type: 'object',
  properties: {
    theme: { type: 'string' },
    names: { type: 'array', items: { type: 'string' } },
  },
  required: ['theme', 'names'],
};

const SYSTEM = `You suggest pet names for Etsy listing photos of personalised dog collars. The names are laser engraved on the buckle, so the shopper should see a name and think it fits the collar's pattern.

Rules for every name:
- one word, ${MAX_LEN} letters or fewer, easy to read at a glance
- sounds like a real dog's name, warm and playful, fine for all ages
- inspired by the pattern's motifs, colours or season (a Christmas dinosaur pattern might give Rexy, Jingle, Comet), mixed with a few classic dog names that suit the mood
- no trademarked or well-known character names, brands, or celebrities
- no repeats, and none of the names the user says to avoid
Reply with JSON only: {"theme":"...","names":["..."]}`;

const cache = new Map();

/**
 * patterns: [{ label, thumb, collection }] (one per distinct pattern in use)
 * avoid: names already shown or used, so "More ideas" gives new ones
 */
async function suggestNames(patterns, { avoid = [], fresh = false } = {}) {
  const key = JSON.stringify([patterns.map((p) => p.label), fresh ? avoid : []]);
  if (!fresh && cache.has(key)) return cache.get(key);
  let result = null;
  try { result = await askOllama(patterns, avoid); } catch (err) {
    console.warn('Name ideas: Ollama call failed, using the themed list.', err.message);
  }
  if (!result) result = themedNames(patterns, avoid);
  if (cache.size > 200) cache.clear();
  cache.set(key, result);
  return result;
}

async function askOllama(patterns, avoid) {
  const described = patterns.map((p) => (p.thumbFile
    ? `- legacy pattern "${p.label}" (catalogue number only; invent warm classic dog names)`
    : `- "${p.label}"${p.collection ? ` (collection: ${p.collection})` : ''}`)).join('\n');
  const user = `Collar pattern${patterns.length > 1 ? 's' : ''}:\n${described}\n\n`
    + `Suggest ${COUNT} names.${avoid.length ? ` Avoid: ${avoid.join(', ')}.` : ''}`;

  const t0 = Date.now();
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: FORMAT,
      options: { temperature: 0.9, num_predict: 200 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error || JSON.stringify(body).slice(0, 200) || res.statusText;
    throw new Error(`Ollama ${res.status}: ${msg}`);
  }
  const raw = body.message && body.message.content;
  console.log(`Name ideas (Ollama ${MODEL}) ${Date.now() - t0}ms:`, raw);
  if (!raw) return null;
  let parsed;
  try { parsed = IdeasSchema.parse(JSON.parse(raw)); } catch (err) {
    console.warn('Name ideas (Ollama) parse failed:', err.message);
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
