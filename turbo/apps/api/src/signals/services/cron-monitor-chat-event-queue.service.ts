import { chatWechatContext } from "@okouai/db/schema/wechat";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { command } from "ccstate";
import { inArray } from "drizzle-orm";
import { db$ } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  CHAT_QUEUE_SCAN_PAGE_SIZE,
  chatQueueEventScanReadPlan,
  recentStaleChatQueueWindow,
  revokedChatEventReadPlan,
  revokedChatEventIdsFromRows,
  type ChatQueueEventScanCandidate,
  type ChatQueueEventScanCursor,
  type RecentStaleChatQueueWindow,
} from "./chat-event-queue.service";

const ORPHANED_CHAT_EVENT_ERROR_CODE = "ORPHANED_QUEUED_CHAT_MESSAGES";
const MONITORED_CONTEXT_TYPES = [
  "slack",
  "feishu",
  "teams",
  "discord",
  "wechat",
  "telegram",
  "agentphone",
  "automation",
] as const;

type MonitoredContextType = (typeof MONITORED_CONTEXT_TYPES)[number];
type MonitoredQueueEvent = Omit<ChatQueueEventScanCandidate, "contextType"> & {
  readonly contextType: MonitoredContextType;
};

interface ExistingContextRow {
  readonly id: string;
  readonly chatThreadId: string;
}

function unreachableMonitoredContextType(contextType: never): never {
  throw new Error(`Unsupported monitored context type: ${String(contextType)}`);
}

class OrphanedQueuedChatEventsError extends Error {
  readonly code = ORPHANED_CHAT_EVENT_ERROR_CODE;

  constructor(
    readonly orphanedMessages: number,
    readonly orphanedMessagesBySource: Readonly<Record<string, number>>,
  ) {
    super("Orphaned queued chat messages detected");
    this.name = "OrphanedQueuedChatEventsError";
  }
}

function monitoredContextTable(contextType: MonitoredContextType) {
  switch (contextType) {
    case "slack": {
      return chatSlackContext;
    }
    case "feishu": {
      return chatFeishuContext;
    }
    case "teams": {
      return chatTeamsContext;
    }
    case "discord": {
      return chatDiscordContext;
    }
    case "wechat": {
      return chatWechatContext;
    }
    case "telegram": {
      return chatTelegramContext;
    }
    case "agentphone": {
      return chatAgentphoneContext;
    }
    case "automation": {
      return chatAutomationContext;
    }
    default: {
      return unreachableMonitoredContextType(contextType);
    }
  }
}

function existingContextReadPlan(
  contextType: MonitoredContextType,
  contextIds: readonly string[],
) {
  if (contextIds.length === 0) {
    return null;
  }
  const table = monitoredContextTable(contextType);
  return {
    columns: { id: table.id, chatThreadId: table.chatThreadId },
    from: table,
    where: inArray(table.id, [...contextIds]),
  };
}

function contextEventsForType(
  candidates: readonly ChatQueueEventScanCandidate[],
  contextType: MonitoredContextType,
): readonly MonitoredQueueEvent[] {
  return candidates.flatMap((candidate) => {
    return candidate.contextType === contextType
      ? [{ ...candidate, contextType }]
      : [];
  });
}

function contextIdsForEvents(contextEvents: readonly MonitoredQueueEvent[]) {
  return [
    ...new Set(
      contextEvents.flatMap(({ contextId }) => {
        return contextId === null ? [] : [contextId];
      }),
    ),
  ];
}

function missingContextEventsFromRows(
  contextEvents: readonly MonitoredQueueEvent[],
  existingRows: readonly ExistingContextRow[],
): readonly MonitoredQueueEvent[] {
  const existingThreadById = new Map(
    existingRows.map((row) => {
      return [row.id, row.chatThreadId] as const;
    }),
  );
  return contextEvents.filter(({ contextId, chatThreadId }) => {
    return (
      contextId === null || existingThreadById.get(contextId) !== chatThreadId
    );
  });
}

