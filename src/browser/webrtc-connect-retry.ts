/** Thrown when a transport failure will be retried on the same session credentials. */
export class WebRtcConnectRetryError extends Error {
  readonly retriable = true as const;

  constructor(message: string) {
    super(message);
    this.name = "WebRtcConnectRetryError";
  }
}

export function isWebRtcConnectRetryError(
  error: unknown,
): error is WebRtcConnectRetryError {
  return (
    error instanceof WebRtcConnectRetryError ||
    (error instanceof Error && error.name === "WebRtcConnectRetryError")
  );
}
