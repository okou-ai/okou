import { command, computed } from "ccstate";
import { and, desc, eq, gt, gte, inArray, isNull, lt, or } from "drizzle-orm";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  INDICATOR_UNREAD_CANDIDATE_LIMIT,
  INDICATOR_UNREAD_LOOKBACK_MS,
} from "./chat-thread.service";

function terminalWatermarkCondition(threadIds: readonly string[]) {
  return and(
    inArray(chatEvents.chatThreadId, [...threadIds]),
    chatEventTerminalPredicate(chatEvents.eventType),
  );
}

/** User-only Thread authorization; the Agent supplies publication ownership. */
export function createChatThreadReadPreparation(args: {
  readonly threadId: string;
  readonly userId: string;
}) {
  const thread$ = computed(async (get) => {
    const [thread] = await get(db$)
      .select({
        agentId: chatThreads.agentId,
        lastReadAt: chatThreads.lastReadAt,
      })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    return thread;
  });
  const agent$ = computed(async (get) => {
    const thread = await get(thread$);
    if (!thread?.agentId) {
      return null;
    }
    const [agent] = await get(db$)
      .select({ orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, thread.agentId))
      .limit(1);
    return agent ?? null;
  });
  const watermark$ = computed(async (get) => {
    const rows = await get(db$)
      .selectDistinctOn([chatEvents.chatThreadId], {
        threadId: chatEvents.chatThreadId,
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .where(terminalWatermarkCondition([args.threadId]))
      .orderBy(
        chatEvents.chatThreadId,
        desc(chatEvents.createdAt),
        desc(chatEvents.id),
      );
    return rows[0]?.createdAt;
  });

  return computed(async (get) => {
    const thread = await get(thread$);
    if (!thread?.agentId) {
      return null;
    }
    const agent = await get(agent$);
    if (!agent) {
      return null;
    }
    const watermark = await get(watermark$);
    return {
      threadId: args.threadId,
      userId: args.userId,
      agentId: thread.agentId,
      orgId: agent.orgId,
      lastReadAt: thread.lastReadAt,
      watermark,
    };
  });
}

/** Bounded caller-owned candidates and one terminal watermark query per Agent. */
export function createAgentThreadReadPreparation(args: {
  readonly agentId: string;
  readonly userId: string;
  readonly orgId: string;
}) {
  const agent$ = computed(async (get) => {
    const [agent] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, args.agentId), eq(agents.orgId, args.orgId)))
      .limit(1);
    return agent;
  });
  const candidates$ = computed(async (get) => {
    const agent = await get(agent$);
    if (!agent) {
      return [];
    }
    return await get(db$)
      .select({ id: chatThreads.id, lastReadAt: chatThreads.lastReadAt })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.agentId, args.agentId),
          gte(
            chatThreads.lastMessageAt,
            new Date(nowDate().getTime() - INDICATOR_UNREAD_LOOKBACK_MS),
          ),
          or(
            isNull(chatThreads.lastReadAt),
            gt(chatThreads.lastMessageAt, chatThreads.lastReadAt),
          ),
        ),
      )
      .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
      .limit(INDICATOR_UNREAD_CANDIDATE_LIMIT);
  });
  const watermarks$ = computed(
    async (get): Promise<ReadonlyMap<string, Date>> => {
      const candidates = await get(candidates$);
      if (candidates.length === 0) {
        return new Map();
      }
      const rows = await get(db$)
        .selectDistinctOn([chatEvents.chatThreadId], {
          threadId: chatEvents.chatThreadId,
          createdAt: chatEvents.createdAt,
        })
        .from(chatEvents)
        .where(
          terminalWatermarkCondition(
            candidates.map((candidate) => {
              return candidate.id;
            }),
          ),
        )
        .orderBy(
          chatEvents.chatThreadId,
          desc(chatEvents.createdAt),
          desc(chatEvents.id),
        );
      return new Map(
        rows.map((row) => {
          return [row.threadId, row.createdAt] as const;
        }),
      );
    },
  );

  return computed(async (get) => {
    const agent = await get(agent$);
    if (!agent) {
      return null;
    }
    const candidates = await get(candidates$);
    const watermarks = await get(watermarks$);
    return candidates.flatMap((candidate) => {
      const watermark = watermarks.get(candidate.id);
      return watermark === undefined ||
        (candidate.lastReadAt !== null && watermark <= candidate.lastReadAt)
        ? []
        : [{ threadId: candidate.id, watermark }];
    });
  });
}

/** One atomic cursor advance; equal/newer cursors and lost races are not retried. */
export const advanceChatThreadReadCursor$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly userId: string;
      readonly watermark: Date;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const updated = await set(writeDb$)
      .update(chatThreads)
      .set({ lastReadAt: args.watermark })
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
          or(
            isNull(chatThreads.lastReadAt),
            lt(chatThreads.lastReadAt, args.watermark),
          ),
        ),
      )
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();
    return updated.length > 0;
  },
);
