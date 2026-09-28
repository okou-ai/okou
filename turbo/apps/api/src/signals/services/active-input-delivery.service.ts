import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { settle } from "../utils";
import { nowDate } from "../../lib/time";
import { touchChatThreadLastMessageAtIndependently } from "./chat-event-shared.service";
import { DiscordQueuedLaunchUnavailableError } from "./discord-queued-launch-context.service";
import {
  activeInputDeliveryPromptFitsControlPayload,
  activeInputRowsByIds,
  activeInputTemplateIdentities,
  materializeActiveInputSource,
  type ActiveInputSourceRow,
} from "./active-input-prompt.service";
import { logTemplateUsage } from "../../lib/template-usage-log";
import { runTimeBudgetEventIdForRun } from "./assistant-event-id";
import { insertChatEvent, replaceLoadedChatEvent } from "./chat-event.service";
import { listPendingChatInputs } from "./chat-event-queue.service";

/*
 * Steering a pending input into a running sandbox run.
 *
 * The delivery ID the runner and guest carry is the source chat event ID.
 * Reserve only reads; receipt and completion consume the source by appending
 * a replacement that carries the run ID and revokes the source. The unique
 * revoke edge is the only mutual exclusion against pick, recall and other
 * consumers: the loser re-reads the revoker and treats a replacement by the
 * same run as already delivered.
 */

const L = logger("active-input-delivery");

interface ActiveInputDeliveryScope {
  readonly runId: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly status: RunStatus;
}

interface ActiveInputRunThread {
  readonly runId: string;
  readonly chatThreadId: string;
}

type ReserveActiveInputDeliveryResult =
  | {
      readonly outcome: "reserved";
      readonly deliveryId: string;
      readonly prompt: string;
    }
  | { readonly outcome: "empty" }
  | { readonly outcome: "terminal" }
  | {
      readonly outcome: "rejected";
      readonly reason: "payload_too_large" | "run_not_running";
    }
  | { readonly outcome: "forbidden" };

type RecordActiveInputDeliveryReceiptResult =
  | {
      readonly outcome: "delivered";
      readonly replacementsAppended: boolean;
      readonly chatThreadId: string;
    }
  | { readonly outcome: "rejected"; readonly replacementsAppended: false }
  | { readonly outcome: "forbidden"; readonly replacementsAppended: false };

type SteeredInputDeclarationResult =
  | {
      readonly outcome: "steered";
      readonly replacementsAppended: boolean;
      readonly chatThreadId: string;
    }
  | {
      readonly outcome: "conflict";
      readonly reason: "input_already_consumed" | "run_not_running";
    }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "forbidden" };

interface NextSteerableInput {
  readonly eventId: string;
  readonly prompt: string;
}

type NextSteerableInputResult =
  | { readonly outcome: "found"; readonly input: NextSteerableInput | null }
  | { readonly outcome: "forbidden" };

type SteerableEventType = "input.prompt" | "input.budget";

const RECEIPT_EVENT_TYPES: readonly SteerableEventType[] = [
  "input.prompt",
  "input.budget",
];

/**
 * Queue inputs a run consumes in thread order. Budget input is excluded: it is
 * appended whenever the run nears its time limit, so its position says nothing
 * about which queued prompts the run has already taken.
 */
const RUN_QUEUE_INPUT_EVENT_TYPES = [
  "input.prompt",
  "input.automation",
] as const;

type ActiveInputConsumption =
  | { readonly outcome: "appended"; readonly source: ActiveInputSourceRow }
  | { readonly outcome: "delivered" }
  | { readonly outcome: "rejected" }
  | { readonly outcome: "invalid" };

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

