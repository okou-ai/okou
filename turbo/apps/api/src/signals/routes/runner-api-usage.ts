import { runnerApiUsageContract } from "@okouai/api-contracts/contracts/runner-api-usage";
import { command } from "ccstate";

import { runnerAuth$ } from "../auth/runner-auth";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { readRunnerApiUsage } from "../services/pi-api-usage-observation.service";

const readApiUsage$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth) {
    return {
      status: 401 as const,
      body: {
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      },
    };
  }
  if (auth.type !== "official-runner") {
    return {
      status: 403 as const,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "Only official runners can read API usage",
        },
      },
    };
  }
  const body = await get(bodyResultOf(runnerApiUsageContract.read));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerApiUsageContract.read));
  const result = await readRunnerApiUsage(
    get(db$),
    { runId, ...body.data },
    signal,
  );
  return { status: 200 as const, body: result };
});

export const runnerApiUsageRoutes: readonly RouteEntry[] = [
  { route: runnerApiUsageContract.read, handler: readApiUsage$ },
];
