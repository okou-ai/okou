import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

export interface PreparedAutomationDisabledNotification {
  readonly automationId: string;
  readonly workflowId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly automationName: string;
  readonly disabledAt: string;
  readonly deliveryKey: string;
}

/** Prepare the owner's audience before the owning atomic disable statement. */
export const prepareAutomationDisabledNotification$ = command(
  async (
    { get, set },
    automation: typeof workflowAutomations.$inferSelect,
    disabledAt: Date,
    signal?: AbortSignal,
  ): Promise<PreparedAutomationDisabledNotification | null> => {
    if (
      !automation.enabled ||
      automation.kind !== "schedule" ||
      (automation.scheduleType !== "cron" && automation.scheduleType !== "loop")
    ) {
      return null;
    }
    const context = await set(
      loadUserFeatureSwitchContext$,
      automation.orgId,
      automation.ownerUserId,
      signal,
    );
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.AutomationDisableNotifications,
        context,
      ) ||
      !isFeatureEnabled(FeatureSwitchKey.UserNotifications, context)
    ) {
      return null;
    }
    const [workflow] = await get(db$)
      .select({ name: workflows.name })
      .from(workflows)
      .where(
        and(
          eq(workflows.id, automation.workflowId),
          eq(workflows.orgId, automation.orgId),
        ),
      )
      .limit(1);
    signal?.throwIfAborted();
    return {
      automationId: automation.id,
      workflowId: automation.workflowId,
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      automationName: (workflow?.name.trim() || "Scheduled automation").slice(
        0,
        200,
      ),
      disabledAt: disabledAt.toISOString(),
      // This identity belongs to this attempted transition, not the automation's lifetime.
      deliveryKey: `automation-disabled:${automation.id}:${crypto.randomUUID()}`,
    };
  },
);
