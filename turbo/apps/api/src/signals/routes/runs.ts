import { computed } from "ccstate";
import {
  runRunnerContract,
  runsByIdContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import {
  agentRunById,
  agentRunQueueStatus,
  agentRunRunner,
  organizationTier,
} from "../services/agent-runs.service";
import type { RouteEntry } from "../route-entry";

const runReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent-run:read",
} as const;

const runNotFound = notFound("Agent run not found");

const getRunByIdInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runsByIdContract.getById));
  const run = await get(
    agentRunById({ runId: params.id, userId: auth.userId, orgId: auth.orgId }),
  );
  if (!run) {
    return runNotFound;
  }
  return { status: 200 as const, body: run };
});

const getRunRunnerInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runRunnerContract.getRunner));
  const runner = await get(
    agentRunRunner({
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );
  if (!runner) {
    return runNotFound;
  }
  return { status: 200 as const, body: runner };
});

const getRunQueueInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const orgTier = await get(organizationTier(auth.orgId));
  const queue = await get(
    agentRunQueueStatus({
      userId: auth.userId,
      orgId: auth.orgId,
      orgTier,
    }),
  );
  return { status: 200 as const, body: queue };
});

export const runsRoutes: readonly RouteEntry[] = [
  {
    route: runsQueueContract.getQueue,
    handler: authRoute(runReadAuth, getRunQueueInner$),
  },
  {
    route: runRunnerContract.getRunner,
    handler: authRoute(runReadAuth, getRunRunnerInner$),
  },
  {
    route: runsByIdContract.getById,
    handler: authRoute(runReadAuth, getRunByIdInner$),
  },
];
