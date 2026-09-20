import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type {
  McpChatStatusResult,
  McpGetChatStatusInput,
  McpGetChatStatusOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-status";
import { trace } from "@opentelemetry/api";
import { runStatusSchema } from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import { computed, type Computed } from "ccstate";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { delay } from "signal-timers";

import type { Tx } from "../../lib/db-types";
import { monotonicNow, nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { isAbortError, settleIncludingAbort } from "../utils";
import {
  boundHistoryQuery,
  McpMessageHistoryError,
  readMcpChatHistoryProjection,
  type HistoryBudget,
} from "./mcp-chat-message-history.service";
import {
  projectMcpChatMessages,
  readMcpChatMessagePage,
  type McpCompleteChatMessage,
} from "./mcp-chat-messages.service";
import {
  admitMcpChatStatusWaiter,
  MCP_CHAT_STATUS_MAX_PRINCIPAL_WAITERS,
  MCP_CHAT_STATUS_MAX_RUNTIME_WAITERS,
} from "./mcp-chat-status-wait-admission";

export const MCP_CHAT_STATUS_MAX_WAIT_MS = 8000;
const MCP_CHAT_STATUS_MAX_OBSERVATIONS = 5;
const STATUS_OUTPUT_BYTES = 16 * 1024;
const STATUS_WITH_MESSAGES_OUTPUT_BYTES = 192 * 1024;

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
  messages: readonly McpCompleteChatMessage[],
  run: RunStatus,
  budget: HistoryBudget,
): McpGetChatStatusOutput["output"] {
  const assistantMessages = messages.filter((message) => {
    budget.check();
    return message.runId === run.id && message.role === "assistant";
  });
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
      assistantMessages.length > 0
        ? settled
          ? "ready"
          : "partial"
        : settled
          ? "unavailable"
          : "pending",
    messageRefs: assistantMessages.slice(-20).map((message) => {
      return message.ref;
    }),
    hasMore: assistantMessages.length > 20,
    reason: settled && assistantMessages.length === 0 ? "no_output" : null,
  };
}

interface StatusSelection {
  readonly input: InputStatus | null;
  readonly run: RunStatus | null;
  readonly associationUnavailable: boolean;
}

async function readStatusSelection(
  tx: Tx,
  rows: readonly ChatEventRow[],
  budget: HistoryBudget,
  principal: Principal,
  args: McpGetChatStatusInput,
): Promise<StatusSelection> {
  let input = args.inputRef
    ? await observeDelivery(
        tx,
        principal,
        resolveInput(args.inputRef, rows, budget),
        budget,
      )
    : null;
  const run = await readRun(tx, principal, args.threadId, input, budget);
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
  return { input, run, associationUnavailable };
}

function readReadyMessagePage(
  messages: readonly McpCompleteChatMessage[],
  budget: HistoryBudget,
  context: {
    readonly principal: Principal;
    readonly args: McpGetChatStatusInput;
    readonly selection: StatusSelection;
    readonly output: McpGetChatStatusOutput["output"];
  },
): McpGetChatStatusOutput["messagePage"] {
  const { principal, args, selection, output } = context;
  if (output.state !== "ready" || !selection.run) {
    return null;
  }
  const page = readMcpChatMessagePage(
    messages,
    principal,
    { threadId: args.threadId, runId: selection.run.id, limit: 20 },
    budget.check,
  );
  if (page.kind !== "ok") {
    throw new Error(
      `Initial chat message page unexpectedly failed: ${page.kind}`,
    );
  }
  return page.data;
}

