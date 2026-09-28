import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { settle } from "../utils";
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
import { replaceLoadedChatEvent } from "./chat-event.service";
import { listPendingChatInputs } from "./chat-event-queue.service";

/*
 * Steering a pending input into a running sandbox run.
 *
 * The runner reads the next steerable input and declares the source chat event
 * ID it handed to the model. The declaration consumes the source by appending
 * a replacement that carries the run ID and revokes the source. The unique
 * revoke edge is the only mutual exclusion against pick, recall and other
 * consumers: the loser re-reads the revoker and treats a replacement by the
 * same run as already steered.
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
  | { readonly outcome: "steered" }
  | { readonly outcome: "rejected" }
  | { readonly outcome: "invalid" };

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

function replacementTarget(source: ActiveInputSourceRow) {
  return {
    id: source.id,
    chatThreadId: source.chatThreadId,
    createdAt: source.createdAt,
    eventType: source.eventType,
    contextType: source.contextType,
    contextId: source.contextId,
    modelSelection: source.modelSelection,
  };
}

/**
 * Consume one steered prompt or run-targeted budget with a single replacement
 * insert. On a revoke-edge conflict the revoker decides: this run's
 * replacement means the source was already steered, anything else means
 * another consumer won. Without `append` (the run is no longer running) only
 * the revoker is read, so a repeated declaration stays idempotent. A source
 * outside the run's thread or of another event type is `invalid`.
 */
async function consumeActiveInputSource(
  db: Db,
  scope: ActiveInputRunThread,
  sourceEventId: string,
  append: boolean,
): Promise<ActiveInputConsumption> {
  const [source] = await activeInputRowsByIds(db, scope.chatThreadId, [
    sourceEventId,
  ]);
  if (
    !source?.userMessage ||
    (source.eventType !== "input.prompt" &&
      (source.eventType !== "input.budget" ||
        source.contextType !== "agent_run" ||
        source.contextId !== scope.runId))
  ) {
    return { outcome: "invalid" };
  }
  if (append && source.runId === null) {
    const replacement = await replaceLoadedChatEvent(
      db,
      replacementTarget(source),
      {
        chatThreadId: scope.chatThreadId,
        eventType: source.eventType,
        runId: scope.runId,
        userMessage: source.userMessage,
        ...(source.modelSelection === null
          ? {}
          : { modelSelection: source.modelSelection }),
      },
    );
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
    ? { outcome: "steered" }
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
 * The next run-less, unrevoked prompt or budget a running sandbox may steer.
 * Prompts follow the last consumed queue input; the run's own budget remains
 * eligible regardless of that anchor. Both are returned in sequence order.
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
    budgetForRunId: scope.runId,
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
 * The runner handed a prompt or its own budget to the model. Consume it with
 * a replacement; a replacement by this run makes a repeat idempotent, and any
 * other revoker is a conflict the runner ignores.
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
 * Revoke the run's time budget input when nothing consumed it.
 *
 * Call only after the terminal transition commits. Steering appends while the
 * run is running, so no budget input can appear afterwards. The budget event
 * ID is derived from the run, so this is one primary-key read and one append;
 * the unique revoke edge lets exactly one consumer revoke the source. Best
 * effort: a failed expiry leaves an unconsumed budget that neither a later
 * run's steering nor the ordinary queue picker can consume.
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
