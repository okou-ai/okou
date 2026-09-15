import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatGithubContext } from "@okouai/db/schema/chat-github-context";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { command } from "ccstate";
import { inArray } from "drizzle-orm";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  CHAT_QUEUE_SCAN_PAGE_SIZE,
  listChatQueueEventScanCandidatePage,
  recentStaleChatQueueWindow,
  revokedChatEventIds,
  type ChatQueueEventScanCandidate,
  type ChatQueueEventScanCursor,
  type RecentStaleChatQueueWindow,
} from "./chat-event-queue.service";

const ORPHANED_CHAT_EVENT_ERROR_CODE = "ORPHANED_QUEUED_CHAT_MESSAGES";
const MONITORED_CONTEXT_TYPES = [
  "slack",
  "feishu",
  "teams",
  "telegram",
  "github",
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

async function loadExistingContextRows(
  db: Db,
  contextType: MonitoredContextType,
  contextIds: readonly string[],
): Promise<readonly ExistingContextRow[]> {
  if (contextIds.length === 0) {
    return [];
  }

  switch (contextType) {
    case "slack": {
      return await db
        .select({
          id: chatSlackContext.id,
          chatThreadId: chatSlackContext.chatThreadId,
        })
        .from(chatSlackContext)
        .where(inArray(chatSlackContext.id, [...contextIds]));
    }
    case "feishu": {
      return await db
        .select({
          id: chatFeishuContext.id,
          chatThreadId: chatFeishuContext.chatThreadId,
        })
        .from(chatFeishuContext)
        .where(inArray(chatFeishuContext.id, [...contextIds]));
    }
    case "teams": {
      return await db
        .select({
          id: chatTeamsContext.id,
          chatThreadId: chatTeamsContext.chatThreadId,
        })
        .from(chatTeamsContext)
        .where(inArray(chatTeamsContext.id, [...contextIds]));
    }
    case "telegram": {
      return await db
        .select({
          id: chatTelegramContext.id,
          chatThreadId: chatTelegramContext.chatThreadId,
        })
        .from(chatTelegramContext)
        .where(inArray(chatTelegramContext.id, [...contextIds]));
    }
    case "github": {
      return await db
        .select({
          id: chatGithubContext.id,
          chatThreadId: chatGithubContext.chatThreadId,
        })
        .from(chatGithubContext)
        .where(inArray(chatGithubContext.id, [...contextIds]));
    }
    case "agentphone": {
      return await db
        .select({
          id: chatAgentphoneContext.id,
          chatThreadId: chatAgentphoneContext.chatThreadId,
        })
        .from(chatAgentphoneContext)
        .where(inArray(chatAgentphoneContext.id, [...contextIds]));
    }
    case "automation": {
      return await db
        .select({
          id: chatAutomationContext.id,
          chatThreadId: chatAutomationContext.chatThreadId,
        })
        .from(chatAutomationContext)
        .where(inArray(chatAutomationContext.id, [...contextIds]));
    }
    default: {
      return unreachableMonitoredContextType(contextType);
    }
  }
}

async function missingContextEvents(
  db: Db,
  candidates: readonly ChatQueueEventScanCandidate[],
): Promise<readonly MonitoredQueueEvent[]> {
  const missingByType = await Promise.all(
    MONITORED_CONTEXT_TYPES.map(async (contextType) => {
      const contextEvents: readonly MonitoredQueueEvent[] = candidates.flatMap(
        (candidate) => {
          return candidate.contextType === contextType
            ? [{ ...candidate, contextType }]
            : [];
        },
      );
      const contextIds = [
        ...new Set(
          contextEvents.flatMap(({ contextId }) => {
            return contextId === null ? [] : [contextId];
          }),
        ),
      ];
      const existingRows = await loadExistingContextRows(
        db,
        contextType,
        contextIds,
      );
      const existingThreadById = new Map(
        existingRows.map((row) => {
          return [row.id, row.chatThreadId] as const;
        }),
      );
      return contextEvents.filter(({ contextId, chatThreadId }) => {
        return (
          contextId === null ||
          existingThreadById.get(contextId) !== chatThreadId
        );
      });
    }),
  );
  return missingByType.flat();
}

async function findOrphanedQueueEvents(
  db: Db,
  window: RecentStaleChatQueueWindow,
  eventIds: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<readonly MonitoredQueueEvent[]> {
  const orphanedEvents: MonitoredQueueEvent[] = [];
  let cursor: ChatQueueEventScanCursor | undefined;
  while (true) {
    const candidates = await listChatQueueEventScanCandidatePage(db, {
      ...window,
      cursor,
      limit: CHAT_QUEUE_SCAN_PAGE_SIZE,
      eventIds,
      contextTypes: MONITORED_CONTEXT_TYPES,
    });
    signal.throwIfAborted();
    if (candidates.length === 0) {
      break;
    }

    const candidateIds = candidates.map(({ id }) => {
      return id;
    });
    const [revokedEventIds, missingEvents] = await Promise.all([
      revokedChatEventIds(db, candidateIds),
      missingContextEvents(db, candidates),
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
}

async function recheckOrphanedQueueEvents(
  db: Db,
  window: RecentStaleChatQueueWindow,
  suspectedEvents: readonly MonitoredQueueEvent[],
  signal: AbortSignal,
): Promise<readonly MonitoredQueueEvent[]> {
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
      ...(await findOrphanedQueueEvents(db, window, eventIds, signal)),
    );
  }
  return confirmedEvents;
}

async function monitorChatEventQueue(
  db: Db,
  signal: AbortSignal,
  eventIds?: readonly string[],
) {
  const window = recentStaleChatQueueWindow(nowDate().getTime());
  const suspectedEvents = await findOrphanedQueueEvents(
    db,
    window,
    eventIds,
    signal,
  );
  signal.throwIfAborted();
  // The split reads deliberately avoid one global polymorphic join. Re-read
  // only suspected rows so a concurrent revoke, context insert, or thread
  // deletion cannot turn the monitor into a false alert.
  const orphanedEvents = await recheckOrphanedQueueEvents(
    db,
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
}

export const monitorChatEventQueue$ = command(
  async ({ set }, signal: AbortSignal) => {
    return await monitorChatEventQueue(set(writeDb$), signal);
  },
);

export const monitorChatEventQueueForEvents$ = command(
  async ({ set }, eventIds: readonly string[], signal: AbortSignal) => {
    return await monitorChatEventQueue(set(writeDb$), signal, eventIds);
  },
);
