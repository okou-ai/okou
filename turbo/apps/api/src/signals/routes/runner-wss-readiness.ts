import { runnerWssReadinessContract } from "@okouai/api-contracts/contracts/runner-wss-readiness";
import { command } from "ccstate";

import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  authenticateWssHost,
  renewLocalWssEndpoint,
  resolveLocalWssEndpoint,
  withdrawLocalWssEndpoint,
} from "../services/runner-wss-readiness.service";

function error(status: 400 | 401 | 409 | 503, code: string, message: string) {
  return { status, body: { error: { code, message } } };
}

const renew$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const identity = authenticateWssHost(get(authorization$));
  if (identity.status === "disabled") {
    return error(
      503,
      "PROVIDER_UNAVAILABLE",
      "WSS host registration is disabled",
    );
  }
  if (identity.status === "unauthorized") {
    return error(401, "UNAUTHORIZED", "WSS host authentication required");
  }
  const body = await get(bodyResultOf(runnerWssReadinessContract.renew));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runnerId } = get(pathParamsOf(runnerWssReadinessContract.renew));
  const result = await renewLocalWssEndpoint(
    set(writeDb$),
    identity.host,
    runnerId,
    body.data.proof.observedAt,
  );
  signal.throwIfAborted();
  if (result.status === "invalid-proof") {
    return error(400, "BAD_REQUEST", "Stale local listener proof");
  }
  if (result.status === "host-conflict") {
    return error(409, "CONFLICT", "Runner ID is bound to a different host");
  }
  return {
    status: 200 as const,
    body: { leaseExpiresAt: result.expiresAt.toISOString() },
  };
});

const status$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const identity = authenticateWssHost(get(authorization$));
  if (identity.status === "disabled") {
    return error(
      503,
      "PROVIDER_UNAVAILABLE",
      "WSS host registration is disabled",
    );
  }
  if (identity.status === "unauthorized") {
    return error(401, "UNAUTHORIZED", "WSS host authentication required");
  }
  const { runnerId } = get(pathParamsOf(runnerWssReadinessContract.status));
  const endpoint = await resolveLocalWssEndpoint(set(writeDb$), runnerId);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      localReady: endpoint?.hostId === identity.host.id,
      publicIngressReady: false as const,
    },
  };
});

const withdraw$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const identity = authenticateWssHost(get(authorization$));
  if (identity.status === "disabled") {
    return error(
      503,
      "PROVIDER_UNAVAILABLE",
      "WSS host registration is disabled",
    );
  }
  if (identity.status === "unauthorized") {
    return error(401, "UNAUTHORIZED", "WSS host authentication required");
  }
  const { runnerId } = get(pathParamsOf(runnerWssReadinessContract.withdraw));
  await withdrawLocalWssEndpoint(set(writeDb$), identity.host, runnerId);
  signal.throwIfAborted();
  return { status: 200 as const, body: { ok: true as const } };
});

export const runnerWssReadinessRoutes: readonly RouteEntry[] = [
  { route: runnerWssReadinessContract.renew, handler: renew$ },
  { route: runnerWssReadinessContract.status, handler: status$ },
  { route: runnerWssReadinessContract.withdraw, handler: withdraw$ },
];
