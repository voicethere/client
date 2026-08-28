# Changelog

## [Unreleased]

### Added

- **Inbound audio playback helpers** — `audio-playback.ts` exports `AudioPlaybackState`, `unlockAudioPlayback()`, and `createHiddenAudioElement()`. Voice sessions auto-create a hidden `<audio>` element when none is supplied; `getAudioPlaybackState()` and `unlockAudioPlayback()` expose autoplay-blocked state.
- **Embed widget mic notice** — After voice connect with denied/unavailable/synthetic microphone, the embed shows an amber notice and **Request microphone** button. **Tap to enable sound** appears when inbound playback is blocked.

### Fixed

- **Embed inbound agent audio** — The embed widget now passes a hidden `<audio>` element and unlocks playback on Connect click so agent TTS can play without a live microphone.

### Changed

- **Reconnect callbacks** — `onIceRecovery`, `onReconnecting`, and `onReconnected` accept an optional 2nd arg `VoiceSessionReconnectInfo` (`reason`, effective `iceTransportPolicy`) for E2E/load-test diagnostics.

## 0.7.28 — 2026-08-15

### Fixed

- Node runtime (`createNodeWebRtcRuntime`) waits for ICE gathering (`gatheringComplete` when available) before sending the SDP answer so relay candidates are in the answer. Browser default remains trickle-immediate.

## 0.7.27 — 2026-08-12

### Added

- **Mic-optional voice connect** — `connectBrowserVoiceSession` / `connectBrowserSession` no longer fail when `getUserMedia` is denied or unavailable; a silent synthetic outbound audio track keeps WebRTC negotiation alive (`mic_synthetic_fallback` / `mic_denied` / `mic_granted` debug events).
- **Microphone device APIs** on `BrowserVoiceSession`: `listAudioInputDevices()`, `getAudioInputDeviceId()`, `getAudioInputState()`, `setAudioInputDevice(deviceId)`, `requestAudioInputAccess()` — mid-session switching via `RTCRtpSender.replaceTrack`.
- **`audioInputDeviceId`** option on connect (`deviceId: { ideal }` for initial GUM).
- **`client/src/browser/microphone.ts`** helpers exported from `@voicethere/client/browser`.

## 0.7.26 — 2026-08-05

### Added

- **ICE recovery (relay-leaning)** — before same-session auto-reconnect budget: on PeerConnection fail (or stuck ICE checking ≥12s with `nominated=0`), rebuild via signaling with `iceTransportPolicy=relay`. Uses `onIceRecovery` / `maxIceRecoveryAttempts` (default **1**) and does **not** increment `autoReconnectAttempts` or call `onReconnecting`. Set `maxIceRecoveryAttempts=0` for legacy behavior; `iceRecoveryStuckCheckingMs=0` disables proactive stuck-checking.
- **`webrtc ice_triage`** — compact diagnostics line (selected/nominated/succeeded/failed + host/srflx/relay counts) in `formatWebRtcDiagnosticsLines` / `formatIceTriageLine`.

## 0.7.25 — 2026-08-03

### Fixed

- **`session_reconnect_token`** — after updating join credentials, forward the control message to `onControlMessage` so E2E waiters and app hooks observe the token (previously returned early after internal update only).

## 0.7.24 — 2026-08-03

### Added

- **`onReconnected`** — callback after same-session reconnect reaches ready again (not on first connect). Enables load/e2e mid-turn phrase resend without treating reconnect as a fresh session.

## 0.7.23 — 2026-08-03

### Added

- **`session_reconnect_token`** — voice-control handler updates in-memory join credentials when the runner mints an opaque reconnect token; same-session `reconnect()` and auto-reconnect open signaling with the latest token.
- **`forceCloseSignalingForTests()`** — test/E2E hook on `BrowserVoiceSession` to force-close the signaling WebSocket and trigger `signaling_closed` auto-reconnect.

## 0.7.22 — 2026-07-31

### Fixed

