import { gmailLabelAppliedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray, sql } from "drizzle-orm";

import { command } from "ccstate";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { writeDb$ } from "../external/db";

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
    const db = set(writeDb$);
    const [selection] = await db
      .select({ connectorId: chatThreadConnectorSelections.connectorId })
      .from(workflowUserAutomationThreads)
      .innerJoin(
        chatThreadConnectorSelections,
        and(
          eq(
            chatThreadConnectorSelections.chatThreadId,
            workflowUserAutomationThreads.chatThreadId,
          ),
          eq(chatThreadConnectorSelections.connectorSlug, "gmail"),
        ),
      )
      .where(
        and(
          eq(workflowUserAutomationThreads.orgId, args.orgId),
          eq(workflowUserAutomationThreads.userId, args.userId),
          eq(workflowUserAutomationThreads.workflowId, args.workflowId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (selection) {
      return selection.connectorId;
    }

    const [defaultAccount] = await db
      .select({ connectorId: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, "gmail"),
          eq(connectors.isDefault, true),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return defaultAccount?.connectorId ?? null;
  },
);

/** SQL only; the caller executes this with its own local write. */
export function gmailSelectedAccountCondition(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly connectorId: string;
}) {
  return sql`${args.connectorId}::uuid = (
    SELECT CASE WHEN ${chatThreadConnectorSelections.connectorSlug} IS NOT NULL
      THEN ${chatThreadConnectorSelections.connectorId} ELSE ${connectors.id} END
    FROM (VALUES (1)) AS owner_scope(unused)
    LEFT JOIN ${workflowUserAutomationThreads}
      ON ${workflowUserAutomationThreads.orgId} = ${args.orgId}
      AND ${workflowUserAutomationThreads.userId} = ${args.userId}
      AND ${workflowUserAutomationThreads.workflowId} = ${args.workflowId}
    LEFT JOIN ${chatThreadConnectorSelections}
      ON ${chatThreadConnectorSelections.chatThreadId} = ${workflowUserAutomationThreads.chatThreadId}
      AND ${chatThreadConnectorSelections.connectorSlug} = 'gmail'
    LEFT JOIN ${connectors}
      ON ${connectors.orgId} = ${args.orgId} AND ${connectors.userId} = ${args.userId}
      AND ${connectors.connectorSlug} = 'gmail' AND ${connectors.isDefault}
    LIMIT 1
  )`;
}
