import {
  readStoredDraftMessage,
  type SuggestionPreset,
} from "@okouai/api-contracts/validators/chat-threads";
import { normalChatInputInsertSql } from "./normal-chat-input-publication-sql";
import { db$, writeDb$ } from "../external/db";
import {
  deleteChatThreadDraft$,
  persistChatThreadDraft$,
} from "./chat-thread-draft-write.service";
import { cancelRun$ } from "./agent-run-cancellation.service";
import { reconcileAutomationEventWatches$ } from "./automation-event-watch-lifecycle.service";
import { array, boolean, object, string, uuid, unknown as zUnknown } from "zod";
import { chatRelations } from "@okouai/db/schema/chat-relation";
import { command, computed, type Computed } from "ccstate";
import {
  type ChatThreadDraft,
  type ChatThreadDetail,
  type CodexServiceTier,
  type PersistedAttachment,
  type UserMessageInputDocument,
  type Indicator,
  type Indicators,
  persistedAttachmentSchema,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { InitialRemoteAccessOverride } from "@okouai/api-contracts/contracts/chat-remote-access";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  max,
  or,
  sql,
  is,
  SQL,
} from "drizzle-orm";

import { settle } from "../utils";
import {
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { chatThreadInitializationCtes } from "./chat-thread-initialization-plan";
import { now, nowDate, nowDateSql } from "../../lib/time";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";
import type { CancelRunResult } from "./agent-run-terminal-transition.service";
import { cancellationRecoveryPendingForThread } from "./chat-active-run.service";
import {
  prepareChatThreadInsert,
  createdChatThreadFromRow,
} from "./chat-thread-create.service";
import { initialRemoteAccessOwnershipPredicate } from "./chat-remote-access.service";

type ChatThreadDetailRow = {
  readonly lastReadAt: Date | null;
};

export function chatThreadDraft(args: {
  readonly legacyMemberDraft?: boolean;
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<ChatThreadDraft | null>> {
  return computed(async (get): Promise<ChatThreadDraft | null> => {
    const db = get(db$);
    const [draft] = await db
      .select({
        draftUserMessage: chatThreadDrafts.draftUserMessage,
        draftAttachments: chatThreadDrafts.draftAttachments,
      })
      .from(chatThreads)
      .leftJoin(
        chatThreadDrafts,
        and(
          eq(chatThreadDrafts.chatThreadId, chatThreads.id),
          eq(chatThreadDrafts.userId, args.userId),
        ),
      )
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          chatThreadOrganizationPredicate(args.orgId),
          args.legacyMemberDraft
            ? undefined
            : eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    if (!draft) {
      return null;
    }
    const marker = draft.draftUserMessage?.parts.find((part) => {
      return part.type === "suggestion_preset";
    });
    return {
      ...(marker ? { suggestionPreset: marker.preset } : {}),
      draftUserMessage: readStoredDraftMessage(draft.draftUserMessage),
      draftAttachments: persistedAttachmentSchema
        .array()
        .nullable()
        .parse(draft.draftAttachments),
    };
  });
}

const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;
const INDICATOR_UNREAD_LIMIT = 50;
/** Unread candidates read per request: the newest threads within the lookback. */
export const INDICATOR_UNREAD_CANDIDATE_LIMIT = 128;
export const INDICATOR_UNREAD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function ownedChatThreadDetail(
  orgId: string,
  threadId: string,
  userId: string,
): Computed<Promise<ChatThreadDetailRow | null>> {
  return computed(async (get): Promise<ChatThreadDetailRow | null> => {
    const [thread] = await get(db$)
      .select({
        lastReadAt: chatThreads.lastReadAt,
      })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.userId, userId),
          chatThreadOrganizationPredicate(orgId),
        ),
      )
      .limit(1);

    if (!thread) {
      return null;
    }

    return {
      lastReadAt: thread.lastReadAt,
    };
  });
}