- **POST `/sessions` 429 mapping** — monthly usage gate responses (`NWRTC_MONTHLY_USAGE_EXCEEDED`) now surface `MONTHLY_USAGE_EXCEEDED` instead of always `CAPACITY_EXCEEDED`.

## 0.7.21 — 2026-07-31

### Fixed

- **`getConnectionState()` after idle kick** — inbound `session_close` now sets internal `connectionState` to `closed` (matching connection status), so callers polling `getConnectionState()` observe the disconnect.

## 0.7.20 — 2026-07-31

### Changed

- **Deps** — `@node-webrtc-rust/{sdk,signaling}` **0.7.0** (Opus SDP omits `maxaveragebitrate` unless env set; encode default 400 kbps).

## 0.7.19 — 2026-07-30

### Fixed

- **Inbound `session_close`** — idle kick and other server-initiated closes now emit a non-recoverable `session_error` (`SESSION_IDLE_TIMEOUT` or `WEBRTC_CONNECTION_CLOSED`) and stop auto-reconnect so dashboard chat does not stay "Connected".
- **`auto_reconnect_exhausted`** — emits `WEBRTC_RECONNECT_EXHAUSTED`, marks the session terminal, and publishes a closed/not-ready connection snapshot.

## 0.7.18 — 2026-07-30

### Fixed

- **Browser ICE:** send the SDP answer immediately after `setLocalDescription` and trickle candidates via `onicecandidate`, instead of waiting for `iceGatheringState === "complete"`. Waiting for gather-complete delayed CreatePermission on the runner and caused Chromium sessions (especially TURN relay) to fail with `WEBRTC_CONNECTION_FAILED` while Node clients succeeded.
- **`waitForConnected`:** fail fast when `connectionState` / `iceConnectionState` enter `failed` or `disconnected`, instead of waiting for the full timeout (dashboard half-open recovery).

## 0.7.17 — 2026-07-28

### Changed

- Treat control-channel JSON `position` as high-frequency: log at debug (with `keepalive` / `state` / `tick`) so load/redis-sync smokes stay quiet unless `LOAD_TEST_CLIENT_DEBUG=1`.

## 0.7.16 — 2026-07-28

### Changed

- Stop logging `dc/control_not_open` / `dc/sync_not_open` on every failed send while channels are connecting. Open/close transitions remain single `dc/open` / `dc/close` events (avoids spam from readiness polls).

## 0.7.15 — 2026-07-28

### Added

- **`StartSessionOptions.signal`** — optional `AbortSignal` cancels `POST /sessions` and status-poll fetches/retry sleeps via `fetchSessionApi` / `pollSessionStatus`.
- **`CLIENT_CAPABILITIES.startSessionAbortSignal`** — explicit capability flag so load/soak harnesses can fail closed when the installed package cannot cancel in-flight provisioning.

### Notes

- Consumers that require abortable `startSession` (canonical voice soak) must install this release (or newer). Older published `0.7.14` builds do not advertise the capability.

## 0.7.14 — 2026-07-27

### Added

- **`disconnectAsync()`** — awaitable terminal cleanup barrier; awaits Node runtime `closeAsync()` when present. Close failure is diagnostic-only and never aborts cleanup. Emits `peer_close` (redacted).
- **`CLIENT_CAPABILITIES.iceTransportPolicy`** — explicit package capability export for e2e fail-closed checks (`/browser` and `/node` entry points).
- **`iceTransportPolicy`** option — `"all" | "relay"` pass-through to `RTCConfiguration` for forced-relay TURN smokes.

### Changed

- **`disconnect()` remains synchronous** — terminal invalidation (timers, WebSocket, peer/channels, mic) using standard sync `pc.close()`. Prefer `disconnectAsync()` when callers need to await native cleanup.
- **Removed startup ICE PC reconstruction** — race-prone automatic peer rebuild on failed/disconnected startup was dropped. Existing same-session signaling reconnect is unchanged.
- Diagnostic redaction covers `http(s)`, `ws(s)`, `turn(s)`, `stun` URIs, join tokens, JSON credentials, and SDP `ice-pwd`; async diagnostic handler rejections are isolated.

