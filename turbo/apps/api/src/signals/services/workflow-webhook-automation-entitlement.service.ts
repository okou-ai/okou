import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  workflowAutomations,
  workflowWebhookAutomations,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  orgPlanCapabilitiesFromRow,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";

const readWorkflowWebhookAutomationCapabilities$ = command(
  async ({ get }, orgId: string): Promise<OrgPlanCapabilities | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        planKey: orgPlanEntitlements.planKey,
        status: orgPlanEntitlements.status,
        baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
        canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
        canBuyCredits: orgPlanEntitlements.canBuyCredits,
        showUsagePack: orgPlanEntitlements.showUsagePack,
        autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
        restrictedBuiltInModels: orgPlanEntitlements.restrictedBuiltInModels,
        workflowWebhookAutomationAllowed:
          orgPlanEntitlements.workflowWebhookTriggerAllowed,
        audioLifetimeLimit: orgPlanEntitlements.audioLifetimeLimit,
        audioDailyRateLimit: orgPlanEntitlements.audioDailyRateLimit,
        audioDailyDurationSeconds:
          orgPlanEntitlements.audioDailyDurationSeconds,
      })
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId))
      .limit(1);
    if (row) {
      return orgPlanCapabilitiesFromRow(row, orgId);
    }
    const [org] = await db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    if (org) {
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    return null;
  },
);

export const disableIneligibleWorkflowWebhookAutomationsForOrg$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<number> => {
    // Keep complete entitlement validation ahead of the original Abort checkpoint.
    const capabilities = await set(
      readWorkflowWebhookAutomationCapabilities$,
      args.orgId,
    );
    signal.throwIfAborted();
    if (capabilities?.workflowWebhookAutomationAllowed === true) {
      return 0;
    }

    const db = set(writeDb$);
    const webhookAutomationIds = db
      .select({ automationId: workflowWebhookAutomations.automationId })
      .from(workflowWebhookAutomations);
    const currentTime = nowDate();
    const disabled = db.$with("disabled_workflow_webhooks").as(
      db
        .update(workflowAutomations)
        .set({ enabled: false, updatedAt: currentTime })
        .where(
          and(
            eq(workflowAutomations.orgId, args.orgId),
            eq(workflowAutomations.enabled, true),
            inArray(workflowAutomations.id, webhookAutomationIds),
          ),
        )
        .returning({ id: workflowAutomations.id }),
    );
    const marked = db.$with("marked_workflow_webhooks").as(
      db
        .update(workflowWebhookAutomations)
        .set({ disabledReason: "paid_plan_required", updatedAt: currentTime })
        .where(
          inArray(
            workflowWebhookAutomations.automationId,
            db.select({ id: disabled.id }).from(disabled),
          ),
        )
        .returning({ automationId: workflowWebhookAutomations.automationId }),
    );
    // Exhaust the dependent write while retaining the true parent result,
    // including a parent whose configuration was concurrently removed.
    const rows = await db
      .with(disabled, marked)
      .select({ id: disabled.id })
      .from(disabled)
      .leftJoin(marked, eq(marked.automationId, disabled.id));
    // Cancellation propagates after the coherent pair has committed.
    signal.throwIfAborted();
    return rows.length;
  },
);
