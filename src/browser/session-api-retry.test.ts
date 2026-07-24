import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SESSION_API_RETRY_DELAYS_MS,
  fetchSessionApi,
  isRetryableSessionApiBody,
  isRetryableSessionApiFailure,
  isRetryableSessionApiNetworkError,
  isRetryableSessionApiStatus,
} from "./session-api-retry.js";

describe("session-api-retry predicates", () => {
  it("treats 502/503/504 as retryable statuses", () => {
    expect(isRetryableSessionApiStatus(502)).toBe(true);
    expect(isRetryableSessionApiStatus(503)).toBe(true);
    expect(isRetryableSessionApiStatus(504)).toBe(true);
    expect(isRetryableSessionApiStatus(429)).toBe(false);
    expect(isRetryableSessionApiStatus(500)).toBe(false);
  });

  it("detects Envoy upstream body text", () => {
    expect(
      isRetryableSessionApiBody(
        "upstream connect error or disconnect/reset before headers. reset reason: connection termination",
      ),
    ).toBe(true);
    expect(isRetryableSessionApiBody('{"error":"capacity"}')).toBe(false);
  });

  it("combines status and body", () => {
    expect(
      isRetryableSessionApiFailure({
        status: 200,
        body: "upstream connect error",
      }),
    ).toBe(true);
    expect(
      isRetryableSessionApiFailure({ status: 503, body: "anything" }),
    ).toBe(true);
  });

  it("detects network fetch failures", () => {
    expect(
      isRetryableSessionApiNetworkError(new TypeError("fetch failed")),
    ).toBe(true);
    expect(isRetryableSessionApiNetworkError(new Error("boom"))).toBe(false);
  });
});

describe("fetchSessionApi", () => {
  it("retries Envoy 503 then returns success", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          "upstream connect error or disconnect/reset before headers. reset reason: connection termination",
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
      );

    const res = await fetchSessionApi(
      "https://sessions.example/v1/sessions/job-1",
      { headers: { Authorization: "Bearer x" } },
      {
        delaysMs: [1],
        runtime: { sleep, fetch: fetchMock as unknown as typeof fetch },
        label: "GET /sessions/job-1",
      },
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it("retries 502 POST then returns 202", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session_id: "job-1" }), { status: 202 }),
      );

    const res = await fetchSessionApi(
      "https://sessions.example/v1/sessions",
      { method: "POST" },
      {
        delaysMs: [1],
        runtime: { sleep, fetch: fetchMock as unknown as typeof fetch },
      },
    );

    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and returns last 503", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("connection termination", { status: 503 }),
      );

    const res = await fetchSessionApi(
      "https://sessions.example/v1/sessions/x",
      undefined,
      {
        delaysMs: DEFAULT_SESSION_API_RETRY_DELAYS_MS,
        runtime: { sleep, fetch: fetchMock as unknown as typeof fetch },
      },
    );

    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(
      DEFAULT_SESSION_API_RETRY_DELAYS_MS.length + 1,
    );
    expect(sleep).toHaveBeenCalledTimes(
      DEFAULT_SESSION_API_RETRY_DELAYS_MS.length,
    );
  });

  it("does not retry 429", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("capacity", { status: 429 }));

    const res = await fetchSessionApi(
      "https://sessions.example/v1/sessions",
      undefined,
      {
        delaysMs: [1, 1, 1],
        runtime: { sleep, fetch: fetchMock as unknown as typeof fetch },
      },
    );

    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
