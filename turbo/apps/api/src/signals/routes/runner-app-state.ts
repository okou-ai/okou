import { command } from "ccstate";
import { runnerAppStateContract } from "@okouai/api-contracts/contracts/computer-use";
import { runnerAuth$ } from "../auth/runner-auth";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { currentAppStateTransfer$ } from "../services/computer-use-app-state-transfer.service";
import type { RouteEntry } from "../route-entry";

const check$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth || auth.type !== "official-runner") {
    return {
      status: auth ? (403 as const) : (401 as const),
      body: {
        error: {
          code: auth ? "FORBIDDEN" : "UNAUTHORIZED",
          message: "Official Runner authentication required",
        },
      },
    };
  }
  const body = await get(bodyResultOf(runnerAppStateContract.check));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId, commandId } = get(pathParamsOf(runnerAppStateContract.check));
  const grant = await set(currentAppStateTransfer$, runId, commandId, signal);
  signal.throwIfAborted();
  if (
    !grant ||
    grant.runnerId !== body.data.runnerId ||
    grant.heartbeatGeneration !== body.data.heartbeatGeneration
  ) {
    return {
      status: 404 as const,
      body: {
        error: { code: "NOT_FOUND", message: "App state transfer unavailable" },
      },
    };
  }
  return {
    status: 200 as const,
    body: { hostId: grant.hostId, claimed: grant.claimed },
  };
});

export const runnerAppStateRoutes: readonly RouteEntry[] = [
  {
    route: runnerAppStateContract.check,
    handler: check$,
  },
];
