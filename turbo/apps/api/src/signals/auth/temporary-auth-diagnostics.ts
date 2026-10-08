import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import {
  AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT,
  recordTemporaryAuthFailure,
} from "@okouai/core/temporary-auth-diagnostics";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { authorization$, cookie$, request$, route$ } from "../context/hono";
import { clerkSessionFailureReason$ } from "./clerk-session";
import { isPatToken, isSandboxToken } from "./tokens";

const L = logger("TemporaryAuthDiagnostics");

function correlationId(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : undefined;
}

function credentialsMissing(
  bearerToken: string | undefined,
  usedClerk: boolean,
  clerkReason: string | null,
): boolean {
  return (
    !bearerToken &&
    (!usedClerk ||
      clerkReason === "session-token-and-uat-missing" ||
      clerkReason === "session-token-missing" ||
      clerkReason === "client-uat-but-no-session-token")
  );
}

/** Remove with #36177 diagnostics after 2026-10-29; auth responses stay intact. */
export const logTemporaryAuthFailure$ = command(
  async ({ get }, auth: AuthContext | null, signal: AbortSignal) => {
    const request = get(request$);
    if (
      now() >= AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT ||
      request.header(CLIENT_TYPE_HEADER) !== CLIENT_TYPE_APP ||
      (auth && auth.tokenType !== "session")
    ) {
      return;
    }

    const authorization = get(authorization$);
    const bearerToken = authorization?.startsWith("Bearer ")
      ? authorization.substring(7)
      : undefined;
    if (
      bearerToken &&
      (isPatToken(bearerToken) || isSandboxToken(bearerToken))
    ) {
      return;
    }

    // Only read the already memoized Clerk result on paths that used Clerk.
    // Missing credentials must not trigger an authentication call for logging.
    const usedClerk = bearerToken !== undefined || Boolean(get(cookie$));
    const clerkReason =
      !auth && usedClerk ? await get(clerkSessionFailureReason$) : null;
    signal.throwIfAborted();
    if (now() >= AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT) {
      return;
    }

    const route = get(route$);
    const version = request.header(CLIENT_VERSION_HEADER);
    const fields = {
      type: "temporary_auth_failure",
      auth_failure_reason: auth
        ? "missing_org"
        : credentialsMissing(bearerToken, usedClerk, clerkReason)
          ? "missing_credentials"
          : "clerk_rejected",
      clerk_reason: clerkReason,
      has_bearer_token: Boolean(bearerToken),
      has_org: Boolean(auth?.orgId),
      method: route.method,
      route: route.path,
      status: 401,
      requestId: correlationId(request.header(CLIENT_REQUEST_ID_HEADER)),
      clientSessionId: correlationId(request.header(CLIENT_SESSION_ID_HEADER)),
      clientVersion:
        version && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(version)
          ? version
          : undefined,
    };

    // Diagnostic delivery is best effort and must not replace the auth result.
    recordTemporaryAuthFailure(now(), () => {
      L.info("temporary auth failure", fields);
    });
  },
);
