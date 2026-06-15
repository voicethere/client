# Browser client test harness

Manual test page for cloud mode using `@voicethere/client` in the browser.

## Prerequisites

1. Platform API running (local `npm run dev` in `platform/` or staging).
2. A **deployed** project with an active build.
3. A **client** API key (`vthc_…`) created for that project (dashboard → API keys).

## Run

From the `client/` repo root:

```bash
npm install
npm run demo:browser
```

Opens `http://127.0.0.1:5199` with:

- Platform API base URL (default empty — uses Vite proxy to `http://127.0.0.1:3000`)
- Client API key field
- Project ID field
- Connect / Disconnect buttons and an event log

## What it does

1. `POST /api/v1/sessions` with your client key
2. Connects signaling via `connectVoiceSession({ mode: "cloud", … })`
3. Logs `peer-joined`, offers, answers, and ICE events

This validates session mint + signaling join. Full WebRTC media requires a deployed agent runner answering in the room.

## CORS

Leave the API base URL **empty** when running locally — Vite proxies `/api/*` to the platform on port 3000 (no CORS setup needed).

For staging (`https://app.voicethere.dev`), enter the full base URL. The platform must allow browser CORS from your test origin, or use a local platform instance.
