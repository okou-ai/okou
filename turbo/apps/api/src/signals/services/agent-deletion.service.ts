import { command } from "ccstate";
import { agents } from "@okouai/db/schema/agent";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { storages } from "@okouai/db/schema/storage";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  agentDeletionAdmissionPlan,
  agentDeletionIdentityCondition,
  agentDeletionAutomationCondition,
  agentDeletionThreadSequencesSql,
  agentInstructionDeletionCondition,
  agentConversationDeletionCondition,
  agentInstructionStoragesSql,
  deletedInstructionStorageSchema,
  deletedConversationReferences,
  conversationReferenceBatches,
  conversationBlobLockCondition,
  conversationBlobReleaseValues,
  conversationDeletionDatabaseError,
  type DeleteAgentArgs,
} from "./agent-deletion-queries";
import { env } from "../../lib/env";
import { conflict } from "../../lib/error";
import { logger } from "../../lib/log";
import { isLockNotAvailable } from "../../lib/pg-errors";
import { settle } from "../utils";
import { agentPublicationFenceDeletionSql } from "./agent-lifecycle.service";
import { reconcileAutomationEventWatches$ } from "./automation-event-watch-lifecycle.service";
import { purgeDeletedStoragePrefix$ } from "./storage-prefix-purge.service";
import { logCommittedConversationDeletion } from "./conversation-history-deletion.service";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";

const log = logger("api:agent-deletion");
const THREAD_DELETION_READ_PAGE_SIZE = 500;
const THREAD_DELETION_EVENT_BATCH_SIZE = 16;

export const agentExistsInOrg$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly agentId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [row] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(agentDeletionIdentityCondition(args))
      .limit(1);
    signal.throwIfAborted();
    return Boolean(row);
  },
);

const DELETE_AGENT_LOCK_TIMEOUT = "100ms";
const agentWatchColumns = Object.freeze({
  orgId: workflowAutomations.orgId,
  ownerUserId: workflowAutomations.ownerUserId,
  eventType: workflowAutomations.eventType,
  eventConfig: workflowAutomations.eventConfig,
  eventConnectorId: workflowAutomations.eventConnectorId,
});

