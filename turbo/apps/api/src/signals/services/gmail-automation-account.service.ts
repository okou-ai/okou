import { gmailLabelAppliedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray, sql } from "drizzle-orm";

import { command } from "ccstate";
import {
  readWorkflowAutomationConnectorAccount$,
  workflowAutomationConnectorSelectionSql,
} from "./workflow-automation-account.service";

const GMAIL_EVENT_TYPES = ["gmail-new-message", "gmail-label-applied"] as const;

export function gmailAutomationResolvedLabelInvalidationWrite(
  connectorId: string,
) {
  return {
    table: workflowAutomations,
    values: {
      eventConfig: sql`${workflowAutomations.eventConfig} - 'resolvedLabelId'`,
    },
    where: and(
      eq(workflowAutomations.eventConnectorId, connectorId),
      eq(workflowAutomations.eventType, "gmail-label-applied"),
    ),
  };
}

export function gmailAutomationProjectionColumns() {
  return {
    id: workflowAutomations.id,
    workflowId: workflowAutomations.workflowId,
    eventType: workflowAutomations.eventType,
    eventConfig: workflowAutomations.eventConfig,
    eventConnectorId: workflowAutomations.eventConnectorId,
  };
}

export function gmailAutomationProjectionCondition(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.kind, "event"),
    inArray(workflowAutomations.eventType, [...GMAIL_EVENT_TYPES]),
  );
}

export function gmailAutomationProjectionConfig(
  automation: Pick<
    typeof workflowAutomations.$inferSelect,
    "eventType" | "eventConfig"
  >,
) {
  let eventConfig = automation.eventConfig;
  if (automation.eventType === "gmail-label-applied") {
    const config = gmailLabelAppliedEventConfigSchema.parse(
      automation.eventConfig,
    );
    eventConfig = {
      provider: config.provider,
      event: config.event,
      labelName: config.labelName,
    };
  }
  return eventConfig;
}

export const readGmailAutomationConnectorId$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    return await set(
      readWorkflowAutomationConnectorAccount$,
      { ...args, connectorSlug: "gmail" },
      signal,
    );
  },
);

/** SQL only; the caller executes this with its own local write. */
export function gmailSelectedAccountCondition(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly connectorId: string;
  readonly chatAccountAccess?: boolean;
}) {
  return sql`${args.connectorId}::uuid = (
    ${workflowAutomationConnectorSelectionSql({ ...args, workflowId: sql`${args.workflowId}`, connectorSlug: "gmail" })}
  )`;
}
