import type { DebugConsole } from "./debug-console.js";

/** Backoff between attempts: 250ms, 750ms, 1500ms (4 tries total). */
export const DEFAULT_SESSION_API_RETRY_DELAYS_MS = [250, 750, 1_500] as const;

export type SessionApiRetryRuntime = {
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
};

/** Resolve fetch/sleep at call time so test stubs of globalThis.fetch apply. */
function resolveRuntime(
  runtime?: SessionApiRetryRuntime,
): SessionApiRetryRuntime {
  return {
    sleep:
      runtime?.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    fetch: runtime?.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

export function isRetryableSessionApiStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export function isRetryableSessionApiBody(body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    normalized.includes("upstream connect error") ||
    normalized.includes("connection termination") ||
    normalized.includes("disconnect/reset before headers")
  );
}

export function isRetryableSessionApiFailure(input: {
  status: number;
  body: string;
}): boolean {
  return (
    isRetryableSessionApiStatus(input.status) ||
    isRetryableSessionApiBody(input.body)
  );
}

export function isRetryableSessionApiNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    error.name === "TypeError" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up")
  );
}

export type FetchSessionApiOptions = {
  delaysMs?: readonly number[];
  runtime?: SessionApiRetryRuntime;
  debug?: DebugConsole;
  /** Label for debug logs (e.g. GET /sessions/:id). */
  label?: string;
};

/**
 * fetch() with retries for Envoy/ingress blips (502–504, upstream connect errors).
 * Does not retry other 4xx (including 429).
 */
export async function fetchSessionApi(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchSessionApiOptions,
): Promise<Response> {
  const runtime = resolveRuntime(options?.runtime);
  const delaysMs = options?.delaysMs ?? DEFAULT_SESSION_API_RETRY_DELAYS_MS;
  const maxAttempts = delaysMs.length + 1;
  const label = options?.label ?? "session-api";

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await runtime.fetch(input, init);
      if (
        response.ok ||
        (response.status < 500 && !isRetryableSessionApiStatus(response.status))
      ) {
        return response;
      }

      const body = await response
        .clone()
        .text()
        .catch(() => "");
      if (
        !isRetryableSessionApiFailure({ status: response.status, body }) ||
        attempt >= maxAttempts - 1
      ) {
        return response;
      }

      const delayMs = delaysMs[attempt] ?? delaysMs.at(-1)!;
      options?.debug?.warn(
        "provision",
        "session_api_retry",
        `${label} status=${response.status} attempt=${attempt + 1}/${maxAttempts} delay_ms=${delayMs}`,
      );
      await runtime.sleep(delayMs);
      continue;
    } catch (error: unknown) {
      lastError = error;
      if (
        !isRetryableSessionApiNetworkError(error) ||
        attempt >= maxAttempts - 1
      ) {
        throw error;
      }
      const delayMs = delaysMs[attempt] ?? delaysMs.at(-1)!;
      options?.debug?.warn(
        "provision",
        "session_api_retry",
        `${label} network_error attempt=${attempt + 1}/${maxAttempts} delay_ms=${delayMs}`,
      );
      await runtime.sleep(delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after retries`);
}