export function chatThreadDetail(args: {
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<ChatThreadDetail | null>> {
  const thread$ = ownedChatThreadDetail(args.orgId, args.threadId, args.userId);
  const recoveryPending$ = cancellationRecoveryPendingForThread(args);
  return computed(async (get): Promise<ChatThreadDetail | null> => {
    const thread = await get(thread$);
    if (!thread) {
      return null;
    }
    const cancellationRecoveryPending = await get(recoveryPending$);

    return {
      lastReadAt: thread.lastReadAt?.toISOString() ?? null,
      cancellationRecoveryPending,
    };
  });
}
type IndicatorScope = {
  readonly userId: string;
  readonly orgId: string;
  readonly includeActiveUnread: boolean;
  readonly activeLimit: number;
};
type IndicatorThreadRow = {
  readonly threadId: string;
};
type UnreadIndicatorRow = IndicatorThreadRow & {
  readonly unreadAt: Date;
};

function newestUnreadIndicators(rows: UnreadIndicatorRow[]) {
  rows.sort((left, right) => {
    const byTime = right.unreadAt.getTime() - left.unreadAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return right.threadId < left.threadId ? -1 : 1;
  });
  return rows.slice(0, INDICATOR_UNREAD_LIMIT);
}

function createIndicatorRows(args: IndicatorScope) {
  const activeRows$ = computed(
    async (get): Promise<readonly IndicatorThreadRow[]> => {
      return await get(db$)
        .select({ threadId: chatThreads.id })
        .from(agentRuns)
        .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
        .where(
          and(
            eq(agentRuns.userId, args.userId),
            eq(agentRuns.orgId, args.orgId),
            inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
            isNotNull(agentRuns.triggerSource),
            eq(chatThreads.userId, args.userId),
            eq(chatThreads.hidden, false),
            eq(chatThreads.orgId, args.orgId),
          ),
        )
        .groupBy(chatThreads.id)
        .orderBy(desc(max(agentRuns.createdAt)))
        .limit(args.activeLimit);
    },
  );
  const unreadRows$ = computed(
    async (get): Promise<readonly UnreadIndicatorRow[]> => {
      const db = get(db$);
      const unreadCutoff = new Date(now() - INDICATOR_UNREAD_LOOKBACK_MS);
      // The newest threads with messages after their read watermark are the only
      // candidates, so the per-thread reads below have a fixed upper bound.
      const candidates = await db
        .select({
          threadId: chatThreads.id,
          lastReadAt: chatThreads.lastReadAt,
        })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.userId, args.userId),
            eq(chatThreads.orgId, args.orgId),
            eq(chatThreads.muted, false),
            eq(chatThreads.hidden, false),
            gte(chatThreads.lastMessageAt, unreadCutoff),
            or(
              isNull(chatThreads.lastReadAt),
              gt(chatThreads.lastMessageAt, chatThreads.lastReadAt),
            ),
          ),
        )
        .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
        .limit(INDICATOR_UNREAD_CANDIDATE_LIMIT);
      if (candidates.length === 0) {
        return [];
      }
      const candidateIds = candidates.map((row) => {
        return row.threadId;
      });

      const [terminalRows, activeCandidates] = await Promise.all([
        db
          .selectDistinctOn([chatEvents.chatThreadId], {
            threadId: chatEvents.chatThreadId,
            createdAt: chatEvents.createdAt,
          })
          .from(chatEvents)
          .where(
            and(
              inArray(chatEvents.chatThreadId, candidateIds),
              chatEventTerminalPredicate(chatEvents.eventType),
              gte(chatEvents.createdAt, unreadCutoff),
            ),
          )
          .orderBy(
            chatEvents.chatThreadId,
            desc(chatEvents.createdAt),
            desc(chatEvents.id),
          ),
        // The default projection excludes active candidates before the unread limit.
        args.includeActiveUnread
          ? []
          : db
              .selectDistinct({ threadId: agentRuns.chatThreadId })
              .from(agentRuns)
              .where(
                and(
                  inArray(agentRuns.chatThreadId, candidateIds),
                  inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
                  isNotNull(agentRuns.triggerSource),
                ),
              ),
      ]);

      const latestTerminalAt = new Map<string, Date>();
      for (const row of terminalRows) {
        latestTerminalAt.set(row.threadId, row.createdAt);
      }
      const activeIds = new Set(
        activeCandidates.map((row) => {
          return row.threadId;
        }),
      );

      const unreadRows: UnreadIndicatorRow[] = [];
      for (const candidate of candidates) {
        const unreadAt = latestTerminalAt.get(candidate.threadId);
        if (
          unreadAt === undefined ||
          activeIds.has(candidate.threadId) ||
          (candidate.lastReadAt !== null &&
            unreadAt.getTime() <= candidate.lastReadAt.getTime())
        ) {
          continue;
        }
        unreadRows.push({
          threadId: candidate.threadId,
          unreadAt,
        });
      }
      return newestUnreadIndicators(unreadRows);
    },
  );
  return { activeRows$, unreadRows$ };
}

