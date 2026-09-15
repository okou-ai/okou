import { command } from "ccstate";
import { historicalRunGroupId } from "./run-event-provenance.service";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  and,
  eq,
  isNotNull,
  isNull,
  not,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { writeDb$, type Db } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { assistantEventIdForRunEvent } from "./assistant-event-id";
import { insertChatEvents } from "./chat-event.service";
import {
  chatEventTypeIn,
  runOwnedChatEventCondition,
} from "./chat-event-type.service";
import { canonicalChatEventError } from "./canonical-chat-event-read.service";
import { publishFirstAssistantEventCreatedSafely } from "./chat-first-assistant-event-metric.service";
import {
  appendChatThreadEvent,
  type ChatThreadEventTransaction,
} from "./chat-thread-event.service";

import {
  withRunContentWrite,
  type RunContentOwnership,
} from "./run-content-erasure-admission.service";

const EXT_MIMETYPE_MAP: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  har: "application/json",
  json: "application/json",
};
const revoker = alias(chatEvents, "revoker");

type InsertAssistantEventItem =
  | {
      readonly eventType: "output.message";
      readonly runEventSequenceNumber: number;
      readonly content: string;
      readonly runEventId: string;
    }
  | {
      readonly eventType: "output.error";
      readonly runEventSequenceNumber: number;
      readonly error: string;
      readonly runEventId: string;
    }
  | {
      readonly eventType: "output.thinking";
      readonly runEventSequenceNumber: number;
      readonly thinking: string;
      readonly runEventId: string;
    };

export interface InsertAssistantEventsInput {
  readonly ownership: RunContentOwnership;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly items: readonly InsertAssistantEventItem[];
}

export function inferMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext
    ? (EXT_MIMETYPE_MAP[ext] ?? "application/octet-stream")
    : "application/octet-stream";
}

export async function touchChatThreadLastMessageAt(
  tx: ChatThreadEventTransaction,
  threadId: string,
  touchedAt: Date = nowDate(),
  eventId?: string,
): Promise<void> {
  const [thread] = await tx
    .update(chatThreads)
    .set({
      lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, ${touchedAt})`,
    })
    .where(and(eq(chatThreads.id, threadId), isNotNull(chatThreads.agentId)))
    .returning({
      id: chatThreads.id,
      userId: chatThreads.userId,
      agentId: chatThreads.agentId,
      lastMessageAt: chatThreads.lastMessageAt,
    });
  if (!thread?.agentId) {
    return;
  }
  await appendChatThreadEvent(tx, {
    kind: "sort_touched",
    userId: thread.userId,
    chatThreadId: thread.id,
    agentId: thread.agentId,
    eventId,
    createdAt: thread.lastMessageAt,
  });
}

export function visibleChatEventCondition(
  db: Pick<Db, "select">,
): SQL | undefined {
  const isUserInputEvent = chatEventTypeIn([
    "input.prompt",
    "input.automation",
    "input.rejected",
    "control.interrupt",
    "control.revoke",
  ]);
  const hasRunOwner = and(
    isNotNull(chatEvents.runId),
    runOwnedChatEventCondition(),
  );
  return and(
    not(chatEventTypeIn(["input.goal"])),
    notExists(
      db
        .select({ id: revoker.id })
        .from(revoker)
        .where(eq(revoker.revokesEventId, chatEvents.id)),
    ),
    or(
      not(isUserInputEvent),
      hasRunOwner,
      isNull(chatEvents.revokesEventId),
      isNotNull(canonicalChatEventError()),
    ),
    not(chatEventTypeIn(["control.interrupt"])),
  );
}

async function assistantEventRunContextForRun(
  db: ChatThreadEventTransaction,
  runId: string,
): Promise<{
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}> {
  const [run] = await db
    .select({
      apiStartedAt: agentRuns.apiStartedAt,
      firstAssistantEventAcknowledgedAt:
        agentRuns.firstAssistantEventAcknowledgedAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return {
    shouldAttemptFirstAssistantEventClaim:
      run !== undefined &&
      run.apiStartedAt !== null &&
      run.firstAssistantEventAcknowledgedAt === null,
  };
}

interface InsertAssistantEventsTransactionResult {
  readonly insertedRowCount: number;
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}

export async function insertAssistantEventsInTransaction(
  tx: ChatThreadEventTransaction,
  args: Omit<InsertAssistantEventsInput, "ownership"> & {
    readonly runGroupId: string | undefined;
  },
  signal: AbortSignal,
): Promise<InsertAssistantEventsTransactionResult> {
  if (args.items.length === 0) {
    return {
      insertedRowCount: 0,
      shouldAttemptFirstAssistantEventClaim: false,
    };
  }

  const runContext = await assistantEventRunContextForRun(tx, args.runId);
  signal.throwIfAborted();

  const insertedRows = await insertChatEvents(
    tx,
    args.items.map((item) => {
      const eventIdentity = {
        id: assistantEventIdForRunEvent(args.runId, item.runEventId),
        chatThreadId: args.threadId,
        runId: args.runId,
        runGroupId: args.runGroupId,
        runEventSequenceNumber: item.runEventSequenceNumber,
        runEventId: item.runEventId,
      };
      if (item.eventType === "output.message") {
        return {
          ...eventIdentity,
          eventType: item.eventType,
          content: item.content,
        };
      }
      if (item.eventType === "output.error") {
        return {
          ...eventIdentity,
          eventType: item.eventType,
          content: null,
          error: item.error,
        };
      }
      return {
        ...eventIdentity,
        eventType: item.eventType,
        thinking: item.thinking,
      };
    }),
  );
  signal.throwIfAborted();

  return {
    insertedRowCount: insertedRows.length,
    shouldAttemptFirstAssistantEventClaim:
      runContext.shouldAttemptFirstAssistantEventClaim,
  };
}

export async function insertAssistantEvents(
  writeDb: Db,
  args: InsertAssistantEventsInput,
  signal: AbortSignal,
): Promise<number> {
  if (args.items.length === 0) {
    return 0;
  }

  const runGroupId = await historicalRunGroupId(
    writeDb,
    args.runId,
    undefined,
    signal,
  );
  const admitted = await withRunContentWrite(
    writeDb,
    { runId: args.runId, destination: args, ownership: args.ownership },
    async (tx) => {
      return await insertAssistantEventsInTransaction(
        tx,
        { ...args, runGroupId },
        signal,
      );
    },
    signal,
  );
  if (admitted.outcome === "closed") {
    return 0;
  }
  const result = admitted.value;
  signal.throwIfAborted();

  if (result.insertedRowCount > 0) {
    if (result.shouldAttemptFirstAssistantEventClaim) {
      await publishFirstAssistantEventCreatedSafely({
        db: writeDb,
        ownership: admitted.ownership,
        orgId: args.orgId,
        userId: args.userId,
        threadId: args.threadId,
        runId: args.runId,
      });
    } else {
      await publishChatThreadMessageCreatedSafely({
        userId: args.userId,
        orgId: args.orgId,
        threadId: args.threadId,
      });
    }
    signal.throwIfAborted();
  }

  return result.insertedRowCount;
}

export const insertAssistantEvents$ = command(
  async (
    { set },
    args: InsertAssistantEventsInput,
    signal: AbortSignal,
  ): Promise<number> => {
    return await insertAssistantEvents(set(writeDb$), args, signal);
  },
);
