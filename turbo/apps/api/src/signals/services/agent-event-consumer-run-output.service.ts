import { command } from "ccstate";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { publicAssistantBalanceError } from "./run-balance-presentation";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { settleIncludingAbort } from "../utils";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import {
  appendAssistantEventRows$,
  type InsertAssistantEventsInput,
} from "./chat-event-shared.service";
import { recordFirstAssistantEventAcknowledgementMetric } from "./chat-first-assistant-event-metric.service";
import { runMetadataWritePlan } from "./agent-run-metadata-write.service";
import { captureRunNativeSession$ } from "./run-native-session.service";
import {
  upsertRunOutputMaterialization$,
  type RunOutputCandidate as OutputCandidate,
} from "./run-output.service";
import {
  assertRunOutputOwner,
  prepareRunOutputOwnership$,
  type PreparedRunOutputOwnership,
  type RunOutputDiagnostics,
  type RunContentOwnership,
} from "./run-content-ownership.service";

const log = logger("api:run-output-projection");

export interface MaterializedChatProjection {
  readonly thread: {
    readonly chatThreadId: string;
    readonly userId: string;
    readonly orgId: string;
  };
  readonly insertedRowCount: number;
  readonly eventPublished: boolean;
}

type RunOutputMaterializationResult =
  | {
      readonly outcome: "accepted";
      readonly chatProjection: MaterializedChatProjection | null;
      readonly payload: EventConsumerPayload;
      readonly ownership: RunContentOwnership;
    }
  | { readonly outcome: "ignored-timeout" };

