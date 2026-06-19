# @voicethere/client

Browser and Node client for VoiceThere voice sessions.

## Modes

| Mode      | When                                  | Signaling URL                           |
| --------- | ------------------------------------- | --------------------------------------- |
| **local** | Local dev — agent runner on localhost | `ws://127.0.0.1:8080/ws`                |
| **cloud** | Hosted VoiceThere sessions            | `wss://signaling…/ws?token=<joinToken>` |

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

## Ending a session

| Action                | API                                | Server `end_reason`   |
| --------------------- | ---------------------------------- | --------------------- |
| Local teardown        | `session.disconnect()`             | `client_disconnected` |
| Graceful close signal | `session.sendCloseSignal(reason?)` | `client_close_signal` |
| Server idle timeout   | _(automatic)_                      | `idle_timeout`        |

In `@voicethere/agent`, call `disconnectClient(sessionId, { reason })` to kick a peer from agent code (e.g. stale multiplayer state).

Configure idle timeouts per project in the dashboard **Session settings** panel or `voicethere projects session-settings set`.

## Session error events

Pass `onSessionError` to `startSession` and `connectBrowserSession` for a unified handler across provisioning failures, WebRTC errors, and runner `session_error` data-channel events:

```typescript
import { startSession, connectBrowserSession } from "@voicethere/client/browser";

const provision = await startSession({
  apiBase: "https://sessions.example/v1",
  projectId,
  headers: { Authorization: `Bearer ${apiKey}` },
  onSessionError: (event) => console.error(event.code, event.message),
});

if (provision.ok) {
  await connectBrowserSession({
    mode: "voice",
    credentials: provision.credentials,
    customerContext: { userId: "u_123" },
    onSessionError: (event) => console.error(event.code, event.message),
  });
}
```

Legacy `{ type: "agent_error" }` payloads are mapped to `AGENT_CHILD_CRASHED`. See platform docs for the full error code catalog.
