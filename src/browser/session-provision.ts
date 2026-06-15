import type { DebugConsole } from "./debug-console.js";

export type SessionFailureCode =
  | "NOT_DEPLOYED"
  | "RUNNER_UNAVAILABLE"
  | "ORCHESTRATOR_ERROR"
  | "JOIN_TOKEN_ERROR"
  | "TIMEOUT";

export type SessionJobStatus = "queued" | "provisioning" | "ready" | "failed";

export type SessionCredentials = {
  session_id: string;
  join_token: string;
  signaling_url: string;
  room_id: string;
  ice_servers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  expires_at: string;
};

export type SessionStatusResponse = {
  session_id: string;
  status: SessionJobStatus;
  project_id: string;
  build_id: string | null;
  failure_code?: SessionFailureCode | null;
  failure_message?: string | null;
  credentials?: SessionCredentials | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

export type StartSessionOptions = {
  apiBase: string;
  projectId: string;
  buildId?: string;
  async?: boolean;
  headers?: Record<string, string>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  onStatus?: (status: SessionStatusResponse) => void;
  debug?: DebugConsole;
};

export type StartSessionResult =
  | { ok: true; credentials: SessionCredentials; jobId: string }
  | {
      ok: false;
      code: SessionFailureCode | "TIMEOUT" | "HTTP_ERROR";
      message: string;
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollSessionStatus(input: {
  apiBase: string;
  jobId: string;
  headers: Record<string, string>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  onStatus?: (status: SessionStatusResponse) => void;
  debug?: DebugConsole;
}): Promise<StartSessionResult> {
  const started = Date.now();
  const url = `${input.apiBase.replace(/\/$/, "")}/api/v1/sessions/${input.jobId}`;

  while (Date.now() - started < input.pollTimeoutMs) {
    const res = await fetch(url, { headers: input.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        code: "HTTP_ERROR",
        message: `GET session status failed (${res.status}): ${body}`,
      };
    }

    const status = (await res.json()) as SessionStatusResponse;
    input.onStatus?.(status);
    input.debug?.info(
      "provision",
      status.status,
      status.failure_message ?? undefined,
      status,
    );

    if (status.status === "ready" && status.credentials) {
      return { ok: true, credentials: status.credentials, jobId: input.jobId };
    }

    if (status.status === "failed") {
      return {
        ok: false,
        code: status.failure_code ?? "ORCHESTRATOR_ERROR",
        message: status.failure_message ?? "Session provisioning failed",
      };
    }

    await sleep(input.pollIntervalMs);
  }

  return {
    ok: false,
    code: "TIMEOUT",
    message: "Session provisioning timed out",
  };
}

/**
 * POST /api/v1/sessions with async=true and poll GET until ready or failed.
 */
export async function startSession(
  options: StartSessionOptions,
): Promise<StartSessionResult> {
  const apiBase = options.apiBase.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  const body = {
    project_id: options.projectId,
    build_id: options.buildId,
    async: options.async ?? true,
  };

  options.debug?.info("provision", "post_sessions", JSON.stringify(body));

  const res = await fetch(`${apiBase}/api/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 200) {
    const sync = (await res.json()) as SessionCredentials & {
      project_id?: string;
      build_id?: string;
    };
    return {
      ok: true,
      credentials: {
        session_id: sync.session_id,
        join_token: sync.join_token,
        signaling_url: sync.signaling_url,
        room_id: sync.room_id,
        ice_servers: sync.ice_servers,
        expires_at: sync.expires_at,
      },
      jobId: sync.session_id,
    };
  }

  if (res.status !== 202) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      code: "HTTP_ERROR",
      message: `POST /sessions failed (${res.status}): ${text}`,
    };
  }

  const accepted = (await res.json()) as { session_id: string };
  return pollSessionStatus({
    apiBase,
    jobId: accepted.session_id,
    headers,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    pollTimeoutMs: options.pollTimeoutMs ?? 120_000,
    onStatus: options.onStatus,
    debug: options.debug,
  });
}
