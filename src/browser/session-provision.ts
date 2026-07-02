import type { DebugConsole } from "./debug-console.js";
import {
  ProvisionedRunnerModeType,
  type ProvisionedRunnerMode,
} from "./session-modes.js";
import {
  createLocalSessionError,
  emitSessionError,
  mapProvisioningFailureCode,
} from "../session-errors.js";

export type SessionFailureCode =
  | "NOT_DEPLOYED"
  | "RUNNER_UNAVAILABLE"
  | "CAPACITY_EXCEEDED"
  | "CAPACITY_WAIT_EXPIRED"
  | "ORCHESTRATOR_ERROR"
  | "JOIN_TOKEN_ERROR"
  | "TIMEOUT";

export type SessionJobStatus =
  | "queued"
  | "waiting"
  | "provisioning"
  | "ready"
  | "failed";

export type SessionCredentials = {
  session_id: string;
  mode: ProvisionedRunnerMode;
  join_token: string;
  signaling_url: string;
  room_id: string;
  ice_servers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  expires_at: string;
};

export type SessionStatusResponse = {
  session_id: string;
  status: SessionJobStatus;
  project_id: string;
  build_id: string | null;
  failure_code?: SessionFailureCode | null;
  failure_message?: string | null;
  queue_position?: number | null;
  /** ISO timestamp when the job entered the capacity wait queue. */
  waiting_since?: string | null;
  /** Sliding deadline — extended on each poll while `waiting`. */
  waiting_expires_at?: string | null;
  /** Last GET /sessions/:id poll while waiting (keepalive). */
  queue_last_seen_at?: string | null;
  /** Rough ETA in seconds based on queue position. */
  estimated_wait_seconds?: number | null;
  credentials?: SessionCredentials | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

export type StartSessionOptions = {
  apiBase: string;
  projectId: string;
  buildId?: string;
  async?: boolean;
  /**
   * When true (default), poll GET /v1/sessions/:id while waiting — each poll
   * keeps your queue place (sliding TTL, default 120 minutes without polls).
   */
  waitForCapacity?: boolean;
  headers?: Record<string, string>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  onStatus?: (status: SessionStatusResponse) => void;
  /** Called when status is `waiting` and queue_position is present. */
  onQueuePosition?: (position: number, status: SessionStatusResponse) => void;
  onSessionError?: import("../session-errors.js").SessionErrorHandler;
  debug?: DebugConsole;
};

export type StartSessionResult =
  | { ok: true; credentials: SessionCredentials; jobId: string }
  | {
      ok: false;
      code: SessionFailureCode | "TIMEOUT" | "HTTP_ERROR";
      message: string;
    };

export function isTerminalSessionJobStatus(status: SessionJobStatus): boolean {
  return status === "ready" || status === "failed";
}

export function isCapacityWaitStatus(status: SessionStatusResponse): boolean {
  return status.status === "waiting";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollSessionStatus(input: {
  apiBase: string;
  jobId: string;
  headers: Record<string, string>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  onStatus?: (status: SessionStatusResponse) => void;
  onQueuePosition?: (position: number, status: SessionStatusResponse) => void;
  onSessionError?: import("../session-errors.js").SessionErrorHandler;
  debug?: DebugConsole;
}): Promise<StartSessionResult> {
  const started = Date.now();
  const url = `${input.apiBase.replace(/\/$/, "")}/sessions/${input.jobId}`;

  while (Date.now() - started < input.pollTimeoutMs) {
    const res = await fetch(url, { headers: input.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const message = `GET session status failed (${res.status}): ${body}`;
      emitSessionError(
        input.onSessionError,
        createLocalSessionError({
          code: "PROVISIONING_FAILED",
          message,
          sessionId: input.jobId,
        }),
      );
      return {
        ok: false,
        code: "HTTP_ERROR",
        message,
      };
    }

    const status = (await res.json()) as SessionStatusResponse;
    input.onStatus?.(status);
    if (
      status.status === "waiting" &&
      status.queue_position != null &&
      status.queue_position > 0
    ) {
      input.onQueuePosition?.(status.queue_position, status);
    }
    input.debug?.info(
      "provision",
      status.status,
      status.failure_message ?? undefined,
      status,
    );

    if (status.status === "ready" && status.credentials) {
      return {
        ok: true,
        credentials: {
          ...status.credentials,
          mode: status.credentials.mode ?? ProvisionedRunnerModeType.Voice,
        },
        jobId: input.jobId,
      };
    }

    if (status.status === "failed") {
      const code = mapProvisioningFailureCode(
        status.failure_code ?? "ORCHESTRATOR_ERROR",
      );
      emitSessionError(
        input.onSessionError,
        createLocalSessionError({
          code,
          message: status.failure_message ?? "Session provisioning failed",
          sessionId: input.jobId,
          projectId: status.project_id,
          buildId: status.build_id ?? undefined,
        }),
      );
      return {
        ok: false,
        code: status.failure_code ?? "ORCHESTRATOR_ERROR",
        message: status.failure_message ?? "Session provisioning failed",
      };
    }

    await sleep(input.pollIntervalMs);
  }

  emitSessionError(
    input.onSessionError,
    createLocalSessionError({
      code: "PROVISIONING_TIMEOUT",
      message: "Session provisioning timed out",
      sessionId: input.jobId,
    }),
  );
  return {
    ok: false,
    code: "TIMEOUT",
    message: "Session provisioning timed out",
  };
}

function emitProvisionError(
  options: StartSessionOptions,
  input: {
    code: string;
    message: string;
    sessionId?: string;
  },
): void {
  emitSessionError(
    options.onSessionError,
    createLocalSessionError({
      code: mapProvisioningFailureCode(input.code),
      message: input.message,
      sessionId: input.sessionId ?? options.projectId,
      projectId: options.projectId,
      buildId: options.buildId,
    }),
  );
}

/**
 * POST /v1/sessions with async=true and poll GET until ready or failed.
 * `apiBase` should point at the session-service root, e.g. https://sessions.voicethere.dev/v1
 */
export async function startSession(
  options: StartSessionOptions,
): Promise<StartSessionResult> {
  const apiBase = options.apiBase.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  const body = {
    project_id: options.projectId,
    build_id: options.buildId,
    async: options.async ?? true,
    wait_for_capacity: options.waitForCapacity ?? true,
  };

  options.debug?.info("provision", "post_sessions", JSON.stringify(body));

  const res = await fetch(`${apiBase}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 200) {
    const sync = (await res.json()) as SessionCredentials & {
      project_id?: string;
      build_id?: string;
    };
    return {
      ok: true,
      credentials: {
        session_id: sync.session_id,
        mode: sync.mode ?? ProvisionedRunnerModeType.Voice,
        join_token: sync.join_token,
        signaling_url: sync.signaling_url,
        room_id: sync.room_id,
        ice_servers: sync.ice_servers,
        expires_at: sync.expires_at,
      },
      jobId: sync.session_id,
    };
  }

  if (res.status === 429) {
    const text = await res.text().catch(() => "");
    const message = `POST /sessions capacity exceeded (${res.status}): ${text}`;
    emitProvisionError(options, {
      code: "CAPACITY_EXCEEDED",
      message,
    });
    return {
      ok: false,
      code: "CAPACITY_EXCEEDED",
      message,
    };
  }

  if (res.status !== 202) {
    const text = await res.text().catch(() => "");
    const message = `POST /sessions failed (${res.status}): ${text}`;
    emitProvisionError(options, { code: "HTTP_ERROR", message });
    return {
      ok: false,
      code: "HTTP_ERROR",
      message,
    };
  }

  const accepted = (await res.json()) as { session_id: string };
  return pollSessionStatus({
    apiBase,
    jobId: accepted.session_id,
    headers,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    pollTimeoutMs: options.pollTimeoutMs ?? 120_000,
    onStatus: options.onStatus,
    onQueuePosition: options.onQueuePosition,
    onSessionError: options.onSessionError,
    debug: options.debug,
  });
}
