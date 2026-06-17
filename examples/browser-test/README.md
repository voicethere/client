# Browser client test harness

Manual test page for cloud mode using `@voicethere/client` in the browser.

## Prerequisites

1. VoiceThere API running locally (`npm run dev` on port 3000) or use staging.
2. A **deployed** project with an active build.
3. A **client** API key (`vthc_…`) created for that project (dashboard → API keys).

## Run

From the `client/` repo root:

```bash
npm install
npm run demo:browser
```

Opens `http://127.0.0.1:5199` with:

- API base URL (default empty — uses Vite proxy to `http://127.0.0.1:3000`)
- Client API key field
- Project ID field
- Connect / Disconnect buttons and an event log

## What it does

1. `POST /api/v1/sessions` with your client key
2. Connects signaling via `connectVoiceSession({ mode: "cloud", … })`
3. Logs `peer-joined`, offers, answers, and ICE events

This validates session mint + signaling join. Full WebRTC media requires a deployed agent runner answering in the room.

## CORS

Dashboard chat and embed widgets call **session-service** (`https://sessions.voicethere.dev/v1`) from the browser with a `vthc_` client API key.

- Staging dashboard (`https://app.voicethere.dev`) is allowed by default.
- Local platform dev: use API base `http://127.0.0.1:3000` or proxy through Vite (leave API base empty in this harness).

Leave the API base URL **empty** when running this harness locally — Vite proxies `/api/*` to port 3000 (no CORS setup needed).
