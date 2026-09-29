import { recordWorkflowAutomationRunStart$ } from "./workflow-automation-launch.service";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { settle, tapError } from "../utils";
import {
  isQueueFirstRunClaimLost,
  type DispatchFailedRunCallbacks,
} from "./agent-run-create.service";
import { createQueueFirstAgentRun$ } from "./agent-runs-create.service";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";
import { touchChatThreadLastMessageAt } from "./chat-event-shared.service";
import { insertChatEvent, replaceChatEvent } from "./chat-event.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import {
  assembleQueuedPromptRun$,
  deliverQueuedPromptRejection$,
  recordQueuedPromptRunLaunch$,
  deliverUnexpectedQueuedPromptRejection$,
} from "./internal-chat-run-callback.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { assembleQueuedAutomationRun$ } from "./workflow-chat-event-queue.service";
import { recordWorkflowAdmissionDuration } from "./workflow-queue-admission-timing.service";
import { settleRejectedAutomationInput$ } from "./workflow-schedule-failure.service";
import type {
  ChatQueueHeadContext,
  ChatQueueHeadRejection,
} from "./chat-queue-run-assembly";

const log = logger("ChatQueueConsume");

const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * How consuming one queue head ended:
 * - `launched`: the head was replaced by its run-bound copy and a run started;
 * - `passed`: the head was rejected as `input.rejected`, or was not launched
 *   by this pick. The picker rejects any unchanged head unless the thread
 *   actually has an active run.
 */
export type ChatQueueHeadConsumption =
  | { readonly kind: "launched"; readonly runId: string }
  | { readonly kind: "passed" };

async function loadChatQueueHeadContext(
  db: Db,
  head: { readonly id: string; readonly chatThreadId: string },
): Promise<{
  readonly contextType: string | null;
  readonly contextId: string | null;
  readonly userId: string;
  readonly agentId: string;
} | null> {
  const [thread] = await db
    .select({
      userId: chatThreads.userId,
      agentId: chatThreads.agentId,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, head.chatThreadId))
    .limit(1);
  if (!thread) {
    return null;
  }
  const [event] = await db
    .select({
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, head.id),
        eq(chatEvents.chatThreadId, head.chatThreadId),
      ),
    )
    .limit(1);
  if (!event) {
    return null;
  }
  return {
    ...event,
    userId: thread.userId,
    // Every queue ingress requires an agent; deleting it cascades the thread.
    agentId: z.string().parse(thread.agentId),
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  const code = (value: unknown) => {
    return typeof value === "object" && value !== null && "code" in value
      ? value.code
      : undefined;
  };
  return (
    code(error) === PG_FOREIGN_KEY_VIOLATION ||
    (error instanceof Error && code(error.cause) === PG_FOREIGN_KEY_VIOLATION)
  );
}

async function threadExists(db: Db, chatThreadId: string): Promise<boolean> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return thread !== undefined;
}

/**
 * Consume the head as `input.rejected` followed by the formatted
 * `output.error`, in one transaction. The rejection conflicts on the head's
 * unique revoke edge with any other consumer, so it is written at most once;
 * a lost edge returns null.
 */
async function appendChatQueueHeadRejection(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
    readonly errorMarker: string;
    readonly displayError: string;
  },
): Promise<{ readonly assistantEventId: string } | null> {
  return await db.transaction(async (tx) => {
    const [head] = await tx
      .select({
        userMessage: canonicalChatEventUserMessage(),
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
        ),
      )
      .limit(1);
    if (!head?.userMessage) {
      throw new Error("Queued input event is missing userMessage");
    }
    const rejectedAt = new Date(
      Math.max(nowDate().getTime(), head.createdAt.getTime() + 1),
    );
    const rejected = await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "input.rejected",
      userMessage: head.userMessage,
      runId: null,
      error: args.errorMarker,
      createdAt: rejectedAt,
    });
    if (!rejected) {
      return null;
    }
    const assistant = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "output.error",
      content: args.displayError,
      runId: null,
      error: args.errorMarker,
      createdAt: new Date(rejectedAt.getTime() + 1),
    });
    if (!assistant) {
      throw new Error("Failed to append queued input rejection");
    }
    await touchChatThreadLastMessageAt(
      tx,
      args.chatThreadId,
      assistant.createdAt,
    );
    return { assistantEventId: assistant.id };
  });
}

