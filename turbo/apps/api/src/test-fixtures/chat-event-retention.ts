import { createHash, randomUUID } from "node:crypto";

import { command } from "ccstate";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { and, desc, eq, inArray, lte, max } from "drizzle-orm";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSearchMessageWatermarks } from "@okouai/db/schema/chat-event-search";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { nowDate } from "../lib/time";
import { writeDb$ } from "../signals/external/db";
import {
  insertChatEvent,
  insertChatEvents,
  replaceChatEvent,
  revokeChatEvent,
} from "../signals/services/chat-event.service";

const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function retentionCreatedAt(offsetMs: number | undefined): Date | undefined {
  return offsetMs === undefined
    ? undefined
    : new Date(nowDate().getTime() - RETENTION_WINDOW_MS + offsetMs);
}

export const seedRetentionOutputEvent$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly runId?: string | null;
      readonly content?: string;
      readonly offsetMs?: number;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const inserted = await set(writeDb$).transaction(async (tx) => {
      return await insertChatEvent(tx, {
        chatThreadId: args.chatThreadId,
        eventType: "output.message",
        runId: args.runId ?? null,
        content: args.content ?? `retention-output-${randomUUID()}`,
        createdAt: retentionCreatedAt(args.offsetMs),
      });
    });
    signal.throwIfAborted();
    if (inserted === null) {
      throw new Error("Expected retention output event insertion");
    }
    return inserted.id;
  },
);

export const seedRetentionOutputEvents$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly count: number;
      readonly contents?: readonly string[];
      readonly offsetMs?: number;
    },
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    if (args.contents !== undefined && args.contents.length !== args.count) {
      throw new Error("Expected one retention output content per event");
    }
    const inserted = await set(writeDb$).transaction(async (tx) => {
      return await insertChatEvents(
        tx,
        Array.from({ length: args.count }, (_, index) => {
          return {
            chatThreadId: args.chatThreadId,
            eventType: "output.message" as const,
            runId: null,
            content:
              args.contents?.[index] ??
              `retention-output-${index.toString()}-${randomUUID()}`,
            createdAt: retentionCreatedAt(args.offsetMs),
          };
        }),
      );
    });
    signal.throwIfAborted();
    if (inserted.length !== args.count) {
      throw new Error("Expected retention output event batch insertion");
    }
    return inserted.map((event) => {
      return event.id;
    });
  },
);

export const seedRetentionPendingEvent$ = command(
  async (
    { set },
    args: { readonly chatThreadId: string; readonly offsetMs?: number },
    signal: AbortSignal,
  ): Promise<string> => {
    const inserted = await set(writeDb$).transaction(async (tx) => {
      return await insertChatEvent(tx, {
        chatThreadId: args.chatThreadId,
        eventType: "input.prompt",
        runId: null,
        contextType: "web",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: `pending-${randomUUID()}` }],
        },
        createdAt: retentionCreatedAt(args.offsetMs),
      });
    });
    signal.throwIfAborted();
    if (inserted === null) {
      throw new Error("Expected retention pending event insertion");
    }
    return inserted.id;
  },
);

export const seedRetentionInvisibleReplacement$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly targetOffsetMs?: number;
      readonly replacementOffsetMs?: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly targetId: string; readonly replacementId: string }> => {
    const result = await set(writeDb$).transaction(async (tx) => {
      const target = await insertChatEvent(tx, {
        chatThreadId: args.chatThreadId,
        eventType: "input.prompt",
        runId: null,
        contextType: "web",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: `replaced-${randomUUID()}` }],
        },
        createdAt: retentionCreatedAt(args.targetOffsetMs),
      });
      if (target === null) {
        throw new Error("Expected retention replacement target insertion");
      }
      const replacement = await replaceChatEvent(tx, target.id, {
        chatThreadId: args.chatThreadId,
        eventType: "input.prompt",
        runId: null,
        contextType: "web",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: `replacement-${randomUUID()}` }],
        },
        createdAt: retentionCreatedAt(args.replacementOffsetMs),
      });
      if (replacement === null) {
        throw new Error("Expected retention replacement insertion");
      }
      return { targetId: target.id, replacementId: replacement.id };
    });
    signal.throwIfAborted();
    return result;
  },
);

export const revokeRetentionEvent$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly eventId: string;
      readonly offsetMs?: number;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const revoker = await set(writeDb$).transaction(async (tx) => {
      return await revokeChatEvent(tx, args.eventId, {
        chatThreadId: args.chatThreadId,
        eventType: "control.revoke",
        runId: null,
        createdAt: retentionCreatedAt(args.offsetMs),
      });
    });
    signal.throwIfAborted();
    if (revoker === null) {
      throw new Error("Expected retention event revocation");
    }
    return revoker.id;
  },
);

export const seedRetentionRun$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly status: string;
      readonly threadBound?: boolean;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const database = set(writeDb$);
    const [owner] = await database
      .select({
        userId: chatThreads.userId,
        orgId: agents.orgId,
        agentId: chatThreads.agentId,
      })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(eq(chatThreads.id, args.chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (owner === undefined) {
      throw new Error("Expected retention thread owner");
    }
    const [session] = await database
      .insert(agentSessions)
      .values({
        userId: owner.userId,
        orgId: owner.orgId,
        agentId: owner.agentId,
      })
      .returning({ id: agentSessions.id });
    signal.throwIfAborted();
    if (session === undefined) {
      throw new Error("Expected retention agent session insertion");
    }
    const [run] = await database
      .insert(agentRuns)
      .values({
        userId: owner.userId,
        orgId: owner.orgId,
        sessionId: session.id,
        status: args.status,
        prompt: "Retention fixture run",
        ...(args.threadBound
          ? {
              triggerSource: "web",
              autonomyBudget: 0,
              chatThreadId: args.chatThreadId,
            }
          : {}),
      })
      .returning({ id: agentRuns.id });
    signal.throwIfAborted();
    if (run === undefined) {
      throw new Error("Expected retention run insertion");
    }
    return run.id;
  },
);

