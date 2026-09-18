import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type {
  McpChatStatusResult,
  McpGetChatStatusInput,
  McpGetChatStatusOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-status";
import { runStatusSchema } from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import { computed, type Computed } from "ccstate";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  boundHistoryQuery,
  McpMessageHistoryError,
  readMcpChatHistoryProjection,
  type HistoryBudget,
} from "./mcp-chat-message-history.service";
import { projectMcpChatMessages } from "./mcp-chat-messages.service";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

type InputStatus = NonNullable<McpGetChatStatusOutput["input"]>;
type RunStatus = NonNullable<McpGetChatStatusOutput["run"]>;

function reference(row: ChatEventRow) {
  return { threadId: row.chatThreadId, eventId: row.id, seqId: row.seqId };
}

function resolveInput(
  inputRef: NonNullable<McpGetChatStatusInput["inputRef"]>,
  rows: readonly ChatEventRow[],
  budget: HistoryBudget,
): InputStatus {
  const status: InputStatus = {
    ref: inputRef,
    state: "unavailable",
    deliveryMode: "unknown",
    runId: null,
    visibleMessageRef: null,
  };
  const byId = new Map<string, ChatEventRow>();
  const replacements = new Map<string, ChatEventRow>();
  for (const row of rows) {
    budget.check();
    byId.set(row.id, row);
    if (row.revokesEventId !== null) {
      if (replacements.has(row.revokesEventId)) {
        throw new Error("Chat input has ambiguous replacements");
      }
      replacements.set(row.revokesEventId, row);
    }
  }
  const original = byId.get(inputRef.eventId);
  if (
    !original ||
    original.seqId !== inputRef.seqId ||
    original.chatThreadId !== inputRef.threadId ||
    original.eventType !== "input.prompt" ||
    original.runId !== null ||
    original.revokesEventId !== null
  ) {
    return status;
  }
  let current: ChatEventRow = original;
  for (;;) {
    budget.check();
    const next = replacements.get(current.id);
    if (!next) {
      break;
    }
    if (next.seqId <= current.seqId) {
      throw new Error("Chat input replacement ordering is invalid");
    }
    current = next;
  }
  if (current.eventType === "control.revoke") {
    return { ...status, state: "revoked" };
  }
  if (current.eventType === "input.rejected") {
    return {
      ...status,
      state: "rejected",
      runId: current.runId,
      visibleMessageRef: reference(current),
    };
  }
  if (current.eventType !== "input.prompt") {
    throw new Error("Chat input has an invalid replacement type");
  }
  return {
    ...status,
    state: current.runId === null ? "queued" : "associated",
    runId: current.runId,
    visibleMessageRef: reference(current),
  };
}

async function observeDelivery(
  tx: Tx,
  principal: Principal,
  input: InputStatus,
  budget: HistoryBudget,
): Promise<InputStatus> {
  if (input.state !== "queued" && input.state !== "associated") {
    return input;
  }
  await boundHistoryQuery(tx, budget);
  const receipts = await tx
    .select({
      runId: agentRuns.id,
      disposition: activeInputDeliveryItems.disposition,
    })
    .from(activeInputDeliveryItems)
    .innerJoin(
      activeInputDeliveries,
      eq(activeInputDeliveries.id, activeInputDeliveryItems.deliveryId),
    )
    .innerJoin(agentRuns, eq(agentRuns.id, activeInputDeliveries.runId))
    .where(
      and(
        eq(activeInputDeliveryItems.sourceEventId, input.ref.eventId),
        eq(activeInputDeliveries.chatThreadId, input.ref.threadId),
        eq(agentRuns.chatThreadId, input.ref.threadId),
        eq(agentRuns.userId, principal.userId),
        eq(agentRuns.orgId, principal.orgId),
        input.runId === null ? undefined : eq(agentRuns.id, input.runId),
        input.state === "queued"
          ? and(
              eq(activeInputDeliveries.status, "open"),
              isNull(activeInputDeliveryItems.disposition),
            )
          : and(
              eq(activeInputDeliveries.status, "settled"),
              eq(activeInputDeliveryItems.disposition, "delivered"),
            ),
      ),
    )
    .limit(2);
  budget.check();
  if (receipts.length > 1) {
    throw new Error("Chat input has ambiguous delivery receipts");
  }
  const receipt = receipts[0];
  if (!receipt) {
    return input;
  }
  if (receipt.disposition === "delivered") {
    if (input.runId !== receipt.runId) {
      throw new Error("Delivered chat input is missing its run association");
    }
    return { ...input, state: "delivered", deliveryMode: "steer" };
  }
  if (input.state !== "queued") {
    throw new Error("Reserved chat input is already associated");
  }
  return { ...input, state: "reserved", runId: receipt.runId };
}

async function readRun(
  tx: Tx,
  principal: Principal,
  threadId: string,
  input: InputStatus | null,
  budget: HistoryBudget,
): Promise<RunStatus | null> {
  const runId = input?.runId;
  if (runId === null) {
    return null;
  }
  await boundHistoryQuery(tx, budget);
  const [run] = await tx
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
      startedAt: agentRuns.startedAt,
      completedAt: agentRuns.completedAt,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, threadId),
        eq(agentRuns.userId, principal.userId),
        eq(agentRuns.orgId, principal.orgId),
        isNotNull(agentRuns.triggerSource),
        runId === undefined ? undefined : eq(agentRuns.id, runId),
      ),
    )
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(1);
  budget.check();
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    status: runStatusSchema.parse(run.status),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    cancellationRecovery:
      run.status !== "cancelled" || run.cancellationRecoveryCompleted === null
        ? "not_applicable"
        : run.cancellationRecoveryCompleted
          ? "complete"
          : "pending",
  };
}

