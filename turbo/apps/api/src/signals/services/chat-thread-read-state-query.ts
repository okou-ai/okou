import { command, computed } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";
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

export function createChatThreadReadPreparation(args: {
  readonly orgId: string;
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
          chatThreadOrganizationPredicate(args.orgId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    return thread;
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
    if (!thread) {
      return null;
    }
    const watermark = await get(watermark$);
    return {
      threadId: args.threadId,
      userId: args.userId,
      ...(thread.agentId ? { agentId: thread.agentId } : {}),
      orgId: args.orgId,
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
          eq(chatThreads.orgId, args.orgId),
          eq(chatThreads.muted, false),
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

/** Advance the prepared cursors atomically and report only the rows changed. */
export const advanceChatThreadReadCursors$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly cursors: readonly {
        readonly threadId: string;
        readonly watermark: Date;
      }[];
      /** Bulk unread actions must not consume a concurrently muted thread. */
      readonly unmutedOnly?: boolean;
    },
    signal: AbortSignal,
  ): Promise<string[]> => {
    signal.throwIfAborted();
    if (args.cursors.length === 0) {
      return [];
    }
    const values = args.cursors.map(({ threadId, watermark }) => {
      return sql`(${threadId}::uuid, ${watermark.toISOString()}::timestamp)`;
    });
    const watermark = sql`prepared_cursor.watermark`;
    const db = set(writeDb$);
    // Recency can reorder the same threads between requests. Lock eligible
    // rows by immutable ID inside the statement before applying the update.
    const eligible = db
      .select({
        id: chatThreads.id,
        watermark: watermark.mapWith(chatThreads.lastReadAt).as("watermark"),
      })
      .from(chatThreads)
      .innerJoin(
        sql`(VALUES ${sql.join(values, sql`, `)}) AS prepared_cursor(thread_id, watermark)`,
        eq(chatThreads.id, sql`prepared_cursor.thread_id`),
      )
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          chatThreadOrganizationPredicate(args.orgId),
          args.unmutedOnly ? eq(chatThreads.muted, false) : undefined,
          or(
            isNull(chatThreads.lastReadAt),
            lt(chatThreads.lastReadAt, watermark),
          ),
        ),
      )
      .orderBy(asc(chatThreads.id))
      .for("no key update", { of: chatThreads })
      .as("eligible_cursor");
    const updated = await db
      .update(chatThreads)
      .set({ lastReadAt: sql`${eligible.watermark}` })
      .from(eligible)
      .where(eq(chatThreads.id, eligible.id))
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();
    const updatedIds = new Set(
      updated.map(({ id }) => {
        return id;
      }),
    );
    return args.cursors.flatMap(({ threadId }) => {
      return updatedIds.has(threadId.toLowerCase()) ? [threadId] : [];
    });
  },
);
