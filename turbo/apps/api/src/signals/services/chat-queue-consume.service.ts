import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

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
import { assembleQueuedPromptRun$ } from "./internal-chat-run-callback.service";
import { assembleQueuedAutomationRun$ } from "./workflow-chat-event-queue.service";
import type {
  ChatQueueHeadContext,
  ChatQueueHeadRejection,
} from "./chat-queue-run-assembly";

const log = logger("ChatQueueConsume");

const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * How consuming one queue head ended:
 * - `launched`: the head was replaced by its run-bound copy and a run started;
 * - `waiting`: a 429 left the head queued;
 * - `passed`: the head was rejected as `input.rejected`, or was not launched
 *   by this pick (another consumer took it or its producer is not ready).
 */
export type ChatQueueHeadConsumption =
  | { readonly kind: "launched"; readonly runId: string }
  | { readonly kind: "waiting" }
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
    .select({ userId: chatThreads.userId, agentId: chatThreads.agentId })
    .from(chatThreads)
    .where(eq(chatThreads.id, head.chatThreadId))
    .limit(1);
  if (!thread?.agentId) {
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
  return { ...event, userId: thread.userId, agentId: thread.agentId };
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
    const displayError =
      rejection.error.code === "CONFLICT"
        ? rejection.error.message
        : await set(
            formatIntegrationRunError$,
            {
              orgId: head.orgId,
              userId: rejection.userId,
              code: rejection.error.code,
              message: rejection.error.message,
            },
            signal,
          );
    signal.throwIfAborted();
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
    await rejection.settle?.(signal);
    signal.throwIfAborted();
    await publishChatQueueHeadConsumed(head);
    signal.throwIfAborted();
    const deliver = rejection.deliver;
    if (!deliver) {
      return;
    }
    await tapError(deliver(rejected.assistantEventId, signal), (error) => {
      log.warn("Failed to deliver queued input rejection", {
        chatThreadId: head.chatThreadId,
        eventId: head.id,
        error,
      });
    });
  },
);

/**
 * Consume one strict-FIFO queue head into a run. The head's context type
 * selects the assembler that builds the run's parameters; loading the head,
 * creating the run, and mapping its outcome are shared: 201 launched, 429
 * waits, and every other failure takes the single rejection exit.
 */
export const consumeChatQueueHead$ = command(
  async (
    { set },
    input: {
      readonly chatThreadId: string;
      readonly orgId: string;
      readonly head: { readonly id: string };
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
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
    };
    const assembly = await set(
      head.contextType === "automation"
        ? assembleQueuedAutomationRun$
        : assembleQueuedPromptRun$,
      head,
      signal,
    );
    signal.throwIfAborted();
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

    const created = await settle(
      set(createQueueFirstAgentRun$, assembly.run, signal),
    );
    signal.throwIfAborted();
    if (!created.ok) {
      // The thread was deleted while its head was being launched.
      if (
        isForeignKeyViolation(created.error) &&
        !(await threadExists(db, head.chatThreadId))
      ) {
        return { kind: "passed" };
      }
      throw created.error;
    }
    const result = created.value;
    if (isQueueFirstRunClaimLost(result)) {
      // Another consumer took the head; its unique revoke edge decided.
      return { kind: "passed" };
    }
    if (result.status === 201) {
      await assembly.launched(result.body.runId, signal);
      signal.throwIfAborted();
      await publishChatQueueHeadConsumed(head);
      signal.throwIfAborted();
      return { kind: "launched", runId: result.body.runId };
    }
    if (result.status === 429) {
      return { kind: "waiting" };
    }
    await set(
      rejectChatQueueHead$,
      { head, rejection: assembly.rejection(result.body.error) },
      signal,
    );
    return { kind: "passed" };
  },
);
