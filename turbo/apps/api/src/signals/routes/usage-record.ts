import { command } from "ccstate";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { usageRecord$ } from "../services/usage-record.service";
import type { RouteEntry } from "../route-entry";
import { isValidTimeZone } from "../utils";

function teamUsageRecordsUnavailable() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Team usage records are aggregated by member",
        code: "FORBIDDEN",
      },
    },
  };
}

const getUsageRecordInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(usageRecordContract.get));

    if (!isValidTimeZone(query.tz)) {
      return badRequestMessage(`Invalid timezone: ${query.tz}`);
    }

    if (query.scope === "team") {
      return teamUsageRecordsUnavailable();
    }

    const body = await set(
      usageRecord$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        scope: query.scope,
        range: query.range,
        tz: query.tz,
        page: query.page,
        pageSize: query.pageSize,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body };
  },
);

export const usageRecordRoutes: readonly RouteEntry[] = [
  {
    route: usageRecordContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsageRecordInner$,
    ),
  },
];