async function projectMcpChatStatus(
  tx: Tx,
  rows: readonly ChatEventRow[],
  budget: HistoryBudget,
  context: {
    readonly principal: Principal;
    readonly args: McpGetChatStatusInput;
    readonly includeMessagePage: boolean;
  },
): Promise<McpGetChatStatusOutput> {
  const { principal, args, includeMessagePage } = context;
  const selection = await readStatusSelection(
    tx,
    rows,
    budget,
    principal,
    args,
  );
  const projectedMessages = selection.run
    ? projectMcpChatMessages(rows, budget.check)
    : [];
  const output: McpGetChatStatusOutput["output"] = selection.run
    ? outputStatus(rows, projectedMessages, selection.run, budget)
    : {
        state: "unavailable",
        messageRefs: [],
        hasMore: false,
        reason: selection.associationUnavailable
          ? "run_unavailable"
          : "no_associated_run",
      };
  const retry =
    output.state === "pending" ||
    output.state === "partial" ||
    selection.input?.state === "queued" ||
    selection.input?.state === "reserved";
  const messagePage = includeMessagePage
    ? readReadyMessagePage(projectedMessages, budget, {
        principal,
        args,
        selection,
        output,
      })
    : null;
  budget.check();
  return {
    threadId: args.threadId,
    observedAt: nowDate().toISOString(),
    input: selection.input,
    runSelection: args.inputRef ? "input" : "latest",
    run: selection.run,
    output,
    messages: selection.run
      ? {
          tool: "get_chat_messages",
          arguments: {
            threadId: args.threadId,
            runId: selection.run.id,
            limit: 20,
          },
        }
      : null,
    wait: null,
    messagePage,
    retryAfterMs: retry ? 2000 : null,
  };
}

function observeMcpChatStatus(
  runtime: { readonly db: Db; readonly bucket: string },
  principal: Principal,
  args: McpGetChatStatusInput,
  signal: AbortSignal,
  includeMessagePage: boolean,
): Computed<Promise<McpGetChatStatusOutput | null>> {
  return computed((get) => {
    return get(
      readMcpChatHistoryProjection(
        runtime,
        principal,
        args.threadId,
        signal,
        (tx, rows, budget) => {
          return projectMcpChatStatus(tx, rows, budget, {
            principal,
            args,
            includeMessagePage,
          });
        },
      ),
    );
  });
}

function checkResponseSize(data: McpGetChatStatusOutput): void {
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  const limit = data.messagePage
    ? STATUS_WITH_MESSAGES_OUTPUT_BYTES
    : STATUS_OUTPUT_BYTES;
  if (bytes <= limit) {
    return;
  }
  throw new McpMessageHistoryError(
    "history_limit",
    data.messagePage
      ? "Chat status and message content exceed the 192 KiB response data limit."
      : "Chat status references exceed the 16 KiB response data limit.",
  );
}

type WaitOutcome = NonNullable<McpGetChatStatusOutput["wait"]>["outcome"];
type WaitReturnReason = NonNullable<
  McpGetChatStatusOutput["wait"]
>["returnReason"];

interface WaitOperation {
  readonly requestedMs: number;
  readonly effectiveMs: number;
  latest: McpGetChatStatusOutput | null;
  observations: number;
  waitStartedAt: number;
  principalOccupancy: number;
  runtimeOccupancy: number;
}

function elapsedWait(operation: WaitOperation): number {
  return Math.max(
    0,
    Math.min(
      operation.effectiveMs,
      Math.round(monotonicNow() - operation.waitStartedAt),
    ),
  );
}

function withWaitResult(
  data: McpGetChatStatusOutput,
  operation: WaitOperation,
  outcome: WaitOutcome,
  returnReason: WaitReturnReason,
): McpGetChatStatusOutput {
  const result: McpGetChatStatusOutput = {
    ...data,
    wait: {
      requestedMs: operation.requestedMs,
      effectiveMs: operation.effectiveMs,
      elapsedMs: elapsedWait(operation),
      observations: operation.observations,
      outcome,
      returnReason,
    },
    messagePage: outcome === "ready" ? data.messagePage : null,
  };
  checkResponseSize(result);
  return result;
}