interface RunOutputEventAdmission {
  readonly diagnostics: RunOutputDiagnostics;
  readonly payload: EventConsumerPayload;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function anthropicMessageText(event: AgentEvent): string | null {
  if (event.type !== "assistant") {
    return null;
  }

  const message = recordOf(event.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    const record = recordOf(block);
    if (
      record?.type === "text" &&
      typeof record.text === "string" &&
      record.text.trim().length > 0
    ) {
      parts.push(record.text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

function codexAgentMessageText(event: AgentEvent): string | null {
  if (event.type !== "item.completed") {
    return null;
  }
  const item = recordOf(event.item);
  if (
    item?.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return null;
  }
  return item.text;
}

function assistantMessageText(event: AgentEvent): string | null {
  return anthropicMessageText(event) ?? codexAgentMessageText(event);
}

function resultText(event: AgentEvent): string | null {
  if (event.type !== "result") {
    return null;
  }

  const directResult = event.result;
  if (typeof directResult === "string" && directResult.trim().length > 0) {
    return directResult;
  }

  const eventData = recordOf(event.eventData);
  const nestedResult = eventData?.result;
  if (typeof nestedResult === "string" && nestedResult.trim().length > 0) {
    return nestedResult;
  }

  return null;
}

function callbackOutputText(event: AgentEvent): string | null {
  return resultText(event) ?? codexAgentMessageText(event);
}

function latestCandidate(
  events: readonly AgentEvent[],
  extractText: (event: AgentEvent) => string | null,
): OutputCandidate | null {
  let latest: OutputCandidate | null = null;
  for (const event of events) {
    const content = extractText(event);
    if (content === null) {
      continue;
    }
    if (latest === null || event.sequenceNumber > latest.sequenceNumber) {
      latest = {
        sequenceNumber: event.sequenceNumber,
        content,
      };
    }
  }
  return latest;
}

function eventOutputId(event: AgentEvent): string {
  if (typeof event.runEventId === "string") {
    return event.runEventId;
  }
  const item = recordOf(event.item);
  if (typeof item?.id === "string") {
    return item.id;
  }

  return `event:${event.sequenceNumber}`;
}

function assistantEventItems(args: {
  readonly events: readonly AgentEvent[];
  readonly modelProvider: string | null;
}): InsertAssistantEventsInput["items"] {
  const items: InsertAssistantEventsInput["items"][number][] = [];
  const events = [...args.events].sort((left, right) => {
    return left.sequenceNumber - right.sequenceNumber;
  });
  for (const event of events) {
    const messageText = assistantMessageText(event);
    if (messageText !== null) {
      const balanceError = publicAssistantBalanceError(
        event,
        args.modelProvider,
      );
      items.push({
        runEventSequenceNumber: event.sequenceNumber,
        runEventId: eventOutputId(event),
        ...(balanceError === undefined
          ? { eventType: "output.message", content: messageText }
          : { eventType: "output.error", error: balanceError }),
      });
    }
  }
  return items;
}

interface AssistantEventInsertion {
  readonly insertedRowCount: number;
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}

function preparedRunOutputProjection(payload: EventConsumerPayload): {
  readonly payload: EventConsumerPayload;
  readonly latestResult: OutputCandidate | null;
  readonly latestOutput: OutputCandidate | null;
} {
  return {
    payload,
    latestResult: latestCandidate(payload.events, resultText),
    latestOutput: latestCandidate(payload.events, callbackOutputText),
  };
}

interface AdmittedRunOutputArgs {
  readonly ownership: RunContentOwnership;
  readonly payload: EventConsumerPayload;
  readonly thread: MaterializedChatProjection["thread"] | null;
  readonly latestResult: OutputCandidate | null;
  readonly latestOutput: OutputCandidate | null;
  readonly diagnostics: RunOutputDiagnostics;
  readonly insertion: AssistantEventInsertion | undefined;
  readonly eventPublished: boolean;
}

async function observeRunOutputAuxiliaryWrite<T>(
  args: AdmittedRunOutputArgs,
  failures: unknown[],
  observation: {
    readonly phase: "run_materialization" | "first_assistant_metric";
    readonly startedAt: number;
  },
  write: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  const { phase, startedAt } = observation;
  const result = await settleIncludingAbort(write);
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: `run_output_${phase}`,
    durationMs: performance.now() - startedAt,
    success: result.ok,
    runId: args.payload.runId,
  });
  if (result.ok) {
    return result.value;
  }
  if (phase === "first_assistant_metric") {
    log.warn("First assistant metric write failed after event commit", {
      runId: args.payload.runId,
      errorCode: safeSqlStateCode(result.error),
    });
    signal.throwIfAborted();
    return undefined;
  }
  // Each projection gets its own attempt after the event commit. Required
  // materializations retry with the existing input receipt; event IDs dedupe.
  if (failures.length === 0) {
    args.diagnostics.recordFailure(result.error);
  }
  failures.push(result.error);
  signal.throwIfAborted();
  return undefined;
}

const materializeAdmittedRunOutputEvents$ = command(
  async (
    { set },
    args: AdmittedRunOutputArgs,
    signal: AbortSignal,
  ): Promise<RunOutputMaterializationResult> => {
    const db = set(writeDb$);
    const { payload, thread } = args;
    const failures: unknown[] = [];
    const insertedRowCount = args.insertion?.insertedRowCount ?? 0;

    args.diagnostics.enter("run_materialization");
    const materializationStartedAt = performance.now();
    await observeRunOutputAuxiliaryWrite(
      args,
      failures,
      { phase: "run_materialization", startedAt: materializationStartedAt },
      set(upsertRunOutputMaterialization$, {
        runId: payload.runId,
        latestResult: args.latestResult,
        latestOutput: args.latestOutput,
      }),
      signal,
    );
    signal.throwIfAborted();

    if (!thread) {
      if (failures.length > 0) {
        throw failures[0];
      }
      return {
        outcome: "accepted",
        chatProjection: null,
        payload,
        ownership: args.ownership,
      };
    }

    let firstAssistantAcknowledgement = null;
    if (args.insertion?.shouldAttemptFirstAssistantEventClaim ?? false) {
      const acknowledgedAt = nowDate();
      const firstAssistantClaimWhere = and(
        eq(agentRuns.id, payload.runId),
        isNotNull(agentRuns.apiStartedAt),
        isNull(agentRuns.firstAssistantEventAcknowledgedAt),
      );
      if (!firstAssistantClaimWhere) {
        throw new Error("First assistant acknowledgement predicate is empty");
      }
      args.diagnostics.enter("first_assistant_metric");
      const acknowledgementStartedAt = performance.now();
      const plan = runMetadataWritePlan({
        patch: { firstAssistantEventAcknowledgedAt: acknowledgedAt },
        where: firstAssistantClaimWhere,
      });
      const [firstAssistantClaim] =
        (await observeRunOutputAuxiliaryWrite(
          args,
          failures,
          {
            phase: "first_assistant_metric",
            startedAt: acknowledgementStartedAt,
          },
          db
            .update(agentRuns)
            .set({
              firstAssistantEventAcknowledgedAt:
                plan.patch.firstAssistantEventAcknowledgedAt,
            })
            .where(plan.where)
            .returning(plan.returning),
          signal,
        )) ?? [];
      firstAssistantAcknowledgement = firstAssistantClaim?.apiStartedAt
        ? {
            apiStartedAt: firstAssistantClaim.apiStartedAt.getTime(),
            acknowledgedAt: acknowledgedAt.getTime(),
          }
        : null;
    }
    if (firstAssistantAcknowledgement) {
      recordFirstAssistantEventAcknowledgementMetric({
        runId: payload.runId,
        ...firstAssistantAcknowledgement,
      });
    }
    if (failures.length > 0) {
      throw failures[0];
    }
    signal.throwIfAborted();

    return {
      outcome: "accepted",
      payload,
      ownership: args.ownership,
      chatProjection: {
        thread,
        insertedRowCount,
        eventPublished: args.eventPublished,
      },
    };
  },
);

const materializePreparedRunOutputEvents$ = command(
  async (
    { set },
    args: {
      readonly prepared: ReturnType<typeof preparedRunOutputProjection>;
      readonly preparedOwnership: PreparedRunOutputOwnership;
      readonly diagnostics: RunOutputDiagnostics;
    },
    signal: AbortSignal,
  ): Promise<RunOutputMaterializationResult> => {
    // Initialize the database before ownership, session and event side effects.
    set(writeDb$);
    const { prepared, preparedOwnership, diagnostics } = args;
    const { ownership } = preparedOwnership;
    const { payload } = prepared;
    const items = assistantEventItems({
      events: prepared.payload.events,
      modelProvider: preparedOwnership.modelProvider,
    });
    // No transaction or run lock: a timeout committed after preparation may admit
    // this batch. The single reserve+insert statement is the only write here.
    assertRunOutputOwner(ownership, payload.context);
    await set(captureRunNativeSession$, payload);
    signal.throwIfAborted();
    const thread =
      ownership.triggerSource !== null && ownership.thread
        ? { ...ownership.thread, orgId: ownership.orgId }
        : null;
    diagnostics.enter("chat_event_append");
    const insertion = thread
      ? await set(
          appendAssistantEventRows$,
          {
            runId: payload.runId,
            threadId: thread.chatThreadId,
            userId: thread.userId,
            orgId: thread.orgId,
            items,
          },
          signal,
        )
      : undefined;
    signal.throwIfAborted();
    // Auxiliary failures must not hide a committed event from live clients.
    // Retried receipts dedupe the row and therefore cannot own this wakeup.
    const eventPublished = Boolean(thread && insertion?.insertedRowCount);
    if (eventPublished && thread) {
      await publishChatThreadMessageCreatedSafely({
        userId: thread.userId,
        orgId: thread.orgId,
        threadId: thread.chatThreadId,
      });
    }
    return await set(
      materializeAdmittedRunOutputEvents$,
      {
        ownership,
        payload: prepared.payload,
        thread,
        latestResult: prepared.latestResult,
        latestOutput: prepared.latestOutput,
        insertion,
        eventPublished,
        diagnostics,
      },
      signal,
    );
  },
);

const prepareAndMaterializeRunOutputEvents$ = command(
  async (
    { set },
    admission: RunOutputEventAdmission,
    signal: AbortSignal,
  ): Promise<RunOutputMaterializationResult> => {
    const { payload, diagnostics } = admission;
    diagnostics.startAttempt("preparation");
    const prepared = preparedRunOutputProjection(payload);

    const preparedOwnership = await set(
      prepareRunOutputOwnership$,
      payload.runId,
      diagnostics,
    );
    signal.throwIfAborted();
    if (!preparedOwnership) {
      return { outcome: "ignored-timeout" };
    }
    diagnostics.enter("preparation");
    return await set(
      materializePreparedRunOutputEvents$,
      { prepared, preparedOwnership, diagnostics },
      signal,
    );
  },
);

export const materializeRunOutputEvents$ = command(
  async (
    { set },
    admission: RunOutputEventAdmission,
    signal: AbortSignal,
  ): Promise<RunOutputMaterializationResult> => {
    const result = await settleIncludingAbort(
      set(prepareAndMaterializeRunOutputEvents$, admission, signal),
    );
    if (signal.aborted) {
      admission.diagnostics.clear();
    }
    if (!result.ok) {
      admission.diagnostics.recordFailure(result.error);
      throw result.error;
    }
    admission.diagnostics.clear();
    return result.value;
  },
);

export async function publishMaterializedChatProjection(
  payload: EventConsumerPayload,
  projection: MaterializedChatProjection,
  signal: AbortSignal,
): Promise<void> {
  if (projection.insertedRowCount === 0 || projection.eventPublished) {
    return;
  }
  await publishChatThreadMessageCreatedSafely({
    userId: projection.thread.userId,
    orgId: projection.thread.orgId,
    threadId: projection.thread.chatThreadId,
  });
  signal.throwIfAborted();
}
