// netlify/functions/log-entry.js
//
// Receives a raw voice transcript from the iOS Shortcut, asks Claude to
// extract structured fields, and writes both the raw + structured record
// to Firestore.
//
// Env vars needed (set in Netlify: Site settings -> Environment variables):
//   ANTHROPIC_API_KEY      - your Claude API key
//   FIREBASE_SERVICE_ACCOUNT - the full JSON of a Firebase service account
//                               key, stringified (see setup notes below)
//   SHORTCUT_SHARED_SECRET  - any random string; the Shortcut sends this
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

const EXTRACTION_PROMPT = `You extract structured data from a short spoken log entry.
The person speaks casually and may cover restaurants, activities, workouts,
book/media notes, or general thoughts. Return ONLY valid JSON, no markdown
fences, no commentary, matching this shape:

{
  "category": "restaurant" | "activity" | "workout" | "media" | "note" | "other",
  "title": string,            // short name of the subject (e.g. venue, book title, activity)
  "rating": number | null,    // out of 10 if one was mentioned, else null
  "sentiment": "positive" | "negative" | "mixed" | "neutral",
  "tags": string[],           // short descriptive tags, lowercase, e.g. ["loud","pasta","date night"]
  "summary": string           // one clean sentence summarizing the entry
}

Transcript: `;

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

  // Ask Claude to structure the transcript
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
    structured = JSON.parse(raw);
  } catch (err) {
    console.error('Extraction failed:', err);
    // Fall back to an unstructured entry rather than losing the log
    structured = {
      category: 'other',
      title: null,
      rating: null,
      sentiment: 'neutral',
      tags: [],
      summary: transcript,
    };
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
