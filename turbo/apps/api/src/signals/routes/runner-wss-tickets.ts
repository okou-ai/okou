import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { command } from "ccstate";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { runnerAuth$ } from "../auth/runner-auth";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  consumeRunnerWssTicket,
  issueRunnerWssTicket,
  revokeRunnerWssTickets,
} from "../services/runner-wss-ticket.service";

const unavailable = notFound("WSS connection unavailable");
const ownerAuth = {
  accept: ["session"],
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const bootstrapInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = get(organizationAuthContext$);
  const params = get(pathParamsOf(runnerWssTicketsContract.bootstrap));
  const result = await issueRunnerWssTicket(set(writeDb$), {
    runId: params.runId,
    owner: { orgId: owner.orgId, userId: owner.userId },
  });
  signal.throwIfAborted();
  return result ? { status: 200 as const, body: result } : unavailable;
});

const revokeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = get(organizationAuthContext$);
  const params = get(pathParamsOf(runnerWssTicketsContract.revoke));
  const revoked = await revokeRunnerWssTickets(set(writeDb$), {
    runId: params.runId,
    owner: { orgId: owner.orgId, userId: owner.userId },
  });
  signal.throwIfAborted();
  return revoked ? { status: 204 as const, body: undefined } : unavailable;
});

const bootstrap$ = authRoute(ownerAuth, bootstrapInner$);
const revoke$ = authRoute(ownerAuth, revokeInner$);

// Set no-store even when authentication is rejected before the inner handler.
const sessionBootstrap$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  return await set(bootstrap$, signal);
});
const sessionRevoke$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  return await set(revoke$, signal);
});

const consume$ = command(async ({ get, set }, signal: AbortSignal) => {
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
        error: { code: "FORBIDDEN", message: "Official Runner required" },
      },
    };
  }
  const body = await get(bodyResultOf(runnerWssTicketsContract.consume));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await consumeRunnerWssTicket(set(writeDb$), body.data);
  signal.throwIfAborted();
  return result ? { status: 200 as const, body: result } : unavailable;
});

export const runnerWssTicketRoutes: readonly RouteEntry[] = [
  { route: runnerWssTicketsContract.bootstrap, handler: sessionBootstrap$ },
  { route: runnerWssTicketsContract.consume, handler: consume$ },
  { route: runnerWssTicketsContract.revoke, handler: sessionRevoke$ },
];
