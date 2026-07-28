/**
 * Capability-based awaitable peer close (Node SDK `closeAsync`, browser sync `close`).
 *
 * Strict status lets soak / disconnectAsync callers observe whether native
 * resources actually converged — a bounded race must never be reported as success.
 */

export type AwaitableCloseablePeerConnection = RTCPeerConnection & {
  closeAsync?: () => Promise<void>;
};

/** Native peer-close convergence outcome. */
export type PeerCloseStatus = "closed" | "timed_out" | "failed";

export type PeerCloseResult = {
  /**
   * `closed` — native close settled successfully.
   * `timed_out` — closeAsync did not settle within the bound (resources may still be live).
   * `failed` — native close rejected / threw.
   */
  status: PeerCloseStatus;
  /** `async` when runtime exposed closeAsync; otherwise sync browser-style close. */
  mode: "async" | "sync";
  durationMs: number;
  /** True when status is `timed_out` (compat with older diagnostic consumers). */
  timedOut: boolean;
  /** Present when status is `failed`, or when a late reject races a timeout. */
  error?: unknown;
};

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Close a peer connection, awaiting `closeAsync()` when the runtime provides it.
 * Never rejects — outcomes are returned on {@link PeerCloseResult.status}.
 */
export async function closePeerConnectionAwaitable(
  pc: AwaitableCloseablePeerConnection | null | undefined,
  options?: { timeoutMs?: number },
): Promise<PeerCloseResult> {
  const started = Date.now();
  if (!pc) {
    return {
      status: "closed",
      mode: "sync",
      durationMs: 0,
      timedOut: false,
    };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  if (typeof pc.closeAsync === "function") {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let error: unknown;
    let settled = false;
    try {
      // Promise.resolve().then contains synchronous throws from closeAsync().
      const closeWork = Promise.resolve()
        .then(() => pc.closeAsync!())
        .then(
          () => {
            settled = true;
          },
          (err: unknown) => {
            settled = true;
            error = err;
          },
        );
      await Promise.race([
        closeWork,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
      // If close settles in the same turn as the timer, prefer the real outcome.
      await Promise.resolve();
    } finally {
      if (timer) clearTimeout(timer);
    }

    const durationMs = Date.now() - started;
    if (timedOut && !settled) {
      return {
        status: "timed_out",
        mode: "async",
        durationMs,
        timedOut: true,
      };
    }
    if (error !== undefined) {
      return {
        status: "failed",
        mode: "async",
        durationMs,
        timedOut: false,
        error,
      };
    }
    return {
      status: "closed",
      mode: "async",
      durationMs,
      timedOut: false,
    };
  }

  try {
    pc.close();
  } catch (error: unknown) {
    return {
      status: "failed",
      mode: "sync",
      durationMs: Date.now() - started,
      timedOut: false,
      error,
    };
  }
  return {
    status: "closed",
    mode: "sync",
    durationMs: Date.now() - started,
    timedOut: false,
  };
}