function recordWaitTelemetry(
  data: McpGetChatStatusOutput | null,
  details: {
    readonly requestedMs: number;
    readonly effectiveMs: number;
    readonly elapsedMs: number;
    readonly observations: number;
    readonly outcome: WaitOutcome | "cancelled" | "error";
    readonly returnReason:
      | WaitReturnReason
      | "request_cancelled"
      | "conversation_not_found"
      | "observation_error";
    readonly principalOccupancy: number;
    readonly runtimeOccupancy: number;
  },
): void {
  trace.getActiveSpan()?.addEvent("mcp.chat_status.wait", {
    "mcp.chat_status.wait.requested_ms": details.requestedMs,
    "mcp.chat_status.wait.effective_ms": details.effectiveMs,
    "mcp.chat_status.wait.elapsed_ms": details.elapsedMs,
    "mcp.chat_status.wait.observations": details.observations,
    "mcp.chat_status.wait.outcome": details.outcome,
    "mcp.chat_status.wait.return_reason": details.returnReason,
    "mcp.chat_status.wait.principal_occupancy": details.principalOccupancy,
    "mcp.chat_status.wait.principal_capacity":
      MCP_CHAT_STATUS_MAX_PRINCIPAL_WAITERS,
    "mcp.chat_status.wait.runtime_occupancy": details.runtimeOccupancy,
    "mcp.chat_status.wait.runtime_capacity":
      MCP_CHAT_STATUS_MAX_RUNTIME_WAITERS,
    "mcp.chat_status.wait.input_state": data?.input?.state ?? "not_requested",
    "mcp.chat_status.wait.run_state": data?.run?.status ?? "unavailable",
    "mcp.chat_status.wait.output_state": data?.output.state ?? "unavailable",
    "mcp.chat_status.wait.content_included":
      data?.messagePage !== null && data?.messagePage !== undefined,
  });
}

function completeObservedWait(
  data: McpGetChatStatusOutput,
  operation: WaitOperation,
): McpGetChatStatusOutput | null {
  if (data.output.state === "ready") {
    return withWaitResult(data, operation, "ready", "output_ready");
  }
  if (data.retryAfterMs === null) {
    return withWaitResult(data, operation, "status", "non_retryable_state");
  }
  return null;
}

function currentStatus(operation: WaitOperation): McpGetChatStatusOutput {
  if (!operation.latest) {
    throw new Error("MCP chat status wait is missing its latest observation");
  }
  return operation.latest;
}

function waitForMcpChatStatus(
  runtime: { readonly db: Db; readonly bucket: string },
  principal: Principal,
  args: McpGetChatStatusInput,
  signal: AbortSignal,
  operation: WaitOperation,
): Computed<Promise<McpGetChatStatusOutput | null>> {
  return computed(async (get): Promise<McpGetChatStatusOutput | null> => {
    const admission = admitMcpChatStatusWaiter(principal);
    operation.principalOccupancy = admission.principalOccupancy;
    operation.runtimeOccupancy = admission.runtimeOccupancy;
    if (!admission.admitted) {
      return withWaitResult(
        currentStatus(operation),
        operation,
        "status",
        "waiter_limit",
      );
    }
    const result = await settleIncludingAbort(
      (async (): Promise<McpGetChatStatusOutput | null> => {
        const deadline = operation.waitStartedAt + operation.effectiveMs;
        for (;;) {
          const remaining = deadline - monotonicNow();
          if (remaining <= 0) {
            return withWaitResult(
              currentStatus(operation),
              operation,
              "deadline",
              "application_deadline",
            );
          }
          if (operation.observations >= MCP_CHAT_STATUS_MAX_OBSERVATIONS) {
            return withWaitResult(
              currentStatus(operation),
              operation,
              "status",
              "observation_limit",
            );
          }
          await delay(
            Math.min(operation.latest?.retryAfterMs ?? remaining, remaining),
            { signal },
          );
          operation.latest = await get(
            observeMcpChatStatus(runtime, principal, args, signal, true),
          );
          operation.observations += 1;
          if (operation.latest === null) {
            return null;
          }
          const completed = completeObservedWait(operation.latest, operation);
          if (completed) {
            return completed;
          }
        }
      })(),
    );
    admission.release();
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  });
}

