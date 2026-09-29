import type {
  McpSendChatMessageInput,
  McpSendChatMessageOutput,
  McpChatMutationResult,
  mcpChatInputReceiptSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import type { z } from "zod";
import { formatMcpChatTimestamp } from "@okouai/api-contracts/contracts/mcp-chat-time";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { command } from "ccstate";
import { env } from "../../lib/env";
import type { ApiOrgRole } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import { sendNormalEvent$ } from "./chat-events.command";
import { mcpClientDisplayName } from "./mcp-client-display-name.service";
import {
  MCP_SUBMISSION_RETRY_MS,
  resolveMcpSubmission,
} from "./mcp-chat-submission.service";

const replacement = alias(chatEvents, "mcp_submission_replacement");

interface Principal {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: ApiOrgRole;
  readonly clientId: string;
}

async function mcpInputDisposition(
  db: Db,
  threadId: string,
  inputId: string,
): Promise<Pick<McpSendChatMessageOutput, "disposition" | "runId">> {
  const [event] = await db
    .select({
      replacementType: replacement.eventType,
      replacementRunId: replacement.runId,
    })
    .from(chatEvents)
    .leftJoin(
      replacement,
      and(
        eq(replacement.revokesEventId, chatEvents.id),
        eq(replacement.chatThreadId, threadId),
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
  return { disposition: "queued", runId: null };
}

type McpChatInputReceipt = z.infer<typeof mcpChatInputReceiptSchema>;

/**
 * Submit one MCP text input through the direct send every user input uses.
 * The MCP `requestId` is the input's client event id, so a retry is settled
 * by the same client event id idempotency as a web or CLI retry. The stored
 * input is then read back as the MCP receipt, which also enforces the MCP
 * contract that a request id names one exact text and is replayable for 24
 * hours; neither check sends anything.
 */
export const submitMcpChatInput$ = command(
  async (
    { set },
    args: {
      readonly principal: Principal;
      readonly threadId: string;
      readonly agentId: string;
      readonly inputId: string;
      readonly text: string;
    },
    signal: AbortSignal,
  ): Promise<
    McpChatMutationResult<{
      readonly receipt: McpChatInputReceipt;
      readonly replayed: boolean;
    }>
  > => {
    const db = set(writeDb$);
    const { principal } = args;
    const clientName = await mcpClientDisplayName(principal.clientId, signal);
    signal.throwIfAborted();
    const sent = await set(
      sendNormalEvent$,
      {
        auth: { tokenType: "oauth", ...principal },
        mcpSource: {
          type: "source",
          kind: "mcp",
          clientId: principal.clientId,
          ...(clientName === undefined ? {} : { clientName }),
        },
        userId: principal.userId,
        orgId: principal.orgId,
        body: {
          agentId: args.agentId,
          threadId: args.threadId,
          prompt: args.text,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: args.text }],
          },
          hasTextContent: true,
          clientEventId: args.inputId,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (sent.status === 409) {
      return requestIdConflict();
    }
    if (sent.status !== 201) {
      return {
        kind: "error",
        code: "submission_unavailable",
        message: sent.body.error.message,
        retryable: true,
      };
    }
    const resolved = await resolveMcpSubmission(
      db,
      { requestId: args.inputId, text: args.text },
      {
        userId: principal.userId,
        orgId: principal.orgId,
        threadId: args.threadId,
      },
    );
    signal.throwIfAborted();
    if (resolved.kind === "conflict") {
      return requestIdConflict();
    }
    if (resolved.kind === "expired") {
      return {
        kind: "error",
        code: "request_expired",
        message:
          "The 24-hour retry window has expired. Inspect the original conversation and input before intentionally submitting new work; this request was not sent again.",
        retryable: false,
      };
    }
    if (resolved.kind === "missing") {
      return submissionUnavailable();
    }
    const disposition = await mcpInputDisposition(
      db,
      args.threadId,
      resolved.receipt.requestId,
    );
    signal.throwIfAborted();
    if (disposition.disposition === "unavailable") {
      return submissionUnavailable();
    }
    const { receipt } = resolved;
    return {
      kind: "ok",
      data: {
        receipt: {
          inputRef: {
            threadId: args.threadId,
            eventId: receipt.requestId,
            seqId: receipt.inputSeqId,
          },
          acceptedAt: formatMcpChatTimestamp(receipt.acceptedAt),
          retryUntil: formatMcpChatTimestamp(
            new Date(receipt.acceptedAt.getTime() + MCP_SUBMISSION_RETRY_MS),
          ),
          ...disposition,
        },
        replayed: sent.replayed === true,
      },
    };
  },
);

function requestIdConflict(): McpChatMutationResult<never> {
  return {
    kind: "error",
    code: "request_id_conflict",
    message:
      "requestId is already in use for a different submission. Retry with the original thread and exact text.",
    retryable: false,
  };
}

function submissionUnavailable(): McpChatMutationResult<never> {
  return {
    kind: "error",
    code: "submission_unavailable",
    message:
      "Submission could not be resolved. Retry the identical requestId, thread and text.",
    retryable: true,
  };
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
      return {
        kind: "error",
        code: "not_found",
        message: "Conversation not found.",
        retryable: false,
      };
    }
    const submitted = await set(
      submitMcpChatInput$,
      {
        principal,
        threadId: input.threadId,
        agentId: thread.agentId,
        inputId: input.requestId,
        text: input.text,
      },
      signal,
    );
    signal.throwIfAborted();
    if (submitted.kind === "error") {
      return submitted;
    }
    const { receipt, replayed } = submitted.data;
    return {
      kind: "ok",
      data: {
        ...receipt,
        replayed,
        url: new URL(`/chats/${input.threadId}`, env("APP_URL")).toString(),
        nextAction: {
          tool: "get_chat_status",
          arguments: { inputRef: receipt.inputRef },
        },
      },
    };
  },
);
