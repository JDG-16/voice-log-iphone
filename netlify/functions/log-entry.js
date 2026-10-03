// netlify/functions/log-entry.js
//
// Receives a raw voice transcript from the iOS Shortcut, asks Claude to
// classify it into one of five categories (todo, grocery, finance, house,
// restaurant) and extract the right fields for that category, then writes
// both the raw + structured record to Firestore.
//
// Env vars needed (set in Netlify: Site configuration -> Environment variables):
//   ANTHROPIC_API_KEY        - your Claude API key
//   FIREBASE_SERVICE_ACCOUNT - the full JSON of a Firebase service account
//                               key, stringified (see SETUP.md)
//   SHORTCUT_SHARED_SECRET   - any random string; the Shortcut sends this
//                               as a header so randoms on the internet
//                               can't write to your Firestore

const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

// --- Firebase init (cold-start-safe singleton) ---
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = `You extract structured data from a short spoken log entry and file it into
exactly one category: "todo", "grocery", "finance", "house", or "restaurant".

Category guide:
- "todo": general tasks, reminders, errands that don't fit the categories below
- "grocery": items to buy at a grocery store or shop
- "finance": bills, payments, money-related tasks or reminders
- "house": home maintenance, repairs, house-related projects or chores
- "restaurant": mentions of a restaurant or place to eat — either already
  visited, or somewhere the person wants to try

If you are unsure which category fits, use "todo".

Return ONLY valid JSON (no markdown code fences, no commentary) matching this
exact shape:

{
  "type": "todo" | "grocery" | "finance" | "house" | "restaurant",
  "title": string,
  "done": boolean,                 // todo/grocery/finance/house only — false unless clearly already done; false for restaurant
  "dueDate": string | null,        // ISO date (YYYY-MM-DD) if a deadline was mentioned, else null — todo/grocery/finance/house only
  "notes": string | null,          // any extra detail worth keeping, for any type
  "status": "went" | "want_to_go" | null,   // restaurant only, else null
  "neighborhood": string | null,   // restaurant only, if a neighborhood/area was mentioned, else null
  "rating": number | null,         // restaurant only, out of 10 if a rating was mentioned, else null
  "sentiment": "positive" | "negative" | "mixed" | "neutral" | null,  // restaurant only, else null
  "tags": string[]                 // short descriptive lowercase tags, any type, [] if none
}

Transcript: `;

function fallbackStructured(transcript) {
  return {
    type: 'todo',
    title: transcript.slice(0, 80),
    done: false,
    dueDate: null,
    notes: transcript,
    status: null,
    neighborhood: null,
    rating: null,
    sentiment: null,
    tags: [],
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Simple shared-secret check so this endpoint isn't open to the world
  const secret = event.headers['x-shortcut-secret'];
  if (secret !== process.env.SHORTCUT_SHARED_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let transcript;
  try {
    const body = JSON.parse(event.body);
    transcript = (body.transcript || '').trim();
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  if (!transcript) {
    return { statusCode: 400, body: 'Missing "transcript" field' };
  }

  // Ask Claude to classify + structure the transcript
  let structured;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      messages: [
        { role: 'user', content: EXTRACTION_PROMPT + transcript },
      ],
    });

    let raw = msg.content[0].text.trim();
    // Claude sometimes wraps JSON in markdown code fences (```json ... ```)
    // even when told not to — strip those before parsing.
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(raw);

    // Normalize so every doc has a consistent shape regardless of type
    structured = {
      type: parsed.type || 'todo',
      title: parsed.title || transcript.slice(0, 80),
      done: !!parsed.done,
      dueDate: parsed.dueDate || null,
      notes: parsed.notes || null,
      status: parsed.status || null,
      neighborhood: parsed.neighborhood || null,
      rating: typeof parsed.rating === 'number' ? parsed.rating : null,
      sentiment: parsed.sentiment || null,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  } catch (err) {
    console.error('Extraction failed:', err);
    // Fall back to a plain to-do entry rather than losing the log
    structured = fallbackStructured(transcript);
  }

  // Write to Firestore
  try {
    const docRef = await db.collection('logs').add({
      transcript,
      ...structured,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ id: docRef.id, ...structured }),
    };
  } catch (err) {
    console.error('Firestore write failed:', err);
    return { statusCode: 500, body: 'Failed to save log entry' };
  }
};
