import { command, computed } from "ccstate";
import {
  runRunnerContract,
  runsByIdContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runWssContract } from "@okouai/api-contracts/contracts/run-wss";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import {
  agentRunById,
  agentRunQueueStatus,
  agentRunRunner,
  organizationTier,
} from "../services/agent-runs.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { bootstrapRunWss$ } from "../services/run-wss.service";
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

const bootstrapWssParams$ = pathParamsOf(runWssContract.bootstrap);
const bootstrapWss$ = authRoute(
  { ...runReadAuth, accept: ["session", "pat"] },
  command(async ({ get, set }, signal: AbortSignal) => {
    const { orgId, userId } = get(organizationAuthContext$);
    const featureContext = await set(
      loadUserFeatureSwitchContext$,
      orgId,
      userId,
      signal,
    );
    if (!isFeatureEnabled(FeatureSwitchKey.RunWss, featureContext)) {
      return notFound("Run WebSocket unavailable");
    }
    const { id: runId } = get(bootstrapWssParams$);
    return await set(bootstrapRunWss$, { runId, orgId, userId }, signal);
  }),
);
const bootstrapWssNoStore$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  return await set(bootstrapWss$, signal);
});

export const runsRoutes: readonly RouteEntry[] = [
  { route: runWssContract.bootstrap, handler: bootstrapWssNoStore$ },
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
