import { googleFormsResponseSubmittedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, asc, eq } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

export async function resolveGoogleFormsAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  return await resolveWorkflowAutomationConnectorId(db, {
    ...args,
    connectorSlug: "google-forms",
  });
}

/** A changed selected account is unavailable until its watch interval is ready. */
export function googleFormsAccountProjectionMutation(
  automation: {
    readonly enabled: boolean;
    readonly eventConfig: unknown;
    readonly eventConnectorId: string | null;
  },
  desiredConnectorId: string | null,
) {
  const config = googleFormsResponseSubmittedEventConfigSchema.parse(
    automation.eventConfig,
  );
  const sourceChanged =
    desiredConnectorId === null ||
    config.connectorId !== desiredConnectorId ||
    (automation.eventConnectorId !== null &&
      automation.eventConnectorId !== desiredConnectorId);
  const eventConfig =
    desiredConnectorId === null || config.connectorId === desiredConnectorId
      ? config
      : { ...config, connectorId: desiredConnectorId };
  const eventConnectorId =
    automation.enabled &&
    (sourceChanged || automation.eventConnectorId === null)
      ? null
      : desiredConnectorId;
  const changed =
    automation.eventConnectorId !== eventConnectorId ||
    eventConfig.connectorId !== config.connectorId;
  return { eventConfig, eventConnectorId, changed };
}

export async function reprojectGoogleFormsAutomationsForOwner(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  const automations = await db
    .select({
      id: workflowAutomations.id,
      enabled: workflowAutomations.enabled,
      workflowId: workflowAutomations.workflowId,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "google-forms-response-submitted"),
      ),
    )
    .orderBy(asc(workflowAutomations.id))
    .for("update");

  for (const automation of automations) {
    const desiredConnectorId = await resolveGoogleFormsAutomationConnectorId(
      db,
      {
        ...args,
        workflowId: automation.workflowId,
      },
    );
    const mutation = googleFormsAccountProjectionMutation(
      automation,
      desiredConnectorId,
    );
    if (!mutation.changed) {
      continue;
    }
    // Owning account writers already hold the account compatibility key. Match
    // publication's automation-before-cursor row order, including without 1290.
    await db
      .update(workflowAutomations)
      .set({
        eventConnectorId: mutation.eventConnectorId,
        eventConfig: mutation.eventConfig,
      })
      .where(eq(workflowAutomations.id, automation.id));
    await db
      .delete(googleFormsAutomationCursors)
      .where(eq(googleFormsAutomationCursors.automationId, automation.id));
  }
}
