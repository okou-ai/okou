import type { SandboxAuth } from "../../types/auth";
import { isSandboxToken, verifySandboxToken } from "../auth/tokens";

export const unauthorizedRunMismatch = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not authenticated or runId mismatch",
      code: "UNAUTHORIZED",
    }),
  }),
});

type SandboxAuthFailureReason =
  | "missing_bearer"
  | "non_sandbox_token"
  | "invalid_token"
  | "run_id_mismatch";

type SandboxAuthForRunResult =
  | {
      ok: true;
      auth: SandboxAuth;
    }
  | {
      ok: false;
      reason: SandboxAuthFailureReason;
    };

export function resolveSandboxAuthForRun(
  expectedRunId: string,
  authHeader: string | undefined,
): SandboxAuthForRunResult {
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, reason: "missing_bearer" };
  }

  const token = authHeader.substring("Bearer ".length);
  if (!isSandboxToken(token)) {
    return { ok: false, reason: "non_sandbox_token" };
  }

  const auth = verifySandboxToken(token);
  if (!auth) {
    return { ok: false, reason: "invalid_token" };
  }

  if (auth.runId !== expectedRunId) {
    return { ok: false, reason: "run_id_mismatch" };
  }

  return { ok: true, auth };
}

export function getSandboxAuthForRun(
  expectedRunId: string,
  authHeader: string | undefined,
): SandboxAuth | null {
  const result = resolveSandboxAuthForRun(expectedRunId, authHeader);
  if (!result.ok) {
    return null;
  }

  return result.auth;
}
