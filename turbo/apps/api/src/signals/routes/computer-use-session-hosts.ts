import { desktopUpgradeRequired } from "../../lib/desktop-compatibility";
import { command, computed, type Command } from "ccstate";
import { computerUseSessionHostsContract as contract } from "@okouai/api-contracts/contracts/computer-use";

import { conflict, notFound, providerUnavailable } from "../../lib/error";
import { authRoute } from "../auth/auth-route";
import { organizationAuthContext$ } from "../auth/auth-context";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { clerkRateLimit, clerkReadUnavailable } from "../external/clerk";
import { settle } from "../utils";
import type { RouteEntry } from "../route-entry";
import {
  startComputerUseHost$,
  heartbeatComputerUseHost$,
  stopComputerUseHost$,
  claimNextComputerUseHostCommand$,
  completeComputerUseHostCommand$,
} from "../services/computer-use.service";

const invalidSession = Object.freeze({
  status: 401 as const,
  body: {
    error: {
      code: "UNAUTHORIZED",
      message: "A valid Clerk session and organization are required",
    },
  },
});
const invalidConnection = Object.freeze({
  status: 409 as const,
  body: {
    error: {
      code: "HOST_CONNECTION_INVALID",
      message: "Computer-use host connection is no longer authorized",
    },
  },
});
const identity$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return auth.tokenType === "session" && auth.sessionId
    ? { userId: auth.userId, orgId: auth.orgId, sessionId: auth.sessionId }
    : null;
});

function sessionRoute<T>(handler$: Command<Promise<T>, [AbortSignal]>) {
  return authRoute(
    {
      requireOrganization: true,
      missingOrganizationStatus: 401,
      accept: ["session"],
    },
    command(async ({ set }, signal: AbortSignal) => {
      const result = await settle(set(handler$, signal), signal);
      if (result.ok) {
        return result.value;
      }
      const rateLimit = clerkRateLimit(result.error);
      if (rateLimit) {
        set(setResHeader$, "Retry-After", String(rateLimit.retryAfterSeconds));
        return {
          status: 429 as const,
          body: {
            error: {
              code: "TOO_MANY_REQUESTS",
              message: "Authentication provider is rate limited",
            },
          },
        };
      }
      if (clerkReadUnavailable(result.error)) {
        return providerUnavailable(
          "Authentication provider is temporarily unavailable",
        );
      }
      throw result.error;
    }),
  );
}

const registerBody$ = bodyResultOf(contract.register);
const register$ = command(async ({ get, set }, signal: AbortSignal) => {
  const identity = get(identity$);
  if (!identity) {
    return invalidSession;
  }
  const body = await get(registerBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    startComputerUseHost$,
    { ...body.data, ...identity },
    signal,
  );
  if (result.status === "upgrade_required") {
    return desktopUpgradeRequired(result.minimumSupportedVersion);
  }
  if (result.status === "invalid_session") {
    return invalidSession;
  }
  return {
    status: 200 as const,
    body: {
      hostId: result.hostId,
      connectionGeneration: result.connectionGeneration,
    },
  };
});

const heartbeatBody$ = bodyResultOf(contract.heartbeat);
const heartbeatParams$ = pathParamsOf(contract.heartbeat);
const heartbeat$ = command(async ({ get, set }, signal: AbortSignal) => {
  const identity = get(identity$);
  if (!identity) {
    return invalidSession;
  }
  const body = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    heartbeatComputerUseHost$,
    { ...get(heartbeatParams$), ...body.data, ...identity },
    signal,
  );
  signal.throwIfAborted();
  if (result.status === "invalid_connection") {
    return invalidConnection;
  }
  return {
    status: 200 as const,
    body: { ok: true as const, hostId: result.hostId },
  };
});

const stopBody$ = bodyResultOf(contract.stop);
const stopParams$ = pathParamsOf(contract.stop);
const stop$ = command(async ({ get, set }, signal: AbortSignal) => {
  const identity = get(identity$);
  if (!identity) {
    return invalidSession;
  }
  const body = await get(stopBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    stopComputerUseHost$,
    { ...get(stopParams$), ...body.data, ...identity },
    signal,
  );
  signal.throwIfAborted();
  if (result.status === "invalid_connection") {
    return invalidConnection;
  }
  return {
    status: 200 as const,
    body: { ok: true as const, hostId: result.hostId },
  };
});

const nextBody$ = bodyResultOf(contract.next);
const nextParams$ = pathParamsOf(contract.next);
const next$ = command(async ({ get, set }, signal: AbortSignal) => {
  const identity = get(identity$);
  if (!identity) {
    return invalidSession;
  }
  const body = await get(nextBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    claimNextComputerUseHostCommand$,
    { ...get(nextParams$), ...body.data, ...identity },
    signal,
  );
  signal.throwIfAborted();
  if (result.status === "upgrade_required") {
    return desktopUpgradeRequired(result.minimumSupportedVersion);
  }
  if (result.status === "invalid_connection") {
    return invalidConnection;
  }
  return result.status === "idle"
    ? { status: 200 as const, body: { status: "idle" as const } }
    : {
        status: 200 as const,
        body: { status: "command" as const, command: result.command },
      };
});

const completeBody$ = bodyResultOf(contract.complete);
const completeParams$ = pathParamsOf(contract.complete);
const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const identity = get(identity$);
  if (!identity) {
    return invalidSession;
  }
  const body = await get(completeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    completeComputerUseHostCommand$,
    { ...get(completeParams$), ...body.data, ...identity },
    signal,
  );
  signal.throwIfAborted();
  if (result.status === "invalid_connection") {
    return invalidConnection;
  }
  if (result.status === "not_found") {
    return notFound("Computer-use command not found");
  }
  if (result.status === "not_running") {
    return conflict("Computer-use command is not running");
  }
  return { status: 200 as const, body: { ok: true as const } };
});

export const computerUseSessionHostRoutes: readonly RouteEntry[] = [
  { route: contract.register, handler: sessionRoute(register$) },
  { route: contract.heartbeat, handler: sessionRoute(heartbeat$) },
  { route: contract.stop, handler: sessionRoute(stop$) },
  { route: contract.next, handler: sessionRoute(next$) },
  { route: contract.complete, handler: sessionRoute(complete$) },
];
