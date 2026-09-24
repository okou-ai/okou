import { command } from "ccstate";
import { isSplitChatEventWriteEnabled } from "./chat-event-write-mode.service";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { runOutputMemoryCitations } from "@okouai/db/schema/run-output-memory-citation";
import { publicAssistantBalanceError } from "./run-balance-presentation";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import type { Tx } from "../../lib/db-types";
import { settleIncludingAbort } from "../utils";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import {
  insertAssistantEventsInTransaction,
  type InsertAssistantEventsInput,
} from "./chat-event-shared.service";
import {
  publishFirstAssistantEventCreatedSignalSafely,
  recordFirstAssistantEventAcknowledgementMetric,
} from "./chat-first-assistant-event-metric.service";
import { writeRunMetadataInTransaction } from "./agent-run-metadata-write.service";
import { historicalRunGroupId } from "./run-event-provenance.service";
import {
  withRunContentWrite,
  withRunOutputWrite,
  RunContentOwnershipChangedError,
  prepareRunOutputOwnership,
  type RunOutputDiagnostics,
  type RunContentOwnership,
} from "./run-content-erasure-admission.service";
import {
  normalizeRunOutputEvents,
  type EventCitation,
} from "./pi-memory-citation-events";

const log = logger("api:run-output-projection");

interface OutputCandidate {
  readonly sequenceNumber: number;
  readonly content: string;
}

export interface MaterializedChatProjection {
  readonly thread: {
    readonly chatThreadId: string;
    readonly userId: string;
    readonly orgId: string;
  };
  readonly insertedRowCount: number;
  readonly eventPublished?: boolean;
  readonly firstAssistantAcknowledgement: {
    readonly apiStartedAt: number;
    readonly acknowledgedAt: number;
  } | null;
}

type RunOutputMaterializationResult =
  | {
      readonly outcome: "accepted";
      readonly chatProjection: MaterializedChatProjection | null;
      readonly payload: EventConsumerPayload;
      readonly ownership: RunContentOwnership;
    }
  | { readonly outcome: "ignored-timeout" | "ignored-closure" };

interface RunOutputEventAdmission {
  readonly diagnostics: RunOutputDiagnostics;
  readonly payload: EventConsumerPayload;
  readonly suppliedCitations: readonly EventCitation[];
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

function codexReasoningText(event: AgentEvent): string | null {
  if (event.type !== "item.completed") {
    return null;
  }
  const item = recordOf(event.item);
  if (
    item?.type !== "reasoning" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return null;
  }
  return item.text;
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
      continue;
    }

    const reasoningText = codexReasoningText(event);
    if (reasoningText !== null) {
      items.push({
        eventType: "output.thinking",
        runEventSequenceNumber: event.sequenceNumber,
        thinking: reasoningText,
        runEventId: eventOutputId(event),
      });
      continue;
    }
  }
  return items;
}

interface AssistantEventInsertion {
  readonly insertedRowCount: number;
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}

async function insertRunOutputChatEvents(
  tx: Db | Tx,
  payload: EventConsumerPayload,
  thread: MaterializedChatProjection["thread"],
  runContext: {
    readonly runGroupId: string | undefined;
    readonly modelProvider: string | null;
    readonly splitWrites?: boolean;
    readonly items?: InsertAssistantEventsInput["items"];
  },
  signal: AbortSignal,
): Promise<AssistantEventInsertion> {
  const assistantItems =
    runContext.items ??
    assistantEventItems({
      events: payload.events,
      modelProvider: runContext.modelProvider,
    });
  return await insertAssistantEventsInTransaction(
    tx,
    {
      runId: payload.runId,
      threadId: thread.chatThreadId,
      userId: thread.userId,
      orgId: thread.orgId,
      items: assistantItems,
      runGroupId: runContext.runGroupId,
      splitWrites: runContext.splitWrites,
    },
    signal,
  );
}

async function insertMemoryCitations(
  tx: Db | Tx,
  runId: string,
  citations: readonly EventCitation[],
): Promise<void> {
  if (citations.length === 0) {
    return;
  }
  await tx
    .insert(runOutputMemoryCitations)
    .values(
      citations.map((item) => {
        return {
          runId,
          sequenceNumber: item.sequenceNumber,
          citation: item.citation,
        };
      }),
    )
    .onConflictDoNothing();
}

