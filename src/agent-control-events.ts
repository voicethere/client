import type { AgentInterruptedEvent, AgentStateEvent } from "./types.js";

const AGENT_STATES = new Set([
  "listening",
  "thinking",
  "tool_call",
  "speaking",
]);
const MAX_DETAIL_LENGTH = 64;

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
