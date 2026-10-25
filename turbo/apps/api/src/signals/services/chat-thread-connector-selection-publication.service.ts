import type { ConnectorAccountSelection } from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  and,
  count,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { WithSubquery } from "drizzle-orm/subquery";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { googleFormsAccountProjectionUpdate } from "./google-forms-automation-account.service";
import {
  NOTION_ACCOUNT_CHANGED_SKIP_REASON,
  notionPendingEventsSkipWrite,
} from "./notion-automation-account.service";
import {
  preparedDefaultAccountProjectionPlan,
  workflowAutomationOwnerProjectionReadPlan,
  workflowAutomationProjectionValues,
  type PreparedDefaultAccountProjection,
} from "./workflow-automation-account-projection.service";
import {
  workflowAutomationDefaultAccountReadPlan,
  workflowAutomationSelectedAccountReadPlan,
} from "./workflow-automation-account.service";

interface UpdateThreadSelectionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly selection: ConnectorAccountSelection;
}

function updatedThreadSelectionPlan(args: UpdateThreadSelectionArgs) {
  const query = new QueryBuilder();
  const account = query
    .$with("selected_connector_account")
    .as(
      query
        .select({ id: connectors.id })
        .from(connectors)
        .where(eq(connectors.id, args.selection.connectionId)),
    );
  const target =
    args.selection.target.kind === "builtin"
      ? {
          connectorSlug: args.selection.target.connectorSlug,
          customConnectorId: null,
        }
      : {
          connectorSlug: null,
          customConnectorId: args.selection.target.customConnectorId,
        };
  return {
    account,
    source: sql`SELECT ${args.chatThreadId}::uuid, ${account.id}, ${target.connectorSlug}::varchar, ${target.customConnectorId}::uuid FROM ${account}`,
    conflict: {
      target:
        args.selection.target.kind === "builtin"
          ? [
              chatThreadConnectorSelections.chatThreadId,
              chatThreadConnectorSelections.connectorSlug,
            ]
          : [
              chatThreadConnectorSelections.chatThreadId,
              chatThreadConnectorSelections.customConnectorId,
            ],
      targetWhere: isNotNull(
        args.selection.target.kind === "builtin"
          ? chatThreadConnectorSelections.connectorSlug
          : chatThreadConnectorSelections.customConnectorId,
      ),
      set: { connectorId: args.selection.connectionId },
    },
  };
}

/** Read generic projections with the requested thread selection overlaid. */
const prepareUpdatedThreadProjections$ = command(
  async (
    { set },
    args: UpdateThreadSelectionArgs,
    signal: AbortSignal,
  ): Promise<readonly PreparedDefaultAccountProjection[]> => {
    const plan = workflowAutomationOwnerProjectionReadPlan({
      ...args,
      target: args.selection.target,
    });
    if (!plan) {
      return [];
    }
    const db = set(writeDb$);
    const automations = await db
      .select(plan.columns)
      .from(workflowAutomations)
      .where(plan.where);
    signal.throwIfAborted();
    const projections: PreparedDefaultAccountProjection[] = [];
    for (const automation of automations) {
      const scope = {
        orgId: args.orgId,
        userId: args.userId,
        workflowId: automation.workflowId,
        connectorSlug: plan.connectorSlug,
      };
      const selected = workflowAutomationSelectedAccountReadPlan(scope);
      const [thread] = await db
        .select({
          chatThreadId: workflowUserAutomationThreads.chatThreadId,
          selectedChatThreadId: chatThreadConnectorSelections.chatThreadId,
          connectorId: chatThreadConnectorSelections.connectorId,
        })
        .from(selected.from)
        .leftJoin(selected.join.table, selected.join.on)
        .where(selected.where)
        .limit(selected.limit);
      signal.throwIfAborted();
      let connectorId: string | null;
      if (thread?.chatThreadId === args.chatThreadId) {
        connectorId = args.selection.connectionId;
      } else if (
        thread?.selectedChatThreadId !== undefined &&
        thread.selectedChatThreadId !== null
      ) {
        connectorId = thread.connectorId;
      } else {
        const fallback = workflowAutomationDefaultAccountReadPlan(scope);
        const [account] = await db
          .select(fallback.columns)
          .from(fallback.from)
          .where(fallback.where)
          .limit(fallback.limit);
        signal.throwIfAborted();
        connectorId = account?.connectorId ?? null;
      }
      const values = workflowAutomationProjectionValues(
        automation,
        connectorId,
        plan.connectorSlug,
      );
      if (values !== null) {
        const eventConfig =
          "eventConfig" in values ? values.eventConfig : undefined;
        projections.push({
          id: automation.id,
          connector_id: values.eventConnectorId,
          replace_config: eventConfig !== undefined,
          event_config: eventConfig === undefined ? null : eventConfig,
        });
      }
    }
    return projections;
  },
);

