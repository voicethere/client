import { afterEach, describe, expect, it, vi } from "vitest";

import {
  diagnosticErrorCode,
  emitDiagnosticSafely,
  redactDiagnosticDetail,
} from "./voice-session-diagnostics.js";

describe("redactDiagnosticDetail", () => {
  it("redacts https URLs, query tokens, join_token, and bearer credentials", () => {
    const redacted = redactDiagnosticDetail(
      "failed https://app.example/path?token=secret123&join_token=jt99&x=1 Bearer abc.def.ghi",
    );
    expect(redacted).toContain("[redacted-url]");
    expect(redacted).toContain("Bearer [redacted]");
    expect(redacted).not.toContain("secret123");
    expect(redacted).not.toContain("jt99");
    expect(redacted).not.toContain("abc.def.ghi");
  });

  it("redacts ws:// and wss:// including embedded credentials/query", () => {
    const redacted = redactDiagnosticDetail(
      "sig ws://user:pass@host:8080/ws?join_token=abc and wss://x:y@edge/ws?token=t1",
    );
    expect(redacted).toContain("[redacted-url]");
    expect(redacted).not.toContain("user:pass");
    expect(redacted).not.toContain("join_token=abc");
    expect(redacted).not.toContain("token=t1");
  });

  it("redacts turn:/turns:/stun: URIs including embedded credentials", () => {
    const redacted = redactDiagnosticDetail(
      "ice turn:user:secret@turn.example:3478?transport=udp turns:u:p@t.example stun:stun.l.google.com:19302",
    );
    expect(redacted).toContain("[redacted-ice-uri]");
    expect(redacted).not.toContain("user:secret");
    expect(redacted).not.toContain("u:p@");
    expect(redacted).not.toContain("stun.l.google.com");
  });

  it("redacts JSON credentials and SDP ice-pwd", () => {
    const redacted = redactDiagnosticDetail(
      `{"password":"p@ss","credential":"turn-secret","join_token":"jt"} a=ice-pwd:AbCdEf123`,
    );
    expect(redacted).not.toContain("p@ss");
    expect(redacted).not.toContain("turn-secret");
    expect(redacted).not.toContain("jt");
    expect(redacted).not.toContain("AbCdEf123");
    expect(redacted).toContain("a=ice-pwd:[redacted]");
  });

  it("prefers allowlisted codes over raw messages when recognized", () => {
    expect(diagnosticErrorCode(new Error("native close boom"))).toBe(
      "peer_close_failed",
    );
    expect(redactDiagnosticDetail(new Error("native close boom"))).toBe(
      "peer_close_failed",
    );
  });

  it("truncates long detail", () => {
    expect(redactDiagnosticDetail("x".repeat(500)).length).toBe(200);
  });
});

describe("emitDiagnosticSafely", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows consumer sync exceptions", () => {
    const handler = vi.fn(() => {
      throw new Error("sink boom");
    });
    expect(() =>
      emitDiagnosticSafely(handler, {
        type: "peer_close",
        status: "closed",
        mode: "sync",
        durationMs: 1,
        timedOut: false,
        context: "disconnect",
      }),
    ).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isolates async handler rejections without unhandled rejection or throw", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      let lifecycleOk = true;
      expect(() =>
        emitDiagnosticSafely(
          async () => {
            throw new Error("async sink boom");
          },
          {
            type: "peer_close",
            status: "failed",
            mode: "async",
            durationMs: 2,
            timedOut: false,
            context: "disconnect",
          },
        ),
      ).not.toThrow();

      // Allow the rejected promise microtask to settle.
      await Promise.resolve();
      await Promise.resolve();
      lifecycleOk = true;

      expect(lifecycleOk).toBe(true);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
