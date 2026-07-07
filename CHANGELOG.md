# Changelog

## [Unreleased]

## 0.7.2 — 2026-07-07

### Fixed

- **Browser answer ICE gathering** — wait for local ICE gathering to complete before sending the SDP answer (matches agent offer and `@node-webrtc-rust/signaling` auto-negotiate), reducing first-connect `WEBRTC_CONNECTION_FAILED` when TURN relay candidates are required.

## 0.7.1 — 2026-07-07

### Added

- **WebRTC connection status tracking** — `onConnectionStatus` on `connectBrowserSession` / `connectBrowserVoiceSession` reports phases from signaling through media or data-channel readiness; `getConnectionStatus()` snapshots the current state.
- **Readiness-aware `waitForConnected()`** — voice sessions resolve when the peer connection is connected and inbound/outbound audio tracks are live; data sessions resolve when `voice-control` and `voicethere-sync` are open; `voice+data` requires both.
- **`MONTHLY_USAGE_EXCEEDED` failure code** — provisioning failures now surface monthly usage limit errors from the session API.

### Changed

- **Embed widget and React starter** — show WebRTC connection progress after provisioning (not only orchestrator job status).
- **Embed widget provisioning UI** — stable connecting label and spinner while queued/provisioning instead of rapidly updating status text.

### Fixed

- **Initial signaling join** — first connect uses a dedicated join path instead of the same-session reconnect flow, avoiding spurious peer-connection resets and reconnect debug noise.

## 0.7.0 — 2026-07-03

### Added

- **Typed session modes** — `ProvisionedRunnerModeType` / `BrowserSessionModeType` enums and matching type aliases for runner (`voice`, `data`, `voice+data`) vs browser (`voice`, `chat`, `voice+data`) session modes.
- **`mode` on session credentials** — provisioning responses now include the server-runner mode; defaults to `voice` when omitted.
- **`mode` on `connectBrowserSession`** — optional client mode with server mismatch guards; resolved `mode` is returned on `BrowserSession`.
- **Embed widget `mode` option** — `createVoiceThereWidget` accepts `mode` (defaults to `chat`).
- **Public exports** — session mode types exported from `@voicethere/client/browser`, `@voicethere/client/embed`, and `@voicethere/client/node`.

### Changed

- **`connectBrowserSession` mic request** — `requestMic` is derived from resolved mode (`voice` and `voice+data` request mic; data-only provisioning maps to `chat` without mic).

## 0.6.1 — 2026-06-28

### Fixed

- **Browser session wrapper callback forwarding** — `connectBrowserSession` now forwards `onAgentAudioTrack`, `onBinaryMessage`, and `onSyncBinaryMessage` to the voice session layer.

### Added

- **Split binary receive callbacks** — browser voice sessions now support a dedicated `onSyncBinaryMessage` callback for `voicethere-sync`, while `onBinaryMessage` handles `voice-control` binary frames.
- **Regression coverage** — added tests to lock callback forwarding and channel-specific binary routing.

## 0.6.0 — 2026-06-28

### Changed

- **Browser dependency boundary** — browser-facing client entrypoints no longer import or re-export `@node-webrtc-rust/sdk`, preventing accidental native bindings resolution in CDN/browser builds.
- **Local connection error surface** — moved shared connection error helpers into client-local sources so browser/session modules stay signaling-only.

### Added

- **Boundary regression tests** — added tests that fail if browser-facing sources reintroduce `@node-webrtc-rust/sdk` imports.

## 0.5.7 — 2026-06-28

### Added

- **Root connection error handler surface** — session and signaling transport errors now bubble to the process-wide root connection error handler so apps can centralize telemetry/logging without wiring `.on("error")` on every connection.

## 0.5.6 — 2026-06-23

### Added

- **`onDebugEvent` ICE tracing** — `webrtc/ice_connection_state`, `webrtc/ice_gathering_state`, and `signaling/join_sent` for headless E2E connect diagnostics.

### Changed

- **Dependencies** — `@node-webrtc-rust/signaling@0.6.2`; peer `@node-webrtc-rust/sdk` `>=0.6.2`.

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
