import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import { command } from "ccstate";
import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { DiscordQueuedLaunchUnavailableError } from "./discord-queued-launch-context.service";
import { WechatLaunchUnavailableError } from "./wechat-context.service";
import {
  activeInputDeliveryPromptFitsControlPayload,
  activeInputSourceFields,
  materializeActiveInputSource$,
  type ActiveInputSourceRow,
} from "./active-input-prompt.service";
import { runTimeBudgetEventIdForRun } from "./assistant-event-id";
import { chatEventReplacementInsertSql } from "./chat-event.service";
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
  | { readonly outcome: "appended" }
  | { readonly outcome: "steered" }
  | { readonly outcome: "rejected" }
  | { readonly outcome: "invalid" };

const loadActiveInputDeliveryScope$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<ActiveInputDeliveryScope | null> => {
    const [row] = await get(db$)
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
  },
);

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
 * The thread position of the queue input the run consumed last. Its latest
 * replacement is appended when it consumes the input, after prompts queued in
 * the meantime, so the anchor is the position of the input it revoked. Two
 * bounded reads: the run's latest replacement, then its source by primary key.
 */
const steeringAnchorSeqId$ = command(
  async ({ get }, scope: ActiveInputRunThread): Promise<number> => {
    const db = get(db$);
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
  },
);

/**
 * The next run-less, unrevoked prompt or budget a running sandbox may steer.
 * Prompts follow the last consumed queue input; the run's own budget remains
 * eligible regardless of that anchor. Both are returned in sequence order.
 * Read-only.
 * A prompt that cannot be steered as is (its Discord binding is gone, or it
 * exceeds the control payload) yields `null` and stays queued for the next
 * pick, which rejects or launches it; later prompts do not overtake it.
 */
export const loadNextSteerableInput$ = command(
  async (
    { get, set },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<NextSteerableInputResult> => {
    const db = get(db$);
    const scope = await set(loadActiveInputDeliveryScope$, args, signal);
    if (!scope) {
      return { outcome: "forbidden" };
    }
    if (scope.status !== "running") {
      return { outcome: "found", input: null };
    }
    const afterSeqId = await set(steeringAnchorSeqId$, scope);
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
    const sourceChatThreadId = scope.chatThreadId;
    const sourceEventIds = [next.id];
    const [source] = await db
      .select(activeInputSourceFields())
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, sourceChatThreadId),
          inArray(chatEvents.id, sourceEventIds),
        ),
      );
    signal.throwIfAborted();
    if (!source) {
      throw new Error("Pending steerable input disappeared from its thread");
    }
    const prompt = await settle(
      set(materializeActiveInputSource$, source, scope, signal),
      signal,
    );
    if (!prompt.ok) {
      if (
        !(prompt.error instanceof DiscordQueuedLaunchUnavailableError) &&
        !(prompt.error instanceof WechatLaunchUnavailableError)
      ) {
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
  },
);

/**
 * The runner handed a prompt or its own budget to the model. Consume it with
 * a replacement; a replacement by this run makes a repeat idempotent, and any
 * other revoker is a conflict the runner ignores.
 */
export const declareSteeredInput$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly eventId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<SteeredInputDeclarationResult> => {
    const db = set(writeDb$);
    const scope = await set(loadActiveInputDeliveryScope$, args, signal);
    if (!scope) {
      return { outcome: "forbidden" };
    }
    const running = scope.status === "running";
    const sourceEventId = args.eventId;
    const append = running;
    const consumed = await (async (): Promise<ActiveInputConsumption> => {
      const sourceChatThreadId = scope.chatThreadId;
      const sourceEventIds = [sourceEventId];
      const [source] = await db
        .select(activeInputSourceFields())
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.chatThreadId, sourceChatThreadId),
            inArray(chatEvents.id, sourceEventIds),
          ),
        );
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
        const steeredInput = {
          chatThreadId: scope.chatThreadId,
          runId: scope.runId,
          userMessage: source.userMessage,
        };
        const replacement =
          parseRawRows(
            chatEventCommandResultSchema,
            await db.execute(
              chatEventReplacementInsertSql(
                replacementTarget(source),
                source.eventType === "input.budget"
                  ? { ...steeredInput, eventType: "input.budget" }
                  : { ...steeredInput, eventType: "input.prompt" },
              ),
            ),
          )[0] ?? null;
        if (replacement) {
          return { outcome: "appended" };
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
    })();
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
    return {
      outcome: "steered",
      replacementsAppended: consumed.outcome === "appended",
      chatThreadId: scope.chatThreadId,
    };
  },
);

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
export const expireRunTimeBudgetInput$ = command(
  async (
    { set },
    args: ActiveInputRunThread,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const expired = await settle(set(revokePendingRunTimeBudgetInput$, args));
    signal.throwIfAborted();
    if (!expired.ok) {
      L.error("Failed to expire run time budget input", {
        runId: args.runId,
        error: expired.error,
      });
      return false;
    }
    return expired.value;
  },
);

const revokePendingRunTimeBudgetInput$ = command(
  async ({ set }, args: ActiveInputRunThread): Promise<boolean> => {
    const db = set(writeDb$);
    const sourceChatThreadId = args.chatThreadId;
    const sourceEventIds = [runTimeBudgetEventIdForRun(args.runId)];
    const [source] = await db
      .select(activeInputSourceFields())
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, sourceChatThreadId),
          inArray(chatEvents.id, sourceEventIds),
        ),
      );
    if (!source) {
      return false;
    }
    const revoked =
      parseRawRows(
        chatEventCommandResultSchema,
        await db.execute(
          chatEventReplacementInsertSql(replacementTarget(source), {
            chatThreadId: args.chatThreadId,
            eventType: "control.revoke",
            runId: args.runId,
          }),
        ),
      )[0] ?? null;
    return revoked !== null;
  },
);