/**
 * Bounded, non-atomic presentation indicators, not per-Run lifecycle status.
 * Active reflects eligible pending/running Runs; unread reflects unread terminal
 * markers, including failed and cancelled Runs. Independent reads can observe
 * different states during transitions. Missing entries do not prove inactivity
 * or completion, and exclusions do not promise eventual appearance.
 *
 * Each indicator source returns at most 50 rows. Only Run terminal markers
 * contribute unread indicators; they are resolved for at most 128 candidate
 * threads with uncorrelated reads. Active wins for a thread in the active
 * window. Clients can request unread watermarks independently from that window.
 */
export function chatIndicators(
  args: IndicatorScope,
): Computed<Promise<Indicators>> {
  const { activeRows$, unreadRows$ } = createIndicatorRows(args);
  return computed(async (get): Promise<Indicators> => {
    const [activeRows, unreadRows] = await Promise.all([
      get(activeRows$),
      get(unreadRows$),
    ]);

    const threads: Record<string, Indicator> = {};
    const unreadAt: Record<string, string> = {};
    for (const row of activeRows) {
      threads[row.threadId] = "active";
    }
    for (const row of unreadRows) {
      const active = threads[row.threadId] === "active";
      if (active && !args.includeActiveUnread) {
        continue;
      }
      unreadAt[row.threadId] = row.unreadAt.toISOString();
      if (active) {
        continue;
      }
      threads[row.threadId] = "unread";
    }
    return { threads, unreadAt };
  });
}

/**
 * Thread ids owned by the user that currently hold an unsent composer draft
 * (a canonical user message with optional `draftAttachments`).
 */
export function chatThreadDraftIds(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get): Promise<readonly string[]> => {
    const db = get(db$);
    const rows = await db
      .select({ id: chatThreadDrafts.chatThreadId })
      .from(chatThreadDrafts)
      .innerJoin(chatThreads, eq(chatThreads.id, chatThreadDrafts.chatThreadId))
      .where(
        and(
          eq(chatThreadDrafts.userId, args.userId),
          chatThreadOrganizationPredicate(args.orgId),
        ),
      );
    return rows.map((row) => {
      return row.id;
    });
  });
}

export interface CreatedChatThread {
  readonly projectId?: string | null;
  readonly kind: "created";
  readonly id: string;
  readonly createdAt: Date;
}

/** The thread a duplicate delivery of one create request replays. */
export interface ExistingChatThread {
  readonly projectId?: string | null;
  readonly kind: "existing";
  readonly id: string;
  readonly createdAt: Date;
  readonly title: string | null;
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
}
const existingClientThreadSelection = Object.freeze({
  projectId: chatThreads.projectId,
  id: chatThreads.id,
  createdAt: chatThreads.createdAt,
  title: chatThreads.title,
  selectedModel: chatThreads.selectedModel,
  codexServiceTier: chatThreads.codexServiceTier,
});

function existingClientThreadCondition(args: {
  readonly clientThreadId: string | undefined;
  readonly userId: string;
  readonly orgId: string;
}) {
  if (args.clientThreadId === undefined) {
    return sql`false`;
  }
  return and(
    eq(chatThreads.id, args.clientThreadId),
    eq(chatThreads.userId, args.userId),
    chatThreadOrganizationPredicate(args.orgId),
  );
}

interface CreateChatThreadArgs {
  readonly projectId?: string;
  /** Only supplied from the authenticated agent token. */
  readonly sourceRunId?: string;
  readonly userId: string;
  readonly orgId: string;
  readonly title: string | undefined;
  readonly clientThreadId: string | undefined;
  readonly eventId: string | undefined;
  readonly selectedModel: string | null;
  readonly modelSettings?: ModelSettings;
  readonly cloudBrowserEnabled?: boolean;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly committedThread?: ExistingChatThread;
  readonly initialRemoteAccessOverrides?: readonly InitialRemoteAccessOverride[];
  /** Welcome delivery seeds one immutable message only for the winning INSERT. */
  readonly initialAssistantMessage?: string;
  readonly replayExisting?: false;
}