async function observeLaunch(
  tx: Tx,
  input: InputStatus,
  run: RunStatus,
  budget: HistoryBudget,
): Promise<InputStatus> {
  if (input.state !== "associated") {
    return input;
  }
  await boundHistoryQuery(tx, budget);
  const [launch] = await tx
    .select({ id: agentRunCallbacks.id })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, run.id),
        eq(agentRunCallbacks.internalKind, "chat"),
        eq(sql`${agentRunCallbacks.payload}->>'threadId'`, input.ref.threadId),
        eq(
          sql`${agentRunCallbacks.payload}->>'queuedMessageId'`,
          input.ref.eventId,
        ),
      ),
    )
    .limit(1);
  budget.check();
  return launch ? { ...input, deliveryMode: "launch" } : input;
}

function outputStatus(
  rows: readonly ChatEventRow[],
  run: RunStatus,
  budget: HistoryBudget,
): McpGetChatStatusOutput["output"] {
  const messages = projectMcpChatMessages(rows, budget.check).filter(
    (message) => {
      budget.check();
      return message.runId === run.id && message.role === "assistant";
    },
  );
  const terminalType = {
    queued: null,
    pending: null,
    running: null,
    completed: "run.completed",
    failed: "run.failed",
    timeout: "run.failed",
    cancelled: "run.cancelled",
  }[run.status];
  const materialized =
    terminalType !== null &&
    rows.some((row) => {
      budget.check();
      return row.runId === run.id && row.eventType === terminalType;
    });
  const settled = materialized && run.cancellationRecovery !== "pending";
  return {
    state:
      messages.length > 0
        ? settled
          ? "ready"
          : "partial"
        : settled
          ? "unavailable"
          : "pending",
    messageRefs: messages.slice(-20).map((message) => {
      return message.ref;
    }),
    hasMore: messages.length > 20,
    reason: settled && messages.length === 0 ? "no_output" : null,
  };
}

export function getMcpChatStatus(
  runtime: { readonly db: Db; readonly bucket: string },
  principal: Principal,
  args: McpGetChatStatusInput,
  signal: AbortSignal,
): Computed<Promise<McpChatStatusResult>> {
  return computed(async (get): Promise<McpChatStatusResult> => {
    const result = await settle(
      get(
        readMcpChatHistoryProjection(
          runtime,
          principal,
          args.threadId,
          signal,
          async (tx, rows, budget): Promise<McpGetChatStatusOutput> => {
            let input = args.inputRef
              ? await observeDelivery(
                  tx,
                  principal,
                  resolveInput(args.inputRef, rows, budget),
                  budget,
                )
              : null;
            const run = await readRun(
              tx,
              principal,
              args.threadId,
              input,
              budget,
            );
            const associationUnavailable =
              input !== null && input.runId !== null && run === null;
            if (input && run) {
              input = await observeLaunch(tx, input, run, budget);
            } else if (input && associationUnavailable) {
              // A reference is never authority for an inaccessible or deleted run.
              input = {
                ...input,
                state: "unavailable",
                runId: null,
                deliveryMode: "unknown",
              };
            }
            const output: McpGetChatStatusOutput["output"] = run
              ? outputStatus(rows, run, budget)
              : {
                  state: "unavailable",
                  messageRefs: [],
                  hasMore: false,
                  reason: associationUnavailable
                    ? "run_unavailable"
                    : "no_associated_run",
                };
            const retry =
              output.state === "pending" ||
              output.state === "partial" ||
              input?.state === "queued" ||
              input?.state === "reserved";
            budget.check();
            const data: McpGetChatStatusOutput = {
              threadId: args.threadId,
              observedAt: nowDate().toISOString(),
              input,
              runSelection: args.inputRef ? "input" : "latest",
              run,
              output,
              messages: run
                ? {
                    tool: "get_chat_messages",
                    arguments: {
                      threadId: args.threadId,
                      runId: run.id,
                      limit: 20,
                    },
                  }
                : null,
              retryAfterMs: retry ? 2000 : null,
            };
            // Includes historical archive identities, whose text length is not
            // constrained by the live UUID columns. Leave room for the SDK's
            // duplicated structuredContent/text representation below 64 KiB.
            if (Buffer.byteLength(JSON.stringify(data), "utf8") > 16 * 1024) {
              throw new McpMessageHistoryError(
                "history_limit",
                "Chat status references exceed the 16 KiB response data limit.",
              );
            }
            budget.check();
            return data;
          },
        ),
      ),
      signal,
    );
    if (result.ok) {
      return result.value === null
        ? { kind: "not_found", message: "Conversation not found." }
        : { kind: "ok", data: result.value };
    }
    if (result.error instanceof McpMessageHistoryError) {
      return { kind: result.error.kind, message: result.error.message };
    }
    return {
      kind: "history_unavailable",
      message: "Chat status is temporarily unavailable. Retry later.",
    };
  });
}