function preparedRunOutputProjection(
  payload: EventConsumerPayload,
  suppliedCitations: readonly EventCitation[],
): {
  readonly payload: EventConsumerPayload;
  readonly citations: readonly EventCitation[];
  readonly latestResult: OutputCandidate | null;
  readonly latestOutput: OutputCandidate | null;
} {
  const normalized = normalizeRunOutputEvents(payload, suppliedCitations);
  return {
    ...normalized,
    latestResult: latestCandidate(normalized.payload.events, resultText),
    latestOutput: latestCandidate(
      normalized.payload.events,
      callbackOutputText,
    ),
  };
}

interface AdmittedRunOutputArgs {
  readonly tx: Db | Tx;
  readonly ownership: RunContentOwnership;
  readonly payload: EventConsumerPayload;
  readonly thread: MaterializedChatProjection["thread"] | null;
  readonly latestResult: OutputCandidate | null;
  readonly latestOutput: OutputCandidate | null;
  readonly citations: readonly EventCitation[];
  readonly runGroupId: string | undefined;
  readonly modelProvider: string | null;
  readonly splitWrites?: boolean;
  readonly diagnostics?: RunOutputDiagnostics;
  readonly insertion?: AssistantEventInsertion;
  readonly eventPublished?: boolean;
}

function createRunOutputAuxiliaryWriter(
  args: AdmittedRunOutputArgs,
  failures: unknown[],
  signal: AbortSignal,
) {
  return async <T>(
    phase:
      | "run_materialization"
      | "memory_citations"
      | "first_assistant_metric",
    write: () => Promise<T>,
  ): Promise<T | undefined> => {
    args.diagnostics?.enter(phase);
    if (!args.splitWrites) {
      return await write();
    }
    const startedAt = performance.now();
    const result = await settleIncludingAbort(write());
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
      args.diagnostics?.recordFailure(result.error);
    }
    failures.push(result.error);
    signal.throwIfAborted();
    return undefined;
  };
}

async function upsertRunOutputMaterialization(
  args: AdmittedRunOutputArgs,
): Promise<void> {
  const { tx, payload, latestResult, latestOutput } = args;
  if (latestResult !== null || latestOutput !== null) {
    const updatedAt = nowDate();
    await tx
      .insert(runOutputMaterializations)
      .values({
        runId: payload.runId,
        latestResultSequence: latestResult?.sequenceNumber,
        latestResultText: latestResult?.content,
        latestOutputSequence: latestOutput?.sequenceNumber,
        latestOutputText: latestOutput?.content,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: runOutputMaterializations.runId,
        set: {
          latestResultSequence:
            latestResult === null
              ? runOutputMaterializations.latestResultSequence
              : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestResultSequence}, -1)`, latestResult.sequenceNumber)} then ${latestResult.sequenceNumber} else ${runOutputMaterializations.latestResultSequence} end`,
          latestResultText:
            latestResult === null
              ? runOutputMaterializations.latestResultText
              : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestResultSequence}, -1)`, latestResult.sequenceNumber)} then ${latestResult.content} else ${runOutputMaterializations.latestResultText} end`,
          latestOutputSequence:
            latestOutput === null
              ? runOutputMaterializations.latestOutputSequence
              : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestOutputSequence}, -1)`, latestOutput.sequenceNumber)} then ${latestOutput.sequenceNumber} else ${runOutputMaterializations.latestOutputSequence} end`,
          latestOutputText:
            latestOutput === null
              ? runOutputMaterializations.latestOutputText
              : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestOutputSequence}, -1)`, latestOutput.sequenceNumber)} then ${latestOutput.content} else ${runOutputMaterializations.latestOutputText} end`,
          updatedAt,
        },
      });
  }
}

