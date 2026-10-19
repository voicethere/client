/**
 * Turn timing from the events a customer's client sees on the voice-control data channel.
 *
 * All timestamps are milliseconds on one monotonic client clock (`performance.now()`), taken
 * when the control message arrives, and `speechEndAtMs` is taken when the last frame of the
 * spoken clip was written to the mic track.
 */

export type SpeechEventRecord = {
  event: string;
  atMs: number;
  /** Present on `user_speech_final`. Only checked for being non-empty, never stored. */
  text?: string;
  /** Extra fields of the `speech_event` message (for example `firstAudioMs`). */
  payload?: Record<string, unknown>;
};

export type TurnMetricValues = {
  speech_end_to_final_ms: number | null;
  final_to_reply_start_ms: number | null;
  speech_end_to_reply_start_ms: number | null;
  tts_first_audio_ms: number | null;
};

const ENVELOPE_KEYS = new Set(["type", "event", "ts", "text", "language"]);

/**
 * Turns a voice-control JSON message into an event record, or null when it is not a
 * `speech_event`. Fields other than the envelope go to `payload`.
 */
export function parseSpeechEvent(
  message: Record<string, unknown>,
  atMs: number,
): SpeechEventRecord | null {
  if (message.type !== "speech_event") return null;
  const event = String(message.event ?? "");
  if (!event) return null;
  const payloadEntries = Object.entries(message).filter(
    ([key]) => !ENVELOPE_KEYS.has(key),
  );
  return {
    event,
    atMs,
    text: typeof message.text === "string" ? message.text : undefined,
    payload:
      payloadEntries.length > 0
        ? Object.fromEntries(payloadEntries)
        : undefined,
  };
}

function timingFromPayload(
  payload: Record<string, unknown> | undefined,
  camelKey: string,
  snakeKey: string,
): number | null {
  for (const key of [camelKey, snakeKey]) {
    const value = payload?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function isNonEmptyFinal(event: SpeechEventRecord): boolean {
  return (
    event.event === "user_speech_final" && (event.text?.trim().length ?? 0) > 0
  );
}

/**
 * The four metrics of one turn. Any metric whose start or end event is missing is null.
 *
 * - `final`: the last non-empty `user_speech_final` seen in the turn.
 * - `reply start`: the first `agent_speaking_start` after that final.
 * - `tts_first_audio_ms`: `firstAudioMs` carried by that `agent_speaking_start`.
 *
 * Pass only the events recorded since the clip started playing, so leftovers from the
 * previous turn cannot be picked up.
 */
export function computeTurnMetrics(input: {
  speechEndAtMs: number | null;
  events: SpeechEventRecord[];
}): TurnMetricValues {
  const { speechEndAtMs, events } = input;
  const final = events.filter(isNonEmptyFinal).at(-1);
  const replyStart = final
    ? events.find(
        (e) =>
          e.event === "agent_speaking_start" &&
          events.indexOf(e) > events.indexOf(final),
      )
    : undefined;

  const diff = (end: number | undefined, start: number | null | undefined) =>
    end != null && start != null ? end - start : null;

  return {
    speech_end_to_final_ms: diff(final?.atMs, speechEndAtMs),
    final_to_reply_start_ms: diff(replyStart?.atMs, final?.atMs),
    speech_end_to_reply_start_ms: diff(replyStart?.atMs, speechEndAtMs),
    tts_first_audio_ms: timingFromPayload(
      replyStart?.payload,
      "firstAudioMs",
      "first_audio_ms",
    ),
  };
}
