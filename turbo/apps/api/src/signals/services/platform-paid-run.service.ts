import { agentRuns } from "@okouai/db/runtime/agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { writeDb$ } from "../external/db";

/** Delayed usage settles against the policy that the Run captured at admission. */
export const platformPaidCreditPolicies = [
  "platform_proactive",
  "official_workflow_free",
] as const;

export function isPlatformPaidPolicy(
  policy:
    typeof billingRunAttribution.$inferSelect.creditChargePolicy | undefined,
) {
  return platformPaidCreditPolicies.some((paid) => {
    return paid === policy;
  });
}

/** New paid tool requests require a running Run with a matching member and workspace. */
export const platformPaidRunCreditAccess$ = command(
  async (
    { set },
    owner: {
      readonly runId?: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    if (!owner.runId) {
      return "standard";
    }
    const [paid] = await set(writeDb$)
      .select({ activeRunId: agentRuns.id })
      .from(billingRunAttribution)
      .leftJoin(
        agentRuns,
        and(
          eq(agentRuns.id, billingRunAttribution.runId),
          eq(agentRuns.orgId, billingRunAttribution.orgId),
          eq(agentRuns.userId, billingRunAttribution.userId),
          eq(agentRuns.status, "running"),
        ),
      )
      .where(
        and(
          eq(billingRunAttribution.runId, owner.runId),
          eq(billingRunAttribution.orgId, owner.orgId),
          eq(billingRunAttribution.userId, owner.userId),
          inArray(billingRunAttribution.creditChargePolicy, [
            ...platformPaidCreditPolicies,
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!paid) {
      return "standard";
    }
    return paid.activeRunId === null ? "closed" : "free";
  },
);
