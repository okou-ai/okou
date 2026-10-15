import { command } from "ccstate";
import { runnersRunStartupContract } from "@okouai/api-contracts/contracts/runner-startup";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNull, or } from "drizzle-orm";

import { conflict, notFound } from "../../lib/error";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const startupBody$ = bodyResultOf(runnersRunStartupContract.setStartup);
const setStartup$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(startupBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { runId } = get(pathParamsOf(runnersRunStartupContract.setStartup));
  const auth = getSandboxAuthForRun(runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  const { sandboxStartupPath } = bodyResult.data;
  const ownedRun = and(
    eq(agentRuns.id, runId),
    eq(agentRuns.userId, auth.userId),
    eq(agentRuns.orgId, auth.orgId),
  );
  // The first actual resource is immutable; identical replay remains successful.
  const [updated] = await set(writeDb$)
    .update(agentRuns)
    .set({ sandboxStartupPath })
    .where(
      and(
        ownedRun,
        or(
          isNull(agentRuns.sandboxStartupPath),
          eq(agentRuns.sandboxStartupPath, sandboxStartupPath),
        ),
      ),
    )
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (updated) {
    return { status: 204 as const, body: undefined };
  }

  const [run] = await get(db$)
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(ownedRun)
    .limit(1);
  signal.throwIfAborted();
  return run
    ? conflict("Sandbox startup path is already recorded")
    : notFound("Agent run not found");
});

export const runnersStartupRoutes: readonly RouteEntry[] = [
  { route: runnersRunStartupContract.setStartup, handler: setStartup$ },
];
