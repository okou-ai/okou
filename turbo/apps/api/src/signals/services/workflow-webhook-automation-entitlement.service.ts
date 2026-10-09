import { and, eq, inArray } from "drizzle-orm";
import {
  workflowAutomations,
  workflowWebhookAutomations,
} from "@okouai/db/schema/workflow";
import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import type { Tx } from "../../lib/db-types";

type DbTransaction = Tx;

export async function lockWorkflowWebhookAutomationTierEligibleForOrg(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const capabilities = await loadOrgPlanCapabilities(tx, args.orgId, {
    forUpdate: true,
  });
  signal.throwIfAborted();
  return capabilities?.workflowWebhookAutomationAllowed === true;
}

export async function disableIneligibleWorkflowWebhookAutomationsForOrg(
  db: Db,
  args: {
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<number> {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0350; new non-billing transactions are prohibited.
  return await db.transaction(async (tx) => {
    const tierEligible = await lockWorkflowWebhookAutomationTierEligibleForOrg(
      tx,
      args,
      signal,
    );
    if (tierEligible) {
      return 0;
    }

    const webhookAutomationIds = tx
      .select({ automationId: workflowWebhookAutomations.automationId })
      .from(workflowWebhookAutomations);
    const currentTime = nowDate();
    const disabled = await tx
      .update(workflowAutomations)
      .set({ enabled: false, updatedAt: currentTime })
      .where(
        and(
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.enabled, true),
          inArray(workflowAutomations.id, webhookAutomationIds),
        ),
      )
      .returning({ id: workflowAutomations.id });
    signal.throwIfAborted();
    if (disabled.length === 0) {
      return 0;
    }

    await tx
      .update(workflowWebhookAutomations)
      .set({
        disabledReason: "paid_plan_required",
        updatedAt: currentTime,
      })
      .where(
        inArray(
          workflowWebhookAutomations.automationId,
          disabled.map((automation) => {
            return automation.id;
          }),
        ),
      );
    signal.throwIfAborted();
    return disabled.length;
  });
}
