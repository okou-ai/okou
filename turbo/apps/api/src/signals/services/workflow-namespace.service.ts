import { computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { and, eq, sql } from "drizzle-orm";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";
import { createUserFeatureSwitchContext } from "./feature-switches.service";

const memberSwitchContext$ = createUserFeatureSwitchContext(
  organizationAuthContext$,
);

/** Run requests use the admitted snapshot, never the member's live override. */
const workflowSingleAgent$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType === "agent" || auth.tokenType === "sandbox") {
    const [run] = await get(db$)
      .select({
        enabled:
          sql`COALESCE(${runnerJobQueue.executionContext}->'featureFlags'->>'singleAgent' = 'true', false)`.mapWith(
            pgBooleanDecoder,
          ),
      })
      .from(runnerJobQueue)
      .innerJoin(agentRuns, eq(agentRuns.id, runnerJobQueue.runId))
      .innerJoin(
        orgMetadata,
        and(
          eq(orgMetadata.orgId, agentRuns.orgId),
          eq(orgMetadata.defaultAgentId, agentRuns.agentId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, auth.runId),
          eq(agentRuns.orgId, auth.orgId),
          eq(agentRuns.userId, auth.userId),
        ),
      )
      .limit(1);
    return run?.enabled === true;
  }
  return isFeatureEnabled(
    FeatureSwitchKey.SingleAgent,
    await get(memberSwitchContext$),
  );
});

export const workflowNamespace$ = computed(async (get) => {
  if (!(await get(workflowSingleAgent$))) {
    return null;
  }
  const auth = get(organizationAuthContext$);
  const [org] = await get(db$)
    .select({ id: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, auth.orgId))
    .limit(1);
  if (!org?.id) {
    throw new Error("Workspace default executor is unavailable");
  }
  return org.id;
});