const publishUpdatedFormsSelection$ = command(
  async (
    { set },
    args: UpdateThreadSelectionArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const insert = updatedThreadSelectionPlan(args);
    const updated = db
      .$with("updated_thread_connector_selection")
      .as(
        db
          .with(insert.account)
          .insert(chatThreadConnectorSelections)
          .select(insert.source)
          .onConflictDoUpdate(insert.conflict)
          .returning({
            connectorId: chatThreadConnectorSelections.connectorId,
          }),
      );
    const changed = db
      .$with("changed_thread_forms_automations", { id: workflowAutomations.id })
      .as(
        googleFormsAccountProjectionUpdate({
          orgId: args.orgId,
          userId: args.userId,
          selectedThread: {
            chatThreadId: args.chatThreadId,
            connectorId: args.selection.connectionId,
          },
          publicationCondition: exists(
            db.select({ connectorId: updated.connectorId }).from(updated),
          ),
        }),
      );
    const removed = db.$with("removed_thread_forms_cursors").as(
      db
        .delete(googleFormsAutomationCursors)
        .where(
          inArray(
            googleFormsAutomationCursors.automationId,
            db.select({ id: changed.id }).from(changed),
          ),
        )
        .returning({ id: googleFormsAutomationCursors.automationId }),
    );
    signal.throwIfAborted();
    const [row] = await db
      .with(updated, changed, removed)
      .select({ value: count() })
      .from(updated)
      .where(gte(db.select({ value: count() }).from(removed), 0));
    signal.throwIfAborted();
    return row !== undefined && row.value > 0;
  },
);

const publishUpdatedGenericSelection$ = command(
  async (
    { set },
    args: UpdateThreadSelectionArgs,
    projections: readonly PreparedDefaultAccountProjection[],
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const insert = updatedThreadSelectionPlan(args);
    const updated = db
      .$with("updated_thread_connector_selection")
      .as(
        db
          .with(insert.account)
          .insert(chatThreadConnectorSelections)
          .select(insert.source)
          .onConflictDoUpdate(insert.conflict)
          .returning({
            connectorId: chatThreadConnectorSelections.connectorId,
          }),
      );
    const ctes: WithSubquery[] = [updated];
    let completed = gte(db.select({ value: count() }).from(updated), 0);
    if (projections.length > 0) {
      const plan = preparedDefaultAccountProjectionPlan(
        projections,
        exists(db.select({ connectorId: updated.connectorId }).from(updated)),
      );
      const configured = db
        .$with("configured_thread_automations")
        .as(
          db
            .update(workflowAutomations)
            .set(plan.configured.values)
            .from(plan.configured.from)
            .where(plan.configured.where)
            .returning({ id: workflowAutomations.id }),
        );
      const selected = db
        .$with("selected_thread_automations")
        .as(
          db
            .update(workflowAutomations)
            .set(plan.selected.values)
            .from(plan.selected.from)
            .where(plan.selected.where)
            .returning({ id: workflowAutomations.id }),
        );
      const projected = db.$with("projected_thread_automations").as(
        db
          .select({ id: configured.id })
          .from(configured)
          .unionAll(db.select({ id: selected.id }).from(selected)),
      );
      ctes.push(configured, selected, projected);
      completed = gte(db.select({ value: count() }).from(projected), 0);
      if (
        args.selection.target.kind === "builtin" &&
        args.selection.target.connectorSlug === "notion"
      ) {
        const write = notionPendingEventsSkipWrite(
          plan.pendingEvents,
          NOTION_ACCOUNT_CHANGED_SKIP_REASON,
        );
        const skipped = db.$with("skipped_thread_notion_events").as(
          db
            .update(write.table)
            .set(write.values)
            .where(
              and(
                write.where,
                completed,
                exists(
                  db.select({ connectorId: updated.connectorId }).from(updated),
                ),
              ),
            )
            .returning({ id: notionWorkflowPendingEvents.id }),
        );
        ctes.push(skipped);
        completed = gte(db.select({ value: count() }).from(skipped), 0);
      }
    }
    signal.throwIfAborted();
    const [row] = await db
      .with(...ctes)
      .select({ value: count() })
      .from(updated)
      .where(completed);
    signal.throwIfAborted();
    return row !== undefined && row.value > 0;
  },
);

/** Publish an already-authorized selection and every related write atomically. */
export const publishUpdatedThreadSelection$ = command(
  async (
    { set },
    args: UpdateThreadSelectionArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    if (
      args.selection.target.kind === "builtin" &&
      args.selection.target.connectorSlug === "google-forms"
    ) {
      return await set(publishUpdatedFormsSelection$, args, signal);
    }
    const projections = await set(
      prepareUpdatedThreadProjections$,
      args,
      signal,
    );
    signal.throwIfAborted();
    return await set(
      publishUpdatedGenericSelection$,
      args,
      projections,
      signal,
    );
  },
);
