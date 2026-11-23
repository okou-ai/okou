import { command } from "ccstate";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { createWorkflowRecency } from "../services/workflow-recency.service";

const { recentWorkflowIds$, saveRecentWorkflowIds$ } = createWorkflowRecency(
  organizationAuthContext$,
);

const requireWorkflowRecency$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    const auth = get(organizationAuthContext$);
    const context = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.WorkflowRecencySync, context)
      ? null
      : resourceUnavailable("Workflow recency sync is not enabled");
  },
);

const readRecent$ = command(async ({ get, set }, signal: AbortSignal) => {
  const denied = await set(requireWorkflowRecency$, signal);
  if (denied) {
    return denied;
  }
  const workflowIds = await get(recentWorkflowIds$);
  signal.throwIfAborted();
  return { status: 200 as const, body: { workflowIds } };
});

function updateRecent(operation: "use" | "import") {
  const body$ = bodyResultOf(
    operation === "use"
      ? workflowsCollectionContract.recordRecentUse
      : workflowsCollectionContract.importRecent,
  );
  return command(async ({ get, set }, signal: AbortSignal) => {
    const denied = await set(requireWorkflowRecency$, signal);
    if (denied) {
      return denied;
    }
    const body = await get(body$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const workflowIds = await set(
      saveRecentWorkflowIds$,
      { workflowIds: body.data.workflowIds, operation },
      signal,
    );
    return { status: 200 as const, body: { workflowIds } };
  });
}

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;
const writeAuth = { ...readAuth, requiredCapability: "agent:write" } as const;

export const workflowRecencyRoutes: readonly RouteEntry[] = [
  {
    route: workflowsCollectionContract.recent,
    handler: authRoute(readAuth, readRecent$),
  },
  {
    route: workflowsCollectionContract.recordRecentUse,
    handler: authRoute(writeAuth, updateRecent("use")),
  },
  {
    route: workflowsCollectionContract.importRecent,
    handler: authRoute(writeAuth, updateRecent("import")),
  },
];