export const openRetentionActiveInput$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly runId: string;
      readonly sourceEventId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const database = set(writeDb$);
    const [delivery] = await database
      .insert(activeInputDeliveries)
      .values({
        chatThreadId: args.chatThreadId,
        runId: args.runId,
        status: "open",
      })
      .returning({ id: activeInputDeliveries.id });
    signal.throwIfAborted();
    if (delivery === undefined) {
      throw new Error("Expected retention active-input delivery insertion");
    }
    await database.insert(activeInputDeliveryItems).values({
      deliveryId: delivery.id,
      sourceEventId: args.sourceEventId,
      position: 0,
      disposition: null,
    });
    signal.throwIfAborted();
  },
);

export const settleRetentionActiveInput$ = command(
  async (
    { set },
    sourceEventId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const database = set(writeDb$);
    const items = await database
      .update(activeInputDeliveryItems)
      .set({ disposition: "delivered" })
      .where(eq(activeInputDeliveryItems.sourceEventId, sourceEventId))
      .returning({ deliveryId: activeInputDeliveryItems.deliveryId });
    signal.throwIfAborted();
    const deliveryIds = items.map((item) => {
      return item.deliveryId;
    });
    if (deliveryIds.length === 0) {
      throw new Error("Expected retention active-input item");
    }
    await database
      .update(activeInputDeliveries)
      .set({ status: "settled" })
      .where(inArray(activeInputDeliveries.id, deliveryIds));
    signal.throwIfAborted();
  },
);

export const coverRetentionThread$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly snapshotLastSeqId?: number;
      readonly indexedSeqId?: number;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const database = set(writeDb$);
    const [sequence] = await database
      .select({ value: max(chatEvents.seqId) })
      .from(chatEvents)
      .where(eq(chatEvents.chatThreadId, args.chatThreadId));
    signal.throwIfAborted();
    const lastSeqId = args.snapshotLastSeqId ?? sequence?.value;
    if (lastSeqId === undefined || lastSeqId === null) {
      throw new Error("Expected retention fixture chat events");
    }
    const [terminal] = await database
      .select({ id: chatEvents.id, seqId: chatEvents.seqId })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, args.chatThreadId),
          lte(chatEvents.seqId, lastSeqId),
        ),
      )
      .orderBy(desc(chatEvents.seqId))
      .limit(1);
    signal.throwIfAborted();
    if (terminal === undefined) {
      throw new Error("Expected retention fixture snapshot terminal event");
    }
    const digest = createHash("sha256")
      .update(
        `${args.chatThreadId}:${lastSeqId.toString()}:${CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString()}`,
      )
      .digest("hex");
    const objectKey = `chat-events/${args.chatThreadId}/${lastSeqId.toString()}-${digest}.ndjson.gz`;
    const [head] = await database
      .select({ id: chatEventSnapshots.id })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, args.chatThreadId),
          eq(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const terminalCursor = {
      terminalEventId: terminal.id,
      terminalSeqId: terminal.seqId,
    };
    if (head === undefined) {
      await database.insert(chatEventSnapshots).values({
        chatThreadId: args.chatThreadId,
        lastSeqId,
        lastEventId: terminal.id,
        ...terminalCursor,
        archiveSchemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        objectKey,
      });
    } else {
      await database
        .update(chatEventSnapshots)
        .set({
          lastSeqId,
          lastEventId: terminal.id,
          ...terminalCursor,
          objectKey,
        })
        .where(eq(chatEventSnapshots.id, head.id));
    }
    await database
      .insert(chatEventSearchMessageWatermarks)
      .values({
        chatThreadId: args.chatThreadId,
        indexedSeqId: args.indexedSeqId ?? lastSeqId,
      })
      .onConflictDoUpdate({
        target: chatEventSearchMessageWatermarks.chatThreadId,
        set: { indexedSeqId: args.indexedSeqId ?? lastSeqId },
      });
    signal.throwIfAborted();
    return lastSeqId;
  },
);

export const readRetentionEvents$ = command(
  async (
    { set },
    eventIds: readonly string[],
    signal: AbortSignal,
  ): Promise<
    readonly {
      readonly id: string;
      readonly createdAt: Date;
      readonly eventType: string;
      readonly revokesEventId: string | null;
      readonly seqId: number;
    }[]
  > => {
    if (eventIds.length === 0) {
      return [];
    }
    const rows = await set(writeDb$)
      .select({
        id: chatEvents.id,
        createdAt: chatEvents.createdAt,
        eventType: chatEvents.eventType,
        revokesEventId: chatEvents.revokesEventId,
        seqId: chatEvents.seqId,
      })
      .from(chatEvents)
      .where(inArray(chatEvents.id, [...eventIds]));
    signal.throwIfAborted();
    return rows;
  },
);

export const setRetentionRunStatus$ = command(
  async (
    { set },
    args: { readonly runId: string; readonly status: string },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(writeDb$)
      .update(agentRuns)
      .set({ status: args.status })
      .where(eq(agentRuns.id, args.runId));
    signal.throwIfAborted();
  },
);
