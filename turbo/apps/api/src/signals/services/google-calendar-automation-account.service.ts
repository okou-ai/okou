import { command } from "ccstate";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray, sql } from "drizzle-orm";

import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

export const GOOGLE_CALENDAR_EVENT_TYPES = [
  "google-calendar-event-created",
  "google-calendar-event-updated",
  "google-calendar-event-cancelled",
] as const;

export const GOOGLE_CALENDAR_PRIMARY_ID = "primary";

export async function resolveGoogleCalendarAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  return await resolveWorkflowAutomationConnectorId(db, {
    ...args,
    connectorSlug: "google-calendar",
  });
}

export async function reprojectGoogleCalendarAutomationsForOwner(
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
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        inArray(workflowAutomations.eventType, [
          ...GOOGLE_CALENDAR_EVENT_TYPES,
        ]),
      ),
    );

  for (const automation of automations) {
    const eventConnectorId = await resolveGoogleCalendarAutomationConnectorId(
      db,
      {
        ...args,
        workflowId: automation.workflowId,
      },
    );
    if (automation.eventConnectorId === eventConnectorId) {
      continue;
    }
    await db
      .update(workflowAutomations)
      .set({ eventConnectorId })
      .where(eq(workflowAutomations.id, automation.id));
  }
}

/**
 * Publish the selected business source. No row locks: the desired account is
 * read from the statement snapshot and the conditional UPDATE re-checks the
 * current target row, so a concurrent reprojection leaves nothing to change.
 */
export function googleCalendarAccountProjectionStatement(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  const eventTypes = inArray(workflowAutomations.eventType, [
    ...GOOGLE_CALENDAR_EVENT_TYPES,
  ]);
  return sql`
    WITH desired AS (
      SELECT ${workflowAutomations.id} AS id,
        CASE WHEN ${chatThreadConnectorSelections.connectorSlug} IS NOT NULL
          THEN ${chatThreadConnectorSelections.connectorId}
          ELSE ${connectors.id} END AS connector_id
      FROM ${workflowAutomations}
      LEFT JOIN ${workflowUserAutomationThreads}
        ON ${workflowUserAutomationThreads.orgId} = ${workflowAutomations.orgId}
        AND ${workflowUserAutomationThreads.userId} = ${workflowAutomations.ownerUserId}
        AND ${workflowUserAutomationThreads.workflowId} = ${workflowAutomations.workflowId}
      LEFT JOIN ${chatThreadConnectorSelections}
        ON ${chatThreadConnectorSelections.chatThreadId} = ${workflowUserAutomationThreads.chatThreadId}
        AND ${chatThreadConnectorSelections.connectorSlug} = 'google-calendar'
      LEFT JOIN ${connectors}
        ON ${connectors.orgId} = ${args.orgId}
        AND ${connectors.userId} = ${args.userId}
        AND ${connectors.connectorSlug} = 'google-calendar'
        AND ${connectors.isDefault}
      WHERE ${workflowAutomations.orgId} = ${args.orgId}
        AND ${workflowAutomations.ownerUserId} = ${args.userId}
        AND ${workflowAutomations.kind} = 'event'
        AND ${eventTypes}
    )
    UPDATE ${workflowAutomations}
    SET event_connector_id = desired.connector_id
    FROM desired
    WHERE ${workflowAutomations.id} = desired.id
      AND ${workflowAutomations.kind} = 'event'
      AND ${eventTypes}
      AND ${workflowAutomations.eventConnectorId} IS DISTINCT FROM desired.connector_id
  `;
}

export const readGoogleCalendarAutomationConnectorId$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
    },
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
          eq(chatThreadConnectorSelections.connectorSlug, "google-calendar"),
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
    if (selection) {
      return selection.connectorId;
    }
    const [account] = await db
      .select({ connectorId: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, "google-calendar"),
          eq(connectors.isDefault, true),
        ),
      )
      .limit(1);
    return account?.connectorId ?? null;
  },
);

/** SQL only; the caller executes this with its own local write. */
export function googleCalendarSelectedAccountCondition(args: {
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
      AND ${chatThreadConnectorSelections.connectorSlug} = 'google-calendar'
    LEFT JOIN ${connectors}
      ON ${connectors.orgId} = ${args.orgId} AND ${connectors.userId} = ${args.userId}
      AND ${connectors.connectorSlug} = 'google-calendar' AND ${connectors.isDefault}
    LIMIT 1
  )`;
}