async function claimFirstAssistantAcknowledgement(
  args: AdmittedRunOutputArgs,
  shouldClaim: boolean,
  auxiliary: ReturnType<typeof createRunOutputAuxiliaryWriter>,
) {
  if (!shouldClaim) {
    return null;
  }
  const acknowledgedAt = nowDate();
  const firstAssistantClaimWhere = and(
    eq(agentRuns.id, args.payload.runId),
    isNotNull(agentRuns.apiStartedAt),
    isNull(agentRuns.firstAssistantEventAcknowledgedAt),
  );
  if (!firstAssistantClaimWhere) {
    throw new Error("First assistant acknowledgement predicate is empty");
  }
  const [firstAssistantClaim] =
    (await auxiliary("first_assistant_metric", () => {
      return writeRunMetadataInTransaction(args.tx, {
        patch: { firstAssistantEventAcknowledgedAt: acknowledgedAt },
        where: firstAssistantClaimWhere,
      });
    })) ?? [];
  return firstAssistantClaim?.apiStartedAt
    ? {
        apiStartedAt: firstAssistantClaim.apiStartedAt.getTime(),
        acknowledgedAt: acknowledgedAt.getTime(),
      }
    : null;
}

async function materializeAdmittedRunOutputEvents(
  args: AdmittedRunOutputArgs,
  signal: AbortSignal,
): Promise<RunOutputMaterializationResult> {
  const { tx, payload, thread, citations } = args;
  const failures: unknown[] = [];
  const auxiliary = createRunOutputAuxiliaryWriter(args, failures, signal);
  let insertedRowCount = args.insertion?.insertedRowCount ?? 0;
  let shouldAttemptFirstAssistantEventClaim =
    args.insertion?.shouldAttemptFirstAssistantEventClaim ?? false;
  if (thread && !args.insertion) {
    args.diagnostics?.enter("chat_event_append");
    const insertion = await insertRunOutputChatEvents(
      tx,
      payload,
      thread,
      {
        runGroupId: args.runGroupId,
        modelProvider: args.modelProvider,
        splitWrites: args.splitWrites,
      },
      signal,
    );
    insertedRowCount = insertion.insertedRowCount;
    shouldAttemptFirstAssistantEventClaim =
      insertion.shouldAttemptFirstAssistantEventClaim;
  }

  await auxiliary("run_materialization", () => {
    return upsertRunOutputMaterialization(args);
  });
  await auxiliary("memory_citations", () => {
    return insertMemoryCitations(tx, payload.runId, citations);
  });
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

  const firstAssistantAcknowledgement =
    await claimFirstAssistantAcknowledgement(
      args,
      shouldAttemptFirstAssistantEventClaim &&
        (insertedRowCount > 0 || args.splitWrites === true),
      auxiliary,
    );
  if (args.splitWrites && firstAssistantAcknowledgement) {
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
      firstAssistantAcknowledgement: args.splitWrites
        ? null
        : firstAssistantAcknowledgement,
    },
  };
}

async function materializeSplitRunOutputEvents(
  writeDb: Db,
  args: {
    readonly prepared: ReturnType<typeof preparedRunOutputProjection>;
    readonly preparedOwnership: NonNullable<
      Awaited<ReturnType<typeof prepareRunOutputOwnership>>
    >;
    readonly runGroupId: string | undefined;
    readonly diagnostics: RunOutputDiagnostics;
  },
  signal: AbortSignal,
): Promise<RunOutputMaterializationResult> {
  const { prepared, preparedOwnership, runGroupId, diagnostics } = args;
  const { ownership } = preparedOwnership;
  const { payload } = prepared;
  const splitWrites = true;
  const items = assistantEventItems({
    events: prepared.payload.events,
    modelProvider: preparedOwnership.modelProvider,
  });
  const projection = await withRunOutputWrite(
    writeDb,
    {
      runId: payload.runId,
      runOwner: payload.context,
      ownership,
      diagnostics,
    },
    async (tx, current) => {
      if (current.status === "timeout") {
        return null;
      }
      if (current.modelProvider !== preparedOwnership.modelProvider) {
        throw new RunContentOwnershipChangedError(
          "Run provider changed during output preparation",
        );
      }
      const thread =
        current.ownership.triggerSource !== null && current.ownership.thread
          ? { ...current.ownership.thread, orgId: current.ownership.orgId }
          : null;
      diagnostics.enter("chat_event_append");
      const insertion = thread
        ? await insertRunOutputChatEvents(
            tx,
            prepared.payload,
            thread,
            {
              runGroupId,
              modelProvider: current.modelProvider,
              splitWrites,
              items,
            },
            signal,
          )
        : undefined;
      return { ...current, thread, insertion };
    },
    signal,
  );
  if (!projection) {
    return { outcome: "ignored-timeout" };
  }
  // Auxiliary failures must not hide a committed event from live clients.
  // Retried receipts dedupe the row and therefore cannot own this wakeup.
  const eventPublished = Boolean(
    projection.thread && projection.insertion?.insertedRowCount,
  );
  if (eventPublished && projection.thread) {
    await publishChatThreadMessageCreatedSafely({
      userId: projection.thread.userId,
      orgId: projection.thread.orgId,
      threadId: projection.thread.chatThreadId,
    });
  }
  return await materializeAdmittedRunOutputEvents(
    {
      tx: writeDb,
      ownership: projection.ownership,
      payload: prepared.payload,
      thread: projection.thread,
      latestResult: prepared.latestResult,
      latestOutput: prepared.latestOutput,
      citations: prepared.citations,
      runGroupId,
      modelProvider: projection.modelProvider,
      insertion: projection.insertion,
      eventPublished,
      splitWrites,
      diagnostics,
    },
    signal,
  );
}

