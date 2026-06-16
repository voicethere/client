# @voicethere/client

Browser and Node client for VoiceThere voice sessions.

## Modes

| Mode | When | Signaling URL |
|------|------|---------------|
| **local** | Local dev — agent runner on localhost | `ws://127.0.0.1:8080/ws` |
| **cloud** | Hosted VoiceThere sessions | `wss://signaling…/ws?token=<joinToken>` |

Wire protocol: [`@node-webrtc-rust/signaling`](https://www.npmjs.com/package/@node-webrtc-rust/signaling).

## Local (runner direct)

```typescript
import { connectVoiceSession } from "@voicethere/client";

const client = await connectVoiceSession({
  mode: "local",
  signalingUrl: "ws://127.0.0.1:8080/ws",
  sessionId: "local-dev",
});

client.on("peer-joined", (peerId) => console.log("peer", peerId));
```

## Cloud (hosted VoiceThere)

```typescript
// Use a **client** API key (prefix vthc_) — safe to embed in web/mobile apps.
// Create one in the dashboard (/api-keys) or: voicethere api-keys create --kind client --project-id <uuid> --name "Web app"
const res = await fetch("https://sessions.voicethere.dev/v1/sessions", {
  method: "POST",
  headers: {
    Authorization: "Bearer vthc_…",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ project_id: "<uuid>" }),
});

const credentials = await res.json();

const client = await connectVoiceSession({
  mode: "cloud",
  credentials: {
    sessionId: credentials.session_id,
    joinToken: credentials.join_token,
    signalingUrl: credentials.signaling_url,
    roomId: credentials.room_id,
    iceServers: credentials.ice_servers,
  },
});
```

## Local stack verify

With the VoiceThere API and session stack running locally:

```bash
cd client && npm run demo:cloud
```

npm publish via GitHub Actions on `release/*` tags — see [`scripts/RELEASE.md`](scripts/RELEASE.md).

## Browser test page

For manual cloud testing with a client API key in the browser:

```bash
npm run demo:browser
```

See [`examples/browser-test/README.md`](examples/browser-test/README.md).
