import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clampSessionPollRetryAfterMs,
  computeSessionPollDelayMs,
  pollSessionStatus,
  SESSION_POLL_INTERVAL_CAP_MS,
  SESSION_POLL_RETRY_AFTER_MAX_MS,
  SESSION_POLL_RETRY_AFTER_MIN_MS,
  shouldResetSessionPollBackoff,
} from "./session-provision-poll.js";
import {
  isCapacityWaitStatus,
  isTerminalSessionJobStatus,
  startSession,
  type SessionStatusResponse,
} from "./session-provision.js";

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";

function baseStatus(
  overrides: Partial<SessionStatusResponse> = {},
): SessionStatusResponse {
  return {
    session_id: "job-1",
    status: "queued",
    project_id: PROJECT_ID,
    build_id: null,
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("session provision state machine", () => {
  it("treats ready and failed as terminal", () => {
    expect(isTerminalSessionJobStatus("ready")).toBe(true);
    expect(isTerminalSessionJobStatus("failed")).toBe(true);
    expect(isTerminalSessionJobStatus("queued")).toBe(false);
    expect(isTerminalSessionJobStatus("waiting")).toBe(false);
    expect(isTerminalSessionJobStatus("provisioning")).toBe(false);
  });

  it("detects capacity wait polling status", () => {
    const waiting: SessionStatusResponse = {
      session_id: "job-1",
      status: "waiting",
      project_id: PROJECT_ID,
      build_id: null,
      queue_position: 2,
      waiting_since: "2026-07-01T10:00:00.000Z",
      waiting_expires_at: "2026-07-01T12:00:00.000Z",
      estimated_wait_seconds: 120,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(isCapacityWaitStatus(waiting)).toBe(true);
    expect(isCapacityWaitStatus({ ...waiting, status: "provisioning" })).toBe(
      false,
    );
  });
});

describe("adaptive session poll scheduling", () => {
  it("progresses backoff 1s → 2s → 3s → 5s with default base", () => {
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 1000,
        attemptIndex: 0,
        jitter: false,
      }),
    ).toBe(1000);
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 1000,
        attemptIndex: 1,
        jitter: false,
      }),
    ).toBe(2000);
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 1000,
        attemptIndex: 2,
        jitter: false,
      }),
    ).toBe(3000);
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 1000,
        attemptIndex: 3,
        jitter: false,
      }),
    ).toBe(5000);
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 1000,
        attemptIndex: 9,
        jitter: false,
      }),
    ).toBe(SESSION_POLL_INTERVAL_CAP_MS);
  });

  it("caps delay at 5s even when base * multiplier exceeds cap", () => {
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 2000,
        attemptIndex: 3,
        jitter: false,
      }),
    ).toBe(SESSION_POLL_INTERVAL_CAP_MS);
  });

  it("scales progression with pollIntervalMs base", () => {
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 500,
        attemptIndex: 1,
        jitter: false,
      }),
    ).toBe(1000);
  });

  it("resets backoff when status or queue position changes", () => {
    expect(
      shouldResetSessionPollBackoff(
        { status: "queued", queuePosition: null },
        { status: "provisioning", queuePosition: null },
      ),
    ).toBe(true);
    expect(
      shouldResetSessionPollBackoff(
        { status: "waiting", queuePosition: 4 },
        { status: "waiting", queuePosition: 3 },
      ),
    ).toBe(true);
    expect(
      shouldResetSessionPollBackoff(
        { status: "provisioning", queuePosition: null },
        { status: "provisioning", queuePosition: null },
      ),
    ).toBe(false);
    expect(shouldResetSessionPollBackoff(null, { status: "queued" })).toBe(
      false,
    );
  });

  it("honors retry_after_ms within min/max bounds", () => {
    expect(clampSessionPollRetryAfterMs(50)).toBe(
      SESSION_POLL_RETRY_AFTER_MIN_MS,
    );
    expect(clampSessionPollRetryAfterMs(60_000)).toBe(
      SESSION_POLL_RETRY_AFTER_MAX_MS,
    );
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 1000,
        attemptIndex: 0,
        retryAfterMs: 1800,
        jitter: false,
      }),
    ).toBe(1800);
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 1000,
        attemptIndex: 5,
        retryAfterMs: 80,
        jitter: false,
      }),
    ).toBe(SESSION_POLL_RETRY_AFTER_MIN_MS);
  });

  it("applies deterministic jitter when random is injected", () => {
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 1000,
        attemptIndex: 0,
        random: () => 0,
      }),
    ).toBe(900);
    expect(
      computeSessionPollDelayMs({
        baseIntervalMs: 1000,
        attemptIndex: 0,
        random: () => 1,
      }),
    ).toBe(1100);
  });
});

describe("pollSessionStatus integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns immediately on terminal ready without sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        baseStatus({
          status: "ready",
          credentials: {
            session_id: "job-1",
            mode: "voice",
            join_token: "token",
            signaling_url: "wss://sig.example/ws",
            room_id: "room-1",
            ice_servers: [],
            expires_at: "2026-07-01T11:00:00.000Z",
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollSessionStatus({
      apiBase: "https://sessions.example/v1",
      jobId: "job-1",
      headers: {},
      pollIntervalMs: 1000,
      pollTimeoutMs: 120_000,
      runtime: {
        sleep,
        now: () => 0,
        random: () => 0.5,
      },
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("times out after pollTimeoutMs with adaptive sleeps", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => baseStatus({ status: "provisioning" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollSessionStatus({
      apiBase: "https://sessions.example/v1",
      jobId: "job-1",
      headers: {},
      pollIntervalMs: 1000,
      pollTimeoutMs: 10_000,
      runtime: {
        sleep,
        now: () => now,
        random: () => 0.5,
      },
    });

    expect(result).toEqual({
      ok: false,
      code: "TIMEOUT",
      message: "Session provisioning timed out",
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThan(10);
    expect(sleep).toHaveBeenCalled();
  });

  it("resets backoff when queue position changes", async () => {
    const delays: number[] = [];
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
      now += ms;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => baseStatus({ status: "waiting", queue_position: 3 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => baseStatus({ status: "waiting", queue_position: 2 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          baseStatus({
            status: "ready",
            credentials: {
              session_id: "job-1",
              mode: "voice",
              join_token: "token",
              signaling_url: "wss://sig.example/ws",
              room_id: "room-1",
              ice_servers: [],
              expires_at: "2026-07-01T11:00:00.000Z",
            },
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollSessionStatus({
      apiBase: "https://sessions.example/v1",
      jobId: "job-1",
      headers: {},
      pollIntervalMs: 1000,
      pollTimeoutMs: 120_000,
      runtime: {
        sleep,
        now: () => now,
        random: () => 0.5,
      },
    });

    expect(result.ok).toBe(true);
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(1000);
  });
});

describe("startSession adaptive polling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("polls with 202 acceptance until ready", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ session_id: "job-1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => baseStatus({ status: "queued" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          baseStatus({
            status: "ready",
            credentials: {
              session_id: "job-1",
              mode: "voice",
              join_token: "token",
              signaling_url: "wss://sig.example/ws",
              room_id: "room-1",
              ice_servers: [],
              expires_at: "2026-07-01T11:00:00.000Z",
            },
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    let now = 0;
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      now += timeout ?? 0;
      if (typeof handler === "function") {
        handler();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const result = await startSession({
      apiBase: "https://sessions.example/v1",
      projectId: PROJECT_ID,
      pollIntervalMs: 1000,
    });

    globalThis.setTimeout = originalSetTimeout;

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
