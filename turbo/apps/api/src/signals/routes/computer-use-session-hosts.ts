import { desktopUpgradeRequired } from "../../lib/desktop-compatibility";
import { logger } from "../../lib/log";
import { command, computed, type Command } from "ccstate";
import { computerUseSessionHostsContract as contract } from "@okouai/api-contracts/contracts/computer-use";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import {
  computerUseHostChannelName,
  computerUseCommandsChangedEvent,
} from "@okouai/api-contracts/contracts/realtime";

import { conflict, notFound, providerUnavailable } from "../../lib/error";
import { authRoute } from "../auth/auth-route";
import { organizationAuthContext$ } from "../auth/auth-context";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { clerkRateLimit, clerkReadUnavailable } from "../external/clerk";
import {
  createComputerUseHostRealtimeToken,
  publishUserSignal,
} from "../external/realtime";
import { resolveComputerUseHost$ } from "../services/computer-use-host-auth.service";
import { settle } from "../utils";
import type { RouteEntry } from "../route-entry";
import {
  startComputerUseHost$,
  waitForComputerUseHostCommands$,
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
const L = logger("ComputerUseConnection");
const invalidConnection = Object.freeze(
  createErrorResponse(
    "HOST_CONNECTION_INVALID",
    "Computer-use host connection is no longer authorized",
  ),
);
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
      ...(result.livenessMode !== "heartbeat"
        ? { livenessMode: result.livenessMode }
        : {}),
      connectionGeneration: result.connectionGeneration,
      commandNotifications: {
        channelName: computerUseHostChannelName(
          identity.userId,
          identity.orgId,
          result.hostId,
          result.connectionGeneration,
        ),
        eventName: computerUseCommandsChangedEvent,
      },
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
    body: {
      ok: true as const,
      hostId: result.hostId,
      hasPendingCommands: result.hasPendingCommands,
    },
  };
});

const waitBody$ = bodyResultOf(contract.wait);
const waitParams$ = pathParamsOf(contract.wait);
const wait$ = command(async ({ get, set }, signal: AbortSignal) => {
  const identity = get(identity$);
  if (!identity) {
    return invalidSession;
  }
  const body = await get(waitBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    waitForComputerUseHostCommands$,
    { ...get(waitParams$), ...body.data, ...identity },
    signal,
  );
  if (result.status === "invalid_connection") {
    return invalidConnection;
  }
  return {
    status: 200 as const,
    body: { hasPendingCommands: result.hasPendingCommands },
  };
});

const stateBody$ = bodyResultOf(contract.state);
const stateParams$ = pathParamsOf(contract.state);
const state$ = command(async ({ get, set }, signal: AbortSignal) => {
  const identity = get(identity$);
  if (!identity) {
    return invalidSession;
  }
  const body = await get(stateBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    heartbeatComputerUseHost$,
    { ...get(stateParams$), ...body.data, ...identity },
    signal,
  );
  if (result.status === "invalid_connection") {
    return invalidConnection;
  }
  await publishUserSignal([identity.userId], "computerUseHostsChanged");
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      hostId: result.hostId,
      hasPendingCommands: result.hasPendingCommands,
    },
  };
});

const realtimeTokenBody$ = bodyResultOf(contract.realtimeToken);
const realtimeTokenParams$ = pathParamsOf(contract.realtimeToken);
const realtimeToken$ = command(async ({ get, set }, signal: AbortSignal) => {
  const identity = get(identity$);
  if (!identity) {
    return invalidSession;
  }
  const body = await get(realtimeTokenBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const authority = { ...get(realtimeTokenParams$), ...body.data, ...identity };
  if (!(await set(resolveComputerUseHost$, authority, signal))) {
    return invalidConnection;
  }
  const token = await createComputerUseHostRealtimeToken(authority, signal);
  return { status: 200 as const, body: token };
});

const connectionEventBody$ = bodyResultOf(contract.connectionEvent);
const connectionEventParams$ = pathParamsOf(contract.connectionEvent);
const connectionEvent$ = command(async ({ get, set }, signal: AbortSignal) => {
  const identity = get(identity$);
  if (!identity) {
    return invalidSession;
  }
  const body = await get(connectionEventBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const authority = {
    ...get(connectionEventParams$),
    ...identity,
    connectionGeneration: body.data.connectionGeneration,
  };
  const host = await set(resolveComputerUseHost$, authority, signal);
  if (!host) {
    return invalidConnection;
  }
  L.debug("Desktop notification connection transition", {
    hostId: host.id,
    connectionGeneration: host.connectionGeneration,
    appVersion: host.appVersion,
    mode: host.livenessMode,
    source: "desktop_sdk",
    event: body.data.event,
    reasonCode: body.data.reasonCode,
  });
  return { status: 204 as const, body: undefined };
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
  { route: contract.wait, handler: sessionRoute(wait$) },
  { route: contract.state, handler: sessionRoute(state$) },
  { route: contract.realtimeToken, handler: sessionRoute(realtimeToken$) },
  { route: contract.connectionEvent, handler: sessionRoute(connectionEvent$) },
  { route: contract.stop, handler: sessionRoute(stop$) },
  {
    route: contract.next,
    handler: sessionRoute(next$),
  },
  { route: contract.complete, handler: sessionRoute(complete$) },
];
