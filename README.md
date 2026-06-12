# @voicethere/client

Browser and Node client for VoiceThere voice sessions.

## Modes

| Mode | When | Signaling URL |
|------|------|---------------|
| **local** | M1 dev — runner on localhost | `ws://127.0.0.1:8080/ws` |
| **cloud** | M4 — platform session mint | `wss://signaling…/ws?token=<joinToken>` |

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

## Cloud (platform + gateway)

```typescript
const res = await fetch("https://app.voicethere.dev/api/v1/sessions", {
  method: "POST",
  headers: {
    Authorization: "Bearer vt_…",
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

From workspace root (after M4 smoke infra is up):

```bash
cd client && npm run demo:cloud
```

npm publish deferred to human — see `development/webrtc-cloud/HUMAN-TASKS-M4.md`.
