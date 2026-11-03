/** Mid-session end-user identification (`POST /v1/sessions/{id}/end-user`). */

export type EndUserIdentifyInput =
  { endUserToken: string } | { endUser: { id: string } };

export type EndUserIdentifyResult = {
  id: string;
  verified: boolean;
  result: "updated" | "unchanged";
};

/** Base class for every `identify` failure; `code` is the API error code. */
export class EndUserIdentityError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  /** True when trying again later can succeed. */
  readonly retryable: boolean;
  constructor(
    name: string,
    code: string,
    httpStatus: number,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

/** 409 `end_user_conflict`: the session already belongs to another end user. */
export class EndUserConflictError extends EndUserIdentityError {
  constructor(code: string, message: string) {
    super("EndUserConflictError", code, 409, message);
  }
}

/** 401 `end_user_rejected`: the token or id was not accepted. */
export class EndUserRejectedError extends EndUserIdentityError {
  constructor(code: string, message: string) {
    super("EndUserRejectedError", code, 401, message);
  }
}

/** 503 `end_user_auth_unavailable`: the project's verifier could not be reached. */
export class EndUserAuthUnavailableError extends EndUserIdentityError {
  constructor(code: string, message: string) {
    super("EndUserAuthUnavailableError", code, 503, message, true);
  }
}

const IDENTIFY_TIMEOUT_MS = 15_000;

function readErrorCode(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string } | string;
      code?: string;
    };
    if (typeof parsed.error === "object" && parsed.error?.code) {
      return parsed.error.code;
    }
    if (typeof parsed.code === "string") return parsed.code;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    /* non-JSON body */
  }
  return "";
}

export async function postEndUserIdentify(input: {
  apiBase: string;
  orchestratorSessionId: string;
  projectId: string;
  joinToken: string;
  headers?: Record<string, string>;
  input: EndUserIdentifyInput;
}): Promise<EndUserIdentifyResult> {
  const apiBase = input.apiBase.replace(/\/$/, "");
  const res = await fetch(
    `${apiBase}/sessions/${encodeURIComponent(input.orchestratorSessionId)}/end-user`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...input.headers },
      body: JSON.stringify({
        project_id: input.projectId,
        join_token: input.joinToken,
        ...("endUserToken" in input.input
          ? { end_user_token: input.input.endUserToken }
          : { end_user: input.input.endUser }),
      }),
      signal: AbortSignal.timeout(IDENTIFY_TIMEOUT_MS),
    },
  );
  if (res.status === 200) {
    const body = (await res.json()) as {
      end_user: { id: string; verified: boolean };
      result: "updated" | "unchanged";
    };
    return {
      id: body.end_user.id,
      verified: body.end_user.verified,
      result: body.result,
    };
  }
  const text = await res.text().catch(() => "");
  const code = readErrorCode(text);
  const message = `identify failed (${res.status}${code ? ` ${code}` : ""})`;
  if (res.status === 409 && code === "end_user_conflict") {
    throw new EndUserConflictError(code, message);
  }
  if (res.status === 401) {
    throw new EndUserRejectedError(code || "end_user_rejected", message);
  }
  if (res.status === 503) {
    throw new EndUserAuthUnavailableError(
      code || "end_user_auth_unavailable",
      message,
    );
  }
  throw new EndUserIdentityError(
    "EndUserIdentityError",
    code || "identify_failed",
    res.status,
    message,
  );
}