## 0.7.13 — 2026-07-26

### Added

- **ICE candidate-pair diagnostics** — `getWebRtcDiagnostics()` / `summarizeRtcStatsReport` now resolve local/remote candidate types for every retained pair (order-independent), including failed non-selected pairs. Aggregate counts add `prflx` / unknown local candidates and total local candidate reports. Formatted lines stay redacted (no addresses, ports, URLs, or credentials).

## 0.7.12 — 2026-07-24

### Added

- **`fetchSessionApi`** — retries session-service `POST`/`GET` on Envoy-style 502–504 / `upstream connect error` / connection termination (and network `fetch failed`), with short backoff. Wired into `startSession` and status polling so rolling deploys do not fail one-shot polls.

## 0.7.11 — 2026-07-23

### Changed

- **Adaptive session provisioning polling** — replace fixed 1s status polls with backoff + jitter, and honor Session API `retry_after_ms` hints to cut control-plane load during wait queues.

## 0.7.10 — 2026-07-21

### Fixed

- **Same-session reconnect after `WEBRTC_SDP_NEGOTIATION_FAILED`** — malformed/empty remote offers (missing `a=ice-ufrag`) now trigger signaling reconnect under the default `same-session` policy so `waitForConnected()` can recover instead of hanging until timeout (scale-up burst flake class).

## 0.7.9 — 2026-07-17

### Added

- **`WEBRTC_SDP_NEGOTIATION_FAILED`** — local `session_error` when the inbound server offer handler fails (step name + underlying error in the message).
- **Offer handler step logs** — `offer_step` / `offer_handler_failed` debug events for `set_remote_description`, `create_answer`, ICE gathering, and `answer_sent` triage.

### Fixed

- **`waitForConnected()` after early offer failure** — preserve non-retriable SDP handler errors via `pendingConnectFailure` so callers fail fast instead of waiting for the connect timeout.

## 0.7.8 — 2026-07-17

### Fixed

- **Terminal `session_error` vs transport failure** — when the server sends `session_error` with `recoverable: false` (e.g. `AGENT_HANDLER_FAILED`), mark the session as gracefully disconnected so auto-reconnect does not overwrite the error with `WEBRTC_CONNECTION_FAILED`.

## 0.7.7 — 2026-07-15

### Changed

- **Data-channel debug noise** — `keepalive`, `state`, and `tick` payloads log at `debug` instead of `info` (inbound and `sendToAgent` outbound). Staging E2E omits them unless `LOAD_TEST_CLIENT_DEBUG=1`.

## 0.7.6 — 2026-07-15

### Added

- **Same-session ICE/WebRTC auto-reconnect** — transient `failed` or unexpected `closed` peer connections schedule an exponential-backoff reconnect (default up to 4 attempts) without re-provisioning.
- **`WebRtcConnectRetryError`** — internal retriable signal so `waitForConnected()` keeps waiting across reconnect attempts until `timeoutMs` or `maxAutoReconnectAttempts` is exhausted.

### Fixed

- **`waitForConnected()` during reconnect** — preserve the connect wait promise across signaling rejoin and ignore intentional peer-connection teardown when applying a replacement server offer.

## 0.7.5 — 2026-07-13

### Changed

- **`waitForConnected()` timeout** — error message includes connection phase, peer connection state, and data-channel flags for E2E/Loki triage without extra debug tooling.

## 0.7.4 — 2026-07-10

### Added

- **`getWebRtcDiagnostics()`** on `BrowserVoiceSession` — ICE transport state plus `getStats()` candidate-pair / relay summary for connect failure triage in staging E2E.

## 0.7.3 — 2026-07-07

### Fixed

- **`waitForIceGatheringComplete` on Node** — fall back to `onicegatheringstatechange` when `RTCPeerConnection.addEventListener` is unavailable (`@node-webrtc-rust/sdk`), fixing headless E2E load tests that use `@voicethere/client/node`.

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
