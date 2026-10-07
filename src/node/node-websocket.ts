import { WebSocket as NodeWebSocket } from "ws";

import {
  createConnectionError,
  dispatchConnectionError,
} from "../connection-errors.js";

/**
 * Minimal WebSocket wrapper matching the browser API used by browser-voice-session.
 */
export class NodeWebSocketAdapter {
  static readonly OPEN = NodeWebSocket.OPEN;

  readonly OPEN = NodeWebSocket.OPEN;

  readyState: number;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null;
  /** HTTP status of a rejected upgrade (e.g. 401), read from `unexpected-response`. */
  httpStatus?: number;

  private readonly ws: NodeWebSocket;
  private readonly url: string;

  constructor(url: string, _protocols?: string | string[]) {
    this.url = url;
    this.ws = new NodeWebSocket(url);
    this.readyState = this.ws.readyState;

    this.ws.on("open", () => {
      this.readyState = NodeWebSocket.OPEN;
      this.onopen?.();
    });
    this.ws.on("unexpected-response", (_request, response) => {
      this.httpStatus = response.statusCode;
      response.resume();
      // With a listener attached `ws` leaves the request open; abort it here.
      this.ws.terminate();
    });
    this.ws.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      dispatchConnectionError(
        createConnectionError(
          message,
          {
            subsystem: "signaling",
            phase: "socket",
            url: this.url,
          },
          error,
        ),
        { fallbackLog: false },
      );
      this.onerror?.();
    });
    this.ws.on("message", (data) => {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(data as ArrayBuffer).toString("utf8");
      this.onmessage?.({ data: text } as MessageEvent);
    });
    this.ws.on("close", (code, reason) => {
      this.readyState = NodeWebSocket.CLOSED;
      this.onclose?.({
        code,
        reason: reason.toString("utf8"),
        wasClean: code === 1000,
      });
    });
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}
