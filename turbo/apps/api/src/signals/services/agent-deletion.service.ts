import { Buffer } from "node:buffer";
import { command } from "ccstate";
import { agents } from "@okouai/db/schema/agent";
import { agentDeletionError } from "@okouai/core/agent-protection";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  array,
  discriminatedUnion,
  enum as zEnum,
  literal,
  number,
  object,
  string,
  unknown as zUnknown,
} from "zod";

import { db$, writeDb$ } from "../external/db";
import { parseRawRows } from "../../lib/db-raw-rows";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { conflict } from "../../lib/error";
import { logger } from "../../lib/log";
import { isLockNotAvailable } from "../../lib/pg-errors";
import { settle } from "../utils";
import { reconcileAutomationEventWatches$ } from "./automation-event-watch-lifecycle.service";
import {
  conversationDeletionDatabaseError,
  logCommittedConversationDeletion,
} from "./conversation-history-deletion.service";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";

interface DeleteAgentArgs {
  readonly agentId: string;
  readonly orgId: string;
  readonly member: { readonly userId: string; readonly role: string };
}

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
      .where(and(eq(agents.id, args.agentId), eq(agents.orgId, args.orgId)))
      .limit(1);
    signal.throwIfAborted();
    return Boolean(row);
  },
);

const deletionResultSchema = discriminatedUnion("kind", [
  object({ kind: literal("missing") }),
  object({ kind: literal("ownership-conflict") }),
  object({ kind: literal("active-run") }),
  object({ kind: literal("default-agent") }),
  object({
    kind: literal("permission-denied"),
    owner: string(),
    visibility: zEnum(["public", "private"]),
  }),
  object({
    kind: literal("deleted"),
    automations: array(
      object({
        orgId: string(),
        ownerUserId: string(),
        eventType: string().nullable(),
        eventConfig: zUnknown(),
        eventConnectorId: string().nullable(),
      }),
    ),
    conversationDeletion: object({
      deletedRuns: number().int().nonnegative(),
      releasedReferences: number().int().nonnegative(),
      releasedHashes: number().int().nonnegative(),
    }),
  }),
]);
const deletionRowSchema = object({ result: deletionResultSchema });

/** A PostgreSQL text owner cannot equal a NUL or unpaired-surrogate JS ID. */
function comparableMemberId(userId: string): string | null {
  return userId.includes("\0") ||
    Buffer.from(userId, "utf8").toString("utf8") !== userId
    ? null
    : userId;
}

function agentDeletionDatabaseError(error: unknown): Error {
  if (
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause
  ) {
    switch (error.cause.constraint) {
      case "agent_deletion_lost_run": {
        return new Error("Conversation deletion lost a locked run");
      }
      case "agent_deletion_missing_blob": {
        return new Error(
          "Conversation history reference accounting failed: missing blob references",
        );
      }
      case "agent_deletion_insufficient_blob": {
        return new Error(
          "Conversation history reference accounting failed: missing or insufficient blob references",
        );
      }
      case "agent_deletion_attachment_owner": {
        return new Error("Workflow attachment package has a foreign owner");
      }
      case "agent_deletion_invalid_visibility": {
        return new Error("Invalid Agent visibility during deletion");
      }
    }
  }
  // Preserve safe SQLSTATE diagnostics and the outer 55P03 -> 409 mapping.
  // The single statement must not expose SQL or bound values from any stage.
  return conversationDeletionDatabaseError(error);
}

const deleteAgentRows$ = command(
  async ({ set }, args: DeleteAgentArgs, signal: AbortSignal) => {
    const db = set(writeDb$);
    const query = sql`SELECT public.delete_agent_rows(
      ${args.agentId}::uuid, ${args.orgId},
      ${comparableMemberId(args.member.userId)}, ${args.member.role === "admin"}
    ) AS result`;
    const rowSchema = deletionRowSchema;
    const deletion = await settle(
      (async () => {
        return parseRawRows(rowSchema, await db.execute(query));
      })(),
    );
    signal.throwIfAborted();
    if (!deletion.ok) {
      throw agentDeletionDatabaseError(deletion.error);
    }
    const [row] = deletion.value;
    if (!row) {
      throw new Error("Agent deletion returned no outcome");
    }
    const result = row.result;
    if (result.kind === "default-agent") {
      return {
        kind: "forbidden" as const,
        response: {
          status: 400 as const,
          body: { error: agentDeletionError(true) },
        },
      };
    }
    if (result.kind === "permission-denied") {
      const response = requireAgentPermission(
        result.owner,
        args.member,
        "delete agent",
        { visibility: result.visibility },
      );
      if (!response) {
        throw new Error(
          "Agent deletion permission outcome contradicts its owner",
        );
      }
      return { kind: "forbidden" as const, response };
    }
    return result;
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
    return undefined;
  },
);
