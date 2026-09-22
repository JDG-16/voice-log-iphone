# Voice Log — Setup

## 1. Firebase

Reuse your existing Firebase project or create a new one (console.firebase.google.com).

1. Firestore: create a database (native mode) if you don't already have one.
2. Project settings → Service accounts → "Generate new private key". This downloads a JSON file.
3. You'll paste the *entire contents* of that JSON file into a Netlify env var (as a single-line string) — see below.

## 2. Netlify site

1. Create a new site (or add this to an existing one) — drag-and-drop the folder or connect a git repo.
2. This repo's layout:
   - `netlify/functions/log-entry.js` — the function
   - `netlify.toml` — tells Netlify where functions live
   - `package.json` — dependencies (Netlify installs these automatically on deploy)
3. Site settings → Environment variables → add:
   - `ANTHROPIC_API_KEY` — your Claude API key from console.anthropic.com
   - `FIREBASE_SERVICE_ACCOUNT` — the full JSON from step 1.2, pasted as one line (most JSON viewers/editors have a "minify" option, or run it through `jq -c . serviceAccount.json` locally)
   - `SHORTCUT_SHARED_SECRET` — make up any random string (e.g. a UUID) — this is your private "password" so nobody else can POST to your endpoint
4. Deploy. Your function will be live at:
   `https://<your-site-name>.netlify.app/.netlify/functions/log-entry`

## 3. iOS Shortcut

Create a new Shortcut named **"Log this"** (the name is what triggers "Hey Siri, Log this"):

1. **Dictate Text** — language: your choice, "Stop Listening": "After Pause" works well for natural speech.
2. **Get Contents of URL**
   - URL: `https://<your-site-name>.netlify.app/.netlify/functions/log-entry`
   - Method: POST
   - Headers: add one — `x-shortcut-secret` → the same string you set as `SHORTCUT_SHARED_SECRET`
   - Request Body: JSON
     - Add field `transcript` → set its value to the "Dictated Text" variable from step 1
3. (Optional) **Show Notification** or **Speak Text** using the response, e.g. "Logged: [summary]" — the function returns JSON with a `summary` field you can pull out with "Get Dictionary Value".
4. Add to Siri, record the phrase "Log this" (or whatever you want to say after "Hey Siri").

Test it by running the Shortcut manually first — check Firestore's `logs` collection for the new document before relying on Siri.

## 4. Notes / next steps

- The function falls back to an unstructured entry (category "other", raw transcript as summary) if the Claude call or JSON parsing fails, so you never lose a log even if extraction has a bad day.
- Firestore documents land in a `logs` collection with fields: `transcript`, `category`, `title`, `rating`, `sentiment`, `tags`, `summary`, `createdAt`.
- The PWA side (browsing/filtering the logs) isn't built yet — that's a separate small app, same single-HTML-file + Firebase pattern as your other projects, whenever you're ready for it.
- Consider a Firestore security rule that only allows reads from an authenticated client (your PWA) and no direct writes from the client at all — since writes only ever come from the Netlify function using the admin SDK, you can lock the `logs` collection down to server-only writes.