function canReplayClientThread(args: CreateChatThreadArgs) {
  return args.clientThreadId !== undefined && args.replayExisting !== false;
}

function ordinaryChatThreadInsertPlan(args: CreateChatThreadArgs) {
  return prepareChatThreadInsert({
    orgId: args.orgId,
    ...(args.clientThreadId !== undefined ? { id: args.clientThreadId } : {}),
    userId: args.userId,
    title: args.title ?? null,
    projectId: args.projectId,
    // Positive classification belongs to the INSERT itself. A conflicting
    // replay below returns the existing row without writing this value, so a
    // client id that already names an unknown or excluded thread keeps it.
    lastReadAt: sql`NOW()`,
    selectedModel: args.selectedModel,
    modelSettings: args.modelSettings,
    cloudBrowserEnabled: args.cloudBrowserEnabled,
    codexServiceTier: args.codexServiceTier,
  });
}

function ordinaryInitializationRead(
  plan: ReturnType<typeof ordinaryChatThreadInsertPlan>,
) {
  const settings = plan.values.modelSettings;
  const browser = plan.values.cloudBrowserEnabled;
  return {
    id: sql`gen_random_uuid()`.mapWith(chatThreads.id),
    at: sql`NOW()::timestamp`.mapWith(chatThreads.createdAt),
    atText: sql`NOW()::timestamp::text`.mapWith(pgTextDecoder),
    modelSettings: (is(settings, SQL)
      ? settings
      : sql`${sql.param(settings, chatThreads.modelSettings)}::jsonb`
    ).mapWith(chatThreads.modelSettings),
    cloudBrowserEnabled: (typeof browser === "boolean"
      ? sql`${browser}::boolean`
      : browser
    ).mapWith(chatThreads.cloudBrowserEnabled),
  };
}

function preparedOrdinaryThread(
  args: CreateChatThreadArgs,
  plan: ReturnType<typeof ordinaryChatThreadInsertPlan>,
  read: {
    readonly id: string;
    readonly at: Date;
    readonly atText: string;
    readonly modelSettings: ModelSettings;
    readonly cloudBrowserEnabled: boolean;
  },
) {
  const thread = createdChatThreadFromRow({
    id: args.clientThreadId ?? read.id,
    projectId: args.projectId,
    userId: args.userId,
    title: args.title ?? null,
    selectedModel: plan.values.selectedModel,
    modelSettings: read.modelSettings,
    codexServiceTier: args.codexServiceTier,
    computerUseHostId: null,
    cloudBrowserEnabled: read.cloudBrowserEnabled,
    createdAt: read.at,
  });
  return {
    thread,
    values: {
      ...plan.values,
      id: thread.id,
      modelSettings: read.modelSettings,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
      lastReadAt: sql`${read.atText}::timestamp`,
      lastMessageAt: sql`${read.atText}::timestamp`,
      createdAt: sql`${read.atText}::timestamp`,
      updatedAt: sql`${read.atText}::timestamp`,
    },
  };
}