async function loadActiveInputDeliveryScope(
  db: Db,
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<ActiveInputDeliveryScope | null> {
  const [row] = await db
    .select({
      runId: agentRuns.id,
      chatThreadId: agentRuns.chatThreadId,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.orgId, args.orgId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row?.chatThreadId) {
    return null;
  }
  return {
    ...row,
    chatThreadId: row.chatThreadId,
    status: runStatusSchema.parse(row.status),
  };
}

/** A run-less input the run may consume: any prompt, or its own budget. */
function sourceIsPendingForRun(
  source: ActiveInputSourceRow,
  runId: string,
): boolean {
  if (source.runId !== null) {
    return false;
  }
  if (source.eventType === "input.prompt") {
    return true;
  }
  return (
    source.eventType === "input.budget" &&
    source.contextType === "agent_run" &&
    source.contextId === runId
  );
}

function replacementTarget(source: ActiveInputSourceRow) {
  return {
    id: source.id,
    chatThreadId: source.chatThreadId,
    createdAt: source.createdAt,
    eventType: source.eventType,
    contextType: source.contextType,
    contextId: source.contextId,
  };
}

/**
 * Reserve the thread's earliest pending prompt, or this run's budget input,
 * for a running sandbox run. Read-only: the source stays pending until the
 * receipt consumes it, so a repeated reserve returns the same source.
 */
export async function reserveActiveInputDelivery(
  db: Db,
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<ReserveActiveInputDeliveryResult> {
  const scope = await loadActiveInputDeliveryScope(db, args, signal);
  if (!scope) {
    return { outcome: "forbidden" };
  }
  if (isTerminalRunStatus(scope.status)) {
    return { outcome: "terminal" };
  }
  if (scope.status !== "running") {
    return { outcome: "rejected", reason: "run_not_running" };
  }
  const [head] = await listPendingChatInputs(db, {
    chatThreadId: scope.chatThreadId,
    eventTypes: ["input.prompt"],
    budgetForRunId: scope.runId,
  });
  signal.throwIfAborted();
  if (!head) {
    return { outcome: "empty" };
  }
  const [source] = await activeInputRowsByIds(db, scope.chatThreadId, [
    head.id,
  ]);
  signal.throwIfAborted();
  if (!source) {
    throw new Error("Pending active input disappeared from its thread");
  }
  const prompt = await settle(
    materializeActiveInputSource(db, source, scope, signal),
    signal,
  );
  if (!prompt.ok) {
    if (!(prompt.error instanceof DiscordQueuedLaunchUnavailableError)) {
      throw prompt.error;
    }
    await rejectUnavailableDiscordActiveInput(db, scope, source, signal);
    return { outcome: "empty" };
  }
  if (!activeInputDeliveryPromptFitsControlPayload(source.id, prompt.value)) {
    return { outcome: "rejected", reason: "payload_too_large" };
  }
  return { outcome: "reserved", deliveryId: source.id, prompt: prompt.value };
}

/**
 * Consume one delivered source for the run with a single replacement insert.
 * On a revoke-edge conflict the revoker decides: this run's replacement means
 * the source was already delivered, anything else means another consumer won.
 * Without `append` (the run is no longer running) only the revoker is read, so
 * a repeated receipt stays idempotent. A source outside the run's thread or of
 * another event type is `invalid`.
 */
async function consumeActiveInputSource(
  db: Db,
  scope: ActiveInputRunThread,
  sourceEventId: string,
  append: boolean,
  eventTypes: readonly SteerableEventType[] = RECEIPT_EVENT_TYPES,
): Promise<ActiveInputConsumption> {
  const [source] = await activeInputRowsByIds(db, scope.chatThreadId, [
    sourceEventId,
  ]);
  if (
    !source?.userMessage ||
    !eventTypes.some((eventType) => {
      return eventType === source.eventType;
    })
  ) {
    return { outcome: "invalid" };
  }
  if (append && sourceIsPendingForRun(source, scope.runId)) {
    const target = replacementTarget(source);
    const replacement =
      source.eventType === "input.budget"
        ? await replaceLoadedChatEvent(db, target, {
            chatThreadId: scope.chatThreadId,
            eventType: "input.budget",
            runId: scope.runId,
            userMessage: source.userMessage,
          })
        : await replaceLoadedChatEvent(db, target, {
            chatThreadId: scope.chatThreadId,
            eventType: "input.prompt",
            runId: scope.runId,
            userMessage: source.userMessage,
          });
    if (replacement) {
      return { outcome: "appended", source };
    }
  }
  const [revoker] = await db
    .select({ eventType: chatEvents.eventType, runId: chatEvents.runId })
    .from(chatEvents)
    .where(eq(chatEvents.revokesEventId, source.id))
    .limit(1);
  return revoker?.runId === scope.runId &&
    revoker.eventType === source.eventType
    ? { outcome: "delivered" }
    : { outcome: "rejected" };
}

function logSteeredTemplateUsage(
  scope: ActiveInputDeliveryScope,
  source: ActiveInputSourceRow,
): void {
  if (source.eventType !== "input.prompt" || !source.userMessage) {
    return;
  }
  logTemplateUsage(
    {
      dispatchPath: "active-input",
      orgId: scope.orgId,
      userId: scope.userId,
      chatThreadId: scope.chatThreadId,
    },
    activeInputTemplateIdentities(source.userMessage),
  );
}

/** The guest confirmed it handed the source to the model of a running run. */
export async function recordActiveInputDeliveryReceipt(
  db: Db,
  args: {
    readonly runId: string;
    readonly deliveryId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<RecordActiveInputDeliveryReceiptResult> {
  const scope = await loadActiveInputDeliveryScope(db, args, signal);
  if (!scope) {
    return { outcome: "forbidden", replacementsAppended: false };
  }
  const consumed = await consumeActiveInputSource(
    db,
    scope,
    args.deliveryId,
    scope.status === "running",
  );
  signal.throwIfAborted();
  if (consumed.outcome === "rejected" || consumed.outcome === "invalid") {
    return { outcome: "rejected", replacementsAppended: false };
  }
  if (consumed.outcome === "appended") {
    logSteeredTemplateUsage(scope, consumed.source);
  }
  return {
    outcome: "delivered",
    replacementsAppended: consumed.outcome === "appended",
    chatThreadId: scope.chatThreadId,
  };
}

/**
 * The thread position of the queue input the run consumed last. Its latest
 * replacement is appended when it consumes the input, after prompts queued in
 * the meantime, so the anchor is the position of the input it revoked. Two
 * bounded reads: the run's latest replacement, then its source by primary key.
 */
async function steeringAnchorSeqId(
  db: Db,
  scope: ActiveInputRunThread,
): Promise<number> {
  const [ownInput] = await db
    .select({
      seqId: chatEvents.seqId,
      revokesEventId: chatEvents.revokesEventId,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, scope.chatThreadId),
        eq(chatEvents.runId, scope.runId),
        inArray(chatEvents.eventType, [...RUN_QUEUE_INPUT_EVENT_TYPES]),
      ),
    )
    .orderBy(desc(chatEvents.seqId))
    .limit(1);
  if (!ownInput) {
    return 0;
  }
  if (ownInput.revokesEventId === null) {
    return ownInput.seqId;
  }
  const [source] = await db
    .select({ seqId: chatEvents.seqId })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, scope.chatThreadId),
        eq(chatEvents.id, ownInput.revokesEventId),
      ),
    )
    .limit(1);
  if (!source) {
    throw new Error("Consumed run input source is missing from its thread");
  }
  return source.seqId;
}

/**
 * The next `input.prompt` a running sandbox run may steer: the first run-less,
 * unrevoked prompt positioned after the queue input the run consumed last.
 * Read-only.
 * A prompt that cannot be steered as is (its Discord binding is gone, or it
 * exceeds the control payload) yields `null` and stays queued for the next
 * pick, which rejects or launches it; later prompts do not overtake it.
 */
export async function loadNextSteerableInput(
  db: Db,
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<NextSteerableInputResult> {
  const scope = await loadActiveInputDeliveryScope(db, args, signal);
  if (!scope) {
    return { outcome: "forbidden" };
  }
  if (scope.status !== "running") {
    return { outcome: "found", input: null };
  }
  const afterSeqId = await steeringAnchorSeqId(db, scope);
  signal.throwIfAborted();
  const [next] = await listPendingChatInputs(db, {
    chatThreadId: scope.chatThreadId,
    eventTypes: ["input.prompt"],
    afterSeqId,
  });
  signal.throwIfAborted();
  if (!next) {
    return { outcome: "found", input: null };
  }
  const [source] = await activeInputRowsByIds(db, scope.chatThreadId, [
    next.id,
  ]);
  signal.throwIfAborted();
  if (!source) {
    throw new Error("Pending steerable input disappeared from its thread");
  }
  const prompt = await settle(
    materializeActiveInputSource(db, source, scope, signal),
    signal,
  );
  if (!prompt.ok) {
    if (!(prompt.error instanceof DiscordQueuedLaunchUnavailableError)) {
      throw prompt.error;
    }
    return { outcome: "found", input: null };
  }
  if (!activeInputDeliveryPromptFitsControlPayload(source.id, prompt.value)) {
    return { outcome: "found", input: null };
  }
  return {
    outcome: "found",
    input: { eventId: source.id, prompt: prompt.value },
  };
}

/**
 * The runner handed an `input.prompt` to the model of the run. Consume it with
 * the same replacement as a receipt; a replacement by this run makes a repeat
 * idempotent, and any other revoker is a conflict the runner ignores.
 */
export async function declareSteeredInput(
  db: Db,
  args: {
    readonly runId: string;
    readonly eventId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<SteeredInputDeclarationResult> {
  const scope = await loadActiveInputDeliveryScope(db, args, signal);
  if (!scope) {
    return { outcome: "forbidden" };
  }
  const running = scope.status === "running";
  const consumed = await consumeActiveInputSource(
    db,
    scope,
    args.eventId,
    running,
    ["input.prompt"],
  );
  signal.throwIfAborted();
  if (consumed.outcome === "invalid") {
    return { outcome: "not_found" };
  }
  if (consumed.outcome === "rejected") {
    return {
      outcome: "conflict",
      reason: running ? "input_already_consumed" : "run_not_running",
    };
  }
  if (consumed.outcome === "appended") {
    logSteeredTemplateUsage(scope, consumed.source);
  }
  return {
    outcome: "steered",
    replacementsAppended: consumed.outcome === "appended",
    chatThreadId: scope.chatThreadId,
  };
}

/**
 * Consume the sources a completing run reports as delivered, before its
 * terminal transition releases the slot, so a later pick cannot launch them
 * again. Undelivered prompts stay pending for that pick; an undelivered
 * budget input is revoked by `expireRunTimeBudgetInput` after the commit.
 * Returns whether any replacement was appended.
 */
export async function consumeCompletedActiveInputDeliveries(
  db: Db,
  args: ActiveInputRunThread & {
    readonly deliveryIds: readonly string[];
  },
  signal: AbortSignal,
): Promise<boolean> {
  let appended = false;
  for (const deliveryId of new Set(args.deliveryIds)) {
    const consumed = await consumeActiveInputSource(db, args, deliveryId, true);
    signal.throwIfAborted();
    if (consumed.outcome === "appended") {
      appended = true;
    }
  }
  return appended;
}

/**
 * Reject an undelivered Discord follow-up whose current binding is gone. The
 * `input.rejected` replacement consumes the source on the revoke edge; only
 * its winner appends the explanation.
 */
async function rejectUnavailableDiscordActiveInput(
  db: Db,
  scope: ActiveInputDeliveryScope,
  source: ActiveInputSourceRow,
  signal: AbortSignal,
): Promise<void> {
  if (source.contextType !== "discord" || !source.userMessage) {
    throw new Error("Unavailable Discord active input has invalid context");
  }
  const rejectedInput = await replaceLoadedChatEvent(
    db,
    replacementTarget(source),
    {
      chatThreadId: scope.chatThreadId,
      eventType: "input.rejected",
      userMessage: source.userMessage,
      runId: null,
      error: "discord_access_revoked",
    },
  );
  signal.throwIfAborted();
  if (!rejectedInput) {
    return;
  }
  const error = await insertChatEvent(db, {
    chatThreadId: scope.chatThreadId,
    eventType: "output.error",
    content: new DiscordQueuedLaunchUnavailableError().message,
    runId: null,
    error: "discord_access_revoked",
    createdAt: new Date(
      Math.max(nowDate().getTime(), rejectedInput.createdAt.getTime() + 1),
    ),
  });
  signal.throwIfAborted();
  if (!error) {
    throw new Error(
      "Unavailable Discord active input rejection was not appended",
    );
  }
  await touchChatThreadLastMessageAtIndependently(db, scope.chatThreadId, {
    touchedAt: error.createdAt,
  });
  signal.throwIfAborted();
  await publishChatThreadMessageCreatedSafely({
    userId: scope.userId,
    orgId: scope.orgId,
    threadId: scope.chatThreadId,
  });
  signal.throwIfAborted();
  await publishThreadListChangedSafely({
    userId: scope.userId,
    orgId: scope.orgId,
  });
  signal.throwIfAborted();
}

/**
 * Revoke the run's time budget steer when no receipt consumed it.
 *
 * Call only after the terminal transition commits. Steering appends while the
 * run is running, so no budget input can appear afterwards. The budget event
 * ID is derived from the run, so this is one primary-key read and one append;
 * the unique revoke edge lets exactly one of receipt, completion or this
 * expiry consume the source. Best effort: losing that race or failing leaves
 * an inert pending row.
 */
export async function expireRunTimeBudgetInput(
  db: Db,
  args: ActiveInputRunThread,
  signal: AbortSignal,
): Promise<boolean> {
  const expired = await settle(revokePendingRunTimeBudgetInput(db, args));
  signal.throwIfAborted();
  if (!expired.ok) {
    L.error("Failed to expire run time budget input", {
      runId: args.runId,
      error: expired.error,
    });
    return false;
  }
  return expired.value;
}

async function revokePendingRunTimeBudgetInput(
  db: Db,
  args: ActiveInputRunThread,
): Promise<boolean> {
  const [source] = await activeInputRowsByIds(db, args.chatThreadId, [
    runTimeBudgetEventIdForRun(args.runId),
  ]);
  if (!source) {
    return false;
  }
  const revoked = await replaceLoadedChatEvent(db, replacementTarget(source), {
    chatThreadId: args.chatThreadId,
    eventType: "control.revoke",
    runId: args.runId,
  });
  return revoked !== null;
}