async function publishChatQueueHeadConsumed(head: {
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  await publishChatThreadMessageCreatedSafely({
    userId: head.userId,
    orgId: head.orgId,
    threadId: head.chatThreadId,
  });
  await publishThreadListChangedSafely({
    userId: head.userId,
    orgId: head.orgId,
  });
}

/**
 * The guidance a direct chat send (web, CLI, MCP, or another agent) shows when
 * the workspace has no spendable credits. Integration inputs use the
 * external-surface formatter instead.
 */
async function directSendInsufficientCreditsMessage(
  db: Db,
  orgId: string,
): Promise<string> {
  const capabilities = await loadOrgPlanCapabilities(db, orgId);
  const appUrl = env("APP_URL");
  if (capabilities?.canBuyCredits !== true) {
    return [
      "Insufficient credits. This workspace has no spendable credits right now.",
      "",
      `Upgrade to Pro to get more credits: ${appUrl}/?settings=billing&billingView=plans`,
    ].join("\n");
  }
  return [
    "Insufficient credits. This workspace has no spendable credits right now.",
    "",
    `Buy more credits or adjust auto-recharge: ${appUrl}/?settings=usage`,
  ].join("\n");
}

function isDirectSendContext(contextType: string | null): boolean {
  return contextType === "web" || contextType === "agent_run";
}

/**
 * The single rejection exit of the pick: consume the head as `input.rejected`
 * with a formatted `output.error`, tell the thread's viewers, and deliver the
 * error to the integration the input came from.
 */
const rejectChatQueueHead$ = command(
  async (
    { set },
    args: {
      readonly head: ChatQueueHeadContext;
      readonly rejection: ChatQueueHeadRejection;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { head, rejection } = args;
    // An admission conflict is written for the user as is; any other error
    // is a run error the external-surface formatter explains.
    const formatted = await settle(
      (async () => {
        if (rejection.error.code === "CONFLICT") {
          return rejection.error.message;
        }
        if (
          rejection.error.code === "INSUFFICIENT_CREDITS" &&
          isDirectSendContext(head.contextType)
        ) {
          return await directSendInsufficientCreditsMessage(
            set(writeDb$),
            head.orgId,
          );
        }
        return await set(
          formatIntegrationRunError$,
          {
            orgId: head.orgId,
            userId: rejection.userId,
            code: rejection.error.code,
            message: rejection.error.message,
          },
          signal,
        );
      })(),
      signal,
    );
    if (!formatted.ok) {
      log.error("Failed to format queued input rejection", {
        chatThreadId: head.chatThreadId,
        eventId: head.id,
        error: formatted.error,
      });
    }
    const displayError = formatted.ok
      ? formatted.value
      : "The input could not be started";
    const rejected = await appendChatQueueHeadRejection(set(writeDb$), {
      chatThreadId: head.chatThreadId,
      eventId: head.id,
      errorMarker: rejection.error.code.toLowerCase(),
      displayError,
    });
    signal.throwIfAborted();
    if (!rejected) {
      return;
    }
    const logRejection =
      rejection.error.code === "INSUFFICIENT_CREDITS" ? log.debug : log.warn;
    logRejection("Rejected queued chat input", {
      chatThreadId: head.chatThreadId,
      eventId: head.id,
      contextType: head.contextType,
      code: rejection.error.code,
      error: rejection.error.message,
    });
    if (head.contextType === "automation") {
      await set(
        settleRejectedAutomationInput$,
        {
          contextId: head.contextId,
          queueEventId: head.id,
          error: rejection.error,
        },
        signal,
      );
    }
    signal.throwIfAborted();
    await publishChatQueueHeadConsumed(head);
    signal.throwIfAborted();
    const delivery = rejection.delivery
      ? set(
          deliverQueuedPromptRejection$,
          rejection.delivery,
          rejected.assistantEventId,
          signal,
        )
      : rejection.error.code === "INTERNAL_ERROR"
        ? set(
            deliverUnexpectedQueuedPromptRejection$,
            { head, assistantEventId: rejected.assistantEventId },
            signal,
          )
        : undefined;
    if (!delivery) {
      return;
    }
    await tapError(delivery, (error) => {
      log.warn("Failed to deliver queued input rejection", {
        chatThreadId: head.chatThreadId,
        eventId: head.id,
        error,
      });
    });
  },
);

/** Reject a head left unconsumed by an idle thread's pick. */
export const rejectUnconsumedChatQueueHead$ = command(
  async (
    { set },
    input: {
      readonly chatThreadId: string;
      readonly orgId: string;
      readonly eventId: string;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const loaded = await loadChatQueueHeadContext(set(writeDb$), {
      id: input.eventId,
      chatThreadId: input.chatThreadId,
    });
    signal.throwIfAborted();
    if (!loaded) {
      return;
    }
    await set(
      rejectChatQueueHead$,
      {
        head: {
          ...loaded,
          id: input.eventId,
          chatThreadId: input.chatThreadId,
          orgId: input.orgId,
          apiStartTime: now(),
          dispatchFailedCallbacks: input.dispatchFailedCallbacks,
        },
        rejection: {
          userId: loaded.userId,
          error: {
            code: "INTERNAL_ERROR",
            message: "The input could not be started",
          },
        },
      },
      signal,
    );
  },
);

/**
 * Consume one strict-FIFO queue head into a run. The head's context type
 * selects the assembler that builds the run's parameters; loading the head,
 * creating the run, and mapping its outcome are shared: 201 launched, and
 * every failure takes the single rejection exit.
 */
interface ConsumeChatQueueHeadArgs {
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly head: { readonly id: string; readonly createdAt: Date };
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
}

export const consumeChatQueueHead$ = command(
  async (
    { set },
    input: ConsumeChatQueueHeadArgs,
    signal: AbortSignal,
  ): Promise<ChatQueueHeadConsumption> => {
    const db = set(writeDb$);
    const apiStartTime = now();
    const loaded = await loadChatQueueHeadContext(db, {
      id: input.head.id,
      chatThreadId: input.chatThreadId,
    });
    signal.throwIfAborted();
    if (!loaded) {
      return { kind: "passed" };
    }
    const head: ChatQueueHeadContext = {
      id: input.head.id,
      chatThreadId: input.chatThreadId,
      orgId: input.orgId,
      apiStartTime,
      dispatchFailedCallbacks: input.dispatchFailedCallbacks,
      ...loaded,
      agentId: loaded.agentId,
    };
    // An unexpected failure is a failure like any other: it rejects the head
    // rather than leaving it for the cron to retry every minute.
    const unexpected = (error: unknown): ChatQueueHeadRejection => {
      log.error("Unexpected failure while launching queued chat input", {
        chatThreadId: head.chatThreadId,
        eventId: head.id,
        contextType: head.contextType,
        error,
      });
      return {
        error: {
          code: "INTERNAL_ERROR",
          message: "The input could not be started",
        },
        userId: head.userId,
      };
    };
    const assembled = await settle(
      set(
        head.contextType === "automation"
          ? assembleQueuedAutomationRun$
          : assembleQueuedPromptRun$,
        head,
        signal,
      ),
      signal,
    );
    if (!assembled.ok) {
      await set(
        rejectChatQueueHead$,
        { head, rejection: unexpected(assembled.error) },
        signal,
      );
      return { kind: "passed" };
    }
    const assembly = assembled.value;
    if (assembly.kind === "not-ready") {
      return { kind: "passed" };
    }
    if (assembly.kind === "rejected") {
      await set(
        rejectChatQueueHead$,
        { head, rejection: assembly.rejection },
        signal,
      );
      return { kind: "passed" };
    }

    if (head.contextType === "automation") {
      // A durable event timestamp survives a background pick on another API
      // instance. This is queue age at consumption, not commit-to-pick time:
      // it includes pre-commit time and legitimate time waiting in FIFO.
      await recordWorkflowAdmissionDuration(
        assembly.run.timing,
        "api_dispatch_workflow_event_created_to_consume_start",
        Math.max(0, apiStartTime - input.head.createdAt.getTime()),
      );
    }
    const created = await settle(
      set(createQueueFirstAgentRun$, assembly.run, signal),
      signal,
    );
    if (!created.ok) {
      // The thread was deleted while its head was being launched.
      if (
        isForeignKeyViolation(created.error) &&
        !(await threadExists(db, head.chatThreadId))
      ) {
        return { kind: "passed" };
      }
      const rejection = unexpected(created.error);
      await set(
        rejectChatQueueHead$,
        { head, rejection: assembly.rejection(rejection.error) },
        signal,
      );
      return { kind: "passed" };
    }
    const result = created.value;
    if (isQueueFirstRunClaimLost(result)) {
      // Another consumer took the head; its unique revoke edge decided.
      return { kind: "passed" };
    }
    if (result.status === 201) {
      if (assembly.launched.kind === "prompt") {
        set(
          recordQueuedPromptRunLaunch$,
          assembly.launched.context,
          result.body.runId,
        );
      } else {
        await set(
          recordWorkflowAutomationRunStart$,
          assembly.launched.input,
          result.body.runId,
          signal,
        );
      }
      signal.throwIfAborted();
      await publishChatQueueHeadConsumed(head);
      signal.throwIfAborted();
      return { kind: "launched", runId: result.body.runId };
    }
    await set(
      rejectChatQueueHead$,
      { head, rejection: assembly.rejection(result.body.error) },
      signal,
    );
    return { kind: "passed" };
  },
);
