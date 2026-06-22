# Changelog

## [Unreleased]

### Added

- **`onDebugEvent` ICE tracing** — `webrtc/ice_connection_state`, `webrtc/ice_gathering_state`, and `signaling/join_sent` for headless E2E connect diagnostics.

## 0.5.5 — 2026-06-20

### Fixed

- **`waitForConnected` after transport failure** — clear the internal connect promise when the peer connection enters `failed` or `closed` so same-session auto-reconnect and a subsequent `waitForConnected()` can succeed instead of hanging on a stale rejected promise.
- **`micPump: "external"` Node connect** — send a short PCM kick on mic attach (before answer handling) so headless load tests emit RTP during ICE like the default silent pump.

## 0.5.4 — 2026-06-19

### Added

- **`micPump`** on `connectBrowserVoiceSession` — `'silent'` (default) or `'external'` so headless load tests can pump scripted PCM via `writeSample` without racing the silent mic loop

## 0.5.3 — 2026-06-19

### Added

- **`reconnectPolicy`** on `connectBrowserSession` / `connectBrowserVoiceSession` — `same-session` (default) auto-retries signaling with the same credentials and `peerId`; `new-session` disables auto-retry
- **`onReconnecting(attempt)`** callback during same-session auto-retry (embed + dashboard status)
- **`maxAutoReconnectAttempts`** (default 4) with exponential backoff
- **`waitForConnected()`** on `connectBrowserSession` return value — await WebRTC `connected` before treating the session as ready
- **`reconnect()`** on browser voice sessions — manual same-session signaling re-join

### Changed

- Recoverable WebRTC disconnects (`WEBRTC_CONNECTION_FAILED`, `WEBRTC_CONNECTION_CLOSED`) emit `session_error` with `recoverable: true` and trigger same-session retry when policy allows

## 0.5.2 — 2026-06-19

### Added

- **`session-errors` module** — shared error codes, `SessionErrorEvent` type, `isSessionErrorEvent`, legacy `agent_error` mapping
- **`onSessionError`** on `startSession` and `connectBrowserSession` — provisioning failures, WebRTC errors, and runner `session_error` DC events
- **`customerContext`** on voice/browser sessions — forwarded in `session_hello` for agent `errorHook` context
- Exports from `@voicethere/client/browser`: `SESSION_ERROR_CODES`, `createLocalSessionError`, `emitSessionError`, related types

### Fixed

- **Node headless voice** — attach mic with `addTrack` **before** `setRemoteDescription` so the answer SDP includes `sendrecv` (required by `@node-webrtc-rust/sdk`; fixes runner mic-track timeout in staging E2E).
- **Mic RTP pump** — after `connected`, send kick + silent PCM frames via `writeSample` so the server receives `ontrack` and starts VoiceAgent.

## 0.5.0 — 2026-06-17

### Added

- `@voicethere/client/node` — headless E2E runtime (`createNodeWebRtcRuntime`) using `ws` + `@node-webrtc-rust/sdk`
- Injectable `WebRtcRuntime` on `connectBrowserVoiceSession` for Node test harnesses
- `waitForConnected`, `onControlMessage` on browser voice sessions

## 0.4.0 — 2026-06-16

### Added

- `BrowserVoiceSession.sendBinary` / `sendSyncBinary` — send `ArrayBuffer`/`Uint8Array` on control or sync data channels.
- `onBinaryMessage` callback for inbound binary frames.
- Export `VOICE_SYNC_CHANNEL_LABEL` (matches helpers / agent sync channel).

## 0.3.0 — 2026-06-15

### Added

- `@voicethere/client/browser` — voice + DC text chat, async session provisioning poll, debug console, mic visualizer
- `@voicethere/client/embed` — `createVoiceThereWidget` floating chat launcher
- `templates/` — React hook, embed HTML, debug page starters
- CI workflow and release tag publish (mirror `@voicethere/cli`)

## 0.1.0

- Initial `connectVoiceSession` cloud/local signaling helper
