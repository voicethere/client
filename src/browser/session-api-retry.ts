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
  /** Abort fetch attempts and retry sleeps. */
  signal?: AbortSignal;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

async function sleepAbortable(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await sleep(ms);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
    throwIfAborted(options?.signal);
    try {
      const response = await runtime.fetch(input, {
        ...init,
        signal: options?.signal ?? init?.signal,
      });
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
      await sleepAbortable(delayMs, runtime.sleep, options?.signal);
      continue;
    } catch (error: unknown) {
      lastError = error;
      if (options?.signal?.aborted) {
        throwIfAborted(options.signal);
      }
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
      await sleepAbortable(delayMs, runtime.sleep, options?.signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after retries`);
}
