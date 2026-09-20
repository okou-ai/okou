import type {
  McpCancelRunInput,
  McpCancelRunOutput,
  McpChatMutationResult,
  McpRevokeQueuedMessageInput,
  McpRevokeQueuedMessageOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";

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
    const db = set(writeDb$);
    const result = await db.transaction(
      async (tx): Promise<McpRevokeQueuedMessageOutput> => {
        // This is the same row lock used by queue claims and active-input
        // reservations, with authorization established under that lock.
        const [thread] = await tx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, input.threadId),
              eq(chatThreads.userId, principal.userId),
              chatThreadOrganizationCondition(tx, principal.orgId),
            ),
          )
          .for("update");
        const reference = {
          threadId: input.threadId,
          inputId: input.inputId,
        };
        if (!thread) {
          return { ...reference, outcome: "unavailable", runId: null };
        }

        const [target] = await tx
          .select({
            eventType: chatEvents.eventType,
            runId: chatEvents.runId,
            revokesEventId: chatEvents.revokesEventId,
          })
          .from(chatEvents)
          .where(
            and(
              eq(chatEvents.id, input.inputId),
              eq(chatEvents.chatThreadId, input.threadId),
            ),
          )
          .limit(1);
        if (
          !target ||
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
              eq(chatEvents.revokesEventId, input.inputId),
              eq(chatEvents.chatThreadId, input.threadId),
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
          chatThreadId: input.threadId,
          eventId: input.inputId,
        });
        if (!pending || target.revokesEventId !== null) {
          const [reservation] = await tx
            .select({ runId: activeInputDeliveries.runId })
            .from(activeInputDeliveryItems)
            .innerJoin(
              activeInputDeliveries,
              eq(activeInputDeliveries.id, activeInputDeliveryItems.deliveryId),
            )
            .where(
              and(
                eq(activeInputDeliveryItems.sourceEventId, input.inputId),
                eq(activeInputDeliveries.chatThreadId, input.threadId),
                eq(activeInputDeliveries.status, "open"),
                isNull(activeInputDeliveryItems.disposition),
              ),
            )
            .limit(1);
          return {
            ...reference,
            outcome: "not_revocable",
            runId: reservation?.runId ?? null,
            reason: reservation ? "reserved_or_associated" : "not_queued",
          };
        }

        const revoked = await revokeChatEvent(tx, input.inputId, {
          chatThreadId: input.threadId,
          eventType: "control.revoke",
          runId: null,
        });
        if (!revoked) {
          throw new Error("Locked queued input was not revoked");
        }
        return { ...reference, outcome: "revoked", runId: null };
      },
    );
    signal.throwIfAborted();
    if (result.outcome === "revoked" || result.outcome === "already_revoked") {
      await publishChatThreadMessageCreatedSafely({
        ...principal,
        threadId: input.threadId,
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
