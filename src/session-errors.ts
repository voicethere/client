/**
 * Session error event catalog — shared contract for browser/Node clients.
 *
 * Remote codes arrive on voice-control as `{ type: "session_error", ... }`.
 * Local codes are emitted by the client for provisioning/WebRTC failures.
 */

import {
  createConnectionError,
  reportConnectionError,
} from "./connection-errors.js";

export const REMOTE_SESSION_ERROR_CODES = [
  "AGENT_HANDLER_FAILED",
  "AGENT_CHILD_CRASHED",
  "RUNNER_INTERNAL",
  "SESSION_END_FAILED",
  "IDLE_TIMEOUT_CALLBACK_FAILED",
  "IDLE_TIMEOUT_CALLBACK_TIMED_OUT",
  "SESSION_IDLE_TIMEOUT",
] as const;

export const LOCAL_SESSION_ERROR_CODES = [
  "PROVISIONING_FAILED",
  "PROVISIONING_TIMEOUT",
  "WEBRTC_CONNECTION_FAILED",
  "WEBRTC_CONNECTION_CLOSED",
  "WEBRTC_CONNECT_TIMEOUT",
  "WEBRTC_SDP_NEGOTIATION_FAILED",
] as const;

export const SESSION_ERROR_CODES = [
  ...REMOTE_SESSION_ERROR_CODES,
  ...LOCAL_SESSION_ERROR_CODES,
] as const;

export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number];

export type SessionErrorEvent = {
  type: "session_error";
  code: SessionErrorCode;
  message: string;
  session_id: string;
  project_id?: string;
  build_id?: string;
  stack?: string;
  recoverable?: boolean;
  customer_context?: Record<string, unknown>;
  occurred_at?: string;
};

export function isSessionErrorEvent(
  value: unknown,
): value is SessionErrorEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SessionErrorEvent>;
  return (
    record.type === "session_error" &&
    typeof record.code === "string" &&
    typeof record.message === "string" &&
    typeof record.session_id === "string"
  );
}

/** Parse legacy `{ type: "agent_error", message }` into session_error shape. */
export function parseLegacyAgentError(
  payload: Record<string, unknown>,
  sessionId: string,
): SessionErrorEvent | null {
  if (payload.type !== "agent_error") return null;
  const message =
    typeof payload.message === "string"
      ? payload.message
      : "The agent encountered an error.";
  return {
    type: "session_error",
    code: "AGENT_CHILD_CRASHED",
    message,
    session_id: sessionId,
    recoverable: false,
    occurred_at: new Date().toISOString(),
  };
}

export function createLocalSessionError(input: {
  code: (typeof LOCAL_SESSION_ERROR_CODES)[number];
  message: string;
  sessionId: string;
  projectId?: string;
  buildId?: string;
  recoverable?: boolean;
}): SessionErrorEvent {
  return {
    type: "session_error",
    code: input.code,
    message: input.message,
    session_id: input.sessionId,
    ...(input.projectId ? { project_id: input.projectId } : {}),
    ...(input.buildId ? { build_id: input.buildId } : {}),
    ...(input.recoverable != null ? { recoverable: input.recoverable } : {}),
    occurred_at: new Date().toISOString(),
  };
}

export function mapProvisioningFailureCode(
  code: string,
): (typeof LOCAL_SESSION_ERROR_CODES)[number] {
  return code === "TIMEOUT" ? "PROVISIONING_TIMEOUT" : "PROVISIONING_FAILED";
}

export type SessionErrorHandler = (event: SessionErrorEvent) => void;

export function emitSessionError(
  handler: SessionErrorHandler | undefined,
  event: SessionErrorEvent,
): void {
  reportConnectionError(
    createConnectionError(event.message, {
      subsystem: "session",
      sessionId: event.session_id,
      code: event.code,
      ...(event.project_id ? { projectId: event.project_id } : {}),
      ...(event.build_id ? { buildId: event.build_id } : {}),
    }),
  );
  handler?.(event);
}
