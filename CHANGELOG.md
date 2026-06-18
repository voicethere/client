# Changelog

## [Unreleased]

## 0.5.1 — 2026-06-18

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
