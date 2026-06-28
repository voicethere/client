/**
 * Cross-subsystem connection errors with a single optional root handler.
 *
 * This is a local copy of the connection-error surface so browser-facing
 * client entrypoints do not need to import `@node-webrtc-rust/sdk`.
 */

export type SignalingErrorSource = {
  subsystem: "signaling";
  room?: string;
  peerId?: string;
  phase: "connect" | "socket";
  url?: string;
};

export type SessionErrorSource = {
  subsystem: "session";
  sessionId: string;
  code: string;
  projectId?: string;
  buildId?: string;
};

export type WebRtcErrorSource = {
  subsystem: "webrtc";
  sessionId?: string;
  peerId?: string;
  kind:
    | "connect"
    | "disconnect"
    | "ice"
    | "datachannel"
    | "signaling-ws"
    | "peer-connection";
  label?: string;
};

export type ConnectionErrorSource =
  | SignalingErrorSource
  | SessionErrorSource
  | WebRtcErrorSource;

export type RootConnectionErrorHandler = (error: ConnectionError) => void;

/** Error with structured source metadata. */
export class ConnectionError extends Error {
  readonly source: ConnectionErrorSource;
  override readonly cause?: unknown;

  constructor(
    message: string,
    source: ConnectionErrorSource,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ConnectionError";
    this.source = source;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  static is(error: unknown): error is ConnectionError {
    return error instanceof ConnectionError;
  }

  static sourceOf(error: unknown): ConnectionErrorSource | undefined {
    return ConnectionError.is(error) ? error.source : undefined;
  }
}

let rootHandler: RootConnectionErrorHandler | undefined;

/** Install a process-wide handler for tagged connection errors. */
export function setRootConnectionErrorHandler(
  handler: RootConnectionErrorHandler | undefined,
): void {
  rootHandler = handler;
}

export function getRootConnectionErrorHandler():
  | RootConnectionErrorHandler
  | undefined {
  return rootHandler;
}

export function createConnectionError(
  message: string,
  source: ConnectionErrorSource,
  cause?: unknown,
): ConnectionError {
  if (ConnectionError.is(cause)) {
    return cause;
  }
  return new ConnectionError(
    message,
    source,
    cause !== undefined ? { cause } : undefined,
  );
}

/** Forward to the root handler when installed. Returns whether a handler ran. */
export function reportConnectionError(error: ConnectionError): boolean {
  if (!rootHandler) return false;
  rootHandler(error);
  return true;
}

type ErrorEmitter = {
  listenerCount: (event: "error") => number;
  emit: (event: "error", error: ConnectionError) => void;
};

/**
 * Bubble a tagged error to the root handler, then optional emitter listeners,
 * then stderr — never throws for unhandled `error` events.
 */
export function dispatchConnectionError(
  error: ConnectionError,
  options?: {
    emitter?: ErrorEmitter;
    fallbackLog?: boolean;
  },
): void {
  reportConnectionError(error);
  if (options?.emitter && options.emitter.listenerCount("error") > 0) {
    options.emitter.emit("error", error);
    return;
  }
  if (options?.fallbackLog === false) return;
  if (rootHandler) return;
  console.error(
    `[connection] ${formatConnectionErrorSource(error.source)}: ${error.message}`,
  );
}

export function formatConnectionErrorSource(source: ConnectionErrorSource): string {
  switch (source.subsystem) {
    case "signaling": {
      const parts = [
        "signaling",
        source.phase,
        source.room ? `room=${source.room}` : undefined,
        source.peerId ? `peer=${source.peerId}` : undefined,
      ].filter(Boolean);
      return parts.join(" ");
    }
    case "session":
      return `session code=${source.code} session=${source.sessionId}`;
    case "webrtc": {
      const parts = [
        "webrtc",
        source.kind,
        source.sessionId ? `session=${source.sessionId}` : undefined,
        source.peerId ? `peer=${source.peerId}` : undefined,
        source.label ? `label=${source.label}` : undefined,
      ].filter(Boolean);
      return parts.join(" ");
    }
    default:
      return "unknown";
  }
}
