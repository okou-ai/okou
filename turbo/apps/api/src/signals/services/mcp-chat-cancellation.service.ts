import type {
  McpCancelRunInput,
  McpCancelRunOutput,
  McpChatMutationResult,
  McpRevokeQueuedMessageInput,
  McpRevokeQueuedMessageOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { tapError } from "../utils";
import { loadPendingChatQueueEvent } from "./chat-event-queue.service";
import { revokeChatEvent } from "./chat-event.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  shouldDispatchCancelSideEffects,
} from "./run-cancel.service";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

const L = logger("McpChatCancellation");

/** The caller owns the admitted mutation lifetime independently of HTTP. */
export const revokeQueuedMcpMessage$ = command(
  async (
    { set },
    args: {
      readonly principal: Principal;
      readonly input: McpRevokeQueuedMessageInput;
    },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpRevokeQueuedMessageOutput>> => {
    signal.throwIfAborted();
    const { principal, input } = args;
    const { threadId, eventId, seqId } = input.inputRef;
    const db = set(writeDb$);
    const result = await db.transaction(
      async (tx): Promise<McpRevokeQueuedMessageOutput> => {
        // Authorization is established under the thread row lock. Queue picks
        // and active-input steering take no thread lock; the unique
        // revocation edge on the target event keeps this revoke and a
        // concurrent consumer from both replacing it.
        const [thread] = await tx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, threadId),
              eq(chatThreads.userId, principal.userId),
              chatThreadOrganizationCondition(tx, principal.orgId),
            ),
          )
          .for("no key update");
        const reference = {
          inputRef: input.inputRef,
        };
        if (!thread) {
          return { ...reference, outcome: "unavailable", runId: null };
        }

        const [target] = await tx
          .select({
            eventType: chatEvents.eventType,
            seqId: chatEvents.seqId,
            runId: chatEvents.runId,
            revokesEventId: chatEvents.revokesEventId,
          })
          .from(chatEvents)
          .where(
            and(
              eq(chatEvents.id, eventId),
              eq(chatEvents.chatThreadId, threadId),
            ),
          )
          .limit(1);
        if (
          !target ||
          target.seqId !== seqId ||
          (target.eventType !== "input.prompt" &&
            target.eventType !== "input.automation")
        ) {
          return { ...reference, outcome: "unavailable", runId: null };
        }

        const [replacement] = await tx
          .select({
            eventType: chatEvents.eventType,
            runId: chatEvents.runId,
          })
          .from(chatEvents)
          .where(
            and(
              eq(chatEvents.revokesEventId, eventId),
              eq(chatEvents.chatThreadId, threadId),
            ),
          )
          .limit(1);
        if (replacement?.eventType === "control.revoke") {
          return { ...reference, outcome: "already_revoked", runId: null };
        }
        if (replacement || target.runId !== null) {
          const runId = replacement?.runId ?? target.runId;
          return {
            ...reference,
            outcome: "not_revocable",
            runId,
            reason: runId === null ? "not_queued" : "reserved_or_associated",
          };
        }

        const pending = await loadPendingChatQueueEvent(tx, {
          chatThreadId: threadId,
          eventId,
        });
        if (!pending || target.revokesEventId !== null) {
          return {
            ...reference,
            outcome: "not_revocable",
            runId: null,
            reason: "not_queued",
          };
        }

        const revoked = await revokeChatEvent(tx, eventId, {
          chatThreadId: threadId,
          eventType: "control.revoke",
          runId: null,
        });
        if (!revoked) {
          // A pick or steer receipt consumed the input after the read above.
          return {
            ...reference,
            outcome: "not_revocable",
            runId: null,
            reason: "reserved_or_associated",
          };
        }
        return { ...reference, outcome: "revoked", runId: null };
      },
    );
    signal.throwIfAborted();
    if (result.outcome === "revoked" || result.outcome === "already_revoked") {
      await publishChatThreadMessageCreatedSafely({
        ...principal,
        threadId,
      });
      signal.throwIfAborted();
    }
    return { kind: "ok", data: result };
  },
);

/** The supplied signal belongs to the admitted operation, not the request. */
export const cancelMcpRun$ = command(
  async (
    { set },
    args: {
      readonly principal: Principal;
      readonly input: McpCancelRunInput;
    },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpCancelRunOutput>> => {
    signal.throwIfAborted();
    const result = await set(
      cancelRun$,
      {
        ...args.principal,
        runId: args.input.runId,
        runnerCancellationMode: "cooperative",
      },
      signal,
    );
    if (!("alreadyCancelled" in result)) {
      return {
        kind: "error",
        code: "cancellation_failed",
        message: result.body.error.message,
        retryable: false,
      };
    }
    if (shouldDispatchCancelSideEffects(result)) {
      waitUntil(
        tapError(set(dispatchCancelSideEffects$, result, signal), (error) => {
          L.error("Failed to dispatch MCP cancellation side effects", {
            runId: result.runId,
            error,
          });
        }),
      );
    }
    return {
      kind: "ok",
      data: {
        runId: result.runId,
        status: "cancelled",
        alreadyCancelled: result.alreadyCancelled,
      },
    };
  },
);
