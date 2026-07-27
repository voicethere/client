/**
 * Capability-based awaitable peer close (Node SDK `closeAsync`, browser sync `close`).
 */

export type AwaitableCloseablePeerConnection = RTCPeerConnection & {
  closeAsync?: () => Promise<void>;
};

export type PeerCloseResult = {
  /** `async` when runtime exposed closeAsync; otherwise sync browser-style close. */
  mode: "async" | "sync";
  durationMs: number;
  timedOut: boolean;
  /** Present when native close rejected; cleanup still completed. */
  error?: unknown;
};

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Close a peer connection, awaiting `closeAsync()` when the runtime provides it.
 * Never rejects — sync and async close failures are returned on {@link PeerCloseResult.error}.
 */
export async function closePeerConnectionAwaitable(
  pc: AwaitableCloseablePeerConnection | null | undefined,
  options?: { timeoutMs?: number },
): Promise<PeerCloseResult> {
  const started = Date.now();
  if (!pc) {
    return { mode: "sync", durationMs: 0, timedOut: false };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  if (typeof pc.closeAsync === "function") {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let error: unknown;
    try {
      // Promise.resolve().then contains synchronous throws from closeAsync().
      const closeWork = Promise.resolve()
        .then(() => pc.closeAsync!())
        .then(
          () => undefined,
          (err: unknown) => {
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
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {
      mode: "async",
      durationMs: Date.now() - started,
      timedOut,
      ...(error !== undefined ? { error } : {}),
    };
  }

  try {
    pc.close();
  } catch (error: unknown) {
    return {
      mode: "sync",
      durationMs: Date.now() - started,
      timedOut: false,
      error,
    };
  }
  return {
    mode: "sync",
    durationMs: Date.now() - started,
    timedOut: false,
  };
}
