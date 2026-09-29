import { gmailLabelAppliedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray, sql } from "drizzle-orm";

import { command } from "ccstate";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

const GMAIL_EVENT_TYPES = ["gmail-new-message", "gmail-label-applied"] as const;

export async function invalidateGmailAutomationResolvedLabelIds(
  db: Db,
  connectorId: string,
): Promise<void> {
  await db
    .update(workflowAutomations)
    .set({
      eventConfig: sql`${workflowAutomations.eventConfig} - 'resolvedLabelId'`,
    })
    .where(
      and(
        eq(workflowAutomations.eventConnectorId, connectorId),
        eq(workflowAutomations.eventType, "gmail-label-applied"),
      ),
    );
}

export async function resolveGmailAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  return await resolveWorkflowAutomationConnectorId(db, {
    ...args,
    connectorSlug: "gmail",
  });
}

export async function reprojectGmailAutomationsForOwner(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  const automations = await db
    .select({
      id: workflowAutomations.id,
      workflowId: workflowAutomations.workflowId,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        inArray(workflowAutomations.eventType, [...GMAIL_EVENT_TYPES]),
      ),
    );

  for (const automation of automations) {
    const eventConnectorId = await resolveGmailAutomationConnectorId(db, {
      ...args,
      workflowId: automation.workflowId,
    });
    if (automation.eventConnectorId === eventConnectorId) {
      continue;
    }
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
    await db
      .update(workflowAutomations)
      .set({ eventConnectorId, eventConfig })
      .where(eq(workflowAutomations.id, automation.id));
  }
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