const deleteAgentRows$ = command(
  async ({ set }, args: DeleteAgentArgs, signal: AbortSignal) => {
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0047; new non-billing transactions are prohibited.
    return await set(writeDb$).transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('lock_timeout', ${DELETE_AGENT_LOCK_TIMEOUT}, true)`,
      );
      signal.throwIfAborted();
      const admission = agentDeletionAdmissionPlan(args);
      let step = admission.next();
      while (!step.done) {
        const statement = step.value;
        const rows = parseRawRows(
          statement.rowSchema,
          await tx.execute(statement.sql),
        );
        signal.throwIfAborted();
        step = admission.next(rows);
      }
      const lifecycle = step.value;
      if (lifecycle.kind !== "ready") {
        return lifecycle;
      }
      // Direct append owns sequence before its thread FK check. Take sequences
      // before the Agent cascade under the existing lock timeout.
      await tx.execute(agentDeletionThreadSequencesSql(args.agentId));
      signal.throwIfAborted();
      const automations = await tx
        .select(agentWatchColumns)
        .from(workflowAutomations)
        .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
        .where(agentDeletionAutomationCondition(args));
      signal.throwIfAborted();
      let removed = deletedConversationReferences([]);
      if (lifecycle.runIds.length > 0) {
        const deleted = tx
          .$with("removed_conversations")
          .as(
            tx
              .delete(conversations)
              .where(agentConversationDeletionCondition(lifecycle.runIds))
              .returning({ hash: conversations.cliAgentSessionHistoryHash }),
          );
        const deletion = await settle(
          tx
            .with(deleted)
            .select({ hash: deleted.hash, references: count() })
            .from(deleted)
            .groupBy(deleted.hash),
        );
        signal.throwIfAborted();
        if (!deletion.ok) {
          throw conversationDeletionDatabaseError(deletion.error);
        }
        removed = deletedConversationReferences(deletion.value);
      }
      // Storage publication and lifecycle deletion prelock parents in UUID order.
      const instructions = parseRawRows(
        deletedInstructionStorageSchema,
        await tx.execute(
          agentInstructionStoragesSql(args.orgId, lifecycle.agentName),
        ),
      );
      signal.throwIfAborted();
      for (const statement of agentPublicationFenceDeletionSql(args.agentId)) {
        await tx.execute(statement);
        signal.throwIfAborted();
      }
      await tx.delete(agents).where(agentDeletionIdentityCondition(args));
      signal.throwIfAborted();
      // The cascade drains already-owned Workflow rows. Sweep their late fence
      // initialization after the cascade, preserving generation-before-token order.
      for (const statement of agentPublicationFenceDeletionSql(args.agentId)) {
        await tx.execute(statement);
        signal.throwIfAborted();
      }
      if (instructions.length > 0) {
        await tx
          .delete(storages)
          .where(agentInstructionDeletionCondition(instructions));
        signal.throwIfAborted();
      }
      // Blob locks and reference release remain LAST, after all parent mutations.
      const release = conversationReferenceBatches(removed);
      for (const batch of release.batches) {
        const locked = await settle(
          tx
            .select({ hash: blobs.hash })
            .from(blobs)
            .where(conversationBlobLockCondition(batch))
            .orderBy(asc(blobs.hash))
            .for("update", { noWait: true }),
        );
        signal.throwIfAborted();
        if (!locked.ok) {
          throw conversationDeletionDatabaseError(locked.error);
        }
        if (locked.value.length !== batch.length) {
          throw new Error(
            "Conversation history reference accounting failed: missing blob references",
          );
        }
        const releaseValues = conversationBlobReleaseValues(batch);
        const released = await settle(
          tx
            .update(blobs)
            .set(releaseValues.values)
            .from(releaseValues.from)
            .where(releaseValues.where),
        );
        signal.throwIfAborted();
        if (!released.ok) {
          throw conversationDeletionDatabaseError(released.error);
        }
        if (released.value.rowCount !== batch.length) {
          throw new Error(
            "Conversation history reference accounting failed: missing or insufficient blob references",
          );
        }
      }
      return {
        kind: "deleted" as const,
        s3Prefix: instructions[0]?.s3Prefix ?? null,
        automations,
        conversationDeletion: release.receipt,
      };
    });
  },
);

const readAgentThreadEventOwners$ = command(
  async (
    { get },
    args: { readonly agentId: string; readonly orgId: string },
    signal: AbortSignal,
  ) => {
    const owners: {
      id: string;
      userId: string;
      orgId: string;
    }[] = [];
    let afterId: string | null = null;
    for (;;) {
      const page = await get(db$)
        .select({ id: chatThreads.id, userId: chatThreads.userId })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.agentId, args.agentId),
            afterId === null ? undefined : gt(chatThreads.id, afterId),
          ),
        )
        .orderBy(asc(chatThreads.id))
        .limit(THREAD_DELETION_READ_PAGE_SIZE);
      signal.throwIfAborted();
      owners.push(
        ...page.map((thread) => {
          return { ...thread, orgId: args.orgId };
        }),
      );
      const last = page.at(-1);
      if (!last || page.length < THREAD_DELETION_READ_PAGE_SIZE) {
        break;
      }
      afterId = last.id;
    }
    return owners;
  },
);

/** Best-effort lifecycle notifications, never part of the Agent's deletion transaction. */
const appendDeletedAgentThreadEvent$ = command(
  async (
    { set },
    thread: {
      readonly id: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
    },
    signal: AbortSignal,
  ) => {
    await set(writeDb$).execute(
      chatThreadEventInsertSql({
        kind: "deleted",
        userId: thread.userId,
        orgId: thread.orgId,
        chatThreadId: thread.id,
        agentId: thread.agentId,
      }),
    );
    signal.throwIfAborted();
  },
);
const appendDeletedAgentThreadEvents$ = command(
  async (
    { set },
    args: {
      readonly agentId: string;
      readonly owners: readonly {
        readonly id: string;
        readonly userId: string;
        readonly orgId: string;
      }[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    for (
      let offset = 0;
      offset < args.owners.length;
      offset += THREAD_DELETION_EVENT_BATCH_SIZE
    ) {
      const batch = args.owners.slice(
        offset,
        offset + THREAD_DELETION_EVENT_BATCH_SIZE,
      );
      const results = await Promise.allSettled(
        batch.map((thread) => {
          return set(
            appendDeletedAgentThreadEvent$,
            { ...thread, agentId: args.agentId },
            signal,
          );
        }),
      );
      signal.throwIfAborted();
      const failed = results.filter((result) => {
        return result.status === "rejected";
      });
      if (failed.length > 0) {
        log.error("Failed to append deleted Agent thread events", {
          agentId: args.agentId,
          offset,
          failed: failed.length,
          error: failed[0]?.reason,
        });
      }
    }
  },
);

export const deleteAgentById$ = command(
  async ({ set }, args: DeleteAgentArgs, signal: AbortSignal) => {
    // The cascade destroys these rows. Read them in bounded keyset pages
    // before it starts; a concurrent creation missed by this read is tolerated.
    const threadEventOwners = await set(
      readAgentThreadEventOwners$,
      args,
      signal,
    );
    signal.throwIfAborted();
    const transaction = await settle(
      // The previous delete transaction did not cancel midway through its
      // lifecycle writes. Keep that boundary and check request abort afterward.
      set(deleteAgentRows$, args, new AbortController().signal),
      signal,
    );
    if (!transaction.ok) {
      if (isLockNotAvailable(transaction.error)) {
        return conflict("Cannot delete agent right now; retry shortly");
      }
      throw transaction.error;
    }
    const result = transaction.value;
    if (result.kind === "deleted") {
      logCommittedConversationDeletion("agent", result.conversationDeletion);
      // Single-statement appends run only after the delete commits. An event
      // failure must not retry or roll back the already committed deletion.
      await set(
        appendDeletedAgentThreadEvents$,
        { agentId: args.agentId, owners: threadEventOwners },
        new AbortController().signal,
      );
    }
    signal.throwIfAborted();
    if (result.kind === "ownership-conflict") {
      return conflict(
        "Cannot delete agent because its lifecycle ownership is inconsistent",
      );
    }
    if (result.kind === "active-run") {
      return conflict("Cannot delete agent: agent is currently running");
    }
    if (result.kind === "forbidden") {
      return result.response;
    }
    if (result.kind === "missing") {
      return undefined;
    }
    await set(
      reconcileAutomationEventWatches$,
      {
        automations: result.automations,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.s3Prefix) {
      await set(
        purgeDeletedStoragePrefix$,
        {
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          s3Prefix: result.s3Prefix,
        },
        signal,
      );
    }
    return undefined;
  },
);
