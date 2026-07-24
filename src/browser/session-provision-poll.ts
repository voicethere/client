import type { DebugConsole } from "./debug-console.js";
import { fetchSessionApi } from "./session-api-retry.js";
import { ProvisionedRunnerModeType } from "./session-modes.js";
import {
  createLocalSessionError,
  emitSessionError,
  mapProvisioningFailureCode,
} from "../session-errors.js";
import type {
  SessionStatusResponse,
  StartSessionResult,
} from "./session-provision.js";

/** Multipliers applied to {@link StartSessionOptions.pollIntervalMs} between polls without progress. */
export const SESSION_POLL_BACKOFF_MULTIPLIERS = [1, 2, 3, 5] as const;

/** Upper bound for adaptive poll spacing (ms). */
export const SESSION_POLL_INTERVAL_CAP_MS = 5_000;

/** Clamp bounds for optional server `retry_after_ms` hints. */
export const SESSION_POLL_RETRY_AFTER_MIN_MS = 250;
export const SESSION_POLL_RETRY_AFTER_MAX_MS = 5_000;

export type SessionPollProgressSnapshot = {
  status: string;
  queuePosition?: number | null;
};

export type SessionPollRuntime = {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const defaultSessionPollRuntime: SessionPollRuntime = {
  sleep: defaultSleep,
  now: () => Date.now(),
  random: () => Math.random(),
};

export function clampSessionPollRetryAfterMs(
  retryAfterMs: number,
  bounds: { minMs?: number; maxMs?: number } = {},
): number {
  const minMs = bounds.minMs ?? SESSION_POLL_RETRY_AFTER_MIN_MS;
  const maxMs = bounds.maxMs ?? SESSION_POLL_RETRY_AFTER_MAX_MS;
  if (!Number.isFinite(retryAfterMs)) {
    return minMs;
  }
  return Math.min(maxMs, Math.max(minMs, Math.round(retryAfterMs)));
}

/**
 * Returns true when adaptive backoff should reset to the base interval — status
 * changed or a capacity-wait queue position moved.
 */
export function shouldResetSessionPollBackoff(
  previous: SessionPollProgressSnapshot | null,
  current: SessionPollProgressSnapshot,
): boolean {
  if (!previous) {
    return false;
  }
  if (previous.status !== current.status) {
    return true;
  }
  if (
    current.status === "waiting" &&
    current.queuePosition != null &&
    previous.queuePosition !== current.queuePosition
  ) {
    return true;
  }
  return false;
}

/**
 * Computes the delay before the next GET /sessions/:id poll.
 * `attemptIndex` is the number of consecutive waits without progress (0 = first wait).
 */
export function computeSessionPollDelayMs(input: {
  baseIntervalMs: number;
  attemptIndex: number;
  retryAfterMs?: number | null;
  /** When false, omit jitter (deterministic tests). Default true. */
  jitter?: boolean;
  /** Returns [0, 1). Used for jitter when `jitter` is true. */
  random?: () => number;
}): number {
  const baseMs = Math.max(1, Math.round(input.baseIntervalMs));
  const capMs = Math.min(
    SESSION_POLL_INTERVAL_CAP_MS,
    baseMs * SESSION_POLL_BACKOFF_MULTIPLIERS.at(-1)!,
  );

  let delayMs: number;
  if (
    input.retryAfterMs != null &&
    Number.isFinite(input.retryAfterMs) &&
    input.retryAfterMs > 0
  ) {
    delayMs = clampSessionPollRetryAfterMs(input.retryAfterMs);
  } else {
    const multiplierIndex = Math.min(
      Math.max(0, input.attemptIndex),
      SESSION_POLL_BACKOFF_MULTIPLIERS.length - 1,
    );
    const multiplier = SESSION_POLL_BACKOFF_MULTIPLIERS[multiplierIndex]!;
    delayMs = Math.min(baseMs * multiplier, capMs);
  }

  if (input.jitter !== false) {
    const random = input.random ?? Math.random;
    // ±10% jitter to avoid synchronized client polls.
    delayMs = Math.round(delayMs * (0.9 + random() * 0.2));
  }

  return Math.max(1, delayMs);
}

function toPollProgressSnapshot(
  status: SessionStatusResponse,
): SessionPollProgressSnapshot {
  return {
    status: status.status,
    queuePosition: status.queue_position,
  };
}

export async function pollSessionStatus(input: {
  apiBase: string;
  jobId: string;
  headers: Record<string, string>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  onStatus?: (status: SessionStatusResponse) => void;
  onQueuePosition?: (position: number, status: SessionStatusResponse) => void;
  onSessionError?: import("../session-errors.js").SessionErrorHandler;
  debug?: DebugConsole;
  runtime?: SessionPollRuntime;
}): Promise<StartSessionResult> {
  const runtime = input.runtime ?? defaultSessionPollRuntime;
  const started = runtime.now();
  const url = `${input.apiBase.replace(/\/$/, "")}/sessions/${input.jobId}`;
  let pollAttemptIndex = 0;
  let previousProgress: SessionPollProgressSnapshot | null = null;

  while (runtime.now() - started < input.pollTimeoutMs) {
    const res = await fetchSessionApi(
      url,
      { headers: input.headers },
      {
        debug: input.debug,
        label: `GET /sessions/${input.jobId}`,
        runtime: {
          sleep: runtime.sleep,
          fetch: globalThis.fetch.bind(globalThis),
        },
      },
    );
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

    const currentProgress = toPollProgressSnapshot(status);
    if (shouldResetSessionPollBackoff(previousProgress, currentProgress)) {
      pollAttemptIndex = 0;
    }

    const delayMs = computeSessionPollDelayMs({
      baseIntervalMs: input.pollIntervalMs,
      attemptIndex: pollAttemptIndex,
      retryAfterMs: status.retry_after_ms,
      random: runtime.random,
    });
    previousProgress = currentProgress;
    pollAttemptIndex += 1;

    await runtime.sleep(delayMs);
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