function executeMcpChatStatus(
  runtime: { readonly db: Db; readonly bucket: string },
  principal: Principal,
  args: McpGetChatStatusInput,
  signal: AbortSignal,
  operation: WaitOperation,
): Computed<Promise<McpGetChatStatusOutput | null>> {
  return computed(async (get): Promise<McpGetChatStatusOutput | null> => {
    operation.latest = await get(
      observeMcpChatStatus(
        runtime,
        principal,
        args,
        signal,
        operation.effectiveMs > 0,
      ),
    );
    operation.observations = 1;
    if (operation.latest === null) {
      return null;
    }
    if (operation.effectiveMs === 0) {
      checkResponseSize(operation.latest);
      return operation.latest;
    }
    operation.waitStartedAt = monotonicNow();
    const completed = completeObservedWait(operation.latest, operation);
    return (
      completed ??
      (await get(
        waitForMcpChatStatus(runtime, principal, args, signal, operation),
      ))
    );
  });
}

function waitLogDetails(
  operation: WaitOperation,
  outcome: WaitOutcome | "cancelled" | "error",
  returnReason:
    | WaitReturnReason
    | "request_cancelled"
    | "conversation_not_found"
    | "observation_error",
): Parameters<typeof recordWaitTelemetry>[1] {
  return {
    requestedMs: operation.requestedMs,
    effectiveMs: operation.effectiveMs,
    elapsedMs: elapsedWait(operation),
    observations: operation.observations,
    outcome,
    returnReason,
    principalOccupancy: operation.principalOccupancy,
    runtimeOccupancy: operation.runtimeOccupancy,
  };
}

export function getMcpChatStatus(
  runtime: { readonly db: Db; readonly bucket: string },
  principal: Principal,
  args: McpGetChatStatusInput,
  signal: AbortSignal,
): Computed<Promise<McpChatStatusResult>> {
  return computed(async (get): Promise<McpChatStatusResult> => {
    const requestedMs = args.waitMs ?? 0;
    const operation: WaitOperation = {
      requestedMs,
      effectiveMs: Math.min(requestedMs, MCP_CHAT_STATUS_MAX_WAIT_MS),
      latest: null,
      observations: 0,
      waitStartedAt: monotonicNow(),
      principalOccupancy: 0,
      runtimeOccupancy: 0,
    };
    const result = await settleIncludingAbort(
      get(executeMcpChatStatus(runtime, principal, args, signal, operation)),
    );
    if (signal.aborted) {
      if (operation.effectiveMs > 0) {
        recordWaitTelemetry(
          operation.latest,
          waitLogDetails(operation, "cancelled", "request_cancelled"),
        );
      }
      signal.throwIfAborted();
    }
    if (!result.ok && isAbortError(result.error)) {
      if (operation.effectiveMs > 0) {
        recordWaitTelemetry(
          operation.latest,
          waitLogDetails(operation, "cancelled", "request_cancelled"),
        );
      }
      throw result.error;
    }
    if (operation.effectiveMs > 0) {
      const completed = result.ok ? result.value : null;
      if (completed?.wait) {
        recordWaitTelemetry(
          completed,
          waitLogDetails(
            operation,
            completed.wait.outcome,
            completed.wait.returnReason,
          ),
        );
      } else if (!result.ok) {
        recordWaitTelemetry(
          operation.latest,
          waitLogDetails(operation, "error", "observation_error"),
        );
      } else if (completed === null) {
        recordWaitTelemetry(
          operation.latest,
          waitLogDetails(operation, "error", "conversation_not_found"),
        );
      }
    }
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
