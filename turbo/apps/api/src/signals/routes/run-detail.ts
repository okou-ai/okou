import { computed } from "ccstate";
import {
  runTelemetryEventsContract,
  runContextContract,
  runNetworkLogsContract,
} from "@okouai/api-contracts/contracts/run-routes";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { notFound } from "../../lib/error";
import {
  runAgentEvents,
  runContext,
  runNetworkLogs,
} from "../services/run-detail.service";
import type { RouteEntry } from "../route-entry";

const runReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent-run:read",
} as const;

const runNotFound = notFound("Agent run not found");

const getContextInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runContextContract.getContext));
  const result = await get(runContext(params.id, auth.userId, auth.orgId));
  if (result.kind === "not-found") {
    return runNotFound;
  }
  if (result.kind === "no-snapshot") {
    return notFound("Run context not available");
  }
  return { status: 200 as const, body: result.context };
});

const getNetworkLogsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runNetworkLogsContract.getNetworkLogs));
  const query = get(queryOf(runNetworkLogsContract.getNetworkLogs));
  const result = await get(
    runNetworkLogs({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      since: query.since,
      sinceTime: query.sinceTime,
      cursor: query.cursor,
      limit: query.limit,
      order: query.order,
    }),
  );
  if (!result) {
    return runNotFound;
  }
  return { status: 200 as const, body: result };
});

const getTelemetryEventsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(
    pathParamsOf(runTelemetryEventsContract.getTelemetryEvents),
  );
  const query = get(queryOf(runTelemetryEventsContract.getTelemetryEvents));
  const result = await get(
    runAgentEvents({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      since: query.since,
      sinceTime: query.sinceTime,
      cursor: query.cursor,
      limit: query.limit,
      order: query.order,
    }),
  );
  if (!result) {
    return runNotFound;
  }
  return { status: 200 as const, body: result };
});

const telemetryEventsHandler = authRoute(runReadAuth, getTelemetryEventsInner$);

export const runDetailRoutes: readonly RouteEntry[] = [
  {
    route: runContextContract.getContext,
    handler: authRoute(runReadAuth, getContextInner$),
  },
  {
    route: runNetworkLogsContract.getNetworkLogs,
    handler: authRoute(runReadAuth, getNetworkLogsInner$),
  },
  {
    route: runTelemetryEventsContract.getTelemetryEvents,
    handler: telemetryEventsHandler,
  },
  {
    // Older Activity tabs still request the original URL.
    route: {
      ...runTelemetryEventsContract.getTelemetryEvents,
      path: "/api/runs/:id/telemetry/agent",
    },
    handler: telemetryEventsHandler,
  },
];