const findOrphanedQueueEvents$ = command(
  async (
    { get },
    window: RecentStaleChatQueueWindow,
    eventIds: readonly string[] | undefined,
    signal: AbortSignal,
  ): Promise<readonly MonitoredQueueEvent[]> => {
    const db = get(db$);
    const orphanedEvents: MonitoredQueueEvent[] = [];
    let cursor: ChatQueueEventScanCursor | undefined;
    while (true) {
      const scanArgs = {
        ...window,
        cursor,
        limit: CHAT_QUEUE_SCAN_PAGE_SIZE,
        eventIds,
        contextTypes: MONITORED_CONTEXT_TYPES,
      };
      const candidates = await (async () => {
        const read = chatQueueEventScanReadPlan(scanArgs);
        if (read === null) {
          return [];
        }
        return await db
          .select(read.columns)
          .from(read.from)
          .where(read.where)
          .orderBy(...read.orderBy)
          .limit(read.limit);
      })();
      signal.throwIfAborted();
      if (candidates.length === 0) {
        break;
      }

      const candidateIds = candidates.map(({ id }) => {
        return id;
      });
      const [revokedEventIds, missingEvents] = await Promise.all([
        (async () => {
          const read = revokedChatEventReadPlan(candidateIds);
          if (read === null) {
            return new Set<string>();
          }
          const rows = await db
            .select(read.columns)
            .from(read.from)
            .where(read.where);
          return revokedChatEventIdsFromRows(rows);
        })(),
        (async () => {
          const missingByType = await Promise.all(
            MONITORED_CONTEXT_TYPES.map(async (contextType) => {
              const contextEvents = contextEventsForType(
                candidates,
                contextType,
              );
              const contextIds = contextIdsForEvents(contextEvents);
              const existingRows = await (async () => {
                const read = existingContextReadPlan(contextType, contextIds);
                if (read === null) {
                  return [];
                }
                return await db
                  .select(read.columns)
                  .from(read.from)
                  .where(read.where);
              })();
              return missingContextEventsFromRows(contextEvents, existingRows);
            }),
          );
          return missingByType.flat();
        })(),
      ]);
      signal.throwIfAborted();
      orphanedEvents.push(
        ...missingEvents.filter(({ id }) => {
          return !revokedEventIds.has(id);
        }),
      );

      if (candidates.length < CHAT_QUEUE_SCAN_PAGE_SIZE) {
        break;
      }
      const lastCandidate = candidates.at(-1);
      if (!lastCandidate) {
        break;
      }
      cursor = lastCandidate;
    }
    return orphanedEvents;
  },
);

const recheckOrphanedQueueEvents$ = command(
  async (
    { set },
    window: RecentStaleChatQueueWindow,
    suspectedEvents: readonly MonitoredQueueEvent[],
    signal: AbortSignal,
  ): Promise<readonly MonitoredQueueEvent[]> => {
    const confirmedEvents: MonitoredQueueEvent[] = [];
    for (
      let offset = 0;
      offset < suspectedEvents.length;
      offset += CHAT_QUEUE_SCAN_PAGE_SIZE
    ) {
      signal.throwIfAborted();
      const eventIds = suspectedEvents
        .slice(offset, offset + CHAT_QUEUE_SCAN_PAGE_SIZE)
        .map(({ id }) => {
          return id;
        });
      confirmedEvents.push(
        ...(await set(findOrphanedQueueEvents$, window, eventIds, signal)),
      );
    }
    return confirmedEvents;
  },
);

export const monitorChatEventQueue$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    get(db$);
    return await (async () => {
      const window = recentStaleChatQueueWindow(nowDate().getTime());
      const suspectedEvents = await set(
        findOrphanedQueueEvents$,
        window,
        undefined,
        signal,
      );
      signal.throwIfAborted();
      // The split reads deliberately avoid one global polymorphic join. Re-read
      // only suspected rows so a concurrent revoke, context insert, or thread
      // deletion cannot turn the monitor into a false alert.
      const orphanedEvents = await set(
        recheckOrphanedQueueEvents$,
        window,
        suspectedEvents,
        signal,
      );
      signal.throwIfAborted();

      const orphanedMessagesBySource: Record<string, number> = {};
      for (const event of orphanedEvents) {
        orphanedMessagesBySource[event.contextType] =
          (orphanedMessagesBySource[event.contextType] ?? 0) + 1;
      }
      const orphanedMessages = orphanedEvents.length;
      if (orphanedMessages > 0) {
        throw new OrphanedQueuedChatEventsError(
          orphanedMessages,
          orphanedMessagesBySource,
        );
      }

      return {
        success: true as const,
        orphanedMessages,
      };
    })();
  },
);
