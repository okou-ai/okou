import type {
  McpSendChatMessageInput,
  McpSendChatMessageOutput,
  McpChatMutationResult,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { command } from "ccstate";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import type { ApiOrgRole } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import { sendNormalEvent$ } from "./chat-events.command";
import {
  MCP_SUBMISSION_RETRY_MS,
  resolveMcpSubmission,
} from "./mcp-chat-submission.service";

const replacement = alias(chatEvents, "mcp_submission_replacement");

interface Principal {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: ApiOrgRole;
}

async function inputDisposition(
  db: Db,
  threadId: string,
  inputId: string,
): Promise<Pick<McpSendChatMessageOutput, "disposition" | "runId">> {
  const [event] = await db
    .select({
      replacementType: replacement.eventType,
      replacementRunId: replacement.runId,
      reservedRunId: activeInputDeliveries.runId,
    })
    .from(chatEvents)
    .leftJoin(
      replacement,
      and(
        eq(replacement.revokesEventId, chatEvents.id),
        eq(replacement.chatThreadId, threadId),
      ),
    )
    .leftJoin(
      activeInputDeliveryItems,
      and(
        eq(activeInputDeliveryItems.sourceEventId, chatEvents.id),
        isNull(activeInputDeliveryItems.disposition),
      ),
    )
    .leftJoin(
      activeInputDeliveries,
      and(
        eq(activeInputDeliveries.id, activeInputDeliveryItems.deliveryId),
        eq(activeInputDeliveries.status, "open"),
      ),
    )
    .where(
      and(eq(chatEvents.id, inputId), eq(chatEvents.chatThreadId, threadId)),
    )
    .limit(1);
  if (!event) {
    return { disposition: "unavailable", runId: null };
  }
  if (event.replacementType === "control.revoke") {
    return { disposition: "revoked", runId: null };
  }
  if (event.replacementType === "input.rejected") {
    return {
      disposition: "rejected",
      runId: event.replacementRunId,
    };
  }
  const runId = event.replacementRunId;
  if (runId !== null) {
    return { disposition: "associated", runId };
  }
  if (event.reservedRunId !== null) {
    return { disposition: "reserved", runId: event.reservedRunId };
  }
  return { disposition: "queued", runId: null };
}

/** Caller owns the admitted operation independently from the HTTP response lifetime. */
export const sendMcpChatMessage$ = command(
  async (
    { set },
    args: {
      readonly principal: Principal;
      readonly input: McpSendChatMessageInput;
    },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpSendChatMessageOutput>> => {
    const db = set(writeDb$);
    const { principal, input } = args;
    const [thread] = await db
      .select({ agentId: agents.id })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(chatThreads.id, input.threadId),
          eq(chatThreads.userId, principal.userId),
          eq(agents.orgId, principal.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return { kind: "error", message: "Conversation not found." };
    }
    const identity = { requestId: input.requestId, text: input.text };
    const owner = {
      userId: principal.userId,
      orgId: principal.orgId,
      threadId: input.threadId,
    };
    let resolved = await resolveMcpSubmission(db, identity, owner);
    signal.throwIfAborted();
    let replayed = resolved.kind === "accepted";
    if (resolved.kind === "conflict") {
      return {
        kind: "error",
        message:
          "requestId is already in use for a different submission. Retry with the original thread and exact text.",
      };
    }
    if (resolved.kind === "expired") {
      return {
        kind: "error",
        message:
          "The 24-hour retry window has expired. Inspect the original conversation and input before intentionally submitting new work; this request was not sent again.",
      };
    }
    if (resolved.kind === "missing") {
      const result = await set(
        sendNormalEvent$,
        {
          auth: { tokenType: "oauth", ...principal },
          ...owner,
          body: {
            agentId: thread.agentId,
            threadId: input.threadId,
            prompt: input.text,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: input.text }],
            },
            hasTextContent: true,
            clientEventId: input.requestId,
          },
          apiStartTime: now(),
          publicBrand: PUBLIC_BRAND,
          mcpSubmission: identity,
        },
        signal,
      );
      signal.throwIfAborted();
      replayed = result.status === 201 && result.mcpReplayed === true;
      resolved = await resolveMcpSubmission(db, identity, owner);
      signal.throwIfAborted();
      if (resolved.kind !== "accepted") {
        return {
          kind: "error",
          message:
            result.status === 201
              ? "Submission could not be resolved. Retry the identical requestId, thread and text."
              : result.body.error.message,
        };
      }
    }
    const receipt = resolved.receipt;
    const disposition = await inputDisposition(
      db,
      input.threadId,
      input.requestId,
    );
    signal.throwIfAborted();
    return {
      kind: "ok",
      data: {
        inputRef: {
          threadId: input.threadId,
          eventId: receipt.requestId,
          seqId: receipt.inputSeqId,
        },
        acceptedAt: receipt.acceptedAt.toISOString(),
        retryUntil: new Date(
          receipt.acceptedAt.getTime() + MCP_SUBMISSION_RETRY_MS,
        ).toISOString(),
        replayed,
        ...disposition,
        url: new URL(`/chats/${input.threadId}`, env("APP_URL")).toString(),
      },
    };
  },
);
