import { dataRouterRequestContract } from "@okouai/api-contracts/contracts/data-router";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { dataRouterRequests } from "@okouai/db/schema/data-router-request";
import { and, eq } from "drizzle-orm";
import { command } from "ccstate";
import { conflict, notFound } from "../../lib/error";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const body$ = bodyResultOf(dataRouterRequestContract.register);
const register$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) return body.response;
  const auth = getSandboxAuthForRun(body.data.runId, get(authorization$));
  if (!auth) return unauthorizedRunMismatch;
  const db = set(writeDb$);
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.userId, auth.userId),
        eq(agentRuns.orgId, auth.orgId),
        eq(agentRuns.status, "running"),
      ),
    );
  signal.throwIfAborted();
  if (!run) return notFound("Active Run not found");
  const [registered] = await db
    .insert(dataRouterRequests)
    .values({ requestId: body.data.requestId, runId: run.id })
    .onConflictDoNothing()
    .returning({ requestId: dataRouterRequests.requestId });
  signal.throwIfAborted();
  if (!registered) return conflict("Data Router request already registered");
  return { status: 200 as const, body: { success: true as const } };
});

export const webhooksAgentDataRequestRoutes: readonly RouteEntry[] = [
  { route: dataRouterRequestContract.register, handler: register$ },
];
