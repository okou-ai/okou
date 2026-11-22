import { computed } from "ccstate";
import {
  logsByIdContract,
  logsListContract,
} from "@okouai/api-contracts/contracts/logs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { notFound } from "../../lib/error";
import { logDetail, logsList } from "../services/logs.service";
import type { RouteEntry } from "../route-entry";

const runReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent-run:read",
} as const;

const logNotFound = notFound("Log not found");

const getLogsListInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(logsListContract.list));
  const result = await get(
    logsList({
      userId: auth.userId,
      orgId: auth.orgId,
      cursor: query.cursor,
      limit: query.limit,
      since: query.since,
      status: query.status,
      triggerSource: query.triggerSource,
    }),
  );
  return { status: 200 as const, body: result };
});

const getLogByIdInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(logsByIdContract.getById));
  const detail = await get(
    logDetail({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );
  if (!detail) {
    return logNotFound;
  }
  return { status: 200 as const, body: detail };
});

export const logsRoutes: readonly RouteEntry[] = [
  {
    route: logsListContract.list,
    handler: authRoute(runReadAuth, getLogsListInner$),
  },
  {
    route: logsByIdContract.getById,
    handler: authRoute(runReadAuth, getLogByIdInner$),
  },
];