const initializedThreadRowSchema = object({
  id: uuid(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema,
});

function createdThreadResult(thread: {
  readonly id: string;
  readonly createdAt: Date;
}): CreatedChatThread {
  return { kind: "created", id: thread.id, createdAt: thread.createdAt };
}

function initialRemoteOwnershipSelection(args: CreateChatThreadArgs) {
  return {
    owned: initialRemoteAccessOwnershipPredicate(
      args,
      args.initialRemoteAccessOverrides ?? [],
    ).mapWith(pgBooleanDecoder),
  };
}

/** The winning thread INSERT supplies the target; replays cannot invent a parent. */
function createdChatRelationCtes(args: CreateChatThreadArgs) {
  if (args.sourceRunId === undefined) {
    return [];
  }
  return [
    sql`created_chat_relation AS (
    INSERT INTO ${chatRelations}
      (org_id, user_id, type, source_chat_thread_id, target_chat_thread_id, source_run_id, created_at)
    SELECT ${args.orgId}, ${args.userId}, 'created', ${chatThreads.id},
      created_chat_thread.id, ${agentRuns.id}, ${sql.param(nowDate(), chatRelations.createdAt)}
    FROM created_chat_thread
    INNER JOIN ${agentRuns} ON ${eq(agentRuns.id, args.sourceRunId)}
    INNER JOIN ${chatThreads} ON ${chatThreads.id} = ${agentRuns.chatThreadId}
    WHERE ${agentRuns.userId} = ${args.userId}
      AND ${agentRuns.orgId} = ${args.orgId}
      AND ${chatThreads.userId} = ${args.userId}
      AND ${chatThreads.id} <> created_chat_thread.id
  )`,
  ];
}

/** Initialization and the ordered created event commit together. */
export const createChatThread$ = command(
  async ({ get, set }, args: CreateChatThreadArgs, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (args.committedThread) {
      return args.committedThread;
    }
    const readDb = get(db$);
    const [remoteOwnership] =
      (args.initialRemoteAccessOverrides?.length ?? 0) > 0
        ? await readDb
            .select(initialRemoteOwnershipSelection(args))
            .from(sql`(SELECT 1) AS initial_remote_ownership`)
        : [{ owned: true }];
    signal.throwIfAborted();
    if (!remoteOwnership) {
      throw new Error("Initial remote access ownership result is missing");
    }
    if (remoteOwnership.owned) {
      const plan = ordinaryChatThreadInsertPlan(args);
      const [read] = await readDb
        .with(...plan.defaults)
        .select(ordinaryInitializationRead(plan))
        .from(sql`(SELECT 1) AS initial_thread_values`);
      signal.throwIfAborted();
      if (!read) {
        throw new Error("Initial chat thread values are missing");
      }
      const prepared = preparedOrdinaryThread(args, plan, read);
      const db = set(writeDb$);
      const insertion = normalChatInputInsertSql(
        chatThreads,
        prepared.values,
        sql`true`,
        sql`DO NOTHING`,
        sql`${chatThreads.id}, ${chatThreads.createdAt}`,
      );
      const ctes = [
        sql`created_chat_thread AS (${insertion})`,
        ...createdChatRelationCtes(args),
        ...chatThreadInitializationCtes({
          orgId: args.orgId,
          eventId: args.eventId,
          thread: prepared.thread,
          remoteOverrides: args.initialRemoteAccessOverrides ?? [],
          assistantMessage: args.initialAssistantMessage,
        }),
      ];
      const [created] = parseRawRows(
        initializedThreadRowSchema,
        await db.execute(sql`WITH ${sql.join(ctes, sql`, `)}
          SELECT id, created_at::text AS "createdAt" FROM created_chat_thread`),
      );
      signal.throwIfAborted();
      if (created) {
        return {
          ...createdThreadResult(created),
          projectId: args.projectId ?? null,
        };
      }
    }
    if (canReplayClientThread(args)) {
      // A conflicting INSERT may have waited for an uncommitted winner.
      // Read again after that statement; its initial snapshot cannot replay it.
      const [existing] = await readDb
        .select(existingClientThreadSelection)
        .from(chatThreads)
        .where(existingClientThreadCondition(args))
        .limit(1);
      signal.throwIfAborted();
      if (existing) {
        return { kind: "existing" as const, ...existing };
      }
    }
    return remoteOwnership.owned
      ? { kind: "client_thread_conflict" as const }
      : {
          kind: "invalid_remote_access_selection" as const,
          message: "Remote access host not found",
        };
  },
);

interface DeleteChatThreadArgs {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly eventId?: string;
}

const deletedThreadRowSchema = object({
  result: object({
    deleted: boolean(),
    activeRuns: array(object({ runId: string(), orgId: string() })),
    disabledAutomations: array(
      object({
        orgId: string(),
        ownerUserId: string(),
        eventType: string().nullable(),
        eventConfig: zUnknown(),
        eventConnectorId: string().nullable(),
      }),
    ),
  }),
});

/** The finite route owner keeps deletion and committed cleanup together. */
const deleteChatThreadContent$ = command(
  async ({ set }, args: DeleteChatThreadArgs, signal: AbortSignal) => {
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    const query = sql`SELECT public.delete_chat_thread_content(
      ${args.threadId}::uuid, ${args.userId}, ${args.orgId},
      ${args.eventId ?? null}, ${nowDateSql(sql`NULL::timestamp`)}
    ) AS result`;
    const rowSchema = deletedThreadRowSchema;
    const result = await (async () => {
      const deletion = await settle(
        (async () => {
          return parseRawRows(rowSchema, await writeDb.execute(query));
        })(),
      );
      if (!deletion.ok) {
        throw new Error(
          `Chat thread deletion SQL execution failed (${safeSqlStateCode(deletion.error) ?? "unknown"})`,
        );
      }
      const [row] = deletion.value;
      if (!row) {
        throw new Error("Chat thread deletion returned no outcome");
      }
      return row.result;
    })();
    signal.throwIfAborted();
    return result;
  },
);
/**
 * Delete a chat thread after winding down everything attached to it. Deleting a
 * thread on its own leaves the linked automations firing and any in-flight runs
 * executing: the canonical run metadata uses `ON DELETE SET NULL`, so a running
 * run simply loses its thread reference and keeps consuming credits.
 *
 * Lock the thread row while deleting it and collecting active runs. Inserts into
 * `agent_runs.chatThreadId` take a FK lock on the same parent row, so this closes
 * the race where a new run attaches after the active-run scan but before the
 * thread delete. All run-side thread ownership now lives in `agent_runs`.
 * Cancellation still happens after the delete transaction because it has runner
 * notifications and queue-drain side effects.
 *
 * Run cancellation has side effects that cannot participate in the thread's
 * delete transaction (`cancelRun$` opens its own transaction and the runner
 * must be notified), so ownership is verified up front and the cancelled-run
 * results are returned for the caller to dispatch the post-cancel side effects.
 */
export const deleteChatThread$ = command(
  async (
    { set },
    args: DeleteChatThreadArgs,
    signal: AbortSignal,
  ): Promise<{
    readonly deleted: boolean;
    readonly cancelledRuns: readonly CancelRunResult[];
  }> => {
    const deletion = await set(deleteChatThreadContent$, args, signal);
    signal.throwIfAborted();
    if (!deletion.deleted) {
      return { deleted: false, cancelledRuns: [] };
    }
    // `chat_thread_drafts` has no foreign key to the thread, so remove its row
    // here with one statement after the deletion commits.
    await set(deleteChatThreadDraft$, args.threadId, signal);
    signal.throwIfAborted();
    const cancelledRuns: CancelRunResult[] = [];
    for (const run of deletion.activeRuns) {
      const result = await set(
        cancelRun$,
        {
          runId: run.runId,
          userId: args.userId,
          orgId: run.orgId,
          runnerCancellationMode: "hard",
        },
        signal,
      );
      signal.throwIfAborted();
      // Pre-filtered to active runs, but a concurrent transition can still race
      // a run to a terminal status; cancelRun$ then returns a frozen error
      // response (no `alreadyCancelled` field), which we skip.
      if ("alreadyCancelled" in result) {
        cancelledRuns.push(result);
      }
    }
    await set(
      reconcileAutomationEventWatches$,
      { automations: deletion.disabledAutomations },
      signal,
    );
    signal.throwIfAborted();
    return { deleted: true, cancelledRuns };
  },
);

export const updateChatThreadDraft$ = command(
  async (
    { set },
    args: {
      readonly legacyMemberDraft?: boolean;
      readonly threadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly suggestionPreset?: SuggestionPreset;
      readonly draftUserMessage: UserMessageInputDocument | null;
      readonly draftAttachments: readonly PersistedAttachment[] | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const saved = await set(
      persistChatThreadDraft$,
      {
        chatThreadId: args.threadId,
        legacyMemberDraft: args.legacyMemberDraft,
        orgId: args.orgId,
        userId: args.userId,
        suggestionPreset: args.suggestionPreset,
        draftUserMessage: args.draftUserMessage,
        draftAttachments: args.draftAttachments
          ? [...args.draftAttachments]
          : null,
      },
      signal,
    );
    signal.throwIfAborted();
    return saved;
  },
);