export async function materializeRunOutputEvents(
  writeDb: Db,
  admission: RunOutputEventAdmission,
  signal: AbortSignal,
): Promise<RunOutputMaterializationResult> {
  const { payload, suppliedCitations, diagnostics } = admission;
  diagnostics.startAttempt("preparation");
  const prepared = preparedRunOutputProjection(payload, suppliedCitations);

  const preparedOwnership = await prepareRunOutputOwnership(
    writeDb,
    payload.runId,
    diagnostics,
  );
  signal.throwIfAborted();
  if (!preparedOwnership) {
    return { outcome: "ignored-timeout" };
  }
  const { ownership } = preparedOwnership;
  diagnostics.enter("preparation");
  const runGroupId =
    ownership.thread &&
    prepared.payload.events.some((event) => {
      return (
        assistantMessageText(event) !== null ||
        codexReasoningText(event) !== null
      );
    })
      ? await historicalRunGroupId(writeDb, payload.runId, undefined, signal)
      : undefined;
  const splitWrites = await isSplitChatEventWriteEnabled(writeDb);
  if (splitWrites) {
    return await materializeSplitRunOutputEvents(
      writeDb,
      { prepared, preparedOwnership, runGroupId, diagnostics },
      signal,
    );
  }
  const result = await withRunContentWrite(
    writeDb,
    { runId: payload.runId, runOwner: payload.context, ownership, diagnostics },
    async (
      tx,
      ownership,
      status,
      modelProvider,
    ): Promise<RunOutputMaterializationResult> => {
      if (status === "timeout") {
        return { outcome: "ignored-timeout" };
      }
      const thread =
        ownership.triggerSource !== null && ownership.thread
          ? { ...ownership.thread, orgId: ownership.orgId }
          : null;
      return await materializeAdmittedRunOutputEvents(
        {
          tx,
          ownership,
          payload: prepared.payload,
          thread,
          latestResult: prepared.latestResult,
          latestOutput: prepared.latestOutput,
          citations: prepared.citations,
          runGroupId,
          modelProvider,
          splitWrites,
        },
        signal,
      );
    },
    signal,
  );
  return result.outcome === "closed"
    ? { outcome: "ignored-closure" }
    : result.value;
}

export const materializeRunOutputEvents$ = command(
  async (
    { set },
    admission: RunOutputEventAdmission,
    signal: AbortSignal,
  ): Promise<RunOutputMaterializationResult> => {
    const result = await settleIncludingAbort(
      materializeRunOutputEvents(set(writeDb$), admission, signal),
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
  if (projection.firstAssistantAcknowledgement) {
    recordFirstAssistantEventAcknowledgementMetric({
      runId: payload.runId,
      ...projection.firstAssistantAcknowledgement,
    });
  }
  if (projection.insertedRowCount === 0 || projection.eventPublished) {
    return;
  }
  if (projection.firstAssistantAcknowledgement) {
    await publishFirstAssistantEventCreatedSignalSafely({
      userId: projection.thread.userId,
      orgId: projection.thread.orgId,
      threadId: projection.thread.chatThreadId,
    });
  } else {
    await publishChatThreadMessageCreatedSafely({
      userId: projection.thread.userId,
      orgId: projection.thread.orgId,
      threadId: projection.thread.chatThreadId,
    });
  }
  signal.throwIfAborted();
}
