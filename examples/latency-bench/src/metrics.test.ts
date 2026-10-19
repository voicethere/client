import { describe, expect, it } from "vitest";

import { computeTurnMetrics, parseSpeechEvent } from "./metrics.js";

const ev = (
  event: string,
  atMs: number,
  extra: { text?: string; payload?: Record<string, unknown> } = {},
) => ({ event, atMs, ...extra });

describe("computeTurnMetrics", () => {
  it("measures the four metrics from a scripted turn", () => {
    const metrics = computeTurnMetrics({
      speechEndAtMs: 1000,
      events: [
        ev("user_speaking_start", 200),
        ev("user_speech_final", 1400, { text: "one two three" }),
        ev("agent_speaking_start", 1900, { payload: { firstAudioMs: 310 } }),
        ev("agent_speaking_end", 4000),
      ],
    });
    expect(metrics).toEqual({
      speech_end_to_final_ms: 400,
      final_to_reply_start_ms: 500,
      speech_end_to_reply_start_ms: 900,
      tts_first_audio_ms: 310,
    });
  });

  it("reads first_audio_ms in snake case", () => {
    const metrics = computeTurnMetrics({
      speechEndAtMs: 0,
      events: [
        ev("user_speech_final", 10, { text: "x" }),
        ev("agent_speaking_start", 20, { payload: { first_audio_ms: 5 } }),
      ],
    });
    expect(metrics.tts_first_audio_ms).toBe(5);
  });

  it("returns null for every metric that needs a missing event", () => {
    expect(computeTurnMetrics({ speechEndAtMs: 1000, events: [] })).toEqual({
      speech_end_to_final_ms: null,
      final_to_reply_start_ms: null,
      speech_end_to_reply_start_ms: null,
      tts_first_audio_ms: null,
    });
    const noReply = computeTurnMetrics({
      speechEndAtMs: 1000,
      events: [ev("user_speech_final", 1300, { text: "one" })],
    });
    expect(noReply.speech_end_to_final_ms).toBe(300);
    expect(noReply.final_to_reply_start_ms).toBeNull();
    expect(noReply.speech_end_to_reply_start_ms).toBeNull();
    expect(noReply.tts_first_audio_ms).toBeNull();
  });

  it("ignores an empty final and a reply that started before the final", () => {
    const metrics = computeTurnMetrics({
      speechEndAtMs: 100,
      events: [
        ev("agent_speaking_start", 150),
        ev("user_speech_final", 200, { text: "  " }),
      ],
    });
    expect(metrics.speech_end_to_final_ms).toBeNull();
    expect(metrics.speech_end_to_reply_start_ms).toBeNull();
  });

  it("drops a negative or non-finite firstAudioMs", () => {
    const metrics = computeTurnMetrics({
      speechEndAtMs: 0,
      events: [
        ev("user_speech_final", 10, { text: "x" }),
        ev("agent_speaking_start", 20, { payload: { firstAudioMs: -1 } }),
      ],
    });
    expect(metrics.tts_first_audio_ms).toBeNull();
  });
});

describe("parseSpeechEvent", () => {
  it("keeps non-envelope fields as payload and ignores other messages", () => {
    const parsed = parseSpeechEvent(
      { type: "speech_event", event: "agent_speaking_start", firstAudioMs: 12 },
      5,
    );
    expect(parsed).toMatchObject({
      event: "agent_speaking_start",
      atMs: 5,
      payload: { firstAudioMs: 12 },
    });
    expect(parseSpeechEvent({ type: "agent_speak", text: "x" }, 5)).toBeNull();
  });
});
