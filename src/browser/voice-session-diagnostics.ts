/** Structured diagnostic events for peer cleanup (no secrets / raw SDP / URLs). */

export type VoiceSessionDiagnosticEvent = {
  type: "peer_close";
  /** Strict native close outcome (`closed` / `timed_out` / `failed`). */
  status: "closed" | "timed_out" | "failed";
  mode: "async" | "sync";
  durationMs: number;
  timedOut: boolean;
  context:
    | "disconnect"
    | "reset"
    | "failed_connect"
    | "offer_replace"
    | "reconnect";
  /** Redacted close failure summary when native close rejects (no URL/token/detail dump). */
  error?: string;
};

export type VoiceSessionDiagnosticHandler = (
  event: VoiceSessionDiagnosticEvent,
) => void | Promise<void>;

/** Prefer short codes over raw messages when a known failure shape is recognized. */
export function diagnosticErrorCode(input: unknown): string | undefined {
  const raw = input instanceof Error ? input.message : String(input ?? "");
  if (/native close boom|closeAsync/i.test(raw)) return "peer_close_failed";
  if (/timeout/i.test(raw)) return "peer_close_timeout";
  return undefined;
}

/**
 * Redact credentials, signaling/ICE URLs, query tokens, JSON secrets, and SDP ice-pwd.
 * Prefer {@link diagnosticErrorCode} in call sites when a code is enough.
 */
export function redactDiagnosticDetail(input: unknown): string {
  const code = diagnosticErrorCode(input);
  if (code) return code;

  const raw = input instanceof Error ? input.message : String(input ?? "");
  return (
    raw
      // http(s), ws(s), and ICE URIs (including user:pass@ and query strings)
      .replace(/\b(?:https?|wss?):\/\/[^\s"'`<>]+/gi, "[redacted-url]")
      .replace(/\b(?:turns?|stuns?):[^\s"'`<>]+/gi, "[redacted-ice-uri]")
      .replace(
        /([?&](?:token|join_token|access_token|auth|authorization|password|credential|secret|api[_-]?key)=)[^&\s"']+/gi,
        "$1[redacted]",
      )
      .replace(
        /\b(join_token|access_token|auth_token|api[_-]?key|password|credential|secret)\b\s*[:=]\s*["']?[^"'&\s,}\]]+/gi,
        "$1=[redacted]",
      )
      .replace(
        /(["'](?:join_token|access_token|password|credential|secret|username)["']\s*:\s*)["'][^"']*["']/gi,
        '$1"[redacted]"',
      )
      .replace(/\b(a=ice-pwd:)[^\r\n]+/gi, "$1[redacted]")
      .replace(/\b(Bearer\s+)[A-Za-z0-9._\-+=/]+/gi, "$1[redacted]")
      .slice(0, 200)
  );
}

/**
 * Invoke a diagnostic callback without letting sync throws or async rejections
 * affect disconnect / reconnect lifecycle. Never awaits the handler.
 */
export function emitDiagnosticSafely(
  handler: VoiceSessionDiagnosticHandler | undefined,
  event: VoiceSessionDiagnosticEvent,
): void {
  if (!handler) return;
  try {
    const result = handler(event);
    void Promise.resolve(result).catch(() => {
      // Async diagnostic sinks must never surface unhandled rejections.
    });
  } catch {
    // Sync diagnostic sinks must never break disconnect / reconnect.
  }
}
