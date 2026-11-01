import type {
  AgentContentEvent,
  AgentInterruptedEvent,
  AgentStateEvent,
} from "./types.js";

const AGENT_STATES = new Set([
  "listening",
  "thinking",
  "tool_call",
  "speaking",
]);
const MAX_DETAIL_LENGTH = 64;
const MAX_URL_LENGTH = 2048;
const MAX_LABEL_LENGTH = 200;

/** Parse a voice-control `agent_state` payload; returns null for anything else. */
export function parseAgentStateEvent(
  payload: Record<string, unknown>,
): AgentStateEvent | null {
  if (payload.type !== "agent_state") return null;
  const state = payload.state;
  if (typeof state !== "string" || !AGENT_STATES.has(state)) return null;
  const event: AgentStateEvent = { state: state as AgentStateEvent["state"] };
  if (typeof payload.detail === "string") {
    event.detail = payload.detail.slice(0, MAX_DETAIL_LENGTH);
  }
  return event;
}

/** Parse a voice-control `agent_interrupted` payload; returns null for anything else. */
export function parseAgentInterruptedEvent(
  payload: Record<string, unknown>,
): AgentInterruptedEvent | null {
  if (payload.type !== "agent_interrupted") return null;
  const played = payload.replyPlayedMs;
  if (typeof played !== "number" || !Number.isFinite(played) || played < 0) {
    return null;
  }
  const event: AgentInterruptedEvent = {
    replyPlayedMs: Math.round(played),
    playedTextExact: payload.playedTextExact === true,
  };
  if (typeof payload.turnId === "string" && payload.turnId.length > 0) {
    event.turnId = payload.turnId;
  }
  return event;
}

/**
 * Parse an `assistant_content` payload; returns null for anything else.
 * Unknown `content.kind` values and links that are not https are ignored, so
 * newer agents can add kinds without breaking older clients.
 */
export function parseAgentContentEvent(
  payload: Record<string, unknown>,
): AgentContentEvent | null {
  if (payload.type !== "assistant_content") return null;
  if (typeof payload.turnId !== "string" || payload.turnId.length === 0) {
    return null;
  }
  const content = payload.content as Record<string, unknown> | null | undefined;
  if (!content || typeof content !== "object" || content.kind !== "link") {
    return null;
  }
  const url = content.url;
  if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const label =
    typeof content.label === "string"
      ? content.label.trim().slice(0, MAX_LABEL_LENGTH)
      : "";
  const event: AgentContentEvent = {
    turnId: payload.turnId,
    spoken: payload.spoken === true,
    content: { kind: "link", url, ...(label ? { label } : {}) },
  };
  if (typeof payload.inReplyTo === "string" && payload.inReplyTo.length > 0) {
    event.inReplyTo = payload.inReplyTo;
  }
  return event;
}
